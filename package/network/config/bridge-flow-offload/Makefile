include $(TOPDIR)/rules.mk

PKG_NAME:=bridge-flow-offload
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/bridge-flow-offload
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Firewall
  TITLE:=Bridge hardware flow offloading
  DEPENDS:=+kmod-nf-flow-bridge +kmod-nft-bridge +kmod-nft-offload \
	   +kmod-nf-flow +firewall4
endef

define Package/bridge-flow-offload/description
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

define Package/bridge-flow-offload/install
	$(INSTALL_DIR) $(1)/usr/share/bridge-flow-offload
	$(INSTALL_BIN) ./files/usr/share/bridge-flow-offload/apply-rules.sh $(1)/usr/share/bridge-flow-offload/apply-rules.sh
endef

$(eval $(call BuildPackage,bridge-flow-offload))
