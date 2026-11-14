// -----------------------------------------------------------------------------
// Dashboard widgets tests: content shape within the Gladys budget, live tiles
// bound to the features, the navigable period widgets (day / month / year)
// and their widget actions, localization. The live snapshot is seeded through
// a real onPoll (stubbed Modbus client) and the statistics through recorded
// daily yields in a temp directory.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  resetConnectionCache,
  resetLiveSnapshotForTests,
  setClientFactoryForTests,
  inverter,
} from '../src/devices/inverter.js';
import {
  addDays,
  recordDaily,
  resetStats,
  setStatsDir,
  snapshot,
} from '../src/stats.js';
import {
  WIDGET_KEYS,
  overviewWidget,
  dayWidget,
  monthWidget,
  yearWidget,
  periodWidget,
  registerWidgets,
  resetNavStateForTests,
} from '../src/widgets.js';
import { normalizeConfig } from '../src/config.js';
import { t } from '../src/i18n.js';

const config = normalizeConfig({ host: '192.168.1.60' });
const ids = (gladys) => gladys.externalIds('inverter', 'huawei-sun2000');

// --- Minimal register blocks (same encodings as devices.test.js) ---------------

function powerBlock({ acPower = 1950, temperature = 415, status = 0x0200, fault = 0 } = {}) {
  const regs = new Uint16Array(27);
  const setI32 = (index, value) => {
    const unsigned = value >>> 0;
    regs[index] = Math.floor(unsigned / 65536);
    regs[index + 1] = unsigned % 65536;
  };
  setI32(0, 2300); // 32064 DC input, W
  setI32(16, acPower); // 32080 active power, W
  regs[23] = temperature; // 32087, 0.1 °C
  regs[25] = status; // 32089
  regs[26] = fault; // 32090
  return regs;
}

function energyBlock({ total = 1234567, daily = 420 } = {}) {
  const regs = new Uint16Array(10);
  regs[0] = Math.floor(total / 65536); // 32106, 0.01 kWh
  regs[1] = total % 65536;
  regs[8] = Math.floor(daily / 65536); // 32114, 0.01 kWh
  regs[9] = daily % 65536;
  return regs;
}

function meterBlock({ active = -1500 } = {}) {
  const regs = new Uint16Array(26);
  regs[0] = 1; // 37100: meter present and normal
  const setI32 = (index, value) => {
    const unsigned = value >>> 0;
    regs[index] = Math.floor(unsigned / 65536);
    regs[index + 1] = unsigned % 65536;
  };
  setI32(13, active); // 37113, W (positive = feed-in)
  return regs;
}

function identityBlock({ rated = 5000 } = {}) {
  const regs = new Uint16Array(75);
  regs[73] = Math.floor(rated / 65536); // 30073 rated power (W), high word
  regs[74] = rated % 65536; // low word
  return regs;
}

function stubClient(overrides = {}) {
  const blocks = {
    identity: identityBlock(),
    power: powerBlock(),
    energy: energyBlock(),
    meter: meterBlock(),
    ...overrides,
  };
  return {
    readRegisters: async (start, count) => {
      const found = Object.entries({ identity: 75, power: 27, energy: 10, meter: 26 }).find(
        ([, c]) => c === count,
      );
      const block = found ? blocks[found[0]] : null;
      if (block === null) {
        throw new Error(`unexpected read ${start}+${count}`);
      }
      return block;
    },
  };
}

// Close the past days into the statistics FIRST (oldest to newest), then run
// one real poll: it reads today's daily register and closes yesterday.
async function seedLive(gladys, { statsDays = 3 } = {}) {
  for (let offset = statsDays; offset >= 1; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    await recordDaily(date.toISOString().slice(0, 10), 3 + offset);
  }
  setClientFactoryForTests(() => stubClient());
  // The "Test the connection" action reads the identity block: it is what
  // teaches the widgets the rated power (the poll no longer reads it).
  await inverter.actions.test_connection(gladys, { fields: {}, config });
  await inverter.onPoll(gladys, config);
}

const tempStats = async () => setStatsDir(await mkdtemp(path.join(tmpdir(), 'huawei-widgets-')));

const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  resetConnectionCache();
  resetLiveSnapshotForTests();
  resetStats();
  resetNavStateForTests();
  setClientFactoryForTests(null);
});

// --- Overview widget -------------------------------------------------------------

test('the overview widget fits the Gladys content budget', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys);

  const content = await overviewWidget(gladys, { language: 'fr' });

  assert.ok(content.components.length <= 8, 'at most 8 components');
  const focal = content.components.filter((c) => ['chart', 'card-list', 'image'].includes(c.type));
  assert.equal(focal.length, 1, 'one focal component (the 7-day chart)');
  const tiles = content.components.filter((c) => ['value', 'gauge'].includes(c.type));
  assert.ok(tiles.length <= 6, 'at most 6 tiles');
  assert.equal(content.components.filter((c) => c.type === 'status').length, 1, 'one status');
  assert.ok(content.components.filter((c) => c.type === 'button').length <= 4, 'at most 4 buttons');
});

test('the overview widget binds a live tile to the AC power feature', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys);

  const content = await overviewWidget(gladys, { language: 'en' });

  const live = content.components.find((c) => c.type === 'value' && c.device_feature);
  assert.equal(live.device_feature, ids(gladys).feature('power_ac'), 'the live tile follows the poll');
  const gauge = content.components.find((c) => c.type === 'gauge');
  assert.ok(gauge, 'a gauge compares the production to the rated power');
  assert.equal(gauge.max, 5000, 'the rated power of the device block');
  assert.equal(gauge.value, 1950);
});

test('the overview widget shows temperature, DC input and the start/stop buttons', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys);

  const content = await overviewWidget(gladys, { language: 'fr' });

  const tiles = content.components.filter((c) => c.type === 'value');
  const temperature = tiles.find((c) => c.unit === '°C');
  assert.ok(temperature, 'an internal temperature tile');
  assert.equal(temperature.value, 41.5, 'register 32087 / 10');
  const dc = tiles.find((c) => c.unit === 'W' && !c.device_feature);
  assert.equal(dc.value, 2300, 'the DC input power tile');

  const buttons = content.components.filter((c) => c.type === 'button');
  assert.deepEqual(
    buttons.map((button) => button.value),
    [1, 0],
    'a start and a stop button',
  );
  for (const button of buttons) {
    assert.equal(button.device_feature, ids(gladys).feature('running'));
  }
  const stop = buttons.find((button) => button.value === 0);
  assert.equal(stop.style, 'danger');
});

test('the overview widget keeps the 7-day series and no period counter tiles', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys, { statsDays: 8 });
  const stats = await snapshot();

  const content = await overviewWidget(gladys, { language: 'en' });

  const chart = content.components.find((c) => c.type === 'chart');
  assert.equal(chart.chart_type, 'bar');
  assert.equal(chart.series[0].points.length, 7, 'the last 7 days');
  assert.equal(
    chart.series[0].points[6].v,
    Math.round(stats.days.at(-1).kwh * 100) / 100,
    'yesterday is the last bar',
  );
  const tiles = content.components.filter((c) => c.type === 'value' && !c.device_feature);
  assert.ok(
    !tiles.some((tile) => tile.unit === 'kWh'),
    'the day/month/year counters are not in the overview anymore',
  );
});

test('the overview widget reports the grid exchange and the inverter state', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys);

  const content = await overviewWidget(gladys, { language: 'fr' });
  const status = content.components.find((c) => c.type === 'status');

  assert.equal(status.items[0].value, 'Connecté au réseau', 'the state in the requested language');
  assert.equal(status.items[0].color, 'success');
  assert.match(status.items[1].value, /Soutirage 1\.5 kW/, 'importing 1500 W (meter sign flipped)');
  assert.equal(status.items[1].color, 'info');
});

// --- Period widgets ---------------------------------------------------------------

test('the day widget shows the selected day per hour and its total', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  const day = today();
  await recordDaily(day, 1.2, 1.2, 12); // morning accumulations booked at noon
  await recordDaily(day, 2.0, 0.8, 13);
  await recordDaily(day, 2.5, 0.5, 14);

  const content = await dayWidget(gladys, { language: 'en' });

  assert.ok(content.components.length <= 8);
  const tile = content.components.find((c) => c.type === 'value');
  assert.equal(tile.value, 2.5, 'the day total');
  const chart = content.components.find((c) => c.type === 'chart');
  assert.equal(chart.chart_type, 'bar');
  assert.equal(chart.series[0].points.length, 24, 'one bar per hour');
  assert.equal(chart.series[0].points[12].v, 1.2);
  assert.equal(chart.series[0].points[13].v, 0.8);
  assert.equal(chart.series[0].points[14].v, 0.5);
  assert.equal(chart.series[0].points.filter((point) => point.v > 0).length, 3, 'the observed hours');
});

test('the day widget navigates to the previous day and back', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  registerWidgets(gladys);
  const yesterday = addDays(today(), -1);
  await recordDaily(yesterday, 4.2); // closed only when a later day starts
  await recordDaily(today(), 2.0);

  await dayWidget(gladys, { language: 'fr' });

  const action = gladys.handlers[`widgetAction:${WIDGET_KEYS.day}`];
  assert.equal(typeof action, 'function', 'the widget action is registered');
  const toast = await action('nav', { dir: -1 }, { settings: {} });
  assert.match(toast.fr, /Jour précédent/);

  const previous = await dayWidget(gladys, { language: 'fr' });
  const tile = previous.components.find((c) => c.type === 'value');
  assert.equal(tile.value, 4.2, 'yesterday total');
  assert.ok(
    previous.components.some((c) => c.type === 'text' && /enregistrement a commencé/.test(c.text.fr)),
    'no hourly detail for a day recorded before this version',
  );

  await action('today', undefined, { settings: {} });
  const back = await dayWidget(gladys, { language: 'fr' });
  assert.equal(back.components.find((c) => c.type === 'value').value, 2.0);
});

test('the day widget cannot navigate before the first recorded day', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  registerWidgets(gladys);
  await recordDaily(today(), 2.0);

  const action = gladys.handlers[`widgetAction:${WIDGET_KEYS.day}`];
  await action('nav', { dir: -1 }, { settings: {} });
  await action('nav', { dir: -1 }, { settings: {} });
  const toast = await action('nav', { dir: -1 }, { settings: {} });
  assert.match(toast.en, /No recorded data before/, 'clamped, with an explicit toast');

  const content = await dayWidget(gladys, { language: 'en' });
  assert.equal(content.components.find((c) => c.type === 'value').value, 2.0, 'still today');
});

test('the month widget shows the month per day, with the previous year alongside', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  // The same month one year back: three observed days.
  const lastYear = new Date();
  lastYear.setFullYear(lastYear.getFullYear() - 1);
  lastYear.setDate(10);
  const key = (date) => date.toISOString().slice(0, 10);
  await recordDaily(key(lastYear), 1.0);
  await recordDaily(key(new Date(lastYear.getTime() + 86400000)), 1.5);
  await recordDaily(key(new Date(lastYear.getTime() + 2 * 86400000)), 2.0);
  // The running month: two closed days + today.
  await recordDaily(addDays(today(), -2), 3.0);
  await recordDaily(addDays(today(), -1), 3.5);
  await recordDaily(today(), 2.0);

  const content = await monthWidget(gladys, { language: 'fr' });

  const tile = content.components.find((c) => c.type === 'value');
  assert.ok(Number.isFinite(tile.value), 'the month total');
  const chart = content.components.find((c) => c.type === 'chart');
  assert.equal(chart.series.length, 2, 'the month and its previous-year twin');
  const thisMonth = String(new Date().toISOString().slice(0, 7));
  assert.equal(
    chart.series[0].points.filter((point) => point.t.startsWith(thisMonth)).length,
    3,
    'two closed days + today',
  );
  const previousYearMonth = chart.series[1];
  assert.match(previousYearMonth.name.fr, /année précédente/);
  assert.equal(previousYearMonth.points.length, 3);
});

test('the year widget shows the year per month with the previous year', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  // Two months of the previous year, then the running year.
  const previousYear = new Date();
  previousYear.setFullYear(previousYear.getFullYear() - 1, 4, 15); // May, last year
  const key = (date) => date.toISOString().slice(0, 10);
  await recordDaily(key(previousYear), 5.0);
  await recordDaily(key(new Date(previousYear.getTime() + 86400000)), 4.0); // closes May
  await recordDaily(addDays(today(), -1), 3.0); // closes into the running year
  await recordDaily(today(), 1.0);

  const content = await yearWidget(gladys, { language: 'en' });

  const chart = content.components.find((c) => c.type === 'chart');
  assert.equal(chart.series.length, 2);
  const runningYear = String(new Date().getFullYear());
  const thisYear = chart.series[0];
  assert.equal(
    thisYear.points.filter((point) => point.t.startsWith(runningYear)).length,
    1,
    'the running month partial',
  );
  assert.match(chart.series[1].name.en, /previous year/);
  const tile = content.components.find((c) => c.type === 'value');
  assert.equal(tile.value, 4.0, 'the running year total (yesterday closed into it + today)');
});

test('every text of the widgets is a multi-language object or a plain string', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys);

  for (const widget of [overviewWidget, dayWidget, monthWidget, yearWidget]) {
    const content = await widget(gladys, { language: 'en' });
    for (const component of content.components) {
      for (const field of ['label', 'title', 'unit', 'text', 'name']) {
        const value = component[field];
        if (value === undefined) continue;
        assert.ok(
          typeof value === 'string' || (value.en !== undefined && value.fr !== undefined),
          `component ${component.type}.${field} is localizable`,
        );
      }
    }
  }
});

test('periodWidget dispatches by key', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await recordDaily(today(), 1.0);
  const day = await periodWidget(gladys, WIDGET_KEYS.day, { language: 'en' });
  const month = await periodWidget(gladys, WIDGET_KEYS.month, { language: 'en' });
  const year = await periodWidget(gladys, WIDGET_KEYS.year, { language: 'en' });
  assert.ok(day.components.some((c) => c.type === 'chart' || c.type === 'text'));
  assert.ok(month.components.some((c) => c.type === 'chart' || c.type === 'text'));
  assert.ok(year.components.some((c) => c.type === 'chart' || c.type === 'text'));
});

test('the widgets degrade gracefully before the first poll (no live data)', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await recordDaily(today(), 1.5);

  const content = await overviewWidget(gladys, { language: 'en' });

  assert.ok(!content.components.some((c) => c.device_feature && c.type === 'value'), 'no live tile without data');
  assert.ok(!content.components.some((c) => c.type === 'gauge'), 'no gauge without a rated power');
  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items[0].value, '\u2014', 'a readable placeholder even without data');
});

test('registerWidgets hooks the widget and action keys on the SDK', () => {
  const gladys = createFakeGladys();
  registerWidgets(gladys);
  for (const key of Object.values(WIDGET_KEYS)) {
    assert.ok(typeof gladys.handlers[`widget:${key}`] === 'function');
  }
  for (const key of [WIDGET_KEYS.day, WIDGET_KEYS.month, WIDGET_KEYS.year]) {
    assert.ok(typeof gladys.handlers[`widgetAction:${key}`] === 'function');
  }
});

test('feature names are stored in the language of the integration (en by default)', () => {
  assert.equal(t('power_ac'), 'AC power');
  assert.equal(t('device_name'), 'Huawei SUN2000 inverter');
});
