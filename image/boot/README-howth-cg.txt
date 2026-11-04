Howth Coast Guard wall display — SD card image
==============================================

What happens on boot
  1. Raspberry Pi OS Lite boots, expands the filesystem to fill the card (first boot
     only, ~1 min), brings up Ethernet via DHCP.
  2. howth-cg-dashboard.service starts the Node server on port 8080.
  3. howth-cg-kiosk.service starts Chromium full-screen on HDMI at 1920x1080.

Before first boot (optional, all on this partition)
  howth-cg.env      secrets: CALLOUT_TOKEN, AISSTREAM_API_KEY, WEBCAM_IMAGE_URL
  howth-cg.yaml     copy of config.yaml; if present it REPLACES the baked-in config
  ssh               SSH is enabled (file present). Delete it to disable.
  userconf.txt      login user. Default  cg / howthcg  — CHANGE IT (see README).

Wi-Fi
  Use Raspberry Pi Imager "OS customisation" when flashing (set Wi-Fi, hostname,
  user), or plug in Ethernet. Imager customisation works on top of this image.

Logs / admin (ssh cg@howth-cg.local)
  sudo journalctl -u howth-cg-dashboard -f
  sudo journalctl -u howth-cg-kiosk -f
  curl -s localhost:8080/healthz
  sudo systemctl restart howth-cg-kiosk

Project: https://github.com/mrstevefay/Coast-Guard-Ops-Display
