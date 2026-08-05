const winston = require('winston');

/**
 * Central structured logger. Never log full UPI strings, VPAs of
 * customers, or raw webhook secrets — only order_id/status/RRN level
 * detail, which is safe for audit trails.
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'upi-payment-gateway' },
  transports: [new winston.transports.Console()],
});

module.exports = logger;
