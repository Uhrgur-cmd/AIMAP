const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ctgate:ctgate@localhost:5432/ctgate'
});

module.exports = pool;
