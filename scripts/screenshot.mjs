// Renders both display modes at 1920x1080 with Playwright.
// Usage: BASE_URL=http://localhost:8080 CALLOUT_TOKEN=... node scripts/screenshot.mjs
// Needs `playwright` resolvable (npm i -D playwright && npx playwright install chromium).
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(require.resolve('playwright', { paths: [process.cwd(), '/usr/lib/node_modules', '/usr/local/lib/node_modules'] })));
}

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const TOKEN = process.env.CALLOUT_TOKEN ?? '';
const OUT = process.env.OUT_DIR ?? 'docs/screenshots';
fs.mkdirSync(OUT, { recursive: true });

const api = (path, body) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body ?? {}) });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));

async function shot(name) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.panel');
  await page.waitForTimeout(5000); // tiles + first state push
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('wrote', `${OUT}/${name}.png`);
}

await api('/api/standdown').catch(() => {});
await shot('standby');

const r = await api('/api/callout', {
  text: "PAGER: MRCC Dublin requests Howth CG — kayaker in difficulty NE of Ireland's Eye, 2 POB, one in water. Launch D-class, muster at station.",
  lat: 53.4105,
  lon: -6.055,
  source: 'screenshot',
});
if (!r.ok) console.error('callout failed', r.status, await r.text());
await shot('callout');
await api('/api/standdown').catch(() => {});
await browser.close();
