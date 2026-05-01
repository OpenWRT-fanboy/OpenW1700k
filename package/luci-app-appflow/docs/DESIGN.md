# appflow: Design

Status: v1 spec LOCKED (2026-08-21). Remaining open items tracked in §8.

## 1. Goal

A LuCI-native, fully open per-application traffic dashboard for OpenWrt, built
on the Netify Agent. Stock OpenWrt can tell you how much traffic crossed an
interface; it cannot tell you which application produced it. Several vendor
firmwares ship a DPI traffic-statistics screen that can, and this is an open
equivalent for stock OpenWrt.

Primary scope (v1): **live view**, per-application and per-device rates and
session totals, category grouping, live charts.
Explicit non-goal for v1, but designed-for: **historical accounting** (see §7).

## 2. Ground truth (verified on hardware, 2026-08-21)

Test platform: Linksys EA8500, OpenWrt 25.12.5, netifyd 4.4.7 (nDPI 5.0-based),
arch `arm_cortex-a15_neon-vfpv4`. All facts below observed live, not assumed.

### 2.1 Data source: netifyd JSON export socket

- netifyd **listens** on `unix:/var/run/netifyd/netifyd.sock`
  (`[socket] listen_path[0]`, enabled by default in the OpenWrt package).
- ucode connects with plain `socket.connect(path)`, verified.
- **Wire framing**: newline-delimited JSON where each payload line is preceded
  by a header line `{"length": N}`. Parser rule: parse each line; a lone
  `length` key = frame header (skip); anything else dispatches on `type`.
- Event types observed: `agent_hello`, `definitions`, `agent_status` (15 s
  cadence), `flow`, `flow_stats`.
- `/var/run/netifyd/status.json` contains **agent status only** (plus a useful
  MAC→IP `devices` map), no flow data. The socket is the only flow source.

### 2.2 Event schemas (as observed)

`flow` (fires on detection; `detection_updated` re-fires on refinement):

```json
{ "type": "flow", "interface": "wan", "internal": false,
  "flow": {
    "digest": "9c2d…",                     // unique flow key
    "detected_application": 10465,
    "detected_application_name": "netify.openwrt",
    "detected_protocol": 5,
    "detected_protocol_name": "DNS",
    "category": { "application": 31, "protocol": 14, "domain": 0 },
    "host_server_name": "openwrt.org",     // SNI/hostname when known
    "local_ip": "…", "local_mac": "…", "local_port": 53,
    "other_ip": "…", "other_mac": "…", "other_port": 57052,
    "other_type": "local" | "remote",
    "local_origin": bool, "ip_nat": bool, "ip_version": 4, "ip_protocol": 17,
    "first_seen_at": 1787325075857, "last_seen_at": …,        // ms epoch
    "risks": { "ndpi_risk_score": 10, "risks": [46] }         // bonus signal
  } }
```

`flow_stats` (periodic per-flow counter updates):

```json
{ "type": "flow_stats", "interface": "wan", "internal": false,
  "flow": { "digest": "…",
    "local_bytes": 0, "other_bytes": 240, "total_bytes": 480,
    "local_packets": 0, "other_packets": 2, "total_packets": 4,
    "last_seen_at": 1787325070685 } }
```

**Correction (implementation ground truth, 2026-08-21):** `local_bytes` /
`other_bytes` are **per-update deltas** during a flow's life, but on the
final `flow_purge` event for that flow they are **always zero** (confirmed
on 10+ live purge events), while `total_bytes` is the flow's final
cumulative value. Since the purge event cannot supply a final directional
split, appflowd recovers it by distributing the `total_bytes` delta since the
last known total across up/down using the flow's established up/down ratio
(accumulated from that flow's prior `flow_stats` deltas), rather than
accounting `local_bytes`/`other_bytes` from the purge event itself.

### 2.3 Naming and taxonomy

- `definitions` event carries id→tag maps: 416 applications, 217 protocols.
  Applications and protocols are SEPARATE id spaces that can collide numerically
  (id 206 is both `WireGuard` the protocol and `netify.cloudflare` the app), and
  legacy netify apps exist below 10000 (netflix=133), the `netify.` tag prefix,
  not the id range, is the discriminator. Details: docs/netifyd-4.4.7-interface.md.
- Category **names** live in `/etc/netify.d/netify-categories.json`:
  `application_tag_index` (32 tags: `streaming-media`, `social-media`, `games`,
  `voip`, `cdn`, `advertiser`, `os-software-updates`, `malware`, …) and
  `protocol_tag_index` (18 tags), plus `application_index` /
  `protocol_index` mapping category-id → member ids.
- Display-name policy: application name if detected (strip `netify.` prefix,
  title-case), else protocol name, else `Unknown`; hostname (`host_server_name`)
  shown as secondary detail.
- **Licensing**: the signature DB (`netify-apps.conf`) and generated category
  file are eGloo-proprietary data shipped by the `netifyd` package. appflow
  reads them at runtime and **vendors none of this data** in the repo.

### 2.4 Additional confirmed facts (research pass, 2026-08-21)

- `flow_purge` events carry `reason: closed|expired|terminated` and the
  flow's final cumulative `total_bytes`/`total_packets`, but
  `local_bytes`/`other_bytes` are always zero on purge (confirmed live, see
  §2.2); the final up/down split must be recovered from the accumulated
  ratio, not read off the purge event, before flow removal.
- **Corrected:** `dump_established_flows` does NOT exist in netifyd 4.4.7 (string absent from the binary; a research citation of v5-era docs was wrong). On (re)connect a
  client starts blind. The daemon
  tolerates `flow_stats` for unknown digests (stub "Unknown" entry). **Corrected
  2026-08-22:** that stub is backfilled only when a `flow` event actually follows,
  which happens for a genuine stats-before-flow race but NOT for a flow that was
  already established at connect time, netifyd never emits a `flow` event for
  those, so they stay Unknown for their remaining lifetime. Measured in §2.5.
- App detections are `netify.<slug>` strings; protocol names are plain.
- OpenWrt ships netifyd **4.4.7** while upstream is v5.x with a different
  plugin architecture, all behavior here is pinned to 4.4.7-as-packaged.
- netifyd bundles its own nDPI statically: `libndpi` is NOT a dependency.

### 2.5 Byte-attribution behavior (measured 2026-08-22)

Three questions about where bytes land were settled on the bench (EA8500,
netifyd 4.4.7). **Method matters here:** all earlier attempts were confounded by
upstream hosts throttling the test router's WAN IP under repeated fetches, and a
refused connection carries no SNI, so netifyd cannot classify it and it lands as
Unknown for reasons unrelated to this daemon. The measurements below therefore
use **LAN-local traffic only** (a file served from the router over `br-lan` via
`socat`, pulled by a LAN client with `curl --limit-rate`), so no upstream can
participate and throttling is impossible by construction.

- **Byte conservation through the Unknown path: HOLDS.** 25 short flows of 2 MB
  = 50,000,000 bytes of client-side ground truth against 51,127,054 bytes
  accounted (the excess is TCP/HTTP overhead, both directions). Repeated with
  150 *tiny* 1 KB flows (the case most likely to complete inside one
  `update_interval`, and so most likely to be purged before any `flow_stats`):
  all 150 accounted, `no_total` = 0, nothing lost. A plausible reading of the
  `fr.total > 0` gate in `flow_update()` predicts silent loss for such flows;
  that prediction is **refuted** on this hardware, because netifyd supplies
  accountable byte counts for sub-interval flows.

  **CORRECTED 2026-08-25. The two paragraphs below understated this, and the
  reviewers were right.** Once `purge_only_rescued` was instrumented and left
  running against ordinary traffic, it reported **13 purge-only flows out of
  1,341 seen, 0.97%**. Flows purged without ever receiving a `flow_stats` DO
  occur on netifyd 4.4.7. Before the defensive path was added, every one of them
  lost its entire byte count silently, which is exactly what three reviewers
  predicted and what this section briefly called refuted.

  The refutation was under-powered, not wrong-headed: a 38-flow capture at a
  0.97% rate has an expected count of 0.4, so observing none said almost
  nothing. Reading "0 of 38" as "netifyd never does this" was the error, and the
  lesson is that a negative result needs its sample size checked against the
  rate it claims to exclude. The event-level evidence below is still accurate
  about what it saw; it simply did not see enough.

  **Re-tested at the EVENT level 2026-08-24, after an adversarial review
  independently reached the same prediction three times.** The 2026-08-22 result
  above is outcome-based: it shows the bytes landed, not why. Tapping netifyd's
  export socket directly for 170 s (`flow`/`flow_stats`/`flow_purge` per digest,
  UDP DNS and short TCP both driven deliberately), **64 of 64 flows whose full
  lifecycle was observed carried a `flow_stats` before their `flow_purge`.**
  Zero went `flow` -> `flow_purge` directly. The premise the prediction rests on
  does not occur on netifyd 4.4.7.

  Two flows in that capture did show a purge with no preceding stats, and both
  were flows that predated the tap: their birth was simply not observed. That is
  §2.4 connect-blindness, not this. Mistaking one for the other is easy and is
  why the analysis is stated at the level of *fully observed* lifecycles.

  The gate is defended: `flow_update()` takes a `final` flag from `ev_purge()`
  and attributes `total_bytes` for a purge-only flow, counted in
  `stats.purge_only` and reported as `status.bytes.purge_only_rescued`. That
  counter is **not** expected to stay 0 -- it runs at about 1% of flows -- and
  it is the reason those bytes are now counted at all. Watch its rate rather
  than its presence: a sharp rise means netifyd's event contract has shifted,
  and a zero across a busy run means the rescue has regressed.
- **Connect/reconnect blindness: REAL, bounded, not fixable here.** A flow that
  is already established when the daemon connects gets `flow_stats` but never a
  `flow` event (§2.4), so its identity never arrives and its ongoing bytes
  accumulate under Unknown until it ends. Forced deterministically by restarting
  the daemon mid-transfer: 10.7 MB of a correctly-classified HTTP flow moved to
  Unknown while the app's own total stayed flat, and a fresh socket client
  observed 5 `flow_stats` and 0 `flow` events for that flow. Confined to the
  window after a daemon restart or a netifyd restart, self-heals as flows cycle,
  and the bytes are parked rather than lost. No fix exists on our side without
  an established-flow dump from netifyd; see §8.
- **Late re-point stranding: OPEN, see §8.** Distinct from the above and not yet
  observed in the wild.

Counters relevant to all three (`status.flows`) behaved consistently: `dropped`
stayed 0 and `late` stayed flat under sustained load, so the daemon is not
losing events under load; the Unknown mass seen during earlier testing was the
upstream confound plus the restart blindness above, not an event-handling defect.

## 3. Architecture

```
netifyd (DPI, procd service; nDPI engine)
    │  unix stream, length-framed JSON events
    ▼
appflowd — ucode daemon (procd service)
    • connects to netifyd.sock, reconnects with backoff
    • parses frames, maintains flow table keyed by digest
    • aggregates: totals + windowed rates per (application × device),
      per category, per device; prunes idle flows
    • serves snapshots over ubus  ←— single writer, many readers
    ▼
rpcd ACL (usr/share/rpcd/acl.d) gates LuCI session access
    ▼
LuCI JS view (htdocs/…/view/appflow/*.js)
    • L.poll every 3–5 s → ubus call → render
    • hand-drawn inline SVG charts (theme-aware via CSS custom properties);
      standard LuCI tables/widgets
```

Two implementation options for the ubus surface:

- **A (preferred): appflowd registers a ubus object directly** via
  `ucode-mod-ubus` (`conn.publish()`); rpcd ACL still governs LuCI access.
- **B (fallback): snapshot file**, appflowd atomically writes
  `/var/run/appflow/state.json`; a stateless rpcd-ucode plugin serves reads.

**DECIDED: Option A shipped**, `publish()` proven reliable on 25.12 (typed args,
status returns, int64 all verified on-device). Option B text retained above only as design rationale.

### 3.1 Why a persistent daemon (not an on-demand reader)

The socket is a **stream**: flows announce once, then only counter deltas
follow. Any on-demand reader would miss all context before it connected.
State must live in a long-running consumer; ucode + uloop keeps that consumer
tiny (no C, no external deps beyond packaged ucode modules).

### 3.2 Flow attribution and the dual-capture problem

netifyd watches `br-lan` (internal) and `wan` (external) simultaneously, so a
NAT'd client flow can be captured **twice** (pre- and post-NAT, different
digests, one per interface). The device a flow belongs to and whether it is a
duplicate must be decided without double-counting.

**The shipping rule (implemented in `flow_identify`).** An earlier design paired
the two captures on the remote endpoint and keyed the dedup on `ip_nat`; it was
replaced before v1 because that pairing was fragile (see §10). The rule that
ships is deterministic and needs no cross-flow pairing state:

- **Device side.** On an `internal` capture the device is the non-router
  endpoint; on an `external` capture the device is the router-owned endpoint
  (upstream infrastructure is the peer). `is_router()` decides which side is the
  router, from the interface MAC/IP maps learned from `agent_status`.
- **Multicast/broadcast** endpoints collapse to a single `multicast`
  pseudo-device (via netifyd's `other_type` when present, else the group-bit MAC
  test), so they cannot mint device aggregates.
- **Single-count (shadow) rule.** An `internal` capture is always counted (it is
  the device's own copy). An `external` capture is counted only when the device
  is the router itself; an external capture of a *client* flow is a NAT twin and
  is **shadowed** (tracked, never counted). This is gated on `saw_internal`, a
  process-wide latch meaning "internal capture is active at all": on an
  external-only netifyd (`-E` with no `-I`) nothing is shadowed, so every flow is
  counted rather than dropped to zero.

**What this rule is and is not.** It is a *mode* test ("is internal capture
running"), not a *per-flow twin* test ("does this specific flow have an internal
twin"). The two differ only for flows that appear on the WAN side alone, and
`fr.nat` (`ip_nat`) is retained as a diagnostic field in the `flows` method but
drives no decision.

**FIXED 2026-08-24 by consulting conntrack. The history below is kept because
the mistakes are the instructive part.**

netifyd cannot answer this question, so appflowd now asks the kernel. For each
external capture whose device resolves to the router, `ct_nat_twin()` looks the
flow up in `/proc/net/nf_conntrack` on its reply tuple and compares the ORIGINAL
source against the reply destination: they differ for a masqueraded client and
match for router-originated traffic. Snapshots are reused for `CT_TTL_MS`, and a
lookup miss forces one refresh (floored at `CT_FORCE_MIN_MS`) because a flow is
normally younger than the current snapshot. If conntrack cannot be read at all
the code shadows on the safe default and says so once in the log, which keeps
client accounting correct at the cost of not attributing the router's own
traffic.

Measured after the fix, against wire ground truth from interface counters:

| | wire truth | attributed | |
|---|---|---|---|
| NAT-ed client | 21,323,454 | 21,287,298 | 99.8% |
| router's own | 6,290,088 | 6,157,849 | 97.9% |

with `conntrack: available true, twins 20, router_local 2, unresolved 2`. Both
are counted once. The fallback path was tested by pointing `CONNTRACK_FILE` at a
non-existent path: totals stayed at 97% rather than doubling, `unresolved` rose
to 16, and the warning fired.

**A defect found in the first version of this very fix**, worth recording because
it would have been invisible: caching the snapshot for 2 s meant new flows,
which are exactly the ones needing classification, usually missed it. It looked
like it worked (totals were right, because everything got shadowed) while
silently degrading to the no-conntrack behavior with conntrack fully available.
`unresolved: 20` against `router_local: 0` was the tell.

---

**The original defect, for the record. This used to double-count.** An earlier revision of
this section, committed the same day, claimed the opposite and said the twin
was correctly shadowed. That claim rested on a single measurement and was
wrong; the correction and how it happened are recorded at the end of this
section, because the mistake is more instructive than the result.

The deciding fact was what netifyd 4.4.7 puts in `local_mac`/`other_mac` when
`ip_nat` is true. Measured: **it carries the router's own WAN identity, not the
client's.** A NAT'd flow's external
capture reports

```json
{ "ip_nat": true, "local_ip": "192.168.72.10",
  "local_mac": "c0:56:27:4e:3e:92", "local_origin": true,
  "other_ip": "172.66.0.218" }
```

where `192.168.72.10` / `c0:56:27:4e:3e:92` are this router's WAN address and
MAC, while the internal capture of the same flow carries the real client
(`192.168.1.50`).

That makes `dev_is_router` **true** on the twin, and the rule reads

```
want_shadow = (saw_internal && !fr.internal && !dev_is_router && !group)
```

so `!dev_is_router` is false and the twin is **NOT shadowed**. It is counted a
second time, under the `router` pseudo-device, on top of the internal capture
already counted against the real client. The global total roughly doubles for
NAT'd client traffic.

Measured with a genuine NAT'd client: a veth pair into a network namespace
attached to `br-lan`, addressed `192.168.1.50/24` with a default route through
the router, so its traffic is really forwarded and really NATed. Ground truth
is the veth interface byte counter, which is **wire** bytes, the same quantity
appflow counts.

Per-device attribution of the client itself is essentially exact. 25 flows of
2 MB:

| | bytes |
|---|---|
| wire ground truth to/from the client | 53,145,843 |
| appflow, client device | 53,145,347 |

496 bytes of difference in 53 MB. The client's own row is trustworthy.

**The global total is not.** The same run credited the `router` pseudo-device a
further 51,785,387 bytes, the external twin of the very same traffic. Three
clean single-flow trials, each restarting `appflowd` first and letting the flow
purge:

| run | wire truth | appflow grand total | ratio |
|---|---|---|---|
| 1 | 10,479,105 | 17,089,074 | 163% |
| 2 | 10,478,155 | 20,639,013 | 196% |
| 3 | 10,478,879 | 20,877,799 | 199% |

> **The rest of this subsection is HISTORICAL and describes the state before
> the fix above. It is kept because the reasoning is what led to the fix, but
> nothing below is an open problem.** A reviewer reading this document cold
> reported it as a live double-count, having entered mid-section, so if you are
> skimming, stop here and go to §3.3.

**Fix direction, at the time this was written, since implemented.** The `!dev_is_router` term exists for a
real reason: traffic the router genuinely originates belongs under `router` and
must not be shadowed. So it cannot simply be dropped. What is needed is a way
to tell a router-originated flow from a NAT'd client's twin, both of which
present the router's own MAC on the external capture. `ip_nat` looks like the
obvious discriminator and `fr.nat` already carries it, but it is **not
reliable**: a capture taken while generating both kinds of traffic reported
`ip_nat: false` for every flow including the NAT'd client's, even though
`ip_nat: true` was definitely observed on a router-WAN flow earlier the same
day. Any fix must first establish when netifyd actually sets that field.

**How the wrong conclusion got committed, because this is the useful part.**
The first measurement was a single 20 MB flow that reported the client at
20,950,037 bytes and `router` at 452. That looked decisive and was written up
as resolved. It was not reproducible: repeating the identical single-flow test
gave `router` 20,572,398 and a grand total of 167%. One measurement, no
repetition, and a result that happened to match the hoped-for branch. The same
failure this project has caught in reviewers repeatedly, committed by the
author, on the day it was caught elsewhere.

**Methodology warning for anyone repeating this.** An earlier run of the same
test reported 69% and then a spread of 46-101%, which would have been a serious
false finding. Both were the measurement, not the daemon: the first sampled
before the flow had purged and immediately after an `appflowd` restart (so it
also measured connect-blindness, §2.5), and the spread came from fragile shell
parsing picking the wrong record out of the JSON. Let `appflowd` settle before
the flow starts, let the flow purge before sampling, and read the numbers
directly rather than through `grep`.

**Related sub-case, now mitigated.** A pre-existing external flow captured only
as a stub (`flow_stats` before any `flow` event) is identified once, before
`saw_internal` latches, and would otherwise stay counted alongside its internal
twin for its whole life, inflating the central total. `reshadow()` re-applies
the shadow rule on later stats updates, closing that window to at most one stats
interval. The residual sign question for an unidentifiable stub (a genuine NAT
twin vs. pre-existing router-origin traffic, both landing in the "unknown"
bucket) folds into the same bench test above.

### 3.3 Memory bounds (runs on 128 MB devices)

Flow table capped (default 4096 flows, uci-tunable); LRU-pruned on purge
events, idle timeout, and cap pressure. No unbounded growth by construction,
but the real worst case for the aggregate tables is not small: each of
`AGG_MAX` (384) aggregates per class can carry up to `APP_DEV_MAX` (64)
per-device ring objects, a ceiling of 384 x 64 = 24,576 per-(app x device)
ring objects, plus up to `APP_HOST_MAX` (16) host ring entries per aggregate,
384 x 16 = 6,144 more. Observed RSS was approximately 2 MB at a light load of
33 apps and 11 devices (§8); the structural ceiling above is one to two
orders of magnitude higher than that observed point, not a number the box is
expected to reach under normal use, but worth stating plainly rather than
waved off as "naturally small".

**Every bound must be VISIBLE when it binds, and two of the three were not.**
A table that silently stops accepting data reports the same status as a table
with nothing to accept, which is the worst reading an operator can be given:
the dashboard looks healthy at exactly the moment it has become incomplete.

| bound | counter | added |
|---|---|---|
| aggregate table full of live entries | `aggregates.refused` | 2026-08-25 |
| flow table at `flow_max` | `flows.shed` | 2026-08-26 |
| unknown event-type map | (bounded at 16, not counted) | |

`flows.shed` counts evictions caused by **cap pressure**, separately from
`flows.pruned`, which is ordinary idle housekeeping and is expected to be
large. They shared one counter until 2026-08-26, so cap pressure was invisible
underneath normal behavior.

**`flows.dropped` is a genuine last-resort backstop and reads 0 in practice.**
`flow_new()` increments it only if the table is still full *after*
`prune(now, true)`, and that prune unconditionally sheds `int(flow_max/10) + 1`
entries, so it always frees space and the fall-through does not occur.
Measured by `tests/protocol-suite.sh`: 200 distinct digests against
`flow_max=64` gave `tracked=60 pruned=143 shed=143 dropped=0`. It is kept
because the guard is correct and cheap; it is not the number to watch.

The conventions this screen follows, which are the ones a DPI traffic screen
conventionally uses and which users of such screens already expect: a
**range-based** view (past hour, with day and week as later phases), a **15 s**
poll, table columns of Application / Download / Upload / Total sorted by total
descending, searchable, with a synthetic "All traffic" first row, a Top-10 bar
chart, and a per-app detail drawer carrying a time series plus per-client rows
(name, MAC, last seen, share %).

Classification here is **entirely local**: netifyd runs on the router, reads a
local socket, and nothing about the traffic leaves the device. Measured on the
development router, netifyd held 16 sockets over 4 days 23 hours of uptime, 12
unix and 3 packet-capture, and **zero TCP or UDP sockets**, with no outbound
connection at any point.

appflow v1 ships two tabs:

1. **Overview (live)**, the live view, which range-based DPI screens do not
   generally provide. Live total
   throughput chart, top apps by current rate, category breakdown, top
   devices. Poll 5 s.
2. **Statistics (Past hour)**, the range view, from in-RAM buckets
   (12 × 5-min per app): Top-10 chart, the Application/Download/Upload/Total
   table (sorted, searchable, "All traffic" row), per-app detail drawer with
   12-point time series + per-device rows (name, MAC, last seen, DL/UL,
   share %), and a Clear button (`reset`). Poll 15 s.

**Past day / Past week tabs are phase 2** (require persistence; the UI shows
the tabs disabled with a tooltip, so the seam is visible rather than hidden).

Deliberate departures from the conventional layout, documented as choices:
- **No app icons in core, by design.** Vendor screens' per-app icons ship
  from their CDN and are proprietary (netify/eGloo data). Core
  `luci-app-appflow` renders letter-tile avatars colored by category on its
  own, zero licensing exposure, still scannable. A separate, optional
  package, `luci-app-appflow-icons` (§9), adds brand icons for the ~100 most
  recognizable detectable apps; core probes for that package's icon
  directory at render time and falls back cleanly when it is not installed.
- **No per-app Block toggle** (vendor screens wire it to a content-filter product;
  out of scope for a statistics package).
- **No enable/disable toggle**, that gates a heavy NFQUEUE pipeline elsewhere; appflowd
  is a lightweight socket consumer, service control via standard init.
- Device names resolved from `/tmp/dhcp.leases` + netifyd status.json MAC map
  (vendor implementations use a proprietary client registry socket).

## 5. ubus contract (v1 draft)

Object `appflow`:

| method | args | returns |
|---|---|---|
| `summary` | - | totals, rates, top_apps[], top_categories[], top_devices[], window meta |
| `apps` | `{sort, limit}` | full per-app aggregate list |
| `devices` | - | per-device aggregates (+resolved names) |
| `app_detail` | `{app}` | per-device + per-hostname breakdown + hour time series for one app |
| `stats` | `{range:"hour"}` | range totals: all/applications[]/top_apps[] with 12×5-min time series (only `hour` in v1; other ranges rejected until phase 2) |
| `flows` | `{limit}` | live flow list (debug/power-user view) |
| `status` | - | daemon health: uptime, flows tracked, events/s, socket state |
| `reset` | - | zero all aggregates/buckets (the "Clear" function; **write-scope ACL**, separate from read grants) |

All byte values in **bytes**, rates in **bytes/sec** (UI formats). Timestamps
ms epoch. Every response carries `generated_at` + `agent_connected`.

## 6. Package layout

```
luci-app-appflow/
├── Makefile                          # LuCI feed style, PKGARCH:=all
├── htdocs/luci-static/resources/view/appflow/{overview,statistics,common}.js
├── root/etc/init.d/appflowd          # procd wrapper
├── root/etc/config/appflow           # uci: caps, window sizes, top-N
├── root/usr/sbin/appflowd            # ucode daemon (shebang /usr/bin/ucode)
├── root/usr/share/rpcd/acl.d/luci-app-appflow.json
├── root/usr/share/luci/menu.d/luci-app-appflow.json
├── po/templates/appflow.pot          # string catalog, GENERATED from source
├── tests/protocol-suite.sh           # 54 checks, fake agent, no traffic needed
├── tests/hardware-suite.sh           # 15 checks, real traffic vs wire truth
├── tests/frontend-suite.js           # 31 checks, Node, runs in CI
├── tests/luci-module.js              # loads a real LuCI view module under Node
└── docs/DESIGN.md                    # this file
```

`po/` is not hand-maintained. `luci.mk` discovers languages by globbing `po/*`
and generates a `luci-i18n-appflow-<lang>` subpackage per directory, so adding
a translation needs no Makefile change. See CONTRIBUTING.md.

Depends (from `Makefile` `LUCI_DEPENDS`): `netifyd`, `luci-base`,
`ucode-mod-socket`, `ucode-mod-uloop`, `ucode-mod-ubus`, `ucode-mod-uci`,
`ucode-mod-fs`.

## 7. History extension seams (deliberate, v1 ships them dormant)

1. **Single aggregation choke point**: every counter delta flows through one
   `account(flow, delta_bytes, ts)` function, the only place history taps in.
2. **Time-bucketed accumulators**: aggregates are structured as
   `{cur, buckets[]}` from day one, and the buckets are load-bearing in v1,
   not a stub: every aggregate (totals, each app, each device, each
   category) carries a 12-slot, 5-minute ring covering the trailing hour
   (backs the `stats`/`app_detail` time series), and every
   per-(app × device) and per-host breakdown carries a coarser 4-slot,
   15-minute ring covering the same trailing window at a quarter of the
   memory. History (§9) extends retention and adds persistence of that same
   shape; it does not introduce the buckets themselves.
3. **Persistence interface**: `store.flush(buckets)` no-op stub in v1; later
   implementations (RAM-rotating file / collectd exec / sqlite on USB) plug in
   without touching accounting. Flash-wear rule: never write per-sample to
   overlay; flush coarse buckets only.
4. **ubus contract reserves** `history` method name + `since/until` args.

## 8. Risks / open items

- ~~UI reference spec~~, landed 2026-08-21. It lived here as section 4 and
  now lives in [frontend.md](frontend.md); the numbering below still skips
  4 rather than renumber every cross-reference in this file.
- ~~netifyd conf details~~, landed: multi-client listen socket, `dump_established_flows`,
  `flow_stats` cadence config. Purge event confirmed as `flow_purge` (extracted from the netifyd binary, 2026-08-21).
- ~~ucode `publish()` reliability → decides §3 option A/B~~: resolved, §3
  states Option A shipped, proven reliable on 25.12.
- ~~Dual-capture dedup double-counts NAT'd client traffic~~, FIXED 2026-08-24
  (§3.2) by resolving the ambiguity through conntrack rather than guessing.
  Client 99.8% and router 97.9% of wire truth, each counted once. Degrades
  safely when conntrack is unreadable. Original defect description follows.
- **(historical) The defect this replaced (§3.2).**
  netifyd 4.4.7 reports the router's own WAN MAC on the external capture of a
  NAT'd flow, so `dev_is_router` is true and `want_shadow` is false: the twin
  is counted again under `router`. Measured 163%, 196% and 199% of wire ground
  truth across three trials. The per-device row for the client is accurate to
  496 bytes in 53 MB; it is the **grand total** and the `router` row that are
  wrong. No fix yet: `!dev_is_router` protects genuinely router-originated
  traffic and cannot simply be removed, and `ip_nat` is not a reliable
  discriminator. See §3.2 for the fix direction.
- ~~**CT_MAX described as a memory bound**~~, FIXED 2026-08-24, also from the
  panel. `ct_load()` called `fs.readfile()` and then `split(raw, "
")`, which
  materialised the whole conntrack table and the whole line array *before*
  `CT_MAX` was consulted, so the constant bounded the retained map but not peak
  allocation, and its own comment calling it a memory bound was wrong. It now
  reads a line at a time via `fs.open()` / `read("line")`, so peak is one line
  and the cap stops the work as well as the retention.

  A second defect in the same function: the non-forced throttle read
  `conntrack.entries && (now - conntrack.at) < CT_TTL_MS`. A snapshot that
  parsed to zero rows while the file was readable made that falsy and disabled
  the throttle entirely, and the non-forced path has no `CT_FORCE_MIN_MS` floor,
  so every external flow identification re-read the whole file. Now gated on
  `conntrack.at`, i.e. on having read recently rather than on having read
  recently *and* found something.
- **Byte conservation is now instrumented, not just asserted** (2026-08-24,
  suggested by a reviewer). `status.bytes` reports `reported` (what netifyd
  said moved, before any clamp or shadow decision), `attributed` (what reached
  an aggregate), `shadowed` (what was deliberately dropped as a NAT twin) and
  `leaked` (the residual, which should be 0). Both silent byte-loss defects this
  daemon has had would have been visible here from the first minute. Measured 0
  across every run since. In a NAT-ed transfer `reported` lands at roughly twice
  wire truth with about half shadowed, which is the dual capture being
  deduplicated, visible for the first time.
- EA8500 resource baseline MEASURED (2026-08-21, light load, 12 flows,
  synthetic traffic): netifyd ~16.5 MB VSZ, ~0% CPU, box 95% idle, 397 MB
  free. Heavy-load measurement (real client routed through) still pending.
- ~~Byte conservation through the Unknown/late-stub path~~, VERIFIED sound
  2026-08-22 (§2.5), including the sub-`update_interval` case.
- **Connect/reconnect blindness (KNOWN LIMITATION, will ship).** Flows already
  established when the daemon or netifyd (re)starts have their remaining bytes
  attributed to Unknown, because netifyd 4.4.7 emits no `flow` event for them
  (§2.4, §2.5). Bounded to that window, self-healing, non-destructive. Cannot be
  fixed without an established-flow dump upstream. Documented in the
  README rather than hidden.
- ~~**reshadow() exempted the flows it existed to correct**~~, FOUND by an
  adversarial review and FIXED 2026-08-24. `reshadow()` returned early on
  `dev_key == "router"`, which is exactly how a WAN-side capture of a NAT-ed
  client flow is classified, because netifyd reports the post-translation
  identity (§3.2). The conntrack twin resolution added earlier that day went
  into `flow_identify()` and was never wired into `reshadow()`, so the one class
  of flow it must correct was the one it skipped. It now calls `ct_nat_twin()`
  and defaults the same way `flow_identify()` does.

  Measured on hardware, NAT-ed client transfer with `appflowd` restarted
  mid-flight, appflow total against the client veth's own tx counter:

  | run | before fix | after fix |
  |---|---|---|
  | 1 | 0.701 | 0.892 |
  | 2 | 0.791 | 1.013 |

  No-restart control after the fix: 1.012. **A caveat worth keeping:** the panel
  predicted a persistent *double* count of the central total. That is not what
  was measured. The old code *under*-counted after a restart (0.70-0.79) and the
  fix restores accuracy; it does not remove an inflation that was never
  observed. The code defect was real, the predicted magnitude and sign were not.
  The residual gap in run 1 is connect-blindness, below.
- **Late re-point stranding (OPEN, unquantified).** If netifyd first reports a
  flow unclassified (`app_id <= 0`) and only later re-points it via a detection
  update, bytes counted before the re-point stay under Unknown, because the
  accounting seam is append-only by design (see the re-point comment in
  `classify()`). No counter currently exposes this, so its real-world magnitude
  is unknown. It could not be induced deliberately on the bench (it needs a
  protocol netifyd classifies only after several packets on a stable
  connection). Cheapest settling test: a real-traffic socket capture correlating
  per-digest `flow`/`flow_stats`/detection-update ordering, excluding
  connect-time orphans by `first_seen_at`; alternatively instrument the re-point
  in `classify()` to accumulate stranded mass into a `status` counter. Deferred
  rather than guessed at.

## 9. Roadmap (queued, post-v1)

1. **v1.1, `luci-app-appflow-icons`, a SEPARATE package.** Hand-curated mapping
   (netify app id → icon) for the ~100 most-recognizable detectable apps, using
   monochrome SVGs from CC0/Apache-licensed collections (simple-icons /
   dashboard-icons), bundled locally, tinted by category color. Deliberately
   split from core, i18n-style, for legal blast-radius isolation: brand icons
   are trademarks regardless of collection license, so if anyone ever objects
   the icon package is delisted on its own and core is untouched. Coupling is
   runtime-soft in BOTH directions: core probes the icon directory at render
   time and falls back to letter-tile avatars; the icon package depends on
   nothing and breaks nothing when absent or removed. Same repo, second
   package directory.
2. **v2, Past day / Past week ranges** (persistence per §7 seams; flash-wear
   policy: coarse-bucket flushes only, tmpfs-first with periodic backup,
   tiered downsampling).

## 10. As-implemented contract notes (v1 final)

§5 sketched the method set; the implemented field naming is authoritative:
live aggregate rows use `bytes_up/bytes_down/bytes_total` +
`rate_up/rate_down/rate_total` (+ `key/name/tag/category`), while the
The `stats`/`app_detail` range views use `download/upload/total`, which is the
conventional vocabulary for that screen. `status` is nested
(`socket.*`, `flows.*`, `aggregates.*`, `agent.*`, `memory.*`).
`app_detail` takes the aggregate `key` or the raw tag or the display
label (resolver tries all three). The frontend ships normalizers for
both dialects in `view/appflow/common.js`. luci-lib-chartjs was dropped:
the packaged build is a Chart.js 1.x fragment (Doughnut/Pie only), and
inline SVG follows LuCI theme variables, which canvas cannot.

## 11. AI service breakout

### 11.1 Why netifyd cannot do this

Measured on two routers, 2026-08-27. `/etc/netify.d/netify-apps.conf` is the
Netify Agent's signature set. On both it is dated **10 August 2023**, carries
**199** application signatures, and contains **zero** entries matching
anthropic, claude, openai, chatgpt, huggingface, perplexity, mistral, copilot,
bard or gemini.

So AI traffic arrives with `detected_application` 0 and aggregates into generic
HTTP/S alongside everything else. This is vendor data three years stale, not a
configuration problem, and nothing on the router can change it.

### 11.2 Why appflow can

netifyd already reports the TLS SNI as `host_server_name`, and appflow already
stores it. Traffic generated to the real endpoints on the bench carried
`api.anthropic.com`, `claude.ai` and `api.openai.com` with no code change at
all. The identifying data was there the whole time; nothing was making use of
it.

The daemon is the right layer because aggregation happens there. The browser
only ever receives summarized rows, so a frontend fix would arrive after the
decision that matters had already been made.

### 11.3 What it does

In `flow_identify()`, after netifyd's identity is resolved and after the
category is derived, the SNI is matched by **domain suffix** against a built-in
table. On a hit the application key, label, tag and category are replaced.

```
key    ai:anthropic-claude
name   Anthropic (Claude)
tag    appflow.anthropic-claude
cat    ai-assistants
```

Four categories: `ai-assistants`, `ai-media`, `ai-developer`,
`ai-infrastructure`. The last covers aggregators, inference APIs, GPU rental
and vector stores, which are different businesses but one thing from a
network's point of view.

**The category is a SLUG on the wire, and 1.1.0 got this wrong.** It shipped
`AI assistants` and its three siblings as display strings, which read correctly
in English and could therefore never be translated: the browser renders a
category by looking the slug up in a table of `_()` literals, and a string that
arrives already rendered has no key to look up. Every netifyd category travels
as a lowercase slug; these four were the only ones that did not, and they were
ours. Corrected in 1.1.1. `frontend-suite.js` now reads this table out of the
daemon source and fails if a category is emitted that the frontend cannot
translate, so the two halves cannot drift apart again.

**Keyed on the vendor label, not the matched domain.** `anthropic.com` and
`claude.ai` are one vendor and must aggregate into one row; keying on the
suffix would produce two identically-named rows and split the total.

**The `appflow.` tag prefix is deliberate.** netifyd's own tags are `netify.*`.
Nothing here pretends to have come from netifyd.

### 11.4 The gate, and why it makes the feature self-retiring

**netifyd's own answer wins.** The override runs only when
`detected_application` is 0, with one exception: entries flagged `strong`,
which override even a positive identification.

`strong` is set only where netifyd is known to recognize the PARENT brand and
would otherwise swallow the AI service inside it: Gemini reported as Google,
Copilot as GitHub, Qwen as Alibaba. Everywhere else the rule is conservative,
which means **the day Netify ship AI signatures this table falls silent by
itself** rather than permanently shadowing better data.

### 11.5 Matching is anchored on label boundaries

The SNI is lowercased, a trailing dot is stripped, and the last two, three and
four labels are rebuilt and looked up in turn. Never a substring test.

`anthropic.com.attacker.example` is a hostname anyone can register and point
anywhere. A substring match on `anthropic.com` matches it. Rebuilding the last
N labels makes that impossible by construction rather than by care, and the
suite asserts it with a flow carrying exactly that hostname.

### 11.6 Accounting is untouched

This changes an identity, never a byte. `account()` never sees it, byte
conservation is exactly as it was, and the existing conservation checks still
hold. `tests/protocol-suite.sh ai` asserts a hand-computed total across a batch
containing AI flows for precisely this reason.

### 11.7 Limitations, stated rather than discovered

- **This is hostname matching, not DPI.** It asserts a classification netifyd
  did not make. The technique is legitimate, matching the SNI is what netifyd
  itself does for HTTP/S, but the accurate description is "we recognize the
  name", never "we inspected the protocol".
- **The list rots.** New services appear constantly and nothing here updates
  itself. `option ai_breakout '0'` turns it off entirely.
- **ECH would end it.** Encrypted Client Hello encrypts the SNI. netifyd has
  the identical exposure so this is no worse than the status quo, but it is not
  durable and should not be sold as such.
- **Region-encoded hostnames under a generic cloud domain cannot be matched.**
  `bedrock-runtime.us-east-1.amazonaws.com` has no suffix specific to Bedrock,
  and matching `amazonaws.com` would label every S3 bucket on the network as
  AI. Deliberately absent rather than approximated.
- **A service behind a shared CDN hostname is invisible**, because the SNI
  names the CDN.
- **No icons ship for these entries.** They render as letter tiles until the
  icon pack gains matching `appflow.*` keys.

## 12. Extensibility: the hostname table is not a constant

The AI breakout (section 11) shipped its table as a constant in the daemon,
which meant adding a service required editing the source and rebuilding the
package. For a tool whose central claim is that netifyd's signature set is three
years stale, being un-extendable is the wrong shape, and the question that
exposed it was the obvious one: "I have a service I want measured, what do I
do?"

`config hostmap` sections in `/etc/config/appflow` are read at config load and
consulted BEFORE the built-in table, so one mechanism does both jobs: adding a
service that is missing, and correcting one that is wrong.

```
config hostmap
	option suffix 'torproject.org'
	option name 'Tor'
	option category 'Privacy'
	option strong '0'
```

**A malformed entry is refused and named in the log.** A suffix with no dot can
never match, because the matcher rebuilds whole labels rather than comparing
substrings, so accepting one produces a rule that silently does nothing and
looks identical to the feature being broken.

That guard has no effect on classification, only on whether the user is told,
and the test for it had to be written accordingly. Two earlier versions were
tautologies: one grepped the whole log and passed forever once the message had
ever appeared, the next counted log lines and read past the count, which failed
because `logread` is a RING whose line count stops growing once it is full. A
unique marker written with `logger` is immune to both. See
`tests/protocol-suite.sh hostmap`.

## 13. Shipped in 1.1.2: the Router row had never counted a byte

**The most serious defect this package has had, and it was invisible by
construction.** On both routers checked, the `router` pseudo-device reported
exactly zero bytes. Production had logged **107,476** flows where conntrack
positively confirmed the router originated the traffic, against a device row
reading zero for 2.6 days and 52 GB. The dashboard correctly hides a zero-byte
device, so the feature was absent rather than visibly broken, and nobody
noticed for the life of the package.

**The cause is one line and it is worth stating precisely.** `ct_nat_twin()`
built its lookup key from the event it was handed:

    other_ip | local_ip | other_port | local_port

netifyd puts the ports on the initial `flow` event and on nothing afterwards. A
`flow_stats` payload carries addresses and byte counters only. So the key built
from an update had two empty fields, matched nothing, and returned `null`.
`reshadow()` treats `null` as grounds to discard, so every router-originated
flow was shadowed on its first stats update, before a single byte reached the
aggregate. `flow_identify()` resolved it correctly, once, and the next event
threw the answer away.

The fix has two halves, and they are independently sufficient, which is why the
tests distinguish them:

- **The ports are stored on the flow record** and the lookup prefers them. This
  is the root cause and the check on `conntrack.unresolved` isolates it.
- **A positive finding is remembered.** `fr.ct_local` records that conntrack
  once said the router originated this flow, and a later lookup that cannot
  answer no longer overturns it. Only a positive "this is a NAT twin" may.
  Absent evidence is not positive evidence, the same rule §5 already states
  about `statusStrip()`.

**The dedup is deliberately unchanged.** A fix that simply stopped shadowing
would restore the 163-199% over-count this mechanism exists to prevent, so the
suite asserts that a router flow conntrack cannot confirm is still discarded.

`conntrack_path` became a config option purely so this is testable, exactly as
`socket_path` already was. The `router` group in `protocol-suite.sh` supplies a
conntrack fixture and drives the real daemon.

**Also in 1.1.2: tile letters outside ASCII.** `tile()` stripped with
`/^[^0-9A-Za-z]+/`, which consumes a name written in any non-Latin script
entirely and falls through to `?`. Every Chinese, Japanese, Korean, Russian,
Greek, Arabic and Hebrew name rendered an identical question mark. Not a
translation bug: any LAN client with a non-Latin DHCP hostname hit it on every
release. Now stripped on `\p{L}\p{N}` with the `/u` flag.

## 14. Shipped in 1.1.1: labels that could not be translated

Every item that stood in this section as "queued for 1.1.1" shipped in 1.1.0
instead (commit `b8ca31d`): the search placeholder, exclude terms, and the
clickable donut. The section was left describing them as pending for three
weeks. What actually became 1.1.1 is below.

**A label is only translatable if a literal reaches `_()`.** That is what the
`.pot` extractor scans for, and three separate paths produced labels that never
did. All three were invisible to a green test run, and all three were reported,
directly or indirectly, by a first-time contributor's translation pull request.

**`catLabel()` held 12 entries and title-cased the rest at runtime.** That is
string manipulation, not translation: `web` became `Web` by algorithm, in
English, in every language. The live netifyd category file carries 43 tags
across its application and protocol indexes. The table now holds all of them.

**The daemon names its three synthetic pseudo-devices in English**, because a
daemon has no idea what language a browser wants. The frontend now maps the
stable key it sends, not the name, so a daemon-side rewording cannot silently
revert the translation.

**The AI categories were ours, not inherited.** See section 12.

The interesting part is why no test caught it. `frontend-suite.js` asserted
that `catLabel('networking')` returns `'Networking'`, which is satisfied
identically by a `_()` lookup and by a title-caser, and it asserted that every
string reaching `_()` is in the catalogue, which is blind by construction to a
string that never reaches `_()`. The new group asserts **membership in the set
of strings the module actually passed to `_()`**, recorded by the harness as it
loads. Six product edits were executed against it to confirm each check can
fail; two of those runs found defects in the test rather than the product.

## 15. Filtering and the drill-down

### 14.1 Where the logic lives, and why

`parseFilter()` and `matchFilter()` are in `common.js`, not inside either
view's render function. Both views share them so the two cannot drift, and Node
can load `common.js`, so the filter is covered by `tests/frontend-suite.js`
rather than by looking at a browser. The sibling package learned the same
lesson the same week: logic that decides something belongs where a test can
reach it.

Terms are space separated and every one must pass, so terms narrow. A leading
minus excludes. Exclusion is not decoration: the question that produced this
feature was "one streaming session is burying everything else", and an
include-only filter cannot express it, because you would have to already know
what you wanted to keep.

A bare `-` is dropped rather than treated as exclude-all, because that is what
a half-typed term looks like and blanking the table between two keystrokes is
not acceptable.

### 14.2 Fetching past the top-N cut

The overview asks the daemon for `FETCH_LIMIT` (50) application rows and
displays `TOP_APPS` (8). The extra rows are the filter's raw material. Without
them, filtering a top-10 list to "AI" returns nothing the moment a streaming
session pushes AI out of the top 10, which looks broken and is worse than
having no filter at all.

### 14.3 The drill-down needs no new aggregate

Both directions are one pass over the live flow table:

    devices_for_apps(keys)   which devices carry these applications
    apps_for_device(dev)     which applications is this device using

Every flow record already carries `dev_key`, `app_key` and `cat_key`, so the
join exists on every flow, and the table is already bounded by `flow_max`. No
new storage.

**This was first answered wrongly.** The initial response was that it required
a per-device-per-application aggregate and was therefore a bounded-memory
design question. Checking the flow record disproved that in two minutes. The
episode is recorded because the shape of the mistake matters more than the
mistake: an architectural-sounding objection offered instead of a two-minute
check.

### 14.4 Attributed bytes, not lifetime counters

Both functions sum `fr.up + fr.down`, the bytes appflow attributed, and never
`fr.total`, which is netifyd's lifetime counter for the connection. A stub flow
adopted mid-transfer has a large lifetime and small attributed bytes, so the
two differ exactly where it matters.

The test fixture carries one flow with a lifetime of 9000 against 1000
attributed, for one reason: without it every flow had the two equal, summing
the wrong field was invisible, and the sabotage for that check passed against
broken code.

### 14.5 Three bugs of one shape

Getting this working produced three defects that presented identically: wired
up, no error, no effect.

- **`null` for a string ubus argument.** ubus rejects it with code 2 rather
  than treating it as absent, and `L.resolveDefault` swallowed the rejection.
- **The poll repainted over the filtered result.** A side call filtered the
  device card and the next five-second poll overwrote it. Filtering is view
  state, so every fetch carries it rather than one special path.
- **`normDevice` dropped the daemon's `key`.** Clicking a device passed
  `undefined`, which *cleared* the selection instead of setting it.

None of these are catchable by a test of logic, because in each case the logic
was right and the wire was not connected. They were found by driving the page.
That is the limit of this package's test strategy and it is written here
rather than left implicit.

### 14.6 One ACL grant was widened, deliberately

`apps` was unbound in the frontend and ungranted in the ACL after an August
security review. The device drill-down needs it, so it was bound and granted,
in that order, exactly as that review's own note required.

`apps {device}` returns an aggregate per device and application from the live
flow table. It is more revealing than either list alone, since it says which
device used which application, and it is still far short of `flows`: no remote
address, no port, no per-connection record. **`flows` remains unbound and
ungranted.**

## 16. Shipped in 1.1.3: netifyd 5.x, and a Router-row loss on every restart

Found with a Docker test on 2026-10-12: OpenWrt 25.12.5 for x86 with Netify's
own netifyd 5.2 packages, and the 4.4.7 from OpenWrt's feed as a control.

**On 5.x, appflow looked healthy and received nothing.** 5.x moved the JSON
export out of the agent into the `netify-sink-socket` plugin, which listens on
`/var/run/netifyd/netify-sink.sock`. The old path still exists but is a
different socket that accepts a connection and sends nothing, so status read
"connected, 0 events": a quiet router. appflowd now uses the 5.x socket when
the configured path is the 4.4 default and the 5.x socket exists, and flags a
connection that has delivered nothing for a minute (`socket.silent`, plus a log
line naming the plugins to enable). netifyd sends a status event every 15 s, so
a silent minute is never normal.

**Other 5.x differences handled:** the category list moved to
`/etc/netifyd/netify-categories.json` (same format; without it every category
read unclassified); `flow_dpi_update` and `flow_dpi_complete` are accepted and
ignored rather than counted as unknown, since the `flow` event already carries
the classification and the first `flow_stats` covers the bytes from the start;
`agent_hello` now repeats every 15 s and is logged once per connection.

**A shortfall leak.** Once in 133 updates on a slow, retransmitting flow, 5.x
reported `total_bytes` growth larger than `local_bytes + other_bytes`, and the
difference showed as `leaked`. The deltas are now scaled up to the growth in
the same direction ratio, mirroring the existing clamp for the opposite case.

**The Router row lost flows after every restart, on 4.4.7 too.** §13's fix
kept a flow's ports on its record because `flow_stats` carries none. It
carries no addresses either, on both versions, though a comment said it did.
A router flow identified before the first LAN flow is re-checked against
conntrack later, from an update, with a key of empty address fields; it
missed, and the flow was shadowed for the rest of its life. The addresses are
now kept on the record too. The protocol suite's own fake events had put
addresses on every `flow_stats`, which real netifyd never does, and that is
why it stayed green; the new `netify5` group sends what netifyd actually
sends, and all five of its checks fail against the previous daemon.
