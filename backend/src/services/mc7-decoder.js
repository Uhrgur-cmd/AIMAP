// SPDX-FileCopyrightText: 2019-2022 deroad <wargio@libero.it>
// SPDX-License-Identifier: LGPL-3.0-only
//
// JavaScript port of rz-libmc7 simatic.c
// MC7 Bytecode Decoder for Siemens S7-300/S7-400
// Disassembles MC7 bytecode to AWL/STL instructions

'use strict';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const S7_INVALID_JUMP = -1;

function INSTR_MASK_N(x)     { return x & 0x0F; }
function INSTR_MASK_T(x)     { return x & 0x70; }
function INSTR_MASK_T_LOW(x) { return x & 0x07; }

function INSTR_IS_BITLOGIC(x)   { return x >= 0x10 && x <= 0x67; }
function INSTR_IS_BITLOGIC_N(x) { return x >= 0x90 && x <= 0xE7; }

function INSTR_IS_BITLOGIC_MEM(x) {
  return INSTR_MASK_T_LOW(x) !== 0 && INSTR_MASK_T_LOW(x) !== 7 && x >= 0x31 && x <= 0x6E;
}
function INSTR_IS_BITLOGIC_MEM_N(x) {
  return INSTR_MASK_T_LOW(x) !== 0 && INSTR_MASK_T_LOW(x) !== 7 && x >= 0xB1 && x <= 0xEE;
}
function INSTR_IS_BITLOGIC_MEM_IO(x) { return (x & 0xF) >= 0x9; }

function INSTR_IS_79(x)   { return x >= 0x10 && x <= 0x6D; }
function INSTR_IS_79_N(x) { return x >= 0x90 && x <= 0xED; }

function INSTR_IS_7E(x) { return x >= 0x01 && x <= 0x67; }

function INSTR_IS_MEM(x)    { return x >= 0x30 && x <= 0x6E; }
function INSTR_IS_MEM_N(x)  { return x >= 0xB0 && x <= 0xEE; }
function INSTR_IS_MEM_IO(x) { return (x & 0x0F) > 6; }

// ---------------------------------------------------------------------------
// Type lookup tables
// ---------------------------------------------------------------------------

const types_def = [
  { byte: 0x10, type: 'I' },
  { byte: 0x20, type: 'Q' },
  { byte: 0x30, type: 'M' },
  { byte: 0x40, type: 'DB' },
  { byte: 0x50, type: 'DI' },
  { byte: 0x60, type: 'L' },
];

const types_x = [
  { byte: 0x10, type: 'I' },
  { byte: 0x20, type: 'Q' },
  { byte: 0x30, type: 'M' },
  { byte: 0x40, type: 'DBX' },
  { byte: 0x50, type: 'DIX' },
  { byte: 0x60, type: 'L' },
];

const types_w = [
  { byte: 0x00, type: 'PIW' },
  { byte: 0x10, type: 'IW' },
  { byte: 0x20, type: 'QW' },
  { byte: 0x30, type: 'MW' },
  { byte: 0x40, type: 'DBW' },
  { byte: 0x50, type: 'DIW' },
  { byte: 0x60, type: 'LW' },
];

const types_d = [
  { byte: 0x00, type: 'PID' },
  { byte: 0x10, type: 'ID' },
  { byte: 0x20, type: 'QD' },
  { byte: 0x30, type: 'MD' },
  { byte: 0x40, type: 'DBD' },
  { byte: 0x50, type: 'DID' },
  { byte: 0x60, type: 'LD' },
];

const types_b = [
  { byte: 0x00, type: 'PIB' },
  { byte: 0x10, type: 'IB' },
  { byte: 0x20, type: 'QB' },
  { byte: 0x30, type: 'MB' },
  { byte: 0x40, type: 'DBB' },
  { byte: 0x50, type: 'DIB' },
  { byte: 0x60, type: 'LB' },
];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function s7_type(T, types) {
  for (let i = 0; i < types.length; i++) {
    if (T === types[i].byte) {
      return types[i].type;
    }
  }
  return '?';
}

function s7_mem_type(T) {
  T = INSTR_MASK_T(T);
  if (T === 0x30) return 'MD';
  if (T === 0x40) return 'DBD';
  if (T === 0x50) return 'DID';
  if (T === 0x60) return 'LD';
  return null;
}

function s7_ut16(buffer, off) {
  return ((buffer[off] << 8) | buffer[off + 1]) >>> 0;
}

function s7_ut32(buffer, off) {
  return (((buffer[off] << 24) | (buffer[off + 1] << 16) | (buffer[off + 2] << 8) | buffer[off + 3]) >>> 0);
}

/** Interpret a uint16 as a signed int16 */
function toS16(v) {
  return (v > 0x7FFF) ? v - 0x10000 : v;
}

/** Interpret a uint32 as a signed int32 */
function toS32(v) {
  return (v > 0x7FFFFFFF) ? v - 0x100000000 : v;
}

/** Convert a uint32 bit pattern to a 32-bit float */
function uint32ToFloat(u) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(u);
  return buf.readFloatBE(0);
}

/** Format a binary string from a 16-bit value, stripping leading zeros (keep at least 1) */
function toBin16(hi, lo) {
  let s = '';
  for (let i = 7; i >= 0; i--) s += ((hi >> i) & 1) ? '1' : '0';
  for (let i = 7; i >= 0; i--) s += ((lo >> i) & 1) ? '1' : '0';
  let idx = 0;
  while (idx < 15 && s[idx] === '0') idx++;
  return s.substring(idx);
}

/** Format a binary string from a 32-bit value (4 bytes), stripping leading zeros */
function toBin32(b0, b1, b2, b3) {
  let s = '';
  for (const b of [b0, b1, b2, b3]) {
    for (let i = 7; i >= 0; i--) s += ((b >> i) & 1) ? '1' : '0';
  }
  let idx = 0;
  while (idx < 31 && s[idx] === '0') idx++;
  return s.substring(idx);
}

function s7_memory_loc(byte) {
  switch (byte) {
    case 0x00: return '';
    case 0x80: return 'PI/PQ';
    case 0x81: return 'I';
    case 0x82: return 'Q';
    case 0x83: return 'M';
    case 0x84: return 'DB';
    case 0x85: return 'DI';
    case 0x86: return 'L';
    case 0x87: return 'V';
    default: return null;
  }
}

function s7_type_7E(T) {
  if (INSTR_MASK_T(T) === 0x00) {
    return INSTR_MASK_T_LOW(T) > 0x03 ? 'PQ' : 'PI';
  }
  const t = INSTR_MASK_T(T);
  if (t === 0x10) return 'I';
  if (t === 0x20) return 'Q';
  if (t === 0x30) return 'M';
  if (t === 0x40) return 'DB';
  if (t === 0x50) return 'DI';
  if (t === 0x60) return 'L';
  return '?';
}

// ---------------------------------------------------------------------------
// Sub-decoders
// ---------------------------------------------------------------------------

function s7_decode_bitlogic(zero_op, memory_op, io_op, buffer, off, size) {
  if (buffer[off] === 0x00) {
    return { assembly: zero_op, size: 2 };
  } else if (size > 2) {
    if (INSTR_IS_BITLOGIC(buffer[off])) {
      const value = s7_ut16(buffer, off + 1);
      const N = INSTR_MASK_N(buffer[off]);
      const type = s7_type(INSTR_MASK_T(buffer[off]), types_x);
      return { assembly: `${memory_op} ${type} ${value}.${N}`, size: 4 };
    } else if (io_op !== null && INSTR_IS_BITLOGIC_N(buffer[off])) {
      const value = s7_ut16(buffer, off + 1);
      const N = INSTR_MASK_N(buffer[off]);
      const type = s7_type(INSTR_MASK_T(buffer[off]), types_x);
      return { assembly: `${io_op} ${type} ${value}.${N}`, size: 4 };
    }
  }
  return null;
}

function s7_decode_byte(op, prefix, buffer, off, size) {
  const N = buffer[off];
  return { assembly: `${op} ${prefix}${N}`, size: 2 };
}

function s7_decode_byte_s(op, suffix, buffer, off, size) {
  const N = buffer[off];
  return { assembly: `${op} ${N}${suffix}`, size: 2 };
}

function s7_decode_byte_signed(op, type_pos, type_neg, suffix, buffer, off, size) {
  let N = buffer[off];
  if (N > 0x7F) {
    N &= 0x7F;
    return { assembly: `${op} ${type_neg} ${N}${suffix}`, size: 2 };
  } else {
    return { assembly: `${op} ${type_pos} ${N}${suffix}`, size: 2 };
  }
}

function s7_decode_4bit(op, high, buffer, off, size) {
  const N = high ? (buffer[off] >> 4) : (buffer[off] & 0x0F);
  return { assembly: `${op} ${N}`, size: 2 };
}

function s7_decode_cmp(type, buffer, off, size) {
  switch (buffer[off]) {
    case 0x20: return { assembly: `>${type}`, size: 2 };
    case 0x40: return { assembly: `<${type}`, size: 2 };
    case 0x60: return { assembly: `<>${type}`, size: 2 };
    case 0x80: return { assembly: `==${type}`, size: 2 };
    case 0xA0: return { assembly: `>=${type}`, size: 2 };
    case 0xC0: return { assembly: `<=${type}`, size: 2 };
    default: return null;
  }
}

function s7_decode_lit16(buffer, off, size) {
  if (size < 2) return null;
  const value = s7_ut16(buffer, off + 1);
  switch (buffer[off]) {
    case 0x02:
      return { assembly: `L 2#${toBin16(buffer[off + 1], buffer[off + 2])}`, size: 4 };
    case 0x03:
      return { assembly: `L ${toS16(value)}`, size: 4 };
    case 0x05:
      if (buffer[off + 1]) {
        return { assembly: `L '${String.fromCharCode(buffer[off + 1])}${String.fromCharCode(buffer[off + 2])}'`, size: 4 };
      } else {
        return { assembly: `L '${String.fromCharCode(buffer[off + 2])}'`, size: 4 };
      }
    case 0x06:
      return { assembly: `L B#(${String(buffer[off + 1]).padStart(2, '0')}, ${String(buffer[off + 2]).padStart(2, '0')})`, size: 4 };
    case 0x07:
      return { assembly: `L W#16#${value.toString(16)}`, size: 4 };
    case 0x08:
      if (value < 0x1000) {
        return { assembly: `L C#${value.toString(16)}`, size: 4 };
      } else {
        return null;
      }
    case 0x0A: {
      // DATE: days since 1990-01-01
      const rawtime = (value * 86400 + 631152000) * 1000; // ms for JS Date
      const d = new Date(rawtime);
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      return { assembly: `L D#${year}-${month}-${day}`, size: 4 };
    }
    case 0x0C: {
      // S5TIME
      if ((value & 0xf000) > 0x3000 || value > 0x3999) {
        return null;
      }
      let ms = (((value & 0x0F00) >> 8) * 100) + (((value & 0xF0) >> 4) * 10) + (value & 0x0F);
      if ((value & 0xf000) === 0x3000) {
        ms *= 10000;
      } else if ((value & 0xf000) === 0x2000) {
        ms *= 1000;
      } else if ((value & 0xf000) === 0x1000) {
        ms *= 100;
      } else {
        ms *= 10;
      }

      let hours = 0, mins = 0, secs = 0;
      if (ms >= 3600000) { hours = Math.floor(ms / 3600000); ms -= hours * 3600000; }
      if (ms >= 60000)   { mins = Math.floor(ms / 60000);    ms -= mins * 60000; }
      if (ms >= 1000)    { secs = Math.floor(ms / 1000);     ms -= secs * 1000; }

      let s = 'L S5T#';
      if (hours > 0) s += `${hours}H`;
      if (mins > 0) s += `${mins}M`;
      if (secs > 0) s += `${secs}S`;
      if ((ms > 0 && ((value & 0xf000) < 0x2000)) || (hours < 1 && mins < 1 && secs < 1)) {
        s += `${ms}MS`;
      }
      return { assembly: s, size: 4 };
    }
    default:
      return null;
  }
}

function s7_decode_lit32(buffer, off, size) {
  if (size < 5) return null;
  const value = s7_ut32(buffer, off + 1);
  switch (buffer[off]) {
    case 0x01: {
      // REAL
      const f = uint32ToFloat(value);
      return { assembly: `L ${f.toFixed(6)}`, size: 6 };
    }
    case 0x02:
      return { assembly: `L 2#${toBin32(buffer[off + 1], buffer[off + 2], buffer[off + 3], buffer[off + 4])}`, size: 6 };
    case 0x03:
      return { assembly: `L L#${toS32(value)}`, size: 6 };
    case 0x04: {
      const loc = s7_memory_loc(buffer[off + 1]);
      if (loc === null || (buffer[off + 2] & 0xF8)) return null;
      const bit_addr = buffer[off + 2] & 7;
      const v = value & 0xFFFF;
      return { assembly: `L P#${loc}${v}.${bit_addr}`, size: 6 };
    }
    case 0x05:
      if (buffer[off + 1] && buffer[off + 2] && buffer[off + 3]) {
        return { assembly: `L '${String.fromCharCode(buffer[off + 1])}${String.fromCharCode(buffer[off + 2])}${String.fromCharCode(buffer[off + 3])}${String.fromCharCode(buffer[off + 4])}'`, size: 6 };
      } else if (buffer[off + 2] && buffer[off + 3]) {
        return { assembly: `L '${String.fromCharCode(buffer[off + 2])}${String.fromCharCode(buffer[off + 3])}${String.fromCharCode(buffer[off + 4])}'`, size: 6 };
      } else if (buffer[off + 3]) {
        return { assembly: `L '${String.fromCharCode(buffer[off + 3])}${String.fromCharCode(buffer[off + 4])}'`, size: 6 };
      } else {
        return { assembly: `L '${String.fromCharCode(buffer[off + 4])}'`, size: 6 };
      }
    case 0x06:
      return { assembly: `L B#(${String(buffer[off + 1]).padStart(2, '0')}, ${String(buffer[off + 2]).padStart(2, '0')}, ${String(buffer[off + 3]).padStart(2, '0')}, ${String(buffer[off + 4]).padStart(2, '0')})`, size: 6 };
    case 0x07:
      return { assembly: `L DW#16#${value.toString(16)}`, size: 6 };
    case 0x09:
      return { assembly: `L T#${value}MS`, size: 6 };
    case 0x0B: {
      const ms = value % 1000;
      const tsecs = Math.floor(value / 1000);
      const secs = tsecs % 60;
      const mins = Math.floor(tsecs / 60) % 60;
      const hours = Math.floor(tsecs / 3600);
      return { assembly: `L TOD#${hours}:${mins}:${secs}.${ms}`, size: 6 };
    }
    default:
      return null;
  }
}

function s7_decode_bitlogic_mem(zero_op, zero_op_value, memory_op, io_op, n_memory_op, n_io_op, buffer, off, size) {
  if (buffer[off] === 0x00 && !zero_op_value) {
    return { assembly: zero_op, size: 2 };
  } else if (size > 2) {
    if (buffer[off] === 0x00 && zero_op_value) {
      const value = toS16(s7_ut16(buffer, off + 1));
      return { assembly: `${zero_op} ${value}`, size: 4 };
    }
    const mem_type = s7_mem_type(buffer[off]);
    const value = s7_ut16(buffer, off + 1);
    if (mem_type && INSTR_IS_BITLOGIC_MEM(buffer[off])) {
      const op2 = INSTR_IS_BITLOGIC_MEM_IO(buffer[off]) ? io_op : memory_op;
      const type = s7_type(INSTR_MASK_T((buffer[off] << 4) & 0xFF), types_x);
      return { assembly: `${op2} ${type} [${mem_type} ${value}]`, size: 4 };
    } else if (mem_type && INSTR_IS_BITLOGIC_MEM_N(buffer[off])) {
      const op2 = INSTR_IS_BITLOGIC_MEM_IO(buffer[off]) ? n_io_op : n_memory_op;
      if (op2 === null) return null;
      const type = s7_type(INSTR_MASK_T((buffer[off] << 4) & 0xFF), types_x);
      return { assembly: `${op2} ${type} [${mem_type} ${value}]`, size: 4 };
    }
  }
  return null;
}

function s7_decode_jump(op, addr, buffer, off, size) {
  if (size > 2) {
    const N = toS16(s7_ut16(buffer, off + 1));
    const target = addr + N;
    return { assembly: `${op} 0x${target.toString(16)}`, size: 4, jump: target };
  }
  return null;
}

function s7_decode_static(ops, buffer, off, size) {
  for (let i = 0; i < ops.length; i++) {
    if (buffer[off] === ops[i].byte) {
      return { assembly: ops[i].op, size: 2 };
    }
  }
  return null;
}

function s7_decode_mem(zero_op, memory_op, io_op, memory_type, io_type, buffer, off, size) {
  if (buffer[off] === 0x00) {
    return { assembly: zero_op, size: 2 };
  } else if (size > 2) {
    const mem_type = s7_mem_type(buffer[off]);
    const value = s7_ut16(buffer, off + 1);
    if (mem_type && INSTR_IS_MEM(buffer[off])) {
      const type = s7_type(INSTR_MASK_T((buffer[off] << 4) & 0xFF), INSTR_IS_MEM_IO(buffer[off]) ? io_type : memory_type);
      return { assembly: `${memory_op} ${type} [${mem_type} ${value}]`, size: 4 };
    } else if (mem_type && INSTR_IS_MEM_N(buffer[off])) {
      const type = s7_type(INSTR_MASK_T((buffer[off] << 4) & 0xFF), INSTR_IS_MEM_IO(buffer[off]) ? io_type : memory_type);
      return { assembly: `${io_op} ${type} [${mem_type} ${value}]`, size: 4 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// s7_decode_79
// ---------------------------------------------------------------------------

function s7_decode_79(buffer, off, size) {
  if (buffer[off] === 0x00) {
    return { assembly: '+I', size: 2 };
  } else if (size > 2) {
    const op = buffer[off] & 0x07;
    const ar = (buffer[off] & 0x08) ? 2 : 1;
    const value = s7_ut16(buffer, off + 1);
    const type = s7_type(INSTR_MASK_T(buffer[off]), types_x);
    if (INSTR_IS_79(buffer[off])) {
      switch (op) {
        case 0x00: return { assembly: `A ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        case 0x01: return { assembly: `AN ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        case 0x02: return { assembly: `O ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        case 0x03: return { assembly: `ON ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        case 0x04: return { assembly: `X ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        case 0x05: return { assembly: `XN ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        default: return null;
      }
    } else if (INSTR_IS_79_N(buffer[off])) {
      switch (op) {
        case 0x00: return { assembly: `S ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        case 0x01: return { assembly: `R ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        case 0x02: return { assembly: `= ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        case 0x04: return { assembly: `FP ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        case 0x05: return { assembly: `FN ${type} [AR${ar}, P#${value >> 3}.${value & 7}]`, size: 4 };
        default: return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// s7_decode_7E
// ---------------------------------------------------------------------------

function s7_decode_7E(buffer, off, size) {
  if (size > 2 && INSTR_IS_7E(buffer[off])) {
    const op = buffer[off] & 0x07;
    const value = s7_ut16(buffer, off + 1);
    const type = s7_type_7E(buffer[off]);
    switch (op) {
      case 0x01: return { assembly: `L ${type}B ${value}`, size: 4 };
      case 0x02: return { assembly: `L ${type}W ${value}`, size: 4 };
      case 0x03: return { assembly: `L ${type}D ${value}`, size: 4 };
      case 0x05: return { assembly: `T ${type}B ${value}`, size: 4 };
      case 0x06: return { assembly: `T ${type}W ${value}`, size: 4 };
      case 0x07: return { assembly: `T ${type}D ${value}`, size: 4 };
      default: return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// s7_decode_BE  (L/T via AR1/AR2 with area prefix)
// ---------------------------------------------------------------------------

function s7_decode_BE(buffer, off, size) {
  if (size > 2 && buffer[off] >= 0x11 && buffer[off] <= 0x6F && (buffer[off] & 0x0F)) {
    const op = buffer[off] & 0x0F;
    const value = s7_ut16(buffer, off + 1);
    const type = s7_type(INSTR_MASK_T(buffer[off]), types_def);
    switch (op) {
      case 0x01: return { assembly: `L ${type}B [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x02: return { assembly: `L ${type}W [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x03: return { assembly: `L ${type}D [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x05: return { assembly: `T ${type}B [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x06: return { assembly: `T ${type}W [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x07: return { assembly: `T ${type}D [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x09: return { assembly: `L ${type}B [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0A: return { assembly: `L ${type}W [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0B: return { assembly: `L ${type}D [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0D: return { assembly: `T ${type}B [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0E: return { assembly: `T ${type}W [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0F: return { assembly: `T ${type}D [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      default: return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// s7_decode_BF  (timer/counter indirect via MW/DBW/DIW/LW)
// ---------------------------------------------------------------------------

function s7_decode_BF(buffer, off, size) {
  if (buffer[off] === 0x00) {
    return { assembly: ')', size: 2 };
  } else if (size > 2) {
    const value = s7_ut16(buffer, off + 1);
    switch (buffer[off]) {
      // Timer indirect via MW
      case 0x30: return { assembly: `A T [MW ${value}]`, size: 4 };
      case 0x31: return { assembly: `AN T [MW ${value}]`, size: 4 };
      case 0x32: return { assembly: `O T [MW ${value}]`, size: 4 };
      case 0x33: return { assembly: `ON T [MW ${value}]`, size: 4 };
      case 0x34: return { assembly: `X T [MW ${value}]`, size: 4 };
      case 0x35: return { assembly: `XN T [MW ${value}]`, size: 4 };
      case 0x36: return { assembly: `L T [MW ${value}]`, size: 4 };
      case 0x38: return { assembly: `FR T [MW ${value}]`, size: 4 };
      case 0x39: return { assembly: `LC T [MW ${value}]`, size: 4 };
      case 0x3A: return { assembly: `SF T [MW ${value}]`, size: 4 };
      case 0x3B: return { assembly: `SE T [MW ${value}]`, size: 4 };
      case 0x3C: return { assembly: `SD T [MW ${value}]`, size: 4 };
      case 0x3D: return { assembly: `SS T [MW ${value}]`, size: 4 };
      case 0x3E: return { assembly: `SP T [MW ${value}]`, size: 4 };
      case 0x3F: return { assembly: `R T [MW ${value}]`, size: 4 };
      // Timer indirect via DBW
      case 0x40: return { assembly: `A T [DBW ${value}]`, size: 4 };
      case 0x41: return { assembly: `AN T [DBW ${value}]`, size: 4 };
      case 0x42: return { assembly: `O T [DBW ${value}]`, size: 4 };
      case 0x43: return { assembly: `ON T [DBW ${value}]`, size: 4 };
      case 0x44: return { assembly: `X T [DBW ${value}]`, size: 4 };
      case 0x45: return { assembly: `XN T [DBW ${value}]`, size: 4 };
      case 0x46: return { assembly: `L T [DBW ${value}]`, size: 4 };
      case 0x48: return { assembly: `FR T [DBW ${value}]`, size: 4 };
      case 0x49: return { assembly: `LC T [DBW ${value}]`, size: 4 };
      case 0x4A: return { assembly: `SF T [DBW ${value}]`, size: 4 };
      case 0x4B: return { assembly: `SE T [DBW ${value}]`, size: 4 };
      case 0x4C: return { assembly: `SD T [DBW ${value}]`, size: 4 };
      case 0x4D: return { assembly: `SS T [DBW ${value}]`, size: 4 };
      case 0x4E: return { assembly: `SP T [DBW ${value}]`, size: 4 };
      case 0x4F: return { assembly: `R T [DBW ${value}]`, size: 4 };
      // Timer indirect via DIW
      case 0x50: return { assembly: `A T [DIW ${value}]`, size: 4 };
      case 0x51: return { assembly: `AN T [DIW ${value}]`, size: 4 };
      case 0x52: return { assembly: `O T [DIW ${value}]`, size: 4 };
      case 0x53: return { assembly: `ON T [DIW ${value}]`, size: 4 };
      case 0x54: return { assembly: `X T [DIW ${value}]`, size: 4 };
      case 0x55: return { assembly: `XN T [DIW ${value}]`, size: 4 };
      case 0x58: return { assembly: `FR T [DIW ${value}]`, size: 4 };
      case 0x5C: return { assembly: `SD T [DIW ${value}]`, size: 4 };
      case 0x5D: return { assembly: `SS T [DIW ${value}]`, size: 4 };
      case 0x5E: return { assembly: `SP T [DIW ${value}]`, size: 4 };
      case 0x5F: return { assembly: `R T [DIW ${value}]`, size: 4 };
      // Timer indirect via LW
      case 0x60: return { assembly: `A T [LW ${value}]`, size: 4 };
      case 0x61: return { assembly: `AN T [LW ${value}]`, size: 4 };
      case 0x62: return { assembly: `O T [LW ${value}]`, size: 4 };
      case 0x63: return { assembly: `ON T [LW ${value}]`, size: 4 };
      case 0x64: return { assembly: `X T [LW ${value}]`, size: 4 };
      case 0x65: return { assembly: `XN T [LW ${value}]`, size: 4 };
      case 0x66: return { assembly: `L T [LW ${value}]`, size: 4 };
      case 0x68: return { assembly: `FR T [LW ${value}]`, size: 4 };
      case 0x69: return { assembly: `LC T [LW ${value}]`, size: 4 };
      case 0x6A: return { assembly: `SF T [LW ${value}]`, size: 4 };
      case 0x6B: return { assembly: `SE T [LW ${value}]`, size: 4 };
      case 0x6C: return { assembly: `SD T [LW ${value}]`, size: 4 };
      case 0x6D: return { assembly: `SS T [LW ${value}]`, size: 4 };
      case 0x6E: return { assembly: `SP T [LW ${value}]`, size: 4 };
      case 0x6F: return { assembly: `R T [LW ${value}]`, size: 4 };
      // Counter indirect via MW
      case 0xB0: return { assembly: `A C [MW ${value}]`, size: 4 };
      case 0xB1: return { assembly: `AN C [MW ${value}]`, size: 4 };
      case 0xB2: return { assembly: `O C [MW ${value}]`, size: 4 };
      case 0xB3: return { assembly: `ON C [MW ${value}]`, size: 4 };
      case 0xB4: return { assembly: `X C [MW ${value}]`, size: 4 };
      case 0xB5: return { assembly: `XN C [MW ${value}]`, size: 4 };
      case 0xB6: return { assembly: `L C [MW ${value}]`, size: 4 };
      case 0xB8: return { assembly: `FR C [MW ${value}]`, size: 4 };
      case 0xB9: return { assembly: `LC C [MW ${value}]`, size: 4 };
      case 0xBA: return { assembly: `CD C [MW ${value}]`, size: 4 };
      case 0xBB: return { assembly: `S C [MW ${value}]`, size: 4 };
      case 0xBD: return { assembly: `CU C [MW ${value}]`, size: 4 };
      case 0xBF: return { assembly: `R C [MW ${value}]`, size: 4 };
      // Counter indirect via DBW
      case 0xC0: return { assembly: `A C [DBW ${value}]`, size: 4 };
      case 0xC1: return { assembly: `AN C [DBW ${value}]`, size: 4 };
      case 0xC2: return { assembly: `O C [DBW ${value}]`, size: 4 };
      case 0xC3: return { assembly: `ON C [DBW ${value}]`, size: 4 };
      case 0xC4: return { assembly: `X C [DBW ${value}]`, size: 4 };
      case 0xC5: return { assembly: `XN C [DBW ${value}]`, size: 4 };
      case 0xC6: return { assembly: `L C [DBW ${value}]`, size: 4 };
      case 0xC8: return { assembly: `FR C [DBW ${value}]`, size: 4 };
      case 0xC9: return { assembly: `LC C [DBW ${value}]`, size: 4 };
      case 0xCA: return { assembly: `CD C [DBW ${value}]`, size: 4 };
      case 0xCB: return { assembly: `S C [DBW ${value}]`, size: 4 };
      case 0xCD: return { assembly: `CU C [DBW ${value}]`, size: 4 };
      case 0xCF: return { assembly: `R C [DBW ${value}]`, size: 4 };
      // Counter indirect via DIW
      case 0xD0: return { assembly: `A C [DIW ${value}]`, size: 4 };
      case 0xD1: return { assembly: `AN C [DIW ${value}]`, size: 4 };
      case 0xD2: return { assembly: `O C [DIW ${value}]`, size: 4 };
      case 0xD3: return { assembly: `ON C [DIW ${value}]`, size: 4 };
      case 0xD4: return { assembly: `X C [DIW ${value}]`, size: 4 };
      case 0xD5: return { assembly: `XN C [DIW ${value}]`, size: 4 };
      case 0xD6: return { assembly: `L C [DIW ${value}]`, size: 4 };
      case 0xD8: return { assembly: `FR C [DIW ${value}]`, size: 4 };
      case 0xD9: return { assembly: `LC C [DIW ${value}]`, size: 4 };
      case 0xDA: return { assembly: `CD C [DIW ${value}]`, size: 4 };
      case 0xDB: return { assembly: `S C [DIW ${value}]`, size: 4 };
      case 0xDD: return { assembly: `CU C [DIW ${value}]`, size: 4 };
      case 0xDF: return { assembly: `R C [DIW ${value}]`, size: 4 };
      // Counter indirect via LW
      case 0xE0: return { assembly: `A C [LW ${value}]`, size: 4 };
      case 0xE1: return { assembly: `AN C [LW ${value}]`, size: 4 };
      case 0xE2: return { assembly: `O C [LW ${value}]`, size: 4 };
      case 0xE3: return { assembly: `ON C [LW ${value}]`, size: 4 };
      case 0xE4: return { assembly: `X C [LW ${value}]`, size: 4 };
      case 0xE5: return { assembly: `XN C [LW ${value}]`, size: 4 };
      case 0xE6: return { assembly: `L C [LW ${value}]`, size: 4 };
      case 0xE8: return { assembly: `FR C [LW ${value}]`, size: 4 };
      case 0xE9: return { assembly: `LC C [LW ${value}]`, size: 4 };
      case 0xEA: return { assembly: `CD C [LW ${value}]`, size: 4 };
      case 0xEB: return { assembly: `S C [LW ${value}]`, size: 4 };
      case 0xED: return { assembly: `CU C [LW ${value}]`, size: 4 };
      case 0xEF: return { assembly: `R C [LW ${value}]`, size: 4 };
      default: return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// s7_decode_FB  (huge: O, L DBLG/DILG/DBNO/DINO, CDB, AR indirect, UC/CC, OPN, params, timers, counters)
// ---------------------------------------------------------------------------

function s7_decode_FB(buffer, off, size) {
  switch (buffer[off]) {
    case 0x00: return { assembly: 'O', size: 2 };
    case 0x3C: return { assembly: 'L DBLG', size: 2 };
    case 0x3D: return { assembly: 'L DILG', size: 2 };
    case 0x4C: return { assembly: 'L DBNO', size: 2 };
    case 0x4D: return { assembly: 'L DINO', size: 2 };
    case 0x7C: return { assembly: 'CDB', size: 2 };
    default: break;
  }
  if (size > 2) {
    const value = s7_ut16(buffer, off + 1);
    switch (buffer[off]) {
      // L/T B/W/D via AR1
      case 0x01: return { assembly: `L B [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x02: return { assembly: `L W [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x03: return { assembly: `L D [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x05: return { assembly: `T B [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x06: return { assembly: `T W [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x07: return { assembly: `T D [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      // L/T B/W/D via AR2
      case 0x09: return { assembly: `L B [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0B: return { assembly: `L W [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0C: return { assembly: `L D [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0D: return { assembly: `T B [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0E: return { assembly: `T W [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x0F: return { assembly: `T D [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      // Bit operations via AR1
      case 0x10: return { assembly: `A [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x11: return { assembly: `AN [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x12: return { assembly: `O [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x13: return { assembly: `ON [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x14: return { assembly: `X [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x15: return { assembly: `XN [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      // Bit operations via AR2
      case 0x18: return { assembly: `A [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x19: return { assembly: `AN [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x1A: return { assembly: `O [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x1B: return { assembly: `ON [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x1C: return { assembly: `X [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x1D: return { assembly: `XN [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      // S/R/= /FP/FN via AR1
      case 0x20: return { assembly: `S [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x21: return { assembly: `R [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x22: return { assembly: `= [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x24: return { assembly: `FP [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x25: return { assembly: `FN [AR1, P#${value >> 3}.${value & 7}]`, size: 4 };
      // S/R/= /FP/FN via AR2
      case 0x28: return { assembly: `S [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x29: return { assembly: `R [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x2A: return { assembly: `= [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x2C: return { assembly: `FP [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      case 0x2D: return { assembly: `FN [AR2, P#${value >> 3}.${value & 7}]`, size: 4 };
      // UC/CC FC/FB indirect via MW
      case 0x30: return { assembly: `UC FC [MW ${value}]`, size: 4 };
      case 0x31: return { assembly: `CC FC [MW ${value}]`, size: 4 };
      case 0x32: return { assembly: `UC FB [MW ${value}]`, size: 4 };
      case 0x33: return { assembly: `CC FB [MW ${value}]`, size: 4 };
      case 0x38: return { assembly: `OPN DB [MW ${value}]`, size: 4 };
      case 0x39: return { assembly: `OPN DI [MW ${value}]`, size: 4 };
      // UC/CC FC/FB indirect via DBW
      case 0x40: return { assembly: `UC FC [DBW ${value}]`, size: 4 };
      case 0x41: return { assembly: `CC FC [DBW ${value}]`, size: 4 };
      case 0x42: return { assembly: `UC FB [DBW ${value}]`, size: 4 };
      case 0x43: return { assembly: `CC FB [DBW ${value}]`, size: 4 };
      case 0x48: return { assembly: `OPN DB [DBW ${value}]`, size: 4 };
      case 0x49: return { assembly: `OPN DI [DBW ${value}]`, size: 4 };
      // UC/CC FC/FB indirect via DIW
      case 0x50: return { assembly: `UC FC [DIW ${value}]`, size: 4 };
      case 0x51: return { assembly: `CC FC [DIW ${value}]`, size: 4 };
      case 0x52: return { assembly: `UC FB [DIW ${value}]`, size: 4 };
      case 0x53: return { assembly: `CC FB [DIW ${value}]`, size: 4 };
      case 0x58: return { assembly: `OPN DB [DIW ${value}]`, size: 4 };
      case 0x59: return { assembly: `OPN DI [DIW ${value}]`, size: 4 };
      // UC/CC FC/FB indirect via LW
      case 0x60: return { assembly: `UC FC [LW ${value}]`, size: 4 };
      case 0x61: return { assembly: `CC FC [LW ${value}]`, size: 4 };
      case 0x62: return { assembly: `UC FB [LW ${value}]`, size: 4 };
      case 0x63: return { assembly: `CC FB [LW ${value}]`, size: 4 };
      case 0x68: return { assembly: `OPN DB [LW ${value}]`, size: 4 };
      case 0x69: return { assembly: `OPN DI [LW ${value}]`, size: 4 };
      // Direct UC/CC FC/FB/SFC/SFB
      case 0x70: return { assembly: `UC FC ${value}`, size: 4 };
      case 0x71: return { assembly: `CC FC ${value}`, size: 4 };
      case 0x72: return { assembly: `UC FC ${value}`, size: 4 };
      case 0x73: return { assembly: `CC FB ${value}`, size: 4 };
      case 0x74: return { assembly: `UC SFC ${value}`, size: 4 };
      case 0x76: return { assembly: `UC SFB ${value}`, size: 4 };
      // OPN DB/DI direct
      case 0x78: return { assembly: `OPN DB ${value}`, size: 4 };
      case 0x79: return { assembly: `OPN DI ${value}`, size: 4 };
      // PARAMETER_BOOLEAN
      case 0x80: return { assembly: `A [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x81: return { assembly: `AN [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x82: return { assembly: `O [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x83: return { assembly: `ON [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x84: return { assembly: `X [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x85: return { assembly: `XN [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x90: return { assembly: `S [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x91: return { assembly: `R [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x92: return { assembly: `= [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x94: return { assembly: `FP [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0x95: return { assembly: `FN [P#${value >> 1}.${value & 1}]`, size: 4 };
      // PARAMETER_TIMER
      case 0xA0: return { assembly: `A [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xA1: return { assembly: `AN [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xA2: return { assembly: `O [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xA3: return { assembly: `ON [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xA4: return { assembly: `X [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xA5: return { assembly: `XN [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xA6: return { assembly: `L [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xA8: return { assembly: `FR [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xA9: return { assembly: `LC [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xAA: return { assembly: `SF [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xAB: return { assembly: `SE [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xAC: return { assembly: `SD [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xAD: return { assembly: `SS [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xAE: return { assembly: `SP [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xAF: return { assembly: `R [P#${value >> 1}.${value & 1}]`, size: 4 };
      // PARAMETER_COUNTER
      case 0xB0: return { assembly: `A [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xB1: return { assembly: `AN [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xB2: return { assembly: `O [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xB3: return { assembly: `ON [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xB4: return { assembly: `X [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xB5: return { assembly: `XN [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xB6: return { assembly: `L [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xB8: return { assembly: `FR [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xB9: return { assembly: `LC [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xBA: return { assembly: `CD [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xBB: return { assembly: `S [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xBD: return { assembly: `CU [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xBF: return { assembly: `R [P#${value >> 1}.${value & 1}]`, size: 4 };
      // PARAMETER_BYTE/WORD/DWORD
      case 0xC1: return { assembly: `L [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xC2: return { assembly: `L [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xC3: return { assembly: `L [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xC5: return { assembly: `T [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xC6: return { assembly: `T [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xC7: return { assembly: `T [P#${value >> 1}.${value & 1}]`, size: 4 };
      // PARAMETER_BLOCK
      case 0xD0: return { assembly: `UC [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xD2: return { assembly: `UC [P#${value >> 1}.${value & 1}]`, size: 4 };
      case 0xD8: return { assembly: `OPN [P#${value >> 1}.${value & 1}]`, size: 4 };
      // Direct timer operations
      case 0xE0: return { assembly: `A T ${value}`, size: 4 };
      case 0xE1: return { assembly: `AN T ${value}`, size: 4 };
      case 0xE2: return { assembly: `O T ${value}`, size: 4 };
      case 0xE3: return { assembly: `ON T ${value}`, size: 4 };
      case 0xE4: return { assembly: `X T ${value}`, size: 4 };
      case 0xE5: return { assembly: `XN T ${value}`, size: 4 };
      case 0xE6: return { assembly: `L T ${value}`, size: 4 };
      case 0xE8: return { assembly: `FR T ${value}`, size: 4 };
      case 0xE9: return { assembly: `LC T ${value}`, size: 4 };
      case 0xEA: return { assembly: `SF T ${value}`, size: 4 };
      case 0xEB: return { assembly: `SE T ${value}`, size: 4 };
      case 0xEC: return { assembly: `SD T ${value}`, size: 4 };
      case 0xED: return { assembly: `SS T ${value}`, size: 4 };
      case 0xEE: return { assembly: `SP T ${value}`, size: 4 };
      case 0xEF: return { assembly: `R T ${value}`, size: 4 };
      // Direct counter operations
      case 0xF0: return { assembly: `A C ${value}`, size: 4 };
      case 0xF1: return { assembly: `AN C ${value}`, size: 4 };
      case 0xF2: return { assembly: `O C ${value}`, size: 4 };
      case 0xF3: return { assembly: `ON C ${value}`, size: 4 };
      case 0xF4: return { assembly: `X C ${value}`, size: 4 };
      case 0xF5: return { assembly: `XN C ${value}`, size: 4 };
      case 0xF6: return { assembly: `L C ${value}`, size: 4 };
      case 0xF8: return { assembly: `FR C ${value}`, size: 4 };
      case 0xF9: return { assembly: `LC C ${value}`, size: 4 };
      case 0xFA: return { assembly: `CD ${value}`, size: 4 };
      case 0xFB: return { assembly: `S ${value}`, size: 4 };
      case 0xFD: return { assembly: `CU ${value}`, size: 4 };
      case 0xFF: return { assembly: `R ${value}`, size: 4 };
      default: return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// s7_decode_FE  (LAR/TAR/+AR/CAR, SRD, extended AR addressing)
// ---------------------------------------------------------------------------

function s7_decode_FE(buffer, off, size) {
  // SRD n (upper nibble 0xC)
  if ((buffer[off] & 0xF0) === 0xC0) {
    const value = buffer[off] & 0x0F;
    return { assembly: `SRD ${value}`, size: 2 };
  }
  switch (buffer[off]) {
    case 0x01: return { assembly: 'LAR1 AR2', size: 2 };
    case 0x04: return { assembly: 'LAR1', size: 2 };
    case 0x05: return { assembly: 'TAR1', size: 2 };
    case 0x06: return { assembly: '+AR1', size: 2 };
    case 0x08: return { assembly: 'CAR', size: 2 };
    case 0x09: return { assembly: 'TAR1 AR2', size: 2 };
    case 0x0C: return { assembly: 'LAR2', size: 2 };
    case 0x0D: return { assembly: 'TAR2', size: 2 };
    case 0x0E: return { assembly: '+AR2', size: 2 };
    default: break;
  }
  if (size > 2) {
    switch (buffer[off]) {
      case 0x03:
        if (size > 4) {
          const value = s7_ut32(buffer, off + 1);
          return { assembly: `LAR1 P#${value >> 1}.${value & 1}`, size: 6 };
        }
        return null;
      case 0x0B:
        if (size > 4) {
          const value = s7_ut32(buffer, off + 1);
          return { assembly: `LAR2 P#${value >> 1}.${value & 1}`, size: 6 };
        }
        return null;
      case 0x02: {
        const value = s7_ut16(buffer, off + 1);
        return { assembly: `+AR1 P#${value & 0xFFF}.${value >> 12}`, size: 4 };
      }
      case 0x0A: {
        const value = s7_ut16(buffer, off + 1);
        return { assembly: `+AR2 P#${value & 0xFFF}.${value >> 12}`, size: 4 };
      }
      case 0x33: { const v = s7_ut16(buffer, off + 1); return { assembly: `LAR1 MD ${v}`, size: 4 }; }
      case 0x37: { const v = s7_ut16(buffer, off + 1); return { assembly: `TAR1 MD ${v}`, size: 4 }; }
      case 0x3B: { const v = s7_ut16(buffer, off + 1); return { assembly: `LAR2 MD ${v}`, size: 4 }; }
      case 0x3F: { const v = s7_ut16(buffer, off + 1); return { assembly: `TAR2 MD ${v}`, size: 4 }; }
      case 0x43: { const v = s7_ut16(buffer, off + 1); return { assembly: `LAR1 DBD ${v}`, size: 4 }; }
      case 0x47: { const v = s7_ut16(buffer, off + 1); return { assembly: `TAR1 DBD ${v}`, size: 4 }; }
      case 0x4B: { const v = s7_ut16(buffer, off + 1); return { assembly: `LAR2 DBD ${v}`, size: 4 }; }
      case 0x4F: { const v = s7_ut16(buffer, off + 1); return { assembly: `TAR2 DBD ${v}`, size: 4 }; }
      case 0x53: { const v = s7_ut16(buffer, off + 1); return { assembly: `LAR1 DID ${v}`, size: 4 }; }
      case 0x57: { const v = s7_ut16(buffer, off + 1); return { assembly: `TAR1 DID ${v}`, size: 4 }; }
      case 0x5B: { const v = s7_ut16(buffer, off + 1); return { assembly: `LAR2 DID ${v}`, size: 4 }; }
      case 0x5F: { const v = s7_ut16(buffer, off + 1); return { assembly: `TAR2 DID ${v}`, size: 4 }; }
      case 0x63: { const v = s7_ut16(buffer, off + 1); return { assembly: `LAR1 LD ${v}`, size: 4 }; }
      case 0x67: { const v = s7_ut16(buffer, off + 1); return { assembly: `TAR1 LD ${v}`, size: 4 }; }
      case 0x6B: { const v = s7_ut16(buffer, off + 1); return { assembly: `LAR2 LD ${v}`, size: 4 }; }
      case 0x6F: { const v = s7_ut16(buffer, off + 1); return { assembly: `TAR2 LD ${v}`, size: 4 }; }
      default: break;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// s7_decode_FF  (status bits, brackets, jumps)
// ---------------------------------------------------------------------------

function s7_decode_FF(addr, buffer, off, size) {
  switch (buffer[off]) {
    // Status bit tests: A/AN/O/ON/X/XN for OS, OV, >0, <0, UO, <>0, ==0, >=0, <=0, BR
    case 0x00: return { assembly: 'A OS', size: 2 };
    case 0x01: return { assembly: 'AN OS', size: 2 };
    case 0x02: return { assembly: 'O OS', size: 2 };
    case 0x03: return { assembly: 'ON OS', size: 2 };
    case 0x04: return { assembly: 'X OS', size: 2 };
    case 0x05: return { assembly: 'XN OS', size: 2 };
    case 0x10: return { assembly: 'A OV', size: 2 };
    case 0x11: return { assembly: 'AN OV', size: 2 };
    case 0x12: return { assembly: 'O OV', size: 2 };
    case 0x13: return { assembly: 'ON OV', size: 2 };
    case 0x14: return { assembly: 'X OV', size: 2 };
    case 0x15: return { assembly: 'XN OV', size: 2 };
    case 0x20: return { assembly: 'A >0', size: 2 };
    case 0x21: return { assembly: 'AN >0', size: 2 };
    case 0x22: return { assembly: 'O >0', size: 2 };
    case 0x23: return { assembly: 'ON >0', size: 2 };
    case 0x24: return { assembly: 'X >0', size: 2 };
    case 0x25: return { assembly: 'XN >0', size: 2 };
    case 0x40: return { assembly: 'A <0', size: 2 };
    case 0x41: return { assembly: 'AN <0', size: 2 };
    case 0x42: return { assembly: 'O <0', size: 2 };
    case 0x43: return { assembly: 'ON <0', size: 2 };
    case 0x44: return { assembly: 'X <0', size: 2 };
    case 0x45: return { assembly: 'XN <0', size: 2 };
    case 0x50: return { assembly: 'A UO', size: 2 };
    case 0x51: return { assembly: 'AN UO', size: 2 };
    case 0x52: return { assembly: 'O UO', size: 2 };
    case 0x53: return { assembly: 'ON UO', size: 2 };
    case 0x54: return { assembly: 'X UO', size: 2 };
    case 0x55: return { assembly: 'XN UO', size: 2 };
    case 0x60: return { assembly: 'A <>0', size: 2 };
    case 0x61: return { assembly: 'AN <>0', size: 2 };
    case 0x62: return { assembly: 'O <>0', size: 2 };
    case 0x63: return { assembly: 'ON <>0', size: 2 };
    case 0x64: return { assembly: 'X <>0', size: 2 };
    case 0x65: return { assembly: 'XN <>0', size: 2 };
    case 0x80: return { assembly: 'A ==0', size: 2 };
    case 0x81: return { assembly: 'AN ==0', size: 2 };
    case 0x82: return { assembly: 'O ==0', size: 2 };
    case 0x83: return { assembly: 'ON ==0', size: 2 };
    case 0x84: return { assembly: 'X ==0', size: 2 };
    case 0x85: return { assembly: 'XN ==0', size: 2 };
    case 0xA0: return { assembly: 'A >=0', size: 2 };
    case 0xA1: return { assembly: 'AN >=0', size: 2 };
    case 0xA2: return { assembly: 'O >=0', size: 2 };
    case 0xA3: return { assembly: 'ON >=0', size: 2 };
    case 0xA4: return { assembly: 'X >=0', size: 2 };
    case 0xA5: return { assembly: 'XN >=0', size: 2 };
    case 0xC0: return { assembly: 'A <=0', size: 2 };
    case 0xC1: return { assembly: 'AN <=0', size: 2 };
    case 0xC2: return { assembly: 'O <=0', size: 2 };
    case 0xC3: return { assembly: 'ON <=0', size: 2 };
    case 0xC4: return { assembly: 'X <=0', size: 2 };
    case 0xC5: return { assembly: 'XN <=0', size: 2 };
    case 0xE0: return { assembly: 'A BR', size: 2 };
    case 0xE1: return { assembly: 'AN BR', size: 2 };
    case 0xE2: return { assembly: 'O BR', size: 2 };
    case 0xE3: return { assembly: 'ON BR', size: 2 };
    case 0xE4: return { assembly: 'X BR', size: 2 };
    case 0xE5: return { assembly: 'XN BR', size: 2 };
    // Brackets
    case 0xF1: return { assembly: 'AN(', size: 2 };
    case 0xF3: return { assembly: 'ON(', size: 2 };
    case 0xF4: return { assembly: 'X(', size: 2 };
    case 0xF5: return { assembly: 'XN(', size: 2 };
    case 0xFF: return { assembly: 'NOP 1', size: 2 };
    default: break;
  }
  // Jump instructions (4 bytes)
  if (size > 2) {
    const value = toS16(s7_ut16(buffer, off + 1));
    const target = addr + value;
    switch (buffer[off]) {
      case 0x08: return { assembly: `JOS 0x${target.toString(16)}`, size: 4, jump: target };
      case 0x18: return { assembly: `JO 0x${target.toString(16)}`, size: 4, jump: target };
      case 0x28: return { assembly: `JP 0x${target.toString(16)}`, size: 4, jump: target };
      case 0x48: return { assembly: `JM 0x${target.toString(16)}`, size: 4, jump: target };
      case 0x58: return { assembly: `JUO 0x${target.toString(16)}`, size: 4, jump: target };
      case 0x68: return { assembly: `JN 0x${target.toString(16)}`, size: 4, jump: target };
      case 0x78: return { assembly: `JNBI 0x${target.toString(16)}`, size: 4, jump: target };
      case 0x88: return { assembly: `JZ 0x${target.toString(16)}`, size: 4, jump: target };
      case 0x98: return { assembly: `JNB 0x${target.toString(16)}`, size: 4, jump: target };
      case 0xA8: return { assembly: `JPZ 0x${target.toString(16)}`, size: 4, jump: target };
      case 0xB8: return { assembly: `JCN 0x${target.toString(16)}`, size: 4, jump: target };
      case 0xC8: return { assembly: `JMZ 0x${target.toString(16)}`, size: 4, jump: target };
      case 0xD8: return { assembly: `JCB 0x${target.toString(16)}`, size: 4, jump: target };
      case 0xE8: return { assembly: `JBI 0x${target.toString(16)}`, size: 4, jump: target };
      case 0xF8: return { assembly: `JC 0x${target.toString(16)}`, size: 4, jump: target };
      default: return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// s7_decode_200A  (direct DB addressing with complex operations)
// ---------------------------------------------------------------------------

function s7_decode_200A(buffer, off, size) {
  if (size < 5) return null;
  const db = buffer[off];
  switch (buffer[off + 1]) {
    case 0x05:
      switch (buffer[off + 2] & 0xF0) {
        case 0xC0: {
          const n = buffer[off + 2] & 0x0F;
          const value = s7_ut16(buffer, off + 3);
          return { assembly: `XN DB${db}.DBX ${value}.${n}`, size: 6 };
        }
        default: return null;
      }
    case 0xFE:
      switch (buffer[off + 2]) {
        case 0x33: { const v = s7_ut16(buffer, off + 3); return { assembly: `LAR1 DB${db}.MD ${v}`, size: 6 }; }
        case 0x37: { const v = s7_ut16(buffer, off + 3); return { assembly: `TAR1 DB${db}.MD ${v}`, size: 6 }; }
        case 0x3B: { const v = s7_ut16(buffer, off + 3); return { assembly: `LAR2 DB${db}.MD ${v}`, size: 6 }; }
        case 0x3F: { const v = s7_ut16(buffer, off + 3); return { assembly: `TAR2 DB${db}.MD ${v}`, size: 6 }; }
        case 0x43: { const v = s7_ut16(buffer, off + 3); return { assembly: `LAR1 DB${db}.DBD ${v}`, size: 6 }; }
        case 0x47: { const v = s7_ut16(buffer, off + 3); return { assembly: `TAR1 DB${db}.DBD ${v}`, size: 6 }; }
        case 0x4B: { const v = s7_ut16(buffer, off + 3); return { assembly: `LAR2 DB${db}.DBD ${v}`, size: 6 }; }
        case 0x4F: { const v = s7_ut16(buffer, off + 3); return { assembly: `TAR2 DB${db}.DBD ${v}`, size: 6 }; }
        case 0x53: { const v = s7_ut16(buffer, off + 3); return { assembly: `LAR1 DB${db}.DID ${v}`, size: 6 }; }
        case 0x57: { const v = s7_ut16(buffer, off + 3); return { assembly: `TAR1 DB${db}.DID ${v}`, size: 6 }; }
        case 0x5B: { const v = s7_ut16(buffer, off + 3); return { assembly: `LAR2 DB${db}.DID ${v}`, size: 6 }; }
        case 0x5F: { const v = s7_ut16(buffer, off + 3); return { assembly: `TAR2 DB${db}.DID ${v}`, size: 6 }; }
        case 0x63: { const v = s7_ut16(buffer, off + 3); return { assembly: `LAR1 DB${db}.LD ${v}`, size: 6 }; }
        case 0x67: { const v = s7_ut16(buffer, off + 3); return { assembly: `TAR1 DB${db}.LD ${v}`, size: 6 }; }
        case 0x6B: { const v = s7_ut16(buffer, off + 3); return { assembly: `LAR2 DB${db}.LD ${v}`, size: 6 }; }
        case 0x6F: { const v = s7_ut16(buffer, off + 3); return { assembly: `TAR2 DB${db}.LD ${v}`, size: 6 }; }
        default: return null;
      }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Main decoder: simatic_s7_decode_instruction
// ---------------------------------------------------------------------------

function decodeInstruction(buffer, offset, size, addr) {
  if (!buffer || size < 2) {
    return null;
  }

  let result = null;
  let isReturn = false;

  // off = offset into the original buffer. Sub-decoders receive off+1 and size-1.
  const b0 = buffer[offset];
  const off1 = offset + 1;
  const sz1 = size - 1;

  switch (b0) {
    case 0x00: result = s7_decode_bitlogic('NOP 0', 'A', 'AN', buffer, off1, sz1); break;
    case 0x01: result = s7_decode_bitlogic('INVI', 'O', 'ON', buffer, off1, sz1); break;
    case 0x02: result = s7_decode_byte('L', 'T ', buffer, off1, sz1); break;
    case 0x04: result = s7_decode_byte('FR', 'T ', buffer, off1, sz1); break;
    case 0x05: result = s7_decode_bitlogic('BEC', 'X', 'XN', buffer, off1, sz1); break;
    case 0x09: result = s7_decode_bitlogic('NEGI', 'S', 'R', buffer, off1, sz1); break;
    case 0x0A: result = s7_decode_byte('L', 'MB ', buffer, off1, sz1); break;
    case 0x0B: result = s7_decode_byte('T', 'MB ', buffer, off1, sz1); break;
    case 0x0C: result = s7_decode_byte('LC', 'T ', buffer, off1, sz1); break;
    case 0x10:
      result = s7_decode_byte('BLD', '', buffer, off1, sz1);
      if (result) isReturn = true;
      break;
    case 0x11: result = s7_decode_byte('INC', '', buffer, off1, sz1); break;
    case 0x12: result = s7_decode_byte('L', 'MW ', buffer, off1, sz1); break;
    case 0x13: result = s7_decode_byte('T', 'MW ', buffer, off1, sz1); break;
    case 0x14: result = s7_decode_byte('SF', 'T ', buffer, off1, sz1); break;
    case 0x19: result = s7_decode_byte('DEC', '', buffer, off1, sz1); break;
    case 0x1A: result = s7_decode_byte('L', 'MD ', buffer, off1, sz1); break;
    case 0x1B: result = s7_decode_byte('T', 'MD ', buffer, off1, sz1); break;
    case 0x1C: result = s7_decode_byte('SE', 'T ', buffer, off1, sz1); break;
    case 0x1D: result = s7_decode_byte('CC', 'FC ', buffer, off1, sz1); break;
    case 0x20:
      if (buffer[off1] === 0x0A) {
        result = s7_decode_200A(buffer, off1, sz1);
      } else {
        result = s7_decode_byte('OPN', 'DB ', buffer, off1, sz1);
      }
      break;
    case 0x21: result = s7_decode_cmp('I', buffer, off1, sz1); break;
    case 0x24: result = s7_decode_byte('SD', 'T ', buffer, off1, sz1); break;
    case 0x28: result = s7_decode_byte('L', 'B#16#', buffer, off1, sz1); break;
    case 0x29:
      if (buffer[off1] < 0x10) {
        result = s7_decode_byte('SLD', '', buffer, off1, sz1);
      }
      break;
    case 0x2C: result = s7_decode_byte('SS', 'T ', buffer, off1, sz1); break;
    case 0x30: result = s7_decode_lit16(buffer, off1, sz1); break;
    case 0x31: result = s7_decode_cmp('R', buffer, off1, sz1); break;
    case 0x34: result = s7_decode_byte('SP', 'T ', buffer, off1, sz1); break;
    case 0x38: result = s7_decode_lit32(buffer, off1, sz1); break;
    case 0x39: result = s7_decode_cmp('D', buffer, off1, sz1); break;
    case 0x3C: result = s7_decode_byte('R', 'T ', buffer, off1, sz1); break;
    case 0x3D: result = s7_decode_byte('UC', 'FC ', buffer, off1, sz1); break;
    case 0x41: result = s7_decode_bitlogic('AW', '=', null, buffer, off1, sz1); break;
    case 0x42: result = s7_decode_byte('L', 'C ', buffer, off1, sz1); break;
    case 0x44: result = s7_decode_byte('FR', 'C ', buffer, off1, sz1); break;
    case 0x49: result = s7_decode_bitlogic('OW', 'FP', 'FN', buffer, off1, sz1); break;
    case 0x4A: result = s7_decode_byte_signed('L', 'IB', 'QB', '', buffer, off1, sz1); break;
    case 0x4B: result = s7_decode_byte_signed('T', 'IB', 'QB', '', buffer, off1, sz1); break;
    case 0x4C: result = s7_decode_byte('LC', 'C ', buffer, off1, sz1); break;
    case 0x51: result = s7_decode_bitlogic_mem('XOW', false, 'A', 'O', 'AN', 'ON', buffer, off1, sz1); break;
    case 0x52: result = s7_decode_byte_signed('L', 'IW', 'QW', '', buffer, off1, sz1); break;
    case 0x53: result = s7_decode_byte_signed('T', 'IW', 'QW', '', buffer, off1, sz1); break;
    case 0x54: result = s7_decode_byte('CD', 'C ', buffer, off1, sz1); break;
    case 0x55: result = s7_decode_byte('CC', 'FB ', buffer, off1, sz1); break;
    case 0x58: result = s7_decode_bitlogic_mem('+', true, 'X', 'S', 'XN', 'R', buffer, off1, sz1); break;
    case 0x59: result = s7_decode_bitlogic_mem('-I', false, '=', 'FP', null, 'FN', buffer, off1, sz1); break;
    case 0x5A: result = s7_decode_byte_signed('L', 'ID', 'QD', '', buffer, off1, sz1); break;
    case 0x5B: result = s7_decode_byte_signed('T', 'ID', 'QD', '', buffer, off1, sz1); break;
    case 0x5C: result = s7_decode_byte('S', 'C ', buffer, off1, sz1); break;
    case 0x60:
      if (buffer[off1] === 0x05 && size > 5) {
        const value = toS32(s7_ut32(buffer, offset + 2));
        result = { assembly: `+ L#${value}`, size: 6 };
      } else {
        const ops = [
          { byte: 0x00, op: '/I' },
          { byte: 0x01, op: 'MOD' },
          { byte: 0x02, op: 'ABS' },
          { byte: 0x03, op: '/R' },
          { byte: 0x04, op: '*I' },
          { byte: 0x06, op: 'NEGR' },
          { byte: 0x07, op: '*R' },
          { byte: 0x08, op: 'ENT' },
          { byte: 0x09, op: '-D' },
          { byte: 0x0A, op: '*D' },
          { byte: 0x0B, op: '-R' },
          { byte: 0x0D, op: '+D' },
          { byte: 0x0E, op: '/D' },
          { byte: 0x0F, op: '+R' },
          { byte: 0x10, op: 'SIN' },
          { byte: 0x11, op: 'COS' },
          { byte: 0x12, op: 'TAN' },
          { byte: 0x13, op: 'LN' },
          { byte: 0x14, op: 'SQRT' },
          { byte: 0x18, op: 'ASIN' },
          { byte: 0x19, op: 'ACOS' },
          { byte: 0x1A, op: 'ATAN' },
          { byte: 0x1B, op: 'EXP' },
          { byte: 0x1C, op: 'SQR' },
        ];
        result = s7_decode_static(ops, buffer, off1, sz1);
      }
      break;
    case 0x61:
      if (buffer[off1] < 0x10) {
        result = s7_decode_4bit('SLW', false, buffer, off1, sz1);
      }
      break;
    case 0x64:
      if (buffer[off1] <= 32) {
        result = s7_decode_byte('RLD', '', buffer, off1, sz1);
      }
      break;
    case 0x65: {
      const ops = [
        { byte: 0x00, op: 'BE' },
        { byte: 0x01, op: 'BEU' },
      ];
      result = s7_decode_static(ops, buffer, off1, sz1);
      if (result) isReturn = true;
      break;
    }
    case 0x68: {
      // Try 32-bit immediate operations first (need 6 bytes)
      if (size > 5) {
        const value32 = s7_ut32(buffer, offset + 2);
        switch (buffer[off1]) {
          case 0x36: result = { assembly: `AD DW#16#${value32.toString(16)}`, size: 6 }; break;
          case 0x46: result = { assembly: `OD DW#16#${value32.toString(16)}`, size: 6 }; break;
          case 0x56: result = { assembly: `XOD DW#16#${value32.toString(16)}`, size: 6 }; break;
          default: break;
        }
      }
      // Try 16-bit immediate operations (need 4 bytes)
      if (!result && size > 3) {
        const value16 = s7_ut16(buffer, offset + 2);
        switch (buffer[off1]) {
          case 0x34: result = { assembly: `AW W#16#${value16.toString(16)}`, size: 4 }; break;
          case 0x44: result = { assembly: `OW W#16#${value16.toString(16)}`, size: 4 }; break;
          case 0x54: result = { assembly: `XOW W#16#${value16.toString(16)}`, size: 4 }; break;
          default: break;
        }
      }
      // SSI with high nibble
      if (!result && (buffer[off1] & 0x0F) === 0x01) {
        result = s7_decode_4bit('SSI', true, buffer, off1, sz1);
      }
      // Static conversion/logic opcodes
      if (!result) {
        const ops = [
          { byte: 0x06, op: 'DTR' },
          { byte: 0x07, op: 'NEGD' },
          { byte: 0x08, op: 'ITB' },
          { byte: 0x0A, op: 'DTB' },
          { byte: 0x0C, op: 'BTI' },
          { byte: 0x0E, op: 'BTD' },
          { byte: 0x0D, op: 'INVD' },
          { byte: 0x12, op: 'SLW' },
          { byte: 0x13, op: 'SLD' },
          { byte: 0x17, op: 'RLD' },
          { byte: 0x18, op: 'RLDA' },
          { byte: 0x1A, op: 'CAW' },
          { byte: 0x1B, op: 'CAD' },
          { byte: 0x1C, op: 'CLR' },
          { byte: 0x1D, op: 'SET' },
          { byte: 0x1E, op: 'ITD' },
          { byte: 0x22, op: 'SRW' },
          { byte: 0x23, op: 'SRD' },
          { byte: 0x24, op: 'SSI' },
          { byte: 0x25, op: 'SSD' },
          { byte: 0x27, op: 'RRD' },
          { byte: 0x28, op: 'RRDA' },
          { byte: 0x2C, op: 'SAVE' },
          { byte: 0x2D, op: 'NOT' },
          { byte: 0x2E, op: 'PUSH' },
          { byte: 0x37, op: 'AD' },
          { byte: 0x3A, op: 'MCRA' },
          { byte: 0x3B, op: 'MCRD' },
          { byte: 0x3C, op: 'MCR(' },
          { byte: 0x3D, op: ')MCR' },
          { byte: 0x3E, op: 'POP' },
          { byte: 0x47, op: 'OD' },
          { byte: 0x4E, op: 'LEAVE' },
          { byte: 0x57, op: 'XOD' },
          { byte: 0x5C, op: 'RND' },
          { byte: 0x5D, op: 'RND-' },
          { byte: 0x5E, op: 'RND+' },
          { byte: 0x5F, op: 'TRUNC' },
        ];
        result = s7_decode_static(ops, buffer, off1, sz1);
      }
      break;
    }
    case 0x69:
      if (buffer[off1] < 0x10) {
        result = s7_decode_4bit('SRW', false, buffer, off1, sz1);
      }
      break;
    case 0x6C: result = s7_decode_byte('CU', 'C ', buffer, off1, sz1); break;
    case 0x70:
      if (buffer[off1] === 0x08) {
        result = s7_decode_jump('LOOP', addr, buffer, off1, sz1);
      } else if (buffer[off1] === 0x09) {
        result = s7_decode_jump('JL', addr, buffer, off1, sz1);
      } else if (buffer[off1] === 0x0B) {
        result = s7_decode_jump('JU', addr, buffer, off1, sz1);
      } else {
        const ops = [
          { byte: 0x02, op: 'TAK' },
          { byte: 0x06, op: 'L STW' },
          { byte: 0x07, op: 'T STW' },
        ];
        result = s7_decode_static(ops, buffer, off1, sz1);
      }
      break;
    case 0x71:
      if (buffer[off1] < 0x10) {
        result = s7_decode_4bit('SSD', false, buffer, off1, sz1);
      }
      break;
    case 0x74: result = s7_decode_byte('RRD', '', buffer, off1, sz1); break;
    case 0x75: result = s7_decode_byte('UC', 'FB ', buffer, off1, sz1); break;
    case 0x79: result = s7_decode_79(buffer, off1, sz1); break;
    case 0x7C: result = s7_decode_byte('R', 'C ', buffer, off1, sz1); break;
    case 0x7E: result = s7_decode_7E(buffer, off1, sz1); break;
    // 0x80-0x87: A M x.0 - A M x.7
    case 0x80: result = s7_decode_byte_s('A M', '.0', buffer, off1, sz1); break;
    case 0x81: result = s7_decode_byte_s('A M', '.1', buffer, off1, sz1); break;
    case 0x82: result = s7_decode_byte_s('A M', '.2', buffer, off1, sz1); break;
    case 0x83: result = s7_decode_byte_s('A M', '.3', buffer, off1, sz1); break;
    case 0x84: result = s7_decode_byte_s('A M', '.4', buffer, off1, sz1); break;
    case 0x85: result = s7_decode_byte_s('A M', '.5', buffer, off1, sz1); break;
    case 0x86: result = s7_decode_byte_s('A M', '.6', buffer, off1, sz1); break;
    case 0x87: result = s7_decode_byte_s('A M', '.7', buffer, off1, sz1); break;
    // 0x88-0x8F: O M x.0 - O M x.7
    case 0x88: result = s7_decode_byte_s('O M', '.0', buffer, off1, sz1); break;
    case 0x89: result = s7_decode_byte_s('O M', '.1', buffer, off1, sz1); break;
    case 0x8A: result = s7_decode_byte_s('O M', '.2', buffer, off1, sz1); break;
    case 0x8B: result = s7_decode_byte_s('O M', '.3', buffer, off1, sz1); break;
    case 0x8C: result = s7_decode_byte_s('O M', '.4', buffer, off1, sz1); break;
    case 0x8D: result = s7_decode_byte_s('O M', '.5', buffer, off1, sz1); break;
    case 0x8E: result = s7_decode_byte_s('O M', '.6', buffer, off1, sz1); break;
    case 0x8F: result = s7_decode_byte_s('O M', '.7', buffer, off1, sz1); break;
    // 0x90-0x97: S M x.0 - S M x.7
    case 0x90: result = s7_decode_byte_s('S M', '.0', buffer, off1, sz1); break;
    case 0x91: result = s7_decode_byte_s('S M', '.1', buffer, off1, sz1); break;
    case 0x92: result = s7_decode_byte_s('S M', '.2', buffer, off1, sz1); break;
    case 0x93: result = s7_decode_byte_s('S M', '.3', buffer, off1, sz1); break;
    case 0x94: result = s7_decode_byte_s('S M', '.4', buffer, off1, sz1); break;
    case 0x95: result = s7_decode_byte_s('S M', '.5', buffer, off1, sz1); break;
    case 0x96: result = s7_decode_byte_s('S M', '.6', buffer, off1, sz1); break;
    case 0x97: result = s7_decode_byte_s('S M', '.7', buffer, off1, sz1); break;
    // 0x98-0x9F: = M x.0 - = M x.7
    case 0x98: result = s7_decode_byte_s('= M', '.0', buffer, off1, sz1); break;
    case 0x99: result = s7_decode_byte_s('= M', '.1', buffer, off1, sz1); break;
    case 0x9A: result = s7_decode_byte_s('= M', '.2', buffer, off1, sz1); break;
    case 0x9B: result = s7_decode_byte_s('= M', '.3', buffer, off1, sz1); break;
    case 0x9C: result = s7_decode_byte_s('= M', '.4', buffer, off1, sz1); break;
    case 0x9D: result = s7_decode_byte_s('= M', '.5', buffer, off1, sz1); break;
    case 0x9E: result = s7_decode_byte_s('= M', '.6', buffer, off1, sz1); break;
    case 0x9F: result = s7_decode_byte_s('= M', '.7', buffer, off1, sz1); break;
    // 0xA0-0xA7: AN M x.0 - AN M x.7
    case 0xA0: result = s7_decode_byte_s('AN M', '.0', buffer, off1, sz1); break;
    case 0xA1: result = s7_decode_byte_s('AN M', '.1', buffer, off1, sz1); break;
    case 0xA2: result = s7_decode_byte_s('AN M', '.2', buffer, off1, sz1); break;
    case 0xA3: result = s7_decode_byte_s('AN M', '.3', buffer, off1, sz1); break;
    case 0xA4: result = s7_decode_byte_s('AN M', '.4', buffer, off1, sz1); break;
    case 0xA5: result = s7_decode_byte_s('AN M', '.5', buffer, off1, sz1); break;
    case 0xA6: result = s7_decode_byte_s('AN M', '.6', buffer, off1, sz1); break;
    case 0xA7: result = s7_decode_byte_s('AN M', '.7', buffer, off1, sz1); break;
    // 0xA8-0xAF: ON M x.0 - ON M x.7
    case 0xA8: result = s7_decode_byte_s('ON M', '.0', buffer, off1, sz1); break;
    case 0xA9: result = s7_decode_byte_s('ON M', '.1', buffer, off1, sz1); break;
    case 0xAA: result = s7_decode_byte_s('ON M', '.2', buffer, off1, sz1); break;
    case 0xAB: result = s7_decode_byte_s('ON M', '.3', buffer, off1, sz1); break;
    case 0xAC: result = s7_decode_byte_s('ON M', '.4', buffer, off1, sz1); break;
    case 0xAD: result = s7_decode_byte_s('ON M', '.5', buffer, off1, sz1); break;
    case 0xAE: result = s7_decode_byte_s('ON M', '.6', buffer, off1, sz1); break;
    case 0xAF: result = s7_decode_byte_s('ON M', '.7', buffer, off1, sz1); break;
    // 0xB0-0xB7: R M x.0 - R M x.7
    case 0xB0: result = s7_decode_byte_s('R M', '.0', buffer, off1, sz1); break;
    case 0xB1: result = s7_decode_byte_s('R M', '.1', buffer, off1, sz1); break;
    case 0xB2: result = s7_decode_byte_s('R M', '.2', buffer, off1, sz1); break;
    case 0xB3: result = s7_decode_byte_s('R M', '.3', buffer, off1, sz1); break;
    case 0xB4: result = s7_decode_byte_s('R M', '.4', buffer, off1, sz1); break;
    case 0xB5: result = s7_decode_byte_s('R M', '.5', buffer, off1, sz1); break;
    case 0xB6: result = s7_decode_byte_s('R M', '.6', buffer, off1, sz1); break;
    case 0xB7: result = s7_decode_byte_s('R M', '.7', buffer, off1, sz1); break;
    // Timer/Counter byte operations
    case 0xB8: result = s7_decode_byte('A', 'C ', buffer, off1, sz1); break;
    case 0xB9: result = s7_decode_byte('O', 'C ', buffer, off1, sz1); break;
    case 0xBA:
      if ((buffer[off1] > 0x66 && buffer[off1] < 0xB0) || buffer[off1] > 0xE6) {
        // invalid
      } else {
        result = s7_decode_mem('A(', 'L', 'T', types_b, types_b, buffer, off1, sz1);
      }
      break;
    case 0xBB: result = s7_decode_mem('O(', 'L', 'T', types_w, types_d, buffer, off1, sz1); break;
    case 0xBC: result = s7_decode_byte('AN', 'C ', buffer, off1, sz1); break;
    case 0xBD: result = s7_decode_byte('ON', 'C ', buffer, off1, sz1); break;
    case 0xBE: result = s7_decode_BE(buffer, off1, sz1); break;
    case 0xBF: result = s7_decode_BF(buffer, off1, sz1); break;
    // 0xC0-0xC7: A I/Q x.0 - A I/Q x.7
    case 0xC0: result = s7_decode_byte_signed('A', 'I', 'Q', '.0', buffer, off1, sz1); break;
    case 0xC1: result = s7_decode_byte_signed('A', 'I', 'Q', '.1', buffer, off1, sz1); break;
    case 0xC2: result = s7_decode_byte_signed('A', 'I', 'Q', '.2', buffer, off1, sz1); break;
    case 0xC3: result = s7_decode_byte_signed('A', 'I', 'Q', '.3', buffer, off1, sz1); break;
    case 0xC4: result = s7_decode_byte_signed('A', 'I', 'Q', '.4', buffer, off1, sz1); break;
    case 0xC5: result = s7_decode_byte_signed('A', 'I', 'Q', '.5', buffer, off1, sz1); break;
    case 0xC6: result = s7_decode_byte_signed('A', 'I', 'Q', '.6', buffer, off1, sz1); break;
    case 0xC7: result = s7_decode_byte_signed('A', 'I', 'Q', '.7', buffer, off1, sz1); break;
    // 0xC8-0xCF: O I/Q x.0 - O I/Q x.7
    case 0xC8: result = s7_decode_byte_signed('O', 'I', 'Q', '.0', buffer, off1, sz1); break;
    case 0xC9: result = s7_decode_byte_signed('O', 'I', 'Q', '.1', buffer, off1, sz1); break;
    case 0xCA: result = s7_decode_byte_signed('O', 'I', 'Q', '.2', buffer, off1, sz1); break;
    case 0xCB: result = s7_decode_byte_signed('O', 'I', 'Q', '.3', buffer, off1, sz1); break;
    case 0xCC: result = s7_decode_byte_signed('O', 'I', 'Q', '.4', buffer, off1, sz1); break;
    case 0xCD: result = s7_decode_byte_signed('O', 'I', 'Q', '.5', buffer, off1, sz1); break;
    case 0xCE: result = s7_decode_byte_signed('O', 'I', 'Q', '.6', buffer, off1, sz1); break;
    case 0xCF: result = s7_decode_byte_signed('O', 'I', 'Q', '.7', buffer, off1, sz1); break;
    // 0xD0-0xD7: S I/Q x.0 - S I/Q x.7
    case 0xD0: result = s7_decode_byte_signed('S', 'I', 'Q', '.0', buffer, off1, sz1); break;
    case 0xD1: result = s7_decode_byte_signed('S', 'I', 'Q', '.1', buffer, off1, sz1); break;
    case 0xD2: result = s7_decode_byte_signed('S', 'I', 'Q', '.2', buffer, off1, sz1); break;
    case 0xD3: result = s7_decode_byte_signed('S', 'I', 'Q', '.3', buffer, off1, sz1); break;
    case 0xD4: result = s7_decode_byte_signed('S', 'I', 'Q', '.4', buffer, off1, sz1); break;
    case 0xD5: result = s7_decode_byte_signed('S', 'I', 'Q', '.5', buffer, off1, sz1); break;
    case 0xD6: result = s7_decode_byte_signed('S', 'I', 'Q', '.6', buffer, off1, sz1); break;
    case 0xD7: result = s7_decode_byte_signed('S', 'I', 'Q', '.7', buffer, off1, sz1); break;
    // 0xD8-0xDF: = I/Q x.0 - = I/Q x.7
    case 0xD8: result = s7_decode_byte_signed('=', 'I', 'Q', '.0', buffer, off1, sz1); break;
    case 0xD9: result = s7_decode_byte_signed('=', 'I', 'Q', '.1', buffer, off1, sz1); break;
    case 0xDA: result = s7_decode_byte_signed('=', 'I', 'Q', '.2', buffer, off1, sz1); break;
    case 0xDB: result = s7_decode_byte_signed('=', 'I', 'Q', '.3', buffer, off1, sz1); break;
    case 0xDC: result = s7_decode_byte_signed('=', 'I', 'Q', '.4', buffer, off1, sz1); break;
    case 0xDD: result = s7_decode_byte_signed('=', 'I', 'Q', '.5', buffer, off1, sz1); break;
    case 0xDE: result = s7_decode_byte_signed('=', 'I', 'Q', '.6', buffer, off1, sz1); break;
    case 0xDF: result = s7_decode_byte_signed('=', 'I', 'Q', '.7', buffer, off1, sz1); break;
    // 0xE0-0xE7: AN I/Q x.0 - AN I/Q x.7
    case 0xE0: result = s7_decode_byte_signed('AN', 'I', 'Q', '.0', buffer, off1, sz1); break;
    case 0xE1: result = s7_decode_byte_signed('AN', 'I', 'Q', '.1', buffer, off1, sz1); break;
    case 0xE2: result = s7_decode_byte_signed('AN', 'I', 'Q', '.2', buffer, off1, sz1); break;
    case 0xE3: result = s7_decode_byte_signed('AN', 'I', 'Q', '.3', buffer, off1, sz1); break;
    case 0xE4: result = s7_decode_byte_signed('AN', 'I', 'Q', '.4', buffer, off1, sz1); break;
    case 0xE5: result = s7_decode_byte_signed('AN', 'I', 'Q', '.5', buffer, off1, sz1); break;
    case 0xE6: result = s7_decode_byte_signed('AN', 'I', 'Q', '.6', buffer, off1, sz1); break;
    case 0xE7: result = s7_decode_byte_signed('AN', 'I', 'Q', '.7', buffer, off1, sz1); break;
    // 0xE8-0xEF: ON I/Q x.0 - ON I/Q x.7
    case 0xE8: result = s7_decode_byte_signed('ON', 'I', 'Q', '.0', buffer, off1, sz1); break;
    case 0xE9: result = s7_decode_byte_signed('ON', 'I', 'Q', '.1', buffer, off1, sz1); break;
    case 0xEA: result = s7_decode_byte_signed('ON', 'I', 'Q', '.2', buffer, off1, sz1); break;
    case 0xEB: result = s7_decode_byte_signed('ON', 'I', 'Q', '.3', buffer, off1, sz1); break;
    case 0xEC: result = s7_decode_byte_signed('ON', 'I', 'Q', '.4', buffer, off1, sz1); break;
    case 0xED: result = s7_decode_byte_signed('ON', 'I', 'Q', '.5', buffer, off1, sz1); break;
    case 0xEE: result = s7_decode_byte_signed('ON', 'I', 'Q', '.6', buffer, off1, sz1); break;
    case 0xEF: result = s7_decode_byte_signed('ON', 'I', 'Q', '.7', buffer, off1, sz1); break;
    // 0xF0-0xF7: R I/Q x.0 - R I/Q x.7
    case 0xF0: result = s7_decode_byte_signed('R', 'I', 'Q', '.0', buffer, off1, sz1); break;
    case 0xF1: result = s7_decode_byte_signed('R', 'I', 'Q', '.1', buffer, off1, sz1); break;
    case 0xF2: result = s7_decode_byte_signed('R', 'I', 'Q', '.2', buffer, off1, sz1); break;
    case 0xF3: result = s7_decode_byte_signed('R', 'I', 'Q', '.3', buffer, off1, sz1); break;
    case 0xF4: result = s7_decode_byte_signed('R', 'I', 'Q', '.4', buffer, off1, sz1); break;
    case 0xF5: result = s7_decode_byte_signed('R', 'I', 'Q', '.5', buffer, off1, sz1); break;
    case 0xF6: result = s7_decode_byte_signed('R', 'I', 'Q', '.6', buffer, off1, sz1); break;
    case 0xF7: result = s7_decode_byte_signed('R', 'I', 'Q', '.7', buffer, off1, sz1); break;
    // Timer byte ops
    case 0xF8: result = s7_decode_byte('A', 'T ', buffer, off1, sz1); break;
    case 0xF9: result = s7_decode_byte('O', 'T ', buffer, off1, sz1); break;
    case 0xFB: result = s7_decode_FB(buffer, off1, sz1); break;
    case 0xFC: result = s7_decode_byte('AN', 'T ', buffer, off1, sz1); break;
    case 0xFD: result = s7_decode_byte('ON', 'T ', buffer, off1, sz1); break;
    case 0xFE: result = s7_decode_FE(buffer, off1, sz1); break;
    case 0xFF: result = s7_decode_FF(addr, buffer, off1, sz1); break;
    default: break;
  }

  if (!result) {
    return { assembly: 'invalid', size: 2, jump: S7_INVALID_JUMP, isReturn: false };
  }

  // The sub-decoders return sizes relative to their view (buffer+1).
  // The actual instruction size equals the returned size (they already account for the opcode byte).
  return {
    assembly: result.assembly,
    size: result.size,
    jump: (result.jump !== undefined) ? result.jump : S7_INVALID_JUMP,
    isReturn: isReturn,
  };
}

// ---------------------------------------------------------------------------
// Public API: decodeMC7
// ---------------------------------------------------------------------------

/**
 * Decode MC7 bytecode buffer into an array of instructions.
 * @param {Buffer|Uint8Array} buffer - The raw MC7 bytecode
 * @param {number} codeLength - Number of bytes to decode (may be <= buffer.length)
 * @returns {Array<{assembly: string, size: number, offset: number, jump: number|null}>}
 */
function decodeMC7(buffer, codeLength) {
  const instructions = [];
  let offset = 0;
  const len = Math.min(codeLength, buffer.length);

  while (offset < len) {
    const remaining = len - offset;
    if (remaining < 2) {
      instructions.push({ assembly: 'invalid', size: 2, offset, jump: null });
      break;
    }

    const decoded = decodeInstruction(buffer, offset, remaining, offset);
    if (!decoded) {
      instructions.push({ assembly: 'invalid', size: 2, offset, jump: null });
      offset += 2;
      continue;
    }

    instructions.push({
      assembly: decoded.assembly,
      size: decoded.size,
      offset: offset,
      jump: decoded.jump === S7_INVALID_JUMP ? null : decoded.jump,
    });

    offset += decoded.size;
  }

  return instructions;
}

// ---------------------------------------------------------------------------
// mc7ToAwl  -  convert decoded instructions to readable AWL text
// ---------------------------------------------------------------------------

/**
 * Convert decoded MC7 instructions to readable AWL (STL) text.
 * Groups instructions by BLD network markers.
 * @param {Array<{assembly: string, size: number, offset: number, jump: number|null}>} instructions
 * @returns {string} AWL text
 */
function mc7ToAwl(instructions) {
  if (!instructions || instructions.length === 0) return '';

  const lines = [];
  let networkNumber = 0;

  for (const instr of instructions) {
    const asm = instr.assembly;

    // BLD marks the start of a new network
    if (asm.startsWith('BLD ')) {
      networkNumber++;
      lines.push('');
      lines.push(`Network ${networkNumber}:`);
      continue;
    }

    // Skip NOP 0 at the start
    if (asm === 'NOP 0' && lines.length === 0) continue;

    // Format the line with offset
    const offsetHex = instr.offset.toString(16).padStart(4, '0').toUpperCase();
    let line = `  ${offsetHex}: ${asm}`;

    // Annotate jump targets
    if (instr.jump !== null) {
      line += `  // -> 0x${instr.jump.toString(16)}`;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// extractLogicChains  -  virtual AWL interpreter
// ---------------------------------------------------------------------------

/**
 * Virtual AWL Interpreter – traces which outputs depend on which inputs.
 *
 * Simulates the S7 CPU execution model:
 *   - RLO stack (Result of Logic Operation) for bit logic
 *   - Akku1/Akku2 for word/dword operations
 *   - DB/DI register tracking for address resolution
 *   - Network boundaries (BLD) for chain separation
 *   - Local variable resolution (L x.x → tracks what was stored there)
 *
 * For each assignment (=, S, R, T), records:
 *   - The output address (resolved with current DB context)
 *   - All input addresses that contributed (resolved)
 *   - The AWL logic chain
 *   - Network number
 *
 * @param {Array<{assembly: string, size: number, offset: number}>} instructions
 * @returns {Array<{output: string, inputs: string[], logic: string[], network: number, startOffset: number, endOffset: number}>}
 */
function extractLogicChains(instructions) {
  if (!instructions || instructions.length === 0) return [];

  const chains = [];

  // ─── CPU State ───
  let currentDB = 0;      // Currently open DB (OPN DB xxx)
  let currentDI = 0;      // Currently open DI (OPN DI xxx / CALL FB,DB)
  let networkNum = 0;      // Current network number
  let rloInputs = [];      // Addresses that feed into the current RLO
  let rloLogic = [];       // AWL instructions in current RLO chain
  let akkuInputs = [];     // Addresses loaded into Akku1/Akku2
  let akkuLogic = [];      // AWL instructions for Akku operations
  let chainStart = 0;      // Offset where current chain started
  let localVars = {};      // L byte.bit → { sources: [], origin: 'instruction' }

  // Helper: resolve an operand address using current DB/DI context
  function resolveAddr(operand) {
    if (!operand) return operand;
    const trimmed = operand.trim();

    // DBX/DBW/DBD → prefix with current DB
    if (/^DBX\s/.test(trimmed) && currentDB) {
      return `DB${currentDB}.${trimmed.replace(/\s+/g, '')}`;
    }
    if (/^DB[WDB]\s/.test(trimmed) && currentDB) {
      return `DB${currentDB}.${trimmed.replace(/\s+/g, '')}`;
    }

    // DIX/DIW/DID → prefix with current DI
    if (/^DIX\s/.test(trimmed) && currentDI) {
      return `DB${currentDI}.DBX${trimmed.replace(/^DIX\s*/, '')}`;
    }
    if (/^DI[WDB]\s/.test(trimmed) && currentDI) {
      const size = trimmed[2]; // W, D, or B
      const addr = trimmed.replace(/^DI[WDB]\s*/, '');
      return `DB${currentDI}.DB${size}${addr}`;
    }

    // Indirect DIX [AR2, P#byte.bit] → DB<DI>.DBX<byte>.<bit>
    const dixAr2Match = trimmed.match(/^DIX\s*\[AR2,\s*P#(\d+)\.(\d+)\]/);
    if (dixAr2Match && currentDI) {
      return `DB${currentDI}.DBX${dixAr2Match[1]}.${dixAr2Match[2]}`;
    }
    // Indirect DIW/DID [AR2, P#byte.bit]
    const diwAr2Match = trimmed.match(/^DI([WDB])\s*\[AR2,\s*P#(\d+)\.\d+\]/);
    if (diwAr2Match && currentDI) {
      const sizeMap = { W: 'DBW', D: 'DBD', B: 'DBB' };
      return `DB${currentDI}.${sizeMap[diwAr2Match[1]] || 'DBW'}${diwAr2Match[2]}`;
    }

    // Indirect DBX [AR1/AR2, P#byte.bit] with current DB
    const dbxArMatch = trimmed.match(/^DBX\s*\[AR[12],\s*P#(\d+)\.(\d+)\]/);
    if (dbxArMatch && currentDB) {
      return `DB${currentDB}.DBX${dbxArMatch[1]}.${dbxArMatch[2]}`;
    }
    const dbwArMatch = trimmed.match(/^DB([WDB])\s*\[AR[12],\s*P#(\d+)\.\d+\]/);
    if (dbwArMatch && currentDB) {
      const sizeMap = { W: 'DBW', D: 'DBD', B: 'DBB' };
      return `DB${currentDB}.${sizeMap[dbwArMatch[1]] || 'DBW'}${dbwArMatch[2]}`;
    }

    // I/Q/M with space → compact
    if (/^[IQM]\s+\d/.test(trimmed)) {
      return trimmed.replace(/\s+/g, '');
    }

    return trimmed;
  }

  // Helper: check if operand is a real PLC address (not a constant/label)
  function isAddress(operand) {
    if (!operand) return false;
    const o = operand.trim();
    // Real addresses: I, Q, M, DB, DI, T, C, PEW, PAW, L
    return /^(DB\d|I\d|I\s|Q\d|Q\s|M\d|M\s|DI|T\s|T\d|C\s|C\d|PEW|PAW|L\s|L\d)/.test(o);
  }

  // Helper: emit a chain
  function emitChain(op, operand, offset) {
    const resolved = resolveAddr(operand);
    const allInputs = [...rloInputs, ...akkuInputs]
      .map(resolveAddr)
      .filter(a => a && isAddress(a));
    const uniqueInputs = [...new Set(allInputs)];

    if (uniqueInputs.length > 0 || op === 'T') {
      chains.push({
        output: resolved,
        inputs: uniqueInputs,
        logic: [...rloLogic, ...akkuLogic, `${op} ${resolved}`],
        network: networkNum,
        startOffset: chainStart,
        endOffset: offset,
      });
    }
  }

  // ─── Main interpreter loop ───
  for (const instr of instructions) {
    const asm = instr.assembly;
    if (asm === 'invalid' || asm.startsWith('invalid')) continue;

    const parts = asm.split(/\s+/);
    const op = parts[0];
    const operand = parts.slice(1).join(' ');

    // ─── Network boundary ───
    if (op === 'BLD') {
      // Save any pending chain state, then reset for new network
      networkNum++;
      rloInputs = [];
      rloLogic = [];
      akkuInputs = [];
      akkuLogic = [];
      chainStart = instr.offset;
      continue;
    }
    if (op === 'NOP') continue;

    // ─── DB context tracking ───
    if (op === 'OPN') {
      if (operand.startsWith('DB')) {
        const num = parseInt(operand.replace('DB', '').trim());
        if (!isNaN(num)) currentDB = num;
      } else if (operand.startsWith('DI')) {
        const num = parseInt(operand.replace('DI', '').trim());
        if (!isNaN(num)) currentDI = num;
      }
      rloLogic.push(asm);
      continue;
    }
    if (op === 'CDB') {
      // Swap DB and DI
      const tmp = currentDB;
      currentDB = currentDI;
      currentDI = tmp;
      rloLogic.push(asm);
      continue;
    }

    // ─── CALL tracking ───
    if (op === 'UC' || op === 'CC') {
      // UC FB xxx → the FB will use current DI
      // UC FC xxx → FC doesn't have instance DB
      rloLogic.push(asm);
      // Track the call as part of the chain
      if (operand.startsWith('FB') || operand.startsWith('FC')) {
        rloInputs.push(`CALL:${operand}`);
      }
      continue;
    }

    // ─── Bit logic: A, AN, O, ON, X, XN (inputs to RLO) ───
    if (['A', 'AN', 'O', 'ON', 'X', 'XN'].includes(op)) {
      if (rloInputs.length === 0) chainStart = instr.offset;
      rloInputs.push(operand);
      rloLogic.push(asm);
      continue;
    }

    // ─── Brackets ───
    if (['A(', 'AN(', 'O(', 'ON(', 'X(', 'XN(', ')'].includes(op)) {
      rloLogic.push(asm);
      continue;
    }

    // ─── Stack/RLO manipulation ───
    if (['CLR', 'SET', 'NOT', 'SAVE'].includes(op)) {
      rloLogic.push(asm);
      continue;
    }

    // ─── Edge detection: FP, FN ───
    if (op === 'FP' || op === 'FN') {
      rloInputs.push(operand);
      rloLogic.push(asm);
      continue;
    }

    // ─── Load into Akku: L ───
    if (op === 'L') {
      // Previous Akku1 → Akku2 (shift)
      akkuInputs.push(operand);
      akkuLogic.push(asm);
      continue;
    }

    // ─── Transfer from Akku: T ───
    if (op === 'T') {
      emitChain('T', operand, instr.offset);
      // Store in local var tracker if writing to L
      if (operand.startsWith('L')) {
        const lAddr = operand.replace(/\s+/g, '');
        localVars[lAddr] = { sources: [...akkuInputs], logic: [...akkuLogic] };
      }
      // Don't reset akkuInputs – Akku1 still holds the value after T
      akkuLogic.push(asm);
      continue;
    }

    // ─── Bit assignment: =, S, R ───
    if (op === '=' || op === 'S' || op === 'R') {
      emitChain(op, operand, instr.offset);
      // Store in local var tracker if writing to L
      if (operand.startsWith('L')) {
        const lAddr = operand.replace(/\s+/g, '');
        localVars[lAddr] = { sources: [...rloInputs], logic: [...rloLogic] };
      }
      // After =, the RLO is consumed but can still feed more = in series
      rloLogic.push(asm);
      continue;
    }

    // ─── Comparisons: ==I, >I, <I, etc. ───
    if (/^[<>=!]=?[IRD]$/.test(op)) {
      // Comparison result goes to RLO, Akku values become RLO inputs
      rloInputs.push(...akkuInputs);
      rloLogic.push(...akkuLogic, asm);
      akkuInputs = [];
      akkuLogic = [];
      continue;
    }

    // ─── Arithmetic: +I, -I, *I, /I, +R, -R, *R, /R, +D, -D, *D, /D ───
    if (/^[+\-*/][IRD]$/.test(op) || op === 'MOD' || op === 'ABS' ||
        op === 'NEGR' || op === 'NEGI' || op === 'NEGD') {
      akkuLogic.push(asm);
      continue;
    }

    // ─── Conversion: ITD, DTR, BTI, etc. ───
    if (['ITD', 'DTR', 'ITB', 'BTI', 'BTD', 'DTB', 'INVD', 'INVI',
         'RND', 'RND+', 'RND-', 'TRUNC', 'SIN', 'COS', 'TAN', 'LN',
         'SQRT', 'SQR', 'ASIN', 'ACOS', 'ATAN', 'EXP'].includes(op)) {
      akkuLogic.push(asm);
      continue;
    }

    // ─── Shift/Rotate ───
    if (['SLW', 'SRW', 'SLD', 'SRD', 'RLD', 'RRD', 'RLDA', 'RRDA',
         'SSI', 'SSD'].includes(op)) {
      akkuLogic.push(asm);
      continue;
    }

    // ─── Word logic: AW, OW, XOW, AD, OD, XOD ───
    if (['AW', 'OW', 'XOW', 'AD', 'OD', 'XOD'].includes(op)) {
      akkuLogic.push(asm);
      continue;
    }

    // ─── Akku operations: TAK, PUSH, POP, ENT, LEAVE ───
    if (['TAK', 'PUSH', 'POP', 'ENT', 'LEAVE'].includes(op)) {
      akkuLogic.push(asm);
      continue;
    }

    // ─── Address register: LAR1, LAR2, TAR1, TAR2, +AR1, +AR2, CAR ───
    if (/^(LAR[12]|TAR[12]|\+AR[12]|CAR)/.test(op)) {
      rloLogic.push(asm);
      continue;
    }

    // ─── Timer operations: SI, SV, SE, SS, SA, SD, SF, SP, FR ───
    if (['SI', 'SV', 'SE', 'SS', 'SA', 'SD', 'SF', 'SP', 'FR'].includes(op)) {
      rloLogic.push(asm);
      if (operand) rloInputs.push(operand);
      continue;
    }

    // ─── Counter operations: CU, CD, S C, R C, FR C ───
    if (['CU', 'CD'].includes(op)) {
      rloLogic.push(asm);
      if (operand) rloInputs.push(operand);
      continue;
    }
    if (op === 'LC') {
      akkuInputs.push(operand);
      akkuLogic.push(asm);
      continue;
    }

    // ─── Jumps: break the chain ───
    if (asm.startsWith('J') || op === 'LOOP') {
      // Conditional jumps: the RLO was tested, chain continues after
      // Unconditional: chain is broken
      if (op === 'JU' || op === 'JL') {
        // Unconditional jump → reset
        rloLogic.push(asm);
        rloInputs = [];
        rloLogic = [];
        akkuInputs = [];
        akkuLogic = [];
      } else {
        // Conditional jump → RLO is tested but chain may continue
        rloLogic.push(asm);
      }
      continue;
    }

    // ─── Block end ───
    if (op === 'BE' || op === 'BEU' || op === 'BEC') {
      rloInputs = [];
      rloLogic = [];
      akkuInputs = [];
      akkuLogic = [];
      continue;
    }

    // ─── Status bit tests: A OS, AN OV, O >0, etc. ───
    if (['OS', 'OV', 'BR', 'UO'].includes(operand) ||
        /^[<>=!]=?0$/.test(operand) || operand === '<>0') {
      rloLogic.push(asm);
      continue;
    }

    // ─── MCR operations ───
    if (['MCR(', ')MCR', 'MCRA', 'MCRD'].includes(op)) {
      rloLogic.push(asm);
      continue;
    }

    // ─── INC, DEC ───
    if (op === 'INC' || op === 'DEC') {
      akkuLogic.push(asm);
      continue;
    }

    // ─── Anything else: just track it ───
    rloLogic.push(asm);
  }

  // ─── Post-process: resolve local variables in chains ───
  for (const chain of chains) {
    const resolvedInputs = [];
    for (const inp of chain.inputs) {
      const lAddr = inp.replace(/\s+/g, '');
      if (lAddr.startsWith('L') && localVars[lAddr]) {
        // Replace local var with its source signals
        resolvedInputs.push(...localVars[lAddr].sources);
      } else if (!inp.startsWith('CALL:')) {
        resolvedInputs.push(inp);
      }
    }
    chain.inputs = [...new Set(resolvedInputs)].filter(a => isAddress(a));
  }

  // ─── Deduplicate chains (same output + same network = keep longest) ───
  const deduped = {};
  for (const chain of chains) {
    const key = `${chain.network}:${chain.output}`;
    if (!deduped[key] || chain.inputs.length > deduped[key].inputs.length) {
      deduped[key] = chain;
    }
  }

  return Object.values(deduped);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { decodeMC7, mc7ToAwl, extractLogicChains };
