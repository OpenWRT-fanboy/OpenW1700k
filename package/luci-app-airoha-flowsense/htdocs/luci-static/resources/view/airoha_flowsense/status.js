'use strict';
'require view';
'require poll';
'require rpc';
'require ui';

/* ── Drop-delta tracking (all counters are cumulative since interface up) ── */
var _prevPseDrops    = null;
var _prevCdmHwfDrops = null;
var _prevBridgeDrops = null;
var _prevPpeBnd      = null;  // for tachometer heartbeat
var _prevBandBnd     = [null, null, null];  // per-WiFi-band BND, drives the HW-accel pulse
var _maxUnbSeen      = 8;     // UNB scale denominator — only grows, never shrinks
var _prevWifiRetry   = {};    // keyed by band_idx: {tx_packets, tx_retries}
var _maxWifiThroughput = 1000; // legacy; superseded by per-band maxMbps in bandInfo
var _prevEthBytes    = {};    // iface -> {tx, rx, time}
var _maxEthMbps      = {};    // iface -> peak Mbps seen; grows, never shrinks

/* ── RPC Declarations ── */
var callNpuStatus        = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getStatus' });
var callPpeEntries       = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getPpeEntries' });
var callTokenInfo        = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getTokenInfo' });
var callFrameEngine      = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getFrameEngine' });
var callTxStats          = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getTxStats' });
var callGetVlanOffload   = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getVlanOffload' });
var callSetVlanOffload   = rpc.declare({ object: 'luci.airoha_flowsense', method: 'setVlanOffload', params: ['enabled'] });
var callGetFlowOffload   = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getFlowOffload' });
var callSetFlowOffload   = rpc.declare({ object: 'luci.airoha_flowsense', method: 'setFlowOffload', params: ['enabled'] });
var callGetPppoeOffload      = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getPppoeOffload' });
var callSetPppoeOffload      = rpc.declare({ object: 'luci.airoha_flowsense', method: 'setPppoeOffload', params: ['enabled'] });
var callGetDeviceMode    = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getDeviceMode' });
var callGetNpuBypass     = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getNpuBypass' });
var callGetWanHealth     = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getWanHealth' });
var callGetJitterResult  = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getJitterResult' });
var callGetConflictAlerts= rpc.declare({ object: 'luci.airoha_flowsense', method: 'getConflictAlerts' });
var callGetWifiStats     = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getWifiStats' });
var callGetBridgeStats   = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getBridgeStats' });
var callGetEthStats      = rpc.declare({ object: 'luci.airoha_flowsense', method: 'getEthStats' });

/* ── Theme-adaptive CSS ── */
var themeCSS = '\
.soc-card{background:var(--soc-card-bg);border:1px solid var(--soc-border);border-radius:8px;padding:14px;transition:border-color .3s}\
.soc-card-accent{border-left-width:3px;border-left-style:solid}\
.soc-muted{color:var(--soc-muted)}\
.soc-text{color:var(--soc-text)}\
.soc-label{font-size:11px;color:var(--soc-muted)}\
.soc-bar-track{background:var(--soc-bar-track);border-radius:4px;overflow:hidden}\
.soc-pse-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px}\
.soc-pse-cell{background:var(--soc-card-bg);border:1px solid var(--soc-border);border-radius:5px;padding:6px 8px;font-size:12px}\
.soc-band-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px}\
.soc-gdm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px}\
.soc-cdm-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:10px}\
.compass-wrap{display:flex;flex-direction:row;align-items:flex-end;gap:2px;padding:4px 0;flex-wrap:wrap}\
.eth-gauge-wrap{display:flex;flex-direction:row;gap:8px;flex-wrap:wrap;margin-top:8px}\
.compass-svg-wrap{flex-shrink:0;max-width:326px;width:100%}\
.compass-cards{display:flex;flex-direction:row;gap:8px;flex-wrap:wrap;margin-top:12px;margin-bottom:4px}\
.compass-card{--soc-card-bg:#16181d;--soc-border:#333;--soc-muted:#999;--soc-text:#e0e0e0;background:var(--soc-card-bg);border:2px solid #222222;border-radius:9px;padding:10px 14px;flex:1;min-width:140px;box-shadow:inset 0 0 0 1px var(--soc-border)}\
.compass-card-title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--soc-muted);margin-bottom:4px;font-family:monospace}\
.compass-card-value{font-size:20px;font-weight:700;line-height:1.1;font-family:monospace}\
.compass-card-sub{font-size:11px;color:var(--soc-muted);margin-top:3px}\
.mode-banner{display:flex;align-items:center;gap:12px;padding:8px 14px;border-radius:6px;margin-bottom:8px;background:var(--soc-card-bg)}\
.mode-badge{font-size:11px;font-weight:700;letter-spacing:1px;padding:3px 10px;border-radius:3px;font-family:monospace}\
.mode-router{background:var(--badge-info-bg);color:var(--badge-info);border:1px solid var(--badge-info-bd)}\
.mode-ap{background:var(--badge-warn-bg);color:var(--badge-warn);border:1px solid var(--badge-warn-bd)}\
.offload-badge{font-size:13px;font-weight:700;letter-spacing:1px;padding:0 10px;border-radius:3px;font-family:monospace;display:inline-flex;align-items:center;align-self:stretch}\
.offload-on{background:var(--badge-on-bg);color:var(--badge-on);border:1px solid var(--badge-on-bd)}\
.offload-off{background:var(--badge-warn-bg);color:var(--badge-warn);border:1px solid var(--badge-warn-bd)}\
.alert-wrap{margin-bottom:8px}\
.alert-item{display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-radius:5px;margin-bottom:5px;font-size:13px}\
.alert-warning{border-left:3px solid #f5a623;background:rgba(245,166,35,0.1)}\
.alert-error{border-left:3px solid #d0021b;background:rgba(208,2,27,0.1)}\
.alert-icon{font-size:16px;line-height:1;flex-shrink:0;margin-top:1px}\
.alert-title{font-weight:600;margin-bottom:2px}\
.alert-msg{font-size:12px;color:var(--soc-muted)}\
@keyframes sqm-pulse{0%{opacity:0.2}50%{opacity:1}100%{opacity:0.2}}\
@keyframes hw-breathe{0%,100%{opacity:0.35}50%{opacity:0.7}}\
@keyframes ppe-blink{0%,100%{opacity:1}50%{opacity:0}}\
.ppe-terminal{background:#0c0c0c;border:1px solid #2a2a2a;border-radius:6px;overflow:hidden;display:flex;flex-direction:column;flex:1;min-width:220px}\
.ppe-terminal-bar{background:#1a1a1a;padding:5px 10px;display:flex;align-items:center;gap:5px;border-bottom:1px solid #2a2a2a;flex-shrink:0}\
.ppe-terminal-dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0}\
.ppe-terminal-title{color:#555;font-size:10px;margin-left:6px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\
.ppe-terminal-body{padding:8px 10px;overflow-y:auto;flex:1;font-size:10px;line-height:1.55;color:#ccc;font-family:"Courier New",Courier,monospace;white-space:pre-wrap;word-break:break-all;min-height:200px}\
.ppe-cursor{animation:ppe-blink 1s step-end infinite}\
';

function isDarkMode() {
	var els = [document.body, document.querySelector('.main-content'), document.querySelector('#maincontent'), document.querySelector('.cbi-map')];
	for (var i = 0; i < els.length; i++) {
		if (!els[i]) continue;
		var bg = window.getComputedStyle(els[i]).backgroundColor;
		var m = bg.match(/\d+/g);
		if (m && m.length >= 3) {
			var a = m.length >= 4 ? parseFloat(m[3]) : 1;
			if (a < 0.1) continue;
			var lum = (parseInt(m[0]) * 299 + parseInt(m[1]) * 587 + parseInt(m[2]) * 114) / 1000;
			return lum < 128;
		}
	}
	var sheets = document.querySelectorAll('link[href*="dark"], link[href*="glass"]');
	return sheets.length > 0;
}

var _lastDarkMode = null;

function injectCSS() {
	var el = document.getElementById('soc-theme-css');
	if (!el) { el = document.createElement('style'); el.id = 'soc-theme-css'; document.head.appendChild(el); }
	var dark = isDarkMode();
	if (dark === _lastDarkMode) return;
	_lastDarkMode = dark;
	var vars = dark
		? ':root{--soc-card-bg:#1e1e1e;--soc-border:#333;--soc-muted:#999;--soc-text:#e0e0e0;--soc-bar-track:#333;--soc-gauge:#fff;--soc-load:#ffe066;--badge-on:#00ff00;--badge-on-bg:rgba(0,255,0,.12);--badge-on-bd:rgba(0,255,0,.35);--badge-warn:#ffa000;--badge-warn-bg:rgba(255,160,0,.15);--badge-warn-bd:rgba(255,160,0,.35);--badge-info:#00c8ff;--badge-info-bg:rgba(0,200,255,.15);--badge-info-bd:rgba(0,200,255,.35)}'
		: ':root{--soc-card-bg:#fff;--soc-border:#d0d0d0;--soc-muted:#666;--soc-text:#222;--soc-bar-track:#e0e0e0;--soc-gauge:#222;--soc-load:#b58900;--badge-on:#16a34a;--badge-on-bg:rgba(22,163,74,.10);--badge-on-bd:rgba(22,163,74,.42);--badge-warn:#b45309;--badge-warn-bg:rgba(180,83,9,.10);--badge-warn-bd:rgba(180,83,9,.40);--badge-info:#0e7490;--badge-info-bg:rgba(14,116,144,.10);--badge-info-bd:rgba(14,116,144,.40)}';
	el.textContent = themeCSS + vars;
}

/* ── Instrument-face palette ──
 * The round gauges are a dark-console design (neon arcs, glow filters, faint
 * tick tracks) that only reads on a dark face. Rather than re-palette every
 * hardcoded neon for light mode, we keep the gauge faces dark in BOTH themes:
 * set these vars on each gauge <svg> root and the interior (which already draws
 * through var(--soc-*)) recolours to the dark values, while the page cards keep
 * their own theme-aware --soc-* untouched. Matches the fixed-dark PPE terminal. */
var GAUGE_VARS = '--soc-card-bg:#16181d;--soc-border:#333;--soc-text:#e0e0e0;--soc-muted:#999;--soc-gauge:#fff;--soc-load:#ffe066';

/* ── Existing Helpers ── */
var bandInfo = [
	{ name: '2.4 GHz', accent: 'var(--soc-gauge)', rtyCol: '#EFBF04', gaugeCol: '#EFBF04', maxMbps: 688,   sMax: 700,   sStep: 100,  sDiv: 100,  sCap: '×100 MBPS'  },
	{ name: '5 GHz',   accent: 'var(--soc-gauge)', rtyCol: '#305CDE', gaugeCol: '#4d7cff', maxMbps: 5765,  sMax: 6000,  sStep: 1000, sDiv: 1000, sCap: '×1000 MBPS' },
	{ name: '6 GHz',   accent: 'var(--soc-gauge)', rtyCol: '#2CFF05', gaugeCol: '#2CFF05', maxMbps: 11529, sMax: 12000, sStep: 2000, sDiv: 1000, sCap: '×1000 MBPS' }
];


function fmtFreq(khz) { return (!khz || khz === 0) ? 'N/A' : (khz / 1000).toFixed(0) + ' MHz'; }
function fmtK(n) {
	if (!n || n === 0) return '0';
	if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return n.toString();
}

function calcTotalMem(regions) {
	var t = 0;
	(regions || []).forEach(function(r) {
		var m = (r.size || '').match(/(\d+)\s*(KiB|MiB|GiB)/i);
		if (m) { var s = parseInt(m[1]); var u = m[2][0].toUpperCase(); t += u === 'G' ? s*1048576 : u === 'M' ? s*1024 : s; }
	});
	return t >= 1024 ? (t/1024).toFixed(0)+' MiB' : t+' KiB';
}

function pleHealth(free) {
	if (typeof free !== 'number' || free < 0) return { text: 'N/A', color: '#888' };
	if (free >= 1000000) return { text: 'OK',   color: '#4caf50' };
	if (free >=  100000) return { text: 'WARN', color: '#ff9800' };
	return { text: 'CRIT', color: '#f44336' };
}

function formatPleCount(free) {
	if (typeof free !== 'number' || free < 0) return '—';
	if (free >= 1000000) return (free/1000000).toFixed(1) + 'M';
	if (free >= 1000)    return Math.round(free/1000) + 'K';
	return free + '';
}

function getBandStats(ti, b) {
	var c = Array.isArray(ti.station_counts) ? ti.station_counts : [];
	for (var i=0;i<c.length;i++) if (c[i].band===b) return c[i];
	return { band:b, count:0, tx_packets:0, tx_retries:0 };
}

var _prevBandStats = [null, null, null];

function getBandDelta(current, band) {
	var prev = _prevBandStats[band];
	_prevBandStats[band] = { tx_packets: current.tx_packets || 0, tx_retries: current.tx_retries || 0 };
	if (!prev) return { band: band, count: current.count || 0, tx_packets: 0, tx_retries: 0 };
	var dp = (current.tx_packets || 0) - prev.tx_packets;
	var dr = (current.tx_retries || 0) - prev.tx_retries;
	if (dp < 0) dp = current.tx_packets || 0;
	if (dr < 0) dr = current.tx_retries || 0;
	return { band: band, count: current.count || 0, tx_packets: dp, tx_retries: dr };
}

function getTxQueue(ti, b) {
	var q = Array.isArray(ti.tx_queues) ? ti.tx_queues : [];
	for (var i=0;i<q.length;i++) if (q[i].band===b) return q[i];
	return null;
}

function bandHealth(s) {
	if (!s || s.count===0) return { text:'No clients', color:'#888' };
	if (!s.tx_packets) return { text:'Idle', color:'#888' };
	var r = (s.retry_pct || 0) / 100;
	return r>0.5 ? {text:'Poor',color:'#f44336'} : r>0.2 ? {text:'Fair',color:'#ff9800'} : {text:'Good',color:'#4caf50'};
}

function retryPct(s) {
	if (!s || !s.tx_packets) return '-';
	// retry_pct now carries the real per-band Tx PER (per-MPDU hardware metric).
	return (s.retry_pct || 0) + '%';
}

function getTxStatsBand(txs, band) {
	var bands = txs && Array.isArray(txs.bands) ? txs.bands : [];
	for (var i = 0; i < bands.length; i++) if (bands[i].band === band) return bands[i];
	return null;
}

function perColor(per) { return per > 15 ? '#f44336' : per > 5 ? '#ff9800' : '#4caf50'; }

function renderBandChip(band, txQ, stats, txs) {
	var info = bandInfo[band] || { name: 'Band '+band, accent: '#888' };
	var id = 'band-'+band;
	var h = bandHealth(stats);
	var type = txQ ? txQ.type : '?';
	var rp = retryPct(stats);
	var rows = [
		E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' }, [
			E('span', { 'class': 'soc-text', 'style': 'font-size:13px;font-weight:bold' }, info.name),
			E('span', { 'style': 'background:'+(type==='npu'?'#1565c0':'#666')+';color:#fff;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:600' }, type.toUpperCase())
		]),
		E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;font-size:12px' }, [
			E('div', { 'id': id+'-health', 'style': 'display:flex;align-items:center;gap:4px' }, [
				E('span', { 'style': 'width:7px;height:7px;border-radius:50%;background:'+h.color+';display:inline-block' }),
				E('span', { 'style': 'color:'+h.color+';font-weight:500' }, h.text)
			]),
			E('span', { 'id': id+'-clients', 'class': 'soc-muted' }, stats.count + ' sta'),
			(stats.tx_packets > 0) ? E('span', { 'id': id+'-retries', 'class': 'soc-muted' }, rp) : E('span')
		])
	];
	rows.push(E('div', { 'id': id+'-txstats', 'style': 'display:flex;gap:10px;font-size:11px;margin-top:5px;padding-top:4px;border-top:1px solid var(--soc-border)' },
		(txs && txs.attempts > 0) ? [
			E('span', { 'class': 'soc-muted' }, 'Drop:'),
			E('span', { 'style': 'color:'+(txs.drops > 0 ? '#f44336' : '#4caf50') }, fmtK(txs.drops)),
			E('span', { 'style': 'color:'+perColor(txs.per) }, txs.per+'%')
		] : [ E('span', { 'class': 'soc-muted' }, 'Drop: -') ]
	));
	return E('div', { 'id': id, 'style': 'background:var(--soc-card-bg);border:1px solid var(--soc-border);border-left:2px solid '+info.accent+';border-radius:6px;padding:10px 12px' }, rows);
}

function updateBandChip(band, stats) {
	var id = 'band-'+band, h = bandHealth(stats);
	var el = document.getElementById(id+'-health');
	if (el) { el.innerHTML = ''; el.appendChild(E('span',{'style':'width:6px;height:6px;border-radius:50%;background:'+h.color+';display:inline-block'})); el.appendChild(E('span',{'style':'color:'+h.color+';font-weight:500;font-size:11px'},h.text)); }
	var cl = document.getElementById(id+'-clients'); if (cl) cl.textContent = stats.count+'sta';
	var re = document.getElementById(id+'-retries'); if (re) re.textContent = retryPct(stats);
}

/* ── CPU Frequency State (used by CPU/NPU tachometer) ── */
function freqBarState(hw, min, max, pll, gov) {
	var pll_khz = (pll || 0) * 1000;
	// cpufreq sysfs missing (e.g. AN7581 broken DVFS) — fall back to PLL hardware read
	if (!hw && pll_khz > 0)
		return { freq: pll_khz, max: pll_khz, oc: false };
	var oc = gov==='performance' && pll>0 && pll_khz>max;
	return { freq: oc ? pll_khz : Math.min(hw,max), max: oc ? pll_khz : max, oc: oc };
}






function renderVlanOffloadSelect(enabled) {
	var cur = enabled ? '1' : '0';
	return E('select', { 'id': 'vlan-offload-select', 'class': 'cbi-input-select', 'style': 'min-width:140px', 'change': function(ev) {
		var v = parseInt(ev.target.value);
		ev.target.disabled = true;
		callSetVlanOffload(v).then(function(r) {
			ev.target.disabled = false;
			if (r && r.error) ui.addNotification(null, E('p', {}, _('Error: ') + r.error), 'error');
		}).catch(function() { ev.target.disabled = false; });
	}}, [
		E('option', { 'value': '0', 'selected': cur === '0' ? '' : null }, _('Disabled')),
		E('option', { 'value': '1', 'selected': cur === '1' ? '' : null }, _('Enabled'))
	]);
}

function renderFlowOffloadSelect(enabled) {
	var cur = enabled ? '1' : '0';
	return E('select', { 'id': 'flow-offload-select', 'class': 'cbi-input-select', 'style': 'min-width:140px', 'change': function(ev) {
		var v = parseInt(ev.target.value);
		ev.target.disabled = true;
		callSetFlowOffload(v).then(function(r) {
			ev.target.disabled = false;
			if (r && r.error) ui.addNotification(null, E('p', {}, _('Error: ') + r.error), 'error');
		}).catch(function() { ev.target.disabled = false; });
	}}, [
		E('option', { 'value': '0', 'selected': cur === '0' ? '' : null }, _('Disabled')),
		E('option', { 'value': '1', 'selected': cur === '1' ? '' : null }, _('Enabled'))
	]);
}

function renderPppoeOffloadSelect(enabled) {
	var cur = enabled ? '1' : '0';
	return E('select', { 'id': 'pppoe-offload-select', 'class': 'cbi-input-select', 'style': 'min-width:140px', 'change': function(ev) {
		var v = parseInt(ev.target.value);
		ev.target.disabled = true;
		callSetPppoeOffload(v).then(function(r) {
			ev.target.disabled = false;
			if (r && r.error) ui.addNotification(null, E('p', {}, _('Error: ') + r.error), 'error');
		}).catch(function() { ev.target.disabled = false; });
	}}, [
		E('option', { 'value': '0', 'selected': cur === '0' ? '' : null }, _('Disabled')),
		E('option', { 'value': '1', 'selected': cur === '1' ? '' : null }, _('Enabled'))
	]);
}

/* ── PPE Panels ── */
function renderPpePanel(label, labelColor, stateLabel, stateClass, entries, total, showNew) {
	var rows = [
		E('tr', { 'class': 'tr cbi-section-table-titles' }, [
			E('th', { 'class': 'th', 'style': 'width:55px' }, _('Index')),
			E('th', { 'class': 'th', 'style': 'width:45px' }, _('State')),
			E('th', { 'class': 'th', 'style': 'width:65px' }, _('Type')),
			E('th', { 'class': 'th' }, _('Original'))
		].concat(showNew ? [ E('th', { 'class': 'th' }, _('Translated')) ] : []))
	];

	(entries || []).forEach(function(e) {
		rows.push(E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td', 'style': 'font-size:11px;font-family:monospace' }, e.index||'-'),
			E('td', { 'class': 'td' }, E('span', { 'class': stateClass, 'style': 'font-size:10px' }, stateLabel)),
			E('td', { 'class': 'td', 'style': 'font-size:11px' }, (e.type||'').trim()),
			E('td', { 'class': 'td', 'style': 'font-size:11px;font-family:monospace;word-break:break-all' }, e.orig||'-')
		].concat(showNew ? [
			E('td', { 'class': 'td', 'style': 'font-size:11px;font-family:monospace;word-break:break-all' }, e.new_flow||'-')
		] : [])));
	});

	if (!entries || entries.length === 0) {
		rows.push(E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td soc-muted', 'colspan': showNew ? '5' : '4', 'style': 'text-align:center;padding:12px' }, _('No entries'))
		]));
	}

	var countText = total + ' entries' + (total > 25 ? ' (showing 25)' : '');
	return E('div', { 'style': 'flex:1;min-width:0' }, [
		E('div', { 'style': 'display:flex;align-items:baseline;gap:8px;margin-bottom:6px' }, [
			E('span', { 'style': 'font-weight:700;font-size:13px;color:'+labelColor }, label),
			E('span', { 'class': 'soc-muted', 'style': 'font-size:11px', 'id': 'ppe-count-'+(showNew?'bnd':'unb') }, countText)
		]),
		E('div', { 'style': 'overflow-x:auto' }, [
			E('table', { 'class': 'table', 'id': 'ppe-table-'+(showNew?'bnd':'unb'), 'style': 'font-size:11px' }, rows)
		])
	]);
}

function renderPpePanels(ppe) {
	var bnd = ppe.bnd || { total: 0, entries: [] };
	var unb = ppe.unb || { total: 0, entries: [] };
	return E('div', { 'style': 'display:flex;gap:16px;align-items:flex-start' }, [
		renderPpePanel('BND — Hardware Offloaded', '#00c8ff', 'BND', 'label-success', bnd.entries, bnd.total, true),
		renderPpePanel('UNB — Pending / Learning', '#4caf50', 'UNB', '', unb.entries, unb.total, false)
	]);
}

function updatePpePanels(ppe) {
	var bnd = ppe.bnd || { total: 0, entries: [] };
	var unb = ppe.unb || { total: 0, entries: [] };

	function refreshPanel(tableId, countId, entries, total, showNew, stateLabel, stateClass) {
		var el = document.getElementById(countId);
		if (el) el.textContent = total + ' entries' + (total > 25 ? ' (showing 25)' : '');
		var tb = document.getElementById(tableId);
		if (!tb) return;
		while (tb.rows.length > 1) tb.deleteRow(1);
		if (!entries || entries.length === 0) {
			var row = tb.insertRow(-1); row.className = 'tr';
			var cell = row.insertCell(-1); cell.className = 'td soc-muted';
			cell.colSpan = showNew ? 5 : 4;
			cell.style.textAlign = 'center'; cell.style.padding = '12px';
			cell.textContent = 'No entries';
			return;
		}
		entries.forEach(function(e) {
			var row = tb.insertRow(-1); row.className = 'tr';
			var c1 = row.insertCell(-1); c1.className='td'; c1.style='font-size:11px;font-family:monospace'; c1.textContent=e.index||'-';
			var c2 = row.insertCell(-1); c2.className='td';
			var badge = document.createElement('span');
			if (stateClass) badge.className = stateClass;
			badge.style.fontSize = '10px';
			badge.textContent = stateLabel;
			c2.appendChild(badge);
			var c3 = row.insertCell(-1); c3.className='td'; c3.style='font-size:11px'; c3.textContent=(e.type||'').trim();
			var c4 = row.insertCell(-1); c4.className='td'; c4.style='font-size:11px;font-family:monospace;word-break:break-all'; c4.textContent=e.orig||'-';
			if (showNew) { var c5=row.insertCell(-1); c5.className='td'; c5.style='font-size:11px;font-family:monospace;word-break:break-all'; c5.textContent=e.new_flow||'-'; }
		});
	}

	refreshPanel('ppe-table-bnd', 'ppe-count-bnd', bnd.entries, bnd.total, true, 'BND', 'label-success');
	refreshPanel('ppe-table-unb', 'ppe-count-unb', unb.entries, unb.total, false, 'UNB', '');
}

/* ── PPE Tachometer (embedded inside compass inner fill) ── */
function buildTachoInner(ppe, cs, mode) {
	var bnd    = ppe.bnd || {};
	var unb    = ppe.unb || {};
	var bndTot = bnd.total || 0;
	var unbTot = unb.total || 0;
	var n4     = bnd.ipv4  || 0;
	var n6     = bnd.ipv6  || 0;

	// Heartbeat: fires once when new BND flows arrive this poll
	var pulsing = (_prevPpeBnd !== null && bndTot > _prevPpeBnd);
	_prevPpeBnd = bndTot;

	var total  = bndTot + unbTot;
	var offPct = total > 0 ? Math.round(bndTot / total * 100) : (cs.npuActive ? 100 : 0);

	var modeText   = mode === 'ap' ? 'AP MODE' : 'ROUTER';
	var statusText = cs.npuActive ? 'HW ACCELERATED' : (cs.hwEnabled ? 'NPU IDLE' : 'CPU PATH');
	var statusCol  = cs.npuActive ? '#00c8ff' : (cs.hwEnabled ? '#888' : '#ff6b35');
	var bndColor   = bndTot > 0 ? '#00c8ff' : 'var(--soc-muted)';
	var unbColor   = unbTot > 0 ? '#ff9800' : 'var(--soc-muted)';

	// CPU-gauge-style lit-fill sweep, scaled to fit inside the compass quadrant arcs (r<=90).
	// Sweep = offload % (BND / total) — a 0-100 fill that encodes the BND/UNB balance;
	// big BND count centre-stage; UNB + v4/v6 as sub-lines. No needle (matches CPU gauge).
	var max = 100;
	var CX = 150, CY = 150, TH0 = 150, TH1 = 390, SWEEP = 240;
	function pt(r, deg) { var a = deg * Math.PI / 180; return [CX + r * Math.cos(a), CY + r * Math.sin(a)]; }
	function theta(v) { return TH0 + (Math.max(0, Math.min(max, v)) / max) * SWEEP; }
	function arcPoly(r, dA, dB, steps) {
		var s = '', k, d, q;
		for (k = 0; k <= steps; k++) { d = dA + (dB - dA) * k / steps; q = pt(r, d); s += (k ? 'L' : '') + q[0].toFixed(2) + ' ' + q[1].toFixed(2) + ' '; }
		return s;
	}
	var p = [];

	// dim track + lit value arc (cyan) — the offload fill
	p.push('<path d="M ' + arcPoly(72, TH0, TH1, 60) + '" fill="none" stroke="#31363f" stroke-width="3.5" stroke-linecap="round"/>');
	if (offPct > 0) p.push('<path d="M ' + arcPoly(72, TH0, theta(offPct), 60) + '" fill="none" stroke="#00c8ff" stroke-width="4" stroke-linecap="round" filter="url(#f-tn4)"/>');

	// lit-fill ticks (cyan up to offload %), r=76-86
	var step = 20, minor = step / 5;
	for (var v = 0; v <= max + 0.5; v += minor) {
		var major = (Math.round(v) % step === 0), th = theta(v), lit = v <= offPct + 0.001;
		var o = pt(86, th), inn = pt(major ? 76 : 81, th);
		p.push('<line x1="' + o[0].toFixed(1) + '" y1="' + o[1].toFixed(1) + '" x2="' + inn[0].toFixed(1) + '" y2="' + inn[1].toFixed(1) + '" stroke="' + (lit ? '#00c8ff' : '#3a3f47') + '" stroke-width="' + (major ? 2.2 : 1.2) + '" stroke-linecap="round" opacity="' + (lit ? 1 : 0.5) + '"/>');
	}
	p.push('<text x="150" y="205" text-anchor="middle" font-family="monospace" font-size="7" letter-spacing="1" fill="var(--soc-muted)">' + offPct + '% OFFLOAD</text>');

	// heartbeat pulse when new BND flows arrive
	if (pulsing) p.push('<circle cx="150" cy="150" r="64" fill="none" stroke="#00c8ff" stroke-width="2" opacity="0.6" style="animation:sqm-pulse 1.2s ease-out forwards"/>');

	// centre readout: mode + status, big BND count centre-stage, UNB + v4/v6 below
	p.push('<text x="150" y="116" text-anchor="middle" fill="var(--soc-text)" font-size="9" font-weight="700" font-family="monospace" letter-spacing="2">' + modeText + '</text>');
	p.push('<text x="150" y="127" text-anchor="middle" fill="' + statusCol + '" font-size="7" font-family="monospace" letter-spacing="1">' + statusText + '</text>');
	p.push('<text x="150" y="159" text-anchor="middle" fill="' + bndColor + '" font-size="30" font-weight="700" font-family="monospace" filter="url(#f-tn4)">' + bndTot + '</text>');
	p.push('<text x="150" y="171" text-anchor="middle" fill="var(--soc-muted)" font-size="7" font-family="monospace" letter-spacing="2">BND FLOWS</text>');
	p.push('<text x="150" y="187" text-anchor="middle" fill="' + unbColor + '" font-size="12" font-weight="700" font-family="monospace">' + unbTot + ' <tspan font-size="7" fill="var(--soc-muted)">UNB</tspan></text>');
	p.push('<text x="120" y="146" text-anchor="middle" fill="#00c8ff" font-size="7.5" font-family="monospace">v4:' + n4 + '</text>');
	p.push('<text x="180" y="146" text-anchor="middle" fill="#9c27b0" font-size="7.5" font-family="monospace">v6:' + n6 + '</text>');

	return p.join('');
}

/* ── PPE Terminal Panel ── */
function buildPpeTerminalBody(ppe) {
	var bnd = ppe.bnd || {}, unb = ppe.unb || {};
	var bndTot = bnd.total || 0, unbTot = unb.total || 0;
	var bndE = bnd.entries || [], unbE = unb.entries || [];

	var grn  = 'color:#55ff55';
	var wht  = 'color:#e0e0e0';
	var dim  = 'color:#555';
	var sep  = 'color:#333';
	var mute = 'color:#666';
	var cyn  = 'color:#00c8ff';
	var org  = 'color:#ff9800';
	var pur  = 'color:#9c27b0';
	var grey = 'color:#999';

	function sp(style, text) { return '<span style="'+style+'">'+text+'</span>'; }
	function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
	// pad: pads or truncates plain string to exactly n chars, then HTML-escapes
	function pad(s, n) {
		s = s || '';
		if (s.length > n) return esc(s.substring(0, n-1)) + '\u2026';
		var out = esc(s);
		for (var i = s.length; i < n; i++) out += ' ';
		return out;
	}

	// Column widths (chars)
	var W = { idx: 6, state: 6, type: 9, orig: 45, flow: 45, eth: 37 };
	var lineLen = W.idx+2+W.state+2+W.type+2+W.orig+2+W.flow+2+W.eth;
	var divLine = '\u2500'.repeat(lineLen);

	function hdrRow() {
		return sp(mute,
			pad('Index',W.idx)+'  '+pad('State',W.state)+'  '+pad('Type',W.type)+'  '+
			pad('Original Flow',W.orig)+'  '+pad('New Flow',W.flow)+'  '+'Ethernet'
		) + '\n';
	}

	function entryRow(e, origCol) {
		var typeStr = (e.type||'') + (e.proto ? ' '+e.proto : '');
		var isV6 = (e.type||'').indexOf('IPv6') >= 0;
		var ipCol = isV6 ? pur : grey;
		var stCol = (e.state === 'BND' || e.state === 'BIND') ? cyn : org;
		return sp(dim,     pad(e.index||'????', W.idx))    + '  ' +
		       sp(stCol,   pad(e.state||'',     W.state))  + '  ' +
		       sp(ipCol,   pad(typeStr,          W.type))   + '  ' +
		       sp(origCol, pad(e.orig||'',       W.orig))   + '  ' +
		       sp(mute,    pad(e.new_flow||'-',  W.flow))   + '  ' +
		       sp(grey,    esc(e.eth||'-')) + '\n';
	}

	var s = '';

	// Prompt + command
	s += sp(grn,'root@OpenWrt') + sp(mute,':~# ') + sp(wht,'ppe status --watch') + '\n\n';

	// CLIENTS section — per-WiFi-client offload: how many bound (hardware-offloaded)
	// PPE flows carry each associated station's MAC. Sourced from bnd.client_bnd
	// (backend matches station MACs from `iw station dump` against eth= in the bind
	// table); self-filters to WiFi clients. Each direction is its own HW slot.
	var clients = (bnd.client_bnd && Array.isArray(bnd.client_bnd)) ? bnd.client_bnd.slice() : [];
	var bandLbl = ['2.4 GHz', '5 GHz', '6 GHz'];
	clients.sort(function(a, b) { return (b.bnd || 0) - (a.bnd || 0); });
	var offCount = 0, maxBnd = 0;
	clients.forEach(function(c) { if ((c.bnd || 0) > 0) offCount++; if ((c.bnd || 0) > maxBnd) maxBnd = c.bnd || 0; });

	s += sp(cyn, '■ CLIENTS') + '  ' + sp(wht, offCount + ' offloaded') +
	     '  ' + sp(mute, '(' + clients.length + ' assoc)') + '\n';
	s += sp(sep, divLine) + '\n';
	if (clients.length === 0) {
		s += sp(mute, '  no wifi clients') + '\n';
	} else {
		var CW = { name: 20, mac: 19, band: 9, bnd: 7 };
		s += sp(mute, pad('Client', CW.name) + '  ' + pad('MAC', CW.mac) + '  ' + pad('Band', CW.band) + '  ' + pad('Bound', CW.bnd) + '  ') + '\n';
		clients.forEach(function(c) {
			var n = c.bnd || 0;
			var barLen = maxBnd > 0 ? Math.round((n / maxBnd) * 20) : 0;
			var cCol = n > 0 ? cyn : dim;
			var nameStr = c.host || c.ip || '—';
			s += sp(wht, pad(nameStr, CW.name)) + '  ' +
			     sp(grey, pad(c.mac || '?', CW.mac)) + '  ' +
			     sp(mute, pad(bandLbl[c.band] || ('band' + c.band), CW.band)) + '  ' +
			     sp(cCol, pad(String(n), CW.bnd)) + '  ' +
			     sp(cCol, '█'.repeat(barLen)) + '\n';
		});
	}
	s += '\n';

	// BND section
	s += sp(cyn,'■ BND') + '  ' + sp(wht, bndTot+' flows');
	s += '  ' + sp(mute,'(v4:'+(bnd.ipv4||0)+' v6:'+(bnd.ipv6||0)+')') + '\n';
	s += sp(sep, divLine) + '\n';

	if (bndTot === 0) {
		s += sp(mute,'  no entries') + '\n';
	} else {
		s += hdrRow();
		s += sp(sep, divLine) + '\n';
		bndE.forEach(function(e) { s += entryRow(e, cyn); });
		if (bndTot > bndE.length) s += sp(mute,'  +' + (bndTot - bndE.length) + ' more\n');
	}

	s += '\n';

	// UNB section
	s += sp(org,'■ UNB') + '  ' + sp(wht, unbTot+' flows') + '\n';
	s += sp(sep, divLine) + '\n';

	if (unbTot === 0) {
		s += sp(mute,'  no entries') + '\n';
	} else {
		s += hdrRow();
		s += sp(sep, divLine) + '\n';
		unbE.forEach(function(e) { s += entryRow(e, org); });
		if (unbTot > unbE.length) s += sp(mute,'  +' + (unbTot - unbE.length) + ' more\n');
	}

	s += '\n';
	s += sp(grn,'root@OpenWrt') + sp(mute,':~# ') + '<span class="ppe-cursor" style="'+wht+'">▌</span>';
	return s;
}

function renderPpeTerminal(ppe) {
	var bar = E('div', { 'class': 'ppe-terminal-bar' }, [
		E('span', { 'class': 'ppe-terminal-title' }, 'ppe_monitor  —  root@OpenWrt:~')
	]);
	var body = E('div', { 'class': 'ppe-terminal-body', 'id': 'ppe-terminal-body' });
	body.innerHTML = buildPpeTerminalBody(ppe);
	return E('div', { 'class': 'ppe-terminal' }, [ bar, body ]);
}

/* ── Compass Math ── */
function arcPt(cx, cy, r, deg) {
	var rad = deg * Math.PI / 180;
	return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx, cy, r, startDeg, endDeg) {
	var s = arcPt(cx, cy, r, startDeg);
	var e = arcPt(cx, cy, r, endDeg);
	var span = endDeg - startDeg;
	if (span < 0) span += 360;
	var large = span > 180 ? 1 : 0;
	return 'M '+s[0].toFixed(1)+' '+s[1].toFixed(1)+
	       ' A '+r+' '+r+' 0 '+large+' 1 '+
	       e[0].toFixed(1)+' '+e[1].toFixed(1);
}

function needleTip(latencyMs) {
	// Jitter/latency PENDULUM hanging below the centre readout. Pivot (150,216), length 32;
	// swings left (0ms, good) → right (100ms, bad) on a log scale so low latency is sensitive.
	var clamped = Math.min(Math.max(latencyMs||0, 0), 100);
	var logPct = Math.log(clamped + 1) / Math.log(101); // 0→0, 100ms→1
	var d = (-50 + logPct * 100) * Math.PI / 180;        // -50° (left) .. +50° (right) from vertical
	return [150 + 32 * Math.sin(d), 224 + 32 * Math.cos(d)];
}

function latencyColor(ms) {
	if (ms <= 20) return '#00cc44';
	if (ms <= 60) return '#f5a623';
	return '#d0021b';
}

/* ── Mode Banner ── */
function renderModeBanner(dm) {
	var mode = dm.mode || 'router';
	var reason = dm.reason || '';
	var reasonMap = { dhcp_disabled: 'DHCP disabled in UCI', no_wan: 'No WAN IP detected', local_gateway: 'Local gateway detected' };
	var reasonText = reasonMap[reason] || '';
	return E('div', { 'class': 'mode-banner' }, [
		E('span', { 'class': 'mode-badge ' + (mode==='ap' ? 'mode-ap' : 'mode-router') },
			mode === 'ap' ? 'AP MODE' : 'ROUTER MODE'),
		E('span', { 'class': 'soc-muted', 'style': 'font-size:12px' }, 'Auto-detected' + (reasonText ? ' \u2014 '+reasonText : '')),
		E('span', { 'id': 'mode-banner-status', 'style': 'margin-left:auto;font-size:12px;color:var(--soc-muted)' }, '')
	]);
}

/* ── Conflict Alerts ── */
function renderConflictAlerts(alertData) {
	var alerts = (alertData && Array.isArray(alertData.alerts)) ? alertData.alerts : [];
	if (!alerts.length) return E('div', { 'id': 'conflict-alerts' });
	var items = alerts.map(function(a) {
		var isErr = a.severity === 'error';
		return E('div', { 'class': 'alert-item ' + (isErr ? 'alert-error' : 'alert-warning') }, [
			E('span', { 'class': 'alert-icon' }, isErr ? '\u26A0' : '\u26A1'),
			E('div', {}, [
				E('div', { 'class': 'alert-title' }, a.title || ''),
				E('div', { 'class': 'alert-msg' }, a.message || '')
			])
		]);
	});
	return E('div', { 'id': 'conflict-alerts', 'class': 'alert-wrap' }, items);
}

/* ── HW Buffer Health (replaces SQM — NPU traffic bypasses qdisc entirely) ── */
function hwBufferState(fe, ppe, mode) {
	fe = fe || {}; ppe = ppe || {}; mode = mode || 'router';

	// PSE port drops: cumulative across all internal ports (0-9).
	// These include CDM/PPE internal paths that drop normally — not a reliable
	// congestion signal on their own. Track for display only.
	var ports = Array.isArray(fe.pse_ports) ? fe.pse_ports : [];
	var pseDrops = 0;
	ports.forEach(function(p) { pseDrops += (p.drops || 0); });

	// CDM HW-forwarding drops — frames the NPU forwarded that CDM couldn't accept.
	// More sensitive than GDM TX drops (which only fire at wire-level jam) and
	// directly reflects NPU path congestion.
	var cdmHwfDrops = ((fe.cdm1||{}).rx_hwf_drop||0) + ((fe.cdm2||{}).rx_hwf_drop||0);

	// Delta since last poll — null on first call (baseline only, no alarm)
	var pseDelta    = (_prevPseDrops    !== null && pseDrops    >= _prevPseDrops)    ? (pseDrops    - _prevPseDrops)    : 0;
	var cdmHwfDelta = (_prevCdmHwfDrops !== null && cdmHwfDrops >= _prevCdmHwfDrops) ? (cdmHwfDrops - _prevCdmHwfDrops) : 0;
	_prevPseDrops    = pseDrops;
	_prevCdmHwfDrops = cdmHwfDrops;

	// DROPPING on CDM HW-forwarding drops or very high PSE bursts (>200/poll).
	var activeDrop = cdmHwfDelta > 0 || pseDelta > 200;

	// PPE offload efficiency — BND/(BND+UNB). Shown in subtitle for info only.
	// LOW OFFLOAD state removed: low BND% when idle is expected, not a problem.
	var ppeBound = (ppe.bnd || {}).total || 0;
	var ppeUnb   = (ppe.unb || {}).total || 0;
	var ppeTotal = ppeBound + ppeUnb;
	var ppePct   = ppeTotal > 0 ? Math.round(ppeBound / ppeTotal * 100) : 0;

	var color = activeDrop ? '#f5a623' : '#00cc44';
	return {
		pseDrops: pseDrops, cdmHwfDrops: cdmHwfDrops, pseDelta: pseDelta, cdmHwfDelta: cdmHwfDelta,
		activeDrop: activeDrop,
		ppeBound: ppeBound, ppeTotal: ppeTotal, ppePct: ppePct,
		color: color, pulsing: activeDrop
	};
}

/* ── Compass SVG ── */
function compassState(bypass, hwBuf, jitter, wan, wifi, bridge, mode) {
	bypass = bypass || {}; hwBuf = hwBuf || {}; jitter = jitter || {};
	wan = wan || {}; wifi = wifi || {}; bridge = bridge || {};

	var npuActive = bypass.npu_active  === true;
	var hwEnabled = bypass.hw_offload_enabled === true;
	var cpuPct    = bypass.cpu_pct  || 0;
	var wanMbps   = bypass.wan_mbps || 0;

	// Latency — jitter daemon pings upstream and works in both router and AP mode
	var latMs = jitter.last_ping || 0;

	// Integrity / errors
	var errCount = 0;
	var eastAlarm = false;
	var worstSignal = 0;  // dBm — 0 means no data; always negative when valid
	// wbDelta holds per-band signal data; stored in cs so both render paths share it.
	var wbDelta = [];
	if (mode === 'router') {
		errCount = (wan.rx_errors||0) + (wan.tx_errors||0);
		eastAlarm = errCount > 0;
	} else {
		// AP mode: use per-station RSSI from iw station dump (signal avg field).
		// min_signal = worst (lowest dBm) station on that band — most meaningful
		// for link integrity since one weak client degrades the whole band's airtime.
		(wifi.bands||[]).filter(function(b){ return (b.stations||0) > 0; }).forEach(function(b) {
			var sig = b.min_signal || 0;
			wbDelta.push({ band: b.band, stations: b.stations, signal: sig, avg_signal: b.avg_signal || 0 });
			if (sig !== 0 && (worstSignal === 0 || sig < worstSignal)) worstSignal = sig;
		});
		// Alarm thresholds: < -75 dBm = weak link, < -82 dBm = poor link
		eastAlarm = worstSignal !== 0 && worstSignal < -75;
	}

	var eastColor;
	if (mode === 'router') {
		eastColor = eastAlarm ? '#d0021b' : '#00cc44';
	} else {
		eastColor = worstSignal === 0 ? '#888'
		          : worstSignal < -82  ? '#d0021b'
		          : worstSignal < -75  ? '#f5a623'
		          :                      '#00cc44';
	}
	return {
		npuActive:npuActive, hwEnabled:hwEnabled, cpuPct:cpuPct, wanMbps:wanMbps,
		hwBuf:hwBuf, mode:mode,
		latMs:latMs, errCount:errCount, eastAlarm:eastAlarm,
		wbDelta:wbDelta, worstSignal:worstSignal,
		latColor:latencyColor(latMs),
		eastColor: eastColor
	};
}

function buildCompassSVG(cs, mode, ppe) {
	var cx=150, cy=150;
	var npuOpacity  = cs.npuActive ? '1'    : cs.hwEnabled ? '0.45' : '0.2';
	var cpuOpacity  = !cs.hwEnabled ? '1'   : cs.npuActive ? '0.2'  : '0.45';
	var npuGlow     = cs.npuActive  ? ' filter="url(#f-cyan)"'   : '';
	var cpuGlow     = !cs.hwEnabled ? ' filter="url(#f-orange)"' : '';
	var eastOpacity = cs.eastAlarm ? '1' : '0.45';
	var eastGlow    = cs.eastAlarm ? ' filter="url(#f-red)"'  : '';
	var southOpacity= cs.hwBuf.pulsing ? '1' : '0.45';
	var southAnim   = cs.hwBuf.pulsing ? ' style="animation:sqm-pulse 1.5s ease-in-out infinite"' : '';
	var tip = needleTip(cs.latMs);
	var ppeRing = _cnPpeRingStyle(ppe);

	// Arc paths
	var pNpuOuter = arcPath(cx,cy,132, 210,330);
	var pNpuInner = arcPath(cx,cy,118, 210,330);
	var pEast     = arcPath(cx,cy,126, 300, 60);
	var pSouth    = arcPath(cx,cy,126,  30,150);
	var pWest     = arcPath(cx,cy,126, 120,240);

	// Text label paths (pre-computed at r=140 for north, r=138 for others)
	// North CW 215→325: text curves along top, reads L→R
	var tpN = 'M 35.3 69.7 A 140 140 0 0 1 264.7 69.7';
	// South CCW 150→30: text curves along bottom, reads L→R
	var tpS = 'M 30.5 219.0 A 138 138 0 0 0 269.5 219.0';
	// East CW 300→60: text curves along right side, reads top→bottom
	var tpE = 'M 219.0 30.5 A 138 138 0 0 1 219.0 269.5';
	// West CCW 240→120: text curves along left side, reads top→bottom
	var tpW = 'M 81.0 30.5 A 138 138 0 0 0 81.0 269.5';

	return '<svg viewBox="-8 -8 316 316" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:326px;display:block;margin:0 auto;'+GAUGE_VARS+'">' +
	'<defs>' +
	'<filter id="f-cyan"  x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'<filter id="f-orange" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'<filter id="f-red"   x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'<filter id="f-tn4"  x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'<filter id="f-tn6"  x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'<path id="tp-north" d="'+tpN+'" fill="none"/>' +
	'<path id="tp-south" d="'+tpS+'" fill="none"/>' +
	'<path id="tp-east"  d="'+tpE+'" fill="none"/>' +
	'<path id="tp-west"  d="'+tpW+'" fill="none"/>' +
	'</defs>' +
	// Outer background
	'<circle cx="150" cy="150" r="153" style="fill:var(--soc-card-bg)" stroke="var(--soc-border)" stroke-width="1"/>' +
	// Tachometer embedded inside compass inner fill
	'<g id="cp-tacho">'+buildTachoInner(ppe, cs, mode)+'</g>' +
	// North: NPU arc (outer, cyan)
	'<path id="cp-arc-npu" d="'+pNpuOuter+'" fill="none" stroke="#00c8ff" stroke-width="10" stroke-linecap="round" opacity="'+npuOpacity+'"'+npuGlow+'/>' +
	// North: CPU arc (inner, orange)
	'<path id="cp-arc-cpu" d="'+pNpuInner+'" fill="none" stroke="#ff6b35" stroke-width="8"  stroke-linecap="round" opacity="'+cpuOpacity+'"'+cpuGlow+'/>' +
	// East: integrity arc
	'<path id="cp-arc-east" d="'+pEast+'" fill="none" stroke="'+cs.eastColor+'" stroke-width="9" stroke-linecap="round" opacity="'+eastOpacity+'"'+eastGlow+'/>' +
	// South: HW buffer arc
	'<path id="cp-arc-south" d="'+pSouth+'" fill="none" stroke="'+cs.hwBuf.color+'" stroke-width="9" stroke-linecap="round" opacity="'+southOpacity+'"'+southAnim+'/>' +
	// West: latency arc
	'<path id="cp-arc-west" d="'+pWest+'" fill="none" stroke="'+cs.latColor+'" stroke-width="9" stroke-linecap="round" opacity="0.7"/>' +
	// Quadrant labels — curved textPath following each arc
	'<text font-size="9" font-family="monospace" letter-spacing="1.5" opacity="0.75" fill="#00c8ff"><textPath href="#tp-north" startOffset="50%" text-anchor="middle">NPU PATH</textPath></text>' +
	'<text font-size="9" font-family="monospace" letter-spacing="1.5" opacity="0.75" id="cp-lbl-south"><textPath href="#tp-south" startOffset="50%" text-anchor="middle">HW BUFFER</textPath></text>' +
	'<text font-size="9" font-family="monospace" letter-spacing="1.5" opacity="0.75" id="cp-lbl-east"><textPath href="#tp-east"  startOffset="50%" text-anchor="middle">INTEGRITY</textPath></text>' +
	'<text font-size="9" font-family="monospace" letter-spacing="1.5" opacity="0.75" id="cp-lbl-west"><textPath href="#tp-west"  startOffset="50%" text-anchor="middle">LATENCY</textPath></text>' +
	// Latency needle
	'<line id="cp-needle" x1="150" y1="224" x2="'+tip[0].toFixed(1)+'" y2="'+tip[1].toFixed(1)+'" stroke="'+cs.latColor+'" stroke-width="2.5" stroke-linecap="round" opacity="0.9"/>' +
	'<circle id="cp-needle-pivot" cx="150" cy="224" r="4" fill="'+cs.latColor+'" opacity="0.9"/>' +
	// PPE state ring outside compass disc — cyan=BND present, invisible otherwise
	'<circle id="cp-ppe-glow" cx="150" cy="150" r="150" fill="none" stroke="'+ppeRing.color+'" stroke-width="2.5" style="'+ppeRing.style+'"/>' +
	// Orange outer ring — ties the compass to the WiFi/F-S gauges (no redline here)
	'<circle cx="150" cy="150" r="152" fill="none" stroke="#ff8c1a" stroke-width="2.5" opacity="0.7"/>' +
	// Solid silver outer ring — outermost dashboard border
	'<circle cx="150" cy="150" r="155" fill="none" stroke="#222222" stroke-width="2.5"/>' +
	'</svg>';
}

function updateCompassSVG(cs, mode, ppe) {
	function sa(id, attr, val) { var el=document.getElementById(id); if(el) el.setAttribute(attr, val); }

	var npuOpacity  = cs.npuActive ? '1'    : cs.hwEnabled ? '0.45' : '0.2';
	var cpuOpacity  = !cs.hwEnabled ? '1'   : cs.npuActive ? '0.2'  : '0.45';
	var eastOpacity = cs.eastAlarm ? '1' : '0.45';
	var southOpacity= cs.hwBuf.pulsing ? '1' : '0.45';
	var tip = needleTip(cs.latMs);

	sa('cp-arc-npu',   'opacity', npuOpacity);
	sa('cp-arc-cpu',   'opacity', cpuOpacity);
	sa('cp-arc-east',  'stroke',  cs.eastColor);
	sa('cp-arc-east',  'opacity', eastOpacity);
	sa('cp-arc-south', 'stroke',  cs.hwBuf.color);
	sa('cp-arc-south', 'opacity', southOpacity);
	sa('cp-arc-west',  'stroke',  cs.latColor);

	// SQM pulse animation
	var south = document.getElementById('cp-arc-south');
	if (south) south.style.animation = cs.hwBuf.pulsing ? 'sqm-pulse 1.5s ease-in-out infinite' : '';

	// NPU glow
	var arcNpu = document.getElementById('cp-arc-npu');
	if (arcNpu) { if(cs.npuActive) arcNpu.setAttribute('filter','url(#f-cyan)'); else arcNpu.removeAttribute('filter'); }
	var arcCpu = document.getElementById('cp-arc-cpu');
	if (arcCpu) { if(!cs.hwEnabled) arcCpu.setAttribute('filter','url(#f-orange)'); else arcCpu.removeAttribute('filter'); }
	var arcEast = document.getElementById('cp-arc-east');
	if (arcEast) { if(cs.eastAlarm) arcEast.setAttribute('filter','url(#f-red)'); else arcEast.removeAttribute('filter'); }

	sa('cp-needle',       'x2',    tip[0].toFixed(1));
	sa('cp-needle',       'y2',    tip[1].toFixed(1));
	sa('cp-needle',       'stroke',cs.latColor);
	sa('cp-needle-pivot', 'fill',  cs.latColor);
	sa('cp-lbl-south',    'fill',  cs.hwBuf.color);
	sa('cp-lbl-west',     'fill',  cs.latColor);
	sa('cp-lbl-east',     'fill',  cs.eastColor);

	// Rebuild tachometer group (also updates mode/status text inside)
	var tg = document.getElementById('cp-tacho');
	if (tg) tg.innerHTML = buildTachoInner(ppe, cs, mode);

	// PPE state ring on compass outer edge
	var ppeGlow = document.getElementById('cp-ppe-glow');
	if (ppeGlow) {
		var ppeRing = _cnPpeRingStyle(ppe);
		ppeGlow.setAttribute('stroke', ppeRing.color);
		ppeGlow.setAttribute('style', ppeRing.style);
	}
}

/* ── CPU/NPU Load Tachometer ── */
function buildCpuNpuTacho(cs, ppe, st, ti) {
	st = st || {};
	var cpuPct     = cs.cpuPct || 0;
	var ppeBound   = (ppe.bnd || {}).total || 0;
	var ppeUnb     = (ppe.unb || {}).total || 0;
	var ppeTotal   = ppeBound + ppeUnb;
	var offloadPct = ppeTotal > 0 ? Math.round(ppeBound / ppeTotal * 100)
	               : (cs.npuActive ? 100 : 0);

	// CPU frequency — same source as the existing freq bar
	var fs       = freqBarState(st.cpu_hw_freq, st.cpu_min_freq, st.cpu_max_freq, st.pll_freq_mhz, st.cpu_governor);
	var freqMhz  = Math.round(fs.freq / 1000);
	var governor = (st.cpu_governor && st.cpu_governor !== 'unknown') ? st.cpu_governor.toUpperCase() : '';

	// Load-based colour for the needle + big readout (yellow<50, amber 50-79, red>=80);
	// fixed CPU-accent green for the scale/name (identity); frequency arc in gauge-blue.
	var loadCol  = cpuPct >= 80 ? '#ff3b30' : cpuPct >= 50 ? '#f5a623' : '#ffd21e';
	var ACCENT   = '#00cc44';
	var FREQ_COL = '#4d7cff';

	// Same automotive speedo geometry as the WiFi band gauges (0 @150° -> max @30°).
	var max = 100;
	var CX = 150, CY = 150, TH0 = 150, TH1 = 390, SWEEP = 240;
	function pt(r, deg) { var a = deg * Math.PI / 180; return [CX + r * Math.cos(a), CY + r * Math.sin(a)]; }
	function theta(v) { return TH0 + (Math.max(0, Math.min(max, v)) / max) * SWEEP; }
	function arcPoly(r, dA, dB, steps) {
		var s = '', k, d, q;
		for (k = 0; k <= steps; k++) { d = dA + (dB - dA) * k / steps; q = pt(r, d); s += (k ? 'L' : '') + q[0].toFixed(2) + ' ' + q[1].toFixed(2) + ' '; }
		return s;
	}
	var p = [];

	// outer rev band: orange sweep + red redline top (80-100% = red zone)
	var revSplit = TH0 + SWEEP * 0.80;
	p.push('<path d="M ' + arcPoly(106, TH0, revSplit, 44) + '" fill="none" stroke="#ff8c1a" stroke-width="2.5" stroke-linecap="round" opacity="0.7"/>');
	p.push('<path d="M ' + arcPoly(106, revSplit, TH1, 12) + '" fill="none" stroke="#ff3b30" stroke-width="2.5" stroke-linecap="round" opacity="0.85"/>');

	// LOAD sweep — flows-tacho style: dim full track + lit value arc that follows 0->load
	// (yellow, red past the 80% redline), and ticks that light up to the reading. No needle.
	var REDLINE_V = 80;
	p.push('<path d="M ' + arcPoly(90, TH0, TH1, 60) + '" fill="none" stroke="#31363f" stroke-width="4" stroke-linecap="round"/>');
	if (cpuPct > 0) {
		var litArc = cpuPct >= REDLINE_V ? '#ff3b30' : '#ffd21e';
		p.push('<path d="M ' + arcPoly(90, TH0, theta(cpuPct), 60) + '" fill="none" stroke="' + litArc + '" stroke-width="4.5" stroke-linecap="round" filter="url(#f-cn-glow)"/>');
	}
	var step = 20, minor = step / 5;
	for (var v = 0; v <= max + 0.5; v += minor) {
		var major = (Math.round(v) % step === 0), th = theta(v), red = v >= REDLINE_V, lit = v <= cpuPct + 0.001;
		var o = pt(104, th), inn = pt(major ? 92 : 98, th);
		var tc = lit ? (red ? '#ff3b30' : '#ffd21e') : '#3a3f47';
		p.push('<line x1="' + o[0].toFixed(1) + '" y1="' + o[1].toFixed(1) + '" x2="' + inn[0].toFixed(1) + '" y2="' + inn[1].toFixed(1) + '" stroke="' + tc + '" stroke-width="' + (major ? 2.4 : 1.4) + '" stroke-linecap="round" opacity="' + (lit ? 1 : 0.55) + '"/>');
		if (major) { var lp = pt(82, th); p.push('<text x="' + lp[0].toFixed(1) + '" y="' + (lp[1] + 4).toFixed(1) + '" text-anchor="middle" font-family="monospace" font-size="13" font-weight="700" fill="' + (v >= 80 ? '#ff6b60' : '#cfd3d8') + '">' + v + '</text>'); }
	}

	// FREQ inner arc (RTY slot): fill RIGHT->LEFT by (freq-500)/(1400-500), gauge-blue
	var FMIN = 500, FMAX = 1400, R_F = 73, NF = 16;
	var fLit = Math.round(Math.max(0, Math.min(1, (freqMhz - FMIN) / (FMAX - FMIN))) * NF);
	for (var i = 0; i < NF; i++) {
		var a1 = TH0 + (i / NF) * SWEEP + 1.4, a2 = TH0 + ((i + 1) / NF) * SWEEP - 1.4;
		var on = i >= NF - fLit;   // rightmost segments light first (fill right->left)
		p.push('<path d="M ' + arcPoly(R_F, a1, a2, 3) + '" fill="none" stroke="' + (on ? FREQ_COL : '#1e2a45') + '" stroke-width="5" stroke-linecap="round" opacity="' + (on ? 0.9 : 0.4) + '"/>');
	}
	p.push('<text x="150" y="214" text-anchor="middle" font-family="monospace" font-size="7.5" fill="' + FREQ_COL + '" opacity="0.9">' + (freqMhz || '—') + ' MHz</text>');

	// NPU/offload inner ring — breathes cyan when the HW offload path is active
	var hwOn = cs.npuActive;
	p.push('<circle cx="150" cy="150" r="52" fill="none" stroke="#00c8ff" stroke-width="2" opacity="' + (hwOn ? '0.5' : '0.18') + '"' + (hwOn ? ' style="animation:hw-breathe 2.4s ease-in-out infinite"' : '') + '/>');

	// BND: cyan bottom glow bar (matches WiFi/compass) — lights when any band has bound flows
	var totalBnd = (ppe && ppe.bnd) ? (ppe.bnd.total || 0) : 0;
	var bndOn = totalBnd > 0, bndOp = bndOn ? (0.55 + Math.min(1, totalBnd / 12) * 0.45).toFixed(2) : '0.16';
	p.push('<path d="M ' + arcPoly(98, 40, 140, 36) + '" fill="none" stroke="#00c8ff" stroke-width="9" stroke-linecap="round" opacity="' + bndOp + '"' + (bndOn ? ' filter="url(#f-cn-bnd)"' : '') + '/>');
	p.push('<text x="150" y="238" text-anchor="middle" font-family="monospace" font-size="8" font-weight="600" fill="' + (bndOn ? '#00c8ff' : '#556') + '" opacity="0.95">' + totalBnd + ' BND</text>');

	// name + governor status (governor moved up to the freed LOAD% slot so the hub doesn't cover it)
	p.push('<text x="150" y="118" text-anchor="middle" font-family="monospace" font-size="10" font-weight="700" letter-spacing="1" fill="' + ACCENT + '">CPU</text>');
	p.push('<text x="150" y="128" text-anchor="middle" font-family="monospace" font-size="7" letter-spacing="1" fill="var(--soc-muted)">' + (governor || '') + '</text>');

	// big LOAD readout — centre stage (no needle), load-coloured + unit + offloaded sub-line
	p.push('<text x="150" y="162" text-anchor="middle" font-family="monospace" font-size="34" font-weight="700" fill="' + loadCol + '" filter="url(#f-cn-soft)">' + cpuPct + '</text>');
	p.push('<text x="150" y="178" text-anchor="middle" font-family="monospace" font-size="8" letter-spacing="3" fill="var(--soc-muted)">LOAD</text>');
	p.push('<text x="150" y="226" text-anchor="middle" font-family="monospace" font-size="7.5" font-weight="600" fill="var(--soc-muted)">' + offloadPct + '% OFFLOADED</text>');

	return p.join('');
}

function _cnPpeRingStyle(ppe, ti) {
	// PLE pool health overrides the BND-based cyan default when the WiFi TX buffer pool
	// drops toward zero — that's the precursor signal for mt7996 SER / TX wedge.
	var ple = (ti && typeof ti.ple_free === 'number') ? ti.ple_free : -1;
	if (ple >= 0 && ple < 100000) {
		return { style: 'filter:blur(6px);opacity:0.85', color: '#f44336' };
	}
	if (ple >= 0 && ple < 1000000) {
		return { style: 'filter:blur(5px);opacity:0.7',  color: '#ff9800' };
	}

	// Default: cyan-on-BND, invisible when no BND
	var bnd = (ppe && ppe.bnd) ? (ppe.bnd.total || 0) : 0;
	if (bnd === 0) return { style: 'opacity:0', color: '#00c8ff' };
	var intensity = Math.min(1, bnd / 100);
	var blur = (3 + intensity * 6).toFixed(1);
	var op   = (0.5 + intensity * 0.45).toFixed(2);
	return { style: 'filter:blur('+blur+'px);opacity:'+op, color: '#00c8ff' };
}

function buildCpuNpuCompassSVG(cs, ppe, st, ti) {
	// Speedometer sibling of the WiFi band gauges: dark radial face + silver ring, the
	// tacho draws its own orange/redline rev-band. Defs mirror the WiFi builder (needle
	// glow, soft number glow, PLE-bar glow).
	return '<svg viewBox="30 30 240 240" xmlns="http://www.w3.org/2000/svg" overflow="hidden" style="width:100%;max-width:213px;display:block;margin:0 auto;'+GAUGE_VARS+'">' +
	'<defs>' +
	'<radialGradient id="f-cn-face" cx="50%" cy="42%" r="72%"><stop offset="0%" stop-color="#1b2733"/><stop offset="55%" stop-color="#12161c"/><stop offset="100%" stop-color="#0a0c0f"/></radialGradient>' +
	'<filter id="f-cn-glow" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'<filter id="f-cn-soft" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'<filter id="f-cn-bnd" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'</defs>' +
	'<circle cx="150" cy="150" r="108" fill="url(#f-cn-face)" stroke="var(--soc-border)" stroke-width="1"/>' +
	'<g id="cn-tacho">'+buildCpuNpuTacho(cs, ppe, st, ti)+'</g>' +
	'<circle cx="150" cy="150" r="109" fill="none" stroke="#222222" stroke-width="2.5"/>' +
	'</svg>';
}

function updateCpuNpuCompassSVG(cs, ppe, st, ti) {
	var tg = document.getElementById('cn-tacho');
	if (tg) tg.innerHTML = buildCpuNpuTacho(cs, ppe, st, ti);
}

/* ── WiFi Band Tachometers ── */
function _wifiBandHealth(ws) {
	var stations = ws ? (ws.stations || 0) : 0;
	if (stations === 0) return { text: 'NO CLIENTS', color: '#888' };
	var rty = ws.retry_pct || 0;
	if (rty > 50) return { text: 'WEAK', color: '#f44336' };
	if (rty > 20) return { text: 'FAIR', color: '#ff9800' };
	return { text: 'GOOD', color: '#4caf50' };
}

// WiFi band SPEEDOMETER: orange needle on a fixed 0→band-max MBPS scale. Needle = exact tx+rx
// byte-rate for host-path traffic; for HW-offloaded bands (byte counters bypassed) it falls back
// to an airtime-derived estimate (air_mbps ≈ airtime×bitrate×0.8) so it tracks offloaded
// throughput too. Yellow dashed RTY arc inside the numbers
// fills L→R with retry% (red at the top end); one solid cyan BND bar at the bottom (compass
// NPU-PATH style) glows when flows are bound; inner cyan HW-ACCELERATED ring breathes when
// accelerated and fires a one-shot pulse when this band gains a bound flow.
function buildWifiBandTacho(bandIdx, ws, qType, bndCount, unbCount) {
	ws = ws || {};
	var info = bandInfo[bandIdx] || { name: 'Band '+bandIdx, gaugeCol: '#888', sMax: 1000, sStep: 200, sDiv: 1, sCap: 'MBPS' };
	var col  = info.gaugeCol || '#888';
	// Throughput needle. Host-path traffic → exact mac80211 tx+rx byte-rate. HW-offloaded
	// traffic bypasses those counters (needle would read 0), so when the band is offloaded
	// (BND>0) fall back to the AIRTIME-derived estimate (air_mbps): airtime survives offload
	// because the MAC spends it on every frame. Use whichever is larger so partial-offload
	// and pure-host-path both read right. No expected-throughput fallback (that reported link
	// capability, not throughput, and showed a ghost value at idle on some mt76 builds).
	var mbps = (ws.tx_mbps || 0) + (ws.rx_mbps || 0);
	// HW-exact composite: per-band MAC MIB uplink bytes + fw per-station downlink
	// bytes. Both survive NPU offload and cover MLO links, unlike the mac80211
	// byte-rate above, so take whichever reads higher — still labelled "MBPS"
	// because these are real byte counters, not estimates.
	var hwMbps = (ws.hw_tx_mbps || 0) + (ws.hw_rx_mbps || 0);
	if (hwMbps > mbps) mbps = hwMbps;
	var mbpsEst = false;   // true when the reading is the airtime-derived estimate (offloaded)
	// Airtime estimate only takes over when it clearly exceeds the exact
	// composite (the one remaining blind spot: an MLD's secondary-link downlink,
	// which neither byte counter can attribute).
	if ((bndCount || 0) > 0 && (ws.air_mbps || 0) > mbps * 1.25) { mbps = ws.air_mbps; mbpsEst = true; }
	var retry = ws.retry_pct || 0;
	var bnd   = bndCount || 0;
	var sta   = ws.stations || 0;
	var sig   = ws.avg_signal || 0;
	var npu   = qType === 'npu';
	var max   = info.sMax || 1000;

	// one-shot pulse when this band gains bound flows (compass heartbeat, per-band)
	var pulsing = (_prevBandBnd[bandIdx] !== null && bnd > _prevBandBnd[bandIdx]);
	_prevBandBnd[bandIdx] = bnd;

	var CX = 150, CY = 150, TH0 = 150, TH1 = 390, SWEEP = 240;  // v=0 @150 deg (8 o'clock) -> v=max @30 deg (4 o'clock)
	function pt(r, deg) { var a = deg * Math.PI / 180; return [CX + r * Math.cos(a), CY + r * Math.sin(a)]; }
	function theta(v) { return TH0 + (Math.max(0, Math.min(max, v)) / max) * SWEEP; }
	function arcPoly(r, dA, dB, steps) {
		var s = '', k, d, q;
		for (k = 0; k <= steps; k++) { d = dA + (dB - dA) * k / steps; q = pt(r, d); s += (k ? 'L' : '') + q[0].toFixed(2) + ' ' + q[1].toFixed(2) + ' '; }
		return s;
	}
	var p = [];

	// outer rev band: orange sweep + red redline at the top end
	var revSplit = TH0 + SWEEP * 0.85;
	p.push('<path d="M ' + arcPoly(106, TH0, revSplit, 44) + '" fill="none" stroke="#ff8c1a" stroke-width="2.5" stroke-linecap="round" opacity="0.7"/>');
	p.push('<path d="M ' + arcPoly(106, revSplit, TH1, 10) + '" fill="none" stroke="#ff3b30" stroke-width="2.5" stroke-linecap="round" opacity="0.85"/>');

	// main MBPS scale ticks + numbers (band colour = identity)
	var minor = info.sStep / 5;
	for (var v = 0; v <= max + 0.5; v += minor) {
		var major = (Math.round(v) % info.sStep === 0), th = theta(v);
		var o = pt(104, th), inn = pt(major ? 92 : 98, th);
		p.push('<line x1="' + o[0].toFixed(1) + '" y1="' + o[1].toFixed(1) + '" x2="' + inn[0].toFixed(1) + '" y2="' + inn[1].toFixed(1) + '" stroke="' + (major ? col : '#5a6472') + '" stroke-width="' + (major ? 2 : 1.1) + '" stroke-linecap="round" opacity="' + (major ? 0.95 : 0.5) + '"/>');
		if (major) { var lp = pt(82, th); p.push('<text x="' + lp[0].toFixed(1) + '" y="' + (lp[1] + 4).toFixed(1) + '" text-anchor="middle" font-family="monospace" font-size="13" font-weight="700" fill="' + (v >= max * 0.85 ? '#ff6b60' : '#cfd3d8') + '">' + (v / info.sDiv) + '</text>'); }
	}
	p.push('<text x="150" y="128" text-anchor="middle" font-family="monospace" font-size="7.5" letter-spacing="1" fill="var(--soc-muted)">' + info.sCap + '</text>');

	// RTY: chunky dashed arc inside the numbers, same sweep, fills L->R by retry (0-30% = full),
	// yellow turning red at the top end (redline)
	var R_RTY = 73, NR = 16, rtyLit = Math.round(Math.min(1, retry / 30) * NR), redFrom = 13;
	for (var i = 0; i < NR; i++) {
		var a1 = TH0 + (i / NR) * SWEEP + 1.4, a2 = TH0 + ((i + 1) / NR) * SWEEP - 1.4;
		var on = i < rtyLit, red = i >= redFrom, rc = on ? (red ? '#ff4d4d' : '#ffcc00') : '#4a4620';
		p.push('<path d="M ' + arcPoly(R_RTY, a1, a2, 3) + '" fill="none" stroke="' + rc + '" stroke-width="5" stroke-linecap="round" opacity="' + (on ? 0.95 : 0.4) + '"/>');
	}
	p.push('<text x="150" y="214" text-anchor="middle" font-family="monospace" font-size="7.5" fill="' + (retry >= 24 ? '#ff4d4d' : '#ffcc00') + '" opacity="0.9">' + retry + '% RTY</text>');

	// HW-ACCELERATED inner ring (breathes when accelerated) + one-shot pulse on new BND
	var hwOn = npu && bnd > 0;
	p.push('<circle cx="150" cy="150" r="52" fill="none" stroke="#00c8ff" stroke-width="2" opacity="' + (hwOn ? '0.5' : '0.18') + '"' + (hwOn ? ' style="animation:hw-breathe 2.4s ease-in-out infinite"' : '') + '/>');
	if (pulsing) p.push('<circle cx="150" cy="150" r="58" fill="none" stroke="#00c8ff" stroke-width="2.5" style="animation:sqm-pulse 1.2s ease-out forwards"/>');

	// BND: one solid glowing bar centred at the bottom (compass NPU-PATH style)
	var bndOn = bnd > 0, inten = Math.min(1, bnd / 12), bndOp = bndOn ? (0.55 + inten * 0.45).toFixed(2) : '0.16';
	p.push('<path d="M ' + arcPoly(98, 40, 140, 36) + '" fill="none" stroke="#00c8ff" stroke-width="9" stroke-linecap="round" opacity="' + bndOp + '"' + (bndOn ? ' filter="url(#f-wbnd-' + bandIdx + ')"' : '') + '/>');
	p.push('<text x="150" y="238" text-anchor="middle" font-family="monospace" font-size="8" font-weight="600" fill="' + (bndOn ? '#00c8ff' : '#556') + '" opacity="0.95">' + bnd + ' BND</text>');

	// band name + HW-accel status
	p.push('<text x="150" y="118" text-anchor="middle" font-family="monospace" font-size="10" font-weight="700" letter-spacing="1" fill="' + col + '">' + info.name.toUpperCase() + '</text>');
	var hwCol = hwOn ? '#00c8ff' : '#666';
	p.push('<text x="150" y="140" text-anchor="middle" font-family="monospace" font-size="7" letter-spacing="1" fill="' + hwCol + '">' + (hwOn ? 'HW ACCELERATED' : (npu ? 'NPU IDLE' : 'CPU PATH')) + '</text>');

	// needle + hub
	var nth = theta(mbps), tip = pt(96, nth), a = nth * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a), px = -dy, py = dx;
	var b1 = [CX + px * 5, CY + py * 5], b2 = [CX - px * 5, CY - py * 5], tail = [CX - dx * 20, CY - dy * 20];
	p.push('<polygon points="' + tip[0].toFixed(1) + ',' + tip[1].toFixed(1) + ' ' + b1[0].toFixed(1) + ',' + b1[1].toFixed(1) + ' ' + tail[0].toFixed(1) + ',' + tail[1].toFixed(1) + ' ' + b2[0].toFixed(1) + ',' + b2[1].toFixed(1) + '" fill="url(#f-wndl-' + bandIdx + ')" filter="url(#f-wglow-' + bandIdx + ')"/>');
	p.push('<circle cx="150" cy="150" r="12" fill="url(#f-whub-' + bandIdx + ')" stroke="#ff7a2f" stroke-width="1.5"/>');
	p.push('<circle cx="150" cy="150" r="4" fill="#001417"/>');

	// big MBPS readout (band colour)
	var lbl = mbps > 0 ? Math.round(mbps) : (sta > 0 ? '0' : '—');
	p.push('<text x="150" y="176" text-anchor="middle" font-family="monospace" font-size="20" font-weight="700" fill="' + col + '"' + (mbps > 0 ? ' filter="url(#f-wsoft-' + bandIdx + ')"' : '') + '>' + lbl + '</text>');
	// unit line: "MBPS" for exact byte-rate, "MBPS (est)" when the value is the
	// airtime-derived offloaded estimate (tighter letter-spacing so it still fits).
	var unitLbl = (mbpsEst && mbps > 0) ? 'MBPS (est)' : 'MBPS';
	var unitLs  = (mbpsEst && mbps > 0) ? '1' : '2';
	p.push('<text x="150" y="187" text-anchor="middle" font-family="monospace" font-size="7" letter-spacing="' + unitLs + '" fill="var(--soc-muted)">' + unitLbl + '</text>');
	p.push('<text x="150" y="226" text-anchor="middle" font-family="monospace" font-size="7.5" font-weight="600" fill="var(--soc-muted)">' + sta + ' STA' + (sta > 0 && sig ? '  ' + sig + ' dBm' : '') + '</text>');

	return p.join('');
}

function buildWifiBandSVG(bandIdx, ws, qType, ppe) {
	var idx      = bandIdx;
	var bndCount = (ppe && ppe.bnd && Array.isArray(ppe.bnd.band_bnd)) ? (ppe.bnd.band_bnd[bandIdx] || 0) : 0;
	var unbCount = (ppe && ppe.unb && Array.isArray(ppe.unb.band_unb)) ? (ppe.unb.band_unb[bandIdx] || 0) : 0;
	return '<svg viewBox="30 30 240 240" xmlns="http://www.w3.org/2000/svg" overflow="hidden" style="width:100%;max-width:207px;display:block;margin:0 auto;'+GAUGE_VARS+'">' +
	'<defs>' +
	'<radialGradient id="f-wface-'+idx+'" cx="50%" cy="42%" r="72%"><stop offset="0%" stop-color="#1b2733"/><stop offset="55%" stop-color="#12161c"/><stop offset="100%" stop-color="#0a0c0f"/></radialGradient>' +
	'<radialGradient id="f-whub-'+idx+'" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#7dffff"/><stop offset="55%" stop-color="#00c8ff"/><stop offset="100%" stop-color="#053947"/></radialGradient>' +
	'<linearGradient id="f-wndl-'+idx+'" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffb060"/><stop offset="100%" stop-color="#ff5a1f"/></linearGradient>' +
	'<filter id="f-wglow-'+idx+'" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'<filter id="f-wsoft-'+idx+'" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'<filter id="f-wbnd-'+idx+'" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
	'</defs>' +
	'<circle cx="150" cy="150" r="108" fill="url(#f-wface-'+idx+')" stroke="var(--soc-border)" stroke-width="1"/>' +
	'<g id="wifi-tacho-'+idx+'">'+buildWifiBandTacho(bandIdx, ws, qType, bndCount, unbCount)+'</g>' +
	'<circle cx="150" cy="150" r="109" fill="none" stroke="#222222" stroke-width="2.5"/>' +
	'</svg>';
}

function updateWifiBandSVG(bandIdx, ws, qType, ppe) {
	var tg       = document.getElementById('wifi-tacho-'+bandIdx);
	var bndCount = (ppe && ppe.bnd && Array.isArray(ppe.bnd.band_bnd)) ? (ppe.bnd.band_bnd[bandIdx] || 0) : 0;
	var unbCount = (ppe && ppe.unb && Array.isArray(ppe.unb.band_unb)) ? (ppe.unb.band_unb[bandIdx] || 0) : 0;
	if (tg) tg.innerHTML = buildWifiBandTacho(bandIdx, ws, qType, bndCount, unbCount);
	// MLO frames banana (only present in the DOM when MLO built it)
	var bw = document.getElementById('wifi-banana-wrap-'+bandIdx);
	if (bw) bw.innerHTML = buildWifiFramesBanana(bandIdx, ws);
}

// Flows/sec tachometer: an automotive sweep-needle gauge in the same slot above each WiFi band
// gauge (replaces the old crescent "banana"). Per-band frame rate (rx_fragments uplink +
// Tx-success downlink — survives NPU offload) drives the needle on a FIXED 0–15 (×1000 F/S)
// scale so the reading is meaningful across pods: majors 0/3/6/9/12/15, minors every 500,
// redline from 12k. Swept arc + lit ticks in band colour; classic red needle; the bottom edge
// arches up to cradle the round gauge below; digital f/s readout kept as our own touch.
function buildWifiFramesBanana(bandIdx, ws) {
	ws = ws || {};
	var info = bandInfo[bandIdx] || { rtyCol: '#888' };
	var col  = info.gaugeCol || info.rtyCol;      // band identity colour (amber/blue/green)
	var fps  = ws.frames_ps || 0;
	var id   = bandIdx;

	var HX = 120, HY = 100, R_TICK = 90, R_LABEL = 66, R_VALARC = 86, R_FACE = 96;
	var TH0 = 202, TH1 = -22, SWEEP = TH0 - TH1;   // v=0 -> 202°, v=max -> -22° (clockwise over the top)
	var MAX_FPS = 15000, REDLINE = 12000;
	function pt(r, deg) { var a = deg * Math.PI / 180; return [HX + r * Math.cos(a), HY - r * Math.sin(a)]; }
	function theta(f) { var v = Math.max(0, Math.min(MAX_FPS, f)); return TH0 - (v / MAX_FPS) * SWEEP; }
	// sampled arc polyline (avoids SVG arc-flag guesswork), returns "x y L x y ..."
	function arcPoly(r, dA, dB, steps) {
		var s = '', i, d, q;
		for (i = 0; i <= steps; i++) { d = dA + (dB - dA) * i / steps; q = pt(r, d); s += (i ? 'L' : '') + q[0].toFixed(2) + ' ' + q[1].toFixed(2) + ' '; }
		return s;
	}

	var p = [];
	p.push('<defs>' +
		'<radialGradient id="f-face-' + id + '" cx="50%" cy="38%" r="75%"><stop offset="0%" stop-color="#20242b"/><stop offset="70%" stop-color="#14161b"/><stop offset="100%" stop-color="#0c0d10"/></radialGradient>' +
		'<filter id="f-fps-glow-' + id + '" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
		'<filter id="f-fps-ndl-' + id + '" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
		'<linearGradient id="f-needle-' + id + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ff8a3d"/><stop offset="100%" stop-color="#ff2d20"/></linearGradient>' +
	'</defs>');
	// face: domed top (outer arc) + bottom edge arched UP in the middle to cradle the round gauge
	var pFaceL = pt(R_FACE, 203);
	var faceD = 'M ' + arcPoly(R_FACE, 203, -23, 48) + 'Q 120 108 ' + pFaceL[0].toFixed(2) + ' ' + pFaceL[1].toFixed(2) + ' Z';
	// #222222 silver bezel under the face, matching the round WiFi speedo's outer ring
	p.push('<path d="' + faceD + '" fill="none" stroke="#222222" stroke-width="2.5" stroke-linejoin="round"/>');
	p.push('<path d="' + faceD + '" fill="url(#f-face-' + id + ')" stroke="var(--soc-border)" stroke-width="1" stroke-linejoin="round"/>');
	// outer orange→red rev band just outside the ticks, matching the round WiFi speedo's outer ring
	// (splits at the redline point so orange runs 0→12k, red 12k→15k)
	var revA = theta(REDLINE);
	p.push('<path d="M ' + arcPoly(93, TH0, revA, 40) + '" fill="none" stroke="#ff8c1a" stroke-width="2.5" stroke-linecap="round" opacity="0.7"/>');
	p.push('<path d="M ' + arcPoly(93, revA, TH1, 12) + '" fill="none" stroke="#ff3b30" stroke-width="2.5" stroke-linecap="round" opacity="0.85"/>');
	// dim full track, faint redline zone, lit value arc (band colour, red past redline)
	p.push('<path d="M ' + arcPoly(R_VALARC, TH0, TH1, 60) + '" fill="none" stroke="#31363f" stroke-width="4" stroke-linecap="round"/>');
	p.push('<path d="M ' + arcPoly(R_VALARC, theta(REDLINE), TH1, 20) + '" fill="none" stroke="#ff3b30" stroke-width="4" stroke-linecap="round" opacity="0.30"/>');
	if (fps > 0) {
		var litArc = (fps >= REDLINE) ? '#ff3b30' : col;
		p.push('<path d="M ' + arcPoly(R_VALARC, TH0, theta(fps), 60) + '" fill="none" stroke="' + litArc + '" stroke-width="4.5" stroke-linecap="round" filter="url(#f-fps-glow-' + id + ')"/>');
	}
	// ticks: minors every 500, majors every 3000; lit up to current f/s
	for (var v = 0; v <= MAX_FPS; v += 500) {
		var major = (v % 3000 === 0), th = theta(v), red = (v >= REDLINE);
		var len = major ? 15 : 8, o = pt(R_TICK, th), inn = pt(R_TICK - len, th);
		var lit = v <= fps, tc = lit ? (red ? '#ff3b30' : col) : '#3a3f47';
		p.push('<line x1="' + o[0].toFixed(2) + '" y1="' + o[1].toFixed(2) + '" x2="' + inn[0].toFixed(2) + '" y2="' + inn[1].toFixed(2) + '" stroke="' + tc + '" stroke-width="' + (major ? 2.4 : 1.4) + '" stroke-linecap="round" opacity="' + (lit ? 1 : 0.55) + '"/>');
	}
	// numbers (×1000) at the majors
	[0, 3, 6, 9, 12, 15].forEach(function(k) {
		var lp = pt(R_LABEL, theta(k * 1000));
		p.push('<text x="' + lp[0].toFixed(1) + '" y="' + (lp[1] + 4).toFixed(1) + '" text-anchor="middle" font-family="monospace" font-weight="700" font-size="13" fill="' + (k >= 12 ? '#ff6b60' : '#cfd3d8') + '">' + k + '</text>');
	});
	// caption + digital readout (our own touch — exact f/s)
	p.push('<text x="120" y="70" text-anchor="middle" font-family="monospace" font-size="8.5" letter-spacing="1.5" fill="var(--soc-muted)">×1000 F/S</text>');
	p.push('<text x="120" y="90" text-anchor="middle" font-family="monospace" font-weight="700" font-size="15" fill="' + (fps > 0 ? (fps >= REDLINE ? '#ff3b30' : col) : 'var(--soc-muted)') + '">' + (fps > 0 ? fmtK(fps) : '—') + '</text>');
	// needle
	var nth = theta(fps), tip = pt(82, nth), a = nth * Math.PI / 180;
	var dx = Math.cos(a), dy = -Math.sin(a), px = -dy, py = dx;
	var b1 = [HX + px * 4.5, HY + py * 4.5], b2 = [HX - px * 4.5, HY - py * 4.5], tail = [HX - dx * 16, HY - dy * 16];
	p.push('<polygon points="' + tip[0].toFixed(1) + ',' + tip[1].toFixed(1) + ' ' + b1[0].toFixed(1) + ',' + b1[1].toFixed(1) + ' ' + tail[0].toFixed(1) + ',' + tail[1].toFixed(1) + ' ' + b2[0].toFixed(1) + ',' + b2[1].toFixed(1) + '" fill="url(#f-needle-' + id + ')" filter="url(#f-fps-ndl-' + id + ')"/>');
	p.push('<circle cx="120" cy="100" r="9" fill="#1a1d22" stroke="#4a5058" stroke-width="1.5"/>');
	p.push('<circle cx="120" cy="100" r="3.4" fill="#2a2f37"/>');

	return '<svg viewBox="0 0 240 140" xmlns="http://www.w3.org/2000/svg" overflow="visible" style="width:100%;max-width:176px;display:block;margin:0 auto -16px;' + GAUGE_VARS + '">' +
		p.join('') + '</svg>';
}

// Returns array of 3 elements (6 GHz, 5 GHz, 2.4 GHz) for direct inclusion in compass-wrap
function buildWifiTachoElements(wifi, ti, st, ppe) {
	var bands = (wifi && Array.isArray(wifi.bands)) ? wifi.bands : [];
	var isMlo = !!(wifi && wifi.mlo);
	var fallbackType = (st && st.npu_loaded) ? 'npu' : 'dma';
	var elems = [];
	// 6 GHz → 5 GHz → 2.4 GHz (band index 2 → 1 → 0)
	for (var b = 2; b >= 0; b--) {
		var ws = null;
		for (var j = 0; j < bands.length; j++) if (bands[j].band === b) { ws = bands[j]; break; }
		var txQ = getTxQueue(ti, b) || { type: fallbackType };
		var svgWrap = E('div', { 'id': 'wifi-svg-wrap-'+b });
		// Frames banana above each gauge (per-band f/s). Shown for BOTH MLO and
		// standard: per-band frames_ps is available in both now (standard reads
		// per-netdev rx_fragments, MLO sums per-link). buildWifiFramesBanana is
		// null-safe, so the empty 2.4 GHz band just renders a "—" pod.
		var banana = '<div id="wifi-banana-wrap-'+b+'">'+buildWifiFramesBanana(b, ws)+'</div>';
		svgWrap.innerHTML = banana + buildWifiBandSVG(b, ws, txQ.type, ppe);
		elems.push(svgWrap);
	}
	return elems;
}

/* ── Ethernet Port Horizontal Bar Gauges ── */
function _ethLabel(iface) {
	var m = { wan:'WAN', lan1:'LAN 1', lan2:'LAN 2', lan3:'LAN 3', lan4:'LAN 4' };
	return m[iface] || iface.toUpperCase();
}
function _ethSpeed(speed) {
	if (!speed || speed <= 0) return 'NO LINK';
	if (speed >= 10000) return '10G';
	if (speed >= 5000)  return '5G';
	if (speed >= 2500)  return '2.5G';
	if (speed >= 1000)  return '1G';
	if (speed >= 100)   return '100M';
	return speed + 'M';
}
function _ethFmt(mbps) {
	if (mbps >= 100) return mbps.toFixed(0);
	if (mbps >= 10)  return mbps.toFixed(1);
	return mbps.toFixed(2);
}

function buildEthPortSVG(port, txMbps, rxMbps, ppe) {
	var iface    = port.iface || '';
	var isWan    = (iface === 'wan');
	var up       = !!port.up;
	var maxSc    = _maxEthMbps[iface] || 100;
	var barW     = 140;
	var txPct    = up ? Math.min(1, txMbps / maxSc) : 0;
	var rxPct    = up ? Math.min(1, rxMbps / maxSc) : 0;
	var txW      = (txPct * barW).toFixed(1);
	var rxW      = (rxPct * barW).toFixed(1);
	var txVal    = up ? _ethFmt(txMbps) : '--';
	var rxVal    = up ? _ethFmt(rxMbps) : '--';
	var label    = _ethLabel(iface);
	var spLbl    = _ethSpeed(up ? (port.speed || 0) : 0);
	var portClr  = up ? (isWan ? '#00ffff' : '#00ff00') : '#555';
	var dimOp    = up ? '1' : '0.4';
	// Footer: WAN shows wired BND (total minus per-band WiFi BND); LAN ports show per-port BND from bridge FDB match
	var footerTxt, footerClr;
	if (isWan) {
		if (up) {
			var bndTotal  = (ppe && ppe.bnd) ? (ppe.bnd.total || 0) : 0;
			var bandBnd   = (ppe && ppe.bnd && ppe.bnd.band_bnd) ? ppe.bnd.band_bnd : [0,0,0];
			var wifiBnd   = (bandBnd[0]||0) + (bandBnd[1]||0) + (bandBnd[2]||0);
			var wiredBnd  = Math.max(0, bndTotal - wifiBnd);
			var unbTotal  = (ppe && ppe.unb) ? (ppe.unb.total || 0) : 0;
			var bandUnb   = (ppe && ppe.unb && ppe.unb.band_unb) ? ppe.unb.band_unb : [0,0,0];
			var wifiUnb   = (bandUnb[0]||0) + (bandUnb[1]||0) + (bandUnb[2]||0);
			var wiredUnb  = Math.max(0, unbTotal - wifiUnb);
			footerTxt = 'BND: ' + wiredBnd + '  UNB: ' + wiredUnb;
			footerClr = '#00c8ff';
		} else {
			footerTxt = '';
			footerClr = '#555';
		}
	} else {
		var portIdx  = {lan1:0, lan2:1, lan3:2, lan4:3}[iface];
		var bndPort  = (ppe && ppe.bnd && ppe.bnd.port_bnd) ? (ppe.bnd.port_bnd[portIdx] || 0) : 0;
		footerTxt = 'BND: ' + bndPort;
		footerClr = bndPort > 0 ? '#00c8ff' : '#555';
	}

	return '<svg viewBox="0 0 240 90" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block;'+GAUGE_VARS+'">' +
	'<rect x="1" y="1" width="238" height="88" rx="6" fill="none" stroke="#222222" stroke-width="2.5"/>' +
	'<rect x="3" y="3" width="234" height="84" rx="5" fill="var(--soc-card-bg)" stroke="var(--soc-border)" stroke-width="1"/>' +
	'<text x="16" y="16" fill="'+portClr+'" font-size="12" font-weight="700" font-family="monospace">'+label+'</text>' +
	'<text x="234" y="16" text-anchor="end" fill="'+portClr+'" font-size="10" font-family="monospace">'+spLbl+'</text>' +
	'<line x1="12" y1="21" x2="229" y2="21" stroke="#333" stroke-width="0.5"/>' +
	'<text x="12" y="35" fill="#00c8ff" font-size="9" font-family="monospace" letter-spacing="1" opacity="'+dimOp+'">TX</text>' +
	'<rect x="30" y="26" width="'+barW+'" height="13" rx="3" fill="var(--soc-border)" opacity="'+dimOp+'"/>' +
	(txPct > 0 ? '<rect x="30" y="26" width="'+txW+'" height="13" rx="3" fill="#00c8ff" opacity="'+dimOp+'"/>' : '') +
	'<text x="218" y="35" text-anchor="end" fill="var(--soc-text)" font-size="10" font-weight="700" font-family="monospace" opacity="'+dimOp+'">'+txVal+'</text>' +
	'<text x="234" y="35" text-anchor="end" fill="var(--soc-muted)" font-size="7" font-family="monospace" opacity="'+dimOp+'">Mb</text>' +
	'<text x="12" y="59" fill="#ff6b35" font-size="9" font-family="monospace" letter-spacing="1" opacity="'+dimOp+'">RX</text>' +
	'<rect x="30" y="50" width="'+barW+'" height="13" rx="3" fill="var(--soc-border)" opacity="'+dimOp+'"/>' +
	(rxPct > 0 ? '<rect x="30" y="50" width="'+rxW+'" height="13" rx="3" fill="#ff6b35" opacity="'+dimOp+'"/>' : '') +
	'<text x="218" y="59" text-anchor="end" fill="var(--soc-text)" font-size="10" font-weight="700" font-family="monospace" opacity="'+dimOp+'">'+rxVal+'</text>' +
	'<text x="234" y="59" text-anchor="end" fill="var(--soc-muted)" font-size="7" font-family="monospace" opacity="'+dimOp+'">Mb</text>' +
	'<text x="120" y="80" text-anchor="middle" fill="'+footerClr+'" font-size="7.5" font-family="monospace">'+footerTxt+'</text>' +
	'</svg>';
}

function updateEthPortSVG(port, txMbps, rxMbps, ppe) {
	var wrap = document.getElementById('eth-port-svg-' + port.iface);
	if (wrap) wrap.innerHTML = buildEthPortSVG(port, txMbps, rxMbps, ppe);
}

function buildEthGaugeRow(ethPorts, ppe) {
	var wrap = E('div', { 'class': 'eth-gauge-wrap', 'id': 'eth-gauge-wrap' });
	ethPorts.forEach(function(p) {
		var div = E('div', { 'id': 'eth-port-svg-' + p.iface, 'style': 'flex:1;min-width:140px' });
		div.innerHTML = buildEthPortSVG(p, 0, 0, ppe);
		wrap.appendChild(div);
	});
	return wrap;
}

/* ── Compass Data Cards ── */
function renderCompassCards(cs, bypass, jitter, wan, wifi, bridge, mode) {
	bypass=bypass||{}; jitter=jitter||{}; wan=wan||{}; wifi=wifi||{};

	// North card: NPU Path
	bridge = bridge || {};
	var rawBridgeDrops = bridge.tx_dropped || 0;
	var bridgeDelta = (_prevBridgeDrops !== null && rawBridgeDrops >= _prevBridgeDrops) ? (rawBridgeDrops - _prevBridgeDrops) : 0;
	_prevBridgeDrops = rawBridgeDrops;
	var northVal   = cs.npuActive ? 'ACTIVE' : (cs.hwEnabled ? 'IDLE' : 'CPU PATH');
	var northColor = cs.npuActive ? '#00c8ff' : (cs.hwEnabled ? '#888' : '#ff6b35');
	var northSub   = mode === 'ap'
		? 'CPU: '+cs.cpuPct+'%  |  Bridge drops Δ: '+bridgeDelta
		: 'CPU: '+cs.cpuPct+'%  |  WAN: '+cs.wanMbps+' Mbps';

	// East card: Integrity
	var eastVal, eastSub;
	if (mode === 'router') {
		eastVal = cs.eastAlarm ? cs.errCount+' ERROR'+(cs.errCount>1?'S':'') : 'CLEAN';
		eastSub = 'RX errors: '+(wan.rx_errors||0)+'  TX errors: '+(wan.tx_errors||0);
	} else {
		var ws = cs.worstSignal;
		eastVal = cs.wbDelta.length === 0 ? 'NO CLIENTS'
		        : ws === 0               ? 'NO DATA'
		        : ws < -82               ? 'POOR'
		        : ws < -75               ? 'WEAK'
		        :                          'CLEAN';
		var bnames = ['2.4G','5G','6G'];
		eastSub = cs.wbDelta.length > 0
			? 'Signal: '+cs.wbDelta.map(function(b){ return (bnames[b.band]||('B'+b.band))+': '+b.signal+' dBm'; }).join('  |  ')
			: 'No connected clients';
	}
	var eastColor = cs.eastColor;

	// South card: HW Buffer Health
	var hb = cs.hwBuf || {};
	var southVal   = hb.activeDrop ? 'DROPPING' : 'HEALTHY';
	var southColor = hb.color || '#00cc44';
	var southSub   = 'PSE Δ: '+hb.pseDelta+' CDM Δ: '+hb.cdmHwfDelta+' | PPE: '+hb.ppePct+'% BND ('+hb.ppeBound+'/'+hb.ppeTotal+')';

	// West card: Latency
	var latVal   = cs.latMs > 0 ? cs.latMs.toFixed(1)+'ms' : (jitter.available===false ? 'N/A' : '---');
	var latColor = cs.latColor;
	var latSub   = 'Jitter: '+(jitter.jitter||0).toFixed(1)+'ms  |  '+(jitter.samples||0)+' samples  |  '+(jitter.target||'1.1.1.1');

	function card(title, val, color, sub) {
		return E('div', { 'class': 'compass-card' }, [
			E('div', { 'class': 'compass-card-title' }, title),
			E('div', { 'class': 'compass-card-value', 'style': 'color:'+color }, val),
			E('div', { 'class': 'compass-card-sub' }, sub)
		]);
	}

	return E('div', { 'class': 'compass-cards', 'id': 'compass-cards' }, [
		card('NPU Path',    northVal, northColor, northSub),
		card('Integrity',   eastVal,  eastColor,  eastSub),
		card('Latency',     latVal,   latColor,   latSub),
		card('HW Buffer',   southVal, southColor, southSub)
	]);
}

function updateCompassCards(cs, bypass, jitter, wan, wifi, bridge, mode) {
	var cards = document.getElementById('compass-cards');
	if (!cards) return;
	var divs = cards.querySelectorAll('.compass-card');
	if (divs.length < 4) return;

	bypass=bypass||{}; jitter=jitter||{}; wan=wan||{}; wifi=wifi||{}; bridge=bridge||{};

	function setCard(div, val, color, sub) {
		var v = div.querySelector('.compass-card-value');
		var s = div.querySelector('.compass-card-sub');
		if (v) { v.textContent=val; v.style.color=color; }
		if (s) s.textContent=sub;
	}

	var rawBridgeDrops2 = bridge.tx_dropped || 0;
	var bridgeDelta2 = (_prevBridgeDrops !== null && rawBridgeDrops2 >= _prevBridgeDrops) ? (rawBridgeDrops2 - _prevBridgeDrops) : 0;
	_prevBridgeDrops = rawBridgeDrops2;

	setCard(divs[0], cs.npuActive?'ACTIVE':(cs.hwEnabled?'IDLE':'CPU PATH'),
		cs.npuActive?'#00c8ff':(cs.hwEnabled?'#888':'#ff6b35'),
		mode==='ap'
			?'CPU: '+cs.cpuPct+'%  |  Bridge drops Δ: '+bridgeDelta2
			:'CPU: '+cs.cpuPct+'%  |  WAN: '+cs.wanMbps+' Mbps');

	if (mode === 'router') {
		setCard(divs[1], cs.eastAlarm?cs.errCount+' ERROR'+(cs.errCount>1?'S':''):'CLEAN',
			cs.eastColor,
			'RX errors: '+(wan.rx_errors||0)+'  TX errors: '+(wan.tx_errors||0));
	} else {
		var ws2 = cs.worstSignal;
		var bnames2 = ['2.4G','5G','6G'];
		setCard(divs[1],
			cs.wbDelta.length === 0 ? 'NO CLIENTS'
			: ws2 === 0             ? 'NO DATA'
			: ws2 < -82             ? 'POOR'
			: ws2 < -75             ? 'WEAK'
			:                         'CLEAN',
			cs.eastColor,
			cs.wbDelta.length > 0
				? 'Signal: '+cs.wbDelta.map(function(b){ return (bnames2[b.band]||('B'+b.band))+': '+b.signal+' dBm'; }).join('  |  ')
				: 'No connected clients');
	}

	var latVal = cs.latMs > 0 ? cs.latMs.toFixed(1)+'ms' : (jitter.available===false?'N/A':'---');
	setCard(divs[2], latVal, cs.latColor,
		'Jitter: '+(jitter.jitter||0).toFixed(1)+'ms  |  '+(jitter.samples||0)+' samples  |  '+(jitter.target||'1.1.1.1'));

	var hb = cs.hwBuf || {};
	setCard(divs[3],
		hb.activeDrop?'DROPPING':'HEALTHY',
		hb.color||'#00cc44',
		'PSE Δ: '+hb.pseDelta+' CDM Δ: '+hb.cdmHwfDelta+' | PPE: '+hb.ppePct+'% BND ('+hb.ppeBound+'/'+hb.ppeTotal+')');
}

/* ── Main View ── */
return view.extend({
	load: function() {
		return Promise.all([
			callNpuStatus(),        // d[0]
			callPpeEntries(),       // d[1]
			callTokenInfo(),        // d[2]
			callFrameEngine(),      // d[3]
			callGetVlanOffload(),   // d[4]
			callTxStats(),          // d[5]
			callGetDeviceMode(),    // d[6]
			callGetNpuBypass(),     // d[7]
			callGetWanHealth(),     // d[8]
			callGetJitterResult(),  // d[9]
			callGetConflictAlerts(),// d[10]
			callGetWifiStats(),     // d[11]
			callGetBridgeStats(),   // d[12]
			callGetFlowOffload(),   // d[13]
			callGetPppoeOffload(),  // d[14]
			callGetEthStats()       // d[15]
		]);
	},

	render: function(data) {
		injectCSS();
		var st=data[0]||{}, ppe=data[1]||{}, ti=data[2]||{}, fe=data[3]||{};
		var vo=data[4]||{}, txs=data[5]||{}, dm=data[6]||{};
		var bypass=data[7]||{}, wan=data[8]||{};
		var jitter=data[9]||{}, alertData=data[10]||{};
		var wifi=data[11]||{}, bridge=data[12]||{};
		var flo=data[13]||{}, ppo=data[14]||{};
		var eth=data[15]||{};
		var memR = Array.isArray(st.memory_regions) ? st.memory_regions : [];
		var mode = dm.mode || 'router';

		var hwBuf = hwBufferState(fe, ppe, mode);
		var cs = compassState(bypass, hwBuf, jitter, wan, wifi, bridge, mode);

		// Compass SVG container — tachometer is embedded inside (innerHTML so we can update by element ID)
		var compassSvgWrap = E('div', { 'class': 'compass-svg-wrap', 'id': 'compass-svg-wrap' });
		compassSvgWrap.innerHTML = buildCompassSVG(cs, mode, ppe);

		var cnWrap = E('div', { 'id': 'cpu-npu-svg-wrap', 'style': 'flex-shrink:0' });
		cnWrap.innerHTML = buildCpuNpuCompassSVG(cs, ppe, st, ti);

		var view = E('div',{'class':'cbi-map'},[
			E('h2',{},_('Airoha FlowSense')),

			// Conflict alerts
			renderConflictAlerts(alertData),

			// Offload Monitor
			E('div',{'class':'cbi-section'},[
				// Gauges: CPU/NPU tachometer, compass, WiFi tachometers, compass cards, mode banner
				E('div', { 'class': 'compass-wrap' }, [
					cnWrap,
					compassSvgWrap
				].concat(buildWifiTachoElements(wifi, ti, st, ppe))),
				renderCompassCards(cs, bypass, jitter, wan, wifi, bridge, mode),
				// Ethernet port gauges row
				buildEthGaugeRow((eth && Array.isArray(eth.ports)) ? eth.ports : [], ppe),
				renderModeBanner(dm),
				E('div',{'style':'display:flex;align-items:center;justify-content:space-evenly;margin-top:10px;flex-wrap:wrap;width:100%'},[
					E('label',{'style':'display:flex;align-items:center;gap:6px;font-size:13px'},[
						E('span',{'id':'flow-offload-badge','class':'offload-badge '+(flo.enabled?'offload-on':'offload-off')},_('HW Flow Offload')),
						renderFlowOffloadSelect(flo.enabled)
					]),
					E('label',{'style':'display:flex;align-items:center;gap:6px;font-size:13px'},[
						E('span',{'id':'vlan-offload-badge','class':'offload-badge '+(vo.enabled?'offload-on':'offload-off')},_('VLAN Offload')),
						renderVlanOffloadSelect(vo.enabled)
					]),
					E('label',{'style':'display:flex;align-items:center;gap:6px;font-size:13px'},[
						E('span',{'id':'pppoe-offload-badge','class':'offload-badge '+(ppo.enabled?'offload-on':'offload-off')},_('PPPoE Offload')),
						renderPppoeOffloadSelect(ppo.enabled)
					])
				]),
				E('div',{'style':'margin-top:12px'}, renderPpeTerminal(ppe))
			]),
		]);

		poll.add(L.bind(function() {
			return Promise.all([
				callNpuStatus(), callPpeEntries(), callTokenInfo(), callFrameEngine(),
				callGetVlanOffload(), callTxStats(),
				callGetDeviceMode(), callGetNpuBypass(),
				callGetWanHealth(), callGetJitterResult(), callGetConflictAlerts(),
				callGetWifiStats(), callGetBridgeStats(),
				callGetFlowOffload(), callGetPppoeOffload(),
				callGetEthStats()
			]).then(L.bind(function(d) {
				injectCSS();
				var st=d[0]||{}, ppe=d[1]||{}, ti=d[2]||{}, fe=d[3]||{};
				var vo=d[4]||{}, txs=d[5]||{}, dm=d[6]||{};
				var bypass=d[7]||{}, wan=d[8]||{};
				var jitter=d[9]||{}, alertData=d[10]||{};
				var wifi=d[11]||{}, bridge=d[12]||{};
				var flo=d[13]||{}, ppo=d[14]||{};
				var eth=d[15]||{};
				var mode = dm.mode || 'router';

				// Compass update (tachometer embedded inside compass)
				var hwBuf = hwBufferState(fe, ppe, mode);
				var cs = compassState(bypass, hwBuf, jitter, wan, wifi, bridge, mode);
				updateCompassSVG(cs, mode, ppe);
				updateCompassCards(cs, bypass, jitter, wan, wifi, bridge, mode);

				// CPU/NPU Load compass update
				updateCpuNpuCompassSVG(cs, ppe, st, ti);

				// WiFi band tachometers
				var wbands = (wifi && Array.isArray(wifi.bands)) ? wifi.bands : [];
				var wFallback = st.npu_loaded ? 'npu' : 'dma';
				for (var wb = 0; wb < 3; wb++) {
					var wws = null;
					for (var wj = 0; wj < wbands.length; wj++) if (wbands[wj].band === wb) { wws = wbands[wj]; break; }
					updateWifiBandSVG(wb, wws, (getTxQueue(ti, wb) || { type: wFallback }).type, ppe);
				}

				// Conflict alerts
				var alertWrap = document.getElementById('conflict-alerts');
				if (alertWrap) {
					var fresh = renderConflictAlerts(alertData);
					alertWrap.innerHTML = fresh.innerHTML;
				}

				// Offload selects + badges
				function _setOffloadBadge(id, on) { var b=document.getElementById(id); if(b) b.className='offload-badge '+(on?'offload-on':'offload-off'); }
				var vs=document.getElementById('vlan-offload-select'); if(vs&&!vs.matches(':focus')) vs.value=(vo.enabled?'1':'0'); _setOffloadBadge('vlan-offload-badge',vo.enabled);
				var fls=document.getElementById('flow-offload-select'); if(fls&&!fls.matches(':focus')) fls.value=(flo.enabled?'1':'0'); _setOffloadBadge('flow-offload-badge',flo.enabled);
				var pps=document.getElementById('pppoe-offload-select'); if(pps&&!pps.matches(':focus')) pps.value=(ppo.enabled?'1':'0'); _setOffloadBadge('pppoe-offload-badge',ppo.enabled);

				// Ethernet port gauges — compute per-port Mbps deltas from cumulative byte counters
				var ethPorts = (eth && Array.isArray(eth.ports)) ? eth.ports : [];
				var now = Date.now() / 1000;
				ethPorts.forEach(function(p) {
					var prev = _prevEthBytes[p.iface];
					var txMbps = 0, rxMbps = 0;
					if (prev && prev.time) {
						var dt = now - prev.time;
						if (dt > 0) {
							txMbps = Math.max(0, (p.tx_bytes - prev.tx) * 8 / dt / 1e6);
							rxMbps = Math.max(0, (p.rx_bytes - prev.rx) * 8 / dt / 1e6);
						}
					}
					_prevEthBytes[p.iface] = { tx: p.tx_bytes, rx: p.rx_bytes, time: now };
					if (!_maxEthMbps[p.iface] || txMbps > _maxEthMbps[p.iface]) _maxEthMbps[p.iface] = Math.max(txMbps, 100);
					if (rxMbps > _maxEthMbps[p.iface]) _maxEthMbps[p.iface] = rxMbps;
					updateEthPortSVG(p, txMbps, rxMbps, ppe);
				});

				// PPE terminal
				var tb = document.getElementById('ppe-terminal-body');
				if (tb) tb.innerHTML = buildPpeTerminalBody(ppe);
			},this));
		},this), 5);

		return view;
	},

	handleSaveApply: null, handleSave: null, handleReset: null
});
