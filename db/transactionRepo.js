const pool = require('./pool');
const logger = require('../utils/logger');

/**
 * All transaction status changes go through this repository so the
 * "terminal state can't be reopened" rule is enforced in exactly one
 * place, inside a single-statement atomic UPDATE guarded by a WHERE
 * clause on the current status — this avoids race conditions between
 * a webhook and a concurrent status poll/retry without needing
 * explicit row locks.
 */

async function createTransaction({
  orderId,
  idempotencyKey,
  amountPaise,
  currency,
  customerUpi,
  merchantVpa,
  upiString,
  expiresAt,
}) {
  const { rows } = await pool.query(
    `INSERT INTO upi_transactions
       (order_id, idempotency_key, amount_paise, currency, customer_upi,
        merchant_vpa, upi_string, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
     RETURNING *`,
    [orderId, idempotencyKey, amountPaise, currency, customerUpi || null, merchantVpa, upiString, expiresAt]
  );
  return rows[0];
}

async function findByIdempotencyKey(idempotencyKey) {
  const { rows } = await pool.query(
    `SELECT * FROM upi_transactions WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  return rows[0] || null;
}

async function findByOrderId(orderId) {
  const { rows } = await pool.query(
    `SELECT * FROM upi_transactions WHERE order_id = $1`,
    [orderId]
  );
  return rows[0] || null;
}

/**
 * Atomically transitions a PENDING transaction to SUCCESS or FAILED.
 * The WHERE status = 'PENDING' guard means:
 *   - A duplicate webhook retry for an already-settled order is a
 *     harmless no-op (rowCount === 0), not a double-processed event.
 *   - Two concurrent webhook deliveries can't both "win" — only the
 *     first UPDATE that finds status = 'PENDING' will match.
 * Returns the updated row, or null if no PENDING row matched (i.e.
 * already settled or doesn't exist).
 */
async function settleTransaction({ orderId, status, rrn, pspRefId, failureReason, webhookPayload }) {
  if (!['SUCCESS', 'FAILED'].includes(status)) {
    throw new Error(`settleTransaction: invalid terminal status "${status}"`);
  }

  const { rows } = await pool.query(
    `UPDATE upi_transactions
        SET status = $2,
            rrn = COALESCE($3, rrn),
            psp_ref_id = COALESCE($4, psp_ref_id),
            failure_reason = $5,
            webhook_payload = $6
      WHERE order_id = $1
        AND status = 'PENDING'
      RETURNING *`,
    [orderId, status, rrn || null, pspRefId || null, failureReason || null, webhookPayload || null]
  );

  if (rows.length === 0) {
    logger.info('Webhook settle no-op (already terminal or unknown order)', { orderId, attemptedStatus: status });
    return null;
  }
  return rows[0];
}

/**
 * Marks any PENDING transactions past their expiry as EXPIRED.
 * Intended to be run on a schedule (see server.js cron-style interval)
 * so stale QR codes don't sit in PENDING forever.
 */
async function expireStaleTransactions() {
  const { rows } = await pool.query(
    `UPDATE upi_transactions
        SET status = 'EXPIRED', failure_reason = 'expired'
      WHERE status = 'PENDING' AND expires_at < now()
      RETURNING order_id`
  );
  if (rows.length) {
    logger.info('Expired stale PENDING transactions', { count: rows.length });
  }
  return rows;
}

module.exports = {
  createTransaction,
  findByIdempotencyKey,
  findByOrderId,
  settleTransaction,
  expireStaleTransactions,
};
