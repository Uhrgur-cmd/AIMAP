const express = require('express');
const router = express.Router();

// In-memory scan progress store: machineId -> { status, db, total, found, error }
const scanProgressStore = new Map();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { parseProjectFile } = require('../services/project-parser');
const { validateWithScanner } = require('../services/scan-validator');

// Strip null bytes and invalid control characters before PostgreSQL insert
function sanitize(str) {
  if (!str) return str;
  return str.replace(/\x00/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

const upload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOAD_PATH || './uploads',
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// List all machines
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM machines ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single machine
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM machines WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Machine not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add machine
router.post('/', async (req, res) => {
  const { name, plc_type, host, rack, slot, tia_version } = req.body;

  let connector;
  switch (plc_type) {
    case 'S7-300': case 'S7-400':
      connector = 'siemens-s7';
      break;
    case 'S7-1500':
      connector = 'siemens-opcua';
      break;
    case 'S7-1200':
      connector = req.body.use_opcua ? 'siemens-opcua' : 'siemens-s7';
      break;
    case 'Rockwell':
      connector = 'rockwell';
      break;
    default:
      return res.status(400).json({ error: 'Invalid plc_type' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO machines (name, plc_type, host, rack, slot, connector, tia_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, plc_type, host, rack || 0, slot || 2, connector, tia_version || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update machine
router.put('/:id', async (req, res) => {
  const { name, plc_type, host, rack, slot } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE machines SET name = COALESCE($1, name), plc_type = COALESCE($2, plc_type),
       host = COALESCE($3, host), rack = COALESCE($4, rack), slot = COALESCE($5, slot)
       WHERE id = $6 RETURNING *`,
      [name, plc_type, host, rack, slot, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Machine not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update machine connection status (used by OPC UA server health manager)
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['connected', 'connecting', 'disconnected'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const { rows } = await pool.query(
      `UPDATE machines SET status = $1, last_seen = CASE WHEN $1 = 'connected' THEN NOW() ELSE last_seen END
       WHERE id = $2 RETURNING id, status`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Machine not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete machine
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM machines WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Machine not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload project file (.s7p / .zap / .L5X)
// After parsing, optionally cross-validates with live S7 scanner to confirm signals.
router.post('/:id/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const { rows: machines } = await pool.query('SELECT * FROM machines WHERE id = $1', [req.params.id]);
    if (!machines.length) return res.status(404).json({ error: 'Machine not found' });
    const machine = machines[0];

    // 1. Parse the project file
    const parsed = await parseProjectFile(req.file.path, machine.plc_type, machine.tia_version);

    // 2. Flatten all parsed signals for scan validation
    const allParsedSignals = parsed.blocks.flatMap(b =>
      b.variables.map(v => ({
        address: v.address,
        data_type: v.type,
        name: v.name,
        comment: v.comment
      }))
    );

    // 3. Validate with live scanner (S7 only – non-blocking, best-effort)
    let enrichedSignals = allParsedSignals;
    let confirmedCount = 0;

    if (machine.connector === 'siemens-s7') {
      try {
        enrichedSignals = await validateWithScanner(machine, allParsedSignals);
        confirmedCount = enrichedSignals.filter(s => s.live_confirmed).length;
        console.log(`[scan-validator] ${confirmedCount}/${allParsedSignals.length} signals live-confirmed`);
      } catch (scanErr) {
        // Scanner failure must NOT block project import
        console.warn(`[scan-validator] Validation skipped: ${scanErr.message}`);
      }
    }

    // Build enrichment map: address → { live_confirmed, live_value }
    const enrichmentMap = new Map(
      enrichedSignals.map(s => [s.address, { live_confirmed: s.live_confirmed || false, live_value: s.live_value || null }])
    );

    // 4. Store in DB
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        "DELETE FROM signals WHERE machine_id = $1 AND source = 'project_file'",
        [req.params.id]
      );
      await client.query('DELETE FROM network_comments WHERE machine_id = $1', [req.params.id]);

      // Insert signals
      for (const block of parsed.blocks) {
        for (const variable of block.variables) {
          const enrichment = enrichmentMap.get(variable.address) || { live_confirmed: false, live_value: null };
          await client.query(
            `INSERT INTO signals
               (machine_id, source, block_type, block_number, block_name, name, address, data_type, comment, live_confirmed, live_value)
             VALUES ($1, 'project_file', $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (machine_id, address) DO UPDATE SET
               name = EXCLUDED.name, data_type = EXCLUDED.data_type,
               comment = EXCLUDED.comment, block_name = EXCLUDED.block_name,
               live_confirmed = EXCLUDED.live_confirmed, live_value = EXCLUDED.live_value`,
            [
              req.params.id, 'DB', block.db_number,
              sanitize(block.name), sanitize(variable.name),
              sanitize(variable.address), sanitize(variable.type),
              sanitize(variable.comment),
              enrichment.live_confirmed, enrichment.live_value
            ]
          );
        }
      }

      // Insert network comments
      for (const network of parsed.networks) {
        await client.query(
          `INSERT INTO network_comments (machine_id, block_name, network_number, comment, signals_referenced, logic)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [req.params.id, sanitize(network.block), network.network_number,
           sanitize(network.comment), network.signals_referenced, sanitize(network.logic) || null]
        );
      }

      await client.query(
        `UPDATE machines SET project_source_type = 'upload', project_source_path = $1, project_last_parsed = NOW()
         WHERE id = $2`,
        [req.file.path, req.params.id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const totalSignals = parsed.blocks.reduce((sum, b) => sum + b.variables.length, 0);
    res.json({
      message: 'Project file parsed successfully',
      plc_type: parsed.plc_type,
      blocks: parsed.blocks.length,
      total_signals: totalSignals,
      networks: parsed.networks.length,
      live_confirmed: confirmedCount,
      live_confirmed_pct: totalSignals > 0 ? Math.round((confirmedCount / totalSignals) * 100) : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger live PLC scan (non-blocking – progress via GET /:id/scan-progress)
router.post('/:id/scan-live', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM machines WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Machine not found' });
    const machine = rows[0];

    // Reject if already running
    const existing = scanProgressStore.get(req.params.id);
    if (existing && existing.status === 'running') {
      return res.json({ started: false, reason: 'already_running' });
    }

    const startDb = parseInt(req.body.startDb) || 1;
    const endDb = parseInt(req.body.endDb) || 100;

    scanProgressStore.set(req.params.id, { status: 'running', db: 0, total: endDb, found: 0 });
    res.json({ started: true });

    // Run scan in background (no await)
    const { scanLive } = require('../services/live-scanner');
    scanLive(machine, (progress) => {
      scanProgressStore.set(req.params.id, { status: 'running', ...progress });
    }, startDb, endDb)
      .then(async (signals) => {
        for (const signal of signals) {
          await pool.query(
            `INSERT INTO signals (machine_id, source, name, address, data_type, comment)
             VALUES ($1, 'live_scan', $2, $3, $4, $5)
             ON CONFLICT (machine_id, address) DO UPDATE SET
               name = COALESCE(NULLIF(EXCLUDED.name, ''), signals.name),
               data_type = EXCLUDED.data_type`,
            [req.params.id, signal.name, signal.address, signal.data_type, signal.comment]
          );
        }
        await pool.query("UPDATE machines SET status = 'connected', last_seen = NOW() WHERE id = $1", [req.params.id]);
        scanProgressStore.set(req.params.id, { status: 'done', found: signals.length });
      })
      .catch((err) => {
        scanProgressStore.set(req.params.id, { status: 'error', error: err.message });
      });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Poll scan progress — no-store so 304 is never returned (fetch treats 304 as !ok)
router.get('/:id/scan-progress', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const progress = scanProgressStore.get(req.params.id);
  res.json(progress || { status: 'idle' });
});

module.exports = router;
