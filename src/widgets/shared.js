// -----------------------------------------------------------------------------
// Shared helpers of the dashboard widgets. Kept in one place so the three
// widget files (overview, production, lines) stay readable and never drift
// apart on a label or a color.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

export const W = WIDGET_COLORS;

export const pick = (language, text) => text[language] ?? text.en;

export const MONTH_NAMES = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  fr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
};

export const MONTH_NAMES_LONG = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};

export const monthIndex = (monthKey) => (Number(monthKey.split('-')[1]) || 1) - 1;

export const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const GRID_EXCHANGE_TEXT = {
  exporting: (kW) => ({ en: `Exporting ${kW} kW`, fr: `Injection ${kW} kW` }),
  importing: (kW) => ({ en: `Importing ${kW} kW`, fr: `Soutirage ${kW} kW` }),
  balanced: { en: 'Balanced', fr: 'Équilibré' },
  noMeter: { en: 'No meter', fr: 'Pas de compteur' },
};

export const STATUS_COLORS = {
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

export function statusText(language, status) {
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

export function monthLabelLong(monthKey, language) {
  const names = MONTH_NAMES_LONG[language] ?? MONTH_NAMES_LONG.en;
  return `${names[monthIndex(monthKey)] ?? monthKey} ${monthKey.slice(0, 4)}`;
}

export function dayLabel(dateKey, language) {
  const names = MONTH_NAMES[language] ?? MONTH_NAMES.en;
  const [, month, day] = dateKey.split('-').map(Number);
  if (language === 'fr') {
    return `${day} ${names[month - 1] ?? dateKey} ${dateKey.slice(0, 4)}`;
  }
  return `${names[month - 1] ?? dateKey} ${day}, ${dateKey.slice(0, 4)}`;
}

/** Bar series from closed-day entries [{ date, kwh }] (t = ISO date). */
export function dailySeries(entries, name) {
  return {
    name: name ?? { en: 'Daily production', fr: 'Production quotidienne' },
    points: entries.map((entry) => ({ t: entry.date, v: round(entry.kwh) })),
  };
}

// Widget keys: the manifest declares these exact keys (see
// gladys-assistant-integration.json). Kept here to avoid a circular import
// with index.js (which imports the widget modules).
export const WIDGET_KEYS = {
  overview: 'huawei_overview',
  production: 'huawei_production',
  lines: 'huawei_lines',
};
