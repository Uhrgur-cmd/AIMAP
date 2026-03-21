/**
 * Simple DB result classifier.
 * Classifies findings based on heuristics:
 *   - REAL → LOW / PROCESS / HIGH
 *   - INT  → FLAG / SMALL / LARGE
 *   - BOOL → BIT FLAG
 */

const fs = require('fs');
const path = require('path');

/** Safely parse a DB result JSON file */
function safeJSONParse(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');

  if (start === -1 || end === -1) {
    throw new Error(`Invalid JSON in ${filePath}`);
  }

  const clean = raw.slice(start, end + 1);
  return JSON.parse(clean);
}

/**
 * Classification logic
 */
function classify(dbData) {
  return dbData.map(item => {
    let guess = item.type;
    let meta = {};

    if (item.type === 'REAL') {
      const v = item.value;

      if (v >= 0 && v <= 200) guess = 'LOW_VALUE';
      else if (v <= 1000) guess = 'PROCESS_VALUE';
      else guess = 'HIGH_VALUE';
    }

    if (item.type === 'INT') {
      const v = item.value;

      if (v === 0 || v === 1) guess = 'FLAG';
      else if (v < 1000) guess = 'SMALL_VALUE';
      else guess = 'LARGE_VALUE';
    }

    if (item.type === 'BOOL') {
      guess = 'BIT_FLAG';
    }

    return { ...item, guess, ...meta };
  });
}

/**
 * CLI mode:
 *   node s7-classifier.js scan-results/<folder>
 */
if (require.main === module) {
  let dir = process.argv[2];

  if (!dir) {
    console.error('Usage: node s7-classifier.js <directory>');
    process.exit(1);
  }

  dir = dir.trim();
  const files = fs.readdirSync(dir).filter(f => f.startsWith('db_'));

  const all = files.map(file => {
    const full = path.join(dir, file);
    const data = safeJSONParse(full);
    return {
      db: file,
      data: classify(data)
    };
  });

  fs.writeFileSync(
    path.join(dir, 'classified-results.json'),
    JSON.stringify(all, null, 2)
  );

  console.log('✅ Classification complete');
}