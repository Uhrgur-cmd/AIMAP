const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Get all signals for a machine
router.get('/machine/:machineId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, nc.comment as network_context
       FROM signals s
       LEFT JOIN network_comments nc ON nc.machine_id = s.machine_id
         AND s.address = ANY(nc.signals_referenced)
       WHERE s.machine_id = $1
       ORDER BY s.address`,
      [req.params.machineId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get network comments for a machine
router.get('/machine/:machineId/networks', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM network_comments WHERE machine_id = $1 ORDER BY block_name, network_number',
      [req.params.machineId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
