// -----------------------------------------------------------------------------
// Dashboard widgets (declared in the manifest `widgets`, rendered by Gladys).
//
// Two widgets, both fed by the live snapshot the poller keeps in memory
// (src/devices/inverter.js) and by the accumulated statistics (/data,
// src/stats.js):
//
//   - "huawei_overview": the live picture — production now (live tile +
//     gauge against the rated power), today / month / year tiles, the last
//     7 days as bars, and the inverter / grid status lines;
//   - "huawei_production": the statistics view — the same three totals, the
//     last 30 days as bars, and the months of the running year.
//
// Every text is a multi-language `{ en, fr }` object: Gladys picks the
// requesting user's language. The vocabulary carries no free HTML/CSS, so the
// "animation" is the core's own rendering: live tiles update with the poll,
// and the gauge/chart components are rendered (and transitioned) by the core.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { snapshot as statsSnapshot } from './stats.js';
import { getLiveSnapshot, featureExternalId } from './devices/inverter.js';

export const WIDGET_KEYS = {
  overview: 'huawei_overview',
  production: 'huawei_production',
};

const W = WIDGET_COLORS;

const pick = (language, text) => text[language] ?? text.en;

const MONTH_NAMES = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  fr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
};

function monthLabel(monthKey, language) {
  const [, month] = monthKey.split('-').map(Number);
  const names = MONTH_NAMES[language] ?? MONTH_NAMES.en;
  return names[(month ?? 1) - 1] ?? monthKey;
}

const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Bar series from closed-day entries [{ date, kwh }] (t = ISO date). */
function dailySeries(entries) {
  return {
    name: { en: 'Daily production', fr: 'Production quotidienne' },
    points: entries.map((entry) => ({ t: entry.date, v: round(entry.kwh) })),
  };
}

const GRID_EXCHANGE_TEXT = {
  exporting: (kW) => ({ en: `Exporting ${kW} kW`, fr: `Injection ${kW} kW` }),
  importing: (kW) => ({ en: `Importing ${kW} kW`, fr: `Soutirage ${kW} kW` }),
  balanced: { en: 'Balanced', fr: 'Équilibré' },
  noMeter: { en: 'No meter', fr: 'Pas de compteur' },
};

const STATUS_COLORS = {
  on_grid: W.SUCCESS,
  on_grid_derating: W.SUCCESS,
  starting: W.INFO,
  standby: W.INFO,
  off_grid: W.WARNING,
  shutdown: W.DANGER,
  grid_scheduling: W.INFO,
  spot_check: W.WARNING,
  unknown: W.NEUTRAL,
};

function statusText(language, status) {
  const labels = {
    en: {
      standby: 'Standby', starting: 'Starting', on_grid: 'On grid',
      on_grid_derating: 'On grid (limited)', off_grid: 'Off grid', shutdown: 'Shutdown',
      grid_scheduling: 'Grid scheduling', spot_check: 'Spot check', unknown: 'Unknown',
    },
    fr: {
      standby: 'Veille', starting: 'Démarrage', on_grid: 'Connecté au réseau',
      on_grid_derating: 'Connecté (limité)', off_grid: 'Hors réseau', shutdown: 'Arrêté',
      grid_scheduling: 'Planification réseau', spot_check: 'Diagnostic', unknown: 'Inconnu',
    },
  };
  const table = labels[language] ?? labels.en;
  return table[status] ?? status ?? '—';
}

/**
 * The live overview widget.
 * @param {object} gladys SDK instance (external ids)
 * @param {{ language: string }} options from onWidgetGet
 */
export async function overviewWidget(gladys, { language = 'en' } = {}) {
  const stats = await statsSnapshot();
  const live = getLiveSnapshot();
  const components = [];

  if (live) {
    // A live tile follows the published states by itself: it animates at
    // every poll without any widget refresh.
    components.push({
      type: 'value',
      device_feature: featureExternalId(gladys, 'power_ac'),
      label: { en: 'Producing now', fr: 'Production actuelle' },
      icon: 'sun',
      color: W.WARNING,
    });
    const rated = live.ratedPower && live.ratedPower > 0 ? live.ratedPower : 10000;
    components.push({
      type: 'gauge',
      value: Math.max(0, live.acPower ?? 0),
      min: 0,
      max: rated,
      unit: 'W',
      label: { en: 'vs rated power', fr: 'vs puissance nominale' },
      color: W.PRIMARY,
    });
  }

  components.push(
    {
      type: 'value',
      value: round(stats.today),
      unit: 'kWh',
      label: { en: 'Today', fr: 'Aujourd\u2019hui' },
      icon: 'sunrise',
      color: W.SUCCESS,
    },
    {
      type: 'value',
      value: round(stats.month),
      unit: 'kWh',
      label: { en: 'This month', fr: 'Ce mois' },
      icon: 'calendar',
      color: W.SUCCESS,
    },
    {
      type: 'value',
      value: round(stats.year),
      unit: 'kWh',
      label: { en: 'This year', fr: 'Cette année' },
      icon: 'calendar',
      color: W.SUCCESS,
    },
  );

  if (stats.days.length >= 2) {
    components.push({
      type: 'chart',
      chart_type: 'bar',
      title: { en: 'Last 7 days', fr: '7 derniers jours' },
      unit: 'kWh',
      series: [dailySeries(stats.days.slice(-7))],
    });
  }

  const statusItems = [
    {
      label: { en: 'Inverter', fr: 'Onduleur' },
      value: statusText(language, live?.status),
      color: STATUS_COLORS[live?.status] ?? W.NEUTRAL,
    },
  ];
  if (live && live.meterPower !== null && Number.isFinite(live.meterPower)) {
    const kW = round(Math.abs(live.meterPower) / 1000, 1);
    const exchange =
      Math.abs(live.meterPower) < 50
        ? GRID_EXCHANGE_TEXT.balanced
        : live.meterPower < 0
          ? GRID_EXCHANGE_TEXT.exporting(kW)
          : GRID_EXCHANGE_TEXT.importing(kW);
    statusItems.push({
      label: { en: 'Grid', fr: 'Réseau' },
      value: pick(language, exchange),
      color: live.meterPower < 0 ? W.PRIMARY : W.INFO,
    });
  } else {
    statusItems.push({
      label: { en: 'Grid', fr: 'Réseau' },
      value: pick(language, GRID_EXCHANGE_TEXT.noMeter),
      color: W.NEUTRAL,
    });
  }
  components.push({ type: 'status', items: statusItems });

  return { ttl_seconds: 60, components };
}

/**
 * The production statistics widget.
 */
export async function productionWidget(gladys, { language = 'en' } = {}) {
  const stats = await statsSnapshot();
  const live = getLiveSnapshot();
  const components = [];

  components.push(
    {
      type: 'value',
      value: round(stats.today),
      unit: 'kWh',
      label: { en: 'Today', fr: 'Aujourd\u2019hui' },
      icon: 'sunrise',
      color: W.SUCCESS,
    },
    {
      type: 'value',
      value: round(stats.month),
      unit: 'kWh',
      label: { en: 'This month', fr: 'Ce mois' },
      icon: 'calendar',
      color: W.SUCCESS,
    },
    {
      type: 'value',
      value: round(stats.year),
      unit: 'kWh',
      label: { en: 'This year', fr: 'Cette année' },
      icon: 'calendar',
      color: W.SUCCESS,
    },
  );

  if (live && live.totalKwh !== null && Number.isFinite(live.totalKwh)) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: {
        en: `Since commissioning (inverter counter): ${round(live.totalKwh)} kWh`,
        fr: `Depuis la mise en service (compteur onduleur) : ${round(live.totalKwh)} kWh`,
      },
    });
  }

  if (stats.days.length >= 2) {
    components.push({
      type: 'chart',
      chart_type: 'bar',
      title: { en: 'Last 30 days', fr: '30 derniers jours' },
      unit: 'kWh',
      series: [dailySeries(stats.days)],
    });
  }

  if (stats.months.length > 0) {
    components.push({
      type: 'status',
      items: stats.months.map((entry) => ({
        label: { en: monthLabel(entry.month, 'en'), fr: monthLabel(entry.month, 'fr') },
        value: round(entry.kwh),
        icon: 'calendar',
        color: W.SUCCESS,
      })),
    });
  }

  return { ttl_seconds: 60, components };
}

/**
 * Register the widgets of the integration.
 * @param {object} gladys SDK instance
 */
export function registerWidgets(gladys) {
  gladys.onWidgetGet(WIDGET_KEYS.overview, (options) => overviewWidget(gladys, options ?? {}));
  gladys.onWidgetGet(WIDGET_KEYS.production, (options) => productionWidget(gladys, options ?? {}));
}
