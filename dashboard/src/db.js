const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let dbInstance = null;

function getDb() {
  if (dbInstance) return dbInstance;
  const activeDbPath = process.env.SOVPIN_DB_PATH || config.dbPath;
  const dir = path.dirname(activeDbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(activeDbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      i_address TEXT PRIMARY KEY,
      friendly_name TEXT NOT NULL,
      primary_address TEXT,
      plan_id TEXT NOT NULL DEFAULT 'builder',
      uk_vat_registered INTEGER NOT NULL DEFAULT 0,
      uk_company_name TEXT,
      uk_vat_number TEXT,
      billing_country TEXT NOT NULL DEFAULT 'GB',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_challenges (
      challenge_id TEXT PRIMARY KEY,
      identity_input TEXT NOT NULL,
      i_address TEXT NOT NULL,
      friendly_name TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      i_address TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (i_address) REFERENCES tenants(i_address) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      key_id TEXT PRIMARY KEY,
      i_address TEXT NOT NULL,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL DEFAULT 'pin:read,pin:write,vdxf:build',
      revoked INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (i_address) REFERENCES tenants(i_address) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pins (
      request_id TEXT PRIMARY KEY,
      i_address TEXT NOT NULL,
      cid TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256_hex TEXT NOT NULL,
      vdxf_uri TEXT NOT NULL DEFAULT 'sovpin::storage.pin.descriptor',
      vdxf_id TEXT,
      encrypted_zs_hint TEXT,
      meta_json TEXT NOT NULL DEFAULT '{}',
      sha256_verified INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pinned',
      created_at TEXT NOT NULL,
      unpinned_at TEXT,
      FOREIGN KEY (i_address) REFERENCES tenants(i_address) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pins_tenant_status ON pins(i_address, status);
    CREATE INDEX IF NOT EXISTS idx_pins_cid_status ON pins(cid, status);

    CREATE TABLE IF NOT EXISTS cmm_watchers (
      watcher_id TEXT PRIMARY KEY,
      i_address TEXT NOT NULL,
      target_identity TEXT NOT NULL,
      target_i_address TEXT NOT NULL,
      vdxf_uri TEXT NOT NULL,
      vdxf_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      pins_discovered INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT,
      last_result_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (i_address) REFERENCES tenants(i_address) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS invoices (
      invoice_id TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      i_address TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      payment_rail TEXT NOT NULL, -- 'veruspay' | 'stripe_gbp'
      subtotal_gbp_pence INTEGER NOT NULL,
      vat_rate REAL NOT NULL,
      vat_gbp_pence INTEGER NOT NULL,
      total_gbp_pence INTEGER NOT NULL,
      vrsc_spot_gbp REAL NOT NULL,
      amount_vrsc REAL NOT NULL,
      receiving_identity TEXT NOT NULL,
      veruspay_memo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'paid'
      txid TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (i_address) REFERENCES tenants(i_address) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blocked_cids (
      cid TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      legislation TEXT NOT NULL DEFAULT 'UK Online Safety Act 2023 / Copyright Designs and Patents Act 1988',
      reporter_identity TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_consent_sessions (
      challenge_id TEXT PRIMARY KEY,
      poll_token TEXT NOT NULL,
      requested_verus_id TEXT,
      signing_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'verified' | 'expired'
      user_i_address TEXT,
      user_friendly_name TEXT,
      session_token TEXT,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_lc_status_expires ON login_consent_sessions(status, expires_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      log_id TEXT PRIMARY KEY,
      i_address TEXT,
      actor_type TEXT NOT NULL DEFAULT 'tenant',
      action TEXT NOT NULL,
      target_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_logs(i_address, created_at DESC);

    CREATE TABLE IF NOT EXISTS chunked_uploads (
      upload_id TEXT PRIMARY KEY,
      i_address TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      total_size_bytes INTEGER,
      vdxf_uri TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}',
      received_parts_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'open',
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      webhook_id TEXT PRIMARY KEY,
      i_address TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT 'pin.created,pin.deleted',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (i_address) REFERENCES tenants(i_address) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      i_address TEXT NOT NULL,
      event TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      response_status INTEGER,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (webhook_id) REFERENCES webhooks(webhook_id) ON DELETE CASCADE
    );
  `);

  const pinColumns = db.prepare('PRAGMA table_info(pins)').all();
  if (!pinColumns.some((column) => column.name === 'sha256_verified')) {
    db.exec('ALTER TABLE pins ADD COLUMN sha256_verified INTEGER NOT NULL DEFAULT 0');
  }
  if (!pinColumns.some((column) => column.name === 'receipt_json')) {
    db.exec('ALTER TABLE pins ADD COLUMN receipt_json TEXT');
  }

  dbInstance = db;
  return db;
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function upsertTenant({ iAddress, friendlyName, primaryAddress }) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM tenants WHERE i_address = ?').get(iAddress);
  if (existing) {
    db.prepare(
      'UPDATE tenants SET friendly_name = ?, primary_address = ?, updated_at = ? WHERE i_address = ?'
    ).run(friendlyName, primaryAddress || existing.primary_address, now, iAddress);
    return db.prepare('SELECT * FROM tenants WHERE i_address = ?').get(iAddress);
  }
  db.prepare(
    `INSERT INTO tenants (i_address, friendly_name, primary_address, plan_id, created_at, updated_at)
     VALUES (?, ?, ?, 'builder', ?, ?)`
  ).run(iAddress, friendlyName, primaryAddress || null, now, now);
  return db.prepare('SELECT * FROM tenants WHERE i_address = ?').get(iAddress);
}

function getTenantUsage(iAddress) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS pin_count, COALESCE(SUM(max_size), 0) AS used_bytes
       FROM (
         SELECT cid, MAX(size_bytes) AS max_size
         FROM pins
         WHERE i_address = ? AND status = 'pinned'
         GROUP BY cid
       )`
    )
    .get(iAddress);
  const keyRow = db
    .prepare(`SELECT COUNT(*) AS key_count FROM api_keys WHERE i_address = ? AND revoked = 0`)
    .get(iAddress);
  const watcherRow = db
    .prepare(`SELECT COUNT(*) AS watcher_count FROM cmm_watchers WHERE i_address = ? AND status = 'active'`)
    .get(iAddress);

  return {
    pinCount: Number(row?.pin_count || 0),
    usedBytes: Number(row?.used_bytes || 0),
    activeApiKeys: Number(keyRow?.key_count || 0),
    activeWatchers: Number(watcherRow?.watcher_count || 0),
  };
}

function upsertActivePinRecord({
  iAddress,
  cid,
  name,
  mimeType = 'application/octet-stream',
  sizeBytes = 0,
  sha256Hex = '',
  vdxfUri = '',
  vdxfId = null,
  meta = {},
  sha256Verified = 0,
}) {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM pins WHERE i_address = ? AND cid = ? AND status = 'pinned' ORDER BY created_at DESC LIMIT 1`
    )
    .get(iAddress, cid);

  if (existing) {
    db.prepare(
      `UPDATE pins
       SET name = ?, mime_type = ?, size_bytes = ?, sha256_hex = ?, vdxf_uri = ?, vdxf_id = ?, meta_json = ?, sha256_verified = ?
       WHERE request_id = ?`
    ).run(
      name || existing.name,
      mimeType || existing.mime_type,
      sizeBytes || existing.size_bytes,
      sha256Verified ? sha256Hex : existing.sha256_hex,
      vdxfUri !== undefined ? vdxfUri : existing.vdxf_uri,
      vdxfId !== undefined ? vdxfId : existing.vdxf_id,
      JSON.stringify(meta || {}),
      sha256Verified ? 1 : existing.sha256_verified,
      existing.request_id
    );
    return db.prepare('SELECT * FROM pins WHERE request_id = ?').get(existing.request_id);
  }

  const requestId = `pin_${crypto.randomBytes(10).toString('hex')}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pins (request_id, i_address, cid, name, mime_type, size_bytes, sha256_hex, vdxf_uri, vdxf_id, meta_json, sha256_verified, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pinned', ?)`
  ).run(
    requestId,
    iAddress,
    cid,
    name,
    mimeType,
    sizeBytes,
    sha256Hex,
    vdxfUri || '',
    vdxfId,
    JSON.stringify(meta || {}),
    sha256Verified ? 1 : 0,
    now
  );
  return db.prepare('SELECT * FROM pins WHERE request_id = ?').get(requestId);
}

function countActivePinReferences(cid) {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS ref_count FROM pins WHERE cid = ? AND status = 'pinned'`)
    .get(cid);
  let refCount = Number(row?.ref_count || 0);

  // Also count active CMM watchers whose last_result_json discovered this CID
  const watchers = db
    .prepare(`SELECT last_result_json FROM cmm_watchers WHERE status = 'active'`)
    .all();
  for (const w of watchers) {
    try {
      const parsed = JSON.parse(w.last_result_json || '{}');
      if (Array.isArray(parsed.discoveredCids) && parsed.discoveredCids.includes(cid)) {
        refCount++;
      }
    } catch {
      // ignore malformed json
    }
  }
  return refCount;
}

function writeAuditLog({
  iAddress = null,
  actorType = 'tenant',
  action,
  targetId = null,
  details = {},
  ipAddress = null,
}) {
  try {
    const db = getDb();
    const logId = `aud_${crypto.randomBytes(10).toString('hex')}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO audit_logs (log_id, i_address, actor_type, action, target_id, details_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      logId,
      iAddress,
      actorType,
      String(action),
      targetId ? String(targetId) : null,
      JSON.stringify(details || {}),
      ipAddress ? String(ipAddress) : null,
      now
    );
    return logId;
  } catch {
    return null;
  }
}

function getSystemMetricsCounts() {
  const db = getDb();
  const tenants = db.prepare('SELECT COUNT(*) AS count FROM tenants').get();
  const activePins = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total_bytes
       FROM pins WHERE status = 'pinned'`
    )
    .get();
  const unpinnedPins = db
    .prepare(`SELECT COUNT(*) AS count FROM pins WHERE status = 'unpinned'`)
    .get();
  const blockedPins = db
    .prepare(`SELECT COUNT(*) AS count FROM blocked_cids`)
    .get();
  const activeKeys = db
    .prepare(`SELECT COUNT(*) AS count FROM api_keys WHERE revoked = 0`)
    .get();
  const activeWatchers = db
    .prepare(`SELECT COUNT(*) AS count FROM cmm_watchers WHERE status = 'active'`)
    .get();

  return {
    tenantsTotal: Number(tenants?.count || 0),
    pinsActiveTotal: Number(activePins?.count || 0),
    pinsBytesTotal: Number(activePins?.total_bytes || 0),
    pinsUnpinnedTotal: Number(unpinnedPins?.count || 0),
    blockedCidsTotal: Number(blockedPins?.count || 0),
    apiKeysActiveTotal: Number(activeKeys?.count || 0),
    watchersActiveTotal: Number(activeWatchers?.count || 0),
  };
}

module.exports = {
  getDb,
  hashToken,
  upsertTenant,
  getTenantUsage,
  upsertActivePinRecord,
  countActivePinReferences,
  writeAuditLog,
  getSystemMetricsCounts,
};
