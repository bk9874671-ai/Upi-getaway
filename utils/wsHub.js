const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');

/**
 * Lightweight pub/sub over WebSocket, keyed by order_id, so a frontend
 * can open ws://host/ws?order_id=XYZ and receive a push the instant
 * the webhook settles that transaction — no polling required.
 *
 * For a multi-instance deployment behind a load balancer, replace the
 * in-memory `subscribers` map with a Redis pub/sub channel so a
 * webhook landing on instance A can notify a client connected to
 * instance B.
 */
const subscribersByOrderId = new Map(); // orderId -> Set<ws>

function initWsHub(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const orderId = url.searchParams.get('order_id');

    if (!orderId) {
      ws.close(4000, 'order_id query param required');
      return;
    }

    if (!subscribersByOrderId.has(orderId)) {
      subscribersByOrderId.set(orderId, new Set());
    }
    subscribersByOrderId.get(orderId).add(ws);

    ws.on('close', () => {
      const set = subscribersByOrderId.get(orderId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) subscribersByOrderId.delete(orderId);
      }
    });

    ws.on('error', (err) => {
      logger.warn('WebSocket client error', { orderId, error: err.message });
    });
  });

  logger.info('WebSocket hub initialized on path /ws');
  return wss;
}

/**
 * Call this after a transaction settles (from the webhook handler) to
 * push the new status to any subscribed client in real time.
 */
function broadcastStatus(orderId, payload) {
  const set = subscribersByOrderId.get(orderId);
  if (!set || set.size === 0) return;

  const message = JSON.stringify({ type: 'payment_status', order_id: orderId, ...payload });
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

module.exports = { initWsHub, broadcastStatus };
