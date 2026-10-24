import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const file = path.resolve(__dirname, '../../config.yaml');

describe('config loading', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('loads defaults', () => {
    const c = loadConfig(file);
    expect(c.station.lat).toBe(53.388);
    expect(c.providers.tideGauge.stationId).toBe('Howth Water Level 1');
    expect(c.callout.token).toBe('');
  });

  it('applies named and generic env overrides with type coercion', () => {
    process.env.CALLOUT_TOKEN = 'secret';
    process.env.AISSTREAM_API_KEY = 'k';
    process.env.PORT = '9090';
    process.env.CFG__providers__ais__enabled = 'false';
    process.env.CFG__providers__metWarnings__localRegionCodes = 'EI07,EI18';
    const c = loadConfig(file);
    expect(c.callout.token).toBe('secret');
    expect(c.providers.ais.apiKey).toBe('k');
    expect(c.server.port).toBe(9090);
    expect(c.providers.ais.enabled).toBe(false);
    expect(c.providers.metWarnings.localRegionCodes).toEqual(['EI07', 'EI18']);
  });
});
