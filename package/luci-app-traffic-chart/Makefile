# This is free software, licensed under the Apache License, Version 2.0

include $(TOPDIR)/rules.mk

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=m0g13r
PKG_VERSION:=1.1.0
PKG_RELEASE:=6

LUCI_TITLE:=Live per-class and per-host traffic chart
LUCI_DESCRIPTION:=Reads nf_conntrack directly rather than polling interface \
	statistics, so the figures stay correct with hardware offload enabled. \
	A per-flow aggregation daemon keeps the totals monotonic, and the shaper \
	panel counts qdisc packets and bytes rather than conntrack bytes. Also \
	ships nss-rk.qos, an SQM shaper whose traffic classes match the chart's.
LUCI_DEPENDS:=+luci-base +rpcd +sqm-scripts +libnetfilter-conntrack +socat +netifyd

include $(TOPDIR)/feeds/luci/luci.mk

# the chart's class definitions live here, so keep them across upgrades
define Package/$(PKG_NAME)/conffiles
/etc/config/trafficchart
endef

# call BuildPackage - OpenWrt buildroot signature
