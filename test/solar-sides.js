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

// A developer script, not app code: it reports to the console and sets an exit status.
/* eslint-disable no-console */

/*
 * The inverter's solar energy side (AC without a battery, DC with one), its battery detection,
 * the titles that name the side and the AC inverter tiles left out without a battery.
 */

const assert = require('assert');
const { inverter } = require('../lib/solarwattPointMap');
const { solarTitle } = require('../lib/solarTitles');

/** A register map from { address: u32 } (two words, high first) and { address: u16 }. */
const regsOf = ({ u32 = {}, u16 = {} }) => {
  const regs = new Map();
  for (const [address, value] of Object.entries(u32)) {
    regs.set(Number(address), (value >>> 16) & 0xffff);
    regs.set(Number(address) + 1, value & 0xffff);
  }
  for (const [address, value] of Object.entries(u16)) regs.set(Number(address), value);
  return regs;
};

const deviceWith = (detected, detectionDone = true) => ({ detected, detectionDone });

// Counters in 0.01 kWh: DC lifetime/today, AC lifetime/today.
const energy = regsOf({
  u32: {
    39601: 1000000, 39603: 1200, 39149: 970000, 39151: 1150,
  },
});

// --- detection -----------------------------------------------------------------------------

const detect = (u16, u32) => inverter.detect(regsOf({ u16: { 39051: 3, ...u16 }, u32 }));

// As read live on the test rig 2026-10-04: BMS connected, 3129.6 / 2890.4 kWh through the battery.
assert.strictEqual(detect({ 37002: 1 }, { 39605: 312960, 39609: 289040 }).hasBattery, true);
// A BMS offline at a restart: the counters still say there is a battery.
assert.strictEqual(detect({ 37002: 0 }, { 39605: 312960, 39609: 0 }).hasBattery, true);
assert.strictEqual(detect({ 37002: 0 }, { 39605: 0, 39609: 0 }).hasBattery, false);
// Unread: no verdict, and the other facts are still there.
assert.strictEqual('hasBattery' in detect({}, {}), false);
assert.strictEqual(detect({}, {}).hasPv, true);
assert.strictEqual('hasBattery' in detect({ 37002: 0 }, {}), false);
// String count unread: the battery verdict is still made.
assert.deepStrictEqual(inverter.detect(regsOf({ u16: { 37002: 0 }, u32: { 39605: 0, 39609: 0 } })), { hasBattery: false });

// --- energy side ---------------------------------------------------------------------------

const values = (device) => [inverter.capabilities.meter_power(energy, device), inverter.capabilities['meter_power.today'](energy, device)];

assert.deepStrictEqual(values(deviceWith({ hasBattery: false })), [9700, 11.5], 'no battery: AC');
assert.deepStrictEqual(values(deviceWith({ hasBattery: true })), [10000, 12], 'battery: DC');
assert.deepStrictEqual(values(deviceWith({})), [10000, 12], 'detected but unknown: DC');
assert.deepStrictEqual(values(deviceWith({}, false)), [undefined, undefined], 'not detected yet: nothing');
// A stored verdict holds while this start's detection has not run yet.
assert.deepStrictEqual(values(deviceWith({ hasBattery: false }, false)), [9700, 11.5]);

// --- titles --------------------------------------------------------------------------------

const titles = (detected) => {
  const options = inverter.capabilityOptions(detected);
  return [options.meter_power.title, options['meter_power.today'].title];
};
assert.deepStrictEqual(titles({ hasBattery: false }), [solarTitle('meter_power', 'ac'), solarTitle('meter_power.today', 'ac')]);
assert.deepStrictEqual(titles({ hasBattery: true }), [solarTitle('meter_power', 'dc'), solarTitle('meter_power.today', 'dc')]);
assert.deepStrictEqual(titles({}), [solarTitle('meter_power', 'dc'), solarTitle('meter_power.today', 'dc')]);
assert.strictEqual(solarTitle('meter_power', 'dc').nl, 'Zonopbrengst (DC)');
assert.strictEqual(solarTitle('meter_power.today', 'ac').fr, 'Production du jour (CA)');
// The limits still follow the rated power.
assert.strictEqual(inverter.capabilityOptions({ ratedPower: 8000 }).target_power.max, 8000);
assert.strictEqual('target_power' in inverter.capabilityOptions({}), false);

// The manifest carries the AC titles; capabilityOptions only has to swap in DC.
const manifest = require('../drivers/inverter/driver.compose.json');

for (const cap of ['measure_power', 'meter_power', 'meter_power.today']) {
  assert.deepStrictEqual(manifest.capabilitiesOptions[cap].title, solarTitle(cap, 'ac'), `${cap} manifest title`);
}

// --- AC inverter tiles ---------------------------------------------------------------------

const acTiles = ['measure_power.ac_inverter', 'meter_power.ac_inverter', 'meter_power.ac_today'];
const dropped = (detected) => acTiles.filter((cap) => inverter.unsupported(detected).includes(cap));
assert.deepStrictEqual(dropped({ hasBattery: false }), acTiles);
assert.deepStrictEqual(dropped({ hasBattery: true }), []);
assert.deepStrictEqual(dropped({}), []);

console.log('solar sides: all checks passed');
