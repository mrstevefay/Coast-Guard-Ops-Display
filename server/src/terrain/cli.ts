/**
 * Build the station terrain data from the command line (same job as Settings → Terrain):
 *
 *   npm run terrain:build                      # dev, from the repo root
 *   node server/dist/server/src/terrain/cli.js # production image
 *   … --refresh-osm / --refresh-lidar          # refetch instead of using the download cache
 */
import path from 'node:path';
import { loadConfig } from '../config.js';
import { buildTerrain, terrainConfig } from './build.js';

const cfg = loadConfig();
const dir = path.join(cfg.server.dataDir, 'terrain');
const args = new Set(process.argv.slice(2));
let last = '';
const t0 = Date.now();
buildTerrain(dir, terrainConfig(cfg.terrain), {
  refreshOsm: args.has('--refresh-osm'),
  refreshLidar: args.has('--refresh-lidar'),
  onProgress: (p) => {
    const line = p.log[p.log.length - 1];
    if (line && line !== last) { last = line; console.log(line); }
  },
})
  .then((meta) => {
    console.log(`terrain written to ${dir} in ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(meta.coverage)}`);
  })
  .catch((e) => {
    console.error(`terrain build failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
