/**
 * Irish Transverse Mercator (EPSG:2157, ETRS89 / GRS80) forward and inverse, using the
 * Ordnance Survey series formulas (mm accuracy across the zone). ETRS89 and WGS84 agree to
 * well under a metre here, which is far below the terrain grid size.
 */
const a = 6378137;
const f = 1 / 298.257222101;
const b = a * (1 - f);
const F0 = 0.99982;
const lat0 = (53.5 * Math.PI) / 180;
const lon0 = (-8 * Math.PI) / 180;
const E0 = 600000;
const N0 = 750000;
const e2 = 1 - (b * b) / (a * a);
const n = (a - b) / (a + b);
const n2 = n * n, n3 = n2 * n;

function meridional(phi: number): number {
  const dp = phi - lat0, sp = phi + lat0;
  return b * F0 * ((1 + n + (5 / 4) * n2 + (5 / 4) * n3) * dp - (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(dp) * Math.cos(sp) + ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * dp) * Math.cos(2 * sp) - (35 / 24) * n3 * Math.sin(3 * dp) * Math.cos(3 * sp));
}

/** WGS84 lat/lon (degrees) → ITM easting/northing (metres). */
export function toItm(latDeg: number, lonDeg: number): [number, number] {
  const phi = (latDeg * Math.PI) / 180, lam = (lonDeg * Math.PI) / 180;
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi), t2 = t * t, t4 = t2 * t2;
  const nu = (a * F0) / Math.sqrt(1 - e2 * s * s);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * s * s, 1.5);
  const eta2 = nu / rho - 1;
  const M = meridional(phi);
  const I = M + N0;
  const II = (nu / 2) * s * c;
  const III = (nu / 24) * s * c ** 3 * (5 - t2 + 9 * eta2);
  const IIIA = (nu / 720) * s * c ** 5 * (61 - 58 * t2 + t4);
  const IV = nu * c;
  const V = (nu / 6) * c ** 3 * (nu / rho - t2);
  const VI = (nu / 120) * c ** 5 * (5 - 18 * t2 + t4 + 14 * eta2 - 58 * t2 * eta2);
  const dl = lam - lon0;
  const N = I + II * dl ** 2 + III * dl ** 4 + IIIA * dl ** 6;
  const E = E0 + IV * dl + V * dl ** 3 + VI * dl ** 5;
  return [E, N];
}

/** ITM easting/northing (metres) → WGS84 lat/lon (degrees). */
export function fromItm(E: number, N: number): [number, number] {
  let phi = lat0;
  let M = 0;
  for (let i = 0; i < 20; i++) {
    phi = (N - N0 - M) / (a * F0) + phi;
    M = meridional(phi);
    if (Math.abs(N - N0 - M) < 1e-5) break;
  }
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi), t2 = t * t, t4 = t2 * t2, t6 = t4 * t2;
  const nu = (a * F0) / Math.sqrt(1 - e2 * s * s);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * s * s, 1.5);
  const eta2 = nu / rho - 1;
  const sec = 1 / c;
  const VII = t / (2 * rho * nu);
  const VIII = (t / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (t / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4);
  const X = sec / nu;
  const XI = (sec / (6 * nu ** 3)) * (nu / rho + 2 * t2);
  const XII = (sec / (120 * nu ** 5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (sec / (5040 * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
  const dE = E - E0;
  const lat = phi - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lon = lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}
