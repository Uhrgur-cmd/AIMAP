const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Get current data model with all signals
router.get('/', async (req, res) => {
  try {
    const { rows: models } = await pool.query('SELECT * FROM datamodel ORDER BY created_at DESC LIMIT 1');
    if (!models.length) return res.json({ version: 0, signals: [] });

    const { rows: signals } = await pool.query(
      'SELECT * FROM datamodel_signals WHERE datamodel_id = $1 ORDER BY sort_order',
      [models[0].id]
    );
    res.json({ ...models[0], signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update data model signals
router.put('/', async (req, res) => {
  const { signals } = req.body;
  if (!signals || !Array.isArray(signals)) {
    return res.status(400).json({ error: 'signals array required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: models } = await client.query('SELECT * FROM datamodel ORDER BY created_at DESC LIMIT 1');
    let modelId;
    if (models.length) {
      modelId = models[0].id;
      await client.query('UPDATE datamodel SET version = version + 1 WHERE id = $1', [modelId]);
    } else {
      const { rows } = await client.query('INSERT INTO datamodel (version) VALUES (1) RETURNING id');
      modelId = rows[0].id;
    }

    await client.query('DELETE FROM datamodel_signals WHERE datamodel_id = $1', [modelId]);
    for (let i = 0; i < signals.length; i++) {
      const s = signals[i];
      await client.query(
        `INSERT INTO datamodel_signals (datamodel_id, name, data_type, unit, description, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [modelId, s.name, s.data_type, s.unit || null, s.description || null, i]
      );
    }

    await client.query('COMMIT');

    const { rows: updatedSignals } = await pool.query(
      'SELECT * FROM datamodel_signals WHERE datamodel_id = $1 ORDER BY sort_order',
      [modelId]
    );
    res.json({ id: modelId, signals: updatedSignals });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get per-machine data model signals (falls back to empty if none set)
router.get('/machine/:machineId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT signals FROM machine_datamodels WHERE machine_id = $1',
      [req.params.machineId]
    );
    res.json({ signals: rows.length ? rows[0].signals : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save per-machine data model signals (upsert)
router.put('/machine/:machineId', async (req, res) => {
  const { signals } = req.body;
  if (!signals || !Array.isArray(signals)) {
    return res.status(400).json({ error: 'signals array required' });
  }
  try {
    await pool.query(
      `INSERT INTO machine_datamodels (machine_id, signals, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (machine_id) DO UPDATE SET signals = EXCLUDED.signals, updated_at = NOW()`,
      [req.params.machineId, JSON.stringify(signals)]
    );
    res.json({ machine_id: req.params.machineId, signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
