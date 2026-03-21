/**
 * CT-Gate OPC UA Server
 *
 * Exposes all configured machine mappings as live OPC UA variables.
 *
 * Address space layout:
 *   Objects/
 *     <MachineName>/                         (FolderType)
 *       <Category>/                          (FolderType, e.g. Communication)
 *         <SignalName>                       (Variable, e.g. HandshakeRealValues)
 *
 * NodeIds use string form:
 *   ns=2;s=<MachineName>.<TargetSignal>
 *   e.g. ns=2;s=MACHINE-1.Communication.HandshakeRealValues
 *
 * Values are read from the PLC via the siemens-s7 / rockwell connector
 * HTTP APIs (same approach as the collector service) and updated every
 * POLL_INTERVAL_MS milliseconds.
 */

'use strict';
require('dotenv').config();

const {
  OPCUAServer,
  Variant,
  DataType,
  makeAccessLevelFlag
} = require('node-opcua');
const http    = require('http');
const net     = require('net');
const express = require('express');

const BACKEND_URL    = process.env.BACKEND_URL    || 'http://localhost:3050';
const SIEMENS_S7_URL = process.env.SIEMENS_S7_URL || 'http://localhost:8300';
const ROCKWELL_URL   = process.env.ROCKWELL_URL   || 'http://localhost:8302';
const OPC_PORT       = parseInt(process.env.OPC_PORT  || process.env.PORT || '4840');
const HTTP_PORT      = parseInt(process.env.HTTP_PORT || '4841');
const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL_MS || '5000');

// ─── Connection health state machine ──────────────────────────
//
//  PROBE  (yellow) → 3 attempts, 5 s apart
//    success → ONLINE (green)
//    3 failures → OFFLINE (red)
//
//  OFFLINE (red) → wait 1 h, then 3 retry attempts 60 s apart
//    success → ONLINE
//    3 failures → OFFLINE again (another 1 h wait)
//
//  ONLINE (green) → normal OPC UA polling every POLL_INTERVAL
//    any poll failure → back to PROBE

const PROBE_ATTEMPTS        = 3;
const PROBE_INTERVAL_MS     = 5_000;
const RETRY_ATTEMPTS        = 3;
const RETRY_INTERVAL_MS     = 60_000;          // 60 s between retry attempts
const OFFLINE_WAIT_MS       = 60 * 60 * 1000; // 1 h before retry round

// machineId → { phase: 'probe'|'online'|'offline', attempts: number, nextAttemptAt: number }
const connectionHealth = new Map();

function getHealth(machineId) {
  if (!connectionHealth.has(machineId)) {
    connectionHealth.set(machineId, { phase: 'probe', attempts: 0, nextAttemptAt: 0 });
  }
  return connectionHealth.get(machineId);
}

/** TCP ping — just checks if the port is open (fast, no data exchange). */
function tcpPing(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok) => { sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.connect(port, host, () => { clearTimeout(timer); done(true); });
    sock.on('error', () => { clearTimeout(timer); done(false); });
  });
}

function connectorPort(machine) {
  if (machine.connector === 'siemens-opcua') return 4840;
  if (machine.connector === 'rockwell')      return 44818;
  return 102; // siemens-s7 (ISO-on-TCP)
}

/** Update machine status in backend (fire-and-forget). */
function pushStatus(machineId, status) {
  const url = `${BACKEND_URL}/api/machines/${machineId}/status`;
  const payload = JSON.stringify({ status });
  const u = new URL(url);
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname,
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  });
  req.on('error', () => {}); // ignore — best effort
  req.write(payload);
  req.end();
}

// ─── Live value cache ─────────────────────────────────────────
// machineId → Map<targetSignal, rawValue>
const liveValues = new Map();

// ─── Created OPC UA nodes ─────────────────────────────────────
// machineId → { machine, folder, signals: Map<targetSignal, { node, dataType }> }
const machineRegistry = new Map();

// ─── Active SSE clients ───────────────────────────────────────
// machineId → Set<response>  (only streams for expanded machines)
const activeStreams = new Map();

let addressSpace = null;
let namespace    = null;

// ─── DataType reverse-map (enum → PLC type string for connector reads) ────────
const dtMap = {
  [DataType.Boolean]: 'BOOL', [DataType.Int16]: 'INT',  [DataType.UInt16]: 'WORD',
  [DataType.Int32]:   'DINT', [DataType.UInt32]: 'DWORD', [DataType.Float]: 'REAL',
  [DataType.Double]:  'LREAL', [DataType.String]: 'STRING'
};

// ─── OPC UA DataType mapping ──────────────────────────────────
function plcTypeToOpcDataType(plcType) {
  switch ((plcType || '').toUpperCase()) {
    case 'BOOL':                         return DataType.Boolean;
    case 'INT': case 'SINT':             return DataType.Int16;
    case 'UINT': case 'WORD':            return DataType.UInt16;
    case 'DINT': case 'TIME':            return DataType.Int32;
    case 'UDINT': case 'DWORD':          return DataType.UInt32;
    case 'REAL':                         return DataType.Float;
    case 'LREAL':                        return DataType.Double;
    case 'STRING': case 'WSTRING':       return DataType.String;
    default:                             return DataType.Variant;
  }
}

function coerceValue(value, dataType) {
  if (value === null || value === undefined) return null;
  switch (dataType) {
    case DataType.Boolean: return value === true || value === 1 || value === '1' || value === 'true';
    case DataType.Int16:   return Math.trunc(Number(value)) || 0;
    case DataType.UInt16:  return Math.max(0, Math.trunc(Number(value)) || 0);
    case DataType.Int32:   return Math.trunc(Number(value)) || 0;
    case DataType.UInt32:  return Math.max(0, Math.trunc(Number(value)) || 0);
    case DataType.Float:
    case DataType.Double:  return Number(value) || 0.0;
    case DataType.String:  return String(value);
    default:               return value;
  }
}

function defaultValue(dataType) {
  switch (dataType) {
    case DataType.Boolean:  return false;
    case DataType.String:   return '';
    case DataType.Float:
    case DataType.Double:   return 0.0;
    default:                return 0;
  }
}

// ─── Address space builder ────────────────────────────────────

/**
 * Sync the OPC UA address space with current mappings from the backend.
 * Only exposes standard data model signals that have a source linked.
 * Safe to call repeatedly — adds new nodes and removes stale ones.
 */
async function syncAddressSpace(machines) {
  // Remove machines that no longer exist in the backend
  const currentIds = new Set(machines.map(m => m.id));
  for (const [machineId, entry] of machineRegistry) {
    if (!currentIds.has(machineId)) {
      try { if (entry.folder) addressSpace.deleteNode(entry.folder); } catch (_) {}
      machineRegistry.delete(machineId);
      liveValues.delete(machineId);
      activeStreams.delete(machineId);
      console.log(`[OPC UA] - Removed machine: ${entry.machine.name}`);
    }
  }

  for (const machine of machines) {
    const safeName = machine.name.replace(/[^a-zA-Z0-9_\-]/g, '_');

    // Create machine folder if needed
    if (!machineRegistry.has(machine.id)) {
      let folder = null;
      try {
        const objectsFolder = addressSpace.findNode('ns=0;i=85');
        folder = namespace.addFolder(objectsFolder, {
          browseName: safeName,
          displayName: machine.name,
          nodeId: `s=${safeName}`
        });
        console.log(`[OPC UA] + Machine folder: ${machine.name}`);
      } catch (_) {
        folder = addressSpace.findNode(`ns=2;s=${safeName}`) || null;
      }
      machineRegistry.set(machine.id, { machine, folder, signals: new Map() });
    }

    const entry = machineRegistry.get(machine.id);
    if (!entry.folder) continue;

    // Fetch only mappings that have a source configured (direct or expression)
    let mappings = [];
    try {
      mappings = await httpGet(`${BACKEND_URL}/api/mappings/machine/${machine.id}`);
    } catch (err) {
      console.warn(`[OPC UA] Could not fetch mappings for ${machine.name}: ${err.message}`);
      continue;
    }

    const activeMappings = mappings.filter(m => m.source_address || m.expression);
    const activeTargets   = new Set(activeMappings.map(m => m.target_signal));

    if (!liveValues.has(machine.id)) liveValues.set(machine.id, new Map());

    // Remove nodes for mappings that no longer exist
    for (const [key, sigEntry] of entry.signals) {
      if (sigEntry.isFolder) continue;
      if (!activeTargets.has(key)) {
        try { addressSpace.deleteNode(sigEntry.node); } catch (_) {}
        liveValues.get(machine.id)?.delete(key);
        entry.signals.delete(key);
      }
    }

    // Fetch signal types only when there are new mappings to add
    const newMappings = activeMappings.filter(m => !entry.signals.has(m.target_signal));
    let typeByAddress = {};
    if (newMappings.length > 0) {
      try {
        const signals = await httpGet(`${BACKEND_URL}/api/signals/machine/${machine.id}`);
        for (const s of signals) {
          if (s.address) typeByAddress[s.address] = s.data_type;
        }
      } catch (_) {}
    }

    // Add nodes for new mappings
    for (const mapping of newMappings) {
      const targetSignal = mapping.target_signal;

      const signalType = typeByAddress[mapping.source_address] || 'REAL';
      const dataType   = plcTypeToOpcDataType(signalType);

      liveValues.get(machine.id).set(targetSignal, null);

      // Category folder support (e.g. "Communication.Heartbeat" → folder "Communication")
      const dotIdx = targetSignal.indexOf('.');
      let parentNode = entry.folder;
      if (dotIdx > -1) {
        const category = targetSignal.substring(0, dotIdx);
        const catKey   = `_cat_${category}`;
        if (!entry.signals.has(catKey)) {
          try {
            const catFolder = namespace.addFolder(entry.folder, {
              browseName: category.replace(/[^a-zA-Z0-9_\-]/g, '_'),
              displayName: category,
              nodeId: `s=${safeName}.${category}`
            });
            entry.signals.set(catKey, { node: catFolder, isFolder: true });
          } catch (_) {}
        }
        const catEntry = entry.signals.get(catKey);
        if (catEntry) parentNode = catEntry.node;
      }

      const leafName  = dotIdx > -1 ? targetSignal.substring(dotIdx + 1) : targetSignal;
      const nodeIdStr = `ns=2;s=${safeName}.${targetSignal}`;

      try {
        const node = namespace.addVariable({
          componentOf:             parentNode,
          browseName:              leafName.replace(/[^a-zA-Z0-9_\-]/g, '_'),
          displayName:             leafName,
          nodeId:                  `s=${safeName}.${targetSignal}`,
          dataType,
          minimumSamplingInterval: 1000,
          accessLevel:             makeAccessLevelFlag('CurrentRead'),
          userAccessLevel:         makeAccessLevelFlag('CurrentRead'),
          value: {
            get: () => {
              const raw     = liveValues.get(machine.id)?.get(targetSignal);
              const coerced = coerceValue(raw, dataType);
              return new Variant({ dataType, value: coerced !== null ? coerced : defaultValue(dataType) });
            }
          }
        });

        entry.signals.set(targetSignal, {
          node, dataType, targetSignal, nodeId: nodeIdStr,
          sourceAddress: mapping.source_address,
          mappingType:   mapping.mapping_type,
          expression:    mapping.expression,
          lookupTable:   mapping.lookup_table
        });
        console.log(`[OPC UA]   + ${machine.name}.${targetSignal} ← ${mapping.source_address || '(expr)'}`);
      } catch (err) {
        console.warn(`[OPC UA] Could not create node ${nodeIdStr}: ${err.message}`);
      }
    }
  }
}

// ─── PLC value polling ────────────────────────────────────────

async function pollAll() {
  let machines = [];
  try {
    machines = await httpGet(`${BACKEND_URL}/api/machines`);
  } catch (err) {
    console.warn('[OPC UA] Could not fetch machines:', err.message);
    return;
  }

  if (addressSpace) await syncAddressSpace(machines);

  const now = Date.now();

  for (const machine of machines) {
    const h = getHealth(machine.id);

    if (h.phase === 'online') {
      // ── Normal poll — machine is green ───────────────────────
      const entry = machineRegistry.get(machine.id);
      if (!entry || entry.signals.size === 0) continue;
      try {
        await pollMachine(machine);
      } catch (_) {
        // Poll failed → drop back to probe
        h.phase = 'probe';
        h.attempts = 0;
        h.nextAttemptAt = now + PROBE_INTERVAL_MS;
        pushStatus(machine.id, 'connecting');
        console.log(`[health] ${machine.name} → probe (poll error)`);
      }

    } else if (h.phase === 'probe') {
      // ── Probe phase — yellow, 3 attempts × 5 s ───────────────
      if (now < h.nextAttemptAt) continue;

      const ok = await tcpPing(machine.host, connectorPort(machine), 4000);
      if (ok) {
        h.phase    = 'online';
        h.attempts = 0;
        pushStatus(machine.id, 'connected');
        console.log(`[health] ${machine.name} → online`);
      } else {
        h.attempts++;
        if (h.attempts >= PROBE_ATTEMPTS) {
          h.phase    = 'offline';
          h.attempts = 0;
          h.nextAttemptAt = now + OFFLINE_WAIT_MS;
          pushStatus(machine.id, 'disconnected');
          console.log(`[health] ${machine.name} → offline (retry in 1 h)`);
        } else {
          h.nextAttemptAt = now + PROBE_INTERVAL_MS;
          pushStatus(machine.id, 'connecting');
          console.log(`[health] ${machine.name} probe ${h.attempts}/${PROBE_ATTEMPTS} failed`);
        }
      }

    } else if (h.phase === 'offline') {
      // ── Offline — red, retry every 1 h (3 × 60 s) ───────────
      if (now < h.nextAttemptAt) continue;

      const ok = await tcpPing(machine.host, connectorPort(machine), 4000);
      if (ok) {
        h.phase    = 'online';
        h.attempts = 0;
        pushStatus(machine.id, 'connected');
        console.log(`[health] ${machine.name} → online (recovered)`);
      } else {
        h.attempts++;
        if (h.attempts >= RETRY_ATTEMPTS) {
          h.attempts = 0;
          h.nextAttemptAt = now + OFFLINE_WAIT_MS;
          console.log(`[health] ${machine.name} retry failed — next attempt in 1 h`);
        } else {
          h.nextAttemptAt = now + RETRY_INTERVAL_MS;
          console.log(`[health] ${machine.name} retry ${h.attempts}/${RETRY_ATTEMPTS} failed`);
        }
      }
    }
  }
}

const POLL_BATCH_SIZE = 50; // max addresses per /read call

async function pollMachine(machine) {
  const entry = machineRegistry.get(machine.id);
  if (!entry) return;

  // Build read list from cached registry (no extra HTTP call needed)
  const dtByAddr    = {};  // sourceAddr → PLC type string
  const directByAddr = {}; // sourceAddr → [targetSignal, ...]
  const exprSignals  = [];

  // Collect ALL addresses needed from ALL mapping types
  for (const [, sigEntry] of entry.signals) {
    if (sigEntry.isFolder) continue;
    const allText = (sigEntry.sourceAddress || '') + ' ' + (sigEntry.expression || '') + ' ' + JSON.stringify(sigEntry.lookupTable || '');
    const addrs = allText.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g) || [];
    for (const addr of addrs) {
      if (!dtByAddr[addr]) dtByAddr[addr] = dtMap[sigEntry.dataType] || 'REAL';
    }
    if (sigEntry.sourceAddress) {
      dtByAddr[sigEntry.sourceAddress] = dtMap[sigEntry.dataType] || 'REAL';
      if (!directByAddr[sigEntry.sourceAddress]) directByAddr[sigEntry.sourceAddress] = [];
      directByAddr[sigEntry.sourceAddress].push(sigEntry.targetSignal);
    }
    if (sigEntry.expression || sigEntry.lookupTable) {
      exprSignals.push(sigEntry);
    }
  }

  const uniqueAddresses = [...new Set([...Object.keys(directByAddr), ...Object.keys(dtByAddr)])];
  if (!uniqueAddresses.length) return;

  const machineCache = liveValues.get(machine.id) || new Map();
  const rawValues    = {};

  for (let i = 0; i < uniqueAddresses.length; i += POLL_BATCH_SIZE) {
    const batch = uniqueAddresses.slice(i, i + POLL_BATCH_SIZE);
    try {
      const values = await readPlcValues(machine, batch, dtByAddr);
      Object.assign(rawValues, values);
    } catch (_) {}
  }

  // Apply direct-only mappings (no expression)
  for (const [addr, targets] of Object.entries(directByAddr)) {
    const val = rawValues[addr];
    if (val !== undefined && val !== null) {
      for (const target of targets) {
        // Only set if there's no expression override for this target
        const hasExpr = exprSignals.some(s => s.targetSignal === target);
        if (!hasExpr) machineCache.set(target, val);
      }
    }
  }

  // Apply ALL expression/lookup/calculated mappings via unified engine
  const { evaluate } = require('./expression-engine');
  for (const sigEntry of exprSignals) {
    try {
      const expr = sigEntry.expression || sigEntry.sourceAddress;
      if (!expr) continue;
      const val = evaluate(expr, rawValues);
      if (val !== undefined && val !== null) machineCache.set(sigEntry.targetSignal, val);
    } catch (_) {}
  }

  liveValues.set(machine.id, machineCache);
  broadcastToStreams(machine.id);
}

// ─── SSE broadcast ────────────────────────────────────────────

function getMachineSnapshot(machineId) {
  const entry = machineRegistry.get(machineId);
  if (!entry) return [];
  const cache = liveValues.get(machineId) || new Map();
  const signals = [];
  for (const [, sigEntry] of entry.signals) {
    if (sigEntry.isFolder) continue;
    signals.push({
      name:   sigEntry.targetSignal,  // e.g. "machine_producing" or "Communication.Heartbeat"
      nodeId: sigEntry.nodeId,
      value:  cache.get(sigEntry.targetSignal) ?? null
    });
  }
  return signals;
}

function broadcastToStreams(machineId) {
  const streams = activeStreams.get(machineId);
  if (!streams || streams.size === 0) return;
  const payload = JSON.stringify({
    type:      'update',
    timestamp: new Date().toISOString(),
    signals:   getMachineSnapshot(machineId)
  });
  for (const res of streams) {
    try { res.write(`data: ${payload}\n\n`); } catch (_) {}
  }
}

// ─── PLC connector reads ──────────────────────────────────────

async function readPlcValues(machine, addresses, typeByAddress) {
  const values = {};

  if (machine.connector === 'siemens-s7') {
    const tags = {};
    for (const addr of addresses) {
      tags[addr] = convertToNodes7Address(addr, (typeByAddress || {})[addr]);
    }
    try {
      const result = await httpPost(`${SIEMENS_S7_URL}/read`, {
        host: machine.host,
        rack: machine.rack,
        slot: machine.slot,
        tags
      });
      if (result.values) Object.assign(values, result.values);
    } catch (_) { /* connector unavailable */ }

  } else if (machine.connector === 'rockwell') {
    for (const addr of addresses) {
      try {
        const result = await httpGet(
          `${ROCKWELL_URL}/read?ip=${encodeURIComponent(machine.host)}&slot=${machine.slot || 0}&tag=${encodeURIComponent(addr)}`
        );
        if (result.value !== undefined) values[addr] = result.value;
      } catch (_) {}
    }
  }

  return values;
}

function convertToNodes7Address(address, signalType) {
  const match = address.match(/^DB(\d+)\.DB([XBWD])(\d+(?:\.\d+)?)$/);
  if (!match) return address;
  const [, db, sizeChar, offset] = match;
  const st = (signalType || '').toUpperCase();
  let t;
  switch (sizeChar) {
    case 'X': t = 'X'; break;
    case 'B': t = 'BYTE'; break;
    case 'W': t = (st === 'WORD' || st === 'UINT') ? 'W' : 'INT'; break;
    case 'D': t = (st === 'DINT' || st === 'TIME') ? 'DI' : st === 'DWORD' ? 'DW' : 'REAL'; break;
    default:  t = sizeChar;
  }
  return `DB${db},${t}${offset}`;
}

// evaluateExpression replaced by unified expression-engine.js (./expression-engine)

// ─── HTTP helpers ─────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function httpPost(url, body) {
  const u       = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname,
      method:   'POST',
      timeout:  8000,
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from POST ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: POST ${url}`)); });
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP API (REST + SSE for web explorer) ───────────────────

function startHttpServer() {
  const app = express();

  // CORS for nginx proxy
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });

  // GET /structure  — full address space snapshot (machines + signals + current values)
  app.get('/structure', (req, res) => {
    const result = [];
    for (const [machineId, entry] of machineRegistry) {
      if (!entry.folder) continue;
      const safeName = entry.machine.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
      result.push({
        id:       machineId,
        name:     entry.machine.name,
        safeName,
        nodeId:   `ns=2;s=${safeName}`,
        status:   entry.machine.status,
        signals:  getMachineSnapshot(machineId)
      });
    }
    res.json(result);
  });

  // GET /values?machine=<safeName>  — snapshot for one machine
  app.get('/values', (req, res) => {
    const target = req.query.machine;
    for (const [machineId, entry] of machineRegistry) {
      const safeName = entry.machine.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
      if (safeName === target) {
        return res.json({ id: machineId, name: entry.machine.name, safeName, signals: getMachineSnapshot(machineId) });
      }
    }
    res.status(404).json({ error: 'Machine not found' });
  });

  // GET /stream?machine=<safeName>  — SSE, pushes updates while client is connected
  app.get('/stream', (req, res) => {
    const target = req.query.machine;
    let machineId = null;
    for (const [id, entry] of machineRegistry) {
      const safeName = entry.machine.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
      if (safeName === target) { machineId = id; break; }
    }

    // SSE headers — disable nginx buffering via header hint
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');  // nginx: disable proxy buffering for SSE
    res.flushHeaders();

    if (machineId === null) {
      res.write('event: error\ndata: Machine not found\n\n');
      res.end();
      return;
    }

    // Send initial snapshot immediately
    const snapshot = JSON.stringify({ type: 'snapshot', timestamp: new Date().toISOString(), signals: getMachineSnapshot(machineId) });
    res.write(`data: ${snapshot}\n\n`);

    // Register client
    if (!activeStreams.has(machineId)) activeStreams.set(machineId, new Set());
    activeStreams.get(machineId).add(res);
    console.log(`[HTTP] SSE client connected for machine ${machineId} (total: ${activeStreams.get(machineId).size})`);

    // Heartbeat every 30s to keep connection alive through proxies
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      activeStreams.get(machineId)?.delete(res);
      if (activeStreams.get(machineId)?.size === 0) activeStreams.delete(machineId);
      console.log(`[HTTP] SSE client disconnected for machine ${machineId}`);
    });
  });

  app.get('/healthz', (req, res) => res.json({ status: 'ok', machines: machineRegistry.size }));

  app.listen(HTTP_PORT, () => {
    console.log(`[HTTP] OPC UA Explorer API running on port ${HTTP_PORT}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('CT-Gate OPC UA Server starting...');
  console.log(`  Backend : ${BACKEND_URL}`);
  console.log(`  S7 conn : ${SIEMENS_S7_URL}`);
  console.log(`  Poll    : ${POLL_INTERVAL}ms`);
  console.log(`  Port    : ${OPC_PORT}`);

  const server = new OPCUAServer({
    port:         OPC_PORT,
    resourcePath: '/UA/CTGate',
    buildInfo: {
      productName: 'CT-Gate OPC UA Server',
      buildNumber: '1',
      buildDate:   new Date()
    },
    serverInfo: {
      applicationName: { text: 'CT-Gate' },
      applicationUri:  'urn:ct-gate:opcua:server'
    }
  });

  await server.initialize();

  addressSpace = server.engine.addressSpace;
  namespace    = addressSpace.getOwnNamespace();

  await server.start();

  const endpointUrl = server.getEndpointUrl();
  console.log(`[OPC UA] Server running at: ${endpointUrl}`);
  console.log('[OPC UA] Connect with any OPC UA client using:');
  console.log(`         opc.tcp://<host>:${OPC_PORT}/UA/CTGate`);
  console.log('[OPC UA] NodeId format: ns=2;s=<MachineName>.<Category>.<SignalName>');

  // Start HTTP API for web explorer (REST + SSE)
  startHttpServer();

  // Polling loop
  while (true) {
    try {
      await pollAll();
    } catch (err) {
      console.error('[OPC UA] Poll cycle error:', err.message);
    }
    await sleep(POLL_INTERVAL);
  }
}

main().catch(err => {
  console.error('[OPC UA] Fatal error:', err);
  process.exit(1);
});
