include $(TOPDIR)/rules.mk

PKG_VERSION:=1.1.0
PKG_RELEASE:=12
PKG_LICENSE:=GPL-2.0-or-later

LUCI_NAME:=luci-app-traffic-chart
LUCI_MAINTAINER:=m0g13r <155771712+m0g13r@users.noreply.github.com>
LUCI_TITLE:=Live traffic chart (conntrack + shaper counters) with NSS SQM classifier
LUCI_DESCRIPTION:=Live and historical traffic chart per application, device and destination. \
	Reads conntrack and the qdisc counters, independent of the shaper in use. \
	Optional: socat + netifyd (application names), conntrack (nss-trafficchart.qos), \
	sqm-scripts (nss-trafficchart.qos itself).
LUCI_DEPENDS:=+luci-base +rpcd +jsonfilter +ip-full +tc-tiny

include $(TOPDIR)/feeds/luci/luci.mk

define Package/luci-app-traffic-chart/conffiles
/etc/config/trafficchart
endef

define Package/luci-app-traffic-chart/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/rpcd reload 2>/dev/null
	rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null
	/usr/libexec/trafficchart-migrate
	/etc/init.d/trafficchart enable
	/etc/init.d/trafficchart restart
}
exit 0
endef

define Package/luci-app-traffic-chart/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/trafficchart stop 2>/dev/null
	/etc/init.d/trafficchart disable 2>/dev/null
}
exit 0
endef

# call BuildPackage - OpenWrt buildroot signature
