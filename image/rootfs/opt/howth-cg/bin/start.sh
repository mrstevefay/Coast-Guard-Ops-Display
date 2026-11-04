#!/bin/sh
# Starts the dashboard server. A config file on the boot partition overrides
# the baked-in one, so the station can be re-configured from a laptop.
set -e
cd /opt/howth-cg
if [ -f /boot/firmware/howth-cg.yaml ]; then
  export CONFIG_FILE=/boot/firmware/howth-cg.yaml
else
  export CONFIG_FILE=/etc/howth-cg/config.yaml
fi
exec /usr/local/bin/node server/dist/server/src/index.js
