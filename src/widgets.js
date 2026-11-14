// -----------------------------------------------------------------------------
// Dashboard widgets (declared in the manifest `widgets`, rendered by Gladys).
//
// Four widgets, fed by the live snapshot the poller keeps in memory
// (src/devices/inverter.js) and by the accumulated statistics (/data,
// src/stats.js):
//
//   - "huawei_overview": the live picture — production now (live tile +
//     gauge against the rated power), internal temperature and DC input
//     tiles, the last 7 days as bars, the inverter / grid status lines and
//     start / stop buttons;
//   - "huawei_day" / "huawei_month" / "huawei_year": the production of one
//     period (per hour / per day / per month), navigable with previous /
//     next / today buttons, with the equivalent previous-year period drawn
//     alongside (month and year widgets).
//
// Every text is a multi-language `{ en, fr }` object: Gladys picks the
// requesting user's language. The vocabulary carries no free HTML/CSS, so the
// "animation" is the core's own rendering: live tiles update with the poll,
// and the gauge/chart components are rendered (and transitioned) by the core.
//
// Navigation: the core offers no tabs, but a `button` can carry a widget
// ACTION (onWidgetAction). Our nav buttons shift an in-memory offset for the
// widget, then fire requestWidgetRefresh so every open instance re-pulls the
// content. The offset resets on container restart (back to "today") and is
// shared by every instance of the same widget key.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import {
  snapshot as statsSnapshot,
  dayTotal,
  monthTotal,
  yearTotal,
  hourlyFor,
  daysOfMonth,
  monthsOfYear,
  dataBounds,
  addDays,
  addMonths,
  dayDiff,
  localDate,
} from './stats.js';
import { getLiveSnapshot, featureExternalId } from './devices/inverter.js';

export const WIDGET_KEYS = {
  overview: 'huawei_overview',
  day: 'huawei_day',
  month: 'huawei_month',
  year: 'huawei_year',
};

const W = WIDGET_COLORS;

const pick = (language, text) => text[language] ?? text.en;

const MONTH_NAMES = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  fr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
};

const MONTH_NAMES_LONG = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};

const monthIndex = (monthKey) => (Number(monthKey.split('-')[1]) || 1) - 1;

function monthLabelLong(monthKey, language) {
  const names = MONTH_NAMES_LONG[language] ?? MONTH_NAMES_LONG.en;
  return `${names[monthIndex(monthKey)] ?? monthKey} ${monthKey.slice(0, 4)}`;
}

function dayLabel(dateKey, language) {
  const names = MONTH_NAMES[language] ?? MONTH_NAMES.en;
  const [, month, day] = dateKey.split('-').map(Number);
  if (language === 'fr') {
    return `${day} ${names[month - 1] ?? dateKey} ${dateKey.slice(0, 4)}`;
  }
  return `${names[month - 1] ?? dateKey} ${day}, ${dateKey.slice(0, 4)}`;
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

// --- Navigation state ----------------------------------------------------------
// One offset per widget key, in memory (back to "today" after a restart).
// Instances of the same widget key share the offset: acceptable — the
// core sends no instance identifier with onWidgetGet/onWidgetAction.

const periodOffset = new Map();

const offsetOf = (key) => periodOffset.get(key) ?? 0;

export function resetNavStateForTests() {
  periodOffset.clear();
}

/**
 * Clamp an offset to the data actually recorded.
 * @param {string} key widget key
 * @param {number} offset requested (<= 0)
 */
async function clampOffset(key, offset) {
  const bounds = await dataBounds();
  const today = localDate();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentYear = String(now.getFullYear());
  if (key === WIDGET_KEYS.day) {
    const min = bounds.firstDay ? -dayDiff(bounds.firstDay, today) : 0;
    return Math.min(0, Math.max(min, offset));
  }
  if (key === WIDGET_KEYS.month) {
    const min = bounds.firstMonth ? -monthDiff(bounds.firstMonth, currentMonth) : 0;
    return Math.min(0, Math.max(min, offset));
  }
  const min = bounds.firstYear ? Number(bounds.firstYear) - Number(currentYear) : 0;
  return Math.min(0, Math.max(min, offset));
}

/** Whole months between two YYYY-MM keys (b - a). */
function monthDiff(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return by * 12 + bm - (ay * 12 + am);
}

/**
 * Handle a navigation action of a period widget (buttons carry
 * `action: { key: 'nav', params: { dir } }` or `key: 'today'`). Shifts the
 * in-memory offset, nudges the core to re-render, and answers with a toast.
 */
async function handlePeriodAction(gladys, key, actionKey, params) {
  const dir = params?.dir === 1 ? 1 : -1;
  const requested = actionKey === 'today' ? 0 : offsetOf(key) + dir;
  const clamped = await clampOffset(key, requested);
  const blocked = clamped !== requested;
  periodOffset.set(key, clamped);
  try {
    gladys.requestWidgetRefresh(key);
  } catch {
    // The nudge is fire-and-forget: the TTL re-renders anyway.
  }
  if (actionKey === 'today') {
    return { en: 'Back to today', fr: 'Retour à aujourd\u2019hui' };
  }
  const forward = dir === 1;
  const moved = !blocked;
  const period = {
    [WIDGET_KEYS.day]: { en: 'day', fr: 'jour' },
    [WIDGET_KEYS.month]: { en: 'month', fr: 'mois' },
    [WIDGET_KEYS.year]: { en: 'year', fr: 'année' },
  }[key];
  if (!moved) {
    return {
      en: `No recorded data ${forward ? 'beyond' : 'before'} this period`,
      fr: `Pas de données enregistrées ${forward ? 'au-delà' : 'avant'} cette période`,
    };
  }
  const articleEn = forward ? 'next' : 'previous';
  const articleFr = forward ? 'suivant' : 'précédent';
  return {
    en: `Showing the ${articleEn} ${period.en}`,
    fr: `${period.fr.charAt(0).toUpperCase()}${period.fr.slice(1)} ${articleFr} affiché`,
  };
}

/**
 * The nav buttons of a period widget (≤ 4 buttons in the budget).
 * @param {{prev: object, next: object, today: object}} labels
 */
function navButtons(labels) {
  return [
    { type: 'button', label: labels.prev, icon: 'chevron-left', action: { key: 'nav', params: { dir: -1 } } },
    { type: 'button', label: labels.today, icon: 'rotate-ccw', action: { key: 'today' } },
    { type: 'button', label: labels.next, icon: 'chevron-right', action: { key: 'nav', params: { dir: 1 } } },
  ];
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
    if (live.dcPower !== null && Number.isFinite(live.dcPower)) {
      components.push({
        type: 'value',
        value: Math.round(live.dcPower),
        unit: 'W',
        label: { en: 'DC input', fr: 'Entrée DC' },
        icon: 'zap',
        color: W.INFO,
      });
    }
    if (live.temperature !== null && Number.isFinite(live.temperature)) {
      components.push({
        type: 'value',
        value: Math.round(live.temperature * 10) / 10,
        unit: '°C',
        label: { en: 'Internal temp.', fr: 'Température int.' },
        icon: 'thermometer',
        color: W.DANGER,
      });
    }
  }

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

  // Start / stop: the standard device-command path (the values come back
  // through onSetValue, like the running switch of the device). See the
  // docs warning before using the stop command on a real inverter.
  const running = featureExternalId(gladys, 'running');
  components.push(
    {
      type: 'button',
      label: { en: 'Start', fr: 'Démarrer' },
      icon: 'play',
      device_feature: running,
      value: 1,
    },
    {
      type: 'button',
      label: { en: 'Stop', fr: 'Arrêter' },
      icon: 'square',
      style: 'danger',
      device_feature: running,
      value: 0,
    },
  );

  return { ttl_seconds: 60, components };
}

// --- The three period widgets ---------------------------------------------------

/**
 * The "day" widget: the selected day per hour, navigable.
 */
export async function dayWidget(gladys, { language = 'en' } = {}) {
  const today = localDate();
  const offset = await clampOffset(WIDGET_KEYS.day, offsetOf(WIDGET_KEYS.day));
  periodOffset.set(WIDGET_KEYS.day, offset);
  const date = addDays(today, offset);

  const [total, hourly] = await Promise.all([dayTotal(date), hourlyFor(date)]);
  const components = [];

  if (total !== null) {
    components.push({
      type: 'value',
      value: round(total),
      unit: 'kWh',
      label: { en: 'Day total', fr: 'Total du jour' },
      icon: 'sun',
      color: W.SUCCESS,
    });
  }

  if (hourly) {
    components.push({
      type: 'chart',
      chart_type: 'bar',
      title: { en: dayLabel(date, 'en'), fr: dayLabel(date, 'fr') },
      unit: 'kWh',
      series: [
        {
          name: { en: 'Hourly production', fr: 'Production horaire' },
          points: hourly.map((kwh, hour) => ({
            t: `${date}T${String(hour).padStart(2, '0')}:00:00`,
            v: round(kwh),
          })),
        },
      ],
    });
  } else {
    components.push({
      type: 'text',
      variant: 'caption',
      text: {
        en: `No hourly detail recorded for ${dayLabel(date, 'en')} (recording started with this version).`,
        fr: `Pas de détail horaire enregistré pour le ${dayLabel(date, 'fr')} (l'enregistrement a commencé avec cette version).`,
      },
    });
  }

  components.push(...navButtons({
    prev: { en: 'Previous day', fr: 'Jour précédent' },
    today: { en: 'Today', fr: 'Aujourd\u2019hui' },
    next: { en: 'Next day', fr: 'Jour suivant' },
  }));
  return { ttl_seconds: 60, components };
}

/**
 * The "month" widget: the selected month per day, with the same month of the
 * previous year drawn alongside, navigable.
 */
export async function monthWidget(gladys, { language = 'en' } = {}) {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const offset = await clampOffset(WIDGET_KEYS.month, offsetOf(WIDGET_KEYS.month));
  periodOffset.set(WIDGET_KEYS.month, offset);
  const month = addMonths(currentMonth, offset);
  const previousYearMonth = addMonths(month, -12);

  const [total, days, previousYearDays] = await Promise.all([
    monthTotal(month),
    daysOfMonth(month),
    daysOfMonth(previousYearMonth),
  ]);
  const components = [];

  if (total !== null) {
    components.push({
      type: 'value',
      value: round(total),
      unit: 'kWh',
      label: { en: 'Month total', fr: 'Total du mois' },
      icon: 'calendar',
      color: W.SUCCESS,
    });
  }

  if (days.length > 0) {
    // The previous-year twin is drawn ON THE SAME AXIS POSITIONS (same day
    // numbers): two clusters one year apart would leave a year of empty
    // axis between them.
    const sameAxis = (entry) => ({ t: `${month}-${entry.date.slice(8)}`, v: round(entry.kwh) });
    const series = [dailySeries(days)];
    if (previousYearDays.length > 0) {
      series.push({
        name: { en: `${monthLabelLong(previousYearMonth, 'en')} (previous year)`, fr: `${monthLabelLong(previousYearMonth, 'fr')} (année précédente)` },
        points: previousYearDays.map(sameAxis),
      });
    }
    components.push({
      type: 'chart',
      chart_type: 'bar',
      title: { en: monthLabelLong(month, 'en'), fr: monthLabelLong(month, 'fr') },
      unit: 'kWh',
      series,
    });
  } else {
    components.push({
      type: 'text',
      variant: 'caption',
      text: {
        en: `No production recorded for ${monthLabelLong(month, 'en')} yet.`,
        fr: `Aucune production enregistrée pour ${monthLabelLong(month, 'fr')} pour l'instant.`,
      },
    });
  }

  // The months of the running year as a compact list: the comparison the
  // user reads at a glance without navigating.
  const yearMonths = await monthsOfYear(month.slice(0, 4));
  if (yearMonths.length > 0) {
    components.push({
      type: 'status',
      items: yearMonths.map((entry) => ({
        label: { en: monthLabelLong(entry.month, 'en'), fr: monthLabelLong(entry.month, 'fr') },
        value: round(entry.kwh),
        color: W.SUCCESS,
      })),
    });
  }

  components.push(...navButtons({
    prev: { en: 'Previous month', fr: 'Mois précédent' },
    today: { en: 'This month', fr: 'Ce mois' },
    next: { en: 'Next month', fr: 'Mois suivant' },
  }));
  return { ttl_seconds: 60, components };
}

/**
 * The "year" widget: the selected year per month, with the previous year
 * drawn alongside, navigable.
 */
export async function yearWidget(gladys, { language = 'en' } = {}) {
  const now = new Date();
  const currentYear = String(now.getFullYear());
  const offset = await clampOffset(WIDGET_KEYS.year, offsetOf(WIDGET_KEYS.year));
  periodOffset.set(WIDGET_KEYS.year, offset);
  const year = String(Number(currentYear) + offset);
  const previousYear = String(Number(year) - 1);

  const [total, months, previousYearMonths] = await Promise.all([
    yearTotal(year),
    monthsOfYear(year),
    monthsOfYear(previousYear),
  ]);
  const components = [];

  if (total !== null) {
    components.push({
      type: 'value',
      value: round(total),
      unit: 'kWh',
      label: { en: 'Year total', fr: "Total de l'année" },
      icon: 'calendar',
      color: W.SUCCESS,
    });
  }

  if (months.length > 0) {
    // Month points carry a full ISO date; the previous-year twin sits on the
    // SAME month positions (a year-apart cluster would leave a year of
    // empty axis between the two series).
    const series = [
      {
        name: { en: 'Monthly production', fr: 'Production mensuelle' },
        points: months.map((entry) => ({ t: `${entry.month}-01`, v: round(entry.kwh) })),
      },
    ];
    if (previousYearMonths.length > 0) {
      series.push({
        name: { en: `${previousYear} (previous year)`, fr: `${previousYear} (année précédente)` },
        points: previousYearMonths.map((entry) => ({ t: `${year}-${entry.month.slice(5)}-01`, v: round(entry.kwh) })),
      });
    }
    components.push({
      type: 'chart',
      chart_type: 'bar',
      title: { en: year, fr: year },
      unit: 'kWh',
      series,
    });
  } else {
    components.push({
      type: 'text',
      variant: 'caption',
      text: {
        en: `No production recorded for ${year} yet.`,
        fr: `Aucune production enregistrée pour ${year} pour l'instant.`,
      },
    });
  }

  components.push(...navButtons({
    prev: { en: 'Previous year', fr: 'Année précédente' },
    today: { en: 'This year', fr: 'Cette année' },
    next: { en: 'Next year', fr: 'Année suivante' },
  }));
  return { ttl_seconds: 60, components };
}

/**
 * Dispatch a period widget by key.
 */
export function periodWidget(gladys, key, options = {}) {
  if (key === WIDGET_KEYS.day) {
    return dayWidget(gladys, options);
  }
  if (key === WIDGET_KEYS.month) {
    return monthWidget(gladys, options);
  }
  return yearWidget(gladys, options);
}

/**
 * Register the widgets of the integration.
 * @param {object} gladys SDK instance
 */
export function registerWidgets(gladys) {
  gladys.onWidgetGet(WIDGET_KEYS.overview, (options) => overviewWidget(gladys, options ?? {}));
  for (const key of [WIDGET_KEYS.day, WIDGET_KEYS.month, WIDGET_KEYS.year]) {
    gladys.onWidgetGet(key, (options) => periodWidget(gladys, key, options ?? {}));
    gladys.onWidgetAction(key, (actionKey, params) => handlePeriodAction(gladys, key, actionKey, params));
  }
}
