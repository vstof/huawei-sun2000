// -----------------------------------------------------------------------------
// Device tests: discovery payload, polling, block tolerance and the connection
// status. The Modbus client is stubbed through setClientFactoryForTests: these
// tests never touch the network.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  createPoller,
  findBlueprintByDevice,
} from '../src/devices/index.js';
import {
  buildStates,
  inverter,
  parseIdentity,
  resetConnectionCache,
  setClientFactoryForTests,
} from '../src/devices/inverter.js';
import { normalizeConfig } from '../src/config.js';

const config = normalizeConfig({ host: '192.168.1.60' });

const ids = (gladys) => gladys.externalIds('inverter', 'huawei-sun2000');

// --- Synthetic register blocks ------------------------------------------------

function identityBlock({ model = 'SUN2000-5KTL-L1', serial = 'HW5KTL1234', rated = 5000 } = {}) {
  const regs = new Uint16Array(75);
  const writeAscii = (text, index, length) => {
    for (let offset = 0; offset < length; offset += 1) {
      const high = text.charCodeAt(offset * 2) || 0;
      const low = text.charCodeAt(offset * 2 + 1) || 0;
      regs[index + offset] = (high << 8) | low;
    }
  };
  writeAscii(model, 0, 15);
  writeAscii(serial, 15, 10);
  regs[73] = Math.floor(rated / 65536); // 30073 rated power (W), high word
  regs[74] = rated % 65536; // low word
  return regs;
}

// Power block (32064, 27 registers), values consistent with a five-kilowatt
// single-phase inverter producing 1 950 W.
function powerBlock(overrides = {}) {
  const regs = new Uint16Array(27);
  const setI32 = (index, value) => {
    const unsigned = value >>> 0;
    regs[index] = Math.floor(unsigned / 65536);
    regs[index + 1] = unsigned % 65536;
  };
  setI32(0, overrides.inputPower ?? 2000); // 32064 DC input power, W
  regs[2] = overrides.gridVoltageAB ?? 2300; // 32066, 230.0 V
  regs[3] = overrides.gridVoltageBC ?? 0; // 32067, not valid (single phase)
  regs[4] = overrides.gridVoltageCA ?? 0;
  regs[5] = 0; // 32069 phase A voltage: not valid on this model
  regs[6] = 0;
  regs[7] = 0;
  setI32(8, overrides.currentA ?? 8695); // 32072, 8.695 A
  setI32(10, 0); // phase B current
  setI32(12, 0); // phase C current
  setI32(14, overrides.peakPower ?? 5000); // 32078, W
  setI32(16, overrides.powerAc ?? 1950); // 32080, W
  setI32(18, overrides.reactive ?? 100); // 32082, var
  regs[20] = overrides.powerFactor ?? 998; // 32084, 0.998
  regs[21] = overrides.frequency ?? 5000; // 32085, 50.00 Hz
  regs[22] = overrides.efficiency ?? 9780; // 32086, 97.8 %
  regs[23] = overrides.temperature ?? 365; // 32087, 36.5 °C
  regs[25] = overrides.status ?? 0x0200; // 32089 on-grid
  regs[26] = overrides.fault ?? 0; // 32090 fault code
  return regs;
}

function stringsBlock({ pv1 = [3600, 2500], pv2 = [0, 0], pv3 = [0, 0], pv4 = [0, 0] } = {}) {
  const regs = new Uint16Array(8);
  [pv1, pv2, pv3, pv4].forEach(([voltage, current], index) => {
    regs[2 * index] = voltage; // /10 V
    regs[2 * index + 1] = current; // /100 A
  });
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

// Meter block (37100, 26 registers), status normal, importing 1 500 W.
function meterBlock({ status = 1, active = -1500, exported = 0, imported = 5050 } = {}) {
  const regs = new Uint16Array(26);
  regs[0] = status; // 37100
  const setI32 = (index, value) => {
    const unsigned = value >>> 0;
    regs[index] = Math.floor(unsigned / 65536);
    regs[index + 1] = unsigned % 65536;
  };
  setI32(13, active); // 37113, W (positive = feed-in)
  setI32(19, exported); // 37119 feed-in energy, 0.01 kWh
  setI32(21, imported); // 37121 consumed energy, 0.01 kWh
  return regs;
}

// A client for the command tests: the writes are recorded, an injected
// `writeError` makes every write fail.
function commandClient({ writeError = null } = {}) {
  const writes = [];
  const base = stubClient();
  return {
    writes,
    readRegisters: base.readRegisters,
    writeRegister: async (address, value) => {
      writes.push([address, value]);
      if (writeError) {
        throw writeError;
      }
    },
  };
}

function stubClient(overrides = {}) {
  const blocks = {
    identity: identityBlock(),
    strings: stringsBlock(),
    power: powerBlock(),
    energy: energyBlock(),
    meter: meterBlock(),
    ...overrides,
  };
  return {
    readRegisters: async (start, count) => {
      const found = Object.entries({ identity: 75, strings: 8, power: 27, energy: 10, meter: 26 }).find(
        ([, blockCount]) => count === blockCount,
      );
      const block = found ? blocks[found[0]] : null;
      if (block === null || block === undefined) {
        throw new Error(`unexpected read ${start}+${count}`);
      }
      return block;
    },
  };
}

beforeEach(() => {
  // The reported status is a module-level cache.
  resetConnectionCache();
  setClientFactoryForTests(null);
});

test('every blueprint exposes the required shape', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    assert.equal(typeof bp.key, 'string', 'key must be a string');
    assert.equal(typeof bp.deviceExternalId, 'function', 'deviceExternalId must be a function');
    assert.equal(typeof bp.buildDevice, 'function', 'buildDevice must be a function');
    assert.equal(typeof bp.onPoll, 'function', 'a polled device implements onPoll');
    assert.equal(typeof bp.onSetValue, 'function', 'onSetValue exists (routes or refuses commands)');
  }
});

test('buildDiscoveredDevices returns the device with its features', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, config);
  assert.equal(devices.length, 1);
  const [device] = devices;
  assert.equal(device.name, 'Onduleur Huawei SUN2000');
  assert.equal(device.external_id, ids(gladys).device);
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, DEVICE_POLL_FREQUENCIES.EVERY_MINUTES);
  assert.ok(device.features.length >= 20, 'the inverter exposes its production and grid features');
});

test('Gladys accepts the discovery payload', async () => {
  // The SDK fake validates the payload like the host API: external_id prefix,
  // known category/type/unit, poll_frequency, supported_options... A refusal
  // is a 400 for the WHOLE list, so nothing would show up in Discovery.
  const gladys = createFakeGladys();
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
  assert.equal(gladys.fake.discoveredDevices.length, 1);
});

test('feature external_ids are unique and every feature declares its bounds', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, config);
  const featureIds = device.features.map((feature) => feature.external_id);
  assert.equal(new Set(featureIds).size, featureIds.length, 'no duplicate feature external_id');
  for (const feature of device.features) {
    assert.equal(typeof feature.min, 'number', `${feature.name}: min`);
    assert.equal(typeof feature.max, 'number', `${feature.name}: max`);
    assert.equal(typeof feature.read_only, 'boolean', `${feature.name}: read_only`);
    if (feature.read_only) {
      assert.equal(feature.has_feedback, false, `${feature.name}: a sensor has no feedback`);
    } else {
      assert.equal(feature.has_feedback, true, `${feature.name}: a command reports its state`);
      assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.SWITCH, `${feature.name}: a command is a switch`);
      assert.equal(feature.type, DEVICE_FEATURE_TYPES.SWITCH.BINARY, `${feature.name}: a command is binary`);
    }
    if (feature.category === DEVICE_FEATURE_CATEGORIES.TEXT) {
      assert.equal(feature.type, DEVICE_FEATURE_TYPES.TEXT.SELECT, `${feature.name}: text feature`);
      assert.ok(Array.isArray(feature.supported_options) && feature.supported_options.length > 0);
      const values = feature.supported_options.map((option) => option.value);
      assert.equal(new Set(values).size, values.length, `${feature.name}: duplicate option`);
      assert.ok(
        feature.supported_options.every((option) => typeof option.label === 'string' && option.label.length > 0),
        `${feature.name}: every option needs a label`,
      );
    }
  }
  const writable = device.features.filter((feature) => !feature.read_only);
  assert.deepEqual(
    writable.map((feature) => feature.name),
    ['Marche / Arrêt de l\u2019onduleur'],
    'the on/off switch is the only writable feature',
  );
});

test('the production and meter features use the dedicated categories', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, config);
  const byKey = Object.fromEntries(device.features.map((feature) => [feature.name, feature]));
  assert.equal(byKey['Puissance produite (AC)'].category, DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR);
  assert.equal(byKey['Production du jour'].type, DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION);
  assert.equal(byKey['Production totale'].type, DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.INDEX);
  assert.equal(byKey['Puissance réseau (compteur)'].category, DEVICE_FEATURE_CATEGORIES.GRID_SENSOR);
  assert.equal(byKey['Énergie soutirée (compteur)'].type, DEVICE_FEATURE_TYPES.GRID_SENSOR.INPUT_INDEX);
  assert.equal(byKey['Énergie injectée (compteur)'].type, DEVICE_FEATURE_TYPES.GRID_SENSOR.OUTPUT_INDEX);
});

test('the poller reads the device at the refresh interval of the config', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const gladys = createFakeGladys();
  const pollDevice = createPoller();
  const device = { external_id: inverter.deviceExternalId(gladys) };
  // A five minutes interval: Gladys ticks every minute, four ticks must be
  // skipped (the default 60 s interval never is, it matches Gladys' own tick).
  const slowConfig = normalizeConfig({ ...config, poll_frequency: 300 });
  let reads = 0;
  setClientFactoryForTests(() => ({
    readRegisters: async (start, count) => {
      // Count the core power-block reads: one poll reads one per cycle.
      if (start === 32064) {
        reads += 1;
      }
      return stubClient().readRegisters(start, count);
    },
  }));

  assert.equal(await pollDevice(gladys, device, slowConfig), true, 'the first poll reads');
  for (let minute = 1; minute < 5; minute += 1) {
    t.mock.timers.tick(DEVICE_POLL_FREQUENCIES.EVERY_MINUTES);
    assert.equal(await pollDevice(gladys, device, slowConfig), false, `skipped at ${minute} min`);
  }
  // Gladys' tick may land a little early: the read is still due.
  t.mock.timers.tick(DEVICE_POLL_FREQUENCIES.EVERY_MINUTES - 50);
  assert.equal(await pollDevice(gladys, device, slowConfig), true, 'read again at 5 min');
  assert.equal(reads, 2, 'two real reads in five minutes');
});

test('the poller ignores a device it does not own', async () => {
  const pollDevice = createPoller();
  const gladys = createFakeGladys();
  assert.equal(await pollDevice(gladys, { external_id: 'does-not-exist' }, config), false);
});

test('onPoll publishes the production, grid, energy and meter values', async () => {
  setClientFactoryForTests(() => stubClient());
  const gladys = createFakeGladys();

  await inverter.onPoll(gladys, config);

  const featureIds = ids(gladys);
  const states = gladys.fake.states;
  assert.ok(states.length >= 12, `${states.length} states published`);
  assert.equal(gladys.fake.lastState(featureIds.feature('power_ac')), 1950);
  assert.equal(gladys.fake.lastState(featureIds.feature('dc_power')), 2000);
  assert.equal(gladys.fake.lastState(featureIds.feature('peak_power')), 5000);
  assert.equal(gladys.fake.lastState(featureIds.feature('daily_yield')), 4.2);
  assert.equal(gladys.fake.lastState(featureIds.feature('total_yield')), 12345.67);
  assert.equal(gladys.fake.lastState(featureIds.feature('pv1_voltage')), 360);
  assert.equal(gladys.fake.lastState(featureIds.feature('pv1_current')), 25);
  assert.equal(gladys.fake.lastState(featureIds.feature('grid_volt_ab')), 230);
  assert.equal(gladys.fake.lastState(featureIds.feature('current_a')), 8.695);
  assert.equal(gladys.fake.lastState(featureIds.feature('power_factor')), 0.998);
  assert.equal(gladys.fake.lastState(featureIds.feature('frequency')), 50);
  assert.equal(gladys.fake.lastState(featureIds.feature('efficiency')), 97.8);
  assert.equal(gladys.fake.lastState(featureIds.feature('temperature')), 36.5);
  assert.equal(gladys.fake.lastState(featureIds.feature('status')), 'on_grid');
  assert.equal(gladys.fake.lastState(featureIds.feature('fault')), 0);
  assert.equal(gladys.fake.lastState(featureIds.feature('meter_power')), 1500);
  assert.equal(gladys.fake.lastState(featureIds.feature('meter_import_index')), 50.5);
  // Nothing was fed into the grid yet: no fabricated 0 index.
  assert.equal(gladys.fake.lastState(featureIds.feature('meter_export_index')), undefined);
});

test('onPoll skips the features the model does not carry', async () => {
  setClientFactoryForTests(() =>
    stubClient({
      strings: stringsBlock({ pv1: [0, 0] }), // no string wired / read at night
      power: powerBlock({ gridVoltageBC: 0 }), // single-phase: B-C and C-A invalid
      meter: meterBlock({ status: 0 }), // no Smart Power Sensor installed
    }),
  );
  const gladys = createFakeGladys();

  await inverter.onPoll(gladys, config);

  const featureIds = ids(gladys);
  for (const key of [
    'pv1_voltage',
    'pv1_current',
    'pv2_voltage',
    'grid_volt_bc',
    'grid_volt_ca',
    'meter_power',
    'meter_import_index',
    'meter_export_index',
  ]) {
    assert.equal(gladys.fake.lastState(featureIds.feature(key)), undefined, `${key} stays silent`);
  }
});

test('a negative AC power stays at zero, the reactive power keeps its sign', async () => {
  setClientFactoryForTests(() => stubClient({ power: powerBlock({ powerAc: -30, reactive: -400 }) }));
  const gladys = createFakeGladys();
  await inverter.onPoll(gladys, config);
  const featureIds = ids(gladys);
  assert.equal(gladys.fake.lastState(featureIds.feature('power_ac')), 0);
  assert.equal(gladys.fake.lastState(featureIds.feature('reactive_power')), -400);
});

test('an unknown status code maps to the unknown option', async () => {
  setClientFactoryForTests(() => stubClient({ power: powerBlock({ status: 0x7777 }) }));
  const gladys = createFakeGladys();
  await inverter.onPoll(gladys, config);
  assert.equal(gladys.fake.lastState(ids(gladys).feature('status')), 'unknown');
});

test('a fault code flags the anomaly feature', async () => {
  setClientFactoryForTests(() => stubClient({ power: powerBlock({ fault: 0x0300, status: 0x0300 }) }));
  const gladys = createFakeGladys();
  await inverter.onPoll(gladys, config);
  const featureIds = ids(gladys);
  assert.equal(gladys.fake.lastState(featureIds.feature('fault')), 1);
  assert.equal(gladys.fake.lastState(featureIds.feature('status')), 'shutdown');
});

test('onPoll reports the inverter as reachable, once', async () => {
  setClientFactoryForTests(() => stubClient());
  const gladys = createFakeGladys();
  await inverter.onPoll(gladys, config);
  await inverter.onPoll(gladys, config);
  assert.equal(gladys.fake.connectionStatuses.length, 1, 'only a change is reported');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a failed core read rejects, flags the inverter unreachable and keeps the bilingual message', async () => {
  setClientFactoryForTests(() => ({
    readRegisters: async () => {
      throw new Error('connection failed: connect ECONNREFUSED 192.168.1.60:502');
    },
  }));
  const gladys = createFakeGladys();
  await assert.rejects(inverter.onPoll(gladys, config), /ECONNREFUSED/);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /injoignable/);
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable/);
});

test('an optional block that fails does not break the poll', async () => {
  const client = stubClient();
  setClientFactoryForTests(() => ({
    readRegisters: async (start, count) => {
      // The meter block (37100) does not exist on this firmware.
      if (start === 37100) {
        throw new Error('Modbus exception 2: illegal data address');
      }
      return client.readRegisters(start, count);
    },
  }));
  const gladys = createFakeGladys();
  await inverter.onPoll(gladys, config);
  const featureIds = ids(gladys);
  assert.equal(gladys.fake.lastState(featureIds.feature('power_ac')), 1950);
  assert.equal(gladys.fake.lastState(featureIds.feature('meter_power')), undefined);
  assert.equal(gladys.fake.connectionStatus.connected, true, 'still reachable');
});

test('onSetValue refuses the features it does not own', async () => {
  setClientFactoryForTests(() => commandClient());
  const gladys = createFakeGladys();
  await assert.rejects(
    inverter.onSetValue(gladys, { feature: { external_id: ids(gladys).feature('power_ac') }, value: 1, config }),
    /No command handler/,
  );
});

test('onSetValue sends the heartbeat then the command register', async () => {
  const client = commandClient();
  setClientFactoryForTests(() => client);
  const gladys = createFakeGladys();
  const running = ids(gladys).feature('running');

  await inverter.onSetValue(gladys, { feature: { external_id: running }, value: 0, config });
  await inverter.onSetValue(gladys, { feature: { external_id: running }, value: 1, config });

  assert.deepEqual(client.writes, [
    [49999, 1], // heartbeat renews the write session
    [40201, 0], // shutdown command (the value written is always 0)
    [49999, 1],
    [40200, 0], // startup command
  ]);
});

test('onSetValue accepts the boolean spellings of the switch', async () => {
  const client = commandClient();
  setClientFactoryForTests(() => client);
  const gladys = createFakeGladys();
  const running = { external_id: ids(gladys).feature('running') };

  await inverter.onSetValue(gladys, { feature: running, value: true, config });
  await inverter.onSetValue(gladys, { feature: running, value: '1', config });
  await inverter.onSetValue(gladys, { feature: running, value: false, config });
  await inverter.onSetValue(gladys, { feature: running, value: '0', config });

  assert.deepEqual(
    client.writes.filter(([address]) => address !== 49999),
    [[40200, 0], [40200, 0], [40201, 0], [40201, 0]],
  );
});

test('onSetValue rejects a value it cannot interpret, nothing is written', async () => {
  const client = commandClient();
  setClientFactoryForTests(() => client);
  const gladys = createFakeGladys();
  await assert.rejects(
    inverter.onSetValue(gladys, { feature: { external_id: ids(gladys).feature('running') }, value: 42, config }),
    /Invalid on\/off value/,
  );
  assert.deepEqual(client.writes, [], 'no write before the value is validated');
});

test('an exception on the command register explains the permission problem', async () => {
  const client = commandClient({
    writeError: Object.assign(new Error('Modbus exception 2: illegal data address'), { code: 2 }),
  });
  setClientFactoryForTests(() => client);
  const gladys = createFakeGladys();
  await assert.rejects(
    inverter.onSetValue(gladys, { feature: { external_id: ids(gladys).feature('running') }, value: 0, config }),
    /refused the on\/off command.*(permissions|installer)/s,
  );
});

test('a failed heartbeat does not block the command', async () => {
  const writes = [];
  const base = stubClient();
  setClientFactoryForTests(() => ({
    readRegisters: base.readRegisters,
    writeRegister: async (address, value) => {
      if (address === 49999) {
        throw new Error('heartbeat refused');
      }
      writes.push([address, value]);
    },
  }));
  const gladys = createFakeGladys();
  await inverter.onSetValue(gladys, { feature: { external_id: ids(gladys).feature('running') }, value: 0, config });
  assert.deepEqual(writes, [[40201, 0]], 'the shutdown command is still sent');
});

test('the running switch feedback follows the status register', async () => {
  const gladys = createFakeGladys();

  // On-grid: the switch reports ON.
  setClientFactoryForTests(() => stubClient({ power: powerBlock({ status: 0x0200 }) }));
  await inverter.onPoll(gladys, config);
  assert.equal(gladys.fake.lastState(ids(gladys).feature('running')), 1);

  // Shutdown (command or fault): the switch reports OFF.
  setClientFactoryForTests(() => stubClient({ power: powerBlock({ status: 0x0301 }) }));
  await inverter.onPoll(gladys, config);
  assert.equal(gladys.fake.lastState(ids(gladys).feature('running')), 0);

  // Standby (no irradiation) says nothing about the commanded state: the
  // feature keeps its last known value (no new state published).
  setClientFactoryForTests(() => stubClient({ power: powerBlock({ status: 0xa000 }) }));
  await inverter.onPoll(gladys, config);
  assert.equal(gladys.fake.lastState(ids(gladys).feature('running')), 0, 'standby keeps the last known value');
});

test('parseIdentity decodes model, serial and rated power', () => {
  const { model, serial, ratedPower } = parseIdentity(identityBlock());
  assert.equal(model, 'SUN2000-5KTL-L1');
  assert.equal(serial, 'HW5KTL1234');
  assert.equal(ratedPower, 5000);
});

test('the test_connection action answers in both languages', async () => {
  setClientFactoryForTests(() => stubClient());
  const gladys = createFakeGladys();
  const message = await inverter.actions.test_connection(gladys, { fields: {}, config });
  assert.match(message.fr, /SUN2000-5KTL-L1/);
  assert.match(message.fr, /HW5KTL1234/);
  assert.match(message.fr, /5\.0 kW/);
  assert.match(message.fr, /état : connecté au réseau/);
  assert.match(message.en, /serial HW5KTL1234/);
  assert.match(message.en, /rated 5\.0 kW/);
  assert.match(message.en, /status: on_grid/);
});

test('findBlueprintByDevice routes the device back to its blueprint', () => {
  const gladys = createFakeGladys();
  const found = findBlueprintByDevice(gladys, { external_id: inverter.deviceExternalId(gladys) });
  assert.equal(found, inverter);
  assert.equal(findBlueprintByDevice(gladys, { external_id: 'does-not-exist' }), undefined);
});
