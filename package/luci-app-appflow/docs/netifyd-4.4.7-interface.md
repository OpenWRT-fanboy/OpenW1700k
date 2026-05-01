# The netifyd 4.4.7 JSON export interface, as shipped by OpenWrt

## Scope

This document describes the JSON socket interface exposed by **netifyd 4.4.7**,
the exact version OpenWrt packages and installs (`netifyd-4.4.7-r2.apk` at the
time of writing). It does **not** describe the current upstream Netify Agent
(v5.x), which has moved to a plugin (`plugins.d`) architecture with a
different sink model, additional fields (`digest_prev`, `risks.*` extensions,
`app_ip_override`), and options that do not exist in 4.4.7. Netify's own
public documentation site currently documents v5, which is a meaningful
source of confusion if you go looking for confirmation of anything here: most
of what you'll find online describes a daemon that is not the one running on
your router.

Everything stated as fact below is grounded in one of two sources:

1. **Direct inspection of the 4.4.7 source and OpenWrt packaging**
   (`gitlab.com/netify.ai/public/netify-agent` at tag `v4.4.7`, and the
   `openwrt/packages` build recipe).
2. **A real captured stream from a running 4.4.7 instance** on a Linksys
   EA8500 (OpenWrt 25.12.5, `arm_cortex-a15_neon-vfpv4`), taken over a UNIX
   socket connection immediately following daemon start. Excerpts from that
   capture are reproduced verbatim throughout this document (only field
   *values* like MAC/IP addresses and timestamps are real lab data, not
   synthetic).

Where the two disagree, or where a claim could only be confirmed from source
and not observed live, this is called out explicitly. An "Unverified /
unknown" section at the end collects every open question directly rather
than papering over it.

**A note on `dump_established_flows`.** You may see this option referenced in
blog posts, forum threads, or even in comments in older netifyd
configuration examples. It does not exist in 4.4.7: the string is entirely
absent from the compiled binary and from the 4.4.7 man page source. It is a
v5-era `plugins.d` option. Practically, this means a client that connects to
the socket mid-stream (which, for most consumers, is every connection) gets
**no backfill of already-tracked flows**. It starts blind. See "Connection
lifecycle" and "Practical consumer guidance" below for what this means and
how to handle it; the real capture used throughout this document directly
demonstrates the resulting behavior.

## 1. Socket and wire framing

netifyd exposes a UNIX domain socket, configured in `/etc/netifyd.conf`:

```ini
[socket]
listen_path[0] = /var/run/netifyd/netifyd.sock
```

On stock OpenWrt this is active by default as soon as the `netifyd` init
script starts the daemon; no additional configuration is required to get a
live stream. (A TCP listener is also supported via `listen_address[n]` /
`listen_port[n]`, but is not used by default on OpenWrt and was not
exercised for this document.)

**Wire format**: every message is a JSON object terminated by `\n`, and every
payload line is preceded by a one-line header of the form `{"length": N}`.
This is newline-delimited JSON with an explicit length prefix, not bare NDJSON.

Real captured pair (the very first two lines netifyd writes to a freshly
connected socket):

```
{"length": 165}
{"agent_version":"4.4.7","build_version":"Netify Agent/4.4.7 (openwrt; arm; conntrack; netlink; dns-cache; plugins; regex)","json_version":1.9,"type":"agent_hello"}
```

**Framing detail confirmed by direct measurement**: `N` is the byte length of
the payload line **including its trailing `\n`**, not the length of the raw
JSON content alone. Checked across all 17 header/payload pairs in the capture
used for this document, the declared `length` matched `byteLength(payload) + 1`
in every case, and never matched `byteLength(payload)` alone. A parser must
account for the newline when deciding how many bytes to read for a given
frame (or, more robustly, simply read line-delimited text and treat the
length header as a frame-boundary hint rather than the sole read-size
authority).

Parser rule, in short: read a line; if its only key is `length`, it is a
frame header, discard it; otherwise the line is a complete JSON event and its
`type` field determines how to interpret it.

## 2. Connection lifecycle

The real capture shows this exact sequence on connect (daemon `update_interval`
was 15 seconds for this run):

1. `agent_hello` -- sent once, immediately, before anything else.
2. `agent_status` -- sent immediately after `agent_hello`. This first status
   frame is a **reduced** one; see the field-presence note in section 3.3.
3. `definitions` -- sent once per connection, a large one-time dump of the
   application and protocol id-to-name tables (416 applications / 217
   protocols in this capture).
4. A burst of `flow_stats` events (11 of them in this capture) for flows that
   were **already being tracked** before this client connected. **None of
   these digests were ever announced via a `flow` event on this connection.**
   This is the live, directly observable consequence of
   `dump_established_flows` not existing in 4.4.7: the client is receiving
   counter updates for flows whose identity (application, protocol, hostname,
   IPs) it was never told.
5. A second `agent_status`, 15 seconds after the first (matching
   `update_interval`), this time carrying the fuller field set (interfaces,
   devices, per-interface capture stats).
6. Two `flow` events, for newly detected DNS queries to `openwrt.org`,
   showing the daemon has now genuinely observed new traffic from
   first packet.

No `flow_purge` event occurred during this capture window (the two new flows
were still active when the capture ended). Its shape is documented in
section 3.6, confirmed live via 10+ purge events captured separately during
this project's hardware testing (`DESIGN.md`), even though none happened to
land in the specific capture excerpted in this document.

Practical implication for a long-running consumer (this is what
`appflowd` in this repo does): on every connect or reconnect, assume you know
nothing about flows already in progress. You will start receiving
`flow_stats` (and eventually `flow_purge`) for digests you have never seen a
`flow` event for. Treat that as the normal, permanent case, not a transient
startup race.

## 3. Event type reference

Every event on the socket, except `agent_hello` and `definitions`, shares the
same top-level envelope:

```json
{"type": "<event-type>", "interface": "<ifname>", "internal": <bool>, "established": <bool>, "flow": { ... }}
```

`interface` is the capturing interface name (`br-lan`, `wan`, etc.). `internal`
reflects which capture point saw the packet (true for internal/LAN-side
capture, false for external/WAN-side), which matters because netifyd watches
both `br-lan` and `wan` simultaneously and a NAT'd client's traffic can appear
as two distinct flows with two distinct digests (see `DESIGN.md` section 3.2
for this project's dedup policy; that is an application-level concern, not
part of the wire protocol itself).

`established` is present on every `flow`/`flow_stats` event in the capture
and was `false` in all observed instances. Its precise semantics were not
confirmed from source in the research this document is based on, and the
capture is too short and too uniform to infer it empirically; see
"Unverified / unknown."

### 3.1 `agent_hello`

Sent once, immediately on connect, before any other event.

```json
{"agent_version":"4.4.7","build_version":"Netify Agent/4.4.7 (openwrt; arm; conntrack; netlink; dns-cache; plugins; regex)","json_version":1.9,"type":"agent_hello"}
```

| Field | Type | Notes |
|---|---|---|
| `agent_version` | string | e.g. `"4.4.7"` |
| `build_version` | string | Human-readable build string; the parenthesized list is compile-time capability flags. This build has `conntrack` compiled in (relevant to `ct_id`/`ct_mark`, see 3.4). |
| `json_version` | number | Schema/protocol version for the JSON payloads on this socket, `1.9` in this capture. Matches the `version` field later seen in `agent_status`. |
| `type` | string | Always `"agent_hello"` |

### 3.2 `definitions`

Sent once per connection, immediately after the first `agent_status`. Carries
the full id-to-name tables for both id spaces used elsewhere in the stream
(`detected_protocol` and `detected_application`). This is a large message
(18,704 bytes in this capture, framed with the `{"length": N}` header like
everything else).

Truncated real excerpt (full arrays omitted for length; see section 5 for a
detailed discussion of what's in them):

```json
{"applications":[{"id":248,"tag":"ZOOM"},{"id":177,"tag":"ZMQ"}, ... ,{"id":10126,"tag":"netify.zendesk"}],
 "protocols":[{"id":248,"tag":"ZOOM"},{"id":177,"tag":"ZMQ"}, ... ,{"id":191,"tag":"OOKLA"}],
 "type":"definitions"}
```

| Field | Type | Notes |
|---|---|---|
| `applications` | array of `{id: uint, tag: string}` | 416 entries in this capture. Resolves `flow.detected_application`. **Do not** also use this array to resolve `detected_protocol` -- see the id-collision warning in section 5. |
| `protocols` | array of `{id: uint, tag: string}` | 217 entries in this capture. Resolves `flow.detected_protocol` only. |
| `type` | string | Always `"definitions"` |

The captured counts (416 / 217) match `DESIGN.md`'s figures exactly, which is
good independent corroboration that this capture is representative and not a
truncated or unusual snapshot.

### 3.3 `agent_status`

Agent-level telemetry: uptime, CPU, memory, flow-table size, sink (upload)
state, and (on richer frames) per-interface identity and packet-capture
counters. **Never contains per-flow data.** This is the same payload also
written periodically to `/var/run/netifyd/status.json`; on the socket it is
additionally interleaved with flow events, once per `update_interval`.

**Two different shapes were observed for this event type in the same
capture, and this is worth flagging explicitly because it is easy to design
a parser around only the richer one and then break on the first frame.**

First `agent_status` (sent immediately after `agent_hello`, before
`definitions`):

```json
{"cpu_cores":2,"cpu_system":0.075803,"cpu_system_prev":0.028308,"cpu_user":1.212848,"cpu_user_prev":0.113235,"dhc_size":1,"dhc_status":true,"flow_count":16,"flow_count_prev":0,"maxrss_kb":15372,"maxrss_kb_prev":9332,"sink_status":false,"sink_uploads":false,"timestamp":1787325073,"type":"agent_status","update_imf":1,"update_interval":15,"uptime":15,"version":1.9}
```

Second `agent_status` (15 seconds later, on the regular cadence):

```json
{"agent_version":"4.4.7","cpu_cores":2,"cpu_system":0.077808,"cpu_system_prev":0.075803,"cpu_user":1.256057,"cpu_user_prev":1.212848,"devices":{"b4:2e:99:3a:d6:e4":["192.168.1.10"],"c0:56:27:4e:3e:92":["192.168.72.10"],"c0:56:27:4e:3e:93":["192.168.1.1"],"dc:b5:4f:ad:0d:6e":["192.168.72.21","fe80::18f3:bf8d:dc6e:980f"]},"dhc_size":1,"dhc_status":true,"flow_count":21,"flow_count_prev":16,"interfaces":{"br-lan":{"addr":["fe80::c256:27ff:fe4e:3e93","fda8:3a0e:1478::1","192.168.1.1"],"mac":"c0:56:27:4e:3e:93","role":"LAN","state":1},"wan":{"addr":["fe80::c256:27ff:fe4e:3e92","192.168.72.10"],"mac":"c0:56:27:4e:3e:92","role":"WAN","state":1}},"maxrss_kb":15372,"maxrss_kb_prev":15372,"sink_status":false,"sink_uploads":false,"stats":{"br-lan":{"capture_dropped":0,"capture_filtered":0,"discarded":0,"discarded_bytes":0,"ethernet":35,"fragmented":0,"icmp":0,"igmp":0,"ip":35,"ip_bytes":10806,"largest_bytes":1718,"mpls":0,"pcap_drop":0,"pcap_ifdrop":0,"pcap_recv":35,"pppoe":0,"queue_dropped":0,"raw":35,"tcp":35,"tcp_resets":0,"tcp_seq_error":0,"udp":0,"vlan":0,"wire_bytes":11646},"wan":{"capture_dropped":0,"capture_filtered":0,"discarded":2,"discarded_bytes":102,"ethernet":158,"fragmented":0,"icmp":2,"igmp":0,"ip":156,"ip_bytes":149662,"largest_bytes":4338,"mpls":0,"pcap_drop":0,"pcap_ifdrop":0,"pcap_recv":158,"pppoe":0,"queue_dropped":0,"raw":158,"tcp":134,"tcp_resets":2,"tcp_seq_error":0,"udp":20,"vlan":0,"wire_bytes":153406}},"timestamp":1787325074,"type":"agent_status","update_imf":1,"update_interval":15,"uptime":30,"version":1.9}
```

| Field | Type | Present on | Notes |
|---|---|---|---|
| `type` | string | both | Always `"agent_status"` |
| `version` | number | both | JSON schema version, `1.9` here (same value as `agent_hello.json_version`) |
| `timestamp` | uint | both | Epoch **seconds**. See the timing anomaly noted below; don't lean on this for interval math. |
| `uptime` | uint | both | Seconds since agent start. Reliable for computing elapsed time between status frames. |
| `update_interval` | uint | both | Configured status/stats cadence in seconds, `15` here |
| `update_imf` | uint | both | Present, value `1` in both frames. Meaning not confirmed by any source consulted; see "Unverified / unknown." |
| `cpu_cores` | uint | both | |
| `cpu_user`, `cpu_user_prev`, `cpu_system`, `cpu_system_prev` | number (seconds) | both | Cumulative CPU time, current and previous sample |
| `flow_count`, `flow_count_prev` | uint | both | Size of the daemon's live flow table, current and previous sample. This is a **count**, never the flows themselves. |
| `maxrss_kb`, `maxrss_kb_prev` | uint | both | Resident memory high-water mark, current and previous sample |
| `dhc_status` | bool | both | DNS hint cache active |
| `dhc_size` | uint | both | DNS hint cache entry count |
| `sink_status` | bool | both | Cloud upload sink connected. `false` throughout this capture (sink disabled). |
| `sink_uploads` | bool | both | Whether upload is compiled/enabled at all |
| `agent_version` | string | second frame only | e.g. `"4.4.7"` |
| `devices` | object, MAC string to array of IP strings | second frame only | MAC to IP(s) map; useful for device-name resolution independent of DHCP leases |
| `interfaces` | object keyed by ifname | second frame only | Per-interface `addr[]`, `mac`, `role` (`"LAN"`/`"WAN"`), `state` (observed `1`, presumed up/down) |
| `stats` | object keyed by ifname | second frame only | Per-interface packet-capture counters (drops, protocol breakdown, byte totals). Not per-flow. |

**Consumer guidance from this asymmetry**: do not assume `agent_version`,
`devices`, `interfaces`, or `stats` are present on every `agent_status`
frame. Merge additively into whatever state you're building rather than
replacing it wholesale on frames that omit these keys, or you will discard
good state on the first frame after every reconnect.

**Timing anomaly, flagged rather than explained**: between the two captured
`agent_status` frames, `uptime` advanced by exactly 15 seconds (matching
`update_interval`, as expected), but the wall-clock `timestamp` field only
advanced by 1 second (`1787325073` to `1787325074`). This is inconsistent
with both fields tracking real elapsed time. It may be a genuine daemon
quirk, or an artifact of how this particular lab capture was recorded (the
JSON was captured live but the header rows were relatively hand-timed for
this exercise). No independent source was available to confirm which.
**Do not use `timestamp` deltas to infer the update cadence; use `uptime`
deltas or the configured `update_interval` instead.**

### 3.4 `flow`

Fires when a flow's Layer-7 identity is (re)determined: first classification,
or a later refinement flagged via `detection_updated`. Carries full identity
metadata. **Carries no byte or packet counters** -- confirmed directly by
this capture, where neither of the two captured `flow` events has
`local_bytes`, `other_bytes`, `total_bytes`, or any packet counter field.
Counters arrive separately via `flow_stats`.

Real captured example (a router-originated DNS query, unedited beyond
formatting):

```json
{"established":false,"flow":{"category":{"application":31,"domain":0,"protocol":14},"detected_application":10465,"detected_application_name":"netify.openwrt","detected_protocol":5,"detected_protocol_name":"DNS","detection_guessed":false,"detection_updated":false,"dhc_hit":false,"digest":"9c2d7b56c4571e146f65b0d15c12cec661d56b3f","first_seen_at":1787325075857,"first_update_at":1787325075857,"host_server_name":"openwrt.org","ip_nat":false,"ip_protocol":17,"ip_version":4,"last_seen_at":1787325075869,"local_ip":"192.168.72.1","local_mac":"94:83:c4:a8:8f:f1","local_origin":false,"local_port":53,"other_ip":"192.168.72.10","other_mac":"c0:56:27:4e:3e:92","other_port":57052,"other_type":"local","risks":{"ndpi_risk_score":10,"ndpi_risk_score_client":5,"ndpi_risk_score_server":5,"risks":[46]},"soft_dissector":false,"vlan_id":0},"interface":"wan","internal":false,"type":"flow"}
```

Reading this example concretely: `local_ip` (192.168.72.1, port 53) is the
upstream DNS resolver; `other_ip` (192.168.72.10, port 57052) is this
router's own WAN address. `local_origin: false` means the "local" side (the
DNS resolver, from netifyd's point of view) did not initiate; the "other"
side (the router) did -- i.e. this is the router itself making a DNS query,
captured on the `wan` interface (`internal: false`). `other_type: "local"`
classifies the *other* endpoint's address as being on a locally-adjacent
network, independent of which capture point (`internal`/`interface`) saw the
packet. This distinction (address locality vs. capture-point locality) is
exactly what `DESIGN.md` section 3.2's router-origin-traffic attribution
policy depends on.

| Field | Type | Notes |
|---|---|---|
| `digest` | string | 40-char lowercase hex (SHA1). Correlation key; unconditionally present on every event type that carries a `flow` object. |
| `first_seen_at`, `last_seen_at` | uint64 | Epoch **milliseconds** |
| `first_update_at` | uint64 | Present in this capture, not documented in prior source-only notes on this interface. In both captured examples it is numerically identical to `first_seen_at`. Whether it diverges once `detection_updated` fires was not observable in this capture (neither example had `detection_updated: true`). See "Unverified / unknown." |
| `detection_guessed` | bool | |
| `detection_updated` | bool | `false` in both captured examples (both are first-detection events, not re-detections) |
| `dhc_hit` | bool | DNS hint cache was used for this detection |
| `soft_dissector` | bool | |
| `ip_version` | uint | 4 or 6 |
| `ip_protocol` | uint | IANA protocol number (`17` = UDP in the example) |
| `vlan_id` | uint | |
| `ip_nat` | bool | `false` in the example |
| `other_type` | string | Observed value: `"local"`. Source also documents `"remote"`, `"broadcast"`, `"multicast"`, `"unsupported"`, `"error"`, `"unknown"` -- not independently confirmed live in this capture. |
| `local_origin` | bool | Which side initiated; see worked example above |
| `local_mac` / `other_mac` | string | MAC addresses |
| `local_ip` / `other_ip` | string | |
| `local_port` / `other_port` | uint | |
| `detected_protocol` | uint | Id into the `definitions.protocols[]` table |
| `detected_protocol_name` | string | Plain string, not namespaced (`"DNS"` here) |
| `detected_application` | uint | Id into the `definitions.applications[]` table |
| `detected_application_name` | string | `"netify.<slug>"` format when an app-level identification was made. Source indicates this can be absent/empty when only a protocol, not a specific app, was identified; not observed empty in this capture (both examples had it set). |
| `category.application`, `category.protocol`, `category.domain` | uint | Category ids. Resolved via `/etc/netify.d/netify-categories.json`'s index tables, **not** via the `definitions` applications/protocols name arrays (different id space entirely; see section 5). |
| `dns_host_name` | string | Not present in either captured example (both flows already had `host_server_name` populated from the query itself) |
| `host_server_name` | string | TLS SNI or DNS/HTTP hostname, when available. `"openwrt.org"` in the example. |
| `http.user_agent`, `http.url` | -- | Not observed (neither captured flow is HTTP); documented from source only |
| `dhcp.fingerprint` | -- | Not observed; documented from source only |
| `gtp.*` | -- | Not observed; documented from source only, GTP tunnel inner addressing |
| `risks` | object | Present in both captured examples: `ndpi_risk_score`, `ndpi_risk_score_client`, `ndpi_risk_score_server` (uint scores) and `risks` (array of numeric risk-flag ids, e.g. `[46]`). Not present in the source-derived field list this document's predecessor research was built from -- this is a real, confirmed field that prior source-reading missed. No id-to-name mapping for the values in `risks[]` was found in any source consulted here; see "Unverified / unknown." |
| `ct_id`, `ct_mark` | -- | **Not present** in either captured `flow` example, despite this build having `conntrack` compiled in (per the `agent_hello.build_version` string). Whether this is because these are UDP/no-NAT flows, or because emitting these fields needs an encode flag not set by default, is unconfirmed. |

Notably absent from `flow` in this capture: `detection_packets` and every
byte/packet counter. Those appear only in `flow_stats` (below), confirming
the two-event split cleanly.

### 3.5 `flow_stats`

Periodic per-flow counter update, once per `update_interval`, for flows past
initial detection. No identity metadata (app/protocol names, hostnames,
etc.) -- only the digest, timestamp, and counters.

Real captured example:

```json
{"established":false,"flow":{"detection_packets":16,"digest":"f663f9df9734cbaf815438f6e4b7361794729816","last_seen_at":1787325073851,"local_bytes":5336,"local_packets":19,"other_bytes":5470,"other_packets":16,"total_bytes":10806,"total_packets":35},"interface":"br-lan","internal":true,"type":"flow_stats"}
```

| Field | Type | Notes |
|---|---|---|
| `digest` | string | Correlation key |
| `last_seen_at` | uint64 | Epoch milliseconds |
| `detection_packets` | uint | Packets DPI examined before finalizing classification (a detection-time count, not a running traffic count) |
| `local_bytes`, `other_bytes` | uint | **Per-update deltas, not cumulative.** See the correction below. |
| `local_packets`, `other_packets` | uint | Same: per-update deltas |
| `total_bytes`, `total_packets` | uint | **Cumulative** since flow start. This is the only running total in the record. |

**Correction to a prior assumption, stated here as confirmed fact**:
`local_bytes`/`other_bytes` (and the matching packet counters) are
per-update deltas, not running totals; only `total_bytes`/`total_packets`
are cumulative. This was verified on hardware by observing directional
counters return to zero in the final `flow_purge` for a flow while
`total_bytes` did not (documented in this project's `DESIGN.md`; that
specific purge event was not part of the shorter capture excerpted in this
document). It also holds up as independent arithmetic in this capture's own
`flow_stats` records, without needing a purge event: for several digests,
`local_bytes + other_bytes` is an exact multiple of `total_bytes`
(consistent with equal-sized prior deltas already having accumulated into
the total), and never simply equal to it by coincidence across the whole
set. Two examples from the real data:

| digest (first 8 hex) | local+other bytes (this update) | total_bytes | local+other pkts | total_packets | Reading |
|---|---|---|---|---|---|
| `7f3838be` | 240 | 480 | 2 | 4 | This update's delta is exactly half the cumulative total: one earlier, equal-sized update already happened. |
| `37be5b0b` | 189 | 378 | 3 | 6 | Same pattern: exactly 2x, one prior equal delta already folded into `total_bytes`. |
| `f663f9df` | 10806 | 10806 | 35 | 35 | Delta equals total exactly: consistent with this being the flow's first `flow_stats` update (nothing prior to sum in). |

If `local_bytes`/`other_bytes` were themselves cumulative, the delta sum
would always equal the total, never a clean multiple of it. Records like
`7f3838be` and `37be5b0b` rule that out directly from this capture's data.

### 3.6 `flow_purge`

**Confirmed live**, across 10+ purge events captured separately during this
project's hardware testing (`DESIGN.md`), though none happened to fall
inside the specific capture session excerpted in this document (the two
newly detected flows were still active when that capture ended, and none of
the already-tracked flows from the initial `flow_stats` burst closed during
the window). The confirmed live behavior: `local_bytes`/`other_bytes`
(and the matching packet counters) are **always zero** on the closing purge
event; `total_bytes`/`total_packets` carry the flow's final cumulative
totals, unchanged from the flow's last known value going into the purge.
The example below is reconstructed for illustration, since this document's
own capture did not happen to include one, reusing a real digest from this
capture with counters set to that confirmed pattern:

```json
{"established":false,"flow":{"digest":"9c2d7b56c4571e146f65b0d15c12cec661d56b3f","last_seen_at":1787325199999,"local_bytes":0,"other_bytes":0,"total_bytes":642,"local_packets":0,"other_packets":0,"total_packets":6,"reason":"closed"},"interface":"wan","internal":false,"type":"flow_purge"}
```
**(Reconstructed for illustration: this document's own capture did not include a purge event, but the local_bytes/other_bytes=0, total_bytes=final pattern shown is confirmed live behavior, not speculation.)**

| Field | Type | Notes |
|---|---|---|
| `digest` | string | Correlation key; the flow being removed |
| `last_seen_at` | uint64 | Epoch milliseconds |
| `local_bytes`, `other_bytes`, `local_packets`, `other_packets` | uint | **Always zero** on `flow_purge`, confirmed live across 10+ purge events (`DESIGN.md`). The flow's final directional split is not available on this event; see the accounting note below. |
| `total_bytes`, `total_packets` | uint | Final cumulative totals for the flow's whole lifetime |
| `reason` | string | One of `"closed"` (e.g. TCP FIN), `"expired"` (idle timeout), `"terminated"` (e.g. agent shutdown) |

Emitted when a flow leaves the tracking table: normal close, idle expiry, or
agent shutdown. This is the last event you will see for a given digest.
Because the directional counters are zeroed on purge, a consumer cannot read
a flow's final up/down split off this event directly; this project's daemon
instead recovers it by distributing the `total_bytes` delta since the last
known total across up/down using the flow's established ratio from its
prior `flow_stats` updates.

## 4. Consumer-relevant caveat on `agent_status`

Repeated from section 3.3 for visibility: never rely on `agent_status`
carrying `agent_version`/`devices`/`interfaces`/`stats`. Only the base
process-telemetry fields are guaranteed on every frame.

## 5. Naming and id spaces

Two id spaces coexist in `detected_protocol`/`detected_application`, and
they are **not** globally unique against each other -- this is a genuine
footgun confirmed directly from the real `definitions` payload.

- **nDPI-native protocol detections** (`detected_protocol` / `protocols[]`
  in `definitions`): plain, unnamespaced strings -- `"DNS"`, `"HTTP"`,
  `"HTTP/S"`, `"BitTorrent"`, `"WireGuard"`, `"Tailscale"`, `"ZOOM"`, etc.
  217 entries in this capture, ids observed from `0` (`"Unknown"`) up to
  `316` (`"Meraki/Cloud"`), plus a sentinel id `4294967295` (`0xFFFFFFFF`,
  uint32 max) tagged `"TODO"` whose meaning is not confirmed by any source
  consulted (placeholder for an unassigned/pending signature, presumably,
  but unverified).

- **Netify application-layer detections** (`detected_application` /
  `applications[]` in `definitions`): use the `netify.<slug>` naming
  convention when a specific app/service was identified on top of the
  transport protocol -- `netify.netflix`, `netify.tailscale`,
  `netify.openwrt`, etc. 416 entries in this capture, 199 of which are
  `netify.`-prefixed; the remaining 217 non-`netify.`-prefixed entries in
  the *applications* array are the same low-numbered nDPI protocol tags
  mirrored into that array as well (e.g. id `156` appears in `applications[]`
  tagged `"Spotify"` *and* separately in `applications[]` tagged... no --
  more precisely: id `156` is `"Spotify"` in `protocols[]` and
  `"netify.spotify"` in `applications[]`. These are two different arrays
  with independently assigned ids that happen to collide numerically.

**The id-collision gotcha, confirmed directly from the real captured
`definitions` payload:**

| Numeric id | Meaning in `protocols[]` | Meaning in `applications[]` |
|---|---|---|
| 121 | `Dropbox` | `netify.dropbox` |
| 156 | `Spotify` | `netify.spotify` |
| 206 | `WireGuard` | `netify.cloudflare` |
| 207 | `SMPP` | `netify.microsoft-onedrive` |

`id 206` is the sharpest example: it is `WireGuard` in the protocol table
and `netify.cloudflare` in the application table -- two completely unrelated
things sharing a number. **Always resolve `detected_protocol` only against
`definitions.protocols[]`, and `detected_application` only against
`definitions.applications[]`. Never cross-reference an id between the two
arrays.**

A second, related nuance: a widely-repeated simplification (also present in
this project's own `DESIGN.md`, stated there as a general rule of thumb) is
that netify application ids are `>= 10000` and nDPI protocol ids are
`< 10000`. That is the dominant pattern for *recently added* app signatures,
but it is not a hard rule: this capture's `applications[]` array contains at
least 26 legacy `netify.<slug>` entries with ids well under 10000, including
some very common ones:

```
68   netify.msn
70   netify.yahoo
119  netify.facebook
120  netify.twitter
121  netify.dropbox
122  netify.gmail
124  netify.youtube
133  netify.netflix
156  netify.spotify
195  netify.twitch
199  netify.snapchat
201  netify.instagram
202  netify.microsoft
206  netify.cloudflare
```

The reliable discriminator for "is this an app-level detection, not just a
protocol-level one" is the literal `netify.` string prefix on
`detected_application_name`, not the numeric id range. Use the prefix test,
not an id threshold.

Cross-checked against the actual `netify-apps.conf` examples cited in prior
source-reading of this project (`app:133:netify.netflix`,
`app:10119:netify.adobe`, `app:10552:netify.tesla`, `app:199:netify.snapchat`):
all four id-to-slug pairs match exactly what's in this capture's
`definitions.applications[]` array, which is good cross-validation that the
signature-file mapping and the live socket's id table are the same data.

## 6. Category files on disk

`/etc/netify.d/netify-categories.json` (installed by the `netifyd` package,
not vendored by this repo) provides the category taxonomy:

- `application_tag_index` / `protocol_tag_index` -- numeric category id to
  name, e.g. `streaming-media`, `social-media`, `games`, `voip`, `cdn`,
  `advertiser`, `malware`, `os-software-updates`.
- `application_index` / `protocol_index` -- numeric category id to the
  member application/protocol ids in that category.

These map to `flow.category.application` / `flow.category.protocol` /
`flow.category.domain` (see section 3.4). No category object was captured in
enough detail in this session to re-derive the full tag list independently;
figures below are as previously documented and are called out where they
disagree.

**Count discrepancy, unresolved**: prior source-reading of this project
enumerated exactly 31 application-category tags and 17 protocol-category
tags by name. This project's `DESIGN.md` states 32 and 18 respectively
(without enumerating the 32nd/18th). Neither the category JSON file itself
nor a `flow.category.*` value dense enough to reverse-engineer the missing
entry was available for this document. Treat `DESIGN.md`'s counts as
authoritative per this project's convention, but be aware the exact
32nd application tag and 18th protocol tag were not independently confirmed
here.

**Licensing**: both the signature database that drives application/protocol
detection and the generated category file are proprietary data owned by
eGloo/Netify, shipped as part of the `netifyd` package itself, not part of
netifyd's GPLv3 source distribution in the way the daemon code is. This
project reads them at runtime from the paths above and vendors none of this
data in its own repository. (Prior source-level reading found the explicit
proprietary-license header specifically inside a signature pattern-matching
file distinct from the plain id-to-slug `netify-apps.conf`; that specific
filename-level detail was not independently re-confirmed for this document
and is listed under "Unverified / unknown." The operative conclusion, that
none of this data should be vendored or redistributed, is confirmed by both
sources independently and is not in question.)

## 7. Practical consumer guidance

**Join on digest.** `flow.digest` and `flow.last_seen_at` are the only two
fields serialized unconditionally across every event type that carries a
`flow` object. Key your flow table by `digest`. Do not assume any other
field is always present -- `flow` carries identity and no counters,
`flow_stats` carries counters and no identity, `flow_purge` carries a final
cumulative `total_bytes`/`total_packets` plus a reason, but zeroed
directional counters (§3.6): it does not carry a final directional split.

**Stub-flow pattern.** Because `dump_established_flows` does not exist in
4.4.7 (section "Scope" above), and because this is directly demonstrated by
the real capture (11 `flow_stats` records for digests never announced via
`flow` on this connection), a consumer must tolerate `flow_stats` or
`flow_purge` arriving for an unknown digest. Do not drop these events.
Instead, create a placeholder entry (interface/internal known from the
envelope, identity fields set to an "Unknown" sentinel) and backfill
identity if and when a `flow` event for that same digest eventually arrives.
It may never arrive, if the flow was already fully classified before this
connection started and its classification does not get re-announced.

**Delta clamping rationale.** Because `local_bytes`/`other_bytes` are
per-update deltas while `total_bytes` is the only cumulative field, a
consumer accounting a running rate should sum the directional deltas per
interval directly. But right after a reconnect (where a stub flow has no
prior history), or after any missed update, naively summing deltas risks
overshooting the flow's real observed growth. Clamp the accounted delta so
the consumer's own running total for that digest never exceeds
`total_bytes`'s growth: `accounted_delta = min(local_bytes + other_bytes,
total_bytes - last_known_total)`. This is the approach this project's daemon
takes, and it is the correct general-purpose defense against the blind-spot
created by the missing backfill option.

**Resolve ids against the matching array only.** `detected_protocol` against
`definitions.protocols[]`; `detected_application` against
`definitions.applications[]`; `flow.category.*` against
`netify-categories.json`'s index tables. All three are separate id spaces
that can and do collide numerically (section 5).

## 8. Unverified / unknown

Collected here in one place rather than scattered as caveats only:

- **`established` (top-level boolean)** -- precise semantics not confirmed
  by source reading or by this capture (always `false` in the sample, which
  is too uniform to infer meaning from).
- **`update_imf`** (in `agent_status`) -- present, value `1` in both captured
  frames, meaning not confirmed by any source consulted.
- **`first_update_at`** (in `flow`) -- a real field, not previously
  documented for this interface. Identical to `first_seen_at` in both
  captured examples (both first-detection events); whether/how it diverges
  when `detection_updated` fires is unconfirmed.
- **The `agent_status` timing anomaly** -- `uptime` advanced 15s between two
  captured frames while `timestamp` advanced only 1s. Not explained; may be
  a genuine daemon quirk or a capture-environment artifact. Flagged, not
  asserted as behavior to depend on.
- **`risks.risks[]` numeric values** (e.g. `46` observed) -- no id-to-name
  mapping found in any netifyd-side source or doc consulted. These are
  presumably nDPI's own risk-flag enum (documented upstream in nDPI, not in
  netifyd), which was out of scope to chase down for this document.
- **`other_type` full enum** -- only `"local"` was observed live. The other
  values (`remote`, `broadcast`, `multicast`, `unsupported`, `error`,
  `unknown`) come from source reading only, not from this capture.
- **`ct_id`/`ct_mark`/conntrack correlation** -- absent from both captured
  `flow` examples despite `conntrack` being a compiled-in capability per
  `build_version`. Unconfirmed whether that's because these are UDP/no-NAT
  flows or because emission requires a config flag not on by default.
- **Category tag counts** -- 31/17 (prior source enumeration, with names) vs
  32/18 (`DESIGN.md`, without full enumeration). Not reconciled; see
  section 6.
- **Whether `detected_application_name` can be absent/empty** for
  protocol-only detections -- asserted by source reading, not observed
  empty in this capture (both examples had an app name set).
- **The specific filename carrying the proprietary-license header** on the
  signature data (`netify-apps.conf` vs. a separate pattern-matching file) --
  see the licensing note in section 6.
- **TCP socket default port** -- irrelevant to OpenWrt's default
  UNIX-socket-only configuration, so omitted from the main body, but never
  resolved in prior research: conflicting values (`7150` in man-page prose,
  `2100` in a shipped sample config) were found and neither was checked
  against a running instance with TCP enabled.
- **`http.*`, `dhcp.fingerprint`, `gtp.*` sub-objects** -- none observed in
  this capture (no flows of the relevant type were present); documented from
  source only.

## 9. Sources

- Direct hardware capture: Linksys EA8500, OpenWrt 25.12.5, netifyd 4.4.7,
  UNIX socket capture immediately following daemon start (this document's
  primary evidence for every "real captured example").
- This project's `docs/DESIGN.md`, sections 2 and 2.4 (separately
  hardware-verified facts, treated as authoritative wherever they conflict
  with source-only reading).
- netifyd 4.4.7 source at the exact shipped tag:
  `gitlab.com/netify.ai/public/netify-agent` (tag `v4.4.7`), in particular
  `src/netifyd.cpp`, `src/nd-detection.cpp`, `src/nd-json.cpp`,
  `src/nd-socket.cpp`, `include/nd-flow.h`, `include/netifyd.h`,
  `deploy/netifyd.conf.in`, `deploy/netify-categories.json`,
  `deploy/netify-apps.conf`, `doc/netifyd.conf.5.in`,
  `doc/README-JSON-socket-example.md`, `doc/json-socket-filter.jq`.
- OpenWrt packaging: `github.com/openwrt/packages`, `net/netifyd/`
  (Makefile, `files/netifyd.init`, `files/netifyd.config`).
