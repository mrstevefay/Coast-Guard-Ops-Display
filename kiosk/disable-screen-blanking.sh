#!/bin/sh
# Run once on the Pi (as the kiosk user) to stop the screen blanking.
set -e
# X11 session (Raspberry Pi OS Bookworm desktop with X): no DPMS, no screensaver
if command -v xset >/dev/null 2>&1 && [ -n "$DISPLAY" ]; then
  xset s off; xset s noblank; xset -dpms
fi
# Persist for X sessions
mkdir -p ~/.config/lxsession/LXDE-pi
AUTOSTART=~/.config/lxsession/LXDE-pi/autostart
touch "$AUTOSTART"
for line in "@xset s off" "@xset s noblank" "@xset -dpms"; do
  grep -qxF "$line" "$AUTOSTART" || echo "$line" >> "$AUTOSTART"
done
# Wayland (Wayfire) — disable dpms/idle in ~/.config/wayfire.ini
if [ -f ~/.config/wayfire.ini ]; then
  grep -q '^\[idle\]' ~/.config/wayfire.ini || printf '\n[idle]\ndpms_timeout = 0\nscreensaver_timeout = 0\n' >> ~/.config/wayfire.ini
fi
# Also hide the mouse cursor when idle (optional)
command -v unclutter >/dev/null 2>&1 || echo "tip: sudo apt install unclutter  (hides the cursor)"
echo "Screen blanking disabled. Reboot to apply autostart changes."
