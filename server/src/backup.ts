import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db/index.js';

const { backup } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export interface BackupInfo {
  file: string;
  bytes: number;
  at: string;
}

/** Online, consistent copy of the SQLite file via the backup API. Keeps the newest `keep`. */
export async function backupDb(db: Db, dir: string, keep: number): Promise<BackupInfo> {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `ops-${stamp}.db`);
  await backup(db.raw, file);
  const bytes = fs.statSync(file).size;
  for (const old of listBackups(dir).slice(keep)) fs.rmSync(old.file, { force: true });
  return { file, bytes, at: new Date().toISOString() };
}

export function listBackups(dir: string): BackupInfo[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^ops-.*\.db$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: path.join(dir, f), bytes: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
