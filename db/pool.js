/**
 * Shared PostgreSQL connection pool.
 * Import this everywhere instead of creating new Pool() instances,
 * so the app respects a single connection budget under load.
 */
const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
});

pool.on('error', (err) => {
  // Catches errors on idle clients (e.g. connection dropped by DB) so
  // they don't crash the whole process.
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

module.exports = pool;
