#!/bin/sh
# Chromium in kiosk mode on Wayland (cage). Profile lives in tmpfs-ish user dir
# so a crash never leaves a "restore pages" bubble.
rm -rf "$HOME/.config/chromium/Singleton"* 2>/dev/null || true
exec /usr/bin/chromium \
  --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --disable-translate --no-first-run --disable-features=TranslateUI \
  --ozone-platform=wayland --enable-features=UseOzonePlatform \
  --window-size=1920,1080 --window-position=0,0 --force-device-scale-factor=1 \
  --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 --disable-pinch \
  --user-data-dir="$HOME/.config/chromium" \
  --app=http://127.0.0.1:8080/
