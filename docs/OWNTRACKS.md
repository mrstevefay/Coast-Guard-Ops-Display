# OwnTracks setup for crew

Positions come from the free **OwnTracks** app (iOS / Android) in HTTP mode. Each phone gets
its own credentials from the crew app.

## Linking a phone (crew)

Nothing to type. The first time the crew app opens on a phone it fetches a credential for that
phone and shows **Set up tracking on this phone** at the top of Status:

1. Install OwnTracks from the App Store / Play Store (*Get the app*).
2. Tap **Open OwnTracks**. The app opens with mode (HTTP), URL, user ID, password, device ID and
   tracker ID already filled in; nothing to copy. Pressing **I'm responding** for the first
   time does the same launch.
3. iOS: allow Location **Always** and Precise. Android: allow location *All the time* and turn
   off battery optimisation for OwnTracks.

The imported config sets Monitoring to **Move** (a fix every 30 s or 20 m while moving), high
accuracy on Android, extended data (battery, speed, course) and remote location requests.

*Not now* hides the card for the session; it returns on the next open until the phone is
linked. **More → Phones** shows which entry is *this phone*, **Send setup to OwnTracks again**
re-issues the credential (any credential that never reported is revoked in the same step, a
phone that is already reporting is left alone), and **Add another phone (QR)** keeps the manual
route for a second device: name, QR to scan, manual values, `.otrc` download.

Secrets are shown once and held for ten minutes; after that, send the setup again. Phones are
only auto-detected as such from the browser user agent (iPhone, iPad, Android); on a laptop the
card never appears.

## What the server does

* `POST /ot` with HTTP Basic auth (`username:secret`). Accepts `_type: location`; other
  message types (transition, waypoint, status, lwt, beacon) are acknowledged and dropped.
* Fixes worse than `search.maxAccuracyM` (100 m) only update "last seen", not the track.
* Track points are stored **only while an incident is open and the user is responding or in a
  team**. Outside that, only the last fix is kept (cleared after 24 h).
* The reply lists the other responders' latest positions as OwnTracks *friends* (with
  `card` names), so OwnTracks' own map shows the team too. `search.owntracksFriends: false`
  turns this off.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "Your position is not being received" on the Status page | OwnTracks running? Mode HTTP, URL `https://ops.<domain>/ot`, auth on. Tap *Publish* in OwnTracks. |
| *Open OwnTracks* does nothing | OwnTracks not installed, or the tap was blocked: install it, then tap again (the button must be tapped by hand, the link cannot open the app on its own). |
| 401 in OwnTracks | Phone revoked or secret wrong: More → Phones → *Send setup to OwnTracks again*. |
| Fixes arrive but no track on the console | The user has not pressed *I'm responding* and is not in a team. |
| Stale on the console after a few minutes | iOS background throttling: ensure Location *Always*, Monitoring *Move*; Android battery optimisation. |
| Altitude looks off by ~50 m | Android reports ellipsoid height, iOS mean-sea-level. Treat as GPS altitude. |
