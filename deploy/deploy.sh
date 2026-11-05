#!/usr/bin/env bash
# Pull the latest image and restart the app. Run by GitHub Actions over SSH,
# or by hand: /opt/howth-cg/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
docker compose pull app
docker compose up -d app
docker image prune -f >/dev/null
sleep 5
curl -fsS "https://${DOMAIN}/healthz" | head -c 200; echo
