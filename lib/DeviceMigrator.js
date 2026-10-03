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
 * Capability migration for already paired devices. Same API and algorithm as
 * com.kia_hyundai's lib/DeviceMigrator.js, so the apps cannot drift apart on it.
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
/** Pause after every add/remove to give Homey time to settle (com.kia_hyundai uses 2 s). */
const SETTLE_MS = 1000;

const settle = (device) => new Promise((resolve) => {
  device.homey.setTimeout(resolve, SETTLE_MS);
});

module.exports = {

  /**
   * Repair a device's capability list - existence and order - against `correctCaps`.
   * The list is snapshotted once, then one removal pass and one addition pass from the first
   * mismatch: re-reading getCapabilities() after every change turns O(n) into O(n^2).
   * @returns {Promise<boolean>} whether the list was touched. A removed-and-re-added capability
   *   comes back with the manifest's options, so callers must re-apply their own afterwards.
   */
  async migrateCapabilities(device, correctCaps) {
    const caps = device.getCapabilities();
    let firstMismatch = 0;
    while (firstMismatch < Math.max(caps.length, correctCaps.length)
      && caps[firstMismatch] === correctCaps[firstMismatch]) firstMismatch += 1;
    if (firstMismatch === Math.max(caps.length, correctCaps.length)) return false;

    device.log(`migrating capabilities for ${device.getName()}`);
    const state = {};
    caps.forEach((cap) => {
      state[cap] = device.getCapabilityValue(cap);
    });
    const wasAvailable = device.getAvailable();
    await device.setUnavailable(device.homey.__('status.migrating')).catch((error) => device.error(error));

    // From the first mismatch onward, which also covers trailing caps no longer wanted at all.
    for (const cap of caps.slice(firstMismatch)) {
      if (!device.hasCapability(cap)) continue;
      device.log(`removing capability ${cap}`);
      // eslint-disable-next-line no-await-in-loop
      await device.removeCapability(cap).catch((error) => device.error(error));
      // eslint-disable-next-line no-await-in-loop
      await settle(device);
    }

    for (const cap of correctCaps.slice(firstMismatch)) {
      if (!device.hasCapability(cap)) {
        device.log(`adding capability ${cap}`);
        // eslint-disable-next-line no-await-in-loop
        await device.addCapability(cap).catch((error) => device.error(error));
        // eslint-disable-next-line no-await-in-loop
        await settle(device);
      }
      if (state[cap] === undefined || state[cap] === null) continue;
      // eslint-disable-next-line no-await-in-loop
      await device.setCapabilityValue(cap, state[cap]).catch((error) => device.error(error));
    }

    // Only undo our own 'migrating' state; an unreachable device stays unavailable.
    if (wasAvailable) await device.setAvailable().catch((error) => device.error(error));
    return true;
  },

  /**
   * Bring capability options that depend on the unit (e.g. a range up to its rated power) in
   * line with `wanted` ({ capability: options }).
   *
   * Merged onto the driver manifest's options rather than sent alone, so a manifest title is
   * not silently dropped (as com.kia_hyundai's sync*Units() do). The live options are read to
   * skip needless writes; that read can throw "Invalid Capability" - for a capability without
   * options, or right after a boot - which then just costs one redundant write.
   */
  async syncCapabilityOptions(device, wanted) {
    const manifestOptions = device.driver.manifest.capabilitiesOptions || {};
    for (const [cap, options] of Object.entries(wanted)) {
      if (!device.hasCapability(cap)) continue;
      let current = {};
      try {
        current = device.getCapabilityOptions(cap) || {};
      } catch {
        current = {};
      }
      if (Object.entries(options).every(([key, value]) => current[key] === value)) continue;
      device.log(`capability options for ${cap}:`, JSON.stringify(options));
      // eslint-disable-next-line no-await-in-loop
      await device.setCapabilityOptions(cap, { ...(manifestOptions[cap] || {}), ...options })
        .catch((error) => device.error(error));
    }
  },

};
