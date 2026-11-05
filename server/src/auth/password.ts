import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt parameters: OWASP-recommended, ~60 ms on a 1 vCPU VPS. */
const N_LOG2 = 15, R = 8, P = 1, KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N: 2 ** N_LOG2, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N_LOG2}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nLog2, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: 2 ** Number(nLog2), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** URL-safe random token. 32 bytes → 43 chars. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Constant-time string compare (also used for the legacy CALLOUT_TOKEN check). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Human-typeable temporary password, e.g. "harbour-7391-tide". */
export function tempPassword(): string {
  const words = ['harbour', 'tide', 'baily', 'eye', 'sutton', 'lambay', 'kish', 'bull', 'nose', 'cliff', 'pier', 'sound', 'buoy', 'light', 'swell', 'reef'];
  const pick = () => words[randomBytes(1)[0] % words.length];
  const num = String(1000 + (randomBytes(2).readUInt16BE(0) % 9000));
  return `${pick()}-${num}-${pick()}`;
}
