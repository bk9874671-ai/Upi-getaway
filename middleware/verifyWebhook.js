const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Verifies inbound PSP/bank webhook authenticity before any business
 * logic runs. Two checks, both required:
 *
 *   1. HMAC-SHA256 signature over the raw request body, using the
 *      shared webhook secret issued by your PSP/banking partner.
 *      Computed against the RAW body bytes (not the parsed JSON) to
 *      avoid signature mismatches from re-serialization.
 *
 *   2. Timestamp freshness — rejects requests whose timestamp header
 *      is older than WEBHOOK_MAX_SKEW_SECONDS, to mitigate replay
 *      attacks with a captured valid payload.
 *
 * NOTE: If your specific PSP (Razorpay, Cashfree, PayU, PhonePe
 * PG, or a bank's direct API) uses RSA/ECDSA signatures instead of
 * HMAC, swap the verifyHmac() call below for a crypto.verify() call
 * using their public key — see the commented alternative at the
 * bottom of this file.
 */

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyHmacSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return timingSafeEqualHex(expected, signatureHeader);
  } catch {
    return false; // malformed header, non-hex, length mismatch, etc.
  }
}

function verifyWebhookMiddleware(req, res, next) {
  const sigHeaderName = (process.env.WEBHOOK_SIGNATURE_HEADER || 'x-webhook-signature').toLowerCase();
  const tsHeaderName = (process.env.WEBHOOK_TIMESTAMP_HEADER || 'x-webhook-timestamp').toLowerCase();
  const maxSkew = Number(process.env.WEBHOOK_MAX_SKEW_SECONDS || 300);

  const signature = req.headers[sigHeaderName];
  const timestamp = req.headers[tsHeaderName];
  const secret = process.env.WEBHOOK_SECRET;

  if (!secret) {
    logger.error('WEBHOOK_SECRET is not configured');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // req.rawBody is populated by the raw-body capture middleware
  // registered in server.js BEFORE express.json() parses it.
  if (!req.rawBody) {
    logger.error('Raw body unavailable for webhook signature verification');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // 1. Replay protection via timestamp freshness
  const ts = Number(timestamp);
  if (!timestamp || Number.isNaN(ts)) {
    return res.status(400).json({ error: 'missing_or_invalid_timestamp' });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > maxSkew) {
    logger.warn('Webhook rejected: timestamp outside allowed skew', { ts, nowSeconds });
    return res.status(400).json({ error: 'stale_or_future_timestamp' });
  }

  // 2. Signature verification
  // Common convention: sign `${timestamp}.${rawBody}` rather than the
  // body alone, so the timestamp itself is tamper-evident too.
  const signedPayload = `${timestamp}.${req.rawBody}`;
  const valid = verifyHmacSignature(signedPayload, signature, secret);

  if (!valid) {
    logger.warn('Webhook rejected: invalid signature');
    return res.status(401).json({ error: 'invalid_signature' });
  }

  req.webhookVerified = true;
  next();
}

module.exports = { verifyWebhookMiddleware, verifyHmacSignature };

/* ------------------------------------------------------------------
 * ASYMMETRIC (RSA/ECDSA) ALTERNATIVE
 * Use this instead if your PSP signs with a private key and gives you
 * a public key/cert to verify against (common with some bank-direct
 * integrations). Replace the HMAC block above with:
 *
 *   const fs = require('fs');
 *   const publicKey = fs.readFileSync(process.env.WEBHOOK_PUBLIC_KEY_PATH, 'utf8');
 *   const verifier = crypto.createVerify('RSA-SHA256');
 *   verifier.update(signedPayload);
 *   const valid = verifier.verify(publicKey, signature, 'base64');
 * ------------------------------------------------------------------ */
