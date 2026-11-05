# Changelog

## Unreleased

- **History and replay** (console → *History*): every past tasking and callout with who was on
  which team, targets, the planning point and conditions; a map replay from start to finish
  (play/pause, 10×–1200×, scrub) showing positions, tracks and coverage as they were; a
  timeline of responses, team and target changes. `GET /api/incidents/:id/replay`.
- **End-of-mission report** (`GET /api/incidents/:id/report.html`, *Report* / *Download* /
  *Email HQ* in History): response time, time to scene and time on scene per responder; teams
  with members, sweep width, time searching, track length and estimated area swept; targets;
  weather, visibility, sea state, tide and daylight at start and end; warnings; timeline; a
  schematic map. Printable (browser → PDF). JSON at `/report`.
- Every response status change is now recorded (`response_events`) and conditions are
  snapshotted when an incident opens and closes (`incident_conditions`); schema migration 3.
- **Taskings**: the console's *New tasking* opens a search (responders, teams, targets,
  tracking) without raising a callout: the TV stays in standby with a TASKING tag and nobody is
  paged. Tick *Also raise a callout* for the old behaviour; a pager callout supersedes an open
  tasking. `POST /api/incidents` now defaults to a tasking (`callout: true` for a callout).
- **Search planning point (IPP)**: set by clicking the map in the console; shown with a label
  on the console, phones and TV, with distance and bearing from each responder.
- **Team sweep width** defaults to 20 m in daylight and 10 m after sunset (`search.nightSearchWidthM`),
  and each team has a ⚙ settings dialog (name, width, colour, status) replacing the slider.
- **Subject details**: a *Subject* tab in the console records who the search is for (name, sex,
  age, clothing, description, significant locations, history, despondent / mental health /
  previous self-harm and means, recent photo). Shown to logged-in crew on the Status page;
  never sent to display keys (the TV) and kept out of the audit log.
- **Topo layer**: OpenTopoMap contours/relief toggle in the console (`map.topoTileUrl`).
- **Settings → Data feeds** in the console: set or clear the AIS (aisstream.io) key, Dublin
  Bay buoy key, webcam URL and label at runtime. Stored in SQLite, applied immediately by
  restarting the feed, overriding `.env` / `config.yaml`. Secrets are masked in the UI and
  kept out of the audit log. New `GET/PUT /api/admin/settings`, `Scheduler.replace()`.
- **Fix: map tiles "Access blocked"** on the hosted server. Caddy sent `Referrer-Policy:
  same-origin`, which strips the Referer from OpenStreetMap tile requests; OSM's tile usage
  policy then serves the blocked tile. Pages now carry `<meta name="referrer"
  content="strict-origin-when-cross-origin">` (overrides the header) and the Caddyfile matches.
- **Fix: crew app on a desktop browser** stretched cards and the tide curve across the window;
  it now keeps a centred 640 px column above 700 px wide.
- **TV display scales to the screen**: every size on the wall display is now `N * var(--u)`,
  with `--u` derived from the viewport (1 design px at 1920×1080). 4K, 720p, laptops and
  ultra-wide all render the same picture; non-16:9 screens widen the map. The crew app and
  console are unaffected (`--u` is 1px there).
- **One-tap OwnTracks setup**: the crew app fetches a credential for the phone it runs on and
  shows *Set up tracking on this phone* on first open; *Open OwnTracks* (or the first *I'm
  responding*) hands the full HTTP-mode configuration to the app. More → Phones gains *Send
  setup to OwnTracks again*. Config now also sets high accuracy (Android), extended data and
  remote location requests. New `POST /api/devices/link`, `GET /api/devices/:id/link`.
- **Console settings** (`/sm/#settings/…`): all administration on the desktop: users (add,
  edit, inline role change, reset password, deactivate, remove), display keys, backups and
  retention (previously API-only), audit log with range and text filter, system status with
  per-feed health, and your own account (password, privacy notice, OwnTracks phones with QR).
  A temporary password forces the account page first. The phone app's More → Admin stays as
  the reduced version.
- `deploy/vultr-create.sh` + `deploy/cloud-init.yaml`: scripted Vultr VPS provisioning.

## v2.0.0 — 05/11/2026 — Phase 2

- **Hosted deployment**: Docker Compose with Caddy TLS for a Vultr VPS, GHCR image on every
  push to the default branch, SSH deploy job, runbook.
- **Accounts**: admin / manager / member roles, scrypt passwords, 180-day sessions, display keys
  for kiosks, CSRF guard, rate limits, audit log, SQLite via node:sqlite (no native modules).
- **Crew app** `/m/` (installable PWA): status with *I'm responding* and ETA, weather, tide,
  sea area forecast, map, team, phone linking for OwnTracks, admin pages.
- **OwnTracks tracking** `/ot`: per-device credentials, one-tap config link/QR, track points
  kept only while responding in an open incident, friends reply.
- **Search management** `/sm/`: incidents, responders, teams with Alpha-0 callsigns, targets
  drawn on the map (point/area/line), live positions, tracks, covered-area overlay, GeoJSON
  export, stand-down.
- **TV**: shows teams, targets, tracks and coverage in callout mode; live muster panel.
- **Pi**: mirrors the hosted server with a display key, falls back to local feeds (LOCAL tag).
- Nightly SQLite backups, retention job (tracks kept indefinitely by default), privacy notice.

## v1.1.0 — 05/11/2026

- Sea State now shows the real **Dublin Bay buoy** (Irish Lights MetOcean via
  dublinbaybuoy.com): Hs, period, water temperature, wind/gust, gale flag. The SWAN
  model point stays as a fallback. *Data from Dublin Bay Buoy, sourced from Irish Lights
  MetOcean — not for navigation.*

## v1.0.0 — 05/11/2026 — Phase 1

First release, running on a Raspberry Pi 5 at 1920×1080.

- Standby and callout wall layouts; token-protected callout / stand-down API with
  auto stand-down and restart-safe mode persistence.
- Live feeds: Met Éireann forecast, Dublin Airport observations, warnings (marine +
  Dublin, CAP), Howth tide gauge, tide predictions (Chart Datum, springs/neaps),
  SWAN wave model off Howth, M2 buoy, sun/moon, aisstream.io AIS.
- Stubs with the Phase 2/3 shape: crew muster, webcam.
- Provider isolation: per-source polling, back-off, stale badges, fast retry until
  first success.
- Flash-and-boot Raspberry Pi SD image (Pi OS Lite + cage/Chromium kiosk + Node 20),
  Wi-Fi from a plain text file on the boot partition, built by GitHub Actions.
- Docker Compose alternative (amd64 + arm64).

Known gaps: no public Dublin Bay wave buoy feed (model used); no stable Howth Harbour
webcam URL; visibility is estimated, not observed.
