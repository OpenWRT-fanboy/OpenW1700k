#!/bin/sh -x

DIR=/sys/kernel/debug/ieee80211/phy0/mt76/
[ $# -ge 1 ] && BAND=$1 || BAND=1

echo 0x00401484 > $DIR/regidx
echo 0x15100002 > $DIR/regval
echo "$BAND,1" > $DIR/sys_recovery
