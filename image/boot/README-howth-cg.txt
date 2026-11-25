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
  Once the Pi is on the network (Ethernet or Wi-Fi), change Wi-Fi from a phone or
  laptop at  http://howth-cg.local:8080/device/  (password: DEVICE_PASSWORD in
  howth-cg.env). A failed switch puts the Pi back on the previous network.
  For the very first network:
  Rename howth-cg-wifi.conf.example to howth-cg-wifi.conf and fill in SSID/PSK
  (up to two networks). Applied at boot by NetworkManager, then renamed to
  .applied. Ethernet needs nothing. (network-config/user-data cloud-init files
  are also left as examples but did not apply on the first test Pi.)

Remote access (Tailscale)
  Put a Tailscale auth key in howth-cg.env as TAILSCALE_AUTHKEY before first boot.
  The Pi joins your tailnet as "howth-cg" (Tailscale SSH on) and the key is blanked.
  Then from anywhere on your tailnet:  ssh cg@howth-cg   http://howth-cg:8080/device/
  In the Tailscale admin console, disable key expiry for the Pi.

Logs / admin (ssh cg@howth-cg.local)
  sudo journalctl -u howth-cg-dashboard -f
  sudo journalctl -u howth-cg-kiosk -f
  sudo journalctl -u howth-cg-tailscale     (did it join?)   tailscale status
  curl -s localhost:8080/healthz
  sudo systemctl restart howth-cg-kiosk

Project: https://github.com/mrstevefay/Coast-Guard-Ops-Display
