const { body, param, validationResult } = require('express-validator');
const { isValidVpa } = require('../utils/upiString');

/**
 * Runs after the validation chains below; returns a 400 with details
 * if any rule failed, otherwise passes through.
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'validation_failed',
      details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

const createPaymentValidators = [
  body('amount')
    .isFloat({ gt: 0, lt: 200000 })
    .withMessage('amount must be a positive number (rupees), under ₹2,00,000 per transaction'),
  body('order_id')
    .isString()
    .trim()
    .isLength({ min: 4, max: 64 })
    .matches(/^[A-Za-z0-9_\-]+$/)
    .withMessage('order_id must be 4-64 alphanumeric/underscore/hyphen characters'),
  body('customer_upi')
    .optional({ nullable: true })
    .custom((value) => isValidVpa(value))
    .withMessage('customer_upi must be a valid VPA (e.g. name@bank)'),
  body('note').optional().isString().trim().isLength({ max: 50 }),
  // Idempotency key comes via header, not body — validated separately below.
  handleValidationErrors,
];

const idempotencyKeyValidator = (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key || typeof key !== 'string' || key.length < 8 || key.length > 128) {
    return res.status(400).json({
      error: 'missing_idempotency_key',
      message: 'Provide a unique Idempotency-Key header (8-128 chars) with every payment creation request.',
    });
  }
  req.idempotencyKey = key;
  next();
};

const orderIdParamValidator = [
  param('order_id')
    .isString()
    .trim()
    .isLength({ min: 4, max: 64 })
    .matches(/^[A-Za-z0-9_\-]+$/)
    .withMessage('invalid order_id format'),
  handleValidationErrors,
];

module.exports = {
  createPaymentValidators,
  idempotencyKeyValidator,
  orderIdParamValidator,
  handleValidationErrors,
};
