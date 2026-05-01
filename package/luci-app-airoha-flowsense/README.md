# luci-app-airoha-flowsense

**Airoha FlowSense** — Hardware Offload & PPE Performance Monitor for the Gemtek W1700K (Airoha AN7581 / MT7996).

Provides real-time visibility into NPU offload state, PPE flow table health, WiFi band performance, hardware buffer congestion, WAN link integrity, and upstream latency — all from a single LuCI dashboard.

---

## Features

- **NPU / PPE flow monitor** — live counts of bound (BND, hardware-offloaded) and unbound (UNB, learning) flows, with per-band and per-port breakdown
- **Compass visualisation** — SVG tachometer compass showing NPU path vs. CPU path load, WAN/WiFi integrity, hardware buffer health, and upstream latency
- **WiFi band tachometers** — per-band (2.4 / 5 / 6 GHz) retry rate, TX throughput, station count, and signal
- **Ethernet port gauges** — per-port TX/RX throughput with link speed and BND/UNB flow counts
- **Frame engine monitoring** — PSE queue depths, GDM/CDM drop counters via direct hardware register reads
- **Latency & jitter** — background daemon continuously pings an upstream target (default: 1.1.1.1), independent of routing mode
- **Auto mode detection** — adapts UI between Router and AP mode automatically
- **Conflict alerts** — warns when NPU offload is bypassing SQM/CAKE, physical errors are present, or latency is unexpectedly high despite offload being active
- **Offload toggles** — enable/disable HW flow offload, VLAN offload, and PPPoE offload from the UI, with persistent sysctl settings

---

## UI Layout

```
[ Conflict Alerts ]          (collapsible — ghost shaper / physical errors / latency anomaly)

[ Main Compass ]             NPU path / integrity / buffer health / latency
[ CPU/NPU Tachometer ]       CPU load % + frequency + governor
[ WiFi Tachometers x3 ]      2.4 GHz / 5 GHz / 6 GHz — retry%, throughput, stations, signal

[ Ethernet Port Gauges ]     WAN + LAN1–4: TX/RX bars, link speed, BND/UNB counts

[ Offload Toggles ]          HW Flow Offload / VLAN Offload / PPPoE Offload

[ PPE Terminal ]             Live BND (cyan) + UNB (orange) flow table entries, top 25 each
```

Poll interval: **5 seconds** (all RPC calls made in parallel).

---

## System Requirements

### Kernel / Hardware Interfaces

| Path | Purpose |
|------|---------|
| `/sys/kernel/debug/ppe/entries` | Unbound PPE flow entries |
| `/sys/kernel/debug/ppe/bind` | Bound (hardware-offloaded) PPE flows |
| `/sys/kernel/debug/ieee80211/phy0/mt76/token_info` | MT7996 WiFi token/queue info |
| `/sys/kernel/debug/ieee80211/phy0/mt76/tx_stats` | Per-band TX statistics |
| `/sys/kernel/debug/clk/npu/clk_rate` | NPU clock frequency |
| `/sys/bus/platform/drivers/airoha-npu/` | NPU driver device enumeration |
| `/sys/devices/system/cpu/cpufreq/policy0/` | CPU frequency scaling |
| `/sys/class/net/<iface>/statistics/` | Per-interface TX/RX counters and errors |
| `/proc/stat` | CPU time counters for load calculation |
| `/proc/uptime` | System uptime |
| `/proc/interrupts` | NPU watchdog interrupt counts |
| `/proc/sys/net/bridge/bridge-nf-filter-vlan-tagged` | VLAN offload toggle |
| `/proc/sys/net/bridge/bridge-nf-filter-pppoe-tagged` | PPPoE offload toggle |
| `/lib/firmware/airoha/en7581_MT7996_npu_rv32.bin` | NPU firmware (version parsing) |

Hardware registers read directly via `devmem`: PSE port queues, GDM/CDM counters, NPU PLL.

---

### Required Tools

The RPC backend shell script (`/usr/libexec/rpcd/luci.airoha_flowsense`) requires the following tools to be present on the router:

| Tool | Package | Purpose |
|------|---------|---------|
| `iw` | `iw` | WiFi interface enumeration and per-station stats |
| `ip` | `ip-full` | Neighbor table, interface stats, route detection (AP mode) |
| `bridge` | `bridge-utils` | Bridge FDB and forwarding stats |
| `tc` | `tc` | Detect CAKE/SQM shaper (conflict alert) |
| `nft` | `nftables` | Read fw4 flowtable members |
| `devmem` | `devmem` | Direct hardware register reads (PSE/GDM/CDM/PLL) |
| `ubus` | *(built-in)* | WAN interface status queries |
| `uci` | *(built-in)* | Read/write offload and firewall config |
| `jsonfilter` | `jsonfilter` | JSON extraction from ubus output |
| `strings` | `binutils` | NPU firmware version parsing |
| `ping` | *(built-in)* | Jitter daemon upstream latency measurement |
| `awk` / `sed` / `grep` | *(busybox)* | Text processing throughout |

---

## Architecture

```
Kernel / Hardware
  debugfs · sysfs · procfs · devmem registers
        |
  /usr/libexec/rpcd/luci.airoha_flowsense   (RPC backend shell script)
  /usr/libexec/npu-jitter-daemon            (background latency daemon)
        |
  ubus / rpcd transport
        |
  /www/luci-static/resources/view/airoha_flowsense/status.js   (frontend)
        |
  Browser (5s poll, parallel RPC calls, SVG/DOM updates)
```

### RPC Methods

| Method | Type | Description |
|--------|------|-------------|
| `getStatus` | read | NPU version, clock, cores, CPU frequency, governor |
| `getPpeEntries` | read | BND/UNB flow entries, per-band and per-port counts |
| `getTokenInfo` | read | MT7996 token buffer and queue health per band |
| `getFrameEngine` | read | PSE queue depths, GDM/CDM drop counters |
| `getTxStats` | read | Per-band TX attempts, success, drops, PER%, BA miss |
| `getDeviceMode` | read | Auto-detected Router vs. AP mode |
| `getWanHealth` | read | WAN interface status, RX/TX bytes/errors |
| `getJitterResult` | read | Upstream latency, jitter, reachability from daemon |
| `getWifiStats` | read | Per-band stations, retries, throughput, signal |
| `getBridgeStats` | read | Bridge RX/TX bytes, drops, forwarding errors |
| `getNpuBypass` | read | HW offload active, CPU%, WAN Mbps, forwarding path |
| `getEthStats` | read | Per-port link speed, TX/RX bytes, errors (WAN + LAN1–4) |
| `getConflictAlerts` | read | Active alert list (ghost shaper, errors, latency) |
| `getVlanOffload` | read | VLAN offload enabled state |
| `getFlowOffload` | read | HW flow offload enabled state |
| `getPppoeOffload` | read | PPPoE offload enabled state |
| `setVlanOffload` | write | Toggle VLAN offload (persists to `/etc/sysctl.d/`) |
| `setFlowOffload` | write | Toggle HW flow offload (UCI + firewall reload) |
| `setPppoeOffload` | write | Toggle PPPoE offload (persists to `/etc/sysctl.d/`) |

---

## Configuration

`/etc/config/npu-monitor` — UCI config created on install:

```
config jitter 'jitter'
    option target '1.1.1.1'
```

Change the target to any reachable host for latency monitoring:

```
uci set npu-monitor.jitter.target='192.0.2.1'
uci commit npu-monitor
/etc/init.d/npu-jitter restart
```

If no target is configured, the daemon falls back to the default gateway
(router mode: the ISP first hop; AP mode: the main router), then `1.1.1.1`.

Note: configs created before 2026-07 used an anonymous section
(`config jitter` with no name); the init script accepts both, addressing the
old form as `npu-monitor.@jitter[0].target`.

---

## Package Info

- **Version**: 1.1.4-3
- **License**: Apache-2.0
- **Target**: `airoha` only (`@TARGET_airoha`)
- **LuCI dependency**: `luci-base`
- **Config file**: `/etc/config/npu-monitor`
- **Init script**: `/etc/init.d/npu-jitter` (started/restarted on package install)

## Bugs

Report bugs at: https://github.com/Gilly1970/Gemtek-W1700K-6.18/issues