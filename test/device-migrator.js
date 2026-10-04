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
/* eslint-disable no-console, no-process-exit */

/*
 * DeviceMigrator against a fake device that behaves like Homey's: capabilities keep the order
 * they were added in, values and options vanish with a removed capability, and
 * getCapabilityOptions() throws for a capability that has none.
 */

const assert = require('assert');
const DeviceMigrator = require('../lib/DeviceMigrator');

const fakeDevice = ({
  caps, values = {}, available = true, manifestOptions = {},
}) => {
  const state = {
    caps: [...caps], values: { ...values }, options: {}, available,
  };
  return {
    state,
    homey: { __: (key) => key, setTimeout: (fn) => fn() }, // no real settle pause in a test
    driver: { manifest: { capabilitiesOptions: manifestOptions } },
    log: () => {},
    error: (...args) => {
      throw Error(args.join(' '));
    },
    getName: () => 'fake',
    getAvailable: () => state.available,
    setAvailable: async () => {
      state.available = true;
    },
    setUnavailable: async () => {
      state.available = false;
    },
    getCapabilities: () => [...state.caps],
    hasCapability: (cap) => state.caps.includes(cap),
    getCapabilityValue: (cap) => (cap in state.values ? state.values[cap] : null),
    setCapabilityValue: async (cap, value) => {
      if (!state.caps.includes(cap)) throw Error(`no ${cap}`);
      state.values[cap] = value;
    },
    addCapability: async (cap) => {
      state.caps.push(cap);
    },
    removeCapability: async (cap) => {
      state.caps = state.caps.filter((c) => c !== cap);
      delete state.values[cap];
      delete state.options[cap];
    },
    getCapabilityOptions: (cap) => {
      if (!state.options[cap]) throw Error(`Invalid Capability: ${cap}`);
      return state.options[cap];
    },
    setCapabilityOptions: async (cap, options) => {
      state.options[cap] = options;
    },
  };
};

const tests = {
  'leaves a correct list alone': async () => {
    const device = fakeDevice({ caps: ['a', 'b'], values: { a: 1, b: 2 } });
    assert.strictEqual(await DeviceMigrator.migrateCapabilities(device, ['a', 'b']), false);
    assert.deepStrictEqual(device.state.caps, ['a', 'b']);
  },
  'inserts in the middle, keeps order and values': async () => {
    const device = fakeDevice({ caps: ['a', 'b', 'c'], values: { a: 1, b: 2, c: 3 } });
    assert.strictEqual(await DeviceMigrator.migrateCapabilities(device, ['a', 'x', 'b', 'c']), true);
    assert.deepStrictEqual(device.state.caps, ['a', 'x', 'b', 'c']);
    assert.deepStrictEqual(device.state.values, { a: 1, b: 2, c: 3 });
    assert.strictEqual(device.state.available, true);
  },
  'drops retired capabilities, including trailing ones': async () => {
    const device = fakeDevice({ caps: ['a', 'old', 'b', 'tail'], values: { a: 1, b: 2 } });
    await DeviceMigrator.migrateCapabilities(device, ['a', 'b']);
    assert.deepStrictEqual(device.state.caps, ['a', 'b']);
    assert.deepStrictEqual(device.state.values, { a: 1, b: 2 });
  },
  'does not mark an unavailable device available': async () => {
    const device = fakeDevice({ caps: ['a'], available: false });
    await DeviceMigrator.migrateCapabilities(device, ['a', 'b']);
    assert.strictEqual(device.state.available, false);
  },
  'runs two migrations at once one after the other': async () => {
    const device = fakeDevice({ caps: ['a'] });
    await Promise.all([
      DeviceMigrator.migrateCapabilities(device, ['a', 'b']),
      DeviceMigrator.migrateCapabilities(device, ['a', 'b', 'c']),
    ]);
    assert.deepStrictEqual(device.state.caps, ['a', 'b', 'c']);
  },
  'merges options onto the manifest and skips a no-op': async () => {
    const device = fakeDevice({ caps: ['target_power'], manifestOptions: { target_power: { title: { en: 'Power limit' }, max: 8000 } } });
    await DeviceMigrator.syncCapabilityOptions(device, { target_power: { min: 0, max: 10000, step: 100 } });
    assert.deepStrictEqual(device.state.options.target_power, {
      title: { en: 'Power limit' }, min: 0, max: 10000, step: 100,
    });
    let writes = 0;
    const set = device.setCapabilityOptions;
    device.setCapabilityOptions = async (...args) => {
      writes += 1; return set(...args);
    };
    await DeviceMigrator.syncCapabilityOptions(device, { target_power: { min: 0, max: 10000, step: 100 } });
    assert.strictEqual(writes, 0);
    // after a rebuild the read is not trusted: force writes anyway
    await DeviceMigrator.syncCapabilityOptions(device, { target_power: { min: 0, max: 10000, step: 100 } }, { force: true });
    assert.strictEqual(writes, 1);
  },
};

const main = async () => {
  let failed = 0;
  for (const [name, test] of Object.entries(tests)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await test();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}: ${error.stack}`);
    }
  }
  if (failed) {
    console.error(`FAIL - ${failed} DeviceMigrator test(s)`);
    process.exit(1);
  }
  console.log(`OK - ${Object.keys(tests).length} DeviceMigrator tests`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
