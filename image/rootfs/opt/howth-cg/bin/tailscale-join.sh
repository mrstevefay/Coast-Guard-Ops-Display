#!/bin/sh
# Joins this Pi to your Tailscale network on first boot, using TAILSCALE_AUTHKEY from
# /boot/firmware/howth-cg.env. Does nothing once joined, or when no key is set. After a
# successful join the key is blanked in howth-cg.env so it does not sit on the card.
set -u
ENV=/boot/firmware/howth-cg.env
KEY=${TAILSCALE_AUTHKEY:-}
NAME=${TAILSCALE_HOSTNAME:-$(hostname)}

# wait for tailscaled to answer
for i in $(seq 1 30); do tailscale status --json >/dev/null 2>&1 && break; sleep 2; done
if tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
  echo "howth-cg: already on Tailscale"; exit 0
fi
[ -n "$KEY" ] || { echo "howth-cg: no TAILSCALE_AUTHKEY in $ENV; skipping"; exit 0; }

# key via a file, not the command line
KF=$(mktemp /run/howth-cg-tskey.XXXXXX); chmod 600 "$KF"; printf '%s' "$KEY" > "$KF"
ok=
for i in $(seq 1 20); do
  if tailscale up --auth-key="file:$KF" --ssh --hostname="$NAME" --timeout=60s; then ok=1; break; fi
  echo "howth-cg: tailscale up failed (try $i), retrying in 15 s"; sleep 15
done
rm -f "$KF"
[ -n "$ok" ] || { echo "howth-cg: could not join Tailscale"; exit 1; }
sed -i 's/^TAILSCALE_AUTHKEY=.*/TAILSCALE_AUTHKEY=/' "$ENV" 2>/dev/null || true
echo "howth-cg: joined Tailscale as $NAME"
