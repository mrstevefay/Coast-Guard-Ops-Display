import { describe, expect, it } from 'vitest';
import { irishGridToLatLon, parseLocation } from '../../shared/location.js';
import { toItm } from '../src/terrain/itm.js';

/** Metres between two WGS84 points (equirectangular is plenty at these distances). */
const metres = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));

// Reference values from PROJ (pyproj, EPSG:4326 → EPSG:29903).
const IG_REF: [string, number, number, number, number][] = [
  ['Spire', 53.34981, -6.26031, 315899.9, 234672.5],
  ['Howth summit', 53.3735, -6.0608, 329112.8, 237651.0],
  ['Skerries', 53.5825, -6.1083, 325334.3, 260824.0],
  ['Carrauntoohil', 51.9993, -9.7429, 80349.3, 84404.5],
];

describe('location parser', () => {
  it('converts Irish Grid to WGS84 within 3 m of PROJ', () => {
    for (const [name, lat, lon, e, n] of IG_REF) {
      expect(metres(irishGridToLatLon(e, n), [lat, lon]), name).toBeLessThan(3);
    }
  });

  it('reads Irish Grid letter references to the middle of the named square', () => {
    const r = parseLocation('O 15899 34672')!;
    expect(r.kind).toBe('irish-grid');
    expect(metres([r.lat, r.lon], [53.34981, -6.26031])).toBeLessThan(3);
    const six = parseLocation('o158346')!; // 100 m square
    expect(metres([six.lat, six.lon], [53.34981, -6.26031])).toBeLessThan(80);
    expect(six.read).toBe('Irish Grid O 158 346');
    expect(parseLocation('O 158 3467')).toBeUndefined(); // uneven halves
  });

  it('reads ITM and numeric Irish Grid pairs', () => {
    const [E, N] = toItm(53.3905, -6.068);
    const r = parseLocation(`ITM ${E.toFixed(0)} ${N.toFixed(0)}`)!;
    expect(r.kind).toBe('itm');
    expect(metres([r.lat, r.lon], [53.3905, -6.068])).toBeLessThan(1);
    expect(parseLocation(`${E.toFixed(0)}, ${N.toFixed(0)}`)!.kind).toBe('itm');
    const ig = parseLocation('329113 237651')!;
    expect(ig.kind).toBe('irish-grid');
    expect(metres([ig.lat, ig.lon], [53.3735, -6.0608])).toBeLessThan(3);
  });

  it('reads decimal degrees, degrees-minutes and DMS in the usual spellings', () => {
    const near = (s: string, lat: number, lon: number, tol = 5) => {
      const r = parseLocation(s);
      expect(r, s).toBeDefined();
      expect(metres([r!.lat, r!.lon], [lat, lon]), s).toBeLessThan(tol);
    };
    near('53.3905, -6.068', 53.3905, -6.068);
    near('53.3905 -6.068', 53.3905, -6.068);
    near('53.3905N 6.068W', 53.3905, -6.068);
    near('N53.3905 W6.068', 53.3905, -6.068);
    near('53.3905, 6.068', 53.3905, -6.068); // east longitude in Ireland means west was meant
    near('-6.068, 53.3905', 53.3905, -6.068); // swapped
    near('53 23.43N 006 04.08W', 53 + 23.43 / 60, -(6 + 4.08 / 60));
    near(`53°23'25.8"N 6°04'04.8"W`, 53 + 23 / 60 + 25.8 / 3600, -(6 + 4 / 60 + 4.8 / 3600));
  });

  it('rejects text that is not a position, and positions outside Ireland', () => {
    for (const s of ['', 'Summit car park', 'D13 X2Y4', '48.85, 2.35', '53.39', '12 13 14', '53 61N 6 04W']) expect(parseLocation(s), s).toBeUndefined();
  });
});
