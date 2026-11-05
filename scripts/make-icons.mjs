// Renders the PWA icons (192/512 PNG) from an inline SVG using the bundled Chromium.
// Usage: node scripts/make-icons.mjs   → web/m/icons/icon-192.png, icon-512.png
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="18" fill="#0b1016"/>
  <circle cx="50" cy="50" r="34" fill="none" stroke="#2dd4bf" stroke-width="7"/>
  <circle cx="50" cy="50" r="12" fill="#ef4444"/>
  <path d="M50 8 V22 M50 78 V92 M8 50 H22 M78 50 H92" stroke="#f3f6fa" stroke-width="6" stroke-linecap="round"/>
</svg>`;

fs.mkdirSync('web/m/icons', { recursive: true });
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  await page.screenshot({ path: `web/m/icons/icon-${size}.png`, omitBackground: true });
  console.log('wrote', `web/m/icons/icon-${size}.png`);
}
await browser.close();
