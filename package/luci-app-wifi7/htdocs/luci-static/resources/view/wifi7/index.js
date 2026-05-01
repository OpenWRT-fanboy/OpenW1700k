'use strict';
'require view';
'require fs';
'require rpc';
'require poll';

var callUciGetWireless = rpc.declare({
    object: 'uci',
    method: 'get',
    params: [ 'config' ],
    expect: { values: {} }
});

var callHostapdStatus = rpc.declare({
    object: 'hostapd.ap-mld-1',
    method: 'get_status',
    expect: {}
});

var callExec = rpc.declare({
    object: 'file',
    method: 'exec',
    params: [ 'command', 'params' ],
    expect: {}
});

// network.wireless status via exec (rpcd ACL for network.wireless is session-restricted)
function callWirelessStatusExec() {
    return L.resolveDefault(callExec('/bin/sh', [
        '-c', 'ubus call network.wireless status 2>/dev/null'
    ]), { stdout: '' }).then(function(r) {
        try { return JSON.parse(r.stdout || '{}'); }
        catch(e) { return {}; }
    });
}

function parseStat(raw) {
    var out = {};
    if (!raw) return out;
    raw.split('\n').forEach(function(line) {
        var eq = line.indexOf('=');
        if (eq > 0)
            out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
    return out;
}

var bwMap = {
    '0': '20 MHz', '1': '40 MHz', '2': '80 MHz',
    '3': '160 MHz', '4': '320 MHz',
    '5': '160 MHz', '6': '320 MHz',
    '9': '160 MHz'
};

function freqLabel(stat) {
    var ch = stat['channel'] || '?';
    var fr = stat['freq']    || '?';
    var bw = bwMap[stat['eht_oper_chwidth']] || stat['eht_oper_chwidth'] || '?';
    return 'CH ' + ch + '  /  ' + fr + ' MHz  /  ' + bw;
}

function chanUtil(stat) {
    var u = parseInt(stat['chan_util_avg']);
    if (isNaN(u) || u > 100) return 'N/A';
    return u + '%';
}

function badge(text, bg, fg) {
    return E('span', { 'style':
        'display:inline-block;font-size:11px;font-weight:bold;padding:2px 7px;' +
        'border-radius:3px;background:' + bg + ';color:' + fg }, text);
}

function skuBanner(skuOff, skuIdx) {
    // SKU is truly active only when sku_disable=0 AND sku_idx is set (non-empty, non-zero)
    var skuIdxSet = skuIdx && skuIdx !== '' && skuIdx !== '0';
    var active    = !skuOff && skuIdxSet;
    var partial   = !skuOff && !skuIdxSet;
    var style = skuOff   ? 'background:#3a0a0a;border:1px solid #e24b4a;color:#f4a0a0'
              : partial  ? 'background:#2a1a00;border:1px solid #f5a623;color:#fac775'
              :            'background:#0a2a0a;border:1px solid #1d9e75;color:#7fff7f';
    var label = skuOff  ? 'SKU regulation inactive -- '
              : partial ? 'SKU partially configured -- '
              :           'SKU regulation active -- ';
    var msg   = skuOff  ? 'Transmitting without country power limits (up to 27 dBm). Set country + sku_idx on the Radio tab.'
              : partial ? 'sku_disable=0 but sku_idx not set. TX power limits may not be applied. Set sku_idx on the Radio tab.'
              :           'TX power limited by country + sku_idx=' + skuIdx + ' regulatory table.';
    return E('div', { 'style': 'border-radius:6px;padding:9px 13px;margin-bottom:14px;' + style }, [
        E('strong', {}, label), msg
    ]);
}

function infoBanner(text) {
    return E('div', { 'style':
        'border-radius:6px;padding:9px 13px;margin-bottom:14px;' +
        'background:#0a1a3a;border:1px solid #85b7eb;color:#b5d4f4' }, text);
}

function warnBanner(text) {
    return E('div', { 'style':
        'border-radius:6px;padding:9px 13px;margin-bottom:14px;' +
        'background:#2a1a0a;border:1px solid #f5a623;color:#fac775' }, text);
}

function sectionBox(title, dotColor, extra, bodyEl) {
    var header = E('div', { 'style':
        'background:#16213e;padding:7px 12px;font-size:13px;font-weight:bold;' +
        'display:flex;align-items:center;gap:10px' }, [
        E('span', { 'style':
            'display:inline-block;width:8px;height:8px;border-radius:50%;' +
            'background:' + dotColor }),
        title
    ]);
    if (extra) {
        var sp = E('span', { 'style':
            'margin-left:auto;font-weight:normal;font-size:12px;color:#aaa' });
        sp.textContent = extra;
        header.appendChild(sp);
    }
    return E('div', { 'style':
        'border:1px solid #444;border-radius:6px;margin-bottom:12px;overflow:hidden' }, [
        header,
        E('div', { 'style': 'padding:10px 12px' }, [ bodyEl ])
    ]);
}

// Persistent state for collapsible sections -- survives auto-refresh
var _collapsibleState = {};

function collapsibleSection(title, dotColor, bodyEl, startCollapsed) {
    // Use title as key -- must be unique per section
    var key = title;
    // First time: default collapsed; after that: remember user choice
    if (!(key in _collapsibleState))
        _collapsibleState[key] = (startCollapsed !== false);
    var collapsed = _collapsibleState[key];

    var header = E('div', { 'style':
        'background:#16213e;padding:7px 12px;font-size:13px;font-weight:bold;' +
        'display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none' });
    var dot = E('span', { 'style':
        'display:inline-block;width:8px;height:8px;border-radius:50%;background:' + dotColor });
    var arrow = E('span', { 'style': 'margin-left:auto;font-size:11px;color:#666' },
        collapsed ? '[ + expand ]' : '[ - collapse ]');
    header.appendChild(dot);
    var titleSpan = E('span', {});
    titleSpan.textContent = title;
    header.appendChild(titleSpan);
    header.appendChild(arrow);
    var body = E('div', { 'style':
        'padding:10px 12px;' + (collapsed ? 'display:none' : '') }, [ bodyEl ]);
    header.addEventListener('click', function() {
        collapsed = !collapsed;
        _collapsibleState[key] = collapsed;
        body.style.display = collapsed ? 'none' : '';
        arrow.textContent  = collapsed ? '[ + expand ]' : '[ - collapse ]';
    });
    return E('div', { 'style':
        'border:1px solid #444;border-radius:6px;margin-bottom:12px;overflow:hidden' }, [
        header, body
    ]);
}

function fieldRow(label, valueEl) {
    var row = E('div', { 'style':
        'display:grid;grid-template-columns:170px 1fr;gap:8px;' +
        'align-items:start;padding:5px 0;' +
        'border-bottom:1px solid #2a2a3a;font-size:12px' });
    var lbl = E('div', { 'style': 'color:#888;padding-top:2px' });
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(typeof valueEl === 'string'
        ? (function(){ var d = E('div', {}); d.textContent = valueEl; return d; })()
        : valueEl);
    return row;
}

function roValue(text) {
    var d = E('div', { 'style':
        'font-family:monospace;font-size:11px;color:#ccc;padding-top:2px' });
    d.textContent = text;
    return d;
}

function detectMode(bitrateStr) {
    if (!bitrateStr) return '';
    if (bitrateStr.indexOf('EHT') >= 0) return 'BE';
    if (bitrateStr.indexOf('HE') >= 0)  return 'AX';
    if (bitrateStr.indexOf('VHT') >= 0) return 'AC';
    if (bitrateStr.indexOf('MCS') >= 0) return 'N';
    return 'G/A';
}

function modeBadge(bitrateStr) {
    var mode = detectMode(bitrateStr);
    var colors = {
        'BE':  ['#1a0a3a', '#afa9ec'],
        'AX':  ['#0a1a3a', '#85b7eb'],
        'AC':  ['#0a2a1a', '#5dcaa5'],
        'N':   ['#2a2a0a', '#d4c46a'],
        'G/A': ['#2a1a0a', '#f5a623']
    };
    var c = colors[mode] || ['#222', '#aaa'];
    return mode ? badge('WiFi ' + mode, c[0], c[1]) : null;
}

function signalColor(dbm) {
    // Color-code signal strength: green > -65, yellow > -75, red <= -75, grey if unknown
    var v = parseInt(dbm);
    if (isNaN(v)) return '#888';
    if (v >= -65) return '#1d9e75'; // good
    if (v >= -75) return '#f5a623'; // fair
    return '#e24b4a';               // poor
}

function signalSpan(signal, signal_arr) {
    if (!signal) return E('span', { 'style': 'color:#888' }, '?');
    var col = signalColor(signal);
    var txt = signal + (signal_arr ? ' ' + signal_arr : '') + ' dBm';
    var sp = E('span', { 'style': 'color:' + col + ';font-weight:bold' });
    sp.textContent = txt;
    return sp;
}

function parseStationDump(raw) {
    var stations = [];
    var cur      = null;
    var curLink  = null;

    raw.split('\n').forEach(function(line) {
        var staMx = line.match(/^Station ([0-9a-f:]+) \(on /i);
        if (staMx) {
            if (cur) stations.push(cur);
            cur = { mac: staMx[1], connected: '', links: {} };
            curLink = null;
            return;
        }
        if (!cur) return;

        var t = line.replace(/\t/g, ' ').trim();

        var linkMx = t.match(/^Link (\d+):$/);
        if (linkMx) {
            curLink = linkMx[1];
            cur.links[curLink] = {
                addr: '', signal: '', signal_arr: '',
                tx: '', rx: '', idle: true
            };
            return;
        }

        if (t.match(/^connected time:/))
            cur.connected = t.replace('connected time:', '').trim();

        if (curLink !== null) {
            var lk = cur.links[curLink];

            var addrMx = t.match(/^address:\s+([0-9a-f:]+)/i);
            if (addrMx) { lk.addr = addrMx[1]; return; }

            var sigMx = t.match(/^signal:\s+([-\d]+)\s+(\[[\d,\s-]+\])\s+dBm/);
            if (sigMx) {
                lk.signal     = sigMx[1];
                lk.signal_arr = sigMx[2];
                lk.idle       = (parseInt(sigMx[1]) === 0);
                return;
            }
            var sigMx0 = t.match(/^signal:\s+([-\d]+)\s+dBm/);
            if (sigMx0) {
                lk.signal = sigMx0[1];
                lk.idle   = (parseInt(sigMx0[1]) === 0);
                return;
            }

            var txMx = t.match(/^tx bitrate:\s+(.+)/);
            if (txMx) { lk.tx = txMx[1]; return; }

            var rxMx = t.match(/^rx bitrate:\s+(.+)/);
            if (rxMx) { lk.rx = rxMx[1]; return; }
        }
    });
    if (cur) stations.push(cur);
    return stations;
}

return view.extend({

    activeTab: 'overview',

    // Derive hostapd/iw ifname from UCI section name
    // ap_mld_1 -> ap-mld-1, mlo0 -> ap-mld0, mlo1 -> ap-mld1
    _mldIfname: function(sid) {
        if (sid === 'ap_mld_1') return 'ap-mld-1';
        var m = sid.match(/^mlo(\d+)$/);
        if (m) return 'ap-mld' + m[1];
        // generic fallback: replace underscores with dashes
        return sid.replace(/_/g, '-');
    },

    loadData: function() {
        var self = this;
        // Phase 1: get UCI data synchronously to know all interfaces
        return L.resolveDefault(callUciGetWireless('wireless'), {}).then(function(uciData) {

        // Collect all MLD sections and legacy interfaces from UCI
        var mldSIDs = [], legacySIDs = [];
        Object.keys(uciData).sort().forEach(function(sid) {
            var s = uciData[sid];
            if (!s || s['.type'] !== 'wifi-iface' || s['mode'] !== 'ap') return;
            if (s['mlo'] === '1') mldSIDs.push(sid);
            else legacySIDs.push(sid);
        });

        // Build dynamic Promise.all
        var calls = [
            Promise.resolve(uciData),                          // [0] UCI
            L.resolveDefault(callHostapdStatus(), {}),         // [1] hostapd status
            L.resolveDefault(callExec('/bin/cat', [            // [2] sku_disable
                '/sys/kernel/debug/ieee80211/phy0/mt76/sku_disable'
            ]), { stdout: '1' }),
        ];

        // [3..] MLD hostapd stat per link (0,1,2) per MLD network
        mldSIDs.forEach(function(sid) {
            var ifn = self._mldIfname(sid);
            calls.push(L.resolveDefault(callExec('/usr/sbin/hostapd_cli',
                ['-i', ifn, '-l', '0', 'stat']), { stdout: '' }));
            calls.push(L.resolveDefault(callExec('/usr/sbin/hostapd_cli',
                ['-i', ifn, '-l', '1', 'stat']), { stdout: '' }));
            calls.push(L.resolveDefault(callExec('/usr/sbin/hostapd_cli',
                ['-i', ifn, '-l', '2', 'stat']), { stdout: '' }));
        });

        // [3 + mldSIDs.length*3 ..] MLD station dumps
        var mldStaBase = 3 + mldSIDs.length * 3;
        mldSIDs.forEach(function(sid) {
            var ifn = self._mldIfname(sid);
            calls.push(L.resolveDefault(callExec('/usr/sbin/iw',
                ['dev', ifn, 'station', 'dump']), { stdout: '' }));
        });

        // [mldStaBase + mldSIDs.length ..] Legacy station dumps
        var legacyStaBase = mldStaBase + mldSIDs.length;
        legacySIDs.forEach(function(sid) {
            var s = uciData[sid];
            var dev = s['device'] || 'radio0';
            // Legacy ifname: phy0.0-ap0 etc -- derive from device
            var devIdx = {'radio0':0,'radio1':1,'radio2':2}[dev];
            var ifn = devIdx !== undefined ? ('phy0.' + devIdx + '-ap0') : (dev + '-ap0');
            calls.push(L.resolveDefault(callExec('/usr/sbin/iw',
                ['dev', ifn, 'station', 'dump']), { stdout: '' }));
        });

        // Fixed diagnostics calls at the end
        var diagBase = legacyStaBase + legacySIDs.length;
        [
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/mt76/fw_version']],
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/mt76/band0/txpower_info']],
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/mt76/band1/txpower_info']],
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/mt76/band2/txpower_info']],
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/mt76/mat_table']],
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/mt76/dfs_status']],
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/netdev:ap-mld-1/link-0/txpower']],
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/netdev:ap-mld-1/link-1/txpower']],
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/netdev:ap-mld-1/link-2/txpower']],
            ['/bin/cat', ['/proc/version']],
            ['/bin/sh',  ['-c', 'for d in /sys/class/thermal/thermal_zone*; do t=$(cat $d/temp 2>/dev/null); n=$(cat $d/type 2>/dev/null); [ -n "$t" ] && [ -n "$n" ] && echo "$n $((t/1000))"; done']],
            ['/bin/cat', ['/sys/kernel/debug/ieee80211/phy0/netdev:ap-mld-1/mt76_links_info']],
            ['/bin/sh',  ['-c', 'ubus call network.wireless status 2>/dev/null']],
        ].forEach(function(c) {
            calls.push(L.resolveDefault(callExec(c[0], c[1]), { stdout: '' }));
        });

        return Promise.all(calls).then(function(data) {
            // Attach index metadata for render functions
            data._mldSIDs     = mldSIDs;
            data._legacySIDs  = legacySIDs;
            data._mldStatBase = 3;
            data._mldStaBase  = mldStaBase;
            data._legacyStaBase = legacyStaBase;
            data._diagBase    = diagBase;
            return data;
        });
        }); // end phase 1
    },

    load: function() {
        return this.loadData();
    },

    switchTab: function(name, container, data) {
        this.activeTab = name;
        var tabs = container.querySelectorAll('.wifi7-tab');
        tabs.forEach(function(t) {
            var active = t.getAttribute('data-tab') === name;
            t.style.borderBottom = active ? '2px solid #85b7eb' : '2px solid transparent';
            t.style.color = active ? '#85b7eb' : '#888';
        });
        var content = container.querySelector('.wifi7-content');
        while (content.firstChild) content.removeChild(content.firstChild);
        content.appendChild(this.renderTab(name, data));
    },

    renderTab: function(name, data) {
        switch(name) {
            case 'overview':    return this.renderOverview(data);
            case 'mld':         return this.renderMLD(data);
            case 'radio':       return this.renderRadio(data);
            case 'legacy':      return this.renderLegacy(data);
            case 'stations':    return this.renderStations(data);
            case 'diagnostics': return this.renderDiagnostics(data);
            default:            return E('div', {}, 'Unknown tab');
        }
    },

    render: function(data) {
        var self = this;

        var tabDefs = [
            { id: 'overview',    label: 'Overview' },
            { id: 'mld',         label: 'MLD config' },
            { id: 'radio',       label: 'Radio' },
            { id: 'legacy',      label: 'Networks' },
            { id: 'stations',    label: 'Stations' },
            { id: 'diagnostics', label: 'Diagnostics' }
        ];

        var tabBar = E('div', { 'style':
            'display:flex;gap:2px;border-bottom:1px solid #333;margin-bottom:16px' });

        tabDefs.forEach(function(td) {
            var t = E('div', {
                'class': 'wifi7-tab',
                'data-tab': td.id,
                'style':
                    'padding:6px 14px;font-size:13px;cursor:pointer;' +
                    'border-bottom:2px solid transparent;color:#888;' +
                    'transition:color .15s'
            });
            t.textContent = td.label;
            t.addEventListener('mouseover', function() {
                if (self.activeTab !== td.id) t.style.color = '#ccc';
            });
            t.addEventListener('mouseout', function() {
                if (self.activeTab !== td.id) t.style.color = '#888';
            });
            t.addEventListener('click', function() {
                self.switchTab(td.id, container, data);
            });
            tabBar.appendChild(t);
        });

        var content = E('div', { 'class': 'wifi7-content' });

        var container = E('div', { 'style':
            'font-family:sans-serif;color:#ddd;padding:4px 0' }, [
            E('h2', { 'style': 'margin-bottom:14px' }, 'WiFi 7 -- MT7996'),
            tabBar,
            content
        ]);

        this.switchTab(this.activeTab, container, data);

        // Only auto-refresh on read-only tabs -- never refresh edit tabs
        var readOnlyTabs = { 'overview': true, 'stations': true, 'diagnostics': true };

        poll.add(L.bind(function() {
            if (!readOnlyTabs[self.activeTab]) return Promise.resolve();
            return this.loadData().then(L.bind(function(newData) {
                data = newData;
                self.switchTab(self.activeTab, container, newData);
            }, this));
        }, this), 10);

        return container;
    },

    renderOverview: function(data) {
        var uciData   = data[0];
        var hapdSt    = data[1];
        var skuRaw    = data[2].stdout ? data[2].stdout.trim() : '1';
        var mldSIDs   = data._mldSIDs || ['ap_mld_1'];
        var diagBase  = data._diagBase || 10;
        var wlStatus  = data[diagBase + 12] || {};

        // Get hostapd stat for first MLD network (primary)
        var statBase = data._mldStatBase || 3;
        var stat0 = parseStat(data[statBase]     ? (data[statBase].stdout || '')     : '');
        var stat1 = parseStat(data[statBase + 1] ? (data[statBase + 1].stdout || '') : '');
        var stat2 = parseStat(data[statBase + 2] ? (data[statBase + 2].stdout || '') : '');

        var skuOff  = skuRaw === '1';
        // Extract sku_idx from radio0 UCI (applies to all radios)
        var skuIdx  = (uciData['radio0'] && uciData['radio0']['sku_idx']) || '';
        var hapdOK  = hapdSt && hapdSt.status === 'ENABLED';

        // Derive radio up/down from hostapd_cli stat data
        // If stat has a valid channel, the radio is up
        var radioUp = {
            'radio0': hapdOK && !!(stat0['channel'] && stat0['channel'] !== '0'),
            'radio1': hapdOK && !!(stat1['channel'] && stat1['channel'] !== '0'),
            'radio2': hapdOK && !!(stat2['channel'] && stat2['channel'] !== '0')
        };

        // Collect ALL MLD networks from UCI
        var self = this;
        // Build MLD nets list using precomputed _mldSIDs from loadData
        var mldNets = mldSIDs.map(function(sid) {
            var s = uciData[sid] || {};
            return {
                sid:    sid,
                ssid:   s['ssid'] || sid,
                enc:    s['encryption'] || 'sae',
                ifname: s['ifname'] || self._mldIfname(sid)
            };
        });

        function linkCard(label, bg, fg, stat, radioName) {
            var txp     = stat['max_txpower'];
            var txpCol  = skuOff ? '#e24b4a' : '#1d9e75';
            var txpNote = skuOff ? ' (no SKU limit)' : ' (regulated)';
            var up      = radioName ? radioUp[radioName] : null;
            var upEl    = up === null ? null :
                E('span', { 'style':
                    'font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px;' +
                    'background:' + (up ? '#0a2a0a' : '#2a0a0a') + ';' +
                    'color:' + (up ? '#1d9e75' : '#e24b4a') },
                    up ? 'UP' : 'DOWN');
            return E('div', { 'style':
                'border:1px solid #333;border-radius:6px;padding:10px 12px;' +
                'background:#1a1a2e;flex:1;min-width:0' }, [
                E('div', { 'style': 'display:flex;align-items:center' }, [
                    badge(label, bg, fg),
                    upEl || E('span', {})
                ]),
                E('div', { 'style':
                    'font-size:14px;font-weight:bold;color:#fff;margin-top:6px' },
                    freqLabel(stat)),
                E('div', { 'style': 'font-size:12px;color:#aaa;margin-top:3px' },
                    'EHT  |  util: ' + chanUtil(stat) +
                    '  |  num_links: ' + (stat['num_links'] || '?')),
                E('div', { 'style':
                    'font-size:12px;color:' + txpCol + ';margin-top:4px' },
                    'Tx: ' + (txp || '?') + ' dBm' + txpNote)
            ]);
        }

        // Build link body for a MLD network given its hostapd stats
        function mldLinkBody(s0, s1, s2, netHapdOK) {
            return E('div', {}, [
                E('div', { 'style': 'display:flex;gap:8px;margin-bottom:10px' }, [
                    linkCard('2.4 GHz -- Link 0', '#0a2a1a', '#5dcaa5', s0, 'radio0'),
                    linkCard('5 GHz -- Link 1',   '#0a1a3a', '#85b7eb', s1, 'radio1'),
                    linkCard('6 GHz -- Link 2',   '#1a0a3a', '#afa9ec', s2, 'radio2')
                ]),
                E('div', { 'style': 'font-size:12px;color:#888' },
                    'type: ' + (s0['ap_mld_type'] || 'STR') +
                    '  |  clients: ' + (s0['num_sta[0]'] || '0') +
                    '  |  MLD MAC: ' + (s0['mld_addr[0]'] || '?'))
            ]);
        }

        var legacyRows = [];
        var bandInfo = {
            'radio0': ['2.4G', '#0a2a1a', '#5dcaa5'],
            'radio1': ['5G',   '#0a1a3a', '#85b7eb'],
            'radio2': ['6G',   '#1a0a3a', '#afa9ec']
        };
        Object.keys(uciData).sort().forEach(function(sid) {
            var s = uciData[sid];
            if (s['.type'] === 'wifi-iface' && s['mlo'] !== '1' && s['mode'] === 'ap') {
                var bi  = bandInfo[s['device']] || [s['device'], '#222', '#aaa'];
                var enc = s['encryption'] || 'none';
                legacyRows.push(E('div', { 'style':
                    'display:flex;align-items:center;gap:8px;padding:5px 0;' +
                    'border-bottom:1px solid #2a2a3a;font-size:12px' }, [
                    badge(bi[0], bi[1], bi[2]),
                    E('span', { 'style': 'font-family:monospace' }, s['ssid'] || sid),
                    E('span', { 'style': 'color:#888;margin-left:4px' },
                        enc === 'none' ? 'open' : enc),
                    E('span', { 'style':
                        'margin-left:auto;font-size:10px;padding:2px 6px;' +
                        'border-radius:3px;background:#2a2a1a;color:#666;' +
                        'cursor:default;border:1px solid #333',
                        'title': 'Legacy (non-MLD) network' }, 'LEGACY')
                ]));
            }
        });

        // Build MLD network boxes -- one per MLD UCI section, each with its own data
        var mldBoxes = mldNets.map(function(net, idx) {
            var base = statBase + idx * 3;
            var s0 = parseStat(data[base]     ? (data[base].stdout     || '') : '');
            var s1 = parseStat(data[base + 1] ? (data[base + 1].stdout || '') : '');
            var s2 = parseStat(data[base + 2] ? (data[base + 2].stdout || '') : '');
            var netOK = !!(s0['state'] === 'ENABLED' || s1['state'] === 'ENABLED' || s2['state'] === 'ENABLED');
            var body = mldLinkBody(s0, s1, s2, netOK);
            return sectionBox('MLD network -- ' + net.sid,
                netOK ? '#1d9e75' : '#444',
                'SSID: ' + net.ssid + '  |  ' + net.enc,
                body);
        });

        var overviewItems = [
            skuBanner(skuOff, skuIdx),
            E('div', { 'style': 'font-size:12px;margin-bottom:14px;color:#aaa' }, [
                'hostapd ap-mld-1: ',
                E('strong', { 'style': 'color:' + (hapdOK ? '#1d9e75' : '#e24b4a') },
                    hapdOK ? 'ENABLED' : 'NOT RUNNING'),
                mldNets.length > 1
                    ? E('span', { 'style': 'margin-left:12px;color:#888' },
                        mldNets.length + ' MLD networks configured')
                    : E('span', {})
            ])
        ];
        mldBoxes.forEach(function(b) { overviewItems.push(b); });
        overviewItems.push(E('div', { 'style':
                'border:1px solid #444;border-radius:6px;overflow:hidden' }, [
            E('div', { 'style':
                'background:#16213e;padding:7px 12px;' +
                'font-size:13px;font-weight:bold' },
                'Legacy networks'),
            E('div', { 'style': 'padding:8px 12px' },
                legacyRows.length ? legacyRows
                    : [E('div', { 'style': 'font-size:12px;color:#888' },
                        'No legacy networks.')])
        ]));
        return E('div', {}, overviewItems);
    },

    renderMLD: function(data) {
        var uciData = data[0];
        var mldSID  = '';
        var mldSSID = '', mldEnc = '', mldKey = '', mldRsno = '';

        Object.keys(uciData).forEach(function(sid) {
            var s = uciData[sid];
            if (s['.type'] === 'wifi-iface' && s['mlo'] === '1') {
                mldSID  = sid;
                mldSSID = s['ssid']            || '';
                mldEnc  = s['encryption']      || 'sae';
                mldKey  = s['key']             || '';
                mldRsno = s['encryption_rsno'] || 'sae';
            }
        });

        var stat0 = parseStat(data[3].stdout || '');
        var stat1 = parseStat(data[4].stdout || '');
        var stat2 = parseStat(data[5].stdout || '');

        var ssidInput = E('input', {
            'type': 'text', 'value': mldSSID,
            'style': 'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                     'color:#fff;padding:4px 8px;font-size:12px;width:220px'
        });
        var keyInput = E('input', {
            'type': 'password', 'value': mldKey,
            'style': 'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                     'color:#fff;padding:4px 8px;font-size:12px;width:220px'
        });
        var keyToggleMld = E('button', { 'style':
            'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;' +
            'padding:4px 8px;font-size:11px;cursor:pointer;margin-left:6px' }, 'Show');
        keyToggleMld.addEventListener('click', function() {
            if (keyInput.type === 'password') { keyInput.type = 'text'; keyToggleMld.textContent = 'Hide'; }
            else { keyInput.type = 'password'; keyToggleMld.textContent = 'Show'; }
        });
        var keyWrapMld = E('div', { 'style': 'display:flex;align-items:center' }, [keyInput, keyToggleMld]);

        var encSel = E('select', { 'style':
            'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
            'color:#fff;padding:4px 8px;font-size:12px;width:220px' });
        [['sae',       'WPA3-SAE (recommended)'],
         ['sae-mixed', 'WPA2/WPA3 mixed'],
         ['owe',       'Enhanced Open (OWE)']].forEach(function(o) {
            var opt = E('option', { 'value': o[0] }, o[1]);
            if (mldEnc === o[0]) opt.selected = true;
            encSel.appendChild(opt);
        });

        var rsnoSel = E('select', { 'style':
            'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
            'color:#fff;padding:4px 8px;font-size:12px;width:220px' });
        [['sae',     'sae (default)'],
         ['sae-ext', 'sae-ext'],
         ['none',    'none']].forEach(function(o) {
            var opt = E('option', { 'value': o[0] }, o[1]);
            if (mldRsno === o[0]) opt.selected = true;
            rsnoSel.appendChild(opt);
        });

        var progressDiv = E('div', { 'style': 'display:none;margin-top:12px' }, [
            E('div', { 'style':
                'background:#1a1a2e;border:1px solid #444;border-radius:6px;' +
                'padding:12px 14px;text-align:center' }, [
                E('div', { 'style':
                    'font-size:13px;font-weight:bold;margin-bottom:6px' },
                    'Applying configuration...'),
                E('div', { 'style': 'font-size:11px;color:#f5a623;margin-bottom:10px' },
                    'wifi restart may take 60-180 s -- do not power cycle'),
                E('div', { 'style':
                    'height:5px;background:#333;border-radius:3px;' +
                    'overflow:hidden;margin-bottom:8px' }, [
                    E('div', { 'id': 'wifi7-pbar', 'style':
                        'height:100%;background:#185fa5;border-radius:3px;' +
                        'width:0%;transition:width .4s' })
                ]),
                E('div', { 'id': 'wifi7-pstat',
                    'style': 'font-size:11px;color:#888' }, 'Waiting...')
            ])
        ]);

        var applyBtn = E('button', { 'style':
            'background:#185fa5;color:#fff;border:none;border-radius:4px;' +
            'padding:6px 16px;font-size:12px;cursor:pointer' }, 'Save & apply');
        var discardBtn = E('button', { 'style':
            'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;' +
            'padding:6px 16px;font-size:12px;cursor:pointer;margin-right:8px' }, 'Discard');

        var callUciSet = rpc.declare({
            object: 'uci', method: 'set',
            params: ['config', 'section', 'values'], expect: {}
        });
        var callUciCommit = rpc.declare({
            object: 'uci', method: 'commit',
            params: ['config'], expect: {}
        });

        applyBtn.addEventListener('click', function() {
            var newSSID = ssidInput.value.trim();
            var newKey  = keyInput.value;
            var newEnc  = encSel.value;
            var newRsno = rsnoSel.value;
            if (!newSSID) { alert('SSID cannot be empty'); return; }
            if (newKey.length < 8 && newEnc !== 'owe') {
                alert('Password must be at least 8 characters'); return; }

            progressDiv.style.display = 'block';
            applyBtn.disabled   = true;
            discardBtn.disabled = true;

            var pbar  = document.getElementById('wifi7-pbar');
            var pstat = document.getElementById('wifi7-pstat');
            var steps = [
                [10, 'Writing UCI config...'],
                [25, 'Committing wireless UCI...'],
                [40, 'Running wifi restart...'],
                [60, 'Waiting for hostapd init...'],
                [80, 'Polling hostapd.ap-mld-1 status...']
            ];
            var si = 0;
            function nextStep() {
                if (si >= steps.length) return;
                pbar.style.width  = steps[si][0] + '%';
                pstat.textContent = steps[si][1];
                si++;
                if (si < steps.length) setTimeout(nextStep, 800);
            }
            nextStep();

            L.resolveDefault(callUciSet('wireless', mldSID, {
                ssid: newSSID, key: newKey,
                encryption: newEnc, encryption_rsno: newRsno
            }), null).then(function() {
                return L.resolveDefault(callUciCommit('wireless'), null);
            }).then(function() {
                return callExec('/sbin/wifi', []);
            }).then(function() {
                var tries    = 0;
                var maxTries = 60;
                function doPoll() {
                    tries++;
                    pbar.style.width  = Math.min(80 + tries, 98) + '%';
                    pstat.textContent = 'Polling hostapd (' + tries + '/' + maxTries + ')...';
                    L.resolveDefault(callHostapdStatus(), {}).then(function(st) {
                        if (st && st.status === 'ENABLED') {
                            pbar.style.width  = '100%';
                            pstat.textContent = 'Done -- WiFi active';
                            applyBtn.disabled   = false;
                            discardBtn.disabled = false;
                            setTimeout(function() {
                                progressDiv.style.display = 'none';
                                pbar.style.width = '0%';
                            }, 2000);
                        } else if (tries >= maxTries) {
                            pstat.textContent =
                                'Timeout! Try: 1) reboot   2) power cycle if no response';
                            pstat.style.color = '#e24b4a';
                            applyBtn.disabled   = false;
                            discardBtn.disabled = false;
                        } else {
                            setTimeout(doPoll, 3000);
                        }
                    });
                }
                setTimeout(doPoll, 3000);
            });
        });

        return E('div', {}, [
            infoBanner('MLD SSID, password and encryption are stored in ap_mld_1 UCI section. PMF (ieee80211w=2) is mandatory for MLD and enforced automatically.'),
            sectionBox('ap_mld_1 -- network configuration', '#1d9e75', null,
                E('div', {}, [
                    fieldRow('SSID',             ssidInput),
                    fieldRow('Password',         keyWrapMld),
                    fieldRow('Encryption',       encSel),
                    fieldRow('RSNO layer',       rsnoSel),
                    fieldRow('PMF (ieee80211w)', roValue('required (=2) -- enforced for MLD')),
                    fieldRow('MLO', (function() {
                        var mloOn = (uciData[mldSID] && uciData[mldSID]['mlo'] !== '0');
                        var mloBtn = E('button', { 'style':
                            mloOn
                                ? 'background:#3a0a0a;color:#f4a0a0;border:1px solid #e24b4a;border-radius:4px;padding:4px 12px;font-size:11px;cursor:pointer'
                                : 'background:#0a2a0a;color:#7fff7f;border:1px solid #1d9e75;border-radius:4px;padding:4px 12px;font-size:11px;cursor:pointer' },
                            mloOn ? 'Disable MLO (switch to single-band)' : 'Enable MLO (switch to multi-link)');
                        mloBtn.addEventListener('click', function() {
                            if (!confirm(
                                mloOn
                                ? 'WARNING: Disabling MLO will switch ap_mld_1 to single-band mode.\nThis requires a full reboot to take effect.\nAre you sure?'
                                : 'Enable MLO on ap_mld_1.\nThis requires a full reboot to take effect.\nAre you sure?'
                            )) return;
                            var callUciSetMlo = rpc.declare({ object:'uci', method:'set',
                                params:['config','section','values'], expect:{} });
                            var callUciCommitMlo = rpc.declare({ object:'uci', method:'commit',
                                params:['config'], expect:{} });
                            mloBtn.disabled = true;
                            mloBtn.textContent = 'Writing UCI...';
                            var newMlo = mloOn ? '0' : '1';
                            L.resolveDefault(callUciSetMlo('wireless', mldSID, { mlo: newMlo }), null)
                            .then(function() { return L.resolveDefault(callUciCommitMlo('wireless'), null); })
                            .then(function() {
                                mloBtn.textContent = 'Done -- REBOOT REQUIRED';
                                mloBtn.style.background = '#2a1a0a';
                                mloBtn.style.borderColor = '#f5a623';
                                mloBtn.style.color = '#fac775';
                            });
                        });
                        var wrap = E('div', { 'style': 'display:flex;align-items:center;gap:10px' }, [
                            roValue((mloOn ? 'mlo=1 -- enabled' : 'mlo=0 -- disabled') + '  (reboot required to change)'), 
                            mloBtn
                        ]);
                        return wrap;
                    })())
                ])),
            (function() {
                var mloOn = (uciData[mldSID] && uciData[mldSID]['mlo'] !== '0');
                if (!mloOn) return null;
                return sectionBox('Per-link info (read-only)', '#444', null,
                    E('div', {}, [
                        fieldRow('Link 0 / radio0',
                            roValue('2.4 GHz  |  addr: ' + (stat0['link_addr'] || '?') +
                                '  |  Tx max: ' + (stat0['max_txpower'] || '?') + ' dBm')),
                        fieldRow('Link 1 / radio1',
                            roValue('5 GHz  |  addr: ' + (stat1['link_addr'] || '?') +
                                '  |  Tx max: ' + (stat1['max_txpower'] || '?') + ' dBm')),
                        fieldRow('Link 2 / radio2',
                            roValue('6 GHz  |  addr: ' + (stat2['link_addr'] || '?') +
                                '  |  Tx max: ' + (stat2['max_txpower'] || '?') + ' dBm')),
                        fieldRow('MLD MAC',
                            roValue(stat0['mld_addr[0]'] || '?')),
                        fieldRow('Active links',
                            roValue('mld_allowed_links: 0x07  (2G + 5G + 6G)')),
                        fieldRow('EMLSR',
                            roValue((function() {
                                // EMLSR status from hostapd stat -- ap_mld_type indicates STR or EMLSR
                                var mldType = stat0['ap_mld_type'] || '';
                                var emlCap  = stat0['eml_capabilities'] || stat0['eml_cap'] || '';
                                if (mldType.indexOf('EMLSR') >= 0) return 'active -- ' + mldType;
                                if (emlCap) return 'capable (eml_cap=' + emlCap + ') -- not active';
                                return 'STR mode (simultaneous TX/RX on all links)';
                            })()))
                    ]));
            })(),
            E('div', { 'style':
                'display:flex;justify-content:flex-end;margin-top:4px' }, [
                discardBtn, applyBtn
            ]),
            progressDiv,
            (function() {
                // --- Add MLD network section ---
                var callUciSetMld2   = rpc.declare({ object:'uci', method:'set',
                    params:['config','section','values'], expect:{} });
                var callUciCommitMld2 = rpc.declare({ object:'uci', method:'commit',
                    params:['config'], expect:{} });

                // nextSectionName: find next free mloN name (YYH2913 pattern)
                function nextMloName() {
                    var idx = 0;
                    while (uciData['mlo' + idx]) idx++;
                    return 'mlo' + idx;
                }

                var addForm = E('div', { 'style': 'display:none;margin-top:12px' });

                var inp = function(type, val, w) {
                    return E('input', { 'type': type, 'value': val || '',
                        'style': 'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                            'color:#fff;padding:4px 8px;font-size:12px;width:' + (w || '220px') });
                };
                var newSSID  = inp('text', 'OpenWrt-MLD-2');
                var newKey   = inp('password', '');
                var newKeyTog = E('button', { 'style':
                    'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;' +
                    'padding:4px 8px;font-size:11px;cursor:pointer;margin-left:6px' }, 'Show');
                newKeyTog.addEventListener('click', function() {
                    newKey.type = newKey.type === 'password' ? 'text' : 'password';
                    newKeyTog.textContent = newKey.type === 'password' ? 'Show' : 'Hide';
                });

                var newEncSel = E('select', { 'style':
                    'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                    'color:#fff;padding:4px 8px;font-size:12px;width:220px' });
                [['sae','WPA3-SAE (recommended)'],['sae-mixed','WPA2/WPA3 mixed'],
                 ['owe','Enhanced Open (OWE)']].forEach(function(o) {
                    var opt = E('option', { 'value': o[0] }, o[1]);
                    newEncSel.appendChild(opt);
                });

                // Radio checkboxes -- multi-radio device list (luci-app-mlo pattern)
                var radioChecks = [
                    { radio: 'radio0', label: '2.4 GHz', bg: '#0a2a1a', fg: '#5dcaa5' },
                    { radio: 'radio1', label: '5 GHz',   bg: '#0a1a3a', fg: '#85b7eb' },
                    { radio: 'radio2', label: '6 GHz',   bg: '#1a0a3a', fg: '#afa9ec' }
                ].map(function(r) {
                    var chk = E('input', { 'type': 'checkbox', 'checked': true,
                        'style': 'width:15px;height:15px;cursor:pointer;margin-right:5px' });
                    var lbl = E('label', { 'style': 'font-size:12px;color:#ccc;' +
                        'display:inline-flex;align-items:center;margin-right:12px;cursor:pointer' },
                        [chk, badge(r.label, r.bg, r.fg)]);
                    return { chk: chk, radio: r.radio, el: lbl };
                });
                var radioWrap = E('div', { 'style': 'display:flex;align-items:center;flex-wrap:wrap;gap:4px' },
                    radioChecks.map(function(r) { return r.el; }));

                var addStatusSpan = E('span', { 'style': 'font-size:11px;color:#888;margin-left:10px' });
                var doAddBtn = E('button', { 'style':
                    'background:#185fa5;color:#fff;border:none;border-radius:4px;' +
                    'padding:6px 16px;font-size:12px;cursor:pointer' }, 'Create network');
                var cancelAddBtn = E('button', { 'style':
                    'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;' +
                    'padding:6px 16px;font-size:12px;cursor:pointer;margin-right:8px' }, 'Cancel');

                cancelAddBtn.addEventListener('click', function() {
                    addForm.style.display = 'none';
                    showAddBtn.style.display = '';
                });

                doAddBtn.addEventListener('click', function() {
                    var ssid = newSSID.value.trim();
                    var key  = newKey.value;
                    var enc  = newEncSel.value;
                    var selectedRadios = radioChecks
                        .filter(function(r) { return r.chk.checked; })
                        .map(function(r) { return r.radio; });

                    if (!ssid) { alert('SSID cannot be empty'); return; }
                    if (key.length < 8 && enc !== 'owe') {
                        alert('Password must be at least 8 characters'); return; }
                    if (selectedRadios.length < 2) {
                        alert('MLO requires at least 2 radios selected'); return; }

                    var newSID = nextMloName();
                    doAddBtn.disabled = true;
                    cancelAddBtn.disabled = true;
                    addStatusSpan.textContent = 'Creating ' + newSID + '...';

                    // UCI add wifi-iface + set values + commit + wifi restart
                    // Build UCI commands as single shell script
                    var devList = selectedRadios.map(function(r) {
                        return 'uci add_list wireless.' + newSID + '.device=' + r;
                    }).join('; ');
                    var uciScript = [
                        'uci set wireless.' + newSID + '=wifi-iface',
                        'uci set wireless.' + newSID + '.ssid=' + JSON.stringify(ssid),
                        'uci set wireless.' + newSID + '.key=' + JSON.stringify(key),
                        'uci set wireless.' + newSID + '.encryption=' + enc,
                        'uci set wireless.' + newSID + '.ieee80211w=2',
                        'uci set wireless.' + newSID + '.mlo=1',
                        'uci set wireless.' + newSID + '.mode=ap',
                        'uci set wireless.' + newSID + '.network=lan',
                        devList,
                        'uci commit wireless'
                    ].join(' && ');

                    addStatusSpan.textContent = 'Writing UCI (' + newSID + ')...';
                    L.resolveDefault(callExec('/bin/sh', ['-c', uciScript]), null)
                    .then(function() {
                        addStatusSpan.textContent = 'Running wifi reload...';
                        return callExec('/sbin/wifi', ['reload']);
                    })
                    .then(function() {
                        addStatusSpan.textContent = 'Done -- reload page to see new network';
                        addStatusSpan.style.color = '#1d9e75';
                        doAddBtn.disabled   = false;
                        cancelAddBtn.disabled = false;
                    });
                });

                addForm.appendChild(sectionBox('New MLD network', '#185fa5', null,
                    E('div', {}, [
                        fieldRow('SSID',       newSSID),
                        fieldRow('Password',   E('div', { 'style': 'display:flex;align-items:center' },
                            [newKey, newKeyTog])),
                        fieldRow('Encryption', newEncSel),
                        fieldRow('Radios',     radioWrap),
                        fieldRow('PMF',        roValue('required (=2) -- enforced for MLD')),
                        fieldRow('Network',    roValue('lan (default)')),
                        E('div', { 'style':
                            'display:flex;align-items:center;padding:8px 0;margin-top:4px' }, [
                            cancelAddBtn, doAddBtn, addStatusSpan
                        ])
                    ])));

                var showAddBtn = E('button', { 'style':
                    'background:#1a3a1a;color:#5dcaa5;border:1px solid #1d9e75;border-radius:4px;' +
                    'padding:6px 16px;font-size:12px;cursor:pointer;margin-top:12px' },
                    '+ Add MLD network');
                showAddBtn.addEventListener('click', function() {
                    showAddBtn.style.display = 'none';
                    addForm.style.display = '';
                });

                return E('div', {}, [showAddBtn, addForm]);
            })()
        ]);
    },

    renderRadio: function(data) {
        var uciData = data[0];
        var stat0   = parseStat(data[3].stdout || '');
        var stat1   = parseStat(data[4].stdout || '');
        var stat2   = parseStat(data[5].stdout || '');
        var radios  = {};
        var ifaces  = {};
        Object.keys(uciData).forEach(function(sid) {
            if (uciData[sid]['.type'] === 'wifi-device') radios[sid] = uciData[sid];
            if (uciData[sid]['.type'] === 'wifi-iface' && uciData[sid]['mlo'] !== '1' && uciData[sid]['mode'] === 'ap')
                ifaces[uciData[sid]['device']] = uciData[sid];
        });
        var r0 = radios['radio0'] || {};
        var r1 = radios['radio1'] || {};
        var r2 = radios['radio2'] || {};
        var i0 = ifaces['radio0'] || {};
        var i1 = ifaces['radio1'] || {};
        var i2 = ifaces['radio2'] || {};
        var ch2g = ['1','2','3','4','5','6','7','8','9','10','11','12','13','auto'];
        var ch5g = ['36','40','44','48','52','56','60','64','100','104','108','112',
                    '116','120','124','128','132','136','140','144','149','153','157','161','165','auto'];
        var ch6g = ['1','5','9','13','17','21','25','29','33','37','41','45','49','53','57','61',
                    '65','69','73','77','81','85','89','93','97','101','105','109','113','117','121',
                    '125','129','133','137','141','145','149','153','157','161','165','169','173',
                    '177','181','185','189','193','197','201','205','209','213','217','221','225',
                    '229','233','auto'];
        var ht2g = ['HT20','HT40','VHT20','VHT40','HE20','HE40','EHT20','EHT40'];
        var ht5g = ['HT20','HT40','VHT20','VHT40','VHT80','VHT160',
                    'HE20','HE40','HE80','HE160','EHT20','EHT40','EHT80','EHT160'];
        var ht6g = ['HE20','HE40','HE80','HE160','EHT20','EHT40','EHT80','EHT160','EHT320'];
        var countries = ['AD','AE','AF','AG','AL','AM','AR','AS','AT','AU','AZ','BA','BB','BD',
            'BE','BF','BG','BH','BN','BO','BR','BS','BT','BW','BY','BZ','CA','CD','CF','CG',
            'CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CY','CZ','DE','DJ','DK','DM',
            'DO','DZ','EC','EE','EG','ES','ET','FI','FJ','FM','FR','GA','GB','GD','GE','GH',
            'GI','GL','GM','GN','GQ','GR','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID',
            'IE','IL','IN','IQ','IR','IS','IT','JM','JO','JP','KE','KG','KH','KI','KM','KN',
            'KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
            'MA','MC','MD','ME','MG','MK','ML','MM','MN','MO','MP','MR','MT','MU','MV','MW',
            'MX','MY','MZ','NA','NC','NE','NG','NI','NL','NO','NP','NR','NZ','OM','PA','PE',
            'PG','PH','PK','PL','PR','PT','PW','PY','QA','RO','RS','RU','RW','SA','SB','SC',
            'SD','SE','SG','SI','SK','SL','SN','SR','SV','SZ','TD','TG','TH','TJ','TM','TN',
            'TO','TR','TT','TW','TZ','UA','UG','US','UY','UZ','VC','VE','VN','VU','WS','YE',
            'ZA','ZM','ZW'];
        function mkSel(opts,cur,w) {
            var sel=E('select',{'style':'background:#1a1a2e;border:1px solid #444;border-radius:4px;color:#fff;padding:4px 8px;font-size:12px;width:'+(w||'180px')});
            opts.forEach(function(o){var opt=E('option',{'value':o});opt.textContent=o;if(o===cur)opt.selected=true;sel.appendChild(opt);});
            return sel;
        }
        function mkChk(checked) { return E('input',{'type':'checkbox','checked':checked?true:null,'style':'width:16px;height:16px;cursor:pointer'}); }
        function chkRow(label,el,note) {
            var row=E('div',{'style':'display:grid;grid-template-columns:170px 40px 1fr;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #2a2a3a;font-size:12px'});
            var lbl=E('div',{'style':'color:#888'});lbl.textContent=label;
            var nd=E('div',{'style':'font-size:11px;color:#666'});nd.textContent=note||'';
            row.appendChild(lbl);row.appendChild(el);row.appendChild(nd);return row;
        }
        function radioCard(title,bg,fg,rows) {
            return E('div',{'style':'border:1px solid #444;border-radius:6px;overflow:hidden;margin-bottom:10px'},[
                E('div',{'style':'background:#16213e;padding:7px 12px;font-size:13px;font-weight:bold'},[badge(title,bg,fg)]),
                E('div',{'style':'padding:10px 12px'},rows)
            ]);
        }
        function mkTxp(cur,maxDbm) {
            var inp=E('input',{'type':'number','min':'1','max':String(maxDbm),'value':cur||'','placeholder':'auto',
                'style':'background:#1a1a2e;border:1px solid #444;border-radius:4px;color:#fff;padding:4px 8px;font-size:12px;width:80px'});
            var wrap=E('div',{'style':'display:flex;align-items:center;gap:8px'},[inp,
                E('span',{'style':'font-size:11px;color:#666'},'dBm  (1-'+maxDbm+', empty = regulatory max)')]);
            wrap._inp=inp; return wrap;
        }
        var r0ch=mkSel(ch2g,r0['channel']||'auto'), r0ht=mkSel(ht2g,r0['htmode']||'EHT40');
        function mkDisChk(checked, radioName) {
            var chk = mkChk(checked);
            chk.addEventListener('change', function() {
                if (chk.checked && !confirm(
                    'WARNING: Disabling ' + radioName + ' is destructive!\n\n' +
                    'MLO link IDs will renumber. Re-enabling requires a full power cycle.\n\n' +
                    'Are you sure you want to disable ' + radioName + '?'
                )) { chk.checked = false; }
            });
            return chk;
        }
        var r0dis=mkDisChk(r0['disabled']==='1','radio0 (2.4 GHz)'), r0noscan=mkChk(r0['noscan']==='1');
        var r0txp=mkTxp(r0['txpower'],20);
        var r1ch=mkSel(ch5g,r1['channel']||'auto'), r1ht=mkSel(ht5g,r1['htmode']||'EHT160');
        var r1dis=mkDisChk(r1['disabled']==='1','radio1 (5 GHz)'), r1bgr=mkChk(r1['background_radar']==='1');
        var r1txp=mkTxp(r1['txpower'],23);
        var r2ch=mkSel(ch6g,r2['channel']||'37'), r2ht=mkSel(ht6g,r2['htmode']||'EHT320');
        var r2dis=mkDisChk(r2['disabled']==='1','radio2 (6 GHz)'), r2lpi=mkChk(r2['lpi_enable']==='1');
        var r2noscan=mkChk(r2['noscan']==='1'), r2txp=mkTxp(r2['txpower'],23);
        // Advanced MTK params -- shared across all radios
        var r0twt=mkChk(r0['he_twt_responder']!=='0');  // default on
        var r1twt=mkChk(r1['he_twt_responder']!=='0');
        var r2twt=mkChk(r2['he_twt_responder']!=='0');
        var r0legacy=mkChk(r0['legacy_rates']!=='0');   // default on
        // sr_enable / etxbfen / mu_onoff -- radio0 only (shared wiphy)
        var srEnable=mkChk(r0['sr_enable']!=='0');      // default on
        var etxbfen=mkChk(r0['etxbfen']!=='0');         // default on
        var countrySel=mkSel(countries,r0['country']||'CZ','120px');
        var skuInput=E('input',{'type':'number','min':'0','max':'99','value':r0['sku_idx']||'0',
            'style':'background:#1a1a2e;border:1px solid #444;border-radius:4px;color:#fff;padding:4px 8px;font-size:12px;width:80px'});
        var dfsChs={'52':1,'56':1,'60':1,'64':1,'100':1,'104':1,'108':1,'112':1,
                    '116':1,'120':1,'124':1,'128':1,'132':1,'136':1,'140':1,'144':1};
        var dfsNote=E('span',{'style':'font-size:11px;color:#f5a623;margin-left:8px'});
        var dfsWeatherChs={'120':1,'124':1,'128':1};
        function updateDfs(){
            var ch=r1ch.value;
            if(dfsWeatherChs[ch]){dfsNote.style.color='#e24b4a';dfsNote.textContent='DFS weather radar -- CAC 10 min (ETSI)';}
            else if(dfsChs[ch]){dfsNote.style.color='#f5a623';dfsNote.textContent='DFS -- CAC 60s required before TX';}
            else{dfsNote.textContent='';}
        }
        r1ch.addEventListener('change',updateDfs); updateDfs();
        var r1chWrap=E('div',{'style':'display:flex;align-items:center'});
        r1chWrap.appendChild(r1ch); r1chWrap.appendChild(dfsNote);
        var callUciSet=rpc.declare({object:'uci',method:'set',params:['config','section','values'],expect:{}});
        var callUciCommit=rpc.declare({object:'uci',method:'commit',params:['config'],expect:{}});
        var progressDiv=E('div',{'style':'display:none;margin-top:12px'},[
            E('div',{'style':'background:#1a1a2e;border:1px solid #444;border-radius:6px;padding:12px 14px;text-align:center'},[
                E('div',{'style':'font-size:13px;font-weight:bold;margin-bottom:6px'},'Applying radio configuration...'),
                E('div',{'style':'font-size:11px;color:#f5a623;margin-bottom:10px'},'wifi restart may take 60-180 s -- do not power cycle'),
                E('div',{'style':'height:5px;background:#333;border-radius:3px;overflow:hidden;margin-bottom:8px'},[
                    E('div',{'id':'wifi7-radio-pbar','style':'height:100%;background:#185fa5;border-radius:3px;width:0%;transition:width .4s'})]),
                E('div',{'id':'wifi7-radio-pstat','style':'font-size:11px;color:#888'},'Waiting...')
            ])
        ]);
        var applyBtn=E('button',{'style':'background:#185fa5;color:#fff;border:none;border-radius:4px;padding:6px 16px;font-size:12px;cursor:pointer'},'Save & apply');
        var discardBtn=E('button',{'style':'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;padding:6px 16px;font-size:12px;cursor:pointer;margin-right:8px'},'Discard');
        discardBtn.addEventListener('click',function(){
            r0ch.value=r0['channel']||'auto'; r0ht.value=r0['htmode']||'EHT40';
            r0dis.checked=r0['disabled']==='1'; r0noscan.checked=r0['noscan']==='1'; r0txp._inp.value=r0['txpower']||'';
            r1ch.value=r1['channel']||'auto'; r1ht.value=r1['htmode']||'EHT160';
            r1dis.checked=r1['disabled']==='1'; r1bgr.checked=r1['background_radar']==='1'; r1txp._inp.value=r1['txpower']||'';
            r2ch.value=r2['channel']||'37'; r2ht.value=r2['htmode']||'EHT320';
            r2dis.checked=r2['disabled']==='1'; r2lpi.checked=r2['lpi_enable']==='1';
            r2noscan.checked=r2['noscan']==='1'; r2txp._inp.value=r2['txpower']||'';
            countrySel.value=r0['country']||'CZ'; skuInput.value=r0['sku_idx']||'0'; updateDfs();
            r0twt.checked=r0['he_twt_responder']!=='0'; r1twt.checked=r1['he_twt_responder']!=='0';
            r2twt.checked=r2['he_twt_responder']!=='0'; r0legacy.checked=r0['legacy_rates']!=='0';
            srEnable.checked=r0['sr_enable']!=='0'; etxbfen.checked=r0['etxbfen']!=='0';
        });
        applyBtn.addEventListener('click',function(){
            var country=countrySel.value;
            // Country change requires full reboot -- wifi restart is not sufficient
            if (country !== (r0['country']||'CZ')) {
                if (!confirm('Country code changed to ' + country + '.\n\n' +
                    'WARNING: Country change requires a full REBOOT to take effect.\n' +
                    'wifi restart alone is NOT sufficient.\n\n' +
                    'Proceed? (Settings will be saved, then you must reboot manually.)')) return;
            }
            progressDiv.style.display='block'; applyBtn.disabled=true; discardBtn.disabled=true;
            var pbar=document.getElementById('wifi7-radio-pbar');
            var pstat=document.getElementById('wifi7-radio-pstat');
            var steps=[[10,'Writing radio0...'],[25,'Writing radio1...'],[40,'Writing radio2...'],
                       [55,'Committing UCI...'],[70,'Running wifi restart...'],[80,'Polling hostapd...']];
            var si=0;
            function nextStep(){if(si>=steps.length)return;pbar.style.width=steps[si][0]+'%';
                pstat.textContent=steps[si][1];si++;if(si<steps.length)setTimeout(nextStep,600);}
            nextStep();
            var skuIdx=skuInput.value||'0';
            // vif_txpower goes to iface, not device -- find iface sids
            var i0sid='', i1sid='', i2sid='';
            Object.keys(uciData).forEach(function(sid) {
                var s=uciData[sid];
                if(s['.type']==='wifi-iface'&&s['mlo']!=='1'&&s['mode']==='ap') {
                    if(s['device']==='radio0') i0sid=sid;
                    if(s['device']==='radio1') i1sid=sid;
                    if(s['device']==='radio2') i2sid=sid;
                }
            });
            var txpWrites = [];
            if(r0txp._inp.value && i0sid) txpWrites.push(L.resolveDefault(callUciSet('wireless',i0sid,{vif_txpower:r0txp._inp.value}),null));
            if(r1txp._inp.value && i1sid) txpWrites.push(L.resolveDefault(callUciSet('wireless',i1sid,{vif_txpower:r1txp._inp.value}),null));
            if(r2txp._inp.value && i2sid) txpWrites.push(L.resolveDefault(callUciSet('wireless',i2sid,{vif_txpower:r2txp._inp.value}),null));
            Promise.all([
                L.resolveDefault(callUciSet('wireless','radio0',{channel:r0ch.value,htmode:r0ht.value,
                    disabled:r0dis.checked?'1':'0',noscan:r0noscan.checked?'1':'0',country:country,sku_idx:skuIdx,
                    he_twt_responder:r0twt.checked?'1':'0',legacy_rates:r0legacy.checked?'1':'0',
                    sr_enable:srEnable.checked?'1':'0',etxbfen:etxbfen.checked?'1':'0'}),null),
                L.resolveDefault(callUciSet('wireless','radio1',{channel:r1ch.value,htmode:r1ht.value,
                    disabled:r1dis.checked?'1':'0',background_radar:r1bgr.checked?'1':'0',country:country,sku_idx:skuIdx,
                    he_twt_responder:r1twt.checked?'1':'0'}),null),
                L.resolveDefault(callUciSet('wireless','radio2',{channel:r2ch.value,htmode:r2ht.value,
                    disabled:r2dis.checked?'1':'0',lpi_enable:r2lpi.checked?'1':'0',noscan:r2noscan.checked?'1':'0',
                    country:country,sku_idx:skuIdx,he_twt_responder:r2twt.checked?'1':'0'}),null)
            ].concat(txpWrites)
            ).then(function(){return L.resolveDefault(callUciCommit('wireless'),null);})
            .then(function(){return callExec('/sbin/wifi',[]);})
            .then(function(){
                var tries=0,maxTries=60;
                function doPoll(){tries++;pbar.style.width=Math.min(80+tries,98)+'%';
                    pstat.textContent='Polling hostapd ('+tries+'/'+maxTries+')...';
                    L.resolveDefault(callHostapdStatus(),{}).then(function(st){
                        if(st&&st.status==='ENABLED'){pbar.style.width='100%';pstat.textContent='Done -- WiFi active';
                            applyBtn.disabled=false;discardBtn.disabled=false;
                            setTimeout(function(){progressDiv.style.display='none';pbar.style.width='0%';},2000);
                        } else if(tries>=maxTries){pstat.textContent='Timeout! Try: 1) reboot   2) power cycle';
                            pstat.style.color='#e24b4a';applyBtn.disabled=false;discardBtn.disabled=false;
                        } else {setTimeout(doPoll,3000);}
                    });
                }
                setTimeout(doPoll,3000);
            });
        });
        return E('div',{},[
            warnBanner('Country and sku_idx must always be written together and apply to all 3 radios. Country change requires a full reboot -- wifi restart is not sufficient.'),
            sectionBox('Global -- country & SKU','#f5a623',null,E('div',{},[
                fieldRow('Country code',countrySel),
                fieldRow('sku_idx',E('div',{'style':'display:flex;align-items:center;gap:10px'},[skuInput,
                    E('span',{'style':'font-size:11px;color:#888'},'0 = default regulation table')])),
                fieldRow('Note',roValue('Written to radio0 + radio1 + radio2 simultaneously'))
            ])),
            radioCard('2.4 GHz -- radio0','#0a2a1a','#5dcaa5',[
                fieldRow('Channel',E('div',{'style':'display:flex;align-items:center;gap:8px'},[
                    r0ch,
                    (r0['channel']==='auto'||!r0['channel'])
                        ? E('span',{'style':'font-size:11px;color:#888'},
                            stat0['channel'] ? 'ACS selected: CH ' + stat0['channel'] : 'ACS pending')
                        : E('span',{},'')])),
                fieldRow('HT mode',r0ht),fieldRow('TX power',r0txp),
                chkRow('Disabled',r0dis,''),chkRow('noscan',r0noscan,'skip channel survey -- disabling may cause slow restart (2-3 min) and channel width reduction'),
                chkRow('he_twt_responder',r0twt,'TWT -- IoT power saving (default: on)'),
                chkRow('legacy_rates',r0legacy,'2.4G legacy rate support (default: on)')]),
            radioCard('5 GHz -- radio1','#0a1a3a','#85b7eb',[
                fieldRow('Channel',E('div',{'style':'display:flex;align-items:center;gap:8px'},[
                    r1chWrap,
                    (r1['channel']==='auto'||!r1['channel'])
                        ? E('span',{'style':'font-size:11px;color:#888'},
                            stat1['channel'] ? 'ACS selected: CH ' + stat1['channel'] : 'ACS pending')
                        : E('span',{},'')])),
                fieldRow('HT mode',r1ht),fieldRow('TX power',r1txp),
                chkRow('Disabled',r1dis,''),chkRow('background_radar',r1bgr,'CAC in background -- keeps AP up during DFS'),
                chkRow('he_twt_responder',r1twt,'TWT -- IoT power saving (default: on)')]),
            radioCard('6 GHz -- radio2','#1a0a3a','#afa9ec',[
                fieldRow('Channel',r2ch),fieldRow('HT mode',r2ht),fieldRow('TX power',r2txp),
                chkRow('Disabled',r2dis,''),chkRow('lpi_enable',r2lpi,'Low Power Indoor -- required in some countries'),
                chkRow('noscan',r2noscan,'6G: normally 0 (PSC channels) -- disabling may cause slow restart'),
                chkRow('he_twt_responder',r2twt,'TWT -- IoT power saving (default: on)')]),
            sectionBox('Advanced -- shared (single wiphy)','#444',null,E('div',{},[
                chkRow('sr_enable',srEnable,'Spatial Reuse / BSS Coloring (default: on)'),
                chkRow('etxbfen',etxbfen,'Explicit TX beamforming (default: on)'),
                fieldRow('Note',roValue('sr_enable + etxbfen apply to all bands via single wiphy (phy0)'))
            ])),
            E('div',{'style':'display:flex;justify-content:flex-end;margin-top:4px'},[discardBtn,applyBtn]),
            progressDiv
        ]);
    },

    renderLegacy: function(data) {
        var uciData = data[0];
        var bandMeta = {
            'radio0': { band: '2.4G', bg: '#0a2a1a', fg: '#5dcaa5' },
            'radio1': { band: '5G',   bg: '#0a1a3a', fg: '#85b7eb' },
            'radio2': { band: '6G',   bg: '#1a0a3a', fg: '#afa9ec' }
        };
        var legacyIfaces = [];
        Object.keys(uciData).sort().forEach(function(sid) {
            var s = uciData[sid];
            if (s['.type']==='wifi-iface' && s['mlo']!=='1' && s['mode']==='ap') {
                var meta = bandMeta[s['device']] || { band: s['device'], bg:'#222', fg:'#aaa' };
                legacyIfaces.push({ sid:sid, s:s, meta:meta });
            }
        });

        function mkChk(checked) {
            return E('input', { 'type':'checkbox', 'checked': checked ? true : null,
                'style': 'width:16px;height:16px;cursor:pointer' });
        }

        var callUciSet = rpc.declare({ object:'uci', method:'set',
            params:['config','section','values'], expect:{} });
        var callUciCommit = rpc.declare({ object:'uci', method:'commit',
            params:['config'], expect:{} });
        var callUciAdd = rpc.declare({ object:'uci', method:'add',
            params:['config','type'], expect:{ section:'' } });
        var callUciDelete = rpc.declare({ object:'uci', method:'delete',
            params:['config','section'], expect:{} });

        var inputStyle = 'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                         'color:#fff;padding:4px 8px;font-size:12px;width:220px';

        var container = E('div', {});

        function rebuildCards() {
            while (container.firstChild) container.removeChild(container.firstChild);

            // Add network button
            var addBtn = E('button', { 'style':
                'background:#185fa5;color:#fff;border:none;border-radius:4px;' +
                'padding:7px 18px;font-size:13px;cursor:pointer;margin-bottom:14px' },
                '+ Add network');

            // Add network dialog (hidden initially)
            var dialog = E('div', { 'style': 'display:none' });

            addBtn.addEventListener('click', function() {
                addBtn.style.display = 'none';
                dialog.style.display = '';
            });

            // Dialog fields
            var newSSID = E('input', { 'type':'text', 'placeholder':'My Network',
                'style': inputStyle });
            var newBand = E('select', { 'style':
                'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                'color:#fff;padding:4px 8px;font-size:12px;width:120px' });
            [['radio0','2.4 GHz'],['radio1','5 GHz'],['radio2','6 GHz']].forEach(function(o) {
                var opt = E('option', { 'value': o[0] }); opt.textContent = o[1];
                newBand.appendChild(opt);
            });
            var newKey = E('input', { 'type':'password', 'placeholder':'min 8 characters',
                'style': inputStyle });
            var newKeyToggle = E('button', { 'style':
                'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;' +
                'padding:4px 8px;font-size:11px;cursor:pointer;margin-left:6px' }, 'Show');
            newKeyToggle.addEventListener('click', function() {
                newKey.type = newKey.type === 'password' ? 'text' : 'password';
                newKeyToggle.textContent = newKey.type === 'password' ? 'Show' : 'Hide';
            });

            // Advanced settings (collapsed by default)
            var advVisible = false;
            var advToggle = E('div', { 'style':
                'font-size:12px;color:#85b7eb;cursor:pointer;margin:8px 0;' +
                'display:flex;align-items:center;gap:6px;user-select:none' });
            var advArrow = E('span', {}, '▶');
            advToggle.appendChild(advArrow);
            advToggle.appendChild(E('span', {}, ' Advanced settings'));

            // Encryption select for advanced
            var newEnc = E('select', { 'style':
                'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                'color:#fff;padding:4px 8px;font-size:12px;width:220px' });
            function updateEncOpts() {
                while (newEnc.firstChild) newEnc.removeChild(newEnc.firstChild);
                var opts = newBand.value === 'radio2'
                    ? [['sae','WPA3-SAE (required on 6 GHz)'],['sae-mixed','WPA2/WPA3 mixed']]
                    : [['psk2','WPA2-PSK (recommended)'],['psk-mixed','WPA/WPA2 mixed'],
                       ['sae-mixed','WPA2/WPA3 mixed'],['sae','WPA3-SAE'],['none','Open (no password)']];
                opts.forEach(function(o) {
                    var opt = E('option',{'value':o[0]}); opt.textContent = o[1];
                    newEnc.appendChild(opt);
                });
                // hide key if open
                newKey.parentNode && (newKey.parentNode.style.display =
                    newEnc.value === 'none' ? 'none' : '');
            }
            newBand.addEventListener('change', updateEncOpts);
            newEnc.addEventListener('change', function() {
                newKey.parentNode && (newKey.parentNode.style.display =
                    newEnc.value === 'none' ? 'none' : '');
            });
            updateEncOpts();

            // htmode select
            var htOpts = {
                'radio0': ['EHT40','EHT20','HE40','HE20','HT40','HT20'],
                'radio1': ['EHT160','EHT80','EHT40','HE160','HE80','VHT160','VHT80'],
                'radio2': ['EHT320','EHT160','EHT80','HE160','HE80']
            };
            var newHt = E('select', { 'style':
                'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                'color:#fff;padding:4px 8px;font-size:12px;width:220px' });
            function updateHtOpts() {
                while (newHt.firstChild) newHt.removeChild(newHt.firstChild);
                (htOpts[newBand.value] || ['auto']).forEach(function(o) {
                    var opt = E('option',{'value':o}); opt.textContent = o;
                    newHt.appendChild(opt);
                });
            }
            newBand.addEventListener('change', updateHtOpts);
            updateHtOpts();

            var advBox = E('div', { 'style': 'display:none;border:1px solid #2a2a3a;' +
                'border-radius:4px;padding:10px;margin:6px 0;background:#0d0d1a' });
            advBox.appendChild(fieldRow('Encryption', newEnc));
            advBox.appendChild(fieldRow('HT mode', newHt));

            advToggle.addEventListener('click', function() {
                advVisible = !advVisible;
                advBox.style.display = advVisible ? '' : 'none';
                advArrow.textContent = advVisible ? '▼' : '▶';
            });

            var keyWrapNew = E('div', { 'style': 'display:flex;align-items:center' },
                [newKey, newKeyToggle]);

            var addStatusSpan = E('span', { 'style': 'font-size:11px;margin-left:8px' });
            var confirmBtn = E('button', { 'style':
                'background:#185fa5;color:#fff;border:none;border-radius:4px;' +
                'padding:5px 14px;font-size:12px;cursor:pointer' }, 'Add network');
            var cancelBtn = E('button', { 'style':
                'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;' +
                'padding:5px 14px;font-size:12px;cursor:pointer;margin-right:8px' }, 'Cancel');

            cancelBtn.addEventListener('click', function() {
                dialog.style.display = 'none';
                addBtn.style.display = '';
                newSSID.value = ''; newKey.value = '';
            });

            confirmBtn.addEventListener('click', function() {
                var ssid = newSSID.value.trim();
                var enc  = newEnc.value;
                var key  = newKey.value;
                var dev  = newBand.value;
                var ht   = newHt.value;
                if (!ssid) { alert('SSID cannot be empty'); return; }
                if (enc !== 'none' && key.length < 8) {
                    alert('Password must be at least 8 characters'); return; }
                if (dev === 'radio2' && enc === 'none') {
                    alert('Open network not allowed on 6 GHz'); return; }

                confirmBtn.disabled = true; cancelBtn.disabled = true;
                addStatusSpan.textContent = 'Creating...';
                addStatusSpan.style.color = '#f5a623';

                // Generate section name: wifinet_<timestamp>
                var newSid = 'wifinet_' + Math.floor(Date.now()/1000);
                var vals = { device: dev, network: 'lan', mode: 'ap',
                             ssid: ssid, encryption: enc, htmode: ht,
                             disabled: '0', mbo: '0' };
                if (enc !== 'none') vals.key = key;
                // 6G extras
                if (dev === 'radio2') {
                    vals.sae_pwe = '2'; vals.ieee80211w = '2';
                    if (enc === 'sae') vals.mbo = '1';
                }

                L.resolveDefault(callUciAdd('wireless', 'wifi-iface'), null)
                .then(function(r) {
                    var sid = (r && r.section) ? r.section : newSid;
                    return L.resolveDefault(callUciSet('wireless', sid, vals), null)
                        .then(function() { return sid; });
                }).then(function() {
                    addStatusSpan.textContent = 'Committing...';
                    return L.resolveDefault(callUciCommit('wireless'), null);
                }).then(function() {
                    addStatusSpan.textContent = 'Running wifi restart...';
                    return callExec('/sbin/wifi', []);
                }).then(function() {
                    addStatusSpan.textContent = 'Done';
                    addStatusSpan.style.color = '#1d9e75';
                    dialog.style.display = 'none';
                    addBtn.style.display = '';
                    newSSID.value = ''; newKey.value = '';
                    confirmBtn.disabled = false; cancelBtn.disabled = false;
                    setTimeout(function() { addStatusSpan.textContent = ''; }, 3000);
                });
            });

            var dialogInner = E('div', { 'style':
                'border:1px solid #444;border-radius:6px;padding:14px;' +
                'background:#1a1a2e;margin-bottom:14px' });
            dialogInner.appendChild(E('div', { 'style':
                'font-size:13px;font-weight:bold;margin-bottom:10px;color:#fff' },
                'Add new network'));
            dialogInner.appendChild(fieldRow('SSID', newSSID));
            dialogInner.appendChild(fieldRow('Band', newBand));
            dialogInner.appendChild(fieldRow('Password', keyWrapNew));
            dialogInner.appendChild(advToggle);
            dialogInner.appendChild(advBox);
            dialogInner.appendChild(E('div', { 'style':
                'display:flex;align-items:center;margin-top:10px' },
                [cancelBtn, confirmBtn, addStatusSpan]));
            dialog.appendChild(dialogInner);

            container.appendChild(addBtn);
            container.appendChild(dialog);

            // Build existing network cards
            legacyIfaces.forEach(function(ifc) {
                var sid  = ifc.sid;
                var s    = ifc.s;
                var meta = ifc.meta;
                var is6g = s['device'] === 'radio2';

                var ssidInp = E('input', { 'type':'text', 'value':s['ssid']||'',
                    'style':inputStyle });
                var keyInp = E('input', { 'type':'password', 'value':s['key']||'',
                    'style':inputStyle });
                var keyToggleLeg = E('button', { 'style':
                    'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;' +
                    'padding:4px 8px;font-size:11px;cursor:pointer;margin-left:6px' }, 'Show');
                keyToggleLeg.addEventListener('click', function() {
                    keyInp.type = keyInp.type === 'password' ? 'text' : 'password';
                    keyToggleLeg.textContent = keyInp.type === 'password' ? 'Show' : 'Hide';
                });
                var keyInpWrap = E('div', { 'style':'display:flex;align-items:center' },
                    [keyInp, keyToggleLeg]);
                var keyWrap = E('div', {});
                keyWrap.appendChild(fieldRow('Password', keyInpWrap));

                var encOpts = is6g
                    ? [['sae','WPA3-SAE (required on 6 GHz)'],['sae-mixed','WPA2/WPA3 mixed'],
                       ['owe','Enhanced Open (OWE)']]
                    : [['none','Open (no password)'],['psk2','WPA2-PSK'],
                       ['psk-mixed','WPA/WPA2 mixed'],['sae-mixed','WPA2/WPA3 mixed'],
                       ['sae','WPA3-SAE'],['owe','Enhanced Open (OWE)'],
                       ['owe-transition','OWE Transition (Open+OWE simultaneously)']];
                var encSel = E('select', { 'style':inputStyle });
                encOpts.forEach(function(o) {
                    var opt = E('option',{'value':o[0]}); opt.textContent = o[1];
                    if ((s['encryption']||'none') === o[0]) opt.selected = true;
                    encSel.appendChild(opt);
                });
                var disChk = E('input', { 'type':'checkbox',
                    'checked':s['disabled']==='1'?true:null,
                    'style':'width:16px;height:16px;cursor:pointer' });
                var statusSpan = E('span', { 'style':'font-size:11px;color:#888;margin-left:8px' });

                function applyKeyVis() {
                    var noKey = encSel.value === 'none' || encSel.value === 'owe' ||
                                encSel.value === 'owe-transition';
                    keyWrap.style.display = noKey ? 'none' : '';
                }
                encSel.addEventListener('change', applyKeyVis);
                applyKeyVis();

                var saveBtn = E('button', { 'style':
                    'background:#185fa5;color:#fff;border:none;border-radius:4px;' +
                    'padding:5px 14px;font-size:12px;cursor:pointer' }, 'Save & apply');
                var discardBtn = E('button', { 'style':
                    'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;' +
                    'padding:5px 14px;font-size:12px;cursor:pointer;margin-right:8px' }, 'Discard');
                var removeBtn = E('button', { 'style':
                    'background:#3a0a0a;color:#f4a0a0;border:1px solid #e24b4a;' +
                    'border-radius:4px;padding:5px 10px;font-size:11px;cursor:pointer;' +
                    'margin-left:auto' }, 'Remove');

                discardBtn.addEventListener('click', function() {
                    ssidInp.value = s['ssid']||''; keyInp.value = s['key']||'';
                    disChk.checked = s['disabled']==='1';
                    Array.prototype.forEach.call(encSel.options, function(o) {
                        o.selected = o.value === (s['encryption']||'none'); });
                    var origNet = s['network']||'lan';
                    var knownNets = ['lan','wan','guest','iot'];
                    netSel.value = knownNets.indexOf(origNet) >= 0 ? origNet : 'custom';
                    netCustom.value = knownNets.indexOf(origNet) < 0 ? origNet : '';
                    netCustom.style.display = netSel.value === 'custom' ? 'inline-block' : 'none';
                    hiddenChk.checked = s['hidden']==='1';
                    isolateChk.checked = s['isolate']==='1';
                    wmmChk.checked = s['wmm']!=='0';
                    maxassocInp.value = s['maxassoc']||'';
                    applyKeyVis(); statusSpan.textContent = '';
                });

                saveBtn.addEventListener('click', function() {
                    var newSSIDv = ssidInp.value.trim();
                    var newEnc  = encSel.value;
                    var newKey  = keyInp.value;
                    if (!newSSIDv) { alert('SSID cannot be empty'); return; }
                    if (newEnc !== 'none' && newKey.length < 8) {
                        alert('Password must be at least 8 characters'); return; }
                    saveBtn.disabled = true; discardBtn.disabled = true;
                    statusSpan.textContent = 'Writing UCI...';
                    statusSpan.style.color = '#f5a623';
                    var netVal = netSel.value === 'custom'
                        ? netCustom.value.trim() : netSel.value;
                    var vals = { ssid:newSSIDv, encryption:newEnc,
                                 disabled:disChk.checked?'1':'0',
                                 network: netVal || 'lan',
                                 hidden:   hiddenChk.checked?'1':'0',
                                 isolate:  isolateChk.checked?'1':'0',
                                 wmm:      wmmChk.checked?'1':'0' };
                    if (maxassocInp.value) vals.maxassoc = maxassocInp.value;
                    if (newEnc !== 'none') vals.key = newKey;
                    L.resolveDefault(callUciSet('wireless', sid, vals), null)
                    .then(function() {
                        statusSpan.textContent = 'Committing...';
                        return L.resolveDefault(callUciCommit('wireless'), null);
                    }).then(function() {
                        statusSpan.textContent = 'Running wifi restart...';
                        return callExec('/sbin/wifi', []);
                    }).then(function() {
                        statusSpan.textContent = 'Done';
                        statusSpan.style.color = '#1d9e75';
                        saveBtn.disabled = false; discardBtn.disabled = false;
                        setTimeout(function() { statusSpan.textContent = ''; }, 3000);
                    });
                });

                removeBtn.addEventListener('click', function() {
                    // Count how many non-MLD interfaces exist on this radio
                    var siblingsOnRadio = Object.keys(uciData).filter(function(k) {
                        var x = uciData[k];
                        return x['.type']==='wifi-iface' && x['mlo']!=='1' &&
                               x['mode']==='ap' && x['device']===s['device'] && k !== sid;
                    }).length;
                    // Check if MLD uses this radio
                    var mldUsesRadio = Object.keys(uciData).some(function(k) {
                        var x = uciData[k];
                        return x['.type']==='wifi-iface' && x['mlo']==='1' &&
                               (x['device'] === s['device'] ||
                               (Array.isArray(x['device']) && x['device'].indexOf(s['device']) >= 0) ||
                               (typeof x['device'] === 'string' && x['device'].indexOf(s['device']) >= 0));
                    });
                    var warn = '';
                    if (siblingsOnRadio === 0)
                        warn += '\n\nWARNING: This is the last legacy interface on ' + s['device'] + '.';
                    if (mldUsesRadio)
                        warn += '\n\nWARNING: MLD network (ap_mld_1) uses ' + s['device'] +
                            '. Removing this interface may cause the MLD link on this band to stop working!';
                    if (!confirm('Remove network "' + (s['ssid']||sid) + '"?' + warn +
                        '\n\nThis will delete the UCI section and restart WiFi.')) return;
                    removeBtn.disabled = true;
                    statusSpan.textContent = 'Removing...';
                    statusSpan.style.color = '#e24b4a';
                    L.resolveDefault(callUciDelete('wireless', sid), null)
                    .then(function() {
                        return L.resolveDefault(callUciCommit('wireless'), null);
                    }).then(function() {
                        return callExec('/sbin/wifi', []);
                    }).then(function() {
                        statusSpan.textContent = 'Done -- removed';
                        // Remove card from DOM
                        var card = removeBtn.closest ? removeBtn.closest('.net-card') : null;
                        if (card) card.parentNode.removeChild(card);
                    });
                });

                // Network bridge selector
                var netSel = E('select', { 'style':
                    'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                    'color:#fff;padding:4px 8px;font-size:12px;width:160px' });
                ['lan','wan','guest','iot','custom'].forEach(function(n) {
                    var opt = E('option', { 'value': n }, n);
                    if ((s['network'] || 'lan') === n) opt.selected = true;
                    netSel.appendChild(opt);
                });
                // Custom network input -- shown when 'custom' selected
                var netCustom = E('input', { 'type':'text',
                    'placeholder': 'network name',
                    'value': ['lan','wan','guest','iot'].indexOf(s['network']||'lan') < 0
                        ? (s['network']||'') : '',
                    'style': 'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                        'color:#fff;padding:4px 8px;font-size:12px;width:120px;' +
                        'margin-left:6px;display:' +
                        (['lan','wan','guest','iot'].indexOf(s['network']||'lan') < 0
                            ? 'inline-block' : 'none') });
                netSel.addEventListener('change', function() {
                    netCustom.style.display = netSel.value === 'custom' ? 'inline-block' : 'none';
                    if (netSel.value !== 'custom') netCustom.value = '';
                });
                var netWrap = E('div', { 'style': 'display:flex;align-items:center' },
                    [netSel, netCustom]);

                // Additional MTK params
                var hiddenChk  = mkChk(s['hidden']==='1');
                var isolateChk = mkChk(s['isolate']==='1');
                var wmmChk     = mkChk(s['wmm']!=='0'); // default on
                var maxassocInp = E('input', { 'type':'number', 'min':'1', 'max':'255',
                    'value': s['maxassoc']||'', 'placeholder':'unlimited',
                    'style':'background:#1a1a2e;border:1px solid #444;border-radius:4px;' +
                        'color:#fff;padding:4px 8px;font-size:12px;width:90px' });
                var maxassocClear = E('button', { 'style':
                    'background:#2a2a3a;color:#aaa;border:1px solid #444;border-radius:4px;' +
                    'padding:3px 8px;font-size:11px;cursor:pointer;margin-left:5px' }, 'unlimited');
                maxassocClear.addEventListener('click', function() { maxassocInp.value = ''; });

                var bodyRows = [
                    fieldRow('SSID', ssidInp),
                    fieldRow('Encryption', encSel),
                    keyWrap,
                    fieldRow('Network bridge', netWrap),
                    fieldRow('Hidden SSID', E('div', {'style':'display:flex;align-items:center;gap:8px'},
                        [hiddenChk, E('span',{'style':'font-size:11px;color:#666'},'do not broadcast SSID')])),
                    fieldRow('Client isolation', E('div', {'style':'display:flex;align-items:center;gap:8px'},
                        [isolateChk, E('span',{'style':'font-size:11px;color:#666'},'prevent clients from talking to each other')])),
                    fieldRow('Max clients', E('div', {'style':'display:flex;align-items:center;gap:4px'},
                        [maxassocInp, maxassocClear, E('span',{'style':'font-size:11px;color:#666;margin-left:4px'},'max stations per BSS')])),
                    fieldRow('WMM', E('div', {'style':'display:flex;align-items:center;gap:8px'},
                        [wmmChk, E('span',{'style':'font-size:11px;color:#666'},'required for 802.11n/ac/ax/be')])),
                    fieldRow('Disabled', E('div', { 'style':'display:flex;align-items:center;gap:8px' }, [
                        disChk, E('span', {'style':'font-size:11px;color:#666'},
                            'disables this interface only')])),
                    fieldRow('UCI section', roValue(sid + '  (device: ' + s['device'] + ')'))
                ];

                var card = E('div', { 'class':'net-card', 'style':
                    'border:1px solid #444;border-radius:6px;overflow:hidden;margin-bottom:10px' }, [
                    E('div', { 'style':
                        'background:#16213e;padding:7px 12px;font-size:13px;font-weight:bold;' +
                        'display:flex;align-items:center;gap:8px' }, [
                        badge(meta.band, meta.bg, meta.fg),
                        E('span', {}, s['ssid']||sid),
                        E('span', { 'style':'font-size:11px;color:#666;margin-left:4px' },
                            s['disabled']==='1' ? '(disabled)' : '')
                    ]),
                    (function() {
                        var bd = E('div', {'style':'padding:10px 12px'});
                        bodyRows.forEach(function(r) { if(r) bd.appendChild(r); });
                        return bd;
                    })(),
                    E('div', { 'style':
                        'display:flex;align-items:center;padding:8px 12px;' +
                        'border-top:1px solid #2a2a3a' }, [
                        discardBtn, saveBtn, statusSpan, removeBtn
                    ])
                ]);
                container.appendChild(card);
            });
        }

        rebuildCards();

        return E('div', {}, [
            infoBanner('Legacy networks are independent from MLD. Open networks disable EHT (WiFi 7). Open on 6 GHz is rejected by hostapd.'),
            container
        ]);
    },

        renderStations: function(data) {
        var mldSIDs      = data._mldSIDs     || ['ap_mld_1'];
        var legacySIDs   = data._legacySIDs  || [];
        var mldStaBase   = data._mldStaBase  || 6;
        var legacyStaBase = data._legacyStaBase || 7;
        var uciData0     = data[0] || {};
        var self = this;

        // Build per-network station data
        var mldNetStations = mldSIDs.map(function(sid, idx) {
            var raw = data[mldStaBase + idx] ? (data[mldStaBase + idx].stdout || '') : '';
            var s   = uciData0[sid] || {};
            return {
                sid:      sid,
                ssid:     s['ssid'] || sid,
                stations: parseStationDump(raw)
            };
        });

        var legacyNetStations = legacySIDs.map(function(sid, idx) {
            var raw = data[legacyStaBase + idx] ? (data[legacyStaBase + idx].stdout || '') : '';
            var s   = uciData0[sid] || {};
            return {
                sid:      sid,
                ssid:     s['ssid'] || sid,
                device:   s['device'] || 'radio0',
                stations: parseStationDump(raw)
            };
        });

        // Keep backward compat for mldStations (first MLD net)
        var mldStations = mldNetStations.length > 0 ? mldNetStations[0].stations : [];
        // legacyBands now handled dynamically via legacyNetStations
        function parseLegacyDump(raw) {
            var stas = [], cur = null;
            raw.split('\n').forEach(function(line) {
                var mx = line.match(/^Station ([0-9a-f:]+) .on /i);
                if (mx) { if (cur) stas.push(cur); cur = { mac: mx[1], signal: '', signal_arr: '', tx: '', rx: '', connected: '' }; return; }
                if (!cur) return;
                var t = line.replace(/\t/g, ' ').trim();
                if (t.match(/^connected time:/)) cur.connected = t.replace('connected time:', '').trim();
                var sigMx = t.match(/^signal:\s+([-\d]+)\s+([\[\d,\s-]+\])\s+dBm/);
                if (sigMx) { cur.signal = sigMx[1]; cur.signal_arr = sigMx[2]; return; }
                var sigMx0 = t.match(/^signal:\s+([-\d]+)\s+dBm/);
                if (sigMx0) { cur.signal = sigMx0[1]; return; }
                var txMx = t.match(/^tx bitrate:\s+(.+)/); if (txMx) { cur.tx = txMx[1]; return; }
                var rxMx = t.match(/^rx bitrate:\s+(.+)/); if (rxMx) { cur.rx = rxMx[1]; return; }
            });
            if (cur) stas.push(cur); return stas;
        }
        function legacyStaEl(sta, bg, fg, name) {
            return E('div', { 'style': 'padding:8px 0;border-bottom:1px solid #2a2a3a;display:flex;align-items:flex-start;gap:8px;font-size:11px' }, [
                badge(name, bg, fg),
                E('div', { 'style': 'color:#ccc;line-height:1.8' }, [
                    E('span', { 'style': 'font-family:monospace;font-size:12px;color:#fff' }, sta.mac),
                    sta.connected ? E('span', { 'style': 'color:#888;margin-left:8px' }, 'connected: ' + sta.connected) : '',
                    E('br'),
                    (function() { var mb = modeBadge(sta.tx); if (!mb) return E('span',{}); var w=E('span',{'style':'margin-right:4px'}); w.appendChild(mb); return w; })(),
                    E('span', {}, 'signal: '), signalSpan(sta.signal, sta.signal_arr),
                    (sta.tx ? E('span', {}, '  |  Tx: ' + sta.tx) : ''),
                    (sta.rx ? E('span', {}, '  |  Rx: ' + sta.rx) : '')
                ])
            ]);
        }
        var bandNames = { '0': '2.4G', '1': '5G', '2': '6G' };
        var bandBg    = { '0': '#0a2a1a', '1': '#0a1a3a', '2': '#1a0a3a' };
        var bandFg    = { '0': '#5dcaa5', '1': '#85b7eb', '2': '#afa9ec' };
        // mldEls now handled by makeMldEls() function


        // Dynamic MLD sections -- all networks with real station data
        function makeMldEls(stations) {
            return stations.map(function(sta) {
                var linkEls = Object.keys(sta.links).sort().map(function(lid) {
                    var lk = sta.links[lid], bg = bandBg[lid]||'#1a1a3a', fg = bandFg[lid]||'#aaa', name = bandNames[lid]||('Link '+lid);
                    if (lk.idle) return E('div', { 'style': 'font-size:11px;margin-top:5px;color:#555;display:flex;align-items:center;gap:6px' },
                        [badge(name, bg, fg), E('span', {}, 'idle (STR)  |  peer: ' + lk.addr)]);
                    var mBadge = modeBadge(lk.tx);
                    return E('div', { 'style': 'font-size:11px;margin-top:5px;color:#ccc;display:flex;align-items:flex-start;gap:6px' }, [
                        badge(name, bg, fg), mBadge || E('span', {}),
                        E('div', { 'style': 'line-height:1.8' }, [
                            E('span', {}, 'signal: '), signalSpan(lk.signal, lk.signal_arr),
                            E('br'), 'Tx: ' + lk.tx, E('br'), 'Rx: ' + lk.rx, E('br'), 'peer MAC: ' + lk.addr
                        ])
                    ]);
                });
                return E('div', { 'style': 'padding:10px 0;border-bottom:1px solid #2a2a3a' }, [
                    E('div', { 'style': 'display:flex;align-items:center;gap:6px;margin-bottom:6px' }, [
                        badge('MLD', '#0a1a3a', '#85b7eb'), badge('EHT', '#0a2a1a', '#5dcaa5'),
                        E('span', { 'style': 'font-family:monospace;font-size:12px;color:#fff' }, sta.mac),
                        E('span', { 'style': 'color:#888;font-size:11px;margin-left:4px' }, sta.connected ? 'connected: ' + sta.connected : '')
                    ]),
                    E('div', {}, linkEls)
                ]);
            });
        }

        var totalClients = 0;
        var allSections = [];

        // All MLD network sections with real data
        mldNetStations.forEach(function(net) {
            totalClients += net.stations.length;
            var els = makeMldEls(net.stations);
            allSections.push(sectionBox(
                'MLD clients -- ' + net.sid + ' (' + net.ssid + ')',
                net.stations.length ? '#1d9e75' : '#888',
                net.stations.length + ' connected',
                E('div', {}, net.stations.length ? els
                    : [E('div', { 'style': 'font-size:12px;color:#888;padding:4px 0' }, 'No MLD clients.')])
            ));
        });

        // Dynamic legacy sections
        var bandColors = {
            'radio0': ['2.4G', '#0a2a1a', '#5dcaa5'],
            'radio1': ['5G',   '#0a1a3a', '#85b7eb'],
            'radio2': ['6G',   '#1a0a3a', '#afa9ec']
        };
        legacyNetStations.forEach(function(net) {
            totalClients += net.stations.length;
            var bc  = bandColors[net.device] || [net.device, '#222', '#aaa'];
            var devIdx = {'radio0':0,'radio1':1,'radio2':2}[net.device];
            var ifn = devIdx !== undefined ? ('phy0.' + devIdx + '-ap0') : (net.device + '-ap0');
            var els = net.stations.map(function(s) { return legacyStaEl(s, bc[1], bc[2], bc[0]); });
            allSections.push(sectionBox(
                'Legacy -- ' + ifn,
                net.stations.length ? '#1d9e75' : '#888',
                net.stations.length + ' connected',
                E('div', {}, net.stations.length ? els
                    : [E('div', { 'style': 'font-size:12px;color:#888;padding:4px 0' }, 'No clients.')])
            ));
        });

        return E('div', {}, allSections.concat([
            E('div', { 'style': 'font-size:11px;color:#666;text-align:right;margin-top:4px' },
                'Total: ' + totalClients + ' client(s) -- auto-refresh 10s')
        ]));
    },

        renderDiagnostics: function(data) {
        var uciData  = data[0] || {};
        var diagBase = data._diagBase || 10;
        var skuRaw   = data[2].stdout  ? data[2].stdout.trim()  : '?';
        var fwRaw    = data[diagBase + 0] ? (data[diagBase + 0].stdout || '').trim() : '?';
        var tp0      = data[diagBase + 1] ? (data[diagBase + 1].stdout || '') : '';
        var tp1      = data[diagBase + 2] ? (data[diagBase + 2].stdout || '') : '';
        var tp2      = data[diagBase + 3] ? (data[diagBase + 3].stdout || '') : '';
        var matTbl  = data[diagBase+4] ? (data[diagBase+4].stdout || '') : '';
        var dfsStat = data[diagBase+5] ? (data[diagBase+5].stdout || '') : '';
        var ltp0    = data[diagBase+6] ? (data[diagBase+6].stdout || '').trim() : '?';
        var ltp1    = data[diagBase+7] ? (data[diagBase+7].stdout || '').trim() : '?';
        var ltp2    = data[diagBase+8] ? (data[diagBase+8].stdout || '').trim() : '?';

        // Parse kernel version from /proc/version: "Linux version X.Y.Z ..."
        var procVer  = data[diagBase+9] ? (data[diagBase+9].stdout || '').trim() : '';
        var kernMatch = procVer.match(/Linux version (\S+)/);
        var kernStr  = kernMatch ? kernMatch[1] : (procVer || '?');
        var driverStr = 'mt7996 / kernel ' + kernStr;

        var skuBad   = skuRaw === '1';
        var thermalRaw   = data[diagBase+10] ? (data[diagBase+10].stdout || '').trim() : '';
        var linksInfoRaw = data[diagBase + 11] ? (data[diagBase + 11].stdout || '').trim() : '';
        // Parse thermal: "type_name temp_int" e.g. "cpu-thermal 52"
        var thermalEl = (function() {
            if (!thermalRaw) return 'N/A';
            var pairs = thermalRaw.split('\n').filter(Boolean).map(function(l) {
                var m = l.match(/^(\S+)\s+(\d+)$/);
                if (!m) return null;
                // Shorten name: remove -thermal suffix for brevity
                var name = m[1].replace(/-thermal$/, '');
                return name + ': ' + m[2] + '°C';
            }).filter(Boolean);
            return pairs.length ? pairs.join('  |  ') : 'N/A';
        })();

        function dcrd(label, val, bad) {
            var inner = E('div', { 'style':
                'font-size:12px;font-family:monospace;color:' +
                (bad ? '#e24b4a' : '#ccc') });
            // val can be a string or a DOM element
            if (typeof val === 'string') inner.textContent = val;
            else if (val && typeof val === 'object') inner.appendChild(val);
            return E('div', { 'style':
                'border:1px solid #333;border-radius:6px;padding:8px 11px' }, [
                E('div', { 'style':
                    'font-size:11px;color:#888;margin-bottom:3px' }, label),
                inner
            ]);
        }

        return E('div', {}, [
            E('div', { 'style':
                'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px' }, [
                dcrd('Firmware',     fwRaw),
                dcrd('MT76 driver',  driverStr),
                dcrd('sku_disable',
                    (function() {
                        var skuIdxVal = (uciData['radio0'] && uciData['radio0']['sku_idx']) || '';
                        var idxSet = skuIdxVal && skuIdxVal !== '0';
                        if (skuBad)   return skuRaw + ' -- regulation INACTIVE';
                        if (!idxSet)  return skuRaw + ' -- sku_idx not set (partial)';
                        return skuRaw + ' -- active (sku_idx=' + skuIdxVal + ')';
                    })(),
                    skuBad),
                dcrd('Single wiphy', 'phy0 (radio0 + radio1 + radio2)'),
                dcrd('Thermal', thermalEl)
            ]),
            collapsibleSection('txpower_info -- band 0 (2.4 GHz)', '#444',
                E('pre', { 'style':
                    'font-size:11px;color:#aaa;margin:0;' +
                    'white-space:pre-wrap;line-height:1.5' },
                    tp0 || 'N/A')),
            collapsibleSection('txpower_info -- band 1 (5 GHz)', '#444',
                E('pre', { 'style':
                    'font-size:11px;color:#aaa;margin:0;' +
                    'white-space:pre-wrap;line-height:1.5' },
                    tp1 || 'N/A')),
            collapsibleSection('txpower_info -- band 2 (6 GHz)', '#444',
                E('pre', { 'style':
                    'font-size:11px;color:#aaa;margin:0;' +
                    'white-space:pre-wrap;line-height:1.5' },
                    tp2 || 'N/A')),
            sectionBox('Per-link current TX power', '#444', null,
                E('div', {}, [
                    fieldRow('Link 0 (2.4G)', roValue(ltp0 ? ltp0 + ' dBm' : 'N/A')),
                    fieldRow('Link 1 (5G)',   roValue(ltp1 ? ltp1 + ' dBm' : 'N/A')),
                    fieldRow('Link 2 (6G)',   roValue(ltp2 ? ltp2 + ' dBm' : 'N/A'))
                ])),
            sectionBox('DFS status -- band 1 (5 GHz)', '#444', null,
                E('pre', { 'style':
                    'font-size:11px;color:#aaa;margin:0;' +
                    'white-space:pre-wrap;line-height:1.5' },
                    dfsStat || 'N/A')),
            sectionBox('MAT table', '#444', null,
                E('pre', { 'style':
                    'font-size:11px;color:#aaa;margin:0;' +
                    'white-space:pre-wrap;line-height:1.5' },
                    matTbl || 'N/A')),
            collapsibleSection('mt76_links_info -- MLO internal topology', '#444',
                E('pre', { 'style':
                    'font-size:11px;color:#aaa;margin:0;' +
                    'white-space:pre-wrap;line-height:1.5' },
                    linksInfoRaw || 'N/A')),
            sectionBox('Log collection', '#444', null,
                E('div', {}, [
                    E('div', { 'style': 'font-size:12px;color:#aaa;margin-bottom:8px' },
                        'Collect kernel + WiFi logs for debugging. Output opens in new tab.'),
                    (function() {
                        var logBtn = E('button', { 'style':
                            'background:#2a2a3a;color:#ccc;border:1px solid #444;border-radius:4px;' +
                            'padding:6px 14px;font-size:12px;cursor:pointer;margin-right:8px' },
                            'Collect logs (logread)');
                        var logStatus = E('span', { 'style': 'font-size:11px;color:#888' });
                        logBtn.addEventListener('click', function() {
                            logBtn.disabled = true;
                            logStatus.textContent = 'Collecting...';
                            L.resolveDefault(callExec('/bin/sh', ['-c',
                                'echo "=== dmesg WiFi ===" && dmesg | grep -i "mt76\|wifi\|mld\|hostapd" | tail -100 && ' +
                                'echo "=== logread ===" && logread 2>/dev/null | tail -200'
                            ]), { stdout: '' }).then(function(r) {
                                var blob = new Blob([r.stdout || 'No output'], { type: 'text/plain' });
                                var url = URL.createObjectURL(blob);
                                var a = document.createElement('a');
                                a.href = url;
                                a.download = 'wifi7-log-' + Date.now() + '.txt';
                                a.click();
                                URL.revokeObjectURL(url);
                                logStatus.textContent = 'Done -- log downloaded';
                                logStatus.style.color = '#1d9e75';
                                logBtn.disabled = false;
                                setTimeout(function() { logStatus.textContent = ''; }, 3000);
                            });
                        });
                        return E('div', { 'style': 'display:flex;align-items:center' },
                            [logBtn, logStatus]);
                    })()
                ]))
        ]);
    },

    handleSave:      null,
    handleSaveApply: null,
    handleReset:     null

});
