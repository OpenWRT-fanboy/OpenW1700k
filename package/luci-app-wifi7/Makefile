#
# Copyright 2026 woziwrt
# https://github.com/woziwrt/luci-app-wifi7
#
# MIT License
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wifi7
PKG_VERSION:=1.0.0
PKG_RELEASE:=20260502

LUCI_TITLE:=LuCI WiFi 7 MT7996 module for BPI-R4
LUCI_DESCRIPTION:=LuCI module for WiFi 7 (MT7996 / BPI-R4). Provides Network > WiFi 7 with tabs for Overview, MLD config, Radio, Networks, Stations and Diagnostics. Requires OpenWrt with MT7996 support and MLD hostapd.
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all
PKG_MAINTAINER:=woziwrt <https://github.com/woziwrt>
PKG_LICENSE:=MIT

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
