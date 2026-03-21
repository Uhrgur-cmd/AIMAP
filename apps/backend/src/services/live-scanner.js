const http = require('http');

/**
 * Scan a PLC live using the connector microservices.
 * Returns unified signal array.
 */
async function scanLive(machine, onProgress, startDb = 1, endDb = 100) {
  const connectorUrl = getConnectorUrl(machine);

  switch (machine.connector) {
    case 'siemens-s7':
      return scanSiemensS7(connectorUrl, machine, onProgress, startDb, endDb);
    case 'siemens-opcua':
      return scanSiemensOpcua(connectorUrl, machine, onProgress);
    case 'rockwell':
      return scanRockwell(connectorUrl, machine, onProgress);
    default:
      throw new Error(`Unknown connector: ${machine.connector}`);
  }
}

function getConnectorUrl(machine) {
  switch (machine.connector) {
    case 'siemens-s7':
      return process.env.SIEMENS_S7_URL || 'http://localhost:8300';
    case 'siemens-opcua':
      return process.env.SIEMENS_OPCUA_URL || 'http://localhost:8200';
    case 'rockwell':
      return process.env.ROCKWELL_URL || 'http://localhost:8100';
  }
}

/**
 * Scan S7 classic – scan DBs 1-100 using heuristic scanner.
 */
async function scanSiemensS7(baseUrl, machine, onProgress, startDb = 1, endDb = 100) {
  const signals = [];

  for (let db = startDb; db <= endDb; db++) {
    onProgress?.({ db, total: endDb, found: signals.length });
    try {
      const result = await httpPost(`${baseUrl}/scan`, {
        host: machine.host,
        rack: machine.rack,
        slot: machine.slot,
        db: db,
        maxOffset: 256,
        throttleMs: 150
      });

      if (result.findings && result.findings.length > 0) {
        for (const finding of result.findings) {
          let address, dataType;
          switch (finding.type) {
            case 'REAL':
              address = `DB${db}.DBD${finding.offset}`;
              dataType = 'REAL';
              break;
            case 'INT':
              address = `DB${db}.DBW${finding.offset}`;
              dataType = 'INT';
              break;
            case 'BOOL':
              address = finding.address || `DB${db}.DBX${finding.offset || 0}.0`;
              dataType = 'BOOL';
              break;
            default:
              address = `DB${db}.DBB${finding.offset}`;
              dataType = finding.type;
          }

          signals.push({
            name: `DB${db}_${finding.type}_${finding.offset !== undefined ? finding.offset : ''}`,
            address: finding.address || address,
            data_type: dataType,
            comment: finding.text || null
          });
        }
      }
    } catch (e) {
      if (!e.message.includes('ECONNREFUSED')) continue;
      throw e;
    }
  }

  return signals;
}

/**
 * Browse S7-1200/1500 via OPC UA.
 */
async function scanSiemensOpcua(baseUrl, machine, onProgress) {
  const signals = [];
  const endpoint = `opc.tcp://${machine.host}:4840`;
  onProgress?.({ db: 0, total: 0, found: 0, label: 'Browsing OPC UA...' });

  const root = await httpGet(`${baseUrl}/browse`, {
    endpoint: endpoint,
    nodeId: 'ObjectsFolder'
  });

  if (!root.children) return signals;

  for (const child of root.children) {
    if (child.nodeClass === 'Variable') {
      signals.push({
        name: child.browseName,
        address: child.nodeId,
        data_type: 'Unknown',
        comment: null
      });
    } else if (child.nodeClass === 'Object') {
      try {
        const sub = await httpGet(`${baseUrl}/browse`, {
          endpoint: endpoint,
          nodeId: child.nodeId
        });
        if (sub.children) {
          for (const subChild of sub.children) {
            if (subChild.nodeClass === 'Variable') {
              signals.push({
                name: `${child.browseName}.${subChild.browseName}`,
                address: subChild.nodeId,
                data_type: 'Unknown',
                comment: null
              });
            }
          }
        }
      } catch (e) { /* skip */ }
    }
  }

  return signals;
}

/**
 * Discover Rockwell tags via EtherNet/IP.
 */
async function scanRockwell(baseUrl, machine, onProgress) {
  onProgress?.({ db: 0, total: 0, found: 0, label: 'Reading EtherNet/IP tags...' });
  const result = await httpGet(`${baseUrl}/tags`, {
    ip: machine.host,
    slot: machine.slot || 0
  });

  const signals = [];
  if (result.properties) {
    for (const [name, info] of Object.entries(result.properties)) {
      signals.push({
        name: name,
        address: name,
        data_type: info.type || 'Unknown',
        comment: null
      });
    }
  }

  return signals;
}

// ─── HTTP helpers ────────────────────────────────────────────

function httpGet(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Promise((resolve, reject) => {
    http.get(url.toString(), { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  const parsed = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { scanLive };
