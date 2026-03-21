const http = require('http');

/**
 * Scan Validator – Cross-references parsed project signals against live PLC values.
 *
 * Problem: The S7 scanner probes memory blindly and picks up garbage values.
 * Solution: Use the project file addresses as a whitelist.
 *           Scanner results that match known project addresses get confirmed.
 *           Everything else is discarded.
 *
 * Result: signals get a `live_confirmed` flag and `live_value` field.
 */

/**
 * Validate parsed project signals against the live S7 scanner.
 *
 * @param {Object} machine - machine record with host, rack, slot, connector
 * @param {Array}  signals - parsed signals [{ address, data_type, ... }]
 * @returns {Array} signals enriched with live_confirmed and live_value
 */
// Hard cap: entire validation must complete within this many ms
const TOTAL_TIMEOUT_MS = 12000;
// Timeout per individual DB scan request
const PER_REQUEST_TIMEOUT_MS = 5000;

async function validateWithScanner(machine, signals) {
  // Only works for Siemens S7 via the siemens-s7 connector
  if (machine.connector !== 'siemens-s7') {
    return signals;
  }

  const s7Url = process.env.SIEMENS_S7_URL || 'http://localhost:8300';

  // Group signals by DB number to minimize scanner calls
  const dbGroups = {};
  for (const signal of signals) {
    const match = signal.address.match(/^DB(\d+)\./);
    if (!match) continue;
    const db = parseInt(match[1]);
    if (!dbGroups[db]) dbGroups[db] = [];
    dbGroups[db].push(signal);
  }

  if (Object.keys(dbGroups).length === 0) return signals;

  // Build a fast lookup: address → signal (for cross-reference)
  const signalByAddress = new Map(signals.map(s => [s.address, s]));

  const confirmedAddresses = new Set();
  const liveValues = new Map();

  // Scan all DBs in parallel (bounded by total timeout)
  const scanDb = async ([db, dbSignals]) => {
    const maxOffset = estimateMaxOffset(dbSignals);
    try {
      const result = await httpPost(`${s7Url}/scan`, {
        host: machine.host,
        rack: machine.rack,
        slot: machine.slot,
        db: parseInt(db),
        maxOffset: maxOffset,
        throttleMs: 0
      }, PER_REQUEST_TIMEOUT_MS);

      if (!result.findings) return;

      for (const finding of result.findings) {
        const scanAddr = finding.address;
        if (!scanAddr) continue;
        const projectSignal = signalByAddress.get(scanAddr);
        if (projectSignal && typesCompatible(finding.type, projectSignal.data_type)) {
          confirmedAddresses.add(scanAddr);
          liveValues.set(scanAddr, String(finding.value));
        }
      }
    } catch (e) {
      if (e.message.includes('ECONNREFUSED')) throw e; // propagate – connector is down
      console.warn(`[scan-validator] DB${db} scan failed: ${e.message}`);
    }
  };

  try {
    // Race all parallel DB scans against a hard total timeout
    const totalTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TOTAL_TIMEOUT')), TOTAL_TIMEOUT_MS)
    );
    await Promise.race([
      Promise.all(Object.entries(dbGroups).map(scanDb)),
      totalTimeout
    ]);
  } catch (e) {
    if (e.message === 'TOTAL_TIMEOUT') {
      console.warn(`[scan-validator] Validation timed out after ${TOTAL_TIMEOUT_MS}ms – returning partial results`);
    } else if (e.message.includes('ECONNREFUSED')) {
      console.warn(`[scan-validator] Siemens S7 connector unreachable at ${s7Url}`);
      return signals;
    }
    // For any other error, fall through and return what we have so far
  }

  // Enrich signals with live_confirmed flag
  return signals.map(s => ({
    ...s,
    live_confirmed: confirmedAddresses.has(s.address),
    live_value: liveValues.get(s.address) || null
  }));
}

/**
 * Estimate the max byte offset needed to cover all signals in a DB.
 * Adds a 32-byte buffer to catch any misalignments.
 */
function estimateMaxOffset(signals) {
  let max = 0;
  for (const s of signals) {
    const match = s.address.match(/\.DB[XBWD](\d+)/);
    if (match) {
      const offset = parseInt(match[1]);
      const size = typeSize(s.data_type);
      if (offset + size > max) max = offset + size;
    }
  }
  return Math.min(max + 32, 4096); // cap at 4096 bytes
}

/**
 * Return byte size of a data type (for offset estimation).
 */
function typeSize(dt) {
  switch ((dt || '').toUpperCase()) {
    case 'BOOL': return 1;
    case 'BYTE': case 'CHAR': case 'SINT': case 'USINT': return 1;
    case 'INT': case 'WORD': case 'UINT': return 2;
    case 'DINT': case 'DWORD': case 'UDINT': case 'REAL': case 'TIME': return 4;
    case 'LREAL': return 8;
    default: return 4;
  }
}

/**
 * Check if a scanner-found type is compatible with the project declared type.
 * The scanner only detects BOOL, INT, REAL – so we do a coarse match.
 */
function typesCompatible(scanType, projectType) {
  const pt = (projectType || '').toUpperCase();
  switch (scanType) {
    case 'BOOL':
      return pt === 'BOOL';
    case 'INT':
      return ['INT', 'WORD', 'UINT', 'SINT', 'USINT', 'BYTE'].includes(pt);
    case 'REAL':
      return ['REAL', 'LREAL'].includes(pt);
    default:
      return false;
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────

function httpPost(url, body, timeoutMs = PER_REQUEST_TIMEOUT_MS) {
  const parsed = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { validateWithScanner };
