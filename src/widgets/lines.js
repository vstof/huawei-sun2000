// -----------------------------------------------------------------------------
// The PV lines widget: live per-row power tiles (U x I as measured by the
// inverter) and the estimated energy per row, with an hourly view of the
// selected day and a 7-day view.
// -----------------------------------------------------------------------------

import { W, dayLabel, round } from './shared.js';
import { WIDGET_KEYS } from './shared.js';
import { stringsOfDay, stringsHourly, dataBounds, dayDiff, addDays, localDate } from '../stats.js';
import { getLiveSnapshot, featureExternalId } from '../devices/inverter.js';

const STRING_VIEWS = ['hourly', 'week'];
let stringsView = 'hourly';
let stringsDayOffset = 0;

const STRING_TABS = {
  hourly: { en: 'Hour by hour', fr: 'Heure par heure' },
  week: { en: '7 days', fr: '7 jours' },
};

let stringsRefresh = null;

export function setStringsRefresh(fn) {
  stringsRefresh = fn;
}

/**
 * Handle the lines widget actions: `view_hourly` / `view_week` (switch
 * view, back to today) and `nav` (one step back). Each button carries its
 * own action key — the core drops buttons sharing an action key.
 */
export async function handleStringsAction(actionKey) {
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

export async function stringsWidget(gladys, { language = 'en' } = {}) {
  const live = getLiveSnapshot();
  const components = [];

  // Live tiles for the lines the inverter actually reports (a row with no
  // data never appears).
  const rows = live?.stringPowers ? Object.keys(live.stringPowers).map(Number).sort((a, b) => a - b) : [];
  for (const row of rows.slice(0, 4)) {
    components.push({
      type: 'value',
      device_feature: featureExternalId(gladys, `pv${row}_power`),
      label: { en: `Line ${row}`, fr: `Ligne ${row}` },
      icon: 'zap',
      color: row === 1 ? W.PRIMARY : W.INFO,
    });
  }

  const date = addDays(localDate(), stringsDayOffset);
  const seriesOf = (valuesFor) =>
    rows.slice(0, 4).map((row) => ({
      name: { en: `Line ${row}`, fr: `Ligne ${row}` },
      points: valuesFor(row),
    }));
  const noRowsText = {
    type: 'text',
    variant: 'caption',
    text: {
      en: 'No per-line data yet (night or no line registers).',
      fr: 'Pas de données par ligne (nuit ou registres absents).',
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
          en: 'No hourly line data for this day.',
          fr: 'Pas de détail horaire par ligne.',
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

export function resetStringsStateForTests() {
  stringsView = 'hourly';
  stringsDayOffset = 0;
}