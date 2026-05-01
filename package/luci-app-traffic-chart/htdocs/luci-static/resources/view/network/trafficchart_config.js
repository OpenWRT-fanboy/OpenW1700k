'use strict';
'require view';
'require form';
'require rpc';
'require ui';
'require uci';

return view.extend({
    render: function() {
        var m, s, o;
        var domainUpdateNotice = null;
        var domainStatusTimer = null;
        var manualUpdateInProgress = false;
        var updateDomains = rpc.declare({ object: 'luci.trafficchart', method: 'update_domains', expect: { '': {} } });
        var getDomainStatus = rpc.declare({ object: 'luci.trafficchart', method: 'get_domain_status', expect: { '': {} } });
        var getDomainGroups = rpc.declare({ object: 'luci.trafficchart', method: 'get_domain_groups', expect: { '': {} } });

        // Load the groups from the currently installed v2fly database before building
        // the form, so the selector always reflects the real list on this router.
        // Older configs kept the storage paths in "option persist_dir" (all resolutions): turn them into rows
        function migrateLegacyPersist() {
            var old = uci.get('trafficchart', 'global', 'persist_dir');
            if (!old) return;
            String(old).trim().split(/\s+/).forEach(function(p) {
                if (!p) return;
                var sid = uci.add('trafficchart', 'persist_target');
                uci.set('trafficchart', sid, 'path', p);
                uci.set('trafficchart', sid, 'tier_5m', '1');
                uci.set('trafficchart', sid, 'tier_1h', '1');
                uci.set('trafficchart', sid, 'tier_1d', '1');
            });
            uci.unset('trafficchart', 'global', 'persist_dir');
        }

        return uci.load('trafficchart').then(migrateLegacyPersist).catch(function() {}).then(function() {
            return getDomainGroups().catch(function() { return { groups: [], available: false }; });
        }).then(function(groupData) {
        m = new form.Map('trafficchart', _('Traffic Chart Settings'),
            _('Settings for the traffic-chart aggregator (trafficchart-agg). ' +
              'Saving restarts the aggregator (cumulative totals reset, the history survives).'));

        s = m.section(form.NamedSection, 'global', 'trafficchart', _('General'));

        o = s.option(form.Flag, 'enabled', _('Enable'), _('Disable to stop the aggregator entirely.'));
        o.default = '1';
        o.rmempty = false;

        o = s.option(form.Flag, 'apps', _('Application names'), _('Run trafficchart-apps (netifyd) to label flows by application. Needs socat + netifyd. Without it flows are named by protocol and port.'));
        o.default = '1';
        o.depends('enabled', '1');

        o = s.option(form.Flag, 'dns_names', _('DNS domain names'), _('Watch clear-text DNS on the configured LAN interface with tcpdump. This works independently of netifyd and supplies domain/application names as a fallback.'));
        o.default = '1';
        o.depends('enabled', '1');

        o = s.option(form.MultiValue, 'alert_groups', _('V2Fly warning groups'),
            _('Select one or more groups from the installed v2fly database. A red warning is shown when a domain belongs to any selected group. Select “No warning groups” to disable these warnings (it overrides any group selections). Update the service database below to refresh this list.'));
        o.rmempty = true;
        o.multiple = true;
        o.size = 8;
        o.default = ['category-porn'];
        var groupNames = groupData && Array.isArray(groupData.groups) ? groupData.groups : [];
        groupNames = groupNames.filter(function(group, index, all) { return all.indexOf(group) === index; }).sort();
        groupNames.forEach(function(group) {
            var label = group.replace(/^category-/, '').replace(/-/g, ' ');
            label = label.replace(/\b\w/g, function(c) { return c.toUpperCase(); });
            o.value(group, label);
        });
        if (!groupNames.length) {
            o.value('category-porn', _('Pornography — fallback; update database to load available groups'));
            o.description = _('The group list is not available yet. Run “Update now” below to download the v2fly database and populate this selector.');
        }
        o.value('none', _('No warning groups — disable group warnings'));

        o = s.option(form.Value, 'alert_keywords', _('Legacy warning keywords'),
            _('Optional application-name matches. Plain terms match anywhere (case-insensitive); use * for any text and ? for one character. Multiple terms can be separated by spaces or commas. V2Fly group warnings are configured above.'));
        o.placeholder = 'ads *ads ads* *ads*';
        o.default = '';
        o.rmempty = true;

        o = s.option(form.Flag, 'domain_auto_update', _('Automatic service-list update'),
            _('Download the current v2fly domain-list-community database in the background and rebuild the local service lookup. The router only keeps the compact lookup file.'));
        o.default = '1';
        o.depends('dns_names', '1');

        o = s.option(form.Value, 'domain_update_days', _('Service-list refresh interval (days)'),
            _('How often the automatic v2fly list refresh is allowed. A manual update is always possible. Default: 7 days.'));
        o.datatype = 'uinteger';
        o.validate = function(section_id, value) {
            if (value == null || value === '') return true;
            if (!/^[1-9][0-9]*$/.test(value))
                return _('Enter a whole number of days (at least 1).');
            return Number(value) <= 3650 ? true : _('Use a refresh interval between 1 and 3650 days.');
        };
        o.placeholder = '7';
        o.depends('domain_auto_update', '1');

        o = s.option(form.Button, 'domain_update', _('Service database'),
            _('Download and compile the current v2fly/domain-list-community release now. The live DNS watcher continues using the previous list until the new file is complete.'));
        o.inputtitle = _('Update now');
        o.inputstyle = 'apply';
        o.onclick = function() {
            if (manualUpdateInProgress) {
                setDomainUpdateNotice(_('A service database update is already being monitored.'));
                return Promise.resolve();
            }
            manualUpdateInProgress = true;
            var statusEl = document.getElementById('trafficchart-domain-status');
            setDomainUpdateNotice(null);
            if (statusEl) {
                statusEl.innerHTML = '';
                statusEl.appendChild(E('div', { 'style': 'font-weight:bold;' }, _('Starting service database update…')));
            }
            // Establish a reliable baseline before launching the updater. Without it,
            // a fast completion after a transient status-RPC failure could be mistaken
            // for the old terminal status and the group selector would never refresh.
            function readBaseline(retries) {
                return getDomainStatus().catch(function(err) {
                    if (retries <= 0) throw err;
                    return new Promise(function(resolve) { setTimeout(resolve, 500); })
                        .then(function() { return readBaseline(retries - 1); });
                });
            }
            // A quick update can finish before the first 1-second poll observes RUNNING;
            // the saved baseline lets us recognize its new terminal status.
            return readBaseline(2).then(function(before) {
                var beforeSignature = [before.status, before.last_attempt, before.last_success, before.message, before.rules, before.changed].join('|');
                return updateDomains().then(function() {
                    var sawRunning = false;
                    var pollInFlight = false;
                    var statusReadError = false;
                    var startedAt = Date.now();
                    var warnedStart = false;
                    var warnedLong = false;
                    var timer = setInterval(function() {
                        if (!document.getElementById('trafficchart-domain-status')) {
                            clearInterval(timer);
                            manualUpdateInProgress = false;
                            return;
                        }
                        // Avoid overlapping RPC requests on a slow router. Otherwise responses
                        // may arrive out of order and a stale RUNNING/FAILED state can win.
                        if (pollInFlight) return;
                        pollInFlight = true;
                        var elapsed = Math.floor((Date.now() - startedAt) / 1000);
                        pollDomainStatus().then(function(st) {
                            if (statusReadError) {
                                statusReadError = false;
                                setDomainUpdateNotice(null);
                            }
                            if (st && st.status === 'RUNNING') sawRunning = true;
                            var signature = st ? [st.status, st.last_attempt, st.last_success, st.message, st.rules, st.changed].join('|') : null;
                            var changedFromBefore = beforeSignature !== null && signature !== beforeSignature;
                            var finished = st && st.status !== 'RUNNING' && (sawRunning || changedFromBefore);
                            if (finished) {
                                clearInterval(timer);
                                manualUpdateInProgress = false;
                                setDomainUpdateNotice(null);
                                if (st.status === 'OK') {
                                    refreshDomainGroupOptions().then(function(refreshed) {
                                        if (!refreshed) setDomainUpdateNotice(_('The update succeeded, but the group list could not be loaded. Reload this page to refresh the selector.'));
                                    });
                                }
                            } else {
                                if (elapsed >= 10 && !sawRunning && !warnedStart) {
                                    warnedStart = true;
                                    setDomainUpdateNotice(_('No new update state appeared yet. Status checks will continue; the updater may be starting or already running.'));
                                }
                                if (elapsed >= 120 && !warnedLong) {
                                    warnedLong = true;
                                    setDomainUpdateNotice(_('The update is taking longer than 120 seconds. Status checks will continue; the updater may still be running.'));
                                }
                                if (elapsed >= 1200) {
                                    clearInterval(timer);
                                    manualUpdateInProgress = false;
                                    setDomainUpdateNotice(_('No final update status was received after 20 minutes. The updater may still be running; reload this page to check its status.'));
                                }
                            }
                        }).catch(function(err) {
                            // A transient status RPC failure must not permanently stop the
                            // observer: the updater can still finish and publish a new group list.
                            statusReadError = true;
                            var detail = err && err.message ? err.message : err;
                            if (elapsed >= 1200) {
                                clearInterval(timer);
                                manualUpdateInProgress = false;
                                setDomainUpdateNotice(_('No final update status was received after 20 minutes. Last status error: ') + detail);
                            } else {
                                setDomainUpdateNotice(_('Could not read update status; retrying: ') + detail);
                            }
                        }).then(function() {
                            pollInFlight = false;
                        });
                    }, 1000);
                    // The 1-second timer owns status polling during the update. The normal
                    // 5-second status timer is suspended to avoid out-of-order DOM updates.
                    return true;
                });
            }).catch(function(err) {
                manualUpdateInProgress = false;
                var el = document.getElementById('trafficchart-domain-status');
                if (el) {
                    el.innerHTML = '';
                    el.appendChild(E('div', { 'style': 'font-weight:bold;' }, _('ERROR: ') + (err && err.message ? err.message : err)));
                }
            });
        };

        // The update status is shown inside the field of the update button (directly below it),
        // not as a separate option row.
        var renderUpdateButton = o.render;
        o.render = function() {
            return Promise.resolve(renderUpdateButton.apply(this, arguments)).then(function(node) {
                var field = node && node.querySelector ? node.querySelector('.cbi-value-field') : null;
                if (!field) return node;
                var status = E('div', { 'id': 'trafficchart-domain-status', 'style': 'margin-top:0.5em; padding:0.6em 0.8em; border:1px solid var(--border-color-medium); border-radius:4px; max-width:48em;' }, _('Loading…'));
                var desc = field.querySelector('.cbi-value-description');
                if (desc) field.insertBefore(status, desc); else field.appendChild(status);
                return node;
            });
        };

        function fmtTime(v) {
            return v || _('Never');
        }
        function refreshDomainGroupOptions() {
            return getDomainGroups().then(function(data) {
                var groups = data && Array.isArray(data.groups) ? data.groups : [];
                groups = groups.filter(function(group, index, all) { return all.indexOf(group) === index; }).sort();
                if (!groups.length) return false;
                var selects = document.querySelectorAll('select[name$=".alert_groups"]');
                for (var i = 0; i < selects.length; i++) {
                    var select = selects[i];
                    var selected = {};
                    for (var j = 0; j < select.options.length; j++)
                        if (select.options[j].selected) selected[select.options[j].value] = true;
                    while (select.options.length) select.remove(0);
                    groups.forEach(function(group) {
                        var label = group.replace(/^category-/, '').replace(/-/g, ' ')
                            .replace(/\b\w/g, function(c) { return c.toUpperCase(); });
                        var option = new Option(label, group);
                        option.selected = !!selected[group];
                        select.add(option);
                    });
                    // Keep the explicit opt-out available when the live group list is refreshed.
                    var disabledOption = new Option(_('No warning groups — disable group warnings'), 'none');
                    disabledOption.selected = !!selected.none;
                    select.add(disabledOption);
                    if (window.jQuery) window.jQuery(select).trigger('change');
                }
                var statusEl = document.getElementById('trafficchart-domain-status');
                if (statusEl) {
                    var note = E('div', { 'style': 'margin-top:0.35em;' }, _('Loaded ') + groups.length + _(' available V2Fly groups. The selector has been refreshed.'));
                    statusEl.appendChild(note);
                }
                return true;
            }).catch(function() { return false; });
        }

        function setDomainUpdateNotice(message) {
            domainUpdateNotice = message || null;
            var el = document.getElementById('trafficchart-domain-status');
            if (!el) return;
            var notes = el.querySelectorAll('.trafficchart-domain-update-notice');
            for (var i = 0; i < notes.length; i++) notes[i].remove();
            if (domainUpdateNotice) {
                el.appendChild(E('div', { 'class': 'trafficchart-domain-update-notice', 'style': 'margin-top:0.35em;' }, domainUpdateNotice));
            }
        }

        function pollDomainStatus() {
            return getDomainStatus().then(function(st) {
                var el = document.getElementById('trafficchart-domain-status');
                if (!el) return;
                var status = st && st.status ? st.status : 'NOT UPDATED';
                var ok = status === 'OK';
                var running = status === 'RUNNING';
                var cls = ok ? 'success' : (running ? 'warning' : 'danger');
                var changed = st && st.changed === 'yes' ? _('Yes') : _('No');
                var rules = Number(st && st.rules || 0);
                var previous = Number(st && st.previous_rules || 0);
                el.innerHTML = '';
                el.appendChild(E('div', { 'style': 'font-weight:bold; margin-bottom:0.35em;' }, [
                    E('span', { 'class': 'label ' + cls }, status),
                    ' ', st && st.message ? st.message : ''
                ]));
                el.appendChild(E('div', {}, _('Entries: ') + rules));
                el.appendChild(E('div', {}, _('Changed: ') + changed + (previous ? ' (' + previous + ' → ' + rules + ')' : '')));
                el.appendChild(E('div', {}, _('Last successful update: ') + fmtTime(st && st.last_success_text)));
                el.appendChild(E('div', {}, _('Last attempt: ') + fmtTime(st && st.last_attempt_text)));
                if (domainUpdateNotice) {
                    el.appendChild(E('div', { 'class': 'trafficchart-domain-update-notice', 'style': 'margin-top:0.35em;' }, domainUpdateNotice));
                }
                return st;
            }).catch(function(err) {
                var el = document.getElementById('trafficchart-domain-status');
                if (el && err) el.textContent = _('Could not read update status: ') + (err.message || err);
                throw err;
            });
        }

        o = s.option(form.Value, 'dns_iface', _('DNS capture interface'), _('Interface on which client DNS queries are observed. Usually br-lan when the router provides DNS to LAN clients.'));
        o.placeholder = 'br-lan';
        o.depends('dns_names', '1');
        o.validate = function(section_id, value) {
            return (value === null || value === '' || (value.length <= 15 && /^[A-Za-z0-9._-]+$/.test(value)))
                ? true : _('Use at most 15 interface characters: A-Z, 0-9, dot, underscore and hyphen.');
        };

        o = s.option(form.ListValue, 'backend', _('Shaper backend'),
            _('Auto selects NSS hardware offload if the nssifb device exists and the nss_ifb module is loaded, otherwise the generic reader.'));
        o.value('auto', _('Auto'));
        o.value('nss', _('NSS hardware offload'));
        o.value('generic', _('Generic (cake / htb+fq_codel / any other qdisc)'));
        o.default = 'auto';

        o = s.option(form.Value, 'interval', _('Poll interval'), _('Seconds between conntrack passes (default 4; stretches automatically under load).'));
        o.validate = function(section_id, value) { return validateInteger(section_id, value, 1, null, _('poll interval')); };
        o.placeholder = '4';

        o = s.option(form.Value, 'wan_dev', _('WAN device'),
            _('Empty = auto-detect (shaped devices are found in the kernel: ingress redirect to an ifb, or NSS nsstbl; otherwise the default route device). ' +
              'Set device names (e.g. eth1 pppoe-wan) or logical interfaces (wan), space separated, to override.'));
        o.placeholder = 'pppoe-wan';
        o.validate = function(section_id, value) {
            if (value === null || value.trim() === '') return true;
            return value.trim().split(/\s+/).every(function(w) {
                return /^[A-Za-z0-9._@-]+$/.test(w);
            }) ? true : _('Use device or logical interface names containing only A-Z, 0-9, dot, underscore, @ and hyphen.');
        };

        o = s.option(form.Value, 'rate_win', _('Rate averaging window'),
            _('Seconds over which the live rates are averaged (default 20, minimum 2 x poll interval). Shorter = the display follows load changes faster, but is more jittery. ' +
              'For the fastest display use poll interval 2 and a window of 4-6.'));
        o.validate = function(section_id, value) { return validateInteger(section_id, value, 1, null, _('rate averaging window')); };
        o.placeholder = '20';

        o = s.option(form.Flag, 'tooltips', _('Detailed tooltips'),
            _('Maintains the application x destination, destination x device and device x application tables that ' +
              'feed the "top destinations / devices / applications" tooltips of the live view. Costs CPU on every ' +
              'accounted flow delta. Disabling leaves the tooltips empty; totals and the History tab are not affected.'));
        o.default = '1';

        o = s.option(form.Value, 'l2_overhead', _('Link header size'),
            _('Bytes per packet the shaper counts but conntrack does not (used for "Not attributed"). "auto" measures it; ' +
              'or a fixed number: 14 Ethernet, 18 +VLAN, 22 +PPPoE, 26 +PPPoE+VLAN, 0 = no correction.'));
        o.placeholder = 'auto';
        o.validate = function(section_id, value) {
            if (value === null || value === '') return true;
            return /^(auto|[0-9]{1,2})$/.test(value) ? true : _('"auto" or a number of bytes (0-99).');
        };

        o = s.option(form.Flag, 'attr_totals', _('Router proxy attribution'),
            _('Tries to attribute the router\'s own WAN traffic (e.g. a stream proxy) to the LAN device it served, ' +
              'instead of showing it generically as "Router".'));
        o.default = '1';

        o = s.option(form.Value, 'attr_ports', _('Router proxy port(s)'),
            _('Port(s) of a stream proxy running on the router itself, space separated. Traffic served to LAN devices ' +
              'through these ports is credited to the device instead of showing up as generic "Router" traffic. Leave empty to use every port except the infrastructure ports below.'));
        o.placeholder = _('all except the infrastructure ports below');
        o.validate = function(section_id, value) { return validatePortList(section_id, value, _('router proxy ports')); };
        o.depends('attr_totals', '1');

        o = s.option(form.Value, 'attr_skip_ports', _('Router infrastructure ports'),
            _('Only used when the field above is empty: ports that never count as "router is serving this device" (SSH, DNS, DHCP, NTP, DoT, mDNS, LuCI ...).'));
        o.placeholder = '22 53 67 68 80 123 443 853 5353 5355';
        o.validate = function(section_id, value) { return validatePortList(section_id, value, _('router infrastructure ports')); };
        o.depends('attr_totals', '1');

        o = s.option(form.Flag, 'attr_topapps', _('Keep application names after attribution'),
            _('When router proxy traffic is attributed to a LAN device, keep the real application label in tooltip breakdowns instead of grouping it as "Proxy-Stream (via Router)". This only affects tooltip detail, not the device/application totals.'));
        o.default = '0';
        o.rmempty = false;
        o.depends('attr_totals', '1');

        o = s.option(form.Value, 'sock', _('netifyd socket'), _('Path of the netifyd JSON socket.'));
        o.validate = function(section_id, value) {
            if (value === null || value === '') return true;
            return /^\/var\/run\/netifyd\/[A-Za-z0-9._-]+\.sock$/.test(value)
                ? true
                : _('The socket must be a .sock file directly below /var/run/netifyd.');
        };
        o.placeholder = '/var/run/netifyd/netifyd.sock';
        o.depends('apps', '1');

        s = m.section(form.NamedSection, 'global', 'trafficchart', _('Router proxy attribution – thresholds'),
            _('Fine-tuning for the attribution algorithm. The defaults work well for typical stream proxies. ' +
              'Only relevant when "Router proxy attribution" is enabled above.'));

        o = s.option(form.Value, 'attr_win', _('Attribution window'),
            _('Seconds: how long accumulated bytes stay in the pairing pool. Router WAN bytes that find no matching ' +
              'device pool within this window stay on the Router device. Default: 60 s.'));
        o.validate = function(section_id, value) { return validateInteger(section_id, value, 1, null, _('attribution window')); };
        o.placeholder = '60';
        o.depends('attr_totals', '1');

        o = s.option(form.Value, 'attr_tol', _('Volume tolerance'),
            _('Maximum fractional volume difference between a router application and a device pool for a match (0 – 1). ' +
              'Lower = stricter matching. Default: 0.6 (60 %).'));
        o.validate = function(section_id, value) {
            if (value === null || value === '') return true;
            value = value.trim();
            return /^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(value)
                ? true : _('A fraction between 0 and 1 (e.g. 0.6).');
        };
        o.placeholder = '0.6';
        o.depends('attr_totals', '1');

        o = s.option(form.Value, 'attr_min', _('Minimum bytes for pairing'),
            _('Both the router application pool and the device pool must hold at least this many bytes before a pair ' +
              'is attempted. Prevents tiny background flows from being mis-attributed. Default: 262144 (256 KiB).'));
        o.datatype = 'uinteger';
        o.placeholder = '262144';
        o.depends('attr_totals', '1');

        o = s.option(form.Value, 'attr_share', _('Minimum router application share'),
            _('A router application must account for at least this fraction of total router WAN volume to be a ' +
              'candidate for attribution (prevents background traffic from being mis-credited). Default: 0.25 (25 %).'));
        o.validate = function(section_id, value) {
            if (value === null || value === '') return true;
            value = value.trim();
            return /^0\.[0-9]+$/.test(value) && Number(value) > 0
                ? true : _('A fraction greater than 0 and less than 1 (e.g. 0.25).');
        };
        o.placeholder = '0.25';
        o.depends('attr_totals', '1');

        o = s.option(form.Value, 'attr_max_apps', _('Max candidate applications'),
            _('Maximum number of router applications considered for attribution per poll (largest first). ' +
              '0 = unlimited. Default: 64.'));
        o.datatype = 'uinteger';
        o.placeholder = '64';
        o.depends('attr_totals', '1');

        o = s.option(form.Value, 'attr_max_devices', _('Max candidate devices'),
            _('Maximum number of LAN devices considered for attribution per poll (largest pool first). ' +
              '0 = unlimited. Default: 64.'));
        o.datatype = 'uinteger';
        o.placeholder = '64';
        o.depends('attr_totals', '1');

        // One row per storage location: a path and a checkbox for each history resolution.
        var ts = m.section(form.TableSection, 'persist_target', _('History storage locations'),
            _('Where the history is saved and reloaded from after a reboot; no row = RAM only. Per location choose which resolutions are written: ' +
              '5 min (24 hours view), hourly (Week / Month) and daily (Year, plus the link header calibration). ' +
              'Paths: /mnt/..., /media/..., /tmp/mnt/... (SD card, USB, network share) or /etc/trafficchart-data (internal flash, created automatically). ' +
              'Flash tip: tick only "daily" there (about one write per day); 5 min / hourly are written once per write interval. ' +
              'All available locations are written (mirrors); a missing one is caught up when it is back. ' +
              'A location below a mount point (mounted or listed in fstab) is only used while that mount point is mounted. The router mounts nothing itself.'));
        ts.anonymous = true;
        ts.addremove = true;
        ts.sortable = false;
        ts.addbtntitle = _('Add location');
        o = ts.option(form.Value, 'path', _('Path'));
        o.placeholder = '/mnt/sda1/trafficchart';
        o.rmempty = false;
        o.validate = function(section_id, value) {
            if (value === null || value === '') return _('Enter a path.');
            if (/\s/.test(value.trim())) return _('Enter one path per row.');
            return validPaths(section_id, value.trim());
        };
        [ [ 'tier_5m', _('5 min') ], [ 'tier_1h', _('Hourly') ], [ 'tier_1d', _('Daily') ] ].forEach(function(t) {
            var f = ts.option(form.Flag, t[0], t[1]);
            f.default = '1';
            f.rmempty = false;
            f.editable = true;
        });

        s = m.section(form.NamedSection, 'global', 'trafficchart', _('History and persistent storage'),
            _('The History tab keeps 5 minute buckets (24 hours), hourly buckets (week, month) and daily buckets (year). ' +
              'Without a storage path they live in RAM only and are lost on reboot.'));

        // Several backend settings are parsed as integers by tc_cfg() or the
        // init script. LuCI's generic min()/range() validators can accept decimal
        // strings, which then get silently replaced by backend defaults. Validate
        // the actual integer contract in the UI as well.
        function validateInteger(section_id, value, min, max, label) {
            if (value === null || value === '') return true;
            if (!/^[0-9]+$/.test(String(value)))
                return _('Enter a whole number for %s.').format(label);
            var n = Number(value);
            // Keep the accepted value exact across JavaScript and shell/awk consumers.
            if (!isFinite(n) || n > 9007199254740991 || n < min || (max != null && n > max)) {
                if (max != null)
                    return _('Enter a whole number from %d to %d for %s.').format(min, max, label);
                return _('Enter a whole number of at least %d for %s.').format(min, label);
            }
            return true;
        }

        function validatePortList(section_id, value, label) {
            if (value === null || value.trim() === '') return true;
            var items = value.trim().split(/\s+/);
            for (var i = 0; i < items.length; i++) {
                if (!/^[0-9]+$/.test(items[i]))
                    return _('Use space-separated numeric ports for %s.').format(label);
                var port = Number(items[i]);
                if (!isFinite(port) || port < 1 || port > 65535)
                    return _('Ports in %s must be between 1 and 65535.').format(label);
            }
            return true;
        }

        function validateInterfaceList(section_id, value) {
            if (value === null || value.trim() === '') return true;
            var items = value.trim().split(/\s+/);
            for (var i = 0; i < items.length; i++) {
                if (items[i].length > 15 || !/^[A-Za-z0-9._-]+$/.test(items[i]))
                    return _('Use space-separated interface names of at most 15 characters.');
            }
            return true;
        }

        function validPaths(section_id, value) {
            if (value === null || value === '') return true;
            var ok = value.trim().split(/\s+/).every(function(w) {
                if (!/^\/(mnt|media|tmp\/mnt)(\/[A-Za-z0-9._-]+)+$/.test(w) &&
                    !/^\/etc\/trafficchart-data(\/[A-Za-z0-9._-]+)*$/.test(w)) return false;
                return w.split('/').every(function(part) { return part !== '.' && part !== '..'; });
            });
            return ok ? true : _('Use /etc/trafficchart-data (internal flash) or directories below /mnt, /media or /tmp/mnt; paths are separated by spaces.');
        }

        o = s.option(form.Value, 'persist_sec', _('Write interval'),
            _('Seconds between two writes to the storage (minimum 60). A clean stop, restart or reboot always writes everything.'));
        o.value('300', _('5 minutes'));
        o.value('900', _('15 minutes'));
        o.value('3600', _('1 hour (default)'));
        o.value('21600', _('6 hours'));
        // The backend's tc_cfg PERSIST_SEC contract is integer-only. A generic
        // range() validator accepts decimal values on some LuCI versions, after
        // which the backend silently falls back to 3600. Use the same strict
        // integer validator as the other settings consumed as shell integers.
        o.validate = function(section_id, value) {
            return validateInteger(section_id, value, 60, 604800, _('write interval'));
        };
        o.placeholder = '3600';

        o = s.option(form.Value, 'persist_timeout', _('Access timeout'),
            _('Seconds an access to a target may take before it is given up (3-120). Use the "soft" mount option for network shares.'));
        o.validate = function(section_id, value) { return validateInteger(section_id, value, 3, 120, _('access timeout')); };
        o.placeholder = '10';

        o = s.option(form.Value, 'hist_sec', _('5-minute bucket length'),
            _('Seconds per bucket of the finest resolution (24 hours view). Default: 300.'));
        o.validate = function(section_id, value) { return validateInteger(section_id, value, 1, null, _('5-minute bucket length')); };
        o.placeholder = '300';

        o = s.option(form.Value, 'hist_keep', _('5-minute buckets kept'),
            _('Default: 288 × 300 s = 24 h.'));
        o.validate = function(section_id, value) { return validateInteger(section_id, value, 1, null, _('5-minute bucket count')); };
        o.placeholder = '288';

        o = s.option(form.Value, 'hist_hour_keep', _('Hourly buckets kept'),
            _('Week and month view. Default: 744 = 31 days.'));
        o.validate = function(section_id, value) { return validateInteger(section_id, value, 1, null, _('hourly bucket count')); };
        o.placeholder = '744';

        o = s.option(form.Value, 'hist_day_keep', _('Daily buckets kept'),
            _('Year view. Default: 400 days.'));
        o.validate = function(section_id, value) { return validateInteger(section_id, value, 1, null, _('daily bucket count')); };
        o.placeholder = '400';

        s = m.section(form.NamedSection, 'global', 'trafficchart', _('SQM classifier (nss-trafficchart.qos)'),
            _('Options of the nss-trafficchart.qos nftables classifier (not used by the chart). DNS redirect and TTL rewrite are off by default. Restart SQM after changing them.'));

        o = s.option(form.Flag, 'dns_redirect', _('Redirect DNS to the router'),
            _('Redirects DNS (port 53, UDP and TCP) coming from every non-WAN interface to the router\'s own resolver. ' +
              'Also hits VPN interfaces and clients that use their own resolver - use the exclusion list below if that is not wanted.'));
        o.default = '0';
        o.rmempty = false;

        o = s.option(form.Value, 'dns_redirect_exclude', _('Interfaces excluded from the redirect'),
            _('Space separated device names (e.g. wg0 tun0) whose DNS is left alone.'));
        o.placeholder = 'wg0';
        o.validate = function(section_id, value) { return validateInterfaceList(section_id, value); };
        o.depends('dns_redirect', '1');

        o = s.option(form.Value, 'bulk_bytes', _('Bulk threshold (bytes)'),
            _('TCP/UDP flows already classified as WEB, P2P or best-effort are moved to BULK after this conntrack byte count. Default: 300 MiB.'));
        o.datatype = 'uinteger';
        o.default = '314572800';
        o.rmempty = false;

        o = s.option(form.Flag, 'ttl_fix', _('Normalise TTL / hop limit'),
            _('Rewrites packets with TTL/hop limit 63 or 127 to 64.'));
        o.default = '0';
        o.rmempty = false;

        o = s.option(form.Flag, 'reset_ct_marks', _('Reset connection marks on SQM start'),
            _('Zeroes the whole conntrack mark when SQM starts. Turn it off if mwan3 (or anything else) keeps state in the higher mark bits.'));
        o.default = '1';
        o.rmempty = false;

        s = m.section(form.NamedSection, 'global', 'trafficchart', _('Advanced'));

        o = s.option(form.Value, 'app_max', _('Max applications'),
            _('Applications kept individually; further ones are summed as "(other)". Default: 400.'));
        o.datatype = 'uinteger';
        o.placeholder = '400';

        o = s.option(form.Value, 'host_max', _('Max destinations'),
            _('Destinations kept individually; idle ones are folded into "(other)" when the table is full. Default: 200.'));
        o.datatype = 'uinteger';
        o.placeholder = '200';

        o = s.option(form.Value, 'row_keep', _('Rows listed individually'),
            _('Devices and destinations listed individually in the live data (the most active ones); the rest is summed as "(other)". ' +
              '0 = list everything. Default: 40.'));
        o.datatype = 'uinteger';
        o.placeholder = '40';

        var rendered = m.render();
        rendered.then(function(node) {
            // pollDomainStatus already displays RPC errors in the status field;
            // consume its rejection here to avoid an unhandled Promise rejection.
            pollDomainStatus().catch(function() {});
            domainStatusTimer = window.setInterval(function() {
                // LuCI removes the previous view on navigation. Stop polling once
                // its status element is gone instead of leaving a permanent timer.
                if (!document.getElementById('trafficchart-domain-status')) {
                    window.clearInterval(domainStatusTimer);
                    domainStatusTimer = null;
                    manualUpdateInProgress = false;
                    return;
                }
                // The error is rendered by pollDomainStatus itself. Do not leave
                // rejected status requests unhandled on this recurring timer.
                if (!manualUpdateInProgress) pollDomainStatus().catch(function() {});
            }, 5000);
        });
        return rendered;
        });
    }
});
