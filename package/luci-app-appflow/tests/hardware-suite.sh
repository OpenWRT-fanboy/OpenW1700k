#!/bin/sh
# appflow hardware test suite.
#
# The behavioural claims this package makes that can be checked without a
# browser, as one runnable script. It exists because all of them had previously
# been verified only by ad-hoc commands typed once and thrown away, and because
# two of this daemon's defects were silent: they produced wrong numbers while
# every status field said things were fine.
#
# RUN IT ON A SANDBOX ROUTER. It restarts appflowd, resets its counters, and
# generates traffic. It does not modify configuration.
#
#   usage:  sh hardware-suite.sh              run everything
#           sh hardware-suite.sh conservation run one group
#                                             (health|conservation|conntrack|restart|acl)
#
# Exit status is the number of failed checks.
#
# WHAT THIS SUITE CAN AND CANNOT CATCH, established by running it against the
# pre-fix v1.0.1 daemon on 2026-08-25, which is the only test of a test worth
# anything:
#
#   caught:      an old daemon with no conservation counters at all
#                (status.bytes missing), and any leak once they exist
#   NOT caught:  the reshadow double-count itself. The restart ratio came back
#                1.012 on the known-broken daemon, having been 0.70 and 0.79 on
#                two runs the day before. See the note in test_restart.
#
# Unlike the wansentry suite, nothing here reimplements the code under test:
# every check queries the running daemon over ubus. The weakness is coverage,
# not construction.
#
# WIRE TRUTH. Where a test needs to know how many bytes really moved, it reads
# the client veth's own counter in /sys/class/net. Nothing in appflowd can
# influence that number, which is the entire point: comparing appflow against
# appflow proves nothing.
#
# Requires: appflowd and netifyd running, root, and a network namespace client
# (see NETNS below) for the NAT tests. Groups that need the netns skip
# themselves with a clear message when it is absent rather than failing.

set -u

GROUP="${1:-all}"
NETNS="${NETNS:-cli}"
VETH="${VETH:-veth-host}"
PASS=0; FAIL=0; SKIP=0

head2() { printf '\n=== %s ===\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
skip() { SKIP=$((SKIP+1)); printf '  SKIP  %s\n' "$*"; }

st()   { ubus call appflow status 2>/dev/null; }
# field <group> <key>   e.g. field bytes leaked
field() {
	st | sed -n "/\"$1\"/,/}/p" | sed -n "s/.*\"$2\": *\([0-9-]*\).*/\1/p" | head -1
}
wire() { cat "/sys/class/net/$VETH/statistics/tx_bytes" 2>/dev/null || echo 0; }

have_netns() {
	ip netns list 2>/dev/null | grep -q "^$NETNS" && [ -r "/sys/class/net/$VETH/statistics/tx_bytes" ]
}

# A sustained NAT-ed transfer. The WAN here moves 50 MB in about a second, so an
# ordinary download finishes long before anything interesting happens; the
# throttle is TCP backpressure from a consumer that reads a fixed amount per
# second. head -c reads an exact count, dd on a pipe does short reads and
# throttles to a trickle instead.
slow_pull() { # slow_pull <seconds> <blocks-per-second>
	local secs="$1" bps="$2"
	ip netns exec "$NETNS" sh -c "
		{ printf 'GET /__down?bytes=40000000 HTTP/1.0\r\nHost: speed.cloudflare.com\r\nConnection: close\r\n\r\n'
		  sleep $secs
		} | socat - TCP:speed.cloudflare.com:80 2>/dev/null | {
			n=0
			while [ \"\$n\" -lt $secs ]; do
				head -c \$(( $bps * 65536 )) > /dev/null 2>&1 || break
				n=\$(( n + 1 )); sleep 1
			done
		}" >/dev/null 2>&1
}

ratio() { awk -v a="$1" -v w="$2" 'BEGIN{ if (w<=0) print "0"; else printf "%.3f", a/w }'; }
within() { # within <value> <lo> <hi>
	awk -v v="$1" -v lo="$2" -v hi="$3" 'BEGIN{ exit !(v>=lo && v<=hi) }'
}

# ---------------------------------------------------------------- health

test_health() {
	head2 "DAEMON HEALTH"

	# busybox pgrep has no -c, so count the lines rather than asking it to.
	if pgrep -f '[a]ppflowd' >/dev/null 2>&1; then
		ok "appflowd is running"
	else
		bad "appflowd is not running"; return
	fi

	[ -n "$(st)" ] && ok "ubus object 'appflow' answers" \
	                || bad "ubus call appflow status returned nothing"

	case "$(st | sed -n 's/.*"connected": *\(true\|false\).*/\1/p' | head -1)" in
		true) ok "connected to netifyd's export socket" ;;
		*)    bad "not connected to netifyd" ;;
	esac

	# A daemon that has never seen an event is not a healthy daemon, it is a
	# daemon whose socket happens to be open.
	# Default the value: an empty field makes [ -gt ] abort the whole script with
	# "out of range" instead of simply failing this one check.
	local seen; seen=$(field flows seen); seen=${seen:-0}
	if [ "$seen" -gt 0 ] 2>/dev/null; then
		ok "flows have been observed (seen=$seen)"
	else
		bad "no flows observed at all"
	fi
}

# ---------------------------------------------------------- conservation

test_conservation() {
	head2 "BYTE CONSERVATION (reported == attributed + shadowed)"
	# Both silent byte-loss defects this daemon has had would have shown here in
	# the first minute. This is the check that makes them loud.

	have_netns || { skip "needs netns '$NETNS' (conservation)"; return; }

	ubus call appflow reset >/dev/null 2>&1; sleep 2
	slow_pull 20 6
	sleep 25

	local rep att sh lk
	rep=$(field bytes reported); att=$(field bytes attributed)
	sh=$(field bytes shadowed);  lk=$(field bytes leaked)

	if [ -z "$rep" ] || [ -z "$lk" ]; then
		bad "status.bytes is missing (is this appflow >= 1.0.2?)"; return
	fi
	printf '        reported=%s attributed=%s shadowed=%s leaked=%s\n' "$rep" "$att" "$sh" "$lk"

	[ "$lk" = "0" ] && ok "leaked == 0 (nothing reported went unaccounted)" \
	                || bad "leaked == $lk, so bytes were reported and never attributed"

	[ "${rep:-0}" -gt 0 ] 2>/dev/null && ok "traffic was actually observed" \
	                             || bad "no bytes reported; the transfer did not happen"

	# purge_only_rescued counts flows that were purged having never received a
	# flow_stats. Those carry their whole byte count on the purge event, and
	# before this path existed every one of them was silently discarded.
	#
	# It is NOT expected to be zero, and an earlier version of this suite
	# asserted that it was. Measured on this hardware: 13 of 1341 flows, 0.97%.
	# A 38-flow event-socket capture had seen none, which at that rate has an
	# expected count of 0.4 -- so the sample was far too small to support the
	# "netifyd never does this" conclusion that was briefly drawn from it, and
	# the review that reported the byte loss was right.
	#
	# What is worth watching is the RATE. A sudden jump means netifyd's event
	# contract has shifted; zero across a busy run means this path stopped
	# firing and the rescue may have regressed.
	local po seen; po=$(field bytes purge_only_rescued); po=${po:-0}
	seen=$(field flows seen); seen=${seen:-0}
	if [ "$seen" -gt 200 ] 2>/dev/null; then
		printf '        purge_only_rescued=%s of %s flows (%s%%)\n' "$po" "$seen" \
		       "$(awk -v p="$po" -v s="$seen" 'BEGIN{printf "%.2f", 100*p/s}')"
		if awk -v p="$po" -v s="$seen" 'BEGIN{exit !(100*p/s <= 10)}'; then
			ok "purge-only rescues are a small fraction of flows"
		else
			bad "purge_only_rescued is $po of $seen flows; netifyd's contract may have shifted"
		fi
	else
		printf '        purge_only_rescued=%s (only %s flows seen; rate not meaningful)\n' "$po" "$seen"
		skip "too few flows to judge the purge-only rate"
	fi
}

# ---------------------------------------------------------------- conntrack

test_conntrack() {
	head2 "NAT TWIN RESOLUTION (conntrack)"
	have_netns || { skip "needs netns '$NETNS' (conntrack)"; return; }

	case "$(st | sed -n 's/.*"available": *\(true\|false\|null\).*/\1/p' | head -1)" in
		true) ok "conntrack is readable" ;;
		*)    bad "conntrack unavailable; NAT twins cannot be resolved" ;;
	esac

	ubus call appflow reset >/dev/null 2>&1; sleep 2
	slow_pull 15 6
	sleep 20

	local tw un
	tw=$(field conntrack twins); un=$(field conntrack unresolved)
	printf '        twins=%s router_local=%s unresolved=%s entries=%s\n' \
	       "$tw" "$(field conntrack router_local)" "$un" "$(field conntrack entries)"

	# The first version of this fix cached the snapshot for 2 s, so new flows
	# almost always missed and it silently degraded to the pre-fix behaviour
	# while reporting conntrack as available. High unresolved against zero twins
	# is exactly that signature.
	if [ "${tw:-0}" -gt 0 ] 2>/dev/null; then
		ok "NAT twins are being resolved on evidence"
	elif [ "${un:-0}" -gt 0 ] 2>/dev/null; then
		bad "unresolved=$un with twins=0: resolution is degrading to the safe default"
	else
		skip "no external captures in this window; nothing to resolve"
	fi
}

# ---------------------------------------------------------------- restart

test_restart() {
	head2 "RESTART MID-TRANSFER (reshadow must not double count)"
	have_netns || { skip "needs netns '$NETNS' (restart)"; return; }

	# reshadow() used to return early on dev_key == "router", which is exactly
	# how a WAN-side capture of a NAT-ed client flow is classified, so after a
	# restart both copies of a flow stayed counted for its whole remaining life.
	#
	# READ THIS BEFORE TRUSTING A GREEN RESULT HERE. This check is a broad
	# regression guard, not a reliable detector of that defect. Measured against
	# the pre-fix v1.0.1 daemon: 0.701 and 0.791 on two runs on 2026-08-24, then
	# 1.012 on 2026-08-25 -- the same broken code passing, because whether the
	# defect manifests depends on a NAT-ed flow actually spanning the restart
	# and being captured on both interfaces, and a sixty-second window does not
	# guarantee that.
	#
	# So: a RED result here is strong evidence of a real problem. A GREEN result
	# is weak evidence of correctness, and one green run is not proof the
	# attribution is sound. The conservation counters above are the dependable
	# signal; this one catches gross breakage.
	# PRECONDITION, CHECKED RATHER THAN ASSUMED: netifyd must actually capture
	# the path this traffic takes. `wire()` reads the test client's own veth, so
	# it counts every byte the client sent regardless of which uplink carried
	# them, while appflow can only ever count what netifyd was told to watch.
	#
	# This bit on 2026-08-27. A bench router had a second uplink and a VPN
	# tunnel added to it while netifyd still ran `-I br-lan -E wan`, and the
	# ratio dropped to 0.62. That reads as an attribution defect and is not one:
	# the traffic left by a path netifyd was never watching. The unmodified
	# shipped daemon produced the same failure, which is the only reason it was
	# not chased as a regression.
	#
	# A ratio computed over an uncaptured path is not a weak signal, it is a
	# meaningless one, so this skips loudly instead of reporting a number.
	local caps uncap
	caps=$(ps w 2>/dev/null | sed -n 's/.*netifyd.*/&/p' | head -1)
	uncap=""
	for d in $(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | sort -u); do
		case " $caps " in
			*" $d "*) ;;
			*) uncap="$uncap $d" ;;
		esac
	done
	if [ -n "$uncap" ]; then
		skip "netifyd does not capture default-route interface(s):$uncap -- ratio would be meaningless"
		[ "$(field bytes leaked)" = "0" ] && ok "leaked still 0" || bad "leaked != 0"
		return 0
	fi

	ubus call appflow reset >/dev/null 2>&1; sleep 2
	local w0; w0=$(wire)

	slow_pull 45 6 &
	local job=$!
	sleep 12
	/etc/init.d/appflowd restart >/dev/null 2>&1
	sleep 40
	wait $job 2>/dev/null
	sleep 20

	local w1 moved tot r
	w1=$(wire); moved=$(( w1 - w0 ))
	tot=$(st | sed -n 's/.*"bytes_total": *\([0-9]*\).*/\1/p' | head -1)
	[ -z "$tot" ] && tot=$(ubus call appflow summary 2>/dev/null | sed -n 's/.*"bytes_total": *\([0-9]*\).*/\1/p' | head -1)
	r=$(ratio "${tot:-0}" "$moved")
	printf '        wire=%s appflow=%s ratio=%s\n' "$moved" "${tot:-0}" "$r"

	if [ "$moved" -lt 100000 ]; then
		skip "not enough traffic moved to judge the ratio"
	elif within "$r" 0.80 1.25; then
		ok "total stays near wire truth across a restart (ratio $r)"
	else
		bad "ratio $r is outside 0.80-1.25; a restart is mis-attributing"
	fi

	[ "$(field bytes leaked)" = "0" ] && ok "leaked still 0 after a restart" \
	                                  || bad "leaked != 0 after a restart"
}

# ---------------------------------------------------------------- acl

test_categories() {
	head2 "Every category this box's netifyd can emit has a translatable label"

	# THE DRIFT GAP, and it is the one thing the offline suite structurally
	# cannot close. frontend-suite.js checks CATEGORY_LABELS against a list of
	# 43 tags hand-copied from netifyd 4.4.7. That catches a deleted entry. It
	# cannot catch netifyd ADDING a tag, because a list written today does not
	# know about it, and the product's response to an unknown tag is to
	# title-case it into credible English that is untranslatable for ever.
	#
	# Only a real box knows what its own netifyd carries. This check reads the
	# installed category file and asserts the frontend has a label for every
	# tag in it, so a netifyd upgrade that adds a category becomes a visible
	# test failure rather than a silently English label.
	#
	# SABOTAGE: delete any entry from CATEGORY_LABELS in common.js. This goes
	# red and names the tag. To see it fire for real, add a tag to
	# /etc/netify.d/netify-categories.json that the frontend does not know.
	local CATS=/etc/netify.d/netify-categories.json
	local JS=/www/luci-static/resources/view/appflow/common.js

	[ -f "$CATS" ] || { skip "netify category file absent ($CATS)"; return; }
	[ -f "$JS" ]   || { skip "appflow frontend not installed ($JS)"; return; }

	local tags missing n
	tags=$(jsonfilter -i "$CATS" -e '@.application_tag_index' \
	                             -e '@.protocol_tag_index' 2>/dev/null |
	       grep -o '"[a-z][a-z0-9-]*"' | tr -d '"' | sort -u)

	if [ -z "$tags" ]; then
		skip "could not read any category tag out of $CATS"
		return
	fi

	n=$(printf '%s\n' "$tags" | grep -c .)
	missing=""
	for t in $tags; do
		# The label table is `'tag': _('Label'),`. Matching the quoted key
		# against the file is enough: an entry that exists but is not wrapped
		# in _() is the offline suite's job, and it checks exactly that.
		grep -q "'$t':" "$JS" || missing="$missing $t"
	done

	if [ -z "$missing" ]; then
		ok "all $n category tags on this box have a CATEGORY_LABELS entry"
	else
		bad "netifyd carries category tags the frontend cannot translate:$missing"
	fi
}

test_acl() {
	head2 "ACL grants no more than the package uses"
	A=/usr/share/rpcd/acl.d/luci-app-appflow.json
	[ -f "$A" ] || { bad "ACL file not installed"; return; }

	# /etc/config/network holds PPPoE and 802.1x credentials and wireguard keys.
	# A sibling package had this grant removed on 2026-08-25 for that reason.
	if grep -q '"network"' "$A"; then
		bad "ACL grants uci read on 'network' (PPPoE/wireguard secrets)"
	else
		ok "ACL does not grant uci read on 'network'"
	fi

	# appflow reads nothing but its own ubus object, so a uci grant of any kind
	# would be a grant it does not use.
	if grep -q '"uci"' "$A"; then
		bad "ACL contains a uci grant; this package only uses its own ubus object"
	else
		ok "ACL contains no uci grant at all"
	fi

	if grep -q '"file"' "$A"; then
		bad "ACL contains a file grant; this package shells out to nothing"
	else
		ok "ACL contains no file/exec grant"
	fi

	# There IS a legitimate write: `reset` clears the live counters and the UI
	# offers it as a button. What must not appear is a write to anything else.
	W=$(sed -n '/"write"/,$p' "$A" | grep -oE '"[a-z_]+"' | grep -vE '"write"|"ubus"|"appflow"' | tr -d '"' | tr '\n' ' ')
	if [ "$(echo "$W" | tr -d ' ')" = "reset" ]; then
		ok "the only write grant is appflow.reset"
	else
		bad "write grants beyond appflow.reset: $W"
	fi

	# The grant list must not exceed what the frontend actually binds. Checking
	# only for absent CATEGORIES missed this: the ACL granted `apps` and `flows`
	# that no view calls, and `flows` is the live per-connection table rather
	# than an aggregate. The code comment even said the two were deliberately
	# unbound, so the evidence was sitting next to the defect.
	V=/www/luci-static/resources/view/appflow/common.js
	if [ -r "$V" ]; then
		DECL=$(grep -oE "declare\('[a-z_]+'" "$V" | sed "s/declare('//;s/'//" | sort -u)
		GRANT=$(sed -n '/"read"/,/"write"/p' "$A" | grep -oE '"[a-z_]+"' \
		        | grep -vE '"read"|"write"|"ubus"|"appflow"' | tr -d '"' | sort -u)
		EXTRA=$(for g in $GRANT; do echo "$DECL" | grep -qx "$g" || echo "$g"; done | tr '\n' ' ')
		if [ -z "$(echo "$EXTRA" | tr -d ' ')" ]; then
			ok "every granted read method is one the frontend declares"
		else
			bad "granted but never called by any view: $EXTRA"
		fi
	else
		skip "frontend not installed; cannot compare grants against declares"
	fi
}

# ---------------------------------------------------------------- run

printf 'appflow hardware suite\n'
printf 'group: %s   netns: %s   veth: %s\n' "$GROUP" "$NETNS" "$VETH"
have_netns || printf 'note: netns/veth absent; traffic tests will skip\n'

case "$GROUP" in
	health)       test_health ;;
	conservation) test_conservation ;;
	conntrack)    test_conntrack ;;
	restart)      test_restart ;;
	acl)          test_acl ;;
	categories)   test_categories ;;
	all)          test_health; test_conservation; test_conntrack
	              test_restart; test_acl; test_categories ;;
	*)            printf "unknown group '%s'\n" "$GROUP"; exit 2 ;;
esac

printf '\n----------------------------------------\n'
printf 'passed %d, failed %d, skipped %d\n' "$PASS" "$FAIL" "$SKIP"
exit $FAIL
