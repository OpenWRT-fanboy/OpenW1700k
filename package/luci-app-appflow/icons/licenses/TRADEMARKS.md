# Trademark notice

The icons shipped under `icons/root/www/luci-static/resources/appflow-icons/svg/`
depict the brand marks of third-party companies and products (Netflix,
Spotify, Microsoft, and others) that `luci-app-appflow` may detect on your
network traffic. Those marks are the property of their respective owners.

## What the collection licenses do and don't cover

`LICENSE.simple-icons` (CC0-1.0) and `LICENSE.dashboard-icons` (Apache-2.0) in
this directory license the icon *artwork/markup* as published by those
collection projects. Neither license waives, licenses, or otherwise affects
trademark rights in the marks the artwork depicts:

- CC0-1.0 says so explicitly, clause 4.1: "No trademark or patent rights held
  by Affirmer are waived, abandoned, surrendered, licensed or otherwise
  affected by this document."
- Apache-2.0 says so explicitly, clause 6: it "does not grant permission to
  use the trade names, trademarks, service marks, or product names of the
  Licensor," and separately grants no rights at all in a third party's marks
  in the first place — dashboard-icons' own project documentation describes
  its icons as used "for identification purposes only," not as a rights
  grant over each depicted brand's logo.

## Basis for using them here

This package uses each mark strictly to *label detected network traffic* for
the application it identifies — showing a Netflix icon next to a flow
netifyd has classified as `netify.netflix`, and nothing more. That is a
textbook case of **nominative fair use**: referring to a company's own
product using its own mark, in a context (interoperability / identification)
where no reasonable viewer would infer sponsorship or endorsement. This
package:

- ships upstream artwork unmodified (no recoloring or redrawing performed
  here),
- uses each icon only to identify the corresponding detected application,
- does not imply that Netify, any OpenWrt project, or the maintainer of
  `luci-app-appflow` is endorsed by, or affiliated with, any depicted brand.

This is the same basis dashboard-style projects such as Homarr and Heimdall
operate on. It is a reasonable, common-practice position — not a substitute
for legal review, and not a representation that every jurisdiction treats
nominative use identically.

## Why this is a separate package (see parent docs/DESIGN.md section 9)

`luci-app-appflow-icons` is deliberately split from `luci-app-appflow` core
for legal blast-radius isolation. Brand icons remain third-party trademarks
regardless of the collection license they were sourced under; core's
dependency on this package is entirely soft (it probes for the icon
directory at render time and falls back to letter-tile avatars when absent),
so this package can be removed without affecting core functionality in any
way.

## Takedown

If you are a rights holder and object to your mark's inclusion here, the
remedy is to ask for this package to be delisted or to have the specific
icon removed. Because the coupling to core is soft in both directions,
removing this package (or an individual icon + its `manifest.json` entry
from it) has no effect on `luci-app-appflow`'s core functionality — traffic
for the affected application(s) simply reverts to a letter-tile avatar.
