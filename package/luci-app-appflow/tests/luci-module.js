// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 VolanticSystems
//
// Load a real LuCI view module under Node, unmodified, so its exported pure
// functions can be tested without a browser.
//
// WHY THIS EXISTS. Every browser-side defect this package has had was found by
// a reviewer reading the code. Not one was found by a test,
// because no test could run any of it: LuCI view files are not CommonJS or ES
// modules, they are evaluated by LuCI's own loader with the `'require x';`
// directives intercepted. So the JavaScript half of a package whose entire
// safety promise lives in `audit()` had zero automated coverage.
//
// WHAT IS AND IS NOT STUBBED, because this is where a harness like this goes
// wrong. The stubs supply DATA and inert plumbing only:
//
//   baseclass.extend(o)  ->  returns o. LuCI returns a class whose singleton
//                            exposes the same properties; callers use it as
//                            `gen.audit()`, so a plain object is behaviourally
//                            identical for these tests.
//   uci.sections(pkg)    ->  returns the fixture array the test supplied.
//   rpc / request        ->  throw if called. Nothing under test calls them,
//                            and a stub that silently returned a plausible
//                            value would be the reimplementation trap: the
//                            test would pass against a product that had
//                            stopped asking.
//
// NO LOGIC FROM THE MODULE IS COPIED HERE. The classification, generation and
// validation code that runs is the shipped code, byte for byte.

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Strip the LuCI loader directives. They are bare string-expression statements
// at the top of the file, exactly `'require name';` or `'require name as x';`,
// and they are the only thing preventing the file from evaluating as ordinary
// JavaScript. Replaced with a blank line each so every reported line number
// still matches the real file.
// The same String.prototype.format, as SOURCE TEXT, so it can be evaluated
// inside the vm realm where the module actually runs.
const FORMAT_SRC = `
Object.defineProperty(String.prototype, 'format', {
  value: function () {
    var args = arguments, i = 0;
    return this.replace(/%(?:(\d+)\$)?([sdifj%])/g, function (m, pos, kind) {
      if (kind === '%') return '%';
      var v = args[pos ? (parseInt(pos, 10) - 1) : i++];
      if (kind === 'd' || kind === 'i') return String(parseInt(v, 10));
      if (kind === 'f') return String(parseFloat(v));
      if (kind === 'j') return JSON.stringify(v);
      return (v == null) ? '' : String(v);
    });
  }
});
`;

function stripRequires(src) {
	return src.replace(/^\s*'require [^']*';\s*$/gm, '');
}

// load(file, stubs, opts) -> the object the module returns.
//
// opts.translate replaces the _() implementation. Default is identity, which
// is LuCI's real behaviour with no catalogue loaded.
//
// WHY A NON-IDENTITY TRANSLATOR IS WORTH HAVING. With identity, a label that
// went through _() and a label a runtime title-caser produced are the same
// string, so no assertion on the OUTPUT can tell them apart. That is not
// hypothetical: three label paths shipped untranslatable underneath a green
// run of a suite that asserted exactly those outputs. Loading the module a
// second time with a marking translator makes the two observationally
// different, and equality assertions become sound again rather than
// coincidentally true. Raised in review, 2026-08-30.
function load(file, stubs, opts) {
	const translate = (opts && opts.translate) || ((s) => s);
	const src = fs.readFileSync(file, 'utf8');
	// Every string passed to _() while the module evaluates, in order. This is
	// not decoration: it lets a test assert that the shipped catalogue
	// (po/templates/*.pot) actually covers the strings the code asks for, which
	// is otherwise a claim nobody checks until a translator files a bug.
	const translated = [];

	const sandbox = Object.assign({
		baseclass: { extend: (o) => o },
		// LuCI's _() returns its msgid unchanged when no catalogue is loaded,
		// which is the default English case, so identity is the real
		// behaviour rather than a convenient stand-in.
		_: (s) => { translated.push(s); return translate(s); },
		N_: (n, s, p) => {
			translated.push(s); translated.push(p);
			return translate(n === 1 ? s : p);
		},
		L: {
			// L.resource() builds a static asset URL. It is a pure string
			// join in LuCI and is used at module top level, so it has to
			// return something or the file will not evaluate. This is the one
			// stub that returns a value rather than throwing, and it returns
			// an obviously-fake path so a test that accidentally depends on it
			// fails visibly rather than plausibly.
			resource: (...p) => '/TEST-RESOURCE/' + p.join('/'),

			// L.toArray is a LuCI RUNTIME helper, not product logic, and this
			// is a faithful copy of it from luci-base's luci.js rather than an
			// approximation. Getting it wrong would make normalize() behave
			// differently here than in a browser, which is the one way a
			// harness like this lies convincingly: the product code would be
			// real and the answer would still be wrong.
			//
			//   null/undefined -> []
			//   array          -> itself
			//   object         -> [ it ]
			//   ''             -> []
			//   otherwise      -> String(val).trim().split(/\s+/)
			toArray: (val) => {
				if (val == null) return [];
				if (Array.isArray(val)) return val;
				if (typeof val === 'object') return [ val ];
				const s = String(val).trim();
				return s === '' ? [] : s.split(/\s+/);
			},

			// Everything else throws rather than returning something
			// plausible. A stub that silently answers is how a test starts
			// passing against a product that has stopped asking.
			error: (e) => { throw new Error('L.error: ' + e); },
			raise: (e) => { throw new Error('L.raise: ' + e); }
		},
		// LuCI's DOM element factory. The real one returns a live DOM node;
		// this returns an inspectable plain tree of the same shape.
		//
		// BE HONEST ABOUT WHAT THIS CAN AND CANNOT TEST. It shows which
		// element, class and text the code CHOSE to emit, which is exactly
		// where this project's browser defects have lived: a status pill that
		// rendered "healthy" for an unknown state, a tile whose colour came
		// back undefined. It says nothing about layout, CSS cascade, or what
		// a browser finally paints. Those still need a browser.
		E: function (tag, attrs, children) {
			if (attrs != null && (typeof attrs !== 'object' || Array.isArray(attrs))) {
				children = attrs;
				attrs = {};
			}
			return {
				tag: tag,
				attrs: attrs || {},
				children: children == null ? [] : [].concat(children)
			};
		},
		console: console
	}, stubs || {});

	// The module body ends in a top-level `return`, which is only legal inside
	// a function, so wrap it in one.
	const fn = new vm.Script(
		'(function(){\n' + stripRequires(src) + '\n})()',
		{ filename: path.basename(file) }
	);
	// vm gives the module its own REALM, with its own String.prototype, so a
	// polyfill installed in Node's realm does not reach it. Build the context
	// first, install the LuCI runtime extensions INSIDE it, then evaluate.
	// Without this, product code calling '%s'.format() throws here while
	// working perfectly in a browser.
	const ctx = vm.createContext(sandbox);
	new vm.Script(FORMAT_SRC, { filename: 'luci-runtime-shim.js' }).runInContext(ctx);
	const mod = fn.runInContext(ctx);

	// Non-enumerable so it cannot be mistaken for part of the module's own
	// export surface by a test that iterates the keys.
	Object.defineProperty(mod, '__translated', {
		value: translated, enumerable: false
	});
	return mod;
}

// Every msgid in a .pot file. Used to assert the catalogue covers the strings
// the code actually asks for.
function potMsgids(file) {
	const out = new Set();
	const re = /^msgid "((?:[^"\\]|\\.)*)"/gm;
	const src = fs.readFileSync(file, 'utf8');
	let m;
	while ((m = re.exec(src)) !== null) {
		const s = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
		              .replace(/\\n/g, '\n').replace(/\\t/g, '\t');
		if (s) out.add(s);
	}
	return out;
}

// A uci stub whose sections() returns fixture data in LuCI's own shape:
// each section is a flat object of its options plus '.name' and '.type'.
function uciStub(sectionsByPackage) {
	return {
		sections: (pkg) => (sectionsByPackage[pkg] || []),
		get: (pkg, sec, opt) => {
			const list = sectionsByPackage[pkg] || [];
			const s = list.find((x) => x['.name'] === sec);
			return s ? s[opt] : undefined;
		}
	};
}

// Parse the output of `uci show <pkg>` into LuCI section objects.
//
// This is here so a fixture can be written in the SAME text the init script
// parses, rather than as hand-built objects that have quietly drifted from
// what uci actually emits. The two halves of the ownership rule are supposed
// to see the same configuration; letting them be described twice, in two
// notations, is how they stopped agreeing in the first place.
function parseUciShow(text) {
	const sections = [];
	const byName = {};
	for (const line of text.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		let m = t.match(/^([a-z0-9_-]+)\.([^.=]+)=(\S+)$/i);
		if (m) {
			const sec = { '.name': m[2], '.type': m[3] };
			byName[m[2]] = sec;
			sections.push(sec);
			continue;
		}
		m = t.match(/^([a-z0-9_-]+)\.([^.=]+)\.([^=]+)='(.*)'$/i);
		if (m && byName[m[2]]) byName[m[2]][m[3]] = m[4];
	}
	return sections;
}

// Flatten an E()-tree to its visible text, and to the set of class names used.
// Both are what a test wants to assert on: "which pill did it choose", not
// "what did the browser paint".
function textOf(node) {
	if (node == null || node === false) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	if (node.children) return node.children.map(textOf).join('');
	return '';
}

function classesOf(node, out) {
	out = out || new Set();
	if (node == null || typeof node !== 'object') return out;
	if (Array.isArray(node)) { node.forEach((n) => classesOf(n, out)); return out; }
	const c = node.attrs && (node.attrs['class'] || node.attrs.class);
	if (typeof c === 'string') c.trim().split(/\s+/).forEach((x) => x && out.add(x));
	(node.children || []).forEach((n) => classesOf(n, out));
	return out;
}

module.exports = { load, uciStub, parseUciShow, stripRequires, potMsgids, textOf, classesOf };
