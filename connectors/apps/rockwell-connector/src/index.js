const express = require('express');
const bodyParser = require('body-parser');
const { connectAndSample, readTag, writeTag } = require('./enip-client');

const app = express();
app.use(bodyParser.json());

app.get('/healthz', (_, res) => res.send('ok'));

// GET /tags?ip=192.168.0.20&slot=0
app.get('/tags', async (req, res) => {
  try {
    const ip = req.query.ip;
    const slot = Number(req.query.slot ?? 0);
    if (!ip) return res.status(400).json({ error: 'ip is required' });
    const out = await connectAndSample(ip, slot);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /read?ip=...&slot=0&tag=Program:MainRoutine.SomeReal
app.get('/read', async (req, res) => {
  try {
    const { ip, tag } = req.query;
    const slot = Number(req.query.slot ?? 0);
    if (!ip || !tag) return res.status(400).json({ error: 'ip and tag are required' });
    const v = await readTag(ip, slot, tag);
    res.json(v);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /write { ip, slot?, tag, value }
app.post('/write', async (req, res) => {
  try {
    const { ip, slot = 0, tag, value } = req.body || {};
    if (!ip || !tag) return res.status(400).json({ error: 'ip and tag are required' });
    const v = await writeTag(ip, Number(slot), tag, value);
    res.json(v);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = Number(process.env.PORT || 8100);
app.listen(PORT, () => console.log(`rockwell-connector listening on :${PORT}`));