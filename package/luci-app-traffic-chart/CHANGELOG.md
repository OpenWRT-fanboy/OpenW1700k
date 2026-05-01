# Changelog

## 1.1.0-r12
- Renamed the SQM script `nss-rk.qos` -> `nss-trafficchart.qos` (version 0.9.4). SQM entries in
  `/etc/config/sqm` are migrated by the postinstall (`trafficchart-migrate`); SQM must be restarted by hand.
- Temporary nft file is now `/tmp/nss-trafficchart-qos.nft`.
- License: GPL-2.0-or-later, maintainer M0g13r. Added LICENSE, README, SPDX headers.
- Package Makefile with correct file modes, conffile `/etc/config/trafficchart`, enable/start on install,
  stop/disable on removal.

## 1.1.0-r11
- Previous state (no packaging).
