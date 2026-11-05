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
];
