const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://aimap:aimap@localhost:5432/aimap'
});

module.exports = pool;
