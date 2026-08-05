# UPI Payment Gateway Integration Layer

Production-ready Node.js/Express + PostgreSQL service for generating UPI
payment intents/QR codes, receiving signed webhook settlements, and
serving real-time payment status (polling + WebSocket).

## Setup

```bash
npm install
cp .env.example .env        # fill in real values — see notes below
npm run migrate             # applies db/schema.sql
npm start                    # or `npm run dev` with nodemon
```

Requires a running PostgreSQL instance and a **PSP/banking-partner
webhook secret** (see below — this is not optional for production).

## Environment variables that need real values

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Your Postgres connection string |
| `MERCHANT_VPA` / `MERCHANT_NAME` | Your actual settlement VPA and display name, as registered with your acquiring bank/PSP |
| `WEBHOOK_SECRET` | Issued by your PSP (Razorpay/Cashfree/PayU/bank) for HMAC signature verification — **never hardcode or commit this** |

## API Reference

### `POST /api/create-upi-payment`
Headers: `Idempotency-Key: <unique-per-attempt-string>` (required)

```json
{ "amount": 499.00, "order_id": "ORDER_1234", "customer_upi": "buyer@okaxis", "note": "Order #1234" }
```

Returns the `upi://pay?...` deep link plus a QR as both a PNG data URL
and inline SVG. Safe to retry with the same `Idempotency-Key` — you'll
get back the original transaction instead of a duplicate.

### `POST /api/upi-webhook`
Server-to-server callback from your PSP/bank. **This is the piece you
must adapt per-integration** — `routes/webhook.js`'s
`extractWebhookFields()` assumes generic field names
(`order_id`/`status`/`rrn`); map it to your actual provider's payload
shape. The signature verification scheme (HMAC-SHA256 over
`timestamp.rawBody`, in `middleware/verifyWebhook.js`) also assumes a
shared-secret HMAC provider — swapped out for RSA/ECDSA verification
if your partner signs asymmetrically (see the commented block at the
bottom of that file).

Use `scripts/testWebhookSign.js` to generate a validly-signed local
test request without a live PSP connection.

### `GET /api/payment-status/:order_id`
Polling endpoint. Also mirrored over WebSocket at
`ws://host/ws?order_id=ORDER_1234` for push-based updates the instant
a webhook settles the transaction — see `utils/wsHub.js`.

## Security notes — read before going to production

- **This code has not been reviewed by your PSP's integration team or
  a security auditor.** Treat it as a solid architectural starting
  point, not a drop-in certified integration. Confirm the exact
  webhook payload shape, signature scheme, and retry semantics with
  your specific PSP/bank's documentation before launch.
- No UPI PINs, OTPs, or bank credentials are ever collected, stored,
  or transmitted by this service — by design, UPI collect/intent
  flows never expose those to the merchant side at all.
- `WEBHOOK_SECRET` must be stored in a secrets manager (AWS Secrets
  Manager, HashiCorp Vault, etc.) in production, not a plain `.env`
  file on disk.
- The in-memory WebSocket hub (`utils/wsHub.js`) only works for a
  single server instance. If you scale horizontally, replace the
  `Map`-based subscriber registry with Redis pub/sub so a webhook
  landing on one instance can notify a client connected to another.
- Rate limits in `middleware/rateLimiters.js` are per-process
  in-memory (via `express-rate-limit`'s default store). For multiple
  instances behind a load balancer, back it with a shared store
  (Redis) so limits apply cluster-wide, not per-instance.
- Add TLS termination (via your reverse proxy/load balancer) — this
  app assumes it sits behind HTTPS, it does not terminate TLS itself.
- Consider adding request logging/APM (e.g. Sentry, Datadog) for
  production visibility into failed settlements and webhook signature
  rejections, which often indicate either an integration bug or an
  active attack attempt.

## Project structure

```
server.js                    Express app wiring, WebSocket init, background jobs
routes/
  createPayment.js            POST /api/create-upi-payment
  webhook.js                  POST /api/upi-webhook
  paymentStatus.js             GET /api/payment-status/:order_id
middleware/
  verifyWebhook.js            HMAC signature + timestamp replay protection
  rateLimiters.js              Per-endpoint rate limits
  validators.js                Input validation (express-validator)
utils/
  upiString.js                  NPCI-compliant upi://pay string builder
  qrGenerator.js                 QR generation (PNG data URL + SVG)
  wsHub.js                       WebSocket pub/sub for real-time status push
  logger.js                       Structured logging (winston)
db/
  schema.sql                     Table definitions + constraints
  migrate.js                     Migration runner (npm run migrate)
  pool.js                         Shared pg Pool
  transactionRepo.js              Atomic status-transition data access layer
scripts/
  testWebhookSign.js              Generates a valid signed test webhook locally
```
