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

const Homey = require('homey');
const ModbusClient = require('./ModbusClient');
const CommonDevice = require('./common_device');
const pointMap = require('./solarwattPointMap');

const DEFAULT_PORT = 502;
const DEFAULT_UNIT_ID = 1;
const DEFAULT_POLL_INTERVAL = 5; // seconds

/** Pairing must answer well inside Homey's 30s budget, so probes are kept short. */
const PAIR_TIMEOUT = 4000;

/** data.id of the list entry that stands for "enter an address by hand". */
const MANUAL_ENTRY_ID = 'manual_entry';

module.exports = class CommonDriver extends Homey.Driver {

  async onInit() {
    this.definition = pointMap[this.id];
    this.log(`${this.id} driver has been initialized`);
  }

  /** The extra list entry that leads to the address form instead of a discovered device. */
  manualEntry() {
    return { name: this.homey.__('pair.manualEntry'), data: { id: MANUAL_ENTRY_ID } };
  }

  static isManualEntry(device) {
    return Boolean(device && device.data && device.data.id === MANUAL_ENTRY_ID);
  }

  /**
   * Homey's device list: what mDNS found, plus an "enter IP address" entry. The 'route' view
   * continues to the add view or the address form.
   */
  onPair(session) {
    let selected = [];
    session.setHandler('list_devices', async () => [...await this.onPairListDevices(), this.manualEntry()]);
    session.setHandler('list_devices_selection', (devices) => {
      selected = devices || [];
    });
    session.setHandler('showView', async (viewId) => {
      if (viewId !== 'route') return;
      await session.showView(selected.some(CommonDriver.isManualEntry) ? 'manual' : 'add_devices');
    });
    session.setHandler('manual_connect', async (data) => this.pairManually(data));
    session.setHandler('manual_fields', async () => ({ unitId: this.definition.usesUnitId }));
  }

  /**
   * Repair points the device at a unit found over mDNS (current one first) or typed by hand.
   * Another unit is allowed on purpose, e.g. after a replacement.
   */
  onRepair(session, device) {
    let selected = [];
    session.setHandler('list_devices', async () => [...await this.listUnits(device), this.manualEntry()]);
    session.setHandler('list_devices_selection', (devices) => {
      selected = devices || [];
    });
    session.setHandler('showView', async (viewId) => {
      if (viewId !== 'route') return;
      const [choice] = selected;
      if (!choice || CommonDriver.isManualEntry(choice)) {
        await session.showView('repair_manual');
        return;
      }
      try {
        await this.moveDevice(device, choice.settings, choice.data.discoveryId);
      } finally {
        await session.showView('done');
      }
    });
    session.setHandler('manual_fields', async () => ({ unitId: this.definition.usesUnitId }));
    session.setHandler('manual_connect', async ({ host, port, unitId }) => {
      const endpoint = this.normalizeEndpoint({ host, port, unitId });
      const discovered = this.discoveryResults().find((result) => result.address === endpoint.host);
      return this.moveDevice(device, endpoint, discovered ? discovered.id : null);
    });
  }

  normalizeEndpoint({ host, port, unitId }) {
    const cleanHost = String(host || '').trim();
    if (!cleanHost) throw Error(this.homey.__('errors.hostRequired'));

    return {
      host: cleanHost,
      port: Number(port) || DEFAULT_PORT,
      unitId: Number(unitId) || DEFAULT_UNIT_ID,
    };
  }

  static endpointOf(result) {
    return {
      host: result.address,
      port: Number(result.port) || DEFAULT_PORT,
      unitId: DEFAULT_UNIT_ID,
    };
  }

  /**
   * Read the identity block, proving something Modbus-speaking is really there and that it
   * carries what this driver is for (a battery, a meter).
   * @returns {Promise<object>} the identity
   */
  async probe({ host, port, unitId }) {
    const client = new ModbusClient({
      host, port, unitId, timeout: PAIR_TIMEOUT, log: (message) => this.log(message),
    });

    let registers;
    try {
      registers = new Map();
      for (const block of this.definition.identityBlocks) {
        // eslint-disable-next-line no-await-in-loop
        const data = await client.readRegisters(block.start, block.count);
        for (let i = 0; i < block.count; i += 1) {
          registers.set(block.start + i, data.readUInt16BE(i * 2));
        }
      }
    } catch (error) {
      throw Error(`${this.homey.__('errors.probeFailed')} (${error.message})`);
    } finally {
      client.destroy();
    }

    if (this.definition.pairable && !this.definition.pairable(registers)) {
      throw Error(this.homey.__(`errors.notPairable.${this.id}`));
    }
    return this.definition.identity(registers);
  }

  /** The endpoint as device settings; without unitId where the driver has no such setting. */
  endpointSettings({ host, port, unitId }) {
    return this.definition.usesUnitId ? { host, port, unitId } : { host, port };
  }

  /** Build the Homey device object for one endpoint. */
  buildDevice({
    id, endpoint, identity, mdnsName = '',
  }) {
    const label = identity.serialNumber || endpoint.host;

    return {
      name: `${this.homey.__(`pair.deviceName.${this.id}`)} ${label}`,
      data: { id },
      store: { unitSerial: identity.unitSerial || '' },
      settings: {
        ...this.endpointSettings(endpoint),
        pollInterval: DEFAULT_POLL_INTERVAL,
        mdnsName,
        ...CommonDevice.identitySettings(identity, this.homey),
      },
    };
  }

  /** Everything the mDNS strategy for this driver currently sees. */
  discoveryResults() {
    try {
      return Object.values(this.getDiscoveryStrategy().getDiscoveryResults());
    } catch (error) {
      this.error('discovery unavailable:', error.message);
      return [];
    }
  }

  /**
   * Probe every discovery result, each on its own socket and all at once, so a few silent
   * hosts cannot add up past Homey's 30 s pairing limit.
   * @returns {Promise<Array<{ result: object, endpoint: object, identity: object }>>}
   */
  async probeDiscovered() {
    const results = this.discoveryResults();
    this.log(`[pair] ${results.length} discovery result(s):`, results.map((r) => `${r.id}@${r.address}:${r.port}`).join(', '));

    const probed = await Promise.all(results.map(async (result) => {
      const endpoint = CommonDriver.endpointOf(result);
      try {
        return { result, endpoint, identity: await this.probe(endpoint) };
      } catch (error) {
        // Discovered but not answering our registers: not a device for this driver.
        this.log(`[pair] ${result.id} at ${endpoint.host}: ${error.message}`);
        return null;
      }
    }));
    return probed.filter(Boolean);
  }

  async onPairListDevices() {
    const units = await this.probeDiscovered();
    return units.map(({ result, endpoint, identity }) => this.buildDevice({
      id: result.id, endpoint, identity, mdnsName: result.id,
    }));
  }

  /** Manual entry. Takes the discovery id when mDNS sees the address, to follow later IP changes. */
  async pairManually({ host, port, unitId }) {
    const endpoint = this.normalizeEndpoint({ host, port, unitId });
    const identity = await this.probe(endpoint);

    const discovered = this.discoveryResults().find((result) => result.address === endpoint.host);
    const id = discovered ? discovered.id : `${this.id}-${identity.serialNumber || endpoint.host}`;

    return this.buildDevice({
      id, endpoint, identity, mdnsName: discovered ? discovered.id : '',
    });
  }

  /** The units repair can offer, as list entries; the one this device uses now first. */
  async listUnits(device) {
    const currentSn = device.getSetting('deviceSn');
    const currentId = device.discoveryId;
    const units = (await this.probeDiscovered()).map(({ result, endpoint, identity }) => {
      const current = (Boolean(currentSn) && identity.serialNumber === currentSn) || result.id === currentId;
      const label = `${identity.serialNumber || endpoint.host} (${endpoint.host})`;
      return {
        name: current ? `${label} - ${this.homey.__('repair.current')}` : label,
        // Not the discovery id itself: the device list hides entries whose data matches an
        // already paired device, and the unit this device uses now is exactly that.
        data: { id: `repair:${result.id}`, discoveryId: result.id },
        settings: endpoint,
        current,
      };
    });
    return units.sort((a, b) => Number(b.current) - Number(a.current))
      .map(({ current, ...unit }) => unit);
  }

  /** Point an existing device at another endpoint and, with it, possibly another unit. */
  async moveDevice(device, endpoint, discoveryId) {
    const identity = await this.probe(endpoint); // throws if nothing (suitable) answers
    await device.setSettings({ ...this.endpointSettings(endpoint), ...CommonDevice.identitySettings(identity, this.homey) });
    await device.setStoreValue('unitSerial', identity.unitSerial || '');
    await device.adoptUnit(discoveryId);
    await device.connect();
    await device.poll();
    return true;
  }

};
