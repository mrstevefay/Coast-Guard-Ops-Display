# Changelog

## Unreleased

- **One-tap OwnTracks setup**: the crew app fetches a credential for the phone it runs on and
  shows *Set up tracking on this phone* on first open; *Open OwnTracks* (or the first *I'm
  responding*) hands the full HTTP-mode configuration to the app. More → Phones gains *Send
  setup to OwnTracks again*. Config now also sets high accuracy (Android), extended data and
  remote location requests. New `POST /api/devices/link`, `GET /api/devices/:id/link`.

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
