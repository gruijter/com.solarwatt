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

/**
 * Decoders for the `Map<address, word>` from CommonDevice.readBlocks(). They return `undefined`
 * for a register that was not read, which leaves its capability untouched.
 *
 * Multi-register values are big-endian, high word first: undocumented (deviation D-02), measured
 * on the vision (39149 reads 2513.5 kWh this way, 35875717 kWh with the words swapped).
 */

/** Unsigned 16-bit. */
const u16 = (regs, address) => regs.get(address);

/** Signed 16-bit. */
const i16 = (regs, address) => {
  const value = regs.get(address);
  if (value === undefined) return undefined;
  return value > 0x7fff ? value - 0x10000 : value;
};

/** Unsigned 32-bit, high word first. */
const u32 = (regs, address) => {
  const high = regs.get(address);
  const low = regs.get(address + 1);
  if (high === undefined || low === undefined) return undefined;
  return (high * 0x10000) + low;
};

/** Signed 32-bit, high word first. */
const i32 = (regs, address) => {
  const value = u32(regs, address);
  if (value === undefined) return undefined;
  return value > 0x7fffffff ? value - 0x100000000 : value;
};

/**
 * ASCII string spread over `length` registers, two characters per register, high byte first.
 * Trailing NUL padding is stripped.
 */
const str = (regs, address, length) => {
  const bytes = Buffer.alloc(length * 2);
  let seen = 0;
  for (let i = 0; i < length; i += 1) {
    const word = regs.get(address + i);
    if (word === undefined) break;
    bytes.writeUInt16BE(word, i * 2);
    seen += 1;
  }
  if (seen === 0) return undefined;
  // NUL padding, stripped without a regex (no-control-regex)
  const text = bytes.subarray(0, seen * 2)
    .filter((byte) => byte !== 0)
    .toString('latin1')
    .trim();
  return text.length ? text : undefined;
};

/** Apply a documented gain, i.e. the raw value is `gain` times the real-world unit. */
const scale = (value, gain) => (value === undefined ? undefined : value / gain);

/** Round to `decimals`, so a 0.1-gain register doesn't surface 22.900000000000002. */
const round = (value, decimals = 2) => {
  if (value === undefined) return undefined;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** True when `index` is set in the bitfield register at `address`. */
const bit = (regs, address, index) => {
  const value = regs.get(address);
  if (value === undefined) return undefined;
  return ((value >> index) & 1) === 1;
};

module.exports = {
  u16, i16, u32, i32, str, scale, round, bit,
};
