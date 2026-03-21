const { Parser } = require('expr-eval');

/**
 * Unified SCL Expression Evaluator
 *
 * Handles ALL mapping types in one function:
 *   - Direct:      "DB10.DBX4.0;"
 *   - Expression:  "DB10.DBX4.0 AND NOT DB2.DBX0.1;"
 *   - Arithmetic:  "(DB0.DBW2 + DB0.DBW4) * 2;"
 *   - Conversion:  "DINT_TO_REAL(DB1.DBD0) / 100;"
 *   - Lookup:      "IF condition THEN value ELSIF ... ELSE default END_IF"
 *
 * All expressions use SCL syntax. Semicolons are stripped before evaluation.
 */

const parser = new Parser({
  operators: { logical: true, comparison: true, assignment: false, 'in': false }
});
parser.functions.AND = (a, b) => (a ? 1 : 0) && (b ? 1 : 0) ? 1 : 0;
parser.functions.OR = (a, b) => (a ? 1 : 0) || (b ? 1 : 0) ? 1 : 0;
parser.functions.NOT = (a) => a ? 0 : 1;

// ─── Address regex: DB addresses + I/Q/M ─────────────────────
const ADDR_REGEX = /DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?/g;

// ─── Type conversion functions ───────────────────────────────
const TYPE_CONVERSIONS = {
  'BOOL_TO_INT':    v => v ? 1 : 0,
  'BOOL_TO_DINT':   v => v ? 1 : 0,
  'BOOL_TO_REAL':   v => v ? 1.0 : 0.0,
  'BOOL_TO_STRING': v => v ? 'TRUE' : 'FALSE',
  'BOOL_TO_BYTE':   v => v ? 1 : 0,
  'BOOL_TO_WORD':   v => v ? 1 : 0,
  'BYTE_TO_INT':    v => Number(v) || 0,
  'BYTE_TO_DINT':   v => Number(v) || 0,
  'BYTE_TO_REAL':   v => Number(v) || 0.0,
  'BYTE_TO_BOOL':   v => !!v,
  'BYTE_TO_STRING': v => String(v),
  'BYTE_TO_WORD':   v => Number(v) || 0,
  'INT_TO_REAL':    v => Number(v) || 0.0,
  'INT_TO_DINT':    v => Math.trunc(Number(v)) || 0,
  'INT_TO_STRING':  v => String(v),
  'INT_TO_BOOL':    v => !!v,
  'INT_TO_BYTE':    v => (Number(v) || 0) & 0xFF,
  'INT_TO_WORD':    v => (Number(v) || 0) & 0xFFFF,
  'DINT_TO_REAL':   v => Number(v) || 0.0,
  'DINT_TO_INT':    v => Math.trunc(Number(v)) & 0xFFFF,
  'DINT_TO_STRING': v => String(v),
  'DINT_TO_BOOL':   v => !!v,
  'WORD_TO_INT':    v => Number(v) || 0,
  'WORD_TO_DINT':   v => Number(v) || 0,
  'WORD_TO_BOOL':   v => !!v,
  'WORD_TO_BYTE':   v => (Number(v) || 0) & 0xFF,
  'WORD_TO_STRING': v => String(v),
  'DWORD_TO_DINT':  v => Number(v) || 0,
  'DWORD_TO_REAL':  v => Number(v) || 0.0,
  'DWORD_TO_STRING':v => String(v),
  'REAL_TO_INT':    v => Math.trunc(Number(v)) || 0,
  'REAL_TO_DINT':   v => Math.trunc(Number(v)) || 0,
  'REAL_TO_STRING': v => String(Number(v) || 0),
  'STRING_TO_INT':  v => parseInt(v) || 0,
  'STRING_TO_DINT': v => parseInt(v) || 0,
  'STRING_TO_REAL': v => parseFloat(v) || 0.0,
  'TIME_TO_DINT':   v => Number(v) || 0,
  'DINT_TO_TIME':   v => Number(v) || 0,
};

/**
 * Evaluate any SCL expression with PLC signal values.
 *
 * @param {string} expression - SCL expression (with or without trailing ;)
 * @param {Object} values - { "DB10.DBX4.0": true, "DB0.DBW2": 42, ... }
 * @returns {*} The evaluated result (boolean, number, or string)
 */
function evaluate(expression, values) {
  if (!expression) return undefined;

  // Strip trailing semicolons and whitespace
  let expr = expression.trim().replace(/;\s*$/, '').trim();
  if (!expr) return undefined;

  // ── IF/THEN/ELSE → evaluate as lookup ──────────────────────
  if (/^\s*IF\b/i.test(expr)) {
    return evaluateIfThenElse(expr, values);
  }

  // ── Single address shortcut (preserves boolean type) ────────
  const singleAddr = expr.match(/^(DB\d+\.DB[XBWD]\d+(?:\.\d+)?|[IQM]\d+(?:\.\d+)?)$/);
  if (singleAddr) {
    const val = values[singleAddr[1]];
    return val !== undefined ? val : null;
  }

  // ── Type conversions: XXX_TO_YYY(inner) ────────────────────
  expr = applyTypeConversions(expr, values);

  // If conversion produced a string/boolean result
  if (typeof expr === 'string') {
    if (/^'.*'$/.test(expr)) return expr.slice(1, -1);
    if (/^true$/i.test(expr)) return true;
    if (/^false$/i.test(expr)) return false;
  }

  // ── Standard expression evaluation ─────────────────────────
  return evaluateSimple(expr, values);
}

/**
 * Evaluate IF/THEN/ELSIF/ELSE/END_IF as a conditional lookup.
 */
function evaluateIfThenElse(expr, values) {
  // Parse into condition→value pairs
  // Format: IF cond1 THEN val1 ELSIF cond2 THEN val2 ELSE valDefault END_IF
  const branches = [];
  let defaultValue = null;

  // Extract ELSIF branches
  const elsifPattern = /ELSIF\s+(.*?)\s+THEN\s+(.*?)(?=\s*(?:ELSIF|ELSE|END_IF))/gis;
  let m;
  while ((m = elsifPattern.exec(expr)) !== null) {
    branches.push({ condition: m[1].trim(), value: m[2].trim() });
  }

  // Extract first IF branch
  const ifMatch = expr.match(/^IF\s+(.*?)\s+THEN\s+(.*?)(?=\s*(?:ELSIF|ELSE|END_IF))/is);
  if (ifMatch) {
    branches.unshift({ condition: ifMatch[1].trim(), value: ifMatch[2].trim() });
  }

  // Extract ELSE
  const elseMatch = expr.match(/ELSE\s+(.*?)\s*END_IF/is);
  if (elseMatch) {
    defaultValue = elseMatch[1].trim();
  }

  // Evaluate branches in order – first TRUE condition wins
  for (const branch of branches) {
    try {
      const condResult = evaluateSimple(branch.condition.replace(/;\s*$/, ''), values);
      if (condResult === true || condResult === 1) {
        return evaluateValue(branch.value, values);
      }
    } catch (e) {
      // Skip failed conditions
    }
  }

  return defaultValue !== null ? evaluateValue(defaultValue, values) : null;
}

/**
 * Evaluate a value from IF/THEN – can be a literal OR an expression/conversion.
 */
function evaluateValue(val, values) {
  const v = val.replace(/;\s*$/, '').trim();
  // Quoted string literal
  if (/^'[^']*'$/.test(v)) return v.slice(1, -1);
  // Simple literals
  if (/^TRUE$/i.test(v)) return true;
  if (/^FALSE$/i.test(v)) return false;
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  // Otherwise try to evaluate as expression (supports conversions, addresses, arithmetic)
  try {
    let expr = applyTypeConversions(v, values);
    if (typeof expr === 'string' && (/^'.*'$/.test(expr) || /^(TRUE|FALSE)$/i.test(expr))) {
      return parseValue(expr);
    }
    return evaluateSimple(expr, values);
  } catch (e) {
    return v; // Return raw string if all else fails
  }
}

/**
 * Parse a value string: 'text' → string, 123 → number, TRUE/FALSE → boolean
 */
function parseValue(val) {
  const v = val.replace(/;\s*$/, '').trim();
  // Quoted string
  if (/^'[^']*'$/.test(v)) return v.slice(1, -1);
  // Boolean
  if (/^TRUE$/i.test(v)) return true;
  if (/^FALSE$/i.test(v)) return false;
  // Float
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  // Integer
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  // Otherwise return as string
  return v;
}

/**
 * Apply type conversion functions in the expression.
 * Replaces XXX_TO_YYY(inner) with the converted result.
 */
function applyTypeConversions(expr, values) {
  // Recursively replace innermost conversion calls
  let result = expr;
  let safety = 0;
  while (/\b([A-Z]+_TO_[A-Z]+)\s*\(([^()]*)\)/i.test(result) && safety++ < 10) {
    result = result.replace(/\b([A-Z]+_TO_[A-Z]+)\s*\(([^()]*)\)/gi, (match, func, inner) => {
      const fn = TYPE_CONVERSIONS[func.toUpperCase()];
      if (!fn) return match; // Unknown conversion, leave as-is
      try {
        const innerVal = evaluateSimple(inner.trim(), values);
        const converted = fn(innerVal);
        // If result is string, wrap in quotes so it doesn't get parsed as variable
        if (typeof converted === 'string') return `'${converted}'`;
        if (typeof converted === 'boolean') return converted ? 'true' : 'false';
        return String(converted);
      } catch (e) {
        return match;
      }
    });
  }
  return result;
}

/**
 * Evaluate a simple expression (no IF/THEN, no conversions).
 */
function evaluateSimple(expression, values) {
  let sanitizedExpr = expression;
  const addressMap = {};

  // Replace PLC addresses with safe variable names
  const matches = sanitizedExpr.match(ADDR_REGEX) || [];
  for (const addr of matches) {
    const safeVar = addr.replace(/\./g, '_');
    addressMap[safeVar] = values[addr];
    sanitizedExpr = sanitizedExpr.split(addr).join(safeVar);
  }

  // Also handle non-DB addresses (I/Q/M already caught by ADDR_REGEX)
  for (const [addr, val] of Object.entries(values)) {
    if (!addr.startsWith('DB') && !addr.startsWith('I') && !addr.startsWith('Q') && !addr.startsWith('M')) {
      const safeVar = addr.replace(/[.\-:\s]/g, '_');
      if (!addressMap[safeVar]) {
        addressMap[safeVar] = val;
        sanitizedExpr = sanitizedExpr.split(addr).join(safeVar);
      }
    }
  }

  // Convert booleans to 0/1 for expr-eval
  for (const [key, val] of Object.entries(addressMap)) {
    if (typeof val === 'boolean') addressMap[key] = val ? 1 : 0;
    if (val === undefined || val === null) addressMap[key] = 0;
  }

  // Replace SCL keywords with expr-eval compatible names
  sanitizedExpr = sanitizedExpr
    .replace(/\bAND\b/g, 'and')
    .replace(/\bOR\b/g, 'or')
    .replace(/\bNOT\b/g, 'not');

  // Normalize single = to == (SCL uses = for comparison, := for assignment)
  // But don't touch <=, >=, !=, ==
  sanitizedExpr = sanitizedExpr.replace(/(?<![<>!=])=(?!=)/g, '==');

  const parsed = parser.parse(sanitizedExpr);
  const result = parsed.evaluate(addressMap);

  // Return as boolean if the expression uses logical operators
  if ((result === 0 || result === 1) && /\b(and|or|not)\b/i.test(expression)) {
    return result === 1;
  }
  return result;
}

/**
 * Extract all PLC addresses referenced in an expression.
 */
function extractAddresses(expression) {
  if (!expression) return [];
  return [...new Set((expression.match(ADDR_REGEX) || []).map(a => a.trim()))];
}

/**
 * Validate an expression without evaluating it.
 */
function validate(expression) {
  try {
    let expr = (expression || '').trim().replace(/;\s*$/, '');
    if (!expr) return { valid: false, error: 'Empty expression', variables: [] };

    // IF/THEN just needs structural validity
    if (/^\s*IF\b/i.test(expr)) {
      const hasIf = /\bIF\b/i.test(expr);
      const hasThen = /\bTHEN\b/i.test(expr);
      const hasEndIf = /\bEND_IF\b/i.test(expr);
      if (!hasThen) return { valid: false, error: 'IF without THEN', variables: extractAddresses(expr) };
      if (!hasEndIf) return { valid: false, error: 'IF without END_IF', variables: extractAddresses(expr) };
      return { valid: true, variables: extractAddresses(expr) };
    }

    // Strip conversions for validation
    let testExpr = expr.replace(/\b[A-Z]+_TO_[A-Z]+\s*\(/gi, '(');

    const variables = extractAddresses(testExpr);
    let sanitized = testExpr;
    for (const addr of (testExpr.match(ADDR_REGEX) || [])) {
      sanitized = sanitized.split(addr).join(addr.replace(/\./g, '_'));
    }
    sanitized = sanitized.replace(/\bAND\b/g, 'and').replace(/\bOR\b/g, 'or').replace(/\bNOT\b/g, 'not');
    parser.parse(sanitized);
    return { valid: true, variables };
  } catch (e) {
    return { valid: false, error: e.message, variables: [] };
  }
}

module.exports = { evaluate, validate, extractAddresses, parseValue };
