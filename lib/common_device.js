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
const DeviceMigrator = require('./DeviceMigrator');
const registerCapture = require('./registerCapture');
const pointMap = require('./solarwattPointMap');

const DEFAULT_PORT = 502;
const DEFAULT_UNIT_ID = 1;
const DEFAULT_POLL_INTERVAL = 5; // seconds
const OVERRIDE_NOTIFICATION_INTERVAL = 24 * 60 * 60 * 1000; // one timeline note a day at most
const DEFAULT_KEEP_ALIVE = 10; // seconds, for a control that does not set its own
const REQUEST_TIMEOUT = 5000;

/** An optional block is dropped after this many consecutive failures. */
const OPTIONAL_BLOCK_RETRIES = 3;
/** Consecutive failed polls before the device is marked unavailable. */
const FAILURES_BEFORE_UNAVAILABLE = 3;

/** Re-read this long after a write, so the tile shows what the device actually did. */
const POLL_AFTER_WRITE = 3000;
/** Capability changes arriving within this window are written as one control action. */
const CONTROL_DEBOUNCE = 300;

module.exports = class CommonDevice extends Homey.Device {

  async onInit() {
    this.definition = pointMap[this.driver.id];
    if (!this.definition) throw Error(`No register map for driver ${this.driver.id}`);

    this.failures = 0;
    this.polling = false;
    this.identityRead = false;
    this.detectionDone = false;
    this.unmappedLogged = new Set();

    // Copy the block list so per-device failure counts don't leak into the shared map.
    this.blocks = this.definition.blocks.map((block) => ({ ...block, failures: 0 }));
    this.armCapture('device start');

    const migrated = await this.migrate();
    await this.applyCapabilityOptions({ force: migrated });
    await this.registerControls();
    await this.connect();
    await this.runDetection();
    this.startPolling();

    this.log(`${this.getName()} has been initialized`);
  }

  // --- connection ------------------------------------------------------------------------

  get endpoint() {
    const settings = this.getSettings();
    return {
      host: settings.host,
      port: Number(settings.port) || DEFAULT_PORT,
      unitId: Number(settings.unitId) || DEFAULT_UNIT_ID,
    };
  }

  /** Take a client from the app-wide pool for the address currently in settings. */
  async connect() {
    const { endpoint } = this;
    if (!endpoint.host) {
      await this.setUnavailable(this.homey.__('errors.hostMissing'));
      return;
    }

    this.release();
    this.client = this.homey.app.pool.acquire({
      ...endpoint,
      timeout: REQUEST_TIMEOUT,
      log: (message) => this.log(message),
    });
    this.connected = endpoint;
  }

  /** Hand the pooled client back, if we hold one. */
  release() {
    if (!this.connected) return;
    this.homey.app.pool.release(this.connected);
    this.connected = null;
    this.client = null;
  }

  // --- discovery -------------------------------------------------------------------------

  /**
   * The mDNS id this device follows. It starts as the pairing id; repair can move the device
   * to another unit, and then it follows that one - or nothing ('') after a manual address.
   */
  get discoveryId() {
    const moved = this.getStoreValue('discoveryId');
    return typeof moved === 'string' ? moved : this.getData().id;
  }

  /** Show the mDNS name this device follows on its settings page ('' for a fixed address). */
  async showMdnsName(name) {
    if (this.getSetting('mdnsName') === (name || '')) return;
    await this.setSettings({ mdnsName: name || '' }).catch((error) => this.error(error));
  }

  /** Start over on a (possibly) different unit: new mDNS id, fresh identity and detection. */
  async adoptUnit(discoveryId) {
    await this.setStoreValue('discoveryId', discoveryId || '');
    await this.showMdnsName(discoveryId);
    this.blocks = this.definition.blocks.map((block) => ({ ...block, failures: 0 }));
    this.identityRead = false;
    this.detectionDone = false;
    this.unmappedLogged = new Set();
    this.armCapture('repair');
  }

  /**
   * Ours when it carries the mDNS id this device follows, or the unit's serial number, which both
   * mDNS ids contain (mDNS-<SN>.local, EVC-<SN>): that catches a device paired by address.
   */
  onDiscoveryResult(discoveryResult) {
    if (this.discoveryId && discoveryResult.id === this.discoveryId) return true;
    const unitSerial = this.getStoreValue('unitSerial');
    return Boolean(unitSerial) && String(discoveryResult.id).toLowerCase().includes(String(unitSerial).toLowerCase());
  }

  // Typed void, but a throw marks the device unavailable with its message (SDK typings).
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onDiscoveryAvailable(discoveryResult) {
    await this.onDiscoveredAt(discoveryResult);
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.onDiscoveredAt(discoveryResult).catch((error) => this.error(error));
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.onDiscoveredAt(discoveryResult).catch((error) => this.error(error));
  }

  /** Follow the device to a new IP address without losing the Homey device. */
  async onDiscoveredAt({ id, address, port }) {
    if (!address) return;
    if (id && id !== this.discoveryId) {
      this.log(`following mDNS id ${id}`);
      await this.setStoreValue('discoveryId', id).catch((error) => this.error(error));
    }
    if (id) await this.showMdnsName(id);

    const settings = this.getSettings();
    const newPort = Number(port) || settings.port || DEFAULT_PORT;
    if (settings.host === address && Number(settings.port) === Number(newPort)) return;

    this.log(`discovered at ${address}:${newPort}, was ${settings.host}:${settings.port}`);
    await this.setSettings({ host: address, port: Number(newPort) }).catch((error) => this.error(error));
    await this.connect();
    await this.poll();
  }

  // --- polling ---------------------------------------------------------------------------

  startPolling() {
    this.stopPolling();

    const seconds = Number(this.getSettings().pollInterval) || DEFAULT_POLL_INTERVAL;
    this.pollInterval = this.homey.setInterval(() => {
      this.poll().catch((error) => this.error(error));
    }, seconds * 1000);

    // Keep-alives run on their own timer, independent of the update interval.
    const keepAliveSeconds = Math.min(...this.controls
      .filter((control) => control.keepAlive)
      .map((control) => control.keepAliveSeconds || DEFAULT_KEEP_ALIVE));
    if (Number.isFinite(keepAliveSeconds)) {
      this.keepAliveInterval = this.homey.setInterval(() => {
        this.keepAlive().catch((error) => this.error(error));
      }, keepAliveSeconds * 1000);
    }

    // The "Get status update" flow card asks every device to refresh right away.
    this.onPollRequested = () => {
      this.poll().catch((error) => this.error(error));
    };
    this.homey.on('poll', this.onPollRequested);

    this.onEnergyManager = () => {
      this.showEnergyManager().catch((error) => this.error(error));
    };
    this.homey.on('energyManager', this.onEnergyManager);

    this.poll().catch((error) => this.error(error));
  }

  stopPolling() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.keepAliveInterval) {
      this.homey.clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    if (this.onPollRequested) {
      this.homey.removeListener('poll', this.onPollRequested);
      this.onPollRequested = null;
    }
    if (this.onEnergyManager) {
      this.homey.removeListener('energyManager', this.onEnergyManager);
      this.onEnergyManager = null;
    }
  }

  async poll() {
    if (this.polling || !this.client) return;
    this.polling = true;
    this.pollStartedAt = Date.now();

    try {
      const registers = await this.readBlocks(this.blocks);
      if (registers.size === 0) throw Error(this.homey.__('errors.noData'));

      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable();
      await this.handleData(registers);
      this.captureRegisters('Poll', registers, {
        values: Object.fromEntries(this.getCapabilities().map((capability) => [capability, this.getCapabilityValue(capability)])),
      });

      if (!this.identityRead) await this.readIdentity();
      // only when the device was unreachable during onInit
      if (!this.detectionDone) await this.runDetection();
    } catch (error) {
      this.failures += 1;
      this.error(`poll ${this.failures} failed:`, error.message);
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE) {
        await this.setUnavailable(`${this.homey.__('errors.unreachable')} ${error.message}`)
          .catch((setError) => this.error(setError));
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Read every block into one address-keyed map. A failing block only loses its own registers;
   * an `optional` one is no longer read after OPTIONAL_BLOCK_RETRIES failures.
   * @returns {Promise<Map<number, number>>}
   */
  async readBlocks(blocks) {
    const registers = new Map();
    const failed = [];

    for (const block of blocks) {
      if (block.disabled) continue;
      // only for hardware detect() found, e.g. the inverter's second meter
      if (block.requires && this.detected[block.requires] !== true) continue;

      try {
        // sequential: one transaction at a time per server
        // eslint-disable-next-line no-await-in-loop
        const data = await this.client.readRegisters(block.start, block.count);
        for (let i = 0; i < block.count; i += 1) {
          registers.set(block.start + i, data.readUInt16BE(i * 2));
        }
        block.failures = 0;
      } catch (error) {
        this.log(`block at ${block.start} failed: ${error.message}`);
        // unreachable: further blocks would only wait out their own timeouts
        if (ModbusClient.isConnectError(error)) break;
        failed.push(block);
      }
    }

    // A failure counts against an optional block only while the rest of the device answers.
    if (registers.size > 0) {
      for (const block of failed) {
        block.failures += 1;
        if (block.optional && block.failures >= OPTIONAL_BLOCK_RETRIES) {
          block.disabled = true;
          this.log(`optional block at ${block.start} not supported, no longer polling it`);
        }
      }
    }

    return registers;
  }

  /** Log identity, detection and the first poll again, see registerCapture. */
  armCapture(reason) {
    this.captureReason = reason;
    this.captured = new Set();
  }

  /** Log one kind of read (Identity, Detection, Poll) once per armCapture. */
  captureRegisters(kind, registers, extra) {
    if (!this.captureReason || this.captured.has(kind)) return;
    this.captured.add(kind);
    registerCapture.record(`${this.driver.id}${kind}`, {
      reason: this.captureReason,
      version: this.homey.manifest.version,
      registers: registerCapture.toRuns(registers),
      ...extra,
    }, (line) => this.log(line));
  }

  /** Read model/serial/firmware once and mirror them into the device settings page. */
  async readIdentity() {
    try {
      const registers = await this.readBlocks(
        this.definition.identityBlocks.map((block) => ({ ...block, failures: 0 })),
      );
      const identity = this.definition.identity(registers);
      this.captureRegisters('Identity', registers, { identity });
      if (!identity.serialNumber && !identity.model) throw Error(this.homey.__('errors.noData'));

      await this.setSettings({
        ...CommonDevice.identitySettings(identity, this.homey),
        ...this.energyManagerSetting(),
      });
      if (identity.unitSerial) await this.setStoreValue('unitSerial', identity.unitSerial);
      this.identityRead = true;
    } catch (error) {
      this.error('could not read device identity:', error.message);
    }
  }

  /** The SOLARWATT Manager seen on the network, for drivers whose control it can override. */
  energyManagerSetting() {
    if (!this.definition.showsEnergyManager) return {};
    return { energyManager: this.homey.app.energyManagerLabel() || this.homey.__('settings.energyManagerNone') };
  }

  async showEnergyManager() {
    const setting = this.energyManagerSetting();
    if (setting.energyManager === undefined || setting.energyManager === this.getSetting('energyManager')) return;
    await this.setSettings(setting).catch((error) => this.error(error));
  }

  /** The settings-page fields for an identity read, with the driver's own extras. */
  static identitySettings(identity, homey) {
    const settings = {
      deviceModel: identity.model || '',
      deviceSn: identity.serialNumber || '',
      manufacturer: identity.manufacturer || '',
      firmware: identity.firmware || '',
    };
    for (const [key, value] of Object.entries(identity.settings || {})) {
      // { i18n: key } is translated; a boolean is a checkbox
      if (typeof value === 'boolean') settings[key] = value;
      else settings[key] = value && value.i18n ? homey.__(value.i18n) : (value || '');
    }
    return settings;
  }

  async handleData(registers) {
    for (const [capability, decode] of Object.entries(this.definition.capabilities)) {
      // no decoder: owned by Homey, written by a control
      if (!decode) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.setCapability(capability, decode(registers, this));
    }
    // e.g. the charger's card trigger
    if (this.definition.afterData) {
      await this.definition.afterData(registers, this).catch((error) => this.error('after data:', error.message));
    }
  }

  // --- controls --------------------------------------------------------------------------

  /** The register map's controls whose capabilities this device carries. */
  get controls() {
    return (this.definition.controls || [])
      .filter((control) => control.capabilities.every((capability) => this.hasCapability(capability)));
  }

  /**
   * One listener per control, not per capability, so a control spanning several capabilities
   * (SoC window, target power plus mode) writes values changed together as one set.
   */
  async registerControls() {
    for (const control of this.controls) {
      const initial = typeof control.initial === 'function' ? control.initial(this) : control.initial;
      for (const [capability, value] of Object.entries(initial || {})) {
        if (this.getCapabilityValue(capability) !== null) continue;
        // eslint-disable-next-line no-await-in-loop
        await this.setCapabilityValue(capability, value).catch((error) => this.error(error));
      }
      // a rejection is shown to the user
      this.registerMultipleCapabilityListener(
        control.capabilities,
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        (values) => this.runControl(control, values),
        CONTROL_DEBOUNCE,
      );
    }
  }

  async runControl(control, values) {
    this.log('control', JSON.stringify(values));
    if (!this.client) throw Error(this.homey.__('errors.hostMissing'));
    const refusal = control.guard ? await control.guard({ client: this.client, device: this, values }) : null;
    if (refusal) throw Error(this.homey.__(refusal));

    // for changedSince() in the register map: a read during a write proves no override
    this.controlsRunning = (this.controlsRunning || 0) + 1;
    try {
      // the user takes control again: reset the override alarm of a watched control
      if (control.watched) await this.clearControlOverridden();
      await control.write({ client: this.client, device: this, values });
    } catch (error) {
      this.error('control failed:', error.message);
      throw Error(`${this.homey.__('errors.writeFailed')} ${error.message}`);
    } finally {
      this.controlsRunning -= 1;
      this.controlEndedAt = Date.now();
    }

    this.homey.setTimeout(() => {
      this.poll().catch((error) => this.error(error));
    }, POLL_AFTER_WRITE);
  }

  /**
   * Run a control from a Flow action and show the new values right away.
   * @param {object} values capability -> value, all belonging to one control
   */
  async setControl(values) {
    const capabilities = Object.keys(values);
    const control = this.controls.find((candidate) => capabilities.every((cap) => candidate.capabilities.includes(cap)));
    if (!control) throw Error(`No control for ${capabilities.join(', ')}`);
    await this.runControl(control, values);
    for (const [capability, value] of Object.entries(values)) {
      // eslint-disable-next-line no-await-in-loop
      await this.setCapabilityValue(capability, value).catch((error) => this.error(error));
    }
  }

  /**
   * Remember what this app wrote, so a decoder can tell when something else changed it.
   * @param {object} values register address -> value as written, or null to forget it
   */
  async noteWrites(values) {
    const written = { ...(this.getStoreValue('writtenRegisters') || {}) };
    let changed = false;
    for (const [address, value] of Object.entries(values)) {
      if (value === null) {
        if (!(address in written)) continue;
        delete written[address];
      } else {
        // a keep-alive rewriting the same value
        if (written[address] && written[address].value === value) continue;
        written[address] = { value, at: Date.now() };
      }
      changed = true;
    }
    if (changed) await this.setStoreValue('writtenRegisters', written);
    // nothing of ours left to override
    if (Object.keys(written).length === 0) await this.clearControlOverridden();
  }

  /**
   * Another writer changed what this app wrote: latch the alarm and notify on the timeline, at
   * most once a day app-wide (a SOLARWATT Manager keeps taking control back).
   */
  async onControlOverridden() {
    this.log('control overridden by another writer');
    await this.setStoreValue('controlOverridden', true);

    const last = Number(this.homey.settings.get('overrideNotifiedAt')) || 0;
    if (Date.now() - last < OVERRIDE_NOTIFICATION_INTERVAL) return;
    this.homey.settings.set('overrideNotifiedAt', Date.now());
    const manager = this.homey.app.energyManagerLabel();
    const excerpt = manager
      ? this.homey.__('notifications.controlOverriddenBy', { name: this.getName(), manager })
      : this.homey.__('notifications.controlOverridden', { name: this.getName() });
    await this.homey.notifications.createNotification({ excerpt });
  }

  /** Reset the latched "Control overridden" alarm, see controlOverridden in the register map. */
  async clearControlOverridden() {
    if (!this.getStoreValue('controlOverridden')) return;
    await this.setStoreValue('controlOverridden', false);
    if (this.hasCapability('alarm_generic.control')) {
      await this.setCapabilityValue('alarm_generic.control', false).catch((error) => this.error(error));
    }
  }

  /** Refresh controls whose effect expires on the device unless it is written again. */
  async keepAlive() {
    if (!this.client) return;
    for (const control of this.controls) {
      if (!control.keepAlive) continue;
      // eslint-disable-next-line no-await-in-loop
      await control.keepAlive({ client: this.client, device: this })
        .catch((error) => this.error('keep-alive failed:', error.message));
    }
  }

  /** Hand control back to the device itself, e.g. when the app stops. */
  async releaseControls() {
    if (!this.client) return;
    for (const control of this.controls) {
      if (!control.release) continue;
      // eslint-disable-next-line no-await-in-loop
      await control.release({ client: this.client, device: this })
        .catch((error) => this.error('release failed:', error.message));
    }
  }

  // --- capabilities ----------------------------------------------------------------------

  /**
   * The capabilities this device should carry, in tile order: the register map's, minus what
   * `unsupported()` drops for this unit.
   */
  capabilityList() {
    const all = Object.keys(this.definition.capabilities);
    if (!this.definition.unsupported) return all;
    const drop = this.definition.unsupported(this.detected);
    return all.filter((capability) => !drop.includes(capability));
  }

  /** What detect() last concluded about this unit. `{}` means nothing is known yet. */
  get detected() {
    return this.getStoreValue('detected') || {};
  }

  /**
   * Work out what this unit can serve, once per (re)start: detect() reads model properties, and
   * re-deciding per poll would only churn capabilities on an odd read.
   */
  async runDetection() {
    if (this.detectionDone || !this.client) return;
    if (!this.definition.detect) {
      this.detectionDone = true;
      return;
    }

    const blocks = (this.definition.detectBlocks || []).map((block) => ({ ...block, failures: 0 }));
    const registers = await this.readBlocks(blocks).catch((error) => {
      this.error('detection read failed:', error.message);
      return new Map();
    });
    // unreachable: keep the stored verdict, retry after the first good poll
    if (registers.size === 0) return;

    this.detectionDone = true;
    // merged: a fact detect() could not read this time keeps its stored value
    const previous = this.detected;
    const detected = { ...previous, ...this.definition.detect(registers) };
    this.captureRegisters('Detection', registers, { previous, detected });

    const keys = new Set([...Object.keys(detected), ...Object.keys(previous)]);
    if (![...keys].some((key) => detected[key] !== previous[key])) return;

    this.log('device detection changed:', JSON.stringify(previous), '->', JSON.stringify(detected));
    await this.setStoreValue('detected', detected);
    const migrated = await this.migrate();
    await this.applyCapabilityOptions({ force: migrated });
  }

  /**
   * Ranges that depend on the unit, e.g. limits that run up to its rated power.
   * @param {object} [settings] { force }: write them unread, after a migration rebuilt capabilities
   */
  async applyCapabilityOptions({ force = false } = {}) {
    if (!this.definition.capabilityOptions) return;
    await DeviceMigrator.syncCapabilityOptions(this, this.definition.capabilityOptions(this.detected), { force });
  }

  /** Bring a paired device's capabilities, and their order, in line with capabilityList(). */
  async migrate() {
    return DeviceMigrator.migrateCapabilities(this, this.capabilityList());
  }

  /**
   * `undefined`: not read (failed block, absent register) - the tile keeps its value.
   * `null`: read, but no value right now (e.g. efficiency at night) - the tile is cleared.
   */
  async setCapability(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (value === undefined) {
      this.logUnmapped(capability);
      return;
    }
    if (typeof value === 'number' && Number.isNaN(value)) return;

    await this.setCapabilityValue(capability, value)
      .catch((error) => this.error(error, capability, value));
  }

  // No trigger() for '<capability>_changed' cards: Homey runs them itself, also for
  // sub-capabilities (confirmed live 2026-10-04; a trigger() made flows run twice).

  /** Log once per start that a capability's registers never arrived. */
  logUnmapped(capability) {
    if (!this.unmappedLogged) this.unmappedLogged = new Set();
    if (this.unmappedLogged.has(capability)) return;
    this.unmappedLogged.add(capability);
    this.log(`no value for '${capability}' - its registers were not returned by this device`);
  }

  // --- lifecycle -------------------------------------------------------------------------

  async onSettings({ newSettings, changedKeys }) {
    const reconnectKeys = ['host', 'port', 'unitId'];

    // Settings stored in the device. A throw makes Homey keep the old value.
    const writes = this.definition.settingWrites || {};
    const toWrite = changedKeys.filter((key) => writes[key]);
    if (toWrite.length > 0) {
      if (!this.client) throw Error(this.homey.__('errors.hostMissing'));
      for (const key of toWrite) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await writes[key]({ client: this.client, device: this, value: newSettings[key] });
        } catch (error) {
          this.error(`setting ${key} failed:`, error.message);
          if (error.refusal) throw error; // e.g. "unplug first"
          throw Error(`${this.homey.__('errors.writeFailed')} ${error.message}`);
        }
      }
      // detect() can depend on it, e.g. the charger's minimum power
      this.detectionDone = false;
      this.homey.setTimeout(() => {
        this.runDetection().catch((error) => this.error(error));
      }, 1000);
    }

    if (changedKeys.some((key) => reconnectKeys.includes(key))) {
      // getSettings() still returns the old values inside this handler
      this.homey.setTimeout(() => {
        this.connect()
          .then(() => this.startPolling())
          .catch((error) => this.error(error));
      }, 1000);
    } else if (changedKeys.includes('pollInterval')) {
      this.homey.setTimeout(() => this.startPolling(), 1000);
    }
  }

  onRenamed(name) {
    this.log('device was renamed to', name);
  }

  onDeleted() {
    this.stopPolling();
    this.releaseControls()
      .catch((error) => this.error(error))
      .finally(() => this.release());
    this.log('device was deleted', this.getName());
  }

  async onUninit() {
    this.stopPolling();
    await this.releaseControls();
    this.release();
  }

};
