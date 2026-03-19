const express = require('express');
const bodyParser = require('body-parser');
const { browseOnce, readNode, writeNode } = require('./opcua-client');

const app = express();
app.use(bodyParser.json());

app.get('/healthz', (_, res) => res.send('ok'));

// GET /browse?endpoint=opc.tcp://192.168.0.10:4840&nodeId=ObjectsFolder
app.get('/browse', async (req, res) => {
  try {
    const endpoint = req.query.endpoint;
    const nodeId = req.query.nodeId || 'ObjectsFolder';
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
    const list = await browseOnce(endpoint, nodeId);
    res.json({ endpoint, nodeId, children: list });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /read?endpoint=opc.tcp://...&nodeId=ns=3;s="DB_1".Temperature
app.get('/read', async (req, res) => {
  try {
    const { endpoint, nodeId } = req.query;
    if (!endpoint || !nodeId) return res.status(400).json({ error: 'endpoint and nodeId are required' });
    const value = await readNode(endpoint, nodeId);
    res.json(value);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /write { endpoint, nodeId, variant: { dataType: "Double", value: 12.3 } }
app.post('/write', async (req, res) => {
  try {
    const { endpoint, nodeId, variant } = req.body || {};
    if (!endpoint || !nodeId || !variant) return res.status(400).json({ error: 'endpoint, nodeId and variant are required' });
    const out = await writeNode(endpoint, nodeId, variant);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = Number(process.env.PORT || 8200);
app.listen(PORT, () => console.log(`siemens-browser listening on :${PORT}`));