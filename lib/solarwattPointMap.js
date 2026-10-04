/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.solarwatt.

Register maps for the local Modbus TCP interfaces:
 - SOLARWATT vision Modbus TCP protocol documentation v1.0 (inverter, battery, meter)
 - Fox ESS EV Charger Modbus TCP & RTU Protocol v1.08 (charger)

Every address below was read back from real hardware on 2026-09-17:
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
 * Blocks are read with function code 0x03 and merged into one Map per poll. Keep each
 * count at or below 125 (the Modbus limit); the inverter happily serves full 125-register
 * reads, so grouping is about round trips, not size.
 *
 * `optional: true` marks a block that some firmware/models do not implement. It is dropped
 * after a few consecutive failures instead of being retried forever - see CommonDevice.
 */

// --- shared vision (inverter/battery/meter live on the same Modbus server) ---------------

/*
 * The vision answers every unit id with the same data (verified live on 1, 2, 3, 247 and 255),
 * so the unit id setting is hidden for its drivers. The charger only answers its own (0x1000).
 */
const VISION_USES_UNIT_ID = false;

const VISION_IDENTITY = [
  { start: 30000, count: 48 }, // model name, serial number, manufacturer
  { start: 36001, count: 3 }, // master / slave / manager firmware versions
];

/*
 * `unitSerial` is the serial number of the Modbus unit a device sits on. It is what the mDNS id
 * is made of (mDNS-<SN>.local, EVC-<SN>), so a device can recognise its unit in discovery even
 * when it was paired by address - see CommonDevice#onDiscoveryResult.
 */
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
 * Class `solarpanel`, so this driver reports PV production - not the inverter's AC output,
 * which on a hybrid also carries battery discharge.
 *
 * Both sides of the conversion are published. The DC side is what the strings deliver
 * (39118 / 39601); the AC side is what the inverter puts on the grid (39134 / 39149),
 * battery discharge included. Neither is solar AC output on its own, so `measure_power` is
 * derived from the two - see solarPowerAC(). Every register involved already sits inside
 * the 39118 block, so none of this costs an extra Modbus read.
 *
 * The solar energy counters show the AC side where they can, as com.foxess does - see
 * solarSide(). The titles say which side a capability shows: '(AC)' in the manifest, '(DC)'
 * from capabilityOptions (lib/solarTitles.js).
 *
 * On a battery-only vision (no strings attached) 39118/39601/39603 correctly read 0 while
 * 39149 keeps counting. Verified live on 2026-09-17: 39134 read 436 W against 39162 -436 W
 * with 39118 at 0 W, i.e. pure battery discharge. solarPowerAC() resolves that to 0 rather
 * than publishing it as sunshine.
 */

/** Efficiency assumed for the battery term when the live figure is unusable. */
const FALLBACK_EFFICIENCY_PCT = 98;

/*
 * Below this much DC the efficiency reading is dominated by sampling skew between the PV
 * and AC measurements, so it is withheld instead of published. com.growatt scales its
 * equivalent floor off the inverter's rated power; the vision reports that at 39053, but
 * that address sits 65 registers ahead of the polled block and a read spanning the gap
 * costs a full timeout, so a flat floor is used. 200 W is ~2.5% of an Inverter vision
 * three 8kW.
 */
const EFFICIENCY_FLOOR_W = 200;

/**
 * DC -> AC conversion efficiency in percent.
 *
 * The strings and the battery share a DC bus, so what actually reaches the converter is
 * `pv - battery` (39162 is > 0 while charging). Returned at full precision on purpose:
 * solarPowerAC() consumes this as arithmetic rather than as a reading, and rounding it
 * there breaks the identity that keeps its ceiling inert.
 *
 * Returns `null` - not undefined - whenever the inverter is running but there is nothing to
 * measure. Efficiency is a ratio of two live flows, so overnight it has no value at all, and
 * leaving yesterday's 96% on the tile until sunrise would present a stale reading as a
 * current one. See CommonDevice.setCapability for what the two empty values mean.
 */
const inverterEfficiency = (regs) => {
  const ac = i32(regs, 39134);
  const pv = i32(regs, 39118);
  const battery = i32(regs, 39162);
  // Registers absent: this unit does not report efficiency at all, so say nothing about it.
  if (ac === undefined || pv === undefined || battery === undefined) return undefined;
  if (!(ac > 0)) return null; // idle or curtailed
  if (pv < EFFICIENCY_FLOOR_W) return null; // dark - nothing is being converted
  const dcIn = pv - battery;
  if (dcIn < EFFICIENCY_FLOOR_W) return null; // nearly all of it is going into the battery
  const pct = (ac / dcIn) * 100;
  // A passive converter cannot exceed 100%, so anything above it is a measurement artefact.
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  return pct;
};

/**
 * Gross solar output expressed on the AC side: what the array produced, after conversion.
 *
 * Only the DC -> AC stage produces 39134, so with `n` the efficiency above:
 *
 *   solarAC = pv * n = (dcIn + battery) * n = ac + battery * n
 *
 * Scaling only the battery term keeps the result anchored to a measured AC value, so when
 * `n` falls back to an assumption that assumption touches the correction rather than the
 * whole figure. `pv * n` is the same quantity by the derivation above, which is why it is
 * also the ceiling: no amount of battery activity can yield more AC solar than the strings
 * are feeding in right now. That is what stops a grid charge at night - watts in `battery`
 * that never came through the array - from being booked as production on a `solarpanel`
 * device. With a live `n` the two expressions are algebraically equal and the ceiling never
 * bites; it engages exactly when `n` is the fallback, i.e. when the battery term is not
 * backed by a measurement.
 */
const solarPowerAC = (regs) => {
  const ac = i32(regs, 39134);
  if (ac === undefined) return undefined;
  // Number.isFinite covers both empty values: inverterEfficiency returns null when it is dark
  // and undefined when the registers are absent, and `null / 100` would silently become 0.
  const live = inverterEfficiency(regs);
  const eff = (Number.isFinite(live) ? live : FALLBACK_EFFICIENCY_PCT) / 100;
  const battery = i32(regs, 39162);
  const solarAC = Math.max(0, ac + ((battery === undefined ? 0 : battery) * eff));
  const pv = i32(regs, 39118);
  // Skip the ceiling when 39118 is missing: capping on an absent field would zero the tile.
  if (pv === undefined) return round(solarAC, 0);
  return round(Math.min(solarAC, Math.max(0, pv * eff)), 0);
};

/*
 * Which side the solar energy capabilities show. 39149/39151 (AC generation) are the solar yield
 * only without a battery: on a hybrid they also count every kWh the battery pushes back out,
 * charged from the grid or not, and there is no AC solar counter to take instead. So:
 *   no battery -> 'ac', 39149/39151
 *   battery    -> 'dc', 39601/39603, the array's own input - what com.foxess and com.growatt
 *                 show for a hybrid too
 * Not known yet - detection has not run since the device was added - gives undefined, and the
 * capabilities stay empty rather than showing one counter and then jumping to the other. After a
 * detection that could not tell (hasBattery unknown), 'dc': the safe side.
 */
const solarSide = (device) => {
  const { hasBattery } = device.detected;
  if (hasBattery === false) return 'ac';
  if (hasBattery === true || device.detectionDone) return 'dc';
  return undefined;
};

/** A solar energy counter: `ac` or `dc` (register addresses of a u32 in 0.01 kWh) per solarSide(). */
const solarEnergy = (ac, dc) => (regs, device) => {
  const side = solarSide(device);
  if (!side) return undefined;
  return round(scale(u32(regs, side === 'ac' ? ac : dc), 100), 2);
};

/*
 * A battery is connected (37002 != 0, as the battery driver's pairable) or ever was: the lifetime
 * charge/discharge counters (39605/39609) only ever grow, so a BMS that is offline at a restart
 * does not turn a hybrid into an AC-only inverter. No battery takes both: 37002 = 0 and never
 * anything charged or discharged. undefined when 37002 was not read.
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

/*
 * The inverter's own AC figures. Without a battery they are the solar figures above - same
 * registers - so they are left out there instead of showing every value twice.
 */
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
 * The unit's own alarms, as with com.foxess: never thresholds of our own. Alarm 1-3 (39067-39069)
 * are bitfields; the individual bits below are from the vision document's "Alarm information".
 * Every set bit raises alarm_problem; the ones about one subject raise its own alarm as well.
 */
const ALARM_REGISTERS = [39067, 39068, 39069];
const ALARM_OVERTEMPERATURE = [39068, 3]; // Alarm 2 bit 3: temperature is too high
const ALARM_STORAGE_ABNORMAL = [39068, 9]; // Alarm 2 bit 9: energy storage equipment abnormality
const ALARM_STORAGE_REVERSED = [39069, 4]; // Alarm 3 bit 4: energy storage reverse connection
const ALARM_METER_LOST = [39069, 9]; // Alarm 3 bit 9
const ALARM_BMS_LOST = [39069, 10]; // Alarm 3 bit 10

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
 * Inverter state from Status 1 (39063: bit 0 standby, bit 2 operation, bit 6 fault) and Status 3
 * (39065, a 32-bit field: bit 0 off-grid). Seen live: 39063 = 4 and 39065 = 0 while running on the
 * grid. Ids are those of com.foxess's running_state; a combination the document does not
 * describe (no bit set) shows as 'unknown' rather than being dropped.
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

/*
 * A SOLARWATT serial number spells out brand and model (manual p. 45, "Serial Number
 * Decomposition"): it starts with "2" (brand: always Solarwatt) and "R" (factory), followed by a
 * five-character model code, e.g. 2RVM29204BFF036 -> VM292.
 */
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

/*
 * Solar capabilities are dropped only on a model that cannot take strings at all.
 *
 * Not on a unit that merely has none connected: the driver is `solarpanel` class, so an
 * inverter that is built to carry an array keeps its solar tiles whether or not anything is
 * wired to it today. Panels get added to existing installations, and a tile reading 0 W is
 * the honest answer for an array that is not there yet - an absent tile is not.
 */
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
 * How the vision takes writes, verified live on 2026-10-03: function code 0x06 for a 16-bit
 * register, and 0x10 only for exactly one 32-bit value. A 0x10 write of a single 16-bit
 * register, or one spanning several signals (46001-46004), is never answered - the same
 * silence as F-01, so it costs a full timeout and changes nothing.
 */
const writeU16 = (client, address, value) => client.writeRegister(address, value);
const writeI32 = (client, address, value) => client.writeRegisters(address, words32(value));

/**
 * Whether something else changed a register since this app wrote it, e.g. a SOLARWATT Manager
 * taking control back (deviation D-08). Only registers written before the poll started count,
 * so a poll that was already reading when a new value went out cannot raise a false alarm.
 *
 * Latched: a keep-alive puts the value back every few seconds, so the next poll may well read
 * it again even though the other writer is still active. The alarm stays on until the user
 * controls the device again or this app stops controlling it (CommonDevice.noteWrites).
 * @param {object} readers address -> (regs) => value, in the unit the write used
 */
const controlOverridden = (regs, device, readers) => {
  const written = device.getStoreValue('writtenRegisters') || {};
  const changed = Object.entries(readers).some(([address, read]) => {
    const entry = written[address];
    if (!entry || entry.at >= device.pollStartedAt) return false;
    const value = read(regs);
    return value !== undefined && value !== entry.value;
  });
  if (changed && !device.getStoreValue('controlOverridden')) {
    device.onControlOverridden().catch((error) => device.error(error));
  }
  return changed || Boolean(device.getStoreValue('controlOverridden'));
};

const inverter = {
  usesUnitId: VISION_USES_UNIT_ID,
  showsEnergyManager: true, // its controls can be overridden by a SOLARWATT Manager
  identityBlocks: VISION_IDENTITY,
  identity: visionIdentity,
  blocks: [
    { start: 39118, count: 55 }, // PV input, grid, AC active power, temperature, generation
    { start: 39601, count: 32 }, // energy counters: PV, battery, grid, output, input, load
    // Added later; optional so a firmware without them costs three timeouts, not one per poll.
    { start: 39063, count: 13, optional: true }, // status, alarms, PV1-3 voltage/current
    { start: 39216, count: 11, optional: true }, // EPS and load power
    { start: 39279, count: 6, optional: true }, // PV1-3 power
    { start: 39053, count: 2, optional: true }, // rated power, to scale the limits below
    { start: 46616, count: 2, optional: true }, // export power limit
    { start: 49007, count: 1, optional: true }, // active power derating, 0.1 %
  ],
  capabilities: {
    measure_power: solarPowerAC,
    /*
     * Curtailment, as in com.growatt: target_power caps the inverter's output in watts. It is
     * stored as a percentage of rated power (49007, 0.1 % steps; 1000 = no limit) rather than
     * in 49008 "fixed active power derated", which reads 0 on an unlimited unit and so cannot
     * tell "off" from "zero".
     */
    target_power: (regs) => {
      const permille = u16(regs, 49007);
      const rated = i32(regs, 39053);
      if (permille === undefined || !(rated > 0)) return undefined;
      return Math.round((Math.min(permille, 1000) / 1000) * rated);
    },
    /*
     * Feed-in cap (46616). Reads 60000 when unlimited; the inverter can never export more than
     * its rating anyway, so anything above it is shown - and written - as the rating.
     */
    export_limit: (regs) => {
      const limit = i32(regs, 46616);
      const rated = i32(regs, 39053);
      if (limit === undefined) return undefined;
      return rated > 0 ? Math.min(limit, rated) : limit;
    },
    // 39118 is documented as kW with gain 1000, so the raw value already is W.
    'measure_power.dc_solar': (regs) => i32(regs, 39118),
    // 39134 carries the same kW/1000 gain. Battery discharge is included, so this is the
    // inverter's throughput and not a solar figure.
    'measure_power.ac_inverter': (regs) => i32(regs, 39134),
    /*
     * House load as the inverter sees it: its own AC output plus grid import (verified live,
     * -959 = -969 + 10). Generation it cannot see - an AC-coupled third-party PV inverter -
     * is not in it, so on such a site it goes negative while that PV charges the battery.
     */
    'measure_power.load': (regs) => i32(regs, 39225),
    'measure_power.eps': (regs) => i32(regs, 39216),
    measure_efficiency: inverterEfficiency,
    // Solar yield, AC without a battery and DC with one - see solarSide().
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
    measure_frequency: (regs) => round(scale(i16(regs, 39139), 100), 2),
    ...pvStrings('power'),
    ...pvStrings('voltage'),
    ...pvStrings('current'),
    running_state: runningState,
    // Every fault and alarm of the unit, whatever it is about.
    alarm_problem: (regs) => {
      const fault = bit(regs, 39063, 6);
      const alarms = anySet(regs, ALARM_REGISTERS);
      if (fault === undefined && alarms === undefined) return undefined;
      return Boolean(fault || alarms);
    },
    alarm_heat: (regs) => anyBit(regs, ALARM_OVERTEMPERATURE),
    // A power or export limit this app set, changed by something else (e.g. a SOLARWATT Manager).
    'alarm_generic.control': (regs, device) => controlOverridden(regs, device, {
      49007: (r) => u16(r, 49007),
      46616: (r) => i32(r, 46616),
    }),

  },

  /*
   * Read once per (re)start, not on every poll - see CommonDevice.runDetection. 39051/39052
   * are model properties that cannot change while the app runs, and they sit far outside the
   * polled block, so there is nothing to gain by asking again every ten seconds.
   */
  detectBlocks: [
    { start: 39050, count: 6 }, // model id, string count, MPPT count, rated power
    { start: 37002, count: 1 }, // BMS connection state
    { start: 39605, count: 6 }, // lifetime battery charge / discharge counters
  ],

  /*
   * Whether this model can carry an array at all, from its declared string count rather than
   * from anything it is producing. The Inverter vision three reports 3 strings and 3 MPPTs
   * even with nothing connected (verified live on a unit whose lifetime PV counter is 0),
   * which is exactly the distinction wanted: the hardware is PV-capable, it just has no
   * panels yet.
   *
   * A fact it cannot read is left out, which leaves every capability in place. That is the
   * safe direction - an undecided unit keeps its tiles. hasBattery decides the side of the solar
   * energy counters, see solarSide().
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
    return detected;
  },

  /**
   * Both limits run from 0 to the rated power, in 1 % steps like com.growatt. The solar energy
   * titles name the side solarSide() picks: the manifest's '(AC)', or '(DC)' - also with the
   * battery not known yet, as that is what the counters will show then.
   */
  capabilityOptions: (detected) => {
    const options = {};
    const side = detected.hasBattery === false ? 'ac' : 'dc';
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
    // Strings the model does not have, including all of them on a model without PV.
    const strings = Number.isInteger(detected.strings) ? detected.strings : PV_STRINGS;
    for (let n = strings + 1; n <= PV_STRINGS; n += 1) drop.push(...pvStringCapabilities(n));
    return drop;
  },
};

// --- battery ----------------------------------------------------------------------------

/*
 * Deadband for the charging state. 39162 is a live measurement that idles at a few watts
 * rather than at exactly zero, so a strict sign test flaps between 'idle' and 'charging'
 * on standby. 10 W is well under 0.1% of this pack's rating - far below anything a user
 * would call charging, and wide enough for the tile to sit still.
 */
const BATTERY_IDLE_BAND_W = 10;

/** 49203 work modes. 5 is not defined in the protocol. */
const WORK_MODES = {
  1: 'self_use',
  2: 'feed_in',
  3: 'backup',
  4: 'peak_shaving',
  6: 'force_charge',
  7: 'force_discharge',
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

/** Homey's setpoint, clamped to what the BMS says it can take or give right now. */
const remoteSetpoint = (device, requested) => {
  const watts = Number(requested) || 0;
  const chargeLimit = device.getCapabilityValue('measure_power.charge_limit') || DEFAULT_POWER_LIMIT_W;
  const dischargeLimit = device.getCapabilityValue('measure_power.discharge_limit') || DEFAULT_POWER_LIMIT_W;
  return Math.round(Math.max(-dischargeLimit, Math.min(chargeLimit, watts)));
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

/*
 * BMS1 Fault1-6 (37626-37631). The document gives no meaning per bit, so they only say "a BMS
 * fault", not which kind - no battery heat alarm can be derived from them.
 */
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
    // Serial number per module: 32 slots of 16 registers, all answering (unused ones read 0).
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
        /*
         * "Remain Energy" is the usable capacity the pack has left after ageing, not the
         * current charge: it read 1440 (14.4 kWh) at 85% and at 58% SoC alike, and the PDF
         * lists it under the EU Battery Regulation health figures.
         */
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
    // The inverter's own limits, which cap the battery too: rated power, power limit, export limit.
    { start: 39053, count: 2, optional: true },
    { start: 49007, count: 1, optional: true },
    { start: 46616, count: 2, optional: true },
    { start: 49241, count: 2, optional: true }, // ripple control enable, trigger inputs K1-K4
    ALARM_BLOCK,
  ],

  capabilities: {
    /*
     * 39162 is the documented signed pair: > 0 charging, < 0 discharging, which is also
     * Homey's convention. Do NOT use 39230/39237 here - verified live that those carry the
     * opposite sign (39162 read -349 W while 39237 read +342 W on the same discharge).
     */
    measure_power: (regs) => i32(regs, 39162),
    /*
     * The setpoint the inverter is actually running, read back from remote control - whoever
     * wrote it (Homey, or e.g. a SOLARWATT Manager: see deviation D-08). Empty while remote
     * control is off. Bit 1 of 46001 says which way 46003 counts; shown in Homey's convention
     * (> 0 charging). target_power stays Homey's own request: copying this into it would make
     * the keep-alive repeat whatever another writer left there.
     */
    'measure_power.target': (regs) => {
      const control = u16(regs, 46001);
      const setpoint = i32(regs, 46003);
      if (control === undefined || setpoint === undefined) return undefined;
      if (!(control & 0b1)) return null;
      return control & 0b10 ? setpoint : -setpoint;
    },
    // Owned by Homey, not read back: see `controls`.
    target_power: null,
    /*
     * One mode picker instead of two overlapping ones. Homey's target_power_mode takes custom
     * values next to 'homey' ("any non-homey value means the device controls its own power"),
     * so the inverter's work modes live in it. While Homey is in control the tile says so;
     * otherwise it shows the work mode the inverter actually runs.
     */
    target_power_mode: (regs, device) => {
      // Once another writer took remote control over (alarm_generic.control), Homey no longer
      // has it: the tile then shows the work mode the inverter runs, like any other time.
      if (device.getCapabilityValue('target_power_mode') === 'homey' && !device.getStoreValue('controlOverridden')) return 'homey';
      const mode = u16(regs, 49203);
      if (mode === undefined) return undefined;
      return WORK_MODES[mode] || null;
    },
    /*
     * BMS SoC, not "System SoC" at 39423: that address is outside the range this firmware
     * implements and never answers at all (the read times out rather than returning an
     * exception), which would stall every poll by a full timeout.
     */
    measure_battery: (regs) => u16(regs, 37612),
    /*
     * Whether the inverter has a limit set that can hold the battery back: an export limit
     * (46616) below its rated power, an AC power limit (49007) below 100 %, or the grid
     * operator's ripple control (49241 enabled, a K input active in 49242). The power
     * limit is also folded into the max discharge power tile; the export limit only bites
     * once a discharge would go to the grid - how much depends on the house load - so this
     * flag is the only place it shows.
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
    /* Same register as measure_power, so the tile and the state can never disagree. */
    battery_charging_state: (regs) => {
      const power = i32(regs, 39162);
      if (power === undefined) return undefined;
      if (power > BATTERY_IDLE_BAND_W) return 'charging';
      if (power < -BATTERY_IDLE_BAND_W) return 'discharging';
      return 'idle';
    },
    // Lowest before highest throughout, so the on-grid floor sits between the two limits.
    battery_min_soc: (regs) => u16(regs, 46609),
    battery_min_soc_ongrid: (regs) => u16(regs, 46611),
    battery_max_soc: (regs) => u16(regs, 46610),
    measure_voltage: (regs) => round(scale(u16(regs, 37609), 10), 1),
    measure_current: (regs) => round(scale(i16(regs, 37610), 10), 1),
    'measure_temperature.min': (regs) => round(scale(i16(regs, 37618), 10), 1),
    'measure_temperature.max': (regs) => round(scale(i16(regs, 37617), 10), 1),
    'measure_voltage.cell_min': (regs) => round(scale(u16(regs, 37620), 1000), 3),
    'measure_voltage.cell_max': (regs) => round(scale(u16(regs, 37619), 1000), 3),
    // 46020 reads negative (-8000 W); both tiles show how much power is available.
    'measure_power.charge_limit': (regs) => {
      const value = i32(regs, 46020);
      return value === undefined ? undefined : Math.abs(value);
    },
    /*
     * The BMS limit (46018), or the inverter's power limit (49007, per mille of the rated
     * power) when that is lower: a discharge leaves through the inverter's AC output, and the
     * BMS limit does not follow a power limit (verified live: 49007 at 50 % left 46018 at
     * 7999 W). remoteSetpoint clamps to this tile, so Homey never asks for more either.
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
    // BMS ambient temperature; reads warmer than the min/max battery temperatures.
    measure_temperature: (regs) => round(scale(i16(regs, 37611), 10), 1),
    measure_soh: (regs) => u16(regs, 37624),
    /*
     * Battery health figures the vision document asks an EMS to show (EU Battery Regulation
     * table, last pages). Remaining energy is the SoC applied to the pack's remaining capacity
     * (37632), so a derived figure rather than a register: live 68 % x 14.4 kWh = 9.79 kWh.
     */
    measure_residual_energy: (regs) => {
      const soc = u16(regs, 37612);
      const capacity = scale(u16(regs, 37632), 100); // 10 Wh units -> kWh
      if (soc === undefined || capacity === undefined) return undefined;
      return round((Math.min(soc, 100) / 100) * capacity, 2);
    },
    /*
     * Full cycle equivalents: energy throughput over the design energy (37635), as the document
     * describes it, with each cycle one charge plus one discharge. Live: (3119 + 2883) / 2 / 14.4
     * = 208.
     */
    measure_battery_cycles: (regs) => {
      const throughput = batteryThroughput(regs);
      const design = scale(u16(regs, 37635), 100);
      if (throughput === undefined || !(design > 0)) return undefined;
      return round(throughput / 2 / design, 1);
    },
    // Energy throughput: total charged plus total discharged, the document's two registers.
    'meter_power.throughput': batteryThroughput,
    alarm_problem: (regs) => anyTrue(
      bmsFault(regs),
      bmsOffline(regs),
      anyBit(regs, ALARM_STORAGE_ABNORMAL, ALARM_STORAGE_REVERSED, ALARM_BMS_LOST),
    ),
    // Battery faults only - a low state of charge is normal operation, as in com.foxess.
    alarm_battery: (regs) => anyTrue(bmsFault(regs), anyBit(regs, ALARM_STORAGE_ABNORMAL, ALARM_STORAGE_REVERSED)),
    // The BMS not talking to the inverter: 37002 = 0, or the inverter's own "BMS lost".
    alarm_connectivity: (regs) => anyTrue(bmsOffline(regs), anyBit(regs, ALARM_BMS_LOST)),
    // Remote control this app set, changed or switched off by something else (deviation D-08).
    'alarm_generic.control': (regs, device) => controlOverridden(regs, device, {
      46001: (r) => u16(r, 46001),
      46003: (r) => i32(r, 46003),
    }),

  },

  /** A vision without a battery still answers the BMS block, with 37002 "not connected". */
  pairable: (regs) => u16(regs, 37002) !== 0,

  controls: [
    {
      /*
       * Battery mode. 'homey': the inverter's remote control follows target_power. Any other
       * value is an inverter work mode (49203): remote control goes off and the inverter runs
       * that mode by itself. Remote control has a watchdog (46002), so keepAlive rewrites it
       * every 10 s - if Homey stops, the inverter falls back to its work mode by itself.
       */
      capabilities: ['target_power', 'target_power_mode'],
      keepAliveSeconds: BATTERY_KEEP_ALIVE_S,
      initial: { target_power: 0 },
      write: async ({ client, device, values }) => {
        const mode = targetPowerMode(device, values);
        const setpoint = values.target_power !== undefined ? values.target_power : device.getCapabilityValue('target_power');
        if (mode === 'homey') {
          await writeRemoteControl(client, device, 'homey', setpoint);
          await showTargetPowerMode(device, mode);
          return;
        }
        const code = Object.keys(WORK_MODES).find((key) => WORK_MODES[key] === mode);
        if (!code) throw Error(`Unknown work mode ${mode}`);
        await writeRemoteControl(client, device, 'off');
        await writeU16(client, 49203, Number(code));
      },
      /*
       * Read back before rewriting. A SOLARWATT Manager writes its own setpoint for a few
       * seconds at a time (seen live: 46002 = 20, 46003 = 8000 between two keep-alives), which
       * this rewrite then undoes - a poll only sees that if it happens to fall in the gap.
       */
      keepAlive: async ({ client, device }) => {
        if (!homeyInControl(device)) return;
        const written = device.getStoreValue('writtenRegisters') || {};
        if (written[46001] && written[46003]) {
          const current = await client.readRegisters(46001, 4);
          const control = current.readUInt16BE(0);
          const setpoint = current.readInt32BE(4);
          if (control !== written[46001].value || setpoint !== written[46003].value) {
            device.log(`remote control changed to ${control}/${setpoint} W, not by this app`);
            // Hand over rather than fight: rewriting would only undo the other writer's
            // setpoint for a few seconds. Ours lapses by itself with the 46002 watchdog.
            await device.onControlOverridden();
            return;
          }
        }
        await writeRemoteControl(client, device, 'homey', device.getCapabilityValue('target_power'));
      },
      release: async ({ client, device }) => {
        // Not after an override: switching remote control off would cut the other writer off too.
        if (!homeyInControl(device)) return;
        await writeRemoteControl(client, device, 'off');
      },
    },
    {
      /*
       * The inverter keeps min SoC <= min SoC on grid <= max SoC and silently ignores a write
       * that would break it (verified: 46609 = 15 with 46611 at 14 was never answered, 14 was
       * accepted). So the guard checks the target, and the three registers are written in an
       * order in which every intermediate state is valid too.
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
        if (max >= current[1]) steps.push([46610, max]); // raising the ceiling first makes room
        // Lowering the floor first, or raising the on-grid floor first, keeps min <= ongrid.
        if (min <= current[2]) steps.push([46609, min], [46611, ongrid]);
        else steps.push([46611, ongrid], [46609, min]);
        if (max < current[1]) steps.push([46610, max]); // lowering the ceiling last
        for (const [address, value] of steps) {
          // eslint-disable-next-line no-await-in-loop
          await writeU16(client, address, value);
        }
      },
    },
  ],
};

// --- meter ------------------------------------------------------------------------------

/** True when an actual meter/CT is wired up, so its registers are worth preferring. */
const meterConnected = (regs) => u16(regs, 38801) === 1;

/** Meter1/CT1 register when the meter is connected, else the inverter's own grid reading. */
const meterOrGrid = (regs, meterAddress, meterGain, gridAddress, gridGain, decimals) => {
  if (meterConnected(regs)) {
    const value = round(scale(i32(regs, meterAddress), meterGain), decimals);
    if (value !== undefined) return value;
  }
  return round(scale(i16(regs, gridAddress), gridGain), decimals);
};

/*
 * The 388xx Meter1 power registers share 39168's convention: > 0 feeding into the grid
 * (verified live, 38814 and 39168 both read +22 W during export). Homey's grid convention is
 * the opposite - positive means importing - so active power is flipped.
 */
const meterPower = (regs, address) => negate(round(scale(i32(regs, address), 10), 1));

const meter = {
  usesUnitId: VISION_USES_UNIT_ID,
  identityBlocks: [
    ...VISION_IDENTITY,
    { start: 38801, count: 1 }, // meter connection state
    { start: 36148, count: 1 }, // meter version (typed STR, but a number: deviation D-04)
    { start: 49207, count: 1 }, // how the meter is attached: off, 1-phase meter, CT, 3-phase meter
  ],
  // The meter's own identity strings are unreadable (F-03), so these are the inverter's.
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
    /*
     * 39168 is documented as > 0 feeding into the grid, < 0 taking from it. Homey's grid
     * convention is the opposite - positive means importing - so the sign is flipped.
     */
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
    // Unlike the power registers this one is already negative on export (read -0.012 and
    // -0.031 while 38814 was positive), so it follows Homey's convention as it is.
    measure_power_factor: (regs) => round(scale(i32(regs, 38838), 1000), 3),
    measure_reactive_power: (regs) => round(scale(i32(regs, 38822), 10), 0),
    measure_apparent_power: (regs) => round(scale(i32(regs, 38830), 10), 0),
    'meter_power.imported': (regs) => round(scale(u32(regs, 39617), 100), 2),
    'meter_power.exported': (regs) => round(scale(u32(regs, 39613), 100), 2),
    // 38801 = 1 means the meter/CT is connected and talking; the inverter also flags "meter lost".
    alarm_connectivity: (regs) => anyTrue(
      u16(regs, 38801) === undefined ? undefined : u16(regs, 38801) !== 1,
      anyBit(regs, ALARM_METER_LOST),
    ),
  },

  /** Without a meter or CT wired up, the meter registers hold nothing worth a device. */
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

/** "1.4–11 kW, 6–16 A": the power and per-phase current range from 0x1011-0x1014 (0.1 steps). */
const chargerRange = (regs) => {
  const [maxKw, minKw, maxA, minA] = [0x1011, 0x1012, 0x1013, 0x1014].map((address) => scale(u16(regs, address), 10));
  if ([maxKw, minKw, maxA, minA].some((value) => value === undefined)) return undefined;
  return `${minKw}–${maxKw} kW, ${minA}–${maxA} A`;
};

/*
 * Homey's target power, as the session limits 0x3001 (current, 0.1 A) and 0x3002 (power,
 * 0.1 kW). The charger's watchdog drops both back to its rating (0x1013/0x1011) after one
 * minute without a write, so the control refreshes them every KEEP_ALIVE seconds while a
 * car is on the cable - also when the update interval is set far longer than that.
 */
const CHARGER_KEEP_ALIVE_S = 30;
const DEFAULT_CHARGER_MAX_W = 11000;
const DEFAULT_CHARGER_MIN_W = 1400;
const DEFAULT_CHARGER_MAX_A = 16;

/** Work mode 0x3000: 0 controlled (app or card starts), 1 plug and charge, 2 locked. */
const CHARGER_MODE_CONTROLLED = 0;
const CHARGER_MODE_LOCK = 2;

/** Connector states with a session that a power limit applies to. */
const chargerSessionActive = (device) => ['plugged_in_charging', 'plugged_in_paused']
  .includes(device.getCapabilityValue('evcharger_charging_state'));

/**
 * Write both session limits in one request: read/write registers take function code 0x10
 * (charger protocol 1.08, section 2). The current limit stays at the rating, so the power
 * limit alone decides; below the minimum power the charger cannot run, so that means 0.
 */
const writeChargerLimit = async (client, device, watts) => {
  const { maxPower = DEFAULT_CHARGER_MAX_W, minPower = DEFAULT_CHARGER_MIN_W, maxCurrent = DEFAULT_CHARGER_MAX_A } = device.detected;
  const limited = Math.min(maxPower, Math.max(0, Number(watts) || 0));
  const power = limited < minPower ? 0 : Math.floor(limited / 100);
  await client.writeRegisters(0x3001, [Math.round(maxCurrent * 10), power]);
};

const charger = {
  usesUnitId: true,
  identityBlocks: [
    { start: 0x1000, count: 50 }, // 0x1000-0x1031, incl. model code and serial
    { start: 0x300a, count: 1 }, // 1-/3-phase switching; a single-phase charger has no such register
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
    /*
     * High-precision power in whole watts. Only on newer firmware: the A011KP1 on fw 1.30
     * answers 0x1032 and up with "illegal data address", so this block is optional and the
     * 0.1 kW register 0x100E is used instead.
     */
    { start: 0x1048, count: 2, optional: true },
    { start: 0x3000, count: 3 }, // work mode, session current and power limit, whoever set them
  ],

  /*
   * The rated range from 0x1011-0x1014 (0.1 steps), for target_power's slider and dead zone.
   * 0x1012 is the single-phase minimum (6 A on one phase). It only applies while 0x300A lets
   * the charger drop to one phase below 4.2 kW; without that it charges on all three, so the
   * lowest power it can run at is three times as high.
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

  /** Settings that are written to the charger rather than kept by Homey. FC 0x10: read/write. */
  settingWrites: {
    phaseSwitching: async ({ client, value }) => client.writeRegisters(0x300a, [value ? 1 : 0]),
  },

  /*
   * Homey energy's EV charger range: 0 to the rating, the 0.1 kW register resolution as step,
   * and everything between 0 and the minimum power excluded - a request in there becomes 0.
   */
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
    /*
     * The power limit the charger runs with right now, set by Homey, another EMS or its own
     * default (the rating, which it returns to by itself). A current limit of 0 means stop.
     */
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
      // CC is the authority on whether a plug is physically inserted.
      const cc = u16(regs, 0x1005);
      if (cc === 0) return 'plugged_out';
      if (cc === 1) return 'plugged_in';
      return status === CONNECTOR_STATUS.IDLE ? 'plugged_out' : 'plugged_in';
    },
    // What the car plugged in now has taken (0x1018, see meter_power below).
    'meter_power.session': (regs) => round(scale(u32(regs, 0x1018), 10), 1),
    // Owned by Homey, not read back: see `controls`.
    target_power: null,
    target_power_mode: null,
    'measure_current.1': (regs) => round(scale(u16(regs, 0x100b), 10), 1),
    'measure_current.2': (regs) => round(scale(u16(regs, 0x100c), 10), 1),
    'measure_current.3': (regs) => round(scale(u16(regs, 0x100d), 10), 1),
    'measure_voltage.1': (regs) => round(scale(u16(regs, 0x1008), 10), 1),
    'measure_voltage.2': (regs) => round(scale(u16(regs, 0x1009), 10), 1),
    'measure_voltage.3': (regs) => round(scale(u16(regs, 0x100a), 10), 1),
    // Shifted up by 50 degrees, 0.1 resolution.
    measure_temperature: (regs) => {
      const raw = u16(regs, 0x1007);
      return raw === undefined ? undefined : round(raw / 10 - 50, 1);
    },
    // The cable lock in the socket, 0x100F: 1 locked. Set through 0x4000, see `controls`.
    locked: (regs) => (u16(regs, 0x100f) === undefined ? undefined : u16(regs, 0x100f) === 1),
    // The whole charger locked: work mode 0x3000 = 2, nobody can charge. See `controls`.
    'locked.charger': (regs) => (u16(regs, 0x3000) === undefined ? undefined : u16(regs, 0x3000) === CHARGER_MODE_LOCK),
    /*
     * The doc's names are misleading: 0x1016 "Current Energy" is the reading of the meter
     * inside the charger (lifetime, 4425.7 kWh live) and 0x1018 "Total Charging Energy" is
     * what the car plugged in now has taken.
     */
    meter_power: (regs) => round(scale(u32(regs, 0x1016), 10), 1),
    /*
     * Faults only (0x101A). The alarm word 0x1015 is left out on purpose: it reads 0x0A on a
     * healthy unit without phase-cutting box or external meter (deviation C-03), which would
     * be a permanent false alarm.
     */
    alarm_problem: (regs) => {
      const faults = u32(regs, 0x101a);
      return faults === undefined ? undefined : faults !== 0;
    },
    // Fault bit 4 (charging port temperature) or 16 (environment temperature), Appendix 2.
    alarm_heat: (regs) => {
      const faults = u32(regs, 0x101a);
      return faults === undefined ? undefined : Boolean(faults & ((1 << 4) | (1 << 16)));
    },
  },

  controls: [
    {
      /*
       * Start/stop plus Homey's target power, as one control: Homey's "Set target power" card
       * changes all three at once. Start/stop is the write-only 0x4001, so function code 0x06.
       * 'device': the charger charges at whatever it decides itself and target_power is kept
       * for later. 'homey': target_power is the session power limit, refreshed by keepAlive.
       */
      capabilities: ['evcharger_charging', 'target_power', 'target_power_mode'],
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
          } else {
            // Limit first, so a start never runs at full power for a moment.
            await writeChargerLimit(client, device, target);
            if (values.evcharger_charging === true) await client.writeRegister(0x4001, 1);
          }
          await showTargetPowerMode(device, mode);
          return;
        }
        // Back to the charger's own rating right away instead of after the watchdog minute.
        if (values.target_power_mode !== undefined && chargerSessionActive(device)) {
          await writeChargerLimit(client, device, device.detected.maxPower || DEFAULT_CHARGER_MAX_W);
        }
        if (values.evcharger_charging !== undefined) {
          await client.writeRegister(0x4001, values.evcharger_charging ? 1 : 2);
        }
      },
      /*
       * Only during a session: in the "connect" and "finish" states two non-zero limits make
       * the charger start by itself, which would undo a stop.
       */
      keepAlive: async ({ client, device }) => {
        if (device.getCapabilityValue('target_power_mode') !== 'homey' || !chargerSessionActive(device)) return;
        const target = device.getCapabilityValue('target_power');
        if (Number(target) > 0) await writeChargerLimit(client, device, target);
      },
      release: async ({ client, device }) => {
        if (device.getCapabilityValue('target_power_mode') !== 'homey' || !chargerSessionActive(device)) return;
        await writeChargerLimit(client, device, device.detected.maxPower || DEFAULT_CHARGER_MAX_W);
      },
    },
    {
      // Cable lock: write-only 0x4000 (1 unlock, 2 lock), so function code 0x06.
      capabilities: ['locked'],
      write: async ({ client, values }) => client.writeRegister(0x4000, values.locked ? 2 : 1),
    },
    {
      /*
       * Charger lock: work mode 0x3000 = 2. Unlocking goes back to the mode it was in before
       * (controlled or plug and charge), remembered when locking. The charger only takes a
       * work mode without a cable in it (protocol 1.08, section 2.41). Read/write: 0x10.
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
        await client.writeRegisters(0x3000, [Number.isInteger(previous) ? previous : CHARGER_MODE_CONTROLLED]);
      },
    },
  ],
};

module.exports = {
  inverter, battery, meter, charger, CONNECTOR_STATUS, WORK_MODES,
};
