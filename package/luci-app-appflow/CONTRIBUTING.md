# Contributing to luci-app-appflow

Contributions are welcome, including bug reports, and especially the two
hardware tests listed under *Where help is most useful* below.

## Reporting a problem

Useful reports include:

- Device and architecture, OpenWrt release, and `netifyd` version
  (`apk info netifyd` or `opkg info netifyd`).
- What the dashboard showed versus what you expected.
- `logread -e appflowd` output covering the period.
- `ubus call appflow status`, which reports the daemon's own counters. The
  useful ones are `flows.seen`, `flows.late`, `flows.shed`, `flows.purged`,
  `flows.no_total`, `bytes.leaked` and `aggregates.refused`; between them they
  distinguish most classes of problem immediately.
  **Do not read `flows.dropped`**: it is a last-resort backstop that no input
  can move, because the cap-pressure prune always frees space before it is
  reached. `flows.shed` is the counter that says the flow table is too small.

If the complaint is about *where bytes were attributed*, read
[docs/DESIGN.md](docs/DESIGN.md) 2.5 first. Some attribution behaviour is
measured, understood and documented rather than accidental, and knowing which
case you are looking at saves everyone time.

## Building

This repository is a single LuCI package, with its `Makefile` at the root and
`icons/` as a second package beside it. That is the same layout upstream
`openwrt/luci` uses under `applications/`, and it drops straight into an
OpenWrt SDK tree's `package/` directory, which the build system scans
recursively.

It is **not** a feed. A feed is a directory *containing* package directories,
and adding this repo directly with `src-link` produces an empty feed index.
The CI workflow stages the packages into a temporary feed directory for
exactly this reason; see `.github/workflows/build.yml`.

    # from an OpenWrt SDK tree matching your target release
    ./scripts/feeds update -a
    ./scripts/feeds install -a
    git clone https://github.com/VolanticSystems/luci-app-appflow.git \
        package/luci-app-appflow
    make package/luci-app-appflow/compile V=s
    make package/luci-app-appflow-icons/compile V=s

CI builds both packages against the OpenWrt SDK on every push and pull
request, so a build break shows up without anyone having to reproduce it
locally.

## Testing a change on a device

The daemon is a single ucode script and the views are plain JS, so the
edit/test loop does not require a rebuild:

    # syntax-check the daemon before installing it
    ucode -c /usr/sbin/appflowd

    # after replacing a view under /www/luci-static/resources/view/appflow/
    rm -f /tmp/luci-indexcache.*
    /etc/init.d/rpcd restart && /etc/init.d/uhttpd restart

Please confirm a change on real hardware before sending it. This package
talks to a DPI engine whose behaviour is version-specific, and several
plausible-looking assumptions about netifyd have already turned out to be
wrong when measured (documented in DESIGN 2.4 and 2.5).

**Then run the suites.** The JavaScript one needs only Node and runs anywhere;
the two shell suites need a sandbox router and must be run one at a time.

    node tests/frontend-suite.js      # 59 checks, no router needed
    sh   tests/protocol-suite.sh      # 104 checks, sandbox router, no traffic
    sh   tests/hardware-suite.sh      # 15 checks, sandbox router, real traffic

`protocol-suite.sh` takes a group name: conservation, protocol, bounds,
attribution, hostile, lifecycle, acl, ai, hostmap, drilldown, or all
(the default).

**`hardware-suite.sh` skips its wire-ratio check when netifyd does not
capture every default-route interface**, and says which one. That check
compares the test client's own veth counter against what appflow counted,
so it silently assumes netifyd watches the path the traffic takes. On a
router with a second uplink or a VPN outside netifyd's capture list the
ratio drops and reads exactly like an attribution defect. It is not one,
and it cost real time on 2026-08-27 before the precondition was made
explicit.

`frontend-suite.js` loads the REAL `common.js` under Node through
`tests/luci-module.js`, a small `vm.Script` loader that supplies LuCI's
runtime (`_()`, `E()`, `uci`) and nothing else. No logic from the product is
copied into it. Every check in its first three groups is a regression test for
a defect that was real, shipped and fixed: a status pill that read "connected"
from a payload carrying no evidence either way, a colour lookup that a device
named `constructor` could turn into `undefined`, and a normaliser that was not
idempotent. All three were found by people reading the code, because until
2026-08-27 no test could run any of it.

`protocol-suite.sh` repoints `appflow.socket_path` at a socket it controls and
feeds the real daemon a chosen event stream, so the byte arithmetic is checked
against hand-computed totals rather than a tolerance band, and the error paths
a real agent never produces get exercised. `hardware-suite.sh` drives real
traffic and compares against the client interface's own counter in
`/sys/class/net`, which nothing in this daemon can influence. Neither replaces
the other.

Both restore what they change on exit, including on interrupt and on a dropped
SSH session, and both take an exclusive lock: they mutate global router state
and running two at once corrupts each other's fixtures.

**If you add a check, write the sabotage first.** Every check in these files
carries a `SABOTAGE:` comment naming the smallest edit to the *product* that
turns it red, and the comment was written before the assertion. That ordering
is the point: "what does this test check" answers itself in the author's own
words, which is how a test that cannot fail gets written and then read a dozen
times without anyone noticing. If you cannot construct a red state, you have
found something more interesting than a test.

## Code style

Match the surrounding code. Specifically:

- **ucode**, not shell, for daemon logic. Note ucode's integer division and
  the requirement to declare functions before use.
- **No build step for the frontend.** The views are hand-written JS using
  LuCI's own `form`, `ui`, `rpc`, `poll` and `dom` modules, and the charts are
  hand-drawn inline SVG. Please do not introduce a bundler, a framework, or a
  charting dependency.
- Keep `appflowd`'s accounting funnelled through the single `account()` choke
  point. Byte conservation is a verified property of this package and it is
  easy to break by accounting somewhere else.
- SPDX headers on new files, Apache-2.0.

## Commits

Prefix the subject with the package name and keep it lowercase after the
colon, matching OpenWrt convention:

    luci-app-appflow: fix device table sort on equal byte counts

If you would like the change to be portable upstream to `openwrt/luci` later,
add a `Signed-off-by:` line with your real name, which is what upstream's DCO
requires.

## Translations

The string catalogue lives in `po/templates/appflow.pot`. It is generated from
the source, not written by hand: every `_('...')` call in
`htdocs/luci-static/resources/view/appflow/*.js`, plus the `title` and
`description` values in `root/usr/share/luci/menu.d/*.json` and
`root/usr/share/rpcd/acl.d/*.json`. That file selection and those keywords are
LuCI's, from `build/i18n-scan.pl` in the `openwrt/luci` tree.

To add a language, create `po/<lang>/appflow.po` from the template and
translate the `msgstr` lines. **Nothing in `Makefile` needs to change.**
`luci.mk` discovers languages by globbing `po/*`:

```make
LUCI_LANGUAGES := $(sort $(filter-out templates,$(notdir $(wildcard ${CURDIR}/po/*))))
```

and generates a `luci-i18n-appflow-<lang>` package for each one, so a new
directory is the whole of the work. The one-package-per-language split is
deliberate upstream policy, not an oversight: a router with 8 MB of flash
should not carry forty translations to use one. A combined "all languages"
package [was proposed and
rejected](https://github.com/openwrt/luci/issues/4075), because translations
depend on applications rather than the reverse and no package metadata can
express that.

Two things worth knowing before you start:

- **Keep the `%s` and `%d` specifiers, in a working order.** Several strings
  interpolate values, and a catalogue that reorders or drops one produces a
  broken sentence at best.
- **Category names are not in the template, and that is not a bug.** They
  arrive at runtime from netifyd's own `netify-categories.json`, so they exist
  in neither the JavaScript nor the daemon as literals and no scanner can find
  them. Translating them needs a source-side change first; open an issue rather
  than adding orphan `msgid` entries, which the next regeneration would delete.

If this package is ever accepted into `openwrt/luci`, translations arrive
through [Hosted Weblate](https://hosted.weblate.org/projects/openwrt/) instead
and this section stops being the interesting path.

## Where help is most useful

Two open items need hardware the author does not have. Both are documented in
[docs/DESIGN.md](docs/DESIGN.md) 8, with the exact observation that would
settle them:

1. **NAT dual-capture attribution.** Needs a real client routed *through* the
   device so netifyd produces both an internal (`br-lan`) and an external
   (`wan`) capture of the same flow. The deciding question is what netifyd
   4.4.7 puts in `local_mac` / `other_mac` when `ip_nat` is true, which
   determines whether the current rule double-counts or drops.
2. **Late re-point stranding.** If netifyd first reports a flow unclassified
   and identifies it only later, bytes counted before that point stay under
   "Unknown". This has not been observed in the wild and its magnitude is
   unmeasured. A socket capture correlating per-digest `flow` /
   `flow_stats` / detection-update ordering would settle it.

Reports of either, even without a patch, are genuinely valuable.

### A note for translators: argument order

LuCI's `format()` substitutes positionally in order, so a translation that needs
the arguments in a different order than English must say so explicitly. Use
`%1$d`, `%2$s` and so on rather than bare `%d`/`%s`:

    msgid  "%d of %d applications"        call site passes (shown, total)
    wrong  "共 %d 个应用中的 %d 个"          renders 143 of a total of 7
    right  "共 %2$d 个应用中的 %1$d 个"

**This class of bug passes every check either side can run.** Argument order is
a property of the relationship between the string and its call site, and the
call site is in another file, so a specifier count matches, a markup sweep finds
nothing, and the build is green. Found in the zh_Hans catalogue in PR #1, where
it turned "7 of 143" into "143 of a total of 7".
