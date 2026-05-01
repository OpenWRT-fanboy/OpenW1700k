# SPDX-License-Identifier: Apache-2.0
#
# Copyright 2026 VolanticSystems

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-appflow
PKG_VERSION:=1.1.3
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Bob <git16@bob7.com>

LUCI_TITLE:=Per-application traffic dashboard (DPI via Netify Agent)
LUCI_DESCRIPTION:=Real-time per-application and per-device traffic visibility \
	for OpenWrt, powered by the Netify Agent (netifyd) deep packet inspection \
	engine. A LuCI-native functional equivalent of vendor DPI dashboards.
LUCI_DEPENDS:=+netifyd +luci-base \
	+ucode-mod-socket +ucode-mod-uloop +ucode-mod-ubus +ucode-mod-uci +ucode-mod-fs
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
