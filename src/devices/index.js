// -----------------------------------------------------------------------------
// Device registry.
//
// Each device lives in its own file and exposes:
//   - key                        : short identifier (used in logs)
//   - deviceExternalId(gladys)   : the device external_id (for dispatch)
//   - buildDevice(gladys, config): the discovery payload sent to Gladys
//   - onPoll(gladys, config)     : periodic read (device published with a
//                                  `poll_frequency`)
//   - onSetValue(gladys, {...})  : run a user command
//   - actions                    : manifest action handlers, keyed by the
//                                  `actions` key of the manifest
// -----------------------------------------------------------------------------

import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';
import { inverter } from './inverter.js';

export const DEVICE_BLUEPRINTS = [inverter];

/**
 * Build the discovery payload for Gladys (all devices).
 */
export function buildDiscoveredDevices(gladys, config) {
  return DEVICE_BLUEPRINTS.map((bp) => bp.buildDevice(gladys, config));
}

/**
 * Find the blueprint that owns a given device, from its external_id
 * (used to route onPoll / onSetValue to the right device).
 */
export function findBlueprintByDevice(gladys, device) {
  return DEVICE_BLUEPRINTS.find((bp) => bp.deviceExternalId(gladys) === device.external_id);
}

// Gladys' poll ticks drift by a few milliseconds: a read due within the next
// half-minute runs now, so a 300 s interval does not slip to 360 s.
const POLL_TOLERANCE_MS = DEVICE_POLL_FREQUENCIES.EVERY_MINUTES / 2;

/**
 * Create the `onPoll` dispatcher: route the poll to the owner blueprint, at
 * the refresh interval the user chose (`poll_frequency` config, in seconds).
 *
 * Gladys polls a device at a fixed pace (at most once a minute,
 * DEVICE_POLL_FREQUENCIES). The slower interval of the config is applied here
 * by skipping the polls in between: the user can change it at any time,
 * without re-creating the device.
 *
 * Resolves `true` when the device was read, `false` when the poll was skipped.
 * A read that throws is retried at the next poll.
 */
export function createPoller() {
  const lastReads = new Map();
  return async function pollDevice(gladys, device, config) {
    const blueprint = findBlueprintByDevice(gladys, device);
    if (!blueprint || typeof blueprint.onPoll !== 'function') {
      return false;
    }
    const now = Date.now();
    const lastRead = lastReads.get(device.external_id);
    if (lastRead !== undefined && now - lastRead < config.poll_frequency * 1000 - POLL_TOLERANCE_MS) {
      return false;
    }
    await blueprint.onPoll(gladys, config);
    lastReads.set(device.external_id, now);
    return true;
  };
}
