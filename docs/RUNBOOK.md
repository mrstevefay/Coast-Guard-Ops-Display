# Runbook — hosted ops server (Vultr) and station Pi

## First-time VPS setup (Ubuntu 24.04, 1 vCPU / 2 GB)

1. DNS: `A ops.<your-domain> → <VPS IP>`. Vultr firewall: allow 22 (your IP), 80, 443 only.
2. On the box:
   ```bash
   adduser deploy && usermod -aG sudo deploy
   # put your public key in /home/deploy/.ssh/authorized_keys, then
   sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl restart ssh
   apt update && apt install -y docker.io docker-compose-v2 fail2ban unattended-upgrades
   usermod -aG docker deploy
   mkdir -p /opt/howth-cg && chown deploy:deploy /opt/howth-cg
   ```
3. As `deploy`, in `/opt/howth-cg`: copy `docker-compose.yml`, `deploy/Caddyfile`,
   `deploy/deploy.sh` (chmod +x), `config.yaml`, and `deploy/env.example` as `.env`. Fill in
   `.env` (domain, `AUTH_OPEN=false`, `ADMIN_EMAIL`/`ADMIN_PASSWORD` for the first start,
   `CALLOUT_TOKEN`, AIS key). If the GHCR package is private: `docker login ghcr.io` with a
   read-only token.
4. `docker compose up -d`. Caddy fetches the certificate within a minute. Check
   `https://ops.<domain>/healthz`.
5. Log in at `https://ops.<domain>/m/` as the admin, change the password, accept the privacy
   notice, create users (More → Admin), and create a **display key** for the station TV.
6. Remove `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` (they only act when there are no users).

## Deploying updates

Pushes to the default branch build `ghcr.io/<owner>/howth-cg-dashboard:latest` and, when the
repo secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` exist, run `/opt/howth-cg/deploy.sh`
over SSH. Manual: `ssh deploy@ops.<domain> /opt/howth-cg/deploy.sh`.

## Station Pi

The Pi keeps running its own server (feeds polled locally) and mirrors the hosted one for the
TV. In `bootfs/howth-cg.env`:

```
UPSTREAM_URL=wss://ops.<domain>
UPSTREAM_KEY=dk_...        # display key from More → Admin
```

The TV shows the hosted picture (callouts, teams, targets) while reachable and switches to
**LOCAL** within 60 s if not; feeds keep updating either way. Pager callouts should go to the
hosted server (`POST https://ops.<domain>/api/callout` with the bridge token); the Pi's own
`/api/callout` remains an emergency path for the LAN.

## Day-to-day

| Task | How |
| --- | --- |
| Health | `curl -s https://ops.<domain>/healthz` → `status`, `db`, `wsClients`, `fixesLastMin` |
| Logs | `docker compose logs -f app` / `caddy` |
| Backup now | `curl -X POST -b cg_s=<admin cookie> https://ops.<domain>/api/admin/backup`, or wait for the 03:30 nightly |
| List backups | `GET /api/admin/backups` (admin) or `docker compose exec app ls -la /app/data/backups` |
| Restore | `docker compose stop app`; `docker run --rm -v howth-cg_app-data:/d alpine sh -c 'cp /d/backups/ops-<stamp>.db /d/ops.db && rm -f /d/ops.db-wal /d/ops.db-shm'`; `docker compose start app` |
| Retention now | `POST /api/admin/retention` (admin) |
| Rotate the bridge token | edit `.env`, `docker compose up -d app`, update the pager bridge and the Pi |
| Lost admin password | another admin: More → Admin → Reset pw. No admin left: reset from the shell (below) |

Reset a password from the shell when no admin can log in:

```bash
docker compose exec app node --no-warnings=ExperimentalWarning -e '
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { scryptSync, randomBytes } = require("node:crypto");
const db = new DatabaseSync("/app/data/ops.db");
const salt = randomBytes(16), pw = process.argv[1];
const hash = "scrypt$15$8$1$" + salt.toString("base64") + "$" + scryptSync(pw, salt, 32, { N: 32768, r: 8, p: 1 }).toString("base64");
db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE email = ?").run(hash, process.argv[2]);
console.log("ok")' 'temporary-password-123' 'admin@example.ie'
```

## Monitoring

Point a free uptime monitor at `https://ops.<domain>/healthz` (expects HTTP 200). Vultr
automatic backups (daily) on top of the in-app nightly SQLite backups. Test a restore
quarterly on a scratch VPS.

## Capacity

1 vCPU / 2 GB handles ~50 phones at one fix per 30 s with headroom. The container is capped at
768 MB. If `fixesLastMin` climbs past ~200 or WS clients past ~100, resize the instance.
