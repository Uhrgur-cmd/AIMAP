const http = require('http');
const https = require('https');
const pool = require('../db/pool');
const { buildCrossReference } = require('./cross-reference');
const { CTBASE_RULES } = require('./ctbase-rules');

const AI_PROVIDER = process.env.AI_PROVIDER || 'ollama';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

async function suggestMappingsBatchwise(machineId, onProgress) {
  onProgress({ status: 'running', progress: 0, total: 1, mapped: 0, currentGroup: 'Building cross-reference...' });

  const { signalProfiles, stats } = await buildCrossReference(machineId);
  console.log(`Cross-ref: ${stats.totalSignals} signals, ${stats.withWriters} writers, ${stats.withDependencies} deps`);

  const signalContext = buildCompactContext(signalProfiles);
  console.log(`Context: ${signalContext.length} chars ≈ ${Math.round(signalContext.length / 4)} tokens`);

  const { rows: models } = await pool.query('SELECT * FROM datamodel ORDER BY created_at DESC LIMIT 1');
  if (!models.length) throw new Error('No data model defined');
  const { rows: targetSignals } = await pool.query(
    'SELECT * FROM datamodel_signals WHERE datamodel_id = $1 ORDER BY sort_order', [models[0].id]
  );

  // Split: Phase 1 = BOOL/INT/REAL, Phase 2 = STRING (lookups)
  const phase1Targets = targetSignals.filter(t => !['STRING', 'CHAR'].includes((t.data_type || '').toUpperCase()));
  const phase2Targets = targetSignals.filter(t => ['STRING', 'CHAR'].includes((t.data_type || '').toUpperCase()));
  console.log(`Phase 1: ${phase1Targets.length} | Phase 2: ${phase2Targets.length} STRING lookups`);

  const provider = (AI_PROVIDER === 'openai' && OPENAI_API_KEY) ? 'openai'
    : (AI_PROVIDER === 'anthropic' && ANTHROPIC_API_KEY) ? 'anthropic' : 'ollama';

  // Phase 1
  const p1Count = await runPhase1(provider, machineId, signalContext, phase1Targets, onProgress);

  // Phase 2
  if (phase2Targets.length > 0) {
    const { rows: p1Results } = await pool.query(
      'SELECT target_signal, source_address, expression FROM mappings WHERE machine_id = $1', [machineId]
    );
    await runPhase2(provider, machineId, signalContext, phase2Targets, p1Results, p1Count, onProgress);
  }

  const { rows: [{ c }] } = await pool.query('SELECT COUNT(*) as c FROM mappings WHERE machine_id = $1', [machineId]);
  onProgress({ status: 'done', progress: 100, total: 100, mapped: parseInt(c), currentGroup: '' });
  console.log(`Done: ${c}/${targetSignals.length} mapped.`);
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: BOOL / INT / REAL
// ═══════════════════════════════════════════════════════════════

async function runPhase1(provider, machineId, signalContext, targets, onProgress) {
  const BATCH = provider === 'ollama' ? 5 : 20;
  const batches = [];
  for (let i = 0; i < targets.length; i += BATCH) batches.push(targets.slice(i, i + BATCH));

  let mapped = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const group = 'Phase 1: ' + batch.map(t => t.name.split('.').pop()).join(', ');
    onProgress({ status: 'running', progress: bi, total: batches.length + 1, mapped, currentGroup: group });

    const list = batch.map(t => `"${t.name}" [${t.data_type}${t.unit ? ', ' + t.unit : ''}]: ${t.description || ''}`).join('\n');

    const prompt = `Du bist ein erfahrener SPS-Ingenieur. Finde für jedes Ziel-Signal das passende PLC-Signal.

ZIEL-SIGNALE (${batch.length}):
${list}

CTBASE MAPPING-REGELN:
${CTBASE_RULES}

ANALYSIERTES SPS-PROGRAMM:
${signalContext}

REGELN:
1. DATENTYPEN MÜSSEN PASSEN: BOOL→BOOL/expression, INT→INT/WORD, REAL→REAL
2. Nutze Abhängigkeiten (← [...]) um zu verstehen was ein Signal WIRKLICH tut
3. Bei mehreren gleichartigen Signalen (z.B. Schutztüren): OR-Verknüpfung als "expression"
4. Wenn NICHTS passt → WEGLASSEN. Nicht raten!
5. Verwende exakte PLC-Adressen (z.B. DB15.DBX0.3, DB49.DBX143.0)

JSON Array:
[{"target":"Name","source":"Adresse","type":"direct","confidence":0.9,"reason":"Begründung"}]
oder [{"target":"Name","expression":"DB15.DBX0.3 OR DB15.DBX10.3","type":"expression","confidence":0.9,"reason":"..."}]
oder []`;

    try {
      console.log(`P1 ${bi + 1}/${batches.length}`);
      const resp = await callProvider(provider, prompt);
      const sug = parseResponse(resp, machineId, batch);
      for (const m of sug) {
        await pool.query(
          `INSERT INTO mappings (machine_id,target_signal,mapping_type,source_address,expression,confidence,validated_by_human,reasoning)
           VALUES ($1,$2,$3,$4,$5,$6,false,$7)
           ON CONFLICT (machine_id,target_signal) DO UPDATE SET
             mapping_type=EXCLUDED.mapping_type,source_address=EXCLUDED.source_address,
             expression=EXCLUDED.expression,confidence=EXCLUDED.confidence,reasoning=EXCLUDED.reasoning`,
          [machineId, m.target_signal, m.mapping_type, m.source_address, m.expression, m.confidence, m.reasoning]
        );
        mapped++;
      }
      console.log(`  → ${sug.length} mapped`);
    } catch (err) {
      console.error(`  P1 batch ${bi + 1} failed: ${err.message}`);
    }
  }
  return mapped;
}

// ═══════════════════════════════════════════════════════════════
// Phase 2: STRING lookups with real addresses from Phase 1
// ═══════════════════════════════════════════════════════════════

async function runPhase2(provider, machineId, signalContext, stringTargets, phase1Results, p1Count, onProgress) {
  onProgress({ status: 'running', progress: 95, total: 100, mapped: p1Count, currentGroup: 'Phase 2: STRING lookups...' });

  const p1Summary = phase1Results.map(m => `${m.target_signal} = ${m.source_address || m.expression || '?'}`).join('\n');
  const list = stringTargets.map(t => `"${t.name}" [STRING]: ${t.description || ''}`).join('\n');

  const prompt = `Du bist ein SPS-Ingenieur. Erstelle LOOKUP-Tabellen für STRING-Ziel-Signale.

BEREITS GEMAPPTE SIGNALE (Phase 1 – verwende diese PLC-Adressen in den Bedingungen!):
${p1Summary}

STRING ZIEL-SIGNALE:
${list}

CTBASE REGELN:
${CTBASE_RULES}

PLC-SIGNALE:
${signalContext}

LOOKUP FORMAT:
Jeder Key in lookup_table ist eine EXPRESSION mit ECHTEN PLC-Adressen die TRUE/FALSE ergibt.
Der Value ist der STRING der dann gesetzt wird.
Bedingungen werden in Reihenfolge ausgewertet – erste TRUE gewinnt.
"DEFAULT" = Fallback wenn nichts passt.

BEISPIEL:
[{
  "target": "Machine.MachineryItemState",
  "type": "lookup",
  "lookup_table": {
    "DB15.DBX0.3 OR DB15.DBX10.3": "Out of Service",
    "DB15.DBX0.2 AND DB49.DBX49.0 AND NOT DB15.DBX0.3": "Executing",
    "DB15.DBX0.0 AND NOT DB49.DBX49.0": "Not Executing",
    "DEFAULT": "Not available"
  },
  "confidence": 0.85,
  "reason": "Priorität: Fehler→OutOfService, AutoProduziert→Executing, Ein→NotExecuting, sonst→NotAvailable"
}]

REGELN:
1. NUR echte PLC-Adressen in Bedingungen (DB15.DBX0.3 etc.), NICHT "ErrorActive" oder "calculated"
2. Verwende die Phase-1-Adressen: z.B. wenn ErrorActive = DB15.DBX0.3, dann schreibe DB15.DBX0.3
3. "DEFAULT" als letzten Key für den Fallback-Wert
4. Wenn kein sinnvoller Lookup möglich → WEGLASSEN
5. Nur STRING-Ziele die einen berechneten Wert brauchen (MachineryItemState, OperationMode, ErrorDescription etc.)
6. Statische Felder wie Manufacturer/SerialNumber → WEGLASSEN (werden nicht berechnet)

JSON Array oder []:`;

  try {
    console.log(`P2: ${stringTargets.length} STRING lookups`);
    const resp = await callProvider(provider, prompt);
    const sug = parseLookupResponse(resp, machineId, stringTargets);
    for (const m of sug) {
      await pool.query(
        `INSERT INTO mappings (machine_id,target_signal,mapping_type,source_address,expression,lookup_table,confidence,validated_by_human,reasoning)
         VALUES ($1,$2,'lookup',null,null,$3,$4,false,$5)
         ON CONFLICT (machine_id,target_signal) DO UPDATE SET
           mapping_type='lookup',source_address=null,expression=null,
           lookup_table=EXCLUDED.lookup_table,confidence=EXCLUDED.confidence,reasoning=EXCLUDED.reasoning`,
        [machineId, m.target_signal, JSON.stringify(m.lookup_table), m.confidence, m.reasoning]
      );
    }
    console.log(`  → ${sug.length} lookups`);
  } catch (err) {
    console.error(`  P2 failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Context builder
// ═══════════════════════════════════════════════════════════════

function buildCompactContext(profiles) {
  const inNets = profiles.filter(p => p.writtenBy.length > 0 || p.readBy.length > 0);
  const withComments = profiles.filter(p =>
    p.writtenBy.length === 0 && p.readBy.length === 0 && p.comment && !p.comment.startsWith('[name:')
  );

  let text = '';
  if (inNets.length > 0) {
    text += `--- SIGNALS WITH TRACED LOGIC (${inNets.length}) ---\n`;
    for (const p of inNets) {
      text += `${p.address} [${p.data_type || '?'}]`;
      if (p.name) text += ` "${p.name}"`;
      if (p.comment && !p.comment.startsWith('[name:')) text += ` // ${p.comment}`;
      if (p.dependsOn.length > 0) {
        const deps = p.dependsOn.slice(0, 8).map(d => {
          let s = d.address;
          if (d.comment && !d.comment.startsWith('[name:') && !d.comment.startsWith('Written in')) {
            s += '(' + d.comment.substring(0, 40) + ')';
          }
          return s;
        });
        text += ` ← [${deps.join(', ')}]`;
      } else if (p.writtenBy.length > 0) {
        text += ` ← written by ${p.writtenBy[0].block}`;
      }
      text += '\n';
    }
    text += '\n';
  }
  if (withComments.length > 0) {
    text += `--- SIGNALS WITH COMMENTS (${withComments.length}) ---\n`;
    for (const p of withComments) {
      text += `${p.address} [${p.data_type || '?'}]`;
      if (p.name) text += ` "${p.name}"`;
      if (p.comment) text += ` // ${p.comment}`;
      text += '\n';
    }
  }
  return text;
}

// ═══════════════════════════════════════════════════════════════
// Provider calls
// ═══════════════════════════════════════════════════════════════

async function callProvider(provider, prompt) {
  if (provider === 'openai') return callOpenAI(prompt);
  if (provider === 'anthropic') return callClaude(prompt);
  return callOllama(prompt);
}

async function callOpenAI(prompt) {
  const payload = JSON.stringify({
    model: OPENAI_MODEL, max_completion_tokens: 16384, temperature: 0.05,
    messages: [{ role: 'user', content: prompt }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST', timeout: 300000,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) reject(new Error(p.error.message));
          else resolve(p.choices[0].message.content);
        } catch (e) { reject(new Error('OpenAI parse: ' + data.slice(0, 300))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function callClaude(prompt) {
  const payload = JSON.stringify({
    model: 'claude-sonnet-4-20250514', max_tokens: 16384, temperature: 0.05,
    messages: [{ role: 'user', content: prompt }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 300000,
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) reject(new Error(p.error.message));
          else resolve(p.content[0].text);
        } catch (e) { reject(new Error('Claude parse: ' + data.slice(0, 300))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function callOllama(prompt) {
  const url = new URL('/api/generate', OLLAMA_URL);
  const payload = JSON.stringify({
    model: OLLAMA_MODEL, prompt, stream: false,
    options: { temperature: 0.05, top_p: 0.8, num_predict: 4096, num_ctx: 8192 }
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', timeout: 300000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) reject(new Error(p.error));
          else resolve(p.response);
        } catch (e) { reject(new Error('Ollama parse: ' + data.slice(0, 300))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// Response parsing
// ═══════════════════════════════════════════════════════════════

function parseResponse(response, machineId, validTargets) {
  let jsonStr = response.trim();
  if (jsonStr.includes('```')) {
    const m = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) jsonStr = m[1].trim();
  }
  const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrMatch) { console.warn('No JSON array:', response.slice(0, 200)); return []; }

  const validNames = new Set(validTargets.map(t => t.name));
  try {
    return JSON.parse(arrMatch[0])
      .filter(s => validNames.has(s.target) && (s.source || s.expression))
      .map(s => {
        let addr = s.source || s.source_address || null;
        let expr = s.expression || null;
        let mtype = s.type || 'direct';

        if (addr && addr.includes('|')) { expr = addr.replace(/\s*\|\s*/g, ' OR '); addr = null; mtype = 'expression'; }
        if (expr) expr = expr.replace(/\s*\|\s*/g, ' OR ');

        if (mtype === 'direct' && addr) {
          const matches = addr.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g);
          if (matches && matches.length > 1) { expr = matches.join(' OR '); addr = null; mtype = 'expression'; }
          else if (matches && matches.length === 1) addr = matches[0];
        }

        return {
          machine_id: machineId, target_signal: s.target, mapping_type: mtype,
          source_address: addr, expression: expr,
          confidence: s.confidence || 0.7, reasoning: s.reason || s.reasoning || null,
          validated_by_human: false
        };
      });
  } catch (e) { console.warn('JSON parse failed:', e.message); return []; }
}

function parseLookupResponse(response, machineId, validTargets) {
  let jsonStr = response.trim();
  if (jsonStr.includes('```')) {
    const m = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) jsonStr = m[1].trim();
  }
  const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrMatch) { console.warn('No JSON in lookup response:', response.slice(0, 200)); return []; }

  const validNames = new Set(validTargets.map(t => t.name));
  try {
    return JSON.parse(arrMatch[0])
      .filter(s => validNames.has(s.target) && s.lookup_table && typeof s.lookup_table === 'object')
      .map(s => ({
        machine_id: machineId, target_signal: s.target,
        lookup_table: s.lookup_table,
        confidence: s.confidence || 0.7, reasoning: s.reason || s.reasoning || null,
      }));
  } catch (e) { console.warn('Lookup parse failed:', e.message); return []; }
}

module.exports = { suggestMappingsBatchwise };
