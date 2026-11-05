import { describe, expect, it } from 'vitest';
import { Users } from '../src/auth/users.js';
import { hashPassword, randomToken, sha256Hex, tempPassword, timingSafeEqualStr, verifyPassword } from '../src/auth/password.js';
import { Db, openDb } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';

describe('db + migrations', () => {
  it('migrates an empty database to the latest version, idempotently', () => {
    const db = openDb(':memory:');
    expect(db.version).toBe(MIGRATIONS.length);
    expect(db.migrate()).toBe(0);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['users', 'sessions', 'devices', 'incidents', 'responses', 'teams', 'team_members', 'targets', 'positions', 'audit_log', 'settings']));
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    db.close();
  });

  it('rolls back a failing transaction', () => {
    const db = new Db(':memory:');
    db.migrate();
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO settings (key, value) VALUES ('a', '1')");
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.all('SELECT * FROM settings')).toHaveLength(0);
    db.close();
  });
});

describe('passwords and tokens', () => {
  it('hashes and verifies with scrypt', () => {
    const h = hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$15$8$1$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
  it('generates distinct tokens and temp passwords', () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken()).toHaveLength(43);
    expect(sha256Hex('a')).toHaveLength(64);
    expect(tempPassword()).toMatch(/^[a-z]+-\d{4}-[a-z]+$/);
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
  });
});

describe('users', () => {
  const db = openDb(':memory:');
  const users = new Users(db);

  it('bootstraps an admin once', () => {
    expect(users.bootstrapAdmin('admin@example.ie', 'first-password-1', 'Admin')).toBe(true);
    expect(users.bootstrapAdmin('other@example.ie', 'x-password-123')).toBe(false);
    expect(users.count()).toBe(1);
    const a = users.byEmail('ADMIN@example.ie')!;
    expect(a.role).toBe('admin');
    expect(a.must_change_password).toBe(1);
  });

  it('creates users with generated temp passwords and authenticates', () => {
    const { user, tempPassword: tp } = users.create({ email: 'joe@example.ie', name: 'Joe', callsign: 'JF', role: 'member' });
    expect(tp).toMatch(/-/);
    expect(users.authenticate('joe@example.ie', tp!)?.id).toBe(user.id);
    expect(users.authenticate('joe@example.ie', 'nope')).toBeUndefined();
    expect(users.authenticate('nobody@example.ie', 'nope')).toBeUndefined();
    expect(() => users.create({ email: 'joe@example.ie', name: 'Dup', role: 'member' })).toThrow(/in use/);
    expect(() => users.create({ email: 'bad', name: 'X', role: 'member' })).toThrow(/email/);
  });

  it('updates, resets, deactivates and anonymises', () => {
    const joe = users.byEmail('joe@example.ie')!;
    users.update(joe.id, { role: 'manager', callsign: 'A0' });
    expect(users.byId(joe.id)?.role).toBe('manager');
    const pw = users.resetPassword(joe.id);
    expect(users.authenticate('joe@example.ie', pw)?.must_change_password).toBe(1);
    users.update(joe.id, { active: false });
    expect(users.authenticate('joe@example.ie', pw)).toBeUndefined();
    users.anonymise(joe.id);
    expect(users.byId(joe.id)?.name).toBe('Deleted user');
    expect(users.byEmail('joe@example.ie')).toBeUndefined();
  });
});
