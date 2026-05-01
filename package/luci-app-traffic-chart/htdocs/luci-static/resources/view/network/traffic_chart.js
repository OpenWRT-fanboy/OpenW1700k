'use strict';
'require view';
'require rpc';
'require poll';

var callTrafficStats = rpc.declare({
    object: 'luci.trafficchart',
    method: 'get_stats',
    expect: { '': {} }
});

var callHistory = rpc.declare({
    object: 'luci.trafficchart',
    method: 'get_stats',
    params: [ 'history', 'tier', 'dim' ],
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

var previousCleanup = null;

return view.extend({
    load: function() {
        return Promise.all([ canCall('restart'), canCall('reset_history') ]);
    },

    render: function(perm) {
        var canRestart = !!(perm && perm[0]), canReset = !!(perm && perm[1]);
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
            '#qos_tip td:first-child { white-space:normal; min-width:150px; max-width:260px; }' +
            '#qos_tip tr + tr td { border-top: 1px solid rgba(255,255,255,.10) !important; }' +
            '#qos_tip td.dl { color:#6ee7b7 !important; } #qos_tip td.ul { color:#93c5fd !important; }' +
            '#qos_tip .tt-name { color:#f8fafc !important; font-weight:600; }' +
            '#qos_tip .tt-title { color:#ffffff !important; font-size:13px; font-weight:800; min-width:0; white-space:normal; overflow-wrap:anywhere; }' +
            '#qos_tip .tt-sub { color:rgba(226,232,240,.75) !important; font-size:11px; margin:-4px 0 8px 16px; white-space:normal; overflow-wrap:anywhere; }';
        document.head.appendChild(tipStyle);
        var tipEl = document.getElementById('qos_tip');
        if (!tipEl) { tipEl = E('div', { id: 'qos_tip' }); document.body.appendChild(tipEl); }
        tipEl.style.cssText = 'position:fixed; z-index:10000; display:none; pointer-events:none; max-width:min(460px, 92vw); ' +
            'background:rgba(15,23,42,0.68) !important; color:#e2e8f0 !important; ' +
            '-webkit-backdrop-filter:blur(14px) saturate(1.4); backdrop-filter:blur(14px) saturate(1.4); ' +
            'border:1px solid rgba(255,255,255,0.18) !important; border-radius:12px; ' +
            'box-shadow:0 12px 32px rgba(0,0,0,0.5); padding:12px 14px; font-size:12px; line-height:1.35;';
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
        function tipHide() { tipEl.style.display = 'none'; }
        function tipShow(m) {
            while (tipEl.firstChild) tipEl.removeChild(tipEl.firstChild);
            var max = 0;
            if (m.details && m.details.length) {
                m.details.forEach(function(d) { max = Math.max(max, (d[1] || 0) + (d[2] || 0)); });
                var rows = [ E('tr', {}, [
                    E('th', {}, m.detailTitle || _('Top applications')),
                    E('th', {}, '\u2193 ' + _('Download')),
                    E('th', {}, '\u2191 ' + _('Upload')) ]) ];
                m.details.forEach(function(d) {
                    var pct = max > 0 ? Math.max(3, ((d[1] || 0) + (d[2] || 0)) / max * 100) : 0;
                    rows.push(E('tr', {}, [
                        E('td', {}, [
                            E('div', { 'class': 'tt-name' }, d[0]),
                            E('div', { style: 'height:3px; margin-top:4px; border-radius:2px; background:rgba(255,255,255,0.12) !important;' }, [
                                E('div', { style: 'height:100%; width:' + pct.toFixed(1) + '%; border-radius:2px; background:hsl(' + slotHue(d[0]) + ',65%,62%) !important;' }) ]) ]),
                        E('td', { 'class': 'dl' }, formatBytes(d[1])),
                        E('td', { 'class': 'ul' }, formatBytes(d[2])) ]));
                });
            }
            var dot = m.color || '#94a3b8';
            tipEl.appendChild(E('div', { style: 'display:flex; align-items:center; gap:8px; margin-bottom:8px;' }, [
                E('span', { style: 'flex-shrink:0; width:8px; height:8px; border-radius:50%; background:' + dot + ' !important; box-shadow:0 0 8px ' + dot + ';' }),
                E('span', { 'class': 'tt-title' }, m.label) ]));
            if (m.sub) tipEl.appendChild(E('div', { 'class': 'tt-sub' }, m.sub));
            if (m.details && m.details.length) tipEl.appendChild(E('table', {}, rows));
            tipEl.style.display = 'block';
            tipPlace();
        }

        var tcDiagText = '';

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
                if (m && m.details && m.details.length) { tipShow(m); tipShown = true; }
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
                var sigmaSuffixWordEl = E('span', { style: 'color:var(--qos-text);' }, ' packets');
                var sigmaSuffixTimeEl = E('span', {}, ' (since start)');
                var sigmaEl = E('span', {
                    style: 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1 1 auto;'
                }, [ E('span', { style: 'color:var(--qos-text);' }, 'Total '), sigmaBytesEl, ' - ', sigmaPacketsEl, sigmaSuffixWordEl, sigmaSuffixTimeEl ]);
                var totalPctEl = E('span', {
                    style: 'min-width:58px; text-align:right; display:inline-block; flex-shrink:0;'
                }, 'total: 0.0%');
                refs.classes[cls].livePct = liveTextEl;
                refs.classes[cls].liveBar = liveBarEl;
                refs.classes[cls].sigma = sigmaEl;
                refs.classes[cls].sigmaBytes = sigmaBytesEl;
                refs.classes[cls].sigmaPackets = sigmaPacketsEl;
                refs.classes[cls].sigmaSuffixTime = sigmaSuffixTimeEl;
                refs.classes[cls].totalPct = totalPctEl;

                var labelEl = E('span', { style: 'font-size:11.5px; color:var(--qos-text-strong); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;' }, metaOf(cls).label);
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
                    refs.classes[cls].labelEl.textContent = m.label;
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

                var sourceTxt = ifaceSourceName ? ' [via ' + ifaceSourceName + ']' : '';
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
                        linkStatsText.textContent = ifaceMbit.toFixed(1) + ' Mbit/s of ' + configuredMbit.toFixed(0) + ' Mbit/s configured (' + totalPct.toFixed(1) + '%)' + sourceTxt;
                    } else {
                        linkStatsText.textContent = ifaceMbit.toFixed(1) + ' Mbit/s' +
                            (tcDiagText ? ' (' + tcDiagText + ')' : ' (configured SQM bandwidth not found)') + sourceTxt;
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
                    refs.classes[cls].totalPct.textContent = 'total: ' + tPct + '%';

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

            return { el: panelEl, update: update, clearPinned: clearPinned };
        }

        function slotHue(name) {
            var h = 7;
            for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
            return h;
        }

        function makeSlotView(top, noun, labelOf, otherLabelOf, detailsOf, detailTitle) {
            var slots = [];
            for (var i = 0; i <= top; i++) slots.push('s' + i);
            slots.push(UN_SLOT);
            var emptyMeta = { label: '', color: 'hsl(0,0%,70%)' };
            var v = { rate: { 'in': {}, 'out': {} }, order: { 'in': [], 'out': [] } };
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

            v.render = function(items, ifaceRate, sqmDownKbit, sqmUpKbit, iface, baselineLabel, rateInfo) {
                var link = ifaceRate || { rx: null, tx: null };
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
                            res.meta[d][sl] = { label: labelOf(name, items[name]), color: 'hsl(' + slotHue(name) + ',58%,46%)', details: detailsOf ? detailsOf(items[name]) : null, detailTitle: detailTitle };
                        res[d].bytes[sl] += items[name][d + '_bytes'] || 0;
                        res[d].packets[sl] += items[name][d + '_packets'] || 0;
                        res[d].rate[sl] += v.rate[d][name] || 0;
                    });
                    if (names.length > top)
                        res.meta[d][slots[top]] = { label: otherLabelOf(names.length - top), color: 'hsl(210,8%,62%)' };
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
                                ? _('Not attributed (uncertain - counter sync jitter, not necessarily real traffic)')
                                : _('Not attributed (not counted by conntrack)');
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
            function(e) { return (e.top && e.top.length) ? e.top : null; }, _('Top destinations'));
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
                if ((e.via_in || 0) + (e.via_out || 0) > 0)
                    t.push([ _('via router services (proxy, DNS, LuCI ...) - LAN side, not WAN'), e.via_in || 0, e.via_out || 0 ]);
                return t.length ? t : null;
            }, _('Top applications'));
        var hostsView = makeSlotView(MAX_ROWS - 1, _('Destinations'),
            function(name, e) { return (name === '(other)' && e && e.count) ? _('Other (%d destinations)').format(e.count) : name; },
            function(n) { return _('Other (%d destinations)').format(n); },
            function(e) { return (e.top && e.top.length) ? e.top : null; }, _('Top devices'));
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
                    row.cells[1].textContent = f.app; row.cells[1].title = f.app;
                    row.cells[2].textContent = dest; row.cells[2].title = f.dst + (f.host ? ' - ' + f.host : '');
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
            var v = { active: false, loadedAt: 0, persist: null, hasShaper: false, sqm: { down: 0, up: 0 } };
            var RANGES = [
                { id: '24h',  label: _('24 hours'), tier: '5m', span: 86400 },
                { id: '7d',   label: _('Week'),     tier: '1h', span: 7 * 86400 },
                { id: '30d',  label: _('Month'),    tier: '1h', span: 30 * 86400 },
                { id: '365d', label: _('Year'),     tier: '1d', span: 365 * 86400 }
            ];
            var REFRESH_MS = { '5m': 60000, '1h': 300000, '1d': 900000 };
            var TIER_SEC = { '5m': 300, '1h': 3600, '1d': 86400 };
            var TIER_ORDER = [ '5m', '1h', '1d' ];   // finest first
            var st = { dim: 'a', dir: 'both', range: '24h', data: {}, cmp: false, hidden: {} };
            var historyPinned = null;

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
            var rangeBtns = [], dimBtns = [], dirBtns = [];
            var cmpBtn = E('button', { type: 'button', style: btnStyle }, _('Compare'));
            cmpBtn.addEventListener('click', function(e) { e.stopPropagation(); st.cmp = !st.cmp; mark(); render(); if (st.cmp) v.load(); });
            cmpBtn.title = _('Dashed line: the same length of time before the shown period');
            function rangeDef() {
                for (var i = 0; i < RANGES.length; i++) if (RANGES[i].id === st.range) return RANGES[i];
                return RANGES[0];
            }
            function mark() {
                rangeBtns.forEach(function(b, i) { b.className = 'btn cbi-button' + (st.range === rangeDefs[i][0] ? ' cbi-button-apply' : ''); });
                dimBtns.forEach(function(b, i) { b.className = 'btn cbi-button' + (st.dim === dimDefs[i][0] ? ' cbi-button-apply' : ''); });
                dirBtns.forEach(function(b, i) { b.className = 'btn cbi-button' + (st.dir === dirDefs[i][0] ? ' cbi-button-apply' : ''); });
                cmpBtn.className = 'btn cbi-button' + (st.cmp ? ' cbi-button-apply' : '');
            }
            rangeDefs.forEach(function(d) {
                var b = E('button', { type: 'button', style: btnStyle }, d[1]);
                b.addEventListener('click', function(e) { e.stopPropagation(); st.range = d[0]; mark(); render(); v.load(); });
                rangeBtns.push(b);
            });
            dimDefs.forEach(function(d) {
                var b = E('button', { type: 'button', style: btnStyle }, d[1]);
                b.addEventListener('click', function(e) { e.stopPropagation(); st.dim = d[0]; st.data = {}; mark(); render(); v.load(); });
                dimBtns.push(b);
            });
            dirDefs.forEach(function(d) {
                var b = E('button', { type: 'button', style: btnStyle }, d[1]);
                b.addEventListener('click', function(e) { e.stopPropagation(); st.dir = d[0]; mark(); render(); });
                dirBtns.push(b);
            });

            var resetBtn = E('button', { type: 'button', style: btnStyle + 'margin-left:18px; color:var(--qos-danger);' }, _('Clear history'));
            if (!canReset) resetBtn.style.display = 'none';
            resetBtn.title = _('Resets the cumulative application/device/destination totals and the stored history, without restarting the service. Buckets already written to a storage path (if configured) are kept.');
            resetBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (!window.confirm(_('Clear all cumulative totals and history? This cannot be undone from here (buckets already saved to a storage path, if any, are kept).')))
                    return;
                resetBtn.disabled = true;
                callResetHistory().then(function() {
                    st.data = {};
                    render();
                    v.load();
                }).catch(function() {}).then(function() { resetBtn.disabled = false; });
            });

            v.el = E('div', { style: 'width:100%; display:none;' }, [
                E('div', { style: 'display:flex; gap:24px; flex-wrap:wrap; justify-content:center; align-items:center; margin-bottom:10px;' }, [
                    E('div', {}, rangeBtns), E('div', {}, dimBtns), E('div', {}, dirBtns.concat([ cmpBtn ])), resetBtn ]),
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
                    if (t.state === 'ok')
                        out.push(_('Saved to %s (last write: %s%s).').format(t.dir, t.saved ? new Date(t.saved * 1000).toLocaleString() : _('not yet'), pend));
                    else if (t.state === 'err')
                        out.push(_('Writing to %s failed - retrying%s.').format(t.dir, pend));
                    else
                        out.push(_('%s is not available (yet) - it gets everything it missed as soon as it is back%s.').format(t.dir, pend));
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
                    var wStart = Math.max(startCal, first);
                    var selCal = B.filter(function(b) { return b.t > wStart && b.t - (b.dt || 0) < latest; });
                    if (!selCal.length) selCal = [ B[B.length - 1] ];
                    return { end: latest, start: wStart, sel: selCal, axisDays: true, axisRange: R.id, dataEnd: latest };
                }

                var end = latest;
                var start = Math.max(end - R.span, first);
                var sel = B.filter(function(b) { return b.t - (b.dt || 0) > start; });
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
                // shaper columns only when a shaper exists (otherwise they would just show 0 / -)
                if (v.hasShaper) {
                    head.appendChild(E('th', { 'class': 'th', style: num }, _('Shaper drops')));
                    head.appendChild(E('th', { 'class': 'th', style: num }, _('ECN marks')));
                    head.appendChild(E('th', { 'class': 'th', style: num, title: _('Highest momentary queue backlog seen at a poll; in brackets the time the shaper needs to drain it at the configured rate') }, _('Peak backlog')));
                }
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
                    if (v.hasShaper) {
                        row.appendChild(E('td', { 'class': 'td', style: num }, formatCount(x.drops)));
                        row.appendChild(E('td', { 'class': 'td', style: num }, formatCount(x.ecn)));
                        row.appendChild(E('td', { 'class': 'td', style: num }, x.bl > 0 ? backlogTxt(x.bl, link / 1000) : '-'));
                    }
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
                var R = rangeDef(), B = st.data[R.tier];
                var errored = st.err && st.err[R.tier];
                if (!B) {
                    if (errored) {
                        chartHost.appendChild(E('div', { style: 'text-align:center; color:var(--qos-danger); padding:30px 0;' },
                            _('History could not be loaded (request to the aggregator failed). Retrying automatically.')));
                    } else {
                        chartHost.appendChild(E('div', { style: 'text-align:center; color:var(--qos-text-muted); padding:30px 0;' }, _('Loading...')));
                    }
                    return;
                }
                if (errored) {
                    chartHost.appendChild(E('div', { style: 'text-align:center; color:var(--qos-danger); font-size:11px; padding:4px 0;' },
                        _('The last refresh of this history failed - showing the most recently loaded data, which may be outdated. Retrying automatically.')));
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
                for (var ci0 = 0; ci0 < ncols; ci0++) cols.push({ dt: 0, src: {}, drop: { rx: 0, tx: 0 }, ecn: { rx: 0, tx: 0 }, bl: { rx: 0, tx: 0 } });
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

                var totals = {}, names = {};
                sel.forEach(function(b) {
                    var src = b[st.dim] || {};
                    Object.keys(src).forEach(function(k) {
                        totals[k] = (totals[k] || 0) + val(src[k]);
                        if (st.dim === 'd' && src[k][2]) names[k] = src[k][2];
                    });
                });
                var keys = Object.keys(totals).sort(function(a, b) { return totals[b] - totals[a]; });
                var TOP = 8, shown = keys.slice(0, TOP), rest = keys.slice(TOP);
                var hiddenSet = st.hidden[st.dim] || (st.hidden[st.dim] = {});
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
                    var rows = Object.keys(c.src).map(function(k) {
                        return [ st.dim === 'd' ? (names[k] || k) : k, c.src[k][0] || 0, c.src[k][1] || 0, c.src[k][di] || 0 ];
                    }).filter(function(r) { return r[3] > 0; }).sort(function(a, b) { return b[3] - a[3]; }).slice(0, 5).map(function(r) { return [ r[0], r[1], r[2] ]; });
                    return {
                        label: stampLabel(t0 + ci * colw, R.span) + ' - ' + stampLabel(t0 + (ci + 1) * colw, R.span),
                        sub: _('%.2f drops/s, %.2f ECN marks/s (%s)').format(rate, ecnRate, d === 'in' ? _('download shaper') : _('upload shaper')) +
                            ((d === 'in' ? c.bl.rx : c.bl.tx) > 0 ? ' - ' + _('peak backlog %s').format(backlogTxt(d === 'in' ? c.bl.rx : c.bl.tx, d === 'in' ? v.sqm.down : v.sqm.up)) : ''),
                        color: '#ef4444',
                        details: rows.length ? rows : [ [ _('no traffic recorded'), 0, 0 ] ],
                        detailTitle: dimLabel()
                    };
                }

                function historyTip(c, ci, k, vv, d) {
                    var timeStr = stampLabel(t0 + ci * colw, R.span) + ' - ' + stampLabel(t0 + (ci + 1) * colw, R.span);
                    var name = k === '__rest' ? _('Other (%d)').format(rest.length) : (st.dim === 'd' ? (names[k] || k) : k);
                    var colColor = k === '__rest' ? 'hsl(210,8%,62%)' : colorOf(k);

                    var details = [];
                    if (c && c.src) {
                        Object.keys(c.src).forEach(function(key) {
                            if (k === '__rest' && shown.indexOf(key) >= 0) return;
                            var entryName = st.dim === 'd' ? (names[key] || key) : key;
                            details.push([ entryName, c.src[key][0] || 0, c.src[key][1] || 0 ]);
                        });
                        details.sort(function(a, b) {
                            return ((b[1] + b[2]) - (a[1] + a[2]));
                        });
                    }

                    return {
                        label: timeStr,
                        sub: name + (dirs.length > 1 ? ' (' + (d === 'in' ? _('Download') : _('Upload')) + ')' : '') + ' \u2022 ' + formatRate(vv * 1e6),
                        color: colColor,
                        detailTitle: dimLabel(),
                        details: details.slice(0, 8)
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
                        if (i % step !== 0 || x.px < Math.min(need, fullPx) * 0.8) return;
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
                    return el;
                }
                shown.forEach(function(k) {
                    var name = st.dim === 'd' ? (names[k] || k) : k;
                    legend.appendChild(legendItem(k, colorOf(k), name + ' (' + formatBytes(totals[k]) + ')'));
                });
                if (rest.length) legend.appendChild(legendItem('__rest', 'hsl(210,8%,62%)', _('Other (%d)').format(rest.length)));
                if (st.cmp && !prevAny) legend.appendChild(E('span', { style: 'opacity:0.7;' }, _('Previous period: no data stored yet')));
                if (drawPrev) legend.appendChild(E('span', {}, [
                    E('span', { style: 'display:inline-block; width:16px; margin-right:5px; vertical-align:middle; border-top:2px dashed var(--qos-text-strong);' }), _('Previous period') ]));
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
            v.stale = function() { return Date.now() - v.loadedAt > REFRESH_MS[rangeDef().tier]; };
            v.clearPinned = function() {
                historyPinned = null;
                tipHide();
            };
            v.load = function() {
                var tier = rangeDef().tier, tiers = [ tier ];
                if (st.cmp) tiers = tiers.concat(TIER_ORDER.slice(TIER_ORDER.indexOf(tier) + 1));
                v.loadedAt = Date.now();
                if (!st.err) st.err = {};
                return Promise.all(tiers.map(function(t) {
                    return callHistory(1, t, st.dim).then(function(d) {
                        st.data[t] = (d && d.buckets) ? d.buckets : [];
                        st.err[t] = false;
                    }).catch(function() {
                        // keep whatever data is already there and set an explicit per-tier error
                        // flag, so render() can say "history unavailable" instead of showing
                        // nothing (or possibly outdated data) without any indication
                        st.err[t] = true;
                    });
                })).then(render);
            };
            mark();
            render();
            v.setPersist(null);
            return v;
        }

        var flowsView = makeFlowsView();
        var histView = makeHistoryView();

        var shaperEl = E('div', { style: 'font-size:11.5px; color:var(--qos-text-strong); margin:0 0 12px; line-height:18px; font-variant-numeric: tabular-nums; height:40px; min-height:40px; max-height:40px; box-sizing:border-box; overflow:hidden;' });

        // Per-WAN breakdown: the main link line above sums all shaped WAN devices into one rate and
        // one configured-rate figure, which hides very asymmetric multi-WAN setups. data.wan has one
        // entry per WAN when there is more than one; it stays empty and hidden for a single WAN.
        var wanEl = E('div', { style: 'display:none; font-size:11px; color:var(--qos-text-muted); margin:0 0 10px; line-height:1.5; font-variant-numeric: tabular-nums; text-align:center;' });
        var prevWan = {};
        function wanUpdate(wan, dt) {
            while (wanEl.firstChild) wanEl.removeChild(wanEl.firstChild);
            if (!wan || wan.length < 2) { wanEl.style.display = 'none'; return; }
            wanEl.style.display = '';
            wan.forEach(function(w, i) {
                var prev = prevWan[w.iface];
                var rxBps = (prev && dt > 0) ? Math.max(0, (w.rx_bytes - prev.rx_bytes) / dt) : null;
                var txBps = (prev && dt > 0) ? Math.max(0, (w.tx_bytes - prev.tx_bytes) / dt) : null;
                var downMbit = (w.download_kbit || 0) / 1000, upMbit = (w.upload_kbit || 0) / 1000;
                var txt = w.iface + ': ';
                txt += (rxBps !== null ? formatRate(rxBps * 8) : '?') + (downMbit > 0 ? ' / ' + downMbit.toFixed(0) + ' Mbit/s' : '') + ' \u2193, ';
                txt += (txBps !== null ? formatRate(txBps * 8) : '?') + (upMbit > 0 ? ' / ' + upMbit.toFixed(0) + ' Mbit/s' : '') + ' \u2191';
                if (i > 0) wanEl.appendChild(document.createTextNode('  \u2022  '));
                wanEl.appendChild(E('span', {}, txt));
                prevWan[w.iface] = { rx_bytes: w.rx_bytes, tx_bytes: w.tx_bytes };
            });
        }
        var prevShaper = { rx: null, tx: null };
        var LIVE_DROP_LEN = 60;
        var liveDropHist = { rx: { d: [], e: [], scale: 0 }, tx: { d: [], e: [], scale: 0 } };
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

        function shaperUpdate(sh, dt) {
            while (shaperEl.firstChild) shaperEl.removeChild(shaperEl.firstChild);
            [ ['rx', _('Download shaper')], ['tx', _('Upload shaper')] ].forEach(function(def) {
                var cur = sh && sh[def[0]], prev = prevShaper[def[0]];
                if (!cur || cur.sent === undefined) return;
                var dr = prev ? Math.max(0, (cur.dropped || 0) - (prev.dropped || 0)) / dt : 0;
                var er = prev ? Math.max(0, (cur.ecn || 0) - (prev.ecn || 0)) / dt : 0;
                var pct = cur.pkts > 0 ? (cur.dropped / cur.pkts * 100) : 0;

                var hist = liveDropHist[def[0]];
                hist.d.push(dr); hist.e.push(er);
                if (hist.d.length > LIVE_DROP_LEN) { hist.d.shift(); hist.e.shift(); }

                var instMax = 0;
                for (var hi = 0; hi < hist.d.length; hi++) instMax = Math.max(instMax, (hist.d[hi] || 0) + (hist.e[hi] || 0));
                hist.scale = Math.max(instMax, hist.scale * 0.9);
                var drawMax = hist.scale > 0 ? hist.scale : 0.0001;

                var prefix = def[1] + ' (' + (cur.rate || '?') + ', target ' + (cur.target || '?') + ', limit ' + (cur.limit || '?') + '): ' + _('drops') + ' ' + dr.toFixed(1) + '/s';
                var suffix = '(' + formatCount(cur.dropped || 0) + ' ' + _('total') + ', ' + pct.toFixed(3) + ' %) · ECN ' + er.toFixed(1) + '/s (' + formatCount(cur.ecn || 0) + ') · ' +
                    _('backlog') + ' ' + formatBytes(cur.backlog_b || 0) + ' / ' + (cur.backlog_p || 0) + ' pkt · ' +
                    _('limit hits') + ' ' + (cur.drop_overlimit || 0) + ' · ' + _('active flows') + ' ' + ((cur.flows_new || 0) + (cur.flows_old || 0));

                var spark = liveSparkline(hist.d, hist.e, drawMax); spark.style.flex = '0 0 auto'; spark.style.display = 'inline-block';
                spark.setAttribute('title', _('Recent drop rate (red) / ECN rate (amber), roughly the last %d polls.').format(LIVE_DROP_LEN));

                var lineEl = E('div', {
                    style: 'display:flex; align-items:center; flex-wrap:nowrap; gap:5px; margin-bottom:2px; height:18px; min-height:18px; max-height:18px; overflow:hidden; white-space:nowrap;',
                    title: _('Drops are normal codel behaviour under load. "Limit hits" > 0 mean the queue limit was exceeded (limit too small for the link speed).')
                }, [ prefix, spark, suffix ]);
                if ((cur.drop_overlimit || 0) > 0 && prev && cur.drop_overlimit > (prev.drop_overlimit || 0)) lineEl.style.color = 'var(--qos-danger)';

                shaperEl.appendChild(lineEl);
            });
            ['rx', 'tx'].forEach(function(d) { prevShaper[d] = (sh && sh[d] && sh[d].sent !== undefined) ? sh[d] : null; });
            // no shaper -> no health line at all (instead of an empty reserved box)
            shaperEl.style.display = shaperEl.firstChild ? '' : 'none';
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

        var container = E('div', {
            id: 'qos_container',
            style: 'background: var(--qos-surface); border: 1px solid var(--qos-text-muted); border-radius: .50em; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3); padding:28px 32px; max-width:1700px; margin:0 auto;'
        }, [ statusEl, restartBtn, staleEl ]);

        container.addEventListener('click', function(e) {
            if (e.target.closest && e.target.closest('.qos-seg, .qos-legend-row')) return;
            slotViews.forEach(function(sv) { sv.panelIn.clearPinned(); sv.panelOut.clearPinned(); });
        });

        var m = E('div', { class: 'cbi-map' }, [
            E('h2', {}, _('Live Traffic Chart')),
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
            var groups = [ appPanels, devPanels, hostPanels, flowsView.el, histView.el ];
            var tabDefs = [ ['qos_tab_apps', _('Applications')], ['qos_tab_devices', _('Devices')],
                            ['qos_tab_hosts', _('Destinations')], ['qos_tab_flows', _('Live flows')], ['qos_tab_history', _('History')] ];
            var tabBtns = [];
            function selectTab(idx) {
                tipHide();
                histView.clearPinned();
                slotViews.forEach(function(sv) { sv.panelIn.clearPinned(); sv.panelOut.clearPinned(); });
                groups.forEach(function(g, i) { g.style.display = (i === idx) ? '' : 'none'; });
                tabBtns.forEach(function(li, i) { li.className = (i === idx) ? 'cbi-tab' : 'cbi-tab-disabled'; });
                activeTab = idx;
                renderTab(idx);
                histView.active = (idx === 4);
                if (idx === 4) histView.load();
                if (btnJson) exportTitles();
            }
            function exportTitles() {
                var h = histView.active;
                btnJson.title = h ? _('Export the shown history range (all buckets, applications, devices and destinations) as JSON') : _('Export the current live data as JSON');
                btnCsv.title = h ? _('Export the shown history range (all buckets, applications, devices and destinations) as CSV') : _('Export the current live data as CSV');
            }
            tabDefs.forEach(function(d, i) {
                var a = E('a', { href: '#', id: d[0] }, d[1]);
                a.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); selectTab(i); });
                tabBtns.push(E('li', {}, a));
            });
            selectTab(0);
            var tabs = E('ul', { class: 'cbi-tabmenu', style: 'flex:1 1 auto;' }, tabBtns);
            var btnJson = E('button', { type: 'button', class: 'btn cbi-button', id: 'qos_export_json' }, _('Export JSON'));
            var btnCsv = E('button', { type: 'button', class: 'btn cbi-button', id: 'qos_export_csv' }, _('Export CSV'));
            btnJson.addEventListener('click', function(e) { e.stopPropagation(); if (histView.active) histView.exportJson(); else exportJson(); });
            btnCsv.addEventListener('click', function(e) { e.stopPropagation(); if (histView.active) histView.exportCsv(); else exportCsv(); });
            exportTitles();
            var toolbar = E('div', { style: 'display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap;' }, [
                tabs, E('div', { style: 'display:flex; gap:6px; margin-bottom:1em;' }, [ btnJson, btnCsv ]) ]);

            var hintText = _('* Note: rates are the mean of the last %d s, measured by the trafficchart-agg daemon on its own clock (bytes per application, device and destination from /proc/net/nf_conntrack, application names from netifyd). The link rate comes from the tc qdisc counters read in the same instant. "Not attributed" is what the shaper carries but conntrack does not count (after subtracting the link layer header): e.g. traffic to router services, dropped inbound packets, multicast.').format((data && data.rate && data.rate.win) || 0);
            if (data && data.backend === 'nss')
                hintText += ' ' + _('NSS hardware offload bypasses nftables for accelerated flows; conntrack byte counters keep advancing under offload, which is why they are used.');
            var hintEl = E('div', {
                style: 'margin-top: 40px; margin-left: 40px; margin-right: 40px; font-size: 11px; color: var(--qos-text-muted);'
            }, hintText);

            container.appendChild(staleEl);
            container.appendChild(wanEl);
            container.appendChild(shaperEl);
            container.appendChild(toolbar);
            container.appendChild(appPanels);
            container.appendChild(devPanels);
            container.appendChild(hostPanels);
            container.appendChild(flowsView.el);
            container.appendChild(histView.el);
            container.appendChild(hintEl);
            chartMounted = true;
        }

        var lastTime = Date.now();
        var lastSrvUp = null;
        var haveRenderedOnce = false;
        var lastSuccessTime = Date.now();
        var consecutiveFailures = 0;

        function updateStaleIndicator() {
            if (!haveRenderedOnce) return;
            if (consecutiveFailures === 0) {
                staleEl.style.display = 'none';
                restartBtn.style.display = 'none';
                return;
            }
            var secsAgo = Math.round((Date.now() - lastSuccessTime) / 1000);
            var textEl = document.getElementById('qos_stale_text');
            if (textEl) textEl.textContent = _('⚠ No update for %ds (last successful read: %s) - retrying automatically...')
                .format(secsAgo, new Date(lastSuccessTime).toLocaleTimeString());
            staleEl.style.display = 'block';
            restartBtn.style.display = canRestart ? '' : 'none';
        }

        var baselineTime = null;
        function baselineLabelText() {
            return baselineTime ? (_('since %s').format(baselineTime.toLocaleString())) : _('since start');
        }
        var pollInFlight = false;
        var pollRequestId = 0;
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

            var hardTimer = setTimeout(function() {
                if (pollRequestId === myPollId) { pollRequestId++; pollInFlight = false; }
            }, POLL_HARD_TIMEOUT);

            return callTrafficStats().then(function(data) {
                clearTimeout(hardTimer);
                var stale = (pollRequestId !== myPollId);
                pollInFlight = false;
                if (stale) return;   // superseded by the hard-timeout fallback above
                if (!document.getElementById('qos_container')) return;

                if (data.error || !data.apps || !data.rate) {
                    consecutiveFailures++;
                    if (!haveRenderedOnce) {
                        statusEl.style.color = 'red';
                        statusEl.textContent = data && data.error
                            ? _('Error: %s').format(data.error)
                            : _('Error: No data received. Is the trafficchart service running (/etc/init.d/trafficchart start)?');
                        restartBtn.style.display = canRestart ? '' : 'none';
                    } else {
                        updateStaleIndicator();
                    }
                    return;
                }

                var now = Date.now();
                var dt = (now - lastTime) / 1000;
                if (dt <= 0) dt = 1;

                var srvUp = (typeof data.up === 'number') ? data.up : null;
                if (haveRenderedOnce && srvUp !== null && lastSrvUp !== null && srvUp <= lastSrvUp && lastSrvUp - srvUp < 30) {
                    lastSuccessTime = Date.now();
                    consecutiveFailures = 0;
                    updateStaleIndicator();
                    return;
                }

                var sqmDownloadKbit = data.sqm ? (data.sqm.download_kbit || 0) : 0;
                var sqmUploadKbit = data.sqm ? (data.sqm.upload_kbit || 0) : 0;

                lastTime = now;
                lastSrvUp = srvUp;
                if (!baselineTime) baselineTime = (data.since ? new Date(data.since * 1000) : new Date(now));

                lastSuccessTime = Date.now();
                consecutiveFailures = 0;
                updateStaleIndicator();

                flowsView.update(data.top_flows || [], sqmDownloadKbit, sqmUploadKbit);
                shaperUpdate(data.shaper, dt);
                wanUpdate(data.wan, dt);
                lastData = data;
                tcDiagText = data.tc_diag || '';
                histView.setPersist(data.persist || null);
                histView.setSqm(sqmDownloadKbit, sqmUploadKbit);
                histView.setShaper(!!(data.shaper && ((data.shaper.rx && data.shaper.rx.sent !== undefined) || (data.shaper.tx && data.shaper.tx.sent !== undefined))));

                mountChartOnce(data);

                renderTab(activeTab);

                haveRenderedOnce = true;
                adaptPoll(data);
            }).catch(function(err) {
                clearTimeout(hardTimer);
                var stale = (pollRequestId !== myPollId);
                pollInFlight = false;
                if (!stale) {
                    consecutiveFailures++;
                    if (haveRenderedOnce) updateStaleIndicator();
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

