const express = require('express');
const bodyParser = require('body-parser');
const { readOnce } = require('./s7-reader');
const { scanDb } = require('./s7-scanner');

const app = express();
app.use(bodyParser.json());

app.get('/healthz', (_, res) => res.send('ok'));

// POST /read  { host, rack?, slot?, tags: { NAME: "DB1,REAL0", ... } }
app.post('/read', async (req, res) => {
  try {
    const plc = req.body || {};
    if (!plc.host || !plc.tags) return res.status(400).json({ error: 'host and tags are required' });
    const out = await readOnce(plc);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /scan  { host, rack?, slot?, db, blockSize?, maxBytes?, throttleMs? }
app.post('/scan', async (req, res) => {
  try {
    const { host, rack = 0, slot = 1, db, blockSize = 256, maxBytes = 4096, throttleMs = 100 } = req.body || {};
    if (!host || typeof db !== 'number') return res.status(400).json({ error: 'host and db are required' });
    const findings = await scanDb({ host, rack, slot, db, blockSize, maxBytes, throttleMs });
    res.json({ host, db, findings });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = Number(process.env.PORT || 8300);
app.listen(PORT, () => console.log(`siemens-connector (classic) listening on :${PORT}`));