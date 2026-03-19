// Read-only DB scanner focusing on STRING/INT/REAL heuristics.
// Notes:
// - Classic S7 has no symbolic browse and doesn't read optimized DBs. [5](https://blog.csdn.net/gitblog_00605/article/details/142018218)
// - This scanner attempts to read raw bytes from DBs in fixed-size chunks and infer likely data fields.
// - Throttling is used to avoid stressing the PLC scan cycle.

const nodes7 = require('nodes7');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPrintable = (b) => b === 0x20 || (b >= 0x21 && b <= 0x7e);

function detectString(buf, off) {
  if (off + 2 > buf.length) return null;
  const max = buf.readUInt8(off);
  const cur = buf.readUInt8(off + 1);
  if (max === 0 || max > 254 || cur > max) return null;
  if (off + 2 + cur > buf.length) return null;
  const body = buf.subarray(off + 2, off + 2 + cur);
  if (![...body].every(isPrintable)) return null;
  return { type: 'STRING', len: cur, text: body.toString('utf8') };
}

function detectInt(buf, off) {
  if (off + 2 > buf.length) return null;
  const v = buf.readInt16BE(off);
  if (Number.isInteger(v) && v >= -32768 && v <= 32767) return { type: 'INT', value: v };
  return null;
}

function detectReal(buf, off) {
  if (off + 4 > buf.length) return null;
  const v = buf.readFloatBE(off);
  if (Number.isFinite(v) && Math.abs(v) <= 1e6) return { type: 'REAL', value: v };
  return null;
}

/**
 * Reads DB bytes in chunks and applies STRING/INT/REAL heuristics.
 * Warning: Requires non-optimized DBs for S7-1200/1500 when using classic S7 access. [4](https://github.com/ottowayi/pycomm3)
 */
async function scanDb({ host, rack = 0, slot = 1, db, blockSize = 256, maxBytes = 4096, throttleMs = 100 }) {
  const conn = new nodes7();
  // Establish connection
  await new Promise((resolve) => conn.initiateConnection({ host, port: 102, rack, slot }, () => resolve()));

  const findings = [];
  for (let base = 0; base < maxBytes; base += blockSize) {
    const alias = 'CHUNK';
    // Attempt raw byte ranges: DB{db},BYTE{base}.{blockSize}
    // nodes7 supports array reads by type/count (e.g., DB1,INT0.10; DB1,REAL0.20). BYTE arrays may vary by version.
    const addr = `DB${db},BYTE${base}.${blockSize}`;
    conn.setTranslationCB((tag) => (tag === alias ? addr : null));
    conn.addItems([alias]);

    // eslint-disable-next-line no-await-in-loop
    const chunk = await new Promise((resolve) =>
      conn.readAllItems((err, values) => resolve(err ? null : Buffer.from(values[alias])))
    );
    conn.removeItems([alias]);

    if (chunk) {
      for (let off = 0; off < chunk.length; off++) {
        const s = detectString(chunk, off);
        if (s) { findings.push({ db, offset: base + off, ...s, score: 0.9 }); continue; }
        const r = detectReal(chunk, off);
        if (r) { findings.push({ db, offset: base + off, ...r, score: 0.6 }); continue; }
        const i = detectInt(chunk, off);
        if (i) { findings.push({ db, offset: base + off, ...i, score: 0.5 }); continue; }
      }
    }
    // Throttle between chunks
    // eslint-disable-next-line no-await-in-loop
    await sleep(throttleMs);
  }

  conn.dropConnection();
  return findings.sort((a, b) => b.score - a.score);
}

module.exports = { scanDb };