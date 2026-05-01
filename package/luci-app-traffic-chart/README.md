# luci-app-traffic-chart 1.1.0-r12

Live traffic chart for OpenWrt (LuCI). Shows traffic per application, device and destination,
the busiest flows, shaper health (drops, ECN marks, queue backlog) and a history
(24 h / week / month / year) with optional persistent storage.

It reads `/proc/net/nf_conntrack` and the qdisc counters, so it does not depend on which shaper
or classifier is used. NSS (nsstbl/nssfq_codel) and generic shapers (cake, htb+fq_codel) are detected
automatically.

The package also ships `nss-trafficchart.qos`, an SQM script for Qualcomm NSS hardware offload with
port based traffic classes. It is optional and independent of the chart.


<img width="1950" height="1363" alt="Bildschirmfoto vom 2026-09-29 01-05-22" src="https://github.com/user-attachments/assets/2a2589db-1969-4608-b04e-83a4ab8bb47d" />
<img width="1950" height="1363" alt="Bildschirmfoto vom 2026-09-29 01-06-35" src="https://github.com/user-attachments/assets/2505da5a-d370-4fa7-a157-50a6899278dc" />
<img width="1950" height="1363" alt="Bildschirmfoto vom 2026-09-29 01-06-03" src="https://github.com/user-attachments/assets/a627bee4-34f6-4996-8b9e-989d6fcefe71" />
<img width="1950" height="1363" alt="Bildschirmfoto vom 2026-09-29 01-01-44" src="https://github.com/user-attachments/assets/e66ec458-9168-45d3-b8fd-a8d767f3850d" />
<img width="1950" height="1363" alt="Bildschirmfoto vom 2026-09-29 01-02-24" src="https://github.com/user-attachments/assets/bdfe1d4f-0fb9-4828-94a8-0b42950c4def" />

Maintainer: m0g13r <155771712+m0g13r@users.noreply.github.com> - License: GPL-2.0-or-later (see LICENSE)

## Installation
Install the package, then open **Network -> Traffic Chart** (and **Traffic Chart Settings**) in LuCI.
The postinstall script enables and starts the `trafficchart` service and reloads rpcd.

Required: `luci-base`, `rpcd`, `jsonfilter`, `ip-full`, `tc-tiny` (pulled in automatically).
Optional:
- `socat` + `netifyd` (with a `[socket] listen_path` in `/etc/netifyd.conf`): application names.
  Without them flows are named `[proto/port]`.
- `conntrack` and `sqm-scripts`: only for `nss-trafficchart.qos`.

## Components
| Part | Installed as |
|---|---|
| Aggregator (conntrack, history) | `/usr/libexec/trafficchart-agg`, service `/etc/init.d/trafficchart` |
| netifyd application labels | `/usr/libexec/trafficchart-apps` |
| Shaper detection + counters | `/usr/libexec/trafficchart-common`, `trafficchart-tc` |
| LAN device identity, IPv6 prefixes | `/usr/libexec/trafficchart-hosts`, `trafficchart-v6prefixes` |
| Persistent storage helper | `/usr/libexec/trafficchart-persist-exec` |
| rpcd plugin + ACLs | `/usr/libexec/rpcd/luci.trafficchart`, `/usr/share/rpcd/acl.d/luci-app-traffic-chart.json` |
| LuCI pages | `/www/luci-static/resources/view/network/traffic_chart.js`, `trafficchart_config.js` |
| NSS SQM script | `/usr/lib/sqm/nss-trafficchart.qos` (+ `.help`) |
| Settings | `/etc/config/trafficchart` (kept on upgrade) |
| Runtime data | `/var/run/trafficchart/` (RAM) |

Two ACL groups exist: `luci-app-traffic-chart` (read only) and `luci-app-traffic-chart-admin`
(settings, restart service, clear history).

## Settings (`/etc/config/trafficchart`, section `global`, or LuCI "Traffic Chart Settings")
Saving restarts the aggregator: cumulative totals reset, the history survives.

| Option | Default | Meaning |
|---|---|---|
| `enabled` | 1 | Run the aggregator |
| `apps` | 1 | Application names via netifyd (needs socat + netifyd) |
| `backend` | auto | `auto`, `nss` or `generic` |
| `interval` | 4 | Seconds between conntrack passes (stretches under load) |
| `wan_dev` | auto | WAN device(s) or logical interface(s), space separated |
| `tooltips` | 1 | Maintain the tooltip tables (costs CPU) |
| `l2_overhead` | auto | Link header bytes per packet (`auto` or 0-99) |
| `attr_totals`, `attr_ports`, `attr_skip_ports`, `attr_win`, `attr_tol`, `attr_min`, `attr_share`, `attr_max_apps`, `attr_max_devices` | see LuCI | Attribution of router proxy traffic to LAN devices |
| `sock` | /var/run/netifyd/netifyd.sock | netifyd socket (must be a `.sock` below /var/run/netifyd) |
| `persist_dir` | empty | Storage path(s) below /mnt, /media or /tmp/mnt; empty = history in RAM only |
| `persist_mount` | empty | Only use a target while this path is mounted |
| `persist_sec` | 3600 | Seconds between writes (min 60) |
| `persist_timeout` | 10 | Access timeout for a target (3-120) |
| `hist_sec`, `hist_keep`, `hist_hour_keep`, `hist_day_keep` | 300, 288, 744, 400 | History resolution and retention |
| `app_max`, `host_max`, `row_keep` | 400, 200, 40 | Table limits |

Classifier options (used by `nss-trafficchart.qos`, restart SQM after changing):

| Option | Default | Meaning |
|---|---|---|
| `bulk_bytes` | 314572800 | WEB/P2P/BE flows above this size (300 MiB) become BULK |
| `reset_ct_marks` | 1 | Zero the conntrack marks when SQM starts; use 0 with mwan3 |
| `dns_redirect` | 0 | Redirect DNS (port 53) from all non-WAN interfaces to the router |
| `dns_redirect_exclude` | empty | Interfaces left out of that redirect (e.g. `wg0`) |
| `ttl_fix` | 0 | Rewrite TTL / hop limit 63 and 127 to 64 |

## nss-trafficchart.qos
SQM script for NSS offload (nsstbl + nssfq_codel). On the SQM page select queue discipline `fq_codel`
and script `nss-trafficchart.qos`. Only one SQM instance is supported (shared `nssifb` and nft table
`inet qos_custom`). Only the low byte of the packet/conntrack mark is used.

Classes (low byte of the mark): 0x1 PRIO, 0x2 VOIP, 0x3 GAME, 0x4 WEB, 0x5 STREAM, 0x6 BULK, 0x7 P2P,
0x8 BE, 0x9 VPN, 0xa MAIL, 0xb NTP, 0xc FTP, 0xd REMOTE, 0xe DB, 0xf MGMT, 0x10 CONTAINER, 0x11 IOT,
0x40 router originated traffic. The order of the rules is the priority.

The script is derived from simple.qos / nss.qos (ricsc, qosmio sqm-scripts-nss) and was formerly named
`nss-trafficchart.qos`. The chart does not use the marks.

### Upgrading from nss-rk.qos
The package postinstall runs `/usr/libexec/trafficchart-migrate`: it changes `script 'nss-rk.qos'` to
`nss-trafficchart.qos` in `/etc/config/sqm` and removes the old script files. SQM is not restarted
automatically (restarting nssifb on a running router can crash it): run `/etc/init.d/sqm restart`
when convenient.

## Troubleshooting
- "aggregator not running / stale": `/etc/init.d/trafficchart restart`, then `logread | grep trafficchart`.
- No application names: check `socat` and `netifyd`, and `listen_path` in `/etc/netifyd.conf`.
- "Not attributed" traffic: what the shaper carries but conntrack does not count (router services, multicast,
  dropped packets). The link header size is measured automatically (`l2_overhead`).
- Ruleset check: `nft list table inet qos_custom`; generated file `/tmp/nss-trafficchart-qos.nft`
  (`nft -c -f` to validate).

## Checks done before release
`sh -n` on all scripts, awk programs parse (busybox), JSON valid, LuCI JS syntax, generated nft ruleset passes
`nft -c` (default, PPPoE, FTP helper, DNS redirect, TTL fix), migration script tested with a stub `uci`.


### how it works
With hardware flow offloading, packets in an established connection can bypass most of the normal Linux forwarding path. So something like:

LAN client
   │
   ▼
conntrack / firewall
   │
   ├── first packets ──► CPU
   │
   └── established flow
            │
            ▼
       HW offload/PPE
            │
            ▼
           WAN

means you cannot reliably build a per-application traffic graph by simply counting packets that traverse iptables/nftables.

The project instead uses conntrack accounting as the per-flow source. Its daemon periodically reads:

/proc/net/nf_conntrack

and uses the byte/packet counters associated with each connection. It remembers the previous counter value and records only the delta.

So conceptually:

conntrack flow:

previous bytes = 500 MB
current bytes  = 650 MB

traffic-chart contribution = 150 MB

That continues to work even when the actual packets subsequently take the hardware fast path, because the hardware-offloaded connection remains represented in conntrack.

Linux's flowtable documentation also distinguishes software [OFFLOAD] from hardware [HW_OFFLOAD]; hardware-offloaded flows are still associated with conntrack.
Why it uses TWO different counters

This is the interesting part.

The project has essentially two accounting layers:
1. Per-flow/application traffic

trafficchart-agg reads conntrack:

/proc/net/nf_conntrack
        │
        ▼
per-flow byte counters
        │
        ▼
application/device/destination aggregation
        │
        ▼
Traffic Chart

The code explicitly enables:

/proc/sys/net/netfilter/nf_conntrack_acct = 1

so that conntrack exposes byte/packet accounting.

This is what allows it to say things like:

YouTube       350 MB
Firefox       120 MB
Device A      500 MB
Device B       80 MB

rather than just:

WAN interface = 580 MB

2. Actual link rate

For the actual WAN traffic rate it uses tc/qdisc counters where possible, rather than adding up conntrack flows.

The rate is obtained from the traffic-control counters and that those samples are synchronized with the conntrack accounting.

For example:

                    ┌─ conntrack ──► application/device accounting
                    │
packet flow ────────┤
                    │
                    └─ tc/qdisc ───► actual link traffic/rate

That's important because conntrack accounting and the interface/qdisc accounting don't necessarily count exactly the same bytes.
And it compensates for the difference

The project actually has a "Not attributed" category.

It calculates approximately:

tc bytes
 - conntrack bytes
 - L2 overhead
------------------
= unaccounted traffic

This calculation and accounts for Ethernet/VLAN/PPPoE headers because tc and conntrack can count different layers.

So you can have:

WAN/tc:
    1.02 Gbit/s

conntrack:
    0.99 Gbit/s

difference:
    ~30 Mbit/s

and it doesn't simply pretend that the missing 30 Mbit/s belongs to Firefox/YouTube/etc. It can show it as un-attributed traffic.
What happens with HW offload

Suppose you download a 10 GB file.

Initially:

TCP SYN
   ↓
CPU
   ↓
conntrack created
   ↓
flow gets HW_OFFLOAD

Then:

       ┌─────────────────────────────┐
       │        Hardware PPE         │
       │                             │
LAN ───┤  10 GB of packets ───── WAN │
       └─────────────────────────────┘

The CPU isn't processing every packet anymore.

But conntrack still has something like:

src=192.168.1.20
dst=...
sport=...
dport=443

bytes=...
packets=...

and the traffic-chart daemon periodically sees:

poll #1:  100 MB
poll #2:  250 MB
poll #3:  500 MB

and calculates:

+150 MB
+250 MB

rather than needing to see the individual packets.

That's the key trick.
One important caveat

That means its accuracy depends on your platform/driver/kernel maintaining meaningful conntrack statistics for HW-offloaded flows.

This is an important distinction because hardware-offload statistics have historically been somewhat platform-dependent. There has even been recent Linux kernel work specifically to propagate statistics for HW-offloaded flows that are delegated through parent devices/DSA.
In short

The architecture is roughly:

                  ┌──────────────────────┐
                  │      Conntrack       │
                  │ flow byte counters   │
                  └──────────┬───────────┘
                             │
                             ▼
                      trafficchart-agg
                             │
                    per-flow deltas
                             │
               ┌─────────────┼─────────────┐
               ▼             ▼             ▼
          Application      Device      Destination


Actual traffic rate:

WAN ──► tc/qdisc/interface counters ──► link rate


Then:

             tc traffic
                 │
                 ├── conntrack traffic
                 │
                 └── L2 overhead
                         │
                         ▼
                  "Not attributed"

So HW offloading can remain enabled while still getting application/device traffic graphs, because the chart isn't trying to observe every accelerated packet. It observes the accounting associated with the connection.


