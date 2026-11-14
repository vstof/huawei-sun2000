// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys from the `config_schema` of
// `gladys-assistant-integration.json`. The SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in
// the `config_schema` of the manifest (test/manifest.test.js pins it).
export const DEFAULT_CONFIG = {
  host: '',
  // Modbus TCP port of the Smart Dongle / SmartLogger (502 is the standard).
  port: 502,
  // Modbus slave id. Huawei's interface definitions use 0 for the directly
  // connected device (the dongle itself answers there); some dongle firmwares
  // answer on 1 instead — both are one field away.
  unit_id: 0,
  // Seconds between two reads of the polled values. Gladys polls at most once
  // a minute: slower intervals are applied by skipping polls (see createPoller
  // in src/devices/index.js). A fast inverter read is cheap, but the dongle is
  // a small embedded server: leave it some air.
  poll_frequency: 60,
};

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const port = Number(raw.port ?? DEFAULT_CONFIG.port);
  const unitId = Number(raw.unit_id ?? DEFAULT_CONFIG.unit_id);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    host: String(raw.host ?? DEFAULT_CONFIG.host).trim(),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_CONFIG.port,
    unit_id: Number.isInteger(unitId) && unitId >= 0 && unitId <= 247 ? unitId : DEFAULT_CONFIG.unit_id,
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
  };
}
