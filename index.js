// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/). It holds
// NO hardware logic: all the reading "work" lives in the device modules. This
// file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects and publishes the discovered devices.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { t, bilingual } from './src/i18n.js';
import { registerWidgets } from './src/widgets.js';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  createPoller,
  findBlueprintByDevice,
} from './src/devices/index.js';
import { resetConnectionCache } from './src/devices/inverter.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// --- Discovery: Gladys asks for the list of devices --------------------------
// No live read here: discovery works even while the inverter is offline, the
// features that this model does not carry simply stay silent.
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the discovered device');
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
});

// --- Command: the user acts on a controllable feature ------------------------
// Only the on/off switch (feature `running`) is writable: any other feature
// throws a readable error, which the SDK turns into a success:false
// acknowledgement.
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const blueprint = findBlueprintByDevice(gladys, device);
  if (!blueprint || typeof blueprint.onSetValue !== 'function') {
    throw new Error(`${t('no_command_handler')} (${device.external_id})`);
  }
  await blueprint.onSetValue(gladys, { device, feature, value, config });
});

// --- Polling: Gladys asks to refresh the device ------------------------------
// Gladys polls the devices published with a `poll_frequency` once a minute;
// the poller reads them at the interval the user chose in the config.
const pollDevice = createPoller();
gladys.onPoll(async (device) => {
  await pollDevice(gladys, device, config);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
// Each action declared in the `actions` field of the manifest is registered
// per key; the message resolved by the handler is displayed under the button.
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.actions ?? {})) {
    gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config }));
  }
}

// --- Dashboard widgets ---------------------------------------------------------
// Two widgets (see the manifest `widgets`): the live overview and the
// production statistics. Their content is built from the last poll snapshot
// and the accumulated statistics (/data), never from a direct Modbus read.
registerWidgets(gladys);

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // The address, the port or the slave id may have changed: forget what was
  // cached about the previous unit, then re-publish the (idempotent) devices.
  resetConnectionCache();
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle: these handlers only run the
// integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());
    resetConnectionCache();
    // 2) (Re)publish the device as soon as we are connected.
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
    // 3) The application-level status is published by the first poll: being
    // connected to Gladys says nothing about the inverter being reachable.
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, bilingual('init_failed'))
      .catch(() => {});
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Huawei SUN2000 integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
