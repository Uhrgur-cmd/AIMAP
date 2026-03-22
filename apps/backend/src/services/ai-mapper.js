const http = require('http');
const https = require('https');
const pool = require('../db/pool');
const { buildCrossReference, awlToReadable } = require('./cross-reference');
const { buildProgramFlow, programFlowForPrompt } = require('./program-flow');
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

  // Build program flow (call hierarchy, machine behavior, sequences)
  let programFlowText = '';
  try {
    const flowData = await buildProgramFlow(machineId);
    programFlowText = programFlowForPrompt(flowData);
    console.log(`Program flow: ${flowData.stats.totalBlocks} blocks, ${flowData.stats.totalCalls} calls, ${flowData.stats.sequenceSteps} steps`);
  } catch (err) {
    console.warn(`Program flow extraction skipped: ${err.message}`);
  }

  const signalContext = buildCompactContext(signalProfiles, programFlowText);
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

    const prompt = `Du bist ein erfahrener SPS-Programmierer der eine Extrusionslinie / Produktionsmaschine analysiert.
Deine Aufgabe: Finde für jedes Ziel-Signal das RICHTIGE PLC-Signal oder die richtige EXPRESSION.

ZIEL-SIGNALE (${batch.length}):
${list}

CTBASE MAPPING-REGELN (beschreiben was jedes Signal BEDEUTET):
${CTBASE_RULES}

ANALYSIERTES SPS-PROGRAMM (Signale mit Dependency Trees):
${signalContext}

═══ KRITISCHE ANALYSE-REGELN ═══

1. DEPENDENCY TREES LESEN – nicht nur Namen matchen!
   Jedes Signal hat "← [dependencies]" die zeigen WOHER der Wert kommt.
   Beispiel: DB321.DBX0.5 AUTO_ON ← [DB300.DBX0.4(BUTT_LINE_ON), DB300.DBX0.0(Control_ON)]
   → Das sagt dir: AUTO_ON wird von FB300 (Liniensteuerung) gesetzt, abhängig von Taste LINE_ON.

2. PRODUCING ≠ AUTOMATIC MODE!
   "Automatic" heißt nur: Betriebsart ist Automatik gewählt.
   "Producing" heißt: Maschine PRODUZIERT TATSÄCHLICH – Antriebe drehen, Material läuft.
   → Suche ein Signal das abhängt von Automatik UND Geschwindigkeit > 0 oder Antrieb läuft.
   → Typisch: expression aus Auto-Bit AND Speed > 0 AND NOT Fehler

3. MEHRFACH-SIGNALE mit OR VERKNÜPFEN!
   Wenn du mehrere Signale mit dem GLEICHEN Namen findest (z.B. 3x "Schutztueren_zu"):
   → Das sind verschiedene Schutztüren an verschiedenen Stationen!
   → Verknüpfe sie mit OR (bei Fehler/Störung) oder AND (bei Freigabe/Türen zu)
   → Für ProtectiveDevice: NOT Tuer1 OR NOT Tuer2 OR NOT Tuer3 (jede offene Tür triggert)

4. FB-HIERARCHIE BEACHTEN!
   FBs die von anderen FBs aufgerufen werden haben oft die GENAUEREN Signale:
   → FB300 (Liniensteuerung) hat Linien-AUTO/PULL → besser als FB120 (Betriebsarten)
   → FB321 (Raupe) hat Liniengeschwindigkeit → zeigt ob tatsächlich produziert wird
   → FB3500 (Safety) hat CONTROL_ON → berechnet aus allen Antrieb-Safety-Inputs

5. GESCHWINDIGKEIT > 0 = PRODUZIERT!
   Wenn ein Signal "Liniengeschwindigkeit" oder "Speed" oder "Drehzahl" als REAL vorhanden ist:
   → Geschwindigkeit > 0 ist der BESTE Indikator für "Maschine produziert"
   → Nutze es in einer expression: AutoBit AND SpeedSignal > 0

6. EXPRESSIONS MÜSSEN SCL-SYNTAX HABEN mit Semikolon am Ende!
   Direct: "DB10.DBX4.0;"
   Expression: "DB321.DBX0.5 AND DB331.DBD2 > 0 AND NOT DB2.DBX0.1;"
   Operatoren: AND, OR, NOT, >, <, >=, <=, ==, !=, +, -, *, /
   Typ-Konvertierungen: INT_TO_REAL(), DINT_TO_REAL(), REAL_TO_INT(), BOOL_TO_INT(), INT_TO_STRING(), etc.
   Beispiel: "DINT_TO_REAL(DB1.DBD0) / 100;"
   Beispiel: "INT_TO_REAL(DB10.DBW2) * 0.01;"
   IF/THEN für berechnete Werte:
   "IF DB15.DBX0.3 THEN 1 ELSIF DB15.DBX0.2 AND DB49.DBX49.0 THEN 2 ELSE 0 END_IF;"

7. WENN NICHTS PASST → WEGLASSEN!
   Lieber kein Mapping als ein falsches. Nicht raten!
   Confidence < 0.5 → besser weglassen.

═══ JSON OUTPUT FORMAT ═══
Antworte NUR mit einem JSON Array. Jedes Element:
[
  {"target":"Signal.Name","source":"DB10.DBX4.0;","type":"direct","confidence":0.95,"reason":"Kurze Begründung"},
  {"target":"Signal.Name","expression":"DB321.DBX0.5 AND DB331.DBD2 > 0;","type":"expression","confidence":0.9,"reason":"..."},
  {"target":"Signal.Name","expression":"DINT_TO_REAL(DB1.DBD0) / 100;","type":"expression","confidence":0.85,"reason":"..."},
  {"target":"Signal.Name","expression":"IF DB1.DBX0.0 THEN 3 ELSIF DB1.DBX0.1 THEN 2 ELSE 0 END_IF;","type":"expression","confidence":0.8,"reason":"..."}
]
Oder [] wenn nichts passt.`;

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

  const prompt = `Du bist ein erfahrener SPS-Programmierer. Erstelle IF/THEN Lookup-Ausdrücke für STRING-Ziel-Signale.

BEREITS GEMAPPTE SIGNALE (Phase 1 – verwende diese PLC-Adressen in den Bedingungen!):
${p1Summary}
WICHTIG: Nutze die Phase-1-Adressen! Wenn ErrorActive = "DB107.DBX0.1 OR DB109.DBX0.1", dann schreibe genau diese Adressen in die IF-Bedingungen.

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

function buildCompactContext(profiles, programFlowText) {
  let text = '';

  // Program flow first — gives AI the "big picture" before signal details
  if (programFlowText) {
    text += programFlowText + '\n\n';
  }

  // Build signal name lookup for AWL translation
  const signalByAddr = {};
  for (const p of profiles) {
    if (p.address && p.name) signalByAddr[p.address.replace(/\s+/g, '')] = { name: p.name };
  }

  const inNets = profiles.filter(p => p.writtenBy.length > 0 || p.readBy.length > 0);
  const withComments = profiles.filter(p =>
    p.writtenBy.length === 0 && p.readBy.length === 0 && p.comment && !p.comment.startsWith('[name:')
  );

  if (inNets.length > 0) {
    text += `--- SIGNALS WITH TRACED LOGIC (${inNets.length}) ---\n`;

    // Show full logic for first 500 signals (most important, sorted by dependency count)
    const MAX_LOGIC_SIGNALS = 500;
    let logicCount = 0;

    for (const p of inNets) {
      text += `${p.address} [${p.data_type || '?'}]`;
      if (p.name) text += ` "${p.name}"`;
      if (p.comment && !p.comment.startsWith('[name:')) text += ` // ${p.comment}`;

      if (p.writtenBy.length > 0) {
        const w = p.writtenBy[0];
        text += ` ← ${w.block}`;

        // Show logic for the first MAX_LOGIC_SIGNALS signals
        if (logicCount < MAX_LOGIC_SIGNALS && w.logic) {
          const readable = awlToReadable(w.logic, signalByAddr);
          if (readable && readable.length > 5) {
            const logicPreview = readable.length > 200 ? readable.substring(0, 200) + '...' : readable;
            text += `\n    LOGIC: ${logicPreview}`;
            logicCount++;
          }
        }
        // Show dependencies (compact, always)
        if (p.dependsOn.length > 0) {
          const deps = p.dependsOn.slice(0, 6).map(d => {
            let s = d.address;
            if (d.comment && !d.comment.startsWith('[name:') && !d.comment.startsWith('Written in'))
              s += '(' + d.comment.substring(0, 30) + ')';
            return s;
          });
          text += `\n    DEPENDS: [${deps.join(', ')}]`;
        }
      }
      text += '\n';
    }
    text += '\n';
  }
  // Only include signals that are referenced somewhere (read/written in networks)
  // Signals that appear nowhere in the program logic are useless for mapping
  if (withComments.length > 0) {
    // Filter: keep only signals that are referenced in at least one network
    // (they have a comment from the symbol table but no direct writer/reader traced)
    // Limit to keep prompt size manageable — most important first (shorter names = more specific)
    const MAX_COMMENT_SIGNALS = 2000;
    const limited = withComments.slice(0, MAX_COMMENT_SIGNALS);
    const skipped = withComments.length - limited.length;
    text += `--- SIGNALS WITH COMMENTS (${limited.length}${skipped > 0 ? ', ' + skipped + ' more omitted' : ''}) ---\n`;
    for (const p of limited) {
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
