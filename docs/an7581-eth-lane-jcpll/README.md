# AN7581 ETH SerDes lane: why the 10G port never links, and how it was found

Reference material for `target/linux/airoha/patches-6.18/998-an7581-eth-jcpll-tclvar.patch`.

On a Gemtek W1700K the `wan` port (PON lane, RTL8261N at MDIO addr 8) links at
10G, while `lan2` (ETH lane, addr 5, `phy-mode = "usxgmii"`) never does. This
directory holds the analysis that located the cause, so the patch can be
reviewed against evidence rather than taken on trust.

## Symptom

* USXGMII in-band AN word (`usxgmii+0x310`) reads `0x00000000`; AN_COMPLETE
  (`+0x318` bit 24) never sets, so `airoha_pcs_get_state_usxgmii()` reports
  link-down forever.
* The failure direction is **SoC TX -> PHY RX**. The PHY system-side SerDes has
  no block lock (SDS page 5 reg 0 = `0x000c`, vs `0x100d` on `wan`), while SoC
  RX from the PHY is locked on both lanes (`BASE_R = 0x1000D`).
* 100 re-init attempts (60 x `ip link down/up`, 40 x PHY driver unbind/rebind,
  i.e. full HW reset) failed identically. On this unit the port was dead 0/100,
  never intermittent.

## Cause

`an7581_pcs_jcpll_bringup()` programs `JCPLL_VCO_TCLVAR` (`pcs_ana + 0x30`,
`GENMASK(2,0)`) in its "Setup VCO" block, which runs **before** the
`/* Enable PLL */` and `/* Enable PLL Output */` writes at the end of that same
function -- and nothing writes the field again afterwards. The driver also never
verifies JCPLL or TXPLL lock anywhere.

The observable behaviour is consistent with the VCO band search only being
(re-)triggered by a TCLVAR change **while the PLL is enabled**: programmed with
the PLL still off, the search settles on a code whose transmit the RTL8261N
cannot lock onto.

## Evidence: the value does not matter, the change does

The first hypothesis was that the ETH lane simply needs the vendor value
`TCLVAR = 0x5` instead of the driver value `0x3`. That was built and flashed,
the register read back `0x0000301D` -- and `lan2` stayed just as dead. The tests
below were then run on that build, each after an `ip link set lan2 up`:

| action after link up | register | result |
| --- | --- | --- |
| nothing (driver wrote `0x5` during bringup) | `0x0000301D` | dead, `sds = 0x000c`, `AN0 = 0` |
| write `0x0000301B` (TCLVAR back to `0x3`) | `0x0000301B` | **link up instantly**, `sds = 0x100d`, `AN0 = 0xF669` |
| write `0x0000301D` again (unchanged value) | `0x0000301D` | dead |

Both `0x3` and `0x5` work as the final value; a write that does not change the
field does nothing. Toggling `0x3 -> 0x5` after the lane is configured gave
5/5 link-ups, and works even with zero delay after `ip link set lan2 up`
returns -- which is why the patch does it from `airoha_pcs_config()` rather than
from a workqueue.

The re-write must happen after the **whole** lane is configured, i.e. after
`bringup` + `airoha_pcs_init()` + the USXGMII AN enable. The end of
`an7581_pcs_bringup()` is too early.

## Reproducing the failure and the fix on a live device

On a stock build, with `lan2` up but dead:

```sh
devmem 0x1fa7a030            # reads 0x0000301B  (TCLVAR = 0x3)
devmem 0x1fa7a030 32 0x0000301D
```

The link comes up within a second or two. `0x1fa7a030` is the ETH lane
`pcs_ana + 0x30`; the PON lane equivalent is `0x1fa8a030` and is left alone.

To watch the PHY system-side SerDes at the same time (needs `mdio-tools` and
`kmod-mdio-netlink`), read SDS page 5 register 0 through the MMD30 indirect
window:

```sh
mdio mt7530_dsa-0 mmd 5:30 raw 323 0x8005 >/dev/null   # select page 5, reg 0
mdio mt7530_dsa-0 mmd 5:30 raw 323 >/dev/null
mdio mt7530_dsa-0 mmd 5:30 raw 322                     # 0x000c -> 0x100d = block lock
```

## Dead ends, so nobody repeats them

* **Do not** apply `pcs_ana+0x0f4 = 0x01000000` from the vendor set. Single-register
  bisection showed it *breaks* the SoC receive path (`BASE_R` drops from
  `0x100D` to `0x0C`).
* `pcs_pma+0x824` bit 24 (`FORCE_SEL_DA_CDR_PR_PWDB`) and `usxgmii+0x2fc`
  bits 9-10 were earlier suspects. Both fixes were built and verified in effect
  at runtime; zero effect on the link.
* Ruled out with live measurements: shared XSI_MAC reset (`RST_CTRL2/1 = 0`),
  the SCU mux (`ETH_XSI_SEL` = USXGMII), manual RX calibration
  (`fl_out = 0x9edf`, the exact USXGMII target, `FBCK_LOCK` set, `PDIDR = 1`),
  SerDes polarity (all four combinations), `AN_ENABLE`, PHY firmware, and the
  copper side (PHY AN completes, copper link up).
* The vendor bootloader writes `pcs_ana+0x30 = 0x301d` **once, early** (position
  8 of ~130 writes in its USXGMII branch), so it does not do a late re-write
  either. Why the lane comes up under stock firmware is still unexplained.

## Files

| file | what it is |
| --- | --- |
| `vendor_seq.txt` | 544 ordered ETH-lane register writes extracted from the stock AXON U-Boot, all four mode branches |
| `branch1_seq.txt` | the USXGMII branch only (`serdes_ethernet` second char `1`), 127 writes / 111 registers -- the one that matters |
| `live_cmp.txt` | full vendor-vs-live comparison, both lanes (124 constant-valued registers: 104 match, 20 differ, 19 of those differ on the working `wan` lane too) |
| `live1.txt` | vendor-vs-live restricted to the USXGMII branch; the comparison that narrowed it to 10 deltas |
| `eth_refs.txt` | the U-Boot functions that touch the ETH lane window `0x1fa7xxxx` |
| `vendor_decomp.c` | Ghidra decompilation of the vendor SerDes init, kept for context on *ordering* |

## How the vendor sequence was extracted

The stock Airoha/AXON bootloader still lives in `mtd0` even after `ubi2` installs
the OpenWrt U-Boot chainloader into `mtd1`. It is LZMA-compressed in five stages;
find the streams by scanning for `0x5D` followed by a plausible dictionary size
and uncompressed length, and decompress with Python `lzma.FORMAT_ALONE`. The
stage at `mtd0` offset `0x02a400` decompresses to 498376 bytes and is the main
**ARM64** U-Boot ("U-Boot 2014.04-rc1 (Jun 26 2024) AXON 2.0"). Load it in
Ghidra headless raw at base 0 with `-processor AARCH64:LE:64:v8A`; ADRP string
references resolve at any page-aligned base.

Seven functions touch the ETH lane; five are named from their debug strings
(`RX_CDR_LPF_RSTB`, `RX_CDR_LPF_L2D`, `SigDet_Int_Init`, `USXGMII_force_data`,
`RX_RDY`), plus the large init routine.

The decisive step was splitting out the per-mode branch. The `serdes_ethernet`
U-Boot environment variable is parsed as two characters: the first must be `1`,
the second selects the mode -- `0` = XFI 10G, **`1` = USXGMII 10G + AN** (the
`else` branch, easy to miss), `2` = HSGMII 2.5G, `4` = SGMII 1G. Comparing only
the `1` branch against the live device left 10 deltas, and single-register
bisection with an interface bounce between each isolated the one that matters.

## Provenance note

`vendor_decomp.c` is machine-generated decompiler output from the stock
bootloader of the device itself, included as documentation of the initialisation
*order*. The patch was written from the driver source and from live register
measurements on the device; no vendor code was copied into it.
