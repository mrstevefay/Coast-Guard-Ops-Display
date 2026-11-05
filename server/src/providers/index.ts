import type { AppConfig } from '../config.js';
import { aisProvider } from './ais.js';
import { dublinBayBuoyProvider } from './dublinBayBuoy.js';
import { metForecastProvider } from './metForecast.js';
import { metObservationsProvider } from './metObservations.js';
import { metWarningsProvider } from './metWarnings.js';
import { musterProvider } from './muster.js';
import { sunMoonProvider } from './sunMoon.js';
import { tideGaugeProvider } from './tideGauge.js';
import { tidePredictionProvider } from './tidePrediction.js';
import type { Provider } from './types.js';
import { waveModelProvider } from './waveModel.js';
import { weatherBuoyProvider } from './weatherBuoy.js';
import { webcamProvider } from './webcam.js';

/** Registry. To add a source: write a Provider, append it here. */
export function buildProviders(cfg: AppConfig): Provider[] {
  return [
    sunMoonProvider(cfg),
    metForecastProvider(cfg),
    metObservationsProvider(cfg),
    metWarningsProvider(cfg),
    tidePredictionProvider(cfg),
    tideGaugeProvider(cfg),
    waveModelProvider(cfg),
    dublinBayBuoyProvider(cfg),
    weatherBuoyProvider(cfg),
    aisProvider(cfg),
    webcamProvider(cfg),
    musterProvider(cfg),
  ];
}
