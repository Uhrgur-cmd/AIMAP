/**
 * Cross-Reference Builder
 *
 * Builds a dependency tree for every signal in the PLC program.
 * Works on the parsed data already in the database (signals + network_comments),
 * so it's format-independent: works for Step7, TIA Portal, Rockwell, OPC UA.
 *
 * For each signal, traces back:
 *   - Which network writes it (= / S / R / T instruction)
 *   - What inputs does that network depend on
 *   - Recursively: what do those inputs depend on
 *   - All with comments resolved from every available source
 *
 * Output: enriched signal profiles that the AI mapper can use for
 * accurate mapping with full semantic context.
 */

const pool = require('../db/pool');

/**
 * Build cross-reference for a machine.
 * Returns an object with enriched signal profiles.
 *
 * @param {string} machineId
 * @returns {Object} { signalProfiles: [...], stats: {...} }
 */
async function buildCrossReference(machineId) {
  // Load machine info to determine PLC type
  const { rows: machineRows } = await pool.query('SELECT plc_type FROM machines WHERE id = $1', [machineId]);
  const plcType = machineRows.length ? machineRows[0].plc_type : null;
  const isS7Classic = plcType && (plcType.startsWith('S7-3') || plcType.startsWith('S7-4'));

  // Load all data from DB
  const { rows: signals } = await pool.query(
    'SELECT address, name, data_type, comment, block_name, block_number FROM signals WHERE machine_id = $1 ORDER BY address',
    [machineId]
  );
  const { rows: networks } = await pool.query(
    'SELECT block_name, network_number, comment, signals_referenced, logic FROM network_comments WHERE machine_id = $1',
    [machineId]
  );

  // ─── S7-300/400 specific: Resolve indirect DIX/AR2 addresses ───
  if (isS7Classic) {
    const fbToDb = buildFbToDbMapping(signals, networks);
    const signalByAddr = {};
    for (const s of signals) {
      if (s.address) signalByAddr[normalizeAddr(s.address)] = s;
    }
    resolveIndirectAddresses(networks, fbToDb, signalByAddr);
  }

  // ─── Pass 1a: Build address → comment lookup from ALL sources ───
  const commentLookup = buildCommentLookup(signals, networks);

  // ─── Pass 1b: Build address → writers/readers index from networks ───
  const { writers, readers } = buildSignalIndex(networks);

  // ─── Pass 1c: Build dependency trees ───
  const profiles = [];
  const MAX_DEPTH = 5; // Prevent infinite recursion

  for (const signal of signals) {
    const addr = signal.address;
    if (!addr) continue;

    const profile = {
      address: addr,
      name: signal.name || null,
      data_type: signal.data_type || null,
      comment: signal.comment || commentLookup[normalizeAddr(addr)] || null,
      block_name: signal.block_name || null,
      writtenBy: [],    // Networks that write this signal
      readBy: [],       // Networks that read this signal
      dependsOn: [],    // Input signals this depends on (with their comments)
      dependencyTree: null, // Full recursive tree (string description)
    };

    // Find all networks that WRITE this signal
    const addrNorm = normalizeAddr(addr);
    const writerNets = writers[addrNorm] || [];
    for (const net of writerNets) {
      profile.writtenBy.push({
        block: net.block_name,
        network: net.network_number,
        comment: net.comment,
        logic: net.logic
      });
    }

    // Find all networks that READ this signal
    const readerNets = readers[addrNorm] || [];
    for (const net of readerNets) {
      profile.readBy.push({
        block: net.block_name,
        network: net.network_number,
        comment: net.comment
      });
    }

    // Build dependency tree: what inputs does this signal depend on?
    const visited = new Set();
    profile.dependencyTree = buildDependencyTree(addrNorm, writers, commentLookup, visited, 0, MAX_DEPTH);

    // Flatten dependencies for quick access
    if (profile.dependencyTree) {
      flattenDependencies(profile.dependencyTree, profile.dependsOn, commentLookup);
    }

    profiles.push(profile);
  }

  // Stats
  const withWriters = profiles.filter(p => p.writtenBy.length > 0).length;
  const withDeps = profiles.filter(p => p.dependsOn.length > 0).length;
  const withComments = profiles.filter(p => p.comment).length;

  return {
    signalProfiles: profiles,
    stats: {
      totalSignals: profiles.length,
      withComments,
      withWriters,
      withDependencies: withDeps,
      totalNetworks: networks.length
    }
  };
}

/**
 * Build a lookup: normalized address → best comment from all sources.
 * Searches signals table, network comments, FB interfaces.
 */
function buildCommentLookup(signals, networks) {
  const lookup = {};

  // Source 1: Signal table (symbol table + DB interface comments)
  for (const s of signals) {
    if (!s.address || !s.comment) continue;
    const addr = normalizeAddr(s.address);
    if (!lookup[addr] || s.comment.length > (lookup[addr].length || 0)) {
      lookup[addr] = s.comment;
    }
    // Also store by name for symbolic lookups
    if (s.name) {
      const nameNorm = s.name.replace(/\s+/g, '').toLowerCase();
      if (!lookup[nameNorm]) lookup[nameNorm] = s.comment;
    }
  }

  // Source 2: Signal names (even without comment, the name itself is context)
  for (const s of signals) {
    if (!s.address || !s.name) continue;
    const addr = normalizeAddr(s.address);
    if (!lookup[addr] && s.name.length > 2) {
      lookup[addr] = `[name: ${s.name}]`;
    }
  }

  // Source 3: FB Interface networks – extract parameter names and comments
  for (const net of networks) {
    if (!net.comment || !net.comment.startsWith('Interface:')) continue;
    // Parse "Interface: VAR_INPUT | temperature : REAL ; //Einlauftemp | ..."
    const parts = net.comment.split('|').map(p => p.trim());
    for (const part of parts) {
      const varMatch = part.match(/^(\w+)\s*:\s*\w+\s*;?\s*(?:\/\/\s*(.+))?$/);
      if (varMatch) {
        const varName = varMatch[1].toLowerCase();
        const varComment = varMatch[2]?.trim();
        if (varComment && !lookup[varName]) {
          lookup[varName] = `${net.block_name}: ${varComment}`;
        }
      }
    }
  }

  // Source 4: ALL networks with assignments – MC7 Logic, SCL, and general
  for (const net of networks) {
    if (!net.comment) continue;

    // MC7 Logic: "MC7 Logic: = DBX0.4 depends on [M0.6, L1.1]"
    const mc7Match = net.comment.match(/MC7 Logic:\s*(.+?)\s*depends on/);
    if (mc7Match) {
      const outputAddr = normalizeAddr(mc7Match[1].replace(/^[=SRT]\s*/, ''));
      if (outputAddr && !lookup[outputAddr]) {
        lookup[outputAddr] = `Written in ${net.block_name}`;
      }
    }

    // SCL: "SCL: output := input1 input2 ..."
    const sclMatch = net.comment.match(/^SCL:\s*(\S+)\s/);
    if (sclMatch) {
      const outputAddr = normalizeAddr(sclMatch[1]);
      if (outputAddr && !lookup[outputAddr]) {
        lookup[outputAddr] = `Written in ${net.block_name} (SCL)`;
      }
    }

    // Any network with logic field
    if (net.logic && net.block_name) {
      // Find := assignments in SCL logic
      const assigns = net.logic.match(/(\S+)\s*:=/g);
      if (assigns) {
        for (const a of assigns) {
          const addr = normalizeAddr(a.replace(/\s*:=$/, ''));
          if (addr && addr.length > 2 && !lookup[addr]) {
            lookup[addr] = `Written in ${net.block_name}`;
          }
        }
      }
    }
  }

  return lookup;
}

/**
 * Build index: which networks WRITE which addresses, which READ.
 * Parses MC7 Logic comments and signals_referenced fields.
 */
function buildSignalIndex(networks) {
  const writers = {}; // addr → [network entries that assign/set/transfer to it]
  const readers = {}; // addr → [network entries that read it]

  for (const net of networks) {
    const refs = net.signals_referenced || [];

    // ─── MC7 Logic: "MC7 Logic: = DBX0.4 depends on [M0.6, L1.1]" ───
    if (net.comment && net.comment.startsWith('MC7 Logic:')) {
      const match = net.comment.match(/MC7 Logic:\s*(.+?)\s*depends on\s*\[([^\]]*)\]/);
      if (match) {
        const outputAddr = normalizeAddr(match[1].replace(/^[=SRT]\s*/, ''));
        const inputs = match[2].split(',').map(s => normalizeAddr(s.trim())).filter(Boolean);

        if (outputAddr) {
          if (!writers[outputAddr]) writers[outputAddr] = [];
          writers[outputAddr].push(net);
        }
        for (const inp of inputs) {
          if (!readers[inp]) readers[inp] = [];
          readers[inp].push(net);
        }
      }
      continue;
    }

    // ─── SCL: "SCL: output := expression with inputs" ───
    if (net.comment && net.comment.startsWith('SCL:')) {
      const sclText = net.comment.substring(4).trim();
      // Find the output (first symbol before :=)
      const assignIdx = sclText.indexOf(' := ');
      if (assignIdx > 0) {
        const outputAddr = normalizeAddr(sclText.substring(0, assignIdx).trim());
        if (outputAddr && outputAddr.length > 2) {
          if (!writers[outputAddr]) writers[outputAddr] = [];
          writers[outputAddr].push(net);
        }
        // Everything after := are inputs (from signals_referenced)
        for (const ref of refs) {
          const addr = normalizeAddr(ref);
          if (addr && addr !== outputAddr) {
            if (!readers[addr]) readers[addr] = [];
            readers[addr].push(net);
          }
        }
        continue;
      }
    }

    // ─── General: logic field with := assignments ───
    if (net.logic) {
      // SCL assignments: "output := input"
      const sclAssigns = net.logic.match(/([A-Za-z_][\w.]*)\s*:=/g);
      if (sclAssigns) {
        for (const a of sclAssigns) {
          const addr = normalizeAddr(a.replace(/\s*:=$/, ''));
          if (addr && addr.length > 2) {
            if (!writers[addr]) writers[addr] = [];
            writers[addr].push(net);
          }
        }
      }
      // AWL assignments: "= Q 1.3" or "T DBW 4"
      const awlAssigns = net.logic.match(/[=SRT]\s+([A-Z]+\s*[\d.]+)/g);
      if (awlAssigns) {
        for (const a of awlAssigns) {
          const addr = normalizeAddr(a.replace(/^[=SRT]\s*/, ''));
          if (addr) {
            if (!writers[addr]) writers[addr] = [];
            writers[addr].push(net);
          }
        }
      }
    }

    // ─── All referenced signals are READ by this network ───
    for (const ref of refs) {
      const addr = normalizeAddr(ref);
      if (addr && addr.length > 1) {
        if (!readers[addr]) readers[addr] = [];
        readers[addr].push(net);
      }
    }
  }

  return { writers, readers };
}

/**
 * Recursively build dependency tree for a signal address.
 * Returns a tree node with children representing input dependencies.
 */
function buildDependencyTree(addr, writers, commentLookup, visited, depth, maxDepth) {
  if (depth >= maxDepth) return null;
  if (visited.has(addr)) return { addr, comment: commentLookup[addr] || null, circular: true };
  visited.add(addr);

  const writerNets = writers[addr] || [];
  if (writerNets.length === 0) {
    // Leaf node – no known writer, this is a raw input
    return {
      addr,
      comment: commentLookup[addr] || null,
      leaf: true
    };
  }

  // Use the first (most specific) writer
  const net = writerNets[0];
  const node = {
    addr,
    comment: commentLookup[addr] || null,
    writtenBy: net.block_name + ' NW' + net.network_number,
    networkComment: net.comment || null,
    logic: net.logic || null,
    inputs: []
  };

  // Extract input addresses from this network
  let inputAddrs = [];
  if (net.comment && net.comment.startsWith('MC7 Logic:')) {
    const match = net.comment.match(/depends on\s*\[([^\]]*)\]/);
    if (match) {
      inputAddrs = match[1].split(',').map(s => normalizeAddr(s.trim())).filter(Boolean);
    }
  } else if (net.signals_referenced) {
    inputAddrs = net.signals_referenced.map(r => normalizeAddr(r)).filter(Boolean);
  }

  // Recurse into each input
  for (const inputAddr of inputAddrs) {
    if (inputAddr === addr) continue; // Skip self-reference
    const child = buildDependencyTree(inputAddr, writers, commentLookup, new Set(visited), depth + 1, maxDepth);
    if (child) {
      node.inputs.push(child);
    }
  }

  return node;
}

/**
 * Flatten a dependency tree into a simple list of {address, comment} pairs.
 */
function flattenDependencies(tree, result, commentLookup) {
  if (!tree) return;
  if (tree.inputs) {
    for (const child of tree.inputs) {
      const existing = result.find(r => r.address === child.addr);
      if (!existing) {
        result.push({
          address: child.addr,
          comment: child.comment || commentLookup[child.addr] || null
        });
      }
      flattenDependencies(child, result, commentLookup);
    }
  }
}

/**
 * Normalize a PLC address for consistent lookups.
 * Removes spaces, standardizes format.
 * "DB 2.DBX 0.0" → "DB2.DBX0.0"
 * "M 5.0" → "M5.0"
 * "DIX [AR2, P#0.4]" → "DIX[AR2,P#0.4]"
 */
function normalizeAddr(addr) {
  if (!addr) return null;
  return addr.replace(/\s+/g, '').replace(/^[=SRT]\s*/, '').trim();
}

/**
 * Generate a compact text summary of a signal profile for the AI prompt.
 * Includes the full dependency context that a human engineer would need.
 */
function profileToText(profile) {
  let text = `${profile.address} [${profile.data_type || '?'}]`;
  if (profile.name) text += ` "${profile.name}"`;
  if (profile.comment) text += ` // ${profile.comment}`;
  text += '\n';

  if (profile.writtenBy.length > 0) {
    for (const w of profile.writtenBy.slice(0, 3)) {
      text += `  ← written by ${w.block} NW${w.network}`;
      if (w.comment) text += `: ${w.comment.substring(0, 100)}`;
      text += '\n';
      if (w.logic) text += `    Logic: ${w.logic.substring(0, 150)}\n`;
    }
  }

  if (profile.dependsOn.length > 0) {
    text += `  depends on:\n`;
    for (const dep of profile.dependsOn.slice(0, 10)) {
      text += `    ${dep.address}`;
      if (dep.comment) text += ` // ${dep.comment}`;
      text += '\n';
    }
  }

  return text;
}

/**
 * Generate the full enriched context for AI mapping.
 * This replaces the raw signal list with semantically enriched profiles.
 *
 * @param {string} machineId
 * @returns {string} Formatted text for the AI prompt
 */
async function buildEnrichedContext(machineId) {
  const { signalProfiles, stats } = await buildCrossReference(machineId);

  // Sort: signals with dependencies and comments first (most useful for mapping)
  const sorted = [...signalProfiles].sort((a, b) => {
    const scoreA = (a.comment ? 10 : 0) + (a.writtenBy.length * 5) + (a.dependsOn.length * 3);
    const scoreB = (b.comment ? 10 : 0) + (b.writtenBy.length * 5) + (b.dependsOn.length * 3);
    return scoreB - scoreA;
  });

  let context = `=== PLC SIGNAL PROFILES (${stats.totalSignals} signals, ${stats.withComments} with comments, ${stats.withDependencies} with traced dependencies) ===\n\n`;

  // Group 1: Signals with full dependency context (most valuable)
  const withDeps = sorted.filter(p => p.dependsOn.length > 0 || p.writtenBy.length > 0);
  if (withDeps.length > 0) {
    context += `--- SIGNALS WITH TRACED LOGIC (${withDeps.length}) ---\n`;
    for (const p of withDeps) {
      context += profileToText(p);
    }
    context += '\n';
  }

  // Group 2: Signals with comments but no traced logic
  const withCommentsOnly = sorted.filter(p => p.comment && p.dependsOn.length === 0 && p.writtenBy.length === 0);
  if (withCommentsOnly.length > 0) {
    context += `--- SIGNALS WITH COMMENTS (${withCommentsOnly.length}) ---\n`;
    for (const p of withCommentsOnly) {
      context += `${p.address} [${p.data_type || '?'}] ${p.name || ''} // ${p.comment}\n`;
    }
    context += '\n';
  }

  // Group 3: Signals without comments (compact list)
  const noContext = sorted.filter(p => !p.comment && p.dependsOn.length === 0);
  if (noContext.length > 0) {
    context += `--- OTHER SIGNALS (${noContext.length}, no comments) ---\n`;
    for (const p of noContext) {
      context += `${p.address} [${p.data_type || '?'}] ${p.name || ''}\n`;
    }
  }

  return context;
}

/**
 * Build FB→DB instance mapping.
 * Pragmatic approach: FB N → DB N when both exist.
 * Works for 95%+ of Step7 projects where instance DBs match FB numbers.
 */
function buildFbToDbMapping(signals, networks) {
  const fbToDb = {};

  // Find which FB numbers exist (from interface networks)
  const fbNumbers = new Set();
  for (const net of networks) {
    if (net.block_name && net.block_name.startsWith('FB')) {
      const num = parseInt(net.block_name.replace('FB', ''));
      if (!isNaN(num)) fbNumbers.add(num);
    }
  }

  // Find which DB numbers exist (from signals)
  const dbNumbers = new Set();
  for (const s of signals) {
    if (s.block_number > 0 && s.address && s.address.startsWith('DB')) {
      dbNumbers.add(s.block_number);
    }
  }

  // Match: FB N → DB N when both exist
  for (const fb of fbNumbers) {
    if (dbNumbers.has(fb)) {
      fbToDb[fb] = fb;
    }
  }

  return fbToDb;
}

/**
 * Resolve indirect addresses in networks.
 * Converts DIX[AR2,P#x.y] → DB<instanceDB>.DBXx.y
 * using the FB→DB mapping and the block name context.
 */
function resolveIndirectAddresses(networks, fbToDb, signalByAddr) {
  for (const net of networks) {
    if (!net.comment || !net.block_name) continue;

    // Get the FB number from the block name
    const fbMatch = net.block_name.match(/^FB(\d+)$/);
    if (!fbMatch) continue;
    const fbNum = parseInt(fbMatch[1]);
    const dbNum = fbToDb[fbNum];
    if (!dbNum) continue;

    // Replace DIX[AR2,P#byte.bit] with DB<dbNum>.DBX<byte>.<bit>
    const dixRegex = /DIX\[AR2,P#(\d+)\.(\d+)\]/g;
    const resolve = (str) => {
      if (!str) return str;
      return str.replace(dixRegex, (match, byte, bit) => {
        const resolved = `DB${dbNum}.DBX${byte}.${bit}`;
        // Try to find a name for this address
        const sig = signalByAddr[normalizeAddr(resolved)];
        if (sig && sig.name) {
          return `${resolved}(${sig.name})`;
        }
        return resolved;
      });
    };

    // Also resolve DIX byte.bit (without AR2 prefix) for simple FB access
    const dixSimpleRegex = /DIX\s+(\d+)\.(\d+)/g;
    const resolveSimple = (str) => {
      if (!str) return str;
      return str.replace(dixSimpleRegex, (match, byte, bit) => {
        const resolved = `DB${dbNum}.DBX${byte}.${bit}`;
        const sig = signalByAddr[normalizeAddr(resolved)];
        if (sig && sig.name) {
          return `${resolved}(${sig.name})`;
        }
        return resolved;
      });
    };

    // Also resolve DIW[AR2,P#byte.bit] and DID[AR2,P#byte.bit]
    const diwRegex = /DI([WDB])\[AR2,P#(\d+)\.(\d+)\]/g;
    const resolveWord = (str) => {
      if (!str) return str;
      return str.replace(diwRegex, (match, size, byte, bit) => {
        const sizeMap = { W: 'DBW', D: 'DBD', B: 'DBB' };
        return `DB${dbNum}.${sizeMap[size] || 'DBW'}${byte}`;
      });
    };

    // Apply all resolutions to comment, logic, and signals_referenced
    net.comment = resolveWord(resolveSimple(resolve(net.comment)));
    if (net.logic) net.logic = resolveWord(resolveSimple(resolve(net.logic)));
    if (net.signals_referenced && Array.isArray(net.signals_referenced)) {
      net.signals_referenced = net.signals_referenced.map(ref => {
        let resolved = resolve(ref);
        resolved = resolveSimple(resolved);
        resolved = resolveWord(resolved);
        return resolved;
      });
    }
  }
}

module.exports = { buildCrossReference, buildEnrichedContext, profileToText };
