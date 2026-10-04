/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.solarwatt.

com.solarwatt is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.solarwatt is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.solarwatt.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

/*
 * Capability migration for already paired devices. One file, kept identical (apart from the
 * licence header) in com.foxess and com.solarwatt so the two cannot drift apart again; the
 * algorithm is com.kia_hyundai's lib/DeviceMigrator.js.
 *
 * Homey orders tiles by the order in which capabilities were added, so a capability slotted
 * into the middle of the list has to be rebuilt from that point rather than appended - or it
 * lands at the bottom of the device page. Values are carried across the rebuild so restored
 * tiles are not blank until the next poll.
 *
 * Never delete a custom capability's definition in the release that drops it from a driver:
 * while a device still carries it, Homey rejects every add/removeCapability on that device
 * with "Invalid Capability" (homey-app-development skill, section 14).
 */

/** Pause after every add/remove to give Homey time to settle (com.kia_hyundai and com.growatt use 2 s). */
const SETTLE_MS = 2 * 1000;

const settle = (device, ms) => (ms > 0
  ? new Promise((resolve) => {
    device.homey.setTimeout(resolve, ms);
  })
  : Promise.resolve());

// One migration per device at a time. A device can ask for one (e.g. a newly reported optional
// capability) while the one from init is still settling; running both at once would have them
// remove and re-add each other's capabilities.
const running = new WeakMap();

const migrate = async (device, correctCaps, settleMs) => {
  if (!Array.isArray(correctCaps)) throw Error(`No capability list to migrate ${device.getName()} to`);
  const wanted = [...new Set(correctCaps.filter(Boolean))];

  const caps = device.getCapabilities();
  const maxLen = Math.max(caps.length, wanted.length);
  let firstMismatch = 0;
  while (firstMismatch < maxLen && caps[firstMismatch] === wanted[firstMismatch]) firstMismatch += 1;
  if (firstMismatch === maxLen) return false;

  // Nothing new and the rest already in order: only remove what is no longer wanted. A rebuild
  // from the first mismatch would remove and re-add every capability after it - and break the
  // flows and Insights on them - to drop one tile near the top.
  const keep = new Set(wanted);
  const kept = caps.filter((cap) => keep.has(cap));
  const onlyDrops = kept.length === wanted.length && kept.every((cap, i) => cap === wanted[i]);
  const toRemove = onlyDrops ? caps.filter((cap) => !keep.has(cap)) : caps.slice(firstMismatch);
  const toAdd = onlyDrops ? [] : wanted.slice(firstMismatch);

  device.log(`migrating capabilities for ${device.getName()} from index ${firstMismatch}:`,
    caps.slice(firstMismatch), '->', wanted.slice(firstMismatch));
  const state = {};
  caps.forEach((cap) => {
    state[cap] = device.getCapabilityValue(cap);
  });
  const wasAvailable = device.getAvailable();
  if (wasAvailable) await device.setUnavailable(device.homey.__('migrating')).catch((error) => device.error(error));

  try {
    // From the first mismatch onward (or only the dropped ones), which also covers trailing caps
    // no longer wanted at all.
    for (const cap of toRemove) {
      if (!device.hasCapability(cap)) continue;
      device.log(`removing capability ${cap}`);
      // eslint-disable-next-line no-await-in-loop
      await device.removeCapability(cap).catch((error) => device.error(error));
      // eslint-disable-next-line no-await-in-loop
      await settle(device, settleMs);
    }

    for (const cap of toAdd) {
      if (!device.hasCapability(cap)) {
        device.log(`adding capability ${cap}`);
        // eslint-disable-next-line no-await-in-loop
        await device.addCapability(cap).catch((error) => device.error(error));
        // eslint-disable-next-line no-await-in-loop
        await settle(device, settleMs);
      }
      // null is a real stored state (no value yet), and restoring it is a no-op, so skip it
      if (state[cap] === undefined || state[cap] === null) continue;
      // eslint-disable-next-line no-await-in-loop
      await device.setCapabilityValue(cap, state[cap]).catch((error) => device.error(error));
    }
  } finally {
    // Only undo our own 'migrating' state; an unreachable device stays unavailable.
    if (wasAvailable) await device.setAvailable().catch((error) => device.error(error));
  }
  return true;
};

// An option value as Homey stores it: a number or string, or an object such as a per-language
// title. `===` would call two equal titles different on every start and rewrite them each time;
// key order is not significant.
const sameOption = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameOption(a[key], b[key]));
};

module.exports = {

  /**
   * Repair a device's capability list - existence and order - against `correctCaps`.
   * The list is snapshotted once, then one removal pass and one addition pass from the first
   * mismatch: re-reading getCapabilities() after every change turns O(n) into O(n^2).
   * Everything before the first mismatch is left alone, so appending a capability never touches
   * the existing ones - or the flows that use them. Neither does dropping one: when nothing is
   * added, only the dropped capabilities are removed.
   * @param {Homey.Device} device the device to repair
   * @param {string[]} correctCaps the capability ids, in the order the device should have them
   * @param {object} [options]
   * @param {number} [options.settleMs] pause after each capability change (tests pass 0)
   * @returns {Promise<boolean>} whether the list was touched. A removed-and-re-added capability
   *   comes back with the manifest's options, so callers must re-apply their own afterwards.
   */
  async migrateCapabilities(device, correctCaps, { settleMs = SETTLE_MS } = {}) {
    const previous = running.get(device) || Promise.resolve();
    const job = previous.catch(() => null).then(() => migrate(device, correctCaps, settleMs));
    running.set(device, job);
    try {
      return await job;
    } finally {
      if (running.get(device) === job) running.delete(device);
    }
  },

  /**
   * Bring capability options that depend on the unit (e.g. a range up to its rated power) in
   * line with `wanted` ({ capability: options }).
   *
   * Merged onto the driver manifest's options rather than sent alone, so a manifest title is
   * not silently dropped (as com.kia_hyundai's sync*Units() do). The live options are read to
   * skip needless writes; that read can throw "Invalid Capability" - for a capability without
   * options, or right after a boot - which then just costs one redundant write.
   * @param {object} [settings]
   * @param {boolean} [settings.force] write without reading first - after a migration that rebuilt
   *   capabilities, whose options the read may not reflect yet
   */
  async syncCapabilityOptions(device, wanted, { force = false } = {}) {
    const manifestOptions = device.driver.manifest.capabilitiesOptions || {};
    for (const [cap, options] of Object.entries(wanted)) {
      if (!device.hasCapability(cap)) continue;
      let current = {};
      try {
        current = force ? {} : device.getCapabilityOptions(cap) || {};
      } catch {
        current = {};
      }
      if (Object.entries(options).every(([key, value]) => sameOption(current[key], value))) continue;
      device.log(`capability options for ${cap}:`, JSON.stringify(options));
      // eslint-disable-next-line no-await-in-loop
      await device.setCapabilityOptions(cap, { ...(manifestOptions[cap] || {}), ...options })
        .catch((error) => device.error(error));
    }
  },

};
