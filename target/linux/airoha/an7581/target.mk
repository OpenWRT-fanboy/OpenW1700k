ARCH:=aarch64
SUBTARGET:=an7581
BOARDNAME:=AN7581 / AN7566 / AN7551
CPU_TYPE:=cortex-a53
KERNELNAME:=Image dtbs
FEATURES+=pwm source-only

DEFAULT_PACKAGES += \
	kmod-airoha-eth kmod-dsa-mt7530-mmio uboot-envtools

define Target/Description
	Build firmware images for Airoha an7581 ARM based boards.
endef

