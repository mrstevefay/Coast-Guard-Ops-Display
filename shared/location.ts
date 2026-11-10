/**
 * Parse a position typed or pasted by a search manager. Accepts the forms that arrive on a
 * callout: decimal degrees ("53.3905, -6.068", "53.3905N 6.068W"), degrees and decimal
 * minutes as used at sea ("53 23.43N 006 04.08W"), degrees-minutes-seconds
 * ("53°23'25.8\"N 6°04'04.8\"W"), Irish Transverse Mercator ("ITM 728900 739100", or any
 * six-digit pair with a northing over 500 000), and Irish Grid references from OSi maps
 * ("O 287 385", "O2870038500", or a numeric pair under 500 000). Eircodes need a licensed
 * lookup service and are not parsed.
 *
 * Shared by the console (instant feedback) and the server (validation).
 */

export type LocationKind = 'latlon' | 'itm' | 'irish-grid';
export interface ParsedLocation {
  lat: number;
  lon: number;
  kind: LocationKind;
  /** How the input was read, for the confirmation line: "53.3905, -6.0680" or "ITM 728900 739100". */
  read: string;
}

const RAD = Math.PI / 180;

interface Tm { a: number; b: number; F0: number; lat0: number; lon0: number; E0: number; N0: number }
/** Irish Transverse Mercator: GRS80, ETRS89 (equal to WGS84 to well under a metre). */
const ITM: Tm = { a: 6378137, b: 6378137 * (1 - 1 / 298.257222101), F0: 0.99982, lat0: 53.5, lon0: -8, E0: 600000, N0: 750000 };
/** Irish Grid: Airy Modified, Ireland 1965 / TM75 datum. */
const IG: Tm = { a: 6377340.189, b: 6356034.447, F0: 1.000035, lat0: 53.5, lon0: -8, E0: 200000, N0: 250000 };

function meridional(p: Tm, phi: number): number {
  const n = (p.a - p.b) / (p.a + p.b), n2 = n * n, n3 = n2 * n;
  const phi0 = p.lat0 * RAD, dp = phi - phi0, sp = phi + phi0;
  return p.b * p.F0 * ((1 + n + (5 / 4) * n2 + (5 / 4) * n3) * dp - (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(dp) * Math.cos(sp) + ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * dp) * Math.cos(2 * sp) - (35 / 24) * n3 * Math.sin(3 * dp) * Math.cos(3 * sp));
}

/** Easting/northing → latitude/longitude (radians) on the projection's own ellipsoid (OS series formulas). */
function inverseTm(p: Tm, E: number, N: number): [number, number] {
  const e2 = 1 - (p.b * p.b) / (p.a * p.a);
  let phi = p.lat0 * RAD, M = 0;
  for (let i = 0; i < 20; i++) {
    phi = (N - p.N0 - M) / (p.a * p.F0) + phi;
    M = meridional(p, phi);
    if (Math.abs(N - p.N0 - M) < 1e-5) break;
  }
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi), t2 = t * t, t4 = t2 * t2, t6 = t4 * t2;
  const nu = (p.a * p.F0) / Math.sqrt(1 - e2 * s * s);
  const rho = (p.a * p.F0 * (1 - e2)) / Math.pow(1 - e2 * s * s, 1.5);
  const eta2 = nu / rho - 1, sec = 1 / c;
  const VII = t / (2 * rho * nu);
  const VIII = (t / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (t / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4);
  const X = sec / nu;
  const XI = (sec / (6 * nu ** 3)) * (nu / rho + 2 * t2);
  const XII = (sec / (120 * nu ** 5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (sec / (5040 * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
  const dE = E - p.E0;
  return [phi - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6, p.lon0 * RAD + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7];
}

/**
 * Ireland 1965 (Airy Modified) → WGS84, seven-parameter Helmert (EPSG:1954 values, applied in the
 * position-vector convention, which matches PROJ). About 1 m across Ireland: far below what a typed grid reference resolves.
 */
function irishToWgs84(phi: number, lam: number): [number, number] {
  const toXyz = (a: number, b: number, ph: number, la: number): [number, number, number] => {
    const e2 = 1 - (b * b) / (a * a), nu = a / Math.sqrt(1 - e2 * Math.sin(ph) ** 2);
    return [nu * Math.cos(ph) * Math.cos(la), nu * Math.cos(ph) * Math.sin(la), nu * (1 - e2) * Math.sin(ph)];
  };
  const [x, y, z] = toXyz(IG.a, IG.b, phi, lam);
  const tx = 482.5, ty = -130.6, tz = 564.6, sec = RAD / 3600, rx = -1.042 * sec, ry = -0.214 * sec, rz = -0.631 * sec, s = 1 + 8.15e-6;
  const X = tx + s * (x - rz * y + ry * z), Y = ty + s * (rz * x + y - rx * z), Z = tz + s * (-ry * x + rx * y + z);
  const a = 6378137, b = a * (1 - 1 / 298.257223563), e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(X, Y);
  let ph = Math.atan2(Z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(ph) ** 2);
    ph = Math.atan2(Z + e2 * nu * Math.sin(ph), p);
  }
  return [ph / RAD, Math.atan2(Y, X) / RAD];
}

export function itmToLatLon(E: number, N: number): [number, number] {
  const [phi, lam] = inverseTm(ITM, E, N);
  return [phi / RAD, lam / RAD];
}

export function irishGridToLatLon(E: number, N: number): [number, number] {
  return irishToWgs84(...inverseTm(IG, E, N));
}

/** 100 km squares of the Irish Grid: A–Z without I, five columns, A in the north-west. */
const IG_LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

const inIreland = (lat: number, lon: number) => lat >= 51 && lat <= 56 && lon >= -11 && lon <= -5;
const f4 = (v: number) => v.toFixed(4);

/** One coordinate: "53.3905", "53 23.43", "53°23'25.8\"", with an optional N/S/E/W on either side. */
function parseAngle(raw: string): { v: number; hemi?: string } | undefined {
  let s = raw.trim().toUpperCase();
  let hemi: string | undefined;
  const lead = /^([NSEW])\s*/.exec(s);
  if (lead) { hemi = lead[1]; s = s.slice(lead[0].length); }
  const trail = /\s*([NSEW])$/.exec(s);
  if (trail) { hemi = trail[1]; s = s.slice(0, -trail[0].length); }
  const nums = s.replace(/[°º'′"″]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!nums.length || nums.length > 3 || nums.some((x) => !/^[-+]?\d+(\.\d+)?$/.test(x))) return undefined;
  const [d, m = '0', sec = '0'] = nums.map(String);
  const neg = d.startsWith('-');
  const v = Math.abs(Number(d)) + Number(m) / 60 + Number(sec) / 3600;
  if (Number(m) >= 60 || Number(sec) >= 60) return undefined;
  return { v: neg ? -v : v, hemi };
}

function parseLatLon(text: string): ParsedLocation | undefined {
  const t = text.trim();
  // split into two angles: on a comma or semicolon, else after the first hemisphere letter, else halfway through the numbers
  let parts = t.split(/\s*[,;]\s*/).filter(Boolean);
  if (parts.length !== 2) {
    const m = /^([NS].*?)\s+([EW].*)$/i.exec(t) ?? /^(.*?\d.*?[NS])\s*(.+)$/i.exec(t);
    if (m && m[2]) parts = [m[1], m[2]];
    else {
      const nums = t.split(/\s+/);
      if (nums.length % 2 !== 0 || nums.length > 6) return undefined;
      parts = [nums.slice(0, nums.length / 2).join(' '), nums.slice(nums.length / 2).join(' ')];
    }
  }
  if (parts.length !== 2) return undefined;
  const a = parseAngle(parts[0]), b = parseAngle(parts[1]);
  if (!a || !b) return undefined;
  let lat = a.v, lon = b.v;
  if (a.hemi === 'E' || a.hemi === 'W' || b.hemi === 'N' || b.hemi === 'S') { [lat, lon] = [b.v, a.v]; [a.hemi, b.hemi] = [b.hemi, a.hemi]; }
  const latH = a.hemi === 'E' || a.hemi === 'W' ? b.hemi : a.hemi;
  const lonH = a.hemi === 'E' || a.hemi === 'W' ? a.hemi : b.hemi;
  if (latH === 'S') lat = -Math.abs(lat);
  if (lonH === 'W') lon = -Math.abs(lon);
  if (lonH === 'E') lon = Math.abs(lon);
  // Ireland is west of Greenwich: a positive longitude without "E" was almost certainly meant as west
  if (!lonH && lon > 0 && inIreland(lat, -lon)) lon = -lon;
  // swapped pair ("-6.068, 53.39")
  if (!inIreland(lat, lon) && inIreland(lon, lat)) [lat, lon] = [lon, lat];
  if (!inIreland(lat, lon)) return undefined;
  return { lat, lon, kind: 'latlon', read: `${f4(lat)}, ${f4(lon)}` };
}

export function parseLocation(input: string): ParsedLocation | undefined {
  const text = input.trim();
  if (!text) return undefined;
  // Irish Grid letter reference: "O 287 385", "O2870038500", "O 28700 38500"
  const g = /^([A-HJ-Z])\s*(\d+)\s*(\d*)$/i.exec(text.replace(/\s+/g, (s, i) => (i === 1 ? ' ' : s)));
  if (g) {
    const letter = g[1].toUpperCase();
    let digits = g[2] + g[3];
    if (g[3] && g[2].length !== g[3].length) return undefined;
    if (digits.length % 2 !== 0 || digits.length < 2 || digits.length > 10) return undefined;
    const half = digits.length / 2, scale = 10 ** (5 - half);
    const idx = IG_LETTERS.indexOf(letter);
    const col = idx % 5, row = 4 - Math.floor(idx / 5);
    // the middle of the square the reference names, not its south-west corner
    const E = col * 100000 + Number(digits.slice(0, half)) * scale + scale / 2;
    const N = row * 100000 + Number(digits.slice(half)) * scale + scale / 2;
    const [lat, lon] = irishGridToLatLon(E, N);
    if (!inIreland(lat, lon)) return undefined;
    digits = `${digits.slice(0, half)} ${digits.slice(half)}`;
    return { lat, lon, kind: 'irish-grid', read: `Irish Grid ${letter} ${digits}` };
  }
  // numeric eastings and northings: ITM (northing ≥ 500 000) or Irish Grid
  const en = /^(?:(ITM|IG|IRISH GRID)\s*)?E?\s*(\d{5,6}(?:\.\d+)?)\s*[,\s]\s*N?\s*(\d{5,6}(?:\.\d+)?)$/i.exec(text);
  if (en) {
    const E = Number(en[2]), N = Number(en[3]);
    const label = en[1]?.toUpperCase();
    const itm = label === 'ITM' || (label === undefined && N >= 500000);
    const [lat, lon] = itm ? itmToLatLon(E, N) : irishGridToLatLon(E, N);
    if (!inIreland(lat, lon)) return undefined;
    return { lat, lon, kind: itm ? 'itm' : 'irish-grid', read: `${itm ? 'ITM' : 'Irish Grid'} ${Math.round(E)} ${Math.round(N)}` };
  }
  return parseLatLon(text);
}
