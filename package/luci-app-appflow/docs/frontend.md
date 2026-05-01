# AppFlow frontend

- `common.js`: shared class (`require view.appflow.common as appflow`); ubus bindings, payload normalizers, byte/rate formatting, category colors, the icon probe, SVG chart primitives, injected CSS.
- `overview.js`: Overview (live). Polls `summary`+`devices`+`status` every 5 s; the 60-sample chart window lives in the view, not the daemon.
- `statistics.js`: Statistics (past hour). Polls `stats {range:"hour"}` every 15 s; search, sort and the detail drawer are client-side; `reset` sits behind a confirm dialog.
- Menu: `root/usr/share/luci/menu.d/luci-app-appflow.json`, top-level `admin/appflow` firstchild node gated on the `luci-app-appflow` ACL group.

Conventions: charts are hand-drawn SVG (`lineChart`/`columnChart`/`donut`) so they inherit the theme's CSS variables and read on both bootstrap themes; `luci-lib-chartjs` is unused (its shipped build ships Doughnut/Pie only, no Line/Bar). All CSS is prefixed `af-` and injected once via `appflow.injectCSS()`.
Every payload field is read through `normApp`/`normDevice`/`normTotals`/`normSeries`, which absorb the daemon's two dialects (`bytes_down`/`rate_down` on live aggregates, `download`/`upload` on range views); tighten those alias lists once the DESIGN §5 contract freezes instead of reaching into payloads from the views.
Icons are an optional soft dependency (DESIGN §9): `loadIcons()` probes `/luci-static/resources/appflow-icons/manifest.json` once per page load from each view's `load()`, keyed by the row's netify `tag`; if the sibling package is absent the probe resolves silently and every tile stays a letter tile. `simple-icons` entries are fill-less glyphs and get whitened over the category-colored tile; other sources render as-is. Category colors come from the fixed `CATEGORY_SLOT` table (hash fallback) so the doughnut legend never shows two identical swatches.
Both views build their skeleton once and repaint only inner nodes, so the search box keeps focus and caret across polls; each keeps a `fails` counter so one dropped poll does not flash the "appflowd is not running" screen.
