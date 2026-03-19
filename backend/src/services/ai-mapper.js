const http = require('http');
const https = require('https');
const pool = require('../db/pool');

const AI_PROVIDER = process.env.AI_PROVIDER || 'ollama';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

/**
 * AI Mapping Service.
 *
 * For Claude (cloud): Send ALL signals + ALL targets in one call. Claude can handle it.
 * For Ollama (local): Batch into small groups with pre-filtering.
 */
async function suggestMappingsBatchwise(machineId, onProgress) {
  const { rows: signals } = await pool.query(
    'SELECT * FROM signals WHERE machine_id = $1 ORDER BY address', [machineId]
  );
  const { rows: networks } = await pool.query(
    'SELECT * FROM network_comments WHERE machine_id = $1 ORDER BY block_name, network_number', [machineId]
  );
  const { rows: models } = await pool.query('SELECT * FROM datamodel ORDER BY created_at DESC LIMIT 1');
  if (!models.length) throw new Error('No data model defined');

  const { rows: targetSignals } = await pool.query(
    'SELECT * FROM datamodel_signals WHERE datamodel_id = $1 ORDER BY sort_order', [models[0].id]
  );

  if (AI_PROVIDER === 'openai' && OPENAI_API_KEY) {
    return suggestWithOpenAI(machineId, signals, networks, targetSignals, onProgress);
  }
  if (AI_PROVIDER === 'anthropic' && ANTHROPIC_API_KEY) {
    return suggestWithClaude(machineId, signals, networks, targetSignals, onProgress);
  }
  return suggestWithOllama(machineId, signals, networks, targetSignals, onProgress);
}

// ═════════════════════════════════════════════════════════════
// OpenAI (GPT-5.4) – ALL signals, ALL networks, ALL targets, ONE call
// ═════════════════════════════════════════════════════════════

async function suggestWithOpenAI(machineId, signals, networks, targetSignals, onProgress) {
  // Build full context once – shared across all batches
  const signalList = signals.map(s =>
    `${s.address} [${s.data_type}] ${s.name || ''} ${s.comment ? '// ' + s.comment : ''}`
  ).join('\n');

  const networkList = networks.map(n => {
    let entry = `${n.block_name} NW${n.network_number}: ${n.comment || ''}`;
    if (n.signals_referenced?.length) entry += ` [refs: ${n.signals_referenced.slice(0, 5).join(', ')}]`;
    if (n.logic) entry += ` Logic: ${n.logic}`;
    return entry;
  }).join('\n');

  // 5 targets per call – model sees ALL signals but focuses on 5 targets
  const BATCH_SIZE = 5;
  const batches = [];
  for (let i = 0; i < targetSignals.length; i += BATCH_SIZE) {
    batches.push(targetSignals.slice(i, i + BATCH_SIZE));
  }

  let totalMapped = 0;
  onProgress({ status: 'running', progress: 0, total: batches.length, mapped: 0, currentGroup: 'Starting...' });

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const group = batch.map(t => t.name.split('.').pop()).join(', ');

    onProgress({ status: 'running', progress: bi, total: batches.length, mapped: totalMapped, currentGroup: group });

    const targetList = batch.map(t =>
      `"${t.name}" [${t.data_type}${t.unit ? ', ' + t.unit : ''}]: ${t.description || ''}`
    ).join('\n');

    const prompt = `Du bist ein erfahrener SPS-Ingenieur. Analysiere dieses SPS-Programm und finde für JEDES der folgenden ${batch.length} Ziel-Signale das passende PLC-Signal.

ZIEL-SIGNALE (finde für jedes das passende PLC-Signal):
${targetList}

ALLE PLC-SIGNALE (${signals.length} – durchsuche ALLE):
${signalList}

ALLE NETZWERK-KOMMENTARE (${networks.length} – FBs, FCs, OBs):
${networkList}

REGELN:
- Zuordnung muss SEMANTISCH passen (Name/Kommentar → Bedeutung des Ziels)
- SPS implementiert möglicherweise CTBase – suche nach HeartbeatUp, CycleIsRunning, Producing, RecipeID, JobName, TraceId etc.
- "direct" = 1:1, "expression" = kombiniert (AND/OR)
- Wenn NICHTS passt → WEGLASSEN. NICHT raten!
- Datentypen müssen passen (BOOL→BOOL, INT→INT/WORD, REAL→REAL)
- Verwende PLC-Adressen als source (z.B. DB2.DBX0.0, I1000.7)

NUR JSON Array, kein anderer Text:
[{"target": "Zielname", "source": "PLC-Adresse", "type": "direct", "confidence": 0.9, "reason": "warum"}]
oder [] wenn nichts passt.`;

    try {
      console.log(`OpenAI batch ${bi + 1}/${batches.length}: ${group}`);
      const response = await callOpenAI(prompt);
      const suggestions = parseResponse(response, machineId, batch);

      for (const m of suggestions) {
        await pool.query(
          `INSERT INTO mappings (machine_id, target_signal, mapping_type, source_address, expression, confidence, validated_by_human, reasoning)
           VALUES ($1, $2, $3, $4, $5, $6, false, $7)
           ON CONFLICT (machine_id, target_signal) DO UPDATE SET
             mapping_type = EXCLUDED.mapping_type, source_address = EXCLUDED.source_address,
             expression = EXCLUDED.expression, confidence = EXCLUDED.confidence, reasoning = EXCLUDED.reasoning`,
          [machineId, m.target_signal, m.mapping_type, m.source_address, m.expression, m.confidence, m.reasoning]
        );
        totalMapped++;
      }
      console.log(`  → ${suggestions.length} mapped`);
    } catch (err) {
      console.error(`  Batch ${bi + 1} failed: ${err.message}`);
    }

    // Rate limit: wait 35s between calls (78K tokens/call, 200K limit/min)
    if (bi < batches.length - 1) {
      const waitSec = 35;
      console.log(`  Waiting ${waitSec}s for rate limit...`);
      onProgress({ status: 'running', progress: bi + 1, total: batches.length, mapped: totalMapped, currentGroup: `Warte ${waitSec}s (Rate-Limit)...` });
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }

  onProgress({ status: 'done', progress: batches.length, total: batches.length, mapped: totalMapped, currentGroup: '' });
  console.log(`OpenAI: Done. ${totalMapped}/${targetSignals.length} targets mapped in ${batches.length} calls.`);
}

async function callOpenAI(prompt) {
  const payload = JSON.stringify({
    model: OPENAI_MODEL,
    max_completion_tokens: 16384,
    temperature: 0.05,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      timeout: 180000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(new Error(`OpenAI parse error: ${data.slice(0, 500)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI timeout 180s')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ═════════════════════════════════════════════════════════════
// Claude (Cloud) – ALL signals, ALL targets, one call
// ═════════════════════════════════════════════════════════════

async function suggestWithClaude(machineId, signals, networks, targetSignals, onProgress) {
  // Only signals with comments – keep it compact
  const usefulSignals = signals.filter(s => s.comment && s.comment.length > 3);

  // Compact signal list – shorter format to stay under 30K tokens
  const signalList = usefulSignals.map(s =>
    `${s.address} [${s.data_type}] ${s.name || ''} // ${s.comment}`
  ).join('\n');

  // Compact networks
  const networkList = networks.slice(0, 100).map(n =>
    `${n.block_name} NW${n.network_number}: ${n.comment || ''}`
  ).join('\n');

  // Split targets into batches of 20 – each batch stays under 30K input tokens
  const BATCH_SIZE = 20;
  const batches = [];
  for (let i = 0; i < targetSignals.length; i += BATCH_SIZE) {
    batches.push(targetSignals.slice(i, i + BATCH_SIZE));
  }

  let totalMapped = 0;
  onProgress({ status: 'running', progress: 0, total: batches.length, mapped: 0, currentGroup: 'Starting...' });

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const group = batch[0].name.split('.')[0];
    onProgress({ status: 'running', progress: bi, total: batches.length, mapped: totalMapped, currentGroup: group });

    // Rate limit: wait 65 seconds between calls (30K tokens/min limit)
    if (bi > 0) {
      console.log(`  Rate limit pause: waiting 65s before batch ${bi + 1}/${batches.length}...`);
      onProgress({ status: 'running', progress: bi, total: batches.length, mapped: totalMapped, currentGroup: `${group} (warte auf Rate-Limit...)` });
      await new Promise(r => setTimeout(r, 65000));
    }

    const targetList = batch.map(t =>
      `"${t.name}" [${t.data_type}${t.unit ? ', ' + t.unit : ''}]: ${t.description || ''}`
    ).join('\n');

    const prompt = `Du bist ein SPS-Ingenieur. Ordne PLC-Signale dem CTBase Standard-Datenmodell zu.

ZIEL-SIGNALE (finde für JEDES das passende PLC-Signal):
${targetList}

PLC-SIGNALE (${usefulSignals.length} mit Kommentaren):
${signalList}

NETZWERKE:
${networkList}

REGELN:
- Zuordnung muss SEMANTISCH passen (Name/Kommentar → Bedeutung)
- SPS implementiert möglicherweise CTBase – suche nach HeartbeatUp, CycleIsRunning, Producing, RecipeID, JobName, TraceId etc.
- "direct" = 1:1, "expression" = kombiniert (AND/OR)
- Wenn NICHTS passt → WEGLASSEN. NICHT raten!
- Datentypen müssen passen

NUR JSON Array:
[{"target": "Zielname", "source": "DB-Adresse", "type": "direct", "confidence": 0.9, "reason": "warum"}]`;

    try {
      console.log(`Claude batch ${bi + 1}/${batches.length}: ${group} (${batch.length} targets)`);
      const response = await callClaude(prompt);
      const suggestions = parseResponse(response, machineId, batch);

      for (const m of suggestions) {
        await pool.query(
          `INSERT INTO mappings (machine_id, target_signal, mapping_type, source_address, expression, confidence, validated_by_human, reasoning)
           VALUES ($1, $2, $3, $4, $5, $6, false, $7)
           ON CONFLICT (machine_id, target_signal) DO UPDATE SET
             mapping_type = EXCLUDED.mapping_type, source_address = EXCLUDED.source_address,
             expression = EXCLUDED.expression, confidence = EXCLUDED.confidence, reasoning = EXCLUDED.reasoning`,
          [machineId, m.target_signal, m.mapping_type, m.source_address, m.expression, m.confidence, m.reasoning]
        );
        totalMapped++;
      }
      console.log(`  → ${suggestions.length} mapped`);
    } catch (err) {
      console.error(`  Batch ${bi + 1} failed: ${err.message}`);
    }
  }

  onProgress({ status: 'done', progress: batches.length, total: batches.length, mapped: totalMapped, currentGroup: '' });
  console.log(`Claude: Done. ${totalMapped}/${targetSignals.length} targets mapped.`);
}

// ═════════════════════════════════════════════════════════════
// Ollama (Local) – batched with pre-filtering
// ═════════════════════════════════════════════════════════════

async function suggestWithOllama(machineId, signals, networks, targetSignals, onProgress) {
  const BATCH_SIZE = 5;
  const batches = [];
  for (let i = 0; i < targetSignals.length; i += BATCH_SIZE) {
    batches.push(targetSignals.slice(i, i + BATCH_SIZE));
  }

  let mapped = 0;
  onProgress({ status: 'running', progress: 0, total: batches.length, mapped: 0, currentGroup: '' });

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const group = batch[0].name.split('.')[0];
    onProgress({ status: 'running', progress: bi, total: batches.length, mapped, currentGroup: group });

    const candidates = selectCandidates(batch, signals);
    if (candidates.length === 0) continue;

    const prompt = buildOllamaPrompt(batch, candidates);

    try {
      console.log(`Ollama: ${group} (${batch.length} targets, ${candidates.length} candidates)`);
      const response = await callOllama(prompt);
      const suggestions = parseResponse(response, machineId, batch);

      for (const m of suggestions) {
        await pool.query(
          `INSERT INTO mappings (machine_id, target_signal, mapping_type, source_address, expression, confidence, validated_by_human, reasoning)
           VALUES ($1, $2, $3, $4, $5, $6, false, $7)
           ON CONFLICT (machine_id, target_signal) DO UPDATE SET
             mapping_type = EXCLUDED.mapping_type, source_address = EXCLUDED.source_address,
             expression = EXCLUDED.expression, confidence = EXCLUDED.confidence, reasoning = EXCLUDED.reasoning`,
          [machineId, m.target_signal, m.mapping_type, m.source_address, m.expression, m.confidence, m.reasoning]
        );
        mapped++;
      }
    } catch (err) {
      console.error(`Ollama batch failed:`, err.message);
    }
  }

  onProgress({ status: 'done', progress: batches.length, total: batches.length, mapped, currentGroup: '' });
}

function selectCandidates(targets, allSignals) {
  const keywords = new Set();
  const targetTypes = new Set();
  for (const t of targets) {
    targetTypes.add(t.data_type?.toUpperCase() || 'BOOL');
    `${t.name} ${t.description || ''}`.replace(/\./g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase().split(/\s+/).forEach(w => { if (w.length > 2) keywords.add(w); });
  }

  const scored = allSignals
    .filter(s => s.comment || s.name)
    .map(s => {
      const text = `${s.name || ''} ${s.comment || ''}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) { if (text.includes(kw)) score += 3; }
      if (s.comment && s.comment.length > 5) score += 2;
      return { signal: s, score };
    })
    .filter(s => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 25).map(s => s.signal);
}

function buildOllamaPrompt(targets, candidates) {
  const candidateList = candidates.map(s =>
    `${s.address} [${s.data_type}] "${s.name || ''}" ${s.comment ? '// ' + s.comment : ''}`
  ).join('\n');

  const targetList = targets.map(t =>
    `"${t.name}" [${t.data_type}${t.unit ? ', ' + t.unit : ''}]: ${t.description || ''}`
  ).join('\n');

  return `Du bist ein SPS-Ingenieur. Ordne PLC-Signale dem Standard-Datenmodell zu.
NUR zuordnen wenn Kommentar/Name WIRKLICH passt. Wenn nichts passt → WEGLASSEN.

ZIEL-SIGNALE:
${targetList}

PLC-KANDIDATEN:
${candidateList}

JSON Array (NUR passende):
[{"target": "Zielname", "source": "Adresse", "type": "direct", "reason": "warum"}]`;
}

// ═════════════════════════════════════════════════════════════
// LLM API calls
// ═════════════════════════════════════════════════════════════

async function callClaude(prompt) {
  const payload = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16384,
    temperature: 0.05,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      timeout: 120000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text);
        } catch (e) { reject(new Error(`Claude parse error: ${data.slice(0, 500)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout 120s')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function callOllama(prompt) {
  const url = new URL('/api/generate', OLLAMA_URL);
  const payload = JSON.stringify({
    model: OLLAMA_MODEL, prompt, stream: false,
    options: { temperature: 0.05, top_p: 0.8, num_predict: 1024, num_ctx: 4096 }
  });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', timeout: 180000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed.response);
        } catch (e) { reject(new Error(`Ollama parse error: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout 180s')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ═════════════════════════════════════════════════════════════
// Response parsing
// ═════════════════════════════════════════════════════════════

function parseResponse(response, machineId, validTargets) {
  let jsonStr = response.trim();
  if (jsonStr.includes('```')) {
    const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) jsonStr = match[1].trim();
  }
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    console.warn('No JSON array in response:', response.slice(0, 200));
    return [];
  }

  const validTargetNames = new Set(validTargets.map(t => t.name));

  try {
    const arr = JSON.parse(arrayMatch[0]);
    return arr
      .filter(s => {
        if (!validTargetNames.has(s.target)) return false;
        if (!s.source && !s.expression) return false;
        return true;
      })
      .map(s => {
        let addr = s.source || s.source_address || null;
        let expr = s.expression || null;
        let mtype = s.type || s.mapping_type || 'direct';

        // Fix pipe separator → OR
        if (addr && addr.includes('|')) {
          expr = addr.replace(/\s*\|\s*/g, ' OR ');
          addr = null;
          mtype = 'expression';
        }
        if (expr) expr = expr.replace(/\s*\|\s*/g, ' OR ');

        // Direct must be single address
        if (mtype === 'direct' && addr) {
          const matches = addr.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g);
          if (matches && matches.length > 1) {
            expr = matches.join(' OR ');
            addr = null;
            mtype = 'expression';
          } else if (matches && matches.length === 1) {
            addr = matches[0];
          }
        }

        return {
          machine_id: machineId,
          target_signal: s.target,
          mapping_type: mtype,
          source_address: addr,
          expression: expr,
          confidence: s.confidence || 0.7,
          reasoning: s.reason || s.reasoning || null,
          validated_by_human: false
        };
      });
  } catch (e) {
    console.warn('JSON parse failed:', e.message);
    return [];
  }
}

module.exports = { suggestMappingsBatchwise };
