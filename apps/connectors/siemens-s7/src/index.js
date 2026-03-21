/**
 * Siemens Classic S7 Connector (RFC1006 / nodes7)
 * ------------------------------------------------
 * POST /read  – batch absolute-address reads
 * POST /scan  – heuristic DB scan (BOOL/INT/REAL discovery)
 *
 * A global queue ensures only one task runs at a time so the PLC is never overloaded.
 */

const express = require('express');
const { readOnce } = require('./s7-reader');
const S7Scanner = require('./s7-scanner');

const app = express();
app.use(express.json());

app.get('/healthz', (_, res) => res.send('ok'));

// Global queue: serialize all PLC requests
let queue = Promise.resolve();
const MIN_INTERVAL_MS = 100;

function enqueue(task) {
  // Run the task after the previous one finishes (regardless of success/failure).
  // Keep the shared `queue` in a resolved state so a single failure never
  // poisons all future requests.
  const result = queue.then(async () => {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS));
    return task();
  });
  queue = result.catch(() => {}); // swallow error on the shared chain only
  return result;               // caller still gets the real result/rejection
}

/**
 * POST /read
 * Body: { host, rack?, slot?, tags: { "alias": "nodes7_address" }, timeoutMs?, throttleMs? }
 * Returns: { values: { "alias": value } } or { error }
 */
app.post('/read', async (req, res) => {
  try {
    const plc = req.body || {};
    if (!plc.host || !plc.tags) {
      return res.status(400).json({ error: 'host and tags are required' });
    }
    if (!Object.keys(plc.tags).length) {
      return res.status(400).json({ error: 'tags cannot be empty' });
    }

    const result = await enqueue(() => readOnce(plc));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /scan
 * Body: { host, rack?, slot?, db (number), maxOffset?, throttleMs? }
 * Returns: { host, db, findings: [{ type, address, offset, value }] }
 */
app.post('/scan', async (req, res) => {
  try {
    const {
      host,
      rack = 0,
      slot = 2,
      db,
      maxOffset = 256,
      silent = true
    } = req.body || {};

    if (!host || typeof db !== 'number') {
      return res.status(400).json({ error: 'host and db (number) are required' });
    }

    const findings = await enqueue(async () => {
      const scanner = new S7Scanner({ host, rack, slot, db, maxOffset, silent });
      await scanner.connect();
      const result = await scanner.scan();
      scanner.disconnect();
      return result;
    });

    res.json({ host, db, findings });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = Number(process.env.PORT || 8300);
app.listen(PORT, () => {
  console.log(`ct-gate siemens-s7 connector listening on :${PORT}`);
});
