#!/usr/bin/env ucode

// Airoha FlowSense RPC backend (ucode plugin for rpcd-mod-ucode).
//
// Replaces the fork-heavy shell backend: rpcd runs this inside its own VM, so
// a poll cycle costs file reads and netlink calls instead of ~600 processes.
// backend.sh is kept alongside as a manual fallback/debug tool; nothing calls it.

'use strict';

import { readfile, writefile, open, popen, glob, lsdir, stat, chmod } from 'fs';
import { cursor } from 'uci';
import { connect } from 'ubus';
import * as nl from 'nl80211';

const PPE_BIND = '/sys/kernel/debug/ppe/bind';
const PPE_ENTRIES = '/sys/kernel/debug/ppe/entries';
const PHY_DBG = '/sys/kernel/debug/ieee80211/phy0';
const JITTER_FILE = '/tmp/npu-jitter.json';

let ubus_conn;

function ubus_call(obj, method, args) {
	if (!ubus_conn)
		ubus_conn = connect();
	return ubus_conn?.call(obj, method, args ?? {});
}

function slurp(path) {
	return readfile(path);
}

function slurp_lines(path) {
	const data = readfile(path);
	return data ? split(data, '\n') : [];
}

function num(value, dflt) {
	if (value == null)
		return dflt ?? 0;
	const n = +trim('' + value);
	return (n == n) ? n : (dflt ?? 0);
}

function read_num(path, dflt) {
	return num(readfile(path), dflt);
}

function read_str(path, dflt) {
	const v = readfile(path);
	return v != null ? trim(v) : (dflt ?? '');
}

// like $(cat file): strip the trailing newline only, keep inner/trailing spaces
function read_line_raw(path, dflt) {
	let v = readfile(path);
	if (v == null)
		return dflt ?? '';
	while (length(v) && (substr(v, -1) == '\n' || substr(v, -1) == '\r'))
		v = substr(v, 0, length(v) - 1);
	return v;
}

// busybox devmem prints "0xNNNNNNNN"; ucode has no int(str, base)
function hexval(s) {
	if (!s)
		return 0;
	s = trim(s);
	if (index(s, '0x') == 0 || index(s, '0X') == 0)
		s = substr(s, 2);
	let v = 0;
	for (let i = 0; i < length(s); i++) {
		const c = ord(s, i);
		let d = -1;
		if (c >= 48 && c <= 57) d = c - 48;
		else if (c >= 97 && c <= 102) d = c - 87;
		else if (c >= 65 && c <= 70) d = c - 55;
		else break;
		v = v * 16 + d;
	}
	return v;
}

// One shell for N registers instead of one per register
function devmem_many(addrs) {
	const cmd = join('; ', map(addrs, a => sprintf('devmem 0x%x', a)));
	const p = popen(cmd);
	if (!p)
		return [];
	const out = p.read('all');
	p.close();
	const vals = [];
	for (let line in split(trim(out ?? ''), '\n'))
		push(vals, hexval(line));
	return vals;
}

function count_hex_lines(path) {
	let n = 0;
	for (let line in slurp_lines(path))
		if (match(line, /^[0-9a-fA-F]/))
			n++;
	return n;
}

// AP interfaces from netlink, with the band index encoded in phyN.<band>-...
function ap_interfaces() {
	const res = nl.request(nl.const.NL80211_CMD_GET_INTERFACE, nl.const.NLM_F_DUMP) ?? [];
	const out = [];
	for (let i in res) {
		if (!i.ifname)
			continue;
		if (i.iftype != null && i.iftype != nl.const.NL80211_IFTYPE_AP)
			continue;
		const m = match(i.ifname, /^[^.]+\.([0-9]+)-/);
		let band = m ? +m[1] : null;
		if (band == null) {
			const freq = i.wiphy_freq ?? 0;
			if (freq >= 5925) band = 2;
			else if (freq >= 5000) band = 1;
			else if (freq > 0) band = 0;
		}
		push(out, { ifname: i.ifname, band, mld: (index(i.ifname, '-mld') >= 0) });
	}
	return out;
}

function stations(ifname) {
	return nl.request(nl.const.NL80211_CMD_GET_STATION, nl.const.NLM_F_DUMP, { dev: ifname }) ?? [];
}


// dmesg only grows; the NPU reservations are printed once at boot
let npu_regions_cache;
function npu_memory_regions() {
	if (npu_regions_cache != null)
		return npu_regions_cache;
	const p = popen('dmesg');
	if (!p)
		return [];
	const out = p.read('all') ?? '';
	p.close();
	const regions = [];
	for (let line in split(out, '\n')) {
		if (!match(line, /reserved mem.*npu/))
			continue;
		if (length(regions) >= 4)
			break;
		const range = match(line, /0x([0-9a-fA-F]+)\.\.0x([0-9a-fA-F]+)/);
		const size = match(line, /\(([0-9]+ [KMG]i?B)\)/);
		const name = match(line, /non-reusable ([^ @]+)/);
		if (!range)
			continue;
		push(regions, {
			name: name ? name[1] : '',
			start: `0x${range[1]}`,
			end: `0x${range[2]}`,
			size: size ? size[1] : ''
		});
	}
	if (length(regions))
		npu_regions_cache = regions;
	return regions;
}

// firmware blob never changes while rpcd runs
let npu_version_cache;
function npu_version() {
	if (npu_version_cache != null)
		return npu_version_cache;
	npu_version_cache = 'Unknown';
	const p = popen("strings /lib/firmware/airoha/en7581_MT7996_npu_rv32.bin 2>/dev/null | " +
		"grep -oE '([0-9]+\\.[0-9]+\\.[0-9]+-)?TLB[0-9.]+[-_v0-9]*' | head -1");
	if (p) {
		const out = trim(p.read('all') ?? '');
		p.close();
		if (out != '')
			npu_version_cache = out;
	}
	return npu_version_cache;
}

function wan_device() {
	return ubus_call('network.interface.wan', 'status')?.l3_device;
}

function iface_stat(dev, name) {
	return read_num(`/sys/class/net/${dev}/statistics/${name}`, 0);
}

function set_sysctl_toggle(req, proc_path, conf_path, conf_key) {
	let enabled = req.args?.enabled;
	enabled = (enabled == null) ? 0 : +enabled;
	if (enabled != 0 && enabled != 1)
		return { error: 'enabled must be 0 or 1' };
	const fd = open(proc_path, 'w');
	if (!fd)
		return { error: 'failed - bridge module may not be loaded' };
	fd.write(`${enabled}`);
	fd.close();
	writefile(conf_path, `${conf_key}=${enabled}\n`);
	chmod(conf_path, 0o644);
	return { result: 'ok', enabled };
}

// ---------------------------------------------------------------- PPE tables

function parse_ppe(path, state_filter, limit) {
	const out = { total: 0, ipv4: 0, ipv6: 0, entries: [] };
	for (let line in slurp_lines(path)) {
		if (!match(line, /^[0-9a-fA-F]+ /))
			continue;
		const f = split(trim(line), /\s+/);
		const state = f[1];
		if (state_filter != '' && state != state_filter)
			continue;
		out.total++;
		if (f[2] == 'IPv4') out.ipv4++;
		if (f[2] == 'IPv6') out.ipv6++;
		if (length(out.entries) >= limit)
			continue;

		let type = f[2], subtype = f[3] ?? '';
		if (f[2] != 'IPv4' && f[2] != 'IPv6' && (f[2] == 'L2B' || f[3] == 'L2B')) {
			type = 'L2B';
			subtype = '';
		}
		const orig = match(line, /orig=([^ \t]+)/);
		const nf = match(line, /new=([^ \t]+)/);
		const eth = match(line, /eth=([^ \t]+)/);
		push(out.entries, {
			index: f[0], state, type, proto: subtype,
			orig: orig ? orig[1] : '',
			new_flow: nf ? nf[1] : '',
			eth: eth ? eth[1] : ''
		});
	}
	return out;
}

// per-band client MACs; an MLD station counts on every band it holds a link on
function station_macs_by_band() {
	const bands = [ [], [], [] ];
	let mlo = false;
	for (let ifc in ap_interfaces()) {
		if (ifc.mld) {
			mlo = true;
			for (let dir in glob(`${PHY_DBG}/netdev:${ifc.ifname}/stations/*`) ?? []) {
				const mac = lc(substr(dir, rindex(dir, '/') + 1));
				for (let b = 0; b < 3; b++)
					if (stat(`${dir}/link-${b}`)?.type == 'directory')
						push(bands[b], mac);
			}
			continue;
		}
		if (ifc.band == null || ifc.band > 2)
			continue;
		for (let s in stations(ifc.ifname))
			if (s.mac)
				push(bands[ifc.band], lc(s.mac));
	}
	return { bands, mlo };
}

function mac_in(list, haystack) {
	if (!length(list) || !haystack)
		return false;
	const low = lc(haystack);
	for (let m in list)
		if (m != '' && index(low, m) >= 0)
			return true;
	return false;
}

function arp_ipv4_by_mac() {
	const map = {};
	let first = true;
	for (let line in slurp_lines('/proc/net/arp')) {
		if (first) { first = false; continue; }          // header
		const f = split(trim(line), /\s+/);
		if (length(f) < 4)
			continue;
		const ip = f[0], mac = lc(f[3]);
		if (mac == '' || mac == '00:00:00:00:00:00' || map[mac] != null)
			continue;
		map[mac] = ip;
	}
	return map;
}

function dhcp_hostname_by_mac() {
	const map = {};
	for (let line in slurp_lines('/tmp/dhcp.leases')) {
		const f = split(trim(line), /\s+/);
		if (length(f) < 4)
			continue;
		const mac = lc(f[1]), host = f[3];
		if (mac != '' && host != '' && host != '*')
			map[mac] = host;
	}
	return map;
}

// one `bridge fdb show` instead of one per port
function fdb_macs_by_port() {
	const ports = {};
	const p = popen('bridge fdb show 2>/dev/null');
	if (!p)
		return ports;
	const out = p.read('all') ?? '';
	p.close();
	for (let line in split(out, '\n')) {
		if (index(line, ' self') >= 0 || index(line, ' permanent') >= 0)
			continue;
		const f = split(trim(line), /\s+/);
		if (length(f) < 3 || f[1] != 'dev')
			continue;
		if (!ports[f[2]])
			ports[f[2]] = [];
		push(ports[f[2]], lc(f[0]));
	}
	return ports;
}

// ------------------------------------------------------------- WiFi stats

function round1(v) {
	return +sprintf('%.1f', v);
}

function state_read(path) {
	const raw = readfile(path);
	if (!raw)
		return null;
	const f = split(trim(raw), /\s+/);
	const out = [];
	for (let v in f)
		push(out, +v);
	return length(out) ? out : null;
}

// mt76 per-band MAC counters (survive NPU offload)
function band_bytes_mib() {
	const mib = [ 0, 0, 0 ];
	let band = -1;
	for (let line in slurp_lines(`${PHY_DBG}/mt76/band_bytes`)) {
		let m = match(line, /Phy band ([0-9]+)/);
		if (m) { band = +m[1]; continue; }
		m = match(line, /rx_ampdu_bytes:\s+([0-9]+)/);
		if (m && band >= 0 && band < 3)
			mib[band] = +m[1];
	}
	return mib;
}

// per-station firmware ADM tx_bytes, keyed by band
function fw_tx_bytes_by_band() {
	const tx = [ 0, 0, 0 ];
	const paths = [];
	for (let g in glob(`${PHY_DBG}/netdev:*/stations/*/stats`) ?? [])
		push(paths, g);
	for (let g in glob(`${PHY_DBG}/netdev:*/stations/*/link-*/stats`) ?? [])
		push(paths, g);
	for (let path in paths) {
		let band = -1;
		let m = match(path, /\/link-([0-9])\/stats$/);
		if (m) band = +m[1];
		else if ((m = match(path, /netdev:phy0\.([0-9])-/))) band = +m[1];
		if (band < 0 || band > 2)
			continue;
		for (let line in slurp_lines(path)) {
			const v = match(line, /^tx_bytes:\s+([0-9]+)/);
			if (v) { tx[band] += +v[1]; break; }
		}
	}
	return tx;
}

function tx_stats_by_band() {
	const per = [ 0, 0, 0 ], txok = [ 0, 0, 0 ];
	let band = -1;
	for (let line in slurp_lines(`${PHY_DBG}/mt76/tx_stats`)) {
		let m = match(line, /Phy band ([0-9]+)/);
		if (m) { band = +m[1]; continue; }
		if (band < 0 || band > 2)
			continue;
		if ((m = match(line, /Tx PER:\s+([0-9.]+)/))) per[band] = int(+m[1]);
		else if ((m = match(line, /Tx success:\s+([0-9]+)/))) txok[band] = +m[1];
	}
	return { per, txok };
}

const methods = {
	getStatus: {
		call: function() {
			const drv = '/sys/bus/platform/drivers/airoha-npu';
			let npu_device = '';
			for (let e in lsdir(drv) ?? [])
				if (match(e, /\.npu$/)) { npu_device = e; break; }

			let npu_cores = 0;
			for (let line in slurp_lines('/proc/interrupts'))
				if (index(line, 'airoha-npu-wdt') >= 0)
					npu_cores++;

			let cpu_count = 0;
			for (let e in lsdir('/sys/devices/system/cpu') ?? [])
				if (match(e, /^cpu[0-9]+$/))
					cpu_count++;

			// PLL registers expose the real (possibly overclocked) frequency
			let pll_freq = 0;
			const regs = devmem_many([ 0x1fa202b4, 0x1fa202b8 ]);
			if (length(regs) == 2) {
				const pcw_int = (regs[0] >> 24) & 0x7F;
				const posdiv = (regs[1] >> 4) & 7;
				pll_freq = posdiv ? (pcw_int * 50 / (1 << posdiv)) : (pcw_int * 50);
			}

			const cpufreq = '/sys/devices/system/cpu/cpufreq/policy0';
			return {
				npu_version: npu_version(),
				npu_loaded: (npu_device != ''),
				npu_device,
				npu_clock: read_num('/sys/kernel/debug/clk/npu/clk_rate', 0),
				npu_cores,
				offload_bound: count_hex_lines(PPE_BIND),
				offload_total: count_hex_lines(PPE_ENTRIES),
				memory_regions: npu_memory_regions(),
				cpu_cur_freq: read_num(`${cpufreq}/scaling_cur_freq`, 0),
				cpu_hw_freq: read_num(`${cpufreq}/cpuinfo_cur_freq`, 0),
				cpu_governor: read_str(`${cpufreq}/scaling_governor`, 'unknown'),
				cpu_avail_governors: read_line_raw(`${cpufreq}/scaling_available_governors`, ''),
				cpu_min_freq: read_num(`${cpufreq}/scaling_min_freq`, 0),
				cpu_max_freq: read_num(`${cpufreq}/scaling_max_freq`, 0),
				cpu_avail_freqs: read_line_raw(`${cpufreq}/scaling_available_frequencies`, ''),
				cpu_count,
				pll_freq_mhz: int(pll_freq)
			};
		}
	},

	getPpeEntries: {
		call: function() {
			const bnd = parse_ppe(PPE_BIND, '', 25);
			const unb = parse_ppe(PPE_ENTRIES, 'UNB', 25);

			// the bind file is sometimes a plain count rather than a table
			const raw = readfile(PPE_BIND);
			if (raw != null) {
				const direct = +trim(raw);
				let lines = 0;
				for (let l in split(raw, '\n'))
					if (l != '') lines++;
				const best = (direct == direct && direct > lines) ? direct : lines;
				if (best > 0 && best > bnd.total)
					bnd.total = best;
			}

			const sm = station_macs_by_band();
			const fdb = fdb_macs_by_port();
			const arp = arp_ipv4_by_mac();
			const hosts = dhcp_hostname_by_mac();

			const band_bnd = [ 0, 0, 0 ];
			const port_bnd = [ 0, 0, 0, 0 ];
			const client_bnd = [];
			for (let b = 0; b < 3; b++)
				for (let mac in sm.bands[b])
					push(client_bnd, { mac, ip: arp[mac] ?? '', host: hosts[mac] ?? '', band: b, bnd: 0 });

			const port_lists = [
				fdb.lan1 ?? [], fdb.lan2 ?? [], fdb.lan3 ?? [], fdb.lan4 ?? []
			];

			for (let line in slurp_lines(PPE_BIND)) {
				if (!match(line, /^[0-9a-fA-F]+ BND /))
					continue;
				const m = match(line, /eth=([^ \t]+)/);
				if (!m)
					continue;
				const eth = lc(m[1]);
				for (let b = 0; b < 3; b++)
					if (mac_in(sm.bands[b], eth))
						band_bnd[b]++;
				for (let p = 0; p < 4; p++)
					if (mac_in(port_lists[p], eth)) { port_bnd[p]++; break; }
				for (let c in client_bnd)
					if (index(eth, c.mac) >= 0)
						c.bnd++;
			}

			// UNB rows carry no MAC: match the source IP against each band's clients
			const band_ips = [ [], [], [] ];
			for (let b = 0; b < 3; b++)
				for (let mac in sm.bands[b])
					if (arp[mac] != null)
						push(band_ips[b], arp[mac]);

			const band_unb = [ 0, 0, 0 ];
			for (let line in slurp_lines(PPE_ENTRIES)) {
				if (!match(line, /^[0-9a-fA-F]+ UNB /))
					continue;
				const m = match(line, /orig=([^ \t]+)/);
				if (!m || substr(m[1], 0, 1) == '[')
					continue;
				const src = split(m[1], ':')[0];
				for (let b = 0; b < 3; b++)
					for (let ip in band_ips[b])
						if (ip == src) { band_unb[b]++; break; }
			}

			bnd.band_bnd = band_bnd;
			bnd.port_bnd = port_bnd;
			bnd.client_bnd = client_bnd;
			unb.band_unb = band_unb;
			return { bnd, unb };
		}
	},

	getTokenInfo: {
		call: function() {
			const counts = [];
			for (let band = 0; band < 3; band++) {
				let n = 0, tx_packets = 0, tx_retries = 0;
				for (let ifc in ap_interfaces()) {
					if (ifc.band != band || ifc.mld)
						continue;
					for (let s in stations(ifc.ifname)) {
						n++;
						tx_packets += s.sta_info?.tx_packets ?? 0;
						tx_retries += s.sta_info?.tx_retries ?? 0;
					}
				}
				push(counts, { band, count: n, tx_packets, tx_retries });
			}

			let ple_free = 0, hif_used = 0, hif_reserved = 0;
			for (let line in slurp_lines(`${PHY_DBG}/mt76/hw-queues`)) {
				let m = match(line, /Total free page:\s+(\S+)/);
				if (m && !ple_free) ple_free = hexval(m[1]);
				m = match(line, /HIF free page:\s+\S+\s+\S+\s+(\S+)\s+\S+\s+(\S+)/);
				if (m && !hif_reserved) { hif_reserved = hexval(m[1]); hif_used = hexval(m[2]); }
			}

			return { ple_free, hif_used, hif_reserved, tx_queues: [], station_counts: counts };
		}
	},

	getFrameEngine: {
		call: function() {
			const addrs = [];
			for (let i = 0; i < 10; i++) push(addrs, 0x1fb50150 + i * 4);   // PSE queue
			for (let i = 0; i < 10; i++) push(addrs, 0x1fb50120 + i * 4);   // PSE drops
			push(addrs, 0x1fb50104);                                        // shared buffer
			for (let base in [ 0x1fb50600, 0x1fb51600, 0x1fb52600 ])        // GDM1/2/4
				for (let off in [ 0x04, 0x08, 0x48, 0x4c ])
					push(addrs, base + off);
			for (let base in [ 0x1fb50580, 0x1fb51580 ])                    // CDM1/2
				for (let off in [ 0x00, 0x10, 0x14, 0x20, 0x24 ])
					push(addrs, base + off);

			const v = devmem_many(addrs);
			if (length(v) != length(addrs))
				return { error: 'devmem not available' };

			const pse_ports = [];
			for (let i = 0; i < 10; i++)
				push(pse_ports, {
					port: i,
					iq: (v[i] >> 16) & 0xFFFF,
					oq: v[i] & 0xFFFF,
					drops: v[10 + i]
				});

			const psb = v[20];
			let n = 21;
			const gdm = [];
			for (let g = 0; g < 3; g++, n += 4)
				push(gdm, { tx: v[n], tx_drop: v[n + 1], rx: v[n + 2], rx_drop: v[n + 3] });
			const cdm = [];
			for (let c = 0; c < 2; c++, n += 5)
				push(cdm, {
					tx: v[n], rx_cpu: v[n + 1], rx_hwf: v[n + 2],
					rx_cpu_drop: v[n + 3], rx_hwf_drop: v[n + 4]
				});

			return {
				pse_ports,
				pse_used: (psb >> 16) & 0xFFFF,
				pse_free: psb & 0x7FFF,
				gdm1: gdm[0], gdm2: gdm[1], gdm4: gdm[2],
				cdm1: cdm[0], cdm2: cdm[1]
			};
		}
	},

	getTxStats: {
		call: function() {
			const bands = [];
			let band = -1, attempts = 0, success = 0, per = 0, ba_miss = 0;
			const flush = () => {
				if (band < 0)
					return;
				let drops = attempts - success;
				if (drops < 0) drops = 0;
				push(bands, { band, attempts, success, drops, per, ba_miss });
			};
			for (let line in slurp_lines(`${PHY_DBG}/mt76/tx_stats`)) {
				let m = match(line, /Phy band ([0-9]+)/);
				if (m) {
					flush();
					band = +m[1]; attempts = 0; success = 0; per = 0; ba_miss = 0;
					continue;
				}
				if ((m = match(line, /BA miss count:\s+([0-9]+)/))) ba_miss = +m[1];
				else if ((m = match(line, /Tx attempts:\s+([0-9]+)/))) attempts = +m[1];
				else if ((m = match(line, /Tx success:\s+([0-9]+)/))) success = +m[1];
				else if ((m = match(line, /Tx PER:\s+([0-9.]+)/))) per = int(+m[1]);
			}
			flush();
			return { bands };
		}
	},

	getVlanOffload: {
		call: function() {
			return { enabled: read_num('/proc/sys/net/bridge/bridge-nf-filter-vlan-tagged', 0) };
		}
	},

	setVlanOffload: {
		args: { enabled: 0 },
		call: function(req) {
			return set_sysctl_toggle(req, '/proc/sys/net/bridge/bridge-nf-filter-vlan-tagged',
				'/etc/sysctl.d/14-vlan-offload.conf', 'net.bridge.bridge-nf-filter-vlan-tagged');
		}
	},

	getFlowOffload: {
		call: function() {
			const uci = cursor();
			const fo = uci.get('firewall', '@defaults[0]', 'flow_offloading');
			const foh = uci.get('firewall', '@defaults[0]', 'flow_offloading_hw');
			return { enabled: (fo == '1' && foh == '1') ? 1 : 0 };
		}
	},

	setFlowOffload: {
		args: { enabled: 0 },
		call: function(req) {
			let enabled = req.args?.enabled;
			enabled = (enabled == null) ? 0 : +enabled;
			if (enabled != 0 && enabled != 1)
				return { error: 'enabled must be 0 or 1' };
			const uci = cursor();
			if (enabled == 1) {
				uci.set('firewall', '@defaults[0]', 'flow_offloading', '1');
				uci.set('firewall', '@defaults[0]', 'flow_offloading_hw', '1');
			} else {
				uci.delete('firewall', '@defaults[0]', 'flow_offloading');
				uci.delete('firewall', '@defaults[0]', 'flow_offloading_hw');
			}
			uci.commit('firewall');
			system('/etc/init.d/firewall reload >/dev/null 2>&1 &');
			return { result: 'ok', enabled };
		}
	},

	getPppoeOffload: {
		call: function() {
			return { enabled: read_num('/proc/sys/net/bridge/bridge-nf-filter-pppoe-tagged', 0) };
		}
	},

	setPppoeOffload: {
		args: { enabled: 0 },
		call: function(req) {
			return set_sysctl_toggle(req, '/proc/sys/net/bridge/bridge-nf-filter-pppoe-tagged',
				'/etc/sysctl.d/15-pppoe-offload.conf', 'net.bridge.bridge-nf-filter-pppoe-tagged');
		}
	},

	getDeviceMode: {
		call: function() {
			const uci = cursor();
			if (uci.get('dhcp', 'lan', 'ignore') == '1')
				return { mode: 'ap', reason: 'dhcp_disabled' };

			const wan = ubus_call('network.interface.wan', 'status');
			const wan_ip = wan?.['ipv4-address']?.[0]?.address;
			if (wan?.up !== true || !wan_ip)
				return { mode: 'ap', reason: 'no_wan' };

			// behind another router: default gateway is RFC1918 and we have no WAN IP
			for (let line in slurp_lines('/proc/net/route')) {
				const f = split(line, /\s+/);
				if (length(f) < 3 || f[1] != '00000000')
					continue;
				const g = f[2];
				if (length(g) != 8)
					continue;
				const b = [];
				for (let i = 6; i >= 0; i -= 2)
					push(b, hexval(substr(g, i, 2)));
				if ((b[0] == 192 && b[1] == 168) || b[0] == 10)
					if (!wan_ip)
						return { mode: 'ap', reason: 'local_gateway' };
			}
			return { mode: 'router', reason: '' };
		}
	},

	getWanHealth: {
		call: function() {
			const wan = ubus_call('network.interface.wan', 'status');
			if (!wan)
				return { available: false };
			const dev = wan.l3_device ?? '';
			return {
				available: true,
				up: wan.up === true,
				device: dev,
				uptime: wan.uptime ?? 0,
				rx_bytes: dev ? iface_stat(dev, 'rx_bytes') : 0,
				tx_bytes: dev ? iface_stat(dev, 'tx_bytes') : 0,
				rx_errors: dev ? iface_stat(dev, 'rx_errors') : 0,
				tx_errors: dev ? iface_stat(dev, 'tx_errors') : 0,
				rx_dropped: dev ? iface_stat(dev, 'rx_dropped') : 0,
				tx_dropped: dev ? iface_stat(dev, 'tx_dropped') : 0
			};
		}
	},

	getJitterResult: {
		call: function() {
			const data = readfile(JITTER_FILE);
			if (data) {
				try { return json(data); } catch (e) { }
			}
			return {
				jitter: 0, last_ping: 0, samples: 0,
				target: '1.1.1.1', reachable: false, available: false
			};
		}
	},

	getWifiStats: {
		call: function() {
			const ifaces = ap_interfaces();
			if (!length(ifaces))
				return { available: true, bands: [] };

			const acc = [];
			for (let b = 0; b < 3; b++)
				push(acc, {
					stations: 0, tx_packets: 0, tx_retries: 0, tx_failed: 0,
					sum_phy: 0, phy_n: 0, sum_sig: 0, sig_n: 0, min_sig: 0,
					tx_bytes: 0, rx_bytes: 0, tx_dur: 0, rx_dur: 0,
					sum_txrate: 0, txrate_n: 0, sum_rxrate: 0, rxrate_n: 0,
					rxfrag: 0
				});

			const add_station = function(a, si, with_bytes) {
				a.stations++;
				a.tx_packets += si?.tx_packets ?? 0;
				a.tx_retries += si?.tx_retries ?? 0;
				a.tx_failed += si?.tx_failed ?? 0;
				const txr = (si?.tx_bitrate?.bitrate32 ?? 0) / 10;   // 100kbps -> Mbps
				const rxr = (si?.rx_bitrate?.bitrate32 ?? 0) / 10;
				if (txr > 0) { a.sum_phy += txr; a.phy_n++; a.sum_txrate += txr; a.txrate_n++; }
				if (rxr > 0) { a.sum_rxrate += rxr; a.rxrate_n++; }
				const sig = si?.signal_avg;
				if (sig != null) {
					a.sum_sig += sig; a.sig_n++;
					if (a.sig_n == 1 || sig < a.min_sig) a.min_sig = sig;
				}
				// an MLD station reports one aggregate byte/duration figure for all
				// its links, so counting it per band would multiply the traffic
				if (with_bytes) {
					a.tx_bytes += si?.tx_bytes64 ?? 0;
					a.rx_bytes += si?.rx_bytes64 ?? 0;
					a.tx_dur += si?.tx_duration ?? 0;
					a.rx_dur += si?.rx_duration ?? 0;
				}
			};

			let mlo = false;
			for (let ifc in ifaces) {
				const base = `${PHY_DBG}/netdev:${ifc.ifname}/stations`;
				if (ifc.mld) {
					mlo = true;
					const by_mac = {};
					for (let s in stations(ifc.ifname))
						if (s.mac) by_mac[lc(s.mac)] = s.sta_info;
					for (let dir in glob(`${base}/*`) ?? []) {
						const mac = lc(substr(dir, rindex(dir, '/') + 1));
						for (let b = 0; b < 3; b++) {
							if (stat(`${dir}/link-${b}`)?.type != 'directory')
								continue;
							if (by_mac[mac])
								add_station(acc[b], by_mac[mac], false);
							acc[b].rxfrag += read_num(`${dir}/link-${b}/rx_fragments`, 0);
						}
					}
					continue;
				}
				if (ifc.band == null || ifc.band > 2)
					continue;
				const a = acc[ifc.band];
				for (let s in stations(ifc.ifname))
					add_station(a, s.sta_info, true);
				for (let dir in glob(`${base}/*`) ?? [])
					a.rxfrag += read_num(`${dir}/rx_fragments`, 0);
			}

			const now = time();

			// --- mac80211 byte rates (exact when the flow is not offloaded)
			const bytes_prev = state_read('/tmp/npu-wifi-bytes.prev');
			const tx_mbps = [ 0, 0, 0 ], rx_mbps = [ 0, 0, 0 ];
			if (bytes_prev && length(bytes_prev) >= 4) {
				const dt = now - bytes_prev[0];
				if (bytes_prev[0] > 0 && dt > 0)
					for (let b = 0; b < 3; b++) {
						let d = acc[b].tx_bytes - bytes_prev[1 + b];
						if (d < 0) d = 0;
						tx_mbps[b] = round1(d / dt / 125000);
						if (length(bytes_prev) >= 7) {
							d = acc[b].rx_bytes - bytes_prev[4 + b];
							if (d < 0) d = 0;
							rx_mbps[b] = round1(d / dt / 125000);
						}
					}
			}
			writefile('/tmp/npu-wifi-bytes.prev',
				`${now} ${acc[0].tx_bytes} ${acc[1].tx_bytes} ${acc[2].tx_bytes} ` +
				`${acc[0].rx_bytes} ${acc[1].rx_bytes} ${acc[2].rx_bytes}`);

			// --- hardware rates: MAC MIB uplink + firmware ADM downlink
			const hw_rx = [ 0, 0, 0 ], hw_tx = [ 0, 0, 0 ];
			const mib = band_bytes_mib();
			const fwtx = fw_tx_bytes_by_band();
			if (stat(`${PHY_DBG}/mt76/band_bytes`)?.type == 'file') {
				const hp = state_read('/tmp/npu-wifi-hwbytes.prev');
				let replayed = false;
				if (hp && length(hp) >= 13 && hp[0] > 0 && now <= hp[0]) {
					// duplicate call within the same second: replay, keep the baseline
					for (let b = 0; b < 3; b++) {
						hw_rx[b] = hp[7 + b];
						hw_tx[b] = hp[10 + b];
					}
					replayed = true;
				} else if (hp && length(hp) >= 7 && hp[0] > 0 && now > hp[0]) {
					const dt = now - hp[0];
					for (let b = 0; b < 3; b++) {
						let d = mib[b] - hp[1 + b];
						if (d < 0) d += 4294967296;                 // u32 wrap
						if (d < 0 || d > 2147483648) d = 0;
						hw_rx[b] = round1(d * 8 / dt / 1000000);
						d = fwtx[b] - hp[4 + b];
						if (d < 0) d = 0;
						hw_tx[b] = round1(d * 8 / dt / 1000000);
					}
				}
				if (!replayed)
					writefile('/tmp/npu-wifi-hwbytes.prev',
						`${now} ${mib[0]} ${mib[1]} ${mib[2]} ${fwtx[0]} ${fwtx[1]} ${fwtx[2]} ` +
						`${hw_rx[0]} ${hw_rx[1]} ${hw_rx[2]} ${hw_tx[0]} ${hw_tx[1]} ${hw_tx[2]}`);
			}

			// --- per-band PER + frame rate
			const ts = tx_stats_by_band();
			const fcur = [ 0, 0, 0 ], frames = [ 0, 0, 0 ];
			for (let b = 0; b < 3; b++)
				fcur[b] = ts.txok[b] + acc[b].rxfrag;
			const fprev = state_read('/tmp/npu-wifi-frames.prev');
			if (fprev && length(fprev) >= 4 && fprev[0] > 0 && now > fprev[0]) {
				const dt = now - fprev[0];
				for (let b = 0; b < 3; b++) {
					let d = fcur[b] - fprev[1 + b];
					if (d < 0) d = 0;
					frames[b] = int(d / dt);
				}
			}
			writefile('/tmp/npu-wifi-frames.prev', `${now} ${fcur[0]} ${fcur[1]} ${fcur[2]}`);

			// --- airtime-derived throughput for offloaded bands, efficiency auto-learned
			let seed = num(cursor().get('npu-monitor', 'settings', 'air_eff'), 80);
			if (seed < 1 || seed > 200) seed = 80;
			let seedf = seed / 100;
			if (seedf < 0.3) seedf = 0.3;
			if (seedf > 1) seedf = 1;

			const bnd_per_band = [ 0, 0, 0 ];
			if (stat(PPE_BIND)?.type == 'file') {
				const sm = station_macs_by_band();
				for (let line in slurp_lines(PPE_BIND)) {
					if (!match(line, /^[0-9a-fA-F]+ BND /))
						continue;
					const m = match(line, /eth=([^ \t]+)/);
					if (!m)
						continue;
					for (let b = 0; b < 3; b++)
						if (mac_in(sm.bands[b], m[1]))
							bnd_per_band[b]++;
				}
			}

			const air = [ 0, 0, 0 ], eff = [ seedf, seedf, seedf ];
			const ap = state_read('/tmp/npu-wifi-airtime.prev');
			const FLOOR = 15, ALPHA = 0.25;
			if (ap && length(ap) >= 10) {
				// fields 8..10 hold the learned efficiencies (the shell read 9..11,
				// so band 0 used band 1's value and band 2 never learned at all)
				for (let b = 0; b < 3; b++) {
					const e = ap[7 + b];
					if (e >= 0.3 && e <= 1.0)
						eff[b] = e;
				}
				const dt = now - ap[0];
				if (ap[0] > 0 && dt > 0)
					for (let b = 0; b < 3; b++) {
						let dtd = acc[b].tx_dur - ap[1 + b];
						if (dtd < 0) dtd = 0;
						let drd = acc[b].rx_dur - ap[4 + b];
						if (drd < 0) drd = 0;
						const btr = acc[b].txrate_n ? acc[b].sum_txrate / acc[b].txrate_n : 0;
						const brr = acc[b].rxrate_n ? acc[b].sum_rxrate / acc[b].rxrate_n : 0;
						let raw = (dtd * btr + drd * brr) / 1000000 / dt;
						if (raw != raw || raw > 20000) raw = 0;
						const exact = tx_mbps[b] + rx_mbps[b];
						if (bnd_per_band[b] == 0 && raw > FLOOR && exact > FLOOR) {
							const sc = exact / raw;
							if (sc >= 0.3 && sc <= 1.0)
								eff[b] = eff[b] * (1 - ALPHA) + sc * ALPHA;
						}
						air[b] = round1(raw * eff[b]);
					}
			}
			writefile('/tmp/npu-wifi-airtime.prev',
				`${now} ${int(acc[0].tx_dur)} ${int(acc[1].tx_dur)} ${int(acc[2].tx_dur)} ` +
				`${int(acc[0].rx_dur)} ${int(acc[1].rx_dur)} ${int(acc[2].rx_dur)} ` +
				sprintf('%.3f %.3f %.3f', eff[0], eff[1], eff[2]));

			const bands = [];
			for (let b = 0; b < 3; b++) {
				const a = acc[b];
				if (!a.stations)
					continue;
				push(bands, {
					band: b,
					stations: a.stations,
					tx_packets: a.tx_packets,
					tx_retries: a.tx_retries,
					tx_failed: a.tx_failed,
					avg_phy_rate: a.phy_n ? round1(a.sum_phy / a.phy_n) : 0,
					retry_pct: ts.per[b],
					avg_signal: a.sig_n ? int(a.sum_sig / a.sig_n) : 0,
					min_signal: a.min_sig,
					tx_mbps: tx_mbps[b],
					rx_mbps: rx_mbps[b],
					air_mbps: air[b],
					hw_tx_mbps: hw_tx[b],
					hw_rx_mbps: hw_rx[b],
					air_eff: int(eff[b] * 100),
					frames_ps: frames[b],
					tx_bytes_raw: a.tx_bytes
				});
			}

			return { available: true, mlo, bands };
		}
	},

	getBridgeStats: {
		call: function() {
			if (stat('/sys/class/net/br-lan')?.type != 'directory')
				return { available: false };
			return {
				available: true,
				rx_bytes: iface_stat('br-lan', 'rx_bytes'),
				rx_packets: iface_stat('br-lan', 'rx_packets'),
				rx_dropped: iface_stat('br-lan', 'rx_dropped'),
				tx_bytes: iface_stat('br-lan', 'tx_bytes'),
				tx_packets: iface_stat('br-lan', 'tx_packets'),
				tx_dropped: iface_stat('br-lan', 'tx_dropped'),
				fwd_errors: 0
			};
		}
	},

	getNpuBypass: {
		call: function() {
			const uci = cursor();
			const hw_offload = (uci.get('firewall', '@defaults[0]', 'flow_offloading_hw') == '1');

			// same count as the shell: raw line count minus a non-numeric header
			let offload_bound = 0;
			const bind_lines = slurp_lines(PPE_BIND);
			if (length(bind_lines)) {
				offload_bound = length(bind_lines);
				if (bind_lines[length(bind_lines) - 1] == '')
					offload_bound--;
				if (length(bind_lines[0]) && !match(bind_lines[0], /^[0-9]/))
					offload_bound--;
				if (offload_bound < 0)
					offload_bound = 0;
			}

			let cpu_pct = 0;
			const jit = readfile(JITTER_FILE);
			if (jit) {
				const m = match(jit, /"cpu_pct":([0-9]+)/);
				if (m) cpu_pct = +m[1];
			}

			// WAN TX delta, router mode only
			let wan_mbps = 0;
			const dev = wan_device();
			if (dev) {
				const cur_tx = iface_stat(dev, 'tx_bytes');
				const now = time();
				const prev = readfile('/tmp/npu-wan-tx.prev');
				if (prev) {
					const p = split(trim(prev), /\s+/);
					const prev_tx = num(p[0], 0), prev_time = num(p[1], 0);
					const elapsed = now - prev_time;
					if (elapsed > 0 && cur_tx >= prev_tx)
						wan_mbps = int((cur_tx - prev_tx) * 8 / elapsed / 1000000);
				}
				writefile('/tmp/npu-wan-tx.prev', `${cur_tx} ${now}`);
			}

			let npu_active = false, path = 'cpu';
			if (hw_offload && offload_bound > 0) { npu_active = true; path = 'npu'; }
			else if (hw_offload) path = 'npu_idle';

			return {
				hw_offload_enabled: hw_offload,
				cpu_pct, wan_mbps, offload_bound, npu_active, path
			};
		}
	},

	getConflictAlerts: {
		call: function() {
			const uci = cursor();
			const hw_offload = (uci.get('firewall', '@defaults[0]', 'flow_offloading_hw') == '1');
			const alerts = [];
			const dev = wan_device();

			let cake_on_wan = false;
			if (dev) {
				const p = popen(`tc qdisc show dev ${dev} 2>/dev/null`);
				if (p) {
					const out = p.read('all') ?? '';
					p.close();
					cake_on_wan = (match(out, /^qdisc cake/) != null);
				}
			}
			if (hw_offload && cake_on_wan)
				push(alerts, {
					id: 'ghost_shaper', severity: 'warning', title: 'Ghost Shaper Active',
					message: 'NPU HW offload is bypassing CAKE SQM. Offloaded flows skip bufferbloat management — latency protection is inactive under load.'
				});

			const rx_errors = dev ? iface_stat(dev, 'rx_errors') : 0;
			if (rx_errors > 0)
				push(alerts, {
					id: 'physical_bottleneck', severity: 'error', title: 'Physical Bottleneck',
					message: `Hardware errors detected on WAN (${rx_errors} rx_errors). Check WAN cable or SFP. Latency stats may be misleading.`
				});

			if (hw_offload) {
				const jit = readfile(JITTER_FILE);
				const m = jit ? match(jit, /"last_ping":([0-9.]+)/) : null;
				if (m && +m[1] > 60)
					push(alerts, {
						id: 'npu_bypass_latency', severity: 'warning', title: 'NPU Bypass Detected',
						message: `HW offload is enabled but ISP latency is high (${m[1]}ms). Latency management may be skipped by hardware acceleration.`
					});
			}

			return { alert_count: length(alerts), alerts };
		}
	},

	getEthStats: {
		call: function() {
			const ports = [];
			for (let iface in [ 'wan', 'lan1', 'lan2', 'lan3', 'lan4' ]) {
				if (stat(`/sys/class/net/${iface}`)?.type != 'directory')
					continue;
				let speed = read_num(`/sys/class/net/${iface}/speed`, 0);
				if (speed < 0) speed = 0;
				push(ports, {
					iface,
					up: (read_str(`/sys/class/net/${iface}/operstate`, 'unknown') == 'up'),
					speed,
					tx_bytes: iface_stat(iface, 'tx_bytes'),
					rx_bytes: iface_stat(iface, 'rx_bytes'),
					tx_errors: iface_stat(iface, 'tx_errors'),
					rx_errors: iface_stat(iface, 'rx_errors')
				});
			}
			return { ports };
		}
	}
};

return { 'luci.airoha_flowsense': methods };
