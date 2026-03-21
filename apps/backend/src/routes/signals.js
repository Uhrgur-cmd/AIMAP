const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Get all signals for a machine
router.get('/machine/:machineId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM signals WHERE machine_id = $1 ORDER BY address',
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
