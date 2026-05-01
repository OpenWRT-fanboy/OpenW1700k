# luci-app-appflow-icons

Optional, separately-installable brand icon pack for
[`luci-app-appflow`](../README.md). See parent `docs/DESIGN.md` section 9 for
the roadmap item and rationale this package implements.

## What it is

`luci-app-appflow` identifies per-application traffic using the Netify Agent
(netifyd) and, on its own, renders every detected application as a
letter-tile avatar colored by category. This package adds real icons,
Netflix, YouTube, Spotify, Microsoft, and 97 other recognizable brands, for
the applications netifyd can actually detect, so the dashboard reads more
like a vendor DPI screen and less like a spreadsheet.

**It is entirely optional.** Installing it changes only how already-detected
traffic is drawn; it adds no detection logic, no new dependency, and no
attack surface beyond static file serving. Removing it drops the dashboard
back to letter-tile avatars, nothing else changes. Core `luci-app-appflow`
has no package dependency on this pack (`LUCI_DEPENDS:=` is deliberately
empty); the coupling is runtime-soft in both directions:

- core probes for `appflow-icons/manifest.json` at render time and falls
  back cleanly when this package is absent;
- this package depends on nothing and does nothing but ship static files,
  it breaks nothing if `luci-app-appflow` itself is ever removed or updated
  incompatibly.

That soft coupling is deliberate legal blast-radius isolation: every icon
here is a redrawing of a third party's trademark (see
[`licenses/TRADEMARKS.md`](licenses/TRADEMARKS.md)), so if a rights holder
ever objects, this package is delisted or trimmed on its own, core is
untouched either way.

## What's in the box

| | |
|---|---|
| Applications with an icon | 101 (of 416 in the Netify Agent free signature set) |
| Unique SVG files shipped | 95 (a few app tags share one icon, e.g. `WhatsApp` and `WhatsApp/Call` both use the WhatsApp mark) |
| Total SVG payload | 124,590 bytes (~122 KiB) |
| Source: simple-icons (CC0-1.0) | 75 unique files / 78 manifest entries |
| Source: dashboard-icons (Apache-2.0) | 20 unique files / 23 manifest entries |

simple-icons was preferred whenever both catalogs had a valid match, since
its CC0-1.0 collection license is unambiguous; dashboard-icons filled the
remainder. See [`licenses/LICENSE.simple-icons`](licenses/LICENSE.simple-icons)
and [`licenses/LICENSE.dashboard-icons`](licenses/LICENSE.dashboard-icons) for
the full license text and per-source scope notes, and
[`licenses/TRADEMARKS.md`](licenses/TRADEMARKS.md) for why a permissive
collection license is not the same thing as a trademark clearance.

## Layout

```
icons/
├── Makefile                                        # LuCI feed style, PKGARCH:=all, no deps
├── README.md                                        # this file
├── CHECKSUMS.sha256                                  # sha256 of every shipped svg + manifest.json
├── licenses/
│   ├── LICENSE.simple-icons                          # CC0-1.0 + source URL + scope note
│   ├── LICENSE.dashboard-icons                       # Apache-2.0 + source URL + scope note
│   └── TRADEMARKS.md                                 # nominative-use rationale + takedown note
└── root/www/luci-static/resources/appflow-icons/
    ├── manifest.json                                 # {"<netify tag>": {"file": "<svg>", "source": "..."}}
    └── svg/                                           # 95 SVG files, source__slug.svg naming
```

`root/` mirrors the LuCI feed convention used by the parent package
(`include $(TOPDIR)/feeds/luci/luci.mk` copies its contents verbatim onto
the target filesystem), landing everything under
`/www/luci-static/resources/appflow-icons/` on the router, a normal LuCI
static-resource path, servable and cacheable exactly like any other
`luci-static` asset, no server-side code involved.

## manifest.json contract

`manifest.json` is keyed by the exact application **tag string** netifyd's
`definitions` event reports (the same string `luci-app-appflow`'s frontend
already receives at runtime, e.g. `"netify.netflix"` for Netify's own
namespaced app ids, or a plain tag like `"Spotify"` for nDPI protocol-space
ids, see parent `docs/DESIGN.md` section 2.3 for the two id spaces). Each
value names the icon file relative to `svg/` and which collection it came
from:

```json
{
  "netify.netflix": { "file": "simple-icons__netflix.svg", "source": "simple-icons" },
  "Skype/Teams/Call": { "file": "dashboard-icons__skype.svg", "source": "dashboard-icons" }
}
```

A consumer only needs to look up the detected tag in this object; a miss
means "no icon shipped for this app," which is the expected, common case
(315 of 416 detectable applications have none) and should fall back to a
letter-tile avatar exactly as when this package isn't installed at all.

## Regenerating / extending this pack

The id-to-icon mapping was curated offline against a `definitions` event
captured from Netify Agent 4.4.7 (416 applications), matched by exact/
normalized name against the simple-icons and dashboard-icons slug catalogs,
with no fuzzy or guessed matches, anything ambiguous (15 applications) was
left out rather than auto-picked, and only the ~100 most household-
recognizable matches ("tier1") were selected for actual SVG download and
inclusion in this package; the remainder of the matched set ("tier2", 73
applications) was identified but not bundled. `manifest.json` in this
package is the tier1-only, validated output of that pass: every entry here
was checked at build time to (a) reference an SVG file that exists on disk
and parses as well-formed XML with an `<svg>` root, and (b) use a tag that
is actually present in the current `detectable-apps` extraction, anything
failing either check is dropped rather than shipped. To extend coverage
(add tier2 apps, or re-run against a newer netifyd's signature set), repeat
that curation pass and re-run the same validation before regenerating
`manifest.json` and `CHECKSUMS.sha256`.

## Verifying the shipped files

```sh
cd icons
sha256sum -c CHECKSUMS.sha256
```
