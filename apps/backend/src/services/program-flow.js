/**
 * Program Flow Analyzer
 *
 * Extracts the complete program structure and machine behavior from parsed PLC data.
 * Works for both Step7 (MC7 binary) and TIA Portal (XML) projects.
 *
 * Produces:
 *   1. FB Call Hierarchy — which OBs call which FBs/FCs, and what those call
 *   2. Machine Behavior Description — clear text explaining what happens when
 *   3. Automatic Mode Analysis — how automatic mode is achieved (inputs, conditions)
 *   4. Signal Flow Summary — key signal groups and their roles
 *
 * This gives the AI a "human understanding" of the machine program,
 * not just raw signal lists.
 */

const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════════
// Main entry: build complete program flow for a machine
// ═══════════════════════════════════════════════════════════════

async function buildProgramFlow(machineId) {
  const { rows: machineRows } = await pool.query('SELECT * FROM machines WHERE id = $1', [machineId]);
  if (!machineRows.length) throw new Error('Machine not found');
  const machine = machineRows[0];

  const isS7Classic = machine.plc_type && (machine.plc_type.startsWith('S7-3') || machine.plc_type.startsWith('S7-4'));

  const { rows: signals } = await pool.query(
    'SELECT address, name, data_type, comment, block_name, block_number FROM signals WHERE machine_id = $1 ORDER BY address',
    [machineId]
  );
  const { rows: networks } = await pool.query(
    'SELECT block_name, network_number, comment, signals_referenced, logic FROM network_comments WHERE machine_id = $1 ORDER BY block_name, network_number',
    [machineId]
  );

  // 1. Extract FB call hierarchy
  const callHierarchy = extractCallHierarchy(networks, isS7Classic);

  // 2. Analyze block purposes from network comments
  const blockPurposes = analyzeBlockPurposes(networks, signals);

  // 3. Detect automatic mode signals
  const automaticAnalysis = analyzeAutomaticMode(signals, networks);

  // 4. Detect machine state signals (producing, error, safety)
  const stateAnalysis = analyzeMachineStates(signals, networks);

  // 5. Detect sequence / step chains (GRAPH)
  const sequences = detectSequences(networks, signals);

  // 6. Extract key block logic (SCL/AWL for the most important blocks)
  const blockLogic = extractKeyBlockLogic(networks, blockPurposes, signals);

  // 7. Build the complete machine description
  const description = buildMachineDescription(
    machine, callHierarchy, blockPurposes,
    automaticAnalysis, stateAnalysis, sequences, signals, blockLogic
  );

  return {
    callHierarchy,
    blockPurposes,
    automaticAnalysis,
    stateAnalysis,
    sequences,
    description,
    stats: {
      totalBlocks: Object.keys(blockPurposes).length,
      totalCalls: Object.values(callHierarchy).reduce((s, c) => s + c.length, 0),
      sequenceSteps: sequences.reduce((s, seq) => s + seq.steps.length, 0)
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. FB Call Hierarchy
// ═══════════════════════════════════════════════════════════════

/**
 * Extract which blocks call which other blocks.
 * Step7: from MC7 decoded instructions (UC FB, OPN DI, CALL FB)
 * TIA: from SCL "CALL" statements, Call Access elements, and cross-block signal references
 */
function extractCallHierarchy(networks, isS7Classic) {
  const calls = {}; // caller → [{ callee, condition, network }]

  // Build set of all block names that have networks (= code blocks / FBs)
  const codeBlocks = new Set();
  for (const net of networks) {
    if (net.block_name) codeBlocks.add(net.block_name);
  }

  for (const net of networks) {
    const caller = net.block_name;
    if (!caller) continue;

    if (!calls[caller]) calls[caller] = [];

    if (isS7Classic) {
      // Step7 MC7: look for CALL:FB/FC references in comment and logic
      extractMC7Calls(net, calls[caller]);
    }

    // TIA + Step7: look for CALL statements in SCL logic
    extractSCLCalls(net, calls[caller]);

    // TIA: look for Call elements in LAD/FBD logic
    extractLADCalls(net, calls[caller]);

    // TIA symbolic: detect cross-block references from signals_referenced
    // If a network in "General Admin" references "OPMode.Auto_act", that means
    // "General Admin" interacts with block "OPMode"
    if (!isS7Classic && net.signals_referenced && Array.isArray(net.signals_referenced)) {
      extractSymbolicBlockRefs(net, calls[caller], caller, codeBlocks);
    }
  }

  // Deduplicate calls per caller, remove self-references
  for (const caller of Object.keys(calls)) {
    const seen = new Set();
    calls[caller] = calls[caller].filter(c => {
      const key = c.callee;
      if (key === caller) return false; // No self-references
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Remove empty callers
    if (calls[caller].length === 0) delete calls[caller];
  }

  return calls;
}

/**
 * Extract calls from MC7 decoded logic chains.
 * MC7 Logic comments contain "CALL:FBxxx" in inputs, and
 * UC/CC instructions in the logic field.
 */
function extractMC7Calls(net, callList) {
  // From MC7 Logic comment: signals_referenced may contain "CALL:FB100"
  if (net.signals_referenced && Array.isArray(net.signals_referenced)) {
    for (const ref of net.signals_referenced) {
      const callMatch = ref.match(/^CALL:(FB|FC)(\d+)$/);
      if (callMatch) {
        callList.push({
          callee: `${callMatch[1]}${callMatch[2]}`,
          condition: null,
          network: net.network_number
        });
      }
    }
  }

  // From logic field: "UC FB 100", "CC FC 50", "OPN DI 100"
  if (net.logic) {
    const ucMatches = net.logic.match(/(?:UC|CC)\s+(FB|FC)\s*(\d+)/g);
    if (ucMatches) {
      for (const m of ucMatches) {
        const parts = m.match(/(FB|FC)\s*(\d+)/);
        if (parts) {
          callList.push({
            callee: `${parts[1]}${parts[2]}`,
            condition: null,
            network: net.network_number
          });
        }
      }
    }

    // OPN DI → instance DB opening (FB call via instance)
    const opnMatches = net.logic.match(/OPN\s+DI\s*(\d+)/g);
    if (opnMatches) {
      for (const m of opnMatches) {
        const num = m.match(/DI\s*(\d+)/);
        if (num) {
          callList.push({
            callee: `FB${num[1]}(DI)`,
            condition: null,
            network: net.network_number
          });
        }
      }
    }
  }
}

/**
 * Extract calls from SCL logic.
 * Patterns: "CALL FB100, DB100", "#BlockName()", function calls
 */
function extractSCLCalls(net, callList) {
  const logic = net.logic || '';
  if (!logic.includes('SCL:') && !logic.includes('CALL')) return;

  // SCL CALL pattern: CALL FB100, DB100 or CALL "BlockName"
  const callPatterns = logic.match(/CALL\s+(FB|FC|"[\w_]+")[\s,]*(\d+)?/gi);
  if (callPatterns) {
    for (const m of callPatterns) {
      const parts = m.match(/CALL\s+(FB|FC)\s*(\d+)/i);
      if (parts) {
        callList.push({
          callee: `${parts[1].toUpperCase()}${parts[2]}`,
          condition: null,
          network: net.network_number
        });
      }
      // Named call: CALL "BlockName"
      const namedMatch = m.match(/CALL\s+"([\w_]+)"/);
      if (namedMatch) {
        callList.push({
          callee: namedMatch[1],
          condition: null,
          network: net.network_number
        });
      }
    }
  }

  // SCL function call pattern: "BlockName"(params) or BlockName(IN := value)
  const funcCalls = logic.match(/["']?([\w_]+)["']?\s*\(\s*\w+\s*:=/g);
  if (funcCalls) {
    for (const m of funcCalls) {
      const name = m.match(/["']?([\w_]+)["']?\s*\(/);
      if (name && /^(FB|FC|OB)\d+$/.test(name[1])) {
        callList.push({
          callee: name[1],
          condition: null,
          network: net.network_number
        });
      }
    }
  }
}

/**
 * Extract calls from LAD/FBD logic.
 * TIA LAD networks reference called blocks in signals_referenced.
 */
function extractLADCalls(net, callList) {
  if (!net.signals_referenced || !Array.isArray(net.signals_referenced)) return;

  for (const ref of net.signals_referenced) {
    // Direct FB/FC references in signal list
    if (/^(FB|FC)\d+$/.test(ref)) {
      callList.push({
        callee: ref,
        condition: null,
        network: net.network_number
      });
    }
  }

  // LAD logic with Call: "LAD: ... = FB100"
  if (net.logic && net.logic.startsWith('LAD:')) {
    const callMatch = net.logic.match(/(?:CALL|=)\s*(FB|FC)(\d+)/);
    if (callMatch) {
      callList.push({
        callee: `${callMatch[1]}${callMatch[2]}`,
        condition: null,
        network: net.network_number
      });
    }
  }
}

/**
 * Extract cross-block references from TIA symbolic signal names.
 * In TIA, signals_referenced contains names like "General.OPMode.Auto_act" or
 * "Drives.Motor1.Speed" — the first component often matches a DB or block name.
 * If a code block (FB) references signals from another code block's DB, that's a relationship.
 */
function extractSymbolicBlockRefs(net, callList, callerBlock, codeBlocks) {
  const refs = net.signals_referenced || [];
  const referencedBlocks = new Set();

  for (const ref of refs) {
    // Get first component of dotted name: "General.Reset" → "General"
    const dot = ref.indexOf('.');
    const prefix = dot > 0 ? ref.substring(0, dot) : ref;

    // Skip self-references and very short names
    if (prefix === callerBlock || prefix.length < 2) continue;

    // Check if this prefix matches a known code block (or close variant)
    // TIA often has: code block = "General Admin", DB = "General"
    // Or: code block = "OPMode", signal = "OPMode.Auto_act"
    if (codeBlocks.has(prefix)) {
      referencedBlocks.add(prefix);
    }
    // Try with " Admin" suffix
    if (codeBlocks.has(prefix + ' Admin')) {
      referencedBlocks.add(prefix + ' Admin');
    }
  }

  for (const block of referencedBlocks) {
    callList.push({
      callee: block,
      condition: null,
      network: net.network_number,
      type: 'data_reference'
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. Block Purpose Analysis
// ═══════════════════════════════════════════════════════════════

/**
 * Analyze what each block does based on network comments, signal names,
 * and the variables it reads/writes.
 */
function analyzeBlockPurposes(networks, signals) {
  const blocks = {}; // blockName → { networks, keywords, signalGroups, purpose }

  // Group networks by block
  for (const net of networks) {
    const block = net.block_name;
    if (!block) continue;
    if (!blocks[block]) blocks[block] = { networks: [], keywords: new Set(), comments: [] };
    blocks[block].networks.push(net);
    if (net.comment) blocks[block].comments.push(net.comment);
  }

  // Analyze each block
  for (const [blockName, data] of Object.entries(blocks)) {
    const allText = data.comments.join(' ').toLowerCase();
    const allRefs = data.networks.flatMap(n => n.signals_referenced || []).join(' ').toLowerCase();
    const combined = allText + ' ' + allRefs;

    // Detect purpose from keywords
    const purpose = detectBlockPurpose(blockName, combined);
    data.purpose = purpose;
    data.networkCount = data.networks.length;

    // Clean up for output
    delete data.networks;
    delete data.keywords;
    data.topComments = data.comments
      .filter(c => c && !c.startsWith('MC7 Logic:') && !c.startsWith('SCL:') && !c.startsWith('Interface:'))
      .slice(0, 5);
    delete data.comments;
  }

  return blocks;
}

/**
 * Detect the purpose of a block from its name and content keywords.
 */
function detectBlockPurpose(blockName, content) {
  const name = blockName.toLowerCase();
  const c = content.toLowerCase();

  // Operating modes
  if (matchAny(name, c, ['betriebsart', 'operating_mode', 'mode_select', 'op_mode', 'manual_auto']))
    return 'Betriebsarten (Operating Modes)';

  // Line control
  if (matchAny(name, c, ['linie', 'line_control', 'linien', 'hauptsteuerung', 'main_control']))
    return 'Liniensteuerung (Line Control)';

  // Safety
  if (matchAny(name, c, ['safety', 'sicher', 'not_halt', 'e_stop', 'emergency', 'schutztür', 'protective', 'guard']))
    return 'Safety / Schutztüren';

  // Extruder
  if (matchAny(name, c, ['extruder', 'extrusion', 'schnecke', 'screw', 'zylinder', 'barrel']))
    return 'Extruder';

  // Drive / Motor
  if (matchAny(name, c, ['antrieb', 'drive', 'motor', 'drehzahl', 'speed', 'frequenz']))
    return 'Antriebssteuerung (Drive Control)';

  // Temperature
  if (matchAny(name, c, ['temperatur', 'heiz', 'kühl', 'temp_', 'heating', 'cooling', 'thermo']))
    return 'Temperaturregelung (Temperature Control)';

  // Caterpillar / Haul-off
  if (matchAny(name, c, ['raupe', 'caterpillar', 'haul', 'abzug', 'puller']))
    return 'Raupe/Abzug (Haul-off)';

  // Winding / Coiler
  if (matchAny(name, c, ['wickl', 'winder', 'coiler', 'spule', 'aufwickl']))
    return 'Wickler (Winder)';

  // Cutter / Saw
  if (matchAny(name, c, ['säge', 'saw', 'schneid', 'cutter', 'trenn', 'cut']))
    return 'Säge/Schneider (Cutter)';

  // Recipe
  if (matchAny(name, c, ['rezept', 'recipe', 'parameter', 'produkt']))
    return 'Rezeptverwaltung (Recipe Management)';

  // Communication
  if (matchAny(name, c, ['kommunikation', 'comm', 'profinet', 'profibus', 'ethernet', 'tcp']))
    return 'Kommunikation (Communication)';

  // Alarm / Error
  if (matchAny(name, c, ['alarm', 'störung', 'error', 'fault', 'meldung', 'diagnostic']))
    return 'Störmeldungen (Alarms/Errors)';

  // Counter / Production data
  if (matchAny(name, c, ['zähler', 'counter', 'produktion', 'production', 'meter', 'length', 'länge']))
    return 'Produktionsdaten (Production Data)';

  // HMI / Visualization
  if (matchAny(name, c, ['hmi', 'visu', 'display', 'anzeige', 'bild', 'screen']))
    return 'HMI/Visualisierung';

  // Energy
  if (matchAny(name, c, ['energie', 'energy', 'power', 'strom', 'leistung', 'kwh']))
    return 'Energiemanagement (Energy Management)';

  // Dosing
  if (matchAny(name, c, ['dosier', 'dosing', 'gravimetr', 'feeder']))
    return 'Dosierung (Dosing/Feeding)';

  // Calibration / Measurement
  if (matchAny(name, c, ['mess', 'measure', 'kalibr', 'calibr', 'sensor', 'gauge']))
    return 'Messtechnik (Measurement)';

  // Water / Cooling
  if (matchAny(name, c, ['wasser', 'water', 'kühlung', 'vakuum', 'vacuum']))
    return 'Wasserkühlung/Vakuum (Cooling/Vacuum)';

  // OB1 is always the main cycle
  if (/^OB0*1$/i.test(blockName)) return 'Hauptprogramm (Main Cycle OB1)';
  if (/^OB\d+$/i.test(blockName)) return 'Organisationsbaustein';

  return null;
}

function matchAny(name, content, keywords) {
  return keywords.some(kw => name.includes(kw) || content.includes(kw));
}

// ═══════════════════════════════════════════════════════════════
// 3. Automatic Mode Analysis
// ═══════════════════════════════════════════════════════════════

/**
 * Find signals related to automatic mode and trace how it's achieved.
 * Returns: which signals represent auto mode, what inputs are needed.
 */
function analyzeAutomaticMode(signals, networks) {
  const autoKeywords = ['auto', 'automatik', 'automatic', 'auto_on', 'auto_mode', 'betriebsart'];
  const autoSignals = [];

  // Find auto-related signals
  for (const s of signals) {
    const text = ((s.name || '') + ' ' + (s.comment || '')).toLowerCase();
    if (autoKeywords.some(kw => text.includes(kw)) && s.data_type === 'BOOL') {
      autoSignals.push(s);
    }
  }

  // Find networks that write to auto signals
  const autoNetworks = [];
  for (const autoSig of autoSignals) {
    for (const net of networks) {
      if (!net.signals_referenced || !Array.isArray(net.signals_referenced)) continue;
      // Check if this network writes to the auto signal
      const refs = net.signals_referenced.map(r => r.replace(/\s+/g, ''));
      const addr = (autoSig.address || '').replace(/\s+/g, '');
      const name = autoSig.name || '';
      if (refs.includes(addr) || refs.includes(name)) {
        autoNetworks.push({
          signal: autoSig,
          network: net,
          inputs: net.signals_referenced.filter(r => r !== addr && r !== name)
        });
      }
    }
  }

  return {
    signals: autoSignals.map(s => ({
      address: s.address,
      name: s.name,
      comment: s.comment,
      block: s.block_name
    })),
    dependencies: autoNetworks.slice(0, 20).map(an => ({
      autoSignal: an.signal.address || an.signal.name,
      writtenIn: an.network.block_name,
      networkComment: an.network.comment,
      inputs: an.inputs.slice(0, 10)
    }))
  };
}

// ═══════════════════════════════════════════════════════════════
// 4. Machine State Analysis
// ═══════════════════════════════════════════════════════════════

/**
 * Detect signals for key machine states:
 * - Producing (machine is actually running)
 * - Error/Fault
 * - Safety (emergency stop, protective doors)
 * - Speed/Drive running
 */
function analyzeMachineStates(signals, networks) {
  const states = {
    producing: [],
    errors: [],
    safety: [],
    speed: [],
    drives: [],
    ready: []
  };

  for (const s of signals) {
    const text = ((s.name || '') + ' ' + (s.comment || '')).toLowerCase();

    if (matchAny('', text, ['produz', 'producing', 'running', 'in_betrieb', 'maschine_ein', 'line_on', 'linie_ein']))
      states.producing.push(s);

    if (matchAny('', text, ['störung', 'error', 'fault', 'alarm', 'fehler']) && s.data_type === 'BOOL')
      states.errors.push(s);

    if (matchAny('', text, ['not_halt', 'e_stop', 'emergency', 'safety', 'schutztür', 'protective', 'guard']) && s.data_type === 'BOOL')
      states.safety.push(s);

    if (matchAny('', text, ['geschwindigkeit', 'speed', 'drehzahl', 'velocity', 'line_speed']) && ['REAL', 'INT', 'DINT'].includes(s.data_type))
      states.speed.push(s);

    if (matchAny('', text, ['antrieb', 'drive', 'motor_on', 'motor_ein', 'freigabe']) && s.data_type === 'BOOL')
      states.drives.push(s);

    if (matchAny('', text, ['bereit', 'ready', 'freigabe', 'control_on']) && s.data_type === 'BOOL')
      states.ready.push(s);
  }

  // Summarize each group
  const summary = {};
  for (const [key, sigs] of Object.entries(states)) {
    summary[key] = sigs.slice(0, 15).map(s => ({
      address: s.address,
      name: s.name,
      comment: s.comment,
      block: s.block_name
    }));
  }
  return summary;
}

// ═══════════════════════════════════════════════════════════════
// 5. Sequence / Step Chain Detection (GRAPH)
// ═══════════════════════════════════════════════════════════════

/**
 * Detect step chains / sequences in the program.
 * GRAPH step chains use numbered steps with transitions.
 * Also detects IF/CASE-based state machines in SCL.
 */
function detectSequences(networks, signals) {
  const sequences = [];

  // Group networks by block to find sequences within blocks
  const blockNets = {};
  for (const net of networks) {
    if (!net.block_name) continue;
    if (!blockNets[net.block_name]) blockNets[net.block_name] = [];
    blockNets[net.block_name].push(net);
  }

  for (const [blockName, nets] of Object.entries(blockNets)) {
    // Detect GRAPH-style step chains: networks with "Step X" or "Schritt X" comments
    const stepNets = nets.filter(n =>
      n.comment && /(?:step|schritt|phase|stufe)\s*\d+/i.test(n.comment)
    );

    if (stepNets.length >= 2) {
      const steps = stepNets.map(n => {
        const stepMatch = n.comment.match(/(?:step|schritt|phase|stufe)\s*(\d+)\s*[:\-]?\s*(.*)/i);
        return {
          number: stepMatch ? parseInt(stepMatch[1]) : n.network_number,
          description: stepMatch ? stepMatch[2].trim() : n.comment,
          network: n.network_number,
          signals: (n.signals_referenced || []).slice(0, 8)
        };
      }).sort((a, b) => a.number - b.number);

      sequences.push({
        block: blockName,
        type: 'GRAPH/StepChain',
        steps
      });
      continue;
    }

    // Detect CASE-based state machines in SCL
    const sclNets = nets.filter(n => n.logic && n.logic.includes('CASE'));
    if (sclNets.length > 0) {
      const steps = [];
      for (const net of sclNets) {
        const caseMatches = net.logic.match(/(\d+)\s*:\s*(?:\/\/\s*)?([^\n;]+)/g);
        if (caseMatches) {
          for (const cm of caseMatches) {
            const parts = cm.match(/(\d+)\s*:\s*(?:\/\/\s*)?(.+)/);
            if (parts) {
              steps.push({
                number: parseInt(parts[1]),
                description: parts[2].trim().substring(0, 100),
                network: net.network_number,
                signals: []
              });
            }
          }
        }
      }
      if (steps.length >= 2) {
        sequences.push({
          block: blockName,
          type: 'SCL/CaseStateMachine',
          steps: steps.sort((a, b) => a.number - b.number)
        });
      }
    }

    // Detect step variables (Schritt_Nr, Step_Number, etc.)
    const stepVarNets = nets.filter(n => {
      const refs = (n.signals_referenced || []).join(' ').toLowerCase();
      return /schritt.*nr|step.*num|phase.*nr|state/i.test(refs);
    });

    if (stepVarNets.length >= 3 && !sequences.some(s => s.block === blockName)) {
      const steps = stepVarNets.map(n => ({
        number: n.network_number,
        description: n.comment || 'Step',
        network: n.network_number,
        signals: (n.signals_referenced || []).slice(0, 8)
      }));
      sequences.push({
        block: blockName,
        type: 'StepVariable',
        steps
      });
    }
  }

  return sequences;
}

// ═══════════════════════════════════════════════════════════════
// 6. Key Block Logic Extraction
// ═══════════════════════════════════════════════════════════════

/**
 * Extract the actual SCL/AWL logic from the most important blocks.
 * This gives the AI the full business logic, not just signal names.
 * Prioritizes blocks with: operating modes, drives, safety, line control.
 */
function extractKeyBlockLogic(networks, blockPurposes, signals) {
  const result = {}; // blockName → [{ network, logic_readable }]

  // ── Build FB→DB mapping for DIX resolution (S7-300/400) ──
  const fbToDb = {};
  const fbNumbers = new Set();
  const dbNumbers = new Set();
  for (const net of networks) {
    if (net.block_name && /^FB\d+$/.test(net.block_name)) {
      fbNumbers.add(parseInt(net.block_name.replace('FB', '')));
    }
  }
  if (signals) {
    for (const s of signals) {
      if (s.block_number > 0 && s.address && s.address.startsWith('DB')) {
        dbNumbers.add(s.block_number);
      }
    }
  }
  for (const fb of fbNumbers) {
    if (dbNumbers.has(fb)) fbToDb[fb] = fb;
  }

  // ── Build signal name lookup for address resolution ──
  const signalByAddr = {};
  if (signals) {
    for (const s of signals) {
      if (s.address && s.name) {
        signalByAddr[s.address.replace(/\s+/g, '')] = s.name;
      }
    }
  }

  // Prioritize blocks by importance for AI understanding
  const priorityPurposes = [
    'Betriebsarten (Operating Modes)',
    'Liniensteuerung (Line Control)',
    'Safety / Schutztüren',
    'Antriebssteuerung (Drive Control)',
    'Extruder',
    'Raupe/Abzug (Haul-off)',
    'Hauptprogramm (Main Cycle OB1)',
    'Produktionsdaten (Production Data)',
    'Rezeptverwaltung (Recipe Management)',
    'Störmeldungen (Alarms/Errors)',
  ];

  // Get blocks sorted by priority
  const priorityBlocks = new Set();
  for (const purpose of priorityPurposes) {
    for (const [block, data] of Object.entries(blockPurposes)) {
      if (data.purpose === purpose) priorityBlocks.add(block);
    }
  }

  // Also include any block with SCL logic
  for (const net of networks) {
    if (net.logic && net.logic.startsWith('SCL:') && net.block_name) {
      priorityBlocks.add(net.block_name);
    }
  }

  let totalLogicChars = 0;
  const MAX_TOTAL_LOGIC = 40000; // Keep total under ~10K tokens

  for (const blockName of priorityBlocks) {
    if (totalLogicChars >= MAX_TOTAL_LOGIC) break;

    const blockNets = networks.filter(n => n.block_name === blockName && n.logic);
    if (blockNets.length === 0) continue;

    // Get FB number for DIX resolution
    const fbMatch = blockName.match(/^FB(\d+)$/);
    const fbNum = fbMatch ? parseInt(fbMatch[1]) : 0;
    const dbNum = fbToDb[fbNum] || 0;

    const logicEntries = [];
    const seenLogic = new Set(); // Deduplicate identical logic

    for (const net of blockNets) {
      if (totalLogicChars >= MAX_TOTAL_LOGIC) break;

      let readable = null;
      if (net.logic.startsWith('SCL:')) {
        // SCL: show the actual code with some cleanup
        readable = net.logic.substring(4).trim();
        readable = readable
          .replace(/;/g, ';\n    ')
          .replace(/THEN/gi, ' THEN\n      ')
          .replace(/ELSIF/gi, '\n    ELSIF ')
          .replace(/ELSE;/gi, '\n    ELSE\n      ')
          .replace(/END_IF/gi, '\n    END_IF')
          .replace(/END_CASE/gi, '\n    END_CASE')
          .replace(/REGION/gi, '\n    // REGION');
      } else {
        // AWL: translate to readable form with DIX resolution
        let logic = net.logic;
        // Resolve DIX[AR2,P#byte.bit] → DB<dbNum>.DBXbyte.bit (signal name)
        if (dbNum > 0) {
          logic = logic.replace(/DIX\s*\[AR2,\s*P#(\d+)\.(\d+)\]/g, (m, byte, bit) => {
            const addr = `DB${dbNum}.DBX${byte}.${bit}`;
            const name = signalByAddr[addr];
            return name ? `${addr}(${name})` : addr;
          });
          logic = logic.replace(/DI([WDB])\s*\[AR2,\s*P#(\d+)\.\d+\]/g, (m, size, byte) => {
            const sizeMap = { W: 'DBW', D: 'DBD', B: 'DBB' };
            const addr = `DB${dbNum}.${sizeMap[size] || 'DBW'}${byte}`;
            const name = signalByAddr[addr];
            return name ? `${addr}(${name})` : addr;
          });
          logic = logic.replace(/DIX\s+(\d+)\.(\d+)/g, (m, byte, bit) => {
            const addr = `DB${dbNum}.DBX${byte}.${bit}`;
            const name = signalByAddr[addr];
            return name ? `${addr}(${name})` : addr;
          });
          logic = logic.replace(/DI([WDB])\s+(\d+)/g, (m, size, byte) => {
            const sizeMap = { W: 'DBW', D: 'DBD', B: 'DBB' };
            const addr = `DB${dbNum}.${sizeMap[size] || 'DBW'}${byte}`;
            const name = signalByAddr[addr];
            return name ? `${addr}(${name})` : addr;
          });
        }
        // Resolve I/Q/M addresses to names
        logic = logic.replace(/([IQM])\s+(\d+\.\d+)/g, (m, area, addr) => {
          const full = `${area}${addr}`;
          const name = signalByAddr[full];
          return name ? `${full}(${name})` : full;
        });
        // Resolve DB addresses (skip already resolved ones with parentheses)
        logic = logic.replace(/DB\s+(\d+)/g, 'DB$1');
        logic = logic.replace(/(DB\d+\.DB[XWDB]\d+(?:\.\d+)?)(?!\()/g, (m, addr) => {
          const name = signalByAddr[addr];
          return name ? `${addr}(${name})` : addr;
        });

        readable = awlToCompactReadable(logic);
      }

      if (readable && readable.length > 5) {
        // Deduplicate: skip if we've seen identical logic
        const logicKey = readable.substring(0, 200);
        if (seenLogic.has(logicKey)) continue;
        seenLogic.add(logicKey);

        // Limit per network
        if (readable.length > 1200) readable = readable.substring(0, 1200) + '...';
        logicEntries.push({
          network: net.network_number,
          comment: net.comment || null,
          logic: readable
        });
        totalLogicChars += readable.length;
      }
    }

    if (logicEntries.length > 0) {
      result[blockName] = logicEntries;
    }
  }

  return result;
}

/**
 * Compact AWL to readable format (simpler than the cross-reference version).
 * Focus on showing the logical operation, not every instruction.
 */
function awlToCompactReadable(awlLogic) {
  if (!awlLogic) return null;

  const parts = awlLogic.split(';').map(s => s.trim()).filter(Boolean);
  const expressions = [];
  let currentInputs = [];
  let currentOp = 'AND';
  let akku1 = null;
  let akku2 = null;

  for (const part of parts) {
    const tokens = part.split(/\s+/);
    const op = tokens[0];
    const operand = tokens.slice(1).join('').replace(/\s+/g, '');

    switch (op) {
      case 'A': currentInputs.push(operand); currentOp = 'AND'; break;
      case 'AN': currentInputs.push(`NOT ${operand}`); currentOp = 'AND'; break;
      case 'O':
        if (operand) currentInputs.push(operand);
        currentOp = 'OR';
        break;
      case 'ON':
        if (operand) currentInputs.push(`NOT ${operand}`);
        currentOp = 'OR';
        break;
      case 'L': akku2 = akku1; akku1 = operand; break;
      case 'T':
        if (akku1) expressions.push(`${operand} := ${akku1}`);
        break;
      case '=':
        if (currentInputs.length > 0) {
          expressions.push(`${operand} := ${currentInputs.join(` ${currentOp} `)}`);
          currentInputs = [];
        }
        break;
      case 'S':
        if (currentInputs.length > 0) {
          expressions.push(`SET ${operand} WHEN ${currentInputs.join(` ${currentOp} `)}`);
          currentInputs = [];
        }
        break;
      case 'R':
        if (currentInputs.length > 0) {
          expressions.push(`RESET ${operand} WHEN ${currentInputs.join(` ${currentOp} `)}`);
          currentInputs = [];
        }
        break;
      case '>I': case '>R': case '<I': case '<R': case '==I': case '==R':
      case '>=I': case '>=R': case '<=I': case '<=R':
        if (akku1 && akku2) {
          const cmp = op.replace(/[IRD]$/, '');
          currentInputs.push(`${akku2} ${cmp} ${akku1}`);
        }
        break;
      case '+I': case '+R': case '-I': case '-R': case '*I': case '*R': case '/I': case '/R':
        if (akku1 && akku2) {
          akku1 = `(${akku2} ${op[0]} ${akku1})`;
          akku2 = null;
        }
        break;
      case 'UC': case 'CC':
        expressions.push(`CALL ${operand}`);
        break;
      case 'OPN':
        if (operand.startsWith('DI')) expressions.push(`OPEN INSTANCE ${operand}`);
        break;
      default: break;
    }
  }

  return expressions.length > 0 ? expressions.join('\n    ') : null;
}

// ═══════════════════════════════════════════════════════════════
// 7. Machine Description Builder
// ═══════════════════════════════════════════════════════════════

/**
 * Build a clear-text machine description that an AI can read to understand
 * the complete machine behavior.
 */
function buildMachineDescription(machine, callHierarchy, blockPurposes, autoAnalysis, stateAnalysis, sequences, signals, blockLogic) {
  const lines = [];

  // ── Header ──
  lines.push(`=== MASCHINENBESCHREIBUNG / MACHINE PROGRAM FLOW ===`);
  lines.push(`Maschine: ${machine.name} | SPS: ${machine.plc_type} | Signale: ${signals.length}`);
  lines.push('');

  // ── Call Hierarchy ──
  lines.push('--- PROGRAMM-HIERARCHIE (welcher Baustein ruft welchen auf) ---');
  const rootBlocks = findRootBlocks(callHierarchy);

  // Check if this is mostly data references (TIA) vs real calls (Step7)
  const totalCalls = Object.values(callHierarchy).reduce((s, c) => s + c.length, 0);
  const dataRefCalls = Object.values(callHierarchy).reduce(
    (s, c) => s + c.filter(x => x.type === 'data_reference').length, 0
  );
  const isDataRefHierarchy = totalCalls > 0 && (dataRefCalls / totalCalls) > 0.5;

  if (isDataRefHierarchy) {
    // TIA-style: flat list showing which blocks interact with which
    lines.push('(Datenreferenzen zwischen Bausteinen:)');
    for (const [caller, calls] of Object.entries(callHierarchy)) {
      const purpose = blockPurposes[caller]?.purpose;
      const callees = calls.map(c => c.callee).join(', ');
      let line = `${caller}`;
      if (purpose) line += ` [${purpose}]`;
      line += ` → ${callees}`;
      lines.push(line);
    }
  } else if (rootBlocks.length > 0) {
    for (const root of rootBlocks) {
      printCallTree(root, callHierarchy, blockPurposes, lines, 0, new Set());
    }
  } else {
    lines.push('(Keine Aufrufhierarchie erkannt – Bausteine nach Funktion:)');
  }
  lines.push('');

  // ── Block purposes ──
  lines.push('--- BAUSTEINE UND IHRE FUNKTION ---');
  const purposeGroups = {};
  for (const [block, data] of Object.entries(blockPurposes)) {
    const purpose = data.purpose || 'Sonstige';
    if (!purposeGroups[purpose]) purposeGroups[purpose] = [];
    purposeGroups[purpose].push({ block, ...data });
  }
  for (const [purpose, blocks] of Object.entries(purposeGroups)) {
    lines.push(`${purpose}:`);
    for (const b of blocks.slice(0, 10)) {
      let line = `  ${b.block} (${b.networkCount} Netzwerke)`;
      if (b.topComments.length > 0) {
        line += ` – "${b.topComments[0].substring(0, 80)}"`;
      }
      lines.push(line);
    }
  }
  lines.push('');

  // ── Automatic Mode ──
  lines.push('--- AUTOMATIK-MODUS (wie wird Automatik hergestellt) ---');
  if (autoAnalysis.signals.length > 0) {
    lines.push('Automatik-Signale:');
    for (const s of autoAnalysis.signals.slice(0, 10)) {
      lines.push(`  ${s.address || '?'} "${s.name}" ${s.comment ? '// ' + s.comment : ''} [${s.block}]`);
    }
    if (autoAnalysis.dependencies.length > 0) {
      lines.push('Bedingungen für Automatik:');
      for (const dep of autoAnalysis.dependencies.slice(0, 10)) {
        lines.push(`  ${dep.autoSignal} ← geschrieben in ${dep.writtenIn}`);
        if (dep.networkComment) lines.push(`    Netzwerk: ${dep.networkComment.substring(0, 100)}`);
        if (dep.inputs.length > 0) lines.push(`    Eingänge: ${dep.inputs.slice(0, 6).join(', ')}`);
      }
    }
  } else {
    lines.push('(Keine eindeutigen Automatik-Signale erkannt)');
  }
  lines.push('');

  // ── Machine States ──
  lines.push('--- MASCHINENZUSTÄNDE (erkannte Zustandssignale) ---');
  const stateLabels = {
    producing: 'PRODUZIERT (Maschine läuft wirklich)',
    errors: 'FEHLER/STÖRUNG',
    safety: 'SAFETY/NOT-HALT/SCHUTZTÜREN',
    speed: 'GESCHWINDIGKEIT/DREHZAHL',
    drives: 'ANTRIEBE/MOTOREN',
    ready: 'BEREIT/FREIGABE'
  };
  for (const [key, label] of Object.entries(stateLabels)) {
    const sigs = stateAnalysis[key] || [];
    if (sigs.length > 0) {
      lines.push(`${label}:`);
      for (const s of sigs.slice(0, 8)) {
        lines.push(`  ${s.address || '?'} [${s.name || ''}] ${s.comment ? '// ' + s.comment : ''}`);
      }
    }
  }
  lines.push('');

  // ── Sequences ──
  if (sequences.length > 0) {
    lines.push('--- ABLAUFKETTEN / SCHRITTKETTEN (GRAPH) ---');
    for (const seq of sequences) {
      lines.push(`${seq.block} [${seq.type}] – ${seq.steps.length} Schritte:`);
      for (const step of seq.steps.slice(0, 20)) {
        lines.push(`  Schritt ${step.number}: ${step.description}`);
        if (step.signals.length > 0) {
          lines.push(`    Signale: ${step.signals.slice(0, 5).join(', ')}`);
        }
      }
    }
    lines.push('');
  }

  // ── Key Block Logic (the actual code!) ──
  if (blockLogic && Object.keys(blockLogic).length > 0) {
    lines.push('--- PROGRAMMLOGIK DER WICHTIGSTEN BAUSTEINE ---');
    lines.push('(Das ist der tatsächliche Code – so versteht man was die Maschine WIRKLICH macht)');
    lines.push('');
    for (const [blockName, entries] of Object.entries(blockLogic)) {
      const purpose = blockPurposes[blockName]?.purpose || '';
      lines.push(`█ ${blockName}${purpose ? ' [' + purpose + ']' : ''}:`);
      for (const entry of entries.slice(0, 15)) {
        if (entry.comment && !entry.comment.startsWith('MC7 Logic:') && !entry.comment.startsWith('SCL:')) {
          lines.push(`  // NW${entry.network}: ${entry.comment.substring(0, 100)}`);
        }
        lines.push(`  ${entry.logic}`);
      }
      if (entries.length > 15) {
        lines.push(`  ... (${entries.length - 15} weitere Netzwerke)`);
      }
      lines.push('');
    }
  }

  // ── Behavior Summary ──
  lines.push('--- ZUSAMMENFASSUNG: MASCHINENVERHALTEN ---');
  lines.push(buildBehaviorSummary(blockPurposes, autoAnalysis, stateAnalysis, sequences, callHierarchy));

  return lines.join('\n');
}

/**
 * Find root blocks (called by nobody, but call others = entry points).
 * Typically OB1, OB35, etc.
 */
function findRootBlocks(callHierarchy) {
  const allCallers = new Set(Object.keys(callHierarchy));
  const allCallees = new Set();
  for (const calls of Object.values(callHierarchy)) {
    for (const c of calls) {
      allCallees.add(c.callee);
    }
  }

  // Root = caller that is not called by anyone
  const roots = [...allCallers].filter(c => !allCallees.has(c));

  // Sort: OB first, then FB, then FC
  roots.sort((a, b) => {
    const oa = a.startsWith('OB') ? 0 : a.startsWith('FB') ? 1 : 2;
    const ob = b.startsWith('OB') ? 0 : b.startsWith('FB') ? 1 : 2;
    return oa - ob;
  });

  return roots.length > 0 ? roots : [...allCallers].slice(0, 5);
}

/**
 * Print a call tree recursively with indentation.
 */
function printCallTree(block, hierarchy, purposes, lines, depth, visited) {
  if (depth > 4 || visited.has(block)) {
    if (visited.has(block)) lines.push('  '.repeat(depth) + `${block} (→ siehe oben)`);
    return;
  }
  visited.add(block);

  const purpose = purposes[block]?.purpose;
  let line = '  '.repeat(depth) + block;
  if (purpose) line += ` [${purpose}]`;
  lines.push(line);

  const calls = hierarchy[block] || [];
  for (const call of calls) {
    printCallTree(call.callee, hierarchy, purposes, lines, depth + 1, new Set(visited));
  }
}

/**
 * Build a natural-language behavior summary from all analyzed data.
 */
function buildBehaviorSummary(blockPurposes, autoAnalysis, stateAnalysis, sequences, callHierarchy) {
  const parts = [];

  // Identify main functional groups
  const groups = {};
  for (const [block, data] of Object.entries(blockPurposes)) {
    if (data.purpose) {
      if (!groups[data.purpose]) groups[data.purpose] = [];
      groups[data.purpose].push(block);
    }
  }

  // Describe the machine type from block purposes
  const machineType = [];
  if (groups['Extruder']) machineType.push('Extruder');
  if (groups['Raupe/Abzug (Haul-off)']) machineType.push('Abzug/Raupe');
  if (groups['Wickler (Winder)']) machineType.push('Wickler');
  if (groups['Säge/Schneider (Cutter)']) machineType.push('Säge');
  if (groups['Dosierung (Dosing/Feeding)']) machineType.push('Dosierung');
  if (groups['Temperaturregelung (Temperature Control)']) machineType.push('Temperaturregelung');

  if (machineType.length > 0) {
    parts.push(`Die Maschine ist eine Produktionslinie mit: ${machineType.join(', ')}.`);
  }

  // Describe startup sequence
  parts.push('');
  parts.push('TYPISCHER ABLAUF:');

  if (autoAnalysis.signals.length > 0) {
    const autoNames = autoAnalysis.signals.slice(0, 3).map(s => s.name || s.address).join(', ');
    parts.push(`1. EINSCHALTEN: Betriebsbereitschaft herstellen (Safety OK, Schutztüren zu, Freigaben)`);
    parts.push(`2. AUTOMATIK WÄHLEN: Betriebsart auf Automatik (${autoNames})`);
  } else {
    parts.push(`1. EINSCHALTEN: Betriebsbereitschaft herstellen`);
    parts.push(`2. AUTOMATIK WÄHLEN: Betriebsart auf Automatik`);
  }

  if (stateAnalysis.drives.length > 0) {
    parts.push(`3. ANTRIEBE STARTEN: Motoren freigeben und hochfahren`);
  }

  if (stateAnalysis.speed.length > 0) {
    const speedNames = stateAnalysis.speed.slice(0, 2).map(s => s.name || s.address).join(', ');
    parts.push(`4. PRODUKTION: Geschwindigkeit > 0 (${speedNames}) = Maschine produziert`);
  }

  if (stateAnalysis.errors.length > 0) {
    parts.push(`5. BEI STÖRUNG: Fehler-Signale setzen Maschine auf Störung, Antriebe stoppen`);
  }

  // Describe sequences if found
  if (sequences.length > 0) {
    parts.push('');
    parts.push('ABLAUFKETTEN:');
    for (const seq of sequences) {
      parts.push(`${seq.block}: ${seq.steps.length} Schritte`);
      for (const step of seq.steps.slice(0, 5)) {
        parts.push(`  → Schritt ${step.number}: ${step.description}`);
      }
      if (seq.steps.length > 5) parts.push(`  → ... und ${seq.steps.length - 5} weitere Schritte`);
    }
  }

  // Key signals for producing
  parts.push('');
  parts.push('WICHTIG FÜR AI-MAPPING:');
  parts.push('- "Producing" = Automatik-Bit AND Geschwindigkeit > 0 AND kein Fehler');
  parts.push('- "Automatic" = NUR die Betriebsart, NICHT dass produziert wird');
  parts.push('- Safety-Signale mit AND verknüpfen (alle müssen OK sein)');
  parts.push('- Fehler-Signale mit OR verknüpfen (jeder einzelne Fehler zählt)');
  parts.push('- Geschwindigkeit als REAL > 0 prüfen für "läuft tatsächlich"');

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// Format for AI prompt (compact)
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a compact program flow section for the AI mapping prompt.
 * Designed to give AI maximum understanding in minimum tokens.
 */
function programFlowForPrompt(flowData) {
  if (!flowData || !flowData.description) return '';
  return flowData.description;
}

module.exports = { buildProgramFlow, programFlowForPrompt };
