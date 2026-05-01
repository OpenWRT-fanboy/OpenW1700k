# SPDX-License-Identifier: Apache-2.0
#
# Copyright 2026 VolanticSystems

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-appflow-icons
PKG_VERSION:=1.0.1
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0 AND CC0-1.0
PKG_LICENSE_FILES:=licenses/LICENSE.simple-icons licenses/LICENSE.dashboard-icons
PKG_MAINTAINER:=Bob <git16@bob7.com>

LUCI_TITLE:=Optional brand icon pack for luci-app-appflow
LUCI_DESCRIPTION:=Adds recognizable per-application icons (Netflix, YouTube, \
	Spotify, etc.) to the luci-app-appflow traffic dashboard. Purely \
	cosmetic and entirely optional: luci-app-appflow renders letter-tile \
	avatars on its own and probes for this package's icon directory at \
	render time, falling back cleanly when it is absent. Installing or \
	removing this package has no effect on core functionality. See \
	docs/DESIGN.md section 9 in the parent luci-app-appflow package for the \
	rationale (legal blast-radius isolation: icons are third-party \
	trademarks regardless of collection license, so this package can be \
	delisted on its own without touching core).
LUCI_DEPENDS:=
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
