/**
 * Collector Service – Continuously reads mapped PLC signals and outputs normalized data.
 *
 * Flow per machine:
 * 1. Fetch mappings from backend API
 * 2. Read required PLC signal values via connectors
 * 3. Evaluate mapping expressions
 * 4. Write normalized data to output (MQTT / REST / stdout)
 */

const http = require('http');
// Expression evaluation via unified ./expression-engine
require('dotenv').config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '1000'); // ms
const MQTT_BROKER = process.env.MQTT_BROKER;


let mqttClient = null;

async function main() {
  console.log('AIMAP Collector starting...');
  console.log(`Backend: ${BACKEND_URL}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);

  // Optional: connect to MQTT
  if (MQTT_BROKER) {
    try {
      const mqtt = require('mqtt');
      mqttClient = mqtt.connect(MQTT_BROKER);
      mqttClient.on('connect', () => console.log(`Connected to MQTT: ${MQTT_BROKER}`));
      mqttClient.on('error', (err) => console.error('MQTT error:', err.message));
    } catch (e) {
      console.warn('MQTT not available, will output to stdout');
    }
  }

  // Main loop
  while (true) {
    try {
      await collectAll();
    } catch (err) {
      console.error('Collection cycle error:', err.message);
    }
    await sleep(POLL_INTERVAL);
  }
}

async function collectAll() {
  // Get all machines
  const machines = await httpGet(`${BACKEND_URL}/api/machines`);

  for (const machine of machines) {
    if (machine.status !== 'connected') continue;

    try {
      await collectMachine(machine);
    } catch (err) {
      console.error(`Error collecting ${machine.name}:`, err.message);
    }
  }
}

async function collectMachine(machine) {
  // Get mappings for this machine
  const mappings = await httpGet(`${BACKEND_URL}/api/mappings/machine/${machine.id}`);
  if (!mappings.length) return;

  // Get signal type info so we can read DBD as the correct type (REAL vs DINT vs DWORD)
  const signalTypes = await httpGet(`${BACKEND_URL}/api/signals/machine/${machine.id}`);
  const typeByAddress = {};
  for (const s of signalTypes) {
    typeByAddress[s.address] = s.data_type;
  }

  // Determine which PLC addresses we need to read
  const addressesNeeded = new Set();
  for (const mapping of mappings) {
    if (mapping.mapping_type === 'direct' && mapping.source_address) {
      addressesNeeded.add(mapping.source_address);
    }
    if (mapping.expression) {
      const matches = mapping.expression.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?/g) || [];
      matches.forEach(a => addressesNeeded.add(a));
    }
    // Also collect addresses from lookup source
    if (mapping.mapping_type === 'lookup' && mapping.source_address) {
      addressesNeeded.add(mapping.source_address);
    }
  }

  if (!addressesNeeded.size) return;

  // Read values from PLC via connector (pass type info for correct S7 reads)
  const values = await readPlcValues(machine, [...addressesNeeded], typeByAddress);

  // Evaluate each mapping using unified SCL expression engine
  const { evaluate } = require('./expression-engine');
  const timestamp = new Date().toISOString();
  for (const mapping of mappings) {
    try {
      // Unified evaluation: expression field contains SCL for ALL types
      // (direct, expression, calculated, lookup/IF-THEN)
      const expr = mapping.expression || mapping.source_address;
      if (!expr) continue;
      const value = evaluate(expr, values);

      if (value !== undefined) {
        const output = {
          timestamp,
          machine_id: machine.id,
          machine_name: machine.name,
          signal: mapping.target_signal,
          value,
          raw_sources: Object.fromEntries(
            [...addressesNeeded]
              .filter(a => mapping.expression?.includes(a) || mapping.source_address === a)
              .map(a => [a, values[a]])
          )
        };

        emitOutput(machine, mapping.target_signal, output);
      }
    } catch (err) {
      // Skip failed evaluations silently
    }
  }
}

async function readPlcValues(machine, addresses, typeByAddress) {
  const connectorUrl = getConnectorUrl(machine.connector);
  const values = {};

  if (machine.connector === 'siemens-s7') {
    // Build tags object for batch read
    const tags = {};
    for (const addr of addresses) {
      // Convert DB10.DBD0 → DB10,REAL0 format for nodes7 (type-aware)
      const signalType = (typeByAddress || {})[addr] || null;
      const converted = convertToNodes7Address(addr, signalType);
      tags[addr] = converted;
    }

    const result = await httpPost(`${connectorUrl}/read`, {
      host: machine.host,
      rack: machine.rack,
      slot: machine.slot,
      tags
    });

    if (result.values) {
      Object.assign(values, result.values);
    }
  } else if (machine.connector === 'siemens-opcua') {
    // OPC UA: read each address individually
    const endpoint = `opc.tcp://${machine.host}:4840`;
    for (const addr of addresses) {
      try {
        const result = await httpGet(`${connectorUrl}/read`, {
          endpoint,
          nodeId: addr
        });
        if (result.value !== undefined) values[addr] = result.value;
      } catch (e) { /* skip */ }
    }
  } else if (machine.connector === 'rockwell') {
    // Rockwell: read each tag
    for (const addr of addresses) {
      try {
        const result = await httpGet(`${connectorUrl}/read`, {
          ip: machine.host,
          slot: machine.slot || 0,
          tag: addr
        });
        if (result.value !== undefined) values[addr] = result.value;
      } catch (e) { /* skip */ }
    }
  }

  return values;
}

/**
 * Convert standard S7 address to nodes7 format, using the known signal data type
 * to correctly distinguish DBD reads (REAL vs DINT vs DWORD vs TIME).
 *
 * Without type info, DBD defaults to REAL (legacy behavior).
 * With type info from the parser/DB, we map correctly:
 *   REAL  → DB10,REAL0
 *   DINT  → DB10,DI0
 *   DWORD → DB10,DW0
 *   TIME  → DB10,DI0  (TIME is stored as DINT ms internally)
 *
 * DBW: INT (default) vs WORD
 *   INT  → DB10,INT4
 *   WORD → DB10,W4
 *   UINT → DB10,W4
 */
function convertToNodes7Address(address, signalType) {
  const match = address.match(/^DB(\d+)\.DB([XBWD])(\d+(?:\.\d+)?)$/);
  if (!match) return address;

  const [, db, sizeChar, offset] = match;
  const st = (signalType || '').toUpperCase();

  let nodes7Type;
  switch (sizeChar) {
    case 'X':
      nodes7Type = 'X';
      break;
    case 'B':
      nodes7Type = 'BYTE';
      break;
    case 'W':
      if (st === 'WORD' || st === 'UINT') nodes7Type = 'W';
      else nodes7Type = 'INT'; // INT is default for DBW
      break;
    case 'D':
      if (st === 'DINT' || st === 'TIME' || st === 'DATE_AND_TIME') nodes7Type = 'DI';
      else if (st === 'DWORD') nodes7Type = 'DW';
      else nodes7Type = 'REAL'; // REAL is default for DBD
      break;
    default:
      nodes7Type = sizeChar;
  }

  return `DB${db},${nodes7Type}${offset}`;
}

// evaluateExpression replaced by unified expression-engine.js (./expression-engine)

function getConnectorUrl(connector) {
  switch (connector) {
    case 'siemens-s7': return process.env.SIEMENS_S7_URL || 'http://localhost:8300';
    case 'siemens-opcua': return process.env.SIEMENS_OPCUA_URL || 'http://localhost:8200';
    case 'rockwell': return process.env.ROCKWELL_URL || 'http://localhost:8100';
  }
}

function emitOutput(machine, signalName, output) {
  if (mqttClient?.connected) {
    const topic = `plant/default/machine/${machine.id}/std/${signalName}`;
    mqttClient.publish(topic, JSON.stringify(output));
  } else {
    // Fallback: log to stdout
    console.log(JSON.stringify(output));
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function httpGet(url, params) {
  const u = new URL(url);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Promise((resolve, reject) => {
    http.get(u.toString(), { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  const u = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST', timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
