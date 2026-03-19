const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL || '';
const isRemote = databaseUrl.includes('supabase.com') || databaseUrl.includes('pooler');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRemote ? { rejectUnauthorized: false } : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false),
});

// Test the connection
pool.on('connect', () => {
  if (process.env.NODE_ENV !== 'test') {
    console.log('✅ Connected to PostgreSQL database');
  }
});

pool.on('error', (err) => {
  console.error('❌ Database pool error:', err);
});

/**
 * Execute a query against the database
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development') {
      console.log('🔍 DB query:', { text: text.substring(0, 80), duration, rows: res.rowCount });
    }
    return res;
  } catch (err) {
    console.error('❌ DB query error:', { 
      text: text.substring(0, 100), 
      errorMessage: err.message,
      errorCode: err.code,
      stack: err.stack 
    });
    throw err;
  }
};

/**
 * Get a client from the pool (for transactions)
 */
const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
