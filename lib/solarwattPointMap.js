/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.solarwatt.

Register maps for the local Modbus TCP interfaces:
 - SOLARWATT vision Modbus TCP protocol documentation v1.0 (inverter, battery, meter)
 - Fox ESS EV Charger Modbus TCP & RTU Protocol v1.08 (charger)

Most addresses below were read back from real hardware, from 2026-09-17 on:
an Inverter vision three 8kW (SN 2RHD802055DM090, protocol V1.05.03.00, Battery vision
top pack SN 2RVM29204BFF036) and an A011KP1 EV charger (SN 2TAH9320519Q197, fw 1.30).
Deviations from the written specs are called out inline - they are not typos.
*/

'use strict';

const {
  u16, i16, u32, i32, str, scale, round, bit,
} = require('./registers');
const { solarTitle } = require('./solarTitles');

/*
 * Blocks are read with function code 0x03, at most 125 registers each, and merged into one Map
 * per poll. `optional: true`: some firmware lacks it; dropped after a few failures (CommonDevice).
 */

// --- shared vision (inverter/battery/meter live on the same Modbus server) ---------------

// The vision answers every unit id alike (verified live), so its drivers hide the setting.
// The charger only answers its own.
const VISION_USES_UNIT_ID = false;

const VISION_IDENTITY = [
  { start: 30000, count: 48 }, // model name, serial number, manufacturer
  { start: 36001, count: 3 }, // master / slave / manager firmware versions
];

// `unitSerial`: serial number of the Modbus unit, part of its mDNS id (CommonDevice#onDiscoveryResult).

/** "VSN THREE 8KW 2RHD802055DM090": the inverter a battery or meter is read through. */
const inverterLabel = (regs) => [str(regs, 30000, 16), str(regs, 30016, 16)].filter(Boolean).join(' ') || undefined;

const visionIdentity = (regs) => ({
  model: str(regs, 30000, 16),
  serialNumber: str(regs, 30016, 16),
  unitSerial: str(regs, 30016, 16),
  manufacturer: str(regs, 30032, 16),
  firmware: [u16(regs, 36001), u16(regs, 36002), u16(regs, 36003)]
    .filter((v) => v !== undefined).join(' / ') || undefined,
});

// --- inverter ---------------------------------------------------------------------------

/*
 * Class `solarpanel`: measure_power is PV production, not the AC output (39134), which includes
 * battery discharge - see solarPowerAC(). DC side: 39118 / 39601; AC side: 39134 / 39149.
 * Without strings, 39118/39601/39603 read 0 while 39149 keeps counting (battery discharge).
 */

/** Efficiency assumed for the battery term when the live figure is unusable. */
const FALLBACK_EFFICIENCY_PCT = 98;

/** Below this DC power, efficiency is not published: PV/AC sampling skew dominates. */
const EFFICIENCY_FLOOR_W = 200;

/**
 * DC -> AC efficiency in percent: ac / (pv - battery), strings and battery sharing the DC bus.
 * Unrounded, as solarPowerAC() computes with it. `null` when there is nothing to measure
 * (e.g. at night), so the tile clears - see CommonDevice.setCapability.
 */
const inverterEfficiency = (regs) => {
  const ac = i32(regs, 39134);
  const pv = i32(regs, 39118);
  const battery = i32(regs, 39162);
  // registers absent
  if (ac === undefined || pv === undefined || battery === undefined) return undefined;
  if (!(ac > 0)) return null; // idle or curtailed
  if (pv < EFFICIENCY_FLOOR_W) return null; // dark - nothing is being converted
  const dcIn = pv - battery;
  if (dcIn < EFFICIENCY_FLOOR_W) return null; // nearly all of it is going into the battery
  const pct = (ac / dcIn) * 100;
  // above 100% is a measurement artefact
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  return pct;
};

/**
 * Solar output on the AC side. With `n` the efficiency:
 *
 *   solarAC = pv * n = (dcIn + battery) * n = ac + battery * n
 *
 * Computed as `ac + battery * n` so a fallback `n` only affects the battery term, and capped at
 * `pv * n` (equal with a live `n`) so a grid charge is never booked as solar production.
 */
const solarPowerAC = (regs) => {
  const ac = i32(regs, 39134);
  if (ac === undefined) return undefined;
  // Number.isFinite rejects null and undefined (`null / 100` would be 0)
  const live = inverterEfficiency(regs);
  const eff = (Number.isFinite(live) ? live : FALLBACK_EFFICIENCY_PCT) / 100;
  const battery = i32(regs, 39162);
  const solarAC = Math.max(0, ac + ((battery === undefined ? 0 : battery) * eff));
  const pv = i32(regs, 39118);
  // no ceiling without 39118
  if (pv === undefined) return round(solarAC, 0);
  return round(Math.min(solarAC, Math.max(0, pv * eff)), 0);
};

/*
 * Side of the solar energy counters. AC generation (39149/39151) includes battery discharge, so:
 *   no battery -> 'ac', 39149/39151
 *   battery    -> 'dc', 39601/39603 (as com.foxess and com.growatt)
 * undefined before the first detection (counters stay empty); 'dc' when detection could not tell.
 */
const solarSide = (detected, detectionDone = true) => {
  const { hasBattery } = detected;
  if (hasBattery === false) return 'ac';
  if (hasBattery === true || detectionDone) return 'dc';
  return undefined;
};

/** A solar energy counter: `ac` or `dc` (register addresses of a u32 in 0.01 kWh) per solarSide(). */
const solarEnergy = (ac, dc) => (regs, device) => {
  const side = solarSide(device.detected, device.detectionDone);
  if (!side) return undefined;
  return round(scale(u32(regs, side === 'ac' ? ac : dc), 100), 2);
};

/*
 * A battery is connected (37002 != 0) or ever was (lifetime counters 39605/39609 > 0), so a BMS
 * offline at a restart does not count as no battery. undefined when 37002 was not read.
 */
const hasBattery = (regs) => {
  const bms = u16(regs, 37002);
  if (bms === undefined) return undefined;
  if (bms !== 0) return true;
  const charged = u32(regs, 39605);
  const discharged = u32(regs, 39609);
  if (charged === undefined || discharged === undefined) return undefined;
  return charged > 0 || discharged > 0;
};

// The inverter's AC figures; without a battery they equal the solar ones and are left out.
const AC_INVERTER_CAPABILITIES = [
  'measure_power.ac_inverter',
  'meter_power.ac_inverter',
  'meter_power.ac_today',
];

/** Register value as-is, or flipped to Homey's sign convention. */
const negate = (value) => (value === undefined ? undefined : -value);

/** True when any of the words is non-zero; undefined when none of them was read. */
const anySet = (regs, addresses) => {
  const words = addresses.map((address) => regs.get(address)).filter((word) => word !== undefined);
  if (!words.length) return undefined;
  return words.some((word) => word !== 0);
};

/*
 * The unit's own alarms, no thresholds of our own. Alarm 1-3 (39067-39069) are bitfields (vision
 * document, "Alarm information"); any set bit raises alarm_problem, some also a specific alarm.
 */
const ALARM_REGISTERS = [39067, 39068, 39069];
const ALARM_OVERTEMPERATURE = [39068, 3]; // Alarm 2 bit 3: temperature is too high
const ALARM_STORAGE_ABNORMAL = [39068, 9]; // Alarm 2 bit 9: energy storage equipment abnormality
const ALARM_STORAGE_REVERSED = [39069, 4]; // Alarm 3 bit 4: energy storage reverse connection
const ALARM_METER_LOST = [39069, 9]; // Alarm 3 bit 9
const ALARM_BMS_LOST = [39069, 10]; // Alarm 3 bit 10

/** The named bits of Alarm 1-3 (vision document, "Alarm information"); names in locales inverterFaults. */
const INVERTER_FAULTS = [
  [39067, 0, 'pv_overvoltage'], [39067, 1, 'dc_arc'], [39067, 2, 'string_reversed'],
  [39067, 7, 'grid_lost'], [39067, 8, 'grid_voltage'], [39067, 11, 'grid_frequency'],
  [39067, 14, 'output_overcurrent'], [39067, 15, 'output_dc'],
  [39068, 0, 'residual_current'], [39068, 1, 'grounding'], [39068, 2, 'insulation'],
  [39068, 3, 'overtemperature'], [39068, 9, 'storage_abnormal'], [39068, 10, 'island'],
  [39068, 14, 'offgrid_overload'],
  [39069, 3, 'fan'], [39069, 4, 'storage_reversed'], [39069, 9, 'meter_lost'], [39069, 10, 'bms_lost'],
];

/** Every set alarm bit by name, a reserved one as "39067 bit 3"; empty without an alarm. */
const inverterFaults = (regs, device) => {
  if (ALARM_REGISTERS.every((address) => regs.get(address) === undefined)) return undefined;
  const names = [];
  for (const address of ALARM_REGISTERS) {
    for (let index = 0; index < 16; index += 1) {
      if (!bit(regs, address, index)) continue;
      const known = INVERTER_FAULTS.find(([a, b]) => a === address && b === index);
      names.push(known ? device.homey.__(`inverterFaults.${known[2]}`) : `${address} bit ${index}`);
    }
  }
  return names.length ? names.join(', ') : null;
};

/** Status, alarms: read by the battery and meter too, for the alarms about them. */
const ALARM_BLOCK = { start: 39063, count: 7, optional: true };

/** True when any of the given alarm bits is set; undefined when none of them was read. */
const anyBit = (regs, ...bits) => {
  const values = bits.map(([address, index]) => bit(regs, address, index)).filter((value) => value !== undefined);
  if (!values.length) return undefined;
  return values.some(Boolean);
};

/** Combine alarm sources: true if any is, undefined only when none of them was read. */
const anyTrue = (...values) => {
  const known = values.filter((value) => value !== undefined);
  if (!known.length) return undefined;
  return known.some(Boolean);
};

/*
 * Status 1 (39063: bit 0 standby, bit 2 operation, bit 6 fault) and Status 3 (39065, 32-bit: bit 0
 * off-grid). Ids as com.foxess's running_state; no bit set gives 'unknown'.
 */
const runningState = (regs) => {
  const status = u16(regs, 39063);
  if (status === undefined) return undefined;
  if (bit(regs, 39063, 6)) return 'fault';
  if (bit(regs, 39063, 2)) {
    const status3 = u32(regs, 39065);
    return status3 !== undefined && (status3 & 1) ? 'off_grid' : 'on_grid';
  }
  if (bit(regs, 39063, 0)) return 'standby';
  return 'unknown';
};

// SOLARWATT serial: "2R" plus a five-character model code, e.g. 2RVM29204BFF036 -> VM292
// (manual p. 46, "Serial Number Decomposition").
const BATTERY_MODELS = {
  VM292: 'Battery vision top pack 1.0',
  VS292: 'Battery vision pack 1.0',
};
const isSolarwattSerial = (serial) => Boolean(serial) && serial.startsWith('2R');
const modelFromSerial = (serial) => {
  if (!serial || serial.length < 7) return undefined;
  const code = serial.slice(2, 7);
  return BATTERY_MODELS[code] || code;
};

/** Number of PV strings the inverter has per-string capabilities for. */
const PV_STRINGS = 3;

/** Per-string capabilities for string `n` (1-based). */
const pvStringCapabilities = (n) => [`measure_power.pv${n}`, `measure_voltage.pv${n}`, `measure_current.pv${n}`];

// Dropped only on a model that cannot take strings, not on one with none connected yet.
const PV_CAPABILITIES = [
  'measure_power',
  'measure_power.dc_solar',
  'measure_efficiency',
  'meter_power',
  'meter_power.today',
];

/** Per-string tiles, one set for each of the PV_STRINGS strings. */
const pvStrings = (field) => {
  const decoders = {};
  for (let n = 1; n <= PV_STRINGS; n += 1) {
    const offset = 2 * (n - 1);
    if (field === 'power') decoders[`measure_power.pv${n}`] = (regs) => i32(regs, 39279 + offset);
    if (field === 'voltage') decoders[`measure_voltage.pv${n}`] = (regs) => round(scale(i16(regs, 39070 + offset), 10), 1);
    if (field === 'current') decoders[`measure_current.pv${n}`] = (regs) => round(scale(i16(regs, 39071 + offset), 100), 2);
  }
  return decoders;
};

/** Rated active power, for clamping and scaling limits before detection has run. */
const DEFAULT_RATED_POWER_W = 8000;

/** The inverter's rated power (39053) as detected at startup, or the fallback. */
const ratedPower = (device) => {
  const { ratedPower: detected } = device.getStoreValue('detected') || {};
  return detected > 0 ? detected : DEFAULT_RATED_POWER_W;
};

/** Split a 32-bit value into the two registers it occupies, high word first. */
const words32 = (value) => [(value >>> 16) & 0xffff, value & 0xffff];

/*
 * The vision takes 0x06 for a 16-bit register and 0x10 only for exactly one 32-bit value
 * (verified live). Any other 0x10 write is never answered and changes nothing (F-04).
 */
const writeU16 = (client, address, value) => client.writeRegister(address, value);
const writeI32 = (client, address, value) => client.writeRegisters(address, words32(value));

/**
 * Registers something else changed since this app wrote them before `since`, as "address=value".
 * Empty while a control of ours ran during the read, which may have caught it halfway.
 * @param {object} readers address -> (regs) => value, in the unit the write used
 */
const changedSince = (regs, device, readers, since) => {
  if (device.controlsRunning > 0 || device.controlEndedAt >= since) return [];
  const written = device.getStoreValue('writtenRegisters') || {};
  return Object.entries(readers).filter(([address, read]) => {
    const entry = written[address];
    if (!entry || entry.at >= since) return false;
    const value = read(regs);
    return value !== undefined && value !== entry.value;
  }).map(([address, read]) => `${address}=${read(regs)}`);
};

/**
 * Whether something else (e.g. a SOLARWATT Manager, D-08) changed a register this app wrote.
 * Latched, as the other value may last only seconds; cleared when the user controls the device
 * again or this app stops controlling it (CommonDevice.noteWrites).
 */
const controlOverridden = (regs, device, readers) => {
  const changed = changedSince(regs, device, readers, device.pollStartedAt).length > 0;
  if (changed && !device.getStoreValue('controlOverridden')) {
    device.onControlOverridden().catch((error) => device.error(error));
  }
  return changed || Boolean(device.getStoreValue('controlOverridden'));
};

/**
 * Keep-alive read-back before rewriting. Returns true, and latches the alarm, when another
 * writer changed our registers: then hand over rather than undo its value.
 */
const handOverIfOverridden = async (client, device, start, count, readers) => {
  const written = device.getStoreValue('writtenRegisters') || {};
  if (!Object.keys(readers).some((address) => written[address])) return false;
  const since = Date.now();
  const data = await client.readRegisters(start, count);
  const regs = new Map();
  for (let i = 0; i < count; i += 1) regs.set(start + i, data.readUInt16BE(i * 2));
  const changed = changedSince(regs, device, readers, since);
  if (changed.length === 0) return false;
  device.log(`changed by another writer: ${changed.join(', ')}`);
  await device.onControlOverridden();
  return true;
};

const inverter = {
  usesUnitId: VISION_USES_UNIT_ID,
  showsEnergyManager: true, // its controls can be overridden by a SOLARWATT Manager
  identityBlocks: VISION_IDENTITY,
  identity: visionIdentity,
  blocks: [
    { start: 39118, count: 55 }, // PV input, grid, AC active power, temperature, generation
    { start: 39601, count: 32 }, // energy counters: PV, battery, grid, output, input, load
    // optional: unanswered addresses cost a full timeout (F-01)
    { start: 39063, count: 13, optional: true }, // status, alarms, PV1-3 voltage/current
    { start: 39216, count: 11, optional: true }, // EPS and load power
    { start: 39279, count: 6, optional: true }, // PV1-3 power
    { start: 39248, count: 6, optional: true }, // active power per phase
    { start: 38914, count: 2, requires: 'hasMeter2' }, // Meter2/CT2 active power, see measure_power.external
    { start: 39053, count: 2, optional: true }, // rated power, to scale the limits below
    { start: 46616, count: 2, optional: true }, // export power limit
    { start: 49007, count: 1, optional: true }, // active power derating, 0.1 %
  ],
  capabilities: {
    measure_power: solarPowerAC,
    /*
     * Output cap in watts, stored in 49007 (per mille of rated power, 1000 = no limit). Not 49008,
     * which reads 0 when unlimited.
     */
    target_power: (regs) => {
      const permille = u16(regs, 49007);
      const rated = i32(regs, 39053);
      if (permille === undefined || !(rated > 0)) return undefined;
      return Math.round((Math.min(permille, 1000) / 1000) * rated);
    },
    // Feed-in cap (46616), 60000 when unlimited: shown and written at most as the rating.
    export_limit: (regs) => {
      const limit = i32(regs, 46616);
      const rated = i32(regs, 39053);
      if (limit === undefined) return undefined;
      return rated > 0 ? Math.min(limit, rated) : limit;
    },
    // kW with gain 1000, i.e. W
    'measure_power.dc_solar': (regs) => i32(regs, 39118),
    // includes battery discharge
    'measure_power.ac_inverter': (regs) => i32(regs, 39134),
    /*
     * House load as the inverter sees it: AC output plus grid import (verified live). Goes negative
     * when AC-coupled PV of another brand charges the battery.
     */
    'measure_power.load': (regs) => i32(regs, 39225),
    'measure_power.eps': (regs) => i32(regs, 39216),
    /*
     * Meter2/CT2 (38914, gain 10): a CT on another generator, e.g. PV of another brand. Only in the
     * upstream FoxESS document. Sign not tested (no CT2 on the test site); assumed > 0 generating.
     */
    'measure_power.external': (regs) => round(scale(i32(regs, 38914), 10), 0),
    measure_efficiency: inverterEfficiency,
    // see solarSide()
    meter_power: solarEnergy(39149, 39601),
    'meter_power.today': solarEnergy(39151, 39603),
    'meter_power.ac_inverter': (regs) => round(scale(u32(regs, 39149), 100), 2),
    'meter_power.ac_today': (regs) => round(scale(u32(regs, 39151), 100), 2),
    'meter_power.load': (regs) => round(scale(u32(regs, 39629), 100), 2),
    'meter_power.load_today': (regs) => round(scale(u32(regs, 39631), 100), 2),
    measure_temperature: (regs) => round(scale(i16(regs, 39141), 10), 1),
    'measure_voltage.1': (regs) => round(scale(i16(regs, 39123), 10), 1),
    'measure_voltage.2': (regs) => round(scale(i16(regs, 39124), 10), 1),
    'measure_voltage.3': (regs) => round(scale(i16(regs, 39125), 10), 1),
    'measure_current.1': (regs) => round(scale(i32(regs, 39126), 1000), 2),
    'measure_current.2': (regs) => round(scale(i32(regs, 39128), 1000), 2),
    'measure_current.3': (regs) => round(scale(i32(regs, 39130), 1000), 2),
    // same sign as 39134 (verified live)
    'measure_power.1': (regs) => i32(regs, 39248),
    'measure_power.2': (regs) => i32(regs, 39250),
    'measure_power.3': (regs) => i32(regs, 39252),
    measure_frequency: (regs) => round(scale(i16(regs, 39139), 100), 2),
    ...pvStrings('power'),
    ...pvStrings('voltage'),
    ...pvStrings('current'),
    running_state: runningState,
    alarm_problem: (regs) => {
      const fault = bit(regs, 39063, 6);
      const alarms = anySet(regs, ALARM_REGISTERS);
      if (fault === undefined && alarms === undefined) return undefined;
      return Boolean(fault || alarms);
    },
    alarm_heat: (regs) => anyBit(regs, ALARM_OVERTEMPERATURE),
    // a limit this app set, changed by something else
    'alarm_generic.control': (regs, device) => controlOverridden(regs, device, {
      49007: (r) => u16(r, 49007),
      46616: (r) => i32(r, 46616),
    }),
    // alarm_problem's bits by name
    active_faults: inverterFaults,

  },

  // read once per (re)start, see CommonDevice.runDetection
  detectBlocks: [
    { start: 39050, count: 6 }, // model id, string count, MPPT count, rated power
    { start: 37002, count: 1 }, // BMS connection state
    { start: 39605, count: 6 }, // lifetime battery charge / discharge counters
    { start: 38901, count: 1 }, // Meter2/CT2 connection state, 1 connected
  ],

  /*
   * PV capability from the declared string count, not from production: the vision three reports
   * 3 strings with none connected (verified live). A fact not read is left out, so its stored
   * verdict stands (runDetection).
   */
  detect: (regs) => {
    const detected = {};
    const strings = u16(regs, 39051);
    if (strings !== undefined) {
      const rated = i32(regs, 39053);
      Object.assign(detected, { hasPv: strings > 0, strings, ...(rated > 0 ? { ratedPower: rated } : {}) });
    }
    const battery = hasBattery(regs);
    if (battery !== undefined) detected.hasBattery = battery;
    const meter2 = u16(regs, 38901);
    if (meter2 !== undefined) detected.hasMeter2 = meter2 === 1;
    return detected;
  },

  /** Limits from 0 to the rated power in 1 % steps; solar energy titles name solarSide()'s side. */
  capabilityOptions: (detected) => {
    const options = {};
    const side = solarSide(detected);
    for (const cap of ['meter_power', 'meter_power.today']) options[cap] = { title: solarTitle(cap, side) };
    if (detected.ratedPower > 0) {
      const limits = { min: 0, max: detected.ratedPower, step: Math.max(1, Math.round(detected.ratedPower / 100)) };
      Object.assign(options, { target_power: limits, export_limit: limits });
    }
    return options;
  },

  controls: [
    {
      capabilities: ['target_power'],
      watched: true, // 49007, see alarm_generic.control
      write: async ({ client, device, values }) => {
        const rated = ratedPower(device);
        const share = Math.max(0, Math.min(1, Number(values.target_power) / rated));
        const raw = Math.round(share * 1000);
        await writeU16(client, 49007, raw);
        await device.noteWrites({ 49007: raw });
      },
    },
    {
      capabilities: ['export_limit'],
      watched: true, // 46616
      write: async ({ client, device, values }) => {
        const watts = Math.round(Math.max(0, Math.min(ratedPower(device), Number(values.export_limit))));
        await writeI32(client, 46616, watts);
        await device.noteWrites({ 46616: watts });
      },
    },
  ],

  unsupported: (detected) => {
    const drop = [];
    if (detected.hasPv === false) drop.push(...PV_CAPABILITIES);
    if (detected.hasBattery === false) drop.push(...AC_INVERTER_CAPABILITIES);
    if (detected.hasMeter2 !== true) drop.push('measure_power.external');
    // strings the model does not have
    const strings = Number.isInteger(detected.strings) ? detected.strings : PV_STRINGS;
    for (let n = strings + 1; n <= PV_STRINGS; n += 1) drop.push(...pvStringCapabilities(n));
    return drop;
  },
};

// --- battery ----------------------------------------------------------------------------

/** Deadband for the charging state: 39162 idles at a few watts, not exactly 0. */
const BATTERY_IDLE_BAND_W = 10;

/**
 * 49203 work modes. 5 is not defined in the protocol. 6 and 7 read back but writing them gets
 * silence, nothing changes (verified live, also reported on an H3): see REMOTE_MODES.
 */
const WORK_MODES = {
  1: 'self_use',
  2: 'feed_in',
  3: 'backup',
  4: 'peak_shaving',
  6: 'force_charge',
  7: 'force_discharge',
};

/**
 * Modes run through remote control, with their setpoint: target_power, or the BMS limit that
 * remoteSetpoint clamps to.
 */
const REMOTE_MODES = {
  homey: (device) => device.getCapabilityValue('target_power'),
  force_charge: () => Infinity,
  force_discharge: () => -Infinity,
};

/**
 * The target power mode a control write runs under. Moving the target_power slider on its own
 * hands control to Homey, the same way Homey's "Set target power" Flow card does.
 */
const targetPowerMode = (device, values) => {
  if (values.target_power_mode !== undefined) return values.target_power_mode;
  return values.target_power === undefined ? device.getCapabilityValue('target_power_mode') : 'homey';
};

/** After a successful write: switch the mode tile along when the slider took control. */
const showTargetPowerMode = async (device, mode) => {
  if (device.getCapabilityValue('target_power_mode') === mode) return;
  await device.setCapabilityValue('target_power_mode', mode).catch((error) => device.error(error));
};

/** Homey runs the battery: 'homey' mode, and no other writer has taken remote control over since. */
const homeyInControl = (device) => device.getCapabilityValue('target_power_mode') === 'homey'
  && !device.getStoreValue('controlOverridden');

/** As homeyInControl, for any of the battery's REMOTE_MODES. */
const remoteInControl = (device) => REMOTE_MODES[device.getCapabilityValue('target_power_mode')] !== undefined
  && !device.getStoreValue('controlOverridden');

/** Used to clamp a setpoint before the first 46018/46020 read: the vision three's rating. */
const DEFAULT_POWER_LIMIT_W = 8000;

/*
 * 46001 Remote Control: bit 0 enable, bit 1 = 1 "power-consumption system" so a positive
 * setpoint means charging (Homey's target_power convention), bits 3:2 = 01 target the
 * battery rather than the AC or grid side.
 */
const REMOTE_CONTROL_BATTERY = 0b0111;
const REMOTE_CONTROL_OFF = 0;

/** Remote control is rewritten this often, independent of the update interval. */
const BATTERY_KEEP_ALIVE_S = 10;

/** The inverter drops remote control by itself when no write arrives for this long: 3 missed keep-alives. */
const REMOTE_TIMEOUT_S = 3 * BATTERY_KEEP_ALIVE_S;

/*
 * Homey's setpoint, clamped to the BMS limits. No charging at or above max SoC: per Home Assistant's
 * nathanmarlor/foxess_modbus, remote control ignores it (not tested here).
 */
const remoteSetpoint = (device, requested) => {
  let watts = Number(requested) || 0;
  const soc = device.getCapabilityValue('measure_battery');
  const maxSoc = device.getCapabilityValue('battery_max_soc');
  if (watts > 0 && Number.isFinite(soc) && Number.isFinite(maxSoc) && soc >= maxSoc) watts = 0;
  // a BMS limit of 0 holds: force charge on a full battery must not become the default
  const limit = (capability) => {
    const value = device.getCapabilityValue(capability);
    return Number.isFinite(value) ? value : DEFAULT_POWER_LIMIT_W;
  };
  const chargeLimit = limit('measure_power.charge_limit');
  const dischargeLimit = limit('measure_power.discharge_limit');
  return Math.round(Math.max(-dischargeLimit, Math.min(chargeLimit, watts)));
};

/** Remote control as written (46001, 46003), for the override check. */
const REMOTE_CONTROL_READERS = {
  46001: (regs) => u16(regs, 46001),
  46003: (regs) => i32(regs, 46003),
};

/** Enable remote control with this setpoint, or switch it off. Setpoint first, enable last. */
const writeRemoteControl = async (client, device, mode, setpoint) => {
  if (mode !== 'homey') {
    await writeU16(client, 46001, REMOTE_CONTROL_OFF);
    await device.noteWrites({ 46001: null, 46003: null });
    return;
  }
  const watts = remoteSetpoint(device, setpoint);
  await writeI32(client, 46003, watts);
  await writeU16(client, 46002, REMOTE_TIMEOUT_S);
  await writeU16(client, 46001, REMOTE_CONTROL_BATTERY);
  await device.noteWrites({ 46001: REMOTE_CONTROL_BATTERY, 46003: watts });
};

/** "2RVM29204BFF036 (v31), 2RVS292048FA020 (v31), ...": every module on the BMS bus. */
const batteryModuleList = (regs) => {
  const count = Math.min(u16(regs, 37032) || 0, 32);
  const modules = [];
  for (let i = 0; i < count; i += 1) {
    const serial = str(regs, 37097 + 16 * i, 16);
    const version = u16(regs, 37033 + i);
    if (serial) modules.push(version === undefined ? serial : `${serial} (v${version})`);
  }
  return modules.join(', ') || undefined;
};

const SOC_CAPABILITIES = ['battery_min_soc', 'battery_max_soc', 'battery_min_soc_ongrid'];

/** Total charged plus total discharged energy in kWh (39605 + 39609). */
const batteryThroughput = (regs) => {
  const charged = u32(regs, 39605);
  const discharged = u32(regs, 39609);
  if (charged === undefined || discharged === undefined) return undefined;
  return round(scale(charged + discharged, 100), 2);
};

// BMS1 Fault1-6 (37626-37631): no meaning per bit documented, so only "a BMS fault".
const bmsFault = (regs) => anySet(regs, [37626, 37627, 37628, 37629, 37630, 37631]);
const bmsOffline = (regs) => (u16(regs, 37002) === undefined ? undefined : u16(regs, 37002) === 0);

const battery = {
  usesUnitId: VISION_USES_UNIT_ID,
  showsEnergyManager: true, // its controls can be overridden by a SOLARWATT Manager
  identityBlocks: [
    { start: 37002, count: 31 }, // BMS connection, versions, serial number, module count
    { start: 37632, count: 4 }, // remaining capacity, full-charge capacity, design energy
    { start: 30000, count: 32 }, // the inverter's model and serial number (its mDNS id carries the latter)
    { start: 37033, count: 32 }, // firmware version per battery module
    // serial number per module: 32 slots of 16 registers, unused ones 0
    { start: 37097, count: 125 },
    { start: 37222, count: 125 },
    { start: 37347, count: 125 },
    { start: 37472, count: 125 },
    { start: 37597, count: 12 },
  ],
  identity: (regs) => {
    const serialNumber = str(regs, 37005, 16);
    const kWh = (address) => {
      const value = round(scale(u16(regs, address), 100), 1); // Wh with gain 0.1 -> kWh
      return value === undefined ? undefined : `${value} kWh`;
    };
    const fcc = round(scale(u16(regs, 37633), 10), 1);
    return {
      model: modelFromSerial(serialNumber),
      serialNumber,
      unitSerial: str(regs, 30016, 16),
      // The BMS has no manufacturer register; the serial number does carry the brand.
      manufacturer: isSolarwattSerial(serialNumber) ? 'SOLARWATT' : undefined,
      firmware: u16(regs, 37003) === undefined ? undefined : String(u16(regs, 37003)),
      settings: {
        connectedTo: inverterLabel(regs),
        batteryModules: u16(regs, 37032) === undefined ? undefined : String(u16(regs, 37032)),
        batteryModuleList: batteryModuleList(regs),
        batteryDesignEnergy: kWh(37635),
        // usable capacity after ageing, not the current charge: 14.4 kWh at 85% and 58% SoC alike
        batteryRemainingCapacity: kWh(37632),
        batteryFcc: fcc === undefined ? undefined : `${fcc} Ah`,
      },
    };
  },
  blocks: [
    { start: 37609, count: 28 }, // BMS voltage, current, temperatures, SoC, SoH, cells, faults
    { start: 39162, count: 2 }, // charge/discharge power
    { start: 39605, count: 8 }, // charged / discharged energy counters
    { start: 37002, count: 1, optional: true }, // BMS connection state
    { start: 46018, count: 4, optional: true }, // available discharge / charge power
    { start: 46607, count: 5, optional: true }, // max currents, SoC window
    { start: 49203, count: 1, optional: true }, // work mode
    { start: 46001, count: 7, optional: true }, // remote control: enable, timeout, setpoint, countdown
    // the inverter's limits, which cap the battery too: rated power, power limit, export limit
    { start: 39053, count: 2, optional: true },
    { start: 49007, count: 1, optional: true },
    { start: 46616, count: 2, optional: true },
    { start: 49241, count: 2, optional: true }, // ripple control enable, trigger inputs K1-K4
    ALARM_BLOCK,
  ],

  capabilities: {
    // > 0 charging, as Homey. Not 39230/39237: opposite sign (verified live, D-05).
    measure_power: (regs) => i32(regs, 39162),
    /*
     * The remote-control setpoint the inverter runs, whoever wrote it (D-08); empty while remote
     * control is off. Bit 1 of 46001 gives 46003's sign. Not copied into target_power, or the
     * keep-alive would repeat another writer's value.
     */
    'measure_power.target': (regs) => {
      const control = u16(regs, 46001);
      const setpoint = i32(regs, 46003);
      if (control === undefined || setpoint === undefined) return undefined;
      if (!(control & 0b1)) return null;
      return control & 0b10 ? setpoint : -setpoint;
    },
    // owned by Homey: see `controls`
    target_power: null,
    // a REMOTE_MODES mode, or the inverter's work mode (49203).
    target_power_mode: (regs, device) => {
      // after an override Homey is no longer in control
      if (remoteInControl(device)) return device.getCapabilityValue('target_power_mode');
      const mode = u16(regs, 49203);
      if (mode === undefined) return undefined;
      return WORK_MODES[mode] || null;
    },
    // BMS SoC: "System SoC" 39423 never answers (F-02).
    measure_battery: (regs) => u16(regs, 37612),
    /*
     * An inverter limit that can hold the battery back: export limit (46616) below rated power,
     * power limit (49007) below 100 %, or ripple control (49241 on, a K input set in 49242).
     */
    inverter_limit_active: (regs) => {
      const exportLimit = i32(regs, 46616);
      const rated = i32(regs, 39053);
      const share = u16(regs, 49007);
      const exportLimited = exportLimit !== undefined && rated > 0 ? exportLimit < rated : undefined;
      const powerLimited = share !== undefined ? share < 1000 : undefined;
      const ripple = u16(regs, 49241);
      const rippleLimited = ripple !== undefined ? ripple === 1 && u16(regs, 49242) > 0 : undefined;
      if ([exportLimited, powerLimited, rippleLimited].every((value) => value === undefined)) return undefined;
      return Boolean(exportLimited || powerLimited || rippleLimited);
    },
    // same register as measure_power
    battery_charging_state: (regs) => {
      const power = i32(regs, 39162);
      if (power === undefined) return undefined;
      if (power > BATTERY_IDLE_BAND_W) return 'charging';
      if (power < -BATTERY_IDLE_BAND_W) return 'discharging';
      return 'idle';
    },
    // min, on-grid min, max: the on-grid floor sits between the two
    battery_min_soc: (regs) => u16(regs, 46609),
    battery_min_soc_ongrid: (regs) => u16(regs, 46611),
    battery_max_soc: (regs) => u16(regs, 46610),
    measure_voltage: (regs) => round(scale(u16(regs, 37609), 10), 1),
    measure_current: (regs) => round(scale(i16(regs, 37610), 10), 1),
    'measure_temperature.min': (regs) => round(scale(i16(regs, 37618), 10), 1),
    'measure_temperature.max': (regs) => round(scale(i16(regs, 37617), 10), 1),
    'measure_voltage.cell_min': (regs) => round(scale(u16(regs, 37620), 1000), 3),
    'measure_voltage.cell_max': (regs) => round(scale(u16(regs, 37619), 1000), 3),
    // 46020 reads negative
    'measure_power.charge_limit': (regs) => {
      const value = i32(regs, 46020);
      return value === undefined ? undefined : Math.abs(value);
    },
    /*
     * The BMS limit (46018), or the inverter's power limit (49007) when lower: 46018 does not
     * follow 49007 (verified live). remoteSetpoint clamps to this.
     */
    'measure_power.discharge_limit': (regs) => {
      const value = i32(regs, 46018);
      if (value === undefined) return undefined;
      const share = u16(regs, 49007);
      const rated = i32(regs, 39053);
      const inverterLimit = share !== undefined && rated > 0 ? Math.round((rated * share) / 1000) : Infinity;
      return Math.min(Math.abs(value), inverterLimit);
    },
    'meter_power.charged': (regs) => round(scale(u32(regs, 39605), 100), 2),
    'meter_power.discharged': (regs) => round(scale(u32(regs, 39609), 100), 2),
    // BMS ambient temperature
    measure_temperature: (regs) => round(scale(i16(regs, 37611), 10), 1),
    measure_soh: (regs) => u16(regs, 37624),
    // EU Battery Regulation figures (vision document, last pages). SoC x remaining capacity (37632).
    measure_residual_energy: (regs) => {
      const soc = u16(regs, 37612);
      const capacity = scale(u16(regs, 37632), 100); // 10 Wh units -> kWh
      if (soc === undefined || capacity === undefined) return undefined;
      return round((Math.min(soc, 100) / 100) * capacity, 2);
    },
    // Full cycle equivalents: throughput / 2 / design energy (37635).
    measure_battery_cycles: (regs) => {
      const throughput = batteryThroughput(regs);
      const design = scale(u16(regs, 37635), 100);
      if (throughput === undefined || !(design > 0)) return undefined;
      return round(throughput / 2 / design, 1);
    },
    'meter_power.throughput': batteryThroughput,
    alarm_problem: (regs) => anyTrue(
      bmsFault(regs),
      bmsOffline(regs),
      anyBit(regs, ALARM_STORAGE_ABNORMAL, ALARM_STORAGE_REVERSED, ALARM_BMS_LOST),
    ),
    // faults only, not a low SoC
    alarm_battery: (regs) => anyTrue(bmsFault(regs), anyBit(regs, ALARM_STORAGE_ABNORMAL, ALARM_STORAGE_REVERSED)),
    // 37002 = 0, or the inverter's "BMS lost"
    alarm_connectivity: (regs) => anyTrue(bmsOffline(regs), anyBit(regs, ALARM_BMS_LOST)),
    // remote control this app set, changed by something else (D-08)
    'alarm_generic.control': (regs, device) => controlOverridden(regs, device, REMOTE_CONTROL_READERS),

  },

  /** A vision without a battery still answers the BMS block, with 37002 "not connected". */
  pairable: (regs) => u16(regs, 37002) !== 0,

  controls: [
    {
      /*
       * REMOTE_MODES: remote control, rewritten by keepAlive within the 46002 watchdog. Any other
       * mode is a work mode (49203) with remote control off.
       */
      capabilities: ['target_power', 'target_power_mode'],
      watched: true, // 46001/46003
      keepAliveSeconds: BATTERY_KEEP_ALIVE_S,
      initial: { target_power: 0 },
      write: async ({ client, device, values }) => {
        const mode = targetPowerMode(device, values);
        if (REMOTE_MODES[mode]) {
          const setpoint = mode === 'homey' && values.target_power !== undefined ? values.target_power : REMOTE_MODES[mode](device);
          await writeRemoteControl(client, device, 'homey', setpoint);
          await showTargetPowerMode(device, mode);
          return;
        }
        const code = Object.keys(WORK_MODES).find((key) => WORK_MODES[key] === mode);
        if (!code) throw Error(`Unknown work mode ${mode}`);
        await writeRemoteControl(client, device, 'off');
        await writeU16(client, 49203, Number(code));
      },
      // Read back first: a SOLARWATT Manager writes its own setpoint for seconds at a time (seen live).
      keepAlive: async ({ client, device }) => {
        if (!remoteInControl(device)) return;
        // hand over: ours lapses with the 46002 watchdog
        if (await handOverIfOverridden(client, device, 46001, 4, REMOTE_CONTROL_READERS)) return;
        // the BMS limits move, so a force mode's setpoint follows them
        await writeRemoteControl(client, device, 'homey', REMOTE_MODES[device.getCapabilityValue('target_power_mode')](device));
      },
      release: async ({ client, device }) => {
        // not after an override: that would cut off the other writer too
        if (!remoteInControl(device)) return;
        await writeRemoteControl(client, device, 'off');
      },
    },
    {
      /*
       * The inverter silently ignores a write breaking min SoC <= on-grid min <= max SoC (F-05), so
       * the write order keeps every intermediate state valid.
       */
      capabilities: SOC_CAPABILITIES,
      guard: ({ device, values }) => {
        const [min, max, ongrid] = SOC_CAPABILITIES.map((cap) => (values[cap] !== undefined ? values[cap] : device.getCapabilityValue(cap)));
        const valid = [min, max, ongrid].every((soc) => Number.isInteger(soc) && soc >= 10 && soc <= 100);
        return valid && min <= ongrid && ongrid <= max ? null : 'errors.socRange';
      },
      write: async ({ client, device, values }) => {
        const [min, max, ongrid] = SOC_CAPABILITIES.map((cap) => (values[cap] !== undefined ? values[cap] : device.getCapabilityValue(cap)));
        const current = SOC_CAPABILITIES.map((cap) => device.getCapabilityValue(cap));
        const steps = [];
        if (max >= current[1]) steps.push([46610, max]); // raise the ceiling first
        if (min <= current[2]) steps.push([46609, min], [46611, ongrid]);
        else steps.push([46611, ongrid], [46609, min]);
        if (max < current[1]) steps.push([46610, max]); // lower the ceiling last
        for (const [address, value] of steps) {
          // eslint-disable-next-line no-await-in-loop
          await writeU16(client, address, value);
        }
      },
    },
  ],
};

// --- meter ------------------------------------------------------------------------------

/** True when a meter/CT is connected. */
const meterConnected = (regs) => u16(regs, 38801) === 1;

/** Meter1/CT1 register when the meter is connected, else the inverter's own grid reading. */
const meterOrGrid = (regs, meterAddress, meterGain, gridAddress, gridGain, decimals) => {
  if (meterConnected(regs)) {
    const value = round(scale(i32(regs, meterAddress), meterGain), decimals);
    if (value !== undefined) return value;
  }
  return round(scale(i16(regs, gridAddress), gridGain), decimals);
};

// Meter1 power is > 0 exporting, as 39168 (verified live); flipped to Homey's > 0 importing.
const meterPower = (regs, address) => negate(round(scale(i32(regs, address), 10), 1));

const meter = {
  usesUnitId: VISION_USES_UNIT_ID,
  identityBlocks: [
    ...VISION_IDENTITY,
    { start: 38801, count: 1 }, // meter connection state
    { start: 36148, count: 1 }, // meter version (typed STR, but a number: deviation D-04)
    { start: 49207, count: 1 }, // how the meter is attached: off, 1-phase meter, CT, 3-phase meter
  ],
  // the meter's identity strings are binary (F-03): the inverter's instead
  identity: (regs) => {
    const mode = u16(regs, 49207);
    return {
      ...visionIdentity(regs),
      settings: {
        connectedTo: inverterLabel(regs),
        meterVersion: u16(regs, 36148) === undefined ? undefined : String(u16(regs, 36148)),
        meterConnection: mode >= 0 && mode <= 3 ? { i18n: `settings.meterConnection.${mode}` } : undefined,
      },
    };
  },
  blocks: [
    { start: 38801, count: 47 }, // Meter1/CT1 voltages, currents, power, frequency
    { start: 39118, count: 55 }, // grid voltages/frequency + meter collection active power
    { start: 39613, count: 8 }, // feed-in / taken energy counters
    ALARM_BLOCK,
  ],
  capabilities: {
    // > 0 exporting: flipped to Homey's > 0 importing
    measure_power: (regs) => negate(i32(regs, 39168)),
    'measure_power.1': (regs) => meterPower(regs, 38816),
    'measure_power.2': (regs) => meterPower(regs, 38818),
    'measure_power.3': (regs) => meterPower(regs, 38820),
    'measure_current.1': (regs) => round(scale(i32(regs, 38808), 1000), 2),
    'measure_current.2': (regs) => round(scale(i32(regs, 38810), 1000), 2),
    'measure_current.3': (regs) => round(scale(i32(regs, 38812), 1000), 2),
    'measure_voltage.1': (regs) => meterOrGrid(regs, 38802, 10, 39123, 10, 1),
    'measure_voltage.2': (regs) => meterOrGrid(regs, 38804, 10, 39124, 10, 1),
    'measure_voltage.3': (regs) => meterOrGrid(regs, 38806, 10, 39125, 10, 1),
    measure_frequency: (regs) => meterOrGrid(regs, 38846, 100, 39139, 100, 2),
    // already negative on export (verified live)
    measure_power_factor: (regs) => round(scale(i32(regs, 38838), 1000), 3),
    measure_reactive_power: (regs) => round(scale(i32(regs, 38822), 10), 0),
    measure_apparent_power: (regs) => round(scale(i32(regs, 38830), 10), 0),
    'meter_power.imported': (regs) => round(scale(u32(regs, 39617), 100), 2),
    'meter_power.exported': (regs) => round(scale(u32(regs, 39613), 100), 2),
    // 38801 != 1, or the inverter's "meter lost"
    alarm_connectivity: (regs) => anyTrue(
      u16(regs, 38801) === undefined ? undefined : u16(regs, 38801) !== 1,
      anyBit(regs, ALARM_METER_LOST),
    ),
  },

  pairable: meterConnected,
};

// --- charger (Fox ESS EVC) --------------------------------------------------------------

const CONNECTOR_STATUS = {
  IDLE: 0,
  CONNECT: 1,
  START: 2,
  CHARGING: 3,
  EV_SUSPENDED: 4,
  FINISH: 5,
  FAULT: 6,
  LOCKED: 8,
  EVC_SUSPENDED: 9,
};

/** Stop reason 0x1002 -> charger_stop_reason (protocol 1.08, appendix 1). 0 is "none". */
const STOP_REASONS = {
  1: 'stopped_on_command',
  2: 'time_limit_reached',
  3: 's2_timeout',
  4: 'pause_timeout',
  5: 'emergency_stop',
  6: 'cp_voltage',
  7: 'connector_fault',
  8: 'ac_contactor',
  9: 'electronic_lock',
  10: 'card_reader',
  11: 'overcurrent',
  12: 'overvoltage',
  13: 'undervoltage',
  14: 'port_overtemperature',
  15: 'leakage_current',
  16: 'n_line_reversed',
  17: 'frequency',
  18: 'stop_button',
  19: 'circuit_breaker',
  20: 'phase_loss',
  21: 'pe_fault',
  22: 'external_meter',
  23: 'ambient_overtemperature',
  24: 'metering_chip',
  25: 'access_control',
  26: 'phase_box',
  27: 'energy_limit_reached',
};

/** Fault bits of 0x101A, bit 0 first (protocol 1.08, appendix 2); names in locales chargerFaults. */
const CHARGER_FAULTS = [
  'emergency_stop', 'overvoltage', 'undervoltage', 'overcurrent', 'port_temperature',
  'pe_grounding', 'leakage_current', 'frequency', 'cp', 'connector', 'ac_contactor',
  'electronic_lock', 'breaker', 'cc', 'external_meter', 'metering_chip',
  'ambient_temperature', 'access_control',
];

/** "1.4–11 kW, 6–16 A": the power and per-phase current range from 0x1011-0x1014 (0.1 steps). */
const chargerRange = (regs) => {
  const [maxKw, minKw, maxA, minA] = [0x1011, 0x1012, 0x1013, 0x1014].map((address) => scale(u16(regs, address), 10));
  if ([maxKw, minKw, maxA, minA].some((value) => value === undefined)) return undefined;
  return `${minKw}–${maxKw} kW, ${minA}–${maxA} A`;
};

/*
 * Homey's target power as session limits 0x3001 (0.1 A) and 0x3002 (0.1 kW). The charger
 * reverts them to its rating after 1 min without a write (protocol), within 10 s without a car
 * (C-05), so they are refreshed every CHARGER_KEEP_ALIVE_S during a session.
 */
const CHARGER_KEEP_ALIVE_S = 30;
const DEFAULT_CHARGER_MAX_W = 11000;
const DEFAULT_CHARGER_MIN_W = 1400;
const DEFAULT_CHARGER_MAX_A = 16;

/** Work mode 0x3000: 0 controlled (app or card starts), 1 plug and charge, 2 locked. */
const CHARGER_MODE_CONTROLLED = 0;
const CHARGER_MODE_PLUG_AND_CHARGE = 1;
const CHARGER_MODE_LOCK = 2;

/** 0x3003/0x3004 at 0xFFFF: no time or energy limit on the session. */
const CHARGER_NO_LIMIT = 0xffff;

/** 0x3004 in whole kWh: the session energy at which the charger stops, null without a limit. */
const sessionEnergyLimit = (regs) => {
  const kwh = u16(regs, 0x3004);
  if (kwh === undefined) return undefined;
  return kwh === CHARGER_NO_LIMIT ? null : kwh;
};

/** Connector states with a session that a power limit applies to. */
const chargerSessionActive = (device) => ['plugged_in_charging', 'plugged_in_paused']
  .includes(device.getCapabilityValue('evcharger_charging_state'));

/** The session limits as written (0x3001, 0x3002), for the override check. */
const CHARGER_LIMIT_READERS = {
  0x3001: (regs) => u16(regs, 0x3001),
  0x3002: (regs) => u16(regs, 0x3002),
};

/** Connector states 0x1003 of a session: start, charging, paused (as in protocol 2.44/2.45). */
const SESSION_STATES = [CONNECTOR_STATUS.START, CONNECTOR_STATUS.CHARGING,
  CONNECTOR_STATUS.EV_SUSPENDED, CONNECTOR_STATUS.EVC_SUSPENDED];

/** A setting the device refuses: shown as it is, not as a failed write. */
const settingRefusal = (message) => Object.assign(Error(message), { refusal: true });

// The "Start charging" setting follows 0x3000; locked (2) keeps the mode to unlock to.
const syncWorkMode = async (regs, device) => {
  const mode = u16(regs, 0x3000);
  if (mode !== CHARGER_MODE_CONTROLLED && mode !== CHARGER_MODE_PLUG_AND_CHARGE) return;
  if (device.getSetting('workMode') === String(mode)) return;
  await device.setSettings({ workMode: String(mode) });
};

/*
 * 0x101C: UID of the card that started this session (protocol 2.26). Fires once per session.
 * Not tested: 0x101C in a session started otherwise; assumed 0.
 */
const triggerCardStart = async (regs, device) => {
  const status = u16(regs, 0x1003);
  const uid = u32(regs, 0x101c);
  if (status === undefined || uid === undefined) return;
  const seen = device.getStoreValue('sessionCard');
  if (!SESSION_STATES.includes(status)) {
    if (seen) await device.setStoreValue('sessionCard', null);
    return;
  }
  if (uid === 0 || uid === seen) return;
  await device.setStoreValue('sessionCard', uid);
  const card = uid.toString(16).toUpperCase().padStart(8, '0');
  device.log(`charging started with card ${card}`);
  await device.homey.flow.getDeviceTriggerCard('charging_started_card').trigger(device, { card });
};

/**
 * Both session limits in one 0x10 write (protocol 1.08, section 2). The current stays at the
 * rating, so the power limit decides; below the minimum power it is 0.
 */
const writeChargerLimit = async (client, device, watts) => {
  const { maxPower = DEFAULT_CHARGER_MAX_W, minPower = DEFAULT_CHARGER_MIN_W, maxCurrent = DEFAULT_CHARGER_MAX_A } = device.detected;
  const limited = Math.min(maxPower, Math.max(0, Number(watts) || 0));
  const power = limited < minPower ? 0 : Math.floor(limited / 100);
  const current = Math.round(maxCurrent * 10);
  await client.writeRegisters(0x3001, [current, power]);
  return { current, power };
};

/** Homey's target power as the session limit, remembered so an override can be spotted. */
const holdChargerLimit = async (client, device, watts) => {
  const { current, power } = await writeChargerLimit(client, device, watts);
  await device.noteWrites({ 0x3001: current, 0x3002: power });
};

/*
 * Homey stopped the charge (0x4001 = 2): no non-zero limit is written until Homey starts it or
 * the car is unplugged, as such a write can resume charging (Home Assistant's
 * andrewmatten/foxess-ev-charger, another model; not tested here).
 */
const chargingStopped = (device) => device.getStoreValue('chargingStopped') === true;
const noteChargingStopped = async (device, stopped) => {
  if (chargingStopped(device) !== stopped) await device.setStoreValue('chargingStopped', stopped);
};

/** Back to the charger's own rating: Homey no longer holds the session limit. */
const releaseChargerLimit = async (client, device) => {
  await writeChargerLimit(client, device, device.detected.maxPower || DEFAULT_CHARGER_MAX_W);
  await device.noteWrites({ 0x3001: null, 0x3002: null });
};

const charger = {
  usesUnitId: true,
  showsEnergyManager: true, // a SOLARWATT Manager may override its session limit (not seen)
  afterData: async (regs, device) => {
    await syncWorkMode(regs, device).catch((error) => device.error('work mode setting:', error.message));
    await triggerCardStart(regs, device);
  },
  identityBlocks: [
    { start: 0x1000, count: 50 }, // 0x1000-0x1031, incl. model code and serial
    { start: 0x300a, count: 1 }, // 1-/3-phase switching
  ],
  identity: (regs) => {
    const version = u16(regs, 0x1001);
    const phaseSwitching = u16(regs, 0x300a);
    return {
      model: str(regs, 0x101e, 4),
      serialNumber: str(regs, 0x1022, 16),
      unitSerial: str(regs, 0x1022, 16),
      manufacturer: 'Fox ESS',
      firmware: version === undefined
        ? undefined
        : `${version >> 8}.${String(version & 0xff).padStart(2, '0')}`,
      settings: {
        chargerRange: chargerRange(regs),
        ...(phaseSwitching === undefined ? {} : { phaseSwitching: phaseSwitching === 1 }),
      },
    };
  },
  blocks: [
    { start: 0x1000, count: 50 }, // status, CP/CC, voltages, currents, power, energy
    // power in W; absent on fw 1.30 (C-02), which falls back to 0x100E (0.1 kW)
    { start: 0x1048, count: 2, optional: true },
    { start: 0x3000, count: 5 }, // work mode, session current/power limit, session time/energy limit
  ],

  /*
   * Rated range 0x1011-0x1014 (0.1 steps), for target_power. 0x1012 is assumed to be the
   * single-phase minimum (undocumented), so it triples when 0x300A fixes three phases.
   */
  detectBlocks: [{ start: 0x1011, count: 4 }, { start: 0x300a, count: 1 }],
  detect: (regs) => {
    const [maxKw, minKw, maxA] = [0x1011, 0x1012, 0x1013].map((address) => u16(regs, address));
    if (!(maxKw > 0) || minKw === undefined || !(maxA > 0)) return {};
    const fixedThreePhase = u16(regs, 0x300a) === 0;
    return {
      maxPower: maxKw * 100,
      minPower: minKw * 100 * (fixedThreePhase ? 3 : 1),
      maxCurrent: maxA / 10,
      phaseSwitching: !fixedThreePhase,
    };
  },

  /** Settings stored in the charger; read/write registers take 0x10. */
  settingWrites: {
    phaseSwitching: async ({ client, value }) => client.writeRegisters(0x300a, [value ? 1 : 0]),
    // 0x3000, only without a cable (2.41). While locked, stored as the mode to unlock to.
    workMode: async ({ client, device, value }) => {
      if (device.getCapabilityValue('evcharger_charging_state') !== 'plugged_out') {
        throw settingRefusal(device.homey.__('errors.unplugFirst'));
      }
      const mode = Number(value);
      const current = (await client.readRegisters(0x3000, 1)).readUInt16BE(0);
      if (current === CHARGER_MODE_LOCK) {
        await device.setStoreValue('chargerWorkMode', mode);
        return;
      }
      await client.writeRegisters(0x3000, [mode]);
    },
  },

  // 0 to the rating in 0.1 kW steps, excluding (0, minimum power).
  capabilityOptions: (detected) => {
    if (!(detected.maxPower > 0)) return {};
    return {
      target_power: {
        min: 0, max: detected.maxPower, step: 100, excludeMin: 0, excludeMax: detected.minPower,
      },
    };
  },

  capabilities: {
    measure_power: (regs) => {
      const precise = u32(regs, 0x1048);
      if (precise !== undefined) return precise;
      const coarse = u16(regs, 0x100e); // 0.1 kW steps
      return coarse === undefined ? undefined : coarse * 100;
    },
    // the power limit the charger runs with, whoever set it; current 0 means stop
    'measure_power.target': (regs) => {
      const current = u16(regs, 0x3001);
      const power = u16(regs, 0x3002); // 0.1 kW steps
      if (current === undefined || power === undefined) return undefined;
      return current === 0 ? 0 : power * 100;
    },
    evcharger_charging: (regs) => {
      const status = u16(regs, 0x1003);
      return status === undefined ? undefined : status === CONNECTOR_STATUS.CHARGING;
    },
    evcharger_charging_state: (regs) => {
      const status = u16(regs, 0x1003);
      if (status === undefined) return undefined;
      if (status === CONNECTOR_STATUS.CHARGING) return 'plugged_in_charging';
      if (status === CONNECTOR_STATUS.EV_SUSPENDED || status === CONNECTOR_STATUS.EVC_SUSPENDED) {
        return 'plugged_in_paused';
      }
      // CC tells whether a plug is inserted
      const cc = u16(regs, 0x1005);
      if (cc === 0) return 'plugged_out';
      if (cc === 1) return 'plugged_in';
      return status === CONNECTOR_STATUS.IDLE ? 'plugged_out' : 'plugged_in';
    },
    // 0x1018, see meter_power
    'meter_power.session': (regs) => round(scale(u32(regs, 0x1018), 10), 1),
    // 0x3004, whoever set it; empty without a limit
    active_energy_limit: (regs) => sessionEnergyLimit(regs),
    // owned by Homey: see `controls`
    target_power: null,
    target_power_mode: null,
    'measure_current.1': (regs) => round(scale(u16(regs, 0x100b), 10), 1),
    'measure_current.2': (regs) => round(scale(u16(regs, 0x100c), 10), 1),
    'measure_current.3': (regs) => round(scale(u16(regs, 0x100d), 10), 1),
    'measure_voltage.1': (regs) => round(scale(u16(regs, 0x1008), 10), 1),
    'measure_voltage.2': (regs) => round(scale(u16(regs, 0x1009), 10), 1),
    'measure_voltage.3': (regs) => round(scale(u16(regs, 0x100a), 10), 1),
    // offset +50 °C, 0.1 resolution
    measure_temperature: (regs) => {
      const raw = u16(regs, 0x1007);
      return raw === undefined ? undefined : round(raw / 10 - 50, 1);
    },
    // cable lock 0x100F, set through 0x4000
    locked: (regs) => (u16(regs, 0x100f) === undefined ? undefined : u16(regs, 0x100f) === 1),
    // charger locked: work mode 0x3000 = 2
    'locked.charger': (regs) => (u16(regs, 0x3000) === undefined ? undefined : u16(regs, 0x3000) === CHARGER_MODE_LOCK),
    // 0x1016 is the lifetime meter, 0x1018 the session, despite their names (C-04).
    meter_power: (regs) => round(scale(u32(regs, 0x1016), 10), 1),
    // Faults only (0x101A): alarm word 0x1015 is set on a healthy unit without accessories (C-03).
    alarm_problem: (regs) => {
      const faults = u32(regs, 0x101a);
      return faults === undefined ? undefined : faults !== 0;
    },
    // fault bit 4 (port) or 16 (ambient temperature), appendix 2
    alarm_heat: (regs) => {
      const faults = u32(regs, 0x101a);
      return faults === undefined ? undefined : Boolean(faults & ((1 << 4) | (1 << 16)));
    },
    // The session limit this app set, changed by something else. Only during a session (C-05).
    'alarm_generic.control': (regs, device) => controlOverridden(regs, device,
      chargerSessionActive(device) ? CHARGER_LIMIT_READERS : {}),
    // follows the limit the charger holds, like active_energy_limit
    session_energy_limit: (regs) => sessionEnergyLimit(regs),
    // why the last charge ended (0x1002); a restart clears it (2.3)
    charger_stop_reason: (regs) => {
      const code = u16(regs, 0x1002);
      if (code === undefined) return undefined;
      if (code === 0) return null;
      return STOP_REASONS[code] || 'unknown';
    },
    // alarm_problem's bits by name
    active_faults: (regs, device) => {
      const faults = u32(regs, 0x101a);
      if (faults === undefined) return undefined;
      const names = CHARGER_FAULTS.filter((id, index) => faults & (2 ** index))
        .map((id) => device.homey.__(`chargerFaults.${id}`));
      // unnamed bits as a raw mask
      const unnamed = faults - (faults % (2 ** CHARGER_FAULTS.length));
      if (unnamed) names.push(`0x${unnamed.toString(16)}`);
      return names.length ? names.join(', ') : null;
    },
  },

  controls: [
    {
      /*
       * One control, as Homey's "Set target power" card changes all three. Start/stop: write-only
       * 0x4001 (0x06). 'homey': target_power is the session limit; 'device': the charger decides.
       */
      capabilities: ['evcharger_charging', 'target_power', 'target_power_mode'],
      watched: true, // 0x3001/0x3002
      initial: (device) => ({
        target_power: device.detected.maxPower || DEFAULT_CHARGER_MAX_W,
        target_power_mode: 'device',
      }),
      keepAliveSeconds: CHARGER_KEEP_ALIVE_S,
      guard: ({ device, values }) => (values.evcharger_charging
        && device.getCapabilityValue('evcharger_charging_state') === 'plugged_out'
        ? 'errors.noCarConnected' : null),
      write: async ({ client, device, values }) => {
        const mode = targetPowerMode(device, values);
        const target = values.target_power !== undefined ? values.target_power : device.getCapabilityValue('target_power');
        if (mode === 'homey') {
          if (values.evcharger_charging === false || !(Number(target) > 0)) {
            await client.writeRegister(0x4001, 2);
            await noteChargingStopped(device, true);
            // no longer held, so not watched
            await device.noteWrites({ 0x3001: null, 0x3002: null });
          } else {
            // limit first, so a start never runs at full power
            await holdChargerLimit(client, device, target);
            await noteChargingStopped(device, false);
            if (values.evcharger_charging === true) await client.writeRegister(0x4001, 1);
          }
          await showTargetPowerMode(device, mode);
          return;
        }
        // back to the rating now rather than after the watchdog
        if (values.target_power_mode !== undefined && chargerSessionActive(device) && !chargingStopped(device)) {
          await releaseChargerLimit(client, device);
        } else {
          await device.noteWrites({ 0x3001: null, 0x3002: null });
        }
        if (values.evcharger_charging !== undefined) {
          await client.writeRegister(0x4001, values.evcharger_charging ? 1 : 2);
          await noteChargingStopped(device, !values.evcharger_charging);
        }
      },
      // Only during a session: in "connect" and "finish" non-zero limits start charging.
      keepAlive: async ({ client, device }) => {
        if (!chargerSessionActive(device)) {
          // the charger drops the limits itself; this also ends a latched override
          await device.noteWrites({ 0x3001: null, 0x3002: null });
          // a stop by Homey does not apply to the next car
          if (device.getCapabilityValue('evcharger_charging_state') === 'plugged_out') await noteChargingStopped(device, false);
          return;
        }
        if (!homeyInControl(device) || chargingStopped(device)) return;
        if (await handOverIfOverridden(client, device, 0x3001, 2, CHARGER_LIMIT_READERS)) return;
        const target = device.getCapabilityValue('target_power');
        if (Number(target) > 0) await holdChargerLimit(client, device, target);
      },
      release: async ({ client, device }) => {
        // not after an override: that would undo the other writer's limit
        if (!homeyInControl(device) || !chargerSessionActive(device) || chargingStopped(device)) return;
        await releaseChargerLimit(client, device);
      },
    },
    {
      /*
       * Session energy limit 0x3004 in kWh (2.45; counting from session start not tested), 0 removes
       * it. Only during a session; the guard reads 0x1003 live, as the last poll may predate it.
       */
      capabilities: ['session_energy_limit'],
      guard: async ({ client, device }) => {
        if (device.getCapabilityValue('evcharger_charging_state') === 'plugged_out') return 'errors.noChargingSession';
        const status = (await client.readRegisters(0x1003, 1)).readUInt16BE(0);
        return SESSION_STATES.includes(status) ? null : 'errors.noChargingSession';
      },
      write: async ({ client, values }) => {
        const kwh = Math.round(Number(values.session_energy_limit) || 0);
        await client.writeRegisters(0x3004, [kwh > 0 ? Math.min(kwh, CHARGER_NO_LIMIT - 1) : CHARGER_NO_LIMIT]);
      },
    },
    {
      // cable lock: write-only 0x4000 (1 unlock, 2 lock)
      capabilities: ['locked'],
      write: async ({ client, values }) => client.writeRegister(0x4000, values.locked ? 2 : 1),
    },
    {
      /*
       * Charger lock: work mode 0x3000 = 2; unlocking restores the mode from before. Only without a
       * cable (2.41).
       */
      capabilities: ['locked.charger'],
      guard: ({ device }) => (device.getCapabilityValue('evcharger_charging_state') === 'plugged_out'
        ? null : 'errors.unplugFirst'),
      write: async ({ client, device, values }) => {
        if (values['locked.charger']) {
          const current = (await client.readRegisters(0x3000, 1)).readUInt16BE(0);
          if (current !== CHARGER_MODE_LOCK) await device.setStoreValue('chargerWorkMode', current);
          await client.writeRegisters(0x3000, [CHARGER_MODE_LOCK]);
          return;
        }
        const previous = device.getStoreValue('chargerWorkMode');
        const chosen = Number(device.getSetting('workMode')) || CHARGER_MODE_CONTROLLED;
        await client.writeRegisters(0x3000, [Number.isInteger(previous) ? previous : chosen]);
      },
    },
  ],
};

module.exports = {
  inverter, battery, meter, charger, CONNECTOR_STATUS, WORK_MODES,
};
