# Privacy notice — Howth Coast Guard crew app

**Controller**: Howth Coast Guard Unit (Irish Coast Guard volunteer unit). Contact: the
Officer in Charge. *(Confirm with the unit whether IRCG / the Department of Transport is
to be named as controller; update this file and the in-app notice together.)*

**Purpose**: coordinating the unit's response to callouts: who is responding, where search
teams are, what has been searched. Lawful basis: the unit's legitimate interest in
conducting search and rescue safely; location tracking is additionally under your control
(it only runs when you press *I'm responding* or are placed in a team, and only while the
OwnTracks app is installed and linked).

**What is collected**

| Data | When | Kept |
| --- | --- | --- |
| Name, email, callsign, role | Account creation by the admin | While you are a member; anonymised on removal |
| Login sessions (hashed token, device/browser, IP) | Each sign-in | Up to 180 days |
| Response status and ETA | When you tap Responding / On scene / Stand down | With the incident record |
| Position (lat/lon, altitude, accuracy, speed, battery) from OwnTracks | Only while an incident is open **and** you are responding or in a team | Track points: indefinitely as the operational record (configurable); last known position cleared after 24 h |
| Team assignment and callsign | When the search manager assigns you | With the incident record |
| Audit log of changes (who created teams, targets, users) | On each change | 2 years |

**Who sees it**: logged-in crew, the search manager and station officers, and the station
wall display. Positions are visible to everyone responding to the same incident. Nothing is
shared outside the unit except as required for an incident review or by law.

**Your rights**: ask the admin to see, correct or remove your data. Removal anonymises your
account; your track points stay in the incident record without your name. You can revoke a
phone at any time under *More → Phones*, which stops tracking immediately.

**Security**: the service runs on a single server with TLS, authenticated access, per-user
accounts, and nightly backups kept on the same server plus the hosting provider's backups.

## Subject details (who the search is for)

The search manager can record details of the person being searched for: name, sex, age,
clothing and description, significant locations, relevant history, whether they are
despondent, have mental health concerns or previous self-harm (and the means), and a recent
photo. This is special-category personal data about a third party, held only as long as the
incident record and only to run the search.

- **Who sees it:** logged-in crew (members, search managers, admins) on the Status page of the
  crew app and in the console. It is **never** sent to display keys, so the station TV cannot
  show it, and it is not in the WebSocket snapshot: phones fetch it over an authenticated
  request when it changes.
- **Audit:** the audit log records that the subject record changed and which fields, never the
  values.
- **Retention:** the record and photo are deleted with the incident. Admins can remove the
  photo at any time (console → Subject → Remove photo).
- **Crew:** do not screenshot or forward these details; they are for the search only.
