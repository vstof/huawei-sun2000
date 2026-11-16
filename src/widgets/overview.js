// -----------------------------------------------------------------------------
// The live overview widget.
// -----------------------------------------------------------------------------

import { W, statusText, GRID_EXCHANGE_TEXT, STATUS_COLORS, dailySeries, round, pick } from './shared.js';
import { snapshot as statsSnapshot } from '../stats.js';
import { getLiveSnapshot, featureExternalId } from '../devices/inverter.js';

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

  // No on/off buttons here: a pill cannot show the inverter state. The state
  // lives in the status line above, and the on/off control stays on the
  // device page (and in scenes) where its state is visible.
  return { ttl_seconds: 60, components };
}
