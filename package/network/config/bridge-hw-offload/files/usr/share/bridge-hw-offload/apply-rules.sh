#!/bin/sh
# Bridge flow offloading rule generator
# Detects bridge member ports and writes a persistent .nft file
# that fw4 includes via its ruleset-post mechanism.
#
# After writing the file, triggers fw4 reload to apply the rules.

BRIDGE="${1:-br-lan}"
RULES_DIR="/usr/share/nftables.d/ruleset-post"
RULES_FILE="${RULES_DIR}/30-bridge-offload.nft"
FLOWTABLE="br_offload"

detect_bridge_ports() {
    local brif_dir="/sys/class/net/${BRIDGE}/brif"
    [ -d "$brif_dir" ] || return 1
    local ports=""
    for port_dir in "$brif_dir"/*; do
        [ -d "$port_dir" ] || continue
        ports="${ports:+${ports}, }$(basename "$port_dir")"
    done
    [ -n "$ports" ] && echo "$ports"
}

main() {
    # Only use the NPU/hardware path when fw4 hardware offload is enabled.
    if [ "$(uci -q get firewall.@defaults[0].flow_offloading_hw)" != "1" ]; then
        rm -f "$RULES_FILE"
        nft delete table bridge fw4 >/dev/null 2>&1
        logger -t bridge-hw-offload "flow_offloading_hw not set, hardware offload disabled"
    else
        local devices
        devices=$(detect_bridge_ports)
        if [ -z "$devices" ]; then
            logger -t bridge-hw-offload "No bridge ports found for ${BRIDGE}, skipping"
            return 1
        fi

        mkdir -p "$RULES_DIR"
        cat > "$RULES_FILE" <<EOF
destroy table bridge fw4

table bridge fw4 {
    flowtable ${FLOWTABLE} {
        hook ingress priority 0; devices = { ${devices} }; flags offload;
    }

    chain forward {
        type filter hook forward priority 0; policy accept;
        meta l4proto { tcp, udp } flow offload @${FLOWTABLE}
    }
}
EOF
        logger -t bridge-hw-offload "hardware offload enabled for ${devices}"
    fi

    # Reload fw4 so it picks up our ruleset-post include
    /etc/init.d/firewall reload >/dev/null 2>&1 &
}

main
