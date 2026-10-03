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
 * Two checks that `homey app validate` cannot make, run with `npm test`.
 *
 * 1. Every driver manifest lists exactly the capabilities its register map decodes, in the
 *    same order. CommonDevice.migrate() takes the register map as the source of truth, so a
 *    manifest that disagrees would make every freshly paired device migrate on first boot -
 *    which works, but churns capabilities for no reason and hides real migrations in the log.
 *
 * 2. Every translatable string carries all thirteen locales. A missing one fails at publish
 *    time, long after the change that caused it.
 */

const fs = require('fs');
const path = require('path');
const pointMap = require('../lib/solarwattPointMap');

const ROOT = path.join(__dirname, '..');
const DRIVERS = ['inverter', 'battery', 'meter', 'charger'];
const LOCALES = ['nl', 'de', 'fr', 'es', 'it', 'da', 'sv', 'no', 'pl', 'ru', 'ar', 'ko'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const failures = [];

// --- 1. manifest capabilities match the register map -------------------------------------

for (const id of DRIVERS) {
  const manifest = readJson(path.join(ROOT, 'drivers', id, 'driver.compose.json')).capabilities || [];
  const mapped = Object.keys(pointMap[id].capabilities);

  if (manifest.length !== mapped.length || manifest.some((cap, i) => mapped[i] !== cap)) {
    failures.push(`${id}: manifest and register map disagree\n`
      + `    manifest: ${manifest.join(', ')}\n`
      + `    map:      ${mapped.join(', ')}`);
  }
}

// --- 2. every translatable string has all locales ----------------------------------------

const walk = (node, file, trail) => {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, file, `${trail}[${i}]`));
    return;
  }
  if (!node || typeof node !== 'object') return;

  // A translation object: strings per locale, or arrays per locale for the app's tags.
  const kind = typeof node.en === 'string' ? 'string' : Array.isArray(node.en) && 'array';
  if (kind) {
    const missing = LOCALES.filter((locale) => (kind === 'array' ? !Array.isArray(node[locale]) : typeof node[locale] !== 'string'));
    if (missing.length) failures.push(`${file} ${trail} missing: ${missing.join(', ')}`);
  }
  for (const key of Object.keys(node)) walk(node[key], file, `${trail}.${key}`);
};

const collect = (dir, into) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, into);
    else if (entry.name.endsWith('.json')) into.push(full);
  }
  return into;
};

const files = collect(path.join(ROOT, '.homeycompose'), []);
for (const id of DRIVERS) files.push(path.join(ROOT, 'drivers', id, 'driver.compose.json'));
for (const file of files) walk(readJson(file), path.relative(ROOT, file), '');

// --- report ------------------------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL - ${failures.length} problem(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`OK - ${DRIVERS.length} manifests match their register maps, `
  + `${files.length} files carry all 13 locales`);
