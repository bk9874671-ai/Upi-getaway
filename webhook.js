const express = require('express');
const router = express.Router();

const { verifyWebhookMiddleware } = require('../middleware/verifyWebhook');
const { webhookLimiter } = require('../middleware/rateLimiters');
const transactionRepo = require('../db/transactionRepo');
const pool = require('../db/pool');
const { broadcastStatus } = require('../utils/wsHub');
const logger = require('../utils/logger');

/**
 * POST /api/upi-webhook
 *
 * Receives server-to-server settlement notifications from the
 * payment aggregator / banking partner. Expected payload shape will
 * vary by PSP — adapt `extractWebhookFields()` below to match your
 * provider's actual schema (Razorpay, Cashfree, PayU, PhonePe PG,
 * or a bank's direct callback all use slightly different field
 * names for the same concepts).
 *
 * Flow:
 *   1. Signature + timestamp already verified by verifyWebhookMiddleware
 *      (registered before this handler).
 *   2. Log the raw event for audit, with dedup on PSP event_id.
 *   3. Atomically settle the matching PENDING transaction.
 *   4. Push a WebSocket update to any subscribed client.
 *   5. Always return 200 once the event is durably logged, even on a
 *      no-op settle (e.g. duplicate delivery) — PSPs retry on non-2xx,
 *      and we don't want retry storms for events we've already handled.
 */
router.post('/upi-webhook', webhookLimiter, verifyWebhookMiddleware, async (req, res) => {
  const payload = req.body;

  let fields;
  try {
    fields = extractWebhookFields(payload);
  } catch (err) {
    logger.warn('Webhook payload missing required fields', { error: err.message });
    return res.status(400).json({ error: 'invalid_payload', message: err.message });
  }

  const { orderId, status, rrn, pspRefId, eventId, failureReason } = fields;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Dedup on PSP-provided event_id where available — some
    // aggregators redeliver the identical event multiple times.
    let alreadyLogged = false;
    if (eventId) {
      const { rows } = await client.query(
        `SELECT id FROM upi_webhook_events WHERE event_id = $1`,
        [eventId]
      );
      alreadyLogged = rows.length > 0;
    }

    if (!alreadyLogged) {
      await client.query(
        `INSERT INTO upi_webhook_events (order_id, signature, event_id, raw_payload, verified, processed)
         VALUES ($1, $2, $3, $4, true, true)`,
        [orderId, req.headers[(process.env.WEBHOOK_SIGNATURE_HEADER || 'x-webhook-signature').toLowerCase()] || null, eventId || null, payload]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to log webhook event', { error: err.message, orderId });
    // Still proceed to attempt settlement — audit logging failure
    // shouldn't block the money-relevant state update, but it is
    // worth alerting on in production monitoring.
  } finally {
    client.release();
  }

  try {
    const updated = await transactionRepo.settleTransaction({
      orderId,
      status,
      rrn,
      pspRefId,
      failureReason,
      webhookPayload: payload,
    });

    if (updated) {
      logger.info('Transaction settled via webhook', { orderId, status, rrn });
      broadcastStatus(orderId, { status: updated.status, rrn: updated.rrn });
    } else {
      logger.info('Webhook received for already-settled or unknown order (no-op)', { orderId, status });
    }

    // Always 200 — see docstring above on why.
    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error settling transaction from webhook', { error: err.message, orderId });
    // 500 here is intentional: this is a genuine processing failure
    // (e.g. DB down), and the PSP *should* retry this one.
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Adapt this to your PSP's actual webhook schema. Shown here is a
 * reasonably generic shape. Throws if mandatory fields are missing.
 */
function extractWebhookFields(payload) {
  const orderId = payload.order_id || payload.merchant_ref || payload.tr;
  const rawStatus = (payload.status || payload.txn_status || '').toUpperCase();
  const rrn = payload.rrn || payload.npci_txn_id || payload.utr;
  const pspRefId = payload.psp_ref_id || payload.transaction_id || payload.id;
  const eventId = payload.event_id || payload.webhook_id;
  const failureReason = payload.failure_reason || payload.error_description;

  if (!orderId) throw new Error('order_id (or merchant_ref/tr) missing from webhook payload');
  if (!rawStatus) throw new Error('status missing from webhook payload');

  const statusMap = {
    SUCCESS: 'SUCCESS',
    SUCCESSFUL: 'SUCCESS',
    COMPLETED: 'SUCCESS',
    PAID: 'SUCCESS',
    FAILED: 'FAILED',
    FAILURE: 'FAILED',
    DECLINED: 'FAILED',
    CANCELLED: 'FAILED',
  };
  const status = statusMap[rawStatus];
  if (!status) throw new Error(`Unrecognized status value from PSP: "${rawStatus}"`);

  return { orderId, status, rrn, pspRefId, eventId, failureReason };
}

module.exports = router;
