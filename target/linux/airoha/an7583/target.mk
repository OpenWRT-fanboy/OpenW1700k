ARCH:=aarch64
SUBTARGET:=an7583
BOARDNAME:=AN7583
CPU_TYPE:=cortex-a53
KERNELNAME:=Image dtbs
FEATURES+=pwm source-only

DEFAULT_PACKAGES += kmod-crypto-hw-eip93

define Target/Description
	Build firmware images for Airoha an7583 ARM based boards.
endef

