const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Get all mappings for a machine
router.get('/machine/:machineId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM mappings WHERE machine_id = $1 ORDER BY target_signal',
      [req.params.machineId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save/update mappings for a machine
router.put('/machine/:machineId', async (req, res) => {
  const { mappings } = req.body;
  if (!mappings || !Array.isArray(mappings)) {
    return res.status(400).json({ error: 'mappings array required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete mappings not in the new list (fix: remove was broken before)
    const targetSignals = mappings.map(m => m.target_signal);
    if (targetSignals.length > 0) {
      await client.query(
        'DELETE FROM mappings WHERE machine_id = $1 AND target_signal != ALL($2)',
        [req.params.machineId, targetSignals]
      );
    } else {
      // Empty array = delete all mappings for this machine
      await client.query('DELETE FROM mappings WHERE machine_id = $1', [req.params.machineId]);
    }

    // Upsert remaining mappings
    for (const m of mappings) {
      await client.query(
        `INSERT INTO mappings (machine_id, target_signal, mapping_type, source_address, expression, lookup_table, confidence, validated_by_human, reasoning)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (machine_id, target_signal) DO UPDATE SET
           mapping_type = EXCLUDED.mapping_type,
           source_address = EXCLUDED.source_address,
           expression = EXCLUDED.expression,
           lookup_table = EXCLUDED.lookup_table,
           confidence = EXCLUDED.confidence,
           validated_by_human = EXCLUDED.validated_by_human,
           reasoning = EXCLUDED.reasoning,
           version = mappings.version + 1`,
        [
          req.params.machineId, m.target_signal, m.mapping_type,
          m.source_address || null, m.expression || null,
          m.lookup_table ? JSON.stringify(m.lookup_table) : null,
          m.confidence || null, m.validated_by_human || false,
          m.reasoning || null
        ]
      );
    }

    await client.query('COMMIT');

    const { rows } = await pool.query(
      'SELECT * FROM mappings WHERE machine_id = $1 ORDER BY target_signal',
      [req.params.machineId]
    );
    res.json(rows);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// AI suggest mappings – runs async, saves batch by batch
const aiJobs = {}; // machineId → { status, progress, total, error }

router.post('/machine/:machineId/ai-suggest', async (req, res) => {
  const machineId = req.params.machineId;

  // If already running, return current status
  if (aiJobs[machineId]?.status === 'running') {
    return res.json(aiJobs[machineId]);
  }

  // Clear old mappings if requested
  if (req.body?.clearExisting !== false) {
    await pool.query('DELETE FROM mappings WHERE machine_id = $1', [machineId]);
  }

  // Start async job
  aiJobs[machineId] = { status: 'running', progress: 0, total: 0, mapped: 0, error: null };
  res.json(aiJobs[machineId]);

  // Run in background
  const { suggestMappingsBatchwise } = require('../services/ai-mapper');
  suggestMappingsBatchwise(machineId, (update) => {
    // Callback per batch – save results immediately
    aiJobs[machineId] = { ...aiJobs[machineId], ...update };
  }).catch(err => {
    aiJobs[machineId].status = 'error';
    aiJobs[machineId].error = err.message;
  });
});

// AI job status polling
router.get('/machine/:machineId/ai-status', (req, res) => {
  const job = aiJobs[req.params.machineId];
  if (!job) return res.json({ status: 'idle' });
  res.json(job);
});

module.exports = router;
