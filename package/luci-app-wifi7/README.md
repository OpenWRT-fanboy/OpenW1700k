# luci-app-wifi7

**Release Candidate v2.1.0** — LuCI module for WiFi 7 (MT7996) — adds **Network > WiFi 7** to your OpenWrt interface.

## ⚠️ Requirements

This module requires **OpenWrt with MTK SDK** (e.g. [woziwrt/bpi-r4-deploy](https://github.com/woziwrt/bpi-r4-deploy)).

Specifically designed for the MTK SDK WiFi stack — will **not work** with mainline OpenWrt. Interface naming, MLD configuration and hostapd parameters differ significantly from mainline.

## Confirmed hardware

| Device | Chip | Status |
|--------|------|--------|
| Banana Pi BPI-R4 | MT7988A + MT7996 | ✅ Primary test device (4GB + 8GB) |
| W1700K | MT7996 | ✅ Confirmed working |

Tested on: OpenWrt 25.12-SNAPSHOT, LuCI 26.118.65222~15aabe7

## Features

### Overview tab
- Live MLD link cards per network — channel, bandwidth, TX power, channel utilization, UP/DOWN status
- Multiple MLD networks displayed dynamically (all configured MLD SSIDs)
- SKU regulation 3-state banner — inactive / partially configured / active
- ACS selected channel displayed live when channel=auto
- Legacy networks list with encryption info

### MLD config tab
- Edit MLD SSID, password, encryption, RSNO layer
- MLO enable/disable with reboot warning
- Per-link info — addresses, TX max per link (hidden when MLO disabled)
- EMLSR status display
- **Add MLD network wizard** — create additional MLD networks with SSID, password, encryption, radio selection

### Radio tab
- Channel, HT mode, TX power per radio (2.4G / 5G / 6G)
- Country + sku_idx always written together (MTK requirement)
- DFS enhanced — distinguishes standard DFS (CAC 60s) from weather radar channels (CAC 10 min ETSI)
- ACS selected channel display
- Country change reboot warning
- Per-radio: `noscan`, `background_radar`, `lpi_enable`, `he_twt_responder` (TWT), `legacy_rates`
- Advanced shared (single wiphy): `sr_enable` (Spatial Reuse / BSS Coloring), `etxbfen` (TX beamforming)
- Radio disable confirm dialog (warns about MLO link ID renumbering)

### Networks tab
- Add/Remove legacy networks with smart defaults per band (6G enforces SAE automatically)
- Network bridge assignment — lan / wan / guest / iot / custom
- Per-network: Hidden SSID, Client isolation, Max clients (maxassoc), WMM
- OWE Transition mode (Open + Enhanced Open simultaneously)
- Encryption options including OWE, OWE Transition, WPA3-SAE, WPA2/WPA3 mixed
- Remove network warning — warns if MLD uses the same radio

### Stations tab
- Live client list for all MLD networks and all legacy interfaces — dynamic, no hardcoded interfaces
- MLD clients with per-link signal, TX/RX bitrate, peer MAC
- Signal quality color coding — green ≥ -65 dBm / orange ≥ -75 dBm / red < -75 dBm
- WiFi mode badges (BE / AX / AC / N / G)
- Auto-refresh every 10 seconds

### Diagnostics tab
- Firmware version, kernel version (dynamic from `/proc/version`)
- SKU regulation status (consistent with Overview banner)
- Thermal monitoring — named zones (cpu-thermal, etc.)
- Collapsible txpower_info per band — collapsed by default, state persists across auto-refresh
- mt76_links_info — MLO internal topology (master link, valid links bitmap, per-link bss_idx/wcid/channel/BW)
- Per-link current TX power (from debugfs)
- DFS status, MAT table
- Log collection button — downloads dmesg WiFi + logread as .txt

## Installation

### Quick install (pre-built APK)

Download the latest APK from [Releases](https://github.com/woziwrt/luci-app-wifi7/releases):

```bash
# Download and install directly on router
ssh root@192.168.1.1 "wget -O /tmp/luci-app-wifi7.apk \
  https://github.com/woziwrt/luci-app-wifi7/releases/download/v2.1.0-luci/luci-app-wifi7-1.0.0-r20260503.apk \
  && apk add --allow-untrusted /tmp/luci-app-wifi7.apk \
  && /etc/init.d/rpcd restart"
```

Or copy manually:
```bash
scp luci-app-wifi7-1.0.0-r20260503.apk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 "apk add --allow-untrusted /tmp/luci-app-wifi7-1.0.0-r20260503.apk && /etc/init.d/rpcd restart"
```

Then open **Network > WiFi 7** in LuCI. Hard reload (Ctrl+Shift+R) if menu doesn't appear.

### Manual deploy (from source)

```bash
git clone https://github.com/woziwrt/luci-app-wifi7.git
cd luci-app-wifi7

scp -O htdocs/luci-static/resources/view/wifi7/index.js \
    root@192.168.1.1:/www/luci-static/resources/view/wifi7/

scp -O root/usr/share/luci/menu.d/luci-app-wifi7.json \
    root@192.168.1.1:/usr/share/luci/menu.d/

scp -O root/usr/share/rpcd/acl.d/luci-app-wifi7.json \
    root@192.168.1.1:/usr/share/rpcd/acl.d/

ssh root@192.168.1.1 "/etc/init.d/rpcd restart"
```

### Build from source (OpenWrt build system)

```bash
cd /your/openwrt/build/dir

# Add feed
echo "src-git wifi7 https://github.com/woziwrt/luci-app-wifi7.git" >> feeds.conf.default
./scripts/feeds update wifi7
./scripts/feeds install luci-app-wifi7

# Copy to luci feed
cp -r feeds/wifi7/* feeds/luci/applications/luci-app-wifi7/
ln -sf ../../../feeds/luci/applications/luci-app-wifi7 package/feeds/luci/luci-app-wifi7
echo "CONFIG_PACKAGE_luci-app-wifi7=m" >> .config

# IMPORTANT: copy index.js into build_dir before compile (cache issue)
cp feeds/luci/applications/luci-app-wifi7/htdocs/luci-static/resources/view/wifi7/index.js \
   build_dir/target-aarch64_cortex-a53_musl/luci-app-wifi7/root/www/luci-static/resources/view/wifi7/index.js
cp feeds/luci/applications/luci-app-wifi7/htdocs/luci-static/resources/view/wifi7/index.js \
   build_dir/target-aarch64_cortex-a53_musl/luci-app-wifi7/ipkg-all/luci-app-wifi7/www/luci-static/resources/view/wifi7/index.js

# Build
make package/feeds/luci/luci-app-wifi7/compile V=s

# APK: bin/packages/aarch64_cortex-a53/luci/luci-app-wifi7-1.0.0-r20260503.apk
```

## Feedback & bug reports

- **GitHub Issues**: [github.com/woziwrt/luci-app-wifi7/issues](https://github.com/woziwrt/luci-app-wifi7/issues)
- **OpenWrt Forum**: [BPI-R4 MTK-SDK thread](https://forum.openwrt.org/t/banana-bpi-r4-all-related-to-mtk-sdk/221080)
- **BPI Forum**: [BPI-R4 thread](https://forum.banana-pi.org)

## Related projects

- Build system: [woziwrt/bpi-r4-deploy](https://github.com/woziwrt/bpi-r4-deploy)
- UniFi stack: [woziwrt/bpi-r4-unifi](https://github.com/woziwrt/bpi-r4-unifi)

## License

Apache-2.0
