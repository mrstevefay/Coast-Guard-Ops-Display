#!/usr/bin/env bash
# Create the hosted ops server on Vultr (docs/RUNBOOK.md, "First-time VPS setup").
#
# Creates, idempotently by label:
#   * an SSH key (your public key),
#   * a firewall group: 22/tcp from ADMIN_IP only, 80/tcp, 443/tcp, 443/udp from anywhere,
#   * one instance: Ubuntu 24.04, 1 vCPU / 2 GB (vc2-1c-2gb), London, daily backups on,
#     first boot configured by deploy/cloud-init.yaml (deploy user, Docker, fail2ban,
#     unattended-upgrades, password SSH off, /opt/howth-cg).
#
# Required environment:
#   VULTR_API_KEY      Vultr API key (Account -> API). Never commit it.
#   SSH_PUBKEY_FILE    public key for the deploy user (default ~/.ssh/id_ed25519.pub), or
#   VULTR_SSH_KEY_ID   id of a key already in the account (then SSH_PUBKEY_FILE is ignored)
# Optional:
#   ADMIN_IP           CIDR allowed to SSH (default: your current public IPv4 /32)
#   REGION             default lhr (London; nearest Vultr region to Dublin)
#   PLAN               default vc2-1c-2gb
#   LABEL              default howth-cg-ops (also the hostname and firewall/key label)
#
# Usage:  VULTR_API_KEY=... deploy/vultr-create.sh
# Afterwards: point  A ops.<domain>  at the printed IP, then follow RUNBOOK step 3 onward.
set -euo pipefail

: "${VULTR_API_KEY:?set VULTR_API_KEY}"
SSH_PUBKEY_FILE="${SSH_PUBKEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
REGION="${REGION:-lhr}"
PLAN="${PLAN:-vc2-1c-2gb}"
LABEL="${LABEL:-howth-cg-ops}"
OS_NAME="Ubuntu 24.04 LTS x64"
API="https://api.vultr.com/v2"
HERE="$(cd "$(dirname "$0")" && pwd)"

for t in curl jq; do command -v "$t" >/dev/null || { echo "need $t" >&2; exit 1; }; done
[ -n "${VULTR_SSH_KEY_ID:-}" ] || [ -r "$SSH_PUBKEY_FILE" ] || { echo "no public key at $SSH_PUBKEY_FILE (set SSH_PUBKEY_FILE or VULTR_SSH_KEY_ID)" >&2; exit 1; }

api() { # api METHOD PATH [JSON]
  local m=$1 p=$2 d=${3:-}
  if [ -n "$d" ]; then
    curl -fsS -X "$m" "$API$p" -H "Authorization: Bearer $VULTR_API_KEY" \
      -H "Content-Type: application/json" --data "$d"
  else
    curl -fsS -X "$m" "$API$p" -H "Authorization: Bearer $VULTR_API_KEY"
  fi
}

ADMIN_IP="${ADMIN_IP:-$(curl -fsS -4 https://api.ipify.org)/32}"
if [ -n "${VULTR_SSH_KEY_ID:-}" ]; then
  PUBKEY="$(api GET "/ssh-keys/$VULTR_SSH_KEY_ID" | jq -r .ssh_key.ssh_key)"
else
  PUBKEY="$(tr -d '\n' < "$SSH_PUBKEY_FILE")"
fi

echo "region=$REGION plan=$PLAN label=$LABEL ssh-from=$ADMIN_IP"

# --- OS id --------------------------------------------------------------------------
OS_ID=$(api GET "/os?per_page=500" | jq -r --arg n "$OS_NAME" '.os[] | select(.name==$n) | .id')
[ -n "$OS_ID" ] || { echo "OS '$OS_NAME' not found" >&2; exit 1; }

# --- SSH key ------------------------------------------------------------------------
KEY_ID="${VULTR_SSH_KEY_ID:-$(api GET "/ssh-keys?per_page=500" | jq -r --arg n "$LABEL" '.ssh_keys[] | select(.name==$n) | .id')}"
if [ -z "$KEY_ID" ]; then
  KEY_ID=$(api POST /ssh-keys "$(jq -n --arg n "$LABEL" --arg k "$PUBKEY" '{name:$n, ssh_key:$k}')" | jq -r .ssh_key.id)
  echo "ssh key created: $KEY_ID"
else
  echo "ssh key exists: $KEY_ID"
fi

# --- Firewall group -------------------------------------------------------------------
FW_ID=$(api GET "/firewalls?per_page=500" | jq -r --arg n "$LABEL" '.firewall_groups[] | select(.description==$n) | .id')
if [ -z "$FW_ID" ]; then
  FW_ID=$(api POST /firewalls "$(jq -n --arg n "$LABEL" '{description:$n}')" | jq -r .firewall_group.id)
  echo "firewall group created: $FW_ID"
  rule() { # rule ip_type protocol port subnet size notes
    api POST "/firewalls/$FW_ID/rules" "$(jq -n --arg t "$1" --arg pr "$2" --arg po "$3" --arg s "$4" --argjson z "$5" --arg n "$6" \
      '{ip_type:$t, protocol:$pr, port:$po, subnet:$s, subnet_size:$z, notes:$n}')" >/dev/null
  }
  rule v4 tcp 22  "${ADMIN_IP%/*}" "${ADMIN_IP#*/}" "ssh admin"
  rule v4 tcp 80  0.0.0.0 0 "http (ACME + redirect)"
  rule v4 tcp 443 0.0.0.0 0 "https"
  rule v4 udp 443 0.0.0.0 0 "http/3"
  rule v6 tcp 80  :: 0 "http"
  rule v6 tcp 443 :: 0 "https"
  rule v6 udp 443 :: 0 "http/3"
  echo "firewall rules added"
else
  echo "firewall group exists: $FW_ID"
fi

# --- Instance -------------------------------------------------------------------------
INST=$(api GET "/instances?per_page=500" | jq -c --arg n "$LABEL" '.instances[] | select(.label==$n)')
if [ -z "$INST" ]; then
  USER_DATA=$(sed "s|__SSH_PUBKEY__|$PUBKEY|" "$HERE/cloud-init.yaml" | base64 -w0)
  BODY=$(jq -n --arg r "$REGION" --arg p "$PLAN" --argjson os "$OS_ID" --arg l "$LABEL" \
    --arg k "$KEY_ID" --arg fw "$FW_ID" --arg ud "$USER_DATA" \
    '{region:$r, plan:$p, os_id:$os, label:$l, hostname:$l, sshkey_id:[$k], firewall_group_id:$fw,
      backups:"enabled", enable_ipv6:true, activation_email:false, user_data:$ud, tags:["howth-cg"]}')
  INST=$(api POST /instances "$BODY" | jq -c .instance)
  echo "instance created: $(jq -r .id <<<"$INST")"
else
  echo "instance exists: $(jq -r .id <<<"$INST")"
fi
ID=$(jq -r .id <<<"$INST")

printf 'waiting for the instance to become active'
for _ in $(seq 1 60); do
  INST=$(api GET "/instances/$ID" | jq -c .instance)
  if [ "$(jq -r .status <<<"$INST")" = active ] && [ "$(jq -r .main_ip <<<"$INST")" != "0.0.0.0" ]; then break; fi
  printf .; sleep 5
done
echo

IP=$(jq -r .main_ip <<<"$INST")
IP6=$(jq -r .v6_main_ip <<<"$INST")
cat <<EOF

Server ready (cloud-init will take another minute or two to finish on first boot).
  label     $LABEL
  id        $ID
  ipv4      $IP
  ipv6      $IP6
  ssh       ssh deploy@$IP

Next (docs/RUNBOOK.md step 1 and 3+):
  1. DNS:  A ops.<your-domain> -> $IP   (and AAAA -> $IP6 if you want)
  2. scp docker-compose.yml config.yaml deploy/Caddyfile deploy/deploy.sh deploy/env.example deploy@$IP:/opt/howth-cg/
     then on the box: mv env.example .env, fill it in, chmod +x deploy.sh, docker compose up -d
  3. GitHub repo secrets for auto-deploy: DEPLOY_HOST=$IP DEPLOY_USER=deploy DEPLOY_SSH_KEY=<private key>
EOF
