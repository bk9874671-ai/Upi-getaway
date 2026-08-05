const express = require('express');
const router = express.Router();

const { buildUpiString } = require('../utils/upiString');
const { generateUpiQr } = require('../utils/qrGenerator');
const { createLimiter } = require('../middleware/rateLimiters');
const { createPaymentValidators, idempotencyKeyValidator } = require('../middleware/validators');
const transactionRepo = require('../db/transactionRepo');
const logger = require('../utils/logger');

const MERCHANT_VPA = process.env.MERCHANT_VPA;
const MERCHANT_NAME = process.env.MERCHANT_NAME;
const CURRENCY = process.env.UPI_CURRENCY || 'INR';
const QR_EXPIRY_MINUTES = 15; // typical UPI collect-QR validity window

/**
 * POST /api/create-upi-payment
 * Headers:  Idempotency-Key: <client-generated unique string>
 * Body:     { amount, order_id, customer_upi? , note? }
 *
 * Returns the UPI deep link plus QR (PNG data URL + SVG) for the
 * client to render. Safe to retry with the same Idempotency-Key —
 * returns the original transaction instead of creating a duplicate.
 */
router.post(
  '/create-upi-payment',
  createLimiter,
  idempotencyKeyValidator,
  createPaymentValidators,
  async (req, res) => {
    const { amount, order_id: orderId, customer_upi: customerUpi, note } = req.body;
    const idempotencyKey = req.idempotencyKey;

    try {
      // --- Idempotency check -------------------------------------------------
      // If a request with this exact Idempotency-Key already succeeded,
      // return the existing transaction rather than creating a new one.
      // This protects against double-charging from client retries
      // (e.g. a mobile app resubmitting on a timeout).
      const existing = await transactionRepo.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.order_id !== orderId) {
          // Same idempotency key reused for a different order_id is a
          // client bug, not a safe retry — reject explicitly.
          return res.status(409).json({
            error: 'idempotency_key_conflict',
            message: 'This Idempotency-Key was already used for a different order_id.',
          });
        }
        logger.info('Idempotent replay: returning existing transaction', { orderId });
        return res.status(200).json(formatResponse(existing, /* isReplay */ true));
      }

      // A second guard: order_id itself is also UNIQUE at the DB level,
      // so even without an idempotency key collision, a duplicate
      // order_id is caught below by the unique constraint violation.
      const existingOrder = await transactionRepo.findByOrderId(orderId);
      if (existingOrder) {
        return res.status(409).json({
          error: 'order_id_already_exists',
          message: 'A transaction with this order_id already exists.',
        });
      }

      // --- Build the UPI intent -----------------------------------------------
      const upiString = buildUpiString({
        payeeVpa: MERCHANT_VPA,
        payeeName: MERCHANT_NAME,
        amount: Number(amount),
        orderId,
        currency: CURRENCY,
        note,
      });

      const { dataUrl, svg } = await generateUpiQr(upiString);

      const expiresAt = new Date(Date.now() + QR_EXPIRY_MINUTES * 60 * 1000);
      const amountPaise = Math.round(Number(amount) * 100);

      const transaction = await transactionRepo.createTransaction({
        orderId,
        idempotencyKey,
        amountPaise,
        currency: CURRENCY,
        customerUpi,
        merchantVpa: MERCHANT_VPA,
        upiString,
        expiresAt,
      });

      logger.info('UPI payment intent created', { orderId, amountPaise });

      return res.status(201).json({
        ...formatResponse(transaction, false),
        qr_code_data_url: dataUrl,
        qr_code_svg: svg,
      });
    } catch (err) {
      // Unique violation on order_id/idempotency_key racing with a
      // concurrent request — treat as a conflict, not a 500.
      if (err.code === '23505') {
        logger.warn('Unique constraint hit on payment creation (likely concurrent duplicate)', {
          orderId,
          detail: err.detail,
        });
        return res.status(409).json({ error: 'duplicate_request', message: 'Duplicate order_id or idempotency key.' });
      }

      logger.error('Failed to create UPI payment', { error: err.message, orderId });
      return res.status(500).json({ error: 'internal_error', message: 'Could not create payment intent.' });
    }
  }
);

function formatResponse(tx, isReplay) {
  return {
    order_id: tx.order_id,
    status: tx.status,
    amount: (Number(tx.amount_paise) / 100).toFixed(2),
    currency: tx.currency,
    upi_string: tx.upi_string,
    expires_at: tx.expires_at,
    replay: isReplay,
  };
}

module.exports = router;
