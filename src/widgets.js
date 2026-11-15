// -----------------------------------------------------------------------------
// Dashboard widgets (declared in the manifest `widgets`, rendered by Gladys).
//
// Three widgets, fed by the live snapshot the poller keeps in memory
// (src/devices/inverter.js) and by the accumulated statistics (/data,
// src/stats.js):
//
//   - "huawei_overview": the live picture — production now (live tile +
//     gauge against the rated power), internal temperature and DC input
//     tiles, the last 7 days as bars, the inverter / grid status lines and
//     start / stop buttons;
//   - "huawei_production": ONE widget with tab-like buttons (Day / Month /
//     Year) switching the single chart — Gladys offers no tabs inside a
//     widget and only one focal component, so the views share the chart slot;
//   - "huawei_strings": the PV rows — live per-string power tiles and the
//     estimated energy per row over the last days.
//
// Every text is a multi-language `{ en, fr }` object: Gladys picks the
// requesting user's language. The vocabulary carries no free HTML/CSS, so the
// "animation" is the core's own rendering: live tiles update with the poll,
// and the gauge/chart components are rendered (and transitioned) by the core.
//
// Navigation: a `button` can carry a widget ACTION (onWidgetAction). The nav
// buttons shift an in-memory offset for the current view, then fire
// requestWidgetRefresh so every open instance re-pulls the content. The
// offset resets on container restart (back to "today") and is shared by
// every instance of the widget key.
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
  stringsOfDay,
  stringsHourly,
  dataBounds,
  addDays,
  addMonths,
  dayDiff,
  localDate,
} from './stats.js';
import { getLiveSnapshot, featureExternalId } from './devices/inverter.js';

export const WIDGET_KEYS = {
  overview: 'huawei_overview',
  production: 'huawei_production',
  strings: 'huawei_strings',
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
function dailySeries(entries, name) {
  return {
    name: name ?? { en: 'Daily production', fr: 'Production quotidienne' },
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
// The production widget's view (day / month / year) and one period offset per
// view, in memory (back to "today" after a restart). Instances of the widget
// key share the state: the core sends no instance identifier with
// onWidgetGet/onWidgetAction.

const VIEWS = ['day', 'month', 'year'];
let productionView = 'day';
const periodOffset = new Map();

const offsetKey = (view) => `production:${view}`;
const offsetOf = (view) => periodOffset.get(offsetKey(view)) ?? 0;

export function resetNavStateForTests() {
  periodOffset.clear();
  productionView = 'day';
  stringsView = 'hourly';
  stringsDayOffset = 0;
}

/** Whole months between two YYYY-MM keys (b - a). */
function monthDiff(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return by * 12 + bm - (ay * 12 + am);
}

/**
 * Clamp a period offset (<= 0) to the data actually recorded.
 * @param {string} view 'day' | 'month' | 'year'
 * @param {number} offset requested
 */
async function clampOffset(view, offset) {
  const bounds = await dataBounds();
  const today = localDate();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentYear = String(now.getFullYear());
  if (view === 'day') {
    const min = bounds.firstDay ? -dayDiff(bounds.firstDay, today) : 0;
    return Math.min(0, Math.max(min, offset));
  }
  if (view === 'month') {
    const min = bounds.firstMonth ? -monthDiff(bounds.firstMonth, currentMonth) : 0;
    return Math.min(0, Math.max(min, offset));
  }
  const min = bounds.firstYear ? Number(bounds.firstYear) - Number(currentYear) : 0;
  return Math.min(0, Math.max(min, offset));
}

// --- The overview widget --------------------------------------------------------

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
    // Energy counters as live tiles: published at every poll, they animate
    // through the real-time path without waiting for the widget TTL.
    components.push({
      type: 'value',
      device_feature: featureExternalId(gladys, 'daily_yield'),
      label: { en: 'Today', fr: 'Aujourd\u2019hui' },
      icon: 'sunrise',
      color: W.SUCCESS,
    });
    components.push({
      type: 'value',
      device_feature: featureExternalId(gladys, 'total_yield'),
      label: { en: 'Total yield', fr: 'Production totale' },
      icon: 'trending-up',
      color: W.SUCCESS,
    });
    // Efficiency and grid voltage only exist while the registers carry them
    // (efficiency reads 0 at night): a tile with no data is not sent.
    if (live.efficiency !== null && Number.isFinite(live.efficiency)) {
      components.push({
        type: 'value',
        value: Math.round(live.efficiency * 10) / 10,
        unit: '%',
        label: { en: 'Efficiency', fr: 'Rendement' },
        icon: 'percent',
        color: W.INFO,
      });
    }
    if (live.gridVoltage !== null && Number.isFinite(live.gridVoltage)) {
      components.push({
        type: 'value',
        value: Math.round(live.gridVoltage * 10) / 10,
        unit: 'V',
        label: { en: 'Grid voltage', fr: 'Tension réseau' },
        icon: 'activity',
        color: W.PRIMARY,
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

  // No on/off buttons here: they were confusing (a pill that cannot show
  // the inverter state). The state lives in the status line above, and the
  // on/off control stays on the device page (and in scenes) where its
  // current state is visible.
  return { ttl_seconds: 60, components };
}

// --- The production widget (one widget, tab-like views) --------------------------

/** Tab labels of the views (also the "switch view" buttons). */
const VIEW_TABS = {
  day: { en: 'Day', fr: 'Jour' },
  month: { en: 'Month', fr: 'Mois' },
  year: { en: 'Year', fr: 'Année' },
};

function viewButtons(currentView) {
  // Each button carries its OWN action key: the core drops buttons sharing
  // an action key within one content ("duplicate action key") — that is what
  // made the tab row disappear.
  return VIEWS.map((view) => ({
    type: 'button',
    label: VIEW_TABS[view],
    icon: view === 'day' ? 'sunrise' : view === 'month' ? 'calendar' : 'bar-chart-2',
    style: view === currentView ? 'primary' : 'secondary',
    action: { key: `view_${view}` },
  }));
}

/**
 * Handle the production widget actions: `view_<name>` (switch tab, resets
 * the period) and `nav` (previous period of the current view). Shifts the
 * in-memory state, nudges the core to re-render, answers with a toast.
 */
async function handleProductionAction(actionKey, params) {
  const requestedView = actionKey.startsWith('view_') ? actionKey.slice('view_'.length) : null;
  if (requestedView !== null && VIEWS.includes(requestedView)) {
    productionView = requestedView;
    periodOffset.set(offsetKey(productionView), 0);
    return finishAction('view');
  }
  // 'nav': one period back in the current view.
  const requested = offsetOf(productionView) - 1;
  const clamped = await clampOffset(productionView, requested);
  const blocked = clamped !== requested;
  periodOffset.set(offsetKey(productionView), clamped);
  return finishAction(blocked ? 'blocked' : 'nav');
}

function finishAction(kind) {
  try {
    // The nudge is fire-and-forget: the TTL re-renders anyway.
    globalRefresh?.();
  } catch {
    /* fire-and-forget */
  }
  const viewLabels = {
    day: { en: 'day', fr: 'jour' },
    month: { en: 'month', fr: 'mois' },
    year: { en: 'year', fr: 'année' },
  }[productionView];
  if (kind === 'view') {
    return {
      en: `Showing the ${viewLabels.en} view`,
      fr: `Vue ${viewLabels.fr} affichée`,
    };
  }
  if (kind === 'blocked') {
    return {
      en: 'No recorded data before this period',
      fr: 'Pas de données enregistrées avant cette période',
    };
  }
  return {
    en: `Showing the previous ${viewLabels.en}`,
    fr: `${viewLabels.fr.charAt(0).toUpperCase()}${viewLabels.fr.slice(1)} précédent affiché`,
  };
}

// Set by registerWidgets: the refresh closure of the production widget key.
let globalRefresh = null;

/**
 * The production widget: total of the shown period, the chart of the current
 * view (hourly / per day / per month), the months list in month view, and
 * the tab-like buttons + previous period.
 */
export async function productionWidget(gladys, { language = 'en' } = {}) {
  const view = productionView;
  const offset = await clampOffset(view, offsetOf(view));
  periodOffset.set(offsetKey(view), offset);
  const now = new Date();
  const components = [];

  if (view === 'day') {
    const today = localDate();
    const date = addDays(today, offset);
    const [total, hourly] = await Promise.all([dayTotal(date), hourlyFor(date)]);
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
          en: `No hourly detail for ${dayLabel(date, 'en')}.`,
          fr: `Pas de détail horaire pour le ${dayLabel(date, 'fr')}.`,
        },
      });
    }
  } else if (view === 'month') {
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = addMonths(currentMonth, offset);
    const previousYearMonth = addMonths(month, -12);
    const [total, days, previousYearDays] = await Promise.all([
      monthTotal(month),
      daysOfMonth(month),
      daysOfMonth(previousYearMonth),
    ]);
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
          name: {
            en: `${monthLabelLong(previousYearMonth, 'en')} (previous year)`,
            fr: `${monthLabelLong(previousYearMonth, 'fr')} (année précédente)`,
          },
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
          en: `No production recorded for ${monthLabelLong(month, 'en')}.`,
          fr: `Aucune production pour ${monthLabelLong(month, 'fr')}.`,
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
  } else {
    const currentYear = String(now.getFullYear());
    const year = String(Number(currentYear) + offset);
    const previousYear = String(Number(year) - 1);
    const [total, months, previousYearMonths] = await Promise.all([
      yearTotal(year),
      monthsOfYear(year),
      monthsOfYear(previousYear),
    ]);
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
      // Month points carry a full ISO date; the previous-year twin sits on
      // the SAME month positions (a year-apart cluster would leave a year of
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
          en: `No production recorded for ${year}.`,
          fr: `Aucune production pour ${year}.`,
        },
      });
    }
  }

  // Tab-like buttons (switch view = also "back to the current period"), then
  // one step back in the current view. Gladys allows 4 buttons per content.
  components.push(
    ...viewButtons(view),
    {
      type: 'button',
      label: { en: 'Previous', fr: 'Précédent' },
      icon: 'chevron-left',
      action: { key: 'nav', params: { dir: -1 } },
    },
  );

  return { ttl_seconds: 60, components };
}

// --- The strings (PV rows) widget ------------------------------------------------

const STRING_VIEWS = ['hourly', 'week'];
let stringsView = 'hourly';
let stringsDayOffset = 0;

const STRING_TABS = {
  hourly: { en: 'Hour by hour', fr: 'Heure par heure' },
  week: { en: '7 days', fr: '7 jours' },
};

/**
 * Handle the strings widget actions: `view_hourly` / `view_week` (switch
 * view, back to today) and `nav` (one step back). Each button carries its
 * own action key — the core drops buttons sharing an action key.
 */
async function handleStringsAction(actionKey) {
  const requestedView = actionKey.startsWith('view_') ? actionKey.slice('view_'.length) : null;
  if (requestedView !== null && STRING_VIEWS.includes(requestedView)) {
    stringsView = requestedView;
    stringsDayOffset = 0;
    return finishStringsAction('view');
  }
  const step = stringsView === 'week' ? 7 : 1;
  const bounds = await dataBounds();
  const today = localDate();
  const min = bounds.firstDay ? -dayDiff(bounds.firstDay, today) : 0;
  const requested = stringsDayOffset - step;
  const clamped = Math.max(min, requested);
  stringsDayOffset = clamped;
  return finishStringsAction(clamped !== requested ? 'blocked' : 'nav');
}

function finishStringsAction(kind) {
  try {
    stringsRefresh?.();
  } catch {
    // fire-and-forget
  }
  if (kind === 'view') {
    return {
      en: `Showing the ${STRING_TABS[stringsView].en.toLowerCase()} view`,
      fr: `Vue ${STRING_TABS[stringsView].fr.toLowerCase()} affichée`,
    };
  }
  if (kind === 'blocked') {
    return { en: 'No recorded data before this period', fr: 'Pas de données enregistrées avant cette période' };
  }
  return { en: 'Showing the previous period', fr: 'Période précédente affichée' };
}

// Set by registerWidgets: the refresh closure of the strings widget key.
let stringsRefresh = null;

/**
 * The PV rows widget: live per-string power tiles (U x I as measured by the
 * inverter), then either the hourly detail of a day or the last 7 days of
 * estimated energy per row — switched by tab-like buttons.
 */
export async function stringsWidget(gladys, { language = 'en' } = {}) {
  const live = getLiveSnapshot();
  const components = [];

  // Live tiles for the strings the inverter actually reports (a row with no
  // data never appears).
  const rows = live?.stringPowers ? Object.keys(live.stringPowers).map(Number).sort((a, b) => a - b) : [];
  for (const row of rows.slice(0, 4)) {
    components.push({
      type: 'value',
      device_feature: featureExternalId(gladys, `pv${row}_power`),
      label: { en: `String ${row}`, fr: `Rangée ${row}` },
      icon: 'zap',
      color: row === 1 ? W.PRIMARY : W.INFO,
    });
  }

  const date = addDays(localDate(), stringsDayOffset);
  const seriesOf = (valuesFor) =>
    rows.slice(0, 4).map((row) => ({
      name: { en: `String ${row}`, fr: `Rangée ${row}` },
      points: valuesFor(row),
    }));
  const noRowsText = {
    type: 'text',
    variant: 'caption',
    text: {
      en: 'No per-string data yet (night or no string registers).',
      fr: 'Pas de données par rangée (nuit ou registres absents).',
    },
  };
  const caption = {
    type: 'text',
    variant: 'caption',
    text: {
      en: 'Estimated from measured power (U x I); offline gaps not counted.',
      fr: 'Estimé (U x I) à chaque relevé ; hors ligne non compté.',
    },
  };

  if (rows.length === 0) {
    components.push(noRowsText);
  } else if (stringsView === 'hourly') {
    // The hourly detail of the day: one series per row, 24 bars.
    const hourly = await stringsHourly(date);
    if (hourly) {
      components.push({
        type: 'chart',
        chart_type: 'bar',
        title: { en: dayLabel(date, 'en'), fr: dayLabel(date, 'fr') },
        unit: 'kWh',
        series: seriesOf((row) =>
          (hourly[String(row)] ?? new Array(24).fill(0)).map((kwh, hour) => ({
            t: `${date}T${String(hour).padStart(2, '0')}:00:00`,
            v: round(kwh),
          })),
        ),
      });
      components.push(caption);
    } else {
      components.push({
        type: 'text',
        variant: 'caption',
        text: {
          en: 'No hourly row data for this day.',
          fr: 'Pas de détail horaire par rangée.',
        },
      });
    }
  } else {
    // The last 7 days ending on the selected date.
    const dates = [];
    for (let back = 6; back >= 0; back -= 1) {
      dates.push(addDays(date, -back));
    }
    const perDay = await Promise.all(dates.map((day) => stringsOfDay(day)));
    const observed = perDay.filter((entry) => entry !== null);
    if (observed.length > 0) {
      components.push({
        type: 'chart',
        chart_type: 'bar',
        title: {
          en: `7 days to ${dayLabel(date, 'en')}`,
          fr: `7 jours jusqu'au ${dayLabel(date, 'fr')}`,
        },
        unit: 'kWh',
        series: seriesOf((row) =>
          dates.map((day, index) => ({ t: day, v: round(perDay[index]?.[String(row)] ?? 0) })),
        ),
      });
      components.push(caption);
    } else {
      components.push(noRowsText);
    }
  }

  // Tab-like buttons (unique action keys) + one step back.
  components.push(
    ...STRING_VIEWS.map((view) => ({
      type: 'button',
      label: STRING_TABS[view],
      icon: view === 'hourly' ? 'clock' : 'bar-chart-2',
      style: view === stringsView ? 'primary' : 'secondary',
      action: { key: `view_${view}` },
    })),
    {
      type: 'button',
      label: { en: 'Previous', fr: 'Précédent' },
      icon: 'chevron-left',
      action: { key: 'nav' },
    },
  );

  return { ttl_seconds: 60, components };
}

/**
 * Register the widgets of the integration.
 * @param {object} gladys SDK instance
 */
export function registerWidgets(gladys) {
  gladys.onWidgetGet(WIDGET_KEYS.overview, (options) => overviewWidget(gladys, options ?? {}));
  gladys.onWidgetGet(WIDGET_KEYS.production, (options) => productionWidget(gladys, options ?? {}));
  gladys.onWidgetGet(WIDGET_KEYS.strings, (options) => stringsWidget(gladys, options ?? {}));
  globalRefresh = () => gladys.requestWidgetRefresh(WIDGET_KEYS.production);
  stringsRefresh = () => gladys.requestWidgetRefresh(WIDGET_KEYS.strings);
  gladys.onWidgetAction(WIDGET_KEYS.production, (actionKey, params) =>
    handleProductionAction(actionKey, params),
  );
  gladys.onWidgetAction(WIDGET_KEYS.strings, (actionKey) => handleStringsAction(actionKey));
}
