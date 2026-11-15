// -----------------------------------------------------------------------------
// Dashboard widgets tests: content shape within the Gladys budget, live tiles
// bound to the features, the production widget (day / month / year views
// switched by widget actions), the PV-rows widget and localization. The live
// snapshot is seeded through a real onPoll (stubbed Modbus client) and the
// statistics through recorded daily yields in a temp directory.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  resetConnectionCache,
  resetLiveSnapshotForTests,
  setClientFactoryForTests,
  inverter,
} from '../src/devices/inverter.js';
import {
  addDays,
  recordDaily,
  recordStrings,
  resetStats,
  setStatsDir,
  snapshot,
  hourlyFor,
} from '../src/stats.js';
import {
  WIDGET_KEYS,
  overviewWidget,
  productionWidget,
  stringsWidget,
  registerWidgets,
  resetNavStateForTests,
} from '../src/widgets.js';
import { normalizeConfig } from '../src/config.js';
import { t } from '../src/i18n.js';

const config = normalizeConfig({ host: '192.168.1.60' });
const ids = (gladys) => gladys.externalIds('inverter', 'huawei-sun2000');

// --- Minimal register blocks (same encodings as devices.test.js) ---------------

function powerBlock({ acPower = 1950, temperature = 415, efficiency = 9780, gridVoltage = 2300, status = 0x0200, fault = 0 } = {}) {
  const regs = new Uint16Array(27);
  const setI32 = (index, value) => {
    const unsigned = value >>> 0;
    regs[index] = Math.floor(unsigned / 65536);
    regs[index + 1] = unsigned % 65536;
  };
  setI32(0, 2300); // 32064 DC input, W
  regs[2] = gridVoltage; // 32066, 0.1 V
  setI32(16, acPower); // 32080 active power, W
  regs[22] = efficiency; // 32086, 0.01 %
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

function stringsBlock({ pv1 = [3600, 2500], pv2 = [3800, 2000], pv3 = [0, 0], pv4 = [0, 0] } = {}) {
  const regs = new Uint16Array(8);
  [pv1, pv2, pv3, pv4].forEach(([voltage, current], index) => {
    regs[2 * index] = voltage; // /10 V
    regs[2 * index + 1] = current; // /100 A
  });
  return regs;
}

function stubClient(overrides = {}) {
  const blocks = {
    identity: identityBlock(),
    power: powerBlock(),
    energy: energyBlock(),
    meter: meterBlock(),
    strings: stringsBlock(),
    ...overrides,
  };
  return {
    readRegisters: async (start, count) => {
      const found = Object.entries({ identity: 75, power: 27, energy: 10, meter: 26, strings: 8 }).find(
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

const productionAction = (gladys) => gladys.handlers[`widgetAction:${WIDGET_KEYS.production}`];

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

test('the overview widget shows the energy counters, efficiency and grid voltage', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys);

  const content = await overviewWidget(gladys, { language: 'fr' });

  const tiles = content.components.filter((c) => c.type === 'value');
  const daily = tiles.find((c) => c.label.en === 'Today');
  assert.equal(daily.device_feature, ids(gladys).feature('daily_yield'), 'the daily yield, live');
  const total = tiles.find((c) => c.label.en === 'Total yield');
  assert.equal(total.device_feature, ids(gladys).feature('total_yield'), 'the lifetime index, live');
  const efficiency = tiles.find((c) => c.unit === '%');
  assert.equal(efficiency.value, 97.8, 'register 32086 / 100');
  const grid = tiles.find((c) => c.unit === 'V');
  assert.equal(grid.value, 230, 'register 32066 / 10');
  assert.ok(
    !content.components.some((c) => c.type === 'button'),
    'no on/off buttons: they cannot show the inverter state',
  );
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

test('the overview widget populates from the poll alone (no test connection needed)', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  // A real poll, WITHOUT the identity read: the model stays unknown, the
  // widgets must still show the live tiles.
  setClientFactoryForTests(() => {
    const base = stubClient({ identity: null });
    return {
      readRegisters: async (start, count) => {
        if (count === 75) {
          throw new Error('identity block refused');
        }
        return base.readRegisters(start, count);
      },
    };
  });
  await inverter.onPoll(gladys, config);

  const content = await overviewWidget(gladys, { language: 'en' });

  const live = content.components.find((c) => c.type === 'value' && c.device_feature);
  assert.equal(live.device_feature, ids(gladys).feature('power_ac'), 'the live tile follows the poll');
  const gauge = content.components.find((c) => c.type === 'gauge');
  assert.ok(gauge, 'a gauge even without the rated power');
  assert.equal(gauge.max, 10000, 'the fallback rated power');
  assert.equal(gauge.value, 1950);
  const tiles = content.components.filter((c) => c.type === 'value');
  assert.ok(
    tiles.some((c) => c.device_feature === ids(gladys).feature('daily_yield')),
    'the daily yield tile',
  );
});

test('the poll books only true hourly deltas (no cumulative lump)', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  // A mutable energy block, shared across polls.
  const energy = energyBlock({ daily: 420 }); // 4.2 kWh already produced
  setClientFactoryForTests(() => ({
    readRegisters: async (start, count) => {
      if (count === 27) return powerBlock();
      if (count === 10) return energy;
      if (count === 26) return meterBlock();
      if (count === 8) return stringsBlock();
      throw new Error(`unexpected read ${start}+${count}`);
    },
  }));

  await inverter.onPoll(gladys, config); // first poll: the morning total cannot be split per hour
  assert.equal(await hourlyFor(today()), null, 'nothing booked on the first poll of the day');

  energy[9] = 450; // 4.5 kWh: 0.3 kWh produced since the previous poll
  await inverter.onPoll(gladys, config);
  const hourly = await hourlyFor(today());
  assert.ok(Math.abs(hourly[new Date().getHours()] - 0.3) < 1e-9, 'the delta of the last minute(s)');
  assert.equal(hourly.filter((h) => h > 0).length, 1, 'one observed hour, no fabricated history');
});

// --- Production widget (day / month / year views) ---------------------------------

test('the production widget opens on the day view: hourly chart + total', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  const day = today();
  await recordDaily(day, 1.2, 1.2, 12);
  await recordDaily(day, 2.0, 0.8, 13);
  await recordDaily(day, 2.5, 0.5, 14);

  const content = await productionWidget(gladys, { language: 'en' });

  assert.ok(content.components.length <= 8);
  assert.ok(content.components.filter((c) => c.type === 'button').length <= 4, 'at most 4 buttons');
  const tile = content.components.find((c) => c.type === 'value');
  assert.equal(tile.value, 2.5, 'the day total');
  const chart = content.components.find((c) => c.type === 'chart');
  assert.equal(chart.chart_type, 'bar');
  assert.equal(chart.series[0].points.length, 24, 'one bar per hour');
  assert.equal(chart.series[0].points[12].v, 1.2);
  assert.equal(chart.series[0].points[13].v, 0.8);
  assert.equal(chart.series[0].points[14].v, 0.5);
  assert.equal(chart.series[0].points.filter((point) => point.v > 0).length, 3, 'the observed hours');

  // Tab-like buttons: Day / Month / Year + Previous.
  const buttons = content.components.filter((c) => c.type === 'button');
  assert.deepEqual(buttons.map((button) => button.label.en), ['Day', 'Month', 'Year', 'Previous']);
  assert.equal(buttons[0].style, 'primary', 'the active tab is highlighted');
});

test('the production widget switches to the month view (tabs as buttons)', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  registerWidgets(gladys);
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

  const toast = await productionAction(gladys)('view_month', undefined, { settings: {} });
  assert.match(toast.fr, /mois/);

  const content = await productionWidget(gladys, { language: 'fr' });
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
  // The twin sits on the SAME month positions (no year of empty axis).
  assert.ok(
    chart.series[1].points.every((point) => point.t.startsWith(thisMonth)),
    'the previous-year series is aligned on the current month',
  );
  const status = content.components.find((c) => c.type === 'status');
  assert.ok(status.items.length >= 1, 'the months of the running year');
});

test('the production widget switches to the year view', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  registerWidgets(gladys);
  const previousYear = new Date();
  previousYear.setFullYear(previousYear.getFullYear() - 1, 4, 15); // May, last year
  const key = (date) => date.toISOString().slice(0, 10);
  await recordDaily(key(previousYear), 5.0);
  await recordDaily(key(new Date(previousYear.getTime() + 86400000)), 4.0); // closes May
  await recordDaily(addDays(today(), -1), 3.0); // closes into the running year
  await recordDaily(today(), 1.0);

  await productionAction(gladys)('view_year', undefined, { settings: {} });
  const content = await productionWidget(gladys, { language: 'en' });

  const chart = content.components.find((c) => c.type === 'chart');
  assert.equal(chart.series.length, 2);
  const runningYear = String(new Date().getFullYear());
  assert.ok(
    chart.series[0].points.every((point) => point.t.startsWith(runningYear)),
    'month points carry a full ISO date',
  );
  assert.match(chart.series[1].name.en, /previous year/);
  assert.ok(
    chart.series[1].points.every((point) => point.t.startsWith(runningYear)),
    'the previous-year twin is aligned on the running year',
  );
  const tile = content.components.find((c) => c.type === 'value');
  assert.equal(tile.value, 4.0, 'the running year total (yesterday closed into it + today)');
});

test('the production widget navigates back in the current view', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  registerWidgets(gladys);
  const yesterday = addDays(today(), -1);
  await recordDaily(yesterday, 4.2);
  await recordDaily(today(), 2.0);

  await productionWidget(gladys, { language: 'fr' });

  const toast = await productionAction(gladys)('nav', { dir: -1 }, { settings: {} });
  assert.match(toast.fr, /Jour précédent/);

  const previous = await productionWidget(gladys, { language: 'fr' });
  const tile = previous.components.find((c) => c.type === 'value');
  assert.equal(tile.value, 4.2, 'yesterday total');
  assert.ok(
    previous.components.some((c) => c.type === 'text' && /Pas de détail horaire/.test(c.text.fr)),
    'no hourly detail for a day recorded before this version',
  );

  // The month tab resets the period of the month view.
  await productionAction(gladys)('view_month', undefined, { settings: {} });
  await productionAction(gladys)('nav', { dir: -1 }, { settings: {} });
  await productionAction(gladys)('view_day', undefined, { settings: {} });
  const back = await productionWidget(gladys, { language: 'fr' });
  assert.equal(back.components.find((c) => c.type === 'value').value, 2.0, 'today again');
});

test('the production widget cannot navigate before the first recorded day', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  registerWidgets(gladys);
  await recordDaily(today(), 2.0);

  const action = productionAction(gladys);
  await action('nav', { dir: -1 }, { settings: {} });
  await action('nav', { dir: -1 }, { settings: {} });
  const toast = await action('nav', { dir: -1 }, { settings: {} });
  assert.match(toast.en, /No recorded data before/, 'clamped, with an explicit toast');

  const content = await productionWidget(gladys, { language: 'en' });
  assert.equal(content.components.find((c) => c.type === 'value').value, 2.0, 'still today');
});

// --- Strings (PV rows) widget ------------------------------------------------------

const stringsAction = (gladys) => gladys.handlers[`widgetAction:${WIDGET_KEYS.strings}`];

test('the strings widget shows one live tile per reported row', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys); // pv1 and pv2 wired, pv3/pv4 absent

  const content = await stringsWidget(gladys, { language: 'fr' });

  assert.ok(content.components.length <= 8);
  const tiles = content.components.filter((c) => c.type === 'value' && c.device_feature);
  assert.equal(tiles.length, 2, 'only the rows the inverter reports');
  assert.equal(tiles[0].device_feature, ids(gladys).feature('pv1_power'));
  assert.equal(tiles[1].device_feature, ids(gladys).feature('pv2_power'));
  assert.equal(tiles[0].label.fr, 'Rangée 1');
  assert.equal(tiles[1].label.fr, 'Rangée 2');
});

test('the strings widget shows the hourly detail per row by default', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys);
  await recordStrings(today(), { 1: 9000, 2: 7600 }, 3600000, 12); // 9 + 7.6 kWh at 12:00
  await recordStrings(today(), { 1: 9000, 2: 7600 }, 1800000, 13); // half an hour at 13:00

  const content = await stringsWidget(gladys, { language: 'en' });

  const chart = content.components.find((c) => c.type === 'chart');
  assert.ok(chart, 'the hourly chart');
  assert.equal(chart.series.length, 2, 'one series per row');
  assert.equal(chart.series[0].points.length, 24, 'one bar per hour');
  assert.ok(Math.abs(chart.series[0].points[12].v - 9) < 1e-9, 'the 12:00 bucket');
  assert.ok(Math.abs(chart.series[0].points[13].v - 4.5) < 1e-9, 'the 13:00 bucket');
  assert.equal(chart.series[0].points.filter((p) => p.v > 0).length, 2, 'the observed hours');

  const buttons = content.components.filter((c) => c.type === 'button');
  assert.deepEqual(
    buttons.map((button) => button.label.en),
    ['Hour by hour', '7 days', 'Previous'],
  );
  assert.equal(buttons[0].style, 'primary', 'the active view tab');
});

test('the strings widget switches to the 7-day view', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  registerWidgets(gladys);
  await seedLive(gladys);
  // Estimated energies for the last days (as the poll would book them).
  for (let offset = -3; offset <= -1; offset += 1) {
    const date = addDays(today(), offset);
    await recordStrings(date, { 1: 9000, 2: 7600 }, 3600000, 12); // 9 kWh + 7.6 kWh over an hour
  }

  await stringsAction(gladys)('view_week', undefined, { settings: {} });
  const content = await stringsWidget(gladys, { language: 'en' });

  const chart = content.components.find((c) => c.type === 'chart');
  assert.ok(chart, 'the per-row chart');
  assert.equal(chart.series.length, 2, 'one series per row');
  assert.equal(chart.series[0].name.en, 'String 1');
  assert.equal(chart.series[0].points.length, 7, 'the last 7 days');
  const observed = chart.series[0].points.filter((point) => point.v > 0);
  assert.equal(observed.length, 3, 'only the observed days');
  assert.ok(Math.abs(observed[0].v - 9) < 1e-9, 'W x ms / 3.6e9 = kWh');
  const caption = content.components.find((c) => c.type === 'text');
  assert.match(caption.text.en, /Estimated/, 'the estimate is spelled out');
});

test('the strings widget degrades gracefully without string data', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await recordDaily(today(), 1.0); // a poll happened, but no string data at all

  const content = await stringsWidget(gladys, { language: 'en' });

  assert.ok(!content.components.some((c) => c.device_feature), 'no live tile without rows');
  const caption = content.components.find((c) => c.type === 'text');
  assert.match(caption.text.en, /No per-string data yet/);
});

// --- Common -----------------------------------------------------------------------

test('every text of the widgets is a multi-language object or a plain string', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys);

  for (const widget of [overviewWidget, productionWidget, stringsWidget]) {
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

test('every widget content renders exactly as sent (core validator)', async () => {
  // The killer regression test: the core drops what it cannot render —
  // notably buttons sharing an action key (what made the tab row vanish).
  const gladys = createFakeGladys();
  await tempStats();
  registerWidgets(gladys);
  await seedLive(gladys, { statsDays: 5 });
  await recordStrings(today(), { 1: 9000, 2: 7600 }, 3600000, 12);
  for (let offset = -3; offset <= -1; offset += 1) {
    await recordStrings(addDays(today(), offset), { 1: 9000, 2: 7600 }, 3600000, 12);
  }

  const contents = [
    await overviewWidget(gladys, { language: 'fr' }),
    await productionWidget(gladys, { language: 'fr' }), // day view
    await stringsWidget(gladys, { language: 'fr' }), // hourly view
  ];
  await productionAction(gladys)('view_month', undefined, { settings: {} });
  contents.push(await productionWidget(gladys, { language: 'fr' }));
  await productionAction(gladys)('view_year', undefined, { settings: {} });
  contents.push(await productionWidget(gladys, { language: 'fr' }));
  await stringsAction(gladys)('view_week', undefined, { settings: {} });
  contents.push(await stringsWidget(gladys, { language: 'fr' }));

  for (const [index, content] of contents.entries()) {
    assert.deepEqual(validateWidgetContent(content), [], `content #${index} renders as sent`);
  }
});

test('registerWidgets hooks the widget and action keys on the SDK', () => {
  const gladys = createFakeGladys();
  registerWidgets(gladys);
  for (const key of Object.values(WIDGET_KEYS)) {
    assert.ok(typeof gladys.handlers[`widget:${key}`] === 'function');
  }
  assert.ok(typeof gladys.handlers[`widgetAction:${WIDGET_KEYS.production}`] === 'function');
  assert.ok(typeof gladys.handlers[`widgetAction:${WIDGET_KEYS.strings}`] === 'function');
});

test('feature names are stored in the language of the integration (en by default)', () => {
  assert.equal(t('power_ac'), 'AC power');
  assert.equal(t('device_name'), 'Huawei SUN2000 inverter');
  assert.equal(t('pv1_power'), 'String 1 power');
});
