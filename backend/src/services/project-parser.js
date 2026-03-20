const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const path = require('path');
const fs = require('fs');
const { decodeMC7, extractLogicChains } = require('./mc7-decoder');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['Member', 'Subelement', 'Section', 'SW.Blocks.CompileUnit', 'Comment', 'MultiLanguageText', 'Component'].includes(name),
  removeNSPrefix: true
});

// Second parser with preserveOrder for correct SCL token stream extraction.
// fast-xml-parser without preserveOrder groups elements by tag name and loses
// the original document order, which scrambles SCL code (operators end up in
// the wrong position). This parser keeps every element in document order so
// we can reconstruct the SCL source faithfully.
const orderedXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  removeNSPrefix: true
});

/**
 * Main entry: parse .zap/.zapXX (TIA), .s7p (Step7), or .L5X (Rockwell).
 * Returns unified signal format regardless of source.
 */
async function parseProjectFile(filePath, plcType, tiaVersion) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.l5x') {
    return parseRockwellL5X(filePath, plcType);
  }
  if (ext === '.s7p') {
    return parseStep7Project(filePath, plcType);
  }
  if (ext.startsWith('.zap')) {
    // Check if V17+ binary format (has PEData.plf) vs V13-V16 XML format
    let hasPEData = false;
    try {
      const zip = new AdmZip(filePath);
      hasPEData = zip.getEntries().some(e => /PEData\.plf$/i.test(e.entryName));
    } catch (e) { /* not a valid ZIP */ }

    if (hasPEData) {
      // V17+ binary – throws with user instructions
      return parseTiaV17Plus(filePath, plcType, tiaVersion);
    }
    return parseTiaProject(filePath, plcType, tiaVersion);
  }

  // Try as ZIP regardless of extension – detect Step7 vs TIA by contents
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();

    // Step7 V5 native project: has SYMLIST.DBF or SUBBLK.DBF or ombstx folder
    const isStep7Native = entries.some(e =>
      /SYMLIST\.DBF$/i.test(e.entryName) || /SUBBLK\.DBF$/i.test(e.entryName) || /ombstx/i.test(e.entryName)
    );
    if (isStep7Native) return parseStep7Project(filePath, plcType);

    // TIA V17+ binary format: has PEData.plf
    const hasPEData = entries.some(e => /PEData\.plf$/i.test(e.entryName));
    if (hasPEData) return parseTiaV17Plus(filePath, plcType, tiaVersion);

    // TIA Portal V13-V16: has XML files with block definitions
    const hasTiaXml = entries.some(e =>
      e.entryName.endsWith('.xml') && !e.isDirectory
    );
    const hasAwl = entries.some(e => /\.awl$/i.test(e.entryName));

    if (hasAwl) return parseStep7Project(filePath, plcType);
    if (hasTiaXml) return parseTiaProject(filePath, plcType);
  } catch (e) { /* not a ZIP */ }

  // Maybe raw L5X XML
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes('<RSLogix5000Content') || content.includes('<Controller')) {
      return parseRockwellL5X(filePath, plcType);
    }
  } catch (e) { /* ignore */ }

  throw new Error(`Unsupported project file format: ${ext}. Supported: .zap, .s7p, .L5X`);
}

// ═════════════════════════════════════════════════════════════
// TIA Portal V17+ – Binary format, requires XML export
// ═════════════════════════════════════════════════════════════

/**
 * TIA Portal V17-V20 uses a proprietary binary format (PEData.plf).
 * Direct parsing is not reliable. Instead, we require the user to export
 * their blocks as XML from TIA Portal, and upload the XML .zip.
 *
 * Export steps (works in every TIA version):
 *   1. Open project in TIA Portal
 *   2. Right-click "PLC Tags" or "Program blocks" in project tree
 *   3. Select "Generate source from blocks" or "Export"
 *   4. Save as XML, zip all exported XMLs together
 *   5. Upload the .zip here
 */
function parseTiaV17Plus(filePath, plcType, tiaVersion) {
  throw new Error(
    `TIA Portal Projektarchive (.zap) enthalten die Bausteine in einem binären Format (PEData.plf) das nicht direkt geparst werden kann.\n\n` +
    `Bitte exportiere deine Bausteine als XML aus TIA Portal:\n\n` +
    `1. Projekt in TIA Portal öffnen\n` +
    `2. Im Projektbaum: "PLC_1 > Programmbausteine" markieren\n` +
    `3. Rechtsklick → "Quelle aus Bausteinen generieren"\n` +
    `   ODER: Rechtsklick → "Exportieren" (ab V16)\n` +
    `4. Alle Bausteine auswählen, als XML exportieren\n` +
    `5. Exportierte Dateien als .zip zusammenpacken\n` +
    `6. Die .zip hier hochladen\n\n` +
    `Tipp: Auch PLC-Variablentabellen exportieren für zusätzlichen Kontext.\n\n` +
    `Alternativ: OPC UA Live-Scan nutzen (Maschine muss online erreichbar sein)`
  );
}

// ═════════════════════════════════════════════════════════════
// TIA Portal V13-V16 XML Parser (.zap / .zapXX)
// ═════════════════════════════════════════════════════════════

function parseTiaProject(filePath, plcType) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const result = {
    source: 'project_file',
    plc_type: plcType || 'S7-1500',
    blocks: [],
    networks: []
  };

  // First pass: build a map of XML filename → parsed content + block metadata
  // so we can resolve block names for network comments
  const blockMetadata = {}; // filename → { blockName, blockType }

  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.endsWith('.xml')) continue;
    try {
      const content = entry.getData().toString('utf-8');
      const parsed = xmlParser.parse(content);

      // Extract block name from this XML file
      const meta = extractBlockMeta(parsed);
      if (meta) blockMetadata[entry.entryName] = meta;

      extractTiaBlocks(parsed, result);
      // Pass raw XML so extractTiaNetworks can use the ordered parser for SCL
      extractTiaNetworks(parsed, result, meta, content);
    } catch (e) { /* skip unparseable XML */ }
  }

  // Calculate addresses for all blocks
  for (const block of result.blocks) {
    calculateAddresses(block);
  }

  return result;
}

/**
 * Extract block name and type from TIA XML file.
 * Works for GlobalDB, InstanceDB, FC, FB, OB.
 */
function extractBlockMeta(parsed) {
  const blockTypes = [
    'SW.Blocks.GlobalDB', 'SW.Blocks.InstanceDB',
    'SW.Blocks.FC', 'SW.Blocks.FB', 'SW.Blocks.OB'
  ];

  for (const bt of blockTypes) {
    const blocks = findAllDeep(parsed, bt);
    for (const block of blocks) {
      const name = getNestedValue(block, 'AttributeList', 'Name');
      const number = getNestedValue(block, 'AttributeList', 'Number');
      if (name || number) {
        const shortType = bt.split('.').pop(); // GlobalDB, FC, FB, OB
        return {
          blockName: name || `${shortType}${number || ''}`,
          blockType: shortType,
          blockNumber: number ? parseInt(number) : null
        };
      }
    }
  }
  return null;
}

/**
 * Extract DB blocks from TIA Portal XML.
 */
function extractTiaBlocks(parsed, result) {
  const globalDbs = findAllDeep(parsed, 'SW.Blocks.GlobalDB');
  const instanceDbs = findAllDeep(parsed, 'SW.Blocks.InstanceDB');

  for (const db of [...globalDbs, ...instanceDbs]) {
    const dbName = getNestedValue(db, 'AttributeList', 'Name') || db['@_Name'] || 'Unknown';
    const dbNumber = parseInt(getNestedValue(db, 'AttributeList', 'Number') || '0');

    const block = {
      db_number: dbNumber,
      name: dbName,
      variables: []
    };

    // TIA V13-V16: Interface is under SW.Blocks.Interface
    // TIA V17+/V19: Interface is directly in AttributeList.Interface
    let interfaces = findAllDeep(db, 'SW.Blocks.Interface');
    if (interfaces.length === 0) {
      // Try AttributeList.Interface (TIA V19 format)
      const attrInterface = getNestedValue(db, 'AttributeList', 'Interface');
      if (attrInterface) interfaces = [attrInterface];
    }
    for (const iface of interfaces) {
      // Sections might be directly under Interface or under Interface.Sections
      let sections = findAllDeep(iface, 'Section');
      if (sections.length === 0 && iface.Sections) {
        const s = iface.Sections.Section;
        sections = Array.isArray(s) ? s : (s ? [s] : []);
      }
      for (const section of Array.isArray(sections) ? sections : [sections]) {
        const sectionName = section['@_Name'] || 'Static';
        if (['Static', 'Input', 'Output', 'InOut', 'Temp'].includes(sectionName)) {
          extractMembers(section, block.variables, `DB${dbNumber}`, '');
        }
      }
    }

    if (block.variables.length > 0) {
      result.blocks.push(block);
    }
  }
}

/**
 * Recursively extract Member elements, handling nested structs and arrays.
 */
function extractMembers(node, variables, dbPrefix, parentPath) {
  const members = node.Member || [];
  for (const member of Array.isArray(members) ? members : [members]) {
    if (!member || !member['@_Name']) continue;

    const name = member['@_Name'];
    const datatype = member['@_Datatype'] || member['@_datatype'] || 'Unknown';
    const comment = extractComment(member);
    const fullPath = parentPath ? `${parentPath}.${name}` : name;

    // Array detection: "Array[0..9] of REAL" or "Array[1..10] of Int"
    const arrayMatch = datatype.match(/^Array\s*\[(\d+)\.\.(\d+)\]\s*of\s+(.+)$/i);
    if (arrayMatch) {
      const lo = parseInt(arrayMatch[1]);
      const hi = parseInt(arrayMatch[2]);
      const elementType = normalizeDatatype(arrayMatch[3]);
      for (let idx = lo; idx <= hi; idx++) {
        variables.push({
          name: `${fullPath}[${idx}]`,
          address: '',
          type: elementType,
          comment: comment ? `${comment} [${idx}]` : null
        });
      }
      continue;
    }

    // Nested struct
    const subelements = member.Subelement || member.Member;
    if (subelements && (datatype.toLowerCase().startsWith('struct') || datatype.startsWith('"'))) {
      const subNode = { Member: subelements };
      extractMembers(subNode, variables, dbPrefix, fullPath);
    } else {
      variables.push({
        name: fullPath,
        address: '',
        type: normalizeDatatype(datatype),
        comment: comment
      });
    }
  }
}

/**
 * Extract network comments + logic from TIA CompileUnit elements.
 * Extracts SCL code from token streams and identifies assignments (dependencies).
 *
 * Uses TWO parsers:
 * - The standard xmlParser (no preserveOrder) for metadata: network number, comments,
 *   Access/Symbol/Component references (works fine without order).
 * - The orderedXmlParser (preserveOrder:true) for SCL token stream reconstruction,
 *   because the token order is critical for correct code output.
 *
 * @param {object} parsed - Result from the standard xmlParser (for metadata).
 * @param {object} result - Accumulator for blocks/networks.
 * @param {object} blockMeta - Block name/type metadata.
 * @param {string} [rawXml] - Original XML string; when provided the ordered parser
 *                             is used for SCL extraction.
 */
function extractTiaNetworks(parsed, result, blockMeta, rawXml) {
  const compileUnits = findAllDeep(parsed, 'SW.Blocks.CompileUnit');

  // Parse with the ordered parser once per file (only when rawXml is available)
  let orderedCompileUnits = null;
  if (rawXml) {
    try {
      const orderedParsed = orderedXmlParser.parse(rawXml);
      orderedCompileUnits = findAllDeepOrdered(orderedParsed, 'SW.Blocks.CompileUnit');
    } catch (e) { /* fall back to unordered extraction */ }
  }

  for (let cuIdx = 0; cuIdx < compileUnits.length; cuIdx++) {
    const cu = compileUnits[cuIdx];
    const networkNumber = parseInt(cu['@_ID'] || cu['@_Number'] || '0');
    const comment = extractComment(cu);
    const blockName = (blockMeta && blockMeta.blockName) || 'Unknown';

    // Extract SCL code from ordered parse tree if available, else fall back
    let scl = '';
    if (orderedCompileUnits && cuIdx < orderedCompileUnits.length) {
      scl = extractSclFromTokens(orderedCompileUnits[cuIdx]);
    } else {
      scl = extractSclFromTokensLegacy(cu);
    }

    // Extract all referenced signals via Access elements (unordered parser is fine here)
    const referencedSignals = [];
    const accessEntries = findAllDeep(cu, 'Access');
    for (const access of accessEntries) {
      if (access['@_Scope'] === 'LiteralConstant' || access['@_Scope'] === 'TypedConstant') continue;
      const components = findAllDeep(access, 'Component');
      if (components.length > 0) {
        const addr = components.map(c => c['@_Name'] || (typeof c === 'string' ? c : '')).filter(Boolean).join('.');
        if (addr && !referencedSignals.includes(addr) && addr.length > 1) {
          referencedSignals.push(addr);
        }
      }
    }

    // Extract assignment dependencies from SCL
    const assignments = extractSclAssignments(scl, referencedSignals);

    // Add the network with SCL logic
    if (comment || referencedSignals.length > 0 || scl) {
      result.networks.push({
        block: blockName,
        network_number: networkNumber,
        comment: comment || null,
        signals_referenced: referencedSignals,
        logic: scl ? scl.substring(0, 500) : null
      });
    }

    // Add individual assignment chains as separate network entries for the cross-reference
    for (const assign of assignments) {
      result.networks.push({
        block: blockName,
        network_number: networkNumber,
        comment: `SCL: ${assign.output} := ${assign.expression}`,
        signals_referenced: assign.inputs,
        logic: assign.fullLine
      });
    }
  }
}

/**
 * Rebuild SCL source code from TIA XML token stream (ordered parser format).
 *
 * With preserveOrder:true, every XML element becomes an object with a single
 * tag-name key whose value is an array of children, plus an optional ':@' key
 * holding attributes. Children appear in document order, so the SCL tokens,
 * symbols, blanks, and newlines are reconstructed in the correct sequence.
 *
 * Format examples:
 *   {Token: [],      ':@': {'@_Text': ':='}}
 *   {Blank: [],      ':@': {'@_Num': '1'}}
 *   {NewLine: []}
 *   {Access: [{Symbol: [{Component: [], ':@': {'@_Name': 'x'}}]}], ':@': {'@_Scope': 'GlobalVariable'}}
 *   {Constant: [{ConstantValue: [{...}]}]}
 */
function extractSclFromTokens(orderedNode) {
  if (!orderedNode || typeof orderedNode !== 'object') return '';
  let text = '';

  // SCL keywords that get spaces around them for readability
  const SPACED_KEYWORDS = new Set([
    ':=', ';', 'IF', 'THEN', 'ELSE', 'ELSIF', 'END_IF',
    'FOR', 'TO', 'DO', 'END_FOR', 'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'AND', 'OR', 'NOT', 'XOR', 'MOD',
    'CASE', 'OF', 'END_CASE',
    'REGION', 'END_REGION',
    'RETURN', 'EXIT', 'CONTINUE',
    '<', '>', '<=', '>=', '<>', '=',
    '+', '-', '*', '/'
  ]);

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    // Each ordered element is { TagName: [children], ':@': {attrs} }
    const keys = Object.keys(node).filter(k => k !== ':@');
    const attrs = node[':@'] || {};

    for (const tag of keys) {
      if (tag === 'Token') {
        const t = attrs['@_Text'] || '';
        if (t) {
          if (SPACED_KEYWORDS.has(t)) {
            text += ' ' + t + ' ';
          } else {
            text += t;
          }
        }
      } else if (tag === 'StlToken') {
        // STL/AWL statement list token (e.g. "L", "T", "A", "=", "CALL")
        const t = attrs['@_Text'] || '';
        if (t === 'EMPTY_LINE') {
          text += '\n';
        } else if (t === 'COMMENT') {
          // Skip – comment text is in a separate element
        } else if (t) {
          text += t + ' ';
        }
      } else if (tag === 'StlStatement') {
        // STL statement – recurse into children, then add newline
        const children = node[tag];
        if (Array.isArray(children)) {
          for (const child of children) walk(child);
        }
        text += '\n';
      } else if (tag === 'Blank') {
        const num = parseInt(attrs['@_Num'] || '1') || 1;
        text += ' '.repeat(num);
      } else if (tag === 'NewLine') {
        text += '\n';
      } else if (tag === 'LineComment') {
        // Skip line comments in SCL output (they are metadata, not code)
      } else if (tag === 'Comment') {
        // Skip XML comment elements
      } else if (tag === 'Parameter') {
        // Function call parameter – emit "Name" then recurse into children
        const paramName = attrs['@_Name'] || '';
        if (paramName) text += paramName;
        const children = node[tag];
        if (Array.isArray(children)) {
          for (const child of children) walk(child);
        }
      } else if (tag === 'Text') {
        // Inline text node (e.g. REGION description text)
        const children = node[tag];
        if (Array.isArray(children)) {
          for (const child of children) {
            if (child && child['#text'] !== undefined) text += String(child['#text']);
          }
        }
      } else if (tag === 'Access') {
        const scope = attrs['@_Scope'] || '';
        const children = node[tag];
        if (scope === 'LiteralConstant' || scope === 'TypedConstant') {
          // Extract constant value (e.g. True, 42, W#16#01)
          text += extractConstantOrdered(children);
        } else if (scope === 'LocalConstant' || scope === 'AddressConstant') {
          // Named constant (e.g. ERROR_INVALID_MODE) or address constant
          text += extractNamedConstantOrdered(children);
        } else if (scope === 'Call') {
          // Function/instruction call – recurse into Instruction children
          // which contain Token, Parameter, Access elements in order
          if (Array.isArray(children)) {
            for (const child of children) {
              if (child && child.Instruction) {
                const instrAttrs = child[':@'] || {};
                const instrName = instrAttrs['@_Name'] || '';
                if (instrName) text += instrName;
                // Recurse into instruction children (tokens, parameters)
                walk(child.Instruction);
              }
            }
          }
        } else {
          // Symbol access – extract component names
          text += extractSymbolOrdered(children);
        }
      } else {
        // Recurse into children (e.g. FlgNet, Parts, StatementList, etc.)
        const children = node[tag];
        if (Array.isArray(children)) {
          for (const child of children) walk(child);
        }
      }
    }
  }

  /**
   * Extract a symbol reference from ordered Access children.
   * Structure: [{Symbol: [{Component: [], ':@': {'@_Name': 'part1'}}, ...]}]
   */
  function extractSymbolOrdered(children) {
    if (!Array.isArray(children)) return '';
    const parts = [];
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      if (child.Symbol) {
        const symbolChildren = child.Symbol;
        if (Array.isArray(symbolChildren)) {
          for (const sc of symbolChildren) {
            if (sc && sc.Component !== undefined) {
              const compAttrs = sc[':@'] || {};
              const name = compAttrs['@_Name'] || '';
              if (name) parts.push(name);
            }
          }
        }
      }
    }
    return parts.length > 0 ? parts.join('.') : '';
  }

  /**
   * Extract a named constant from ordered Access children (LocalConstant scope).
   * Structure: [{Constant: [], ':@': {'@_Name': 'ERROR_INVALID_MODE'}}]
   */
  function extractNamedConstantOrdered(children) {
    if (!Array.isArray(children)) return '';
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      if (child.Constant !== undefined) {
        const constAttrs = child[':@'] || {};
        if (constAttrs['@_Name']) return constAttrs['@_Name'];
      }
    }
    return '';
  }

  /**
   * Extract a constant value from ordered Access children.
   * Structure: [{Constant: [{ConstantValue: [{...}], ':@': {...}}]}]
   *         or [{Constant: [{StringValue: [{...}]}]}]
   */
  function extractConstantOrdered(children) {
    if (!Array.isArray(children)) return '';
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      if (child.Constant) {
        const constChildren = child.Constant;
        if (!Array.isArray(constChildren)) continue;
        for (const cc of constChildren) {
          if (cc.ConstantValue !== undefined) {
            // ConstantValue children contain text nodes
            const cvChildren = cc.ConstantValue;
            if (Array.isArray(cvChildren)) {
              for (const cv of cvChildren) {
                if (cv && cv['#text'] !== undefined) return String(cv['#text']);
              }
            }
            // Might also be empty array with value in ':@'
            const cvAttrs = cc[':@'] || {};
            if (cvAttrs['@_Value']) return cvAttrs['@_Value'];
            return '0';
          }
          if (cc.StringValue !== undefined) {
            const svChildren = cc.StringValue;
            if (Array.isArray(svChildren)) {
              for (const sv of svChildren) {
                if (sv && sv['#text'] !== undefined) return "'" + String(sv['#text']) + "'";
              }
            }
            return "''";
          }
        }
      }
    }
    return '';
  }

  // Walk the ordered node (could be array or object)
  walk(orderedNode);

  return text
    .replace(/\n{3,}/g, '\n\n')   // collapse excessive blank lines
    .replace(/  +/g, ' ')          // collapse multiple spaces (but preserve newlines)
    .trim();
}

/**
 * Legacy SCL extraction from the unordered parser.
 * Used as fallback when rawXml is not available (e.g. Step7 XML path).
 * NOTE: This does NOT produce correct token order – it is only a best-effort fallback.
 */
function extractSclFromTokensLegacy(node) {
  if (!node || typeof node !== 'object') return '';
  let text = '';

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }

    for (const key of Object.keys(obj)) {
      if (key === 'Blank') { text += ' '; continue; }
      if (key === 'NewLine') { text += '\n'; continue; }
      if (key === 'Token') {
        const tks = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
        for (const tk of tks) {
          if (tk && tk['@_Text']) {
            const t = tk['@_Text'];
            if (t === ':=' || t === ';' || t === 'IF' || t === 'THEN' || t === 'ELSE' ||
                t === 'ELSIF' || t === 'END_IF' || t === 'FOR' || t === 'TO' || t === 'DO' ||
                t === 'END_FOR' || t === 'AND' || t === 'OR' || t === 'NOT' || t === 'CASE' ||
                t === 'OF' || t === 'END_CASE' || t === 'REGION' || t === 'END_REGION') {
              text += ' ' + t + ' ';
            } else {
              text += t;
            }
          }
        }
        continue;
      }
      if (key === 'Access') {
        const accs = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
        for (const a of accs) {
          if (a && a['Symbol']) {
            const comps = a['Symbol']['Component'] || [];
            const arr = Array.isArray(comps) ? comps : [comps];
            text += arr.map(c => c['@_Name'] || '').filter(Boolean).join('.');
            text += ' ';
          } else if (a && a['Constant']) {
            const c = a['Constant'];
            if (c['StringValue']) {
              const sv = typeof c['StringValue'] === 'string' ? c['StringValue'] : (c['StringValue']['#text'] || '');
              text += "'" + sv + "'";
            } else if (c['ConstantValue']) {
              text += typeof c['ConstantValue'] === 'object' ? (c['ConstantValue']['#text'] || '0') : c['ConstantValue'];
            }
            text += ' ';
          }
        }
        continue;
      }
      if (key === 'Comment' || key.startsWith('@_')) continue;
      walk(obj[key]);
    }
  }

  walk(node);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract assignment statements from SCL code.
 * Finds patterns like "output := input" or "output := expr AND expr"
 * Returns array of {output, inputs[], expression, fullLine}
 */
function extractSclAssignments(scl, allRefs) {
  if (!scl) return [];
  const assignments = [];

  // Split by lines and find := assignments
  const lines = scl.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes(':=')) continue;

    // Split on :=
    const parts = trimmed.split(':=');
    if (parts.length < 2) continue;

    const output = parts[0].trim().replace(/;$/, '').trim();
    const rhs = parts.slice(1).join(':=').trim().replace(/;$/, '').trim();

    if (!output || !rhs || output.length < 2) continue;

    // Skip IF/THEN/FOR constructs that got merged into one line
    if (output.includes('IF') || output.includes('FOR') || output.includes('THEN')) continue;

    // Find which signals are referenced in the right-hand side
    const inputs = allRefs.filter(ref => rhs.includes(ref) && ref !== output);

    if (inputs.length > 0 || rhs.length > 2) {
      assignments.push({
        output: output,
        inputs: inputs,
        expression: rhs.substring(0, 200),
        fullLine: trimmed.substring(0, 300)
      });
    }
  }

  return assignments;
}

/**
 * Extract logic from LAD/FBD network structure (non-SCL blocks).
 */
function extractLadFbdLogic(compileUnit, references) {
  const contacts = findAllDeep(compileUnit, 'Contact');
  const coils = findAllDeep(compileUnit, 'Coil');

  if (contacts.length > 0 && references.length > 0) {
    const parts = [];
    for (const contact of contacts) {
      const negated = contact['@_Negated'] === 'true';
      const name = getNestedValue(contact, 'Operand', 'Symbol', 'Component');
      if (name) {
        const addr = Array.isArray(name) ? name.map(c => c['@_Name'] || c).join('.') : (name['@_Name'] || name);
        parts.push(negated ? `NOT ${addr}` : addr);
      }
    }
    if (parts.length > 0) return parts.join(' AND ');
  }
  return null;
}

// ═════════════════════════════════════════════════════════════
// Step7 Parser (.s7p)
// ═════════════════════════════════════════════════════════════

function parseStep7Project(filePath, plcType) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const result = {
    source: 'project_file',
    plc_type: plcType || 'S7-300',
    blocks: [],
    networks: []
  };

  // ── Native Step7 V5.x binary project (SYMLIST.DBF / SUBBLK.DBF) ──
  // This is the most common format – no AWL source export needed.
  const symlistEntries = entries.filter(e =>
    /SYMLIST\.DBF$/i.test(e.entryName) && /YDBs/i.test(e.entryName)
  );

  if (symlistEntries.length > 0) {
    // Use the largest SYMLIST.DBF (the main CPU's symbol table)
    const symEntry = symlistEntries.sort((a, b) => b.header.size - a.header.size)[0];
    const symData = symEntry.getData();
    parseStep7SymlistDbf(symData, result);
  }

  // ── Parse SUBBLK.DBF/DBT for DB interface definitions (variable names + comments) ──
  // The offline folder with the largest SUBBLK.DBF is the main CPU
  const subblkEntries = entries.filter(e => /SUBBLK\.DBF$/i.test(e.entryName));
  if (subblkEntries.length > 0) {
    const subblkEntry = subblkEntries.sort((a, b) => b.header.size - a.header.size)[0];
    const subblkDbfData = subblkEntry.getData();

    // Find matching .DBT memo file (same folder)
    const dbtPath = subblkEntry.entryName.replace(/\.DBF$/i, '.DBT');
    const dbtEntry = entries.find(e => e.entryName === dbtPath);
    if (dbtEntry) {
      const dbtData = dbtEntry.getData();
      parseStep7SubblkDbt(subblkDbfData, dbtData, result);
      parseStep7NetworkComments(subblkDbfData, dbtData, result);
      parseStep7FbInterfaces(subblkDbfData, dbtData, result);
      parseStep7MC7Logic(subblkDbfData, dbtData, result);
    }
  }

  // ── Also try text-based formats as fallback ──
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.toLowerCase();

    if (name.endsWith('.awl') || name.endsWith('.stl')) {
      const content = entry.getData().toString('latin1');
      parseAwlSource(content, result);
    }

    if (name.endsWith('.db') && !name.endsWith('.dbf')) {
      try {
        const content = entry.getData().toString('latin1');
        parseAwlSource(content, result);
      } catch (e) { /* skip */ }
    }

    if (name.includes('symlist') && name.endsWith('.sdf')) {
      try {
        const content = entry.getData().toString('latin1');
        parseSymbolTable(content, result);
      } catch (e) { /* skip */ }
    }

    if (name.endsWith('.xml')) {
      try {
        const content = entry.getData().toString('utf-8');
        const parsed = xmlParser.parse(content);
        const meta = extractBlockMeta(parsed);
        extractTiaBlocks(parsed, result);
        extractTiaNetworks(parsed, result, meta, content);
      } catch (e) { /* skip */ }
    }
  }

  return result;
}

/**
 * Parse a native Step7 SYMLIST.DBF file (dBASE III format).
 * This is the symbol table containing ALL symbols with addresses and comments.
 *
 * Key fields:
 *   _SKZ     = Symbol name (e.g. "+EX2_309M5_STO")
 *   _OPIEC   = IEC address (e.g. "I    1030.7", "Q    1030.0", "DB10.DBX4.0")
 *   _DATATYP = Data type (e.g. "BOOL", "INT", "REAL")
 *   _COMMENT = Comment (e.g. "Extruder 2 Formradzustellung STO")
 *   _OPCODE  = Operand type: 1=I/E, 2=I/E, 3=Q/A, 4=M, 5=T, 6=C, 7=DB, ...
 */
function parseStep7SymlistDbf(buffer, result) {
  if (buffer.length < 32) return;

  const numRecords = buffer.readUInt32LE(4);
  const headerSize = buffer.readUInt16LE(8);
  const recordSize = buffer.readUInt16LE(10);

  // Parse field descriptors
  const fields = [];
  let pos = 32;
  while (pos < headerSize - 1 && buffer[pos] !== 0x0D) {
    const name = buffer.slice(pos, pos + 11).toString('ascii').replace(/\x00/g, '');
    const type = String.fromCharCode(buffer[pos + 11]);
    const length = buffer[pos + 16];
    fields.push({ name, type, length });
    pos += 32;
  }

  // Group signals by DB number for block grouping
  const dbBlocks = {};     // DB number → { variables: [] }
  const ioSignals = [];    // I/Q/M signals (no DB)

  const dataStart = headerSize;
  for (let i = 0; i < numRecords; i++) {
    const recStart = dataStart + (i * recordSize);
    if (recStart + recordSize > buffer.length) break;
    if (buffer[recStart] === 0x2A) continue; // Deleted record

    // Read fields
    const record = {};
    let offset = 1;
    for (const f of fields) {
      if (f.type === 'M') {
        offset += f.length;
        continue;
      }
      record[f.name] = buffer.slice(recStart + offset, recStart + offset + f.length).toString('latin1').trim();
      offset += f.length;
    }

    const symbol = record._SKZ || '';
    const iecAddr = record._OPIEC || '';
    const dataType = record._DATATYP || '';
    const comment = record._COMMENT || '';

    if (!symbol || !iecAddr) continue;

    // Detect data type: raw _DATATYP may contain "DB    101" or "FB    348" etc.
    // These are block-type symbols (DB name mappings, FB references), not signals.
    const dtTrimmed = dataType.trim();
    const isBlockSymbol = /^(DB|FB|FC|OB|SFB|SFC|UDT|SDB)\s+\d+$/i.test(dtTrimmed);

    if (isBlockSymbol) {
      // This is a DB/FB name mapping (e.g. "DB_GLOBAL" → DB101)
      // Store as block name metadata
      const blockMatch = dtTrimmed.match(/^(DB)\s+(\d+)$/i);
      if (blockMatch) {
        const dbNum = parseInt(blockMatch[2]);
        if (!dbBlocks[dbNum]) {
          dbBlocks[dbNum] = { db_number: dbNum, name: symbol, variables: [] };
        } else {
          dbBlocks[dbNum].name = symbol; // Enrich with symbolic name
        }
      }
      continue; // Skip – not an actual signal
    }

    // Convert IEC address to S7 format
    const s7Addr = convertIecToS7Address(iecAddr, dataType);
    if (!s7Addr) continue;

    const signal = {
      name: symbol,
      address: s7Addr,
      type: normalizeDatatype(dataType),
      comment: comment || null
    };

    // Group by DB (for DB member signals) or put in area-based blocks
    const dbMemberMatch = s7Addr.match(/^DB(\d+)\./);
    if (dbMemberMatch) {
      const dbNum = parseInt(dbMemberMatch[1]);
      if (!dbBlocks[dbNum]) {
        dbBlocks[dbNum] = { db_number: dbNum, name: `DB${dbNum}`, variables: [] };
      }
      dbBlocks[dbNum].variables.push(signal);
    } else {
      ioSignals.push(signal);
    }
  }

  // Add DB blocks
  for (const db of Object.values(dbBlocks)) {
    db.variables.sort((a, b) => a.address.localeCompare(b.address));
    result.blocks.push(db);
  }

  // Add I/O signals as a pseudo-block
  if (ioSignals.length > 0) {
    result.blocks.push({
      db_number: -1,
      name: 'I/O Signals',
      variables: ioSignals.sort((a, b) => a.address.localeCompare(b.address))
    });
  }
}

/**
 * Parse SUBBLK.DBF/DBT to extract DB interface definitions.
 * The DBT (memo file) contains AWL source for each block's interface,
 * with variable names, types, and comments embedded as text.
 *
 * dBASE memo file format: 512-byte blocks, first 8 bytes = next-block pointer.
 * Chained blocks until next-block = 0xFFFF.
 */
function parseStep7SubblkDbt(dbfBuffer, dbtBuffer, result) {
  if (dbfBuffer.length < 32 || dbtBuffer.length < 512) return;

  const numRecords = dbfBuffer.readUInt32LE(4);
  const headerSize = dbfBuffer.readUInt16LE(8);
  const recordSize = dbfBuffer.readUInt16LE(10);

  // Parse field descriptors
  const fields = [];
  let pos = 32;
  while (pos < headerSize - 1 && dbfBuffer[pos] !== 0x0D) {
    const name = dbfBuffer.slice(pos, pos + 11).toString('ascii').replace(/\x00/g, '');
    const type = String.fromCharCode(dbfBuffer[pos + 11]);
    const length = dbfBuffer[pos + 16];
    fields.push({ name, type, length });
    pos += 32;
  }

  // Find field positions
  const fieldIndex = {};
  let fOffset = 1; // skip delete flag
  for (const f of fields) {
    fieldIndex[f.name] = { offset: fOffset, length: f.length, type: f.type };
    fOffset += f.length;
  }

  const dataStart = headerSize;

  // Find DB interface definitions: SUBBLKTYP=6 contains the DB body/interface
  // with AWL source in the MC5CODE memo field (variable names, types, comments)
  for (let i = 0; i < numRecords; i++) {
    const recStart = dataStart + (i * recordSize);
    if (recStart + recordSize > dbfBuffer.length) break;
    if (dbfBuffer[recStart] === 0x2A) continue; // deleted

    const subblkTyp = parseInt(readField(dbfBuffer, recStart, fieldIndex.SUBBLKTYP) || '0');
    // Type 6 = DB/UDT interface, Type 4 = FB instance DB interface, Type 5 = FB/FC AWL source
    // Skip types 1(SDB), 3(OB), 7(SFB), 9(SFC), 10(MC7 code) – these produce system-internal vars
    if (![4, 5, 6].includes(subblkTyp)) continue;

    const blkNumber = parseInt(readField(dbfBuffer, recStart, fieldIndex.BLKNUMBER) || '0');
    const mc5Ref = parseInt(readField(dbfBuffer, recStart, fieldIndex.MC5CODE) || '0');
    if (mc5Ref <= 0) continue;

    // Read MC5CODE memo from DBT – DON'T use expectedLen here,
    // as reading the full memo for DB interfaces pulls in thousands of
    // FB-internal variables (timers, counters, temp vars). The first 504 bytes
    // contain the user-relevant interface for most blocks.
    const memoContent = readDbtMemo(dbtBuffer, mc5Ref);
    if (!memoContent) continue;

    const text = memoContent.toString('latin1');

    // Check if this looks like a DB interface (has STRUCT with variable definitions)
    if (!text.includes('STRUCT') && !text.includes('VAR_')) continue;

    // Parse as AWL to extract variables
    const tempResult = { blocks: [], networks: [] };
    const wrappedAwl = `DATA_BLOCK DB${blkNumber}\nTITLE =\n${text}\nEND_DATA_BLOCK\n`;
    parseAwlSource(wrappedAwl, tempResult);

    // Merge found blocks into result
    for (const block of tempResult.blocks) {
      const existing = result.blocks.find(b => b.db_number === blkNumber);
      if (existing) {
        for (const v of block.variables) {
          if (!existing.variables.find(ev => ev.address === v.address)) {
            existing.variables.push(v);
          }
        }
      } else {
        block.db_number = blkNumber;
        result.blocks.push(block);
      }
    }
  }
}

/**
 * Extract network titles/comments from SUBBLK type 38 blocks.
 * Type 38 contains hardware/network-level comments, often with I/O assignments
 * and section titles like "Safety OUT", "Normal Eingänge", etc.
 *
 * Also extracts type 20 (block headers) which have network titles in
 * parentheses format: "( Safety IN", "( Freigabe", etc.
 */
function parseStep7NetworkComments(dbfBuffer, dbtBuffer, result) {
  const { fieldIndex, dataStart, numRecords, recordSize } = parseDbfHeader(dbfBuffer);
  if (!fieldIndex.SUBBLKTYP) return;

  // Collect network comments from type 38 and type 20 blocks
  for (let i = 0; i < numRecords; i++) {
    const recStart = dataStart + (i * recordSize);
    if (recStart + recordSize > dbfBuffer.length) break;
    if (dbfBuffer[recStart] === 0x2A) continue;

    const subblkTyp = parseInt(readField(dbfBuffer, recStart, fieldIndex.SUBBLKTYP) || '0');
    // Type 38 = HW comments, Type 20 = block headers, Type 18 = DB comments/network text
    if (![18, 20, 38].includes(subblkTyp)) continue;

    const blkNumber = parseInt(readField(dbfBuffer, recStart, fieldIndex.BLKNUMBER) || '0');

    // Read all memo fields and extract readable text
    for (const memoName of ['MC5CODE', 'SSBPART', 'ADDINFO']) {
      const ref = parseInt(readField(dbfBuffer, recStart, fieldIndex[memoName]) || '0');
      if (ref <= 0) continue;

      const data = readDbtMemo(dbtBuffer, ref);
      if (!data || data.length < 10) continue;
      const text = data.toString('latin1');

      // Extract network titles in parentheses: "( Safety OUT ..."
      const titleMatches = text.match(/\(\s*[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß0-9_ ,./\-]{3,60}/g);
      if (titleMatches) {
        for (let t = 0; t < titleMatches.length; t++) {
          const title = titleMatches[t].replace(/^\(\s*/, '').trim();
          if (title.length < 4) continue;
          result.networks.push({
            block: `OB${blkNumber}`,
            network_number: t + 1,
            comment: title,
            signals_referenced: [],
            logic: null
          });
        }
      }

      // Extract I/O signal-to-tag mappings: "V52_Beginn O295.0=+EX2-556U2"
      const ioMatches = text.match(/[A-Za-z]\d{1,4}\.\d=\+[A-Za-z0-9\-_]+/g);
      if (ioMatches) {
        // Add these as signal references to the last network
        const lastNet = result.networks[result.networks.length - 1];
        if (lastNet) {
          for (const m of ioMatches) {
            const parts = m.split('=');
            if (parts.length === 2) {
              const addr = parts[0].trim();
              const tag = parts[1].trim();
              if (!lastNet.signals_referenced.includes(addr)) {
                lastNet.signals_referenced.push(addr);
              }
              if (!lastNet.comment.includes(tag)) {
                lastNet.comment += ` [${tag}]`;
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Extract FB/FC interface definitions (VAR_INPUT/OUTPUT) from SUBBLK type 5.
 * These give the AI mapper context about what inputs/outputs each function block expects.
 */
function parseStep7FbInterfaces(dbfBuffer, dbtBuffer, result) {
  const { fieldIndex, dataStart, numRecords, recordSize } = parseDbfHeader(dbfBuffer);
  if (!fieldIndex.SUBBLKTYP) return;

  for (let i = 0; i < numRecords; i++) {
    const recStart = dataStart + (i * recordSize);
    if (recStart + recordSize > dbfBuffer.length) break;
    if (dbfBuffer[recStart] === 0x2A) continue;

    const subblkTyp = parseInt(readField(dbfBuffer, recStart, fieldIndex.SUBBLKTYP) || '0');
    // Type 5 = FB/FC AWL source, Type 3 = OB, Type 4 = DB instance, Type 7 = SFB, Type 9 = SFC
    if (![3, 4, 5, 7, 9].includes(subblkTyp)) continue;

    const blkNumber = parseInt(readField(dbfBuffer, recStart, fieldIndex.BLKNUMBER) || '0');
    const mc5Ref = parseInt(readField(dbfBuffer, recStart, fieldIndex.MC5CODE) || '0');
    if (mc5Ref <= 0) continue;

    const data = readDbtMemo(dbtBuffer, mc5Ref);
    if (!data || data.length < 20) continue;
    const text = data.toString('latin1');

    if (!text.includes('VAR_')) continue;

    // Extract interface as a pseudo-network comment for the AI mapper
    // This gives context like: FB500 expects inputs "temperature: REAL // Einlauftemp"
    const lines = text.split(/[\r\n\t]+/).filter(l => l.trim());
    const interfaceLines = [];
    let inVarSection = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^VAR_(INPUT|OUTPUT|IN_OUT|TEMP)/i.test(trimmed)) {
        inVarSection = true;
        interfaceLines.push(trimmed);
        continue;
      }
      if (/^END_VAR/i.test(trimmed)) {
        inVarSection = false;
        continue;
      }
      if (inVarSection && trimmed.includes(':')) {
        interfaceLines.push(trimmed);
      }
    }

    if (interfaceLines.length > 0) {
      result.networks.push({
        block: `FB${blkNumber}`,
        network_number: 0,
        comment: `Interface: ${interfaceLines.join(' | ').substring(0, 500)}`,
        signals_referenced: [],
        logic: null
      });
    }
  }
}

/**
 * Decode MC7 bytecode from SUBBLK type 10 to extract actual PLC logic.
 * This gives the AI mapper the complete program logic: which outputs depend on which inputs,
 * through what conditions (AND/OR/comparisons), with CALL chains.
 *
 * Only decodes blocks that have real MC7 code (AWL/FBD/LAD compiled blocks).
 * SCL-compiled blocks have empty MC7 (all zeros) and are skipped.
 */
function parseStep7MC7Logic(dbfBuffer, dbtBuffer, result) {
  const { fieldIndex, dataStart, numRecords, recordSize } = parseDbfHeader(dbfBuffer);
  if (!fieldIndex.SUBBLKTYP) return;

  // Also need BLKLANG to detect SCL blocks (lang=5) vs AWL (lang=1/2)
  for (let i = 0; i < numRecords; i++) {
    const recStart = dataStart + (i * recordSize);
    if (recStart + recordSize > dbfBuffer.length) break;
    if (dbfBuffer[recStart] === 0x2A) continue;

    const subblkTyp = parseInt(readField(dbfBuffer, recStart, fieldIndex.SUBBLKTYP) || '0');
    // Type 14 = FB MC7, Type 12 = FC MC7, Type 8 = OB MC7, Type 13 = SFC, Type 15 = SFB
    // Type 10 was wrong - it only has init data for SCL blocks
    if (![8, 12, 13, 14, 15].includes(subblkTyp)) continue;

    const blkNumber = parseInt(readField(dbfBuffer, recStart, fieldIndex.BLKNUMBER) || '0');
    const mc5len = parseInt(readField(dbfBuffer, recStart, fieldIndex.MC5LEN) || '0');
    const mc5Ref = parseInt(readField(dbfBuffer, recStart, fieldIndex.MC5CODE) || '0');
    if (mc5Ref <= 0 || mc5len < 20) continue;

    const data = readDbtMemo(dbtBuffer, mc5Ref, mc5len);
    if (!data || data.length < mc5len) continue;

    // Skip all-zeros blocks (SCL compiled – no MC7 to decode)
    let allZero = true;
    for (let j = 0; j < Math.min(data.length, mc5len); j++) {
      if (data[j] !== 0) { allZero = false; break; }
    }
    if (allZero) continue;

    try {
      const decoded = decodeMC7(data, mc5len);
      if (!decoded || decoded.length < 3) continue;

      // Extract logic chains: which outputs depend on which inputs
      const chains = extractLogicChains(decoded);
      if (!chains || chains.length === 0) continue;

      // Convert chains to network entries for the AI mapper
      for (const chain of chains) {
        if (!chain.output || !chain.inputs || chain.inputs.length === 0) continue;

        // Build readable logic description
        const logicStr = chain.logic ? chain.logic.map(l => l).join('; ') : null;
        const inputAddrs = chain.inputs.map(inp => {
          // Clean up addresses: "M 5.0" → "M5.0", "DBX 10.2" → "DBX10.2"
          return inp.replace(/\s+/g, '');
        });

        const blockPrefix = subblkTyp === 12 ? 'FC' : subblkTyp === 8 ? 'OB' : 'FB';
        result.networks.push({
          block: `${blockPrefix}${blkNumber}`,
          network_number: chain.startOffset || 0,
          comment: `MC7 Logic: ${chain.output} depends on [${inputAddrs.join(', ')}]`,
          signals_referenced: inputAddrs,
          logic: logicStr ? logicStr.substring(0, 500) : null
        });
      }
    } catch (e) {
      // Skip blocks that fail to decode
    }
  }
}

/**
 * Parse dBASE header and return field index + metadata.
 * Reusable helper for all SUBBLK parsers.
 */
function parseDbfHeader(dbfBuffer) {
  const numRecords = dbfBuffer.readUInt32LE(4);
  const headerSize = dbfBuffer.readUInt16LE(8);
  const recordSize = dbfBuffer.readUInt16LE(10);

  const fields = [];
  let pos = 32;
  while (pos < headerSize - 1 && dbfBuffer[pos] !== 0x0D) {
    const name = dbfBuffer.slice(pos, pos + 11).toString('ascii').replace(/\x00/g, '');
    const type = String.fromCharCode(dbfBuffer[pos + 11]);
    const length = dbfBuffer[pos + 16];
    fields.push({ name, type, length });
    pos += 32;
  }

  const fieldIndex = {};
  let offset = 1;
  for (const f of fields) {
    fieldIndex[f.name] = { offset, length: f.length, type: f.type };
    offset += f.length;
  }

  return { fieldIndex, dataStart: headerSize, numRecords, recordSize };
}

function readField(buffer, recStart, fieldInfo) {
  if (!fieldInfo) return '';
  return buffer.slice(recStart + fieldInfo.offset, recStart + fieldInfo.offset + fieldInfo.length).toString('latin1').trim();
}

/**
 * Read a memo field from a dBASE DBT file.
 *
 * Step7 SUBBLK.DBT uses contiguous storage: data starts at blockNum * 512 + 8
 * and extends for the full mc5len bytes across consecutive 512-byte blocks.
 * The first 8 bytes of the starting block are a header (next-pointer + flags),
 * but subsequent blocks are pure data (no per-block headers).
 *
 * For small memos (< 504 bytes): fits in single block (offset 8..511).
 * For large memos: spans multiple consecutive blocks. After the first block's
 * 8-byte header, all remaining data is contiguous.
 */
function readDbtMemo(dbtBuffer, blockNum, expectedLen) {
  const BLOCK_SIZE = 512;
  const blockStart = blockNum * BLOCK_SIZE;

  if (blockStart >= dbtBuffer.length) return null;

  // First block: data starts at offset 8 (after 8-byte header)
  const dataStart = blockStart + 8;

  if (expectedLen && expectedLen > 0) {
    // We know how much data to read – read it contiguously
    const end = Math.min(dataStart + expectedLen, dbtBuffer.length);
    if (end <= dataStart) return null;
    return dbtBuffer.slice(dataStart, end);
  }

  // Fallback: no expected length – read using chain pointers (old behavior)
  const chunks = [];
  let currentBlock = blockNum;
  let safety = 0;

  while (currentBlock > 0 && safety < 1000) {
    const bs = currentBlock * BLOCK_SIZE;
    if (bs + BLOCK_SIZE > dbtBuffer.length) break;

    const nextBlock = dbtBuffer.readUInt16LE(bs);
    const blockData = dbtBuffer.slice(bs + 8, bs + BLOCK_SIZE);
    chunks.push(blockData);

    if (nextBlock === 0 || nextBlock === 0xFFFF || nextBlock === currentBlock) break;
    currentBlock = nextBlock;
    safety++;
  }

  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

/**
 * Convert Step7 IEC address format to S7 absolute address.
 *
 * IEC format examples:
 *   "I    1030.7"  → Input bit  → "E1030.7" (or "I1030.7")
 *   "Q    1030.0"  → Output bit → "A1030.0" (or "Q1030.0")
 *   "M     100.0"  → Merker bit → "M100.0"
 *   "DB    10"     → Data block → "DB10"
 *   "PIW   256"    → Peripheral input word → "PEW256"
 *   "T       5"    → Timer → "T5"
 *   "C       3"    → Counter → "C3"
 *
 * For DB members, address comes from _OPBYTEO and _OPBITO fields.
 */
function convertIecToS7Address(iecAddr, dataType) {
  if (!iecAddr) return null;
  const trimmed = iecAddr.trim();

  // Pattern: "AreaType   ByteOffset.BitOffset"
  const match = trimmed.match(/^([A-Z]+)\s+(\d+)(?:\.(\d+))?$/i);
  if (!match) return null;

  const [, area, byteStr, bitStr] = match;
  const byte = parseInt(byteStr);
  const bit = bitStr !== undefined ? parseInt(bitStr) : null;
  const dt = (dataType || '').toUpperCase();

  switch (area.toUpperCase()) {
    case 'I': case 'E': // Input
      if (bit !== null) return `I${byte}.${bit}`;
      if (dt === 'WORD' || dt === 'INT') return `IW${byte}`;
      if (dt === 'DWORD' || dt === 'DINT' || dt === 'REAL') return `ID${byte}`;
      if (dt === 'BYTE') return `IB${byte}`;
      return `I${byte}.0`;

    case 'Q': case 'A': // Output
      if (bit !== null) return `Q${byte}.${bit}`;
      if (dt === 'WORD' || dt === 'INT') return `QW${byte}`;
      if (dt === 'DWORD' || dt === 'DINT' || dt === 'REAL') return `QD${byte}`;
      if (dt === 'BYTE') return `QB${byte}`;
      return `Q${byte}.0`;

    case 'M': // Merker
      if (bit !== null) return `M${byte}.${bit}`;
      if (dt === 'WORD' || dt === 'INT') return `MW${byte}`;
      if (dt === 'DWORD' || dt === 'DINT' || dt === 'REAL') return `MD${byte}`;
      if (dt === 'BYTE') return `MB${byte}`;
      return `M${byte}.0`;

    case 'DB': // Data block
      return `DB${byte}`;

    case 'T': return `T${byte}`;       // Timer
    case 'C': case 'Z': return `C${byte}`;  // Counter

    case 'PIW': case 'PEW': return `PEW${byte}`;  // Peripheral input word
    case 'PQW': case 'PAW': return `PAW${byte}`;  // Peripheral output word

    default: return null;
  }
}

/**
 * Parse AWL/STL source for DATA_BLOCK definitions and network comments.
 * Also extracts signal references from AWL instruction operands.
 */
function parseAwlSource(content, result) {
  const lines = content.split(/\r?\n/);
  let currentBlock = null;
  let inStruct = false;
  let structDepth = 0;
  let currentFnBlock = null; // Current FC/FB/OB name

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Track current function block name (for network parent resolution)
    const fnMatch = line.match(/^(?:FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)\s+(\S+)/i);
    if (fnMatch) {
      currentFnBlock = fnMatch[1];
    }

    // DATA_BLOCK
    const dbMatch = line.match(/^DATA_BLOCK\s+(?:DB\s*)?(\d+)/i);
    if (dbMatch) {
      const dbNumber = parseInt(dbMatch[1]);
      currentBlock = { db_number: dbNumber, name: `DB${dbNumber}`, variables: [] };
      inStruct = false;
      structDepth = 0;
      continue;
    }

    // TITLE
    if (currentBlock && /^TITLE\s*=/i.test(line)) {
      const title = line.replace(/^TITLE\s*=\s*/i, '').trim();
      if (title) currentBlock.name = title;
      continue;
    }

    // Enter variable section: STRUCT, VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_TEMP, VAR
    if (currentBlock && /^(STRUCT|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR)\b/i.test(line)) {
      inStruct = true;
      if (/^STRUCT$/i.test(line)) structDepth++;
      continue;
    }
    // Exit variable section
    if (currentBlock && /^(END_STRUCT|END_VAR)\b/i.test(line)) {
      if (/^END_STRUCT/i.test(line)) structDepth--;
      if (structDepth <= 0) inStruct = false;
      continue;
    }

    if (currentBlock && /^END_DATA_BLOCK/i.test(line)) {
      if (currentBlock.variables.length > 0) {
        calculateAddresses(currentBlock);
        result.blocks.push(currentBlock);
      }
      currentBlock = null;
      continue;
    }

    // Variable inside STRUCT or VAR_ section
    if (currentBlock && inStruct) {
      // Handle: name : TYPE ; // comment
      // Also handle: name : ARRAY[0..9] OF REAL ; // comment
      const varMatch = line.match(/^(\w+)\s*:\s*(ARRAY\s*\[.*?\]\s*OF\s+\w+|\w+(?:\s*\[\d+(?:\.\.\d+)?\])?)\s*;?\s*(?:\/\/\s*(.*))?$/i);
      if (varMatch) {
        const varName = varMatch[1];
        const rawType = varMatch[2].trim();
        const comment = varMatch[3] ? varMatch[3].trim() : null;

        // Array handling
        const arrayMatch = rawType.match(/^ARRAY\s*\[(\d+)\.\.(\d+)\]\s*OF\s+(\w+)$/i);
        if (arrayMatch) {
          const lo = parseInt(arrayMatch[1]);
          const hi = parseInt(arrayMatch[2]);
          const elementType = normalizeDatatype(arrayMatch[3]);
          for (let idx = lo; idx <= hi; idx++) {
            currentBlock.variables.push({
              name: `${varName}[${idx}]`, address: '', type: elementType,
              comment: comment ? `${comment} [${idx}]` : null
            });
          }
        } else {
          currentBlock.variables.push({
            name: varName, address: '', type: normalizeDatatype(rawType), comment
          });
        }
      }
    }

    // Network comments in FC/FB/OB code
    const networkMatch = line.match(/^NETWORK\s+(\d+)/i);
    if (networkMatch) {
      const networkNum = parseInt(networkMatch[1]);
      let comment = '';
      const references = [];

      // Collect title/comments from next lines
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const l = lines[j].trim();
        const titleMatch = l.match(/^TITLE\s*=\s*(.*)/i);
        const commentLine = l.match(/^\/\/\s*(.*)/);
        if (titleMatch) comment = titleMatch[1].trim();
        else if (commentLine) comment += (comment ? ' ' : '') + commentLine[1].trim();
        else if (l && !l.startsWith('//')) break;
      }

      // Scan ahead for DB references in AWL instructions
      for (let j = i + 1; j < Math.min(i + 50, lines.length); j++) {
        const l = lines[j].trim();
        if (/^NETWORK\s+\d+/i.test(l)) break; // Next network
        if (/^END_(?:FUNCTION|ORGANIZATION)/i.test(l)) break;
        const dbRefs = l.match(/DB\d+\.DB[XBWD]\d+(?:\.\d+)?/g);
        if (dbRefs) {
          for (const ref of dbRefs) {
            if (!references.includes(ref)) references.push(ref);
          }
        }
      }

      if (comment || references.length > 0) {
        result.networks.push({
          block: currentFnBlock || 'Unknown',
          network_number: networkNum,
          comment: comment || null,
          signals_referenced: references,
          logic: null
        });
      }
    }
  }

  // Commit any remaining block (text might not have END_DATA_BLOCK)
  if (currentBlock && currentBlock.variables.length > 0) {
    calculateAddresses(currentBlock);
    result.blocks.push(currentBlock);
  }
}

/**
 * Parse Step7 symbol table and enrich existing signals.
 */
function parseSymbolTable(content, result) {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const symbol = parts[0].trim().replace(/^"|"$/g, '');
      const address = parts[1].trim().replace(/^"|"$/g, '');
      const datatype = parts[2] ? parts[2].trim().replace(/^"|"$/g, '') : '';
      const comment = parts[3] ? parts[3].trim().replace(/^"|"$/g, '') : '';

      if (symbol && address && /^[MIEQD]/i.test(address)) {
        enrichSignalWithSymbol(result, address, symbol, comment);
      }
    }
  }
}

function enrichSignalWithSymbol(result, address, symbol, comment) {
  for (const block of result.blocks) {
    for (const variable of block.variables) {
      if (variable.address === address || variable.address.includes(address)) {
        if (!variable.comment && comment) variable.comment = comment;
        if (/^DB\d+/.test(variable.name) && symbol) variable.name = symbol;
        return;
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════
// Rockwell L5X Parser
// ═════════════════════════════════════════════════════════════

/**
 * Parse Rockwell Studio 5000 exported .L5X file (XML format).
 *
 * L5X structure:
 *   <RSLogix5000Content>
 *     <Controller>
 *       <Tags> ... controller-scoped tags ... </Tags>
 *       <Programs>
 *         <Program Name="MainProgram">
 *           <Tags> ... program-scoped tags ... </Tags>
 *           <Routines>
 *             <Routine Name="MainRoutine">
 *               <RLLContent> ... ladder rungs ... </RLLContent>
 *             </Routine>
 */
function parseRockwellL5X(filePath, plcType) {
  const l5xParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['Tag', 'Program', 'Routine', 'Rung', 'Member', 'DataType', 'EnumerationMember'].includes(name),
    removeNSPrefix: true
  });

  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = l5xParser.parse(content);
  const result = {
    source: 'project_file',
    plc_type: plcType || 'Rockwell',
    blocks: [],
    networks: []
  };

  const controller = getNestedValue(parsed, 'RSLogix5000Content', 'Controller');
  if (!controller) return result;

  // Parse UDTs (User-Defined Types) first for type resolution
  const udts = {};
  const dataTypes = findAllDeep(controller, 'DataType');
  for (const dt of dataTypes) {
    if (!dt || !dt['@_Name']) continue;
    const members = dt.Member || [];
    udts[dt['@_Name']] = (Array.isArray(members) ? members : [members]).map(m => ({
      name: m['@_Name'],
      type: m['@_DataType'],
      dimension: m['@_Dimension'] ? parseInt(m['@_Dimension']) : 0,
      description: getNestedValue(m, 'Description') || null
    }));
  }

  // Controller-scoped tags → one block (DB equivalent)
  const controllerTags = findAllDeep(controller, 'Tags');
  for (const tagContainer of controllerTags) {
    const tags = tagContainer.Tag || [];
    const block = { db_number: 0, name: 'Controller Tags', variables: [] };
    for (const tag of Array.isArray(tags) ? tags : [tags]) {
      extractRockwellTag(tag, block.variables, '', udts);
    }
    if (block.variables.length > 0) {
      result.blocks.push(block);
    }
  }

  // Program-scoped tags
  const programs = findAllDeep(controller, 'Program');
  for (const prog of programs) {
    const progName = prog['@_Name'] || 'Unknown';
    const progTags = prog.Tags;
    if (progTags) {
      const tags = progTags.Tag || [];
      const block = { db_number: 0, name: `Program:${progName}`, variables: [] };
      for (const tag of Array.isArray(tags) ? tags : [tags]) {
        extractRockwellTag(tag, block.variables, `Program:${progName}.`, udts);
      }
      if (block.variables.length > 0) {
        result.blocks.push(block);
      }
    }

    // Routines → network equivalents (rung comments)
    const routines = findAllDeep(prog, 'Routine');
    for (const routine of routines) {
      const routineName = routine['@_Name'] || 'Unknown';
      const rungs = findAllDeep(routine, 'Rung');
      for (const rung of rungs) {
        const rungNum = parseInt(rung['@_Number'] || '0');
        const comment = getNestedValue(rung, 'Comment');
        const commentText = typeof comment === 'string' ? comment
          : (comment && comment['#text']) ? comment['#text']
          : null;
        const rungText = getNestedValue(rung, 'Text') || '';
        const rungContent = typeof rungText === 'string' ? rungText : (rungText['#text'] || '');

        // Extract tag references from rung text
        const references = [];
        const tagRefRegex = /(?:Program:\w+\.)?[\w.]+/g;
        const matches = rungContent.match(tagRefRegex) || [];
        for (const m of matches) {
          if (m.includes('.') && !references.includes(m) && !/^[A-Z]{2,4}$/.test(m)) {
            references.push(m);
          }
        }

        if (commentText || references.length > 0) {
          result.networks.push({
            block: `${progName}.${routineName}`,
            network_number: rungNum,
            comment: commentText,
            signals_referenced: references,
            logic: rungContent || null
          });
        }
      }
    }
  }

  return result;
}

/**
 * Extract a Rockwell tag into the variables list.
 * Handles UDTs, arrays, and atomic types.
 */
function extractRockwellTag(tag, variables, prefix, udts) {
  if (!tag || !tag['@_Name']) return;

  const name = tag['@_Name'];
  const dataType = tag['@_DataType'] || 'DINT';
  const description = getNestedValue(tag, 'Description');
  const descText = typeof description === 'string' ? description : (description?.['#text'] || null);
  const dimension = tag['@_Dimension'] ? parseInt(tag['@_Dimension']) : 0;
  const fullName = `${prefix}${name}`;

  // Array of atomic type
  if (dimension > 0 && !udts[dataType]) {
    for (let i = 0; i < dimension; i++) {
      variables.push({
        name: `${fullName}[${i}]`,
        address: `${fullName}[${i}]`,
        type: normalizeRockwellType(dataType),
        comment: descText ? `${descText} [${i}]` : null
      });
    }
    return;
  }

  // UDT → expand members
  if (udts[dataType]) {
    for (const member of udts[dataType]) {
      if (member.dimension > 0) {
        for (let i = 0; i < member.dimension; i++) {
          variables.push({
            name: `${fullName}.${member.name}[${i}]`,
            address: `${fullName}.${member.name}[${i}]`,
            type: normalizeRockwellType(member.type),
            comment: member.description ? `${member.description} [${i}]` : null
          });
        }
      } else {
        variables.push({
          name: `${fullName}.${member.name}`,
          address: `${fullName}.${member.name}`,
          type: normalizeRockwellType(member.type),
          comment: member.description
        });
      }
    }
    return;
  }

  // Atomic tag
  variables.push({
    name: fullName,
    address: fullName, // Rockwell uses tag name as address
    type: normalizeRockwellType(dataType),
    comment: descText
  });
}

function normalizeRockwellType(dt) {
  if (!dt) return 'Unknown';
  const map = {
    'BOOL': 'BOOL', 'BIT': 'BOOL',
    'SINT': 'SINT', 'INT': 'INT', 'DINT': 'DINT', 'LINT': 'LINT',
    'REAL': 'REAL', 'LREAL': 'LREAL',
    'STRING': 'STRING',
    'TIMER': 'TIMER', 'COUNTER': 'COUNTER',
  };
  return map[dt.toUpperCase()] || dt;
}

// ═════════════════════════════════════════════════════════════
// Address Calculation (Siemens S7)
// ═════════════════════════════════════════════════════════════

/**
 * Calculate S7 addresses for variables based on their data types.
 * Follows Siemens S7 alignment rules:
 *   - BOOL: bit-addressed, 8 bits per byte
 *   - BYTE/CHAR/SINT/USINT: 1 byte, no alignment
 *   - INT/WORD/UINT: 2 bytes, 2-byte aligned
 *   - DINT/DWORD/UDINT/REAL/TIME: 4 bytes, 2-byte aligned (S7 uses word-alignment, not dword)
 *   - LREAL: 8 bytes, 2-byte aligned
 *   - STRING[n]: 2 + n bytes (2-byte header: max-len, current-len), 2-byte aligned
 *   - After any BOOL sequence, pad to next byte boundary before non-BOOL
 */
function calculateAddresses(block) {
  let offset = 0;
  let bitOffset = 0;
  const dbNum = block.db_number;

  for (const variable of block.variables) {
    if (variable.address) continue;

    const type = variable.type.toUpperCase();

    // Close BOOL bit group before non-BOOL type
    if (type !== 'BOOL' && bitOffset > 0) {
      offset++;
      bitOffset = 0;
    }

    // Word-alignment for types >= 2 bytes
    if (type !== 'BOOL' && type !== 'BYTE' && type !== 'CHAR' && type !== 'USINT' && type !== 'SINT') {
      if (offset % 2 !== 0) offset++;
    }

    switch (type) {
      case 'BOOL':
        variable.address = `DB${dbNum}.DBX${offset}.${bitOffset}`;
        bitOffset++;
        if (bitOffset >= 8) { offset++; bitOffset = 0; }
        break;

      case 'BYTE': case 'CHAR': case 'USINT': case 'SINT':
        variable.address = `DB${dbNum}.DBB${offset}`;
        offset += 1;
        break;

      case 'INT': case 'WORD': case 'UINT':
        variable.address = `DB${dbNum}.DBW${offset}`;
        offset += 2;
        break;

      case 'DINT': case 'DWORD': case 'UDINT': case 'REAL': case 'TIME': case 'DATE_AND_TIME':
        variable.address = `DB${dbNum}.DBD${offset}`;
        offset += 4;
        break;

      case 'LREAL':
        variable.address = `DB${dbNum}.DBD${offset}`;
        offset += 8;
        break;

      case 'STRING': {
        // STRING default = STRING[254] → 2 header bytes + 254 data = 256 bytes
        // Check if variable has explicit length: STRING[80] etc.
        const strLenMatch = variable.type.match(/STRING\s*\[(\d+)\]/i);
        const strLen = strLenMatch ? parseInt(strLenMatch[1]) : 254;
        variable.address = `DB${dbNum}.DBB${offset}`;
        offset += 2 + strLen; // 2-byte header + actual chars
        // Re-align after string
        if (offset % 2 !== 0) offset++;
        break;
      }

      default:
        // Unknown type – assume 2 bytes word-aligned
        variable.address = `DB${dbNum}.DBW${offset}`;
        offset += 2;
    }
  }
}

// ═════════════════════════════════════════════════════════════
// Shared utilities
// ═════════════════════════════════════════════════════════════

function normalizeDatatype(dt) {
  if (!dt) return 'Unknown';
  const clean = dt.trim().replace(/^"|"$/g, '');
  const upper = clean.toUpperCase();

  // Preserve STRING[n] with length
  if (upper.startsWith('STRING')) return clean;

  const map = {
    'BOOL': 'BOOL', 'BYTE': 'BYTE', 'CHAR': 'CHAR',
    'WORD': 'WORD', 'INT': 'INT', 'UINT': 'UINT',
    'SINT': 'SINT', 'USINT': 'USINT',
    'DWORD': 'DWORD', 'DINT': 'DINT', 'UDINT': 'UDINT',
    'REAL': 'REAL', 'LREAL': 'LREAL',
    'TIME': 'TIME', 'DATE_AND_TIME': 'DATE_AND_TIME',
    'DT': 'DATE_AND_TIME', 'S5TIME': 'TIME', 'TOD': 'TIME', 'DATE': 'INT'
  };
  return map[upper] || clean;
}

function extractComment(node) {
  if (!node) return null;
  const comment = node.Comment;
  if (!comment) return null;

  const comments = Array.isArray(comment) ? comment : [comment];
  for (const c of comments) {
    const texts = c.MultiLanguageText || c;
    const textArr = Array.isArray(texts) ? texts : [texts];

    let deText = null, enText = null, anyText = null;
    for (const t of textArr) {
      const lang = t['@_Lang'] || '';
      const text = typeof t === 'string' ? t : (t['#text'] || '');
      if (!text) continue;
      if (lang.startsWith('de')) deText = text;
      else if (lang.startsWith('en')) enText = text;
      else if (!anyText) anyText = text;
    }
    return deText || enText || anyText;
  }
  return null;
}

function findAllDeep(obj, key) {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;
  if (obj[key]) {
    const val = obj[key];
    if (Array.isArray(val)) results.push(...val);
    else results.push(val);
  }
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'object') {
      results.push(...findAllDeep(obj[k], key));
    }
  }
  return results;
}

/**
 * Find all elements with a given tag name in the ordered (preserveOrder) parse tree.
 * In ordered mode each element is {TagName: [children], ':@': {attrs}}.
 * Returns the full element objects (not just children) so callers have access to ':@'.
 */
function findAllDeepOrdered(node, tagName) {
  const results = [];
  if (!node || typeof node !== 'object') return results;

  if (Array.isArray(node)) {
    for (const child of node) {
      results.push(...findAllDeepOrdered(child, tagName));
    }
    return results;
  }

  for (const key of Object.keys(node)) {
    if (key === ':@') continue;
    if (key === tagName) {
      // This element IS the one we want – push the whole node
      results.push(node);
    }
    // Recurse into children
    const children = node[key];
    if (Array.isArray(children)) {
      for (const child of children) {
        results.push(...findAllDeepOrdered(child, tagName));
      }
    }
  }
  return results;
}

function getNestedValue(obj, ...keys) {
  let current = obj;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return null;
    current = current[key];
  }
  return current;
}

module.exports = { parseProjectFile, parseTiaProject, parseStep7Project, parseRockwellL5X };
