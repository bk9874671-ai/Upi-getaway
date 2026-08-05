require('dotenv').config();
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const logger = require('./utils/logger');
const { initWsHub } = require('./utils/wsHub');
const transactionRepo = require('./db/transactionRepo');

const createPaymentRoute = require('./routes/createPayment');
const webhookRoute = require('./routes/webhook');
const paymentStatusRoute = require('./routes/paymentStatus');

const REQUIRED_ENV_VARS = ['DATABASE_URL', 'MERCHANT_VPA', 'MERCHANT_NAME', 'WEBHOOK_SECRET'];
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    logger.error(`Missing required environment variable: ${key}. Refusing to start.`);
    process.exit(1);
  }
}

const app = express();

// --- Security headers -------------------------------------------------------
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));

// --- Raw body capture (required for webhook signature verification) --------
// Must run BEFORE express.json() parses the body, and only the exact
// bytes the PSP signed should be hashed — capturing here on the
// `verify` hook of express.json guarantees we hash precisely what
// was received on the wire, not a re-serialized version.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// --- Routes ------------------------------------------------------------------
app.use('/api', createPaymentRoute);
app.use('/api', webhookRoute);
app.use('/api', paymentStatusRoute);

app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// --- Centralized error handler (catches anything routes didn't) ------------
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal_error' });
});

// --- Server + WebSocket hub ---------------------------------------------------
const server = http.createServer(app);
initWsHub(server);

// --- Background job: expire stale PENDING transactions ---------------------
// A QR that's been sitting unpaid past its validity window shouldn't
// stay PENDING forever — this keeps status queries and reconciliation
// reports honest. Runs every 5 minutes.
const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  transactionRepo.expireStaleTransactions().catch((err) => {
    logger.error('Expiry sweep failed', { error: err.message });
  });
}, EXPIRY_SWEEP_INTERVAL_MS);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  logger.info(`UPI payment gateway listening on port ${PORT}`);
});

// --- Graceful shutdown -------------------------------------------------------
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});

module.exports = app;
