import SunCalc from 'suncalc';
import type { DashboardData, SunMoonState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { Provider } from './types.js';

const PHASES = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];

export function moonPhaseName(phase: number): string {
  // phase 0 = new, 0.5 = full
  const idx = Math.round(phase * 8) % 8;
  return PHASES[idx];
}

export function computeSunMoon(now: Date, lat: number, lon: number): SunMoonState {
  const today = SunCalc.getTimes(now, lat, lon);
  const tomorrow = SunCalc.getTimes(new Date(now.getTime() + 86400_000), lat, lon);
  const yesterday = SunCalc.getTimes(new Date(now.getTime() - 86400_000), lat, lon);
  // Choose the "current" solar day: the one whose dusk hasn't passed yet.
  const day = now < today.dusk ? today : tomorrow;
  const isDaylight = now >= today.sunrise && now < today.sunset;
  const dusk = now < today.dusk ? today.dusk : tomorrow.dusk;
  const nextSunrise = now < today.sunrise ? today.sunrise : tomorrow.sunrise;
  const daylightRemainingMin = now < today.dusk && now >= today.dawn ? Math.max(0, Math.round((today.dusk.getTime() - now.getTime()) / 60_000)) : 0;
  const untilSunriseMin = isDaylight ? undefined : Math.max(0, Math.round((nextSunrise.getTime() - now.getTime()) / 60_000));
  const illum = SunCalc.getMoonIllumination(now);
  void yesterday;
  return {
    date: now.toISOString().slice(0, 10),
    sunrise: day.sunrise.toISOString(),
    sunset: day.sunset.toISOString(),
    civilDawn: day.dawn.toISOString(),
    civilDusk: dusk.toISOString(),
    nauticalDusk: day.nauticalDusk.toISOString(),
    isDaylight,
    daylightRemainingMin,
    untilSunriseMin,
    nextSunrise: nextSunrise.toISOString(),
    moonPhase: Math.round(illum.phase * 1000) / 1000,
    moonPhaseName: moonPhaseName(illum.phase),
    moonIlluminationPct: Math.round(illum.fraction * 100),
  };
}

export function sunMoonProvider(cfg: AppConfig): Provider {
  const c = cfg.providers.sunMoon;
  return {
    name: 'sunMoon',
    pollIntervalMs: c.pollIntervalMs,
    enabled: c.enabled,
    kind: 'poll',
    async fetch(): Promise<Partial<DashboardData>> {
      return { sun: computeSunMoon(new Date(), cfg.station.lat, cfg.station.lon) };
    },
  };
}
