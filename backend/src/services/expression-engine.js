const { Parser } = require('expr-eval');

/**
 * Safe expression evaluator for PLC signal mapping expressions.
 * Supports: AND, OR, NOT, >, <, >=, <=, ==, !=, +, -, *, /
 *
 * Expressions reference PLC addresses that get replaced with actual values:
 *   "DB10.DBX4.0 AND DB10.DBD0 > 100 AND DB20.DBX1.2"
 */

const parser = new Parser({
  operators: {
    logical: true,
    comparison: true,
    assignment: false, // no assignment
    'in': false
  }
});

// Add AND/OR/NOT as custom operators via function aliases
parser.functions.AND = (a, b) => (a ? 1 : 0) && (b ? 1 : 0) ? 1 : 0;
parser.functions.OR = (a, b) => (a ? 1 : 0) || (b ? 1 : 0) ? 1 : 0;
parser.functions.NOT = (a) => a ? 0 : 1;

/**
 * Evaluate a mapping expression with given signal values.
 *
 * @param {string} expression - e.g. "DB10_DBX4_0 AND DB10_DBD0 > 100"
 * @param {Object} values - e.g. { "DB10.DBX4.0": true, "DB10.DBD0": 145.3 }
 * @returns {*} The evaluated result
 */
function evaluate(expression, values) {
  // Sanitize PLC addresses to valid variable names
  // DB10.DBX4.0 → DB10_DBX4_0
  let sanitizedExpr = expression;
  const addressMap = {};

  // Replace PLC addresses with safe variable names
  // Match patterns like DB10.DBX4.0, DB10.DBD0, DB20.DBW12
  const addressRegex = /DB\d+\.DB[XBWD]\d+(?:\.\d+)?/g;
  const matches = sanitizedExpr.match(addressRegex) || [];

  for (const addr of matches) {
    const safeVar = addr.replace(/\./g, '_');
    addressMap[safeVar] = values[addr];
    sanitizedExpr = sanitizedExpr.split(addr).join(safeVar);
  }

  // Also handle Rockwell-style addresses (tag names with dots)
  for (const [addr, val] of Object.entries(values)) {
    if (!addr.startsWith('DB')) {
      const safeVar = addr.replace(/[.\-:\s]/g, '_');
      addressMap[safeVar] = val;
      sanitizedExpr = sanitizedExpr.split(addr).join(safeVar);
    }
  }

  // Convert boolean values to 0/1 for expr-eval
  for (const [key, val] of Object.entries(addressMap)) {
    if (typeof val === 'boolean') {
      addressMap[key] = val ? 1 : 0;
    }
  }

  // Replace AND/OR/NOT keywords with function calls
  sanitizedExpr = sanitizedExpr
    .replace(/\bAND\b/g, 'and')
    .replace(/\bOR\b/g, 'or')
    .replace(/\bNOT\b/g, 'not');

  try {
    const expr = parser.parse(sanitizedExpr);
    const result = expr.evaluate(addressMap);

    // Convert back: if result is 0 or 1 and expression contains logical ops, return boolean
    if ((result === 0 || result === 1) && /\b(and|or|not)\b/i.test(expression)) {
      return result === 1;
    }
    return result;
  } catch (e) {
    throw new Error(`Expression evaluation failed: ${e.message}\nExpression: ${expression}\nSanitized: ${sanitizedExpr}`);
  }
}

/**
 * Validate an expression without evaluating it.
 * Returns { valid: boolean, error?: string, variables: string[] }
 */
function validate(expression) {
  try {
    let sanitizedExpr = expression;
    const addressRegex = /DB\d+\.DB[XBWD]\d+(?:\.\d+)?/g;
    const matches = sanitizedExpr.match(addressRegex) || [];
    const variables = [...matches];

    for (const addr of matches) {
      sanitizedExpr = sanitizedExpr.split(addr).join(addr.replace(/\./g, '_'));
    }

    sanitizedExpr = sanitizedExpr
      .replace(/\bAND\b/g, 'and')
      .replace(/\bOR\b/g, 'or')
      .replace(/\bNOT\b/g, 'not');

    parser.parse(sanitizedExpr);
    return { valid: true, variables };
  } catch (e) {
    return { valid: false, error: e.message, variables: [] };
  }
}

module.exports = { evaluate, validate };
