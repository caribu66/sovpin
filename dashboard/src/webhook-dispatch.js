const crypto = require('node:crypto');
const { getDb } = require('./db');

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 5000, 15000];
const DELIVERY_TIMEOUT_MS = 10000;

/**
 * Dispatch a webhook event to all active webhooks registered by a tenant
 * that are subscribed to the given event type.
 *
 * Non-blocking: fires delivery attempts in the background with exponential backoff.
 * Each delivery is recorded in `webhook_deliveries` for audit/replay.
 */
function dispatchWebhook(iAddress, event, data) {
  if (!iAddress || !event) return;

  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  let webhooks;
  try {
    webhooks = db
      .prepare(
        `SELECT webhook_id, url, secret, events FROM webhooks WHERE i_address = ? AND active = 1`
      )
      .all(iAddress);
  } catch {
    return;
  }

  const subscribed = webhooks.filter((wh) => {
    const events = String(wh.events || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    return events.some((pattern) => {
      if (pattern === '*' || pattern === event) return true;
      // Support wildcard patterns like "watcher.*" or "pin.*"
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        return event.startsWith(prefix + '.');
      }
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return event.startsWith(prefix);
      }
      return false;
    });
  });

  if (subscribed.length === 0) return;

  const deliveryId = `whd_${crypto.randomBytes(10).toString('hex')}`;
  const now = new Date().toISOString();
  const payload = {
    id: `evt_${crypto.randomBytes(12).toString('hex')}`,
    type: event,
    timestamp: now,
    data: {
      ...data,
      tenant_i_address: iAddress,
    },
  };
  const payloadJson = JSON.stringify(payload);

  for (const wh of subscribed) {
    const perDeliveryId = `whd_${crypto.randomBytes(10).toString('hex')}`;
    try {
      db.prepare(
        `INSERT INTO webhook_deliveries (delivery_id, webhook_id, i_address, event, payload_json, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`
      ).run(perDeliveryId, wh.webhook_id, iAddress, event, payloadJson, now);
    } catch {
      continue;
    }

    // Fire-and-forget delivery with retries
    attemptDelivery(perDeliveryId, wh, payloadJson, 0).catch(() => {});
  }
}

function isPublicWebhookUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' ||
      host === '169.254.169.254' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  if (/^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|169\\.254\\.|127\\.)/.test(host)) return false;
  return true;
}

async function attemptDelivery(deliveryId, webhook, payloadJson, attemptIndex) {
  if (!isPublicWebhookUrl(webhook.url)) return;
  const db = getDb();
  const hmac = crypto.createHmac('sha256', webhook.secret).update(payloadJson, 'utf8').digest('hex');
  const now = new Date().toISOString();

  let responseStatus = null;
  let success = false;

  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SovPin-Signature': `sha256=${hmac}`,
        'X-SovPin-Event': JSON.parse(payloadJson).type,
        'X-SovPin-Delivery': deliveryId,
        'User-Agent': 'SovPin-Webhook/1.0',
      },
      body: payloadJson,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    responseStatus = res.status;
    success = res.ok;
  } catch {
    responseStatus = null;
    success = false;
  }

  const status = success ? 'delivered' : attemptIndex + 1 >= MAX_RETRIES ? 'failed' : 'pending';
  try {
    db.prepare(
      `UPDATE webhook_deliveries
       SET status = ?, attempts = ?, response_status = ?, last_attempt_at = ?
       WHERE delivery_id = ?`
    ).run(status, attemptIndex + 1, responseStatus, now, deliveryId);
  } catch {}

  if (!success && attemptIndex + 1 < MAX_RETRIES) {
    const delay = RETRY_DELAYS_MS[attemptIndex] || 15000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return attemptDelivery(deliveryId, webhook, payloadJson, attemptIndex + 1);
  }
}

module.exports = { dispatchWebhook };