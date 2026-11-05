# Changelog

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
