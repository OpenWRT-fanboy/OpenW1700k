include $(TOPDIR)/rules.mk

PKG_NAME:=bridge-hw-offload
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/bridge-hw-offload
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Firewall
  TITLE:=Bridge hardware flow offloading
  DEPENDS:=+kmod-nft-bridge +firewall4
endef

define Package/bridge-hw-offload/description
  Adds nftables bridge flowtable offloading rules after firewall4
  initialization. Detects bridge member ports dynamically and creates
  a bridge-family flowtable with hardware offload support.
endef

define Build/Configure
	true
endef

define Build/Compile
	true
endef

define Package/bridge-hw-offload/install
	$(INSTALL_DIR) $(1)/usr/share/bridge-hw-offload $(1)/etc/init.d $(1)/etc/hotplug.d/iface
	$(INSTALL_BIN) ./files/usr/share/bridge-hw-offload/apply-rules.sh $(1)/usr/share/bridge-hw-offload/apply-rules.sh
	$(INSTALL_BIN) ./files/etc/init.d/bridge-hw-offload $(1)/etc/init.d/bridge-hw-offload
	$(INSTALL_BIN) ./files/etc/hotplug.d/iface/51-bridge-hw-offload $(1)/etc/hotplug.d/iface/51-bridge-hw-offload
endef

$(eval $(call BuildPackage,bridge-hw-offload))
