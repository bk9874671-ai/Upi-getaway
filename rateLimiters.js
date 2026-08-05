const rateLimit = require('express-rate-limit');

const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);

/**
 * Separate limiters per endpoint class:
 *  - createLimiter: stricter, since payment creation is the most
 *    expensive/abusable operation (QR generation + DB write).
 *  - statusLimiter: looser, since legitimate clients poll this
 *    repeatedly while waiting for a payment to settle.
 *  - webhookLimiter: generous but present, as a backstop against a
 *    misbehaving or compromised upstream flooding the endpoint —
 *    real protection there is the signature check, not this limiter.
 */
const createLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX_CREATE || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many payment creation attempts. Please slow down.' },
});

const statusLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX_STATUS || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many status checks. Please slow down.' },
});

const webhookLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX_WEBHOOK || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

module.exports = { createLimiter, statusLimiter, webhookLimiter };
