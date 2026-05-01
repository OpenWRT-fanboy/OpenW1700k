'use strict';
'require view';
'require dom';
'require poll';
'require ui';
'require view.appflow.common as appflow';

/*
 * AppFlow: Statistics (past hour).
 *
 * DESIGN.md §4 item 2: the range view, served from the daemon's
 * in-RAM 12 x 5-minute buckets via ubus appflow.stats {range:"hour"}. Layout,
 * column set, sort order, the synthetic "All traffic" row, the search box, the
 * per-app detail drawer and the 15 s poll follow the conventions of the
 * "Flow Control -> Data Statistics" screen.
 *
 * Past day / past week are phase 2 (they need persistence). The tabs are shown
 * disabled rather than hidden, so the seam is visible instead of pretended away.
 */

var INTERVAL = 15,
    TOP_N = 10,
    MAX_ROWS = 200,
    RANGE = 'hour';

var COLUMNS = [
	{ key: 'label', title: _('Application'), cls: '' },
	{ key: 'dl',    title: _('Download'),    cls: 'af-num' },
	{ key: 'ul',    title: _('Upload'),      cls: 'af-num' },
	{ key: 'total', title: _('Total'),       cls: 'af-num' }
];

return view.extend({
	sortKey: 'total',
	sortDir: -1,
	filter: '',
	fails: 0,
	painted: false,
	stats: null,

	fetch: function() {
		/* Keep the rejection (via this.lastErr) instead of L.resolveDefault-ing
		 * it away, so showDown can tell a stopped daemon from an ACL denial. */
		var self = this;
		return appflow.rpc.stats(RANGE).then(
			function(v) { self.lastErr = null; return v; },
			function(e) { self.lastErr = e; return null; }
		);
	},

	load: function() {
		/* the icon pack is optional; loadIcons() resolves either way */
		return Promise.all([ appflow.loadIcons(), this.fetch() ])
			.then(function(r) { return r[1]; });
	},

	/* ------------------------------------------------------------ render */

	render: function(stats) {
		appflow.injectCSS();

		this.nodes = {
			strip: E('div'),
			top: E('div'),
			rows: E('div'),
			count: E('span', { 'class': 'af-sub' })
		};

		var tip = _('Requires history storage (planned)');

		this.searchInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			/* It has always matched the CATEGORY label as well as the app name.
			 * Saying "Search app name" meant nobody could discover that, which
			 * is closer to a defect than a wording nit: the capability shipped
			 * and the label concealed it. */
			'placeholder': _('Filter by application or category'),
			'aria-label': _('Filter by application or category'),
			'input': L.bind(function(ev) {
				this.filter = (ev.target.value || '').toLowerCase();
				this.paintTable();
			}, this)
		});

		this.clearButton = E('button', {
			'class': 'cbi-button cbi-button-negative',
			'click': L.bind(this.handleClear, this)
		}, [ _('Clear') ]);

		this.liveNode = E('div', {}, [
			E('ul', { 'class': 'cbi-tabmenu af-ranges' }, [
				E('li', { 'class': 'cbi-tab' }, [
					E('a', { 'href': '#', 'click': function(ev) { ev.preventDefault(); } },
						[ _('Past hour') ])
				]),
				E('li', { 'class': 'cbi-tab-disabled af-disabled', 'title': tip }, [
					E('a', { 'title': tip, 'click': function(ev) { ev.preventDefault(); } },
						[ _('Past day') ])
				]),
				E('li', { 'class': 'cbi-tab-disabled af-disabled', 'title': tip }, [
					E('a', { 'title': tip, 'click': function(ev) { ev.preventDefault(); } },
						[ _('Past week') ])
				])
			]),
			this.nodes.strip,
			appflow.card(_('Top 10 apps by bandwidth usage'),
				[ _('last 60 minutes') ], this.nodes.top),
			appflow.card(_('App traffic statistics'), null, E('div', {}, [
				E('div', { 'class': 'af-toolbar' }, [
					this.searchInput,
					this.nodes.count,
					E('div', { 'class': 'af-spacer' }),
					this.clearButton
				]),
				this.nodes.rows
			]))
		]);

		this.downNode = E('div', { 'style': 'display:none' }, [ appflow.notRunning() ]);

		this.paint(stats);

		poll.add(L.bind(function() {
			return this.fetch().then(L.bind(this.paint, this));
		}, this), INTERVAL);

		return E([], [
			E('h2', {}, [ _('AppFlow') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Per-application totals for the last hour, aggregated on the router from the Netify Agent\'s classification. Select a row for the per-device breakdown.')
			]),
			this.liveNode,
			this.downNode
		]);
	},

	/* ------------------------------------------------------------- paint */

	paint: function(stats) {
		if (stats == null) {
			this.fails++;

			if (this.fails >= (this.painted ? 2 : 1))
				return this.showDown();

			return;
		}

		this.fails = 0;
		this.painted = true;
		this.stats = stats;
		this.liveNode.style.display = '';
		this.downNode.style.display = 'none';
		this.clearButton.disabled = false;

		dom.content(this.nodes.strip, appflow.statusStrip(stats, [
			stats.generated_at ? E('span', { 'class': 'af-pill' }, [
				_('Updated %s').format(appflow.fmtAgo(stats.generated_at))
			]) : null,
			appflow.pill(_('12 buckets of 5 min'))
		]));

		this.paintTop();
		this.paintTable();
	},

	showDown: function() {
		this.stats = null;
		dom.content(this.downNode, appflow.notRunning(appflow.classifyFail(this.lastErr), this.lastErr));
		this.liveNode.style.display = 'none';
		this.downNode.style.display = '';
	},

	/* Applications, normalised and sorted; "All traffic" is kept separate. */
	appList: function() {
		var stats = this.stats || {};

		return appflow.toList(stats.applications || stats.apps)
			.map(function(a) { return appflow.normApp(a); })
			.filter(function(a) {
				/* the daemon may already include the synthetic row */
				return a.key != '-1' && a.key != 'all_traffic';
			});
	},

	allRow: function(apps) {
		var stats = this.stats || {};

		if (stats.all != null)
			return appflow.normTotals(stats.all);

		return apps.reduce(function(a, x) {
			a.dl += x.dl;
			a.ul += x.ul;
			a.total += x.total;

			return a;
		}, { dl: 0, ul: 0, total: 0 });
	},

	/* ---------------------------------------------------------- top ten */

	paintTop: function() {
		var stats = this.stats || {},
		    top = appflow.toList(stats.top_apps);

		if (!top.length)
			top = this.appList().sort(function(a, b) { return b.total - a.total; });
		else
			top = top.map(function(a) { return appflow.normApp(a); })
				.sort(function(a, b) { return b.total - a.total; });

		top = top.slice(0, TOP_N);

		if (!top.length) {
			dom.content(this.nodes.top, appflow.placeholder(
				_('No application traffic recorded in the last hour.')));
			return;
		}

		var peak = appflow.num(stats, [ 'max_bytes' ], 0) || top[0].total || 1,
		    self = this;

		dom.content(this.nodes.top, [
			E('table', { 'class': 'table af-table' }, top.map(function(a) {
				return E('tr', {
					'class': 'tr af-row',
					'title': _('Show per-device details'),
					'click': L.bind(self.handleDetail, self, a)
				}, [
					E('td', { 'class': 'td', 'style': 'width:28%' }, [ appflow.appCell(a) ]),
					E('td', { 'class': 'td' }, [ appflow.bar(a.dl, a.ul, peak) ]),
					E('td', { 'class': 'td af-num', 'style': 'width:14%' }, [
						appflow.fmtBytes(a.total)
					])
				]);
			})),
			appflow.swatches(
				appflow.fmtBytes(top.reduce(function(s, a) { return s + a.dl; }, 0)),
				appflow.fmtBytes(top.reduce(function(s, a) { return s + a.ul; }, 0)))
		]);
	},

	/* ------------------------------------------------------- main table */

	handleSort: function(key) {
		if (this.sortKey == key)
			this.sortDir = -this.sortDir;
		else {
			this.sortKey = key;
			this.sortDir = (key == 'label') ? 1 : -1;
		}

		this.paintTable();
	},

	paintTable: function() {
		var self = this,
		    apps = this.appList(),
		    all = this.allRow(apps),
		    total = apps.length;

		/* Shared with the overview via common.js, so the two pages cannot drift
		 * and the logic is reachable by a Node test. Adds exclusion: a term
		 * prefixed with a minus removes matching rows, which is what you want
		 * when one heavy application is burying everything else. */
		var terms = appflow.parseFilter(this.filter);

		if (terms.length)
			apps = apps.filter(function(a) {
				return appflow.matchFilter(terms,
					[ a.label, a.key, appflow.catLabel(a.cat) ]);
			});

		apps.sort(function(a, b) {
			var k = self.sortKey;

			if (k == 'label')
				return self.sortDir * a.label.localeCompare(b.label);

			return self.sortDir * ((a[k] - b[k]) || (a.total - b.total));
		});

		dom.content(this.nodes.count, [ this.filter.length
			? _('%d of %d applications').format(apps.length, total)
			: _('%d applications').format(total) ]);

		var truncated = apps.length > MAX_ROWS;

		if (truncated)
			apps = apps.slice(0, MAX_ROWS);

		var header = E('tr', { 'class': 'tr table-titles' }, COLUMNS.map(function(c) {
			return E('th', {
				'class': 'th af-sortable ' + c.cls,
				'title': _('Sort by %s').format(c.title),
				'click': L.bind(self.handleSort, self, c.key)
			}, [
				c.title,
				(self.sortKey == c.key)
					? E('span', { 'class': 'af-caret' }, [ self.sortDir < 0 ? '▼' : '▲' ])
					: ''
			]);
		}));

		var rows = [ header ];

		/* Synthetic "All traffic" summary row, always pinned to the top. */
		rows.push(E('tr', { 'class': 'tr af-all' }, [
			E('td', { 'class': 'td' }, [
				E('span', {}, [ _('All traffic') ]),
				E('span', { 'class': 'af-sub' }, [ _('sum of all applications') ])
			]),
			E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(all.dl) ]),
			E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(all.ul) ]),
			E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(all.total) ])
		]));

		if (!apps.length)
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'colspan': String(COLUMNS.length) }, [
					appflow.placeholder(this.filter.length
						? _('No application matches "%s".').format(this.filter)
						: _('No application traffic recorded in the last hour.'))
				])
			]));

		apps.forEach(function(a) {
			/* Keyboard-reachable, not mouse-only. The per-device drawer is the
			 * feature this whole view exists for and until 2026-08-25 a `click`
			 * handler was the only way in: no tabindex, no role, no key
			 * handler anywhere in this package. role=button plus tabindex puts
			 * the row in the tab order and makes it announce as activatable;
			 * Enter and Space are the two keys a button is required to answer.
			 * Raised in code review. */
			rows.push(E('tr', {
				'class': 'tr af-row',
				'title': _('Show per-device details'),
				'role': 'button',
				'tabindex': '0',
				'aria-label': _('Show per-device details for %s').format(a.label || a.key),
				'keydown': L.bind(function(app, ev) {
					if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar')
						return;
					ev.preventDefault();   /* Space would scroll the page */
					self.handleDetail(app, ev);
				}, self, a),
				'click': L.bind(self.handleDetail, self, a)
			}, [
				E('td', { 'class': 'td' }, [ appflow.appCell(a) ]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(a.dl) ]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(a.ul) ]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(a.total) ])
			]));
		});

		dom.content(this.nodes.rows, [
			E('table', { 'class': 'table af-table' }, rows),
			truncated ? E('div', { 'class': 'af-placeholder' }, [
				_('Showing the first %d applications; narrow the search to see the rest.')
					.format(MAX_ROWS)
			]) : ''
		]);
	},

	/* ------------------------------------------------------ detail drawer */

	handleDetail: function(app, ev) {
		if (ev)
			ev.stopPropagation();

		/* Mark which app this drawer is for. A late detail() result only renders
		 * if it still matches; today the spinner overlay blocks a second row
		 * click while one is in flight, but that is an accident of the overlay
		 * being modal, so the guard should not depend on it. */
		this.detailKey = app.key;

		// Title must be a node array, never a bare string: LuCI's showModal
		// routes a bare-string title through innerHTML, and app.label aliases
		// to attacker-influenced fields (DHCP hostname, TLS SNI) one edit away.
		ui.showModal([ app.label ], [
			E('p', { 'class': 'spinning' }, [ _('Collecting data…') ])
		], 'cbi-modal');

		appflow.rpc.detail(app.key).then(L.bind(function(detail) {
			this.renderDetail(app, detail);
		}, this)).catch(L.bind(function(err) {
			this.renderDetail(app, null, err);
		}, this));
	},

	renderDetail: function(app, detail, err) {
		/* the drawer may have been dismissed while the call was in flight */
		if (!document.body.classList.contains('modal-overlay-active'))
			return;

		/* or replaced by a drawer for a different app: a late result for the
		 * previously-open app must not overwrite the one now showing */
		if (this.detailKey !== app.key)
			return;

		var d = detail || {},
		    totals = appflow.normTotals(d.metrics || d.totals || d),
		    /* Do not re-normalise app.series: normApp() already did. The alias
		     * fix in common.js makes that harmless now, but normalising once is
		     * the actual intent and it keeps the fallback readable. */
		    series = appflow.normSeries(d.time_series || d.series),
		    devices = appflow.toList(d.devices || d.clients || d.mac_addresses, 'mac')
			.map(function(x) { return appflow.normDevice(x); })
			.filter(function(x) { return x.total > 0; })
			.sort(function(a, b) { return b.total - a.total; }),
		    hosts = appflow.toList(d.hostnames || d.hosts, 'hostname')
			.map(function(h) {
				var t = appflow.normTotals(h);

				return {
					name: appflow.str(h, [ 'hostname', 'host', 'name', 'domain' ], '?'),
					total: t.total
				};
			})
			.filter(function(h) { return h.total > 0; })
			.sort(function(a, b) { return b.total - a.total; })
			.slice(0, 8);

		if (!totals.total)
			totals = { dl: app.dl, ul: app.ul, total: app.total };

		var body = [
			E('div', { 'class': 'af-modal-head' }, [
				appflow.tile(app.label, app.cat, app.tag),
				E('div', {}, [
					E('h4', { 'style': 'display:block;text-align:start;padding:0;margin:0' }, [ app.label ]),
					app.cat ? E('span', {
						'class': 'af-badge',
						'style': 'background:' + appflow.color(app.cat)
					}, [ appflow.catLabel(app.cat) ]) : E('span', { 'class': 'af-sub' }, [
						_('Unclassified')
					])
				])
			]),
			E('div', { 'class': 'af-kpi' }, [
				appflow.kpi(_('Download'), appflow.fmtBytes(totals.dl), 'af-dlc'),
				appflow.kpi(_('Upload'), appflow.fmtBytes(totals.ul), 'af-ulc'),
				appflow.kpi(_('Total'), appflow.fmtBytes(totals.total)),
				appflow.kpi(_('Devices'), String(devices.length))
			])
		];

		if (err)
			body.push(E('div', { 'class': 'alert-message warning' }, [
				_('The daemon could not return details for this application: %s')
					.format(String(err.message || err))
			]));
		else if (detail && detail.found === false)
			body.push(E('div', { 'class': 'alert-message warning' }, [
				_('This application is no longer in the daemon\'s aggregate table; it may have been pruned since the table was last refreshed.')
			]));

		body.push(E('h4', {}, [ _('Data usage') ]));

		if (series.length)
			body.push(appflow.columnChart(series, {
				height: 150,
				/* The axis is labelled -60 min, so it must span the daemon's full
				 * trailing hour regardless of how many buckets have accumulated
				 * so far. That hour is TWELVE five-minute buckets
				 * (appflowd: SERIES_SLOTS=12, SERIES_MS=300000), not sixty --
				 * passing 60 here would squeeze a complete hour into the last
				 * fifth of the chart, which is a worse lie than the one this
				 * fixes. If SERIES_SLOTS changes, this changes with it. */
				slots: 12,
				xlabels: [ _('-%d min').format(60), _('now') ]
			}));
		else
			body.push(appflow.placeholder(_('No time series available for this application.')));

		body.push(E('h4', {}, [ _('Devices') ]));

		if (devices.length) {
			var rows = [ E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, [ _('Client') ]),
				E('th', { 'class': 'th' }, [ _('Last seen') ]),
				E('th', { 'class': 'th af-num' }, [ _('Download') ]),
				E('th', { 'class': 'th af-num' }, [ _('Upload') ]),
				E('th', { 'class': 'th af-num' }, [ _('Share') ])
			]) ];

			devices.forEach(function(dev) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td' }, [ appflow.deviceCell(dev) ]),
					E('td', { 'class': 'td af-sub' }, [ appflow.fmtAgo(dev.seen) ]),
					E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(dev.dl) ]),
					E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(dev.ul) ]),
					E('td', { 'class': 'td af-num' }, [
						appflow.fmtPercent(dev.total, totals.total)
					])
				]));
			});

			body.push(E('table', { 'class': 'table af-table' }, rows));
		}
		else {
			body.push(appflow.placeholder(
				_('No per-device breakdown available for this application.')));
		}

		if (hosts.length) {
			body.push(E('h4', {}, [ _('Hosts') ]));
			body.push(E('ul', { 'class': 'af-legend' }, hosts.map(function(h) {
				return E('li', {}, [
					E('span', { 'class': 'af-legend-lbl af-mono', 'title': h.name }, [ h.name ]),
					E('span', { 'class': 'af-legend-val af-num' }, [
						appflow.fmtBytes(h.total)
					])
				]);
			})));
		}

		body.push(E('div', { 'class': 'af-btnrow' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': ui.hideModal
			}, [ _('Close') ])
		]));

		/* Node array, not a bare string -- the same rule stated at the top of
		 * handleDetail() and, until 2026-08-26, not followed here. LuCI routes a
		 * bare-string title through innerHTML, and `_()` returns whatever the
		 * active catalog says. With the English catalog that is a constant in
		 * this file; the moment a translation is accepted it is third-party
		 * content, which is exactly what the pending zh_Hans PR proposes. Raised
		 * by a review of that PR, which was careful to note the submitted
		 * Chinese contains no markup: this is closing the trust distinction, not
		 * fixing an exploit. */
		ui.showModal([ _('Details') ], body, 'cbi-modal');
	},

	/* -------------------------------------------------------------- clear */

	handleClear: function() {
		ui.showModal([ _('Clear statistics') ], [
			E('p', {}, [
				_('This resets the per-application, per-device and per-category counters and time buckets. Live flow tracking continues uninterrupted, so the figures on this page simply start again from zero.')
			]),
			E('div', { 'class': 'af-btnrow' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.hideModal
				}, [ _('Cancel') ]),
				E('button', {
					'class': 'btn cbi-button cbi-button-negative important',
					'click': ui.createHandlerFn(this, 'handleClearConfirm')
				}, [ _('Clear') ])
			])
		]);
	},

	handleClearConfirm: function() {
		return appflow.rpc.reset().then(L.bind(function() {
			ui.hideModal();
			ui.addTimeLimitedNotification(null,
				E('p', {}, [ _('AppFlow statistics cleared.') ]), 4000, 'info');

			return this.fetch().then(L.bind(this.paint, this));
		}, this), function(err) {
			ui.hideModal();
			ui.addNotification(null, E('p', {}, [
				_('Could not clear the statistics: %s').format(String(err.message || err))
			]), 'error');
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
