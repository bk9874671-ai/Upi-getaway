/**
 * Dev helper — generates a correctly-signed test webhook request so
 * you can exercise POST /api/upi-webhook locally without a live PSP.
 *
 * Usage:
 *   node scripts/testWebhookSign.js
 *   # then copy the printed curl command and run it
 */
require('dotenv').config();
const crypto = require('crypto');

const secret = process.env.WEBHOOK_SECRET || 'dev_secret_change_me';

const body = {
  order_id: 'ORDER_TEST_001',
  status: 'SUCCESS',
  rrn: '123456789012',
  psp_ref_id: 'psp_txn_abc123',
  event_id: `evt_${Date.now()}`,
};

const rawBody = JSON.stringify(body);
const timestamp = Math.floor(Date.now() / 1000);
const signedPayload = `${timestamp}.${rawBody}`;
const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

console.log('--- Signed test webhook ---');
console.log(`Timestamp: ${timestamp}`);
console.log(`Signature: ${signature}`);
console.log('\nCurl command:\n');
console.log(
  `curl -X POST http://localhost:${process.env.PORT || 4000}/api/upi-webhook \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -H "x-webhook-timestamp: ${timestamp}" \\\n` +
    `  -H "x-webhook-signature: ${signature}" \\\n` +
    `  -d '${rawBody}'`
);
