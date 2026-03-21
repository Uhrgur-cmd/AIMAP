import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Parser } from 'expr-eval';

const ADDRESS_REGEX = /DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g;

/* ── S7 type system ────────────────────────────────── */
const TYPE_GROUPS = {
  BOOL: 'bool', BYTE: 'int', SINT: 'int', USINT: 'int',
  INT: 'int', UINT: 'int', WORD: 'int',
  DINT: 'int', UDINT: 'int', DWORD: 'int',
  REAL: 'real', LREAL: 'real',
  STRING: 'string', CHAR: 'string', WSTRING: 'string',
  TIME: 'time', DATE_AND_TIME: 'time', DT: 'time', DATE: 'time', TOD: 'time',
};
function typeGroup(t) { return TYPE_GROUPS[(t || '').toUpperCase()] || 'unknown'; }

const CONVERSIONS = [
  'BOOL_TO_INT', 'BOOL_TO_DINT', 'BOOL_TO_REAL', 'BOOL_TO_STRING', 'BOOL_TO_BYTE', 'BOOL_TO_WORD',
  'BYTE_TO_INT', 'BYTE_TO_DINT', 'BYTE_TO_REAL', 'BYTE_TO_BOOL', 'BYTE_TO_STRING', 'BYTE_TO_WORD',
  'INT_TO_REAL', 'INT_TO_DINT', 'INT_TO_STRING', 'INT_TO_BOOL', 'INT_TO_BYTE', 'INT_TO_WORD',
  'DINT_TO_REAL', 'DINT_TO_INT', 'DINT_TO_STRING', 'DINT_TO_BOOL',
  'WORD_TO_INT', 'WORD_TO_DINT', 'WORD_TO_BOOL', 'WORD_TO_BYTE', 'WORD_TO_STRING',
  'DWORD_TO_DINT', 'DWORD_TO_REAL', 'DWORD_TO_STRING',
  'REAL_TO_INT', 'REAL_TO_DINT', 'REAL_TO_STRING',
  'STRING_TO_INT', 'STRING_TO_DINT', 'STRING_TO_REAL',
  'TIME_TO_DINT', 'DINT_TO_TIME',
];

function extractAddresses(text) {
  if (!text) return [];
  return [...new Set((text.match(ADDRESS_REGEX) || []).map(a => a.trim()))];
}

/* ── SCL Syntax Validator ──────────────────────────── */
function validateSCL(expr, getType, targetType) {
  const errors = [];
  if (!expr || !expr.trim()) return errors;
  const v = expr.trim();

  // 1. Bracket check
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '(') depth++;
    if (v[i] === ')') depth--;
    if (depth < 0) { errors.push('Unexpected closing bracket ")" at position ' + (i + 1)); break; }
  }
  if (depth > 0) errors.push('Missing ' + depth + ' closing bracket(s) ")"');

  // 1b. Semicolons — each statement/value must end with ;
  const hasIF = /\bIF\b/i.test(v);
  if (hasIF) {
    // In IF blocks: each value after THEN/ELSE must end with ;
    const lines = v.split('\n').map(l => l.trim()).filter(l => l);
    for (const line of lines) {
      // Skip structural keywords
      if (/^(IF|ELSIF|ELSE|END_IF)\b/i.test(line)) continue;
      if (/^(IF|ELSIF)\b/i.test(line)) continue;
      // Value lines must end with ;
      if (line && !line.endsWith(';') && !/^(THEN|END_IF)$/i.test(line)) {
        errors.push(`Missing ";" at end of: ${line.substring(0, 40)}`);
      }
    }
  } else {
    // Simple expressions: must end with ;
    if (!v.endsWith(';')) {
      errors.push('Expression must end with ";"');
    }
  }

  // 2. IF/THEN/ELSE/END_IF check
  const hasTHEN = /\bTHEN\b/i.test(v);
  const hasENDIF = /\bEND_IF\b/i.test(v);
  const hasELSIF = /\bELSIF\b/i.test(v);
  const hasELSE = /\bELSE\b/i.test(v);

  if (hasIF && !hasTHEN) errors.push('IF without THEN');
  if (hasIF && !hasENDIF) errors.push('IF without END_IF');
  if (hasTHEN && !hasIF) errors.push('THEN without IF');
  if (hasENDIF && !hasIF) errors.push('END_IF without IF');
  if (hasELSIF && !hasIF) errors.push('ELSIF without IF');
  if (hasELSE && !hasIF) errors.push('ELSE without IF');

  // Count IF vs END_IF
  const ifCount = (v.match(/\bIF\b/gi) || []).length;
  const endifCount = (v.match(/\bEND_IF\b/gi) || []).length;
  if (ifCount > endifCount) errors.push('Missing END_IF (' + ifCount + ' IF, ' + endifCount + ' END_IF)');
  if (endifCount > ifCount) errors.push('Extra END_IF');

  // 2b. Empty ELSIF condition
  if (/ELSIF\s+THEN/i.test(v)) errors.push('ELSIF has empty condition — add a condition or remove the ELSIF');

  // 2c. BOOL compared with number or TRUE/FALSE (common mistake)
  if (/DBX\d+\.\d+\s*==\s*\d+/i.test(v)) errors.push('BOOL cannot be compared with numbers. Use NOT for false, or just the address for true.');
  if (/DBX\d+\.\d+\s*==\s*(TRUE|FALSE)/i.test(v)) errors.push('BOOL does not need == TRUE/FALSE. Use address directly for true, or NOT address for false.');
  if (/DBX\d+\.\d+\s*[><]\s/i.test(v)) errors.push('BOOL cannot use > or <. Use AND/OR/NOT for boolean logic.');
  if (/==\s*(TRUE|FALSE)\b/i.test(v)) errors.push('Remove == TRUE/FALSE. Use the signal directly, or NOT signal for false.');

  // 2d. Empty IF condition
  if (/\bIF\s+THEN\b/i.test(v)) errors.push('IF has empty condition');

  // 3. Double operators
  if (/\b(AND\s+AND|OR\s+OR|NOT\s+NOT)\b/i.test(v)) errors.push('Double operator (AND AND, OR OR, etc.)');
  if (/[\+\-\*\/]{2,}/.test(v.replace(/\s/g, ''))) errors.push('Double arithmetic operator');

  // 3b. Type-safe comparison check — all types, all directions
  // Find all comparisons: operand1 OPERATOR operand2
  const ADDR = /(DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?)/;
  const LIT_STR = /'[^']*'/;
  const LIT_REAL = /-?\d+\.\d+/;
  const LIT_INT = /-?\d+/;
  const LIT_BOOL = /\b(TRUE|FALSE)\b/i;
  const OPS = /\s*([><=!]{1,2})\s*/;

  // Helper: determine type of an operand
  function operandType(op) {
    op = op.trim();
    if (ADDR.test(op)) { const t = getType(op.match(ADDR)[0]); return t ? typeGroup(t) : null; }
    if (/^'[^']*'$/.test(op)) return 'string';
    if (/^(TRUE|FALSE)$/i.test(op)) return 'bool';
    if (/^-?\d+\.\d+$/.test(op)) return 'real';
    if (/^-?\d+$/.test(op)) return 'int';
    return null;
  }

  // Extract all binary comparisons from the expression
  const compPattern = /([^\s><=!]+)\s*([><=!]{1,2})\s*([^\s><=!;]+)/g;
  let compMatch;
  while ((compMatch = compPattern.exec(v)) !== null) {
    const [, left, op, right] = compMatch;
    const leftType = operandType(left);
    const rightType = operandType(right);
    if (!leftType || !rightType) continue;

    // Same group or compatible → OK
    if (leftType === rightType) continue;
    // int and real can be compared (int gets promoted)
    if ((leftType === 'int' && rightType === 'real') || (leftType === 'real' && rightType === 'int')) {
      // But warn if int signal compared with decimal literal (will never exact-match with = or ==)
      if (op === '==' || op === '=' || op === '!=') {
        const intSide = leftType === 'int' ? left : right;
        const realSide = leftType === 'real' ? left : right;
        if (ADDR.test(intSide) && /^\d+\.\d+$/.test(realSide.trim())) {
          errors.push(`${intSide.trim()} is integer — comparing with ${realSide.trim()} using == will likely never match.`);
        }
      }
      continue;
    }

    // Everything else is a type mismatch
    const leftLabel = ADDR.test(left) ? `${left.trim()} (${getType(left.match(ADDR)[0]) || leftType})` : `${left.trim()} (${leftType})`;
    const rightLabel = ADDR.test(right) ? `${right.trim()} (${getType(right.match(ADDR)[0]) || rightType})` : `${right.trim()} (${rightType})`;
    errors.push(`Cannot compare ${leftLabel} with ${rightLabel} — incompatible types.`);
  }

  // 4. Conversion validation
  // 4a. Check for unresolved ?_TO_? placeholders
  if (/\?_TO_\?/.test(v) || /\?/.test(v.replace(/'[^']*'/g, ''))) {
    errors.push('Replace "?" with actual type names (e.g. INT_TO_REAL)');
  }
  // 4b. Check conversion has brackets
  const convMatches = [...v.matchAll(/\b([A-Z]+_TO_[A-Z]+)\s*/gi)];
  for (const m of convMatches) {
    const after = v.substring(m.index + m[0].length).trimStart();
    if (!after.startsWith('(')) {
      errors.push(`${m[1]} must be followed by ( ... )`);
    }
  }
  // 4c. Check conversion name is valid AND input type matches
  const convWithArgs = [...v.matchAll(/\b([A-Z]+)_TO_([A-Z]+)\s*\(([^)]*)\)/gi)];
  for (const m of convWithArgs) {
    const fromType = m[1].toUpperCase();
    const toType = m[2].toUpperCase();
    const convName = `${fromType}_TO_${toType}`;
    const inner = m[3].trim();

    // Check conversion exists
    if (!CONVERSIONS.includes(convName)) {
      errors.push(`Unknown conversion "${convName}".`);
      continue;
    }

    // Check input type matches the FROM type of the conversion
    if (inner) {
      let actualType = null;

      // 1. Check if inner is a PLC address
      const innerAddrs = extractAddresses(inner);
      if (innerAddrs.length === 1 && inner.trim() === innerAddrs[0]) {
        actualType = getType(innerAddrs[0])?.toUpperCase() || null;
      }
      // 2. Check if inner is a literal (with S7 range checks)
      else if (/^-?\d+\.\d+$/.test(inner.trim())) {
        actualType = 'REAL';
      } else if (/^-?\d+$/.test(inner.trim())) {
        const num = parseInt(inner.trim(), 10);
        if (!Number.isSafeInteger(num) || num > 4294967295 || num < -2147483648) {
          errors.push(`${convName}: value ${inner.trim()} is out of range for any PLC integer type.`);
        } else if (num >= 0 && num <= 1) actualType = 'BOOL';
        else if (num >= 0 && num <= 255) actualType = 'BYTE';
        else if (num >= -32768 && num <= 65535) actualType = 'INT';
        else actualType = 'DINT';
      } else if (/^(TRUE|FALSE)$/i.test(inner.trim())) {
        actualType = 'BOOL';
      } else if (/^'[^']*'$/.test(inner.trim())) {
        actualType = 'STRING';
      }
      // 3. Check if inner is another conversion → get its result type
      else {
        const nestedConv = inner.trim().match(/^([A-Z]+)_TO_([A-Z]+)\s*\(/i);
        if (nestedConv) actualType = nestedConv[2].toUpperCase();
      }
      // 4. Check if inner is an expression with addresses → infer type
      if (!actualType && innerAddrs.length >= 1) {
        actualType = getType(innerAddrs[0])?.toUpperCase() || null;
      }

      if (actualType) {
        if (actualType !== fromType) {
          // For PLC addresses: exact match required
          // For literals: allow upward compatible (BYTE fits in INT fits in DINT)
          const isLiteral = !extractAddresses(inner).length;
          const upwardCompatible = isLiteral && (
            // Smaller integer fits in larger integer
            (actualType === 'BOOL' && ['BYTE','INT','DINT','WORD','DWORD'].includes(fromType)) ||
            (actualType === 'BYTE' && ['INT','DINT','WORD','DWORD'].includes(fromType)) ||
            (actualType === 'INT'  && ['DINT','DWORD'].includes(fromType)) ||
            // Any integer fits in REAL
            (['BOOL','BYTE','INT','DINT'].includes(actualType) && ['REAL','LREAL'].includes(fromType))
          );
          if (!upwardCompatible) {
            errors.push(`${convName}: input is ${actualType}, but expects ${fromType}. Use ${actualType}_TO_${toType}() instead.`);
          }
        }
      } else if (inner && !innerAddrs.length && !/^[0-9.\-]+$/.test(inner.trim()) && !/^(TRUE|FALSE)$/i.test(inner.trim()) && !/^'.*'$/.test(inner.trim()) && !/\b[A-Z]+_TO_[A-Z]+\b/i.test(inner) && !/[\+\-\*\/]/.test(inner)) {
        // inner is not a valid address, literal, conversion, or expression
        errors.push(`${convName}: "${inner.trim()}" is not a valid PLC address, literal, or expression.`);
      }
    }
  }
  // Also check standalone conversion names without matching args (already handled by bracket check)
  const convNamesOnly = [...v.matchAll(/\b([A-Z]+_TO_[A-Z]+)\b/gi)];
  for (const m of convNamesOnly) {
    if (!CONVERSIONS.includes(m[1].toUpperCase())) {
      // Only report if not already caught above
      if (!convWithArgs.some(c => `${c[1]}_TO_${c[2]}`.toUpperCase() === m[1].toUpperCase())) {
        errors.push(`Unknown conversion "${m[1]}".`);
      }
    }
  }

  // 5. Unknown addresses
  const addrs = extractAddresses(v);
  for (const a of addrs) {
    if (!getType(a)) errors.push(`Signal ${a} not found in PLC`);
  }

  // 6. IF/THEN value types must match target type
  if (hasIF && hasTHEN && hasENDIF && targetType) {
    const tgtUpper = targetType.toUpperCase();
    const tgtGroup = typeGroup(tgtUpper);
    // Extract all values after THEN/ELSE
    const valMatches = [
      ...v.matchAll(/THEN\s+([^\n;]*)/gi),
      ...v.matchAll(/ELSE\s+([^\n;]*)/gi)
    ];
    for (const vm of valMatches) {
      const val = vm[1].trim().replace(/;$/, '').trim();
      if (!val) continue;
      let valType = null;
      if (/^'[^']*'$/.test(val)) valType = 'string';
      else if (/^(TRUE|FALSE)$/i.test(val)) valType = 'bool';
      else if (/^-?\d+\.\d+$/.test(val)) valType = 'real';
      else if (/^-?\d+$/.test(val)) valType = 'int';
      if (valType && valType !== tgtGroup) {
        errors.push(`IF/THEN value "${val}" is ${valType}, but target ${targetType} expects ${tgtGroup}. Use matching value type.`);
      }
    }
  }

  // 7. Type compatibility – exact match required
  if (errors.length === 0 && targetType && !/\bIF\b/i.test(v)) {
    const resultType = evaluateResultType(v, getType);
    if (resultType && resultType !== targetType.toUpperCase()) {
      // Allow compatible pairs without conversion:
      // DINT↔INT (same size family, auto-cast in S7)
      // REAL↔LREAL (precision only)
      // WORD↔UINT, DWORD↔UDINT (signed/unsigned same size)
      const autoCompatible = new Set([
        // Same size family
        'INT:DINT', 'DINT:INT', 'REAL:LREAL', 'LREAL:REAL',
        'WORD:UINT', 'UINT:WORD', 'DWORD:UDINT', 'UDINT:DWORD',
        'INT:UINT', 'UINT:INT', 'DINT:UDINT', 'UDINT:DINT',
        'WORD:INT', 'INT:WORD', 'DWORD:DINT', 'DINT:DWORD',
        // Integer ↔ Float (coerceValue handles truncation)
        'INT:REAL', 'INT:LREAL', 'DINT:REAL', 'DINT:LREAL',
        'UINT:REAL', 'UINT:LREAL', 'UDINT:REAL', 'UDINT:LREAL',
        'REAL:INT', 'REAL:DINT', 'LREAL:INT', 'LREAL:DINT',
        'REAL:UINT', 'REAL:UDINT', 'LREAL:UINT', 'LREAL:UDINT',
        'BYTE:INT', 'BYTE:DINT', 'BYTE:WORD', 'BYTE:REAL',
        'WORD:DINT', 'WORD:REAL',
      ]);
      const pair = `${resultType}:${targetType.toUpperCase()}`;
      if (!autoCompatible.has(pair)) {
        errors.push(`Result type ${resultType} is not compatible with target ${targetType}. Use ${resultType}_TO_${targetType.toUpperCase()}().`);
      }
    }
  }

  return errors;
}

/* ── Evaluate result type ──────────────────────────── */
function evaluateResultType(expr, getType) {
  if (!expr || !expr.trim()) return null;
  const v = expr.trim();

  // IF/THEN → lookup, result type depends on values
  if (/\bIF\b/i.test(v) && /\bTHEN\b/i.test(v)) {
    // Extract values after THEN/ELSE
    const values = [...v.matchAll(/THEN\s+([^\n]*?)(?=\s*(?:ELSIF|ELSE|END_IF|$))/gi),
                    ...v.matchAll(/ELSE\s+([^\n]*?)(?=\s*(?:END_IF|$))/gi)]
      .map(m => m[1].trim()).filter(Boolean);
    if (values.every(val => /^'[^']*'$/.test(val))) return 'STRING';
    if (values.every(val => /^-?\d+$/.test(val))) return 'INT';
    if (values.every(val => /^-?\d+\.\d+$/.test(val))) return 'REAL';
    if (values.every(val => /^(TRUE|FALSE)$/i.test(val))) return 'BOOL';
    return null; // mixed or can't determine – allow any target
  }

  // Conversion wrapper
  const convMatch = v.match(/^([A-Z]+)_TO_([A-Z]+)\s*\(/i);
  if (convMatch) return convMatch[2].toUpperCase();

  // Boolean operators
  if (/\b(AND|OR|NOT)\b/i.test(v)) return 'BOOL';
  if (/[><=!]{1,2}/.test(v) && !/\b_TO_\b/i.test(v)) return 'BOOL';

  // Arithmetic
  if (/[\+\-\*\/]/.test(v)) {
    const addrs = extractAddresses(v);
    const types = addrs.map(a => getType(a)).filter(Boolean);
    if (types.some(t => typeGroup(t) === 'real')) return 'REAL';
    if (types.some(t => ['DINT', 'UDINT', 'DWORD'].includes(t.toUpperCase()))) return 'DINT';
    if (types.length > 0) return types[0].toUpperCase();
    // No addresses — only literals. Check if any decimal point exists
    if (/\d+\.\d+/.test(v)) return 'REAL';
    // Division always produces REAL (could be non-integer)
    if (/\//.test(v)) return 'REAL';
    return 'INT';
  }

  // Single address
  const addrs = extractAddresses(v);
  if (addrs.length === 1) {
    const t = getType(addrs[0]);
    return t ? t.toUpperCase() : null;
  }
  return null;
}

/* ── Detect mapping type ───────────────────────────── */
function detectType(value) {
  if (!value || !value.trim()) return 'direct';
  const v = value.trim();
  if (/\bIF\b/i.test(v)) return 'lookup';
  if (/\b[A-Z]+_TO_[A-Z]+\b/i.test(v)) return 'calculated';
  if (/\b(AND|OR|NOT)\b/i.test(v) || /[><=!]{1,2}/.test(v) || /[\+\-\*\/]/.test(v)) return 'expression';
  if (extractAddresses(v).length > 1) return 'expression';
  return 'direct';
}

/* ── Small UI components ───────────────────────────── */
function TypeTag({ type }) {
  const colors = {
    direct: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    expression: 'bg-blue-100 text-blue-700 border-blue-200',
    calculated: 'bg-amber-100 text-amber-700 border-amber-200',
    lookup: 'bg-violet-100 text-violet-700 border-violet-200',
  };
  return <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${colors[type] || colors.direct}`}>{type}</span>;
}

function DataTypeBadge({ type }) {
  const g = typeGroup(type);
  const styles = {
    bool: 'bg-blue-50 text-blue-700 border-blue-200',
    int: 'bg-amber-50 text-amber-700 border-amber-200',
    real: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    string: 'bg-violet-50 text-violet-700 border-violet-200',
    time: 'bg-pink-50 text-pink-700 border-pink-200',
  };
  return <span className={`text-[9px] px-1 py-0.5 rounded border font-mono ${styles[g] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>{type}</span>;
}

/* ── Custom conversion input ───────────────────────── */
function CustomConversionInput({ onInsert }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState('');
  const inputRef = useRef(null);

  if (!open) {
    return (
      <button onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="text-[10px] bg-gray-50 hover:bg-gray-100 text-gray-500 px-2 py-0.5 rounded border border-dashed border-gray-300 font-mono transition-colors"
        title="Type a custom conversion, e.g. LREAL_TO_DINT">
        ?_TO_?
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef}
        value={val}
        onChange={e => setVal(e.target.value.toUpperCase())}
        onKeyDown={e => {
          if (e.key === 'Enter' && val.includes('_TO_')) { onInsert(val); setVal(''); setOpen(false); }
          if (e.key === 'Escape') { setVal(''); setOpen(false); }
        }}
        className="w-28 text-[10px] bg-white text-amber-700 font-mono px-1.5 py-0.5 rounded border border-amber-300 outline-none focus:border-amber-500"
        placeholder="INT_TO_REAL"
        spellCheck={false}
      />
      <button onClick={() => { if (val.includes('_TO_')) { onInsert(val); setVal(''); setOpen(false); } }}
        className="text-[10px] text-amber-600 hover:text-amber-800 font-semibold" title="Insert">
        ↵
      </button>
      <button onClick={() => { setVal(''); setOpen(false); }}
        className="text-[10px] text-gray-400 hover:text-gray-600">
        ✕
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════ */

export default function ExpressionBuilder({ signals, currentMapping, targetName, targetType, onSave, onCancel }) {
  const { t } = useTranslation();
  // Reconstruct SCL from any mapping format
  function mappingToSCL(m) {
    if (!m) return '';
    // If it has a lookup_table, convert back to IF/THEN
    if (m.lookup_table) {
      const table = typeof m.lookup_table === 'string' ? JSON.parse(m.lookup_table) : m.lookup_table;
      const entries = Object.entries(table);
      if (entries.length === 0) return m.expression || m.source_address || '';
      const lines = [];
      let first = true;
      let defaultVal = null;
      for (const [cond, val] of entries) {
        if (cond === 'DEFAULT') { defaultVal = val; continue; }
        const keyword = first ? 'IF' : 'ELSIF';
        const valStr = typeof val === 'string' ? `'${val}'` : String(val);
        lines.push(`${keyword} ${cond} THEN\n  ${valStr};`);
        first = false;
      }
      if (defaultVal !== null) {
        const valStr = typeof defaultVal === 'string' ? `'${defaultVal}'` : String(defaultVal);
        lines.push(`ELSE\n  ${valStr};`);
      }
      lines.push('END_IF');
      return lines.join('\n');
    }
    return m.expression || m.source_address || '';
  }

  const initial = mappingToSCL(currentMapping);
  const [value, setValue] = useState(initial);
  const [search, setSearch] = useState('');
  const textareaRef = useRef(null);

  useEffect(() => {
    setValue(mappingToSCL(currentMapping));
  }, [currentMapping?.target_signal, currentMapping?.source_address, currentMapping?.expression, currentMapping?.lookup_table]);

  const signalMap = useMemo(() => {
    const m = new Map();
    signals.forEach(s => m.set(s.address, s));
    return m;
  }, [signals]);

  function getType(addr) { return signalMap.get(addr)?.data_type || null; }
  function getInfo(addr) { return signalMap.get(addr) || null; }

  const detectedType = detectType(value);
  const referencedAddrs = extractAddresses(value);
  const resultType = evaluateResultType(value, getType);
  const targetUpper = (targetType || '').toUpperCase();
  const validationErrors = useMemo(() => validateSCL(value, getType, targetType), [value, signals, targetType]);

  // Live preview — try to evaluate with real signal values
  const livePreview = useMemo(() => {
    if (!value.trim()) return null;
    try {
      let expr = value.trim().replace(/;\s*$/, '');
      if (!expr) return null;

      // Build values map from signals
      const vals = {};
      for (const s of signals) {
        if (!s.address) continue;
        // Use a dummy value based on type for preview
        const t = (s.data_type || '').toUpperCase();
        if (t === 'BOOL') vals[s.address] = false;
        else if (['INT','WORD','UINT','SINT','USINT','BYTE'].includes(t)) vals[s.address] = 0;
        else if (['DINT','UDINT','DWORD'].includes(t)) vals[s.address] = 0;
        else if (['REAL','LREAL'].includes(t)) vals[s.address] = 0.0;
        else if (['STRING','CHAR'].includes(t)) vals[s.address] = '';
        else vals[s.address] = 0;
      }

      // Handle IF/THEN
      if (/^\s*IF\b/i.test(expr)) {
        // Extract ELSE/default value to show as preview type
        const elseMatch = expr.match(/ELSE\s+([^\n;]*)/i);
        if (elseMatch) {
          const val = elseMatch[1].trim().replace(/;$/, '');
          if (/^'[^']*'$/.test(val)) return { value: val, type: 'STRING', ok: true };
          if (/^-?\d+$/.test(val)) return { value: parseInt(val), type: 'INT', ok: true };
          if (/^-?\d+\.\d+$/.test(val)) return { value: parseFloat(val), type: 'REAL', ok: true };
          if (/^(TRUE|FALSE)$/i.test(val)) return { value: val.toUpperCase(), type: 'BOOL', ok: true };
        }
        return { value: '(conditional)', type: 'LOOKUP', ok: true };
      }

      // Normalize = to ==
      expr = expr.replace(/(?<![<>!])=(?!=)/g, '==');

      // Replace addresses with dummy values
      const addrRegex = /DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g;
      let evalExpr = expr;
      const addrs = expr.match(addrRegex) || [];
      const addrMap = {};
      for (const addr of addrs) {
        const safe = addr.replace(/\./g, '_');
        addrMap[safe] = vals[addr] !== undefined ? vals[addr] : 0;
        if (typeof addrMap[safe] === 'boolean') addrMap[safe] = addrMap[safe] ? 1 : 0;
        evalExpr = evalExpr.split(addr).join(safe);
      }

      // Handle type conversions by replacing with inner value
      evalExpr = evalExpr.replace(/\b[A-Z]+_TO_[A-Z]+\s*\(([^)]*)\)/gi, '($1)');

      // Replace SCL keywords
      evalExpr = evalExpr.replace(/\bAND\b/g, 'and').replace(/\bOR\b/g, 'or').replace(/\bNOT\b/g, 'not');

      const p = new Parser({ operators: { logical: true, comparison: true, assignment: false, 'in': false } });
      p.functions.AND = (a, b) => (a ? 1 : 0) && (b ? 1 : 0) ? 1 : 0;
      p.functions.OR = (a, b) => (a ? 1 : 0) || (b ? 1 : 0) ? 1 : 0;
      p.functions.NOT = (a) => a ? 0 : 1;

      const parsed = p.parse(evalExpr);
      const result = parsed.evaluate(addrMap);

      const rType = typeof result === 'boolean' ? 'BOOL' :
                    typeof result === 'string' ? 'STRING' :
                    Number.isInteger(result) ? 'INT' : 'REAL';

      return { value: result, type: rType, ok: true };
    } catch (e) {
      return { value: e.message.substring(0, 60), type: null, ok: false };
    }
  }, [value, signals]);

  // Relevant conversions
  const relevantConversions = useMemo(() => {
    const srcTypes = new Set(referencedAddrs.map(a => getType(a)?.toUpperCase()).filter(Boolean));
    if (targetUpper) srcTypes.add(targetUpper);
    return CONVERSIONS.filter(c => {
      const parts = c.split('_TO_');
      return srcTypes.has(parts[0]) || srcTypes.has(parts[1]);
    }).slice(0, 10);
  }, [referencedAddrs, targetUpper, signals]);

  // Insert text at cursor
  function insertAtCursor(text) {
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const before = value.substring(0, start);
      const after = value.substring(end);
      const spaceBefore = before && !before.endsWith(' ') && !before.endsWith('\n') && !before.endsWith('(') ? ' ' : '';
      const newVal = before + spaceBefore + text + after;
      setValue(newVal);
      // Set cursor after inserted text
      setTimeout(() => { el.selectionStart = el.selectionEnd = start + spaceBefore.length + text.length; el.focus(); }, 0);
    } else {
      setValue(prev => prev ? `${prev} ${text}` : text);
    }
  }

  // Insert IF template
  function insertIfTemplate() {
    const isString = typeGroup(targetType) === 'string';
    const v1 = isString ? "'value1'" : '0';
    const v2 = isString ? "'value2'" : '1';
    const vd = isString ? "'default'" : '0';
    const template = `IF  THEN\n  ${v1};\nELSIF  THEN\n  ${v2};\nELSE\n  ${vd};\nEND_IF`;
    setValue(template);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) { el.selectionStart = el.selectionEnd = 3; el.focus(); }
    }, 0);
  }

  // Filtered signal search
  const filteredPick = search
    ? signals.filter(s => {
        const q = search.toLowerCase();
        return s.address?.toLowerCase().includes(q) || s.name?.toLowerCase().includes(q) || s.comment?.toLowerCase().includes(q);
      }).slice(0, 12)
    : [];

  function handleSave() {
    const trimmed = value.trim();
    if (!trimmed || validationErrors.length > 0) return;
    const type = detectedType;
    // For lookup type, parse IF/THEN/ELSE into lookup_table
    if (type === 'lookup') {
      const table = parseIfToLookup(trimmed);
      if (table) {
        onSave({ mapping_type: 'lookup', source_address: null, expression: null, lookup_table: table, confidence: 1.0, validated_by_human: true });
        return;
      }
    }
    onSave({
      mapping_type: type,
      source_address: type === 'direct' ? trimmed : null,
      expression: type !== 'direct' ? trimmed : null,
      confidence: 1.0,
      validated_by_human: true
    });
  }

  const canSave = value.trim() && validationErrors.length === 0;

  return (
    <div className="mt-2 bg-gray-50 rounded-md p-3 space-y-2.5 border border-gray-200">
      {/* Assignment header */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-gray-500 font-mono">{targetName || 'target'}</span>
        <DataTypeBadge type={targetType} />
        <span className="text-[11px] text-gray-400 font-mono">:=</span>
        <div className="flex-1" />
        <TypeTag type={detectedType} />
        {resultType && (
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-gray-400">→</span>
            <DataTypeBadge type={resultType} />
          </div>
        )}
      </div>

      {/* Code editor */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        className={`w-full bg-white text-signal-blue text-xs font-mono rounded-md px-3 py-2 border outline-none resize-none leading-5 ${
          validationErrors.length > 0 ? 'border-red-300 focus:border-red-400 focus:ring-1 focus:ring-red-100' :
          'border-gray-200 focus:border-signal-blue focus:ring-1 focus:ring-signal-blue/20'
        }`}
        rows={value.includes('\n') ? Math.min(value.split('\n').length + 1, 8) : 2}
        placeholder="DB10.DBX4.0 AND DB2.DBX0.0"
        autoFocus
        spellCheck={false}
      />

      {/* Live preview */}
      {livePreview && (
        <div className={`flex items-center gap-2 text-[10px] px-2 py-1 rounded-md ${
          livePreview.ok ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'
        }`}>
          <span className={livePreview.ok ? 'text-gray-500' : 'text-red-500'}>Preview:</span>
          {livePreview.ok ? (
            <>
              <span className="font-mono font-medium text-gray-900">{String(livePreview.value)}</span>
              <DataTypeBadge type={livePreview.type} />
              <span className="text-emerald-600">evaluates OK</span>
            </>
          ) : (
            <span className="text-red-600 font-mono">{livePreview.value}</span>
          )}
        </div>
      )}

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-md p-2 space-y-0.5">
          {validationErrors.map((err, i) => (
            <div key={i} className="text-[10px] text-red-700 flex items-start gap-1">
              <span className="text-red-400 shrink-0">●</span>
              <span>{err}</span>
            </div>
          ))}
        </div>
      )}

      {/* Referenced signals */}
      {referencedAddrs.length > 0 && (
        <div className="space-y-0.5">
          {referencedAddrs.map(addr => {
            const info = getInfo(addr);
            return (
              <div key={addr} className="text-[10px] flex items-center gap-1.5">
                <span className="text-signal-blue font-mono font-medium">{addr}</span>
                {info ? (
                  <>
                    <DataTypeBadge type={info.data_type} />
                    <span className="text-gray-500">{info.name}</span>
                    {info.comment && <span className="italic text-gray-400 truncate">// {info.comment}</span>}
                  </>
                ) : (
                  <span className="text-red-400">not found</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Signal search */}
      <div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          className="w-full bg-white text-gray-900 text-[11px] rounded-md px-2.5 py-1.5 border border-gray-200 outline-none focus:border-signal-blue placeholder:text-gray-400"
          placeholder="Search signal to insert..." />
        {filteredPick.length > 0 && (
          <div className="mt-1 max-h-32 overflow-y-auto border border-gray-200 rounded-md bg-white shadow-sm">
            {filteredPick.map(s => (
              <button key={s.address} onClick={() => { insertAtCursor(s.address); setSearch(''); }}
                className="w-full text-left px-2.5 py-1 text-[11px] hover:bg-gray-50 border-b border-gray-100 last:border-0 flex items-center gap-2">
                <span className="text-signal-blue font-mono font-medium shrink-0">{s.address}</span>
                <DataTypeBadge type={s.data_type} />
                <span className="text-gray-600 truncate">{s.name}</span>
                {s.comment && <span className="text-gray-400 italic truncate text-[10px]">{s.comment}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Operators + IF + Conversions */}
      <div className="space-y-1">
        <div className="flex flex-wrap gap-1">
          <button onClick={insertIfTemplate}
            className="text-[10px] bg-violet-50 hover:bg-violet-100 text-violet-700 px-2 py-0.5 rounded border border-violet-200 font-semibold transition-colors">
            IF / THEN
          </button>
          {['AND', 'OR', 'NOT', '>', '<', '>=', '<=', '==', '!=', '+', '-', '*', '/'].map(op => (
            <button key={op} onClick={() => insertAtCursor(op)}
              className="text-[10px] bg-white hover:bg-gray-100 text-gray-600 px-2 py-0.5 rounded border border-gray-200 font-mono transition-colors">
              {op}
            </button>
          ))}
        </div>
        {(relevantConversions.length > 0 || true) && (
          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-[9px] text-gray-400 mr-0.5">Convert:</span>
            {relevantConversions.map(conv => (
              <button key={conv} onClick={() => insertAtCursor(`${conv}(`)}
                className="text-[10px] bg-amber-50 hover:bg-amber-100 text-amber-700 px-2 py-0.5 rounded border border-amber-200 font-mono transition-colors">
                {conv}
              </button>
            ))}
            <button onClick={() => insertAtCursor('?_TO_?(')}
              className="text-[10px] bg-gray-50 hover:bg-gray-100 text-gray-500 px-2 py-0.5 rounded border border-dashed border-gray-300 font-mono transition-colors"
              title="Insert custom conversion – replace ? with type names (e.g. LREAL_TO_DINT)">
              ?_TO_?
            </button>
          </div>
        )}
      </div>

      {/* Save / Cancel */}
      <div className="flex items-center gap-2 pt-1">
        <button onClick={handleSave} disabled={!canSave}
          className="text-xs bg-signal-blue hover:bg-signal-blue-light text-white font-semibold px-3 py-1.5 rounded-md disabled:opacity-30 transition-colors">
          {t('expression.save') || 'Save'}
        </button>
        <button onClick={onCancel}
          className="text-xs bg-white hover:bg-gray-50 text-gray-600 border border-gray-200 px-3 py-1.5 rounded-md transition-colors">
          {t('expression.cancel') || 'Cancel'}
        </button>
        {!canSave && value.trim() && (
          <span className="text-[10px] text-red-500">{validationErrors[0] || 'Fix errors to save'}</span>
        )}
      </div>
    </div>
  );
}

/* ── Parse IF/THEN/ELSE to lookup table ────────────── */
function parseIfToLookup(expr) {
  try {
    const table = {};
    // Match: IF condition THEN 'value' (ELSIF condition THEN 'value')* (ELSE 'value')? END_IF
    const blocks = expr.split(/\bELSIF\b|\bELSE\b|\bEND_IF\b/i).filter(b => b.trim());

    // First block: IF condition THEN 'value'
    for (const block of blocks) {
      const ifMatch = block.match(/\bIF\s+(.*?)\s+THEN\s+'([^']*)'/is);
      const thenMatch = block.match(/^\s*\bTHEN\s+'([^']*)'/is);
      const valueOnly = block.match(/^\s*'([^']*)'\s*$/);

      if (ifMatch) {
        table[ifMatch[1].trim()] = ifMatch[2];
      } else if (thenMatch) {
        // ELSIF part: condition is before THEN
        const condMatch = block.match(/^\s*(.*?)\s+THEN\s+'([^']*)'/is);
        if (condMatch) table[condMatch[1].trim()] = condMatch[2];
      } else if (valueOnly) {
        table['DEFAULT'] = valueOnly[1];
      }
    }

    // Re-parse more carefully
    const reparse = {};
    const ifParts = expr.match(/IF\s+(.*?)\s+THEN\s+'([^']*)'/gi);
    if (ifParts) {
      for (const part of ifParts) {
        const m = part.match(/IF\s+(.*?)\s+THEN\s+'([^']*)'/i);
        if (m) reparse[m[1].trim()] = m[2];
      }
    }
    const elsifParts = expr.match(/ELSIF\s+(.*?)\s+THEN\s+'([^']*)'/gi);
    if (elsifParts) {
      for (const part of elsifParts) {
        const m = part.match(/ELSIF\s+(.*?)\s+THEN\s+'([^']*)'/i);
        if (m) reparse[m[1].trim()] = m[2];
      }
    }
    const elseMatch = expr.match(/ELSE\s+'([^']*)'/i);
    if (elseMatch) reparse['DEFAULT'] = elseMatch[1];

    return Object.keys(reparse).length > 0 ? reparse : null;
  } catch (e) {
    return null;
  }
}
