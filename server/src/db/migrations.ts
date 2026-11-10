/**
 * Numbered schema migrations applied under PRAGMA user_version. Append only;
 * never edit a shipped entry. Each entry runs inside one transaction.
 */
export const MIGRATIONS: string[] = [
  // 1 — Phase 2 initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    callsign TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin','manager','member')),
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    privacy_accepted_at TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user','display')),
    label TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);

  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    secret_hash TEXT NOT NULL,
    tid TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    last_ip TEXT,
    revoked_at TEXT,
    last_lat REAL, last_lon REAL, last_alt REAL, last_acc REAL, last_batt INTEGER, last_tst INTEGER
  );
  CREATE INDEX devices_user ON devices(user_id);

  CREATE TABLE incidents (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    received_at TEXT NOT NULL,
    lat REAL, lon REAL,
    source TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT,
    created_by INTEGER
  );
  CREATE INDEX incidents_ended ON incidents(ended_at);

  CREATE TABLE responses (
    id INTEGER PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('responding','on-scene','available','unavailable','stood-down')),
    eta_min INTEGER,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (incident_id, user_id)
  );

  CREATE TABLE teams (
    id INTEGER PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    colour TEXT NOT NULL,
    search_width_m REAL NOT NULL DEFAULT 20,
    leader_user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'forming' CHECK (status IN ('forming','tasked','searching','returned','stood-down')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (incident_id, name)
  );

  CREATE TABLE team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    position INTEGER NOT NULL,
    joined_at TEXT NOT NULL,
    left_at TEXT,
    PRIMARY KEY (team_id, user_id)
  );

  CREATE TABLE targets (
    id INTEGER PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('point','area','line')),
    geometry TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','assigned','in-progress','done','cancelled')),
    priority INTEGER NOT NULL DEFAULT 2,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX targets_incident ON targets(incident_id);
  CREATE INDEX targets_team ON targets(team_id);

  CREATE TABLE positions (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id INTEGER,
    incident_id TEXT,
    team_id INTEGER,
    tst INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    alt REAL, acc REAL, vel REAL, cog REAL, batt INTEGER, trig TEXT,
    UNIQUE (device_id, tst)
  );
  CREATE INDEX positions_incident ON positions(incident_id, team_id, tst);
  CREATE INDEX positions_user ON positions(user_id, tst);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor_user_id INTEGER,
    actor_ip TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail TEXT
  );
  CREATE INDEX audit_at ON audit_log(at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `,
  // 2 — taskings, search planning point, subject details
  `
  ALTER TABLE incidents ADD COLUMN kind TEXT NOT NULL DEFAULT 'callout';
  ALTER TABLE incidents ADD COLUMN ipp_lat REAL;
  ALTER TABLE incidents ADD COLUMN ipp_lon REAL;
  ALTER TABLE incidents ADD COLUMN ipp_label TEXT;
  ALTER TABLE incidents ADD COLUMN ipp_set_at TEXT;

  CREATE TABLE incident_subjects (
    incident_id TEXT PRIMARY KEY REFERENCES incidents(id) ON DELETE CASCADE,
    name TEXT,
    sex TEXT,
    age INTEGER,
    clothing TEXT,
    description TEXT,
    locations TEXT,
    history TEXT,
    despondent INTEGER NOT NULL DEFAULT 0,
    mental_health INTEGER NOT NULL DEFAULT 0,
    self_harm INTEGER NOT NULL DEFAULT 0,
    self_harm_means TEXT,
    photo_mime TEXT,
    photo_updated_at TEXT,
    updated_at TEXT NOT NULL,
    updated_by INTEGER
  );
  `,
  // 3 — history: every response status change, and conditions at incident start/end
  `
  CREATE TABLE response_events (
    id INTEGER PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    eta_min INTEGER,
    at TEXT NOT NULL
  );
  CREATE INDEX response_events_incident ON response_events(incident_id, at);

  CREATE TABLE incident_conditions (
    id INTEGER PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('start','end')),
    at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX incident_conditions_incident ON incident_conditions(incident_id, at);
  `,
  // 4 — subject behaviour profile (MISPER-UK category slug) and terrain, for search planning
  `
  ALTER TABLE incident_subjects ADD COLUMN category TEXT;
  ALTER TABLE incident_subjects ADD COLUMN terrain TEXT;
  `,
  // 5 — despondent characteristics on the subject (UKMPBS 2011 Table 16 factors)
  `
  ALTER TABLE incident_subjects ADD COLUMN suicide_threatened INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE incident_subjects ADD COLUMN depression INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE incident_subjects ADD COLUMN significant_place INTEGER NOT NULL DEFAULT 0;
  `,
  // 6 — typed planning points (LKP, place last seen, home, vehicle, significant places); the old
  // single IPP becomes the incident's 'lkp' point. incidents.ipp_* stay but are no longer written.
  `
  CREATE TABLE planning_points (
    id INTEGER PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('lkp','pls','home','vehicle','significant','other')),
    label TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    note TEXT,
    set_at TEXT NOT NULL,
    set_by INTEGER
  );
  CREATE INDEX planning_points_incident ON planning_points(incident_id);
  CREATE UNIQUE INDEX planning_points_one_lkp ON planning_points(incident_id) WHERE kind = 'lkp';
  CREATE UNIQUE INDEX planning_points_one_pls ON planning_points(incident_id) WHERE kind = 'pls';
  INSERT INTO planning_points (incident_id, kind, label, lat, lon, set_at)
    SELECT id, 'lkp', ipp_label, ipp_lat, ipp_lon, COALESCE(ipp_set_at, started_at) FROM incidents WHERE ipp_lat IS NOT NULL AND ipp_lon IS NOT NULL;
  `,
  // 7 — finds reported by crew (clue, item, sighting, subject found) are planning points of kind
  // 'find'. SQLite cannot widen a CHECK, so the table is rebuilt with the same rows and indexes.
  `
  CREATE TABLE planning_points_new (
    id INTEGER PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('lkp','pls','home','vehicle','significant','other','find')),
    label TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    note TEXT,
    set_at TEXT NOT NULL,
    set_by INTEGER
  );
  INSERT INTO planning_points_new (id, incident_id, kind, label, lat, lon, note, set_at, set_by)
    SELECT id, incident_id, kind, label, lat, lon, note, set_at, set_by FROM planning_points;
  DROP TABLE planning_points;
  ALTER TABLE planning_points_new RENAME TO planning_points;
  CREATE INDEX planning_points_incident ON planning_points(incident_id);
  CREATE UNIQUE INDEX planning_points_one_lkp ON planning_points(incident_id) WHERE kind = 'lkp';
  CREATE UNIQUE INDEX planning_points_one_pls ON planning_points(incident_id) WHERE kind = 'pls';
  `,
];
