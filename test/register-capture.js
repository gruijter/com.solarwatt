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
 * The register capture survives the trip through a diagnostics report: runs, chunking, line
 * prefixes and a truncated report.
 */

const assert = require('assert');
const registerCapture = require('../lib/registerCapture');

const registers = new Map();
for (let i = 0; i < 300; i += 1) registers.set(37609 + i, (i * 997) & 0xffff);
registers.set(49203, 1);
registers.set(49204, 0xffff);

const runs = registerCapture.toRuns(registers);
assert.deepStrictEqual(Object.keys(runs), ['37609', '49203']);
assert.deepStrictEqual(registerCapture.fromRuns(runs), registers);

const lines = [];
const payload = { reason: 'device start', registers: runs, values: { measure_battery: 13 } };
assert.ok(registerCapture.record('batteryPoll', payload, (line) => lines.push(line)));
assert.ok(lines.length > 3, 'chunked over several lines');

// a diagnostics report prefixes every line
const report = lines.map((line) => `2026-10-07T08:16:13.311Z [log] [ManagerDrivers] [Driver:battery] [Device:x] ${line}`).join('\n');
const { captures, errors } = registerCapture.parseLog(report);
assert.deepStrictEqual(errors, []);
assert.deepStrictEqual(captures.batteryPoll, payload);

const truncated = registerCapture.parseLog(report.split('\n').filter((line, i) => i !== 2).join('\n'));
assert.deepStrictEqual(truncated.captures, {});
assert.match(truncated.errors[0], /missing chunk\(s\) 2/);

const tooBig = [];
assert.ok(!registerCapture.record('batteryPoll', { blob: 'x'.repeat(40000) }, (line) => tooBig.push(line)));
assert.match(tooBig[0], /exceeds/);

console.log('register capture: all checks passed');
