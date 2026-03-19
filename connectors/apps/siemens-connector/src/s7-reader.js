// Basic reads with nodes7 (classic S7, absolute addressing).
// For S7-1200/1500 with classic S7, typical requirement is slot=1 and disabling "Optimized Block Access" for used DBs, plus enabling PUT/GET. [4](https://github.com/ottowayi/pycomm3)
const nodes7 = require('nodes7');

function readOnce(plc) {
  // plc = { host, rack, slot, tags: { NAME: 'DB1,REAL0', ... } }
  return new Promise((resolve) => {
    const conn = new nodes7();
    conn.initiateConnection({ host: plc.host, port: 102, rack: plc.rack ?? 0, slot: plc.slot ?? 1 }, (err) => {
      if (err) return resolve({ error: String(err) });
      conn.setTranslationCB((tag) => plc.tags[tag]);
      conn.addItems(Object.keys(plc.tags || {}));
      conn.readAllItems((err2, values) => {
        conn.dropConnection();
        if (err2) resolve({ error: String(err2) });
        else resolve({ values });
      });
    });
  });
}

module.exports = { readOnce };