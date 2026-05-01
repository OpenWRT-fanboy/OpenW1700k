#!/bin/sh
# appflow protocol and bounds suite.
#
# The sibling suite, hardware-suite.sh, drives real traffic through a real
# netifyd and checks that the totals stay near wire truth. It is an integration
# test and its own header says the weakness is coverage: it can only assert on
# whatever netifyd happened to send during the window, so the arithmetic is
# checked loosely, the error paths are never reached at all, and a test either
# waits a minute or skips.
#
# This suite replaces netifyd with a socket WE control, so the input is exact
# and chosen. That buys three things the hardware suite cannot have:
#
#   1. Byte arithmetic checked against a hand-computed total rather than
#      against a ratio band. If the daemon adds one byte that netifyd did not
#      report, a check here goes red; the 0.80-1.25 ratio band cannot see it.
#   2. The error and bounds paths, which real netifyd never exercises:
#      malformed frames, oversized tags, a full flow table, a full aggregate
#      table, unknown event types, a peer that stops sending newlines.
#   3. Determinism. No traffic, no waiting on a transfer, no SKIP.
#
# It does NOT replace the hardware suite. Everything here is the daemon's view
# of a wire this file wrote, so nothing here can catch appflowd and netifyd
# disagreeing about what a field means. That is exactly what the hardware
# suite's wire-truth comparison is for, and neither suite subsumes the other.
#
#   usage:  sh protocol-suite.sh                  run everything
#           sh protocol-suite.sh conservation     run one group
#             (conservation|protocol|bounds|attribution|hostile|acl|lifecycle)
#
# RUN IT ON A SANDBOX ROUTER. It stops appflowd, repoints appflow.socket_path
# at a temporary socket, and restarts the daemon many times. It restores the
# original socket_path on exit, including on interrupt. It never touches
# netifyd's own configuration.
#
# Exit status is the number of failed checks.
#
# ---------------------------------------------------------------------------
# HOW TO READ THE `SABOTAGE:` COMMENTS, AND WHY THEY ARE THERE
#
# Every check below carries one. It names the smallest edit to appflowd -- the
# product, not this file -- that makes that check report failure, and it was
# written BEFORE the assertion it sits above.
#
# That ordering is the whole discipline. Asking "what does this test check"
# answers itself in the author's own words, which is how a test that cannot
# fail gets written and then read a dozen times without anyone noticing. Asking
# "what edit turns this red" is a construction task: either a concrete edit
# exists or you hit a wall, and the wall is the finding.
#
# They are also here so a reviewer can check this suite in sixty seconds rather
# than trusting it. Apply the named edit, run the group, and exactly the checks
# that name it should go red. If one of them stays green, that check is
# decorative and this comment is how you found out.
#
# An edit that makes the file unparseable does not count and none is used
# below: an error is not a red assertion, and it is the escape hatch every
# hollow test reaches for.
# ---------------------------------------------------------------------------

set -u

# ---------------------------------------------------------------- exclusivity
#
# Every suite in these two packages mutates GLOBAL router state: this one
# rewrites /etc/config/mwan3 and drives the mwan3 service, its sibling repoints
# appflow.socket_path and restarts appflowd. Two of them running at once
# corrupt each other's fixtures, and the failures look like product defects.
#
# That is not hypothetical. On 2026-08-26 two suites were launched a minute
# apart against the same router; the second reported two failures that could
# not be reproduced in isolation, and the ownership arithmetic was rewritten
# twice chasing a bug that was never there.
#
# One lock file for ALL suites across both packages, because the resource being
# protected is the router, not the config file.
# mkdir is atomic and is NOT a file descriptor, which is the whole point.
# The first version of this guard used `exec 9>lock; flock -n 9`. Every child
# inherits an fd, and these suites launch children that outlive them: socat
# serving the fake agent, and mwan3track respawned per interface by mwan3's
# init script. The lock therefore stayed held after the suite exited and the
# next suite in a serial run was refused. Observed: suite 1 passed, suites 2
# and 3 produced no output at all because both exited 2.
SUITE_LOCK=/tmp/openwrt-suite.lock.d
if ! mkdir "$SUITE_LOCK" 2>/dev/null; then
	# Someone holds it, or a killed run left it behind. Only the second is
	# ours to clear, and only when the recorded pid is provably gone.
	stale=1
	if [ -r "$SUITE_LOCK/pid" ]; then
		kill -0 "$(cat "$SUITE_LOCK/pid" 2>/dev/null)" 2>/dev/null && stale=0
	fi
	if [ "$stale" = 1 ]; then
		printf 'clearing a stale suite lock (%s)\n' "$SUITE_LOCK"
		rm -rf "$SUITE_LOCK"
		mkdir "$SUITE_LOCK" 2>/dev/null || { printf "cannot take the suite lock\n"; exit 2; }
	else
		printf 'another test suite is running on this router (pid %s).\n' \
		       "$(cat "$SUITE_LOCK/pid" 2>/dev/null)"
		printf 'they mutate shared router state; run them one at a time.\n'
		exit 2
	fi
fi
echo $$ > "$SUITE_LOCK/pid"

GROUP="${1:-all}"
PASS=0; FAIL=0

SOCK=/tmp/appflow-proto.sock
EV=/tmp/appflow-proto-events.jsonl
FAKE=""
ORIG_SOCK=""
ORIG_FLOWMAX=""

head2() { printf '\n=== %s ===\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
skip() { printf '  SKIP  %s\n' "$*"; }
note() { printf '        %s\n' "$*"; }

# chk <description> <expected> <actual>
chk() {
	if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

# chk_ge <description> <floor> <actual>
chk_ge() {
	if [ "${3:-0}" -ge "$2" ] 2>/dev/null; then
		ok "$1 ($3 >= $2)"
	else
		bad "$1 (expected >= $2, got '${3:-}')"
	fi
}

# ------------------------------------------------------------------ fixtures

st() { ubus call appflow status 2>/dev/null; }

# field <group> <key>  -- read one integer out of one object in status.
#
# Anchored to the group so `flows.pruned` and `aggregates.pruned`, which share a
# key name, cannot be confused for each other.
#
# TWO DEFECTS IN EARLIER DRAFTS OF THIS FUNCTION, both found by running it, and
# both worth keeping written down because they are the shape that makes a whole
# suite worthless rather than one check:
#
#   1. The range ended at `/}/`, which is the first closing brace ANYWHERE in
#      the group -- and `events` contains two nested objects, `unknown_types`
#      and `by_type`. So the range closed early and `rx_bytes`, `resyncs` and
#      `last_event_age_ms` were unreadable. Anchoring both ends to a single tab
#      of indentation is what fixes it.
#
#   2. Far worse: a key that could not be found returned the empty string, and
#      every caller wrote `${x:-0}`. Six checks in this suite assert that a
#      counter is exactly "0". Every one of them would have passed
#      unconditionally, for as long as the helper stayed broken, with the
#      daemon uninstalled entirely. That is the "loop over a property that does
#      not exist" trap wearing a different hat: not zero iterations, but a
#      default that happens to equal the expected value.
#
# So a miss now returns the literal MISSING, which equals no expected value and
# turns the check red. A test helper that cannot find its subject must fail
# loudly; returning a plausible number is how a suite starts lying.
field() {
	local v
	v=$(st | sed -n "/^	\"$1\": {/,/^	}/p" \
	       | sed -n "s/.*\"$2\": *\([0-9-]*\).*/\1/p" | head -1)
	printf '%s' "${v:-MISSING}"
}

cleanup() {
	fake_down
	rm -f "$SOCK" "$EV"
	if [ -n "$ORIG_SOCK" ]; then
		uci set appflow.main.socket_path="$ORIG_SOCK"
		[ -n "$ORIG_FLOWMAX" ] && uci set appflow.main.flow_max="$ORIG_FLOWMAX"
		uci commit appflow
		/etc/init.d/appflowd restart >/dev/null 2>&1
		printf '\nrestored appflow.socket_path=%s flow_max=%s\n' "$ORIG_SOCK" "$ORIG_FLOWMAX"
	fi
	rm -rf "$SUITE_LOCK"
}
# HUP IS IN THAT LIST DELIBERATELY. These suites are normally run over SSH, and
# a dropped session sends SIGHUP, which the original INT/TERM/EXIT list did not
# catch: the process died without running the trap. Observed 2026-08-26, where
# it left a stale lock behind. The lock self-heals; what would NOT self-heal is
# the rest of what this trap undoes -- the mwan3 init-script shim, a rewritten
# /etc/config/mwan3, or appflow left pointed at a socket that no longer exists.
# A router in that state looks broken and gives no clue why.
trap 'cleanup; exit $FAIL' INT TERM HUP EXIT

# Start a fake netifyd that serves $EV and then holds the connection open.
#
# It must HOLD rather than close. appflowd treats a closed socket as netifyd
# going away and reconnects after a second, and socat is in `fork` mode, so the
# reconnect would be served a FRESH `cat` of the same file: every event
# delivered twice, every byte counted twice, and every arithmetic check in this
# suite quietly wrong in a way that looks like a daemon defect. The hold is
# what makes the input exactly-once.
#
# HOLD_S is 60, not 600. At 600 the shell that socat spawns outlives the suite
# holding the inherited stdout pipe, so anything reading this script's output
# blocks for ten minutes after the last check has printed. That is not
# hypothetical, it happened on the first run of this file. cleanup() now kills
# the child by pattern as well as killing socat, and the shorter hold bounds the
# damage if both miss.
HOLD_S=60

fake_up() {
	fake_down
	rm -f "$SOCK"
	socat UNIX-LISTEN:"$SOCK",fork,unlink-early \
	      SYSTEM:"cat $EV; sleep $HOLD_S" 2>/dev/null &
	FAKE=$!
	local i=0
	while [ "$i" -lt 30 ]; do
		[ -S "$SOCK" ] && return 0
		i=$((i + 1)); sleep 1
	done
	return 1
}

# kill every process whose command line matches, or nothing if none do.
#
# `pkill` DOES NOT EXIST on stock OpenWrt. busybox ships pgrep and killall but
# not pkill, so `pkill -f ...` is `ash: pkill: not found` -- which, inside a
# cleanup function whose failures are all redirected to /dev/null, is a silent
# no-op. The first version of this suite used it twice and left socat and its
# child running after every case.
#
# The `[ -n ... ]` guard matters too: bare `kill $(pgrep ...)` with no matches
# calls kill with no arguments, which is a usage error, and under `set -u`-style
# discipline that noise hides the real failures.
killmatch() {
	local pids
	pids=$(pgrep -f "$1" 2>/dev/null)
	[ -n "$pids" ] && kill $pids 2>/dev/null
	return 0
}

fake_down() {
	[ -n "$FAKE" ] && kill "$FAKE" 2>/dev/null
	killmatch "UNIX-LISTEN:$SOCK"
	# The SYSTEM: child is a separate process and does not die with socat.
	killmatch "cat $EV"
	FAKE=""
}

# Restart the daemon against the current $EV and let it drain.
#
# The wait is on OBSERVED PROGRESS rather than a fixed sleep: poll until the
# daemon reports having read the bytes we staged, then stop. A fixed sleep is
# either slower than it needs to be or, on a loaded box, shorter than the drain,
# and a check that reads counters mid-drain fails intermittently and gets
# "fixed" by lengthening the sleep until it no longer tests anything.
feed_and_settle() {
	local want; want=$(wc -c < "$EV")
	fake_up || { bad "fake netifyd did not come up"; return 1; }
	/etc/init.d/appflowd restart >/dev/null 2>&1
	local i=0 rx=0
	while [ "$i" -lt 40 ]; do
		rx=$(field events rx_bytes); rx=${rx:-0}
		[ "$rx" -ge "$want" ] 2>/dev/null && { sleep 1; return 0; }
		i=$((i + 1)); sleep 1
	done
	note "warning: drained ${rx} of ${want} staged bytes before the deadline"
	return 0
}

# A flow event. Deliberately verbose rather than templated: a generator that
# builds these from a table would put the expected byte totals and the events
# that produce them in the same expression, and then the oracle comes from the
# artifact under test rather than from a human. The numbers below are stated by
# hand, and the totals asserted against are stated by hand too.
#
# flow_ev <digest> <app_id> <app_name> <local_bytes> <other_bytes> <total_bytes> <internal> <mac>
flow_ev() {
	printf '{"type":"flow","internal":%s,"interface":"%s","flow":{"digest":"%s","local_ip":"192.168.9.10","local_mac":"%s","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_port":40001,"other_port":443,"ip_protocol":6,"detected_application":%s,"detected_application_name":"%s","detected_protocol":91,"detected_protocol_name":"TLS","category":{"application":10,"protocol":20},"local_bytes":0,"other_bytes":0,"total_bytes":0}}\n' \
		"$7" "$([ "$7" = true ] && echo br-lan || echo eth0)" "$1" "$8" "$2" "$3"
	printf '{"type":"flow_stats","internal":%s,"interface":"%s","flow":{"digest":"%s","local_ip":"192.168.9.10","local_mac":"%s","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":%s,"other_bytes":%s,"total_bytes":%s}}\n' \
		"$7" "$([ "$7" = true ] && echo br-lan || echo eth0)" "$1" "$8" "$4" "$5" "$6"
}

hello() { printf '{"type":"agent_hello","agent_version":"test-4.4.7","build_version":"protocol-suite"}\n'; }

# ------------------------------------------------------------- conservation

test_conservation() {
	head2 "BYTE CONSERVATION (against a hand-computed total, not a ratio band)"

	# Three flows, chosen so no two sums coincide and a swapped or dropped term
	# cannot land on the right answer by accident:
	#
	#   flow A   local  1000   other  2000   total  3000
	#   flow B   local   500   other   700   total  1200
	#   flow C   local    17   other    83   total   100
	#
	#   sum(local) = 1517     sum(other) = 2783     sum(total) = 4300
	#
	# Every expected value below is one of those three, computed here and not
	# read back from the daemon.
	{
		hello
		flow_ev A0000001 1001 protoapp-one   1000 2000 3000 true 02:00:00:00:00:aa
		flow_ev B0000002 1002 protoapp-two    500  700 1200 true 02:00:00:00:00:aa
		flow_ev C0000003 1003 protoapp-three   17   83  100 true 02:00:00:00:00:aa
	} > "$EV"

	feed_and_settle || return

	local rep att shd lk up dn tot
	rep=$(field bytes reported);   att=$(field bytes attributed)
	shd=$(field bytes shadowed);   lk=$(field bytes leaked)
	note "reported=$rep attributed=$att shadowed=$shd leaked=$lk"

	# SABOTAGE: in appflowd flow_update(), change the `stats.bytes.reported +=`
	# line to add `tb` instead of the clamped delta. reported becomes 4300 on
	# the first update and keeps climbing; this check goes red immediately.
	chk "reported == the 4300 bytes we sent, exactly" "4300" "$rep"

	# SABOTAGE: in account(), drop the `stats.bytes.attributed +=` line.
	# attributed falls to 0 while reported stays 4300, and leaked becomes 4300.
	chk "attributed == reported when nothing is shadowed" "4300" "$att"
	chk "nothing was shadowed on an all-internal capture" "0" "$shd"

	# SABOTAGE: same edit as above. leaked is reported minus what reached an
	# aggregate, so any accounting path that stops adding shows here. This is
	# the check the README tells a user to run, so it must bind.
	chk "leaked == 0 (every reported byte reached an aggregate)" "0" "$lk"

	head2 "DIRECTIONAL SPLIT (a swap survives every total-only check)"

	up=$(ubus call appflow summary 2>/dev/null | sed -n 's/.*"bytes_up": *\([0-9]*\).*/\1/p' | head -1)
	dn=$(ubus call appflow summary 2>/dev/null | sed -n 's/.*"bytes_down": *\([0-9]*\).*/\1/p' | head -1)
	tot=$(ubus call appflow summary 2>/dev/null | sed -n 's/.*"bytes_total": *\([0-9]*\).*/\1/p' | head -1)
	note "up=$up down=$dn total=$tot"

	# SABOTAGE: in flow_update(), swap the two initialisers so `dl` takes
	# f.other_bytes and `do_` takes f.local_bytes.
	#
	# This is why the two directions are asserted separately rather than as a
	# sum. That swap leaves reported, attributed, leaked and bytes_total all
	# exactly correct -- every check in the group above stays green, and so does
	# the hardware suite's wire-truth ratio, because the sum is unchanged. Only
	# these two go red. A suite that checks totals alone cannot see a swap.
	chk "bytes_up == sum(local_bytes) == 1517" "1517" "$up"
	chk "bytes_down == sum(other_bytes) == 2783" "2783" "$dn"
	chk "bytes_total == 4300" "4300" "$tot"

	head2 "SELF-INCONSISTENT COUNTERS ARE CLAMPED ONCE A BASELINE EXISTS"

	# netifyd is trusted to report its own counters honestly, and DESIGN 2.2
	# says the directional deltas are bounded by the growth of total_bytes so a
	# self-inconsistent counter cannot inflate the totals.
	#
	# READ THE GUARD BEFORE BELIEVING THAT SENTENCE. In flow_update() the clamp
	# sits behind `if (tb > 0 && fr.total > 0)`, so it applies from the SECOND
	# update of a flow onward. On the first there is no baseline to measure
	# growth against and the deltas are trusted as given -- deliberately, and
	# the comment beside it argues the case: a missing or reset counter must not
	# scale real deltas to zero, which would silently stop accounting a flow
	# forever. That is a defensible trade and it is not what this checks.
	#
	# The first draft of this check sent ONE update with local 1e9 + other 1e9
	# against total 100 and asserted the result was bounded by 100. It came back
	# 2000000000 and read as a live defect. It was not: the test asserted a
	# promise the code never made, on the one path where the promise is
	# explicitly suspended. Written sabotage-first it would have died at the
	# wall, because there is no clamp on that path to remove.
	#
	# So drive the path the clamp actually governs. Two updates:
	#
	#   stats #1   local  100  other  100  total  200   no baseline, trusted
	#   stats #2   local  1e9  other  1e9  total  250   baseline 200, grew 50
	#
	# Growth is 50, so the second update may contribute 50 and no more:
	#   reported   = 200 + 50 = 250
	#   attributed = 100 + 100 + 25 + 25 = 250
	#
	# Both hand-computed. An unclamped daemon reports 2000000200.
	{
		hello
		printf '{"type":"flow","internal":true,"interface":"br-lan","flow":{"digest":"D0000004","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","detected_application":1004,"detected_application_name":"protoapp-liar","local_bytes":0,"other_bytes":0,"total_bytes":0}}\n'
		printf '{"type":"flow_stats","internal":true,"interface":"br-lan","flow":{"digest":"D0000004","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":100,"other_bytes":100,"total_bytes":200}}\n'
		printf '{"type":"flow_stats","internal":true,"interface":"br-lan","flow":{"digest":"D0000004","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":1000000000,"other_bytes":1000000000,"total_bytes":250}}\n'
	} > "$EV"
	feed_and_settle || return

	rep=$(field bytes reported); att=$(field bytes attributed)
	note "reported=$rep attributed=$att (two billion offered, 50 bytes of growth)"

	# SABOTAGE: in flow_update(), delete the `if (sum > dt)` branch so `dl` and
	# `do_` pass through unclamped. reported becomes 2000000200 and both checks
	# go red.
	chk "growth, not the declared deltas, bounds what is reported" "250" "$rep"
	chk "and what is attributed" "250" "$att"

	# The first-update path is a real and deliberate hole in the clamp: one
	# oversized update on a brand-new digest is trusted in full. Recorded here
	# rather than asserted, because the daemon documents the trade and changing
	# it is a design decision, not a bug fix.
	note "note: the clamp does not cover a flow's FIRST update, by design"
}

# ------------------------------------------------------------------ protocol

test_protocol() {
	head2 "WIRE PROTOCOL (the paths real netifyd never exercises)"

	# One good flow so there is something to compare against, then five lines
	# that are not JSON objects at all, then another good flow. The good flows
	# bracket the garbage: if a malformed line desynchronised the reader, the
	# second flow would not arrive and the byte total would be short.
	{
		hello
		flow_ev E0000005 1005 protoapp-before 100 200 300 true 02:00:00:00:00:aa
		printf '{"type":"flow","flow":{"digest":"trunc\n'
		printf 'not json at all\n'
		printf '[1,2,3]\n'
		printf '"a bare string"\n'
		printf '{"unterminated": \n'
		flow_ev F0000006 1006 protoapp-after 400 500 900 true 02:00:00:00:00:aa
	} > "$EV"
	feed_and_settle || return

	local mal rep
	mal=$(field events malformed)
	rep=$(field bytes reported)
	note "malformed=$mal reported=$rep"

	# SABOTAGE: in feed(), delete `stats.malformed++` from the json() catch
	# block. malformed stays 0 and this goes red.
	#
	# The floor is 4 rather than 5 because two of the six garbage lines are a
	# truncated object and an unterminated one; how the split lands depends on
	# buffering, and pinning the exact count would make this check assert on
	# socat's write sizes rather than on the daemon. Four is below any plausible
	# split and above zero, which is the property under test.
	chk_ge "malformed lines are counted, not silently dropped" 4 "$mal"

	# SABOTAGE: in feed(), change the `return` in the catch block to a bare
	# `dispatch(ev, now)` on an undefined `ev`. The daemon stops parsing after
	# the first garbage line and this total falls to 300.
	chk "a malformed line does not desynchronise the reader (300+900)" "1200" "$rep"

	head2 "FRAME HEADERS ARE NOT EVENTS, AND EVENTS ARE NOT FRAMES"

	{
		hello
		printf '{"length":512}\n'
		printf '{"length":1024}\n'
		flow_ev G0000007 1007 protoapp-framed 300 300 600 true 02:00:00:00:00:aa
	} > "$EV"
	feed_and_settle || return

	local fr ev_total
	fr=$(field events frames)
	ev_total=$(field events total)
	note "frames=$fr events.total=$ev_total"

	# SABOTAGE: in feed(), delete `stats.frames++` from the frame-header branch.
	chk "a sole-key {\"length\":N} object counts as a frame" "2" "$fr"

	# SABOTAGE: in feed(), weaken the frame test from
	#   `ev.length != null && length(ev) == 1`
	# to just `ev.length != null`.
	#
	# This is the interesting direction and the reason the check below exists.
	# With the key-count dropped, ANY event that happens to carry a `length`
	# field is swallowed as a frame header and never dispatched. netifyd does
	# not send one today, so nothing in the hardware suite or in production
	# would notice until it did -- at which point flows would silently vanish.
	{
		hello
		printf '{"type":"flow","length":99,"internal":true,"interface":"br-lan","flow":{"digest":"H0000008","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","detected_application":1008,"detected_application_name":"protoapp-lengthy","local_bytes":0,"other_bytes":0,"total_bytes":0}}\n'
		printf '{"type":"flow_stats","length":99,"internal":true,"interface":"br-lan","flow":{"digest":"H0000008","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":250,"other_bytes":250,"total_bytes":500}}\n'
	} > "$EV"
	feed_and_settle || return

	rep=$(field bytes reported)
	chk "an event carrying a 'length' field is still dispatched" "500" "$rep"

	head2 "UNKNOWN EVENT TYPES ARE COUNTED AND NAMED"

	{
		hello
		printf '{"type":"some_future_event","payload":{"a":1}}\n'
		printf '{"type":"another_new_one","payload":{"b":2}}\n'
	} > "$EV"
	feed_and_settle || return

	local unk
	unk=$(field events unknown)
	note "unknown=$unk"

	# SABOTAGE: in dispatch(), delete the `stats.unknown++` line at the tail.
	chk_ge "an unhandled event type is counted" 2 "$unk"

	# SABOTAGE: in dispatch(), delete the `stats.unknown_types[t] = 0`
	# initialiser so the name is never recorded.
	if st | grep -q '"some_future_event"'; then
		ok "the unknown type is named in status, not just counted"
	else
		bad "unknown_types does not name 'some_future_event'"
	fi

	head2 "A PURGE-ISH UNKNOWN TYPE STILL FINALISES THE FLOW"

	# PURGE_RE exists so a netifyd rename cannot leak flow records. Nothing in
	# the hardware suite reaches it, because real netifyd only ever sends the
	# three names the handler table already knows.
	{
		hello
		flow_ev I0000009 1009 protoapp-terminated 100 100 200 true 02:00:00:00:00:aa
		printf '{"type":"flow_terminated","internal":true,"interface":"br-lan","flow":{"digest":"I0000009","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":0,"other_bytes":0,"total_bytes":200}}\n'
	} > "$EV"
	feed_and_settle || return

	local tracked purged
	tracked=$(field flows tracked); purged=$(field flows purged)
	note "tracked=$tracked purged=$purged"

	# SABOTAGE: in dispatch(), delete the `if (match(t, PURGE_RE))` branch.
	# The flow is never finalised, so tracked stays 1 and purged stays 0.
	chk "a 'flow_terminated' event purges the flow" "0" "$tracked"
	chk_ge "the purge was counted" 1 "$purged"

	head2 "BLANK LINES ARE IGNORED, NOT COUNTED AS MALFORMED"

	{
		hello
		printf '\n\n   \n\t\n'
		flow_ev J0000010 1010 protoapp-blanks 50 50 100 true 02:00:00:00:00:aa
	} > "$EV"
	feed_and_settle || return

	mal=$(field events malformed)

	# SABOTAGE: in feed(), delete the `if (!length(line)) return;` guard.
	# Each blank line then reaches json(), throws, and is counted, so malformed
	# becomes 4 and this goes red.
	chk "whitespace-only lines are not counted as malformed" "0" "$mal"
}

# -------------------------------------------------------------------- bounds

test_bounds() {
	head2 "BOUNDS: a single flow record cannot hold an unbounded string"

	# TAG_MAX is 64. Send an 8 KB application name.
	local longname
	longname=$(awk 'BEGIN{ s=""; while (length(s) < 8192) s = s "A"; print s }')
	{
		hello
		printf '{"type":"flow","internal":true,"interface":"br-lan","flow":{"digest":"K0000011","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","detected_application":1011,"detected_application_name":"%s","local_bytes":0,"other_bytes":0,"total_bytes":0}}\n' "$longname"
		printf '{"type":"flow_stats","internal":true,"interface":"br-lan","flow":{"digest":"K0000011","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":10,"other_bytes":10,"total_bytes":20}}\n'
	} > "$EV"
	feed_and_settle || return

	# Longest run of A's anywhere in the summary reply.
	local worst
	worst=$(ubus call appflow summary 2>/dev/null | grep -oE 'A+' | awk '{ if (length($0) > m) m = length($0) } END { print m+0 }')
	note "longest A-run in the summary reply: $worst (TAG_MAX is 64)"

	# SABOTAGE: in flow_identify(), replace the `cap(...)` wrapper around
	# f.detected_application_name with the raw field. The stored tag becomes
	# 8192 characters and this goes red.
	if [ "${worst:-0}" -le 64 ] 2>/dev/null && [ "${worst:-0}" -gt 0 ]; then
		ok "an oversized detection tag is capped at TAG_MAX ($worst <= 64)"
	else
		bad "detection tag not capped: longest run is $worst"
	fi

	head2 "BOUNDS: the flow table refuses to grow past flow_max"

	# flow_max is clamped to a floor of 64 by cfg_load, so 64 is the smallest
	# table this can ask for. 200 distinct digests against it.
	uci set appflow.main.flow_max=64
	uci commit appflow
	{
		hello
		awk 'BEGIN {
			for (i = 1; i <= 200; i++) {
				d = sprintf("FLOOD%05d", i)
				printf "{\"type\":\"flow\",\"internal\":true,\"interface\":\"br-lan\",\"flow\":{\"digest\":\"%s\",\"local_ip\":\"192.168.9.10\",\"local_mac\":\"02:00:00:00:00:aa\",\"other_ip\":\"93.184.216.34\",\"other_mac\":\"02:00:00:00:00:ff\",\"detected_application\":2000,\"detected_application_name\":\"flood\",\"local_bytes\":0,\"other_bytes\":0,\"total_bytes\":0}}\n", d
				printf "{\"type\":\"flow_stats\",\"internal\":true,\"interface\":\"br-lan\",\"flow\":{\"digest\":\"%s\",\"local_ip\":\"192.168.9.10\",\"local_mac\":\"02:00:00:00:00:aa\",\"other_ip\":\"93.184.216.34\",\"other_mac\":\"02:00:00:00:00:ff\",\"local_bytes\":1,\"other_bytes\":1,\"total_bytes\":2}}\n", d
			}
		}'
	} > "$EV"
	feed_and_settle || return

	local tracked dropped pruned
	tracked=$(field flows tracked); dropped=$(field flows dropped)
	pruned=$(field flows pruned)
	note "tracked=$tracked pruned=$pruned dropped=$dropped against flow_max=64"

	# SABOTAGE: in flow_new(), delete the `if (nflows >= cfg.flow_max)` block.
	# tracked climbs to 200 and this goes red.
	if [ "${tracked:-0}" -le 64 ] 2>/dev/null; then
		ok "the flow table stays within flow_max ($tracked <= 64)"
	else
		bad "flow table holds $tracked with flow_max=64"
	fi

	# The bound above passes trivially if the table never actually filled, so
	# prove the cap-pressure path RAN. Without this, offering three flows
	# instead of two hundred would look identical.
	#
	# SABOTAGE: in prune(), delete the `if (force && nflows >= cfg.flow_max)`
	# block. Nothing sheds, tracked climbs past 64 and pruned stays 0, so this
	# and the check above go red together.
	chk_ge "the cap-pressure prune actually ran" 1 "$pruned"

	# `flows.shed` is the counter that says "the table is too small for this
	# network", and it exists because of this check.
	#
	# The first version asserted `dropped >= 1` and failed. That was the test
	# being wrong, not the daemon: flow_new() increments flows_dropped only if
	# the table is STILL full after prune(now, true), and that prune
	# unconditionally sheds `int(flow_max/10) + 1` entries, so it always frees
	# space and the fall-through never happens. `flows_dropped` cannot be moved
	# by any input this daemon can receive.
	#
	# Status therefore carried a counter that permanently read 0 while flows
	# were being shed continuously, with the shedding hidden inside `pruned`
	# alongside ordinary idle housekeeping. Same shape as aggregates.refused.
	# `flows.shed` was added 2026-08-26 to make it visible.
	#
	# SABOTAGE: in prune(), delete the `stats.flows_shed++` line. The table
	# still sheds correctly and the operator still cannot see it, which is
	# exactly the defect this counter was added for.
	local shed; shed=$(field flows shed)
	note "flows.shed=$shed  flows.dropped=$dropped (dropped is a last-resort backstop)"
	chk_ge "cap-pressure shedding is counted separately from idle pruning" 1 "$shed"

	uci set appflow.main.flow_max="$ORIG_FLOWMAX"
	uci commit appflow

	head2 "BOUNDS: a full aggregate table refuses rather than evicting live data"

	# AGG_MAX is 384 per class. 500 distinct application ids, each with a live
	# flow, so nothing is evictable: every entry has cur.flows > 0.
	#
	# This is the LAN-attacker case the 2026-08-25 security panel converged on,
	# reproduced deterministically. The right behaviour is the one already
	# shipped: refuse to grow rather than drop a device that is actively
	# transferring. What this checks is that the refusal is VISIBLE, because a
	# status reading `apps: 384` with no other signal looks healthy at exactly
	# the moment the table has stopped accepting anything.
	{
		hello
		awk 'BEGIN {
			for (i = 1; i <= 500; i++) {
				d = sprintf("AGGF%06d", i)
				printf "{\"type\":\"flow\",\"internal\":true,\"interface\":\"br-lan\",\"flow\":{\"digest\":\"%s\",\"local_ip\":\"192.168.9.10\",\"local_mac\":\"02:00:00:00:00:aa\",\"other_ip\":\"93.184.216.34\",\"other_mac\":\"02:00:00:00:00:ff\",\"detected_application\":%d,\"detected_application_name\":\"agg-%d\",\"local_bytes\":0,\"other_bytes\":0,\"total_bytes\":0}}\n", d, 5000+i, i
				printf "{\"type\":\"flow_stats\",\"internal\":true,\"interface\":\"br-lan\",\"flow\":{\"digest\":\"%s\",\"local_ip\":\"192.168.9.10\",\"local_mac\":\"02:00:00:00:00:aa\",\"other_ip\":\"93.184.216.34\",\"other_mac\":\"02:00:00:00:00:ff\",\"local_bytes\":10,\"other_bytes\":10,\"total_bytes\":20}}\n", d
			}
		}'
	} > "$EV"
	feed_and_settle || return

	local apps refused rep2
	apps=$(field aggregates apps); refused=$(field aggregates refused)
	rep2=$(field bytes reported)
	note "apps=$apps refused=$refused reported=$rep2 (500 apps offered, AGG_MAX is 384)"

	# SABOTAGE: in agg_make(), delete `stats.aggs_refused++` from the
	# victim == null branch. The table still refuses correctly and the operator
	# still cannot see it, which is the defect this counter was added for.
	chk_ge "a refused aggregate is counted, not only logged" 1 "$refused"

	if [ "${apps:-0}" -le 384 ] 2>/dev/null; then
		ok "the aggregate table stays within AGG_MAX ($apps <= 384)"
	else
		bad "aggregate table holds $apps, above AGG_MAX"
	fi

	# SABOTAGE: in agg_make(), change the victim == null branch to evict the
	# oldest entry regardless of cur.flows. Bytes belonging to an evicted live
	# aggregate stop reaching the totals, so reported and the summary total
	# diverge and this goes red.
	#
	# 500 flows x 20 bytes = 10000, and every one is reported whether or not it
	# got its own aggregate row. That is the documented promise: the table
	# refuses to GROW, it does not drop bytes from the totals.
	chk "every offered byte is still reported when the table is full" "10000" "$rep2"

	head2 "BOUNDS: the unknown-type map cannot be grown without limit"

	# UNKNOWN_TYPE_MAX is 16. Offer 60 distinct unhandled type names.
	{
		hello
		awk 'BEGIN { for (i = 1; i <= 60; i++) printf "{\"type\":\"unkflood_%d\",\"payload\":{}}\n", i }'
	} > "$EV"
	feed_and_settle || return

	local ntypes
	ntypes=$(st | sed -n '/"unknown_types": {/,/}/p' | grep -c '": *[0-9]')
	note "distinct unknown types remembered: $ntypes (UNKNOWN_TYPE_MAX is 16)"

	# SABOTAGE: in dispatch(), delete the
	# `length(stats.unknown_types) < UNKNOWN_TYPE_MAX` guard. The map grows to
	# 60 and this goes red. A peer that can pick type names would otherwise grow
	# it without bound, and it is serialised into every status reply.
	if [ "${ntypes:-0}" -le 16 ] 2>/dev/null; then
		ok "the unknown-type map is bounded ($ntypes <= 16)"
	else
		bad "unknown_types holds $ntypes entries"
	fi

	head2 "BOUNDS: a peer that stops sending newlines is resynced, not unbounded"

	# RX_MAX is 262144. Send 512 KB with no newline in it at all, then a real
	# flow, so we can prove the reader recovered rather than merely survived.
	{
		hello
		awk 'BEGIN { s = ""; while (length(s) < 4096) s = s "x"; for (i = 0; i < 128; i++) printf "%s", s }'
		printf '\n'
		flow_ev L0000012 1012 protoapp-afterflood 60 40 100 true 02:00:00:00:00:aa
	} > "$EV"
	feed_and_settle || return

	local rs rep3
	rs=$(field events resyncs); rep3=$(field bytes reported)
	note "resyncs=$rs reported=$rep3"

	# SABOTAGE: in on_readable(), delete the `if (length(rxbuf) > RX_MAX)`
	# block. resyncs stays 0 and the buffer grows to whatever the peer sends.
	chk_ge "a 512 KB line without a newline forces a resync" 1 "$rs"

	# SABOTAGE: in the same block, drop back to `rxbuf = ""` unconditionally
	# instead of cutting at the last newline. The flow that follows the flood is
	# then eaten along with it and this goes red.
	chk "the reader recovers and still parses the next flow" "100" "$rep3"
}

# --------------------------------------------------------------- attribution

test_attribution() {
	head2 "ATTRIBUTION: a WAN-side copy of a LAN flow is shadowed, not counted twice"

	# The double-count class. With netifyd watching br-lan and the WAN at once,
	# a client's traffic is captured twice; DESIGN 3.2 says the internal capture
	# is the device's own copy and the external one is a NAT twin.
	#
	# Same digest, two captures, 1000 bytes each. The honest answer is that 2000
	# were reported and 1000 attributed, with 1000 shadowed. A daemon that
	# counts both says the client used twice what it did.
	{
		hello
		flow_ev M0000013 1013 protoapp-twin 500 500 1000 true  02:00:00:00:00:aa
		flow_ev N0000014 1013 protoapp-twin 500 500 1000 false 02:00:00:00:00:bb
	} > "$EV"
	feed_and_settle || return

	local rep att shd
	rep=$(field bytes reported); att=$(field bytes attributed); shd=$(field bytes shadowed)
	note "reported=$rep attributed=$att shadowed=$shd"

	# SABOTAGE: in flow_identify(), replace the `dev_local` expression with a
	# constant `true`. The external capture is then treated as its own device's
	# traffic, shadowed falls to 0 and attributed rises to 2000.
	chk "both captures are reported" "2000" "$rep"
	chk "only one copy is attributed" "1000" "$att"
	chk "the WAN-side twin is shadowed" "1000" "$shd"

	# SABOTAGE: any of the above. Conservation must hold across the shadow
	# split as well, and this is the check that ties the three together: a
	# daemon that shadowed a copy but forgot to report it would pass the three
	# above individually while losing bytes.
	chk "attributed + shadowed == reported" "2000" "$(( att + shd ))"
	chk "leaked is still 0 across a shadow decision" "0" "$(field bytes leaked)"
}

# -------------------------------------------------------------------- hostile

test_hostile() {
	head2 "HOSTILE INPUT: nothing off the wire is interpreted"

	# Everything in a flow record arrives from netifyd, which derives most of it
	# from packets. host_server_name in particular is an SNI or an HTTP Host
	# header: it is attacker-chosen, it reaches this daemon, and it is
	# serialised into a ubus reply that a browser then renders.
	#
	# The daemon shells out to nothing, so the shell metacharacters below should
	# be inert. This check is what makes that a tested property rather than an
	# assumption, and it is cheap to keep.
	local canary=/tmp/appflow-hostile-canary
	rm -f "$canary"
	{
		hello
		printf '{"type":"flow","internal":true,"interface":"br-lan","flow":{"digest":"O0000015","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","host_server_name":"$(touch %s)`touch %s`;touch %s","detected_application":1015,"detected_application_name":"protoapp-hostile","local_bytes":0,"other_bytes":0,"total_bytes":0}}\n' "$canary" "$canary" "$canary"
		printf '{"type":"flow_stats","internal":true,"interface":"br-lan","flow":{"digest":"O0000015","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":11,"other_bytes":22,"total_bytes":33}}\n'
	} > "$EV"
	feed_and_settle || return

	# THIS RUNTIME CHECK BINDS NOTHING TODAY, AND THE STATIC ONE BELOW IS THE
	# REAL GUARD. Reviewers converged on this and they were right.
	#
	# The canary cannot be turned red by any edit that leaves appflowd doing
	# what it does, because appflowd never invokes a shell. The only edits that
	# make it fire ADD a capability the daemon has never had. That is defect
	# injection, not sabotage, so under the rule this file is written to it
	# binds nothing and it must not be counted as behavioural coverage.
	#
	# It is kept, clearly labelled, because it costs one file existence test and
	# it is the only thing that would catch a future maintainer adding a shell
	# call on this path. What it is NOT is evidence that shell safety is tested.
	if [ -e "$canary" ]; then
		bad "a host_server_name was interpreted by a shell: $canary exists"
	else
		ok "(future-change guard, binds nothing today) no shell ran on the hostile name"
	fi

	# THIS is the assertion that binds, and it binds because the property being
	# asserted is itself a property of the text: appflowd's shell safety comes
	# from the daemon containing no shell invocation at all, so "the source
	# contains no such construct" is the guarantee rather than a stand-in for
	# it. The defect and the text are the same object.
	#
	# SABOTAGE: add `system("true");` anywhere in root/usr/sbin/appflowd. This
	# goes red and the canary above does not, which is the whole reason both
	# are here.
	local D=/usr/sbin/appflowd
	if [ -r "$D" ]; then
		local shellcalls
		shellcalls=$(grep -cE '\b(system|popen|exec|spawn)[[:space:]]*\(' "$D")
		chk "the daemon contains no shell or process-spawning construct" "0" "$shellcalls"

		# The same property one level up: a module it never imports is a
		# capability it cannot reach by accident.
		#
		# SABOTAGE: add `import * as fs2 from "fs";`-style access to a process
		# module. Pinned as an exact set because every import is a capability.
		local imports
		imports=$(grep -oE '^import .* from "[a-z]+"' "$D" | grep -oE '"[a-z]+"$' | tr -d '"' | sort | tr '\n' ' ')
		chk "the daemon imports exactly the five modules it needs" \
		    "fs socket ubus uci uloop " "$imports"
	else
		bad "cannot read $D to check it for shell constructs"
	fi

	# SABOTAGE: in flow_identify(), remove the `substr(f.host_server_name, 0, 63)`
	# bound. The stored host grows to whatever the peer sent.
	chk "the flow was still accounted normally (11+22)" "33" "$(field bytes reported)"

	head2 "HOSTILE INPUT: reserved-looking key names are ordinary data"

	# In a JS engine these names reach Object.prototype and a lookup on a plain
	# object literal returns a function rather than undefined. That defect was
	# real in this package's BROWSER code and was fixed there with
	# hasOwnProperty.
	#
	# ucode is not JavaScript and its objects carry no prototype chain, so the
	# daemon has never been exposed to it. Verified directly:
	#   ucode -e 'let o = {}; print(o.constructor);'   prints nothing
	#
	# The check stays because the property under test is "a device or
	# application named like a language builtin is stored and returned as
	# ordinary data", which is worth pinning on either engine, and because the
	# sibling defect proves the input is reachable. It is honestly a weak check
	# on this engine and section 7 of any review should say so.
	{
		hello
		flow_ev P0000016 1016 constructor    10 10 20 true 02:00:00:00:00:aa
		flow_ev Q0000017 1017 __proto__      10 10 20 true 02:00:00:00:00:aa
		flow_ev R0000018 1018 hasOwnProperty 10 10 20 true 02:00:00:00:00:aa
		flow_ev S0000019 1019 toString       10 10 20 true 02:00:00:00:00:aa
	} > "$EV"
	feed_and_settle || return

	local apps rep
	apps=$(field aggregates apps); rep=$(field bytes reported)
	note "apps=$apps reported=$rep"

	# SABOTAGE: in agg_make(), change the `let a = tbl[key]` lookup to consult a
	# fresh object literal seeded from tbl. On an engine with a prototype chain
	# the four names below would then resolve to inherited functions; on ucode
	# they would not, which is the honest limit of this check.
	chk "four builtin-named applications produce four aggregates" "4" "$apps"
	chk "and their bytes are accounted normally (4 x 20)" "80" "$rep"

	head2 "HOSTILE INPUT: the ubus reply survives control characters"

	# A name containing an embedded quote, a backslash and a newline escape. If
	# any of them reached the reply unescaped, ubus's own JSON output would be
	# malformed and the browser would fail to parse the whole document rather
	# than showing one odd row.
	{
		hello
		printf '{"type":"flow","internal":true,"interface":"br-lan","flow":{"digest":"T0000020","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","detected_application":1020,"detected_application_name":"ev\\"il\\\\name\\nsecond","local_bytes":0,"other_bytes":0,"total_bytes":0}}\n'
		printf '{"type":"flow_stats","internal":true,"interface":"br-lan","flow":{"digest":"T0000020","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":5,"other_bytes":5,"total_bytes":10}}\n'
	} > "$EV"
	feed_and_settle || return

	# SABOTAGE: in the ubus reply path, build the JSON by string concatenation
	# instead of handing the object to the ubus binding. The reply stops being
	# parseable and this goes red.
	#
	# Parsed rather than pattern-matched, deliberately: a grep for a quote would
	# assert on the spelling of the escape, while this asserts that the document
	# is well formed, which is the property that matters to the browser.
	if ubus call appflow summary 2>/dev/null | jsonfilter -e '@' >/dev/null 2>&1; then
		ok "the summary reply is still well-formed JSON"
	else
		bad "a hostile application name made the ubus reply unparseable"
	fi
	chk "and the flow was accounted (5+5)" "10" "$(field bytes reported)"
}

# ------------------------------------------------------------------ lifecycle

test_lifecycle() {
	head2 "LIFECYCLE: reset clears the counters it claims to"

	{
		hello
		flow_ev U0000021 1021 protoapp-reset 1234 4321 5555 true 02:00:00:00:00:aa
	} > "$EV"
	feed_and_settle || return

	local before tot_before tot_after rep att shd lk
	before=$(field bytes reported)
	tot_before=$(ubus call appflow summary 2>/dev/null | sed -n 's/.*"bytes_total": *\([0-9]*\).*/\1/p' | head -1)
	chk "fixture: bytes were counted before the reset" "5555" "$before"
	chk "fixture: and the summary shows them" "5555" "$tot_before"

	ubus call appflow reset >/dev/null 2>&1
	sleep 2

	tot_after=$(ubus call appflow summary 2>/dev/null | sed -n 's/.*"bytes_total": *\([0-9]*\).*/\1/p' | head -1)
	rep=$(field bytes reported); att=$(field bytes attributed)
	shd=$(field bytes shadowed); lk=$(field bytes leaked)
	note "after reset: summary=$tot_after  reported=$rep attributed=$att shadowed=$shd leaked=$lk"

	# WHAT RESET ACTUALLY PROMISES, because the first version of this check got
	# it wrong and read as a defect.
	#
	# It asserted `bytes.reported == 0` after a reset and failed with 5555.
	# m_reset() zeroes the AGGREGATES -- totals, apps, devices, categories, and
	# each flow's attributed up/down -- and deliberately does not touch
	# `stats.bytes_*`, which are lifetime process counters. Its own comment says
	# so. The summary is what the button clears and what the user sees; the
	# conservation counters measure the daemon against netifyd for the life of
	# the process and resetting them would destroy the only record of a leak.
	#
	# SABOTAGE: in m_reset(), delete the `agg_reset(totals, now)` call. The
	# summary keeps its 5555 and this goes red.
	chk "the summary total is zero after a reset" "0" "$tot_after"

	# The invariant is the part worth guarding, not any single counter's value.
	#
	# SABOTAGE: in m_reset(), add `stats.bytes_reported = 0;` and nothing else.
	# reported drops to 0 while attributed stays 5555, so leaked computes
	# negative and this goes red. That is the realistic way a future edit
	# breaks this: somebody makes reset "more thorough" one counter at a time.
	chk "the conservation invariant survives a reset (leaked still 0)" "0" "$lk"
	chk "and reported still equals attributed + shadowed" "$rep" "$(( att + shd ))"

	note "note: bytes.* are lifetime counters and survive a reset by design"

	head2 "LIFECYCLE: the daemon reconnects when the peer goes away"

	local rc0 rc1
	rc0=$(field socket reconnects); rc0=${rc0:-0}
	fake_down
	sleep 3
	fake_up || { bad "could not bring the fake agent back up"; return; }

	local i=0
	while [ "$i" -lt 30 ]; do
		[ "$(st | sed -n 's/.*"connected": *\(true\|false\).*/\1/p' | head -1)" = "true" ] && break
		i=$((i + 1)); sleep 1
	done
	rc1=$(field socket reconnects); rc1=${rc1:-0}
	note "reconnects before=$rc0 after=$rc1"

	# SABOTAGE: in disconnect(), delete the schedule_reconnect() call. The
	# daemon never comes back and both checks go red. Losing netifyd silently
	# and permanently is the failure this guards: status would keep answering,
	# with numbers frozen at the moment the agent went away.
	chk "the daemon is connected again after the peer returned" "true" \
	    "$(st | sed -n 's/.*"connected": *\(true\|false\).*/\1/p' | head -1)"
	chk_ge "the reconnect was counted" "$((rc0 + 1))" "$rc1"
}

# ------------------------------------------------------------------------ acl

test_acl() {
	head2 "ACL: the grant list matches what the package uses"

	local A=/usr/share/rpcd/acl.d/luci-app-appflow.json
	[ -f "$A" ] || { bad "ACL file not installed"; return; }

	# These four are the same checks the hardware suite makes and they are
	# repeated here on purpose: this suite is the one that can run without
	# traffic, and an ACL check that only runs on the slow path is an ACL check
	# that stops being run.
	#
	# SABOTAGE for each: add the named grant back to the ACL file. That file is
	# part of the product, it is what rpcd enforces, and these are properties of
	# its text rather than of a behaviour standing behind the text -- which is
	# the case where reading source is a binding assertion rather than a hollow
	# one.
	if grep -q '"network"' "$A"; then
		bad "ACL grants uci read on 'network' (PPPoE/wireguard secrets)"
	else
		ok "ACL does not grant uci read on 'network'"
	fi

	if grep -q '"uci"' "$A"; then
		bad "ACL contains a uci grant; this package reads only its own ubus object"
	else
		ok "ACL contains no uci grant at all"
	fi

	if grep -q '"file"' "$A"; then
		bad "ACL contains a file grant; this package shells out to nothing"
	else
		ok "ACL contains no file/exec grant"
	fi

	local W
	W=$(sed -n '/"write"/,$p' "$A" | grep -oE '"[a-z_]+"' | grep -vE '"write"|"ubus"|"appflow"' | tr -d '"' | tr '\n' ' ')
	chk "the only write grant is appflow.reset" "reset" "$(echo "$W" | tr -d ' ')"

	# Every granted read method must be one the frontend actually declares, and
	# every method the frontend declares must answer. The second half is the
	# addition: the hardware suite checks that the ACL grants nothing extra, and
	# nothing checked that a granted method exists at all.
	#
	# SABOTAGE: add `"nonexistent_method"` to the read grant list in the ACL.
	# The loop below calls it, ubus refuses, and this goes red. A grant naming a
	# method that does not exist is dead text that outlives the thing it named.
	local m missing=""
	for m in $(sed -n '/"read"/,/"write"/p' "$A" | grep -oE '"[a-z_]+"' \
	           | grep -vE '"read"|"write"|"ubus"|"appflow"' | tr -d '"' | sort -u); do
		ubus -v list appflow 2>/dev/null | grep -q "\"$m\"" || missing="$missing $m"
	done
	if [ -z "$(echo "$missing" | tr -d ' ')" ]; then
		ok "every granted read method exists on the ubus object"
	else
		bad "granted but not offered by the daemon:$missing"
	fi
}

# ------------------------------------------------------------- AI breakout

# A flow carrying an SNI. Separate from flow_ev() rather than an extra
# parameter on it, because every existing caller of flow_ev states its byte
# totals by hand and adding an optional field in the middle is how those calls
# silently shift by one.
#
# ai_flow <digest> <app_id> <app_name> <host> <local> <other> <total>
ai_flow() {
	printf '{"type":"flow","internal":true,"interface":"br-lan","flow":{"digest":"%s","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_port":40001,"other_port":443,"ip_protocol":6,"host_server_name":"%s","detected_application":%s,"detected_application_name":"%s","detected_protocol":91,"detected_protocol_name":"TLS","category":{"application":10,"protocol":20},"local_bytes":0,"other_bytes":0,"total_bytes":0}}\n' \
		"$1" "$4" "$2" "$3"
	printf '{"type":"flow_stats","internal":true,"interface":"br-lan","flow":{"digest":"%s","local_ip":"192.168.9.10","local_mac":"02:00:00:00:00:aa","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":%s,"other_bytes":%s,"total_bytes":%s}}\n' \
		"$1" "$5" "$6" "$7"
}

# The application label the daemon settled on for a given app name, read from
# the summary. Returns MISSING when absent, for the same reason field() does:
# a helper that cannot find its subject must turn its check red rather than
# return something plausible.
# jsonfilter, not sed. The first version of app_bytes() ranged from the "name"
# line to the next closing brace and looked for bytes_total inside it, but
# bytes_total appears BEFORE name in the object, so the range never contained
# it and every call returned the empty string. A structural query cannot make
# that mistake; a line-range over JSON can, and did.
app_present() {
	local k
	k=$(ubus call appflow summary '{"limit":50}' 2>/dev/null |
	    jsonfilter -e "@.top_apps[@.name=\"$1\"].key" | head -1)
	[ -n "$k" ] && echo YES || echo NO
}

# Bytes attributed to one application name. MISSING on a miss, never 0: a
# helper that cannot find its subject must turn its check red rather than
# return a number that happens to look plausible.
app_bytes() {
	local v
	v=$(ubus call appflow summary '{"limit":50}' 2>/dev/null |
	    jsonfilter -e "@.top_apps[@.name=\"$1\"].bytes_total" | head -1)
	printf '%s' "${v:-MISSING}"
}

# The category the daemon PUTS ON THE WIRE for one application. MISSING on a
# miss, never empty, so a helper that cannot find its subject turns its check
# red rather than comparing two blanks and passing.
app_cat() {
	local v
	v=$(ubus call appflow apps '{"limit":50}' 2>/dev/null |
	    jsonfilter -e "@.apps[@.name=\"$1\"].category" | head -1)
	printf '%s' "${v:-MISSING}"
}

# Bytes on one device aggregate. MISSING on a miss, never 0, so a helper that
# cannot find its subject turns its check red instead of comparing two blanks.
dev_bytes() {
	local v
	v=$(ubus call appflow devices '{"limit":20}' 2>/dev/null |
	    jsonfilter -e "@.devices[@.key=\"$1\"].bytes_total" | head -1)
	printf '%s' "${v:-MISSING}"
}

# A WAN-side flow the router itself originated: local_* is the router's own
# address and MAC, which is what makes is_router() true for the local side.
router_flow() {
	printf '{"type":"flow","internal":false,"interface":"wan","flow":{"digest":"%s","local_ip":"%s","local_mac":"%s","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_port":40001,"other_port":443,"ip_protocol":6,"detected_application":0,"detected_application_name":"","detected_protocol":91,"detected_protocol_name":"TLS","category":{"application":10,"protocol":20},"local_bytes":0,"other_bytes":0,"total_bytes":0}}\n' \
		"$1" "$RIP" "$RMAC"
	printf '{"type":"flow_stats","internal":false,"interface":"wan","flow":{"digest":"%s","local_ip":"%s","local_mac":"%s","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":%s,"other_bytes":%s,"total_bytes":%s}}\n' \
		"$1" "$RIP" "$RMAC" "$2" "$3" "$4"
}

# A second stats event on an existing router flow, carrying a larger cumulative
# counter. This is the update that used to discard the flow.
router_stats() {
	printf '{"type":"flow_stats","internal":false,"interface":"wan","flow":{"digest":"%s","local_ip":"%s","local_mac":"%s","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":%s,"other_bytes":%s,"total_bytes":%s}}\n' \
		"$1" "$RIP" "$RMAC" "$2" "$3" "$4"
}

test_router_origin() {
	head2 "ROUTER-ORIGINATED TRAFFIC SURVIVES CONNTRACK FORGETTING THE FLOW"

	# THE DEFECT, found 2026-08-31 on BOTH routers. The "Router" pseudo-device
	# had never counted a single byte in production: 107,476 flows where
	# conntrack positively confirmed the router originated the traffic, and a
	# device row reading zero. The dashboard then correctly hides a zero-byte
	# device, so the feature was invisibly absent rather than visibly broken.
	#
	# The mechanism, measured with temporary counters in the daemon rather than
	# reasoned about: flow_identify() asks conntrack, gets a positive "the
	# router originated this", keeps the flow and attaches it. Then the FIRST
	# flow_stats event runs reshadow(), which asks the same question again. By
	# then the connection has often closed and its conntrack entry is gone, so
	# the answer is "unknown", and the code treated unknown as grounds to
	# discard. Absence of evidence overrode a positive determination already
	# made. That is the same mistake statusStrip() carries a comment about.
	#
	# This test pins the ordering that matters: resolve once, then let conntrack
	# forget, and the bytes must still land.
	local RIP RMAC CT
	CT=/tmp/appflow-ct-fixture
	RIP=$(jsonfilter -i /var/run/netifyd/status.json -e '@.interfaces.wan.addr[0]' 2>/dev/null)
	case "$RIP" in
		*.*) : ;;
		*) RIP=$(jsonfilter -i /var/run/netifyd/status.json -e '@.interfaces.wan.addr[1]' 2>/dev/null) ;;
	esac
	RMAC=$(jsonfilter -i /var/run/netifyd/status.json -e '@.interfaces.wan.mac' 2>/dev/null)

	if [ -z "$RIP" ] || [ -z "$RMAC" ]; then
		skip "no WAN address/mac in netifyd status; cannot forge a router flow"
		return
	fi
	note "router WAN identity: $RIP / $RMAC"

	# A conntrack line in the kernel's own format. The daemon keys on the REPLY
	# tuple and decides "was the source translated" by comparing the ORIGINAL
	# src against the REPLY dst. Equal means no NAT, i.e. the router itself
	# opened this connection.
	printf 'ipv4 2 tcp 6 431999 ESTABLISHED src=%s dst=93.184.216.34 sport=40001 dport=443 packets=4 bytes=400 src=93.184.216.34 dst=%s sport=443 dport=40001 packets=4 bytes=400 [ASSURED] mark=0 zone=0 use=2\n' \
		"$RIP" "$RIP" > "$CT"

	uci set appflow.main.conntrack_path="$CT"
	uci commit appflow

	# An internal flow first, so saw_internal is true: without it the whole
	# shadow path is skipped and this test would pass against a daemon that had
	# never worked. Then the router's own flow, and a SECOND stats update on it,
	# because the second update is what used to destroy the flow.
	#
	# local_bytes/other_bytes are per-update deltas; total_bytes is cumulative.
	{
		hello
		flow_ev RO000001 1001 lan-client 400 600 1000 true 02:00:00:00:00:aa
		router_flow RO000002 700 1300 2000
		router_stats RO000002 700 1300 4000
	} > "$EV"
	feed_and_settle || { uci delete appflow.main.conntrack_path; uci commit appflow; return; }

	# The conntrack block is the instrument this test depends on. Print it: a
	# run where entries is 0 or available is null is not a failing product, it
	# is a test that never armed, and the two must not look alike in the log.
	note "conntrack: $(ubus call appflow status 2>/dev/null | jsonfilter -e '@.conntrack' 2>/dev/null)"

	# THE SABOTAGE FOR THIS ONE IS BOTH HALVES OF THE FIX, NOT EITHER, and that
	# was established by running it rather than by reasoning. Reverting only the
	# ct_nat_twin() port lookup leaves this GREEN, because the fr.ct_local guard
	# then rescues the flow; reverting only the guard leaves it green too,
	# because the lookup succeeds. Revert both -- key off `f.local_port` again
	# AND drop the `if (fr.ct_local) return;` -- and this reads 0, which is what
	# every release up to and including 1.1.1 did.
	#
	# The check below is the one that isolates the root cause on its own.
	chk "a router-originated flow reaches the router device" "4000" "$(dev_bytes router)"

	# Same run, different question: the counter must show the lookup SUCCEEDING
	# on the update, not merely that some bytes arrived. unresolved > 0 here
	# means the key is not matching even though the entry is present.
	#
	# SABOTAGE: revert ct_nat_twin() to keying off `f.local_port`/`f.other_port`
	# instead of the ports stored on the flow record. A flow_stats event carries
	# no ports, so the key gains two empty fields and matches nothing. This is
	# the precise detector for the shipped defect, and it fires on that revert
	# alone even while the check above stays green.
	chk "and conntrack resolved every re-check" "0" \
	    "$(ubus call appflow status 2>/dev/null | jsonfilter -e '@.conntrack.unresolved' 2>/dev/null)"

	# THE MIRROR, and it is the one that matters most. A fix that simply stopped
	# shadowing would pass both checks above and reintroduce the double-count
	# this whole mechanism exists to prevent: a WAN-side copy of a NAT-ed client
	# measured at 163-199% of wire truth. With conntrack unable to confirm the
	# router originated anything, the flow must still be discarded.
	#
	# SABOTAGE: make reshadow() return unconditionally for dev_key "router".
	# The two checks above stay green and this goes red.
	: > "$CT"
	{
		hello
		flow_ev RO000011 1001 lan-client 400 600 1000 true 02:00:00:00:00:aa
		router_flow RO000012 700 1300 2000
		router_stats RO000012 700 1300 4000
	} > "$EV"
	feed_and_settle

	note "with an empty conntrack: router = $(dev_bytes router)"
	chk "an unconfirmable router flow is still shadowed, not counted" \
	    "MISSING" "$(dev_bytes router)"

	uci delete appflow.main.conntrack_path 2>/dev/null
	uci commit appflow
	rm -f "$CT"
}

test_netify5() {
	head2 "WHAT REAL NETIFYD SENDS: NO ADDRESSES ON UPDATES, NEW 5.x MESSAGE TYPES"

	# THE DEFECT, found 2026-10-12 in a Docker test against netifyd 4.4.7 and
	# 5.2. A flow_stats event carries the digest and the byte counters and
	# nothing else: no ports, no addresses. The fake events everywhere else in
	# this suite put local_ip/other_ip on every flow_stats, which real netifyd
	# never does, and that is why the suite stayed green while router flows
	# identified before the first LAN flow were silently shadowed: reshadow()
	# re-asked conntrack with a key built from the update's (absent) addresses.
	local RIP RMAC CT
	CT=/tmp/appflow-ct-fixture5
	RIP=$(jsonfilter -i /var/run/netifyd/status.json -e '@.interfaces.wan.addr[0]' 2>/dev/null)
	case "$RIP" in
		*.*) : ;;
		*) RIP=$(jsonfilter -i /var/run/netifyd/status.json -e '@.interfaces.wan.addr[1]' 2>/dev/null) ;;
	esac
	RMAC=$(jsonfilter -i /var/run/netifyd/status.json -e '@.interfaces.wan.mac' 2>/dev/null)

	if [ -n "$RIP" ] && [ -n "$RMAC" ]; then
		printf 'ipv4 2 tcp 6 431999 ESTABLISHED src=%s dst=93.184.216.34 sport=40005 dport=443 packets=4 bytes=400 src=93.184.216.34 dst=%s sport=443 dport=40005 packets=4 bytes=400 [ASSURED] mark=0 zone=0 use=2\n' \
			"$RIP" "$RIP" > "$CT"
		uci set appflow.main.conntrack_path="$CT"
		uci commit appflow

		# Order is the point: the router's flow is identified BEFORE any LAN
		# flow, so saw_internal is still false and nothing is decided then.
		# The LAN flow arrives, saw_internal goes true, and the router flow's
		# later updates, carrying no addresses, are what re-check conntrack.
		{
			hello
			printf '{"type":"flow","internal":false,"interface":"wan","flow":{"digest":"N5R00001","local_ip":"%s","local_mac":"%s","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_port":40005,"other_port":443,"ip_protocol":6,"detected_application":0,"detected_application_name":"","detected_protocol":91,"detected_protocol_name":"TLS","category":{"application":10,"protocol":20},"local_bytes":0,"other_bytes":0,"total_bytes":0}}\n' "$RIP" "$RMAC"
			flow_ev N5L00001 1001 lan-client 400 600 1000 true 02:00:00:00:00:aa
			printf '{"type":"flow_stats","internal":false,"interface":"wan","flow":{"digest":"N5R00001","local_bytes":700,"other_bytes":1300,"total_bytes":2000}}\n'
			printf '{"type":"flow_stats","internal":false,"interface":"wan","flow":{"digest":"N5R00001","local_bytes":700,"other_bytes":1300,"total_bytes":4000}}\n'
		} > "$EV"
		feed_and_settle

		# SABOTAGE: delete the two `fr.local_ip`/`fr.other_ip` assignments in
		# flow_identify(), or make ct_nat_twin() key off f.local_ip again. The
		# router row then reads MISSING, which is what 1.1.2 did.
		chk "a router flow seen before any LAN flow still counts" "4000" "$(dev_bytes router)"
		uci delete appflow.main.conntrack_path 2>/dev/null
		uci commit appflow
		rm -f "$CT"
	else
		skip "no WAN address/mac in netifyd status; cannot forge a router flow"
	fi

	# THE SHORTFALL, seen once in 133 updates on netifyd 5.2: total_bytes grew
	# by more than local_bytes + other_bytes. The difference showed as leaked.
	#
	#   first update   local 400  other 600  total 1000
	#   second update  local 100  other 100  total 1500   (grew 500, deltas 200)
	#
	# Expected: the device gets 1500, the cumulative total, and nothing leaks.
	# SABOTAGE: delete the `sum > 0 && sum < dt` branch in flow_update(). The
	# device then reads 1200 and leaked reads 300.
	{
		hello
		flow_ev N5S00001 1001 lan-client 400 600 1000 true 02:00:00:00:00:bb
		printf '{"type":"flow_stats","internal":true,"interface":"br-lan","flow":{"digest":"N5S00001","local_bytes":100,"other_bytes":100,"total_bytes":1500}}\n'
	} > "$EV"
	feed_and_settle
	chk "a shortfall update still credits the full growth" "1500" "$(dev_bytes 02:00:00:00:00:bb)"
	chk "and nothing is reported as leaked" "0" "$(field bytes leaked)"

	# 5.x sends flow_dpi_update / flow_dpi_complete as classification firms
	# up. They carry nothing appflow needs; they must not count as unknown.
	# SABOTAGE: drop them from HANDLERS. unknown then reads 2.
	{
		hello
		flow_ev N5D00001 1001 lan-client 400 600 1000 true 02:00:00:00:00:cc
		printf '{"type":"flow_dpi_update","flow":{"digest":"N5D00001"}}\n'
		printf '{"type":"flow_dpi_complete","flow":{"digest":"N5D00001"}}\n'
	} > "$EV"
	feed_and_settle
	chk "5.x classification events are not counted as unknown" "0" "$(field events unknown)"

	# Connected but silent: on 5.x the old socket path accepts a connection
	# and sends nothing, and that read as a healthy idle router. A minute with
	# no events at all must raise the flag. One hello, then nothing; the
	# housekeeping sweep runs every 15 s, so wait past 60 + 15.
	# SABOTAGE: never set `silent` in housekeeping(). The flag then reads false.
	#
	# The fake hangs up after HOLD_S, appflowd reconnects and the fake replays
	# the hello, which is not silence. The first run of this check failed that
	# way, against a daemon that was right. Hold the line past the wait here.
	local HOLD_S=150
	hello > "$EV"
	feed_and_settle
	note "waiting 80 s for the silence to register"
	sleep 80
	chk "a connection that sends nothing is flagged silent" "true" \
	    "$(st | jsonfilter -e '@.socket.silent' 2>/dev/null)"
}

test_ai_breakout() {
	head2 "AI BREAKOUT (hostname matching, and the things it must NOT match)"

	# WHY THIS FEATURE EXISTS, measured: /etc/netify.d/netify-apps.conf is dated
	# 10 August 2023, holds 199 signatures, and contains no AI vendor at all, so
	# this traffic arrives as generic HTTP/S with detected_application 0. The SNI
	# is already present in the flow record. Everything below drives the REAL
	# daemon through the fake netifyd socket, so the oracle is the daemon's own
	# output rather than a reimplementation of its table.

	uci set appflow.main.ai_breakout=1 2>/dev/null
	uci commit appflow

	# Byte totals stated by hand, chosen so no two sums coincide:
	#
	#   anthropic  A   local 1100  other 2200  total 3300
	#   claude.ai  B   local  100   other  200  total  300
	#   openai     C   local   11   other   22  total   33
	#   evil       D   local    7   other   13  total   20
	#
	#   Anthropic (Claude) must aggregate A+B = 3600 into ONE row.
	#   sum(total) over all four = 3653
	{
		hello
		ai_flow AI000001 0 "" "api.anthropic.com"                 1100 2200 3300
		ai_flow AI000002 0 "" "claude.ai"                          100  200  300
		ai_flow AI000003 0 "" "api.openai.com"                      11   22   33
		# SUFFIX ANCHORING. This host is registrable by anyone and a substring
		# test on "anthropic.com" matches it. It must not be labelled Anthropic.
		#
		# SABOTAGE: in ai_match(), replace the label-boundary suffix rebuild with
		# an index()/substring test. This check goes red on its own.
		ai_flow AI000004 0 "" "anthropic.com.attacker.example"        7   13   20
	} > "$EV"
	feed_and_settle

	chk "an SNI netifyd could not classify is labelled" \
	    "YES" "$(app_present 'Anthropic (Claude)')"
	chk "and so is a second AI vendor" "YES" "$(app_present 'OpenAI')"

	# THE MERGE. anthropic.com and claude.ai are one vendor. Keying on the
	# matched suffix instead of the label would produce two identically-named
	# rows, which looks like a rendering bug and hides the real total.
	#
	# SABOTAGE: in flow_identify(), set `key = "ai:" + ai.via`. The bytes split
	# across two rows and this drops to 3300.
	chk "two domains of one vendor aggregate into a single row" \
	    "3600" "$(app_bytes 'Anthropic (Claude)')"

	# THE LOOKALIKE MUST LAND SOMEWHERE ELSE, and that is asserted by finding it
	# where it belongs rather than by failing to find it where it does not.
	#
	# Two earlier versions of this check were TAUTOLOGIES, caught by running the
	# sabotage rather than by reading them. One asked whether an app named
	# "Anthropic (Claude)x" was present, which nothing can ever make true. The
	# other grepped the summary for the hostname, which the summary does not
	# carry at all. Both stayed green with the suffix matcher replaced by a
	# substring test, which is the exact defect they were written for.
	#
	# anthropic.com.attacker.example arrives as app_id 0 over detected_protocol
	# 91, so unlabelled it aggregates as "TLS" carrying its own 20 bytes. Under
	# a substring matcher those bytes move into Anthropic and this reads MISSING.
	#
	# SABOTAGE: in ai_match(), match with index() instead of rebuilding the last
	# N labels.
	chk "a lookalike domain keeps its own identity, not the vendor it imitates" \
	    "20" "$(app_bytes TLS)"

	# The counter must move, and by exactly the number of flows relabelled.
	# Without this, "the label appeared" could come from anywhere.
	#
	# SABOTAGE: delete `stats.ai_labeled++`.
	chk "exactly three flows were relabelled" "3" "$(field flows ai_labeled)"

	# THE CATEGORY IS A SLUG, AND NOTHING ELSE IN EITHER SUITE CHECKED IT.
	#
	# 1.1.0 shipped this column as four English display strings, "AI assistants"
	# and three siblings, where every netifyd category is a lowercase slug. They
	# read correctly in English and could therefore never be translated: the
	# browser renders a category by looking the slug up in a table of _()
	# literals, and a string that arrives already rendered has no key to look
	# up. Every check in this group passed throughout, because all of them
	# assert on labels, bytes and counters and none of them had ever looked at
	# the category at all.
	#
	# This asserts the value ON THE WIRE, from the real daemon, which is the
	# only place the contract is real. The frontend suite reads the same table
	# out of the daemon source; that catches a bad edit, this catches a bad
	# emission, and neither subsumes the other.
	#
	# SABOTAGE: in appflowd's AI_HOSTS table, change any category back to a
	# display string, e.g. "ai-assistants" -> "AI assistants". This goes red and
	# every other check in this group stays green.
	chk "the AI category reaches the wire as a slug" \
	    "ai-assistants" "$(app_cat 'Anthropic (Claude)')"
	chk "and so does a second vendor's" "ai-assistants" "$(app_cat 'OpenAI')"

	# The mirror: a daemon that hardcoded one slug for everything would pass
	# both rows above. A flow the AI table did NOT match must still carry the
	# category netifyd gave it.
	#
	# ASSERTED AS A PROPERTY, NOT A LITERAL, AND THAT IS DELIBERATE. The first
	# version expected "unclassified" and was simply wrong: the fixture sends
	# category.application 10, and appflowd resolves that through
	# catnames.app[] against the box's own /etc/netify.d/netify-categories.json,
	# which on this bench is "file-sharing". Pasting that observed value back in
	# would have made the check depend on one router's netifyd index, so a
	# netifyd update would turn it red having broken nothing. What the check is
	# actually for is that the AI block does not reach flows it never matched.
	#
	# SABOTAGE: set the category unconditionally in the AI block rather than
	# from the table. This goes red while the two rows above stay green.
	local tlscat verdict
	tlscat=$(app_cat TLS)
	case "$tlscat" in
		MISSING|"") verdict=MISSING ;;
		ai-*)       verdict=AI-LEAKED ;;
		*)          verdict=OK ;;
	esac
	note "the unmatched TLS flow carries category '$tlscat'"
	chk "a flow the AI table did not match keeps its netifyd category" \
	    "OK" "$verdict"

	# ACCOUNTING IS UNTOUCHED. This is the check that matters most: the feature
	# changes an identity and must not be able to change a byte.
	#
	# SABOTAGE: move the AI block after flow_attach(), or have it touch fr.a.
	local tot
	tot=$(ubus call appflow summary 2>/dev/null | sed -n 's/.*"bytes_total": *\([0-9]*\).*/\1/p' | head -1)
	chk "byte conservation holds with AI flows present (3300+300+33+20)" \
	    "3653" "${tot:-MISSING}"

	head2 "AI BREAKOUT: netifyd's own answer wins unless we say otherwise"

	# THE SELF-RETIRING PROPERTY. If netifyd identified an application, its
	# answer stands. That is what makes this table fall silent by itself the day
	# Netify ship AI signatures, instead of permanently shadowing better data.
	#
	# SABOTAGE: drop the `app_id == 0` half of the gate in flow_identify(). The
	# first check goes red.
	{
		hello
		ai_flow AI000010 4242 "netify.some-cdn" "api.anthropic.com" 500 500 1000
	} > "$EV"
	feed_and_settle

	# "netify.some-cdn" renders as "Some CDN" via display_name()/title_case(),
	# read back from a live run rather than predicted.
	chk "netifyd's application identification is NOT overridden" \
	    "YES" "$(app_present 'Some CDN')"
	chk "and the AI label was not applied over it" \
	    "NO" "$(app_present 'Anthropic (Claude)')"
	chk "so no flow was relabelled" "0" "$(field flows ai_labeled)"

	# THE EXCEPTION. A `strong` entry overrides even a netifyd identification,
	# because netifyd recognises the PARENT brand and would swallow the service
	# inside it: Gemini reported as Google, Copilot as GitHub.
	#
	# SABOTAGE: change gemini.google.com's third field to false. This goes red
	# and the check above stays green, which is the distinction it exists for.
	{
		hello
		ai_flow AI000011 4243 "netify.google" "gemini.google.com" 400 600 1000
	} > "$EV"
	feed_and_settle

	chk "a strong entry DOES override netifyd's parent-brand answer" \
	    "YES" "$(app_present 'Google Gemini')"

	head2 "AI BREAKOUT: hostile and awkward hostnames"

	# "constructor" and "toString.prototype" as hostnames.
	#
	# These are here to PROVE ucode behaves as the daemon's comment claims, not
	# because they catch a live bug. In a browser `{}["constructor"]` returns a
	# function and such a hostname would read as a match; in ucode there is no
	# prototype chain and the lookup is null. Confirmed by sabotage: replacing
	# the array type-check with a truthiness test changes no result here, so
	# this group is NOT the reason that check exists and must not claim to be.
	#
	# What these hostnames do still prove is that a label-shaped input which is
	# not a domain neither matches nor crashes the daemon.
	#
	# Also covers case folding and a trailing dot, both legal in a FQDN and both
	# capable of shifting every suffix by one label.
	{
		hello
		ai_flow AI000020 0 "" "constructor"          10 10 20
		ai_flow AI000021 0 "" "toString.prototype"   10 10 20
		ai_flow AI000022 0 "" "API.ANTHROPIC.COM"    30 30 60
		ai_flow AI000023 0 "" "api.openai.com."      40 40 80
		ai_flow AI000024 0 "" "notanthropic.com"     50 50 100
		ai_flow AI000025 0 "" ""                     60 60 120
	} > "$EV"
	feed_and_settle

	chk "an uppercase SNI still matches" "YES" "$(app_present 'Anthropic (Claude)')"
	chk "a trailing-dot FQDN still matches" "YES" "$(app_present 'OpenAI')"

	# notanthropic.com shares a substring with anthropic.com but not a label
	# boundary, and must not match. Counted rather than name-checked, because
	# "is Anthropic present" is already true from AI000022 in this same batch.
	#
	# SABOTAGE: as for the lookalike above.
	chk "exactly two of six awkward hostnames were relabelled" \
	    "2" "$(field flows ai_labeled)"

	if [ "$(field bytes reported)" = "MISSING" ]; then
		bad "status did not report byte totals after the hostile batch"
	else
		ok "the daemon survived the hostile hostname batch and still reports"
	fi

	head2 "AI BREAKOUT: the upgrade path, where the option is absent"

	# THE UPGRADE PATH. apk treats /etc/config/appflow as a configuration file
	# and leaves an existing one alone, so a config written by a version before
	# this feature existed has no ai_breakout line at all. That is what every
	# upgrading router has, which makes it the COMMON case, and it was the one
	# case this group did not cover: the checks above set the option explicitly
	# to 1, and the off-switch check sets it explicitly to 0.
	#
	# CFG_DEFAULTS says 1 and the daemon comment says "Absent means ON". This is
	# the check that makes that true rather than merely claimed.
	#
	# SABOTAGE: change CFG_DEFAULTS.ai_breakout to 0, or make load_config() treat
	# a missing value as off. Both go red here and nowhere else, because every
	# other check in this file states the option explicitly.
	uci delete appflow.main.ai_breakout 2>/dev/null
	uci commit appflow
	chk "the option really is absent (fixture guard)" "" "$(uci -q get appflow.main.ai_breakout)"

	{
		hello
		ai_flow AI000040 0 "" "api.anthropic.com" 300 300 600
	} > "$EV"
	feed_and_settle

	chk "with no ai_breakout option at all, the feature is ON" \
	    "1" "$(field flows ai_labeled)"
	chk "and the vendor is labelled" "YES" "$(app_present 'Anthropic (Claude)')"
	chk "status reports the default as enabled" "1" "$(field config ai_breakout)"

	head2 "AI BREAKOUT: the off switch"

	# A user who does not want an asserted classification must be able to turn
	# it off completely, and the setting must be visible in status so support
	# questions can be answered without asking for the config file.
	#
	# SABOTAGE: ignore cfg.ai_breakout in flow_identify().
	uci set appflow.main.ai_breakout=0
	uci commit appflow
	{
		hello
		ai_flow AI000030 0 "" "api.anthropic.com" 100 100 200
	} > "$EV"
	feed_and_settle

	chk "with ai_breakout off, nothing is relabelled" "0" "$(field flows ai_labeled)"
	chk "and the AI label does not appear" "NO" "$(app_present 'Anthropic (Claude)')"
	chk "status reports the setting" "0" "$(field config ai_breakout)"

	uci set appflow.main.ai_breakout=1
	uci commit appflow
}

test_hostmap() {
	head2 "HOSTMAP: teaching appflow a service it does not know"

	# WHY THIS EXISTS. Someone asked the obvious question of any traffic
	# classifier: "I have a service I want measured, what do I do?" The answer
	# used to be "edit the daemon and rebuild the package", which for a tool
	# whose pitch is that netifyd's signatures are three years stale is the
	# wrong shape entirely.
	#
	# `config hostmap` sections add to the built-in table, or override it.

	cp /etc/config/appflow /tmp/appflow.hostmap.keep

	# The worked example from the documentation, verbatim. If the docs and the
	# code ever diverge, this is where it shows.
	cat >> /etc/config/appflow <<'HMEOF'

config hostmap
	option suffix 'torproject.org'
	option name 'Tor'
	option category 'Privacy'
HMEOF
	uci commit appflow 2>/dev/null

	{
		hello
		ai_flow HM000001 0 "" "check.torproject.org"     100 200 300
		ai_flow HM000002 0 "" "www.torproject.org"        10  20  30
		# NOT Tor: shares a substring but not a label boundary. Anyone can
		# register this, and a substring matcher would label it Tor.
		#
		# SABOTAGE: make the matcher use index() instead of rebuilding the
		# last N labels. This host is relabelled and the byte check goes red.
		ai_flow HM000003 0 "" "torproject.org.evil.test"   7  13  20
	} > "$EV"
	feed_and_settle

	chk "a user-supplied suffix is recognised" "YES" "$(app_present 'Tor')"

	# Both real hosts aggregate into the one application: 300 + 30 = 330.
	#
	# SABOTAGE: key the app on the matched suffix rather than the label. The
	# rows split and this drops to 300.
	chk "both hosts under it aggregate into one application" "330" "$(app_bytes Tor)"

	# The lookalike must keep its own identity. It is app_id 0 over
	# detected_protocol 91, so unlabelled it aggregates as TLS with its own 20
	# bytes.
	chk "a lookalike domain is not captured by a user entry" "20" "$(app_bytes TLS)"

	# The counter must move by exactly the number relabelled, so "the label
	# appeared" cannot come from somewhere else.
	chk "exactly two flows were relabelled" "2" "$(field flows ai_labeled)"

	head2 "HOSTMAP: overriding a built-in entry"

	# The same mechanism corrects a built-in that is wrong for someone's
	# network, which is the second half of what extensibility means.
	#
	# SABOTAGE: consult AI_HOSTS before cfg.hostmap in the matcher. The
	# built-in name comes back and this goes red.
	cp /tmp/appflow.hostmap.keep /etc/config/appflow
	cat >> /etc/config/appflow <<'HMEOF'

config hostmap
	option suffix 'anthropic.com'
	option name 'Work AI'
	option category 'Business'
HMEOF
	uci commit appflow 2>/dev/null

	{
		hello
		ai_flow HM000010 0 "" "api.anthropic.com" 500 500 1000
	} > "$EV"
	feed_and_settle

	chk "a user entry overrides the built-in name" "YES" "$(app_present 'Work AI')"
	chk "and the built-in name is gone" "NO" "$(app_present 'Anthropic (Claude)')"

	head2 "HOSTMAP: malformed entries are refused, not half-applied"

	# A suffix with no dot can never match, because the matcher compares whole
	# labels, so accepting one produces a rule that silently does nothing.
	#
	# THE GUARD'S ONLY OBSERVABLE EFFECT IS THE LOG LINE, and that is worth
	# knowing. Removing the guard changes no classification at all: a dotless
	# suffix matches nothing either way. What it changes is whether a user who
	# fatfingered an entry is TOLD, or is left staring at a feature that appears
	# not to work. An earlier version of this comment claimed the sabotage would
	# redden a classification check; running it proved otherwise, so the check
	# below asserts the thing that actually differs.
	#
	# SABOTAGE: drop the `index(suf, ".") < 0` guard. The warning disappears and
	# the log check goes red.
	cp /tmp/appflow.hostmap.keep /etc/config/appflow
	# MARK THE LOG, do not count it.
	#
	# Two ways this went wrong before it worked. Grepping the whole history
	# passes forever once a message has appeared even once, so the sabotage that
	# removes the guard left the check green on a PREVIOUS run's warning. Then
	# counting lines and reading past the count failed too, because logread is a
	# RING: the buffer was already full at its maximum, the count stopped
	# growing, and the window was always empty. A unique marker is immune to
	# both.
	local LOGTAG
	LOGTAG="hostmap-test-$$-$(date +%s)"
	logger -t appflow-suite "$LOGTAG" 
	cat >> /etc/config/appflow <<'HMEOF'

config hostmap
	option suffix 'notadomain'
	option name 'Bad'

config hostmap
	option suffix 'example.net'
	option name ''

config hostmap
	option suffix 'good.example'
	option name 'Good'
HMEOF
	uci commit appflow 2>/dev/null

	{
		hello
		ai_flow HM000020 0 "" "host.good.example" 40 60 100
		ai_flow HM000021 0 "" "notadomain"        10 10  20
	} > "$EV"
	feed_and_settle

	chk "the valid entry still works alongside malformed ones" "YES" "$(app_present 'Good')"
	chk "an entry with no name is refused" "NO" "$(app_present 'Bad')"
	chk "only the valid flow was relabelled" "1" "$(field flows ai_labeled)"

	# The user must be TOLD which entry was skipped, by name. Silence here is
	# indistinguishable from the feature being broken.
	local NEWLOG
	NEWLOG=$(logread 2>/dev/null | sed -n "/$LOGTAG/,\$p")
	if printf '%s
' "$NEWLOG" | grep -q "hostmap: skipping entry with suffix notadomain"; then
		ok "a dotless suffix is named in the log, not silently dropped"
	else
		bad "a dotless suffix was skipped without telling anyone"
	fi
	if printf '%s
' "$NEWLOG" | grep -q "hostmap: skipping entry with suffix example.net"; then
		ok "an entry with no name is named in the log too"
	else
		bad "the nameless entry was skipped without telling anyone"
	fi

	# Accounting is untouched by any of this: 100 + 20 = 120.
	#
	# SABOTAGE: have the hostmap path touch fr.a or run after flow_attach().
	local tot
	tot=$(ubus call appflow summary 2>/dev/null | sed -n 's/.*"bytes_total": *\([0-9]*\).*/\1/p' | head -1)
	chk "byte conservation holds with user entries present" "120" "${tot:-MISSING}"

	cp /tmp/appflow.hostmap.keep /etc/config/appflow
	uci commit appflow 2>/dev/null
	rm -f /tmp/appflow.hostmap.keep
}

test_drilldown() {
	head2 "DRILL-DOWN: device <-> application, from the live flow table"

	# WHY THIS EXISTS. "Who is using the bandwidth" was answerable and "what is
	# that thing doing" was not. Both answers are one pass over the flow table,
	# which already carries dev_key, app_key and cat_key on every record, so
	# neither needed a new aggregate. That was worth checking rather than
	# assuming: the first answer given was that it required a per-device
	# per-application table and was therefore a memory design question. It did
	# not, and the check took two minutes.
	#
	# Both directions report what CURRENTLY TRACKED flows account for, not
	# lifetime totals, because a flow that has ended is no longer in the table.
	# Every reply carries from_flows so a view cannot present one as the other.

	# Two devices, three applications, byte totals chosen so no two sums
	# coincide and every assertion below is a distinct number.
	#
	#   dev A (02:00:00:00:00:aa)  app 4001  local 1000 other 2000  = 3000
	#   dev A                      app 4002  local  100 other  200  =  300
	#   dev B (02:00:00:00:00:bb)  app 4001  local   10 other   20  =   30
	#
	#   app 4001 spans BOTH devices        -> 3030
	#   dev A spans BOTH applications      -> 3300
	dev_flow() {
		printf '{"type":"flow","internal":true,"interface":"br-lan","flow":{"digest":"%s","local_ip":"192.168.9.%s","local_mac":"%s","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_port":40001,"other_port":443,"ip_protocol":6,"detected_application":%s,"detected_application_name":"%s","detected_protocol":91,"detected_protocol_name":"TLS","category":{"application":10,"protocol":20},"local_bytes":0,"other_bytes":0,"total_bytes":0}}\n' \
			"$1" "$2" "$3" "$4" "$5"
		printf '{"type":"flow_stats","internal":true,"interface":"br-lan","flow":{"digest":"%s","local_ip":"192.168.9.%s","local_mac":"%s","other_ip":"93.184.216.34","other_mac":"02:00:00:00:00:ff","local_bytes":%s,"other_bytes":%s,"total_bytes":%s}}\n' \
			"$1" "$2" "$3" "$6" "$7" "$8"
	}

	{
		hello
		dev_flow DD000001 10 02:00:00:00:00:aa 4001 "netify.alpha" 1000 2000 3000
		dev_flow DD000002 10 02:00:00:00:00:aa 4002 "netify.beta"   100  200  300
		dev_flow DD000003 11 02:00:00:00:00:bb 4001 "netify.alpha"   10   20   30
		# A flow whose LIFETIME counter exceeds what appflow attributed, which
		# is what a stub adopted mid-transfer looks like: netifyd reports the
		# connection's whole life, appflow only ever attributes what it saw.
		# Without a row like this the two numbers are equal for every flow and
		# summing the wrong one is invisible, which is exactly what happened:
		# the sabotage below passed until this line existed.
		dev_flow DD000004 12 02:00:00:00:00:cc 4003 "netify.gamma"  400  600 9000
	} > "$EV"
	feed_and_settle

	# --- devices restricted to an application -----------------------------

	# SABOTAGE: in m_devices, ignore req.args.apps and always take the
	# aggregate path. from_flows goes false and every count below is wrong.
	local A B
	A=$(ubus call appflow devices '{"apps":["a4001"],"limit":10}' 2>/dev/null)

	chk "a device query restricted to one app says it came from flows" \
	    "1" "$(printf '%s' "$A" | grep -c '"from_flows": true')"
	chk "and finds BOTH devices carrying that application" \
	    "2" "$(printf '%s' "$A" | jsonfilter -e '@.total' 2>/dev/null)"

	# The heavier device sorts first, and its bytes are its own, not the
	# application's total across devices.
	#
	# SABOTAGE: sum fr.total instead of fr.up + fr.down. Device cc's flow has a
	# lifetime counter of 9000 and 1000 attributed, so the sabotage reports
	# 9000 and this goes red. Every other flow in the fixture has the two equal,
	# which is why that row had to be added: without it the sabotage passed.
	chk "the busier device is first" "3000" \
	    "$(printf '%s' "$A" | jsonfilter -e '@.devices[0].bytes_total' 2>/dev/null)"
	chk "and the quieter one carries only its own bytes" "30" \
	    "$(printf '%s' "$A" | jsonfilter -e '@.devices[1].bytes_total' 2>/dev/null)"

	# An application nothing used yields an empty answer, not the whole list.
	#
	# SABOTAGE: treat an empty match set as "no filter". This returns every
	# device, which is the failure that looks like the filter silently not
	# working.
	chk "an application with no flows yields no devices" "0" \
	    "$(ubus call appflow devices '{"apps":["a9999"]}' 2>/dev/null | jsonfilter -e '@.total')"

	# Absent or empty `apps` must take the ordinary aggregate path, or every
	# unfiltered page load starts answering from the flow table instead.
	chk "no apps argument means the ordinary aggregate" "1" \
	    "$(ubus call appflow devices '{"limit":5}' 2>/dev/null | grep -c '"from_flows": false')"

	# --- applications restricted to a device ------------------------------

	# The mirror image, and the one a person actually reaches for.
	#
	# SABOTAGE: in apps_for_device, compare fr.app_key against dev instead of
	# fr.dev_key. Everything below goes red at once.
	B=$(ubus call appflow apps '{"device":"02:00:00:00:00:aa","limit":10}' 2>/dev/null)

	chk "an application query scoped to a device says it came from flows" \
	    "1" "$(printf '%s' "$B" | grep -c '"from_flows": true')"
	chk "and finds both applications that device used" \
	    "2" "$(printf '%s' "$B" | jsonfilter -e '@.total' 2>/dev/null)"
	chk "the heavier application is first" "3000" \
	    "$(printf '%s' "$B" | jsonfilter -e '@.apps[0].bytes_total' 2>/dev/null)"
	chk "and the lighter one is its own total" "300" \
	    "$(printf '%s' "$B" | jsonfilter -e '@.apps[1].bytes_total' 2>/dev/null)"

	# The other device used only one application, which is the check that the
	# scope is really per-device rather than global.
	chk "a different device sees only its own applications" "1" \
	    "$(ubus call appflow apps '{"device":"02:00:00:00:00:bb"}' 2>/dev/null | jsonfilter -e '@.total')"

	chk "a device with no flows yields nothing" "0" \
	    "$(ubus call appflow apps '{"device":"02:00:00:00:00:zz"}' 2>/dev/null | jsonfilter -e '@.total')"

	chk "no device argument means the ordinary aggregate" "1" \
	    "$(ubus call appflow apps '{"limit":5}' 2>/dev/null | grep -c '"from_flows": false')"

	# --- the argument policy ---------------------------------------------

	# ubus REJECTS an undeclared argument rather than ignoring it, and the
	# rejection presents as the method returning nothing at all. Both new
	# arguments had to be added to the published policy, and forgetting either
	# is silent.
	#
	# SABOTAGE: remove `apps: []` or `device: ""` from the publish() policy.
	chk "the devices policy declares apps" "1" \
	    "$(ubus -v list appflow 2>/dev/null | grep -c '\"devices\":.*\"apps\":\"Array\"')"
	chk "the apps policy declares device" "1" \
	    "$(ubus -v list appflow 2>/dev/null | grep -c '\"apps\":.*\"device\":\"String\"')"

	# --- accounting is untouched -----------------------------------------

	# Both directions read the flow table and write nothing. Conservation must
	# hold exactly as it did: 3000 + 300 + 30.
	#
	# SABOTAGE: have either function mutate fr.up/fr.down while summing.
	# ATTRIBUTED, NOT LIFETIME. Device cc contributes its attributed 1000, not
	# its 9000 lifetime, so the total is 3000 + 300 + 30 + 1000.
	#
	# SABOTAGE: sum fr.total in either drill-down function.
	chk "a drill-down reports ATTRIBUTED bytes, not the lifetime counter" "1000" \
	    "$(ubus call appflow apps '{"device":"02:00:00:00:00:cc"}' 2>/dev/null | jsonfilter -e '@.apps[0].bytes_total')"

	chk "byte conservation is unaffected by either drill-down" "4330" \
	    "$(ubus call appflow summary 2>/dev/null | sed -n 's/.*"bytes_total": *\([0-9]*\).*/\1/p' | head -1)"
}

# ------------------------------------------------------------------------ run

printf 'appflow protocol and bounds suite\n'
printf 'router: %s   group: %s\n' \
	"$(uci -q get system.@system[0].hostname 2>/dev/null || echo '?')" "$GROUP"

command -v socat >/dev/null 2>&1 || { printf 'socat is required and is not installed\n'; exit 2; }

# Wait for the ubus object rather than demanding it instantly.
#
# appflowd registers a few seconds after procd starts it, so a bare check here
# fails whenever this suite is run right after something that restarted the
# daemon -- including the previous group of this same suite, whose cleanup
# restarts it. That happened on the first full pass: the hostile group exited 2
# and reported the daemon absent while it was starting up two feet away.
#
# The guard itself is right and stays. An absent daemon must stop the run, not
# be tested around, because every counter would then read MISSING and the
# failures would blame the product.
i=0
while [ "$i" -lt 20 ]; do
	ubus list appflow >/dev/null 2>&1 && break
	i=$((i + 1)); sleep 1
done
ubus list appflow >/dev/null 2>&1 || {
	printf 'the appflow ubus object never appeared; is appflowd installed and running?\n'
	exit 2
}

ORIG_SOCK=$(uci -q get appflow.main.socket_path)
ORIG_FLOWMAX=$(uci -q get appflow.main.flow_max)
[ -n "$ORIG_SOCK" ] || { printf 'appflow.main.socket_path is unset; refusing to guess\n'; exit 2; }
printf 'saved socket_path=%s flow_max=%s\n' "$ORIG_SOCK" "$ORIG_FLOWMAX"

# The test MACs must not be the router's own, or is_router() reclassifies every
# synthetic flow and the attribution checks assert on the wrong branch while
# still passing. Proving the fixture is valid costs one check and is the
# difference between a suite that tests attribution and one that tests nothing.
if ip link show 2>/dev/null | grep -qiE 'link/ether (02:00:00:00:00:aa|02:00:00:00:00:bb|02:00:00:00:00:ff)'; then
	bad "fixture: a test MAC collides with a real interface on this router"
else
	ok "fixture: no test MAC collides with a real interface"
fi

uci set appflow.main.socket_path="$SOCK"
uci commit appflow

case "$GROUP" in
	conservation) test_conservation ;;
	protocol)     test_protocol ;;
	bounds)       test_bounds ;;
	attribution)  test_attribution ;;
	hostile)      test_hostile ;;
	lifecycle)    test_lifecycle ;;
	acl)          test_acl ;;
	ai)           test_ai_breakout ;;
	router)       test_router_origin ;;
	netify5)      test_netify5 ;;
	hostmap)      test_hostmap ;;
	drilldown)    test_drilldown ;;
	all)          test_conservation; test_protocol; test_bounds
	              test_attribution; test_hostile; test_lifecycle; test_acl
	              test_ai_breakout; test_hostmap; test_drilldown
	              test_router_origin; test_netify5 ;;
	*)            printf "unknown group '%s'\n" "$GROUP"; exit 2 ;;
esac

printf '\n----------------------------------------\n'
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
