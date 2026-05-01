#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 VolanticSystems
//
// appflow browser-half suite.
//
// WHY THIS FILE EXISTS. Every defect this package's frontend has had was found
// by a reviewer READING the code. Not one was found by a test,
// because until now no test could run any of it. The daemon has 54 checks
// against it and the JavaScript had none, which is backwards: the daemon
// mostly counts bytes, while the frontend is what decides whether an operator
// is told the collector is down.
//
//   usage:  node tests/frontend-suite.js
//
// Runs anywhere Node runs. No router, no browser, no network. The real
// common.js is loaded and executed by tests/luci-module.js; nothing in it is
// reimplemented here.
//
// EVERY CHECK IN THE FIRST THREE GROUPS IS A REGRESSION TEST FOR A DEFECT THAT
// WAS REAL, shipped, and fixed. They are not hypotheticals: each one names the
// date it was found and what it did to the screen.
//
// SABOTAGE COMMENTS: every check names the smallest edit to the PRODUCT that
// turns it red, written before the assertion.

'use strict';

const path = require('path');
const { load, potMsgids, textOf, classesOf } = require('./luci-module.js');

const ROOT = path.join(__dirname, '..');
const COMMON = path.join(ROOT, 'htdocs/luci-static/resources/view/appflow/common.js');
const POT = path.join(ROOT, 'po/templates/appflow.pot');
const DAEMON = path.join(ROOT, 'root/usr/sbin/appflowd');

// The category column of the daemon's AI_HOSTS table, read out of the daemon
// source itself. This is the only cross-file contract the browser half has: if
// the daemon emits a category the frontend has no key for, the label is
// untranslatable and nothing else in either suite notices.
//
// Deliberately a text scan rather than a fixture. A fixture would record what
// the daemon USED to send, which is exactly the failure being guarded against.
function daemonAiCategories() {
	const src = require('fs').readFileSync(DAEMON, 'utf8');
	const out = new Set();
	const re = /\[\s*"[^"]*"\s*,\s*"(ai-[a-z-]+|AI [a-z]+)"\s*,/g;
	let m;
	while ((m = re.exec(src)) !== null) out.add(m[1]);
	return [...out].sort();
}

let PASS = 0, FAIL = 0;

function ok(m)  { PASS++; console.log('  PASS  ' + m); }
function bad(m) { FAIL++; console.log('  FAIL  ' + m); }
function chk(desc, expected, actual) {
	const e = JSON.stringify(expected), a = JSON.stringify(actual);
	if (e === a) ok(desc); else bad(`${desc} (expected ${e}, got ${a})`);
}
function head(m) { console.log('\n=== ' + m + ' ==='); }

// rpc and request throw if touched. Nothing under test calls them, and a stub
// that answered plausibly would let a test pass against a product that had
// stopped asking.
const c = load(COMMON, {
	rpc:     { declare: (o) => () => { throw new Error('rpc called: ' + (o && o.method)); } },
	request: { get: () => { throw new Error('request called'); } }
});

// --------------------------------------------------- the status strip

head('STATUS STRIP: absent evidence is not positive evidence');

// THE DEFECT, found 2026-08-25. The test was
//   connected = (s.agent_connected !== false) && (sock.connected !== false)
// and `undefined !== false` is true, so a payload carrying neither field
// rendered a single green "Netify agent connected" pill. Overview passes
// `status || summary`, so this fired exactly when the status call FAILED: the
// one indicator whose job is to say the collector is down failed GREEN, on the
// most common reason for the page being empty.
//
// SABOTAGE for this whole group: in statusStrip(), drop the `known &&` from
// the `connected` expression, or replace `known` with `true`. The three
// unknown rows go red and the two positive rows stay green, which is the
// asymmetry that matters.
const STATES = [
	['no status at all',                  undefined,                          'af-unknown'],
	['an empty object',                   {},                                 'af-unknown'],
	// The payload that actually triggered it: a summary, passed in because the
	// status call failed. It has neither field.
	['a summary payload (the real case)', { bytes_total: 12345, top_apps: [] }, 'af-unknown'],
	['agent_connected true',              { agent_connected: true },           'af-ok'],
	['agent_connected false',             { agent_connected: false },          'af-warn'],
	// socket.connected alone IS positive evidence: it says the daemon has the
	// export socket open. `known` requires only that ONE of the two fields be
	// present, which is deliberate.
	['socket.connected true only',        { socket: { connected: true } },     'af-ok'],
	['socket.connected false only',       { socket: { connected: false } },    'af-warn']
];

for (const [label, status, wantClass] of STATES) {
	const cls = classesOf(c.statusStrip(status));
	if (cls.has(wantClass)) ok(`${label} -> ${wantClass}`);
	else bad(`${label} -> expected ${wantClass}, got [${[...cls].join(' ')}]`);
}

// And the text, because a neutral class with reassuring words is still a lie.
//
// SABOTAGE: change the unknown-state string back to "Netify agent connected".
// The class check above stays green and only this goes red.
const unknownText = textOf(c.statusStrip({ bytes_total: 1 }));
if (/unknown/i.test(unknownText)) ok('and the unknown state SAYS unknown');
else bad(`the unknown state reads "${unknownText}"`);

// -------------------------------------------- prototype-chain lookups

head('HOSTILE KEYS: a name from the wire must not reach Object.prototype');

// THE DEFECT, found 2026-08-25. CATEGORY_SLOT is an object literal, so it
// inherits Object.prototype, and a bare `CATEGORY_SLOT[s] != null` test passed
// for 'constructor', '__proto__', 'toString' and friends, indexing PALETTE
// with a function and yielding undefined. A device named `constructor`
// rendered style="background:undefined", which the browser drops: white text
// on a transparent tile, and in the doughnut the slice silently did not draw
// while its legend still claimed a percentage.
//
// `s` is attacker-influenced. It comes from a category tag, an application
// label, or a DHCP hostname, so a LAN device can choose it.
//
// SABOTAGE: in color(), replace
//   Object.prototype.hasOwnProperty.call(CATEGORY_SLOT, s)
// with a bare `CATEGORY_SLOT[s] != null`. Every row below goes red.
const HOSTILE = ['constructor', '__proto__', 'toString', 'hasOwnProperty',
                 'valueOf', 'isPrototypeOf'];

for (const key of HOSTILE) {
	const col = c.color(key);
	if (typeof col === 'string' && /^hsl\(/.test(col))
		ok(`color(${JSON.stringify(key)}) is a real colour`);
	else
		bad(`color(${JSON.stringify(key)}) returned ${JSON.stringify(col)}`);
}

// The mirror: a function that returned a fixed colour for everything would
// pass all six rows above. A known category must still get its ASSIGNED slot,
// not the hash fallback.
//
// SABOTAGE: delete the hasOwnProperty branch entirely so everything falls
// through to the hash. This goes red while the six rows above stay green.
const known = c.color('games'), other = c.color('games');
chk('a known category is stable across calls', known, other);
if (c.color('games') !== c.color('shopping'))
	ok('and different categories get different colours');
else
	bad('two different categories returned the same colour');

// -------------------------------------------------------- normalisers

head('LABELS: netifyd slugs are cased, deliberate casing is left alone');

// catLabel() used to lowercase its input before title-casing it. That is
// harmless for netifyd's own categories, which are lowercase slugs, and it
// destroyed appflow's AI categories: "AI assistants" came back as
// "Ai assistants", because the title-case split is on [-_] and a space is
// neither. It rendered that way on a live router before anyone noticed.
//
// Since 1.1.1 the daemon sends those four as slugs, so no category the daemon
// actually emits reaches the pass-through any more. It is kept because it is
// the guard for anything NOT in the table, and these two inputs exercise it
// directly.
//
// SABOTAGE: remove the /[A-Z]/ pass-through in catLabel(). The first two go
// red and the netifyd cases stay green, which is the distinction that matters.
chk('a category with deliberate capitals is left alone',
    'AI assistants', c.catLabel('AI assistants'));
chk('and so is a second one', 'AI infrastructure', c.catLabel('AI infrastructure'));

// The netifyd side must be unchanged by that pass-through.
chk('a lowercase netifyd slug is still title-cased', 'Networking', c.catLabel('networking'));
chk('and a hyphenated one still splits', 'Social Network', c.catLabel('social-network'));
chk('an empty category is still Unclassified', 'Unclassified', c.catLabel(''));

head('TILE LETTERS: a name in any script must produce a letter from that script');

// THE DEFECT, found 2026-08-31 by rendering the real component and looking at
// it. tile() stripped leading characters with /^[^0-9A-Za-z]+/, an ASCII class,
// so a name in any non-Latin script was consumed entirely and fell through to
// the '?' fallback. Every Chinese, Japanese, Korean, Russian, Greek, Arabic and
// Hebrew name rendered an identical question-mark tile.
//
// It was never a translation bug. Any LAN client with a non-Latin DHCP hostname
// hit it on every release shipped so far; accepting a zh_Hans catalogue would
// have turned an occasional case into a universal one.
//
// SABOTAGE: put the ASCII class back. The three non-Latin rows go red and every
// Latin row stays green, which is the asymmetry that matters.
chk('a Latin name is unchanged', 'R', textOf(c.tile('Router', 'Router')));
chk('and a hyphenated one', 'K', textOf(c.tile('kitchen-pi', 'kitchen-pi')));
chk('Chinese yields a Chinese character', '路',
    textOf(c.tile('路由器', '路由器')));
chk('Japanese yields a Japanese character', '日',
    textOf(c.tile('日本語', '日本語')));
chk('Cyrillic yields a Cyrillic character, upper-cased', 'Р',
    textOf(c.tile('Русский',
                  'Русский')));

// The strip must still do its job, and the fallback must still exist. A fix
// that simply removed the strip would pass every row above.
//
// SABOTAGE: delete the .replace() entirely. This row goes red.
chk('leading punctuation is still stripped', 'W', textOf(c.tile('...weird', 'x')));
// SABOTAGE: replace the '?' fallback with ''. This row goes red.
chk('a nameless tile still falls back', '?', textOf(c.tile('', 'x')));

head('LABELS ARE TRANSLATABLE, WHICH IS NOT WHAT THE CHECKS ABOVE PROVE');

// THE DEFECT, found 2026-08-30, reported by @ntbowen against 1.1.0.
//
// READ THIS BEFORE ADDING A CHECK ABOVE INSTEAD OF HERE. Every assertion in
// the group above is satisfied identically by two implementations, one of
// which is broken:
//
//     catLabel('networking') -> _('Networking')          translatable
//     catLabel('networking') -> 'networking'.replace(…)  English for ever
//
// Both return the string 'Networking', so `chk(…, 'Networking', …)` passes on
// either. The difference IS the feature, and an equality assertion cannot see
// it. Three separate label paths shipped broken underneath a green run of this
// file, including its own catalogue check, which asserts that every string
// reaching _() is in the .pot and is therefore blind by construction to a
// string that never reaches _() at all.
//
// The observable that distinguishes them is not the output, it is WHETHER _()
// WAS CALLED. tests/luci-module.js records every string the module passes to
// _() as it loads, so the assertion is membership in that set.
//
// NETIFYD_TAGS is a deliberate second copy, read off the bench from
// /etc/netify.d/netify-categories.json on netifyd 4.4.7 (32 application tags
// + 18 protocol tags, 43 unique). It must NOT be imported from the product,
// or this check becomes a tautology that compares the table with itself.
const NETIFYD_TAGS = [
	'adult', 'advertiser', 'authentication', 'business', 'cdn', 'cybersecurity',
	'database', 'device-iot', 'education', 'entertainment', 'file-server',
	'file-sharing', 'financial', 'gambling', 'games', 'government', 'hosting',
	'infrastructure', 'mail', 'malware', 'media', 'media-provider', 'messaging',
	'networking', 'news', 'os-software-updates', 'portal', 'printing', 'proxy',
	'recreation', 'reference', 'remote-desktop', 'shopping', 'social-media',
	'sports', 'streaming-media', 'technology', 'telco', 'unclassified', 'voip',
	'vpn', 'vpn-and-proxy', 'web'
];

// THE MODULE IS LOADED A SECOND TIME WITH A MARKING TRANSLATOR, and every
// check below runs against that copy rather than against `c`.
//
// The first version of this group asked "is the returned string in the set of
// strings passed to _()". That is weaker than it looks, and a panel named the
// general shape after an executed sabotage had already found one instance:
// with the default identity translator, `_('Web')` and a runtime title-caser
// both produce exactly `'Web'`, so a membership test can be satisfied by a
// COINCIDENCE between an untranslated label and some other string that did go
// through _(). It happened for real with the AI categories, where the table
// entry _('AI media') put that exact string in the set, so a daemon that had
// reverted to sending 'AI media' still passed.
//
// With `_()` returning `[[msgid]]`, a translated label and a generated one are
// different strings, and plain equality becomes a sound test again. `c` keeps
// the identity translator because every other check in this file asserts on
// real English output.
const T = (s) => `[[${s}]]`;
const t9n = load(COMMON, {
	rpc:     { declare: (o) => () => { throw new Error('rpc called: ' + (o && o.method)); } },
	request: { get: () => { throw new Error('request called'); } }
}, { translate: T });

// __translated still records the ARGUMENT to _(), not its return, so the
// catalogue check further down is unaffected by the marking translator.
const translated = new Set(c.__translated.filter(Boolean));

// A check over an empty set passes vacuously. Refuse to report on one, the
// same way the catalogue check below does.
if (translated.size === 0) {
	bad('the run reached NO _() strings, so nothing below proves anything');
} else if (t9n.normDevice({}).name !== T('Unknown device')) {
	// If the marking translator is not actually reaching the product, every
	// equality check below would compare English with English and pass while
	// proving nothing. Prove the instrument works before trusting it.
	//
	// ANCHOR THIS ON A STRING THAT IS NOT IN EITHER TABLE UNDER TEST. The
	// first version probed catLabel('web'), which is one of the very entries
	// these checks exist to police: unwrapping that entry to `'web': 'Web'`
	// made the probe fail, so a real product defect reported itself as a
	// broken instrument and skipped the nine checks that would have named it.
	// normDevice's fallback is translated on a path no check below asserts on.
	bad('the marking translator had no effect, so nothing below proves anything');
} else {
	// SABOTAGE: delete any one entry from CATEGORY_LABELS in common.js, or
	// write it unwrapped as `'web': 'Web'`. The title-caser still returns the
	// same English text and every equality check above stays green; this goes
	// red and names the tag.
	const untranslatable = NETIFYD_TAGS.filter((t) => t9n.catLabel(t) !== T(c.catLabel(t)));
	if (untranslatable.length === 0)
		ok(`all ${NETIFYD_TAGS.length} netifyd category tags return the translator's output`);
	else
		bad(`${untranslatable.length} category tag(s) produce a label _() never saw, `
		    + `so they are English in every language: ${JSON.stringify(untranslatable)}`);

	// Every one of those labels must also be in the shipped catalogue. The
	// check above proves _() was called; this proves the extractor saw it.
	//
	// SABOTAGE: add a category entry to common.js without regenerating the
	// .pot. This goes red; the check above stays green.
	const catalogue = potMsgids(POT);
	const uncatalogued = NETIFYD_TAGS.map((t) => c.catLabel(t))
	                                  .filter((s) => !catalogue.has(s));
	if (uncatalogued.length === 0)
		ok('and every one of those labels is in appflow.pot');
	else
		bad(`${uncatalogued.length} label(s) reach _() but are not in the catalogue: `
		    + JSON.stringify(uncatalogued.slice(0, 5)));

	// The daemon's own AI categories, which is where WE introduced this bug
	// rather than inheriting it. Until 1.1.1 appflowd sent 'AI assistants' and
	// three siblings as rendered English, and catLabel returned them untouched.
	//
	// TWO ASSERTIONS, AND THE FIRST ONE IS NOT REDUNDANT. The membership test
	// alone cannot catch this: catLabel('AI media') falls through the
	// pass-through and returns 'AI media' unchanged, and that exact string IS
	// in the translated set, because the table entry 'ai-media': _('AI media')
	// put it there. So a daemon that reverted to display strings would satisfy
	// a membership check while being exactly as broken as before. That was the
	// first version of this check and an executed sabotage caught it, which is
	// the only reason it is written this way.
	//
	// SABOTAGE A: change one AI_HOSTS category in appflowd back to a display
	// string, e.g. 'ai-media' -> 'AI media'. The shape check goes red.
	// SABOTAGE B: change one to a slug with no table entry, e.g. 'ai-video'.
	// The membership check goes red.
	const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
	const daemonCats = daemonAiCategories();
	if (daemonCats.length < 4) {
		bad(`read only ${daemonCats.length} AI categories out of appflowd; expected 4`);
	} else {
		const shaped = daemonCats.filter((t) => !SLUG.test(t));
		if (shaped.length === 0)
			ok(`all ${daemonCats.length} AI categories the daemon emits are lowercase slugs`);
		else
			bad(`the daemon emits pre-rendered display string(s) ${JSON.stringify(shaped)}; `
			    + 'a category that arrives already in English has no key to look up');

		const unknown = daemonCats.filter((t) => t9n.catLabel(t) !== T(c.catLabel(t)));
		if (unknown.length === 0)
			ok(`and the frontend has a _() label for all ${daemonCats.length} of them`);
		else
			bad(`the daemon emits ${JSON.stringify(unknown)}, which the frontend `
			    + 'has no CATEGORY_LABELS entry for');
	}

	// The three synthetic pseudo-devices. The daemon sends their display name
	// already rendered in English because it has no idea what language the
	// browser wants, so the frontend must name them from the stable key.
	//
	// The fixture's `name` is deliberately the real English the daemon sends,
	// not a marker string: a lookup keyed on the name rather than the key is a
	// plausible implementation and would pass against a fixture that could not
	// satisfy it.
	//
	// SABOTAGE: delete an entry from DEVICE_LABELS, key the lookup on the
	// daemon's name instead of t.key, or misspell a key. This goes red.
	[ [ 'router', 'Router' ],
	  [ 'unknown', 'Unknown' ],
	  [ 'multicast', 'Multicast / Broadcast' ] ].forEach(function(pair) {
		const key = pair[0], english = pair[1];
		const got = t9n.normDevice({ key: key, name: english }).name;
		if (got === T(english))
			ok(`pseudo-device '${key}' is named through _(), not from the daemon's English`);
		else
			bad(`pseudo-device '${key}' rendered ${JSON.stringify(got)}, `
			    + `expected the translated ${JSON.stringify(T(english))}`);
	});

	// A real device must NOT be captured by that table, even when its DHCP
	// hostname is exactly the English of a pseudo-device. This is the check
	// that a name-keyed implementation fails.
	//
	// SABOTAGE: index DEVICE_LABELS by the daemon's name rather than t.key.
	[ 'kitchen-pi', 'Router', 'Multicast / Broadcast' ].forEach(function(name) {
		const got = t9n.normDevice({ key: 'b4:2e:99:3a:d6:df',
		                             mac: 'b4:2e:99:3a:d6:df', name: name }).name;
		if (got === name)
			ok(`a real device named ${JSON.stringify(name)} keeps its own name`);
		else
			bad(`a real device named ${JSON.stringify(name)} was renamed to `
			    + `${JSON.stringify(got)} by the pseudo-device table`);
	});
}

// Both label tables are plain object literals, so they inherit
// Object.prototype and a bare lookup on an inherited key returns a truthy
// non-string. t.name is assumed to be a string by the .toUpperCase() two lines
// later in normDevice, and a label is assumed to be a string by every caller.
//
// Raised independently by two reviewers against the contributor's patch, which
// used a bare `DEVICE_LABELS[key] ||` lookup. color() in the same file already
// guarded its own table this way; catLabel() did not.
//
// THESE PROBES FEED HOSTILE INPUT, SO THEY MUST NOT BE ALLOWED TO THROW
// UNCAUGHT. Removing the guard makes normDevice raise a TypeError rather than
// return a bad value, and an uncaught throw here would abort the whole file:
// node prints a stack trace, every later check never runs, and the summary
// line that says how many passed is never printed at all. The run is still red
// by exit code, but "red" and "red naming the defect, with the other 60 checks
// still reported" are different things. attempt() turns a throw into a named
// failure and lets the suite finish.
//
// SABOTAGE: replace either hasOwnProperty guard with a bare truthiness test.
// Every probe below goes red, by value for catLabel and by throw for
// normDevice, and the checks after this block still report.
function attempt(desc, fn) {
	let v;
	try {
		v = fn();
	} catch (e) {
		bad(`${desc} threw ${e && e.name}: ${e && e.message}`);
		return;
	}
	if (typeof v === 'string') ok(desc);
	else bad(`${desc} produced a ${typeof v}, not a string`);
}

[ '__proto__', 'constructor', 'toString', 'hasOwnProperty' ].forEach(function(k) {
	attempt(`catLabel(${JSON.stringify(k)}) returns a string`,
	        () => c.catLabel(k));
	attempt(`normDevice key ${JSON.stringify(k)} names a string`,
	        () => c.normDevice({ key: k, mac: 'aa:bb:cc:dd:ee:ff' }).name);
});

head('NORMALISERS: idempotent, and never inventing a total');

// THE DEFECT, found 2026-08-25. normSeries() was not idempotent and one caller
// normalised twice. The second pass read the already-renamed fields, found
// nothing, and produced {dl:0, ul:0, total:<real>}: a total contradicting its
// own parts. The chart drew empty while the "no data" message stayed
// suppressed, because `total` was non-zero.
//
// SABOTAGE: remove 'dl' and 'ul' from the alias lists the normaliser accepts.
// The second pass zeroes them and this goes red.
const rawSeries = [{ time: 1, dl: 10, ul: 5 }, { time: 2, dl: 20, ul: 10 }];
const once = c.normSeries(rawSeries);
const twice = c.normSeries(once);
chk('normSeries is idempotent', once, twice);

// SABOTAGE: change the `(tot >= 0) ? tot : dl + ul` fallback to a constant.
chk('a point with no explicit total gets dl+ul', 15, once[0].total);
chk('and the parts survive', [10, 5], [once[0].dl, once[0].ul]);

// The invariant that would have caught the original defect on its own, stated
// as an invariant rather than as a value: parts and total must not contradict.
const contradictions = twice.filter((p) => p.dl === 0 && p.ul === 0 && p.total > 0);
chk('no point claims a total while both parts are zero', [], contradictions);

// SABOTAGE: make normSeries() return its input unchanged. The empty and
// absent cases stop being normalised and this goes red.
chk('normSeries(null) is an empty list', [], c.normSeries(null));
chk('normSeries(undefined) is an empty list', [], c.normSeries(undefined));

head('HELPERS: the accessors every view depends on');

// SABOTAGE for each: change the default-value branch of num()/str()/toList()
// so a miss returns something other than the supplied default.
chk('num() finds a value by alias', 5, c.num({ a: 5 }, ['x', 'a'], 0));
chk('num() returns the default on a miss', 42, c.num({}, ['nope'], 42));
chk('num() returns the default on a non-number', 7, c.num({ a: 'xyz' }, ['a'], 7));
chk('str() returns the default on a miss', 'dflt', c.str({}, ['nope'], 'dflt'));
chk('toList(null) is empty', [], c.toList(null));
chk('toList of an array is itself', [1, 2], c.toList([1, 2]));

// toList over an object keyed by name must carry the key through, or every
// per-device row loses its identity.
//
// SABOTAGE: drop the keyField assignment in toList(). This goes red.
const keyed = c.toList({ 'aa:bb': { bytes: 1 } }, 'mac');
chk('toList carries the object key into the named field', 'aa:bb', keyed[0] && keyed[0].mac);

// ---------------------------------------------------------- catalogue

head('FILTER: include, exclude, and the shapes a half-typed term takes');

// WHY THIS GROUP EXISTS. The filter is the only way to make a busy dashboard
// legible, and the question that produced it was concrete: one streaming
// session buried everything else and there was no way to look past it.
//
// Both views share this logic precisely so they cannot drift, and it lives in
// common.js rather than inside a render function so a test can reach it at all.
// The classifier lesson from the sibling package: logic that decides something
// belongs where Node can load it.

// A term matches the application label, its key, or its category label. Those
// are the three strings a person could plausibly be typing at.
const FIELDS = {
	claude:  [ 'Anthropic (Claude)', 'ai:anthropic-claude', 'AI assistants' ],
	openai:  [ 'OpenAI', 'ai:openai', 'AI assistants' ],
	netflix: [ 'Netflix', 'a145', 'Streaming Media' ],
	http:    [ 'HTTP/S', 'p196', 'Web' ]
};

const pass = (text, row) => c.matchFilter(c.parseFilter(text), FIELDS[row]);

// An empty filter passes everything. This is the unfiltered case and must not
// be special-cased by any caller.
//
// SABOTAGE: make matchFilter return false for an empty term list. Every view
// renders an empty table on load, which is as broken as it sounds.
chk('an empty filter passes everything', [ true, true, true, true ],
    [ 'claude', 'openai', 'netflix', 'http' ].map((r) => pass('', r)));

// Matching is case-insensitive and matches any of the three fields.
chk('a term matches the application label', true,  pass('netflix', 'netflix'));
chk('and is case-insensitive',              true,  pass('NeTfLiX', 'netflix'));
chk('a term matches the CATEGORY label',    true,  pass('ai assistants', 'claude'));
chk('a partial category matches',           true,  pass('ai', 'claude'));
chk('a term matches the internal key',      true,  pass('p196', 'http'));
chk('a term that matches nothing excludes', false, pass('netflix', 'claude'));

// EXCLUSION. This is the case the whole feature exists for: "show me
// everything except the thing that is burying the view". An include-only
// filter cannot express it, because you would have to already know what you
// wanted to keep.
//
// SABOTAGE: drop the leading-minus branch in parseFilter so '-netflix' is
// treated as an ordinary term. The two checks below invert.
chk('a minus term removes the row it matches',  false, pass('-netflix', 'netflix'));
chk('and leaves every other row alone',         true,  pass('-netflix', 'claude'));

// Terms combine with AND, so each one narrows. Mixing include and exclude is
// the useful case: this category, except that member of it.
//
// SABOTAGE: change every() to some() in matchFilter. The first goes true.
chk('include and exclude combine',        false, pass('ai -claude', 'claude'));
chk('and the combination still includes', true,  pass('ai -claude', 'openai'));
chk('two includes both have to match',    false, pass('ai netflix', 'claude'));

// A bare '-' is what a half-typed exclusion looks like. Treating it as
// "exclude everything" would blank the table between two keystrokes.
//
// SABOTAGE: remove the final filter() in parseFilter that drops empty terms.
chk('a bare minus is ignored, not treated as exclude-all',
    [ true, true ], [ pass('-', 'claude'), pass('-', 'netflix') ]);
chk('and so is stray whitespace', true, pass('   ', 'claude'));

// Nulls and absent fields must not throw: a row can legitimately have no
// category, and normApp fills what it can.
//
// SABOTAGE: drop the null guard in matchFilter's field join.
chk('a row with missing fields does not throw', false,
    c.matchFilter(c.parseFilter('claude'), [ null, undefined, '' ]));
chk('and still matches on the field it does have', true,
    c.matchFilter(c.parseFilter('claude'), [ null, 'Anthropic (Claude)', undefined ]));

head('DEVICE IDENTITY: the key the drill-down is addressed by');

// normDevice DROPPED the daemon's device key. Every call site that needed it
// got undefined, so clicking a device cleared the selection instead of setting
// it: no error, no effect, a feature that looked wired and was not. Three bugs
// in one evening had that exact shape.
//
// SABOTAGE: remove `t.key = ...` from normDevice. This goes red and nothing
// else does, which is precisely why it had to be added.
{
	const d = c.normDevice({ key: 'b4:2e:99:3a:d6:df', mac: 'b4:2e:99:3a:d6:df',
	                         ip: '192.168.72.20', name: 'Stang', bytes_total: 10 });

	chk('normDevice carries the daemon key through', 'b4:2e:99:3a:d6:df', d.key);
	chk('and still carries name, mac and ip', [ 'Stang', 'B4:2E:99:3A:D6:DF', '192.168.72.20' ],
	    [ d.name, d.mac, d.ip ]);
}

// The pseudo-devices have no MAC at all, so a fallback to mac/ip would leave
// them unaddressable. The daemon's key is what they are called.
//
// SABOTAGE: change the key preference order so mac wins over key.
{
	const d = c.normDevice({ key: 'router', name: 'Router', bytes_total: 5 });

	chk('a pseudo-device is addressed by its key', 'router', d.key);
}

head('CLICKABLE CELLS: a label that names a thing is a way to see it');

// appCell and deviceCell take an onPick callback. Without one they render
// exactly as before, so nothing that does not want the behaviour gets it.
//
// SABOTAGE: make appCell add af-pick unconditionally. The first check goes red,
// and every table that never wanted click targets grows them.
{
	const plain = c.appCell({ label: 'Netflix', key: 'a145', cat: 'streaming-media' });
	chk('without a callback an app cell is not clickable',
	    false, /af-pick/.test(JSON.stringify(plain)));

	const picked = [];
	const live = c.appCell({ label: 'Netflix', key: 'a145', cat: 'streaming-media' },
	                       null, (v) => picked.push(v));
	chk('with a callback it is', true, /af-pick/.test(JSON.stringify(live)));
}

// A device cell with a callback is clickable and passes the whole device
// object, because the caller needs both the key (to query) and the name (to
// show in the chip).
//
// SABOTAGE: have deviceCell pass dev.name instead of dev. The drill-down then
// queries by name, which is not what the daemon keys on.
{
	const plain = c.deviceCell({ name: 'Stang', mac: 'B4:2E:99:3A:D6:DF', key: 'b4:2e' });
	chk('without a callback a device cell is not clickable',
	    false, /af-pick/.test(JSON.stringify(plain)));

	const live = c.deviceCell({ name: 'Stang', mac: 'B4:2E:99:3A:D6:DF', key: 'b4:2e' },
	                          () => {});
	chk('with a callback it is', true, /af-pick/.test(JSON.stringify(live)));
}

head('THE STRING CATALOGUE COVERS WHAT THE CODE ASKS FOR');

// SABOTAGE: add a `_('some new string')` anywhere in common.js without
// regenerating po/templates/appflow.pot. This goes red. Without it the
// catalogue rots silently the moment anyone adds a message, and nobody finds
// out until a translator does.
const pot = potMsgids(POT);
const seen = new Set(c.__translated.filter(Boolean));

// A catalogue check over an empty set proves nothing, so refuse to report a
// pass on one.
if (seen.size === 0) {
	bad('the run reached NO _() strings, so this check proved nothing');
} else {
	const missing = [...seen].filter((x) => !pot.has(x));
	if (missing.length === 0)
		ok(`all ${seen.size} strings reached by this run are in the catalogue`);
	else
		bad(`${missing.length} of ${seen.size} not in appflow.pot: `
		    + JSON.stringify(missing.slice(0, 5)));
}

// The catalogue must also not be EMPTY or trivially small, which would make
// the check above pass while covering nothing.
//
// SABOTAGE: truncate appflow.pot. This goes red.
if (pot.size >= 100) ok(`the catalogue holds ${pot.size} msgids`);
else bad(`the catalogue holds only ${pot.size} msgids; expected the full extraction`);

console.log('\n----------------------------------------');
console.log(`passed ${PASS}, failed ${FAIL}`);
process.exit(FAIL);
