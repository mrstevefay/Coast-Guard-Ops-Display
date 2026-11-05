#!/bin/sh
# Reads /boot/firmware/howth-cg-wifi.conf (KEY=value lines) and creates
# NetworkManager profiles. Idempotent; renames the file when done.
set -eu
F=/boot/firmware/howth-cg-wifi.conf
[ -f "$F" ] || exit 0
# shellcheck disable=SC1090
. "$F"
# wait for NetworkManager to be answering
for i in $(seq 1 30); do nmcli -t general status >/dev/null 2>&1 && break; sleep 1; done
if [ -n "${COUNTRY:-}" ]; then
  iw reg set "$COUNTRY" 2>/dev/null || true
  command -v raspi-config >/dev/null && raspi-config nonint do_wifi_country "$COUNTRY" || true
fi
rfkill unblock wlan 2>/dev/null || true
nmcli radio wifi on || true
add() { # name ssid psk priority
  nmcli -t -f NAME con show | grep -qx "$1" && nmcli con delete "$1" >/dev/null 2>&1 || true
  if [ -n "$3" ]; then
    nmcli con add type wifi ifname wlan0 con-name "$1" ssid "$2" -- wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$3" connection.autoconnect yes connection.autoconnect-priority "$4"
  else
    nmcli con add type wifi ifname wlan0 con-name "$1" ssid "$2" -- connection.autoconnect yes connection.autoconnect-priority "$4"
  fi
}
[ -n "${SSID:-}" ] && add howth-cg-wifi-1 "$SSID" "${PSK:-}" 10
[ -n "${SSID2:-}" ] && add howth-cg-wifi-2 "$SSID2" "${PSK2:-}" 5
nmcli con up howth-cg-wifi-1 >/dev/null 2>&1 || true
mv "$F" "$F.applied"
echo "howth-cg: wifi profiles applied"
