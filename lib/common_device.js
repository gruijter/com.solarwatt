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
  }

  /**
   * Ours when it carries the mDNS id this device follows - or, failing that, the serial
   * number of the Modbus unit it sits on, which both mDNS ids contain (mDNS-<SN>.local,
   * EVC-<SN>). The latter picks up a device that was paired by address while mDNS did not
   * see it yet; onDiscoveredAt() then adopts the id.
   */
  onDiscoveryResult(discoveryResult) {
    if (this.discoveryId && discoveryResult.id === this.discoveryId) return true;
    const unitSerial = this.getStoreValue('unitSerial');
    return Boolean(unitSerial) && String(discoveryResult.id).toLowerCase().includes(String(unitSerial).toLowerCase());
  }

  // Homey awaits this one despite the SDK typings declaring it void: throwing here
  // marks the device unavailable with the error message.
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

    /*
     * Keep-alive writes run on their own timer, not with every poll: a 1 s update interval
     * should not mean rewriting a watchdog every second, nor a 10 minute one letting it expire.
     */
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

      if (!this.identityRead) await this.readIdentity();
      // Still once per start: this only fires when the device was unreachable during onInit.
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
   * Read every block and merge the words into one address-keyed map.
   *
   * A failing block only removes its own registers, so one unsupported range never costs the
   * whole poll. Blocks flagged `optional` stop being requested after a few failures - some
   * firmware answers those addresses with an exception on every single read.
   * @returns {Promise<Map<number, number>>}
   */
  async readBlocks(blocks) {
    const registers = new Map();
    const failed = [];

    for (const block of blocks) {
      if (block.disabled) continue;

      try {
        // Sequential on purpose: one Modbus transaction at a time per server.
        // eslint-disable-next-line no-await-in-loop
        const data = await this.client.readRegisters(block.start, block.count);
        for (let i = 0; i < block.count; i += 1) {
          registers.set(block.start + i, data.readUInt16BE(i * 2));
        }
        block.failures = 0;
      } catch (error) {
        this.log(`block at ${block.start} failed: ${error.message}`);
        // Nothing answers at all: every further block would only wait out its own timeout.
        if (ModbusClient.isConnectError(error)) break;
        failed.push(block);
      }
    }

    // Only count it against an optional block while the rest of the device is answering: a
    // block that fails during an outage says nothing about whether the firmware has it.
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

  /** Read model/serial/firmware once and mirror them into the device settings page. */
  async readIdentity() {
    try {
      const registers = await this.readBlocks(
        this.definition.identityBlocks.map((block) => ({ ...block, failures: 0 })),
      );
      const identity = this.definition.identity(registers);
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
      // { i18n: key } marks a value that has to be translated, e.g. a meter connection type.
      if (typeof value === 'boolean') settings[key] = value; // a checkbox, e.g. phase switching
      else settings[key] = value && value.i18n ? homey.__(value.i18n) : (value || '');
    }
    return settings;
  }

  async handleData(registers) {
    for (const [capability, decode] of Object.entries(this.definition.capabilities)) {
      // No decoder: the value is owned by Homey and written by a control, not read back.
      if (!decode) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.setCapability(capability, decode(registers, this));
    }
    // What a poll can start besides capability values, e.g. the charger's card trigger.
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
   * Route user and Flow changes of controllable capabilities to their register writes.
   *
   * One listener per control, not per capability: a control spanning several capabilities
   * (the SoC window, Homey's target power plus its mode) gets every value that changed
   * together in one call, so it can write them as one consistent set.
   */
  async registerControls() {
    for (const control of this.controls) {
      const initial = typeof control.initial === 'function' ? control.initial(this) : control.initial;
      for (const [capability, value] of Object.entries(initial || {})) {
        if (this.getCapabilityValue(capability) !== null) continue;
        // eslint-disable-next-line no-await-in-loop
        await this.setCapabilityValue(capability, value).catch((error) => this.error(error));
      }
      // The SDK awaits this listener: a rejection reaches the user.
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
    // May read the device, e.g. the charger's live connector status.
    const refusal = control.guard ? await control.guard({ client: this.client, device: this, values }) : null;
    if (refusal) throw Error(this.homey.__(refusal));

    // Seen by the override check (solarwattPointMap changedSince): a read during a write is no proof.
    this.controlsRunning = (this.controlsRunning || 0) + 1;
    try {
      // The user takes control again: start watching for overrides afresh. Only for a control
      // whose registers are watched - another one (a lock, a SoC window) leaves the alarm alone.
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
   * Run a control from code (a Flow action) and show the new values right away, the same
   * way a change on the device page would.
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
        // A keep-alive rewriting the same value: keep the entry, no store write.
        if (written[address] && written[address].value === value) continue;
        written[address] = { value, at: Date.now() };
      }
      changed = true;
    }
    if (changed) await this.setStoreValue('writtenRegisters', written);
    // Nothing of ours left to override: an earlier override no longer applies.
    if (Object.keys(written).length === 0) await this.clearControlOverridden();
  }

  /**
   * Another writer changed what this app wrote: latch the alarm and tell the user on the
   * timeline - at most once a day for the whole app, since a SOLARWATT Manager that wants
   * control back keeps doing so and the battery and inverter would otherwise both report it.
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
   * The capabilities this device should carry, in tile order.
   *
   * The register map is the source of truth, not the driver manifest: the manifest lists
   * everything the driver can offer, while a given unit may not be able to serve all of it.
   * `unsupported()` turns the facts that detect() established into the list to leave out.
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
   * Work out what this unit can serve, once per app or device (re)start.
   *
   * Deliberately not per poll. Everything detect() looks at is a model property that cannot
   * change while the app is running, so re-deciding every poll would buy nothing and
   * risk churning capabilities on a single odd read. A unit that is physically changed gets
   * its new verdict on the next restart, which is also when a firmware update would land.
   *
   * Its registers are read separately from the poll blocks, so an address that is only
   * interesting at startup does not have to ride along on every cycle.
   */
  async runDetection() {
    if (this.detectionDone || !this.client) return;
    if (!this.definition.detect) {
      this.detectionDone = true; // nothing to detect for this driver
      return;
    }

    const blocks = (this.definition.detectBlocks || []).map((block) => ({ ...block, failures: 0 }));
    const registers = await this.readBlocks(blocks).catch((error) => {
      this.error('detection read failed:', error.message);
      return new Map();
    });
    // Unreachable at startup: keep the stored verdict and try again after the first good
    // poll, rather than re-deciding the capability set from a failed read.
    if (registers.size === 0) return;

    this.detectionDone = true;
    // Merged onto the stored verdict: a fact whose block failed this time is left out by
    // detect(), and must keep its old value rather than read as "changed to unknown" - that
    // would bring back every tile it dropped, until the next start drops them again.
    const previous = this.detected;
    const detected = { ...previous, ...this.definition.detect(registers) };

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

  /**
   * Bring an already paired device in line with capabilityList().
   *
   * Two things make this necessary. Capabilities added to a driver in an app update do not
   * appear on devices paired before it, and setCapability() silently skips anything the
   * device does not have - so without this the new tiles would only show up on a re-pair.
   * And Homey orders tiles by the order in which capabilities were added, so a capability
   * slotted into the middle of the list has to be rebuilt from that point rather than
   * appended, or it lands at the bottom of the device page.
   *
   * The rebuild itself, with values carried across, is lib/DeviceMigrator.js.
   */
  async migrate() {
    return DeviceMigrator.migrateCapabilities(this, this.capabilityList());
  }

  /**
   * Write one capability, distinguishing the two ways a decoder can come back empty.
   *
   * `undefined` means this unit does not report the value at all - the block failed, or the
   * register is absent on this firmware. Whatever is on the tile is left alone, because
   * clearing it on a single failed poll would make a brief network hiccup look like data loss.
   *
   * `null` means the device is answering fine but there is genuinely no value right now.
   * That clears the tile, so a stale reading cannot masquerade as a current one - overnight
   * efficiency is the case this exists for. (The same split com.growatt settled on.)
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

  // No trigger() for '<capability>_changed' cards: Homey runs a device trigger with that id itself
  // on every setCapabilityValue() that changes the value - sub-capabilities of system capabilities
  // too (measured on HomeyDev 2026-10-04: an extra trigger() made every such flow run twice).

  /**
   * Note once per app start that a capability's registers never arrived.
   *
   * Silence is the normal failure mode here: a decoder reading an address the firmware does
   * not implement returns undefined forever and nothing in the log ever says so. One line
   * with the driver and capability is enough to turn "that tile is empty" into a starting
   * point, without a message on every poll.
   */
  logUnmapped(capability) {
    if (!this.unmappedLogged) this.unmappedLogged = new Set();
    if (this.unmappedLogged.has(capability)) return;
    this.unmappedLogged.add(capability);
    this.log(`no value for '${capability}' - its registers were not returned by this device`);
  }

  // --- lifecycle -------------------------------------------------------------------------

  async onSettings({ newSettings, changedKeys }) {
    const reconnectKeys = ['host', 'port', 'unitId'];

    // Settings that live in the device itself. A failed write throws, so Homey keeps the old value.
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
          throw Error(`${this.homey.__('errors.writeFailed')} ${error.message}`);
        }
      }
      // What detect() concluded can depend on it, e.g. the charger's lowest power.
      this.detectionDone = false;
      this.homey.setTimeout(() => {
        this.runDetection().catch((error) => this.error(error));
      }, 1000);
    }

    if (changedKeys.some((key) => reconnectKeys.includes(key))) {
      // getSettings() still returns the old values here, so defer past this handler.
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
    // Hand the pooled client back only once control has been released over it.
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
