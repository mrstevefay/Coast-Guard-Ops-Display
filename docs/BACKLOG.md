# Backlog

Candidate work after Phase 2, roughly in priority order. Nothing here is scheduled.

## 1. Pager / WhatsApp bridge

Turn a pager message or WhatsApp group post into `POST /api/callout` with the bridge token,
and `standdown` likewise. External process; no schema change. See README → Phase 3 hooks.

## 2. Push notifications on callout

Web Push to crew phones when an incident opens (VAPID keys, `push_subscriptions` table,
service-worker handler in the crew PWA). Falls back to the pager, never replaces it.

## 3. D4H availability feed

Read crew availability from D4H and seed `responses` with status `available` so the muster
panel shows who is on-island before anyone presses *I'm responding*.

## 4. Search planning module: lost person behaviour, scenario analysis, POI reference

**Goal.** Give the search manager a first search plan within minutes of a callout, grounded
in the *UK Missing Person Behaviour Study* (UKMPBS, Centre for Search Research, Perkins,
Roberts & Feeney 2011; plus the later UK update and ISRID where UK data is thin), rather
than drawing targets from memory.

**Inputs.**

- Subject profile from the console: category (despondent, dementia, child by age band,
  walker/hiker, mental health, autism, elderly, water-related, etc.), age, mobility, mental
  state, intention if known.
- Initial Planning Point (IPP): last known position or place last seen, dropped on the map.
- Time missing, weather, daylight (already in state), tide (already in state) for
  coastal/foreshore cases.

**Behaviour reference.** Per category: distance from IPP quartiles (25 / 50 / 75 / 95 %),
find-location types (water's edge, road/track, building, open ground, woodland, cliff base),
direction of travel tendencies, mobility over time, survivability curves. Store as a versioned
JSON dataset (`server/src/search/behaviour/ukmpbs.json`) with citation per row; confirm the
study's reuse licence before shipping the numbers.

**Scenario analysis.** The search manager records 2 to 5 scenarios (e.g. "entered water at
the pier", "walked the cliff path east", "returned to car park / left area") and weights them
by consensus (simple 0–100 split, Mattson-style). Each scenario maps to the behaviour profile
and to POIs, producing segments with an initial probability of area (POA). After a team
reports a segment searched with an estimated probability of detection (POD), POA is updated
(Bayesian, `POA' = POA × (1 − POD)` normalised) and the ranking refreshes. Show the ranked
segment list with cumulative POS.

**POI-based reference.** Pull points of interest around the IPP from OpenStreetMap
(Overpass, cached per station: piers, slipways, beaches, cliffs, car parks, bus stops, pubs,
shelters, lifebuoy stations, benches, paths, drainage, buildings) and from a station-curated
list in `config.yaml` (known hazard spots, regular routes). Rank POIs per scenario using the
find-location statistics and distance quartiles; one click turns a POI into a target on the
existing targets layer.

**Map output.** Quartile rings (25/50/75/95 %) around the IPP, scenario-coloured segment
polygons, ranked POI markers. All reuse `web/src/search/layers.ts` and the existing
`targets` API, so segments become assignable targets with no new tracking logic.

**Data model.** `incident_subject` (profile), `scenarios` (incident, label, weight),
`segments` (incident, scenario, geometry, poa, pod, searched_at, team_id → existing targets
row), `poi_cache` (station, osm_id, kind, geometry, fetched_at). Audit every weight change.

**Out of scope / caveats.** Not a replacement for IRCG search procedure or the SMC's
judgement; the UK figures are land SAR statistics, so coastal drift is handled by the
existing tide/wind panels, not by this module. No drift modelling (that would be a separate
SAROPS-style item).

**Acceptance.** From a test callout at Howth pier, enter "walker, 65, mobile", two
scenarios, and get within two minutes: rings, ranked POIs, three segments assigned to Alpha
teams, and a POA table that updates after a segment is marked searched at 70 % POD.
