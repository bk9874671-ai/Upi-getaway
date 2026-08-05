const express = require('express');
const router = express.Router();

const { statusLimiter } = require('../middleware/rateLimiters');
const { orderIdParamValidator } = require('../middleware/validators');
const transactionRepo = require('../db/transactionRepo');

/**
 * GET /api/payment-status/:order_id
 *
 * Polling fallback for clients that aren't using the WebSocket push
 * (utils/wsHub.js, ws://host/ws?order_id=...). Cheap read-only query,
 * safe for a frontend to call every few seconds while a QR is
 * displayed and awaiting settlement.
 */
router.get('/payment-status/:order_id', statusLimiter, orderIdParamValidator, async (req, res) => {
  const { order_id: orderId } = req.params;

  try {
    const tx = await transactionRepo.findByOrderId(orderId);
    if (!tx) {
      return res.status(404).json({ error: 'not_found', message: 'No transaction with this order_id.' });
    }

    return res.status(200).json({
      order_id: tx.order_id,
      status: tx.status, // PENDING | SUCCESS | FAILED | EXPIRED
      amount: (Number(tx.amount_paise) / 100).toFixed(2),
      currency: tx.currency,
      rrn: tx.rrn || null,
      failure_reason: tx.failure_reason || null,
      created_at: tx.created_at,
      updated_at: tx.updated_at,
      expires_at: tx.expires_at,
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', message: 'Could not fetch payment status.' });
  }
});

module.exports = router;
