import { LPB, profileBySlug, ringRadiiKm } from '../../../shared/lpb/index.js';
import type { ConditionsSnapshot, IncidentReplay, ReplayEvent, ReplayFix, SearchIncident, Target, TargetGeometry, Team, TeamMembership } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { haversineKm } from '../util/units.js';

/**
 * End-of-mission report: the numbers HQ asks for (response times, time on scene, areas
 * searched, conditions) computed from the incident record, plus a printable HTML version
 * with a schematic map. Pure functions over the replay bundle; no DB access here.
 */

export interface ResponderReport {
  userId: number;
  name: string;
  callsign?: string;
  team?: string;
  teamCallsign?: string;
  finalStatus: string;
  respondedAt?: string;
  /** Minutes from incident start to "responding". */
  responseMin?: number;
  onSceneAt?: string;
  /** Minutes from incident start to "on scene". */
  toSceneMin?: number;
  stoodDownAt?: string;
  /** Minutes between on scene and stand-down / incident end. */
  onSceneMin?: number;
  etaMin?: number;
  trackKm: number;
}

export interface TeamReport {
  id: number;
  name: string;
  colour: string;
  status: string;
  searchWidthM: number;
  members: TeamMembership[];
  targets: string[];
  firstFixAt?: string;
  lastFixAt?: string;
  searchingMin: number;
  trackKm: number;
  /** Track length × 2 × sweep width, km². */
  sweptKm2: number;
}

export interface IncidentReport {
  station: string;
  incident: SearchIncident;
  generatedAt: string;
  durationMin: number;
  responders: ResponderReport[];
  teams: TeamReport[];
  targets: Target[];
  events: ReplayEvent[];
  conditions: ConditionsSnapshot[];
  totals: { responders: number; onScene: number; teams: number; targetsDone: number; targetsTotal: number; trackKm: number; sweptKm2: number; fixes: number };
  subject?: ReportSubject;
}

export interface ReportSubject {
  name?: string;
  sex?: string;
  age?: number;
  /** MISPER-UK behaviour category slug and terrain, if recorded. */
  category?: string;
  terrain?: string;
}

const minutesBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));

export function buildReport(
  replay: IncidentReplay,
  opts: { station: string; cfg: AppConfig; responseEvents: { userId: number; status: string; etaMin?: number; at: string }[]; subject?: ReportSubject },
): IncidentReport {
  const inc = replay.incident;
  const end = inc.endedAt ?? new Date().toISOString();
  const gapSec = opts.cfg.search.trackGapSec;

  // Distance per user (and per team) from consecutive fixes, ignoring long gaps.
  const perUserKm = new Map<number, number>();
  const perTeam = new Map<number, { km: number; first?: number; last?: number }>();
  const byUser = new Map<number, ReplayFix[]>();
  for (const f of replay.fixes) {
    const arr = byUser.get(f.u) ?? [];
    arr.push(f);
    byUser.set(f.u, arr);
  }
  for (const [uid, fixes] of byUser) {
    let km = 0;
    for (let i = 1; i < fixes.length; i++) {
      const a = fixes[i - 1], b = fixes[i];
      if (b.t - a.t > gapSec || a.team !== b.team) continue;
      const d = haversineKm(a.lat, a.lon, b.lat, b.lon);
      km += d;
      if (b.team !== null) {
        const t = perTeam.get(b.team) ?? { km: 0 };
        t.km += d;
        perTeam.set(b.team, t);
      }
    }
    for (const f of fixes) {
      if (f.team === null) continue;
      const t = perTeam.get(f.team) ?? { km: 0 };
      t.first = t.first === undefined ? f.t : Math.min(t.first, f.t);
      t.last = t.last === undefined ? f.t : Math.max(t.last, f.t);
      perTeam.set(f.team, t);
    }
    perUserKm.set(uid, km);
  }

  const firstEvent = (uid: number, status: string) => opts.responseEvents.find((e) => e.userId === uid && e.status === status)?.at;
  const lastEvent = (uid: number, status: string) => [...opts.responseEvents].reverse().find((e) => e.userId === uid && e.status === status)?.at;
  const responders: ResponderReport[] = replay.responders
    .filter((r) => r.status !== 'available' && r.status !== 'unavailable')
    .map((r) => {
      const respondedAt = firstEvent(r.userId, 'responding') ?? r.updatedAt;
      const onSceneAt = firstEvent(r.userId, 'on-scene');
      const stoodDownAt = lastEvent(r.userId, 'stood-down');
      const team = replay.teams.find((t) => t.id === r.teamId) ?? replay.teams.find((t) => t.memberships.some((m) => m.userId === r.userId));
      return {
        userId: r.userId,
        name: r.name,
        callsign: r.callsign,
        team: team?.name,
        teamCallsign: r.teamCallsign ?? team?.memberships.find((m) => m.userId === r.userId)?.callsign,
        finalStatus: r.status,
        etaMin: r.etaMin,
        respondedAt,
        responseMin: respondedAt ? minutesBetween(inc.startedAt, respondedAt) : undefined,
        onSceneAt,
        toSceneMin: onSceneAt ? minutesBetween(inc.startedAt, onSceneAt) : undefined,
        stoodDownAt,
        onSceneMin: onSceneAt ? minutesBetween(onSceneAt, stoodDownAt ?? end) : undefined,
        trackKm: round1(perUserKm.get(r.userId) ?? 0),
      };
    })
    .sort((a, b) => (a.respondedAt ?? '').localeCompare(b.respondedAt ?? ''));

  const teams: TeamReport[] = replay.teams.map((t) => {
    const pt = perTeam.get(t.id);
    const km = pt?.km ?? 0;
    return {
      id: t.id,
      name: t.name,
      colour: t.colour,
      status: t.status,
      searchWidthM: t.searchWidthM,
      members: t.memberships,
      targets: replay.targets.filter((x) => x.teamId === t.id).map((x) => `${x.name} (${x.status})`),
      firstFixAt: pt?.first !== undefined ? new Date(pt.first * 1000).toISOString() : undefined,
      lastFixAt: pt?.last !== undefined ? new Date(pt.last * 1000).toISOString() : undefined,
      searchingMin: pt?.first !== undefined && pt?.last !== undefined ? Math.round((pt.last - pt.first) / 60) : 0,
      trackKm: round1(km),
      sweptKm2: round2((km * 2 * t.searchWidthM) / 1000),
    };
  });

  const totalKm = [...perUserKm.values()].reduce((s, k) => s + k, 0);
  return {
    station: opts.station,
    incident: inc,
    generatedAt: new Date().toISOString(),
    durationMin: minutesBetween(inc.startedAt, end),
    responders,
    teams,
    targets: replay.targets,
    events: replay.events,
    conditions: replay.conditions,
    totals: {
      responders: responders.length,
      onScene: responders.filter((r) => r.onSceneAt).length,
      teams: teams.length,
      targetsDone: replay.targets.filter((t) => t.status === 'done').length,
      targetsTotal: replay.targets.filter((t) => t.status !== 'cancelled').length,
      trackKm: round1(totalKm),
      sweptKm2: round2(teams.reduce((s, t) => s + t.sweptKm2, 0)),
      fixes: replay.fixes.length,
    },
    subject: opts.subject,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ HTML

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const dt = new Intl.DateTimeFormat('en-IE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Dublin' });
const hm = new Intl.DateTimeFormat('en-IE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Dublin' });
const fmtDT = (iso?: string) => (iso ? dt.format(new Date(iso)) : '—');
const fmtHM = (iso?: string) => (iso ? hm.format(new Date(iso)) : '—');
const fmtMin = (m?: number) => (m === undefined ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`);
const n = (v: number | undefined, unit = '', d = 0) => (v === undefined || v === null ? '—' : `${v.toFixed(d)}${unit}`);

export function renderReportHtml(r: IncidentReport, replay: IncidentReplay, station: { lat: number; lon: number; name: string }): string {
  const inc = r.incident;
  const title = `${inc.kind === 'tasking' ? 'Tasking' : 'Callout'} report — ${fmtDT(inc.startedAt)}`;
  const cond = (c: ConditionsSnapshot) => `<table class="kv">
      <tr><th>Recorded</th><td>${fmtDT(c.at)} (${c.phase})</td></tr>
      <tr><th>Wind (forecast)</th><td>${c.wind ? `${c.wind.speedKt} kt ${esc(c.wind.dirName)} F${c.wind.beaufort}${c.wind.gustKt ? `, gusts ${c.wind.gustKt} kt` : ''}` : '—'}</td></tr>
      <tr><th>Wind (observed)</th><td>${c.observed ? `${c.observed.speedKt} kt ${esc(c.observed.dirName)}${c.observed.gustKt ? `, gusts ${c.observed.gustKt} kt` : ''} at ${esc(c.observed.stationName)} ${fmtHM(c.observed.time)}` : '—'}</td></tr>
      <tr><th>Visibility</th><td>${esc(c.visibility ?? '—')}</td></tr>
      <tr><th>Weather</th><td>${esc(c.symbol ?? '—')}${c.precipMm !== undefined ? `, ${n(c.precipMm, ' mm', 1)}` : ''}${c.tempC !== undefined ? `, ${n(c.tempC, ' °C')}` : ''}${c.pressureHpa !== undefined ? `, ${n(c.pressureHpa, ' hPa')}` : ''}</td></tr>
      <tr><th>Sea state</th><td>${c.sea ? `Hs ${n(c.sea.hsM, ' m', 1)}${c.sea.periodS ? `, ${n(c.sea.periodS, ' s')}` : ''}${c.sea.seaTempC !== undefined ? `, sea ${n(c.sea.seaTempC, ' °C', 1)}` : ''}${c.sea.gale ? ', GALE' : ''} (${esc(c.sea.source)})` : '—'}</td></tr>
      <tr><th>Tide</th><td>${c.tide ? `${n(c.tide.heightM, ' m', 2)} ${c.tide.rising === undefined ? '' : c.tide.rising ? 'rising' : 'falling'}${c.tide.next ? `, next ${esc(c.tide.next.kind)} ${fmtHM(c.tide.next.time)} ${n(c.tide.next.heightM, ' m', 2)}` : ''}${c.tide.springNeap ? ` (${esc(c.tide.springNeap)})` : ''}` : '—'}</td></tr>
      <tr><th>Daylight</th><td>${c.sun ? `${c.sun.isDaylight ? 'daylight' : 'dark'}; sunrise ${fmtHM(c.sun.sunrise)}, sunset ${fmtHM(c.sun.sunset)}, civil dusk ${fmtHM(c.sun.civilDusk)}` : '—'}</td></tr>
      <tr><th>Warnings</th><td>${c.warnings.length ? c.warnings.map(esc).join('<br/>') : 'none'}</td></tr>
    </table>`;
  const subject = r.subject && (r.subject.name || r.subject.age !== undefined || r.subject.sex) ? `<p><b>Subject:</b> ${esc(r.subject.name ?? 'not recorded')}${r.subject.sex ? `, ${esc(r.subject.sex)}` : ''}${r.subject.age !== undefined ? `, ${r.subject.age} yrs` : ''}. Further details are held on the ops server and are not reproduced here.</p>` : '';
  const profile = profileBySlug(r.subject?.category);
  const behaviour = profile
    ? `<p><b>Behaviour profile:</b> ${esc(profile.name)} (MISPER-UK, n=${profile.n}${profile.lowNumbersCaution ? ', low numbers' : ''})${r.subject?.terrain ? `, terrain ${esc(r.subject.terrain)}` : ''}. Found within ${ringRadiiKm(profile).map((x) => `${x.km} km (${x.pct} %)`).join(', ') || 'n/a'} of the planning point. ${esc(LPB.source.attribution)}</p>`
    : '';
  return `<!doctype html>
<html lang="en-IE"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${esc(title)} — ${esc(station.name)}</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 0; padding: 24px; max-width: 960px; margin: 0 auto; font-size: 13px; line-height: 1.4; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 2px solid #111; padding-bottom: 3px; letter-spacing: 0.04em; text-transform: uppercase; }
  .sub { color: #555; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .stat { border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; } .stat b { display: block; font-size: 20px; } .stat span { color: #555; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0; } th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #ddd; vertical-align: top; } th { background: #f3f3f3; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
  table.kv th { width: 150px; background: none; text-transform: none; letter-spacing: 0; color: #555; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: middle; margin-right: 4px; }
  .muted { color: #666; } .small { font-size: 11px; }
  .timeline li { margin: 2px 0; } .timeline time { font-variant-numeric: tabular-nums; color: #555; margin-right: 8px; }
  svg.map { width: 100%; height: auto; border: 1px solid #ccc; border-radius: 6px; background: #f8fafc; }
  footer { margin-top: 24px; color: #666; font-size: 11px; border-top: 1px solid #ddd; padding-top: 8px; }
  @media print { body { padding: 0; } .noprint { display: none; } h2 { page-break-after: avoid; } table { page-break-inside: auto; } tr { page-break-inside: avoid; } }
</style></head><body>
<h1>${esc(station.name)} — ${inc.kind === 'tasking' ? 'Tasking' : 'Callout'} report</h1>
<div class="sub">${esc(inc.text)}</div>
<div class="grid">
  <div class="stat"><span>Started</span><b>${fmtHM(inc.startedAt)}</b>${fmtDT(inc.startedAt).slice(0, 10)}</div>
  <div class="stat"><span>${inc.endedAt ? 'Ended' : 'Status'}</span><b>${inc.endedAt ? fmtHM(inc.endedAt) : 'open'}</b>${inc.endReason ? esc(inc.endReason) : ''}</div>
  <div class="stat"><span>Duration</span><b>${fmtMin(r.durationMin)}</b></div>
  <div class="stat"><span>Responders / on scene</span><b>${r.totals.responders} / ${r.totals.onScene}</b></div>
  <div class="stat"><span>Teams</span><b>${r.totals.teams}</b></div>
  <div class="stat"><span>Targets done</span><b>${r.totals.targetsDone} / ${r.totals.targetsTotal}</b></div>
  <div class="stat"><span>Track searched</span><b>${r.totals.trackKm} km</b></div>
  <div class="stat"><span>Area swept (est.)</span><b>${r.totals.sweptKm2} km²</b>${(r.totals.sweptKm2 * 100).toFixed(0)} ha</div>
</div>
${inc.lat !== undefined && inc.lon !== undefined ? `<p><b>Incident position:</b> ${inc.lat.toFixed(4)}, ${inc.lon.toFixed(4)}</p>` : ''}
${inc.ipp ? `<p><b>Planning point:</b> ${esc(inc.ipp.label ?? 'IPP')} ${inc.ipp.lat.toFixed(4)}, ${inc.ipp.lon.toFixed(4)} (set ${fmtHM(inc.ipp.setAt)})</p>` : ''}
${subject}
${behaviour}

<h2>Responders</h2>
<table><thead><tr><th>Name</th><th>Team / callsign</th><th>Responded</th><th>Response time</th><th>On scene</th><th>Time to scene</th><th>Time on scene</th><th>Track</th><th>Final status</th></tr></thead><tbody>
${r.responders.map((p) => `<tr><td>${esc(p.name)}${p.callsign ? ` <span class="muted">${esc(p.callsign)}</span>` : ''}</td><td>${p.team ? `${esc(p.team)} ${esc(p.teamCallsign ?? '')}` : '—'}</td><td>${fmtHM(p.respondedAt)}</td><td>${fmtMin(p.responseMin)}${p.etaMin ? ` <span class="muted small">(ETA ${p.etaMin})</span>` : ''}</td><td>${fmtHM(p.onSceneAt)}</td><td>${fmtMin(p.toSceneMin)}</td><td>${fmtMin(p.onSceneMin)}</td><td>${p.trackKm} km</td><td>${esc(p.finalStatus)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No responders recorded.</td></tr>'}
</tbody></table>

<h2>Teams and areas searched</h2>
<table><thead><tr><th>Team</th><th>Members</th><th>Sweep width</th><th>Searching</th><th>Track</th><th>Area swept</th><th>Targets</th><th>Status</th></tr></thead><tbody>
${r.teams.map((t) => `<tr><td><span class="sw" style="background:${esc(t.colour)}"></span>${esc(t.name)}</td><td>${t.members.map((m) => `${esc(m.callsign)} ${esc(m.name)}${m.leftAt ? ` <span class="muted small">(left ${fmtHM(m.leftAt)})</span>` : ''}`).join('<br/>') || '—'}</td><td>${t.searchWidthM} m</td><td>${t.firstFixAt ? `${fmtHM(t.firstFixAt)}–${fmtHM(t.lastFixAt)} (${fmtMin(t.searchingMin)})` : '—'}</td><td>${t.trackKm} km</td><td>${t.sweptKm2} km²</td><td>${t.targets.map(esc).join('<br/>') || '—'}</td><td>${esc(t.status)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No teams formed.</td></tr>'}
</tbody></table>
<p class="muted small">Area swept = track length × 2 × sweep width per team; an estimate of ground covered, not a probability of detection.</p>

<h2>Targets</h2>
<table><thead><tr><th>Target</th><th>Kind</th><th>Priority</th><th>Team</th><th>Status</th><th>Completed</th><th>Notes</th></tr></thead><tbody>
${r.targets.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.kind)}</td><td>P${t.priority}</td><td>${esc(replay.teams.find((x) => x.id === t.teamId)?.name ?? '—')}</td><td>${esc(t.status)}</td><td>${fmtHM(t.completedAt)}</td><td>${esc(t.notes ?? '')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No targets.</td></tr>'}
</tbody></table>

<h2>Map</h2>
${schematicMap(replay, station)}
<p class="muted small">Schematic: tracks coloured by team, targets outlined, ★ planning point, ● station, ✚ incident position. Full detail in the GeoJSON export.</p>

<h2>Conditions</h2>
<div class="two">${r.conditions.length ? r.conditions.map(cond).join('') : '<p class="muted">No conditions were recorded for this incident.</p>'}</div>

<h2>Timeline</h2>
<ul class="timeline">${r.events.map((e) => `<li><time>${fmtHM(e.at)}</time>${esc(e.text)}</li>`).join('') || '<li class="muted">No events recorded.</li>'}</ul>

<footer>Generated ${fmtDT(r.generatedAt)} by the ${esc(station.name)} ops display · incident ${esc(inc.id)} · ${r.totals.fixes} position fixes. Times are Europe/Dublin.</footer>
</body></html>`;
}

/** Equirectangular sketch of the search: enough for a report, no base map needed. */
function schematicMap(replay: IncidentReplay, station: { lat: number; lon: number }): string {
  const pts: [number, number][] = [[station.lon, station.lat]];
  const inc = replay.incident;
  if (inc.lat !== undefined && inc.lon !== undefined) pts.push([inc.lon, inc.lat]);
  if (inc.ipp) pts.push([inc.ipp.lon, inc.ipp.lat]);
  for (const t of replay.targets) pts.push(...flat(t.geometry));
  for (const f of replay.fixes) pts.push([f.lon, f.lat]);
  // Focus on the search, not the station, when there is anything else to show.
  const focus = pts.length > 1 ? pts.slice(1) : pts;
  let minLon = Math.min(...focus.map((p) => p[0])), maxLon = Math.max(...focus.map((p) => p[0]));
  let minLat = Math.min(...focus.map((p) => p[1])), maxLat = Math.max(...focus.map((p) => p[1]));
  const cosLat = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const padLat = Math.max((maxLat - minLat) * 0.15, 0.004), padLon = Math.max((maxLon - minLon) * 0.15, 0.004 / cosLat);
  minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;
  const W = 900;
  const kmX = haversineKm(minLat, minLon, minLat, maxLon), kmY = haversineKm(minLat, minLon, maxLat, minLon);
  const H = Math.max(300, Math.round((W * kmY) / Math.max(kmX, 0.001)));
  const X = (lon: number) => ((lon - minLon) / (maxLon - minLon)) * W;
  const Y = (lat: number) => H - ((lat - minLat) / (maxLat - minLat)) * H;
  const teamColour = (id: number | null | undefined) => replay.teams.find((t) => t.id === id)?.colour ?? '#64748b';
  let svg = '';
  for (const t of replay.targets) {
    if (t.status === 'cancelled') continue;
    const c = teamColour(t.teamId);
    const g = t.geometry;
    if (g.type === 'Polygon') svg += `<polygon points="${g.coordinates[0].map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}" fill="${c}" fill-opacity="0.15" stroke="${c}" stroke-width="2" stroke-dasharray="6 4"/>`;
    else if (g.type === 'LineString') svg += `<polyline points="${g.coordinates.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="3" stroke-dasharray="6 4"/>`;
    else svg += `<circle cx="${X(g.coordinates[0]).toFixed(1)}" cy="${Y(g.coordinates[1]).toFixed(1)}" r="7" fill="${c}" stroke="#fff" stroke-width="2"/>`;
    const [ax, ay] = anchor(g);
    svg += `<text x="${(X(ax) + 9).toFixed(1)}" y="${(Y(ay) - 6).toFixed(1)}" font-size="12" font-weight="700" fill="${c}">${esc(t.name)}</text>`;
  }
  // tracks: per user, split on team change / gap
  const byUser = new Map<number, ReplayFix[]>();
  for (const f of replay.fixes) byUser.set(f.u, [...(byUser.get(f.u) ?? []), f]);
  for (const fixes of byUser.values()) {
    let seg: ReplayFix[] = [];
    const flush = () => {
      if (seg.length > 1) svg += `<polyline points="${seg.map((f) => `${X(f.lon).toFixed(1)},${Y(f.lat).toFixed(1)}`).join(' ')}" fill="none" stroke="${teamColour(seg[0].team)}" stroke-width="2" stroke-opacity="0.9" stroke-linejoin="round"/>`;
      seg = [];
    };
    for (let i = 0; i < fixes.length; i++) {
      const f = fixes[i], p = fixes[i - 1];
      if (p && (f.t - p.t > 900 || f.team !== p.team)) flush();
      seg.push(f);
    }
    flush();
  }
  svg += `<circle cx="${X(station.lon).toFixed(1)}" cy="${Y(station.lat).toFixed(1)}" r="7" fill="#0d9488" stroke="#fff" stroke-width="2"/>`;
  if (inc.lat !== undefined && inc.lon !== undefined) svg += `<text x="${X(inc.lon).toFixed(1)}" y="${(Y(inc.lat) + 7).toFixed(1)}" font-size="22" text-anchor="middle" fill="#dc2626" font-weight="900">✚</text>`;
  if (inc.ipp) svg += `<text x="${X(inc.ipp.lon).toFixed(1)}" y="${(Y(inc.ipp.lat) + 8).toFixed(1)}" font-size="24" text-anchor="middle" fill="#ca8a04">★</text>`;
  // scale bar: pick a round km
  const kmPerPx = kmX / W;
  const scaleKm = [0.1, 0.2, 0.5, 1, 2, 5, 10].find((k) => k / kmPerPx >= 120) ?? 10;
  const sw = scaleKm / kmPerPx;
  svg += `<g transform="translate(20,${H - 22})"><rect x="0" y="0" width="${sw.toFixed(1)}" height="6" fill="#111"/><text x="0" y="-4" font-size="11" fill="#111">${scaleKm < 1 ? `${scaleKm * 1000} m` : `${scaleKm} km`}</text></g>`;
  // legend
  svg += replay.teams.map((t, i) => `<g transform="translate(${W - 150},${16 + i * 16})"><rect width="12" height="12" rx="2" fill="${t.colour}"/><text x="18" y="10" font-size="11" fill="#111">${esc(t.name)} (${t.searchWidthM} m)</text></g>`).join('');
  return `<svg class="map" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
}

function flat(g: TargetGeometry): [number, number][] {
  if (g.type === 'Point') return [g.coordinates];
  if (g.type === 'LineString') return g.coordinates;
  return g.coordinates[0];
}
function anchor(g: TargetGeometry): [number, number] {
  const p = flat(g);
  return [p.reduce((s, c) => s + c[0], 0) / p.length, p.reduce((s, c) => s + c[1], 0) / p.length];
}

export type { Team };
