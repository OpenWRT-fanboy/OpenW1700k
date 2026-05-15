// SPDX-License-Identifier: GPL-2.0-only
/* Reverse-engineered Realtek RTL8261CE 10GBASE-T PHY (physical layer) driver.
 *
 * The register initialisation sequence is ported from a best-effort recovery
 * of Realtek's rtk-rtl8261ce-phy.ko module from the stock LUMEN W1700K2
 * firmware. Keep the CE-specific SerDes (serializer/deserializer) handling in
 * this driver: boards that used RTL8261N can expose similar properties, but
 * RTL8261CE stores polarity controls behind a different vendor OCP
 * (Open Core Protocol) window.
 *
 * This driver also incorporates RTL8261C PHY and LED support from the
 * cmonroe/target-airoha patches:
 * 992-08-01-smartrg-net-phy-realtek-add-support-for-rtl8261c.patch and
 * 992-08-02-smartrg-net-phy-realtek-add-rtl8261c-led-support.patch.
 */

#include <linux/bitfield.h>
#include <linux/delay.h>
#include <linux/ethtool.h>
#include <linux/hwmon.h>
#include <linux/kernel.h>
#include <linux/mdio.h>
#include <linux/mii.h>
#include <linux/module.h>
#include <linux/phy.h>
#include <linux/phy/phy-common-props.h>
#include <linux/property.h>
#include <linux/slab.h>
#include <dt-bindings/phy/phy.h>

#define RTL8261CE_PHY_ID 0x001cc890

/* The vendor firmware is not immediately ready after reset. The long
 * init delay matches the recovered module; the shorter poll interval is used
 * for boot state, patch-loader, and SerDes OCP transactions.
 */
#define RTL8261CE_INIT_DELAY_MS 51
#define RTL8261CE_POLL_SLEEP_US 1000
#define RTL8261CE_POLL_SLEEP_US_MAX 2000
#define RTL8261CE_READY_POLL_TRIES 100
#define RTL8261CE_SERDES_POLL_TRIES 400

/* The recovered patch flow writes this marker through the indirect OCP
 * window once the firmware patch has been downloaded. A warm probe can then
 * skip the firmware download and only re-apply the system SerDes selection.
 */
#define RTL8261CE_PATCH_MARK 0x1007
#define RTL8261CE_PHYID2_MODEL_MASK GENMASK(9, 4)
#define RTL8261CE_PHYID2_MODEL 0x9
#define RTL8261CE_PHYID2_REV_MASK GENMASK(3, 0)
#define RTL8261CE_PHYID2_REV_A 0x0
#define RTL8261CE_PHYID2_REV_B 0x8
#define RTL8261CE_PHYID2_REV_C 0x9

/* System-side SerDes option registers. Several lanes share one register;
 * low_lane and high_lane packing is handled by rtl8261ce_serdes_option_set().
 */
#define RTL8261CE_VND1_SERDES_OPT0 0x6977
#define RTL8261CE_VND1_SERDES_OPT1_3 0x6976
#define RTL8261CE_VND1_SERDES_OPT2 0x6975
#define RTL8261CE_VND1_SERDES_OPT4_9 0x6972
#define RTL8261CE_VND1_SERDES_OPT5_7 0x6974
#define RTL8261CE_VND1_SERDES_OPT6_8 0x6973

/* RTL8261CE does not use the RTL8261N VND1 (Vendor 1) global HSI/HSO
 * (high-speed input/high-speed output) inversion bits for W1700K2 lane
 * polarity. The recovered CE path talks to the SerDes OCP command window
 * below, then updates the real polarity bits in OCP registers 0x0000 and
 * 0x00c2.
 */
#define RTL8261CE_VND1_SERDES_OCP_CMD 0x7587
#define RTL8261CE_VND1_SERDES_OCP_ADDR 0x7588
#define RTL8261CE_VND1_SERDES_OCP_DATA 0x7589
#define RTL8261CE_VND1_SERDES_OCP_READ_DATA 0x758a
#define RTL8261CE_SERDES_POLARITY_REG0 0x0000
#define RTL8261CE_SERDES_POLARITY_REGC2 0x00c2
#define RTL8261CE_SERDES_OCP_READ 0x0001
#define RTL8261CE_SERDES_OCP_WRITE 0x0003
#define RTL8261CE_SERDES_POLARITY_TX BIT(0)
#define RTL8261CE_SERDES_POLARITY_RX BIT(1)

/* Vendor 2 owns boot status, the firmware patch loader, indirect OCP access,
 * and the Realtek-specific 1000base-T/EEE (Energy Efficient Ethernet)/thermal
 * controls that generic C45 (IEEE 802.3 Clause 45) helpers cannot cover.
 */
#define RTL8261CE_VND2_BOOT_STATUS 0xa420
#define RTL8261CE_VND2_BOOT_STATUS_READY GENMASK(1, 0)
#define RTL8261CE_VND2_BOOT_CTRL 0xa400
#define RTL8261CE_VND2_OCP_ADDR 0xa436
#define RTL8261CE_VND2_OCP_DATA 0xa438
#define RTL8261CE_VND2_PATCH_CTRL 0xb820
#define RTL8261CE_VND2_PATCH_STATUS 0xb800
#define RTL8261CE_VND2_PATCH_GATE 0xb82e
#define RTL8261CE_VND2_PATCH_TRIGGER 0xa4a0
#define RTL8261CE_VND2_PATCH_DONE 0xa600
#define RTL8261CE_VND2_AN_CTRL1000 0xa412
#define RTL8261CE_VND2_AN_STAT1000 0xa414
#define RTL8261CE_VND2_TSALRM			0xa662
#define RTL8261CE_VND2_TSRR			0xbd84
#define RTL8261CE_VND2_THERMAL_SENSOR_CTRL	0xb54c
#define RTL8261CE_THERMAL_OVERTEMP_DWNSPD_EN	BIT(3)
#define RTL8261CE_THERMAL_ALARM_MASK		GENMASK(5, 0)
#define RTL8261CE_THERMAL_RAW_MASK		GENMASK(9, 0)
#define RTL8261CE_THERMAL_THRESHOLD_SHIFT	7
#define RTL8261CE_INDIRECT_PATCH_VER 0x801e
#define RTL8261CE_INDIRECT_PATCH_SETUP 0x8023
#define RTL8261CE_VND2_EEE_CTRL0 0xd036
#define RTL8261CE_VND2_EEE_CTRL1 0xd038

struct rtl8261ce_priv {
	/* Guard the recovered init flow; phylib may call config_init again. */
	bool initialized;
};

struct rtl8261ce_regval {
	u16 mmd;
	u16 reg;
	u16 val;
};

/* Large recovered firmware/init write tables are kept in a separate header.
 * Treat them as opaque vendor register scripts: the order and values come from
 * the Realtek module and should only change with a matching hardware test.
 */
#include "rtk_rtl8261ce_patch.h"

/* Short post-patch OCP sequence from the recovered module. It runs after the
 * main firmware download and before the patch gate is released.
 */
static const struct rtl8261ce_regval rtl8261ce_post_patch_seq[] = {
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR, 0x8173 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA, 0x8620 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR, 0x8175 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA, 0x8671 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR, 0x8370 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA, 0x8671 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR, 0x8372 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA, 0x86c8 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR, 0x8401 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA, 0x86c8 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR, 0x8403 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA, 0x86da },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR, 0x0000 },
	{ MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA, 0x0000 },
};

static long rtl8261ce_hwmon_temp_from_raw(int raw)
{
	raw &= RTL8261CE_THERMAL_RAW_MASK;

	/* The recovered RTL8261CE-specific decode under-reports temperature
	 * on this board, so use the upstream RTL822x hwmon conversion: TSRR is
	 * a signed 10-bit half-degree Celsius value.
	 */
	if (raw >= BIT(9))
		raw -= BIT(10);
	return raw * 500;
}

static int rtl8261ce_hwmon_read(struct device *dev,
				enum hwmon_sensor_types type, u32 attr,
				int channel, long *val)
{
	struct phy_device *phydev = dev_get_drvdata(dev);
	int raw;

	switch (attr) {
	case hwmon_temp_input:
		raw = phy_read_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_TSRR);
		if (raw < 0)
			return raw;

		*val = rtl8261ce_hwmon_temp_from_raw(raw);
		return 0;
	case hwmon_temp_max:
		raw = phy_read_mmd(phydev, MDIO_MMD_VEND2,
				   RTL8261CE_VND2_THERMAL_SENSOR_CTRL);
		if (raw < 0)
			return raw;

		/* RTL8261CE stores the downspeed threshold as degrees Celsius
		 * starting at bit 7. This differs from the generic RTL822x
		 * hwmon layout, which shifts the same register by bit 6.
		 */
		*val = (raw >> RTL8261CE_THERMAL_THRESHOLD_SHIFT) * 1000;
		return 0;
	default:
		return -EINVAL;
	}
}

static const struct hwmon_ops rtl8261ce_hwmon_ops = {
	.visible = 0444,
	.read = rtl8261ce_hwmon_read,
};

static const struct hwmon_channel_info * const rtl8261ce_hwmon_info[] = {
	HWMON_CHANNEL_INFO(temp, HWMON_T_INPUT | HWMON_T_MAX),
	NULL
};

static const struct hwmon_chip_info rtl8261ce_hwmon_chip_info = {
	.ops = &rtl8261ce_hwmon_ops,
	.info = rtl8261ce_hwmon_info,
};

static int rtl8261ce_hwmon_init(struct phy_device *phydev)
{
	struct device *dev = &phydev->mdio.dev;
	struct device *hwdev;

	/* Clear latched thermal status bits without making hwmon registration
	 * depend on this write.
	 */
	phy_clear_bits_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_TSALRM,
			   RTL8261CE_THERMAL_ALARM_MASK);

	hwdev = devm_hwmon_device_register_with_info(dev, NULL, phydev,
						     &rtl8261ce_hwmon_chip_info,
						     NULL);
	return PTR_ERR_OR_ZERO(hwdev);
}

/* Replay one recovered MDIO (Management Data Input/Output) script table. This
 * is used for both the large firmware patch stages and the short post-patch
 * OCP sequence.
 */
static int rtl8261ce_write_seq(struct phy_device *phydev,
			       const struct rtl8261ce_regval *seq, size_t len)
{
	size_t i;
	int ret;

	/* The recovered init data is an ordered MDIO script. Stop on the first
	 * failing write so the caller does not continue with a partial firmware
	 * state.
	 */
	for (i = 0; i < len; i++) {
		ret = phy_write_mmd(phydev, seq[i].mmd, seq[i].reg, seq[i].val);
		if (ret < 0)
			return ret;
	}

	return 0;
}

/* Read a register behind the Vendor 2 indirect OCP window. The loader state,
 * patch version marker, and patch setup latch all live behind this window.
 */
static int rtl8261ce_read_indirect(struct phy_device *phydev, u16 reg)
{
	int ret;

	/* Vendor 2 exposes a simple address/data indirect window. The patch
	 * version and setup registers used below are only reachable through it.
	 */
	ret = phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR,
			    reg);
	if (ret < 0)
		return ret;

	return phy_read_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA);
}

/* Write a register behind the Vendor 2 indirect OCP window. Keep this paired
 * with rtl8261ce_read_indirect() so all Vendor 2 OCP accesses follow the same
 * address/data latch ordering.
 */
static int rtl8261ce_write_indirect(struct phy_device *phydev, u16 reg, u16 val)
{
	int ret;

	/* See rtl8261ce_read_indirect(); writes use the same address latch. */
	ret = phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR,
			    reg);
	if (ret < 0)
		return ret;

	return phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA,
			     val);
}

/* Poll a single status bit until it becomes set or clear. The PHY uses this
 * pattern for boot readiness, patch-loader gates, and SerDes OCP completion.
 */
static int rtl8261ce_wait_for_bit(struct phy_device *phydev, int devad,
				  u32 regnum, u16 mask, bool set,
				  unsigned int tries)
{
	int ret;

	/* Most vendor operations complete by flipping a single status bit. This
	 * helper is intentionally small so it can be reused for both set and
	 * clear waits without open-coding timeout loops.
	 */
	while (tries--) {
		ret = phy_read_mmd(phydev, devad, regnum);
		if (ret < 0)
			return ret;

		if (set) {
			if ((ret & mask) == mask)
				return 0;
		} else if (!(ret & mask)) {
			return 0;
		}

		usleep_range(RTL8261CE_POLL_SLEEP_US,
			     RTL8261CE_POLL_SLEEP_US_MAX);
	}

	return -ETIMEDOUT;
}

/* Poll an arbitrary bit field. The recovered patch trigger reports
 * completion through a small field rather than a single ready bit.
 */
static int rtl8261ce_poll_value(struct phy_device *phydev, int devad,
				u32 regnum, u8 high, u8 low, u16 expect,
				bool equal, unsigned int tries)
{
	u16 mask;
	int ret;
	u16 val;

	if (high > 15 || low > high)
		return -EINVAL;

	/* The patch completion register reports a small field rather than a
	 * single bit. Poll the extracted field and let the caller choose
	 * equality or inequality depending on the recovered sequence.
	 */
	mask = GENMASK(high, low);

	while (tries--) {
		ret = phy_read_mmd(phydev, devad, regnum);
		if (ret < 0)
			return ret;

		val = (ret & mask) >> low;
		if (equal && val == expect)
			return 0;
		if (!equal && val != expect)
			return 0;

		usleep_range(RTL8261CE_POLL_SLEEP_US,
			     RTL8261CE_POLL_SLEEP_US_MAX);
	}

	return -ETIMEDOUT;
}

/* Program one system-side SerDes option slot. The vendor flow selects the
 * same MAC (Media Access Control), PHY, and mode tuple for every slot, but the
 * bit packing differs per shared register, so keep the lane mapping isolated
 * here.
 */
static int rtl8261ce_serdes_option_set(struct phy_device *phydev, u8 serdes,
				       u8 mac_sel, u8 phy_sel, u8 mode)
{
	bool high_lane = false;
	u16 mask;
	u16 val;
	u32 reg;
	int ret;

	/* The CE part has ten system-side SerDes option slots. Adjacent odd or
	 * high-numbered lanes share registers with different bit packing, so
	 * high_lane selects the upper field layout.
	 */
	switch (serdes) {
	case 0:
		reg = RTL8261CE_VND1_SERDES_OPT0;
		break;
	case 1:
		reg = RTL8261CE_VND1_SERDES_OPT1_3;
		break;
	case 2:
		reg = RTL8261CE_VND1_SERDES_OPT2;
		break;
	case 3:
		reg = RTL8261CE_VND1_SERDES_OPT1_3;
		high_lane = true;
		break;
	case 4:
		reg = RTL8261CE_VND1_SERDES_OPT4_9;
		break;
	case 5:
		reg = RTL8261CE_VND1_SERDES_OPT5_7;
		break;
	case 6:
		reg = RTL8261CE_VND1_SERDES_OPT6_8;
		break;
	case 7:
		reg = RTL8261CE_VND1_SERDES_OPT5_7;
		high_lane = true;
		break;
	case 8:
		reg = RTL8261CE_VND1_SERDES_OPT6_8;
		high_lane = true;
		break;
	case 9:
		reg = RTL8261CE_VND1_SERDES_OPT4_9;
		high_lane = true;
		break;
	default:
		return -EINVAL;
	}

	ret = phy_read_mmd(phydev, MDIO_MMD_VEND1, reg);
	if (ret < 0)
		return ret;

	if (high_lane) {
		mask = 0xa0ff;
		val = (ret & mask) | ((mode & 0xf) << 8) |
		      ((phy_sel & 0x3) << 12) | ((mac_sel & 0x3) << 14);
	} else {
		mask = 0xffa0;
		val = (ret & mask) | (mode & 0xf) | ((phy_sel & 0x3) << 4) |
		      ((mac_sel & 0x3) << 6);
	}

	return phy_write_mmd(phydev, MDIO_MMD_VEND1, reg, val);
}

/* Wait for a SerDes OCP transaction to finish. This is the busy bit used by
 * the CE-specific polarity read/write path.
 */
static int rtl8261ce_serdes_ocp_wait(struct phy_device *phydev)
{
	/* OCP command bit 0 is busy while the SerDes side completes a request. */
	return rtl8261ce_wait_for_bit(phydev, MDIO_MMD_VEND1,
				      RTL8261CE_VND1_SERDES_OCP_CMD, BIT(0),
				      false, RTL8261CE_SERDES_POLL_TRIES);
}

/* Read a SerDes-side OCP register through the Vendor 1 command window. This
 * path is distinct from the Vendor 2 indirect window used by the patch loader.
 */
static int rtl8261ce_serdes_ocp_read(struct phy_device *phydev, u16 reg)
{
	int ret;

	/* The SerDes OCP window is separate from the Vendor 2 indirect window.
	 * Program the OCP address, issue a read command, wait for completion,
	 * then fetch the read-data latch.
	 */
	ret = phy_write_mmd(phydev, MDIO_MMD_VEND1,
			    RTL8261CE_VND1_SERDES_OCP_ADDR, reg);
	if (ret < 0)
		return ret;

	ret = phy_write_mmd(phydev, MDIO_MMD_VEND1,
			    RTL8261CE_VND1_SERDES_OCP_CMD,
			    RTL8261CE_SERDES_OCP_READ);
	if (ret < 0)
		return ret;

	ret = rtl8261ce_serdes_ocp_wait(phydev);
	if (ret < 0)
		return ret;

	return phy_read_mmd(phydev, MDIO_MMD_VEND1,
			    RTL8261CE_VND1_SERDES_OCP_READ_DATA);
}

/* Write a SerDes-side OCP register through the Vendor 1 command window. The
 * W1700K2 polarity fix depends on this path, not on RTL8261N global bits.
 */
static int rtl8261ce_serdes_ocp_write(struct phy_device *phydev, u16 reg,
				      u16 val)
{
	int ret;

	/* Writes use the same OCP address/command path as reads, with DATA
	 * loaded before issuing the write command.
	 */
	ret = phy_write_mmd(phydev, MDIO_MMD_VEND1,
			    RTL8261CE_VND1_SERDES_OCP_ADDR, reg);
	if (ret < 0)
		return ret;

	ret = phy_write_mmd(phydev, MDIO_MMD_VEND1,
			    RTL8261CE_VND1_SERDES_OCP_DATA, val);
	if (ret < 0)
		return ret;

	ret = phy_write_mmd(phydev, MDIO_MMD_VEND1,
			    RTL8261CE_VND1_SERDES_OCP_CMD,
			    RTL8261CE_SERDES_OCP_WRITE);
	if (ret < 0)
		return ret;

	return rtl8261ce_serdes_ocp_wait(phydev);
}

/* Convert the requested board polarity into RTL8261CE register encodings.
 * The mapping is revision-sensitive and intentionally mirrors the recovered
 * vendor decision table.
 */
static void rtl8261ce_update_serdes_polarity(u16 phyid2, u8 polarity, u16 *reg0,
					     u16 *regc2)
{
	bool model_mismatch;

	/* This decision table is recovered from the RTL8261CE vendor module.
	 * Do not collapse it to the RTL8261N global HSI/HSO inversion bits:
	 * RTL8261CE uses different encodings in SerDes OCP registers 0x0000
	 * and 0x00c2, and the encoding also depends on the PHY revision.
	 */
	model_mismatch = FIELD_GET(RTL8261CE_PHYID2_MODEL_MASK, phyid2) !=
			 RTL8261CE_PHYID2_MODEL;

	if ((phyid2 & 0x7) || model_mismatch) {
		if (model_mismatch ||
		    FIELD_GET(RTL8261CE_PHYID2_REV_MASK, phyid2) !=
			    RTL8261CE_PHYID2_REV_C)
			return;

		if ((polarity & 0x3) == 0x3) {
			*reg0 |= 0x0300;
			*regc2 |= 0x6000;
		} else if (polarity & RTL8261CE_SERDES_POLARITY_TX) {
			*reg0 = (*reg0 & ~0x0200) | 0x0100;
			*regc2 = (*regc2 & ~0x2000) | 0x4000;
		} else if (!(polarity & RTL8261CE_SERDES_POLARITY_RX)) {
			*reg0 &= ~0x0300;
			*regc2 &= ~0x6000;
		} else {
			*reg0 = (*reg0 & ~0x0100) | 0x0200;
			*regc2 = (*regc2 & ~0x4000) | 0x2000;
		}

		return;
	}

	if ((polarity & 0x3) == 0x3) {
		*reg0 = (*reg0 & ~0x0100) | 0x0200;
		*regc2 = (*regc2 & ~0x4000) | 0x2000;
	} else if (polarity & RTL8261CE_SERDES_POLARITY_TX) {
		*reg0 &= ~0x0300;
		*regc2 &= ~0x6000;
	} else if (!(polarity & RTL8261CE_SERDES_POLARITY_RX)) {
		*reg0 = (*reg0 & ~0x0200) | 0x0100;
		*regc2 = (*regc2 & ~0x2000) | 0x4000;
	} else {
		*reg0 |= 0x0300;
		*regc2 |= 0x6000;
	}
}

/* Apply board-level TX/RX (transmit/receive) polarity by updating both CE
 * SerDes polarity registers. This is the boundary where DT (device tree)
 * properties become hardware state.
 */
static int rtl8261ce_serdes_polarity_swap(struct phy_device *phydev,
					  u8 polarity)
{
	u16 next_reg0;
	u16 next_regc2;
	int phyid2;
	int reg0;
	int regc2;
	int ret;

	/* Board polarity is applied as a read/modify/write of both CE SerDes
	 * polarity registers. Preserve unrelated fields because these OCP
	 * registers contain more than just TX/RX lane inversion state.
	 */
	phyid2 = phy_read_mmd(phydev, MDIO_MMD_PMAPMD, MDIO_DEVID2);
	if (phyid2 < 0)
		return phyid2;

	reg0 = rtl8261ce_serdes_ocp_read(phydev,
					 RTL8261CE_SERDES_POLARITY_REG0);
	if (reg0 < 0)
		return reg0;

	regc2 = rtl8261ce_serdes_ocp_read(phydev,
					  RTL8261CE_SERDES_POLARITY_REGC2);
	if (regc2 < 0)
		return regc2;

	next_reg0 = reg0;
	next_regc2 = regc2;
	rtl8261ce_update_serdes_polarity((u16)phyid2, polarity, &next_reg0,
					 &next_regc2);

	ret = rtl8261ce_serdes_ocp_write(phydev, RTL8261CE_SERDES_POLARITY_REG0,
					 next_reg0);
	if (ret < 0)
		return ret;

	return rtl8261ce_serdes_ocp_write(phydev,
					  RTL8261CE_SERDES_POLARITY_REGC2,
					  next_regc2);
}

/* Read generic board-level TX/RX polarity from DT and apply it if required.
 * The helper only parses the firmware-node properties; the CE-specific OCP
 * path below still owns the actual RTL8261CE SerDes register programming.
 */
static void rtl8261ce_apply_board_serdes_polarity(struct phy_device *phydev)
{
	struct device *dev = &phydev->mdio.dev;
	unsigned int tx_pol;
	unsigned int rx_pol;
	u8 polarity = 0;
	int ret;

	ret = phy_get_tx_polarity(dev_fwnode(dev), phy_modes(phydev->interface),
				  BIT(PHY_POL_NORMAL) | BIT(PHY_POL_INVERT),
				  PHY_POL_NORMAL, &tx_pol);
	if (ret < 0) {
		phydev_warn(phydev,
			    "RTL8261CE TX polarity parse failed: %pe\n",
			    ERR_PTR(ret));
		return;
	}

	ret = phy_get_rx_polarity(dev_fwnode(dev), phy_modes(phydev->interface),
				  BIT(PHY_POL_NORMAL) | BIT(PHY_POL_INVERT),
				  PHY_POL_NORMAL, &rx_pol);
	if (ret < 0) {
		phydev_warn(phydev,
			    "RTL8261CE RX polarity parse failed: %pe\n",
			    ERR_PTR(ret));
		return;
	}

	if (tx_pol == PHY_POL_INVERT)
		polarity |= RTL8261CE_SERDES_POLARITY_TX;
	if (rx_pol == PHY_POL_INVERT)
		polarity |= RTL8261CE_SERDES_POLARITY_RX;
	if (!polarity)
		return;

	/* A polarity-programming failure is logged but not fatal. Keeping the
	 * PHY attached leaves the link state visible for further diagnosis.
	 */
	ret = rtl8261ce_serdes_polarity_swap(phydev, polarity);
	if (ret < 0)
		phydev_warn(phydev,
			    "RTL8261CE SerDes polarity swap failed: %pe\n",
			    ERR_PTR(ret));
}

/* Run the recovered Realtek initialisation flow. It waits for the internal
 * loader, downloads the vendor patch if it is not already marked as loaded,
 * then restores the system-side SerDes option programming.
 */
static int rtl8261ce_phy_init(struct phy_device *phydev)
{
	unsigned int serdes;
	u16 phyid2;
	u16 rev;
	int ret;

	/* Wait for the internal loader before touching patch-control registers. */
	ret = rtl8261ce_wait_for_bit(phydev, MDIO_MMD_VEND2,
				     RTL8261CE_VND2_BOOT_STATUS,
				     RTL8261CE_VND2_BOOT_STATUS_READY, true,
				     RTL8261CE_READY_POLL_TRIES);
	if (ret < 0)
		return ret;

	ret = phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_BOOT_CTRL,
			    0x9200);
	if (ret < 0)
		return ret;

	ret = phy_read_mmd(phydev, MDIO_MMD_PMAPMD, MDIO_DEVID2);
	if (ret < 0)
		return ret;

	phyid2 = ret;
	rev = FIELD_GET(RTL8261CE_PHYID2_REV_MASK, phyid2);

	/* This driver can match through the outer PHY ID (identifier) while the
	 * recovered init flow still expects a narrower RTL8261x PMA/PMD
	 * (Physical Medium Attachment/Physical Medium Dependent) device id
	 * range. If that id does not match, leave the PHY to generic C45
	 * handling.
	 */
	if (FIELD_GET(RTL8261CE_PHYID2_MODEL_MASK, phyid2) !=
		    RTL8261CE_PHYID2_MODEL ||
	    (rev != RTL8261CE_PHYID2_REV_A && rev != RTL8261CE_PHYID2_REV_B &&
	     rev != RTL8261CE_PHYID2_REV_C)) {
		phydev_info(phydev,
			    "not RTL8261x, skipping init flow: id2=0x%04x\n",
			    phyid2);
		return 0;
	}

	ret = rtl8261ce_read_indirect(phydev, RTL8261CE_INDIRECT_PATCH_VER);
	if (ret < 0)
		return ret;

	/* Warm probes skip the heavy firmware download but still restore SerDes. */
	if (ret == RTL8261CE_PATCH_MARK)
		goto configure_serdes;

	/* Firmware download sequence recovered from the vendor module:
	 * enable patch access, wait for loader readiness, write each stage,
	 * release the gate, trigger execution, and mark the patch as loaded.
	 */
	ret = phy_set_bits_mmd(phydev, MDIO_MMD_VEND2,
			       RTL8261CE_VND2_PATCH_CTRL, BIT(4));
	if (ret < 0)
		return ret;

	ret = rtl8261ce_wait_for_bit(phydev, MDIO_MMD_VEND2,
				     RTL8261CE_VND2_PATCH_STATUS, BIT(6), true,
				     100);
	if (ret < 0)
		return ret;

	ret = rtl8261ce_write_indirect(phydev, RTL8261CE_INDIRECT_PATCH_SETUP,
				       0x6100);
	if (ret < 0)
		return ret;

	ret = phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_ADDR,
			    0xb82e);
	if (ret < 0)
		return ret;

	/* Open the patch gate through the indirect address/data window before
	 * switching the loader into the patch-download state.
	 */
	ret = phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_OCP_DATA,
			    0x0001);
	if (ret < 0)
		return ret;

	ret = phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_PATCH_CTRL,
			    0x0090);
	if (ret < 0)
		return ret;

	/* Stage tables are recovered vendor script chunks and must stay ordered. */
	ret = rtl8261ce_write_seq(phydev, rtl8261ce_patch_stage0,
				  ARRAY_SIZE(rtl8261ce_patch_stage0));
	if (ret < 0)
		return ret;

	ret = rtl8261ce_write_seq(phydev, rtl8261ce_patch_stage1,
				  ARRAY_SIZE(rtl8261ce_patch_stage1));
	if (ret < 0)
		return ret;

	ret = rtl8261ce_write_seq(phydev, rtl8261ce_patch_stage2,
				  ARRAY_SIZE(rtl8261ce_patch_stage2));
	if (ret < 0)
		return ret;

	ret = phy_clear_bits_mmd(phydev, MDIO_MMD_VEND2,
				 RTL8261CE_VND2_PATCH_CTRL, BIT(7));
	if (ret < 0)
		return ret;

	ret = rtl8261ce_write_seq(phydev, rtl8261ce_patch_stage3,
				  ARRAY_SIZE(rtl8261ce_patch_stage3));
	if (ret < 0)
		return ret;

	ret = rtl8261ce_write_seq(phydev, rtl8261ce_post_patch_seq,
				  ARRAY_SIZE(rtl8261ce_post_patch_seq));
	if (ret < 0)
		return ret;

	/* Close the gate and leave patch setup mode before triggering execution. */
	ret = phy_clear_bits_mmd(phydev, MDIO_MMD_VEND2,
				 RTL8261CE_VND2_PATCH_GATE, BIT(0));
	if (ret < 0)
		return ret;

	ret = rtl8261ce_write_indirect(phydev, RTL8261CE_INDIRECT_PATCH_SETUP,
				       0x0000);
	if (ret < 0)
		return ret;

	ret = phy_clear_bits_mmd(phydev, MDIO_MMD_VEND2,
				 RTL8261CE_VND2_PATCH_CTRL, BIT(4));
	if (ret < 0)
		return ret;

	ret = rtl8261ce_wait_for_bit(phydev, MDIO_MMD_VEND2,
				     RTL8261CE_VND2_PATCH_STATUS, BIT(6), false,
				     100);
	if (ret < 0)
		return ret;

	ret = phy_set_bits_mmd(phydev, MDIO_MMD_VEND2,
			       RTL8261CE_VND2_PATCH_TRIGGER, BIT(10));
	if (ret < 0)
		return ret;

	/* Wait until the firmware reports that the downloaded patch is live. */
	ret = rtl8261ce_poll_value(phydev, MDIO_MMD_VEND2,
				   RTL8261CE_VND2_PATCH_DONE, 7, 0, 1, true,
				   100);
	if (ret < 0)
		return ret;

	ret = phy_clear_bits_mmd(phydev, MDIO_MMD_VEND2,
				 RTL8261CE_VND2_PATCH_TRIGGER, BIT(10));
	if (ret < 0)
		return ret;

	ret = rtl8261ce_write_indirect(phydev, RTL8261CE_INDIRECT_PATCH_VER,
				       RTL8261CE_PATCH_MARK);
	if (ret < 0)
		return ret;

	/* Re-assert the vendor boot control value used by the recovered flow. */
	ret = phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_BOOT_CTRL,
			    0x9200);
	if (ret < 0)
		return ret;

configure_serdes:
	/* The vendor flow leaves all ten system-side SerDes slots on the same
	 * MAC/PHY selector and mode. This must be re-applied even when the
	 * firmware patch was already loaded on a previous probe.
	 */
	for (serdes = 0; serdes < 10; serdes++) {
		ret = rtl8261ce_serdes_option_set(phydev, serdes, 1, 1, 0);
		if (ret < 0)
			return ret;
	}

	return 0;
}

/* Allocate per-PHY state used to guard the recovered init flow.
 */
static int rtl8261ce_probe(struct phy_device *phydev)
{
	struct rtl8261ce_priv *priv;
	struct device *dev = &phydev->mdio.dev;

	priv = devm_kzalloc(dev, sizeof(*priv), GFP_KERNEL);
	if (!priv)
		return -ENOMEM;

	phydev->priv = priv;

	return rtl8261ce_hwmon_init(phydev);
}

/* Re-apply PHY-side runtime state after a port stop/start, resume, or repeated
 * config_init() call. rtl8261ce_phy_init() skips the heavy firmware download
 * when the patch marker is present, but it still reprograms the system-side
 * SerDes selector that the recovered vendor flow expects.
 */
static int rtl8261ce_restore_runtime_state(struct phy_device *phydev)
{
	int ret;

	ret = rtl8261ce_phy_init(phydev);
	if (ret < 0)
		return ret;

	/* Board polarity must be applied after the vendor SerDes restore because
	 * rtl8261ce_phy_init() rewrites the same CE-specific OCP registers.
	 */
	rtl8261ce_apply_board_serdes_polarity(phydev);

	/* Recovered EEE defaults plus thermal downspeed protection. */
	ret = phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_EEE_CTRL0,
			    0x0067);
	if (ret < 0)
		return ret;

	ret = phy_write_mmd(phydev, MDIO_MMD_VEND2, RTL8261CE_VND2_EEE_CTRL1,
			    0x0010);
	if (ret < 0)
		return ret;

	return phy_set_bits_mmd(phydev, MDIO_MMD_VEND2,
				RTL8261CE_VND2_THERMAL_SENSOR_CTRL,
				RTL8261CE_THERMAL_OVERTEMP_DWNSPD_EN);
}

/* phylib calls config_init() when the PHY is attached. Run the recovered
 * vendor init once, then apply board polarity and the small vendor feature
 * setup that generic C45 helpers do not cover.
 */
static int rtl8261ce_config_init(struct phy_device *phydev)
{
	struct rtl8261ce_priv *priv = phydev->priv;
	int ret;

	if (!priv)
		return -ENODEV;

	if (priv->initialized)
		return rtl8261ce_restore_runtime_state(phydev);

	/* The recovered module sleeps before running the init flow. Removing
	 * this delay can race the internal firmware loader on cold boot.
	 */
	msleep(RTL8261CE_INIT_DELAY_MS);

	ret = rtl8261ce_restore_runtime_state(phydev);
	if (ret < 0)
		return ret;

	priv->initialized = true;

	return 0;
}

/* Report the link modes this vendor driver can support. Generic C45 ability
 * discovery is supplemented with copper modes that are otherwise missed.
 */
static int rtl8261ce_get_features(struct phy_device *phydev)
{
	int ret;

	/* Generic C45 ability discovery covers 2.5G/5G/10G. Add basic copper
	 * modes and the vendor-reported 1000base-T capability explicitly.
	 */
	ret = genphy_c45_pma_read_abilities(phydev);
	if (ret)
		return ret;

	linkmode_or(phydev->supported, phydev->supported, PHY_BASIC_FEATURES);
	linkmode_set_bit(ETHTOOL_LINK_MODE_1000baseT_Full_BIT,
			 phydev->supported);
	linkmode_set_bit(ETHTOOL_LINK_MODE_2500baseT_Full_BIT,
			 phydev->supported);
	linkmode_set_bit(ETHTOOL_LINK_MODE_5000baseT_Full_BIT,
			 phydev->supported);
	linkmode_set_bit(ETHTOOL_LINK_MODE_10000baseT_Full_BIT,
			 phydev->supported);

	return 0;
}

/* Configure auto-negotiation. The generic C45 helper handles the standard
 * pages; RTL8261CE additionally needs its Vendor 2 1000base-T advertisement
 * register programmed.
 */
static int rtl8261ce_config_aneg(struct phy_device *phydev)
{
	struct rtl8261ce_priv *priv = phydev->priv;
	bool changed = false;
	u16 reg = 0;
	int ret;

	if (!priv)
		return -ENODEV;

	if (priv->initialized) {
		/* Bonding and netdev reconfiguration can call into AN setup
		 * after a lower-port stop/start. Replay the CE runtime state
		 * before advertising/restarting AN so RX is not left stale.
		 */
		ret = rtl8261ce_restore_runtime_state(phydev);
		if (ret < 0)
			return ret;
	}

	phydev->mdix_ctrl = ETH_TP_MDI_AUTO;
	if (phydev->autoneg == AUTONEG_DISABLE)
		return genphy_c45_pma_setup_forced(phydev);

	ret = genphy_c45_an_config_aneg(phydev);
	if (ret < 0)
		return ret;
	if (ret > 0)
		changed = true;

	if (linkmode_test_bit(ETHTOOL_LINK_MODE_1000baseT_Full_BIT,
			      phydev->advertising))
		reg |= ADVERTISE_1000FULL;

	/* RTL8261CE keeps 1000base-T advertisement in a Vendor 2 register; the
	 * generic C45 AN (auto-negotiation) helper does not program it.
	 */
	ret = phy_modify_mmd_changed(phydev, MDIO_MMD_VEND2,
				     RTL8261CE_VND2_AN_CTRL1000,
				     ADVERTISE_1000FULL | ADVERTISE_1000HALF,
				     reg);
	if (ret < 0)
		return ret;
	if (ret > 0)
		changed = true;

	return genphy_c45_check_and_restart_aneg(phydev, changed);
}

static int rtl8261ce_resume(struct phy_device *phydev)
{
	struct rtl8261ce_priv *priv = phydev->priv;
	int ret;

	ret = genphy_c45_pma_resume(phydev);
	if (ret < 0 || !priv || !priv->initialized)
		return ret;

	/* PM resume brings the standard PMA block back, then the CE-specific
	 * SerDes selector and board polarity need to be replayed as well.
	 */
	return rtl8261ce_restore_runtime_state(phydev);
}

/* Read link status using the generic C45 path, then fill in the RTL8261CE
 * vendor pieces that generic helpers cannot see: 1000base-T LPA (link partner
 * advertisement) and MDI-X (medium dependent interface crossover).
 */
static int rtl8261ce_read_status(struct phy_device *phydev)
{
	int status;
	int ret;

	phydev->speed = SPEED_UNKNOWN;
	phydev->duplex = DUPLEX_UNKNOWN;
	phydev->pause = 0;
	phydev->asym_pause = 0;

	ret = genphy_c45_read_link(phydev);
	if (ret)
		return ret;

	if (phydev->autoneg == AUTONEG_ENABLE) {
		ret = genphy_c45_read_lpa(phydev);
		if (ret)
			return ret;

		/* genphy_c45_read_lpa() cannot see the vendor 1000base-T LPA
		 * bit, so clear any stale value before adding the fresh value
		 * from RTL8261CE_VND2_AN_STAT1000.
		 */
		linkmode_clear_bit(ETHTOOL_LINK_MODE_1000baseT_Full_BIT,
				   phydev->lp_advertising);

		status = phy_read_mmd(phydev, MDIO_MMD_VEND2,
				      RTL8261CE_VND2_AN_STAT1000);
		if (status < 0)
			return status;

		if (status & LPA_1000FULL)
			linkmode_set_bit(ETHTOOL_LINK_MODE_1000baseT_Full_BIT,
					 phydev->lp_advertising);

		phy_resolve_aneg_linkmode(phydev);
	} else {
		ret = genphy_c45_read_pma(phydev);
		if (ret < 0)
			return ret;
	}

	status = phy_read_mmd(phydev, MDIO_MMD_PMAPMD, MDIO_PMA_10GBT_SWAPPOL);
	if (status < 0)
		return status;

	/* MDI-X state is exposed through the 10GBASE-T PMA swap-polarity
	 * register. Only the two all-normal/all-swapped states map cleanly to
	 * ethtool MDI (medium dependent interface)/MDI-X; mixed pair state is
	 * reported as invalid.
	 */
	switch (status &
		(MDIO_PMA_10GBT_SWAPPOL_ABNX | MDIO_PMA_10GBT_SWAPPOL_CDNX)) {
	case 0:
		phydev->mdix = ETH_TP_MDI_X;
		break;
	case MDIO_PMA_10GBT_SWAPPOL_ABNX | MDIO_PMA_10GBT_SWAPPOL_CDNX:
		phydev->mdix = ETH_TP_MDI;
		break;
	default:
		phydev->mdix = ETH_TP_MDI_INVALID;
		break;
	}

	return 0;
}

/* Register the standalone CE driver. The generic Realtek driver also handles
 * other RTL826x parts, but W1700K2 needs the CE-specific SerDes polarity path.
 */
static struct phy_driver rtl8261ce_drvs[] = {
	{
		PHY_ID_MATCH_MODEL(RTL8261CE_PHY_ID),
		.name = "Realtek RTL8261CE",
		.probe = rtl8261ce_probe,
		.config_init = rtl8261ce_config_init,
		.get_features = rtl8261ce_get_features,
		.suspend = genphy_c45_pma_suspend,
		.resume = rtl8261ce_resume,
		.config_aneg = rtl8261ce_config_aneg,
		.aneg_done = genphy_c45_aneg_done,
		.read_status = rtl8261ce_read_status,
	},
};

module_phy_driver(rtl8261ce_drvs);

/* MDIO match table for module autoload and built-in driver matching. */
static const struct mdio_device_id __maybe_unused
	rtl8261ce_tbl[] = { { PHY_ID_MATCH_MODEL(RTL8261CE_PHY_ID) }, {} };

MODULE_DEVICE_TABLE(mdio, rtl8261ce_tbl);

MODULE_AUTHOR("Realtek");
MODULE_DESCRIPTION("Realtek RTL8261CE PHY driver");
MODULE_LICENSE("GPL");
