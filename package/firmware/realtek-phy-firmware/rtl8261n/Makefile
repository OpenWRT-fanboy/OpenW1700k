# SPDX-License-Identifier: GPL-2.0-or-later

include $(TOPDIR)/rules.mk

PKG_NAME:=rtl8261n-firmware
PKG_SOURCE:=rtl8261n.bin
PKG_SOURCE_URL:=https://github.com/balika011/realtek_phy_firmware/releases/download/rtl8261n-2024.07.29/
PKG_SOURCE_VERSION:=0cd4abe2b0bf197f75c27088f86a74c7ddb103b4
PKG_HASH:=9a097056b0cb369679f1dccba7004e3378b86b39c4987ed07f68ae3117d6f4c2

PKG_MAINTAINER:=Balázs Triszka <info@balika011.hu>
PKG_LICENSE_FILES:=LICENCE

include $(INCLUDE_DIR)/package.mk

PKG_UNPACK:=cp $(DL_DIR)/$(PKG_SOURCE) $(PKG_BUILD_DIR)

define Build/Compile
	true
endef

define Package/rtl8261n-firmware
  SECTION:=firmware
  CATEGORY:=Firmware
  TITLE:=Realtek RTL8251L/RTL8261BE/RTL8261N firmware
endef

define Package/rtl8261n-firmware/install
	$(INSTALL_DIR) $(1)/lib/firmware
	$(INSTALL_DATA) \
		$(PKG_BUILD_DIR)/rtl8261n.bin \
		$(1)/lib/firmware/
endef

$(eval $(call BuildPackage,rtl8261n-firmware))

