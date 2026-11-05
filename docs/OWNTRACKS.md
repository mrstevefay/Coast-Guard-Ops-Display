# OwnTracks setup for crew

Positions come from the free **OwnTracks** app (iOS / Android) in HTTP mode. Each phone gets
its own credentials from the crew app.

## Linking a phone (crew)

1. Install OwnTracks from the App Store / Play Store.
2. In the crew app: **More → Phones → Add this phone**, give it a name, **Create**.
3. Tap **Open in OwnTracks**. The app imports mode, URL, user ID, password and tracker ID.
   From another device, scan the QR instead. Manual values are under *Manual settings*.
4. iOS: allow Location **Always** and Precise. Android: allow location *All the time* and turn
   off battery optimisation for OwnTracks.
5. In OwnTracks set *Monitoring* to **Move** (the imported config already does this: a fix
   every 30 s or 20 m while moving).

The secret is shown once. If it is lost, revoke the phone and add it again.

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
| 401 in OwnTracks | Phone revoked or secret wrong: revoke and re-add. |
| Fixes arrive but no track on the console | The user has not pressed *I'm responding* and is not in a team. |
| Stale on the console after a few minutes | iOS background throttling: ensure Location *Always*, Monitoring *Move*; Android battery optimisation. |
| Altitude looks off by ~50 m | Android reports ellipsoid height, iOS mean-sea-level. Treat as GPS altitude. |
