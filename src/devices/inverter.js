// -----------------------------------------------------------------------------
// Device type: HUAWEI SUN2000 SOLAR INVERTER.
//
// One physical inverter = one Gladys device. The values come from the local
// Modbus TCP interface (see src/modbus.js), registers are the Huawei "Solar
// Inverter Modbus Interface Definitions" (Smart Dongle / SmartLogger):
//
//   30000..30074  identity : model string, serial number, rated power
//   32016..32023  PV strings 1-4 : voltage / current
//   32064..32090  power     : DC input, grid voltages/currents, AC power,
//                             reactive power, power factor, frequency,
//                             efficiency, temperature, device status, fault
//   32106..32115  energy    : total yield, daily yield
//   37100..37125  power meter (only when a Smart Power Sensor is installed):
//                             signed grid power, feed-in and consumed energy
//   40200, 40201  commands  : startup / shutdown (write-only, value 0)
//   49999         heartbeat : magic register written (value 1) before a
//                             command, it renews the write session
//
// Blocks are read independently: a block the inverter refuses (old firmware,
// missing power meter, single-phase model) simply does not publish its states.
// The two "core" blocks — identity and power — must both answer: failing both
// flags the inverter unreachable.
//
// All units are converted to what Gladys expects: W, V, A, kWh, °C, Hz... the
// Huawei "gain" (value in 0.001 kW for powers, /10 for voltages...) is applied
// at decoding time.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { createModbusClient } from '../modbus.js';

const DEVICE_TYPE = 'inverter';

// Stable platform identifier: one integration instance drives one inverter, and
// an external_id is forever (it keys the device, its history, scenes and
// dashboards). Deliberately NOT the IP address or the serial number: both may
// change, and a changed external_id would orphan the existing device.
const PLATFORM_DEVICE_ID = 'huawei-sun2000';

const logger = createLogger({ name: DEVICE_TYPE });

const FEATURE = {
  POWER_AC: 'power_ac',
  DC_POWER: 'dc_power',
  PEAK_POWER: 'peak_power',
  DAILY_YIELD: 'daily_yield',
  TOTAL_YIELD: 'total_yield',
  PV1_VOLTAGE: 'pv1_voltage',
  PV1_CURRENT: 'pv1_current',
  PV2_VOLTAGE: 'pv2_voltage',
  PV2_CURRENT: 'pv2_current',
  PV3_VOLTAGE: 'pv3_voltage',
  PV3_CURRENT: 'pv3_current',
  PV4_VOLTAGE: 'pv4_voltage',
  PV4_CURRENT: 'pv4_current',
  GRID_VOLTAGE_AB: 'grid_volt_ab',
  GRID_VOLTAGE_BC: 'grid_volt_bc',
  GRID_VOLTAGE_CA: 'grid_volt_ca',
  CURRENT_A: 'current_a',
  CURRENT_B: 'current_b',
  CURRENT_C: 'current_c',
  REACTIVE_POWER: 'reactive_power',
  POWER_FACTOR: 'power_factor',
  FREQUENCY: 'frequency',
  EFFICIENCY: 'efficiency',
  TEMPERATURE: 'temperature',
  STATUS: 'status',
  FAULT: 'fault',
  RUNNING: 'running',
  METER_POWER: 'meter_power',
  METER_IMPORT_INDEX: 'meter_import_index',
  METER_EXPORT_INDEX: 'meter_export_index',
};

// Modbus read blocks. `start` is a Huawei register number (wire address).
const BLOCKS = {
  identity: { start: 30000, count: 75 },
  strings: { start: 32016, count: 8 },
  power: { start: 32064, count: 27 },
  energy: { start: 32106, count: 10 },
  meter: { start: 37100, count: 26 },
};

// Command registers (write-only, per the Huawei interface definitions the
// value written is 0 for both commands). 49999 is the undocumented "magic"
// register the official tooling writes (value 1) before a command: it keeps
// the write session alive. Same behavior as the Home Assistant integration.
const COMMANDS = {
  STARTUP: 40200,
  SHUTDOWN: 40201,
  HEARTBEAT: 49999,
};

// Device status (register 32089), mapped to stable enum values.
const DEVICE_STATUSES = [
  { value: 'standby', label: 'Veille' },
  { value: 'starting', label: 'Démarrage' },
  { value: 'on_grid', label: 'Connecté au réseau' },
  { value: 'on_grid_derating', label: 'Connecté (puissance limitée)' },
  { value: 'off_grid', label: 'Hors réseau' },
  { value: 'shutdown', label: 'Arrêté' },
  { value: 'grid_scheduling', label: 'Planification réseau' },
  { value: 'spot_check', label: 'Diagnostic' },
  { value: 'unknown', label: 'Inconnu' },
];

const STATUS_CODES = new Map([
  [0x0000, 'standby'], // standby: initializing
  [0x0100, 'starting'],
  [0x0200, 'on_grid'],
  [0x0201, 'on_grid_derating'], // grid-connected: power limited
  [0x0202, 'on_grid_derating'], // grid-connected: self-derating
  [0x0203, 'off_grid'],
  [0x0300, 'shutdown'], // shutdown: fault
  [0x0301, 'shutdown'], // shutdown: command
  [0x0302, 'shutdown'], // shutdown: OVGR
  [0x0303, 'shutdown'], // shutdown: communication
  [0x0304, 'shutdown'], // shutdown: power rationing
  [0x0305, 'shutdown'], // shutdown: manual startup required
  [0x0306, 'shutdown'], // shutdown: rapid cut-off
  [0x0307, 'shutdown'], // shutdown: input undercurrent
  [0x0308, 'shutdown'],
  [0x0401, 'grid_scheduling'],
  [0x0402, 'grid_scheduling'],
  [0x0403, 'grid_scheduling'],
  [0x0404, 'grid_scheduling'],
  [0x0500, 'spot_check'],
  [0x0501, 'spot_check'],
  [0x0a00, 'off_grid'], // off-grid charging
  [0xa000, 'standby'], // standby: no irradiation
]);

// Status families used for the on/off switch feedback (register 32089).
const RUNNING_STATUS_VALUES = new Set(['starting', 'on_grid', 'on_grid_derating', 'off_grid']);
const SHUTDOWN_STATUS_VALUES = new Set(['shutdown']);

function isRunningStatus(statusCode) {
  const value = STATUS_CODES.get(statusCode);
  return value !== undefined && RUNNING_STATUS_VALUES.has(value);
}

function isShutdownStatus(statusCode) {
  const value = STATUS_CODES.get(statusCode);
  return value !== undefined && SHUTDOWN_STATUS_VALUES.has(value);
}

// Last reported connection state: setConnectionStatus is only called on a
// change, not on every poll.
let lastConnectionState = null;
// Client factory: the inverter is reached through this seam, so the tests can
// substitute a stub and never touch the network.
let clientFactory = createModbusClient;

/**
 * @description Replace the Modbus client factory (tests only). Pass `null` to
 * restore the real implementation.
 * @param {Function|null} factory `(config) => client`
 */
export function setClientFactoryForTests(factory) {
  clientFactory = factory || createModbusClient;
}

function getClient(config) {
  return clientFactory(config);
}

/**
 * @description Forget the reported connection state (config change or
 * reconnection: both may reach another inverter).
 */
export function resetConnectionCache() {
  lastConnectionState = null;
}

async function reportConnection(gladys, reachable, error) {
  if (lastConnectionState === reachable) {
    return;
  }
  lastConnectionState = reachable;
  try {
    if (reachable) {
      await gladys.setConnectionStatus(true);
      return;
    }
    const reason = String(error?.message ?? error ?? 'unknown error').slice(0, 160);
    await gladys.setConnectionStatus(false, {
      en: `Inverter unreachable: ${reason}`,
      fr: `Onduleur injoignable : ${reason}`,
    });
  } catch (e) {
    // The status is cosmetic: never let it break a poll.
    logger.debug('Unable to publish the connection status', e);
  }
}

// --- Register decoding helpers ------------------------------------------------
// All registers are big-endian 16-bit words (Huawei word order: high word of a
// 32-bit value first). Powers carry a gain of 1000 on kW: the raw value IS the
// power in W.

const u16 = (regs, index) => regs[index];
const i16 = (regs, index) => (regs[index] << 16) >> 16;
const u32 = (regs, index) => regs[index] * 65536 + regs[index + 1];
const i32 = (regs, index) => (regs[index] * 65536 + regs[index + 1]) | 0;

function ascii(regs, index, length) {
  let text = '';
  for (let offset = 0; offset < length; offset += 1) {
    const word = regs[index + offset];
    text += String.fromCharCode((word >> 8) & 0xff, word & 0xff);
  }
  return text.replace(/\0+/g, '').trim();
}

/**
 * @description Turn one set of Modbus block reads into the list of Gladys
 * states. Missing values (block refused by the firmware, power meter absent,
 * single-phase model) are simply skipped: an unknown state is better than a
 * fabricated one.
 * @param {object} ids external ids helper of the device
 * @param {object} reads { identity, strings, power, energy, meter } register
 *   blocks (Uint16Array or null)
 * @returns {Array<object>} batch for gladys.publishStates
 */
export function buildStates(ids, { identity, strings, power, energy, meter } = {}) {
  const states = [];
  const addNumber = (key, state) => {
    if (Number.isFinite(state)) {
      states.push({ device_feature_external_id: ids.feature(key), state });
    }
  };
  const addText = (key, text) => {
    if (typeof text === 'string' && text.length > 0) {
      states.push({ device_feature_external_id: ids.feature(key), text });
    }
  };

  if (power) {
    // Instantaneous powers (registers carry 0.001 kW units, i.e. W).
    const acPower = i32(power, 16); // 32080 active power
    // A solar inverter never consumes AC power (night reactive-compensation
    // mode can read slightly negative): the production feature stays >= 0.
    addNumber(FEATURE.POWER_AC, acPower > 0 ? acPower : 0);
    addNumber(FEATURE.DC_POWER, Math.max(0, i32(power, 0))); // 32064 DC input
    addNumber(FEATURE.PEAK_POWER, Math.max(0, i32(power, 14))); // 32078 day peak
    addNumber(FEATURE.REACTIVE_POWER, i32(power, 18)); // 32082, var

    const factor = i16(power, 20) / 1000; // 32084
    if (factor !== 0) {
      addNumber(FEATURE.POWER_FACTOR, factor);
    }
    const frequency = u16(power, 21) / 100; // 32085
    if (frequency > 0) {
      addNumber(FEATURE.FREQUENCY, frequency);
    }
    const efficiency = u16(power, 22) / 100; // 32086
    if (efficiency > 0 && efficiency <= 100) {
      addNumber(FEATURE.EFFICIENCY, efficiency);
    }
    const temperature = i16(power, 23) / 10; // 32087
    if (temperature > -50 && temperature < 150) {
      addNumber(FEATURE.TEMPERATURE, temperature);
    }

    // Grid voltages (32066-32068, /10 V). 32066 is the grid voltage on a
    // single-phase model and the A-B line voltage on a three-phase one; a zero
    // reading means "not valid on this output mode": the feature is skipped
    // rather than published as 0 V.
    const voltages = [
      [FEATURE.GRID_VOLTAGE_AB, 2],
      [FEATURE.GRID_VOLTAGE_BC, 3],
      [FEATURE.GRID_VOLTAGE_CA, 4],
    ];
    for (const [key, index] of voltages) {
      const raw = u16(power, index);
      if (raw > 0) {
        addNumber(key, raw / 10);
      }
    }

    // Phase currents (32072-32077, mA).
    addNumber(FEATURE.CURRENT_A, i32(power, 8) / 1000);
    addNumber(FEATURE.CURRENT_B, i32(power, 10) / 1000);
    addNumber(FEATURE.CURRENT_C, i32(power, 12) / 1000);

    addText(FEATURE.STATUS, STATUS_CODES.get(u16(power, 25)) ?? 'unknown'); // 32089
    addNumber(FEATURE.FAULT, u16(power, 26) !== 0 ? 1 : 0); // 32090 fault code

    // The on/off switch feedback is derived from the status register, the only
    // honest source (the command registers are write-only). Shutdown codes are
    // OFF, starting/on-grid codes are ON; the standby codes ("no irradiation",
    // initializing) say nothing about the commanded state: the feature keeps
    // its last known value instead of being published.
    const statusCode = u16(power, 25);
    if (isRunningStatus(statusCode)) {
      addNumber(FEATURE.RUNNING, 1);
    } else if (isShutdownStatus(statusCode)) {
      addNumber(FEATURE.RUNNING, 0);
    }
  }

  if (strings) {
    // PV strings 1-4 (32016+, /10 V and /100 A). A string the inverter does
    // not have reads 0 V: both its features are skipped.
    for (let stringIndex = 1; stringIndex <= 4; stringIndex += 1) {
      const base = 2 * (stringIndex - 1);
      const rawVoltage = i16(strings, base);
      if (rawVoltage > 0) {
        addNumber(`pv${stringIndex}_voltage`, rawVoltage / 10);
        const rawCurrent = i16(strings, base + 1);
        if (rawCurrent >= 0) {
          addNumber(`pv${stringIndex}_current`, rawCurrent / 100);
        }
      }
    }
  }

  if (energy) {
    const total = u32(energy, 0) / 100; // 32106, kWh
    if (total > 0) {
      addNumber(FEATURE.TOTAL_YIELD, total);
    }
    const daily = u32(energy, 8) / 100; // 32114, kWh
    if (daily >= 0 && (daily > 0 || total > 0)) {
      addNumber(FEATURE.DAILY_YIELD, daily);
    }
  }

  if (meter) {
    // The power meter block only exists when a Smart Power Sensor (DTSU666) is
    // installed and reports itself: status register 1 = normal.
    if (u16(meter, 0) === 1) {
      // Huawei reports the grid exchange with a POSITIVE value when feeding
      // the grid; the `grid-sensor` POWER convention is import > 0.
      addNumber(FEATURE.METER_POWER, -i32(meter, 13)); // 37113, W
      const exportIndex = u32(meter, 19) / 100; // 37119 feed-in energy, kWh
      if (exportIndex > 0) {
        addNumber(FEATURE.METER_EXPORT_INDEX, exportIndex);
      }
      const importIndex = u32(meter, 21) / 100; // 37121 consumed energy, kWh
      if (importIndex > 0) {
        addNumber(FEATURE.METER_IMPORT_INDEX, importIndex);
      }
    }
  }

  return states;
}

export function parseIdentity(identity) {
  if (!identity) {
    return {};
  }
  const ratedPower = u32(identity, 73); // 30073, W
  return {
    model: ascii(identity, 0, 15) || 'SUN2000',
    serial: ascii(identity, 15, 10) || '-',
    ratedPower: Number.isFinite(ratedPower) && ratedPower > 0 ? ratedPower : undefined,
  };
}

export const inverter = {
  key: DEVICE_TYPE,

  deviceExternalId(gladys) {
    return gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID).device;
  },

  buildDevice(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID);
    const feature = (name, key, category, type, { unit, min = 0, max = 100, keepHistory = false } = {}) => ({
      name,
      external_id: ids.feature(key),
      category,
      type,
      ...(unit ? { unit } : {}),
      min,
      max,
      read_only: true,
      has_feedback: false,
      keep_history: keepHistory,
    });

    return {
      name: 'Onduleur Huawei SUN2000',
      external_id: ids.device,
      // Gladys polls the device once a minute; the user's own refresh interval
      // is applied by the poll dispatcher (createPoller in ./index.js).
      should_poll: true,
      poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
      features: [
        feature('Puissance produite (AC)', FEATURE.POWER_AC, DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.POWER, { unit: DEVICE_FEATURE_UNITS.WATT, max: 200000, keepHistory: true }),
        feature('Puissance d\u2019entrée DC', FEATURE.DC_POWER, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER, { unit: DEVICE_FEATURE_UNITS.WATT, max: 200000, keepHistory: true }),
        feature('Puissance crête du jour', FEATURE.PEAK_POWER, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER, { unit: DEVICE_FEATURE_UNITS.WATT, max: 200000 }),
        feature('Production du jour', FEATURE.DAILY_YIELD, DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION, { unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR, max: 1000000, keepHistory: true }),
        feature('Production totale', FEATURE.TOTAL_YIELD, DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.INDEX, { unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR, max: 1000000, keepHistory: true }),

        feature('Tension string 1', FEATURE.PV1_VOLTAGE, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE, { unit: DEVICE_FEATURE_UNITS.VOLT, max: 1000 }),
        feature('Courant string 1', FEATURE.PV1_CURRENT, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT, { unit: DEVICE_FEATURE_UNITS.AMPERE, max: 100 }),
        feature('Tension string 2', FEATURE.PV2_VOLTAGE, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE, { unit: DEVICE_FEATURE_UNITS.VOLT, max: 1000 }),
        feature('Courant string 2', FEATURE.PV2_CURRENT, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT, { unit: DEVICE_FEATURE_UNITS.AMPERE, max: 100 }),
        feature('Tension string 3', FEATURE.PV3_VOLTAGE, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE, { unit: DEVICE_FEATURE_UNITS.VOLT, max: 1000 }),
        feature('Courant string 3', FEATURE.PV3_CURRENT, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT, { unit: DEVICE_FEATURE_UNITS.AMPERE, max: 100 }),
        feature('Tension string 4', FEATURE.PV4_VOLTAGE, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE, { unit: DEVICE_FEATURE_UNITS.VOLT, max: 1000 }),
        feature('Courant string 4', FEATURE.PV4_CURRENT, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT, { unit: DEVICE_FEATURE_UNITS.AMPERE, max: 100 }),

        feature('Tension réseau (A-B)', FEATURE.GRID_VOLTAGE_AB, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE, { unit: DEVICE_FEATURE_UNITS.VOLT, max: 1000 }),
        feature('Tension réseau (B-C)', FEATURE.GRID_VOLTAGE_BC, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE, { unit: DEVICE_FEATURE_UNITS.VOLT, max: 1000 }),
        feature('Tension réseau (C-A)', FEATURE.GRID_VOLTAGE_CA, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE, { unit: DEVICE_FEATURE_UNITS.VOLT, max: 1000 }),
        feature('Courant phase A', FEATURE.CURRENT_A, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT, { unit: DEVICE_FEATURE_UNITS.AMPERE, max: 200 }),
        feature('Courant phase B', FEATURE.CURRENT_B, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT, { unit: DEVICE_FEATURE_UNITS.AMPERE, max: 200 }),
        feature('Courant phase C', FEATURE.CURRENT_C, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT, { unit: DEVICE_FEATURE_UNITS.AMPERE, max: 200 }),

        feature('Puissance réactive', FEATURE.REACTIVE_POWER, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.SENSOR.DECIMAL, { unit: DEVICE_FEATURE_UNITS.VOLT_AMPERE_REACTIVE, min: -200000, max: 200000 }),
        feature('Facteur de puissance', FEATURE.POWER_FACTOR, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.SENSOR.DECIMAL, { min: -1, max: 1 }),
        feature('Fréquence réseau', FEATURE.FREQUENCY, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.SENSOR.DECIMAL, { max: 100 }),
        feature('Rendement', FEATURE.EFFICIENCY, DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR, DEVICE_FEATURE_TYPES.SENSOR.DECIMAL, { unit: DEVICE_FEATURE_UNITS.PERCENT, max: 100 }),
        feature('Température interne', FEATURE.TEMPERATURE, DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR, DEVICE_FEATURE_TYPES.SENSOR.DECIMAL, { unit: DEVICE_FEATURE_UNITS.CELSIUS, min: -50, max: 150 }),

        {
          name: 'État de l\u2019onduleur',
          external_id: ids.feature(FEATURE.STATUS),
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
          supported_options: DEVICE_STATUSES,
          min: 0,
          max: 100,
          read_only: true,
          has_feedback: false,
          keep_history: false,
        },
        {
          // On/off command (registers 40200/40201). Write-only registers: the
          // displayed state is derived from the status register at each poll.
          name: 'Marche / Arrêt de l\u2019onduleur',
          external_id: ids.feature(FEATURE.RUNNING),
          category: DEVICE_FEATURE_CATEGORIES.SWITCH,
          type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
          min: 0,
          max: 1,
          read_only: false,
          has_feedback: true,
          keep_history: false,
        },
        feature('Anomalie (code défaut)', FEATURE.FAULT, DEVICE_FEATURE_CATEGORIES.SWITCH, DEVICE_FEATURE_TYPES.SWITCH.BINARY, { max: 1, keepHistory: true }),

        feature('Puissance réseau (compteur)', FEATURE.METER_POWER, DEVICE_FEATURE_CATEGORIES.GRID_SENSOR, DEVICE_FEATURE_TYPES.GRID_SENSOR.POWER, { unit: DEVICE_FEATURE_UNITS.WATT, min: -200000, max: 200000, keepHistory: true }),
        feature('Énergie soutirée (compteur)', FEATURE.METER_IMPORT_INDEX, DEVICE_FEATURE_CATEGORIES.GRID_SENSOR, DEVICE_FEATURE_TYPES.GRID_SENSOR.INPUT_INDEX, { unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR, max: 1000000, keepHistory: true }),
        feature('Énergie injectée (compteur)', FEATURE.METER_EXPORT_INDEX, DEVICE_FEATURE_CATEGORIES.GRID_SENSOR, DEVICE_FEATURE_TYPES.GRID_SENSOR.OUTPUT_INDEX, { unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR, max: 1000000, keepHistory: true }),
      ],
    };
  },

  // Manifest action: "Test the connection" (Configuration screen).
  actions: {
    async test_connection(gladys, { config }) {
      logger.info('Action test_connection -> live read of the inverter');
      const client = getClient(config);
      const identity = await client.readRegisters(BLOCKS.identity.start, BLOCKS.identity.count);
      const power = await client.readRegisters(BLOCKS.power.start, BLOCKS.power.count);
      const { model, serial, ratedPower } = parseIdentity(identity);
      const statusCode = u16(power, 25);
      const statusValue = STATUS_CODES.get(statusCode) ?? 'unknown';
      const statusLabel = DEVICE_STATUSES.find((option) => option.value === statusValue)?.label ?? statusValue;
      const fault = u16(power, 26);
      await reportConnection(gladys, true);
      const rated = ratedPower !== undefined ? (ratedPower / 1000).toFixed(1) : '?';
      return {
        en: `${model} (serial ${serial}, rated ${rated} kW) - status: ${statusValue}, fault code: ${fault}.`,
        fr: `${model} (n° ${serial}, ${rated} kW nominal) - état : ${statusLabel.toLowerCase()}, code défaut : ${fault}.`,
      };
    },
  },

  async onPoll(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID);
    const client = getClient(config);

    // Core blocks: both must answer, otherwise the inverter is unreachable.
    let identity;
    let power;
    try {
      identity = await client.readRegisters(BLOCKS.identity.start, BLOCKS.identity.count);
      power = await client.readRegisters(BLOCKS.power.start, BLOCKS.power.count);
    } catch (error) {
      await reportConnection(gladys, false, error);
      throw error;
    }

    // Optional blocks: a refused block (old firmware, no power meter,
    // registers the model does not carry) only means "no data this cycle".
    const optional = {};
    for (const name of ['strings', 'energy', 'meter']) {
      const block = BLOCKS[name];
      try {
        optional[name] = await client.readRegisters(block.start, block.count);
      } catch (error) {
        optional[name] = null;
        logger.debug(`Block ${block.start}+${block.count} not available: ${error.message}`);
      }
    }

    const states = buildStates(ids, { identity, power, ...optional });
    logger.debug(`Poll: ${states.length} value(s) read`);
    if (states.length > 0) {
      await gladys.publishStates(states);
    }
    await reportConnection(gladys, true);
  },

  async onSetValue(gladys, { feature, value, config }) {
    const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID);
    if (feature.external_id !== ids.feature(FEATURE.RUNNING)) {
      throw new Error(`No command handler for ${feature.external_id}`);
    }

    const client = getClient(config);
    const command = value === 1 || value === true || value === '1' ? COMMANDS.STARTUP : null;
    const shutdown = value === 0 || value === false || value === '0';
    if (command === null && !shutdown) {
      throw new Error(`Invalid on/off value: ${value} (use 1 to start, 0 to shut down)`);
    }

    // The write session is renewed first: the undocumented register 49999 is
    // what the official tooling writes before a command. A refusal here is
    // only logged: the command itself tells the truth.
    try {
      await client.writeRegister(COMMANDS.HEARTBEAT, 1);
    } catch (error) {
      logger.debug(`Heartbeat write failed, trying the command anyway: ${error.message}`);
    }

    try {
      await client.writeRegister(command ?? COMMANDS.SHUTDOWN, 0);
    } catch (error) {
      if (error?.code === 2 || /illegal data address/.test(String(error?.message))) {
        // Per the Huawei interface definitions the address is right: on many
        // firmwares this exception means the command needs installer-level
        // rights, or the inverter refuses remote commands in its current
        // state (some models cannot be re-enabled remotely at all, see
        // docs/fr.md).
        throw new Error(
          'The inverter refused the on/off command (illegal data address): it may require ' +
            'installer-level permissions or refuse remote commands in its current state.',
        );
      }
      throw error;
    }
  },
};
