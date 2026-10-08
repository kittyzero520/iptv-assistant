#!/bin/sh
# iptv-assistant install.sh — runs after .run self-extracts
# Copies files into place, enables service, reloads LuCI.

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)/rootfs"

echo "[iptv-assistant] Installing files…"

# Config
mkdir -p /etc/config
if [ -f /etc/config/iptv_assistant ]; then
	# 已有配置:保留用户现有参数,仅收紧权限
	chmod 600 /etc/config/iptv_assistant
else
	cp "$ROOT/etc/config/iptv_assistant" /etc/config/
	chmod 600 /etc/config/iptv_assistant
fi

# Init script
cp "$ROOT/etc/init.d/iptv-assistant" /etc/init.d/
chmod +x /etc/init.d/iptv-assistant

# uci-defaults
mkdir -p /etc/uci-defaults
cp "$ROOT/etc/uci-defaults/10-iptv-assistant" /etc/uci-defaults/
chmod +x /etc/uci-defaults/10-iptv-assistant

# LuCI menu
mkdir -p /usr/share/luci/menu.d
cp "$ROOT/usr/share/luci/menu.d/luci-app-iptv-assistant.json" /usr/share/luci/menu.d/

# rpcd ACL
mkdir -p /usr/share/rpcd/acl.d
cp "$ROOT/usr/share/rpcd/acl.d/luci-app-iptv-assistant.json" /usr/share/rpcd/acl.d/

# LuCI JS view
mkdir -p /www/luci-static/resources/view
cp "$ROOT/www/luci-static/resources/view/iptv_assistant.js" /www/luci-static/resources/view/

echo "[iptv-assistant] Seeding config…"
sh /etc/uci-defaults/10-iptv-assistant

echo "[iptv-assistant] Enabling service…"
/etc/init.d/iptv-assistant enable
/etc/init.d/iptv-assistant start

echo "[iptv-assistant] Reloading LuCI…"
/etc/init.d/rpcd restart 2>/dev/null
/etc/init.d/uhttpd restart 2>/dev/null

echo "[iptv-assistant] Verifying…"
echo "--- /etc/sysctl.d/10-iptv-assistant.conf ---"
cat /etc/sysctl.d/10-iptv-assistant.conf 2>/dev/null
echo "--- live sysctl (igmp version lines) ---"
sysctl net.ipv4.conf 2>/dev/null | grep force_igmp_version | grep -v '= 0$' || echo "(none with non-zero value)"
echo "--- rmem_max / netdev_max_backlog ---"
sysctl -n net.core.rmem_max 2>/dev/null
sysctl -n net.core.netdev_max_backlog 2>/dev/null

echo
echo "[iptv-assistant] Done."
echo "  LuCI: Network → IPTV 网络助手"
echo "  CLI:  uci set iptv_assistant.@interface[0].iface=pppoe-wan1"
echo "        uci set iptv_assistant.@interface[0].igmp_version=2"
echo "        uci commit iptv_assistant && /etc/init.d/iptv-assistant reload"
