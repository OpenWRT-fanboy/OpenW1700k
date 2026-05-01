'use strict';
'require view';
'require dom';
'require poll';
'require view.appflow.common as appflow';

/*
 * AppFlow: Overview (live).
 *
 * DESIGN.md §4 item 1. The live view: total
 * throughput, the applications currently moving traffic, the category split
 * and the busiest devices, refreshed every 5 s from ubus appflow.summary /
 * appflow.devices / appflow.status.
 *
 * The chart window is kept client-side only: SLOTS samples at INTERVAL
 * seconds, i.e. a rolling five minutes that starts over on page load. The
 * daemon is not asked to remember anything for it.
 */

var INTERVAL = 5,
    SLOTS = 60,
    TOP_APPS = 8,
    TOP_DEVICES = 8,
    TOP_CATEGORIES = 6,
    /* How many application rows to ask the daemon for. The table displays
     * TOP_APPS of them; the rest are the filter's raw material, so filtering
     * does not fall off the top-N cliff the moment one heavy flow pushes what
     * you are looking for out of the visible rows. */
    FETCH_LIMIT = 50;

function head(cells) {
	return E('tr', { 'class': 'tr table-titles' }, cells.map(function(c) {
		return E('th', { 'class': 'th' + (c[1] ? ' ' + c[1] : '') }, [ c[0] ]);
	}));
}

return view.extend({
	samples: [],
	fails: 0,
	painted: false,

	fetch: function() {
		var self = this;

		/* Capture the summary rejection (rather than L.resolveDefault-ing it to
		 * null) so paint can tell a stopped daemon from an ACL denial. */
		return Promise.all([
			/* FETCH_LIMIT, not the daemon's top_n. Filtering a top-10 list to
			 * "AI" returns nothing as soon as one streaming session pushes AI
			 * out of the top 10, which looks broken and is worse than no
			 * filter. The table still displays TOP_APPS rows; the extra rows
			 * exist so there is something to filter. */
			appflow.rpc.summary(FETCH_LIMIT).then(function(v) { return { v: v }; },
			                          function(e) { return { e: e }; }),
			/* When a device is selected the application list comes from the
			 * flow table scoped to it, rather than from the global aggregate. */
			L.resolveDefault(self.deviceFilter
				? appflow.rpc.apps('', FETCH_LIMIT, self.deviceFilter.key)
				: null, null),
			/* The poll has to carry the filter too. A side call that filtered the
			 * device card was painted over by the very next poll five seconds
			 * later, so the card flickered back to unfiltered and the feature
			 * looked dead. Filtering is view state, so every fetch respects it
			 * rather than one special path doing so. */
			L.resolveDefault((self.filteredKeys && self.filteredKeys.length)
				? appflow.rpc.devices('', TOP_DEVICES, self.filteredKeys)
				: appflow.rpc.devices(), null),
			L.resolveDefault(appflow.rpc.status(), null)
		]).then(function(r) {
			return { summary: r[0].v || null, err: r[0].e,
			         devApps: r[1], devices: r[2], status: r[3] };
		});
	},

	load: function() {
		/* the icon pack is optional; loadIcons() resolves either way */
		return Promise.all([ appflow.loadIcons(), this.fetch() ])
			.then(function(r) { return r[1]; });
	},

	/* ------------------------------------------------------------ render */

	render: function(data) {
		appflow.injectCSS();

		var self = this;

		/* Live filter state. Held on the view rather than read from the DOM so
		 * that a poll repaint cannot lose what the user typed. */
		this.filter = this.filter || '';

		/* The selected device, or null. Separate from the text filter because
		 * they are different kinds of thing: the text is a substring anyone can
		 * edit, a device is one exact record. */
		this.deviceFilter = this.deviceFilter || null;

		this.devFilter = this.devFilter || '';

		this.devFilterInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': _('Filter by device name, MAC or IP'),
			'aria-label': _('Filter by device name, MAC or IP'),
			'value': this.devFilter,
			'input': function(ev) {
				self.devFilter = ev.target.value || '';
				if (self.lastDevices)
					self.paintDevices(self.lastDevices, self.lastSummary);
			}
		});

		this.filterInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': _('Filter by application or category'),
			'aria-label': _('Filter by application or category'),
			'value': this.filter,
			'input': function(ev) {
				self.filter = ev.target.value || '';
				if (self.lastSummary) {
					self.paintApps(self.lastSummary);
					self.refreshDevices();
				}
			}
		});

		this.nodes = {
			strip: E('div'),
			window: E('span'),
			kpi: E('div', { 'class': 'af-kpi' }),
			chart: E('div'),
			apps: E('div'),
			appsAux: E('span', {}, [ _('by current rate') ]),
			/* Shows which device is selected, with a way out. A filter you
			 * cannot see is a filter you cannot clear. */
			devChip: E('div', { 'class': 'af-chipbar' }),
			cats: E('div'),
			/* Its own node so the caption can change when a filter is applied:
			 * filtered figures come from flows in progress, not cumulative
			 * totals, and the heading must not keep promising the latter. */
			/* No af-cardaux class: card() wraps whatever it is given in one, and
			 * passing a second nested one produced the caption twice. */
			devsAux: E('span', {}, [ _('top, by cumulative bytes') ]),
			devs: E('div')
		};

		var n = this.nodes;

		this.liveNode = E('div', {}, [
			n.strip,
			appflow.card(_('Live throughput'), [
				n.window,
				_('%d minute chart, %d second interval').format(SLOTS * INTERVAL / 60, INTERVAL)
			], E('div', {}, [ n.kpi, n.chart ])),
			E('div', { 'class': 'af-grid af-split' }, [
				/* card() puts `body` in as a single child, so an ARRAY here lands
				 * as a nested array that E() does not flatten and nothing after
				 * the first element renders. Wrap it in one element. Found by
				 * looking at the live page: the clickable categories worked and
				 * the filter box was simply absent from the DOM. */
				appflow.card(_('Top applications'), n.appsAux, E('div', {}, [
					E('div', { 'class': 'af-filter' }, [
						this.filterInput,
						E('button', {
							'class': 'cbi-button',
							'click': L.bind(function(ev) {
								ev.preventDefault();
								this.setFilter('');
							}, this)
						}, [ _('Clear') ])
					]),
					/* SAY WHERE THE CATEGORIES ARE, AND SAY WHAT CLEAR DOES.
					 *
					 * This read "Click a category below", and the Categories
					 * panel is beside this card, not below it. A user who looks
					 * where the text points and finds nothing concludes the
					 * feature is missing. "Below" was written without checking
					 * the layout.
					 *
					 * It names the panel rather than a direction, because the
					 * cards wrap underneath each other on a narrow window and
					 * "to the right" would then be wrong in the other
					 * direction. */
					n.devChip,
					E('div', { 'class': 'af-filter-note' }, [
						_('Start typing an application or category name to show only that traffic, or click a category in the Categories panel. Prefix a word with a minus to exclude it instead, for example -netflix. Press Clear to see all traffic again.')
					]),
					n.apps
				])),
				appflow.card(_('Categories'), [ _('top, by cumulative bytes') ], n.cats)
			]),
			appflow.card(_('Top devices'), n.devsAux, E('div', {}, [
					E('div', { 'class': 'af-filter' }, [
						this.devFilterInput,
						E('button', {
							'class': 'cbi-button',
							'click': L.bind(function(ev) {
								ev.preventDefault();
								this.setDevFilter('');
							}, this)
						}, [ _('Clear') ])
					]),
					E('div', { 'class': 'af-filter-note' }, [
						_('Start typing a device name, MAC address or IP to find it. Click a device to see what it is doing in the applications list above. Press Clear to see all devices again.')
					]),
					n.devs
				]))
		]);

		this.downNode = E('div', { 'style': 'display:none' }, [ appflow.notRunning() ]);

		this.paint(data);

		poll.add(L.bind(function() {
			return this.fetch().then(L.bind(this.paint, this));
		}, this), INTERVAL);

		return E([], [
			E('h2', {}, [ _('AppFlow') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Live per-application traffic, classified on the router by the Netify Agent. Nothing on this page leaves the device.')
			]),
			this.liveNode,
			this.downNode
		]);
	},

	/* ------------------------------------------------------------- paint */

	paint: function(data) {
		var summary = data ? data.summary : null,
		    status = data ? data.status : null;

		if (summary == null) {
			this.fails++;

			/* One miss on a live page is usually a blip; only fall back to the
			 * "not running" screen once it is clearly not coming back. */
			if (this.fails >= (this.painted ? 2 : 1))
				return this.showDown(data ? data.err : null);

			return;
		}

		this.fails = 0;
		this.painted = true;
		this.liveNode.style.display = '';
		this.downNode.style.display = 'none';

		/* live aggregates carry byte and rate counters in one object; a future
		 * split into totals/rates is handled by normRates */
		var totals = appflow.normTotals(summary.totals || summary),
		    rates = summary.rates ? appflow.normRates(summary.rates) : totals;

		/* Stamped so a gap can be measured. The chart still places points by
		 * INDEX, so the "-5 min" label remains an assumption that every sample
		 * is INTERVAL apart -- that is a real limitation and is not fixed here.
		 * What the stamp does fix is the recovery below: without it there was no
		 * way to tell a 10-second blip from an hour offline, so showDown()
		 * cleared unconditionally. */
		var nowMs = Date.now(),
		    last = this.samples.length ? this.samples[this.samples.length - 1].t : 0;

		/* Coming back from a gap longer than the whole window: the old samples
		 * would be drawn adjacent to the new ones and read as continuous, which
		 * is a worse lie than an empty chart. Start over. */
		if (last && (nowMs - last) > SLOTS * INTERVAL * 1000)
			this.samples = [];

		this.samples.push({ t: nowMs, dl: rates.rdl, ul: rates.rul });

		while (this.samples.length > SLOTS)
			this.samples.shift();

		var stamp = summary.generated_at || (status ? status.generated_at : 0);

		dom.content(this.nodes.strip, appflow.statusStrip(status || summary, [
			stamp ? E('span', { 'class': 'af-pill' }, [
				_('Updated %s').format(appflow.fmtAgo(stamp))
			]) : null
		]));

		dom.content(this.nodes.window, [ summary.window
			? _('%d s rate window').format(appflow.num(summary, [ 'window' ]))
			: '' ]);

		this.paintThroughput(totals, rates);
		/* When a device is selected the application rows come from the
		 * flow-scoped reply rather than the global aggregate. */
		this.paintApps(summary, data.devApps);
		this.paintCategories(summary);
		this.paintDevices(data.devices, summary);
		this.paintChip();
	},

	showDown: function(err) {
		/* Deliberately NOT clearing this.samples. showDown fires on the SECOND
		 * consecutive miss, so roughly ten seconds of unavailability used to
		 * destroy five minutes of history -- and appflowd is restarted by an
		 * ordinary config change, so that was a hair trigger. paint() now drops
		 * the buffer only when the gap exceeds the chart's own window, which is
		 * the case where redrawing it really would mislead. Raised by a
		 * code review, 2026-08-25. */
		dom.content(this.downNode, appflow.notRunning(appflow.classifyFail(err), err));
		this.liveNode.style.display = 'none';
		this.downNode.style.display = '';
	},

	/* ---------------------------------------------------------- sections */

	paintThroughput: function(totals, rates) {
		dom.content(this.nodes.kpi, [
			appflow.kpi(_('Download'), appflow.fmtRate(rates.rdl), 'af-dlc'),
			appflow.kpi(_('Upload'), appflow.fmtRate(rates.rul), 'af-ulc'),
			appflow.kpi(_('Downloaded'), appflow.fmtBytes(totals.dl)),
			appflow.kpi(_('Uploaded'), appflow.fmtBytes(totals.ul))
		]);

		if (this.samples.length < 2) {
			dom.content(this.nodes.chart, appflow.placeholder(
				_('Collecting samples…')));
			return;
		}

		dom.content(this.nodes.chart, [
			appflow.lineChart([
				{ values: this.samples.map(function(s) { return s.dl; }),
				  cls: 'af-dl', fill: true },
				{ values: this.samples.map(function(s) { return s.ul; }),
				  cls: 'af-ul', fill: true }
			], {
				slots: SLOTS,
				height: 170,
				fmt: function(v) { return appflow.fmtRate(v); },
				xlabels: [ _('-%d min').format(SLOTS * INTERVAL / 60), _('now') ]
			}),
			appflow.swatches(appflow.fmtRate(this.samples[this.samples.length - 1].dl),
			                 appflow.fmtRate(this.samples[this.samples.length - 1].ul))
		]);
	},

	/* Set the filter box and repaint. Used by the category legend, so clicking
	 * a category is exactly equivalent to typing its name: the user can see
	 * what was applied, edit it, or clear it. One mechanism, not two. */
	setDevFilter: function(text) {
		this.devFilter = text || '';

		if (this.devFilterInput)
			this.devFilterInput.value = this.devFilter;

		/* Clearing the box also drops the application scope, because the two
		 * were set by one click and leaving half of it behind is how a user
		 * ends up looking at a filtered list with nothing saying why. */
		if (!this.devFilter && this.deviceFilter)
			return this.setDevice(null);

		if (this.lastDevices)
			this.paintDevices(this.lastDevices, this.lastSummary);
	},

	/* Select a device, or pass null to clear. Repaints from the live data we
	 * already hold, then refetches so the application list is scoped. */
	setDevice: function(key, name) {
		this.deviceFilter = key ? { key: key, name: name || key } : null;

		/* Fill the device box too, so the list narrows to what was selected.
		 * Clicking a device used to scope the application list while the device
		 * list carried on showing everything, so the thing just selected was
		 * not visibly selected anywhere. */
		this.devFilter = key ? (name || key) : '';
		if (this.devFilterInput)
			this.devFilterInput.value = this.devFilter;

		this.paintChip();
		this.refetch();
	},

	paintChip: function() {
		var self = this, d = this.deviceFilter;

		if (!this.nodes || !this.nodes.devChip)
			return;

		dom.content(this.nodes.devChip, d ? [
			E('span', { 'class': 'af-chip' }, [
				E('span', {}, [ _('Device: %s').format(d.name) ]),
				E('a', {
					'href': '#',
					'class': 'af-chip-x',
					'title': _('Show all devices'),
					'click': function(ev) { ev.preventDefault(); self.setDevice(null); }
				}, [ '\u00d7' ])
			])
		] : []);
	},

	/* One refetch path for both filters, so a repaint cannot lose either. */
	refetch: function() {
		var self = this;

		return this.fetch().then(function(d) { self.paint(d); });
	},

	setFilter: function(text) {
		this.filter = text || '';
		if (this.filterInput)
			this.filterInput.value = this.filter;
		if (this.lastSummary) {
			this.paintApps(this.lastSummary);
			this.refreshDevices();
		}
	},

	/* Ask the daemon for device totals restricted to the filtered applications.
	 * paintApps() must have run first, because it is what computes which keys
	 * survived.
	 *
	 * Failure is deliberately quiet: the device card keeps showing the
	 * unfiltered view rather than emptying itself, because a filter that blanks
	 * an unrelated card looks like a crash. */
	refreshDevices: function() {
		var self = this,
		    keys = this.filteredKeys;

		var call = (keys && keys.length)
			/* '' and not null for `sort`. The ubus policy types it as a string, and
			 * a null fails the policy with code 2 (Invalid argument) rather than
			 * being treated as absent. resolveDefault below then swallowed the
			 * rejection and the card silently kept its unfiltered contents, which
			 * is how this bug hid: the feature looked implemented and did
			 * nothing. */
			? appflow.rpc.devices('', TOP_DEVICES, keys)
			: appflow.rpc.devices();

		return L.resolveDefault(call, null).then(function(d) {
			if (d && self.lastSummary)
				self.paintDevices(d, self.lastSummary);
		});
	},

	paintApps: function(summary, devApps) {
		var self = this;
		this.lastSummary = summary;

		if (devApps !== undefined)
			this.lastDevApps = devApps;

		/* Device-scoped rows when a device is selected, otherwise the global
		 * aggregate. Both go through the same normalisation and the same text
		 * filter below, so the two filters compose. */
		var scoped = this.deviceFilter ? (this.lastDevApps || null) : null;

		if (this.nodes && this.nodes.appsAux)
			dom.content(this.nodes.appsAux, [ scoped
				? _('on %s, from flows in progress').format(this.deviceFilter.name)
				: _('by current rate') ]);

		var terms = appflow.parseFilter(this.filter);

		/* Filter BEFORE the top-N slice, or the filter only ever searches the
		 * ten rows that were already visible. */
		var all = appflow.toList(scoped
				? (scoped.apps || [])
				: (summary.top_apps || summary.apps))
			.map(function(a) { return appflow.normApp(a); })
			.filter(function(a) {
				return appflow.matchFilter(terms,
					[ a.label, a.key, appflow.catLabel(a.cat) ]);
			})
			/* Scoped rows have no rate, so sorting by it would order them all
			 * equal and the top-N slice would be arbitrary. */
			.sort(scoped
				? function(a, b) { return b.total - a.total; }
				: function(a, b) { return b.rate - a.rate; });

		/* Every key that survived the filter, not just the displayed rows: the
		 * device query should account for all matching traffic, not only the
		 * top eight of it. */
		this.filteredKeys = terms.length
			? all.map(function(a) { return a.key; }).filter(function(k) { return k; })
			: null;

		var apps = all.slice(0, TOP_APPS);

		if (!apps.length) {
			dom.content(this.nodes.apps, appflow.placeholder(terms.length
				? _('No application matches that filter.')
				: _('No application traffic in the current window.')));
			return;
		}

		/* UNITS CHANGE WITH THE SOURCE, AND SO MUST THE HEADINGS.
		 *
		 * The global aggregate carries rate rings, so the unscoped table shows
		 * rates. The device-scoped rows are summed from the live flow table,
		 * which holds cumulative per-flow counters and no rate ring, so there
		 * is no rate to show. Rendering them through fmtRate produced a table
		 * of zeroes: every value present, every one formatted from a field that
		 * does not exist.
		 *
		 * Computing a per-device-per-application rate would need a delta ring
		 * per pair, which is the new state this whole approach avoids. Showing
		 * bytes is the honest answer, and the column headings say which. */
		var byBytes = !!scoped,
		    fmt = byBytes ? appflow.fmtBytes : appflow.fmtRate,
		    val = byBytes
			? function(a) { return { dl: a.dl, ul: a.ul }; }
			: function(a) { return { dl: a.rdl, ul: a.rul }; };

		var peak = byBytes
			? (apps[0].total || 1)
			: (apps[0].rate || 1);

		dom.content(this.nodes.apps, E('table', { 'class': 'table af-table' }, [
			head([
				[ _('Application') ],
				[ '' ],
				[ byBytes ? _('Downloaded') : _('Download'), 'af-num' ],
				[ byBytes ? _('Uploaded') : _('Upload'), 'af-num' ]
			])
		].concat(apps.map(function(a) {
			var v = val(a);

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [ appflow.appCell(a, null, function(x) {
					self.setFilter(x);
				}) ]),
				E('td', { 'class': 'td', 'style': 'width:26%' }, [
					appflow.bar(v.dl, v.ul, peak, fmt)
				]),
				E('td', { 'class': 'td af-num' }, [ fmt(v.dl) ]),
				E('td', { 'class': 'td af-num' }, [ fmt(v.ul) ])
			]);
		}))));
	},

	paintCategories: function(summary) {
		var cats = appflow.toList(summary.top_categories || summary.categories, 'category')
			.map(function(c) {
				var t = appflow.normTotals(c);

				return {
					label: appflow.catLabel(appflow.str(c,
						[ 'category', 'category_name', 'cat', 'key', 'name', 'label' ])),
					key: appflow.str(c,
						[ 'category', 'category_name', 'cat', 'key', 'name', 'label' ]),
					/* Cumulative bytes ONLY. This used to be `t.total || t.rate`,
					 * so a category carrying a rate but a zero/absent byte total
					 * contributed a RATE into a sum of byte totals, which the
					 * doughnut centre then printed through fmtBytes under a card
					 * caption reading "top, by cumulative bytes". The fallback
					 * looked like belt-and-braces and was actually a silent unit
					 * mix; a row with no bytes is filtered out below, which is
					 * the honest outcome. Found in code review. */
					value: t.total
				};
			})
			.filter(function(c) { return c.value > 0; })
			.sort(function(a, b) { return b.value - a.value; });

		if (!cats.length) {
			dom.content(this.nodes.cats, appflow.placeholder(_('No categories yet.')));
			return;
		}

		var slices = cats.slice(0, TOP_CATEGORIES).map(function(c) {
			/* `pick` is what clicking this slice types into the filter box. The
			 * LABEL, not the key, because the filter matches on the rendered
			 * category label and the user can then read and edit it. */
			return { label: c.label, value: c.value, pick: c.label,
			         color: appflow.color(c.key) };
		});

		if (cats.length > TOP_CATEGORIES) {
			var rest = cats.slice(TOP_CATEGORIES).reduce(function(a, c) {
				return a + c.value;
			}, 0);

			if (rest > 0)
				slices.push({ label: _('Other'), value: rest, color: appflow.color('other') });
		}

		var self = this;

		dom.content(this.nodes.cats, appflow.donut(slices, {
			centerLabel: _('total'),
			/* "Other" is this view's roll-up of everything past the top N, not
			 * a category anything is tagged with, so filtering by it would
			 * match nothing. It is left unclickable rather than offered and
			 * broken. */
			onPick: function(pick) {
				if (pick !== _('Other'))
					self.setFilter(pick);
			}
		}));
	},

	paintDevices: function(devices, summary) {
		var self = this;
		/* The daemon says whether it answered from the live flow table. When it
		 * did, these are the bytes currently-tracked flows account for, NOT
		 * lifetime device totals, and the caption has to say so. */
		var fromFlows = !!(devices && devices.from_flows);

		if (this.nodes.devsAux)
			dom.content(this.nodes.devsAux, [ fromFlows
				? _('matching the filter, from flows in progress')
				: _('by cumulative bytes') ]);

		var list = appflow.toList(
			(devices && (devices.devices || devices.clients)) || devices || summary.top_devices,
			'mac');

		this.lastDevices = devices;

		var devTerms = appflow.parseFilter(this.devFilter);

		var devs = list
			.map(function(d) { return appflow.normDevice(d); })
			.filter(function(d) { return d.total > 0 || d.rate > 0; })
			/* Same matcher as the application filter, so -exclude works here
			 * too and the two boxes behave identically. */
			.filter(function(d) {
				return appflow.matchFilter(devTerms, [ d.name, d.mac, d.ip, d.key ]);
			})
			/* Cumulative bytes first, rate only as the tie-break. These were the
			 * other way round until 2026-08-25, which disagreed with this card's
			 * own caption ("top, by cumulative bytes") and with the bar beside
			 * each row, which is scaled against max(total) below. A table
			 * ordered by rate and drawn against a cumulative scale produces bars
			 * that do not shorten down the column, directly under a Top
			 * applications table that does -- both visible in one screenshot.
			 *
			 * It also chose the wrong rows: most devices sit at rate 0 at any
			 * instant, so a phone doing a 2 KB/s keepalive outranked a TV that
			 * pulled 12 GB an hour ago, and with enough devices trickling the TV
			 * left the card entirely. Found by a security/first-look review of
			 * this file, which had never been reviewed by anyone. */
			.sort(function(a, b) { return (b.total - a.total) || (b.rate - a.rate); })
			.slice(0, TOP_DEVICES);

		if (!devs.length) {
			dom.content(this.nodes.devs, appflow.placeholder(devTerms.length
				? _('No device matches that filter.')
				: _('No active devices.')));
			return;
		}

		var peak = devs.reduce(function(m, d) {
			return Math.max(m, d.total);
		}, 0) || 1;

		dom.content(this.nodes.devs, E('table', { 'class': 'table af-table' }, [
			head([
				[ _('Device') ],
				[ '' ],
				[ _('Current rate'), 'af-num' ],
				[ _('Downloaded'), 'af-num' ],
				[ _('Uploaded'), 'af-num' ]
			])
		].concat(devs.map(function(d) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'style': 'width:32%' }, [
					appflow.deviceCell(d, function(dev) { self.setDevice(dev.key, dev.name); })
				]),
				E('td', { 'class': 'td', 'style': 'width:26%' }, [
					appflow.bar(d.dl, d.ul, peak)
				]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtRate(d.rate) ]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(d.dl) ]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(d.ul) ])
			]);
		}))));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
