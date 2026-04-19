#
# Copyright (C) 2024-2026 luci-theme-glass contributors
#
# This is free software, licensed under the GNU General Public License v3.0.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-theme-glass
PKG_VERSION:=1.1.5
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/rchen14b/luci-theme-glass.git
PKG_SOURCE_VERSION:=v$(PKG_VERSION)
PKG_SOURCE_DATE:=2026-04-21
PKG_MIRROR_HASH:=skip

PKG_MAINTAINER:=Ryan Chen <rchen14b@gmail.com>
PKG_LICENSE:=GPL-3.0
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/luci-theme-glass
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Themes
  TITLE:=Glass - Apple-inspired glassmorphism theme for LuCI
  URL:=https://github.com/rchen14b/luci-theme-glass
  DEPENDS:=+luci-base
  PKGARCH:=all
endef

define Package/luci-theme-glass/description
  Apple-inspired glassmorphism theme for LuCI with Big Sur / Monterey
  visual language: translucent panels, backdrop blur, rounded corners.
endef

define Build/Compile
endef

define Package/luci-theme-glass/install
	$(INSTALL_DIR) $(1)
	[ ! -d $(PKG_BUILD_DIR)/root ] || $(CP) $(PKG_BUILD_DIR)/root/. $(1)/
	[ ! -d $(PKG_BUILD_DIR)/htdocs ] || { \
		$(INSTALL_DIR) $(1)/www; \
		$(CP) $(PKG_BUILD_DIR)/htdocs/. $(1)/www/; \
	}
	[ ! -d $(PKG_BUILD_DIR)/ucode ] || { \
		$(INSTALL_DIR) $(1)/usr/share/ucode/luci; \
		$(CP) $(PKG_BUILD_DIR)/ucode/. $(1)/usr/share/ucode/luci/; \
	}
endef

define Package/luci-theme-glass/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
rm -rf /tmp/luci-indexcache /tmp/luci-modulecache
exit 0
endef

$(eval $(call BuildPackage,luci-theme-glass))
