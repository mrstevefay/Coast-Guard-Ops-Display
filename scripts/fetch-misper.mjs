// Fetches the UK missing-person behaviour statistics from MISPER-UK (The Centre for
// Search Research, https://misper.uk) and writes them as a TypeScript dataset.
// Usage: node scripts/fetch-misper.mjs   → shared/lpb/misperUk.ts
//
// The site's HTML tables are incomplete (they drop some location rows), so the counts
// are read from the Highcharts series embedded in each page, and the distance deciles
// from the map's data-dataset attribute. Every category is reconciled (outcome total =
// location totals = n) before anything is written; a mismatch aborts the run.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://misper.uk';
const OUT = path.resolve('shared/lpb/misperUk.ts');

const TERRAINS = ['Crag / Broken Ground', 'Farmland', 'Moorland / Upland', 'Not Specified', 'Plantation (dense)', 'Urban', 'Water Margin', 'Woodland / Parkland'];
const LOCATIONS = ['Habitation', 'Travel Aid', 'Linear Feature', 'Open Ground', 'Trees', 'Water', 'Not Found'];
const OUTCOMES = ['None', 'Minor Injury', 'Serious Injury', 'Fatality', 'Unknown'];

const html = async (p) => {
  const r = await fetch(BASE + p, { headers: { 'user-agent': 'coast-guard-ops-display/fetch-misper' } });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.text();
};
const unescape = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const text = (s) => unescape(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
/** Paragraph-aware text: each <p>/<li> becomes its own string. */
const paras = (s) => [...s.matchAll(/<(?:p|li)[^>]*>(.*?)<\/(?:p|li)>/gs)].map((m) => text(m[1])).filter(Boolean);
const series = (s) => [...s.matchAll(/series:\s*(\[.*?\])\s*\n/g)].map((m) => JSON.parse(m[1]));
const counts = (points, keys, what) => {
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const p of points) {
    if (!(p.name in out)) throw new Error(`${what}: unknown key "${p.name}"`);
    out[p.name] = p.y;
  }
  return out;
};
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

async function category(slug, name, definition) {
  const page = await html(`/initial-response/${slug}/`);
  const ser = series(page);
  if (ser.length < 3) throw new Error(`${slug}: expected at least 3 chart series, got ${ser.length}`);
  const cats = [...page.match(/categories:\s*\[([^\]]*)\]/)[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  for (const c of cats) if (!TERRAINS.includes(c)) throw new Error(`${slug}: unknown terrain "${c}"`);
  const bySex = Object.fromEntries(ser[0].map((x) => [x.name, x.data]));
  const terrainBySex = cats.map((terrain, i) => ({ terrain, male: bySex.Male?.[i] ?? 0, female: bySex.Female?.[i] ?? 0, other: bySex.Other?.[i] ?? 0 }));
  const outcome = counts(ser[1][0].data, OUTCOMES, `${slug} outcome`);
  const all = counts(ser[2][0].data, LOCATIONS, `${slug} locations`);
  // Per-terrain blocks: <div id="itemTerrain-<Key>"> … <h3>Terrain name</h3> … series
  const keyToName = Object.fromEntries([...page.matchAll(/<option value="([A-Za-z]+)">([^<]+)</g)].map((m) => [m[1], text(m[2])]).filter(([k]) => k !== 'all'));
  const blocks = [...page.matchAll(/<div id="itemTerrain-([A-Za-z]+)" class="itemTerrain"/g)].map((m) => m[1]).filter((k) => k !== 'all');
  if (blocks.length !== ser.length - 3) throw new Error(`${slug}: ${blocks.length} terrain blocks but ${ser.length - 3} terrain series`);
  const byTerrain = {};
  blocks.forEach((key, i) => {
    const terrain = keyToName[key];
    if (!TERRAINS.includes(terrain)) throw new Error(`${slug}: terrain key ${key} → "${terrain}" unknown`);
    byTerrain[terrain] = counts(ser[3 + i][0].data, LOCATIONS, `${slug}/${terrain}`);
  });
  const ds = page.match(/data-dataset="([^"]+)"/);
  if (!ds) throw new Error(`${slug}: no distance dataset`);
  const deciles = JSON.parse(unescape(ds[1])).map((d) => ({ pct: d.Key, km: d.Value }));
  const extra = [...page.matchAll(/Distance: ([\d.]+) Km \/ Percentage: (\d+)%/g)].map((m) => ({ pct: Number(m[2]), km: Number(m[1]) }));
  const distanceKm = [...deciles, ...extra.filter((e) => !deciles.some((d) => d.pct === e.pct))].sort((a, b) => a.pct - b.pct || a.km - b.km);
  const notes = [...page.matchAll(/<div class="alert alert-warning">(.*?)<\/div>/gs)].flatMap((m) => paras(m[1]));
  const caution = /<div class="alert alert-danger[^"]*">(.*?)<\/div>/s.exec(page);
  const lowNumbersCaution = Boolean(caution);
  const n = sum(outcome);
  const problems = [];
  if (sum(all) !== n) problems.push(`all-terrains locations ${sum(all)} ≠ outcome ${n}`);
  const byT = Object.values(byTerrain).reduce((a, t) => a + sum(t), 0);
  if (byT !== n) problems.push(`per-terrain locations ${byT} ≠ ${n}`);
  const bySexN = terrainBySex.reduce((a, t) => a + t.male + t.female + t.other, 0);
  if (Math.abs(bySexN - n) > 4) problems.push(`terrain-by-sex ${bySexN} far from ${n}`);
  for (let i = 1; i < distanceKm.length; i++) if (distanceKm[i].km < distanceKm[i - 1].km) problems.push(`distance not monotonic at ${distanceKm[i].pct}%`);
  if (problems.length) throw new Error(`${slug}: ${problems.join('; ')}`);
  console.log(`${slug.padEnd(24)} n=${String(n).padStart(5)} terrains=${cats.length} deciles=${deciles.length} extra=${extra.length} notes=${notes.length}${lowNumbersCaution ? ' (caution)' : ''}`);
  return { slug, name, definition, n, sourceUrl: `${BASE}/initial-response/${slug}/`, lowNumbersCaution, terrainBySex, outcome, locations: { all, byTerrain }, distanceKm, notes };
}

async function immediate() {
  const page = await html('/immediate-response/');
  const pct = (re) => {
    const m = re.exec(page);
    if (!m) throw new Error(`immediate-response: ${re} not found`);
    return Number(m[1]);
  };
  const body = page.slice(page.indexOf('<main'));
  const t = text(body);
  const notes = [...body.matchAll(/<p[^>]*>(.*?)<\/p>/gs)].map((m) => text(m[1])).filter((p) => /approximately|travel aid/i.test(p));
  const tacticsIdx = body.indexOf('Search Tactics for Immediate Response');
  const tactics = tacticsIdx >= 0 ? paras(body.slice(tacticsIdx)).filter((p) => !/^Search Tactics/.test(p)) : [];
  if (!tactics.length) throw new Error('immediate-response: no tactics found');
  return {
    foundAlivePct: pct(/Found Alive \([^,]*,\s*(\d+)%\)/), fatalityPct: pct(/Fatality \([^,]*,\s*(\d+)%\)/), noTracePct: pct(/No Trace \([^,]*,\s*(\d+)%\)/),
    within500mPct: Number(/Within 500m\s*-\s*(\d+)%/.exec(t)[1]),
    within1kmPct: Number(/Within 1km\s*-\s*(\d+)%/.exec(t)[1]),
    notes, tactics,
  };
}

async function main() {
  const index = await html('/initial-response/');
  const links = [...index.matchAll(/<a href="\/initial-response\/([a-z0-9-]+)\/" title="([^"]+)"[^>]*>[\s\S]*?data-bs-target="#(subcat-\d+)"/g)];
  if (links.length !== 15) throw new Error(`expected 15 categories on the index, found ${links.length}`);
  const definitionOf = (id) => {
    const m = new RegExp(`id="${id}"[\\s\\S]*?class="modal-body">([\\s\\S]*?)</div>`).exec(index);
    return m ? paras(m[1]).join(' ') || text(m[1]) : '';
  };
  const profiles = [];
  for (const [, slug, name, modal] of links) profiles.push(await category(slug, unescape(name), definitionOf(modal)));
  const total = profiles.reduce((a, p) => a + p.n, 0);
  const dataset = {
    source: {
      name: 'MISPER-UK',
      publisher: 'The Centre for Search Research (tcsr.org.uk)',
      url: `${BASE}/`,
      study: 'UK Missing Person Behaviour Study 2011 (Perkins, Roberts & Feeney) and later MREW incident data',
      dataProvider: 'Mountain Rescue England and Wales (MREW) team incident reports',
      attribution: 'Statistics © The Centre for Search Research, from MISPER-UK (misper.uk), built on data supplied by Mountain Rescue England and Wales.',
      licence: 'No reuse licence is stated on misper.uk; used with attribution for operational planning. Confirm permission with The Centre for Search Research before wider distribution.',
      fetchedAt: new Date().toISOString(),
    },
    immediate: await immediate(),
    profiles,
  };
  const body = JSON.stringify(dataset, null, 2);
  const out = `// GENERATED by scripts/fetch-misper.mjs on ${dataset.source.fetchedAt.slice(0, 10)} — do not edit by hand; rerun the script.
// Source: MISPER-UK, The Centre for Search Research (https://misper.uk). ${total} incidents across ${profiles.length} categories.
import type { LpbDataset } from './types.js';

export const MISPER_UK: LpbDataset = ${body} as LpbDataset;
`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${profiles.length} profiles, ${total} incidents`);
}

await main();
