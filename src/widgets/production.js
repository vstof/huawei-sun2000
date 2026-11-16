// -----------------------------------------------------------------------------
// The production widget: one widget, three views (Day / Month / Year) switched
// by tab-like buttons, because Gladys has no tabs inside a widget and only one
// focal chart per content.
//
//   - Day:   the selected day, hour by hour (24 bars).
//   - Month: a rolling window of the last 12 months (one bar per month, even
//            the months with no production), shifted with the Previous button.
//   - Year:  a multi-year comparison (one bar per year), shifted the same way.
// -----------------------------------------------------------------------------

import { W, monthLabelLong, dayLabel, round } from './shared.js';
import { WIDGET_KEYS } from './shared.js';
import { dayTotal, hourlyFor, monthTotal, yearTotal, dataBounds, addDays, addMonths, dayDiff, localDate } from '../stats.js';

const VIEWS = ['day', 'month', 'year'];

const VIEW_TABS = {
  day: { en: 'Day', fr: 'Jour' },
  month: { en: 'Month', fr: 'Mois' },
  year: { en: 'Year', fr: 'Année' },
};

let productionView = 'day';
const periodOffset = new Map();

const offsetKey = (view) => `production:${view}`;
const offsetOf = (view) => periodOffset.get(offsetKey(view)) ?? 0;

/**
 * Clamp a period offset (<= 0) to the data actually recorded.
 * @param {string} view 'day' | 'month' | 'year'
 * @param {number} offset requested (<= 0)
 */
async function clampOffset(view, offset) {
  const bounds = await dataBounds();
  const today = localDate();
  const now = new Date();
  const currentYear = now.getFullYear();
  if (view === 'day') {
    const min = bounds.firstDay ? -dayDiff(bounds.firstDay, today) : 0;
    return Math.min(0, Math.max(min, offset));
  }
  if (view === 'month') {
    // Window of 12 months ending at currentMonth + offset: the oldest month
    // in the window must not predate the first recorded month.
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const endMonth = addMonths(currentMonth, offset);
    const startMonth = addMonths(endMonth, -11);
    let minOffset = 0;
    if (bounds.firstMonth) {
      // smallest offset such that startMonth >= firstMonth
      // startMonth = addMonths(currentMonth, offset-11) >= firstMonth
      minOffset = monthDiff(bounds.firstMonth, currentMonth) - 11;
      if (minOffset > 0) minOffset = 0;
    }
    return Math.min(0, Math.max(minOffset, offset));
  }
  // Year view: window of 5 years ending at currentYear + offset.
  const minOffset = bounds.firstYear ? Number(bounds.firstYear) - currentYear + 4 : 0;
  return Math.min(0, Math.max(minOffset > 0 ? 0 : minOffset, offset));
}

/** Whole months between two YYYY-MM keys (b - a). */
function monthDiff(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return by * 12 + bm - (ay * 12 + am);
}

function viewButtons(currentView) {
  // Each button carries its OWN action key: the core drops buttons sharing
  // an action key within one content ("duplicate action key") — that is what
  // made the tab row vanish.
  return VIEWS.map((view) => ({
    type: 'button',
    label: VIEW_TABS[view],
    icon: view === 'day' ? 'sunrise' : view === 'month' ? 'calendar' : 'bar-chart-2',
    style: view === currentView ? 'primary' : 'secondary',
    action: { key: `view_${view}` },
  }));
}

export async function handleProductionAction(actionKey) {
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
    globalRefresh?.();
  } catch {
    // fire-and-forget
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

let globalRefresh = null;

export function setProductionRefresh(fn) {
  globalRefresh = fn;
}

export async function productionWidget(gladys, { language = 'en' } = {}) {
  const view = productionView;
  const offset = await clampOffset(view, offsetOf(view));
  periodOffset.set(offsetKey(view), offset);
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
    // Shift the rolling window by the offset (negative = older).
    const shifted = [];
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const endMonth = addMonths(currentMonth, offset);
    for (let i = -11; i <= 0; i += 1) {
      const m = addMonths(endMonth, i);
      const kwh = (await monthTotal(m)) ?? 0;
      shifted.push({ month: m, kwh });
    }
    const total = shifted.reduce((sum, x) => sum + x.kwh, 0);
    components.push({
      type: 'value',
      value: round(total),
      unit: 'kWh',
      label: { en: '12-month total', fr: 'Total 12 mois' },
      icon: 'calendar',
      color: W.SUCCESS,
    });
    components.push({
      type: 'chart',
      chart_type: 'bar',
      title: { en: `12 months to ${monthLabelLong(endMonth, 'en')}`, fr: `12 mois jusqu'à ${monthLabelLong(endMonth, 'fr')}` },
      unit: 'kWh',
      series: [
        {
          name: { en: 'Monthly production', fr: 'Production mensuelle' },
          points: shifted.map((x) => ({ t: `${x.month}-01`, v: round(x.kwh) })),
        },
      ],
    });
  } else {
    const now = new Date();
    const currentYear = now.getFullYear();
    const endYear = currentYear + offset;
    const shifted = [];
    for (let i = -4; i <= 0; i += 1) {
      const y = String(endYear + i);
      const kwh = (await yearTotal(y)) ?? 0;
      shifted.push({ year: y, kwh });
    }
    const total = shifted.reduce((sum, x) => sum + x.kwh, 0);
    components.push({
      type: 'value',
      value: round(total),
      unit: 'kWh',
      label: { en: '5-year total', fr: 'Total 5 ans' },
      icon: 'calendar',
      color: W.SUCCESS,
    });
    components.push({
      type: 'chart',
      chart_type: 'bar',
      title: { en: `5 years to ${endYear}`, fr: `5 ans jusqu'à ${endYear}` },
      unit: 'kWh',
      series: [
        {
          name: { en: 'Annual production', fr: 'Production annuelle' },
          points: shifted.map((x) => ({ t: `${x.year}-01-01`, v: round(x.kwh) })),
        },
      ],
    });
  }

  // Tab-like buttons (switch view = also "back to the current period"), then
  // one step back in the current view. Gladys allows 4 buttons per content.
  components.push(
    ...viewButtons(view),
    {
      type: 'button',
      label: { en: 'Previous', fr: 'Précédent' },
      icon: 'chevron-left',
      action: { key: 'nav' },
    },
  );

  return { ttl_seconds: 60, components };
}

export function resetProductionStateForTests() {
  productionView = 'day';
  periodOffset.clear();
}