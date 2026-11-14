// -----------------------------------------------------------------------------
// Dashboard widgets tests: content shape within the Gladys budget, live tiles
// bound to the features, statistics series, localization. The live snapshot is
// seeded through a real onPoll (stubbed Modbus client) and the statistics
// through recorded daily yields in a temp directory.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { resetConnectionCache, resetLiveSnapshotForTests, setClientFactoryForTests, inverter } from '../src/devices/inverter.js';
import { recordDaily, resetStats, setStatsDir, snapshot } from '../src/stats.js';
import {
  WIDGET_KEYS,
  overviewWidget,
  productionWidget,
  registerWidgets,
} from '../src/widgets.js';
import { normalizeConfig } from '../src/config.js';
import { t } from '../src/i18n.js';

const config = normalizeConfig({ host: '192.168.1.60' });
const ids = (gladys) => gladys.externalIds('inverter', 'huawei-sun2000');

// --- Minimal register blocks (same encodings as devices.test.js) ---------------

function powerBlock({ acPower = 1950, status = 0x0200, fault = 0 } = {}) {
  const regs = new Uint16Array(27);
  const setI32 = (index, value) => {
    const unsigned = value >>> 0;
    regs[index] = Math.floor(unsigned / 65536);
    regs[index + 1] = unsigned % 65536;
  };
  setI32(0, 2300); // 32064 DC input, W
  setI32(16, acPower); // 32080 active power, W
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

function identityBlock({ rated = 5000 } = {}) {
  const regs = new Uint16Array(75);
  regs[73] = Math.floor(rated / 65536); // 30073 rated power (W), high word
  regs[74] = rated % 65536; // low word
  return regs;
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

beforeEach(() => {
  resetConnectionCache();
  resetLiveSnapshotForTests();
  resetStats();
  setClientFactoryForTests(null);
});

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

test('the overview widget shows the statistics totals and the 7-day series', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys, { statsDays: 8 });
  const stats = await snapshot();

  const content = await overviewWidget(gladys, { language: 'en' });

  const tiles = content.components.filter((c) => c.type === 'value' && !c.device_feature);
  assert.deepEqual(
    tiles.map((tile) => tile.value),
    [stats.today, stats.month, stats.year].map((v) => Math.round(v * 100) / 100),
  );
  const chart = content.components.find((c) => c.type === 'chart');
  assert.equal(chart.chart_type, 'bar');
  assert.equal(chart.series[0].points.length, 7, 'the last 7 days');
  assert.equal(
    chart.series[0].points[6].v,
    Math.round(stats.days.at(-1).kwh * 100) / 100,
    'yesterday is the last bar',
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

test('the production widget shows the totals, the 30-day chart and the months', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys, { statsDays: 5 });

  const content = await productionWidget(gladys, { language: 'en' });

  assert.ok(content.components.length <= 8);
  const chart = content.components.find((c) => c.type === 'chart');
  assert.equal(chart.chart_type, 'bar');
  assert.equal(chart.series[0].points.length, 5, 'the closed days so far');
  const months = content.components.find((c) => c.type === 'status');
  assert.ok(months.items.length >= 1, 'the months of the running year');
  const caption = content.components.find((c) => c.type === 'text');
  assert.match(caption.text.en, /12345\.67 kWh/, 'the inverter lifetime counter');
});

test('every text of the widgets is a multi-language object or a plain string', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await seedLive(gladys);

  for (const widget of [overviewWidget, productionWidget]) {
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

test('the widgets degrade gracefully before the first poll (no live data)', async () => {
  const gladys = createFakeGladys();
  await tempStats();
  await recordDaily(new Date().toISOString().slice(0, 10), 1.5);

  const content = await overviewWidget(gladys, { language: 'en' });

  assert.ok(!content.components.some((c) => c.device_feature), 'no live tile without data');
  assert.ok(!content.components.some((c) => c.type === 'gauge'), 'no gauge without a rated power');
  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items[0].value, '\u2014', 'a readable placeholder even without data');
  const tiles = content.components.filter((c) => c.type === 'value' && !c.device_feature);
  assert.equal(tiles[0].value, 1.5, 'the statistics still show');
});

test('registerWidgets hooks both widget keys on the SDK', () => {
  const gladys = createFakeGladys();
  registerWidgets(gladys);
  assert.ok(typeof gladys.handlers[`widget:${WIDGET_KEYS.overview}`] === 'function');
  assert.ok(typeof gladys.handlers[`widget:${WIDGET_KEYS.production}`] === 'function');
});

test('feature names are stored in the language of the integration (en by default)', () => {
  assert.equal(t('power_ac'), 'AC power');
  assert.equal(t('device_name'), 'Huawei SUN2000 inverter');
});
