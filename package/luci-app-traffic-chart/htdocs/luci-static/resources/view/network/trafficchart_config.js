'use strict';
'require form';
'require view';

return view.extend({
    render: function() {
        var m, s, o;

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

        o = s.option(form.ListValue, 'backend', _('Shaper backend'),
            _('Auto selects NSS hardware offload if the nssifb device exists and the nss_ifb module is loaded, otherwise the generic reader.'));
        o.value('auto', _('Auto'));
        o.value('nss', _('NSS hardware offload'));
        o.value('generic', _('Generic (cake / htb+fq_codel / any other qdisc)'));
        o.default = 'auto';

        o = s.option(form.Value, 'interval', _('Poll interval'), _('Seconds between conntrack passes (default 4; stretches automatically under load).'));
        o.datatype = 'min(1)';
        o.placeholder = '4';

        o = s.option(form.Value, 'wan_dev', _('WAN device'),
            _('Empty = auto-detect (shaped devices are found in the kernel: ingress redirect to an ifb, or NSS nsstbl; otherwise the default route device). ' +
              'Set device names (e.g. eth1 pppoe-wan) or logical interfaces (wan), space separated, to override.'));
        o.placeholder = 'pppoe-wan';

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
        o.depends('attr_totals', '1');

        o = s.option(form.Value, 'attr_skip_ports', _('Router infrastructure ports'),
            _('Only used when the field above is empty: ports that never count as "router is serving this device" (SSH, DNS, DHCP, NTP, DoT, mDNS, LuCI ...).'));
        o.placeholder = '22 53 67 68 80 123 443 853 5353 5355';
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
        o.datatype = 'min(1)';
        o.placeholder = '60';
        o.depends('attr_totals', '1');

        o = s.option(form.Value, 'attr_tol', _('Volume tolerance'),
            _('Maximum fractional volume difference between a router application and a device pool for a match (0 – 1). ' +
              'Lower = stricter matching. Default: 0.6 (60 %).'));
        o.validate = function(section_id, value) {
            if (value === null || value === '') return true;
            var v = parseFloat(value);
            return (v >= 0 && v <= 1) ? true : _('A fraction between 0 and 1 (e.g. 0.6).');
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
            var v = parseFloat(value);
            return (v > 0 && v < 1) ? true : _('A fraction greater than 0 and less than 1 (e.g. 0.25).');
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

        s = m.section(form.NamedSection, 'global', 'trafficchart', _('History and persistent storage'),
            _('The History tab keeps 5 minute buckets (24 hours), hourly buckets (week, month) and daily buckets (year). ' +
              'Without a storage path they live in RAM only and are lost on reboot.'));

        function validPaths(section_id, value) {
            if (value === null || value === '') return true;
            var ok = value.trim().split(/\s+/).every(function(w) {
                return /^\/(mnt|media|tmp\/mnt)(\/[A-Za-z0-9._-]+)+$/.test(w);
            });
            return ok ? true : _('Use existing directories below /mnt, /media, or /tmp/mnt; paths are separated by spaces.');
        }

        o = s.option(form.Value, 'persist_dir', _('Storage path(s)'),
            _('Directory (or several, separated by spaces) the history is saved to and reloaded from after a reboot; empty = RAM only. ' +
              'Targets must be below /mnt, /media or /tmp/mnt; symlinks leading outside those trees are rejected by the daemon. ' +
              'All available targets are written (mirrors); a missing one is caught up when it is back. ' +
              'The router mounts nothing itself.'));
        o.placeholder = '/mnt/nas/traffic /mnt/sda1/trafficchart';
        o.rmempty = true;
        o.validate = validPaths;

        o = s.option(form.Value, 'persist_mount', _('Required mount point(s)'),
            _('Optional, separated by spaces: a target below one of these paths is only used while the path is mounted (e.g. /mnt/nas). ' +
              'Prevents the history from ending up on the flash below a share that is not mounted yet.'));
        o.placeholder = '/mnt/nas /mnt/sda1';
        o.rmempty = true;
        o.validate = validPaths;

        o = s.option(form.Value, 'persist_sec', _('Write interval'),
            _('Seconds between two writes to the storage (minimum 60). A clean stop, restart or reboot always writes everything.'));
        o.value('300', _('5 minutes'));
        o.value('900', _('15 minutes'));
        o.value('3600', _('1 hour (default)'));
        o.value('21600', _('6 hours'));
        o.datatype = 'range(60,604800)';
        o.placeholder = '3600';

        o = s.option(form.Value, 'persist_timeout', _('Access timeout'),
            _('Seconds an access to a target may take before it is given up (3-120). Use the "soft" mount option for network shares.'));
        o.datatype = 'range(3,120)';
        o.placeholder = '10';

        o = s.option(form.Value, 'hist_sec', _('5-minute bucket length'),
            _('Seconds per bucket of the finest resolution (24 hours view). Default: 300.'));
        o.datatype = 'min(1)';
        o.placeholder = '300';

        o = s.option(form.Value, 'hist_keep', _('5-minute buckets kept'),
            _('Default: 288 × 300 s = 24 h.'));
        o.datatype = 'min(1)';
        o.placeholder = '288';

        o = s.option(form.Value, 'hist_hour_keep', _('Hourly buckets kept'),
            _('Week and month view. Default: 744 = 31 days.'));
        o.datatype = 'min(1)';
        o.placeholder = '744';

        o = s.option(form.Value, 'hist_day_keep', _('Daily buckets kept'),
            _('Year view. Default: 400 days.'));
        o.datatype = 'min(1)';
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

        return m.render();
    }
});
