// refs resolved: 294  unique functions: 7

/* ===== FUN_000213c8 @ 000213c8 ===== */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void FUN_000213c8(uint param_1,uint param_2)

{
  if (DAT_0011f691 != '\0') {
    FUN_00012214(s_RX_CDR_LPF_RSTB_mode__x__sel_x_00064d67,param_1 & 0xff,param_2 & 0xff);
  }
  _DAT_1fa7b818 =
       _DAT_1fa7b818 & 0xffff |
       ((param_2 & 0xff | (param_1 & 0xff) << 8) & 0x101 | _DAT_1fa7b818 >> 0x10 & 0xfffffefe) <<
       0x10;
  return;
}



/* ===== FUN_00021434 @ 00021434 ===== */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void FUN_00021434(uint param_1,uint param_2)

{
  if (DAT_0011f691 != '\0') {
    FUN_00012214(s_RX_CDR_LFP_L2D_mode__x__sel__x_00064d47,param_1 & 0xff,param_2 & 0xff);
  }
  _DAT_1fa7b818 =
       _DAT_1fa7b818 & 0xffff0000 |
       (param_2 & 0xff | (param_1 & 0xff) << 8) & 0x101 | _DAT_1fa7b818 & 0xfefe;
  return;
}



/* ===== FUN_000214a0 @ 000214a0 ===== */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void FUN_000214a0(uint param_1)

{
  if (DAT_0011f691 != '\0') {
    FUN_00012214(s_SigDet_Int_Init__en__x_00064eb2,param_1 & 0xff);
  }
  _DAT_1fa7b47c = 0;
  _DAT_1fa7b474 = _DAT_1fa7b474 & 0xfffe0000 | _DAT_1fa7b474 & 0xffff | (param_1 & 1) << 0x10;
  _DAT_1fa7b16c = _DAT_1fa7b16c & 0xfffffffe | param_1 & 1;
  _DAT_1fa7b208 = _DAT_1fa7b208 & 0xfffffeff | 0x100;
  return;
}



/* ===== FUN_0002152c @ 0002152c ===== */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void FUN_0002152c(uint param_1)

{
  if (DAT_0011f691 != '\0') {
    FUN_00012214(s_USXGMII_force_data_xsgmii__x__fo_0006df92,0,param_1 & 0xff);
  }
  if (_DAT_1fa75be8 != 0x7070707) {
    _DAT_1fa75be8 = 0x7070707;
  }
  if ((_DAT_1fa75bf0 & 0xff) != 0xff) {
    _DAT_1fa75bf0 = _DAT_1fa75bf0 | 0xff;
  }
  _DAT_1fa75bf4 = _DAT_1fa75bf4 & 0xfffffffe | param_1 & 1;
  return;
}



/* ===== FUN_000215b8 @ 000215b8 ===== */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void FUN_000215b8(byte param_1)

{
  if (DAT_0011f691 != '\0') {
    FUN_00012214(s_RX_RDY__x__sel__x_00064d87,param_1,0);
  }
  _DAT_1fa7b10c =
       _DAT_1fa7b10c & 0xfe000000 | _DAT_1fa7b10c & 0xffffff | (uint)(param_1 & 1) << 0x18;
  _DAT_1fa7b114 = _DAT_1fa7b114 & 0xfeffffff;
  return;
}



/* ===== FUN_0002166c @ 0002166c ===== */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void FUN_0002166c(void)

{
  uint uVar1;
  bool bVar2;
  uint uVar3;
  ulong uVar4;
  ulong extraout_x1;
  ulong extraout_x1_00;
  ulong extraout_x1_01;
  ulong extraout_x1_02;
  ulong extraout_x1_03;
  ulong extraout_x1_04;
  ulong extraout_x1_05;
  char cVar5;
  uint uVar6;
  uint uVar7;
  
  cVar5 = '\x06';
  uVar6 = 0;
  _DAT_1fa7b360 = 0x30000;
  do {
    cVar5 = cVar5 + -1;
    uVar6 = uVar6 + (_DAT_1fa7b380 >> 8 & 1) & 0xff;
  } while (cVar5 != '\0');
  if (DAT_0011f691 != '\0') {
    FUN_00012214(s_RX_SigDet_Flag__cnt__x_0006dc39,uVar6);
  }
  uVar7 = _DAT_1fa75930 & 0xffff;
  if (DAT_0011f691 != '\0') {
    FUN_00012214(s_eth_xsgmii__usxgmii_isr_signal___0006dc51,3 < uVar6,uVar7);
  }
  uVar3 = _DAT_1fa7b47c;
  if ((_DAT_1fa7b474 >> 0x10 & 1) != 0) {
    if (DAT_0011f691 != '\0') {
      FUN_00012214(s_rx_sigdet_int__x_0006dc7d,_DAT_1fa7b47c >> 0x10 & 1);
    }
    bVar2 = false;
    if ((uVar3 >> 0x10 & 1) != 0) {
      if (DAT_0011f691 != '\0') {
        FUN_00012214(s________________rx_sigdet_int_isr_0006dc8f);
      }
      uVar1 = _DAT_1fa7b818 >> 8 & 1;
      if (DAT_0011f691 != '\0') {
        FUN_00012214(s_RX_CDR_LFP_L2D_sta__x_0006dcc5,uVar1);
      }
      if (uVar1 != 0) {
        if (DAT_0011f691 != '\0') {
          FUN_00012214(s_RX_CDR_RST_0006dcdc);
        }
        FUN_00021434(1,0);
        FUN_000213c8(1,0);
        FUN_00037c5c(700);
        FUN_000213c8(1);
        FUN_00037c5c(100);
        FUN_00021434(1);
        FUN_000213c8(0,1);
        FUN_00021434(0,1);
      }
      uVar1 = _DAT_1fa7b10c;
      if (DAT_0011f691 != '\0') {
        FUN_00012214(s_RX_RDY_Sta__x_0006dce8,_DAT_1fa7b10c >> 0x18 & 1);
      }
      if ((uVar1 >> 0x18 & 1) == 0) {
        FUN_000215b8(1);
      }
      bVar2 = true;
      FUN_000214a0(0);
    }
    _DAT_1fa7b47c = uVar3;
    if ((DAT_0011f691 != '\0') &&
       (FUN_00012214(s__XPON_INT_STA_3__x_0006dcf8,uVar3), DAT_0011f691 != '\0')) {
      FUN_00012214(s________________rx_sigdet_int_isr_0006dd0c);
    }
    if (bVar2) {
      return;
    }
  }
  uVar1 = _DAT_1fa75be4;
  uVar3 = _DAT_1fa75bdc;
  uVar4 = (ulong)_DAT_1fa75bd8;
  if ((DAT_0011f691 != '\0') &&
     (FUN_00012214(s_Interrupt_sta_rg_xfi_pcs_int_sta_0006dd41,uVar4,_DAT_1fa75bdc,_DAT_1fa75be4),
     uVar4 = extraout_x1, DAT_0011f691 != '\0')) {
    FUN_00012214(s_link_up_st_int__x_0006dd9b,uVar3 >> 8 & 1);
    uVar4 = extraout_x1_00;
  }
  if ((uVar3 >> 8 & 1) == 0) {
    _DAT_0011f694 = _DAT_0011f694 & 0xfffffeff;
  }
  else {
    if (DAT_0011f691 != '\0') {
      FUN_00012214(s________________link_up_st_int_is_0006ddae,uVar4);
      uVar4 = extraout_x1_01;
    }
    if (3 < uVar6) {
      uVar7 = _DAT_1fa75930 & 0xffff;
    }
    if (DAT_0011f691 != '\0') {
      FUN_00012214(s_link_up_st_int_sync____x_0006dde5,uVar7);
      uVar4 = extraout_x1_02;
    }
    if (3 < uVar6 && uVar7 == 0x100d) {
      _DAT_0011f694 = _DAT_0011f694 | 0x100;
      FUN_0002152c(0);
      uVar4 = extraout_x1_03;
    }
    else {
      _DAT_0011f694 = _DAT_0011f694 & 0xfffffeff;
    }
    if (DAT_0011f691 != '\0') {
      FUN_00012214(s________________link_up_st_int_is_0006ddff,uVar4);
      uVar4 = extraout_x1_04;
    }
  }
  if (DAT_0011f691 != '\0') {
    FUN_00012214(s_link_down_st_int__x_0006de36,uVar1 & 1);
    uVar4 = extraout_x1_05;
  }
  if ((uVar1 & 1) == 0) {
    _DAT_0011f694 = _DAT_0011f694 & 0xfffffdff;
  }
  else {
    if (DAT_0011f691 != '\0') {
      FUN_00012214(s________________link_down_st_int_i_0006de4b,uVar4);
    }
    if (uVar7 == 0x100d || 3 < uVar6) {
      _DAT_0011f694 = _DAT_0011f694 & 0xfffffdff;
    }
    else {
      _DAT_0011f694 = _DAT_0011f694 | 0x200;
      FUN_0002152c(1);
      FUN_000215b8(0);
      FUN_00021434(1,0);
      FUN_000214a0(1);
      FUN_0002161c();
    }
    if (DAT_0011f691 == '\0') goto LAB_000219e0;
    FUN_00012214(s________________link_down_st_int_i_0006de84);
  }
  if (DAT_0011f691 != '\0') {
    FUN_00012214(s_usxgmii_linkup_sta__x_linkdn_sta_0006debd,_DAT_0011f694 >> 8 & 1,
                 _DAT_0011f694 >> 9 & 1);
  }
LAB_000219e0:
  _DAT_1fa75bd8 = 0x1010101;
  _DAT_1fa75bdc = 0x1010101;
  _DAT_1fa75be4 = 1;
  if (DAT_0011f691 == '\0') {
    _DAT_1fa75be4 = 1;
    _DAT_1fa75bdc = 0x1010101;
    _DAT_1fa75bd8 = 0x1010101;
    return;
  }
  FUN_00012214(s_After_clear__rg_xfi_pcs_int_sta__0006dee2,0x1010101,0x1010101,1);
  return;
}



/* ===== FUN_00021a90 @ 00021a90 ===== */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */

void FUN_00021a90(void)

{
  char cVar1;
  uint uVar2;
  uint uVar3;
  int iVar4;
  long lVar5;
  char *pcVar6;
  uint uVar7;
  uint uVar8;
  uint uVar9;
  
  lVar5 = FUN_00011a40(s_serdes_ethernet_0006da26);
  FUN_00011a40(s_serdes_usb1_0006da50);
  FUN_00011a40(s_serdes_wifi1_0006da36);
  FUN_00011a40(s_serdes_wifi2_0006da43);
  iVar4 = FUN_00037964(lVar5);
  if (iVar4 < 2) {
    FUN_00012214(s_ecnt_eth_check_serdes_error_eth__00067a6e + 0x16,iVar4);
    return;
  }
  lVar5 = lVar5 + iVar4;
  if (*(char *)(lVar5 + -2) != '1') {
    return;
  }
  cVar1 = *(char *)(lVar5 + -1);
  if (cVar1 == '0') {
    FUN_00012214(s_ETH_VER___ETH_2_2_1_R_0006a7be);
    _DAT_1fb00094 = 0xe0002820;
    _DAT_1fa7a000 = 0x10040001;
    _DAT_1fa7a01c = 0x104;
    _DAT_1fa7a020 = 0x30000;
    _DAT_1fa7a038 = 0;
    _DAT_1fa7a034 = 0;
    _DAT_1fa7a004 = 0x180000;
    _DAT_1fa7a008 = 0x101f0a;
    _DAT_1fa7a030 = 0x301d;
    uVar9 = 0x100;
    _DAT_1fa7b800 = 0x25800000;
    _DAT_1fa7b79c = 0x10000;
    _DAT_1fa7a014 = 0x10000;
    _DAT_1fa7a02c = 0x4010100;
    _DAT_1fa7a010 = 0x1000300;
    _DAT_1fa7a00c = 0x2e40000;
    _DAT_1fa7a048 = 0xf20ff;
    _DAT_1fa7a024 = 0x5010100;
    _DAT_1fa7a028 = 0x10400;
    _DAT_1fa7b828 = 0x1010101;
    _DAT_1fa7a064 = 0x1040001;
    _DAT_1fa7a068 = 0;
    _DAT_1fa7a080 = 0;
    _DAT_1fa7a07c = 0;
    _DAT_1fa7a084 = 0x1010000;
    _DAT_1fa7a050 = 0x1f05000f;
    _DAT_1fa7a078 = 0x4040701;
    uVar8 = 0;
    _DAT_1fa7b798 = 0x8400000;
    _DAT_1fa7a058 = 0x30004e4;
    _DAT_1fa7a054 = 0x180b02;
    _DAT_1fa7a05c = 1;
    _DAT_1fa7a094 = 0x1000f;
    _DAT_1fa7a070 = 0x4000b03;
    _DAT_1fa7a074 = 0x1000001;
    _DAT_1fa7a06c = 0x1010003;
    _DAT_1fa7b854 = 0x1010101;
    _DAT_1fa7b580 = 2;
    _DAT_1fa7a0c4 = 0x1010401;
    _DAT_1fa7b874 = 0x1010000;
    _DAT_1fa7b77c = 0x1050101;
    _DAT_1fa7b784 = 0x102;
    _DAT_1fa7b778 = 0x1010101;
    _DAT_1fa7b780 = 0x10b;
    _DAT_1fa7b260 = 0x101;
    _DAT_1fa7b374 = 2;
    _DAT_1fa7b184 = 0x40003ff;
    _DAT_1fa7a148 = 0x1010101;
    _DAT_1fa7a144 = 0x1000000;
    _DAT_1fa7a11c = 0x2000401;
    _DAT_1fa7b004 = 0xc100a01;
    _DAT_1fa7a13c = 0x20000;
    _DAT_1fa7a120 = 0x3ff08;
    _DAT_1fa7b320 = 0x10101;
    _DAT_1fa7b48c = 0x1000202;
    _DAT_1fa7b80c = 0x1000000;
    _DAT_1fa7b814 = 0x1010000;
    _DAT_1fa7b88c = 0;
    _DAT_1fa7b768 = 0;
    _DAT_1fa7b390 = 0x100001;
    _DAT_1fa7b394 = 0xffff0000;
    _DAT_1fa7b39c = 0x3107;
    _DAT_1fa7a0d4 = 0xc8c31030;
    _DAT_1fa7b100 = 0xa0005;
    _DAT_1fa7b08c = 0x101;
    _DAT_1fa7b104 = 2;
    _DAT_1fa7b090 = 0x320002;
    _DAT_1fa7b09c = 0x320002;
    _DAT_1fa7b094 = 0x320002;
    _DAT_1fa7b098 = 0x320002;
    _DAT_1fa7b76c = 0x1000000;
    _DAT_1fa7a0dc = 0;
    _DAT_1fa7a0e8 = 0x2000000;
    _DAT_1fa7a0f8 = 0x4010808;
    _DAT_1fa7a0fc = 0x80606;
    _DAT_1fa7b120 = 0x103;
    _DAT_1fa7b088 = 1;
    _DAT_1fa7b38c = 1;
    _DAT_1fa7b000 = 0x1000000;
    _DAT_1fa7b33c = 0x1010100;
    _DAT_1fa7b330 = 1;
    _DAT_1fa7a118 = 0x1010100;
    _DAT_1fa7a10c = 0x70604;
    _DAT_1fa7a114 = 0x1020200;
    _DAT_1fa7a110 = 0x3000200;
    _DAT_1fa7a0d8 = 0x10242;
    _DAT_1fa7a0cc = 0x1000000;
    _DAT_1fa7b81c = 0x101;
    _DAT_1fa7b894 = 0x101;
    _DAT_1fa7b84c = 0x1010000;
    _DAT_1fa7b34c = 0x1010101;
    _DAT_1fa7b350 = 1;
    _DAT_1fa7b818 = 0x100;
    _DAT_1fa7b460 = 0x20;
    _DAT_1fa7b150 = 0x9f439e7b;
    _DAT_1fa7b14c = 0x7fff7fff;
    _DAT_1fa7b154 = 0x9f439e7b;
    _DAT_1fa7a0f4 = 0x1000000;
    _DAT_1fa7b820 = 0x1010100;
    _DAT_1fa7b794 = 0x1010000;
    _DAT_1fa7b824 = 0x1010101;
    do {
      _DAT_1fa7b794 = _DAT_1fa7b794 & 0xfffff800 | uVar9 & 0x7ff;
      _DAT_1fa7b158 = 0x3303;
      FUN_00037c5c(5000);
      uVar7 = _DAT_1fa7b794;
      uVar2 = _DAT_1fa7b530 >> 0x10;
      FUN_00012214(s_pr_idac___0x_x__RO_FL_Out___0x_x_0006a7d5,_DAT_1fa7b794 & 0x7ff,uVar2);
      if (0x9edf < uVar2) {
        FUN_00012214(s_cdr_pr_idac_tmp___0x_x_0006a7f7,uVar9);
        uVar8 = uVar9;
      }
      uVar9 = uVar9 + 0x100;
    } while (uVar9 != 0x800);
    uVar9 = 7;
    do {
      uVar2 = 1 << (ulong)(uVar9 & 0x1f);
      uVar8 = uVar8 | uVar2;
      uVar7 = uVar7 & 0xfffff800 | uVar8 & 0x7ff;
      _DAT_1fa7b158 = 0x3303;
      _DAT_1fa7b794 = uVar7;
      FUN_00037c5c(5000);
      uVar3 = _DAT_1fa7b530 >> 0x10;
      FUN_00012214(s_pr_idac___0x_x__RO_FL_Out___0x_x_0006a7d5,uVar8);
      if (uVar3 < 0x9edf) {
        uVar8 = uVar8 & (uVar2 ^ 0xffffffff);
      }
      uVar9 = uVar9 - 1;
      FUN_00012214(s_cdr_pr_idac_tmp___0x_x_0006a7f7,uVar8);
    } while (uVar9 != 0xffffffff);
    _DAT_1fa7b794 = uVar8;
    FUN_00012214(s_sel_cdr_pr_idac___0x_x_0006a80f,uVar8);
    _DAT_1fa7b158 = 0x3303;
    FUN_00037c5c(5000);
    FUN_00012214(s_RO_state_freqdet___0x_x_0006a827,_DAT_1fa7b530 & 1);
    _DAT_1fa7a0f4 = _DAT_1fa7a0f4 & 0xfeffffff;
    _DAT_1fa7b794 = _DAT_1fa7b794 & 0xfffeffff;
    _DAT_1fa7b820 = _DAT_1fa7b820 & 0xfefefefe | 0x1010000;
    _DAT_1fa7b19c = _DAT_1fa7b19c | 1;
    _DAT_1fa7b174 = _DAT_1fa7b174 & 0xfffff800 | uVar8 & 0x7ff;
    _DAT_1fa7b824 = _DAT_1fa7b824 & 0xfefeffff | 0x10000;
    _DAT_1fa7b460 = (DAT_0003f80c >> 0x10 & 1) << 5;
    _DAT_1fa7b818 = 0x1000100;
    FUN_00037c5c(700);
    _DAT_1fa7b818 = 0x1010100;
    FUN_00037c5c(100);
    _DAT_1fa7b460 = 0xfff;
    _DAT_1fa7b818 = 0x1000100;
    FUN_00037c5c(700);
    _DAT_1fa7b818 = 0x1010100;
    FUN_00037c5c(100);
    _DAT_1fa7b818 = 0x10001;
    _DAT_1fa74100 = 0x10010001;
    _DAT_1fa75b2c = 0;
    _DAT_1fa75bc0 = 0;
    _DAT_1fa75bc4 = 0;
    _DAT_1fa75bd8 = 0;
    _DAT_1fa75bdc = 0;
    _DAT_1fa75be4 = 0;
    _DAT_1fa75bc8 = 0;
    _DAT_1fa75bcc = 0;
    _DAT_1fa75be0 = 0;
    _DAT_1fa75bf8 = 0x6330000;
    _DAT_1fa75bfc = 0x1001;
    _DAT_1fa76000 = 0xc000c11;
    _DAT_1fa7602c = 0x104;
    _DAT_1fa09000 = 0x71082800;
    FUN_00012214(s_set_mac_reg_init_0006a840);
    _DAT_1fa75c20 = 0x1000;
    pcVar6 = s_XFI_10G_exit_0006a852;
  }
  else if (cVar1 == '2') {
    FUN_00012214(s_ETH_VER___ETH_2_2_1_R_0006a7be);
    _DAT_1fa7a000 = 0x10040001;
    _DAT_1fa7a01c = 0x104;
    _DAT_1fa7a020 = 0x30000;
    _DAT_1fa7a038 = 0;
    _DAT_1fa7a034 = 0;
    _DAT_1fa7a004 = 0x180000;
    _DAT_1fa7a008 = 0x101f0a;
    uVar9 = 0x100;
    _DAT_1fa7a030 = 0x301d;
    _DAT_1fa7b800 = 0x25800000;
    _DAT_1fa7a014 = 0x10000;
    _DAT_1fa7a02c = 0x4010100;
    _DAT_1fa7a010 = 0x1000300;
    _DAT_1fa7a00c = 0x2e40000;
    _DAT_1fa7a048 = 0x1020ff;
    _DAT_1fa7a024 = 0x5010100;
    _DAT_1fa7a028 = 0x10400;
    _DAT_1fa7b828 = 0x1010101;
    _DAT_1fa7a064 = 0x1040001;
    _DAT_1fa7a068 = 0;
    _DAT_1fa7a06c = 0x1000003;
    _DAT_1fa7a080 = 0;
    _DAT_1fa7a07c = 0;
    _DAT_1fa7a084 = 0x1010000;
    _DAT_1fa7a050 = 0x1f05000a;
    _DAT_1fa7a078 = 0x4040701;
    _DAT_1fa7b798 = 0xa000000;
    _DAT_1fa7a058 = 0x30004e4;
    uVar8 = 0;
    _DAT_1fa7a054 = 5;
    _DAT_1fa7a05c = 1;
    _DAT_1fa7a074 = 0x10001;
    _DAT_1fa7a0940 = 0x1000f;
    _DAT_1fa7a0700 = 0x4000d03;
    _DAT_1fa7a0740 = 0x10001;
    _DAT_1fa7a06c0 = 0x1000003;
    _DAT_1fa7b854 = 0x1010101;
    _DAT_1fa7b580 = 1;
    _DAT_1fa7a0c4 = 0x1010401;
    _DAT_1fa7b874 = 0x1010000;
    _DAT_1fa7b77c = 0x1040101;
    _DAT_1fa7b784 = 0x101;
    _DAT_1fa7b778 = 0x100010b;
    _DAT_1fa7b780 = 0x101;
    _DAT_1fa7b260 = 0x101;
    _DAT_1fa7b374 = 0;
    _DAT_1fa7b184 = 0x40003ff;
    _DAT_1fa7a148 = 0x1010101;
    _DAT_1fa7a144 = 0x1000000;
    _DAT_1fa7a11c = 0x2000401;
    _DAT_1fa7b004 = 0xc100a01;
    _DAT_1fa7a13c = 0x20000;
    _DAT_1fa7a120 = 0x3ff08;
    _DAT_1fa7b320 = 0x10101;
    _DAT_1fa7b48c = 0x1000202;
    _DAT_1fa7b80c = 0x1000000;
    _DAT_1fa7b814 = 0x1010000;
    _DAT_1fa7b88c = 0;
    _DAT_1fa7b768 = 0;
    _DAT_1fa7b79c = 0x10100;
    _DAT_1fa7b390 = 0x100001;
    _DAT_1fa7b394 = 0xffff0000;
    _DAT_1fa7b39c = 0x3107;
    _DAT_1fa7a0d4 = 0xc8c31030;
    _DAT_1fa7b100 = 0xa0005;
    _DAT_1fa7b08c = 0x101;
    _DAT_1fa7b104 = 2;
    _DAT_1fa7b090 = 0x320002;
    _DAT_1fa7b09c = 0x320002;
    _DAT_1fa7b094 = 0x320002;
    _DAT_1fa7b098 = 0x320002;
    _DAT_1fa7b76c = 0x1010000;
    _DAT_1fa7a0dc = 0x100;
    _DAT_1fa7a0e8 = 0x2000001;
    _DAT_1fa7a0f8 = 0x4010806;
    _DAT_1fa7a0fc = 0x60606;
    _DAT_1fa7b120 = 0x103;
    _DAT_1fa7b088 = 1;
    _DAT_1fa7b38c = 1;
    _DAT_1fa7b000 = 0x1000000;
    _DAT_1fa7b33c = 0x1010100;
    _DAT_1fa7b330 = 1;
    _DAT_1fa7a118 = 0x1010100;
    _DAT_1fa7a10c = 0xe0604;
    _DAT_1fa7a114 = 0x1020200;
    _DAT_1fa7a110 = 0x3000200;
    _DAT_1fa7a0d8 = 0x1010b;
    _DAT_1fa7a0cc = 0x1000000;
    _DAT_1fa7b81c = 0x101;
    _DAT_1fa7b894 = 0x101;
    _DAT_1fa7b84c = 0x1010000;
    _DAT_1fa7b34c = 0x1010101;
    _DAT_1fa7b350 = 1;
    _DAT_1fa7b818 = 0x100;
    _DAT_1fa7b460 = 0x20;
    _DAT_1fa7b150 = 0xa0649f9c;
    _DAT_1fa7b14c = 0x4e204e20;
    _DAT_1fa7b154 = 0xa0649f9c;
    _DAT_1fa7a0f4 = 0x1000000;
    _DAT_1fa7b820 = 0x1010100;
    _DAT_1fa7b794 = 0x1010000;
    _DAT_1fa7b824 = 0x1010101;
    do {
      _DAT_1fa7b794 = _DAT_1fa7b794 & 0xfffff800 | uVar9 & 0x7ff;
      _DAT_1fa7b158 = 0x3303;
      FUN_00037c5c(5000);
      uVar7 = _DAT_1fa7b794;
      uVar2 = _DAT_1fa7b530 >> 0x10;
      FUN_00012214(s_pr_idac___0x_x__RO_FL_Out___0x_x_0006a7d5,_DAT_1fa7b794 & 0x7ff,uVar2);
      if (0xa000 < uVar2) {
        FUN_00012214(s_cdr_pr_idac_tmp___0x_x_0006a7f7,uVar9);
        uVar8 = uVar9;
      }
      uVar9 = uVar9 + 0x100;
    } while (uVar9 != 0x800);
    uVar9 = 7;
    do {
      uVar2 = 1 << (ulong)(uVar9 & 0x1f);
      uVar8 = uVar8 | uVar2;
      uVar7 = uVar7 & 0xfffff800 | uVar8 & 0x7ff;
      _DAT_1fa7b158 = 0x3303;
      _DAT_1fa7b794 = uVar7;
      FUN_00037c5c(5000);
      uVar3 = _DAT_1fa7b530 >> 0x10;
      FUN_00012214(s_pr_idac___0x_x__RO_FL_Out___0x_x_0006a7d5,uVar8);
      if (uVar3 < 0xa000) {
        uVar8 = uVar8 & (uVar2 ^ 0xffffffff);
      }
      uVar9 = uVar9 - 1;
      FUN_00012214(s_cdr_pr_idac_tmp___0x_x_0006a7f7,uVar8);
    } while (uVar9 != 0xffffffff);
    _DAT_1fa7b794 = uVar8;
    FUN_00012214(s_sel_cdr_pr_idac___0x_x_0006a80f,uVar8);
    _DAT_1fa7b158 = 0x3303;
    FUN_00037c5c(5000);
    FUN_00012214(s_RO_state_freqdet___0x_x_0006a827,_DAT_1fa7b530 & 1);
    _DAT_1fa7a0f4 = _DAT_1fa7a0f4 & 0xfeffffff;
    _DAT_1fa7b794 = _DAT_1fa7b794 & 0xfffeffff;
    _DAT_1fa7b820 = _DAT_1fa7b820 & 0xfefefefe | 0x1010000;
    _DAT_1fa7b19c = _DAT_1fa7b19c | 1;
    _DAT_1fa7b174 = _DAT_1fa7b174 & 0xfffff800 | uVar8 & 0x7ff;
    _DAT_1fa7b824 = _DAT_1fa7b824 & 0xfefeffff | 0x10000;
    _DAT_1fa7b460 = (DAT_0003f80c >> 0x10 & 1) << 5;
    _DAT_1fa7b818 = 0x1000100;
    FUN_00037c5c(700);
    _DAT_1fa7b818 = 0x1010100;
    FUN_00037c5c(100);
    _DAT_1fa7b460 = 0xfff;
    _DAT_1fa7b818 = 0x1000100;
    FUN_00037c5c(700);
    _DAT_1fa7b818 = 0x1010100;
    FUN_00037c5c(100);
    _DAT_1fa7b818 = 0x10001;
    _DAT_1fa70a00 = 0x4c9cc000;
    _DAT_1fa74018 = 0x34;
    _DAT_1fa70000 = 0x140;
    _DAT_1fa76000 = 0xc000c11;
    pcVar6 = s_HSGMII_2_5_exit_0006a860;
  }
  else if (cVar1 == '4') {
    FUN_00012214(s_ETH_VER___ETH_2_2_1_R_0006a7be);
    _DAT_1fa7a000 = 0x10040001;
    _DAT_1fa7a01c = 0x104;
    _DAT_1fa7a020 = 0x30000;
    _DAT_1fa7a038 = 0;
    _DAT_1fa7a034 = 0;
    _DAT_1fa7a004 = 0x180000;
    _DAT_1fa7a008 = 0x101f0a;
    _DAT_1fa7a030 = 0x301d;
    uVar9 = 0x100;
    _DAT_1fa7b800 = 0x25800000;
    _DAT_1fa7a014 = 0x10000;
    _DAT_1fa7a02c = 0x4010100;
    _DAT_1fa7a010 = 0x1000300;
    _DAT_1fa7a00c = 0x2e40000;
    _DAT_1fa7a048 = 0x1020ff;
    _DAT_1fa7a024 = 0x5010100;
    _DAT_1fa7a028 = 0x10400;
    _DAT_1fa7b828 = 0x1010101;
    _DAT_1fa7a064 = 0x1040001;
    _DAT_1fa7a068 = 0;
    _DAT_1fa7a080 = 0;
    _DAT_1fa7a07c = 0;
    _DAT_1fa7a084 = 0x1010000;
    _DAT_1fa7a050 = 0x1f05000f;
    uVar8 = 0;
    _DAT_1fa7a078 = 0x4040701;
    _DAT_1fa7b798 = 0x8000000;
    _DAT_1fa7a058 = 0x30004e4;
    _DAT_1fa7a054 = 0x180b02;
    _DAT_1fa7a05c = 1;
    _DAT_1fa7a094 = 0x1000f;
    _DAT_1fa7a070 = 0x4000b03;
    _DAT_1fa7a074 = 0x3000001;
    _DAT_1fa7a06c = 0x1000003;
    _DAT_1fa7b854 = 0x1010101;
    _DAT_1fa7b580 = 1;
    _DAT_1fa7a0c4 = 0x1010401;
    _DAT_1fa7b874 = 0x1010000;
    _DAT_1fa7b77c = 0x1020101;
    _DAT_1fa7b784 = 0x101;
    _DAT_1fa7b778 = 0x100010c;
    _DAT_1fa7b780 = 0x100;
    _DAT_1fa7b260 = 0x101;
    _DAT_1fa7b374 = 0;
    _DAT_1fa7b184 = 0x40003ff;
    _DAT_1fa7a148 = 0x1010101;
    _DAT_1fa7a144 = 0x1000000;
    _DAT_1fa7a11c = 0x2000401;
    _DAT_1fa7b004 = 0xc100a01;
    _DAT_1fa7a13c = 0x20000;
    _DAT_1fa7a120 = 0x3ff08;
    _DAT_1fa7b320 = 0x10101;
    _DAT_1fa7b48c = 0x1000202;
    _DAT_1fa7b80c = 0x1000000;
    _DAT_1fa7b814 = 0x1010000;
    _DAT_1fa7b88c = 0;
    _DAT_1fa7b768 = 0;
    _DAT_1fa7b79c = 0x10100;
    _DAT_1fa7b390 = 0x100001;
    _DAT_1fa7b394 = 0xffff0000;
    _DAT_1fa7b39c = 0x3107;
    _DAT_1fa7a0d4 = 0xc8c31030;
    _DAT_1fa7b100 = 0xa0005;
    _DAT_1fa7b08c = 0x101;
    _DAT_1fa7b104 = 2;
    _DAT_1fa7b090 = 0x320002;
    _DAT_1fa7b09c = 0x320002;
    _DAT_1fa7b094 = 0x320002;
    _DAT_1fa7b098 = 0x320002;
    _DAT_1fa7b76c = 0x1030000;
    _DAT_1fa7a0dc = 0x100;
    _DAT_1fa7a0e8 = 0x2000003;
    _DAT_1fa7a0f8 = 0x4010808;
    _DAT_1fa7a0fc = 0x80606;
    _DAT_1fa7b120 = 0x103;
    _DAT_1fa7b088 = 1;
    _DAT_1fa7b38c = 1;
    _DAT_1fa7b000 = 0x1000000;
    _DAT_1fa7b33c = 0x1010100;
    _DAT_1fa7b330 = 1;
    _DAT_1fa7a118 = 0x1010100;
    _DAT_1fa7a10c = 0x70604;
    _DAT_1fa7a114 = 0x1020200;
    _DAT_1fa7a110 = 0x3000200;
    _DAT_1fa7a0d8 = 0x10129;
    _DAT_1fa7a0cc = 0x1000000;
    _DAT_1fa7b81c = 0x101;
    _DAT_1fa7b894 = 0x101;
    _DAT_1fa7b84c = 0x1010000;
    _DAT_1fa7b34c = 0x1010101;
    _DAT_1fa7b350 = 1;
    _DAT_1fa7b818 = 0x100;
    _DAT_1fa7b460 = 0x20;
    _DAT_1fa7b150 = 0xa43aa372;
    _DAT_1fa7b14c = 0x7fff7fff;
    _DAT_1fa7b154 = 0xa43aa372;
    _DAT_1fa7a0f4 = 0x1000000;
    _DAT_1fa7b820 = 0x1010100;
    _DAT_1fa7b794 = 0x1010000;
    _DAT_1fa7b824 = 0x1010101;
    do {
      _DAT_1fa7b794 = _DAT_1fa7b794 & 0xfffff800 | uVar9 & 0x7ff;
      _DAT_1fa7b158 = 0x3303;
      FUN_00037c5c(5000);
      uVar7 = _DAT_1fa7b794;
      uVar2 = _DAT_1fa7b530 >> 0x10;
      FUN_00012214(s_pr_idac___0x_x__RO_FL_Out___0x_x_0006a7d5,_DAT_1fa7b794 & 0x7ff,uVar2);
      if (0xa3d6 < uVar2) {
        FUN_00012214(s_cdr_pr_idac_tmp___0x_x_0006a7f7,uVar9);
        uVar8 = uVar9;
      }
      uVar9 = uVar9 + 0x100;
    } while (uVar9 != 0x800);
    uVar9 = 7;
    do {
      uVar2 = 1 << (ulong)(uVar9 & 0x1f);
      uVar8 = uVar8 | uVar2;
      uVar7 = uVar7 & 0xfffff800 | uVar8 & 0x7ff;
      _DAT_1fa7b158 = 0x3303;
      _DAT_1fa7b794 = uVar7;
      FUN_00037c5c(5000);
      uVar3 = _DAT_1fa7b530 >> 0x10;
      FUN_00012214(s_pr_idac___0x_x__RO_FL_Out___0x_x_0006a7d5,uVar8);
      if (uVar3 < 0xa3d6) {
        uVar8 = uVar8 & (uVar2 ^ 0xffffffff);
      }
      uVar9 = uVar9 - 1;
      FUN_00012214(s_cdr_pr_idac_tmp___0x_x_0006a7f7,uVar8);
    } while (uVar9 != 0xffffffff);
    _DAT_1fa7b794 = uVar8;
    FUN_00012214(s_sel_cdr_pr_idac___0x_x_0006a80f,uVar8);
    _DAT_1fa7b158 = 0x3303;
    FUN_00037c5c(5000);
    FUN_00012214(s_RO_state_freqdet___0x_x_0006a827,_DAT_1fa7b530 & 1);
    _DAT_1fa7a0f4 = _DAT_1fa7a0f4 & 0xfeffffff;
    _DAT_1fa7b794 = _DAT_1fa7b794 & 0xfffeffff;
    _DAT_1fa7b820 = _DAT_1fa7b820 & 0xfefefefe | 0x1010000;
    _DAT_1fa7b19c = _DAT_1fa7b19c | 1;
    _DAT_1fa7b174 = _DAT_1fa7b174 & 0xfffff800 | uVar8 & 0x7ff;
    _DAT_1fa7b824 = _DAT_1fa7b824 & 0xfefeffff | 0x10000;
    _DAT_1fa7b460 = (DAT_0003f80c >> 0x10 & 1) << 5;
    _DAT_1fa7b818 = 0x1000100;
    FUN_00037c5c(700);
    _DAT_1fa7b818 = 0x1010100;
    FUN_00037c5c(100);
    _DAT_1fa7b460 = 0xfff;
    _DAT_1fa7b818 = 0x1000100;
    FUN_00037c5c(700);
    _DAT_1fa7b818 = 0x1010100;
    FUN_00037c5c(100);
    _DAT_1fa7b818 = 0x10001;
    _DAT_1fa70034 = 0x31120029;
    _DAT_1fa70a24 = 1;
    _DAT_1fa70a00 = 0x4c9cc000;
    _DAT_1fa76018 = 0x7070707;
    _DAT_1fa76020 = 0xff;
    _DAT_1fa74014 = 1;
    _DAT_1fa70a20 = 1;
    _DAT_1fa7414c = 1;
    _DAT_1fa70000 = 0x140;
    _DAT_1fa76000 = 0xc000c11;
    pcVar6 = s_SGMII_1G_exit_0006a871;
    _DAT_1fa74018 = 0x24;
  }
  else {
    if (cVar1 != '1') {
      return;
    }
    FUN_00012214(s_ETH_VER___ETH_2_2_1_R_0006a7be);
    if ((iVar4 != 2) && (*(char *)(lVar5 + -3) == '\x02')) {
      FUN_0001f828(0,4,&DAT_0000c441,8);
    }
    _DAT_1fb00094 = 0xe0002820;
    _DAT_1fa7a000 = 0x10040001;
    _DAT_1fa7a01c = 0x104;
    _DAT_1fa7a020 = 0x30000;
    _DAT_1fa7a038 = 0;
    _DAT_1fa7a034 = 0;
    _DAT_1fa7a004 = 0x180000;
    _DAT_1fa7a008 = 0x101f0a;
    _DAT_1fa7a030 = 0x301d;
    uVar9 = 0x100;
    _DAT_1fa7b800 = 0x25800000;
    _DAT_1fa7b79c = 0x10000;
    _DAT_1fa7a014 = 0x10000;
    _DAT_1fa7a02c = 0x4010100;
    _DAT_1fa7a010 = 0x1000300;
    _DAT_1fa7a00c = 0x2e40000;
    _DAT_1fa7a048 = 0xf20ff;
    _DAT_1fa7a024 = 0x5010100;
    _DAT_1fa7a028 = 0x10400;
    _DAT_1fa7b828 = 0x1010101;
    _DAT_1fa7a064 = 0x1040001;
    _DAT_1fa7a068 = 0;
    _DAT_1fa7a080 = 0;
    _DAT_1fa7a07c = 0;
    _DAT_1fa7a084 = 0x1010000;
    _DAT_1fa7a050 = 0x1f05000f;
    _DAT_1fa7a078 = 0x4040701;
    uVar8 = 0;
    _DAT_1fa7b798 = 0x8400000;
    _DAT_1fa7a058 = 0x30004e4;
    _DAT_1fa7a054 = 0x180b02;
    _DAT_1fa7a05c = 1;
    _DAT_1fa7a094 = 0x1000f;
    _DAT_1fa7a070 = 0x4000b03;
    _DAT_1fa7a074 = 0x1000001;
    _DAT_1fa7a06c = 0x1010003;
    _DAT_1fa7b854 = 0x1010101;
    _DAT_1fa7b580 = 2;
    _DAT_1fa7a0c4 = 0x1010401;
    _DAT_1fa7b874 = 0x1010000;
    _DAT_1fa7b77c = 0x1050101;
    _DAT_1fa7b784 = 0x102;
    _DAT_1fa7b778 = 0x1010101;
    _DAT_1fa7b780 = 0x10b;
    _DAT_1fa7b260 = 0x101;
    _DAT_1fa7b374 = 2;
    _DAT_1fa7b184 = 0x40003ff;
    _DAT_1fa7a148 = 0x1010101;
    _DAT_1fa7a144 = 0x1000000;
    _DAT_1fa7a11c = 0x2000401;
    _DAT_1fa7b004 = 0xc100a01;
    _DAT_1fa7a13c = 0x20000;
    _DAT_1fa7a120 = 0x3ff08;
    _DAT_1fa7b320 = 0x10101;
    _DAT_1fa7b48c = 0x1000202;
    _DAT_1fa7b80c = 0x1000000;
    _DAT_1fa7b814 = 0x1010000;
    _DAT_1fa7b88c = 0;
    _DAT_1fa7b768 = 0;
    _DAT_1fa7b390 = 0x100001;
    _DAT_1fa7b394 = 0xffff0000;
    _DAT_1fa7b39c = 0x3107;
    _DAT_1fa7a0d4 = 0xc8c31030;
    _DAT_1fa7b100 = 0xa0005;
    _DAT_1fa7b08c = 0x101;
    _DAT_1fa7b104 = 2;
    _DAT_1fa7b090 = 0x320002;
    _DAT_1fa7b09c = 0x320002;
    _DAT_1fa7b094 = 0x320002;
    _DAT_1fa7b098 = 0x320002;
    _DAT_1fa7b76c = 0x1000000;
    _DAT_1fa7a0dc = 0;
    _DAT_1fa7a0e8 = 0x2000000;
    _DAT_1fa7a0f8 = 0x4010808;
    _DAT_1fa7a0fc = 0x80606;
    _DAT_1fa7b120 = 0x103;
    _DAT_1fa7b088 = 1;
    _DAT_1fa7b38c = 1;
    _DAT_1fa7b000 = 0x1000000;
    _DAT_1fa7b33c = 0x1010100;
    _DAT_1fa7b330 = 1;
    _DAT_1fa7a118 = 0x1010100;
    _DAT_1fa7a10c = 0x70604;
    _DAT_1fa7a114 = 0x1020200;
    _DAT_1fa7a110 = 0x3000200;
    _DAT_1fa7a0d8 = 0x10242;
    _DAT_1fa7a0cc = 0x1000000;
    _DAT_1fa7b81c = 0x101;
    _DAT_1fa7b894 = 0x101;
    _DAT_1fa7b84c = 0x1010000;
    _DAT_1fa7b34c = 0x1010101;
    _DAT_1fa7b350 = 1;
    _DAT_1fa7b818 = 0x100;
    _DAT_1fa7b460 = 0x20;
    _DAT_1fa7b150 = 0x9f439e7b;
    _DAT_1fa7b14c = 0x7fff7fff;
    _DAT_1fa7b154 = 0x9f439e7b;
    _DAT_1fa7a0f4 = 0x1000000;
    _DAT_1fa7b820 = 0x1010100;
    _DAT_1fa7b794 = 0x1010000;
    _DAT_1fa7b824 = 0x1010101;
    do {
      _DAT_1fa7b794 = _DAT_1fa7b794 & 0xfffff800 | uVar9 & 0x7ff;
      _DAT_1fa7b158 = 0x3303;
      FUN_00037c5c(5000);
      uVar7 = _DAT_1fa7b794;
      uVar2 = _DAT_1fa7b530 >> 0x10;
      FUN_00012214(s_pr_idac___0x_x__RO_FL_Out___0x_x_0006a7d5,_DAT_1fa7b794 & 0x7ff,uVar2);
      if (0x9edf < uVar2) {
        FUN_00012214(s_cdr_pr_idac_tmp___0x_x_0006a7f7,uVar9);
        uVar8 = uVar9;
      }
      uVar9 = uVar9 + 0x100;
    } while (uVar9 != 0x800);
    uVar9 = 7;
    do {
      uVar2 = 1 << (ulong)(uVar9 & 0x1f);
      uVar8 = uVar8 | uVar2;
      uVar7 = uVar7 & 0xfffff800 | uVar8 & 0x7ff;
      _DAT_1fa7b158 = 0x3303;
      _DAT_1fa7b794 = uVar7;
      FUN_00037c5c(5000);
      uVar3 = _DAT_1fa7b530 >> 0x10;
      FUN_00012214(s_pr_idac___0x_x__RO_FL_Out___0x_x_0006a7d5,uVar8);
      if (uVar3 < 0x9edf) {
        uVar8 = uVar8 & (uVar2 ^ 0xffffffff);
      }
      uVar9 = uVar9 - 1;
      FUN_00012214(s_cdr_pr_idac_tmp___0x_x_0006a7f7,uVar8);
    } while (uVar9 != 0xffffffff);
    _DAT_1fa7b794 = uVar8;
    FUN_00012214(s_sel_cdr_pr_idac___0x_x_0006a80f,uVar8);
    _DAT_1fa7b158 = 0x3303;
    FUN_00037c5c(5000);
    FUN_00012214(s_RO_state_freqdet___0x_x_0006a827,_DAT_1fa7b530 & 1);
    _DAT_1fa7a0f4 = _DAT_1fa7a0f4 & 0xfeffffff;
    _DAT_1fa7b794 = _DAT_1fa7b794 & 0xfffeffff;
    _DAT_1fa7b820 = _DAT_1fa7b820 & 0xfefefefe | 0x1010000;
    _DAT_1fa7b19c = _DAT_1fa7b19c | 1;
    _DAT_1fa7b174 = _DAT_1fa7b174 & 0xfffff800 | uVar8 & 0x7ff;
    _DAT_1fa7b824 = _DAT_1fa7b824 & 0xfefeffff | 0x10000;
    _DAT_1fa7b460 = (DAT_0003f80c >> 0x10 & 1) << 5;
    _DAT_1fa7b818 = 0x1000100;
    FUN_00037c5c(700);
    _DAT_1fa7b818 = 0x1010100;
    FUN_00037c5c(100);
    _DAT_1fa7b460 = 0xfff;
    _DAT_1fa7b818 = 0x1000100;
    FUN_00037c5c(700);
    _DAT_1fa7b818 = 0x1010100;
    FUN_00037c5c(100);
    _DAT_1fa7b818 = 0x10001;
    _DAT_1fa74100 = 0x10010001;
    _DAT_1fa75b2c = 0;
    _DAT_1fa75bc0 = 0;
    _DAT_1fa75bc4 = 0;
    _DAT_1fa75bd8 = 0;
    _DAT_1fa75bdc = 0;
    _DAT_1fa75be4 = 0;
    _DAT_1fa75bc8 = 0;
    _DAT_1fa75bcc = 0;
    _DAT_1fa75be0 = 0;
    FUN_00012214(s_AN_mode_0006a880);
    _DAT_1fa75bf8 = 0x6330001;
    _DAT_1fa76000 = 0xc11;
    _DAT_1fa09000 = 0x71082800;
    FUN_00012214(s_set_mac_reg_init_0006a840);
    FUN_00012214(s_usxgmii_pcs_int_en__x_0006a889,1);
    _DAT_1fa75bc0 = 0;
    _DAT_1fa75bc4 = 0;
    _DAT_1fa75bd8 = 0x1010101;
    _DAT_1fa75bdc = 0x1010101;
    _DAT_1fa75be4 = 1;
    _DAT_1fa75bc8 = 0;
    _DAT_1fa75bcc = 0x100;
    _DAT_1fa75be0 = 1;
    FUN_00001df0(0x32);
    FUN_00001dc8(0x32);
    FUN_00002260(0x32,FUN_0002166c,1);
    pcVar6 = s_USXGMII_10G_exit_0006a8a0;
  }
  FUN_00012214(pcVar6);
  return;
}


