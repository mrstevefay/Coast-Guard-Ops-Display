import fs from 'node:fs';
import path from 'node:path';
import type { IncidentSubject } from '../../../shared/types.js';
import { now, type Db } from '../db/index.js';

interface SubjectRow {
  incident_id: string; name: string | null; sex: string | null; age: number | null; clothing: string | null; description: string | null;
  locations: string | null; history: string | null; despondent: number; mental_health: number; self_harm: number; self_harm_means: string | null;
  photo_mime: string | null; photo_updated_at: string | null; updated_at: string; updated_by: number | null;
}

export type SubjectPatch = Partial<Pick<IncidentSubject, 'name' | 'sex' | 'age' | 'clothing' | 'description' | 'locations' | 'history' | 'despondent' | 'mentalHealth' | 'selfHarmHistory' | 'selfHarmMeans'>>;

const PHOTO_MIMES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const PHOTO_MAX_BYTES = 6 * 1024 * 1024;
const TEXT_MAX = 2000;

/**
 * Who the search is for: description, flags and a photo, per incident. Kept out of the
 * WebSocket snapshot so the TV (display key) never receives it; phones fetch it when
 * `subjectUpdatedAt` on the incident changes. The photo lives on disk under dataDir/subjects.
 */
export class Subjects {
  constructor(private readonly db: Db, private readonly dir: string) {}

  get(incidentId: string): IncidentSubject | undefined {
    const r = this.db.get<SubjectRow>('SELECT * FROM incident_subjects WHERE incident_id = ?', incidentId);
    return r ? toSubject(r) : undefined;
  }

  updatedAt(incidentId: string): string | undefined {
    return this.db.get<{ updated_at: string }>('SELECT updated_at FROM incident_subjects WHERE incident_id = ?', incidentId)?.updated_at;
  }

  set(incidentId: string, patch: SubjectPatch, by?: number): IncidentSubject {
    const cur = this.db.get<SubjectRow>('SELECT * FROM incident_subjects WHERE incident_id = ?', incidentId);
    const text = (v: string | undefined | null, prev: string | null) => (v === undefined ? prev : v === null || v.trim() === '' ? null : v.trim().slice(0, TEXT_MAX));
    const flag = (v: boolean | undefined, prev: number) => (v === undefined ? prev : v ? 1 : 0);
    let age: number | null = cur?.age ?? null;
    if (patch.age !== undefined) {
      if (patch.age === null || (patch.age as unknown) === '') age = null;
      else {
        const n = Number(patch.age);
        if (!Number.isInteger(n) || n < 0 || n > 120) throw new Error('age must be 0–120');
        age = n;
      }
    }
    const sex = patch.sex === undefined ? (cur?.sex ?? null) : patch.sex ? String(patch.sex).slice(0, 20) : null;
    const t = now();
    this.db.run(
      `INSERT INTO incident_subjects (incident_id, name, sex, age, clothing, description, locations, history, despondent, mental_health, self_harm, self_harm_means, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(incident_id) DO UPDATE SET name = excluded.name, sex = excluded.sex, age = excluded.age, clothing = excluded.clothing, description = excluded.description,
         locations = excluded.locations, history = excluded.history, despondent = excluded.despondent, mental_health = excluded.mental_health, self_harm = excluded.self_harm,
         self_harm_means = excluded.self_harm_means, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      incidentId, text(patch.name, cur?.name ?? null), sex, age, text(patch.clothing, cur?.clothing ?? null), text(patch.description, cur?.description ?? null),
      text(patch.locations, cur?.locations ?? null), text(patch.history, cur?.history ?? null), flag(patch.despondent, cur?.despondent ?? 0), flag(patch.mentalHealth, cur?.mental_health ?? 0),
      flag(patch.selfHarmHistory, cur?.self_harm ?? 0), text(patch.selfHarmMeans, cur?.self_harm_means ?? null), t, by ?? null,
    );
    return this.get(incidentId)!;
  }

  photoPath(incidentId: string): { file: string; mime: string } | undefined {
    const r = this.db.get<{ photo_mime: string | null }>('SELECT photo_mime FROM incident_subjects WHERE incident_id = ?', incidentId);
    if (!r?.photo_mime) return undefined;
    const file = path.join(this.dir, `${safeId(incidentId)}.${PHOTO_MIMES[r.photo_mime] ?? 'bin'}`);
    return fs.existsSync(file) ? { file, mime: r.photo_mime } : undefined;
  }

  setPhoto(incidentId: string, data: Buffer, mime: string, by?: number): IncidentSubject {
    const ext = PHOTO_MIMES[mime];
    if (!ext) throw new Error('photo must be JPEG, PNG or WebP');
    if (!data.length) throw new Error('empty photo');
    if (data.length > PHOTO_MAX_BYTES) throw new Error('photo too large (max 6 MB; the console resizes before upload)');
    fs.mkdirSync(this.dir, { recursive: true });
    this.deletePhotoFile(incidentId);
    fs.writeFileSync(path.join(this.dir, `${safeId(incidentId)}.${ext}`), data);
    const t = now();
    if (!this.db.get('SELECT 1 FROM incident_subjects WHERE incident_id = ?', incidentId)) this.set(incidentId, {}, by);
    this.db.run('UPDATE incident_subjects SET photo_mime = ?, photo_updated_at = ?, updated_at = ?, updated_by = ? WHERE incident_id = ?', mime, t, t, by ?? null, incidentId);
    return this.get(incidentId)!;
  }

  deletePhoto(incidentId: string, by?: number): IncidentSubject | undefined {
    this.deletePhotoFile(incidentId);
    const t = now();
    this.db.run('UPDATE incident_subjects SET photo_mime = NULL, photo_updated_at = NULL, updated_at = ?, updated_by = ? WHERE incident_id = ?', t, by ?? null, incidentId);
    return this.get(incidentId);
  }

  private deletePhotoFile(incidentId: string): void {
    for (const ext of Object.values(PHOTO_MIMES)) {
      const f = path.join(this.dir, `${safeId(incidentId)}.${ext}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

const safeId = (id: string) => id.replace(/[^A-Za-z0-9-]/g, '_');

function toSubject(r: SubjectRow): IncidentSubject {
  return {
    incidentId: r.incident_id,
    name: r.name ?? undefined,
    sex: r.sex ?? undefined,
    age: r.age ?? undefined,
    clothing: r.clothing ?? undefined,
    description: r.description ?? undefined,
    locations: r.locations ?? undefined,
    history: r.history ?? undefined,
    despondent: Boolean(r.despondent),
    mentalHealth: Boolean(r.mental_health),
    selfHarmHistory: Boolean(r.self_harm),
    selfHarmMeans: r.self_harm_means ?? undefined,
    hasPhoto: Boolean(r.photo_mime),
    photoUpdatedAt: r.photo_updated_at ?? undefined,
    updatedAt: r.updated_at,
  };
}
