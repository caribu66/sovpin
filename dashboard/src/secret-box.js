// At-rest encryption for outbound webhook HMAC secrets.
// HMAC signing needs the raw secret at delivery time, so hashing (as with
// API keys) is not an option. Secrets are sealed with AES-256-GCM under a
// key derived via HKDF-SHA256 from SOVPIN_INTERNAL_SECRET ('webhook' purpose
// string), stored as `enc1:<b64 nonce>:<b64 ciphertext+tag>`. Legacy
// plaintext `whsec_...` rows are still accepted and transparently re-sealed
// on use. Rotating SOVPIN_INTERNAL_SECRET invalidates sealed secrets (fail
// closed); affected tenants must re-register their webhooks.
const crypto = require('node:crypto');

const ENC_PREFIX = 'enc1:';
const LEGACY_PREFIX = 'whsec_';

function dataKey() {
  const master = process.env.SOVPIN_INTERNAL_SECRET || '';
  if (!master) throw new Error('SOVPIN_INTERNAL_SECRET is required for webhook secret storage');
  // Non-empty salt + distinct info context for key separation (best practice).
  return crypto.hkdfSync(
    'sha256',
    master,
    Buffer.from('sovpin-hkdf-salt-v1', 'utf8'),
    Buffer.from('sovpin/webhook-secret/data-key/v1', 'utf8'),
    32
  );
}

function sealSecret(plaintext) {
  const key = dataKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${nonce.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`;
}

function openSecret(stored) {
  const value = String(stored || '');
  if (!value.startsWith(ENC_PREFIX)) {
    // Legacy plaintext row: usable, caller should re-seal it.
    if (!value.startsWith(LEGACY_PREFIX) || value.length < 16) {
      throw new Error('Unrecognized webhook secret format');
    }
    return { secret: value, migrated: false };
  }
  const key = dataKey();
  const rest = value.slice(ENC_PREFIX.length).split(':');
  if (rest.length !== 2) throw new Error('Malformed sealed webhook secret');
  const nonce = Buffer.from(rest[0], 'base64');
  const blob = Buffer.from(rest[1], 'base64');
  if (nonce.length !== 12 || blob.length < 17) throw new Error('Malformed sealed webhook secret');
  const ct = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  if (!pt.startsWith(LEGACY_PREFIX)) throw new Error('Webhook secret failed integrity check');
  return { secret: pt, migrated: true };
}

function needsMigration(stored) {
  return String(stored || '').startsWith(LEGACY_PREFIX);
}

module.exports = { sealSecret, openSecret, needsMigration, ENC_PREFIX };
