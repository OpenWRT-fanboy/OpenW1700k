'use strict';
'require view';
'require rpc';
'require poll';
'require uci';

/*
 * Warning state is computed by trafficchart-agg from V2Fly groups and the optional
 * legacy application-name patterns. The browser only renders the marker carried by
 * the backend, avoiding false positives and duplicate warning glyphs.
 */
function alertBaseLabel(value) {
    return String(value || '').replace(/\s*⚠+\s*$/, '').trim();
}

function isAlertMatch(value) {
    return /(?:^|\s)⚠+$/.test(String(value || '').trim());
}

var callTrafficStats = rpc.declare({
    object: 'luci.trafficchart',
    method: 'get_stats',
    expect: { '': {} }
});

var callHistory = rpc.declare({
    object: 'luci.trafficchart',
    method: 'get_stats',
    params: [ 'history', 'tier', 'dim', 'n', 'skip', 'slim' ],
    expect: { '': {} }
});

var callRestart = rpc.declare({
    object: 'luci.trafficchart',
    method: 'restart',
    expect: { '': {} }
});

// Separate from "restart": clears cumulative totals + in-RAM history without
// bouncing the daemon (see hist_reset() in trafficchart-agg).
// ubus ACL check of the current session: the write actions are only offered when allowed
var callAccess = rpc.declare({
    object: 'session',
    method: 'access',
    params: [ 'scope', 'object', 'function' ],
    expect: { 'access': false }
});

function canCall(method) {
    return callAccess('ubus', 'luci.trafficchart', method).catch(function() { return false; });
}

var callResetHistory = rpc.declare({
    object: 'luci.trafficchart',
    method: 'reset_history',
    expect: { '': {} }
});

var DIRECTIONS = [
    { suffix: '_in',  title: _('Incoming (Download)'), centerLabel: _('INCOMING SHARE') },
    { suffix: '_out', title: _('Outgoing (Upload)'),    centerLabel: _('OUTGOING SHARE') }
];

var SVG_SIZE = 360;
var CX = SVG_SIZE / 2;
var CY = SVG_SIZE / 2;
var R = 118;
var STROKE_NORMAL = 70;
var STROKE_HOVER = 82;
var CIRC = 2 * Math.PI * R;

var UN_SLOT = 'su';
var UN_MIN_BPS = 5000;
var UN_MIN_SHARE = 0.04;


function formatBytes(b) {
    if (!isFinite(b) || b < 0) b = 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return Math.round(b) + ' B';
}
function formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}
function formatRate(bitsPerSec) {
    if (!isFinite(bitsPerSec) || bitsPerSec < 0) bitsPerSec = 0;
    if (bitsPerSec >= 1e6) return (bitsPerSec / 1e6).toFixed(2) + ' Mbit/s';
    if (bitsPerSec >= 1e3) return (bitsPerSec / 1e3).toFixed(1) + ' kbit/s';
    return Math.round(bitsPerSec) + ' bit/s';
}

function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
}

// Remembered view settings (tab, ranges, ...). localStorage can be unavailable or full: every access is guarded,
// and a missing / damaged value simply gives the defaults.
var PREF_KEY = 'trafficchart.ui';
function prefLoad() {
    try {
        var o = JSON.parse(window.localStorage.getItem(PREF_KEY) || '{}');
        return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
}
function prefSave(section, obj) {
    try {
        var o = prefLoad();
        o[section] = obj;
        window.localStorage.setItem(PREF_KEY, JSON.stringify(o));
    } catch (e) {}
}

var previousCleanup = null;

return view.extend({
    load: function() {
        return Promise.all([ canCall('restart'), canCall('reset_history'), uci.load('trafficchart') ]).then(function(result) {
            return result.slice(0, 2);
        });
    },

    render: function(perm) {
        var canRestart = !!(perm && perm[0]), canReset = !!(perm && perm[1]);
        // "Enable" off in the settings: the init script starts nothing then, so a restart cannot help
        var svcEnabled = String(uci.get('trafficchart', 'global', 'enabled')) !== '0';
        if (previousCleanup) {
            previousCleanup();
            previousCleanup = null;
        }
        var cleanupFns = [];
        previousCleanup = function() {
            var fn;
            while ((fn = cleanupFns.pop())) {
                try { fn(); } catch (e) {}
            }
            previousCleanup = null;
        };

        if (!document.getElementById('qos_chart_style')) {
            var styleTag = document.createElement('style');
            styleTag.id = 'qos_chart_style';
            styleTag.textContent =
                ':root {' +
                '  --qos-text-strong: var(--primary-color, var(--main-color, var(--text-color, currentColor)));' +
                '  --qos-text: var(--text-color, var(--main-color, var(--primary-color, currentColor)));' +
                '  --qos-text-muted: var(--secondary-color, var(--gray-color, color-mix(in srgb, var(--qos-text-strong) 58%, transparent)));' +
                '  --qos-surface: var(--card-background, var(--background-color, Canvas));' +
                '  --qos-danger: var(--error-color, #dc2626);' +
                '}' +
                '.qos-panels { position: relative; z-index: 1; display:flex; justify-content:center; align-items:flex-start;' +
                '  gap:16px; flex-wrap:wrap; }' +
                '.qos-panel { display:flex; flex-direction:column; align-items:center; width:100%; max-width:1280px; box-sizing:border-box; }' +
                '.qos-panel-title { font-size:15px; font-weight:800; color:var(--qos-text-strong); margin-bottom:6px; letter-spacing:0.3px; }' +
                '.qos-card { display:flex; justify-content:center; align-items:flex-start; gap:12px; flex-wrap:wrap; width:100%; min-width:0; }' +
                '.qos-card > * { min-width:0; }' +
                '.qos-donut-wrap, .qos-donut-wrap > svg { background:transparent !important; }' +
                '.qos-donut-wrap::before, .qos-donut-wrap::after { background:transparent !important; }' +
                '.qos-seg { transition: stroke-dasharray 1.2s cubic-bezier(.22,1,.36,1), stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1), stroke-width .25s ease, opacity .25s ease; cursor: pointer; }' +
                '.qos-seg.dimmed { opacity: 0.28; }' +
                '.qos-seg.active { stroke-width: ' + STROKE_HOVER + 'px; }' +
                '.qos-legend-row { transition: background .2s ease, transform .2s ease; border-radius: 10px; cursor: pointer; }' +
                '.qos-legend-row:hover { background: rgba(0,0,0,0.035); transform: translateX(2px); }' +
                '.qos-legend-row.dimmed { opacity: 0.4; }' +
                '.qos-center-value { transition: opacity .18s ease, transform .18s ease; }' +
                '.qos-swatch { transition: transform .2s ease, box-shadow .2s ease; }' +
                '.qos-legend-row:hover .qos-swatch { transform: scale(1.15); }';
            document.head.appendChild(styleTag);
        }

        // no animation for the first draw of a tab: its views were not updated while hidden, so the
        // transition would run from stale values to the current ones and look like a jump
        var ntOld = document.getElementById('qos_notrans_style');
        if (ntOld) ntOld.parentNode.removeChild(ntOld);
        var ntStyle = document.createElement('style');
        ntStyle.id = 'qos_notrans_style';
        ntStyle.textContent = '.qos-notrans, .qos-notrans * { transition: none !important; }';
        document.head.appendChild(ntStyle);

        var tipOld = document.getElementById('qos_tip_style');
        if (tipOld) tipOld.parentNode.removeChild(tipOld);
        var tipStyle = document.createElement('style');
        tipStyle.id = 'qos_tip_style';
        tipStyle.textContent =
            '@keyframes qosTipIn { from { opacity:0; transform: translateY(6px) scale(.97); } to { opacity:1; transform:none; } }' +
            '#qos_tip { animation: qosTipIn .16s ease-out; transform-origin: top left; font-family: inherit; background: rgba(15,23,42,0.68) !important; color: #e2e8f0 !important; }' +
            '#qos_tip table, #qos_tip tbody, #qos_tip tr, #qos_tip th, #qos_tip td { background: transparent !important; border: 0 !important; box-shadow: none !important; text-shadow: none !important; }' +
            '#qos_tip table { border-collapse: collapse; margin:0; width:auto; }' +
            '#qos_tip th { font-weight:600; font-size:10px; letter-spacing:.6px; text-transform:uppercase; color:rgba(226,232,240,.65) !important; padding:0 0 6px 18px; text-align:right; white-space:nowrap; }' +
            '#qos_tip td { font-size:12px; color:#e2e8f0 !important; padding:5px 0 5px 18px; text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }' +
            '#qos_tip th:first-child, #qos_tip td:first-child { padding-left:0; text-align:left; }' +
            '#qos_tip th:first-child { white-space:normal; }' +
            '#qos_tip td:first-child { white-space:normal; min-width:150px; max-width:300px; }' +
            '#qos_tip tr + tr td { border-top: 1px solid rgba(255,255,255,.10) !important; }' +
            '#qos_tip td.dl { color:#6ee7b7 !important; } #qos_tip td.ul { color:#93c5fd !important; }' +
            '#qos_tip .tt-name { color:#f8fafc !important; font-weight:600; }' +
            '#qos_tip .tt-title { color:#ffffff !important; font-size:13px; font-weight:800; min-width:0; white-space:normal; overflow-wrap:anywhere; }' +
            '#qos_tip .tt-sub { color:rgba(226,232,240,.75) !important; font-size:11px; margin:-4px 0 8px 16px; white-space:normal; overflow-wrap:anywhere; }' +
            '#qos_tip .tt-link { cursor:pointer; }' +
            '#qos_tip .tt-name.tt-link { text-decoration:none; }' +
            '#qos_tip .tt-name.tt-link:hover { color:#93c5fd !important; }' +
            '#qos_tip .tt-hl { color:#93c5fd !important; font-weight:600; cursor:pointer; margin-right:14px; }' +
            '#qos_tip .tt-hl:hover { text-decoration:underline; }' +
            '#qos_tip td.tt-act { padding-left:20px; font-size:10px; white-space:nowrap; }' +
            '#qos_tip .tt-mini { color:#93c5fd !important; cursor:pointer; margin-left:7px; text-decoration:none; }' +
            '#qos_tip .tt-mini:hover { color:#bfdbfe !important; }';
        document.head.appendChild(tipStyle);
        var tipEl = document.getElementById('qos_tip');
        if (!tipEl) { tipEl = E('div', { id: 'qos_tip' }); document.body.appendChild(tipEl); }
        tipEl.style.cssText = 'position:fixed; z-index:10000; display:none; pointer-events:none; width:max-content; box-sizing:border-box; max-width:min(680px, 94vw); ' +
            'background:rgba(15,23,42,0.68) !important; color:#e2e8f0 !important; ' +
            '-webkit-backdrop-filter:blur(14px) saturate(1.4); backdrop-filter:blur(14px) saturate(1.4); ' +
            'border:1px solid rgba(255,255,255,0.18) !important; border-radius:12px; ' +
            'box-shadow:0 12px 32px rgba(0,0,0,0.5); padding:14px 20px 14px 18px; font-size:12px; line-height:1.35;';
        var tipPos = { x: 0, y: 0 };
        function tipPlace() {
            // measure at the top-left corner: with the old left/top still set near the right or bottom
            // edge the box is squeezed to the space left there and its content overflows it
            tipEl.style.left = '0px'; tipEl.style.top = '0px';
            var pad = 14, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
            var x = tipPos.x + pad, y = tipPos.y + pad;
            if (x + w > window.innerWidth - 8) x = tipPos.x - pad - w;
            if (y + h > window.innerHeight - 8) y = tipPos.y - pad - h;
            tipEl.style.left = Math.max(8, x) + 'px';
            tipEl.style.top = Math.max(8, y) + 'px';
        }
        function tipTrack(ev) {
            tipPos.x = ev.clientX; tipPos.y = ev.clientY;
            if (tipEl.style.display !== 'none') tipPlace();
        }
        var tipScrollY = window.pageYOffset;
        var tipScrollHandler = function() {
            var y = window.pageYOffset;
            if (tipEl.style.display !== 'none') { tipPos.y -= (y - tipScrollY); tipPlace(); }
            tipScrollY = y;
        };
        window.addEventListener('scroll', tipScrollHandler);
        cleanupFns.push(function() { window.removeEventListener('scroll', tipScrollHandler); });
        function tipHide() { tipEl.style.display = 'none'; tipEl.style.pointerEvents = 'none'; }
        function tipShow(m) {
            while (tipEl.firstChild) tipEl.removeChild(tipEl.firstChild);
            var max = 0, live = !!m.interactive, anyNav = false;
            var hasNavRows = live && !!(m.details && m.details.some(function(d) { return !!d[5]; }));
            function actCell(nv) {
                var td = E('td', { 'class': 'tt-act' });
                if (nv) navActions(m.kind).forEach(function(a) {
                    var sp = E('span', { 'class': 'tt-mini', title: a[2] }, a[1]);
                    sp.addEventListener('click', function(ev) { ev.stopPropagation(); openNav(a[0], nv, m.nav, m.range); });
                    td.appendChild(sp);
                });
                return td;
            }
            if (m.details && m.details.length) {
                m.details.forEach(function(d) { max = Math.max(max, (d[1] || 0) + (d[2] || 0)); });
                var rows = [ E('tr', {}, [
                    E('th', {}, m.detailTitle || _('Top applications')),
                    E('th', {}, '\u2193 ' + _('Download')),
                    E('th', {}, '\u2191 ' + _('Upload')),
                    hasNavRows ? E('th', {}, '') : '' ]) ];
                m.details.forEach(function(d) {
                    var pct = max > 0 ? Math.max(3, ((d[1] || 0) + (d[2] || 0)) / max * 100) : 0;
                    var detailAlert = !!d[3] || isAlertMatch(d[0]);
                    var detailName = alertBaseLabel(d[0]);
                    var detailNameChildren = [detailName];
                    if (detailAlert) detailNameChildren.unshift(E('span', { style: 'color:#ffffff !important;font-weight:800;' }, '⚠ '));
                    var nameDiv = E('div', { 'class': 'tt-name' + (live && d[5] ? ' tt-link' : '') }, detailNameChildren);
                    if (live && d[5]) {
                        anyNav = true;
                        (function(nv) { nameDiv.addEventListener('click', function(ev) { ev.stopPropagation(); openNav(m.kind === 'hist' ? 'hist' : 'live', nv, m.nav, m.range); }); })(d[5]);
                    }
                    rows.push(E('tr', {}, [
                        E('td', {}, [
                            nameDiv,
                            E('div', { style: 'height:3px; margin-top:4px; border-radius:2px; background:rgba(255,255,255,0.12) !important;' }, [
                                E('div', { style: 'height:100%; width:' + pct.toFixed(1) + '%; border-radius:2px; background:hsl(' + slotHue(d[4] || d[0]) + ',65%,62%) !important;' }) ]) ]),
                        E('td', { 'class': 'dl' }, formatBytes(d[1])),
                        E('td', { 'class': 'ul' }, formatBytes(d[2])),
                        hasNavRows ? actCell(d[5]) : '' ]));
                });
            }
            var dot = m.color || '#94a3b8';
            tipEl.appendChild(E('div', { style: 'display:flex; align-items:center; gap:8px; margin-bottom:8px;' }, [
                E('span', { style: 'flex-shrink:0; width:8px; height:8px; border-radius:50%; background:' + dot + ' !important; box-shadow:0 0 8px ' + dot + ';' }),
                E('span', { 'class': 'tt-title' }, m.label) ]));
            if (m.sub) tipEl.appendChild(E('div', { 'class': 'tt-sub' }, m.sub));
            if (live && (m.nav || navOrigin)) {
                var actions = E('div', { 'class': 'tt-sub', style: 'margin:-2px 0 8px 16px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;' });
                if (navOrigin && navOrigin.label && (!m.nav || navOrigin.key !== m.nav.key)) {
                    var backSp = E('span', { 'class': 'tt-hl', style: 'cursor:pointer; font-weight:700;', title: _('Back to %s').format(navOrigin.label) }, '\u2190 ' + navOrigin.label);
                    backSp.addEventListener('click', function(ev) {
                        ev.stopPropagation();
                        var prev = navOrigin;
                        navOrigin = null;
                        if (prev.kind === 'hist') focusHist(prev.dim, prev.key, prev.label, m.range);
                        else if (prev.kind === 'vol') navVolume(prev, null, m.range);
                        else focusLive(prev.dim, prev.key, prev.label, m.range);
                    });
                    actions.appendChild(backSp);
                }
                if (m.nav) {
                    navActions(m.kind).forEach(function(a) {
                        var sp = E('span', { 'class': 'tt-hl', title: a[2] }, '\u2197 ' + a[3]);
                        sp.addEventListener('click', function(ev) { ev.stopPropagation(); openNav(a[0], m.nav, navOrigin || null, m.range); });
                        actions.appendChild(sp);
                    });
                }
                tipEl.appendChild(actions);
            }
            if (m.details && m.details.length) tipEl.appendChild(E('table', {}, rows));
            if (live && anyNav)
                tipEl.appendChild(E('div', { 'class': 'tt-sub', style: 'margin:8px 0 0 0; font-size:10px;' }, _('Click a name to jump to it, or use the small links on the right.')));
            // only a pinned tooltip with links takes the mouse; hover tooltips stay transparent to it
            tipEl.style.pointerEvents = (live && (m.nav || anyNav)) ? 'auto' : 'none';
            tipEl.style.display = 'block';
            tipPlace();
        }


        // Use the native LuCI checkbox markup so controls inherit the active OpenWrt theme.
        // Choice groups stay mutually exclusive even though their visual controls are checkboxes.
        var qosCheckboxSeq = 0;
        function makeOpenWrtCheckbox(label, checked, onChange) {
            var id = 'qos-filter-' + (++qosCheckboxSeq);
            var input = E('input', { type: 'checkbox', id: id, 'class': 'cbi-input-checkbox' });
            input.checked = !!checked;
            input.setAttribute('aria-label', label);
            var hiddenLabel = E('label', { 'for': id });
            // Keep the label comfortably separated from the checkbox in every LuCI theme.
            var caption = E('span', { style: 'margin-left:0.5em;' }, label);
            caption.addEventListener('click', function(ev) {
                ev.preventDefault();
                input.click();
            });
            var el = E('span', { 'class': 'cbi-checkbox', style: 'margin-right:12px;' }, [ input, hiddenLabel, caption ]);
            input.addEventListener('change', function(ev) {
                ev.stopPropagation();
                onChange(!!input.checked);
            });
            return { el: el, input: input };
        }

        function makeCheckboxGroup(defs, inputs, selected, onPick) {
            var group = E('div', { style: 'display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px;' });
            defs.forEach(function(d) {
                var choice;
                choice = makeOpenWrtCheckbox(d[1], selected === d[0], function(checked) {
                    // A selected choice cannot be unchecked; selecting another one moves the check.
                    if (!checked) {
                        choice.input.checked = true;
                        return;
                    }
                    onPick(d[0]);
                });
                choice.input.title = d[1];
                inputs.push(choice.input);
                group.appendChild(choice.el);
            });
            return group;
        }

        var tcDiagText = '';

        // ---- links between the views: any entry can be opened in the Volume tab, and from there on
        // every related entry (destinations of an application, applications of a device, devices of a
        // destination) is one click away. The path is kept in the address (#volume/<range>/<dim>:<key>/...),
        // so the browser's back button, bookmarks and copied links all work.
        var REL_DIM = { a: 'h', d: 'a', h: 'd' };
        var selectTabFn = null;
        var homeTab = 0;                       // tab of the first entry: where an empty address leads back to
        var lastHandledHash = window.location.hash;   // last address the router has seen (hashchange + popstate fire for one Back)
        function pushHash(h) {
            try { window.history.pushState(null, '', window.location.pathname + window.location.search + h); } catch (e) {}
            lastHandledHash = h;
        }
        function replaceHash(h) {
            try { window.history.replaceState(null, '', window.location.pathname + window.location.search + h); } catch (e) {}
            lastHandledHash = h;
        }
        var navOrigin = null; // { dim, key, label, tab, range, kind }
        // detail rows of a tooltip -> [ name, in, out, warning, colour key, link target ]
        function navRows(rows, relDim) {
            if (!rows) return rows;
            return rows.map(function(r) {
                var o = [ r[0], r[1], r[2], r[3], r[4] ], key = r[4] || r[0];
                if (!r.nonav && key && key !== '(other)') o[5] = { dim: relDim, key: key, label: alertBaseLabel(r[0]) };
                return o;
            });
        }
        function hashFor(range, trail) {
            return '#volume/' + encodeURIComponent(range) + trail.map(function(t) {
                if (t.heat) return '/heat';
                return '/' + (t.dim || 'a') + ':' + encodeURIComponent(t.key || '');
            }).join('');
        }
        function parseHash(h) {
            var raw = h || '';
            if (raw === '' || raw === '#') return { tab: 'default' };
            if (/^#(?:apps|devices|hosts|flows|history)(?:$|\/|:)/.test(raw)) {
                var mLive = /^#([a-z]+)(?:[:\/]([adh]):?([^\/]*))?/.exec(raw);
                if (mLive) {
                    var tabMap = { apps: 0, devices: 1, hosts: 2, flows: 3, history: 4 };
                    return { liveTab: tabMap[mLive[1]], dim: mLive[2], key: mLive[3] ? decodeURIComponent(mLive[3]) : null };
                }
            }
            var mt = /^#volume\/([^\/]+)(.*)$/.exec(raw), trail = [], range, rest;
            if (!mt) return null;
            try { range = decodeURIComponent(mt[1]); } catch (e) { return null; }
            rest = mt[2] || '';
            if (rest === '/heat') return { range: range, trail: [], heat: true };
            mt = /^\/heat-slot:(\d+):(\d+)$/.exec(rest);
            if (mt) {
                var day = +mt[1], hour = +mt[2];
                if (day < 0 || day > 6 || hour < 0 || hour > 23) return null;
                return { range: range, trail: [], heatSlot: { day: day, hour: hour } };
            }
            if (/^\/heat\/(?:[adh]:[^\/]*)+$/.test(rest)) {
                trail.push({ heat: true, label: _('Heatmap') });
                rest.slice(6).split('/').forEach(function(part) {
                    try { trail.push({ dim: part.charAt(0), key: decodeURIComponent(part.slice(2)) }); } catch (e) {}
                });
                return { range: range, trail: trail };
            }
            if (rest && !/^(?:\/[adh]:[^\/]*)+$/.test(rest)) return null;
            if (rest) rest.split('/').slice(1).forEach(function(part) {
                try { trail.push({ dim: part.charAt(0), key: decodeURIComponent(part.slice(2)) }); } catch (e) {}
            });
            return { range: range, trail: trail };
        }
        function navVolume(nav, owner, range) {
            var trail = [];
            if (owner && owner.key) {
                trail.push({ dim: owner.dim, key: owner.key, label: owner.label, fromTab: owner.tab !== undefined ? owner.tab : activeTab });
            }
            trail.push(nav);
            volView.go(trail, range);
        }
        // targets: 'vol' = Volume tab, 'live' = Applications / Devices / Destinations tab with the entry pinned,
        // 'hist' = History tab showing only that entry
        function navActions(kind) {
            var vol = [ 'vol', _('Vol.'), _('Open in Volume'), _('Volume') ];
            return kind === 'hist' ? [ vol, [ 'live', _('Live'), _('Show in the live tab'), _('Live') ] ]
                                   : [ vol, [ 'hist', _('Hist.'), _('Show in History'), _('History') ] ];
        }
        function focusLive(dim, key, label, range, owner) {
            var tabIdx = { a: 0, d: 1, h: 2 }[dim];
            var view = slotViews[tabIdx];
            if (owner) navOrigin = { dim: owner.dim, key: owner.key, label: owner.label, tab: activeTab, range: range, kind: (activeTab === 4 ? 'hist' : 'live') };
            // not one of the rows that have a slice of their own: go straight to Volume (ONE history entry, no dead live entry)
            if (!view.canPin(key)) { navVolume({ dim: dim, key: key, label: label }, navOrigin || owner, range); return; }
            var tabName = [ 'apps', 'devices', 'hosts' ][tabIdx];
            pushHash('#' + tabName + ':' + dim + ':' + encodeURIComponent(key));
            selectTabFn(tabIdx, true);
            // only the biggest rows of a tab exist as slices; anything else is found in Volume
            if (!view.pinKey(key)) navVolume({ dim: dim, key: key, label: label }, navOrigin || owner, range);
        }
        function focusHist(dim, key, label, range, owner) {
            if (owner) navOrigin = { dim: owner.dim, key: owner.key, label: owner.label, tab: activeTab, range: range, kind: (activeTab === 5 ? 'vol' : 'live') };
            histView.focus(dim, key, label, range);
            pushHash('#history:' + dim + ':' + encodeURIComponent(key));
            selectTabFn(4, true);
        }
        function openNav(target, nav, owner, range) {
            var origin = owner ? {
                dim: owner.dim,
                key: owner.key,
                label: owner.label,
                tab: activeTab,
                range: range,
                kind: (activeTab === 4 ? 'hist' : (activeTab === 5 ? 'vol' : 'live'))
            } : null;
            if (origin) navOrigin = origin;
            if (target === 'vol') navVolume(nav, origin || owner, range);
            else if (target === 'live') focusLive(nav.dim, nav.key, nav.label, range, origin || owner);
            else focusHist(nav.dim, nav.key, nav.label, range, origin || owner);
        }
        function onHashNav() {
            var nv = parseHash(window.location.hash);
            if (!nv || !selectTabFn) return;
            if (nv.tab === 'default') {
                selectTabFn(homeTab, true);
                return;
            }
            if (nv.liveTab !== undefined) {
                if (nv.key && nv.liveTab === 4) {
                    // focus before selectTab so skipLoad is set before the tab triggers a load
                    histView.focus(nv.dim || 'a', nv.key, nv.key);
                }
                selectTabFn(nv.liveTab, true);
                if (nv.dim && nv.key && nv.liveTab <= 2) {
                    var sv = slotViews[nv.liveTab];
                    // no longer pinnable: continue in Volume and REPLACE this entry, so Back cannot run into it again
                    if (sv && !sv.pinKey(nv.key)) volView.go([ { dim: nv.dim, key: nv.key, label: nv.key } ], null, true);
                }
                return;
            }
            volView.applyNav(nv);
            selectTabFn(5, true);
        }

        function buildDirectionPanel(dir, order, metaOf, dynamicMeta, noun) {
            var refs = { classes: {}, segEls: {} };
            var lastValues = { total: '100.0%', classes: {}, counters: {} };
            var pinned = null;
            var hovered = null;
            var currentMeta = null;
            function getMeta(cls) { return (dynamicMeta && currentMeta && currentMeta[cls]) ? currentMeta[cls] : metaOf(cls); }
            var lastUpdateArgs = null;

            var tipShown = false;
            function refreshTip() {
                var m = (dynamicMeta && pinned && currentMeta && panelEl.offsetParent) ? currentMeta[pinned.key] : null;
                if (m && m.details && m.details.length) {
                    var mi = {}, mk;
                    for (mk in m) if (Object.prototype.hasOwnProperty.call(m, mk)) mi[mk] = m[mk];
                    mi.interactive = true;
                    tipShow(mi); tipShown = true;
                }
                else if (tipShown) { tipHide(); tipShown = false; }
            }

            function setPinned(newPinned) {
                var wasPinned = !!pinned;
                pinned = newPinned;
                applyHighlight();
                if (wasPinned && !pinned && lastUpdateArgs) {
                    applyUpdate.apply(null, lastUpdateArgs);
                }
            }

            var svg = svgEl('svg', {
                viewBox: '0 0 ' + SVG_SIZE + ' ' + SVG_SIZE,
                width: '100%',
                height: '100%',
                style: 'display:block; background:transparent !important; filter: drop-shadow(0 14px 30px rgba(15,23,42,0.16));'
            });
            svg.appendChild(svgEl('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: 'rgba(0,0,0,0.055)', 'stroke-width': STROKE_NORMAL }));

            var segGroup = svgEl('g', { transform: 'rotate(-90 ' + CX + ' ' + CY + ')' });
            order.forEach(function(cls) {
                var seg = svgEl('circle', {
                    cx: CX, cy: CY, r: R, fill: 'none', stroke: metaOf(cls).color,
                    'stroke-width': STROKE_NORMAL, 'stroke-dasharray': '0 ' + CIRC.toFixed(2),
                    'stroke-dashoffset': '0', class: 'qos-seg'
                });
                seg.addEventListener('mouseenter', function() { hovered = { type: 'class', key: cls }; applyHighlight(); });
                seg.addEventListener('mouseleave', function() { hovered = null; applyHighlight(); });
                seg.addEventListener('click', function(ev) {
                    tipTrack(ev);
                    setPinned((pinned && pinned.type === 'class' && pinned.key === cls) ? null : { type: 'class', key: cls });
                });
                refs.segEls[cls] = seg;
                segGroup.appendChild(seg);
            });
            svg.appendChild(segGroup);

            var centerPctEl = E('div', {
                class: 'qos-center-value',
                style: 'font-size:19px; font-weight:800; color:var(--qos-text-strong); font-variant-numeric: tabular-nums; min-width:95px; text-align:center;'
            }, '100.0%');
            var centerLabelEl = E('div', {
                class: 'qos-center-value',
                style: 'font-size:9.5px; line-height:1.2; color:var(--qos-text-muted); letter-spacing:0.4px; text-align:center; width:82%; max-width:96px; box-sizing:border-box; white-space:normal; overflow-wrap:anywhere; word-break:break-word;'
            }, dir.centerLabel);

            var activeCountEl = E('div', {
                style: 'font-size:11px; color:var(--qos-text-muted); text-transform:uppercase; letter-spacing:0.7px; margin-bottom:2px;'
            }, noun || '');

            var legendChildren = [];
            order.forEach(function(cls) {
                refs.classes[cls] = {};

                var liveBarEl = E('div', {
                    style: 'position:absolute; left:0; top:0; bottom:0; width:0%; border-radius:6px; opacity:0.25; background:' + metaOf(cls).color + '; transition:width 0.4s ease;'
                });
                var liveTextEl = E('span', {
                    style: 'position:relative; z-index:1; font-size:11px; font-weight:700; color:var(--qos-text-strong); font-variant-numeric: tabular-nums;'
                }, '0 bit/s');
                var livePctEl = E('div', {
                    style: 'position:relative; display:inline-flex; align-items:center; justify-content:flex-end; padding:2px 8px; border-radius:6px; background:rgba(0,0,0,0.04); min-width:85px; overflow:hidden;'
                }, [ liveBarEl, liveTextEl ]);

                var sigmaBytesEl = E('span', { style: 'color:var(--qos-text);' }, '0 B');
                var sigmaPacketsEl = E('span', { style: 'color:var(--qos-text);' }, '0');
                var sigmaSuffixWordEl = E('span', { style: 'color:var(--qos-text);' }, ' ' + _('packets'));
                var sigmaSuffixTimeEl = E('span', {}, ' (' + _('since start') + ')');
                var sigmaEl = E('span', {
                    style: 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1 1 auto;'
                }, [ E('span', { style: 'color:var(--qos-text);' }, _('Total') + ' '), sigmaBytesEl, ' - ', sigmaPacketsEl, sigmaSuffixWordEl, sigmaSuffixTimeEl ]);
                var totalPctEl = E('span', {
                    style: 'min-width:58px; text-align:right; display:inline-block; flex-shrink:0;'
                }, _('Total') + ': 0.0%');
                refs.classes[cls].livePct = liveTextEl;
                refs.classes[cls].liveBar = liveBarEl;
                refs.classes[cls].sigma = sigmaEl;
                refs.classes[cls].sigmaBytes = sigmaBytesEl;
                refs.classes[cls].sigmaPackets = sigmaPacketsEl;
                refs.classes[cls].sigmaSuffixTime = sigmaSuffixTimeEl;
                refs.classes[cls].totalPct = totalPctEl;

                var labelRaw = metaOf(cls).label;
                var labelAlert = isAlertMatch(labelRaw);
                var labelText = alertBaseLabel(labelRaw);
                var labelChildren = [labelText];
                if (labelAlert) labelChildren.unshift(E('span', { style: 'color:#dc2626 !important;font-weight:800;' }, '⚠ '));
                var labelEl = E('span', { style: 'font-size:11.5px; color:var(--qos-text-strong); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;' }, labelChildren);
                var swatch = E('span', { class: 'qos-swatch', style: 'width:11px; height:11px; background:' + metaOf(cls).color + '; border-radius:3px; display:inline-block; flex-shrink:0; box-shadow:0 2px 5px rgba(0,0,0,0.15);' });

                var headerRow = E('div', {
                    class: 'qos-legend-row',
                    style: 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:0px 1px;'
                }, [
                    E('div', { style: 'display:flex; align-items:center; gap:5px; min-width:0; overflow:hidden;' }, [
                        swatch,
                        labelEl
                    ]),
                    E('div', { style: 'text-align:right; min-width:85px; flex-shrink:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11px;' }, [ livePctEl ])
                ]);

                headerRow.addEventListener('mouseenter', function() { hovered = { type: 'class', key: cls }; applyHighlight(); });
                headerRow.addEventListener('mouseleave', function() { hovered = null; applyHighlight(); });
                headerRow.addEventListener('click', function(ev) {
                    tipTrack(ev);
                    setPinned((pinned && pinned.type === 'class' && pinned.key === cls) ? null : { type: 'class', key: cls });
                });

                refs.classes[cls].headerRow = headerRow;
                refs.classes[cls].labelEl = labelEl;
                refs.classes[cls].swatchEl = swatch;

                var rowEl = E('div', {
                    style: 'padding:0px 0; border-bottom:1px solid rgba(165,173,175,0.25); display:none;'
                }, [
                    headerRow,
                    E('div', {
                        style: 'display:flex; flex-wrap:nowrap; justify-content:space-between; align-items:center; gap:4px; margin:0 1px; min-width:0; font-size:9.5px; color:var(--qos-text-muted); font-variant-numeric: tabular-nums;'
                    }, [ sigmaEl, totalPctEl ])
                ]);
                refs.classes[cls].rowEl = rowEl;

                legendChildren.push(rowEl);
            });

            function applyHighlight() {
                var active = hovered || pinned;
                refreshTip();

                order.forEach(function(cls) {
                    var seg = refs.segEls[cls];
                    var match = !active || active.key === cls;
                    seg.classList.toggle('dimmed', !!active && !match);
                    seg.classList.toggle('active', !!active && match);
                    refs.classes[cls].headerRow.classList.toggle('dimmed', !!active && !match);
                });

                if (!active) {
                    centerPctEl.textContent = lastValues.total;
                    centerLabelEl.textContent = dir.centerLabel;
                } else {
                    var cv = lastValues.classes[active.key];
                    centerPctEl.textContent = cv ? cv.pct : '0.0%';
                    centerLabelEl.textContent = getMeta(active.key).label;
                }
            }

            var legendGrid = E('div', {
                style: 'display:grid; grid-template-columns:repeat(auto-fit, minmax(250px, 1fr)); gap:0 32px; align-content:start;'
            }, legendChildren);

            var card = E('div', { class: 'qos-card' }, [
                E('div', {
                    class: 'qos-donut-wrap',
                    style: 'position:relative; width:100%; max-width:360px; aspect-ratio:1/1; flex:0 1 360px; background:transparent !important;'
                }, [
                    svg,
                    E('div', {
                        style: 'position:absolute; inset:30.8%; border-radius:50%; background:var(--qos-surface); display:flex; flex-direction:column; align-items:center; justify-content:center; box-shadow: inset 0 0 0 1px var(--qos-text-muted);'
                    }, [ centerPctEl, centerLabelEl ])
                ]),
                E('div', { style: 'width:100%; max-width:760px; min-width:280px; flex:1 1 520px; box-sizing:border-box;' }, [ activeCountEl, legendGrid ])
            ]);

            var linkStatsBar = E('div', { style: 'position:absolute; left:0; top:0; bottom:0; width:0%; background:var(--qos-text-muted); opacity:0.15; transition:width 0.4s ease; border-radius:6px; pointer-events:none;' });
            var linkStatsText = E('span', { style: 'position:relative; z-index:1; font-weight:600;' }, _('Measuring real interface throughput...'));
            var linkStatsEl = E('div', {
                style: 'position:relative; display:inline-block; font-size:11.5px; color:var(--qos-text-strong); margin-bottom:8px; font-variant-numeric: tabular-nums; text-align:center; padding:4px 12px; border-radius:6px; background:rgba(0,0,0,0.03); overflow:hidden; min-width:60%;'
            }, [ linkStatsBar, linkStatsText ]);

            var diagEl = E('div', {
                style: 'font-size:9.5px; color:var(--qos-text-muted); margin-bottom:6px; font-variant-numeric: tabular-nums; text-align:center;'
            }, '');

            var panelEl = E('div', { class: 'qos-panel' }, [
                E('div', { class: 'qos-panel-title' }, dir.title),
                E('div', { style: 'width:100%; display:flex; justify-content:center;' }, [ linkStatsEl ]),
                diagEl,
                card
            ]);

            function refreshMeta() {
                order.forEach(function(cls) {
                    var m = getMeta(cls);
                    refs.segEls[cls].setAttribute('stroke', m.color);
                    refs.classes[cls].swatchEl.style.background = m.color;
                    var alert = isAlertMatch(m.label);
                    refs.classes[cls].labelEl.textContent = (alert ? '⚠ ' : '') + alertBaseLabel(m.label);
                    refs.classes[cls].labelEl.style.color = alert ? 'var(--qos-danger, #dc2626)' : 'var(--qos-text-strong)';
                    refs.classes[cls].labelEl.style.fontWeight = alert ? '800' : '600';
                    refs.classes[cls].headerRow.style.background = alert ? 'rgba(220,38,38,0.09)' : '';
                    refs.classes[cls].headerRow.title = alert ? _('Warning: matches a configured alert rule') : '';
                    if (refs.classes[cls].liveBar)
                        refs.classes[cls].liveBar.style.background = m.color;
                });
            }

            function applyUpdate(classBytes, classPackets, classRate, ifaceRateBps, configuredKbit, ifaceSourceName, baselineLabel, metaSnapshot) {
                if (dynamicMeta) { if (metaSnapshot) currentMeta = metaSnapshot; refreshMeta(); }
                var rawTotal = order.reduce(function(s, cls) { return s + classRate[cls]; }, 0);
                var totalBytesSum = order.reduce(function(s, cls) { return s + classBytes[cls]; }, 0);

                var MIN_SLICE_FRACTION = 0.002;
                var displayRates = {};
                order.forEach(function(cls) {
                    if (rawTotal === 0) {
                        displayRates[cls] = 1;
                    } else if (classRate[cls] > 0) {
                        displayRates[cls] = Math.max(classRate[cls], rawTotal * MIN_SLICE_FRACTION);
                    } else {
                        displayRates[cls] = 0;
                    }
                });
                var displayTotal = order.reduce(function(s, cls) { return s + displayRates[cls]; }, 0);

                var offsetSoFar = 0;
                order.forEach(function(cls) {
                    var frac = displayTotal > 0 ? (displayRates[cls] / displayTotal) : 0;
                    var segLen = frac * CIRC;
                    var seg = refs.segEls[cls];
                    seg.setAttribute('stroke-dasharray', segLen.toFixed(2) + ' ' + (CIRC - segLen).toFixed(2));
                    seg.setAttribute('stroke-dashoffset', (-offsetSoFar).toFixed(2));
                    offsetSoFar += segLen;
                });

                lastValues.total = rawTotal > 0 ? '100.0%' : '0.0%';
                var activeClassCount = order.filter(function(cls) {
                    return classRate[cls] > 0 && cls !== UN_SLOT;
                }).length;
                activeCountEl.textContent = _('%s (%d active)').format(noun, activeClassCount);

                var sourceTxt = ifaceSourceName ? ' [' + _('via') + ' ' + ifaceSourceName + ']' : '';
                var configuredMbit = (configuredKbit || 0) / 1000;
                var configuredBps = (configuredKbit || 0) * 1000;
                var totalPct = 0;

                var diagTxt = tcDiagText ? ' - ' + tcDiagText : '';
                if (ifaceRateBps === null || ifaceRateBps === undefined) {
                    linkStatsText.textContent = _('Link rate not available (no tc counters)') + diagTxt + sourceTxt;
                } else {
                    var ifaceMbit = ifaceRateBps * 8 / 1e6;
                    if (configuredMbit > 0) {
                        totalPct = Math.min(100, (ifaceMbit / configuredMbit) * 100);
                        linkStatsText.textContent = _('%s of %s Mbit/s configured (%s%%)').format(formatRate(ifaceRateBps * 8), configuredMbit.toFixed(0), totalPct.toFixed(1)) + sourceTxt;
                    } else {
                        linkStatsText.textContent = formatRate(ifaceRateBps * 8) +
                            (tcDiagText ? ' (' + tcDiagText + ')' : ' (' + _('configured SQM bandwidth not found') + ')') + sourceTxt;
                    }
                }
                linkStatsText.title = tcDiagText || '';
                linkStatsBar.style.width = totalPct.toFixed(1) + '%';

                order.forEach(function(cls) {
                    var classFrac = rawTotal > 0 ? (classRate[cls] / rawTotal) : 0;
                    var classRateBits = classRate[cls] * 8;
                    var livePct = rawTotal > 0 ? (classFrac * 100).toFixed(1) : '0.0';
                    var tPct = totalBytesSum > 0 ? ((classBytes[cls] / totalBytesSum) * 100).toFixed(1) : '0.0';

                    refs.classes[cls].livePct.textContent = formatRate(classRateBits);

                    var barPct = 0;
                    if (configuredBps > 0) {
                        barPct = Math.min(100, (classRateBits / configuredBps) * 100);
                    } else if (rawTotal > 0) {
                        barPct = classFrac * 100;
                    }

                    if (refs.classes[cls].liveBar)
                        refs.classes[cls].liveBar.style.width = barPct.toFixed(1) + '%';

                    refs.classes[cls].sigmaBytes.textContent = formatBytes(classBytes[cls]);
                    refs.classes[cls].sigmaPackets.textContent = formatCount(classPackets[cls]);
                    refs.classes[cls].sigmaSuffixTime.textContent = ' (' + (baselineLabel || _('since start')) + ')';
                    refs.classes[cls].sigma.title = _('Total %s - %s packets (%s)')
                        .format(formatBytes(classBytes[cls]), formatCount(classPackets[cls]), baselineLabel || _('since start'));
                    refs.classes[cls].totalPct.textContent = _('Total: %s%%').format(tPct);

                    lastValues.classes[cls] = { pct: livePct + '%' };
                    refs.classes[cls].rowEl.style.display = classBytes[cls] > 0 ? '' : 'none';
                });

                if (!pinned && !hovered) {
                    centerPctEl.textContent = lastValues.total;
                }
            }

            function update() {
                lastUpdateArgs = arguments;
                if (pinned) return;
                applyUpdate.apply(null, arguments);
            }

            function clearPinned() {
                if (pinned) { setPinned(null); }
            }

            // pin the slice of this entry (used by links from other tabs)
            function pinClass(cls) {
                var c = refs.classes[cls];
                var row = c && c.headerRow;
                if (!row) return false;
                if (c.rowEl) c.rowEl.style.display = '';
                try { if (row.scrollIntoView) row.scrollIntoView({ block: 'center' }); } catch (e) {}
                var r = row.getBoundingClientRect ? row.getBoundingClientRect() : null;
                if (r && r.width > 0 && r.height > 0) {
                    tipPos.x = r.left + Math.min(r.width, 240) / 2;
                    tipPos.y = r.top + r.height / 2;
                } else {
                    tipPos.x = Math.max(80, window.innerWidth / 2 - 120);
                    tipPos.y = 200;
                }
                setPinned({ type: 'class', key: cls });
                return true;
            }

            return { el: panelEl, update: update, clearPinned: clearPinned, pinClass: pinClass };
        }

        function slotHue(name) {
            var h = 7;
            for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
            return h;
        }

        function makeSlotView(top, noun, labelOf, otherLabelOf, detailsOf, detailTitle, navDim) {
            var slots = [];
            for (var i = 0; i <= top; i++) slots.push('s' + i);
            slots.push(UN_SLOT);
            var emptyMeta = { label: '', color: 'hsl(0,0%,70%)' };
            var v = { rate: { 'in': {}, 'out': {} }, order: { 'in': [], 'out': [] } };
            var lastItems = {};
            var RANK_MARGIN = 1.25;
            v.panelIn = buildDirectionPanel(DIRECTIONS[0], slots, function() { return emptyMeta; }, true, noun);
            v.panelOut = buildDirectionPanel(DIRECTIONS[1], slots, function() { return emptyMeta; }, true, noun);

            function rankNames(d, items) {
                var all = Object.keys(items), seen = {}, arr = [], sc = {}, fresh;
                all.forEach(function(n) {
                    var act = v.rate[d][n] || 0;
                    sc[n] = { g: act > 0 ? 1 : 0, a: act, t: items[n][d + '_bytes'] || 0 };
                });
                v.order[d].forEach(function(n) { if (n in items) { arr.push(n); seen[n] = true; } });
                fresh = all.filter(function(n) { return !seen[n]; });
                fresh.sort(function(a, b) {
                    var x = sc[a], y = sc[b];
                    return (y.g - x.g) || (y.a - x.a) || (y.t - x.t) || (a < b ? -1 : (a > b ? 1 : 0));
                });
                arr = arr.concat(fresh);
                function beats(x, y) {
                    var X = sc[x], Y = sc[y];
                    if (X.g !== Y.g) return X.g > Y.g;
                    return X.g ? (X.a > Y.a * RANK_MARGIN) : (X.t > Y.t);
                }
                var previous = {};
                arr.forEach(function(n, i) { previous[n] = i; });
                arr.sort(function(a, b) {
                    if (beats(a, b)) return -1;
                    if (beats(b, a)) return 1;
                    return previous[a] - previous[b];
                });
                v.order[d] = arr;
                return arr;
            }

            // pin the entry in the direction where it moves more traffic (falls back to the other one)
            v.canPin = function(key) {
                var d, idx;
                for (d = 0; d < 2; d++) {
                    idx = v.order[d ? 'out' : 'in'].indexOf(key);
                    if (idx >= 0 && idx < top) return true;
                }
                return false;
            };
            v.pinKey = function(key) {
                var first = (v.rate['in'][key] || 0) >= (v.rate.out[key] || 0) ? [ 'in', 'out' ] : [ 'out', 'in' ], i, idx;
                v.panelIn.clearPinned(); v.panelOut.clearPinned();
                for (i = 0; i < first.length; i++) {
                    idx = v.order[first[i]].indexOf(key);
                    if (idx >= 0 && idx < top && (first[i] === 'in' ? v.panelIn : v.panelOut).pinClass(slots[idx])) return true;
                }
                for (i = 0; i < first.length; i++) {
                    idx = v.order[first[i]].indexOf(key);
                    if (idx >= 0 && idx < top && (first[i] === 'out' ? v.panelIn : v.panelOut).pinClass(slots[idx])) return true;
                }
                if (lastItems && lastItems[key]) {
                    var item = lastItems[key];
                    var inR = v.rate['in'][key] || item.in_bps || 0, outR = v.rate.out[key] || item.out_bps || 0;
                    var meta = {
                        label: labelOf(key, item),
                        color: 'hsl(' + slotHue(key) + ',58%,46%)',
                        details: detailsOf ? navRows(detailsOf(item), REL_DIM[navDim]) : null,
                        detailTitle: detailTitle,
                        nav: { dim: navDim, key: key, label: alertBaseLabel(labelOf(key, item)) },
                        kind: 'live',
                        interactive: true,
                        sub: '\u2193 ' + formatRate(inR) + '   \u2191 ' + formatRate(outR)
                    };
                    tipPos.x = Math.max(80, window.innerWidth / 2 - 120);
                    tipPos.y = 200;
                    tipShow(meta);
                    return true;
                }
                return false;
            };
            v.render = function(items, ifaceRate, sqmDownKbit, sqmUpKbit, iface, baselineLabel, rateInfo) {
                lastItems = items || {};
                var link = ifaceRate || { rx: null, tx: null };
                // The aggregator's own "(other)" entry (folded rows, with a "count") is not ranked like a normal
                // row: it is merged into the one grey "Other" bucket below together with the rows beyond the top.
                var otherItem = items['(other)'] || null;
                if (otherItem) {
                    var rankedItems = {};
                    Object.keys(items).forEach(function(k) { if (k !== '(other)') rankedItems[k] = items[k]; });
                    items = rankedItems;
                }
                var res = { meta: { 'in': {}, 'out': {} },
                            'in': { bytes: {}, packets: {}, rate: {} }, 'out': { bytes: {}, packets: {}, rate: {} } };
                ['in', 'out'].forEach(function(d) {
                    Object.keys(items).forEach(function(n) { v.rate[d][n] = items[n][d + '_bps'] || 0; });
                    var names = rankNames(d, items);
                    slots.forEach(function(sl) {
                        res.meta[d][sl] = { label: '', color: 'hsl(0,0%,70%)' };
                        res[d].bytes[sl] = 0; res[d].packets[sl] = 0; res[d].rate[sl] = 0;
                    });
                    names.forEach(function(name, i) {
                        var sl = slots[Math.min(i, top)];
                        if (i < top)
                            res.meta[d][sl] = { label: labelOf(name, items[name]), color: 'hsl(' + slotHue(name) + ',58%,46%)', details: detailsOf ? navRows(detailsOf(items[name]), REL_DIM[navDim]) : null, detailTitle: detailTitle,
                                nav: { dim: navDim, key: name, label: alertBaseLabel(labelOf(name, items[name])) }, kind: 'live' };
                        res[d].bytes[sl] += items[name][d + '_bytes'] || 0;
                        res[d].packets[sl] += items[name][d + '_packets'] || 0;
                        res[d].rate[sl] += v.rate[d][name] || 0;
                    });
                    var otherCount = names.length > top ? names.length - top : 0;
                    if (otherItem) {
                        res[d].bytes[slots[top]] += otherItem[d + '_bytes'] || 0;
                        res[d].packets[slots[top]] += otherItem[d + '_packets'] || 0;
                        res[d].rate[slots[top]] += otherItem[d + '_bps'] || 0;
                        otherCount += otherItem.count || 1;
                    }
                    if (otherCount > 0)
                        res.meta[d][slots[top]] = { label: otherLabelOf(otherCount), color: 'hsl(210,8%,62%)' };
                    if (rateInfo && rateInfo.tc) {
                        var un = (d === 'in') ? { rate: rateInfo.un_rx_bps || 0, bytes: rateInfo.un_rx_bytes || 0, link: link.rx || 0, conf: rateInfo.un_rx_conf }
                                              : { rate: rateInfo.un_tx_bps || 0, bytes: rateInfo.un_tx_bytes || 0, link: link.tx || 0, conf: rateInfo.un_tx_conf };
                        if (un.rate >= Math.max(UN_MIN_BPS, UN_MIN_SHARE * un.link)) {
                            // un.conf === 0: the aggregator's short-window estimate disagreed
                            // sharply with its steadier long-window one, meaning this figure is
                            // likely mostly counter-sync jitter rather than real missing
                            // traffic (see un_update() in trafficchart-agg) - label it as such
                            // instead of presenting it with the same confidence as a normal row.
                            var unLabel = (un.conf === 0)
                                ? _('Not attrib. (sync jitter)')
                                : _('Not attrib. (N/C)');
                            // flows that exist but have no byte counters in conntrack (created while accounting was off):
                            // their traffic is carried by the shaper and can never be counted - say so instead of leaving it unexplained
                            if (un.conf !== 0 && rateInfo.nocount > 0)
                                unLabel += ' - ' + _('%d flows w/o counters').format(rateInfo.nocount);
                            res.meta[d][UN_SLOT] = { label: unLabel, color: 'hsl(0,0%,55%)', details: null };
                            res[d].rate[UN_SLOT] = un.rate;
                            res[d].bytes[UN_SLOT] = Math.max(un.bytes, 1);
                        }
                    }
                });
                v.panelIn.update(res['in'].bytes, res['in'].packets, res['in'].rate, link.rx, sqmDownKbit, iface ? iface.rx_source : null, baselineLabel, res.meta['in']);
                v.panelOut.update(res['out'].bytes, res['out'].packets, res['out'].rate, link.tx, sqmUpKbit, iface ? iface.tx_source : null, baselineLabel, res.meta['out']);
            };
            return v;
        }

        var MAX_ROWS = 22;
        var appsView = makeSlotView(MAX_ROWS - 1, _('Applications'),
            function(name) { return name; },
            function(n) { return _('Other (%d applications)').format(n); },
            function(e) { return (e.top && e.top.length) ? e.top : null; }, _('Top destinations'), 'a');
        var devicesView = makeSlotView(MAX_ROWS - 1, _('Devices'),
            function(key, e) {
                if (key === '(other)' && e.count) return _('Other (%d devices)').format(e.count);
                var nm = e.name || key;
                if (e.ip && e.ip !== nm) nm += ' (' + e.ip + ')';
                return nm;
            },
            function(n) { return _('Other (%d devices)').format(n); },
            function(e) {
                var t = (e.top || []).slice();
                if ((e.via_in || 0) + (e.via_out || 0) > 0) {
                    var viaRow = [ _('via router services (proxy, DNS, LuCI ...) - LAN side, not WAN'), e.via_in || 0, e.via_out || 0 ];
                    viaRow.nonav = true;
                    t.push(viaRow);
                }
                return t.length ? t : null;
            }, _('Top applications'), 'd');
        var hostsView = makeSlotView(MAX_ROWS - 1, _('Destinations'),
            function(name, e) { return (name === '(other)' && e && e.count) ? _('Other (%d destinations)').format(e.count) : name; },
            function(n) { return _('Other (%d destinations)').format(n); },
            function(e) { return (e.top && e.top.length) ? e.top : null; }, _('Top devices'), 'h');
        var slotViews = [ appsView, devicesView, hostsView ];

        function makeFlowsView() {
            var v = {};
            var flowRows = [], emptyRow;
            var COL_WIDTHS = [ 16, 14, 30, 8, 11, 11, 10 ];
            var colgroup = E('colgroup', {}, COL_WIDTHS.map(function(w) {
                return E('col', { style: 'width:' + w + '%;' });
            }));
            var trunc = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            var hdr = function(t, right) { return E('th', { class: 'th', style: (right ? 'text-align:right; ' : '') + trunc }, t); };
            var head = E('tr', { class: 'tr table-titles' }, [
                hdr(_('Device')), hdr(_('Application')), hdr(_('Destination')), hdr(_('Port')),
                hdr(_('Download'), true), hdr(_('Upload'), true), hdr(_('Volume'), true) ]);
            var table = E('table', { class: 'table', id: 'qos_flows_table', style: 'table-layout:fixed; width:100%;' }, [ colgroup, head ]);
            var num = 'text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap;';
            v.el = E('div', { style: 'width:100%; display:none;' }, [
                E('div', { class: 'qos-panel-title', style: 'text-align:center;' }, _('Busiest flows (smoothed rate, top 25)')),
                table ]);
            function makeBarCell(color) {
                var bar = E('div', { style: 'position:absolute; right:0; top:2px; bottom:2px; width:0%; background:' + color + '; border-radius:4px; z-index:0; transition:width 0.4s ease; pointer-events:none;' });
                var text = E('span', { style: 'position:relative; z-index:1;' });
                return { cell: E('td', { class: 'td', style: num + ' position:relative; padding-right:8px;' }, [ bar, text ]), bar: bar, text: text };
            }
            function makeFlowRow() {
                var down = makeBarCell('rgba(110, 231, 183, 0.22)');
                var up = makeBarCell('rgba(147, 197, 253, 0.22)');
                var cells = [
                    E('td', { class: 'td', style: trunc }), E('td', { class: 'td', style: trunc }),
                    E('td', { class: 'td', style: trunc }), E('td', { class: 'td', style: trunc }),
                    down.cell, up.cell, E('td', { class: 'td', style: num + ' ' + trunc })
                ];
                var row = { el: E('tr', { class: 'tr' }, cells), cells: cells, down: down, up: up };
                table.appendChild(row.el);
                return row;
            }
            v.update = function(flows, sqmDownKbit, sqmUpKbit) {
                if (!flows || !flows.length) {
                    flowRows.forEach(function(row) { row.el.style.display = 'none'; });
                    if (!emptyRow) {
                        emptyRow = E('tr', { class: 'tr' }, [ E('td', { class: 'td', colspan: 7 }, _('No active flows')) ]);
                        table.appendChild(emptyRow);
                    }
                    emptyRow.style.display = '';
                    return;
                }
                if (emptyRow) emptyRow.style.display = 'none';

                var maxIn = 0, maxOut = 0;
                flows.forEach(function(f) {
                    if ((f.in_bps || 0) > maxIn) maxIn = f.in_bps;
                    if ((f.out_bps || 0) > maxOut) maxOut = f.out_bps;
                });

                var downLimitBps = (sqmDownKbit || 0) * 1000;
                var upLimitBps = (sqmUpKbit || 0) * 1000;

                flows.forEach(function(f, i) {
                    var row = flowRows[i] || (flowRows[i] = makeFlowRow());
                    var dest = f.host || f.dst;
                    var dev = (f.ip && f.ip !== f.dev) ? f.dev + ' (' + f.ip + ')' : f.dev;

                    var inBits = (f.in_bps || 0) * 8;
                    var outBits = (f.out_bps || 0) * 8;

                    var pctIn = downLimitBps > 0 ? Math.min(100, (inBits / downLimitBps) * 100) : (maxIn > 0 ? ((f.in_bps || 0) / maxIn * 100) : 0);
                    var pctOut = upLimitBps > 0 ? Math.min(100, (outBits / upLimitBps) * 100) : (maxOut > 0 ? ((f.out_bps || 0) / maxOut * 100) : 0);

                    row.el.style.display = '';
                    row.cells[0].textContent = dev; row.cells[0].title = dev;
                    var appAlert = isAlertMatch(f.app);
                    var destAlert = !!f.dest_alert || isAlertMatch(dest) || isAlertMatch(f.dst);
                    var appLabel = alertBaseLabel(f.app);
                    var destLabel = alertBaseLabel(dest);
                    var hostLabel = alertBaseLabel(f.host || '');
                    var rawDestLabel = alertBaseLabel(f.dst || '');
                    row.cells[1].textContent = (appAlert ? '⚠ ' : '') + appLabel; row.cells[1].title = appAlert ? _('Warning: matches a configured alert rule') : appLabel;
                    row.cells[2].textContent = (destAlert ? '⚠ ' : '') + destLabel; row.cells[2].title = (rawDestLabel + (hostLabel ? ' - ' + hostLabel : '')) + (destAlert ? ' — ' + _('Warning: matches a configured alert rule') : '');
                    row.cells[1].style.color = appAlert ? 'var(--qos-danger, #dc2626)' : '';
                    row.cells[2].style.color = destAlert ? 'var(--qos-danger, #dc2626)' : '';
                    row.cells[1].style.fontWeight = appAlert ? '800' : '';
                    row.cells[2].style.fontWeight = destAlert ? '800' : '';
                    row.el.style.background = (appAlert || destAlert) ? 'rgba(220,38,38,0.08)' : '';
                    row.cells[3].textContent = (f.proto || '') + (f.port ? '/' + f.port : '');
                    row.down.bar.style.width = pctIn.toFixed(1) + '%'; row.down.text.textContent = formatRate(inBits);
                    row.up.bar.style.width = pctOut.toFixed(1) + '%'; row.up.text.textContent = formatRate(outBits);
                    row.cells[6].textContent = formatBytes(f.bytes || 0);
                });
                for (var i = flows.length; i < flowRows.length; i++) flowRows[i].el.style.display = 'none';
            };
            return v;
        }

        function makeHistoryView() {
            var v = { active: false, loadedAt: 0, loading: false, loadingAt: 0, persist: null, hasShaper: false, sqm: { down: 0, up: 0 } };
            var RANGES = [
                { id: '24h',  label: _('24 hours'), tier: '5m', span: 86400 },
                { id: '7d',   label: _('Week'),     tier: '1h', span: 7 * 86400 },
                { id: '30d',  label: _('Month'),    tier: '1h', span: 30 * 86400 },
                { id: '365d', label: _('Year'),     tier: '1d', span: 365 * 86400 }
            ];
            var REFRESH_MS = { '5m': 60000, '1h': 300000, '1d': 900000 };
            // Failed history reads should not wait for the normal long cache TTL before retrying.
            function historyRefreshDelayMs(tier, hasError) {
                return hasError ? 15000 : REFRESH_MS[tier];
            }
            var TIER_SEC = { '5m': 300, '1h': 3600, '1d': 86400 };
            var TIER_ORDER = [ '5m', '1h', '1d' ];   // finest first
            // get_stats caps each reply at 800 buckets / about 1 MB. Page through older
            // buckets so long-history views and comparisons are not silently truncated.
            var HISTORY_PAGE_SIZE = 800;
            var HISTORY_MAX_BUCKETS = 1600; // enough for the longest range plus its comparison
            var loadSequence = 0;
            var hp = prefLoad().hist || {};
            var st = {
                dim: [ 'a', 'd', 'h' ].indexOf(hp.dim) >= 0 ? hp.dim : 'a',
                dir: [ 'in', 'out', 'both' ].indexOf(hp.dir) >= 0 ? hp.dir : 'both',
                range: [ '24h', '7d', '30d', '365d' ].indexOf(hp.range) >= 0 ? hp.range : '24h',
                data: {}, cmp: hp.cmp === true, hidden: {}
            };
            function histSave() { prefSave('hist', { dim: st.dim, dir: st.dir, range: st.range, cmp: st.cmp }); }
            var historyPinned = null;
            var resetError = null;

            function historyTipKey(type, a, b, c) {
                return type + ':' + String(a) + ':' + String(b || '') + ':' + String(c || '');
            }

            function historyTipHover(info, ev) {
                if (historyPinned) return;
                tipTrack(ev);
                tipShow(info);
            }

            function historyTipMove(ev) {
                if (!historyPinned) tipTrack(ev);
            }

            function historyTipLeave() {
                if (!historyPinned) tipHide();
            }

            function historyTipClick(info, ev, key) {
                ev.stopPropagation();

                /* The logical key is the identity of the pin: all buckets of a panel share one overlay element. */
                if (historyPinned && historyPinned.key === key) {
                    historyPinned = null;
                    tipHide();
                    return;
                }

                historyPinned = { key: key };

                info.interactive = true;
                tipTrack(ev);
                tipShow(info);
            }

            /* Clicking the pinned tooltip itself releases the pin. */
            tipEl.addEventListener('click', function(ev) {
                if (!historyPinned) return;
                ev.stopPropagation();
                historyPinned = null;
                tipHide();
            });

            var historyPinOutsideHandler = function(ev) {
                if (!historyPinned) return;
                if (ev.target === tipEl || tipEl.contains(ev.target)) return;
                historyPinned = null;
                tipHide();
            };
            document.addEventListener('click', historyPinOutsideHandler);
            cleanupFns.push(function() {
                document.removeEventListener('click', historyPinOutsideHandler);
                historyPinned = null;
                tipHide();
            });

            var chartHost = E('div', { style: 'width:100%;' });
            var persistEl = E('div', { style: 'text-align:center; font-size:10.5px; color:var(--qos-text-muted); margin-top:4px;' });
            var btnStyle = 'margin-right:6px;';
            var rangeDefs = RANGES.map(function(r) { return [ r.id, r.label ]; });
            var dimDefs = [ ['a', _('Applications')], ['d', _('Devices')], ['h', _('Destinations')] ];
            var dirDefs = [ ['in', _('Download')], ['out', _('Upload')], ['both', _('Both')] ];
            var rangeChecks = [], dimChecks = [], dirChecks = [];
            var cmpCheck = makeOpenWrtCheckbox(_('Compare'), st.cmp, function(checked) {
                st.cmp = checked; histSave(); mark(); render(); if (st.cmp) v.load();
            });
            cmpCheck.input.title = _('Dashed line: the same length of time before the shown period');
            function rangeDef() {
                for (var i = 0; i < RANGES.length; i++) if (RANGES[i].id === st.range) return RANGES[i];
                return RANGES[0];
            }
            function mark() {
                rangeChecks.forEach(function(input, i) { input.checked = st.range === rangeDefs[i][0]; });
                dimChecks.forEach(function(input, i) { input.checked = st.dim === dimDefs[i][0]; });
                dirChecks.forEach(function(input, i) { input.checked = st.dir === dirDefs[i][0]; });
                cmpCheck.input.checked = !!st.cmp;
            }
            var rangeGroup = makeCheckboxGroup(rangeDefs, rangeChecks, st.range, function(id) {
                st.range = id; histSave(); mark(); render(); v.load();
            });
            var dimGroup = makeCheckboxGroup(dimDefs, dimChecks, st.dim, function(id) {
                st.dim = id; st.data = {}; histSave(); mark(); render(); v.load();
            });
            var dirGroup = makeCheckboxGroup(dirDefs, dirChecks, st.dir, function(id) {
                st.dir = id; histSave(); mark(); render();
            });

            var resetBtn = E('button', { type: 'button', style: btnStyle + 'margin-left:18px; color:var(--qos-danger);' }, _('Clear history'));
            if (!canReset) resetBtn.style.display = 'none';
            resetBtn.title = _('Resets the cumulative application/device/destination totals and the stored history, without restarting the service. Buckets already written to a storage path (if configured) are kept.');
            resetBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (!window.confirm(_('Clear all cumulative totals and history? This cannot be undone from here (buckets already saved to a storage path, if any, are kept).')))
                    return;
                resetError = null;
                resetBtn.disabled = true;
                callResetHistory().then(function() {
                    resetError = null;
                    st.data = {};
                    st.err = {};
                    render();
                    v.load();
                }).catch(function(err) {
                    resetError = err && err.message ? err.message : String(err || _('unknown error'));
                    render();
                }).then(function() { resetBtn.disabled = false; });
            });

            v.el = E('div', { style: 'width:100%; display:none;' }, [
                E('div', { style: 'display:flex; gap:18px 24px; flex-wrap:wrap; justify-content:center; align-items:center; margin-bottom:10px;' }, [
                    rangeGroup, dimGroup, dirGroup, cmpCheck.el, resetBtn ]),
                chartHost, persistEl ]);

            function colorOf(k) {
                if (k === '(other)') return 'hsl(210,8%,62%)';
                return 'hsl(' + slotHue(k) + ',58%,46%)';
            }
            var AXIS_TEXT_STYLE = 'font-size:12px; fill:var(--qos-text-muted);';
            function axisRate(mbit) {
                if (mbit >= 100) return Math.round(mbit) + ' Mbit/s';
                if (mbit >= 1) return (Math.round(mbit * 10) / 10) + ' Mbit/s';
                if (mbit > 0) return Math.round(mbit * 1000) + ' kbit/s';
                return '0';
            }
            /*
             * Visual history scaling: emphasize low rates without changing
             * the actual values used by tooltips/export/data processing.
             * sqrt() means 25% of max occupies 50% of the chart height.
             */
            var Y_SCALE_POWER = 0.5;
            function scaleY(rate, dmax) {
                if (!(dmax > 0) || !(rate > 0)) return 0;
                var f = rate / dmax;
                return Math.pow(Math.max(0, Math.min(1, f)), Y_SCALE_POWER);
            }
            function niceMax(x) {
                if (x <= 0) return 1;
                var p = Math.pow(10, Math.floor(Math.log(x) / Math.LN10)), n = x / p;
                return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
            }
            function hhmm(epoch) {
                return new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
            function tickLabel(epoch, span) {
                var d = new Date(epoch * 1000);
                if (span <= 2 * 86400) return hhmm(epoch);
                if (span <= 8 * 86400) return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'numeric' });
                if (span <= 40 * 86400) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
                return d.toLocaleDateString([], { month: 'short', year: 'numeric' });
            }
            function stampLabel(epoch, span) {
                var d = new Date(epoch * 1000);
                if (span <= 2 * 86400) return hhmm(epoch);
                return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + hhmm(epoch);
            }
            function medianDt(B) {
                var a = B.map(function(b) { return b.dt || 0; }).filter(function(x) { return x > 0; }).sort(function(x, y) { return x - y; });
                return a.length ? a[Math.floor(a.length / 2)] : 0;
            }

            function persistLines() {
                var p = v.persist, out = [];
                if (!p) return out;
                if (p.state === 'off')
                    return [ _('Persistence is off: the history is kept in RAM only and is lost on reboot. Set a storage path under Network - Traffic Chart Settings.') ];
                (p.targets || []).forEach(function(t) {
                    var pend = t.pending ? ', ' + _('%d buckets not written yet').format(t.pending) : '';
                    var scope = (t.tiers && t.tiers !== '5m,1h,1d') ? ' (' + t.tiers + ')' : '';
                    if (t.state === 'ok')
                        out.push(_('Saved to %s (last write: %s%s).').format(t.dir + scope, t.saved ? new Date(t.saved * 1000).toLocaleString() : _('not yet'), pend));
                    else if (t.state === 'err')
                        out.push(_('Writing to %s failed - retrying%s.').format(t.dir + scope, pend));
                    else
                        out.push(_('%s is not available (yet) - it gets everything it missed as soon as it is back%s.').format(t.dir + scope, pend));
                });
                out.push(_('Written every %d min to every available target; the history stays in RAM meanwhile.').format(Math.round((p.sec || 0) / 60)));
                return out;
            }
            v.setPersist = function(p) {
                v.persist = p;
                var lines = persistLines(), targets = (p && p.targets) || [];
                while (persistEl.firstChild) persistEl.removeChild(persistEl.firstChild);
                lines.forEach(function(l, i) {
                    var bad = (p && p.state !== 'off' && targets[i] && targets[i].state !== 'ok');
                    persistEl.appendChild(E('div', { style: bad ? 'color:var(--qos-danger);' : '' }, l));
                });
            };

            function localDayStart(epoch) {
                var d = new Date(epoch * 1000);
                return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
            }
            function localDayAdd(epoch, days) {
                var d = new Date(epoch * 1000);
                return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime() / 1000;
            }
            function windowOf(B, R) {
                var latest = B[B.length - 1].t;
                var first = B[0].t - (B[0].dt || 0);

                /* The Week view is seven LOCAL calendar days, not seven arbitrary
                 * 24-hour chunks.  Keep the chart axis independent of bucket
                 * boundaries so DST and partially closed buckets cannot produce
                 * duplicate/missing day labels. */
                if (R.id === '7d' || R.id === '30d' || R.id === '365d') {
                    /* Window = the last 7 / 30 / 365 local calendar days, but never
                     * longer than the data that exists: with little data the window
                     * shrinks to it, so the data fills the full width. */
                    var days = R.id === '7d' ? 7 : (R.id === '30d' ? 30 : 365);
                    var startCal = localDayAdd(localDayStart(latest), -(days - 1));
                    var wStart = Math.max(startCal, first);   // up to 7 / 30 / 365 calendar days, no empty space before the first bucket
                    var selCal = B.filter(function(b) { return b.t > wStart && b.t - (b.dt || 0) < latest; });
                    if (!selCal.length) selCal = [ B[B.length - 1] ];
                    return { end: latest, start: wStart, sel: selCal, axisDays: true, axisRange: R.id, dataEnd: latest };
                }

                var end = latest;
                var start = Math.max(end - R.span, first);
                var sel = B.filter(function(b) { return b.t - (b.dt || 0) >= start; });
                if (!sel.length) sel = [ B[B.length - 1] ];
                return { end: end, start: start, sel: sel, dataEnd: end };
            }
            function durTxt(sec) {
                return sec >= 86400 ? _('%.1f days').format(sec / 86400) : sec >= 3600 ? _('%.1f h').format(sec / 3600) : _('%d min').format(Math.round(sec / 60));
            }
            function backlogTxt(bytes, kbit) {
                var t = formatBytes(bytes);
                if (kbit > 0 && bytes > 0) {
                    var ms = bytes * 8 / (kbit * 1000) * 1000;
                    t += ' (~' + (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms)';
                }
                return t;
            }
            function dimLabel() {
                for (var i = 0; i < dimDefs.length; i++) if (dimDefs[i][0] === st.dim) return dimDefs[i][1];
                return '';
            }
            v.setShaper = function(on) { v.hasShaper = !!on; };
            v.setSqm = function(downKbit, upKbit) { v.sqm = { down: downKbit || 0, up: upKbit || 0 }; };

            function computeStats(sel, dirKey, shKey) {
                var vol = 0, dt = 0, peak = 0, peakT = 0, drops = 0, ecn = 0, bl = 0, rates = [];
                sel.forEach(function(b) {
                    var d = b.dt || 0, bytes = b[dirKey] || 0;
                    if (b.sh && b.sh[shKey]) { drops += b.sh[shKey][0] || 0; ecn += b.sh[shKey][1] || 0; bl = Math.max(bl, b.sh[shKey][2] || 0); }
                    if (d <= 0) return;
                    var r = bytes * 8 / d;
                    vol += bytes; dt += d;
                    rates.push([ r, d ]);
                    if (r > peak) { peak = r; peakT = b.t; }
                });
                rates.sort(function(a, b) { return a[0] - b[0]; });
                var p95 = 0, acc = 0, target = 0.95 * dt;
                for (var i = 0; i < rates.length; i++) {
                    acc += rates[i][1];
                    p95 = rates[i][0];
                    if (acc >= target) break;
                }
                return { vol: vol, avg: dt > 0 ? vol * 8 / dt : 0, p95: p95, peak: peak, peakT: peakT, drops: drops, ecn: ecn, bl: bl };
            }

            function statsTable(sel, R, bl) {
                var cell = 'padding:1px 10px; font-size:11px; line-height:1.5; height:auto;';
                var num = cell + ' text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap;';
                var head = E('tr', { 'class': 'tr table-titles' }, [
                    E('th', { 'class': 'th', style: cell }, ''),
                    E('th', { 'class': 'th', style: num }, _('Volume')),
                    E('th', { 'class': 'th', style: num, title: _('Volume divided by the time the aggregator was running') }, _('Average')),
                    E('th', { 'class': 'th', style: num, title: _('95% of the time the rate was at or below this value (time-weighted)') }, _('95th percentile')),
                    E('th', { 'class': 'th', style: num, title: _('Highest bucket average in the period') }, _('Peak')) ]);
                // shaper columns only when the shaper really reported something in the shown period
                var stIn = computeStats(sel, 'in', 'rx'), stOut = computeStats(sel, 'out', 'tx');
                var showDrops = v.hasShaper && (stIn.drops > 0 || stOut.drops > 0);
                var showEcn = v.hasShaper && (stIn.ecn > 0 || stOut.ecn > 0);
                var showBl = v.hasShaper && (stIn.bl > 0 || stOut.bl > 0);
                if (showDrops) head.appendChild(E('th', { 'class': 'th', style: num }, _('Shaper drops')));
                if (showEcn) head.appendChild(E('th', { 'class': 'th', style: num }, _('ECN marks')));
                if (showBl) head.appendChild(E('th', { 'class': 'th', style: num, title: _('Highest momentary queue backlog seen at a poll; in brackets the time the shaper needs to drain it at the configured rate') }, _('Peak backlog')));
                var rows = [ head ];
                [ [ 'in', _('Download'), 'rx', v.sqm.down * 1000 ], [ 'out', _('Upload'), 'tx', v.sqm.up * 1000 ] ].forEach(function(d) {
                    var x = computeStats(sel, d[0], d[2]), link = d[3];
                    function rateCell(bps) {
                        var pct = link > 0 ? bps / link * 100 : -1;
                        return formatRate(bps) + (pct >= 0 ? ' (' + pct.toFixed(pct < 10 ? 1 : 0) + ' %)' : '');
                    }
                    var row = E('tr', { 'class': 'tr' }, [
                        E('td', { 'class': 'td', style: cell + ' font-weight:600;' }, d[1]),
                        E('td', { 'class': 'td', style: num }, formatBytes(x.vol)),
                        E('td', { 'class': 'td', style: num }, rateCell(x.avg)),
                        E('td', { 'class': 'td', style: num }, rateCell(x.p95)),
                        E('td', { 'class': 'td', style: num, title: x.peakT ? stampLabel(x.peakT, R.span) : '' }, rateCell(x.peak))
                    ]);
                    if (showDrops) row.appendChild(E('td', { 'class': 'td', style: num }, formatCount(x.drops)));
                    if (showEcn) row.appendChild(E('td', { 'class': 'td', style: num }, formatCount(x.ecn)));
                    if (showBl) row.appendChild(E('td', { 'class': 'td', style: num }, x.bl > 0 ? backlogTxt(x.bl, link / 1000) : ''));
                    rows.push(row);
                });
                return E('div', { style: 'width:fit-content; max-width:100%; margin:10px auto 0; overflow-x:auto;' }, [
                    E('div', { style: 'font-size:11px; font-weight:700; color:var(--qos-text-strong); margin-bottom:2px;' }, _('Statistics for the shown period')),
                    E('table', { 'class': 'table', style: 'width:auto; margin:0;' }, rows),
                    E('div', { style: 'font-size:9.5px; color:var(--qos-text-muted); margin-top:2px; max-width:640px;' },
                        _('Computed from the stored buckets (%s each), so short bursts inside a bucket are averaged out.').format(durTxt(bl)) +
                        (v.sqm.down > 0 || v.sqm.up > 0 ? ' ' + _('Percentages refer to the configured SQM rate.') : '')) ]);
            }

            function historyExportData() {
                var R = rangeDef(), B = st.data[R.tier];
                if (!B || !B.length) return null;
                var w = windowOf(B, R);
                // Take a snapshot of exactly what the History view currently shows.
                // Do not fall back to the live-data exporter and do not export a
                // different tier/dimension because another tab/range was used before.
                var dim = st.dim, dir = st.dir;
                var buckets = w.sel.map(function(b) {
                    var out = {
                        t: b.t,
                        dt: b.dt || 0,
                        in: b['in'] || 0,
                        out: b.out || 0
                    };
                    out[dim] = b[dim] || {};
                    if (b.sh) out.sh = b.sh;
                    return out;
                });
                return { R: R, start: w.start, end: w.end, dim: dim, dir: dir, buckets: buckets };
            }
            v.exportJson = function() {
                var d = historyExportData();
                if (!d) return;
                saveFile('trafficchart-history-' + d.R.id + '-' + stamp() + '.json', 'application/json', JSON.stringify({
                    generated: new Date().toISOString(),
                    range: d.R.id,
                    tier: d.R.tier,
                    from: d.start,
                    to: d.end,
                    dimension: d.dim,
                    direction: d.dir,
                    sqm_kbit: { download: v.sqm.down, upload: v.sqm.up },
                    buckets: d.buckets
                }, null, 2));
            };
            v.exportCsv = function() {
                var d = historyExportData();
                if (!d) return;
                var dimName = d.dim === 'a' ? 'application' : d.dim === 'd' ? 'device' : 'destination';
                var lines = [ csvLine([ 'time_start', 'time_end', 'epoch_end', 'seconds', 'dimension', 'id', 'name', 'in_bytes', 'out_bytes', 'rx_drops', 'rx_ecn', 'tx_drops', 'tx_ecn', 'rx_backlog_peak_bytes', 'tx_backlog_peak_bytes' ]) ];
                d.buckets.forEach(function(b) {
                    var dt = b.dt || 0, t0 = new Date((b.t - dt) * 1000).toISOString(), t1 = new Date(b.t * 1000).toISOString();
                    var sh = b.sh || {}, rx = sh.rx || [], tx = sh.tx || [];
                    lines.push(csvLine([ t0, t1, b.t, dt, 'total', '', '', b['in'], b.out, rx[0] || 0, rx[1] || 0, tx[0] || 0, tx[1] || 0, rx[2] || 0, tx[2] || 0 ]));
                    var src = b[d.dim] || {};
                    Object.keys(src).forEach(function(k) {
                        lines.push(csvLine([ t0, t1, b.t, dt, dimName, k, (d.dim === 'd' && src[k][2]) ? src[k][2] : k, src[k][0], src[k][1], '', '', '', '', '', '' ]));
                    });
                });
                saveFile('trafficchart-history-' + d.R.id + '-' + stamp() + '.csv', 'text/csv', lines.join('\n') + '\n');
            };

            function render() {
                while (chartHost.firstChild) chartHost.removeChild(chartHost.firstChild);
                tipHide();
                if (resetError) {
                    chartHost.appendChild(E('div', { style: 'text-align:center; color:var(--qos-danger); padding:8px 0;' },
                        _('Could not clear history: ') + resetError));
                }
                var R = rangeDef(), B = st.data[R.tier];
                var errored = st.err && st.err[R.tier];
                var compareErrored = st.cmp && TIER_ORDER.slice(TIER_ORDER.indexOf(R.tier) + 1).some(function(t) { return st.err && st.err[t]; });
                if (!B) {
                    if (errored) {
                        chartHost.appendChild(E('div', { style: 'text-align:center; color:var(--qos-danger); padding:30px 0;' },
                            _('History could not be loaded (request to the aggregator failed). Retrying automatically.')));
                    } else {
                        chartHost.appendChild(E('div', { style: 'text-align:center; color:var(--qos-text-muted); padding:30px 0;' }, _('Loading...')));
                    }
                    return;
                }
                if (errored || compareErrored) {
                    chartHost.appendChild(E('div', { style: 'text-align:center; color:var(--qos-danger); font-size:11px; padding:4px 0;' },
                        errored
                            ? _('The last refresh of this history failed - showing the most recently loaded data, which may be outdated. Retrying automatically.')
                            : _('The previous-period comparison could not be fully refreshed; it may use older or incomplete data.')));
                }
                if (!B.length) {
                    chartHost.appendChild(E('div', { style: 'text-align:center; color:var(--qos-text-muted); padding:30px 0;' },
                        R.tier === '5m' ? _('No history yet - the first bucket is written 5 minutes after the aggregator started.')
                                        : _('No data for this range yet - hourly buckets are closed at the full hour, daily buckets at midnight (and when the service is stopped).')));
                    return;
                }

                var dirs = st.dir === 'both' ? [ 'in', 'out' ] : [ st.dir ];
                var idx = dirs.map(function(d) { return d === 'in' ? 0 : 1; });
                function val(e) { var t = 0; idx.forEach(function(i) { t += e[i] || 0; }); return t; }

                var win = windowOf(B, R), end = win.end, start = win.start, sel = win.sel;

                var W = Math.max(360, Math.round(chartHost.clientWidth || 900));
                var PANEL_H = 210, pl = 84, pr = 10, pt = 10, pb = 10;
                var DROP_H = 7;
                var AXIS_H = 26;
                var PANEL_GAP = 28;
                var pw = W - pl - pr, ph = PANEL_H - pt - pb;

                var bl = medianDt(sel) || TIER_SEC[R.tier];
                var maxCols = Math.max(20, Math.floor(pw / (win.axisDays ? 2.5 : 3)));
                var m = Math.max(1, Math.ceil(((end - start) / maxCols) / bl - 0.01));
                var colw = m * bl;
                var ncols = Math.max(1, Math.ceil((end - start) / colw));
                var t0 = end - ncols * colw;
                var cols = [];
                for (var ci0 = 0; ci0 < ncols; ci0++) cols.push({ dt: 0, src: {}, rel: {}, alerts: {}, drop: { rx: 0, tx: 0 }, ecn: { rx: 0, tx: 0 }, bl: { rx: 0, tx: 0 } });
                sel.forEach(function(b) {
                    var bd = b.dt || 0;
                    if (bd <= 0) return;
                    var b0 = b.t - bd, b1 = b.t;
                    var c0 = Math.max(0, Math.floor((b0 - t0) / colw));
                    var c1 = Math.min(ncols - 1, Math.floor((b1 - t0 - 1e-9) / colw));
                    if (c1 < 0 || c0 > ncols - 1) return;
                    c0 = Math.max(0, c0);
                    c1 = Math.min(ncols - 1, c1);
                    for (var cj = c0; cj <= c1; cj++) {
                        var o0 = Math.max(b0, t0 + cj * colw);
                        var o1 = Math.min(b1, t0 + (cj + 1) * colw);
                        var ov = o1 - o0;
                        if (ov <= 0) continue;
                        var frac = ov / bd;
                        var c = cols[cj], src = b[st.dim] || {};
                        c.dt += ov;
                        Object.keys(src).forEach(function(k) {
                            var s = c.src[k] || (c.src[k] = [0, 0]);
                            s[0] += (src[k][0] || 0) * frac;
                            s[1] += (src[k][1] || 0) * frac;
                            // related entries stored with the bucket (destinations of an application, applications of a
                            // device, devices of a destination), summed over the buckets of this column
                            var relArr = (st.dim === 'd') ? src[k][3] : src[k][2];
                            if (Array.isArray(relArr)) {
                                var rm = c.rel[k] || (c.rel[k] = {});
                                relArr.forEach(function(r) {
                                    var e = rm[r[0]] || (rm[r[0]] = [0, 0, '']);
                                    e[0] += (r[1] || 0) * frac; e[1] += (r[2] || 0) * frac;
                                    if (r[3]) e[2] = r[3];
                                });
                            }
                            // warning flag of THIS bucket (device label carries a suffix, apps/destinations their name)
                            if (isAlertMatch(k) || (st.dim === 'd' && isAlertMatch(src[k][2]))) c.alerts[k] = 1;
                        });
                        if (b.sh) {
                            c.drop.rx += ((b.sh.rx && b.sh.rx[0]) || 0) * frac;
                            c.drop.tx += ((b.sh.tx && b.sh.tx[0]) || 0) * frac;
                            c.ecn.rx += ((b.sh.rx && b.sh.rx[1]) || 0) * frac;
                            c.ecn.tx += ((b.sh.tx && b.sh.tx[1]) || 0) * frac;
                            c.bl.rx = Math.max(c.bl.rx, (b.sh.rx && b.sh.rx[2]) || 0);
                            c.bl.tx = Math.max(c.bl.tx, (b.sh.tx && b.sh.tx[2]) || 0);
                        }
                    }
                });

                var totals = {}, names = {}, alertKeys = {};
                sel.forEach(function(b) {
                    var src = b[st.dim] || {};
                    Object.keys(src).forEach(function(k) {
                        totals[k] = (totals[k] || 0) + val(src[k]);
                        if (st.dim === 'd' && src[k][2]) names[k] = alertBaseLabel(src[k][2]);
                        if (isAlertMatch(k) || (st.dim === 'd' && isAlertMatch(src[k][2]))) alertKeys[k] = true;
                    });
                });
                var keys = Object.keys(totals).sort(function(a, b) { return totals[b] - totals[a]; });
                var TOP = 8, shown = keys.slice(0, TOP), rest = keys.slice(TOP);
                var hiddenSet = st.hidden[st.dim] || (st.hidden[st.dim] = {});
                if (st.focus && !v.loading) {
                    var fk = st.focus, allK = shown.slice();
                    st.focus = null;
                    if (rest.length) allK.push('__rest');
                    if (shown.indexOf(fk) >= 0) allK.forEach(function(x) { hiddenSet[x] = (x !== fk); });
                    else {
                        var msgEl = E('div', { style: 'text-align:center; color:var(--qos-danger); font-size:11.5px; padding:4px 0 8px;' }, [
                            document.createTextNode(_('"%s" is not among the biggest entries of this period, so it has no series of its own here. ').format(st.focusLabel)),
                            E('a', {
                                href: '#',
                                style: 'text-decoration:underline; font-weight:700; cursor:pointer;',
                                title: _('Open in Volume')
                            }, _('Open in Volume')),
                            (navOrigin && navOrigin.label ? E('span', { style: 'margin:0 8px;' }, '•') : ''),
                            (navOrigin && navOrigin.label ? E('a', {
                                href: '#',
                                style: 'text-decoration:underline; cursor:pointer;',
                                title: _('Back to %s').format(navOrigin.label)
                            }, '\u2190 ' + _('Back to %s').format(navOrigin.label)) : '')
                        ]);
                        var links = msgEl.querySelectorAll('a');
                        if (links[0]) links[0].addEventListener('click', function(ev) {
                            ev.preventDefault(); ev.stopPropagation();
                            navVolume({ dim: st.dim, key: fk, label: st.focusLabel }, navOrigin, st.range);
                        });
                        if (links[1]) links[1].addEventListener('click', function(ev) {
                            ev.preventDefault(); ev.stopPropagation();
                            var prev = navOrigin; navOrigin = null;
                            if (prev.kind === 'vol') navVolume(prev, null, st.range);
                            else {
                                // pass prev as owner so navOrigin is kept if pinKey fails
                                var fakeOwner = { dim: prev.dim, key: prev.key, label: prev.label, tab: prev.tab };
                                focusLive(prev.dim, prev.key, prev.label, st.range, fakeOwner);
                            }
                        });
                        chartHost.appendChild(msgEl);
                    }
                }
                var series = shown.slice();
                if (rest.length) series.push('__rest');
                series = series.filter(function(k) { return !hiddenSet[k]; });

                cols.forEach(function(c) {
                    c.byDir = {};
                    dirs.forEach(function(d) {
                        var di = d === 'in' ? 0 : 1;
                        var out = {}, tot = 0;
                        series.forEach(function(k) { out[k] = 0; });
                        Object.keys(c.src).forEach(function(k) {
                            var mbit = c.dt > 0 ? (c.src[k][di] || 0) * 8 / c.dt / 1e6 : 0;
                            var key = (shown.indexOf(k) >= 0) ? k : '__rest';
                            out[key] = (out[key] || 0) + mbit;
                        });
                        series.forEach(function(k) { tot += out[k] || 0; });
                        c.byDir[d] = { v: out, total: tot };
                    });
                });

                // Previous period: the same length of time right before the shown window. The shown tier only
                // reaches back as far as its keep limit (24 h of 5 min buckets, for example, has nothing before it),
                // so the finest tier that covers most of that time is used, and every bucket is spread over the
                // columns it overlaps.
                var shift = ncols * colw, pcols = [], prevAny = false, pStart = t0 - shift;
                for (var pi = 0; pi < ncols; pi++) pcols.push({ dt: 0, b: [0, 0] });
                var prevB = null, prevCov = 0;
                if (st.cmp) TIER_ORDER.slice(TIER_ORDER.indexOf(R.tier)).forEach(function(tier) {
                    var Bt = st.data[tier];
                    if (!Bt || !Bt.length) return;
                    var cov = 0;
                    Bt.forEach(function(b) { var ov = Math.min(b.t, t0) - Math.max(b.t - (b.dt || 0), pStart); if (ov > 0) cov += ov; });
                    if (cov > prevCov + 0.05 * shift) { prevB = Bt; prevCov = cov; }
                });
                (prevB || []).forEach(function(b) {
                    var d = b.dt || 0;
                    if (d <= 0) return;
                    var o0 = Math.max(b.t - d, pStart), o1 = Math.min(b.t, t0);
                    if (o1 <= o0) return;
                    var c0 = Math.max(0, Math.floor((o0 + shift - t0) / colw)), c1 = Math.min(ncols - 1, Math.floor((o1 + shift - t0 - 1e-6) / colw));
                    for (var cj = c0; cj <= c1; cj++) {
                        var ov = Math.min(o1 + shift, t0 + (cj + 1) * colw) - Math.max(o0 + shift, t0 + cj * colw);
                        if (ov <= 0) continue;
                        pcols[cj].dt += ov; pcols[cj].b[0] += (b['in'] || 0) * ov / d; pcols[cj].b[1] += (b.out || 0) * ov / d;
                        prevAny = true;
                    }
                });
                mark();
                var drawPrev = st.cmp && prevAny;

                var maxvByDir = {};
                dirs.forEach(function(d) {
                    var t = cols.map(function(c) { return c.byDir[d].total; });
                    if (drawPrev) pcols.forEach(function(pc) { if (pc.dt > 0) t.push(pc.b[d === 'in' ? 0 : 1] * 8 / pc.dt / 1e6); });
                    maxvByDir[d] = niceMax(Math.max.apply(null, t.concat([0.001])));
                });

                var maxDropRate = 0;
                cols.forEach(function(c) {
                    if (c.dt <= 0) return;
                    if (dirs.indexOf('in') >= 0) maxDropRate = Math.max(maxDropRate, c.drop.rx / c.dt);
                    if (dirs.indexOf('out') >= 0) maxDropRate = Math.max(maxDropRate, c.drop.tx / c.dt);
                });
                var showDrops = maxDropRate > 0;

                var totalH = dirs.length * PANEL_H + (showDrops ? dirs.length * DROP_H : 0) + (dirs.length - 1) * PANEL_GAP + AXIS_H;
                var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + totalH, width: '100%', style: 'display:block;' });

                function dropTip(c, ci, d, rate, ecnRate) {
                    var di = d === 'in' ? 0 : 1;
                    // r = [ name, in, out, rate in this direction, warning flag ]. The flag is carried separately:
                    // device names are stored without the marker, so it cannot be read from the name there.
                    var rows = Object.keys(c.src).map(function(k) {
                        var nm = st.dim === 'd' ? (names[k] || k) : k;
                        var warn = isAlertMatch(k) || isAlertMatch(nm) || !!(c.alerts && c.alerts[k]);
                        return [ nm, c.src[k][0] || 0, c.src[k][1] || 0, c.src[k][di] || 0, warn ];
                    }).filter(function(r) { return r[3] > 0; }).sort(function(a, b) { return b[3] - a[3]; });
                    // the five busiest, plus every warned entry below them (a small warned entry must stay visible)
                    rows = rows.slice(0, 5).concat(rows.slice(5).filter(function(r) { return r[4]; }).slice(0, 5))
                        .map(function(r) { return [ r[0], r[1], r[2], r[4] ]; });
                    return {
                        label: stampLabel(t0 + ci * colw, R.span) + ' - ' + stampLabel(t0 + (ci + 1) * colw, R.span),
                        sub: _('%.2f drops/s, %.2f ECN marks/s (%s)').format(rate, ecnRate, d === 'in' ? _('download shaper') : _('upload shaper')) +
                            ((d === 'in' ? c.bl.rx : c.bl.tx) > 0 ? ' - ' + _('peak backlog %s').format(backlogTxt(d === 'in' ? c.bl.rx : c.bl.tx, d === 'in' ? v.sqm.down : v.sqm.up)) : ''),
                        color: '#ef4444',
                        details: rows.length ? rows : [ [ _('no traffic recorded'), 0, 0 ] ],
                        detailTitle: dimLabel()
                    };
                }

                var REL_TITLE = { a: _('Top destinations'), d: _('Top applications'), h: _('Top devices') };
                // Same content as the live tooltips: application -> its destinations, device -> its applications,
                // destination -> its devices. rows = [ name, in, out, warning, colour key ]; the colour key is the
                // name the chart itself colours that entry by (full name / device key), so the colours match.
                function relRows(c, k) {
                    var acc = {}, any = false;
                    function take(key) {
                        var rm = c.rel && c.rel[key];
                        if (!rm) return;
                        any = true;
                        Object.keys(rm).forEach(function(nm) {
                            var e = acc[nm] || (acc[nm] = [0, 0, '']);
                            e[0] += rm[nm][0]; e[1] += rm[nm][1];
                            if (rm[nm][2]) e[2] = rm[nm][2];
                        });
                    }
                    if (k === '__rest') Object.keys(c.src).forEach(function(key) { if (shown.indexOf(key) < 0) take(key); });
                    else take(k);
                    if (!any) return null;
                    var rows = Object.keys(acc).map(function(nm) {
                        var disp = acc[nm][2] || nm;
                        return [ disp, acc[nm][0], acc[nm][1], isAlertMatch(nm) || isAlertMatch(disp), nm ];
                    }).sort(function(x, y) { return (y[1] + y[2]) - (x[1] + x[2]); });
                    return rows.slice(0, 10).concat(rows.slice(10).filter(function(r) { return r[3]; }).slice(0, 5));
                }

                function historyTip(c, ci, k, vv, d) {
                    var timeStr = stampLabel(t0 + ci * colw, R.span) + ' - ' + stampLabel(t0 + (ci + 1) * colw, R.span);
                    var rawName = k === '__rest' ? _('Other (%d)').format(rest.length) : (st.dim === 'd' ? (names[k] || k) : k);
                    var bucketAlert = isAlertMatch(k) || isAlertMatch(rawName) || !!(c && c.alerts && c.alerts[k]);
                    var details = c ? relRows(c, k) : null;
                    var detailTitle = REL_TITLE[st.dim], relDimUse = REL_DIM[st.dim];
                    if (!details) {
                        // buckets written without related lists (older data, or detailed tooltips switched off):
                        // fall back to the other entries of the same dimension in this column
                        details = [];
                        detailTitle = dimLabel();
                        relDimUse = st.dim;
                        if (c && c.src) {
                            Object.keys(c.src).forEach(function(key) {
                                if (k === '__rest' && shown.indexOf(key) >= 0) return;
                                var entryName = st.dim === 'd' ? (names[key] || key) : key;
                                var entryAlert = isAlertMatch(key) || isAlertMatch(entryName) || !!(c.alerts && c.alerts[key]);
                                if (entryAlert) bucketAlert = true;
                                details.push([ entryName, c.src[key][0] || 0, c.src[key][1] || 0, entryAlert, key ]);
                            });
                            details.sort(function(a, b) { return ((b[1] + b[2]) - (a[1] + a[2])); });
                            details = details.slice(0, 8).concat(details.slice(8).filter(function(r) { return r[3]; }).slice(0, 8));
                        }
                    }

                    details = details.map(function(r) {
                        var o = [ r[0], r[1], r[2], r[3], r[4] ];
                        if (r[4] && r[4] !== '(other)') o[5] = { dim: relDimUse, key: r[4], label: alertBaseLabel(r[0]) };
                        return o;
                    });

                    // title = the hovered entry (like the live tooltips), the time range and rate below it
                    return {
                        nav: k === '__rest' ? null : { dim: st.dim, key: k, label: alertBaseLabel(rawName) },
                        range: st.range, kind: 'hist',
                        label: (bucketAlert ? '⚠ ' : '') + alertBaseLabel(rawName),
                        sub: timeStr + (dirs.length > 1 ? ' \u2022 ' + (d === 'in' ? _('Download') : _('Upload')) : '') + ' \u2022 ' + formatRate(vv * 1e6),
                        color: bucketAlert ? '#dc2626' : (k === '__rest' ? 'hsl(210,8%,62%)' : colorOf(k)),
                        detailTitle: detailTitle,
                        details: details
                    };
                }

                var gapRuns = [], gFirst = -1, gLast = -1, gs = -1;
                cols.forEach(function(c, ci) { if (c.dt > 0) { if (gFirst < 0) gFirst = ci; gLast = ci; } });
                cols.forEach(function(c, ci) {
                    var isGap = c.dt <= 0 && ci > gFirst && ci < gLast;
                    if (isGap && gs < 0) gs = ci;
                    if (!isGap && gs >= 0) { gapRuns.push([ gs, ci ]); gs = -1; }
                });
                if (gapRuns.length) {
                    var defs = svgEl('defs', {}), pat = svgEl('pattern', { id: 'qos_gap_pat', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
                    pat.appendChild(svgEl('rect', { width: 6, height: 6, fill: 'rgba(128,128,128,0.06)' }));
                    pat.appendChild(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'rgba(128,128,128,0.35)', 'stroke-width': 1.5 }));
                    defs.appendChild(pat);
                    svg.appendChild(defs);
                }

                var bw = pw / cols.length;
                var gap = bw >= 6 ? bw * 0.1 : (bw >= 3 ? 0.4 : 0);

                var yCursor = 0;
                dirs.forEach(function(d) {
                    var panelTop = yCursor;
                    var dmax = maxvByDir[d];
                    for (var g = 0; g <= 4; g++) {
                        var yf = g / 4;
                        var y = panelTop + pt + ph - (ph * yf);
                        var axisRateValue = dmax * Math.pow(yf, 1 / Y_SCALE_POWER);
                        svg.appendChild(svgEl('line', { x1: pl, x2: W - pr, y1: y, y2: y, stroke: 'rgba(0,0,0,0.12)', 'stroke-width': 1 }));
                        var lbl = svgEl('text', { x: pl - 8, y: y + 4, 'text-anchor': 'end', style: AXIS_TEXT_STYLE });
                        lbl.textContent = axisRate(axisRateValue);
                        svg.appendChild(lbl);
                    }
                    if (dirs.length > 1) {
                        var dirLabel = svgEl('text', { x: pl, y: panelTop + pt - 2, style: AXIS_TEXT_STYLE + ' font-weight:700;' });
                        dirLabel.textContent = (d === 'in' ? _('Download') : _('Upload'));
                        svg.appendChild(dirLabel);
                    }

                    gapRuns.forEach(function(gr) {
                        var gx = svgEl('rect', { x: pl + gr[0] * bw, y: panelTop + pt, width: (gr[1] - gr[0]) * bw, height: ph, fill: 'url(#qos_gap_pat)', style: 'pointer-events:none;' });
                        svg.appendChild(gx);
                    });

                    cols.forEach(function(c, ci) {
                        var acc = 0, bd = c.byDir[d];
                        series.forEach(function(k) {
                            var vv = bd.v[k] || 0;
                            if (vv <= 0) return;
                            var yTopFrac = scaleY(acc + vv, dmax);
                            var yBaseFrac = scaleY(acc, dmax);
                            var y = panelTop + pt + ph - ph * yTopFrac;
                            var h = ph * Math.max(0, yTopFrac - yBaseFrac);
                            var r = svgEl('rect', {
                                x: pl + ci * bw + gap,
                                y: y,
                                width: Math.max(bw - 2 * gap, 1),
                                height: Math.max(h, 0.5),
                                fill: k === '__rest' ? 'hsl(210,8%,62%)' : colorOf(k),
                                style: 'pointer-events:none;'
                            });

                            svg.appendChild(r);
                            acc += vv;
                        });
                    });

                    /* Alert marker: show a red warning symbol above each history bucket
                     * containing a configured keyword match in the selected dimension. */
                    if (d === dirs[0]) {
                        cols.forEach(function(c, ci) {
                            if (!c || c.dt <= 0) return;
                            if (!Object.keys(c.alerts || {}).length) return;
                            var ax = pl + ci * bw + bw / 2;
                            var ay = panelTop + pt + 7;
                            var marker = svgEl('g', {
                                style: 'pointer-events:none;',
                                'aria-label': _('Warning: configured alert keyword found in this bucket')
                            });
                            var bang = svgEl('text', {
                                x: ax, y: ay + 4, 'text-anchor': 'middle',
                                style: 'font-size:15px;font-weight:900;fill:#dc2626;paint-order:stroke;stroke:#ffffff;stroke-width:2px;'
                            });
                            bang.textContent = '⚠';
                            marker.appendChild(bang);
                            svg.appendChild(marker);
                        });
                    }

                    /*
                     * Independent interaction layer.
                     *
                     * The visible bars keep their real dimensions.  The
                     * overlay below handles selection from the DATA geometry,
                     * so a bucket remains selectable even when it is only a
                     * few pixels wide and a series is <1px high.
                     */
                    (function() {
                        var HIT_MIN_H = 10;

                        function svgPoint(ev) {
                            var rr = svg.getBoundingClientRect();
                            var vb = svg.viewBox && svg.viewBox.baseVal;
                            var sx = vb && vb.width ? vb.width / rr.width : 1;
                            var sy = vb && vb.height ? vb.height / rr.height : 1;
                            return {
                                x: (ev.clientX - rr.left) * sx + (vb ? vb.x : 0),
                                y: (ev.clientY - rr.top) * sy + (vb ? vb.y : 0)
                            };
                        }

                        function clamp(v, lo, hi) {
                            return Math.max(lo, Math.min(hi, v));
                        }

                        function gapAt(ci) {
                            for (var gi = 0; gi < gapRuns.length; gi++) {
                                if (ci >= gapRuns[gi][0] && ci < gapRuns[gi][1])
                                    return gapRuns[gi];
                            }
                            return null;
                        }

                        function pickSegment(c, ci, py) {
                            var bd = c.byDir[d];
                            if (!bd || !bd.v) return null;

                            var items = [];
                            var acc = 0;

                            /*
                             * IMPORTANT: hit testing follows the exact same
                             * transformed geometry as the visible bars.
                             * This makes the mouse position deterministic:
                             * when the pointer is physically over a segment,
                             * that segment always wins.
                             */
                            series.forEach(function(k) {
                                var v = Number(bd.v[k]) || 0;
                                if (v <= 0) return;

                                var y0 = scaleY(acc, dmax);
                                var y1 = scaleY(acc + v, dmax);
                                var top = panelTop + pt + ph - ph * y1;
                                var bottom = panelTop + pt + ph - ph * y0;

                                items.push({
                                    k: k,
                                    v: v,
                                    top: Math.min(top, bottom),
                                    bottom: Math.max(top, bottom),
                                    center: (top + bottom) / 2,
                                    realH: Math.abs(bottom - top)
                                });
                                acc += v;
                            });

                            if (!items.length) return null;

                            /* Pass 1: exact visual hit.  Never let a virtual
                             * target steal a mouse position that is actually
                             * inside another visible segment. */
                            for (var i = 0; i < items.length; i++) {
                                var exact = items[i];
                                if (py >= exact.top && py <= exact.bottom)
                                    return exact;
                            }

                            /*
                             * Pass 2: the pointer is in empty space because
                             * the segment is sub-pixel or above the stack.
                             * Use a small virtual target around the real
                             * segment, but do NOT move its center.  The target
                             * is clipped halfway toward neighbouring segment
                             * centers, so adjacent series cannot unexpectedly
                             * swap ownership.
                             */
                            var best = null;
                            var bestDist = Infinity;
                            var maxVirtual = 8;

                            for (var j = 0; j < items.length; j++) {
                                var item = items[j];
                                var half = Math.max(item.realH / 2, HIT_MIN_H / 2);

                                /* Limit expansion to the nearest neighbouring
                                 * real segment center. */
                                if (j > 0) {
                                    var dPrev = Math.abs(item.center - items[j - 1].center);
                                    half = Math.min(half, dPrev / 2);
                                }
                                if (j + 1 < items.length) {
                                    var dNext = Math.abs(items[j + 1].center - item.center);
                                    half = Math.min(half, dNext / 2);
                                }

                                half = Math.min(half, maxVirtual);

                                var dist = Math.abs(py - item.center);
                                if (dist <= half && dist < bestDist) {
                                    bestDist = dist;
                                    best = item;
                                }
                            }

                            /* Above/below the actual stack: make selection easy
                             * without making a distant tiny series steal the
                             * whole panel. */
                            if (!best) {
                                var nearest = null;
                                var nearestDist = Infinity;
                                items.forEach(function(item) {
                                    var dist = py < item.top ? item.top - py :
                                        (py > item.bottom ? py - item.bottom : 0);
                                    if (dist < nearestDist) {
                                        nearestDist = dist;
                                        nearest = item;
                                    }
                                });
                                if (nearestDist <= maxVirtual)
                                    best = nearest;
                            }

                            return best;
                        }

                        function hitInfo(ev) {
                            var p = svgPoint(ev);
                            var ci = Math.floor((p.x - pl) / bw);
                            ci = clamp(ci, 0, cols.length - 1);

                            var gr = gapAt(ci);
                            if (gr) {
                                return {
                                    info: {
                                        label: stampLabel(t0 + gr[0] * colw, R.span) +
                                            ' - ' + stampLabel(t0 + gr[1] * colw, R.span),
                                        sub: _('no data (aggregator was not running)'),
                                        color: '#94a3b8',
                                        detailTitle: '',
                                        details: []
                                    },
                                    key: historyTipKey('gap', gr[0], gr[1], d)
                                };
                            }

                            var c = cols[ci];
                            if (!c || !c.dt || c.dt <= 0) return null;

                            var picked = pickSegment(c, ci, p.y);
                            if (!picked) return null;

                            return {
                                info: historyTip(c, ci, picked.k, picked.v, d),
                                key: historyTipKey('hit', ci, picked.k, d)
                            };
                        }

                        var overlay = svgEl('rect', {
                            x: pl,
                            y: panelTop + pt,
                            width: Math.max(pw, 1),
                            height: Math.max(ph, 1),
                            fill: 'rgba(0,0,0,0)'
                        });

                        function update(ev) {
                            /* A pinned tooltip must stay where it was pinned.
                             * Do not retarget or move it while the mouse moves. */
                            if (historyPinned) return;

                            var hit = hitInfo(ev);
                            if (!hit) {
                                historyTipLeave();
                                return;
                            }

                            historyTipHover(hit.info, ev);
                        }

                        overlay.addEventListener('mouseenter', update);
                        overlay.addEventListener('mousemove', update);
                        overlay.addEventListener('mouseleave', historyTipLeave);

                        overlay.addEventListener('click', function(ev) {
                            var hit = hitInfo(ev);
                            if (!hit) return;
                            historyTipClick(hit.info, ev, hit.key);
                        });

                        svg.appendChild(overlay);
                    })();

                    if (drawPrev) {
                        var pd = '', pen = false;
                        pcols.forEach(function(pc, ci) {
                            if (pc.dt <= 0) { pen = false; return; }
                            var pv = pc.b[d === 'in' ? 0 : 1] * 8 / pc.dt / 1e6;
                            pd += (pen ? 'L' : 'M') + (pl + ci * bw + bw / 2).toFixed(1) + ' ' + (panelTop + pt + ph - ph * scaleY(Math.min(pv, dmax), dmax)).toFixed(1) + ' ';
                            pen = true;
                        });
                        var pline = svgEl('path', { d: pd, style: 'fill:none; stroke:var(--qos-text-strong); stroke-width:1.4; stroke-dasharray:4 3; opacity:0.8; pointer-events:none;' });
                        svg.appendChild(pline);
                    }

                    yCursor += PANEL_H;

                    if (showDrops) {
                        var dropTop = yCursor;
                        cols.forEach(function(c, ci) {
                            if (c.dt <= 0) return;
                            var rate = (d === 'in' ? c.drop.rx : c.drop.tx) / c.dt;
                            var ecnRate = (d === 'in' ? c.ecn.rx : c.ecn.tx) / c.dt;
                            if (rate <= 0 && ecnRate <= 0) return;
                            var frac = Math.min(1, rate / maxDropRate);
                            var op = 0.12 + frac * 0.45;
                            svg.appendChild(svgEl('rect', { x: pl + ci * bw + gap, y: dropTop, width: Math.max(bw - 2 * gap, 1), height: DROP_H, fill: 'rgba(220,38,38,' + op.toFixed(2) + ')' }));
                            var hit = svgEl('rect', { x: pl + ci * bw, y: dropTop - 3, width: Math.max(bw, 2), height: DROP_H + 6, fill: 'rgba(0,0,0,0)' });
                            (function(c_ref, ci_ref, d_ref, rate_ref, ecnRate_ref) {
                                var dropKey = historyTipKey('drop', ci_ref, '', d_ref);
                                hit.addEventListener('mouseenter', function(ev) {
                                    historyTipHover(dropTip(c_ref, ci_ref, d_ref, rate_ref, ecnRate_ref), ev);
                                });
                                hit.addEventListener('mousemove', historyTipMove);
                                hit.addEventListener('mouseleave', historyTipLeave);
                                hit.addEventListener('click', function(ev) {
                                    historyTipClick(dropTip(c_ref, ci_ref, d_ref, rate_ref, ecnRate_ref), ev, dropKey);
                                });
                            })(c, ci, d, rate, ecnRate);
                            svg.appendChild(hit);
                        });
                        var dl = svgEl('text', { x: pl - 8, y: dropTop + DROP_H - 1, 'text-anchor': 'end', style: 'font-size:8.5px; fill:var(--qos-text-muted);' });
                        dl.textContent = _('drops');
                        svg.appendChild(dl);
                        yCursor += DROP_H;
                    }
                    if (d !== dirs[dirs.length - 1]) yCursor += PANEL_GAP;
                });

                var ticks = [], spanT = end - t0;
                if (win.axisDays) {
                    /* labels per local day (week, month) or per month (year), placed at the
                     * middle of the visible part of that day/month; thinned out if too dense */
                    var axR = win.axisRange;
                    var need = axR === '7d' ? 80 : (axR === '30d' ? 48 : 70);
                    var segs = [], sc0, sc1, guard;
                    if (axR === '365d') {
                        var dm = new Date(t0 * 1000);
                        sc0 = new Date(dm.getFullYear(), dm.getMonth(), 1).getTime() / 1000;
                        for (guard = 0; sc0 < end && guard < 40; guard++) {
                            var dn = new Date(sc0 * 1000);
                            sc1 = new Date(dn.getFullYear(), dn.getMonth() + 1, 1).getTime() / 1000;
                            segs.push([ sc0, sc1 ]); sc0 = sc1;
                        }
                    } else {
                        sc0 = localDayStart(t0);
                        for (guard = 0; sc0 < end && guard < 400; guard++) {
                            sc1 = localDayAdd(sc0, 1);
                            segs.push([ sc0, sc1 ]); sc0 = sc1;
                        }
                    }
                    var vis = segs.map(function(sg) {
                        var a = Math.max(sg[0], t0), b = Math.min(sg[1], end);
                        return { a: a, b: b, px: (b - a) / spanT * pw };
                    }).filter(function(x) { return x.px > 0; });
                    var fullPx = 1;
                    vis.forEach(function(x) { if (x.px > fullPx) fullPx = x.px; });
                    var step = Math.max(1, Math.ceil(need / fullPx));
                    vis.forEach(function(x, i) {
                        var isLastWeekDay = (axR === '7d' && i === vis.length - 1);
                        if (!isLastWeekDay && (i % step !== 0 || x.px < Math.min(need, fullPx) * 0.8)) return;
                        var ep = (x.a + x.b) / 2, d = new Date(ep * 1000), txt;
                        if (axR === '7d') txt = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'numeric' });
                        else if (axR === '30d') txt = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
                        else txt = d.toLocaleDateString([], { month: 'short', year: 'numeric' });
                        ticks.push({ x: pl + (ep - t0) / spanT * pw, text: txt });
                    });
                } else {
                    for (var nn = 0; nn < 5; nn++) {
                        var epoch = t0 + (nn / 4) * spanT;
                        ticks.push({ x: pl + (nn / 4) * pw, text: tickLabel(epoch, spanT) });
                    }
                }
                ticks.forEach(function(tk) {
                    var tx = svgEl('text', { x: tk.x, y: totalH - 9, 'text-anchor': 'middle', style: AXIS_TEXT_STYLE });
                    tx.textContent = tk.text;
                    svg.appendChild(tx);
                });
                chartHost.appendChild(svg);

                var legend = E('div', { style: 'display:flex; flex-wrap:wrap; gap:4px 18px; justify-content:center; margin-top:8px; font-size:11.5px;' });
                function legendItem(k, swatchColor, text) {
                    var off = !!hiddenSet[k];
                    var el = E('span', { style: 'cursor:pointer;' + (off ? ' opacity:0.4; text-decoration:line-through;' : ''), title: _('Click to hide or show') }, [
                        E('span', { style: 'display:inline-block; width:11px; height:11px; border-radius:3px; margin-right:5px; background:' + swatchColor + ';' }), text ]);
                    el.addEventListener('click', function(e) { e.stopPropagation(); hiddenSet[k] = !hiddenSet[k]; render(); });
                    // "only": show just this entry (again: show all). Shift-click on the entry does the same.
                    function solo() {
                        var all = shown.slice(); if (rest.length) all.push('__rest');
                        var isSolo = !hiddenSet[k] && all.every(function(x) { return x === k || hiddenSet[x]; });
                        all.forEach(function(x) { hiddenSet[x] = isSolo ? false : (x !== k); });
                        render();
                    }
                    el.addEventListener('click', function(e) { if (e.shiftKey) { hiddenSet[k] = !hiddenSet[k]; solo(); } });
                    var only = E('span', {
                        style: 'cursor:pointer; margin-left:5px; font-size:10px; line-height:1; padding:1px 5px; border:1px solid var(--qos-text-muted); border-radius:8px; color:var(--qos-text-muted);',
                        title: _('Show only this entry (click again: show all)')
                    }, _('only'));
                    only.addEventListener('click', function(e) { e.stopPropagation(); solo(); });
                    return E('span', { style: 'white-space:nowrap;' }, [ el, only ]);
                }
                shown.forEach(function(k) {
                    var name = st.dim === 'd' ? ((alertKeys[k] ? '\u26a0 ' : '') + (names[k] || k)) : k;
                    legend.appendChild(legendItem(k, colorOf(k), name + ' (' + formatBytes(totals[k]) + ')'));
                });
                if (rest.length) legend.appendChild(legendItem('__rest', 'hsl(210,8%,62%)', _('Other (%d)').format(rest.length)));
                var anyHidden = shown.concat(rest.length ? [ '__rest' ] : []).some(function(x) { return hiddenSet[x]; });
                if (anyHidden) {
                    var showAll = E('span', { style: 'cursor:pointer; font-weight:700; color:var(--qos-text-strong);' }, _('Show all'));
                    showAll.addEventListener('click', function(e) { e.stopPropagation(); Object.keys(hiddenSet).forEach(function(x) { hiddenSet[x] = false; }); render(); });
                    legend.appendChild(showAll);
                }
                if (st.cmp && !prevAny) legend.appendChild(E('span', { style: 'opacity:0.7;' }, _('Previous period: no data stored yet')));
                if (drawPrev) {
                    var prevLabel = prevCov < shift * 0.95
                        ? _('Previous period (partial, %d%% coverage)').format(shift > 0 ? Math.min(100, Math.round(prevCov / shift * 100)) : 0)
                        : _('Previous period');
                    legend.appendChild(E('span', {}, [
                        E('span', { style: 'display:inline-block; width:16px; margin-right:5px; vertical-align:middle; border-top:2px dashed var(--qos-text-strong);' }), prevLabel ]));
                }
                if (showDrops) legend.appendChild(E('span', {}, [
                    E('span', { style: 'display:inline-block; width:11px; height:11px; border-radius:3px; margin-right:5px; background:rgba(220,38,38,0.4);' }), _('Shaper drops (strip opacity = intensity relative to the worst column shown)') ]));
                chartHost.appendChild(legend);

                var colTxt = colw >= 86400 ? _('%.1f days').format(colw / 86400) : colw >= 3600 ? _('%.1f h').format(colw / 3600) : _('%d min').format(Math.round(colw / 60));
                chartHost.appendChild(E('div', { style: 'text-align:center; font-size:10.5px; color:var(--qos-text-muted); margin-top:6px;' },
                    _('Average rate per column (%s), %s - %s.').format(colTxt, new Date(t0 * 1000).toLocaleString(), new Date(end * 1000).toLocaleString())));
                chartHost.appendChild(statsTable(sel, R, bl));
            }
            v.render = render;
            var resizeTimer = null;
            var resizeHandler = function() {
                if (!v.active) return;
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(render, 150);
            };
            window.addEventListener('resize', resizeHandler);
            cleanupFns.push(function() {
                window.removeEventListener('resize', resizeHandler);
                clearTimeout(resizeTimer);
            });
            v.stale = function() {
                // Avoid overlapping normal refreshes, but recover if an RPC never settles.
                if (v.loading) return Date.now() - v.loadingAt > 30000;
                var tier = rangeDef().tier;
                var failed = !!(st.err && (st.err[tier] ||
                    (st.cmp && TIER_ORDER.slice(TIER_ORDER.indexOf(tier) + 1).some(function(t) { return st.err[t]; }))));
                return Date.now() - v.loadedAt > historyRefreshDelayMs(tier, failed);
            };
            // jump here from another tab: show only this entry (only the biggest 8 + rest have a series of their own)
            v.focus = function(dim, key, label, range) {
                var needLoad = false;
                if (dim !== st.dim) { st.dim = dim; st.data = {}; needLoad = true; }
                if (range && [ '24h', '7d', '30d', '365d' ].indexOf(range) >= 0 && range !== st.range) { st.range = range; needLoad = true; }
                if (!st.data[rangeDef().tier]) needLoad = true;
                st.focus = key; st.focusLabel = label || key;
                histSave(); mark();
                if (needLoad) v.load(); else render();
                v.skipLoad = true;      // the tab switch that follows must not read the same data again
            };
            v.clearPinned = function() {
                historyPinned = null;
                tipHide();
            };
            function historyNextSkip(response, skip, returnedCount) {
                var cursor = response && Number(response.nextSkip);
                // Compatibility with older rpcd adapters that don't return a cursor.
                return isFinite(cursor) && cursor > skip ? cursor : skip + returnedCount;
            }

            function loadTier(tier, dim, slim) {
                var collected = [];
                function fetchPage(skip) {
                    if (collected.length >= HISTORY_MAX_BUCKETS) return Promise.resolve();
                    var count = Math.min(HISTORY_PAGE_SIZE, HISTORY_MAX_BUCKETS - collected.length);
                    return callHistory(1, tier, dim, count, skip, slim ? 1 : 0).then(function(d) {
                        var page = d && Array.isArray(d.buckets) ? d.buckets : [];
                        var nextSkip = historyNextSkip(d, skip, page.length);
                        if (!page.length) {
                            // An individually oversized bucket is deliberately omitted by
                            // the RPC. Its cursor advances past it, allowing older buckets
                            // to load; a genuinely exhausted page has no advancing cursor.
                            if (nextSkip > skip && nextSkip < HISTORY_MAX_BUCKETS && collected.length < HISTORY_MAX_BUCKETS)
                                return fetchPage(nextSkip);
                            return;
                        }
                        // The RPC returns each page oldest-to-newest. Later pages are older,
                        // so prepend them to preserve chronological order in the final array.
                        collected = page.concat(collected);
                        if (nextSkip > skip && nextSkip < HISTORY_MAX_BUCKETS && collected.length < HISTORY_MAX_BUCKETS)
                            return fetchPage(nextSkip);
                    });
                }
                return fetchPage(0).then(function() { return collected; });
            }
            v.load = function() {
                var seq = ++loadSequence;
                v.loading = true;
                v.loadingAt = Date.now();
                var tier = rangeDef().tier, dim = st.dim, tiers = [ tier ];
                if (st.cmp) tiers = tiers.concat(TIER_ORDER.slice(TIER_ORDER.indexOf(tier) + 1));
                v.loadedAt = Date.now();
                if (!st.err) st.err = {};
                return Promise.all(tiers.map(function(t) {
                    return loadTier(t, dim).then(function(buckets) {
                        // Ignore a slower response for a previous dimension / view load.
                        if (seq !== loadSequence || dim !== st.dim) return;
                        st.data[t] = buckets;
                        st.err[t] = false;
                    }).catch(function() {
                        if (seq !== loadSequence || dim !== st.dim) return;
                        // Retain existing data and expose a visible error instead of silently
                        // replacing a comparison with stale or incomplete history.
                        st.err[t] = true;
                    });
                })).then(function() {
                    if (seq === loadSequence) {
                        v.loading = false;
                        if (dim === st.dim) render();
                    }
                });
            };
            mark();
            render();
            v.setPersist(null);
            v.RANGES = RANGES; v.windowOf = windowOf; v.loadTier = loadTier;
            return v;
        }

        // "Volume" tab: who used how much in the chosen period. Reads the same stored buckets as the
        // History tab (through its loadTier(); nothing extra is collected on the router).
        //  * table: all entries, change against the preceding period of the same length, text filter, and a
        //    click on a row opens the usage over time plus the top related entries (destinations of an
        //    application, applications of a device, devices of a destination)
        //  * heatmap: average rate per weekday and hour of day
        //  * ranges: 24 h / week / month / year, this month, last month and a custom date range
        // The table only asks the router for the slim bucket form (no related lists, about 5x smaller);
        // the full form is fetched once, when a row is opened.
        function makeVolumeView(hv) {
            var v = { active: false, loadedAt: 0, loading: false, loadingAt: 0, cur: null, heat: null };
            // Heatmap tooltip: click pins it (hover is ignored meanwhile), click again, a click elsewhere or on
            // the tooltip itself releases it - the same behaviour as in the History tab.
            var heatPin = null;
            function heatUnpin() {
                if (!heatPin) return;
                heatPin.rect.removeAttribute('stroke'); heatPin.rect.removeAttribute('stroke-width');
                heatPin = null;
                tipHide();
            }
            var heatOutside = function(ev) {
                if (!heatPin) return;
                if (ev.target === tipEl || tipEl.contains(ev.target)) return;
                heatUnpin();
            };
            document.addEventListener('click', heatOutside);
            tipEl.addEventListener('click', function(ev) {
                if (!heatPin) return;
                ev.stopPropagation();
                heatUnpin();
            });
            cleanupFns.push(function() { document.removeEventListener('click', heatOutside); heatPin = null; });
            var TIER_ORDER = [ '5m', '1h', '1d' ];
            var REFRESH = { '5m': 60000, '1h': 300000, '1d': 900000 };
            var DIMS = [ [ 'a', _('Applications') ], [ 'd', _('Devices') ], [ 'h', _('Destinations') ] ];
            var MODES = [ [ 'table', _('Table') ], [ 'heat', _('Heatmap') ] ];
            var HDIRS = [ [ 'sum', '\u03A3' ], [ 'in', '\u2193 ' + _('Download') ], [ 'out', '\u2191 ' + _('Upload') ] ];
            var RANGES = hv.RANGES.concat([
                { id: 'tm', label: _('This month'), tier: '1h' },
                { id: 'lm', label: _('Last month'), tier: '1d' },
                { id: 'cu', label: _('Custom'),     tier: '1h' } ]);
            var LIMIT = 30, DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
            var COL_IN = 'hsl(160,60%,42%)', COL_OUT = 'hsl(215,75%,55%)';

            function pickOf(val, list, def) { return list.indexOf(val) >= 0 ? val : def; }
            var saved = prefLoad().vol || {};
            var rangeIds = RANGES.map(function(r) { return r.id; });
            var st = {
                dim: pickOf(saved.dim, [ 'a', 'd', 'h' ], 'a'),
                range: pickOf(saved.range, rangeIds, '24h'),
                mode: 'table',
                hdir: pickOf(saved.hdir, [ 'sum', 'in', 'out' ], 'sum'),
                cmp: saved.cmp !== false,
                from: DAY_RE.test(saved.from || '') ? saved.from : '',
                to: DAY_RE.test(saved.to || '') ? saved.to : '',
                sort: { col: pickOf(saved.sortCol, [ 'n', 'i', 'o', 't', 'd' ], 't'), dir: saved.sortDir === 1 ? 1 : -1 },
                filter: '', all: false, open: null, heatKey: null, heatLabel: '', heatSlot: null, heatSlotDate: null, reveal: null, trail: [],
                data: {}, dataDim: '', err: {}, full: null
            };
            function savePrefs() {
                prefSave('vol', { dim: st.dim, range: st.range, hdir: st.hdir, cmp: st.cmp,
                                  from: st.from, to: st.to, sortCol: st.sort.col, sortDir: st.sort.dir });
            }

            // ---- date helpers (all local time) ----
            function pad2(n) { return (n < 10 ? '0' : '') + n; }
            function dayStr(ep) { var d = new Date(ep * 1000); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
            function dayEp(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getTime() / 1000; }
            function dayStartEp(ep) { var d = new Date(ep * 1000); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000; }
            function dayAddEp(ep, n) { var d = new Date(ep * 1000); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime() / 1000; }
            function monthStart(ep, delta) { var d = new Date(ep * 1000); return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime() / 1000; }
            function customTier(fromEp) {
                var age = Date.now() / 1000 - fromEp;
                return age <= 80000 ? '5m' : (age <= 30 * 86400 ? '1h' : '1d');
            }
            function fillCustomDefaults() {
                var today = dayStartEp(Date.now() / 1000);
                if (!DAY_RE.test(st.to)) st.to = dayStr(today);
                if (!DAY_RE.test(st.from)) st.from = dayStr(dayAddEp(dayEp(st.to), -6));
            }
            function rangeDef() {
                var R = RANGES[0], i;
                for (i = 0; i < RANGES.length; i++) if (RANGES[i].id === st.range) R = RANGES[i];
                if (R.id !== 'cu') return R;
                fillCustomDefaults();
                var a = dayEp(st.from), b = dayEp(st.to);
                if (a > b) { var t = a; a = b; b = t; }
                return { id: 'cu', label: R.label, from: a, to: dayAddEp(b, 1), tier: customTier(a) };
            }
            function tiersFor(R) {
                if (st.mode === 'heat') return [ '1h' ];
                var out = [ R.tier ];
                if (st.cmp) out = out.concat(TIER_ORDER.slice(TIER_ORDER.indexOf(R.tier) + 1));
                return out;
            }
            function medianDt(B) {
                var a = B.map(function(b) { return b.dt || 0; }).filter(function(x) { return x > 0; }).sort(function(x, y) { return x - y; });
                return a.length ? a[Math.floor(a.length / 2)] : 0;
            }
            function durTxt(sec) {
                return sec >= 86400 ? _('%.1f days').format(sec / 86400) : sec >= 3600 ? _('%.1f h').format(sec / 3600) : _('%d min').format(Math.round(sec / 60));
            }
            function axisLabel(ep, span) {
                var d = new Date(ep * 1000);
                if (span <= 2 * 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + (span <= 8 * 86400 ? ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
            }
            function periodTxt(a, b) {
                return new Date(a * 1000).toLocaleString() + ' \u2013 ' + new Date(b * 1000).toLocaleString();
            }

            // ---- period maths ----
            function windowFor(R, B) {
                var latest = B[B.length - 1].t;
                if (R.id === 'tm') return { start: monthStart(latest, 0), end: latest };
                if (R.id === 'lm') return { start: monthStart(latest, -1), end: Math.min(monthStart(latest, 0), latest) };
                if (R.id === 'cu') return { start: R.from, end: Math.min(R.to, latest) };
                var w = hv.windowOf(B, R);
                return { start: w.start, end: w.end };
            }
            function prevWindow(R, w) {
                var len = w.end - w.start, s;
                if (R.id === 'lm') return { start: monthStart(w.start, -1), end: w.start };
                if (R.id === 'tm') { s = monthStart(w.start, -1); return { start: s, end: Math.min(s + len, w.start) }; }
                return { start: w.start - len, end: w.start };
            }
            function coverage(B, a, b) {
                var c = 0;
                B.forEach(function(bk) { var ov = Math.min(bk.t, b) - Math.max(bk.t - (bk.dt || 0), a); if (ov > 0) c += ov; });
                return c;
            }
            // sums the entries of dimension "dim" over [a, b]; a bucket counts with the share of it that lies inside
            function sumWindow(B, a, b, dim) {
                var acc = {}, cov = 0, sumI = 0, sumO = 0;
                (B || []).forEach(function(bk) {
                    var d = bk.dt || 0;
                    if (d <= 0) return;
                    var ov = Math.min(bk.t, b) - Math.max(bk.t - d, a);
                    if (ov <= 0) return;
                    var f = ov / d, src = bk[dim] || {};
                    cov += ov;
                    Object.keys(src).forEach(function(k) {
                        var e = src[k], r = acc[k] || (acc[k] = { k: k, i: 0, o: 0, label: k, warn: false });
                        r.i += (e[0] || 0) * f; r.o += (e[1] || 0) * f;
                        if (dim === 'd' && e[2] && typeof e[2] === 'string') r.label = alertBaseLabel(e[2]);
                        if (isAlertMatch(k) || (dim === 'd' && typeof e[2] === 'string' && isAlertMatch(e[2]))) r.warn = true;
                        sumI += (e[0] || 0) * f; sumO += (e[1] || 0) * f;
                    });
                });
                Object.keys(acc).forEach(function(k) { if (dim !== 'd') acc[k].label = alertBaseLabel(k); });
                return { acc: acc, cov: cov, sumI: sumI, sumO: sumO };
            }
            function compute() {
                var R = rangeDef(), B = st.data[R.tier];
                if (!B || st.dataDim !== st.dim) return null;
                if (!B.length) return { empty: true, R: R };
                var w = windowFor(R, B), m = { R: R, w: w, cur: sumWindow(B, w.start, w.end, st.dim), prev: null, prevFrac: 0, prevTier: '' };
                if (st.cmp && w.end > w.start) {
                    var pw = prevWindow(R, w), len = pw.end - pw.start, bestT = '', bestCov = 0;
                    TIER_ORDER.slice(TIER_ORDER.indexOf(R.tier)).forEach(function(t) {
                        var Bt = st.data[t];
                        if (!Bt || !Bt.length) return;
                        var c = coverage(Bt, pw.start, pw.end);
                        if (c > bestCov + 0.05 * len) { bestCov = c; bestT = t; }
                    });
                    if (bestT && len > 0) {
                        m.prev = sumWindow(st.data[bestT], pw.start, pw.end, st.dim);
                        m.prevFrac = bestCov / len; m.prevTier = bestT; m.pw = pw;
                    }
                }
                return m;
            }
            // change of the AVERAGE RATE against the preceding period (robust against partly stored periods)
            function deltaOf(curBytes, curCov, prevBytes, prevCov) {
                if (!(curCov > 0) || !(prevCov > 0)) return null;
                var c = curBytes / curCov, p = prevBytes / prevCov;
                if (p > 0) return c / p - 1;
                return c > 0 ? Infinity : null;
            }
            function deltaTxt(d) {
                if (d === null || d === undefined) return '\u2013';
                if (d === Infinity) return _('new');
                var a = Math.abs(d) * 100;
                if (a < 0.5) return '\u2248 0 %';
                return (d > 0 ? '\u25B2 ' : '\u25BC ') + a.toFixed(a < 10 ? 1 : 0) + ' %';
            }
            function deltaColor(d) {
                if (d === null || d === undefined || (d !== Infinity && Math.abs(d) < 0.005)) return '';
                return (d > 0) ? 'var(--qos-danger, #dc2626)' : '#16a34a';
            }
            function colorOf(k) { return k === '(other)' ? 'hsl(210,8%,62%)' : 'hsl(' + slotHue(k) + ',58%,46%)'; }

            // ---- controls ----
            var host = E('div', { style: 'width:100%; max-width:1100px; margin:0 auto;' });
            var buildFn = null, seq = 0;
            var rangeChecks = [], dimChecks = [], modeChecks = [], dirChecks = [];
            var cmpCheck = makeOpenWrtCheckbox(_('Compare'), st.cmp, function(checked) {
                st.cmp = checked; savePrefs(); mark(); render(); v.load();
            });
            cmpCheck.input.title = _('Show the change of the average rate against the preceding period of the same length');
            function resetOpen() { st.open = null; st.full = null; st.all = false; st.trail = []; }
            var rangeGroup = makeCheckboxGroup(RANGES.map(function(r) { return [ r.id, r.label ]; }), rangeChecks, st.range, function(id) {
                st.range = id; resetOpen();
                if (id === 'cu') { fillCustomDefaults(); fromIn.value = st.from; toIn.value = st.to; }
                savePrefs(); mark(); render(); v.load();
            });
            var dimGroup = makeCheckboxGroup(DIMS, dimChecks, st.dim, function(d) {
                st.dim = d; st.data = {}; st.dataDim = ''; resetOpen(); savePrefs(); mark(); render(); v.load();
            });
            var modeGroup = makeCheckboxGroup(MODES, modeChecks, st.mode, function(m) {
                st.mode = m; st.heatKey = null; resetOpen(); savePrefs(); mark(); render(); v.load();
            });
            var dirGroup = makeCheckboxGroup(HDIRS, dirChecks, st.hdir, function(d) { st.hdir = d; savePrefs(); mark(); render(); });

            var inStyle = 'font-size:12px; padding:2px 4px; max-width:9.5em;';
            var fromIn = E('input', { type: 'date', style: inStyle }), toIn = E('input', { type: 'date', style: inStyle });
            function dateChanged() {
                if (DAY_RE.test(fromIn.value)) st.from = fromIn.value;
                if (DAY_RE.test(toIn.value)) st.to = toIn.value;
                resetOpen(); savePrefs(); render(); v.load();
            }
            fromIn.addEventListener('change', dateChanged); toIn.addEventListener('change', dateChanged);
            var customBox = E('div', { style: 'display:none; align-items:center; gap:6px; font-size:12px;' }, [
                E('span', {}, _('From')), fromIn, E('span', {}, _('to')), toIn ]);
            var filterIn = E('input', { type: 'search', placeholder: _('Filter...'), style: 'font-size:12px; padding:2px 6px; width:12em;' });
            filterIn.addEventListener('input', function() { st.filter = filterIn.value || ''; if (buildFn) buildFn(); });
            filterIn.addEventListener('click', function(e) { e.stopPropagation(); });
            var filterWrap = E('div', {}, [ filterIn ]);

            function mark() {
                rangeChecks.forEach(function(input, i) { input.checked = st.range === RANGES[i].id; });
                dimChecks.forEach(function(input, i) { input.checked = st.dim === DIMS[i][0]; });
                modeChecks.forEach(function(input, i) { input.checked = st.mode === MODES[i][0]; });
                dirChecks.forEach(function(input, i) { input.checked = st.hdir === HDIRS[i][0]; });
                cmpCheck.input.checked = !!st.cmp;
                var heat = st.mode === 'heat';
                dimGroup.style.display = heat ? 'none' : '';
                dirGroup.style.display = heat ? '' : 'none';
                cmpCheck.el.style.display = heat ? 'none' : '';
                filterWrap.style.display = heat ? 'none' : '';
                customBox.style.display = (st.range === 'cu') ? 'flex' : 'none';
            }

            v.el = E('div', { style: 'width:100%; display:none;' }, [
                E('div', { style: 'display:flex; gap:8px 24px; flex-wrap:wrap; justify-content:center; align-items:center; margin-bottom:8px;' },
                    [ rangeGroup, modeGroup, dimGroup, dirGroup ]),
                E('div', { style: 'display:flex; gap:8px 18px; flex-wrap:wrap; justify-content:center; align-items:center; margin-bottom:12px;' },
                    [ customBox, cmpCheck.el, filterWrap ]),
                host ]);
            fromIn.value = st.from; toIn.value = st.to; filterIn.value = '';

            function msg(text, bad) {
                host.appendChild(E('div', { style: 'text-align:center; padding:30px 0; color:' + (bad ? 'var(--qos-danger)' : 'var(--qos-text-muted)') + ';' }, text));
            }

            // ---- navigation between entries (see the helpers at the top of render) ----
            var labelCache = {};
            function labelFor(dim, key) { return labelCache[dim + '|' + key] || alertBaseLabel(key); }
            function trailActive() {
                var n = st.trail.length, last = n ? st.trail[n - 1] : null;
                return n > 0 && last.dim === st.dim && last.key === st.open;
            }
            v.go = function(trail, range, replace) {
                trail.forEach(function(t) { if (t.label && t.dim && t.key) labelCache[t.dim + '|' + t.key] = t.label; });
                var h = hashFor(range || st.range, trail);
                if (replace) { replaceHash(h); onHashNav(); return; }      // repair the current entry, no new one
                // the same address fires no hashchange: apply directly in that case
                if (window.location.hash === h) onHashNav(); else window.location.hash = h;
            };
            v.applyNav = function(nv) {
                var last = nv.trail.length ? nv.trail[nv.trail.length - 1] : null;
                if (rangeIds.indexOf(nv.range) >= 0) st.range = nv.range;
                st.heatKey = null; st.filter = ''; filterIn.value = ''; st.all = false;
                if (nv.heatSlot) {
                    st.mode = 'table'; st.heatSlot = { day: nv.heatSlot.day, hour: nv.heatSlot.hour };
                    st.heatSlotDate = null;
                    st.open = null; st.full = null; st.trail = [];
                } else if (nv.heat) {
                    st.mode = 'heat'; st.heatSlot = null; st.heatSlotDate = null; st.open = null; st.full = null; st.trail = [];
                } else {
                    st.mode = 'table'; st.heatSlot = null; st.heatSlotDate = null; st.trail = nv.trail;
                    if (last && last.dim && last.key) {
                        if (st.dim !== last.dim) { st.dim = last.dim; st.data = {}; st.dataDim = ''; }
                        st.open = last.key; st.reveal = last.key; st.full = null;
                    } else { st.open = null; st.full = null; }
                }
                savePrefs(); mark();
                var R = rangeDef();
                var needLoad = st.dataDim !== st.dim || tiersFor(R).some(function(t) { return !st.data[t]; }) || (!!st.heatSlot && !st.data['1h']);
                render();
                if (needLoad) v.load();
            };
            // a related entry of the opened row: continue the path from it
            function goRelated(k, x, nm) {
                var base = trailActive() ? st.trail.slice() : [ { dim: st.dim, key: k, label: labelFor(st.dim, k) } ];
                base.push({ dim: REL_DIM[st.dim], key: x.n, label: alertBaseLabel(nm) });
                v.go(base, st.range);
            }
            function relLink(k, x, nm, warn) {
                var txt = (warn ? '\u26A0 ' : '') + alertBaseLabel(nm);
                if (x.n === '(other)') return txt;
                var el = E('span', { style: 'cursor:pointer;', title: _('Open in Volume') }, txt);
                el.addEventListener('click', function(e) { e.stopPropagation(); goRelated(k, x, nm); });
                return el;
            }
            function crumbNode() {
                var DIM_TAG = { a: _('App'), d: _('Device'), h: _('Destination') };
                var box = E('div', { style: 'text-align:center; font-size:12px; margin-bottom:8px;' });
                st.trail.forEach(function(t, i) {
                    var last = (i === st.trail.length - 1);
                    if (i > 0) box.appendChild(E('span', { style: 'margin:0 6px; color:var(--qos-text-muted);' }, '\u203A'));
                    var tag = t.heat ? _('Heatmap') : (DIM_TAG[t.dim] || (t.fromTab !== undefined ? _('Live') : ''));
                    var el = E('span', {
                        style: 'display:inline-block; padding:1px 9px; border-radius:11px; ' +
                               (last ? 'font-weight:700; background:rgba(128,128,128,0.18);' : 'cursor:pointer; border:1px solid rgba(128,128,128,0.45);'),
                        title: last ? '' : (t.fromTab !== undefined ? _('Back to live view') : (t.heat ? _('Back to heatmap') : _('Back to this entry')))
                    }, [
                        tag ? E('span', { style: 'font-size:9.5px; text-transform:uppercase; letter-spacing:.4px; color:var(--qos-text-muted); margin-right:5px;' }, tag) : '',
                        t.key ? E('span', { style: 'display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:5px; vertical-align:-1px; background:' + colorOf(t.key) + ';' }) : '',
                        t.label || labelFor(t.dim, t.key) ]);
                    if (!last) el.addEventListener('click', function(e) {
                        e.stopPropagation();
                        if (t.heat) {
                            st.mode = 'heat'; st.trail = [];
                            window.location.hash = '#volume/' + encodeURIComponent(st.range) + '/heat';
                        } else if (t.fromTab !== undefined && selectTabFn) {
                            // restore navOrigin so the Live tooltip can show a Back link
                            navOrigin = { dim: t.dim, key: t.key, label: t.label, tab: 5, range: st.range, kind: 'vol' };
                            selectTabFn(t.fromTab);
                        } else {
                            v.go(st.trail.slice(0, i + 1), st.range);
                        }
                    });
                    box.appendChild(el);
                });
                var clr = E('span', { style: 'margin-left:10px; cursor:pointer; color:var(--qos-text-muted);', title: _('Close the path') }, '\u00D7');
                clr.addEventListener('click', function(e) {
                    e.stopPropagation();
                    st.trail = [];
                    replaceHash('#volume/' + encodeURIComponent(st.range));
                    render();
                });
                box.appendChild(clr);
                return box;
            }

            // ---- lazily loaded full buckets (with the related lists) for the opened row ----
            function ensureFull(R) {
                var key = R.tier + '|' + st.dim;
                if (st.full && st.full.key === key) return;
                var f = st.full = { key: key, state: 'loading', data: null }, p;
                try { p = hv.loadTier(R.tier, st.dim, false); } catch (err) { p = Promise.reject(err); }
                p.then(function(b) { f.data = b; f.state = 'ok'; })
                 .catch(function() { f.state = 'err'; })
                 .then(function() { if (st.full === f && v.active) render(); });
            }

            // ---- detail of one row: usage over time + related entries ----
            var MUTED = 'font-size:11px; color:var(--qos-text-muted);';
            function timelineNode(k, m) {
                var B = st.data[m.R.tier] || [], a = m.w.start, b = m.w.end, span = b - a;
                var W = 720, H = 92, pl = 4, pr = 4, pt = 14, pb = 16, i;
                var ncols = Math.max(1, Math.min(96, Math.round(span / (medianDt(B) || 3600))));
                var colw = span / ncols, cols = [], maxv = 0;
                for (i = 0; i < ncols; i++) cols.push({ i: 0, o: 0 });
                B.forEach(function(bk) {
                    var d = bk.dt || 0, e = (bk[st.dim] || {})[k];
                    if (d <= 0 || !e) return;
                    var b0 = bk.t - d, b1 = bk.t;
                    if (b1 <= a || b0 >= b) return;
                    var c0 = Math.max(0, Math.floor((Math.max(b0, a) - a) / colw));
                    var c1 = Math.min(ncols - 1, Math.floor((Math.min(b1, b) - a - 1e-6) / colw));
                    for (var c = c0; c <= c1; c++) {
                        var ov = Math.min(b1, a + (c + 1) * colw) - Math.max(b0, a + c * colw);
                        if (ov <= 0) continue;
                        cols[c].i += (e[0] || 0) * ov / d; cols[c].o += (e[1] || 0) * ov / d;
                    }
                });
                cols.forEach(function(c) { if (c.i + c.o > maxv) maxv = c.i + c.o; });
                var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', style: 'display:block;' });
                var bw = (W - pl - pr) / ncols, ph = H - pt - pb;
                svg.appendChild(svgEl('line', { x1: pl, x2: W - pr, y1: pt + ph, y2: pt + ph, stroke: 'rgba(128,128,128,0.4)', 'stroke-width': 1 }));
                cols.forEach(function(c, ci) {
                    if (!(c.i + c.o > 0) || !(maxv > 0)) return;
                    var hi = ph * c.i / maxv, ho = ph * c.o / maxv, x = pl + ci * bw + (bw > 3 ? 0.5 : 0), w2 = Math.max(bw - (bw > 3 ? 1 : 0), 1);
                    var tip = stampTxt(a + ci * colw, span) + ' \u2013 ' + stampTxt(a + (ci + 1) * colw, span) + '\n\u2193 ' + formatBytes(c.i) + '   \u2191 ' + formatBytes(c.o);
                    var r1 = svgEl('rect', { x: x, y: pt + ph - hi, width: w2, height: Math.max(hi, 0.5), fill: COL_IN });
                    var r2 = svgEl('rect', { x: x, y: pt + ph - hi - ho, width: w2, height: Math.max(ho, 0.5), fill: COL_OUT });
                    [ r1, r2 ].forEach(function(r) { var t = svgEl('title', {}); t.textContent = tip; r.appendChild(t); svg.appendChild(r); });
                });
                var tl = svgEl('text', { x: pl, y: 9, style: 'font-size:10px; fill:var(--qos-text-muted);' });
                tl.textContent = _('max. %s per column of %s').format(formatBytes(maxv), durTxt(colw));
                svg.appendChild(tl);
                var t0 = svgEl('text', { x: pl, y: H - 3, style: 'font-size:10px; fill:var(--qos-text-muted);' });
                t0.textContent = axisLabel(a, span); svg.appendChild(t0);
                var t1 = svgEl('text', { x: W - pr, y: H - 3, 'text-anchor': 'end', style: 'font-size:10px; fill:var(--qos-text-muted);' });
                t1.textContent = axisLabel(b, span); svg.appendChild(t1);
                return E('div', { style: 'flex:1 1 420px; min-width:260px;' }, [
                    E('div', { style: 'font-size:11px; font-weight:700; color:var(--qos-text-strong); margin-bottom:2px;' }, _('Usage over time')),
                    svg,
                    E('div', { style: MUTED }, [
                        E('span', { style: 'display:inline-block; width:9px; height:9px; margin-right:4px; background:' + COL_IN + ';' }), '\u2193 ' + _('Download') + '   ',
                        E('span', { style: 'display:inline-block; width:9px; height:9px; margin-right:4px; background:' + COL_OUT + ';' }), '\u2191 ' + _('Upload') ]) ]);
            }
            function stampTxt(ep, span) {
                var d = new Date(ep * 1000);
                if (span <= 2 * 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
            function relNode(k, m) {
                var f = st.full, title = (st.dim === 'a') ? _('Top destinations') : (st.dim === 'd' ? _('Top applications') : _('Top devices'));
                var head = E('div', { style: 'font-size:11px; font-weight:700; color:var(--qos-text-strong); margin-bottom:2px;' }, title);
                var box = E('div', { style: 'flex:1 1 320px; min-width:260px;' }, [ head ]);
                if (!f || f.state === 'loading') { box.appendChild(E('div', { style: MUTED }, _('Loading details...'))); return box; }
                if (f.state === 'err') { box.appendChild(E('div', { style: 'font-size:11px; color:var(--qos-danger);' }, _('The details could not be loaded.'))); return box; }
                var acc = {}, any = false, a = m.w.start, b = m.w.end;
                f.data.forEach(function(bk) {
                    var d = bk.dt || 0, e = (bk[st.dim] || {})[k];
                    if (d <= 0 || !e) return;
                    var ov = Math.min(bk.t, b) - Math.max(bk.t - d, a);
                    if (ov <= 0) return;
                    var rel = (st.dim === 'd') ? e[3] : e[2];
                    if (!Array.isArray(rel)) return;
                    any = true;
                    rel.forEach(function(r) {
                        var x = acc[r[0]] || (acc[r[0]] = { n: r[0], label: '', i: 0, o: 0 });
                        x.i += (r[1] || 0) * ov / d; x.o += (r[2] || 0) * ov / d;
                        if (r[3]) x.label = r[3];
                    });
                });
                var list = Object.keys(acc).map(function(n) { return acc[n]; }).sort(function(x, y) { return (y.i + y.o) - (x.i + x.o); });
                var warned = list.slice(10).filter(function(x) { return isAlertMatch(x.n) || isAlertMatch(x.label); }).slice(0, 5);
                list = list.slice(0, 10).concat(warned);
                if (!any || !list.length) {
                    box.appendChild(E('div', { style: MUTED }, _('No detail data is stored for this entry (needs "History tooltip details" and "Detailed tooltips"; applies to new buckets only).')));
                    return box;
                }
                var mx = 0; list.forEach(function(x) { if (x.i + x.o > mx) mx = x.i + x.o; });
                var cell = 'padding:1px 8px; font-size:11px; line-height:1.5;', num = cell + ' text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums;';
                var rows = [ E('tr', { 'class': 'tr table-titles' }, [ E('th', { 'class': 'th', style: cell }, ''), E('th', { 'class': 'th', style: num }, '\u2193'), E('th', { 'class': 'th', style: num }, '\u2191') ]) ];
                list.forEach(function(x) {
                    var nm = x.label || x.n, warn = isAlertMatch(x.n) || isAlertMatch(nm);
                    var pct = mx > 0 ? Math.max(3, (x.i + x.o) / mx * 100) : 0;
                    rows.push(E('tr', { 'class': 'tr' }, [
                        E('td', { 'class': 'td', style: cell + ' max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' + (warn ? ' color:var(--qos-danger,#dc2626); font-weight:700;' : ''), title: alertBaseLabel(nm) }, [
                            relLink(k, x, nm, warn),
                            E('div', { style: 'height:2px; margin-top:2px; width:' + pct.toFixed(1) + '%; background:' + colorOf(x.n) + ';' }) ]),
                        E('td', { 'class': 'td', style: num }, formatBytes(x.i)), E('td', { 'class': 'td', style: num }, formatBytes(x.o)) ]));
                });
                box.appendChild(E('table', { 'class': 'table', style: 'width:100%; margin:0;' }, rows));
                box.appendChild(E('div', { style: MUTED }, _('Sum of the per-bucket top lists (at most 5 per bucket), so small entries can be missing.')));
                return box;
            }

            // ---- table ----
            function renderTable() {
                var m = compute();
                if (!m) { msg(_('Loading...')); return; }
                if (m.empty) { msg(_('No history yet - the first bucket is written 5 minutes after the aggregator started.')); return; }
                var R = m.R, cur = m.cur, w = m.w, span = w.end - w.start;
                if (!(span > 0) || !(cur.cov > 0)) { msg(_('No data stored for this period.')); return; }
                var showDelta = !!m.prev && m.prevFrac >= 0.05;
                var rows = Object.keys(cur.acc).map(function(k) {
                    var r = cur.acc[k], p = showDelta ? m.prev.acc[k] : null;
                    r.t = r.i + r.o; r.prevT = p ? p.i + p.o : 0;
                    r.delta = (showDelta && k !== '(other)') ? deltaOf(r.t, cur.cov, r.prevT, m.prev.cov) : null;
                    return r;
                });
                rows.forEach(function(r) { labelCache[st.dim + '|' + r.k] = r.label; });
                var navMiss = null;
                if (st.reveal && !(st.reveal in cur.acc)) { navMiss = labelFor(st.dim, st.reveal); st.reveal = null; st.open = null; }
                var grand = cur.sumI + cur.sumO;
                var maxT = 0;
                rows.forEach(function(r) { if (r.k !== '(other)' && r.t > maxT) maxT = r.t; });
                var totalDelta = showDelta ? deltaOf(grand, cur.cov, m.prev.sumI + m.prev.sumO, m.prev.cov) : null;
                v.cur = { R: R, w: w, rows: rows, sumI: cur.sumI, sumO: cur.sumO, showDelta: showDelta, totalDelta: totalDelta, prev: m.prev, prevFrac: m.prevFrac };

                if (st.err[R.tier])
                    host.appendChild(E('div', { style: 'text-align:center; color:var(--qos-danger); font-size:11px; padding:4px 0;' },
                        _('The last refresh failed - showing the most recently loaded data, which may be outdated. Retrying automatically.')));
                if (st.trail && st.trail.length) host.appendChild(crumbNode());
                if (navMiss) {
                    var missBox = E('div', { style: 'text-align:center; color:var(--qos-danger); font-size:12px; margin-bottom:10px; padding:6px; background:rgba(220,38,38,0.08); border-radius:6px;' }, [
                        E('div', { style: 'font-weight:700; margin-bottom:4px;' },
                            _('"%s" is not listed individually in this period (too small, or folded into "(other)").').format(navMiss)),
                        E('div', { style: 'font-size:11px;' }, [
                            _('Try switching to another period: '),
                            E('a', { href: '#', style: 'margin:0 6px; text-decoration:underline; font-weight:600;' }, '7 ' + _('days')),
                            E('a', { href: '#', style: 'margin:0 6px; text-decoration:underline; font-weight:600;' }, '30 ' + _('days')),
                            E('span', { style: 'margin:0 8px;' }, '•'),
                            E('a', { href: '#', style: 'margin:0 6px; text-decoration:underline; font-weight:700; color:var(--qos-text-strong);' }, '\u2190 ' + _('Back to Live'))
                        ])
                    ]);
                    var links = missBox.querySelectorAll('a');
                    if (links[0]) links[0].addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); st.range = '7d'; st.reveal = navMiss; st.open = navMiss; render(); v.load(); });
                    if (links[1]) links[1].addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); st.range = '30d'; st.reveal = navMiss; st.open = navMiss; render(); v.load(); });
                    if (links[2]) links[2].addEventListener('click', function(e) {
                        e.preventDefault(); e.stopPropagation();
                        if (navOrigin && navOrigin.tab !== undefined) {
                            var prev = navOrigin; navOrigin = null;
                            if (prev.kind === 'vol') navVolume(prev, null, st.range);
                            else if (prev.kind === 'hist') focusHist(prev.dim, prev.key, prev.label, st.range);
                            else focusLive(prev.dim, prev.key, prev.label, st.range,
                                { dim: prev.dim, key: prev.key, label: prev.label, tab: prev.tab });
                        } else selectTabFn(0);
                    });
                    host.appendChild(missBox);
                }
                host.appendChild(E('div', { style: 'text-align:center; font-size:12.5px; font-weight:700; color:var(--qos-text-strong); margin-bottom:2px;' },
                    '\u2193 ' + formatBytes(cur.sumI) + '   \u2191 ' + formatBytes(cur.sumO) + '   \u03A3 ' + formatBytes(grand) +
                    (showDelta ? '   (' + deltaTxt(totalDelta) + ' ' + _('vs. previous period') + ')' : '')));
                var notes = [ periodTxt(w.start, w.end) ];
                if (cur.cov < span * 0.95) notes.push(_('only %d %% of this period is stored').format(Math.round(cur.cov / span * 100)));
                if (st.cmp && !showDelta) notes.push(_('previous period: no data stored yet'));
                else if (showDelta && m.prevFrac < 0.95) notes.push(_('previous period: only %d %% stored (%s)').format(Math.round(m.prevFrac * 100), m.prevTier));
                host.appendChild(E('div', { style: 'text-align:center; ' + MUTED + ' margin-bottom:8px;' }, notes.join(' \u2022 ')));

                // stacked share bar: the biggest entries in the colour they have everywhere else, the rest grey
                if (grand > 0) {
                    var stack = E('div', { style: 'display:flex; height:16px; border-radius:5px; overflow:hidden; margin:0 0 12px; background:rgba(0,0,0,0.06);' });
                    var restShare = 0;
                    // a click on a segment opens that entry in the table (and scrolls to it)
                    var mkSeg = function(r, sh) {
                        var seg = E('div', { style: 'width:' + sh.toFixed(2) + '%; background:' + colorOf(r.k) + '; cursor:pointer;',
                            title: r.label + ': ' + formatBytes(r.t) + ' (' + sh.toFixed(1) + ' %) - ' + _('click for details') });
                        seg.addEventListener('click', function(e) {
                            e.stopPropagation();
                            st.filter = ''; filterIn.value = '';
                            st.open = r.k; st.reveal = r.k;
                            ensureFull(R);
                            if (buildFn) buildFn();
                        });
                        return seg;
                    };
                    rows.slice().sort(function(x, y) { return y.t - x.t; }).forEach(function(r, idx) {
                        var sh = r.t / grand * 100;
                        if (idx < 14 && sh >= 0.4 && r.k !== '(other)')
                            stack.appendChild(mkSeg(r, sh));
                        else restShare += sh;
                    });
                    if (restShare > 0)
                        stack.appendChild(E('div', { style: 'width:' + restShare.toFixed(2) + '%; background:' + colorOf('(other)') + ';',
                            title: _('Rest') + ': ' + restShare.toFixed(1) + ' %' }));
                    host.appendChild(stack);
                }
                var tableHost = E('div', { style: 'overflow-x:auto;' });
                host.appendChild(tableHost);
                var footer = E('div', { style: 'text-align:center; margin-top:6px;' });
                host.appendChild(footer);
                host.appendChild(E('div', { style: 'text-align:center; ' + MUTED + ' margin-top:6px;' },
                    _('Computed from the stored buckets (%s each); the busiest entries of each bucket are kept, the rest is summed as "(other)". Click a row for details.').format(durTxt(medianDt(st.data[R.tier] || [])))
                    + (showDelta ? ' ' + _('The change compares average rates, so a partly stored period does not distort it.') : '')));

                function build() {
                    while (tableHost.firstChild) tableHost.removeChild(tableHost.firstChild);
                    while (footer.firstChild) footer.removeChild(footer.firstChild);
                    var q = (st.filter || '').toLowerCase(), sort = st.sort, other = null;
                    var list = rows.filter(function(r) { if (r.k === '(other)') { other = r; return false; } return true; });
                    var shown = q ? list.filter(function(r) { return r.label.toLowerCase().indexOf(q) >= 0 || r.k.toLowerCase().indexOf(q) >= 0; }) : list;
                    shown.sort(function(x, y) {
                        var a, b;
                        if (sort.col === 'n') return (x.label < y.label ? -1 : (x.label > y.label ? 1 : 0)) * sort.dir;
                        if (sort.col === 'd') {
                            a = x.delta; b = y.delta;
                            if (a === null && b === null) return 0;
                            if (a === null) return 1;
                            if (b === null) return -1;
                            if (a === b) return 0;
                            return (a < b ? -1 : 1) * sort.dir;
                        }
                        a = (sort.col === 'i') ? x.i : (sort.col === 'o') ? x.o : x.t;
                        b = (sort.col === 'i') ? y.i : (sort.col === 'o') ? y.o : y.t;
                        return (a - b) * sort.dir;
                    });
                    var cell = 'padding:2px 8px; font-size:12px; line-height:1.5; height:auto;';
                    var num = cell + ' text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap;';
                    var ncol = showDelta ? 6 : 5;
                    function th(col, txt, right, title) {
                        var a = E('th', { 'class': 'th', style: (right ? num : cell) + ' cursor:pointer; user-select:none;', title: title || '' },
                            txt + (sort.col === col ? (sort.dir < 0 ? ' \u25BE' : ' \u25B4') : ''));
                        a.addEventListener('click', function(e) {
                            e.stopPropagation();
                            if (st.sort.col === col) st.sort.dir = -st.sort.dir; else st.sort = { col: col, dir: (col === 'n') ? 1 : -1 };
                            savePrefs(); build();
                        });
                        return a;
                    }
                    var head = [ th('n', DIMS.filter(function(d) { return d[0] === st.dim; })[0][1], false),
                                 th('i', '\u2193 ' + _('Download'), true), th('o', '\u2191 ' + _('Upload'), true), th('t', _('Total'), true) ];
                    if (showDelta) head.push(th('d', '\u0394', true, _('Change of the average rate compared with the preceding period of the same length')));
                    head.push(E('th', { 'class': 'th', style: num }, _('Share')));
                    var headerRow = E('tr', { 'class': 'tr table-titles' }, head);
                    var trs = [];

                    function heatBtnFor(r) {
                        var b = E('button', { type: 'button', 'class': 'btn cbi-button', style: 'font-size:11px; padding:1px 8px; margin-bottom:8px;' }, _('Heatmap of this entry'));
                        b.addEventListener('click', function(e) {
                            e.stopPropagation();
                            st.heatKey = r.k; st.heatLabel = r.label; st.mode = 'heat'; st.open = null; st.full = null;
                            savePrefs(); mark(); render(); v.load();
                        });
                        return E('div', {}, [ b ]);
                    }
                    function addRow(r, bold) {
                        var clickable = !bold && r.k !== '(other)' && r.k !== '__sub';
                        var share = grand > 0 ? r.t / grand * 100 : 0;
                        var nameKids = [];
                        if (clickable) nameKids.push(E('span', { style: 'display:inline-block; width:12px; color:var(--qos-text-muted);' }, st.open === r.k ? '\u25BE' : '\u25B8'));
                        if (!bold) nameKids.push(E('span', { style: 'display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; vertical-align:middle; background:' + colorOf(r.k) + ';' }));
                        nameKids.push((r.warn ? '\u26A0 ' : '') + r.label);
                        var dTxt = (r.delta === undefined) ? '' : deltaTxt(r.delta);
                        var tr = E('tr', { 'class': 'tr', title: clickable ? _('Click for details') : '' }, [
                            E('td', { 'class': 'td', style: cell + (bold ? ' font-weight:700;' : '') + (r.warn ? ' color:var(--qos-danger,#dc2626); font-weight:700;' : '') + ' max-width:380px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' }, nameKids),
                            E('td', { 'class': 'td', style: num + (bold ? ' font-weight:700;' : '') }, formatBytes(r.i)),
                            E('td', { 'class': 'td', style: num + (bold ? ' font-weight:700;' : '') }, formatBytes(r.o)),
                            E('td', { 'class': 'td', style: num + ' font-weight:700;' }, formatBytes(r.t)) ]);
                        if (showDelta) tr.appendChild(E('td', { 'class': 'td', style: num + (bold ? ' font-weight:700;' : '') + (deltaColor(r.delta) ? ' color:' + deltaColor(r.delta) + ';' : ''),
                            title: (r.prevT !== undefined && r.k !== '__sub') ? _('previous period: %s').format(formatBytes(r.prevT || 0)) : '' }, dTxt));
                        var frac = bold ? (r.k === '__tot' ? 1 : 0) : (maxT > 0 ? Math.min(1, r.t / maxT) : 0);
                        var barCol = bold ? 'var(--qos-text-muted)' : colorOf(r.k);
                        var shareKids = [];
                        // The Total row is the reference sum, not an item being compared.
                        // Keep its 100% label but omit the decorative progress bar.
                        if (r.k !== '__tot')
                            shareKids.push(E('div', { style: 'position:absolute; left:6px; top:4px; bottom:4px; width:calc((100% - 12px) * ' + frac.toFixed(4) + ');' +
                                (frac > 0 ? ' min-width:2px;' : '') + ' background:' + barCol + '; opacity:0.3; border-radius:3px; pointer-events:none;' }));
                        shareKids.push(E('span', { style: 'position:relative;' }, bold && r.k === '__tot' ? '100 %' : share.toFixed(share < 10 ? 1 : 0) + ' %'));
                        tr.appendChild(E('td', { 'class': 'td', style: num + ' position:relative; min-width:130px;' }, shareKids));
                        if (r.warn) tr.style.background = 'rgba(220,38,38,0.08)';
                        if (clickable) {
                            tr.style.cursor = 'pointer'; tr.setAttribute('data-k', r.k);
                            tr.addEventListener('click', function(e) {
                                e.stopPropagation();
                                st.open = (st.open === r.k) ? null : r.k;
                                if (st.open) ensureFull(R);
                                build();
                            });
                        }
                        trs.push(tr);
                        if (clickable && st.open === r.k)
                            trs.push(E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td', colspan: ncol, style: 'padding:8px 12px; background:rgba(128,128,128,0.07);' }, [
                                heatBtnFor(r),
                                E('div', { style: 'display:flex; gap:20px; flex-wrap:wrap; align-items:flex-start;' }, [ timelineNode(r.k, m), relNode(r.k, m) ]) ]) ]));
                    }
                    var cap = q ? 300 : (st.all ? list.length : LIMIT);
                    if (st.reveal) for (var ix = 0; ix < shown.length; ix++) if (shown[ix].k === st.reveal) { if (ix >= cap) cap = ix + 1; break; }
                    shown.slice(0, cap).forEach(function(r) { addRow(r, false); });
                    if (q) {
                        var si = 0, so = 0; shown.forEach(function(r) { si += r.i; so += r.o; });
                        addRow({ k: '__sub', label: _('Filter total (%d)').format(shown.length), i: si, o: so, t: si + so, delta: undefined, prevT: undefined }, true);
                    } else if (other) {
                        addRow(other, false);
                    }
                    addRow({ k: '__tot', label: _('Total'), i: cur.sumI, o: cur.sumO, t: grand, delta: totalDelta, prevT: showDelta ? m.prev.sumI + m.prev.sumO : undefined }, true);
                    var table = E('table', { 'class': 'table', style: 'width:100%;' });
                    table.appendChild(E('thead', {}, [ headerRow ]));
                    table.appendChild(E('tbody', {}, trs));
                    tableHost.appendChild(table);
                    if (st.reveal) {
                        var revKey = st.reveal; st.reveal = null;
                        setTimeout(function() {
                            var els = tableHost.querySelectorAll('tr[data-k]');
                            for (var ei = 0; ei < els.length; ei++)
                                if (els[ei].getAttribute('data-k') === revKey && els[ei].scrollIntoView) { els[ei].scrollIntoView({ block: 'center', behavior: 'smooth' }); break; }
                        }, 30);
                    }

                    if (!q && list.length > LIMIT) {
                        var more = E('button', { type: 'button', 'class': 'btn cbi-button' }, st.all ? _('Show fewer') : _('Show all %d').format(list.length));
                        more.addEventListener('click', function(e) { e.stopPropagation(); st.all = !st.all; build(); });
                        footer.appendChild(more);
                    } else if (q && shown.length > cap) {
                        footer.appendChild(E('span', { style: MUTED }, _('Only the first %d matches are listed.').format(cap)));
                    }
                }
                buildFn = build;
                if (st.open && !(st.open in cur.acc)) st.open = null;
                if (st.open) ensureFull(R);
                build();
            }

            // A heatmap cell drills into all matching weekday/hour buckets and ranks entries.
            // Clicking an entry then opens the normal linked Volume detail view.
            function renderHeatSlot() {
                var B = st.data['1h'] || [], slot = st.heatSlot, w = windowFor(rangeDef(), B);
                if (!slot) { renderHeat(); return; }
                var datesInSlot = [], sampleCount = 0;
                B.forEach(function(bk) {
                    var d = bk.dt || 0;
                    if (d <= 0) return;
                    var o0 = Math.max(bk.t - d, w.start), o1 = Math.min(bk.t, w.end), ov = o1 - o0;
                    if (ov <= 0) return;
                    var mid = new Date((bk.t - d / 2) * 1000);
                    if ((mid.getDay() + 6) % 7 !== slot.day || mid.getHours() !== slot.hour) return;
                    sampleCount++;
                    var bDate = dayStr(bk.t - d / 2);
                    if (datesInSlot.indexOf(bDate) < 0) datesInSlot.push(bDate);
                });
                datesInSlot.sort();
                var activeDate = st.heatSlotDate;
                if (activeDate && datesInSlot.indexOf(activeDate) < 0) { activeDate = null; st.heatSlotDate = null; }

                var acc = {}, cov = 0;
                B.forEach(function(bk) {
                    var d = bk.dt || 0;
                    if (d <= 0) return;
                    var o0 = Math.max(bk.t - d, w.start), o1 = Math.min(bk.t, w.end), ov = o1 - o0;
                    if (ov <= 0) return;
                    var midEp = bk.t - d / 2, mid = new Date(midEp * 1000);
                    if ((mid.getDay() + 6) % 7 !== slot.day || mid.getHours() !== slot.hour) return;
                    var bDate = dayStr(midEp);
                    if (activeDate && bDate !== activeDate) return;
                    var f = ov / d, src = bk[st.dim] || {};
                    Object.keys(src).forEach(function(k) {
                        var e = src[k], r = acc[k] || (acc[k] = { k: k, label: k, i: 0, o: 0 });
                        r.i += (e[0] || 0) * f; r.o += (e[1] || 0) * f;
                        if (st.dim === 'd' && typeof e[2] === 'string') r.label = alertBaseLabel(e[2]);
                    });
                    cov += ov;
                });
                var rows = Object.keys(acc).map(function(k) { return acc[k]; });
                rows.sort(function(a, b) { return (b.i + b.o) - (a.i + a.o); });
                rows.forEach(function(r) { if (st.dim !== 'd') r.label = alertBaseLabel(r.k); });
                var dayNames = [];
                for (var di = 0; di < 7; di++) dayNames.push(new Date(2024, 0, 1 + di).toLocaleDateString([], { weekday: 'long' }));
                var timeRangeStr = pad2(slot.hour) + ':00–' + pad2((slot.hour + 1) % 24) + ':00';
                var title = dayNames[slot.day] + ' ' + timeRangeStr;
                if (activeDate) {
                    var dp = activeDate.split('-');
                    var activeDateObj = new Date(+dp[0], +dp[1] - 1, +dp[2]);
                    title = activeDateObj.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + timeRangeStr;
                }
                var back = E('button', { type: 'button', 'class': 'btn cbi-button', style: 'font-size:11px; padding:2px 9px; margin:0 0 8px;' }, '← ' + _('Back to heatmap'));
                back.addEventListener('click', function(e) {
                    e.stopPropagation();
                    st.heatSlot = null; st.heatSlotDate = null; st.mode = 'heat';
                    savePrefs(); mark();
                    window.location.hash = '#volume/' + encodeURIComponent(st.range) + '/heat';
                });
                host.appendChild(E('div', { style: 'text-align:center; margin-bottom:8px;' }, [ back ]));
                host.appendChild(E('div', { style: 'text-align:center; font-size:13px; font-weight:700; color:var(--qos-text-strong); margin-bottom:4px;' }, _('Entries for %s').format(title)));

                if (datesInSlot.length > 1) {
                    var selOptions = [
                        E('option', { value: '' }, _('All %d matching days (average/sum)').format(datesInSlot.length))
                    ];
                    datesInSlot.slice().sort().reverse().forEach(function(day) {
                        var parts = day.split('-');
                        var dObj = new Date(+parts[0], +parts[1] - 1, +parts[2]);
                        var dLabel = dObj.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
                        var opt = E('option', { value: day }, dLabel);
                        if (activeDate === day) opt.selected = true;
                        selOptions.push(opt);
                    });
                    var selEl = E('select', {
                        'class': 'cbi-input-select',
                        style: 'font-size:11.5px; padding:2px 8px; max-width:280px; margin-left:6px; cursor:pointer;'
                    }, selOptions);
                    selEl.addEventListener('change', function(e) {
                        st.heatSlotDate = selEl.value || null;
                        render();
                    });
                    var datePicker = E('div', {
                        style: 'display:flex; justify-content:center; align-items:center; gap:6px; margin-bottom:8px; font-size:11.5px;'
                    }, [
                        E('span', { style: 'color:var(--qos-text-muted); font-weight:600;' }, _('Day:')),
                        selEl
                    ]);
                    host.appendChild(datePicker);
                }

                host.appendChild(E('div', { style: 'text-align:center; ' + MUTED + ' margin-bottom:8px;' },
                    (activeDate ? _('Hourly samples for this day: %d').format(sampleCount) : _('Matching hourly samples: %d across %d day(s)').format(sampleCount, datesInSlot.length)) +
                    ' • ' + _('Accumulated coverage: %s').format(durTxt(cov))));
                if (!rows.length) { host.appendChild(E('div', { style: 'text-align:center; ' + MUTED }, _('No entry details are stored for this time slot.'))); return; }
                var table = E('table', { 'class': 'table', style: 'width:100%;' });
                table.appendChild(E('tr', { 'class': 'tr table-titles' }, [
                    E('th', { 'class': 'th' }, _('Entry')), E('th', { 'class': 'th', style: 'text-align:right;' }, '↓ ' + _('Download')),
                    E('th', { 'class': 'th', style: 'text-align:right;' }, '↑ ' + _('Upload')),
                    E('th', { 'class': 'th', style: 'text-align:right;' }, _('Total')) ]));
                rows.slice(0, 100).forEach(function(r) {
                    var tr = E('tr', { 'class': 'tr', title: _('Click for linked details in Volume'), style: 'cursor:pointer;' }, [
                        E('td', { 'class': 'td' }, [ E('span', { style: 'display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; background:' + colorOf(r.k) + ';' }), r.label ]),
                        E('td', { 'class': 'td', style: 'text-align:right; white-space:nowrap;' }, formatBytes(r.i)),
                        E('td', { 'class': 'td', style: 'text-align:right; white-space:nowrap;' }, formatBytes(r.o)),
                        E('td', { 'class': 'td', style: 'text-align:right; white-space:nowrap; font-weight:700;' }, formatBytes(r.i + r.o)) ]);
                    tr.addEventListener('click', function(e) {
                        e.stopPropagation();
                        v.go([
                            { heat: true, label: _('Heatmap') + ' (' + title + ')' },
                            { dim: st.dim, key: r.k, label: r.label }
                        ], st.range);
                    });
                    table.appendChild(tr);
                });
                host.appendChild(E('div', { style: 'overflow-x:auto;' }, [ table ]));
                host.appendChild(E('div', { style: 'text-align:center; ' + MUTED + ' margin-top:6px;' },
                    _('Select an entry to open its overall Volume details and related links.')));
            }

            // ---- heatmap: average rate per weekday and hour of day ----
            function renderHeat() {
                var R = rangeDef(), B = st.data['1h'];
                if (!B) { msg(_('Loading...')); return; }
                if (st.err['1h'])
                    host.appendChild(E('div', { style: 'text-align:center; color:var(--qos-danger); font-size:11px; padding:4px 0;' },
                        _('The last refresh failed - showing the most recently loaded data, which may be outdated. Retrying automatically.')));
                if (!B.length) { msg(_('No hourly data yet - hourly buckets are closed at the full hour.')); return; }
                var w = windowFor(R, B), cells = [], dI, h, nb = 0, first = Infinity, last = 0;
                for (dI = 0; dI < 7; dI++) { cells.push([]); for (h = 0; h < 24; h++) cells[dI].push({ ib: 0, ob: 0, sec: 0, n: 0, dates: [] }); }
                B.forEach(function(bk) {
                    var d = bk.dt || 0;
                    if (d < 600 || d > 7300) return;
                    var o0 = Math.max(bk.t - d, w.start), o1 = Math.min(bk.t, w.end), ov = o1 - o0;
                    if (ov <= 0) return;
                    var f = ov / d, midEp = bk.t - d / 2, mid = new Date(midEp * 1000), c = cells[(mid.getDay() + 6) % 7][mid.getHours()];
                    var bucketDate = dayStr(midEp);
                    if (c.dates.indexOf(bucketDate) < 0) c.dates.push(bucketDate);
                    var ent = st.heatKey ? (bk[st.dim] || {})[st.heatKey] : null;
                    var bi = st.heatKey ? (ent ? ent[0] || 0 : 0) : (bk['in'] || 0), bo = st.heatKey ? (ent ? ent[1] || 0 : 0) : (bk.out || 0);
                    c.ib += bi * f; c.ob += bo * f; c.sec += ov; c.n++; nb++;
                    if (o0 < first) first = o0;
                    if (o1 > last) last = o1;
                });
                if (!nb) { msg(_('No hourly data for the shown period.')); return; }
                function val(c) {
                    if (c.sec <= 0) return -1;
                    var by = (st.hdir === 'in') ? c.ib : (st.hdir === 'out') ? c.ob : c.ib + c.ob;
                    return by * 8 / c.sec;
                }
                var mx = 0, best = null;
                cells.forEach(function(row, ri) { row.forEach(function(c, hi) { var x = val(c); if (x > mx) { mx = x; best = [ ri, hi ]; } }); });
                v.heat = { cells: cells, w: w, first: first, last: last };
                var dayNames = []; for (dI = 0; dI < 7; dI++) dayNames.push(new Date(2024, 0, 1 + dI).toLocaleDateString([], { weekday: 'short' }));
                var W = 760, pl = 44, pr = 6, pt = 20, cw = (W - pl - pr) / 24, ch = 26, H = pt + 7 * ch + 4;
                var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', style: 'display:block;' });
                var hcol = st.heatKey ? colorOf(st.heatKey) : 'hsl(210,75%,48%)';
                for (h = 0; h < 24; h += 2) {
                    var ht = svgEl('text', { x: pl + h * cw + cw, y: 13, 'text-anchor': 'middle', style: 'font-size:10px; fill:var(--qos-text-muted);' });
                    ht.textContent = pad2(h); svg.appendChild(ht);
                }
                cells.forEach(function(row, ri) {
                    var lt = svgEl('text', { x: pl - 6, y: pt + ri * ch + ch / 2 + 4, 'text-anchor': 'end', style: 'font-size:11px; fill:var(--qos-text-muted);' });
                    lt.textContent = dayNames[ri]; svg.appendChild(lt);
                    row.forEach(function(c, hi) {
                        var x = val(c), op = (x > 0 && mx > 0) ? 0.08 + 0.92 * Math.pow(x / mx, 0.5) : 0;
                        var r = svgEl('rect', { x: pl + hi * cw + 1, y: pt + ri * ch + 1, width: cw - 2, height: ch - 2, rx: 3,
                            fill: op > 0 ? hcol : 'rgba(128,128,128,0.10)', 'fill-opacity': op > 0 ? op.toFixed(3) : 1 });
                        // same tooltip as the other views (the plain SVG <title> shows late and without formatting)
                        var info = {
                            label: dayNames[ri] + ' ' + pad2(hi) + ':00\u2013' + pad2((hi + 1) % 24) + ':00',
                            color: hcol, details: []
                        };
                        if (c.sec > 0) {
                            var avgIn = c.ib * 8 / c.sec, avgOut = c.ob * 8 / c.sec;
                            var dateText = c.dates.slice().sort().map(function(day) {
                                var parts = day.split('-');
                                return new Date(+parts[0], +parts[1] - 1, +parts[2]).toLocaleDateString([], {
                                    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
                                });
                            }).join(', ');
                            info.sub = _('Dates') + ': ' + dateText + ' \u2022 \u2193 ' + formatRate(avgIn) + '   \u2191 ' + formatRate(avgOut) + '   \u03A3 ' + formatRate(avgIn + avgOut) +
                                ' \u2022 ' + _('%d samples').format(c.n);
                            info.detailTitle = _('Volume');
                            info.details = [
                                [ _('Average per hour'), c.ib * 3600 / c.sec, c.ob * 3600 / c.sec, false, 'avg' ],
                                [ _('Total in the period'), c.ib, c.ob, false, 'tot' ]
                            ];
                        } else info.sub = _('no data');
                        (function(rect, inf, key) {
                            function mark(on) {
                                if (on) { rect.setAttribute('stroke', 'var(--qos-text-strong)'); rect.setAttribute('stroke-width', '1.5'); }
                                else { rect.removeAttribute('stroke'); rect.removeAttribute('stroke-width'); }
                            }
                            rect.addEventListener('mouseenter', function(ev) { if (heatPin) return; tipTrack(ev); tipShow(inf); mark(true); });
                            rect.addEventListener('mousemove', function(ev) { if (!heatPin) tipTrack(ev); });
                            rect.addEventListener('mouseleave', function() { if (heatPin) return; tipHide(); mark(false); });
                            rect.addEventListener('click', function(ev) {
                                ev.stopPropagation();
                                heatUnpin();
                                // Keep the heatmap and the selected cell in browser history so Back
                                // restores the previous heatmap state instead of leaving stale UI.
                                var base = '#volume/' + encodeURIComponent(st.range) + '/heat';
                                if (window.location.hash !== base && !/^#volume\/.+\/heat$/.test(window.location.hash)) {
                                    replaceHash(base);
                                }
                                var target = '#volume/' + encodeURIComponent(st.range) + '/heat-slot:' + ri + ':' + hi;
                                if (window.location.hash === target) onHashNav(); else window.location.hash = target;
                            });
                        })(r, info, ri + ':' + hi);
                        svg.appendChild(r);
                    });
                });
                host.appendChild(E('div', { style: 'text-align:center; font-size:12.5px; font-weight:700; color:var(--qos-text-strong); margin-bottom:2px;' },
                    _('Average rate by weekday and hour of day') + ' (' + HDIRS.filter(function(d) { return d[0] === st.hdir; })[0][1] + ')'));
                if (st.heatKey) {
                    var clr = E('button', { type: 'button', 'class': 'btn cbi-button', style: 'margin-left:12px; font-size:11px; padding:1px 8px;' }, '\u00D7 ' + _('All entries'));
                    clr.addEventListener('click', function(e) { e.stopPropagation(); st.heatKey = null; st.heatLabel = ''; heatUnpin(); render(); });
                    host.appendChild(E('div', { style: 'text-align:center; margin-bottom:6px; font-size:12.5px;' }, [
                        E('span', { style: 'display:inline-block; width:11px; height:11px; border-radius:3px; margin-right:6px; vertical-align:-1px; background:' + hcol + ';' }),
                        E('strong', {}, st.heatLabel), clr ]));
                }
                host.appendChild(E('div', { style: 'text-align:center; ' + MUTED + ' margin-bottom:8px;' },
                    periodTxt(first, last) + ' \u2022 ' + _('%d hourly buckets').format(nb) +
                    (R.id === '365d' || R.id === 'lm' ? ' \u2022 ' + _('hourly data only reaches back about 31 days') : '')));
                host.appendChild(svg);
                host.appendChild(E('div', { style: 'text-align:center; ' + MUTED + ' margin-top:8px;' },
                    (best ? _('Busiest slot: %s %s:00 with an average of %s.').format(dayNames[best[0]], pad2(best[1]), formatRate(mx)) + ' ' : '') +
                    _('Darkest cell = %s; empty cells have no stored data. Times are in your local time.').format(formatRate(mx)) +
                    (st.heatKey ? ' ' + _('Values of a single entry are summed from the stored hourly buckets; hours in which it was too small to be listed count as 0.') : '')));
            }

            function render() {
                try { renderInner(); }
                catch (err) {
                    while (host.firstChild) host.removeChild(host.firstChild);
                    buildFn = null; v.cur = null; v.heat = null;
                    msg(_('Volume view error: ') + (err && err.message ? err.message : err), true);
                    if (window.console) console.error('trafficchart volume view', err);
                }
            }
            function renderInner() {
                heatPin = null;
                tipHide();
                while (host.firstChild) host.removeChild(host.firstChild);
                buildFn = null; v.cur = null; v.heat = null;
                mark();
                var R = rangeDef(), need = (st.mode === 'heat' || st.heatSlot) ? '1h' : R.tier;
                if (!st.data[need] || st.dataDim !== st.dim) {
                    if (st.err[need]) msg(_('History could not be loaded (request to the aggregator failed). Retrying automatically.'), true);
                    else msg(_('Loading...'));
                    return;
                }
                if (st.heatSlot) renderHeatSlot(); else if (st.mode === 'heat') renderHeat(); else renderTable();
            }
            v.render = render;
            v.getRange = function() { return st.range; };
            v.resetView = function() {
                st.trail = [];
                st.open = null;
                st.reveal = null;
                st.full = null;
                st.all = false;
                st.filter = '';
                if (filterIn) filterIn.value = '';
                st.heatSlot = null;
                st.heatSlotDate = null;
                st.mode = 'table';
                // clear stale DOM immediately so old heatmap/table is not visible during load
                while (host.firstChild) host.removeChild(host.firstChild);
                buildFn = null; v.cur = null; v.heat = null;
            };
            v.stale = function() {
                if (v.loading) return Date.now() - v.loadingAt > 30000;
                var tier = (st.mode === 'heat') ? '1h' : rangeDef().tier, failed = !!st.err[tier];
                return Date.now() - v.loadedAt > (failed ? 15000 : REFRESH[tier]);
            };
            v.load = function() {
                var mySeq = ++seq, R = rangeDef(), dim = st.dim, tiers = tiersFor(R), got = {}, errs = {};
                v.loading = true; v.loadingAt = Date.now(); v.loadedAt = Date.now();
                // one tier after the other: every request makes the router read a whole history file, so
                // running them side by side only raises its peak load
                return tiers.reduce(function(chain, t) {
                    return chain.then(function() {
                        var p;
                        try { p = hv.loadTier(t, dim, true); } catch (err) { p = Promise.reject(err); }
                        return p.then(function(b) { got[t] = b; }).catch(function(err) {
                            errs[t] = true;
                            if (window.console) console.error('trafficchart volume load', t, err);
                        });
                    });
                }, Promise.resolve()).then(function() {
                    if (mySeq !== seq) return;
                    v.loading = false;
                    if (st.dataDim !== dim) { st.data = {}; st.dataDim = dim; }
                    tiers.forEach(function(t) { if (got[t]) st.data[t] = got[t]; });
                    st.err = errs;
                    if (st.open) st.full = null;
                    render();
                });
            };

            // ---- export ----
            v.exportJson = function() {
                if (st.mode === 'heat' && v.heat) {
                    saveFile('trafficchart-heatmap-' + stamp() + '.json', 'application/json', JSON.stringify({
                        generated: new Date().toISOString(), from: v.heat.first, to: v.heat.last, direction: st.hdir,
                        cells: v.heat.cells.map(function(row, ri) { return row.map(function(c) {
                            return { in_bytes: c.ib, out_bytes: c.ob, seconds: c.sec, samples: c.n }; }); }) }, null, 2));
                    return;
                }
                var c = v.cur;
                if (!c) return;
                saveFile('trafficchart-volume-' + c.R.id + '-' + stamp() + '.json', 'application/json', JSON.stringify({
                    generated: new Date().toISOString(), range: c.R.id, from: c.w.start, to: c.w.end, dimension: st.dim,
                    in_bytes: c.sumI, out_bytes: c.sumO, delta_vs_previous: c.totalDelta === Infinity ? null : c.totalDelta,
                    entries: c.rows.map(function(r) { return { id: r.k, name: r.label, in_bytes: r.i, out_bytes: r.o, total_bytes: r.t,
                        previous_total_bytes: c.showDelta ? r.prevT : null, delta: (r.delta === Infinity || r.delta === undefined) ? null : r.delta }; })
                }, null, 2));
            };
            v.exportCsv = function() {
                var lines, c;
                if (st.mode === 'heat' && v.heat) {
                    lines = [ csvLine([ 'weekday', 'hour', 'avg_in_bits_per_s', 'avg_out_bits_per_s', 'samples' ]) ];
                    v.heat.cells.forEach(function(row, ri) { row.forEach(function(x, hi) {
                        lines.push(csvLine([ ri + 1, hi, x.sec > 0 ? Math.round(x.ib * 8 / x.sec) : '', x.sec > 0 ? Math.round(x.ob * 8 / x.sec) : '', x.n ])); }); });
                    saveFile('trafficchart-heatmap-' + stamp() + '.csv', 'text/csv', lines.join('\n') + '\n');
                    return;
                }
                c = v.cur;
                if (!c) return;
                lines = [ csvLine([ 'id', 'name', 'in_bytes', 'out_bytes', 'total_bytes', 'previous_total_bytes', 'delta_percent' ]) ];
                c.rows.slice().sort(function(a, b) { return b.t - a.t; }).forEach(function(r) {
                    lines.push(csvLine([ r.k, r.label, Math.round(r.i), Math.round(r.o), Math.round(r.t), c.showDelta ? Math.round(r.prevT) : '',
                        (r.delta === null || r.delta === undefined || r.delta === Infinity) ? (r.delta === Infinity ? 'new' : '') : (r.delta * 100).toFixed(1) ]));
                });
                saveFile('trafficchart-volume-' + c.R.id + '-' + stamp() + '.csv', 'text/csv', lines.join('\n') + '\n');
            };
            mark();
            render();
            return v;
        }

        var flowsView = makeFlowsView();
        var histView = makeHistoryView();
        var volView = makeVolumeView(histView);

        // Shaper status rows must be able to wrap on narrow LuCI viewports.
        // A fixed-height grid with nowrap/ellipsis clipped long WAN and queue labels.
        var shaperEl = E('div', { style: 'font-size:11.5px; color:var(--qos-text-strong); margin:0 0 12px; line-height:1.4; font-variant-numeric:tabular-nums; box-sizing:border-box; overflow:visible; white-space:normal !important; overflow-wrap:anywhere;' });

        // Per-WAN breakdown: the main link line above sums all shaped WAN devices into one rate and
        // one configured-rate figure, which hides very asymmetric multi-WAN setups. data.wan has one
        // entry per WAN when there is more than one; it stays empty and hidden for a single WAN.
        var wanEl = E('div', { style: 'display:none; font-size:11px; color:var(--qos-text-muted); margin:0 0 10px; line-height:1.5; font-variant-numeric: tabular-nums; text-align:center;' });
        var prevWan = {};
        function wanRateBps(current, previous, dt) {
            if (typeof current !== 'number' || !isFinite(current) ||
                typeof previous !== 'number' || !isFinite(previous) || !(dt > 0)) return null;
            // Interface devices can be recreated while the logical WAN name
            // stays the same. A lower counter means a new counter generation;
            // its current total is the best available delta for this interval.
            var delta = current >= previous ? current - previous : current;
            return Math.max(0, delta / dt);
        }
        function wanUpdate(wan, dt) {
            while (wanEl.firstChild) wanEl.removeChild(wanEl.firstChild);
            if (!wan || wan.length < 2) {
                // A missing/single-WAN sample breaks the per-WAN time baseline.
                // Do not divide counters accumulated across that gap by just
                // the next poll interval when multi-WAN data returns.
                prevWan = {};
                wanEl.style.display = 'none';
                return;
            }
            wanEl.style.display = '';
            var presentWan = {};
            wan.forEach(function(w, i) {
                presentWan[w.iface] = true;
                var prev = prevWan[w.iface];
                var rxBps = wanRateBps(w.rx_bytes, prev ? prev.rx_bytes : null, dt);
                var txBps = wanRateBps(w.tx_bytes, prev ? prev.tx_bytes : null, dt);
                var downMbit = (w.download_kbit || 0) / 1000, upMbit = (w.upload_kbit || 0) / 1000;
                var dTxt = (rxBps !== null ? formatRate(rxBps * 8) : '') + (downMbit > 0 ? (rxBps !== null ? ' / ' : '') + downMbit.toFixed(0) + ' Mbit/s' : '');
                var uTxt = (txBps !== null ? formatRate(txBps * 8) : '') + (upMbit > 0 ? (txBps !== null ? ' / ' : '') + upMbit.toFixed(0) + ' Mbit/s' : '');
                var txt = w.iface + ':';
                if (dTxt) txt += ' ' + dTxt + ' \u2193';
                if (dTxt && uTxt) txt += ',';
                if (uTxt) txt += ' ' + uTxt + ' \u2191';
                if (i > 0) wanEl.appendChild(document.createTextNode('  \u2022  '));
                wanEl.appendChild(E('span', {}, txt));
                prevWan[w.iface] = { rx_bytes: w.rx_bytes, tx_bytes: w.tx_bytes };
            });
            // If WAN membership changed while two or more WANs remained, forget
            // vanished interfaces too; they may return later with a stale counter.
            for (var iface in prevWan)
                if (Object.prototype.hasOwnProperty.call(prevWan, iface) && !presentWan[iface])
                    delete prevWan[iface];
        }
        // One entry per shaped queue and direction. With a single WAN these are the "rx" / "tx" shapers; with several
        // WANs (data.shapers) every WAN gets its own download and upload line, so no queue is hidden behind the first.
        var prevShaper = {};
        var LIVE_DROP_LEN = 60;
        var liveDropHist = {};
        function shaperEntries(data) {
            var out = [], sh = data && data.shaper, list = data && data.shapers;
            function has(x) { return x && x.sent !== undefined; }
            var ppeRate = data && data.ppe_hw && data.sqm && Number(data.sqm.download_kbit) > 0 ? Number(data.sqm.download_kbit) : 0;
            var hasDownloadQueue = !!(sh && has(sh.rx));
            if (list && list.length > 1) {
                var perWanRx = list.some(function(w) { return has(w.rx); });
                // NSS has one shared ingress device for all WANs: show it once instead of per WAN.
                if (!perWanRx && hasDownloadQueue) out.push({ key: 'rx', label: _('Download shaper'), cur: sh.rx });
                list.forEach(function(w) {
                    [ ['rx', _('Download shaper')], ['tx', _('Upload shaper')] ].forEach(function(def) {
                        if (has(w[def[0]])) out.push({ key: w.iface + ':' + def[0], label: w.iface + ' - ' + def[1], cur: w[def[0]] });
                    });
                });
                hasDownloadQueue = perWanRx || (!perWanRx && hasDownloadQueue);
            } else {
                [ ['rx', _('Download shaper')], ['tx', _('Upload shaper')] ].forEach(function(def) {
                    if (has(sh && sh[def[0]])) out.push({ key: def[0], label: def[1], cur: sh[def[0]] });
                });
            }
            // hw_ppe.qos has no IFB/qdisc on the switch CPU port. Its configured
            // rate comes from devlink cpu_port_rate; queue/drop/backlog counters
            // are not exposed for that CPU port, so show the rate without fake stats.
            if (ppeRate > 0 && !hasDownloadQueue)
                out.push({ key: 'rx-ppe-cpu', label: _('PPE CPU-port download shaper'), cur: { sent: null, rate: formatRate(ppeRate * 1000) } });
            return out;
        }
        function liveSparkline(dropArr, ecnArr, maxv) {
            var n = LIVE_DROP_LEN, w = 110, h = 18;
            var bw = w / n;
            var svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, style: 'display:inline-block; vertical-align:middle; flex-shrink:0; border-radius:4px; overflow:hidden;' });
            svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, fill: 'rgba(0,0,0,0.035)', rx: 4, ry: 4 }));
            var offset = n - dropArr.length;
            dropArr.forEach(function(dv, i) {
                var ev = ecnArr[i] || 0;
                var x = (offset + i) * bw;
                var bwv = Math.max(bw - 0.5, 0.5);
                var dh = h * (dv || 0) / maxv, eh = h * ev / maxv;
                if (dv > 0) {
                    var rd = svgEl('rect', { x: x, y: h - dh, width: bwv, height: Math.max(dh, 0.8), fill: 'rgba(239,68,68,0.85)' });
                    (function(val) {
                        rd.addEventListener('mouseenter', function(ev) {
                            tipTrack(ev);
                            tipShow({ label: _('Shaper Drops'), sub: val.toFixed(2) + ' drops/s', color: '#ef4444', details: [] });
                        });
                        rd.addEventListener('mousemove', tipTrack);
                        rd.addEventListener('mouseleave', tipHide);
                    })(dv);
                    svg.appendChild(rd);
                }
                if (ev > 0) {
                    var re = svgEl('rect', { x: x, y: h - dh - eh, width: bwv, height: Math.max(eh, 0.8), fill: 'rgba(245,158,11,0.85)' });
                    (function(val) {
                        re.addEventListener('mouseenter', function(ev) {
                            tipTrack(ev);
                            tipShow({ label: _('ECN Marks'), sub: val.toFixed(2) + ' ECN/s', color: '#f59e0b', details: [] });
                        });
                        re.addEventListener('mousemove', tipTrack);
                        re.addEventListener('mouseleave', tipHide);
                    })(ev);
                    svg.appendChild(re);
                }
            });
            return svg;
        }

        function shaperCounterRate(current, previous, dt) {
            if (typeof current !== 'number' || !isFinite(current) ||
                typeof previous !== 'number' || !isFinite(previous) || !(dt > 0)) return null;
            // Qdiscs are recreated on SQM reloads, resetting their cumulative counters.
            // Treat a decrease as a new counter generation instead of clamping the
            // entire sample to zero until the counter catches up with the old value.
            var delta = current >= previous ? current - previous : current;
            return Math.max(0, delta / dt);
        }

function shaperUpdate(entries, dt) {
    while (shaperEl.firstChild) shaperEl.removeChild(shaperEl.firstChild);
    var rows = [];
    entries.forEach(function(def) {
        var cur = def.cur, prev = prevShaper[def.key];
        var dr = prev ? shaperCounterRate(cur.dropped, prev.dropped, dt) : null;
        var er = prev ? shaperCounterRate(cur.ecn, prev.ecn, dt) : null;
        var hasDropped = typeof cur.dropped === 'number' && isFinite(cur.dropped);
        var hasEcn = typeof cur.ecn === 'number' && isFinite(cur.ecn);
        var hasBacklogB = typeof cur.backlog_b === 'number' && isFinite(cur.backlog_b);
        var hasBacklogP = typeof cur.backlog_p === 'number' && isFinite(cur.backlog_p);
        var pct = hasDropped && typeof cur.pkts === 'number' && isFinite(cur.pkts) && cur.pkts > 0 ? (cur.dropped / cur.pkts * 100) : null;
        var hasActiveFlows = typeof cur.flows_new === 'number' && isFinite(cur.flows_new) && typeof cur.flows_old === 'number' && isFinite(cur.flows_old);

        var hist = liveDropHist[def.key] || (liveDropHist[def.key] = { d: [], e: [], scale: 0 });
        hist.d.push(dr === null ? 0 : dr); hist.e.push(er === null ? 0 : er);
        if (hist.d.length > LIVE_DROP_LEN) { hist.d.shift(); hist.e.shift(); }

        var instMax = 0;
        for (var hi = 0; hi < hist.d.length; hi++) instMax = Math.max(instMax, (hist.d[hi] || 0) + (hist.e[hi] || 0));
        var wantScale = 1;
        if (instMax > 1) {
            var sp = Math.pow(10, Math.floor(Math.log(instMax) / Math.LN10)), sn = instMax / sp;
            wantScale = (sn <= 1 ? 1 : sn <= 2 ? 2 : sn <= 5 ? 5 : 10) * sp;
        }
        if (!hist.scale || instMax > hist.scale || instMax < hist.scale * 0.4) hist.scale = wantScale;
        var drawMax = hist.scale;

        var head = def.label;
        var headInfo = [];
        if (cur.rate) headInfo.push(cur.rate);
        if (cur.target) headInfo.push(_('target') + ' ' + cur.target);
        if (cur.limit) headInfo.push(_('limit') + ' ' + cur.limit);
        if (headInfo.length) head += ' (' + headInfo.join(', ') + ')';

        var prefix = head, dropsTxt = '';
        var showSpark = false;
        if (hasDropped) {
            prefix += ':';
            dropsTxt = _('drops') + (dr !== null ? ' ' + dr.toFixed(1) + '/s' : '');
            showSpark = true;
        }

        var rest = [];
        if (hasDropped)
            rest.push('(' + formatCount(cur.dropped) + ' ' + _('total') + (pct !== null ? ', ' + pct.toFixed(3) + ' %' : '') + ')');
        if (hasEcn) {
            rest.push('ECN' + (er !== null ? ' ' + er.toFixed(1) + '/s' : '') + ' (' + formatCount(cur.ecn) + ')');
            showSpark = true;
        }
        if (hasBacklogB)
            rest.push(_('backlog') + ' ' + formatBytes(cur.backlog_b) + (hasBacklogP ? ' / ' + cur.backlog_p + ' pkt' : ''));
        if (typeof cur.drop_overlimit === 'number' && isFinite(cur.drop_overlimit))
            rest.push(_('limit hits') + ' ' + cur.drop_overlimit);
        if (hasActiveFlows)
            rest.push(_('active flows') + ' ' + (cur.flows_new + cur.flows_old));

        if (!showSpark && !rest.length && !headInfo.length) return;

        var spark = null;
        if (showSpark) {
            spark = liveSparkline(hist.d, hist.e, drawMax);
            spark.style.display = 'inline-block';
            spark.setAttribute('title', _('Recent drop rate (red) / ECN rate (amber), roughly the last %d polls.').format(LIVE_DROP_LEN));
        }
        rows.push({
            prefix: prefix, dropsTxt: dropsTxt, spark: spark, rest: rest.join(' \u00b7 '),
            danger: typeof cur.drop_overlimit === 'number' && typeof (prev && prev.drop_overlimit) === 'number' && cur.drop_overlimit > prev.drop_overlimit
        });
    });

    var anySpark = rows.some(function(r) { return !!r.spark; });
    var rowTip = _('Drops are normal codel behaviour under load. "Limit hits" > 0 mean the queue limit was exceeded (limit too small for the link speed).');
    
    rows.forEach(function(r) {
        var cs = r.danger ? ' color:var(--qos-danger);' : '';
        
        var rowDiv = E('div', { 
            style: 'margin-bottom: 8px; line-height: 1.4; font-variant-numeric: tabular-nums;' + cs, 
            title: rowTip 
        }, [
            // Fester Kernblock (Präfix, Drops, Sparkline) schmiegt sich links an und bricht nicht intern um
            E('span', { 
                style: 'display: inline-flex; align-items: center; white-space: nowrap; margin-right: 8px;' 
            }, [
                E('span', { style: 'font-weight: 600; align-items: center;' }, r.prefix),
                r.dropsTxt ? E('span', { style: 'min-width: 85px; display: inline-block; text-align: left;' }, r.dropsTxt) : null,
                anySpark ? (r.spark || E('span', { style: 'display:inline-block; width:110px; height:18px;' })) : null
            ].filter(Boolean)),
            
            // Rest-Text fließt natürlich im Textfluss weiter
            r.rest ? E('span', { style: 'word-break: break-word; overflow-wrap: anywhere;' }, r.rest) : null
        ].filter(Boolean));
        
        shaperEl.appendChild(rowDiv);
    });

    shaperEl.style.display = shaperEl.firstChild ? 'block' : 'none';
    shaperEl.style.overflowX = 'hidden';
    shaperEl.style.height = '';
    shaperEl.style.minHeight = '';
    shaperEl.style.maxHeight = '';

    var liveKeys = {};
    entries.forEach(function(def) { liveKeys[def.key] = true; prevShaper[def.key] = def.cur; });
    Object.keys(prevShaper).forEach(function(k) { if (!liveKeys[k]) { delete prevShaper[k]; delete liveDropHist[k]; } });
}

        var lastData = null;
        // Only the visible one of the three live views (applications / devices /
        // destinations) is rendered; the others catch up when their tab is opened.
        var activeTab = 0;
        function renderTab(idx) {
            var d = lastData;
            if (!d || idx > 2 || !d.rate) return;
            var ri = d.rate;
            var ifr = ri.tc ? { rx: ri.rx_bps || 0, tx: ri.tx_bps || 0 } : null;
            var dn = d.sqm ? (d.sqm.download_kbit || 0) : 0, up = d.sqm ? (d.sqm.upload_kbit || 0) : 0;
            var v = [ appsView, devicesView, hostsView ][idx], items = [ d.apps, d.devices, d.hosts ][idx];
            if (items) v.render(items, ifr, dn, up, d.iface, baselineLabelText(), ri);
        }
        function stamp() {
            var d = new Date(), p = function(n) { return (n < 10 ? '0' : '') + n; };
            return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
        }
        function saveFile(name, mime, text) {
            var url = URL.createObjectURL(new Blob([ text ], { type: mime }));
            var a = E('a', { href: url, download: name });
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
        }
        function csvLine(cells) {
            return cells.map(function(c) { return '"' + String(c === undefined || c === null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
        }
        function exportCsv() {
            if (!lastData) return;
            var d = lastData, lines = [ csvLine([ 'view', 'name', 'in_bytes', 'out_bytes', 'in_packets', 'out_packets', 'in_bytes_per_s', 'out_bytes_per_s' ]) ];
            var block = function(view, obj, labelFn) {
                Object.keys(obj || {}).forEach(function(k) {
                    var e = obj[k];
                    lines.push(csvLine([ view, labelFn ? labelFn(k, e) : k, e.in_bytes, e.out_bytes, e.in_packets, e.out_packets, e.in_bps, e.out_bps ]));
                });
            };
            block('application', d.apps);
            block('device', d.devices, function(k, e) { return (e.name || k) + (e.ip ? ' (' + e.ip + ')' : ''); });
            block('destination', d.hosts);
            lines.push('');
            lines.push(csvLine([ 'busiest_flows', 'device', 'application', 'destination', 'port', 'proto', 'in_bytes_per_s', 'out_bytes_per_s', 'volume_bytes' ]));
            (d.top_flows || []).forEach(function(f) {
                lines.push(csvLine([ 'flow', f.dev, f.app, f.host || f.dst, f.port, f.proto, f.in_bps, f.out_bps, f.bytes ]));
            });
            saveFile('trafficchart-' + stamp() + '.csv', 'text/csv', lines.join('\n') + '\n');
        }
        function exportJson() {
            if (!lastData) return;
            saveFile('trafficchart-' + stamp() + '.json', 'application/json', JSON.stringify(lastData, null, 2));
        }

        var statusEl = E('span', { style: 'color:var(--qos-text-muted);' }, _('Querying conntrack via ubus...'));

        var restartBusy = false;
        var restartBtn = E('button', {
            type: 'button', class: 'btn cbi-button cbi-button-remove',
            style: 'display:none; margin-left:10px; font-size:11px; padding:1px 8px; vertical-align:middle;'
        }, _('Restart service'));
        restartBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (restartBusy) return;
            restartBusy = true;
            restartBtn.disabled = true;
            restartBtn.textContent = _('Restarting...');
            callRestart().then(function() {
                setTimeout(function() {
                    restartBusy = false;
                    restartBtn.disabled = false;
                    restartBtn.textContent = _('Restart service');
                }, 4000);
            }).catch(function() {
                restartBusy = false;
                restartBtn.disabled = false;
                restartBtn.textContent = _('Restart service');
            });
        });

        var staleEl = E('div', {
            style: 'display:none; color:var(--qos-danger); font-size:11.5px; text-align:center; margin-bottom:8px;'
        }, [ E('span', { id: 'qos_stale_text' }, '') ]);

        // shown instead of the restart button while the service is switched off in the settings
        var disabledEl = E('div', { style: 'display:none; text-align:center; margin:10px 0;' }, [
            E('div', {}, _('The Traffic Chart service is disabled in the settings, so no data is collected.')),
            canRestart ? E('a', {
                href: L.url('admin', 'network', 'traffic_chart_settings'),
                'class': 'btn cbi-button cbi-button-apply',
                style: 'margin-top:8px; display:inline-block; text-decoration:none;'
            }, _('Open settings to enable it')) : '' ]);
        function applyServiceState() {
            restartBtn.style.display = (canRestart && svcEnabled) ? '' : 'none';
            disabledEl.style.display = svcEnabled ? 'none' : '';
            if (!svcEnabled && !haveRenderedOnce) {
                statusEl.style.color = 'var(--qos-text-muted)';
                statusEl.textContent = _('Traffic Chart is disabled.');
            }
        }

        var container = E('div', {
            id: 'qos_container',
            style: 'background: var(--qos-surface); border: 1px solid var(--qos-text-muted); border-radius: .50em; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3); padding:28px 32px; max-width:1700px; margin:0 auto;'
        }, [ statusEl, restartBtn, disabledEl, staleEl ]);

        container.addEventListener('click', function(e) {
            if (e.target.closest && e.target.closest('.qos-seg, .qos-legend-row')) return;
            slotViews.forEach(function(sv) { sv.panelIn.clearPinned(); sv.panelOut.clearPinned(); });
        });

        var m = E('div', { class: 'cbi-map' }, [
            E('h2', {}, _('Traffic Chart')),
            E('div', { class: 'cbi-section' }, [ container ])
        ]);

        var chartMounted = false;
        function mountChartOnce(data) {
            if (chartMounted) return;
            container.innerHTML = '';

            container.style.position = 'relative';
            container.style.paddingBottom = '40px';

            var appPanels = E('div', { class: 'qos-panels', style: 'margin-bottom: 40px; display:none;' }, [ appsView.panelIn.el, appsView.panelOut.el ]);
            var devPanels = E('div', { class: 'qos-panels', style: 'margin-bottom: 40px; display:none;' }, [ devicesView.panelIn.el, devicesView.panelOut.el ]);
            var hostPanels = E('div', { class: 'qos-panels', style: 'margin-bottom: 40px; display:none;' }, [ hostsView.panelIn.el, hostsView.panelOut.el ]);
            var groups = [ appPanels, devPanels, hostPanels, flowsView.el, histView.el, volView.el ];
            var tabDefs = [ ['qos_tab_apps', _('Applications')], ['qos_tab_devices', _('Devices')],
                            ['qos_tab_hosts', _('Destinations')], ['qos_tab_flows', _('Flows')], ['qos_tab_history', _('History')], ['qos_tab_volume', _('Volume')] ];
            var tabBtns = [];
            var TAB_NAMES = [ 'apps', 'devices', 'hosts', 'flows', 'history', 'volume' ];
            function selectTab(idx, skipHash, isDirectTabClick) {
                if (idx === 5 && isDirectTabClick && volView && volView.resetView) {
                    volView.resetView();
                }
                if (!skipHash) {
                    if (idx === 5) {
                        var h = '#volume/' + encodeURIComponent(volView.getRange ? volView.getRange() : '24h');
                        if (window.location.hash !== h) {
                            lastHandledHash = h;
                            try { window.history.pushState(null, '', window.location.pathname + window.location.search + h); } catch (e) {}
                        }
                    } else {
                        var targetHash = '#' + TAB_NAMES[idx];
                        if (window.location.hash !== targetHash) {
                            lastHandledHash = targetHash;
                            try { window.history.pushState(null, '', window.location.pathname + window.location.search + targetHash); } catch (e) {}
                        }
                    }
                }
                tipHide();
                histView.clearPinned();
                slotViews.forEach(function(sv) { sv.panelIn.clearPinned(); sv.panelOut.clearPinned(); });
                groups.forEach(function(g, i) { g.style.display = (i === idx) ? '' : 'none'; });
                tabBtns.forEach(function(li, i) { li.className = (i === idx) ? 'cbi-tab' : 'cbi-tab-disabled'; });
                activeTab = idx;
                prefSave('ui', { tab: idx });
                var tg = groups[idx];
                tg.classList.add('qos-notrans');
                renderTab(idx);
                void tg.offsetWidth;
                setTimeout(function() { tg.classList.remove('qos-notrans'); }, 60);
                histView.active = (idx === 4);
                volView.active = (idx === 5);
                if (idx === 4) { if (histView.skipLoad) histView.skipLoad = false; else histView.load(); }
                if (idx === 5) {
                    try {
                        if (volView.stale() || isDirectTabClick) volView.load();
                        else volView.render();
                    } catch (err) { if (window.console) console.error(err); }
                }
                if (btnJson) exportTitles();
            }
            function exportTitles() {
                if (volView.active) {
                    btnJson.title = _('Export the volume table of the shown period as JSON');
                    btnCsv.title = _('Export the volume table of the shown period as CSV');
                    return;
                }
                var h = histView.active;
                btnJson.title = h ? _('Export the shown history range (all buckets, applications, devices and destinations) as JSON') : _('Export the current data as JSON');
                btnCsv.title = h ? _('Export the shown history range (all buckets, applications, devices and destinations) as CSV') : _('Export the current data as CSV');
            }
            tabDefs.forEach(function(d, i) {
                var a = E('a', { href: '#', id: d[0] }, d[1]);
                a.addEventListener('click', function(e) {
                    e.preventDefault(); e.stopPropagation();
                    selectTab(i, false, true);
                });
                tabBtns.push(E('li', {}, a));
            });
            var savedTab = prefLoad().ui && prefLoad().ui.tab;
            var initialTab = (typeof savedTab === 'number' && savedTab >= 0 && savedTab < groups.length) ? Math.floor(savedTab) : 0;
            selectTab(initialTab, true);
            selectTabFn = selectTab;
            // the very first entry gets a real address, so Back always has something valid to return to
            if (!window.location.hash) {
                replaceHash(initialTab === 5 ? '#volume/' + encodeURIComponent(volView.getRange ? volView.getRange() : '24h') : '#' + TAB_NAMES[initialTab]);
            } else lastHandledHash = window.location.hash;
            homeTab = initialTab;
            var hashHandler = function() {
                if (window.location.hash === lastHandledHash) return;
                lastHandledHash = window.location.hash;
                onHashNav();
            };
            window.addEventListener('hashchange', hashHandler);
            window.addEventListener('popstate', hashHandler);
            cleanupFns.push(function() {
                window.removeEventListener('hashchange', hashHandler);
                window.removeEventListener('popstate', hashHandler);
                selectTabFn = null;
            });
            if (parseHash(window.location.hash)) onHashNav();
            var tabs = E('ul', { class: 'cbi-tabmenu', style: 'flex:1 1 auto;' }, tabBtns);
            var btnJson = E('button', { type: 'button', class: 'btn cbi-button', id: 'qos_export_json' }, _('Export JSON'));
            var btnCsv = E('button', { type: 'button', class: 'btn cbi-button', id: 'qos_export_csv' }, _('Export CSV'));
            btnJson.addEventListener('click', function(e) { e.stopPropagation(); if (histView.active) histView.exportJson(); else if (volView.active) volView.exportJson(); else exportJson(); });
            btnCsv.addEventListener('click', function(e) { e.stopPropagation(); if (histView.active) histView.exportCsv(); else if (volView.active) volView.exportCsv(); else exportCsv(); });
            exportTitles();
            // settings live on their own page (admin ACL only)
            var toolbarBtns = [ btnJson, btnCsv ];
            if (canRestart)
                toolbarBtns.push(E('a', {
                    href: L.url('admin', 'network', 'traffic_chart_settings'),
                    'class': 'btn cbi-button', id: 'qos_settings_link',
                    style: 'text-decoration:none;', title: _('Settings'), 'aria-label': _('Settings')
                }, '\u2699'));
            var toolbar = E('div', { style: 'display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap;' }, [
                tabs, E('div', { style: 'display:flex; gap:6px; margin-bottom:1em;' }, toolbarBtns) ]);

            var hintText = _('* Note: rates are the mean of the last %d s, measured by the trafficchart-agg daemon on its own clock (bytes per application, device and destination from /proc/net/nf_conntrack, application names from netifyd). The link rate comes from the tc qdisc counters read in the same instant. "Not attributed" is what the shaper carries but conntrack does not count (after subtracting the link layer header): e.g. traffic to router services, dropped inbound packets, multicast.').format((data && data.rate && data.rate.win) || 0);
            if (data && data.backend === 'nss')
                hintText += ' ' + _('NSS hardware offload bypasses nftables for accelerated flows; conntrack byte counters keep advancing under offload, which is why they are used.');
            var hintEl = E('div', {
                style: 'margin-top: 40px; margin-left: 40px; margin-right: 40px; font-size: 11px; color: var(--qos-text-muted);'
            }, hintText);

            container.appendChild(staleEl);
            container.appendChild(disabledEl);
            container.appendChild(wanEl);
            container.appendChild(shaperEl);
            container.appendChild(toolbar);
            container.appendChild(appPanels);
            container.appendChild(devPanels);
            container.appendChild(hostPanels);
            container.appendChild(flowsView.el);
            container.appendChild(histView.el);
            container.appendChild(volView.el);
            container.appendChild(hintEl);
            chartMounted = true;
        }

        var lastTime = Date.now();
        var lastSrvUp = null;
        var lastSrvSince = null;
        var haveRenderedOnce = false;
        var lastSuccessTime = Date.now();
        var consecutiveFailures = 0;

        function initialPollFailureMessage(err) {
            var detail = err && (err.message || err.statusText);
            if (!detail && typeof err === 'string') detail = err;
            if (detail) return _('Error: %s').format(detail);
            return _('Error: No response from trafficchart RPC. Is the trafficchart service running (/etc/init.d/trafficchart start)?');
        }

        function updateStaleIndicator() {
            if (!haveRenderedOnce) return;
            if (consecutiveFailures === 0) {
                staleEl.style.display = 'none';
                restartBtn.style.display = 'none';
                disabledEl.style.display = 'none';
                return;
            }
            var secsAgo = Math.round((Date.now() - lastSuccessTime) / 1000);
            var textEl = document.getElementById('qos_stale_text');
            if (textEl) textEl.textContent = _('⚠ No update for %ds (last successful read: %s) - retrying automatically...')
                .format(secsAgo, new Date(lastSuccessTime).toLocaleTimeString());
            staleEl.style.display = 'block';
            applyServiceState();
        }

        var baselineTime = null;
        // The aggregator's `since` timestamp changes when history is cleared, even
        // though its process uptime does not reset. Refresh this label on every
        // successful poll instead of pinning it to the first page render.
        function updateBaselineTime(current, dataSince, now) {
            if (typeof dataSince === 'number' && isFinite(dataSince) && dataSince > 0)
                return new Date(dataSince * 1000);
            return current || new Date(now);
        }
        function baselineLabelText() {
            return baselineTime ? (_('since %s').format(baselineTime.toLocaleString())) : _('since start');
        }
        // A small backwards uptime jump is normally an out-of-order/stale sample.
        // But when `since` has changed, the daemon or its cumulative baseline has
        // genuinely reset; do not suppress the new zeroed totals for up to 30 s.
        function isStaleUptimeSample(haveRenderedOnce, srvUp, lastSrvUp, srvSince, lastSrvSince) {
            return haveRenderedOnce && srvUp !== null && lastSrvUp !== null &&
                srvUp <= lastSrvUp && lastSrvUp - srvUp < 30 &&
                (srvSince === null || lastSrvSince === null || srvSince === lastSrvSince);
        }
        var pollInFlight = false;
        var pollRequestId = 0;
        // A timed-out request may settle after a replacement poll has started. Only the current
        // request may release pollInFlight; stale callbacks must not unlock a newer request.
        function finishPollRequest(requestId) {
            if (pollRequestId !== requestId) return false;
            pollInFlight = false;
            return true;
        }
        // Far longer than any normal rpc/ubus timeout - this only exists to recover if a request
        // NEVER settles at all. It advances pollRequestId, so a response that arrives later is
        // recognised as stale (myPollId mismatch) and discarded instead of overwriting newer data.
        var POLL_HARD_TIMEOUT = 30000;

        var tabHidden = (typeof document.hidden === 'boolean') ? document.hidden : false;
        var visibilityHandler = function() { tabHidden = document.hidden; };
        document.addEventListener('visibilitychange', visibilityHandler);
        cleanupFns.push(function() { document.removeEventListener('visibilitychange', visibilityHandler); });

        // The daemon only produces new data every load.interval seconds (4-20 s):
        // poll at half of that instead of a fixed 2 s.
        var pollSec = 2;
        function adaptPoll(data) {
            var iv = (data && data.load && data.load.interval) || 0;
            var want = Math.max(2, Math.min(10, Math.ceil(iv / 2)));
            if (want === pollSec) return;
            pollSec = want;
            // not inside the running poll iteration
            setTimeout(function() { poll.remove(pollFn); poll.add(pollFn, pollSec); }, 0);
        }

        var pollFn = function() {
            if (tabHidden) return Promise.resolve();
            if (pollInFlight) return Promise.resolve();
            pollInFlight = true;
            var myPollId = ++pollRequestId;

            if (histView.active && histView.stale()) histView.load();
            if (volView.active && volView.stale()) volView.load();

            var hardTimer = setTimeout(function() {
                if (pollRequestId === myPollId) { pollRequestId++; pollInFlight = false; }
            }, POLL_HARD_TIMEOUT);

            return callTrafficStats().then(function(data) {
                clearTimeout(hardTimer);
                // Do not let a late response from a timed-out request unlock a newer poll.
                if (!finishPollRequest(myPollId)) return;   // superseded by the hard-timeout fallback above
                if (!document.getElementById('qos_container')) return;

                if (data.error || !data.apps || !data.rate) {
                    consecutiveFailures++;
                    if (!haveRenderedOnce) {
                        statusEl.style.color = 'red';
                        statusEl.textContent = data && data.error
                            ? _('Error: %s').format(data.error)
                            : _('Error: No data received. Is the trafficchart service running (/etc/init.d/trafficchart start)?');
                        applyServiceState();
                    } else {
                        updateStaleIndicator();
                    }
                    return;
                }

                var now = Date.now();
                var dt = (now - lastTime) / 1000;
                if (dt <= 0) dt = 1;

                var srvUp = (typeof data.up === 'number') ? data.up : null;
                var srvSince = (typeof data.since === 'number') ? data.since : null;
                if (isStaleUptimeSample(haveRenderedOnce, srvUp, lastSrvUp, srvSince, lastSrvSince)) {
                    lastSuccessTime = Date.now();
                    consecutiveFailures = 0;
                    updateStaleIndicator();
                    return;
                }

                var sqmDownloadKbit = data.sqm ? (data.sqm.download_kbit || 0) : 0;
                var sqmUploadKbit = data.sqm ? (data.sqm.upload_kbit || 0) : 0;
                var liveShapers = shaperEntries(data);

                lastTime = now;
                lastSrvUp = srvUp;
                lastSrvSince = srvSince;
                baselineTime = updateBaselineTime(baselineTime, srvSince, now);

                lastSuccessTime = Date.now();
                consecutiveFailures = 0;
                updateStaleIndicator();

                flowsView.update(data.top_flows || [], sqmDownloadKbit, sqmUploadKbit);
                shaperUpdate(liveShapers, dt);
                wanUpdate(data.wan, dt);
                lastData = data;
                tcDiagText = data.tc_diag || '';
                histView.setPersist(data.persist || null);
                histView.setSqm(sqmDownloadKbit, sqmUploadKbit);
                histView.setShaper(liveShapers.some(function(entry) {
                    var c = entry.cur || {};
                    return typeof c.dropped === 'number' || typeof c.ecn === 'number' || typeof c.backlog_b === 'number';
                }));

                mountChartOnce(data);

                renderTab(activeTab);

                haveRenderedOnce = true;
                adaptPoll(data);
            }).catch(function(err) {
                clearTimeout(hardTimer);
                // Rejected stale requests must not clear the active newer request's lock either.
                if (finishPollRequest(myPollId)) {
                    consecutiveFailures++;
                    if (haveRenderedOnce) {
                        updateStaleIndicator();
                    } else {
                        // A rejected first RPC never reaches the resolved { error: ... } path
                        // above. Show a useful error instead of leaving the page on "Querying".
                        statusEl.style.color = 'red';
                        statusEl.textContent = initialPollFailureMessage(err);
                        applyServiceState();
                    }
                }
                throw err;
            });
        };
        poll.add(pollFn, pollSec);
        cleanupFns.push(function() {
            poll.remove(pollFn);
            pollInFlight = false;
            pollRequestId++;
        });

        return m;
    },
    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});

