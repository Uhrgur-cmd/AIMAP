/**
 * Simple absolute-address read using nodes7.
 * This function is kept EXACTLY as your logic originally required.
 */

const nodes7 = require('nodes7');

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function readOnce(plc) {
  const {
    host,
    rack = 0,
    slot = 1,
    tags = {},
    timeoutMs = 3000,
    throttleMs = 0
  } = plc;

  const conn = new nodes7();

  return new Promise((resolve) => {
    let finished = false;

    const done = (result) => {
      if (!finished) {
        finished = true;
        try { conn.dropConnection(); } catch {}
        resolve(result);
      }
    };

    const timer = setTimeout(() =>
      done({ error: 'Timeout connecting/reading PLC' }), timeoutMs);

    conn.initiateConnection(
      { host, port: 102, rack, slot },
      async (err) => {
        if (err) {
          clearTimeout(timer);
          return done({ error: String(err) });
        }

        try {
          conn.setTranslationCB(tag => tags[tag]);
          conn.addItems(Object.keys(tags));

          if (throttleMs > 0) await sleep(throttleMs);

          conn.readAllItems((err2, values) => {
            clearTimeout(timer);
            if (err2) return done({ error: String(err2) });
            done({ values });
          });

        } catch (e) {
          clearTimeout(timer);
          done({ error: String(e) });
        }
      }
    );
  });
}

module.exports = { readOnce };