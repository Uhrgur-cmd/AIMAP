/**
 * S7 Scanner – exports S7Scanner class for use as a module.
 * Can also be run directly as a CLI script.
 *
 * Usage as module:
 *   const S7Scanner = require('./s7-scanner');
 *   const scanner = new S7Scanner({ host, rack, slot, db, maxOffset });
 *   await scanner.connect();
 *   const results = await scanner.scan();
 *   scanner.disconnect();
 *
 * Usage as CLI:
 *   node s7-scanner.js <host> <rack> <slot> <db> <maxOffset>
 */

const nodes7 = require('nodes7');

class S7Scanner {
  constructor({ host, rack, slot, db, maxOffset, silent = true }) {
    this.host = host;
    this.rack = rack;
    this.slot = slot;
    this.db = db;
    this.maxOffset = maxOffset;
    this.silent = silent;
    this.conn = new nodes7();
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.conn.initiateConnection(
        { host: this.host, port: 102, rack: this.rack, slot: this.slot },
        (err) => {
          if (err) return reject(err);
          this.conn.setTranslationCB((tag) => tag);
          this.connected = true;
          resolve();
        }
      );
    });
  }

  disconnect() {
    try { this.conn.dropConnection(); } catch {}
    this.connected = false;
  }

  async tryRead(address) {
    return new Promise((resolve) => {
      try {
        this.conn.addItems(address);
        this.conn.readAllItems((err, values) => {
          this.conn.removeItems();
          if (err || !values) return resolve(null);
          resolve(values[address]);
        });
      } catch {
        return resolve(null);
      }
    });
  }

  async scan() {
    if (!this.connected) throw new Error('Not connected');

    const results = [];

    for (let offset = 0; offset < this.maxOffset; offset++) {
      // BOOL – only record bits that are true
      for (let bit = 0; bit < 8; bit++) {
        const addr = `DB${this.db},X${offset}.${bit}`;
        const val = await this.tryRead(addr);
        if (val === true) {
          results.push({
            type: 'BOOL',
            address: `DB${this.db}.DBX${offset}.${bit}`,
            offset: offset,
            value: true
          });
        }
      }

      // REAL – 4-byte aligned, value must be in plausible range
      let realVal = null;
      if (offset % 4 === 0) {
        const val = await this.tryRead(`DB${this.db},REAL${offset}`);
        if (val !== null && Math.abs(val) > 0.0001 && Math.abs(val) < 10000) {
          realVal = val;
        }
      }

      // INT – 2-byte aligned, non-zero and in plausible range
      let intVal = null;
      if (offset % 2 === 0) {
        const val = await this.tryRead(`DB${this.db},INT${offset}`);
        if (val !== null && val !== 0 && Math.abs(val) < 10000) {
          intVal = val;
        }
      }

      // Priority: REAL beats INT at the same offset
      if (realVal !== null) {
        results.push({ type: 'REAL', address: `DB${this.db}.DBD${offset}`, offset, value: realVal });
      } else if (intVal !== null) {
        results.push({ type: 'INT', address: `DB${this.db}.DBW${offset}`, offset, value: intVal });
      }
    }

    return results;
  }
}

module.exports = S7Scanner;

// ── CLI mode ──────────────────────────────────────────────────
if (require.main === module) {
  const [host, rack, slot, db, maxOffset] = process.argv.slice(2);

  if (!host || !rack || !slot || !db || !maxOffset) {
    console.error('Usage: node s7-scanner.js <host> <rack> <slot> <db> <maxOffset>');
    process.exit(1);
  }

  const scanner = new S7Scanner({
    host,
    rack: Number(rack),
    slot: Number(slot),
    db: Number(db),
    maxOffset: Number(maxOffset),
    silent: false
  });

  (async () => {
    try {
      await scanner.connect();
      const results = await scanner.scan();
      scanner.disconnect();
      process.stdout.write(JSON.stringify(results) + '\n');
    } catch (err) {
      scanner.disconnect();
      process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
      process.exit(1);
    }
  })();
}
