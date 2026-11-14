const express = require('express');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const Busboy = require('busboy');
const { Transform, Readable } = require('node:stream');
const config = require('./config');
const {
  getDb,
  hashToken,
  upsertTenant,
  getTenantUsage,
  upsertActivePinRecord,
  countActivePinReferences,
  writeAuditLog,
} = require('./db');
const {
  getDaemonInfo,
  getIdentity,
  getIdentityContent,
  getVdxfId,
  verifySignature,
  signData,
  getTransaction,
} = require('./verus-rpc');
const { verusId, primitives } = require('./verusid-interface');
const {
  LoginConsentChallenge,
  RedirectUri,
  RequestedPermission,
  Subject,
  IDENTITY_VIEW,
  ID_ADDRESS_VDXF_KEY,
  LOGIN_CONSENT_WEBHOOK_VDXF_KEY,
  LoginConsentResponse,
} = primitives;
const {
  kuboAddBuffer,
  kuboPinAdd,
  kuboPinPrimary,
  kuboPinMany,
  replicateInBackground,
  kuboPinRm,
  kuboBlockStat,
  kuboListRecursivePins,
  kuboAddStream,
  kuboVerifyCid,
  kuboRepoGc,
  buildVdxfDescriptor,
} = require('./kubo-service');
const {
  extractDataDescriptorsFromCmm,
  extractUrlRefsFromCmm,
  extractCidsFromUrlRefs,
  buildNativeDataContentMultiMapEntry,
} = require('./verus-storage');

const { dispatchWebhook } = require('./webhook-dispatch');

const router = express.Router();

router.use(enforceGlobalRateLimit);
router.use('/auth', enforceAuthRateLimit);

let inFlightUploads = 0;
const tenantUploadBuckets = new Map();
const globalRateBuckets = new Map();
const authRateBuckets = new Map();

function pruneBuckets(map, windowMs, now) {
  for (const [key, arr] of map.entries()) {
    const filtered = arr.filter((ts) => now - ts < windowMs);
    if (filtered.length === 0) map.delete(key);
    else map.set(key, filtered);
  }
}

function enforceGlobalRateLimit(req, res, next) {
  const key = req.ip || 'anonymous';
  const now = Date.now();
  const windowMs = 60_000;
  if (Math.random() < 0.01) pruneBuckets(globalRateBuckets, windowMs, now);
  const existing = (globalRateBuckets.get(key) || []).filter((ts) => now - ts < windowMs);
  if (existing.length >= 300) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: { reason: 'RATE_LIMIT_EXCEEDED', details: 'Too many requests' } });
  }
  existing.push(now);
  globalRateBuckets.set(key, existing);
  return next();
}

function enforceAuthRateLimit(req, res, next) {
  const key = req.ip || 'anonymous';
  const now = Date.now();
  const windowMs = 60_000;
  const existing = (authRateBuckets.get(key) || []).filter((ts) => now - ts < windowMs);
  if (existing.length >= 20) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: { reason: 'RATE_LIMIT_EXCEEDED', details: 'Too many auth attempts' } });
  }
  existing.push(now);
  authRateBuckets.set(key, existing);
  return next();
}

function enforceUploadRateLimit(req, res, next) {
  const key = req.tenant?.i_address || req.ip || 'anonymous';
  const now = Date.now();
  const windowMs = 60_000;
  const maxPerMin = Number(config.uploadRateLimitPerMin || 60);
  const existing = (tenantUploadBuckets.get(key) || []).filter((ts) => now - ts < windowMs);
  if (existing.length >= maxPerMin) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: {
        reason: 'RATE_LIMIT_EXCEEDED',
        details: `Upload rate limit exceeded (${maxPerMin} requests/min)`,
      },
    });
  }
  existing.push(now);
  tenantUploadBuckets.set(key, existing);
  return next();
}

// ── Auth Middleware (Supports Session Token OR Scoped API Key svp_live_...) ──
function authenticate(requiredScope = null) {
  return (req, res, next) => {
    const authHeader = req.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const sessionHeader = req.get('x-sovpin-session') || '';
    const rawToken = bearer || sessionHeader;

    if (!rawToken) {
      return res.status(401).json({
        error: {
          reason: 'UNAUTHORIZED',
          details: 'Missing Authorization: Bearer <svp_live_... or session_token> header',
        },
      });
    }

    const db = getDb();

    // 1. Check API Key (svp_live_...)
    if (rawToken.startsWith('svp_live_')) {
      const tokenHash = hashToken(rawToken);
      const keyRow = db
        .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0')
        .get(tokenHash);
      if (!keyRow) {
        return res.status(401).json({
          error: { reason: 'INVALID_API_KEY', details: 'API key is invalid or revoked' },
        });
      }
      const scopes = (keyRow.scopes || '').split(',').map((s) => s.trim());
      const isAdminKey = config.adminIdentities.includes(keyRow.i_address);
      const wildcardOk = isAdminKey && scopes.includes('*');
      if (requiredScope && !scopes.includes(requiredScope) && !wildcardOk) {
        return res.status(403).json({
          error: {
            reason: 'INSUFFICIENT_SCOPE',
            details: `API key requires scope: ${requiredScope}`,
          },
        });
      }
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_id = ?').run(
        new Date().toISOString(),
        keyRow.key_id
      );
      const tenant = db
        .prepare('SELECT * FROM tenants WHERE i_address = ?')
        .get(keyRow.i_address);
      if (!tenant) {
        return res.status(401).json({
          error: { reason: 'TENANT_NOT_FOUND', details: 'Associated VerusID tenant not found' },
        });
      }
      req.tenant = tenant;
      req.authType = 'api_key';
      req.apiKey = keyRow;
      return next();
    }

    // 2. Check Session Token
    const nowMs = Date.now();
    const sessionRow = db
      .prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
      .get(hashToken(rawToken), nowMs);
    if (!sessionRow) {
      return res.status(401).json({
        error: { reason: 'SESSION_EXPIRED', details: 'Session token invalid or expired' },
      });
    }
    const tenant = db
      .prepare('SELECT * FROM tenants WHERE i_address = ?')
      .get(sessionRow.i_address);
    if (!tenant) {
      return res.status(401).json({
        error: { reason: 'TENANT_NOT_FOUND', details: 'VerusID tenant not found' },
      });
    }
    req.tenant = tenant;
    req.authType = 'session';
    req.sessionToken = rawToken;
    return next();
  };
}

function serializePinningServiceJob(pinRow) {
  let meta = {};
  try {
    meta = JSON.parse(pinRow.meta_json || '{}');
  } catch {
    meta = {};
  }
  let receipt = null;
  if (pinRow.receipt_json) {
    try {
      receipt = JSON.parse(pinRow.receipt_json);
    } catch {
      receipt = null;
    }
  }
  let identityName = pinRow.i_address;
  try {
    const db = getDb();
    const t = db.prepare('SELECT friendly_name FROM tenants WHERE i_address = ?').get(pinRow.i_address);
    if (t?.friendly_name) identityName = t.friendly_name;
  } catch {
    // fallback to i_address
  }
  const vdxf = pinRow.vdxf_id
    ? buildVdxfDescriptor({
        cid: pinRow.cid,
        sha256Hex: pinRow.sha256_verified ? pinRow.sha256_hex : null,
        vdxfUri: pinRow.vdxf_uri,
        vdxfId: pinRow.vdxf_id,
        identityName,
        label: typeof meta.label === 'string' ? meta.label : pinRow.name,
        mimeType: pinRow.mime_type,
        contentHashVerified: Boolean(pinRow.sha256_verified),
      })
    : null;
  const gatewayUrl = vdxf?.gatewayUrl || `${config.publicGatewayUrl}/ipfs/${pinRow.cid}`;

  return {
    requestid: pinRow.request_id,
    status: pinRow.status,
    created: pinRow.created_at,
    pin: {
      cid: pinRow.cid,
      name: pinRow.name,
      origins: [],
      meta,
    },
    delegates: [`/ip4/${config.tailscaleIp}/tcp/4001`],
    info: {
      size_bytes: pinRow.size_bytes,
      mime_type: pinRow.mime_type,
      sha256: pinRow.sha256_verified ? pinRow.sha256_hex : null,
      gateway_url: gatewayUrl,
      vdxf_uri: vdxf?.vdxfUri || null,
      vdxf_id: vdxf?.vdxfId || null,
    },
    verus_vdxf: vdxf,
    verus_receipt: receipt,
  };
}

async function createAndStorePinReceipt(pinRow) {
  try {
    const info = await getDaemonInfo().catch(() => null);
    const blockHeight = Number(info?.blocks || 0);
    const issuedAt = new Date().toISOString();
    const sha256 = pinRow.sha256_verified ? pinRow.sha256_hex : '';
    const message = [
      'SovPin Storage Attestation v1',
      `Chain: ${config.verusChain}`,
      `Block: ${blockHeight}`,
      `Tenant: ${pinRow.i_address}`,
      `RequestId: ${pinRow.request_id}`,
      `CID: ${pinRow.cid}`,
      `SHA256: ${sha256}`,
      `Bytes: ${pinRow.size_bytes}`,
      `Issued: ${issuedAt}`,
    ].join(' | ');

    let signature = null;
    let hash = null;
    try {
      const signed = await signData({
        address: config.sovpinSignerIAddress,
        message,
      });
      signature = signed?.signature || null;
      hash = signed?.hash || null;
    } catch {
      signature = null;
    }

    if (!signature && config.sovpinSignerWif) {
      const bitcoinMessage = require('bitcoinjs-message');
      const { networks } = require('@bitgo/utxo-lib');
      const { ECPair } = require('@bitgo/utxo-lib');
      const keyPair = ECPair.fromWIF(config.sovpinSignerWif, networks.verustest || networks.komodo);
      signature = bitcoinMessage
        .sign(message, keyPair.d.toBuffer(32), keyPair.compressed, '\x15Verus signed data:\n')
        .toString('base64');
    }

    if (!signature) return pinRow;

    const verifyCliCommand = `verus -chain=${config.verusChain} verifysignature '${JSON.stringify({
      address: config.sovpinSignerIdentity,
      message,
      signature,
      checklatest: true,
    })}'`;

    const receipt = {
      version: 1,
      signerIdentity: config.sovpinSignerIdentity,
      signerIAddress: config.sovpinSignerIAddress,
      chain: config.verusChain,
      blockHeight,
      tenantIAddress: pinRow.i_address,
      requestId: pinRow.request_id,
      cid: pinRow.cid,
      sha256: sha256 || null,
      sizeBytes: pinRow.size_bytes,
      issuedAt,
      message,
      signature,
      hash,
      verifyCliCommand,
    };

    const db = getDb();
    db.prepare('UPDATE pins SET receipt_json = ? WHERE request_id = ?').run(
      JSON.stringify(receipt),
      pinRow.request_id
    );
    return db.prepare('SELECT * FROM pins WHERE request_id = ?').get(pinRow.request_id);
  } catch {
    return pinRow;
  }
}

function createHttpError(status, reason, message) {
  const error = new Error(message);
  error.status = status;
  error.reason = reason;
  return error;
}

function streamMultipartFileToKubo(req, maxFileBytes) {
  return new Promise((resolve, reject) => {
    let parser;
    let fileSeen = false;
    let settled = false;
    let uploadPromise;
    const fields = {};
    const controller = new AbortController();
    const fail = (error) => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(error);
    };

    try {
      parser = Busboy({
        headers: req.headers,
        limits: { files: 1, fields: 4, parts: 5, fieldSize: 64 * 1024, fileSize: maxFileBytes },
      });
    } catch (error) {
      fail(createHttpError(400, 'INVALID_MULTIPART', error.message));
      return;
    }

    parser.on('file', (fieldName, file, fileInfo) => {
      if (fileSeen || fieldName !== 'file') {
        file.resume();
        fail(createHttpError(400, 'INVALID_FILE_FIELD', 'Send exactly one file using the multipart field named "file"'));
        return;
      }
      fileSeen = true;

      let bytesReceived = 0;
      let tooLarge = false;
      const quotaError = createHttpError(402, 'QUOTA_EXCEEDED', 'Upload exceeded the remaining storage quota');
      const contentHash = crypto.createHash('sha256');
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          bytesReceived += chunk.length;
          contentHash.update(chunk);
          callback(null, chunk);
        },
      });

      file.on('limit', () => {
        tooLarge = true;
        controller.abort(quotaError);
      });
      file.on('error', fail);
      meter.on('error', fail);

      const filename = String(fileInfo.filename || 'upload.bin').replace(/^.*[\\/]/, '');
      const mimeType = fileInfo.mimeType || 'application/octet-stream';
      uploadPromise = kuboAddStream(meter, filename, mimeType, controller.signal).then((added) => {
        if (tooLarge || file.truncated) {
          throw quotaError;
        }
        return {
          ...added,
          filename,
          mimeType,
          sizeBytes: bytesReceived,
          sha256Hex: contentHash.digest('hex'),
          fields,
        };
      }).catch((error) => {
        if (tooLarge) throw quotaError;
        throw error;
      });
      uploadPromise.catch(() => {});
      file.pipe(meter);
    });

    parser.on('field', (name, value, info) => {
      if (name !== 'meta') {
        fail(createHttpError(400, 'UNEXPECTED_FIELD', `Unsupported multipart field: ${name}`));
        return;
      }
      if (info?.valueTruncated) {
        fail(createHttpError(400, 'FIELD_TOO_LARGE', 'Multipart metadata exceeds the 64 KiB limit'));
        return;
      }
      fields[name] = value;
    });

    parser.on('filesLimit', () => fail(createHttpError(400, 'TOO_MANY_FILES', 'Only one file is allowed per upload')));
    parser.on('fieldsLimit', () => fail(createHttpError(400, 'TOO_MANY_FIELDS', 'Too many multipart fields')));
    parser.on('partsLimit', () => fail(createHttpError(400, 'TOO_MANY_PARTS', 'Too many multipart parts')));
    parser.on('error', fail);
    req.on('aborted', () => fail(createHttpError(400, 'UPLOAD_ABORTED', 'Upload client disconnected')));

    parser.on('finish', async () => {
      if (!fileSeen) {
        fail(createHttpError(400, 'MISSING_FILE', 'Include a file using the multipart field named "file"'));
        return;
      }
      try {
        const result = await uploadPromise;
        if (settled) return;
        settled = true;
        resolve(result);
      } catch (error) {
        fail(error);
      }
    });

    req.pipe(parser);
  });
}

// ── 1. Public Catalog: Plans, Verus Node Status & UK Compliance ──────────────
router.get('/public/info', async (req, res) => {
  let verusInfo = null;
  try {
    const info = await getDaemonInfo();
    verusInfo = {
      online: true,
      chain: info.name || config.verusChain,
      chainId: info.chainid,
      version: info.VRSCversion,
      blocks: info.blocks,
    };
  } catch (err) {
    verusInfo = {
      online: false,
      chain: config.verusChain,
      error: err.message,
    };
  }

  res.json({
    service: 'SovPin — Sovereign IPFS & VDXF Storage Engine for Verus Developers',
    ukCompany: config.ukCompany,
    gatewayUrl: config.publicGatewayUrl,
    maxSingleUploadBytes: config.maxSingleUploadBytes,
    gbpPerVrscRate: config.gbpPerVrscRate,
    receivingIdentity: config.sovpinReceivingIdentity,
    verusDaemon: verusInfo,
    plans: Object.values(config.PLANS),
  });
});

// ── 2. VerusID Authentication (Live Chain Lookup + Signature Verification) ───
router.post('/auth/challenge', async (req, res) => {
  try {
    const identityInput = String(req.body?.identity || '').trim();
    if (!identityInput) {
      return res.status(400).json({ error: 'Provide a VerusID (e.g. vreal@ or i-address)' });
    }

    const idInfo = await getIdentity(identityInput);
    const identityObj = idInfo?.identity;
    if (!identityObj || !identityObj.identityaddress) {
      return res.status(404).json({ error: `VerusID not found on ${config.verusChain}` });
    }
    if (idInfo.status && idInfo.status !== 'active') {
      return res.status(403).json({
        error: `VerusID '${identityInput}' is ${idInfo.status} (must be active on-chain)`,
      });
    }

    const iAddress = identityObj.identityaddress;
    const friendlyName =
      idInfo.fullyqualifiedname || `${identityObj.name}.${config.verusChain}@`;
    const challengeId = `ch_${crypto.randomBytes(12).toString('hex')}`;
    const nonce = crypto.randomBytes(16).toString('hex');
    const issuedAt = new Date().toISOString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    const message = [
      'SovPin Sovereign Developer Login',
      `Chain: ${config.verusChain}`,
      `Identity: ${friendlyName} (${iAddress})`,
      `Nonce: ${nonce}`,
      `Issued: ${issuedAt}`,
    ].join(' | ');

    const db = getDb();
    db.prepare(
      `INSERT INTO auth_challenges (challenge_id, identity_input, i_address, friendly_name, message, expires_at, used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(challengeId, identityInput, iAddress, friendlyName, message, expiresAt, issuedAt);

    const cliCommand = `verus -chain=${config.verusChain} signdata '${JSON.stringify({
      address: friendlyName,
      message,
    })}'`;

    const isProxiedPublicRequest = Boolean(
      req.get('cf-connecting-ip') || req.get('x-forwarded-for')
    );

    res.json({
      challengeId,
      iAddress,
      friendlyName,
      primaryAddress: (identityObj.primaryaddresses || [])[0] || null,
      blockHeight: idInfo.blockheight,
      message,
      expiresAt,
      cliCommand,
      canLocalSign:
        Boolean(idInfo.cansignfor) && (!isProxiedPublicRequest || config.allowPublicNodeSign),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to resolve VerusID on chain' });
  }
});

// Helper for developers whose wallet is connected to the local VRSCTEST node to sign challenge directly
router.post('/auth/sign-with-node', async (req, res) => {
  try {
    const isProxiedPublicRequest = Boolean(
      req.get('cf-connecting-ip') || req.get('x-forwarded-for')
    );
    if (isProxiedPublicRequest && !config.allowPublicNodeSign) {
      return res.status(403).json({
        error:
          'Direct node signing is restricted to local loopback (127.0.0.1). On the public web, sign via Verus Mobile QR or paste your `verus signdata` signature.',
      });
    }
    const { challengeId } = req.body || {};
    const db = getDb();
    const ch = db
      .prepare('SELECT * FROM auth_challenges WHERE challenge_id = ? AND used = 0')
      .get(String(challengeId || ''));
    if (!ch) {
      return res.status(404).json({ error: 'Challenge not found or already used' });
    }
    const signed = await signData({
      address: ch.i_address,
      message: ch.message,
    });
    if (!signed || !signed.signature) {
      return res.status(400).json({
        error: 'Connected daemon wallet does not hold signing keys for this VerusID. Sign via CLI or Verus Mobile.',
      });
    }
    res.json({
      challengeId: ch.challenge_id,
      signature: signed.signature,
      hash: signed.hash,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Node signing failed' });
  }
});

router.post('/auth/verify', async (req, res) => {
  try {
    const { challengeId, signature } = req.body || {};
    if (!challengeId || !signature) {
      return res.status(400).json({ error: 'challengeId and signature are required' });
    }

    const db = getDb();
    const ch = db
      .prepare('SELECT * FROM auth_challenges WHERE challenge_id = ?')
      .get(String(challengeId));
    if (!ch || ch.used) {
      return res.status(400).json({ error: 'Challenge invalid or already used' });
    }
    if (Date.now() > ch.expires_at) {
      return res.status(400).json({ error: 'Challenge expired' });
    }

    const verified = await verifySignature({
      address: ch.i_address,
      message: ch.message,
      signature: String(signature).trim(),
      checklatest: true,
    });

    const isVerified =
      verified === true ||
      verified?.signaturestatus === 'verified' ||
      (verified?.address === ch.i_address && Boolean(verified?.hash));

    if (!isVerified) {
      return res.status(401).json({
        error: 'Verus daemon verifysignature rejected signature for this VerusID',
      });
    }

    db.prepare('UPDATE auth_challenges SET used = 1 WHERE challenge_id = ?').run(ch.challenge_id);

    const idInfo = await getIdentity(ch.i_address);
    const primaryAddress = (idInfo?.identity?.primaryaddresses || [])[0] || null;

    const tenant = upsertTenant({
      iAddress: ch.i_address,
      friendlyName: ch.friendly_name,
      primaryAddress,
    });

    const sessionToken = `svps_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
    db.prepare(
      'INSERT INTO sessions (token, i_address, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).run(hashToken(sessionToken), tenant.i_address, expiresAt, new Date().toISOString());

    writeAuditLog({
      iAddress: tenant.i_address,
      actorType: 'session',
      action: 'auth.verify',
      targetId: ch.challenge_id,
      details: { friendlyName: tenant.friendly_name },
      ipAddress: req.ip,
    });

    res.json({
      sessionToken,
      expiresAt,
      tenant,
      usage: getTenantUsage(tenant.i_address),
      plan: config.PLANS[tenant.plan_id] || config.PLANS.builder,
    });
  } catch (err) {
    console.error('[auth] verification failed:', err.message);
    res.status(401).json({ error: 'Signature verification failed' });
  }
});

router.post('/auth/logout', authenticate(), (req, res) => {
  const db = getDb();
  if (req.sessionToken) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(req.sessionToken));
  }
  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'session',
    action: 'auth.logout',
    targetId: req.tenant.i_address,
    details: {},
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

// ── 2b. VerusID QR Login (LoginConsent protocol for Verus Mobile) ────────────
const LC_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

router.post('/auth/login-consent/challenge', async (req, res) => {
  try {
    const requestedVerusId = req.body?.verusId ? String(req.body.verusId).trim() : null;
    const { toBase58Check } = require('verus-typescript-primitives/dist/utils/address');
    const challengeId = toBase58Check(crypto.randomBytes(20), 102);
    const pollToken = crypto.randomBytes(24).toString('hex');
    const createdAtTimestamp = Math.floor(Date.now() / 1000) - 600; // time-skew tolerance
    const expiresAt = Date.now() + LC_SESSION_TTL_MS;

    const callbackUrl = new URL(`${config.sovpinCallbackHost}/v1/auth/login-consent/callback`);
    const redirectUriObj = new RedirectUri(
      callbackUrl.toString(),
      LOGIN_CONSENT_WEBHOOK_VDXF_KEY.vdxfid
    );
    const identityViewPermission = new RequestedPermission(IDENTITY_VIEW.vdxfid);

    // Resolve subject identity address if a specific VerusID is requested.
    let subject;
    if (requestedVerusId) {
      try {
        const idInfo = await getIdentity(requestedVerusId);
        const iAddr = idInfo?.identity?.identityaddress;
        if (typeof iAddr === 'string' && iAddr.startsWith('i')) {
          subject = [new Subject(iAddr, ID_ADDRESS_VDXF_KEY.vdxfid)];
        }
      } catch {
        // Omit subject constraint if resolution fails.
      }
    }

    const challenge = new LoginConsentChallenge({
      challenge_id: challengeId,
      requested_access: [identityViewPermission],
      redirect_uris: [redirectUriObj],
      created_at: createdAtTimestamp,
      ...(subject && { subject }),
    });

    const signingId = config.sovpinSignerIAddress;
    const requestObj = await verusId.createLoginConsentRequest(
      signingId,
      challenge,
      config.sovpinSignerWif
    );

    const deepLink = requestObj.toWalletDeeplinkUri();
    let qrCodeDataUrl = null;
    try {
      const QRCode = require('qrcode');
      qrCodeDataUrl = await QRCode.toDataURL(deepLink, { width: 320, margin: 2 });
    } catch (err) {
      // qrcode optional; deepLink still usable.
    }

    const db = getDb();
    db.prepare(
      `INSERT INTO login_consent_sessions (challenge_id, poll_token, requested_verus_id, signing_id, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      challengeId,
      pollToken,
      requestedVerusId,
      signingId,
      expiresAt,
      new Date().toISOString()
    );

    res.json({
      challengeId,
      pollToken,
      deepLink,
      qrCodeDataUrl,
      expiresAt,
      signingIdentity: config.sovpinSignerIdentity,
    });
  } catch (err) {
    res.status(500).json({
      error: { reason: 'CHALLENGE_FAILED', details: err.message || 'Failed to create login consent request' },
    });
  }
});

// Structural gate for the unauthenticated webhook body posted by Verus Mobile.
function isLoginConsentResponseBody(body) {
  if (typeof body !== 'object' || body === null) return false;
  if (!('system_id' in body) || typeof body.system_id !== 'string') return false;
  if (!('signing_id' in body) || typeof body.signing_id !== 'string') return false;
  return 'decision' in body && typeof body.decision === 'object' && body.decision !== null;
}

router.post('/auth/login-consent/callback', async (req, res) => {
  try {
    const body = req.body;
    if (!isLoginConsentResponseBody(body)) {
      return res.status(400).json({ error: 'Malformed login consent response' });
    }

    const response = new LoginConsentResponse(body);

    // Bind verification to current on-chain identity state.
    let currentIdentity = null;
    try {
      const idRes = await getIdentity(response.signing_id);
      currentIdentity = idRes?.result || idRes;
    } catch {
      currentIdentity = null;
    }
    if (!currentIdentity) {
      return res.status(400).json({ error: 'Could not resolve signing identity on chain' });
    }

    const isValid = await verusId.verifyLoginConsentResponse(
      response,
      currentIdentity,
      config.chainIAddress
    );
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const challengeId = response.decision?.request?.challenge?.challenge_id;
    if (!challengeId) {
      return res.status(400).json({ error: 'Missing challenge_id in response' });
    }

    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM login_consent_sessions WHERE challenge_id = ?')
      .get(challengeId);
    if (!existing) {
      return res.status(404).json({ error: 'Unknown challenge_id' });
    }
    if (existing.status === 'verified') {
      return res.json({ success: true });
    }
    if (Date.now() > existing.expires_at) {
      db.prepare(`UPDATE login_consent_sessions SET status = 'expired' WHERE challenge_id = ?`).run(challengeId);
      return res.status(410).json({ error: 'Challenge expired' });
    }

    // Resolve user identity.
    let iAddress = response.signing_id;
    let friendlyName = response.signing_id;
    try {
      const idInfo = await getIdentity(response.signing_id);
      const ident = idInfo?.identity || idInfo?.result?.identity;
      if (ident?.identityaddress) iAddress = ident.identityaddress;
      if (idInfo?.fullyqualifiedname) friendlyName = idInfo.fullyqualifiedname;
      else if (ident?.name) friendlyName = `${ident.name}.${config.verusChain}@`;
    } catch {
      // Fall back to signing_id.
    }

    const tenant = upsertTenant({
      iAddress,
      friendlyName,
      primaryAddress: null,
    });

    const sessionToken = `svps_${crypto.randomBytes(24).toString('hex')}`;
    const sessionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    db.prepare(
      'INSERT INTO sessions (token, i_address, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).run(hashToken(sessionToken), tenant.i_address, sessionExpiresAt, new Date().toISOString());

    db.prepare(
      `UPDATE login_consent_sessions
       SET status = 'verified', user_i_address = ?, user_friendly_name = ?, session_token = ?, resolved_at = ?
       WHERE challenge_id = ?`
    ).run(iAddress, friendlyName, sessionToken, new Date().toISOString(), challengeId);

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Authentication failed' });
  }
});

router.get('/auth/login-consent/poll', (req, res) => {
  const challengeId = String(req.query?.challengeId || '').trim();
  const pollToken = String(req.query?.pollToken || '').trim();
  if (!challengeId || !pollToken) {
    return res.status(400).json({ error: 'challengeId and pollToken are required' });
  }
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM login_consent_sessions WHERE challenge_id = ?')
    .get(challengeId);
  if (!row || row.poll_token !== pollToken) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (Date.now() > row.expires_at && row.status === 'pending') {
    db.prepare(`UPDATE login_consent_sessions SET status = 'expired' WHERE challenge_id = ?`).run(challengeId);
    row.status = 'expired';
  }
  if (row.status === 'verified') {
    return res.json({
      status: 'verified',
      sessionToken: row.session_token,
      userIAddress: row.user_i_address,
      userFriendlyName: row.user_friendly_name,
    });
  }
  res.json({ status: row.status });
});

// ── 3. Authenticated Tenant Profile & UK VAT Settings ────────────────────────
router.get('/account', authenticate(), (req, res) => {
  const tenant = req.tenant;
  const plan = config.PLANS[tenant.plan_id] || config.PLANS.builder;
  const usage = getTenantUsage(tenant.i_address);
  res.json({
    tenant,
    plan,
    usage,
    ukCompany: config.ukCompany,
  });
});

router.patch('/account/billing-profile', authenticate(), (req, res) => {
  const { ukCompanyName, ukVatNumber, billingCountry } = req.body || {};
  const db = getDb();
  const hasVat = Boolean(ukVatNumber && String(ukVatNumber).trim());
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tenants
     SET uk_company_name = ?, uk_vat_number = ?, uk_vat_registered = ?, billing_country = ?, updated_at = ?
     WHERE i_address = ?`
  ).run(
    ukCompanyName ? String(ukCompanyName).trim() : null,
    hasVat ? String(ukVatNumber).trim().toUpperCase() : null,
    hasVat ? 1 : 0,
    billingCountry ? String(billingCountry).trim().toUpperCase() : 'GB',
    now,
    req.tenant.i_address
  );
  const updated = db
    .prepare('SELECT * FROM tenants WHERE i_address = ?')
    .get(req.tenant.i_address);
  res.json({ tenant: updated });
});

// UK GDPR Right-to-Erasure / Tenant Offboarding: unpins unreferenced CIDs and deletes tenant data
router.delete('/account', authenticate(), async (req, res) => {
  const db = getDb();
  const iAddress = req.tenant.i_address;
  const friendlyName = req.tenant.friendly_name;
  const activePins = db
    .prepare(`SELECT DISTINCT cid FROM pins WHERE i_address = ? AND status = 'pinned'`)
    .all(iAddress);

  db.prepare(`UPDATE pins SET status = 'unpinned', unpinned_at = ? WHERE i_address = ? AND status = 'pinned'`).run(
    new Date().toISOString(),
    iAddress
  );

  let unpinnedFromKubo = 0;
  for (const row of activePins) {
    if (countActivePinReferences(row.cid) === 0) {
      const removed = await kuboPinRm(row.cid);
      if (removed) unpinnedFromKubo++;
    }
  }

  writeAuditLog({
    iAddress,
    actorType: req.authType || 'tenant',
    action: 'account.delete_gdpr',
    targetId: iAddress,
    details: { friendlyName, unpinnedFromKubo },
    ipAddress: req.ip,
  });

  db.prepare('DELETE FROM tenants WHERE i_address = ?').run(iAddress);
  res.json({
    ok: true,
    deletedTenant: iAddress,
    unpinnedFromKubo,
  });
});

// GET /v1/audit-logs — Tenant security & pin lifecycle audit trail
router.get('/audit-logs', authenticate(), (req, res) => {
  const db = getDb();
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = db
    .prepare(
      `SELECT log_id, i_address, actor_type, action, target_id, details_json, ip_address, created_at
       FROM audit_logs
       WHERE i_address = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(req.tenant.i_address, limit);

  res.json({
    count: rows.length,
    logs: rows.map((row) => {
      let details = {};
      try {
        details = JSON.parse(row.details_json || '{}');
      } catch {
        details = {};
      }
      return {
        logId: row.log_id,
        iAddress: row.i_address,
        actorType: row.actor_type,
        action: row.action,
        targetId: row.target_id,
        details,
        ipAddress: row.ip_address,
        createdAt: row.created_at,
      };
    }),
  });
});

// ── 4. Scoped Developer API Keys (svp_live_...) ──────────────────────────────
router.get('/keys', authenticate(), (req, res) => {
  const db = getDb();
  const keys = db
    .prepare(
      `SELECT key_id, name, key_prefix, scopes, revoked, last_used_at, created_at
       FROM api_keys
       WHERE i_address = ?
       ORDER BY created_at DESC`
    )
    .all(req.tenant.i_address);
  res.json({ keys });
});

router.post('/keys', authenticate(), (req, res) => {
  const db = getDb();
  const plan = config.PLANS[req.tenant.plan_id] || config.PLANS.builder;
  const usage = getTenantUsage(req.tenant.i_address);
  if (usage.activeApiKeys >= plan.maxApiKeys) {
    return res.status(403).json({
      error: `Plan '${plan.name}' allows up to ${plan.maxApiKeys} active API keys. Upgrade your plan for more.`,
    });
  }

  const name = String(req.body?.name || 'Default Verus App Key').trim();
  const ALLOWED_SCOPES = new Set(['pin:read', 'pin:write', 'vdxf:build', 'webhook:manage', 'watcher:manage']);
  const requestedScopes = String(req.body?.scopes || 'pin:read,pin:write,vdxf:build')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of requestedScopes) {
    if (!ALLOWED_SCOPES.has(s)) {
      return res.status(400).json({ error: `Unknown or disallowed scope: ${s}` });
    }
  }
  const scopes = [...new Set(requestedScopes)].join(',');
  const rawSecret = `svp_live_${crypto.randomBytes(20).toString('hex')}`;
  const keyPrefix = `${rawSecret.slice(0, 14)}...`;
  const keyHash = hashToken(rawSecret);
  const keyId = `key_${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO api_keys (key_id, i_address, name, key_prefix, key_hash, scopes, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(keyId, req.tenant.i_address, name, keyPrefix, keyHash, scopes, now);

  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'session',
    action: 'key.create',
    targetId: keyId,
    details: { name, keyPrefix, scopes },
    ipAddress: req.ip,
  });

  res.status(201).json({
    keyId,
    name,
    apiKey: rawSecret, // Shown once!
    keyPrefix,
    scopes,
    createdAt: now,
  });
});

router.delete('/keys/cleanup-revoked', authenticate(), (req, res) => {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM api_keys WHERE i_address = ? AND revoked = 1')
    .run(req.tenant.i_address);
  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'tenant',
    action: 'key.cleanup_revoked',
    targetId: null,
    details: { deletedCount: result.changes },
    ipAddress: req.ip,
  });
  res.json({ ok: true, deletedCount: result.changes });
});

router.delete('/keys/:keyId', authenticate(), (req, res) => {
  const db = getDb();
  db.prepare('UPDATE api_keys SET revoked = 1 WHERE key_id = ? AND i_address = ?').run(
    req.params.keyId,
    req.tenant.i_address
  );
  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'session',
    action: 'key.revoke',
    targetId: req.params.keyId,
    details: {},
    ipAddress: req.ip,
  });
  res.json({ ok: true, keyId: req.params.keyId });
});

// ── 4b. Outbound Webhooks (Pin & Chain Events) ─────────────────────────────

// ── 4b0. Webhook Event Catalog (for UI selection) ──────────────────────────
const WEBHOOK_EVENT_CATALOG = [
  { event: 'pin.created', description: 'Fired when a new object is pinned (upload, stream, chunked, or pin-by-CID)' },
  { event: 'pin.deleted', description: 'Fired when a pin is marked unpinned for the tenant' },
  { event: 'watcher.created', description: 'Fired when a new CMM auto-pin watcher is registered' },
  { event: 'watcher.synced', description: 'Fired when a watcher completes an on-chain CMM sync' },
  { event: 'watcher.repaired', description: 'Fired when a watcher repairs unpinned CIDs on Kubo' },
];

router.get('/webhook-events', authenticate(), (req, res) => {
  res.json({ events: WEBHOOK_EVENT_CATALOG });
});

router.get('/webhooks', authenticate(), (req, res) => {
  const db = getDb();
  const hooks = db
    .prepare(
      `SELECT webhook_id, url, events, active, created_at FROM webhooks WHERE i_address = ? ORDER BY created_at DESC`
    )
    .all(req.tenant.i_address);
  res.json({ webhooks: hooks });
});

router.post('/webhooks', authenticate(), (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'A valid HTTP(S) webhook URL is required' });
  }
  // SSRF guard: block loopback, private, link-local, and metadata endpoints.
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid webhook URL' });
  }
  const host = parsedUrl.hostname.toLowerCase();
  const blockedHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254', 'metadata.google.internal']);
  if (blockedHosts.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return res.status(400).json({ error: 'Webhook URL must point to a public host' });
  }
  // Block RFC1918 / link-local / loopback IP literals.
  if (/^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|169\\.254\\.|127\\.)/.test(host)) {
    return res.status(400).json({ error: 'Webhook URL must point to a public host' });
  }
  const events = String(req.body?.events || 'pin.created,pin.deleted').trim();
  const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  const webhookId = `wh_${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO webhooks (webhook_id, i_address, url, secret, events, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(webhookId, req.tenant.i_address, url, secret, events, now);

  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'tenant',
    action: 'webhook.create',
    targetId: webhookId,
    details: { url, events },
    ipAddress: req.ip,
  });

  res.status(201).json({
    webhookId,
    url,
    events,
    secret, // Shown once!
    createdAt: now,
  });
});

router.delete('/webhooks/:webhookId', authenticate(), (req, res) => {
  const db = getDb();
  const wh = db
    .prepare('SELECT * FROM webhooks WHERE webhook_id = ? AND i_address = ?')
    .get(req.params.webhookId, req.tenant.i_address);
  if (!wh) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  db.prepare('DELETE FROM webhooks WHERE webhook_id = ? AND i_address = ?').run(
    wh.webhook_id,
    req.tenant.i_address
  );
  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'tenant',
    action: 'webhook.delete',
    targetId: wh.webhook_id,
    details: { url: wh.url },
    ipAddress: req.ip,
  });
  res.json({ ok: true, webhookId: wh.webhook_id });
});

router.get('/webhooks/:webhookId/deliveries', authenticate(), (req, res) => {
  const db = getDb();
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = db
    .prepare(
      `SELECT delivery_id, webhook_id, event, status, attempts, response_status, last_attempt_at, created_at
       FROM webhook_deliveries WHERE webhook_id = ? AND i_address = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(req.params.webhookId, req.tenant.i_address, limit);
  res.json({ deliveries: rows });
});

// ── 5. Standard IPFS Pinning Service API + Verus VDXF Descriptor Engine ──────

// GET /v1/pins (IPFS Pinning Service Spec compliant)
router.get('/pins', authenticate('pin:read'), (req, res) => {
  const db = getDb();
  const statusFilter = req.query.status ? String(req.query.status) : 'pinned';
  const cidFilter = req.query.cid ? String(req.query.cid).trim() : null;

  let rows;
  if (cidFilter) {
    rows = db
      .prepare(
        'SELECT * FROM pins WHERE i_address = ? AND status = ? AND cid = ? ORDER BY created_at DESC'
      )
      .all(req.tenant.i_address, statusFilter, cidFilter);
  } else {
    rows = db
      .prepare('SELECT * FROM pins WHERE i_address = ? AND status = ? ORDER BY created_at DESC')
      .all(req.tenant.i_address, statusFilter);
  }

  res.json({
    count: rows.length,
    results: rows.map(serializePinningServiceJob),
  });
});

// POST /v1/pins — Pin an existing CID and prepare its Verus URLRef CMM value
router.post('/pins', authenticate('pin:write'), async (req, res) => {
  try {
    const cid = String(req.body?.cid || '').trim();
    const name = String(req.body?.name || cid).trim();
    const vdxfUri = String(req.body?.vdxfUri || 'sovpin::storage.pin.descriptor').trim();
    const meta = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : {};

    if (!cid || !/^[A-Za-z0-9]+$/.test(cid)) {
      return res.status(400).json({
        error: { reason: 'INVALID_CID', details: 'Provide a valid alphanumeric IPFS CID' },
      });
    }

    const db = getDb();
    const blocked = db.prepare('SELECT * FROM blocked_cids WHERE cid = ?').get(cid);
    if (blocked) {
      return res.status(451).json({
        error: {
          reason: 'UNAVAILABLE_FOR_LEGAL_REASONS',
          details: `CID blocked under ${blocked.legislation}: ${blocked.reason}`,
        },
      });
    }

    const plan = config.PLANS[req.tenant.plan_id] || config.PLANS.builder;
    const usage = getTenantUsage(req.tenant.i_address);

    const vdxfRes = await getVdxfId(vdxfUri);
    const vdxfId = vdxfRes?.vdxfid;
    if (!vdxfId) throw new Error(`Verus daemon did not resolve VDXF URI: ${vdxfUri}`);

    await kuboPinAdd(cid);
    const verified = await kuboVerifyCid(cid);
    let sizeBytes = Number(verified.actualSizeBytes || 0);
    if (!sizeBytes) {
      const stat = await kuboBlockStat(cid);
      sizeBytes = Number(stat?.Size || 0);
    }

    if (usage.usedBytes + sizeBytes > plan.storageLimitBytes) {
      return res.status(402).json({
        error: {
          reason: 'QUOTA_EXCEEDED',
          details: `Storage limit exceeded for plan ${plan.name} (${plan.storageLimitBytes} bytes)`,
        },
      });
    }

    const sha256Hex = verified.reachable && verified.actualSha256Hex ? verified.actualSha256Hex : '';
    const sha256Verified = verified.reachable && verified.actualSha256Hex ? 1 : 0;

    const createdRow = await createAndStorePinReceipt(
      upsertActivePinRecord({
        iAddress: req.tenant.i_address,
        cid,
        name,
        mimeType: String(meta.mimeType || 'application/octet-stream'),
        sizeBytes,
        sha256Hex,
        vdxfUri,
        vdxfId,
        meta,
        sha256Verified,
      })
    );

    writeAuditLog({
      iAddress: req.tenant.i_address,
      actorType: req.authType || 'tenant',
      action: 'pin.create',
      targetId: createdRow.request_id,
      details: { cid, sizeBytes },
      ipAddress: req.ip,
    });
    dispatchWebhook(req.tenant.i_address, 'pin.created', {
      requestid: createdRow.request_id,
      cid,
      name,
      size_bytes: sizeBytes,
      sha256: sha256Hex || null,
      vdxf_uri: vdxfUri,
      vdxf_id: vdxfId,
      gateway_url: `${config.publicGatewayUrl}/ipfs/${cid}`,
    });
    res.status(202).json(serializePinningServiceJob(createdRow));
  } catch (err) {
    res.status(500).json({
      error: { reason: 'PIN_FAILED', details: err.message || 'Failed to pin CID on Kubo' },
    });
  }
});

// POST /v1/pin/upload — Upload bytes to Kubo + return the serialized Verus URLRef CMM value
// Streaming multipart variant for large files; the JSON endpoint remains for text/JSON and compatibility.
router.post(
  '/pin/upload/stream',
  authenticate('pin:write'),
  enforceUploadRateLimit,
  async (req, res) => {
    inFlightUploads++;
    try {
      if (!req.is('multipart/form-data')) {
        return res
          .status(415)
          .json({ error: 'Use multipart/form-data with one file field named "file"' });
      }

      const contentLength = Number(req.get('content-length') || 0);
      if (
        Number.isFinite(contentLength) &&
        contentLength > 0 &&
        contentLength > config.maxSingleUploadBytes
      ) {
        return res.status(413).json({
          error: {
            reason: 'PAYLOAD_TOO_LARGE',
            details: `Request body (${contentLength} bytes) exceeds single-request upload limit (${config.maxSingleUploadBytes} bytes)`,
            maxSingleUploadBytes: config.maxSingleUploadBytes,
          },
        });
      }

      const vdxfUri = String(req.query?.vdxfUri || '').trim();
      const plan = config.PLANS[req.tenant.plan_id] || config.PLANS.builder;
      const usage = getTenantUsage(req.tenant.i_address);
      const remainingBytes = plan.storageLimitBytes - usage.usedBytes;
      if (remainingBytes <= 0 || (contentLength > 0 && contentLength > remainingBytes + 128 * 1024)) {
        return res.status(402).json({
          error: {
            reason: 'QUOTA_EXCEEDED',
            details: `Storage limit reached or upload exceeds remaining quota for plan ${plan.name}`,
          },
        });
      }

      let vdxfId = null;
      if (vdxfUri) {
        const vdxfRes = await getVdxfId(vdxfUri);
        vdxfId = vdxfRes?.vdxfid || null;
        if (!vdxfId) {
          throw createHttpError(
            502,
            'VDXF_RESOLUTION_FAILED',
            `Verus daemon did not resolve VDXF URI: ${vdxfUri}`
          );
        }
      }

      const maxAllowedBytes = Math.min(remainingBytes, config.maxSingleUploadBytes);
      const uploaded = await streamMultipartFileToKubo(req, maxAllowedBytes);
      let meta = {};
      if (uploaded.fields?.meta) {
        try {
          meta = JSON.parse(uploaded.fields.meta);
          if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
            throw new Error('metadata must be a JSON object');
          }
        } catch (error) {
          await kuboPinRm(uploaded.cid);
          return res.status(400).json({ error: `Invalid multipart meta field: ${error.message}` });
        }
      }
      const db = getDb();
      const blocked = db.prepare('SELECT * FROM blocked_cids WHERE cid = ?').get(uploaded.cid);
      if (blocked) {
        await kuboPinRm(uploaded.cid);
        return res.status(451).json({
          error: {
            reason: 'UNAVAILABLE_FOR_LEGAL_REASONS',
            details: `Content matches blocked CID under ${blocked.legislation}`,
          },
        });
      }

      const row = await createAndStorePinReceipt(
        upsertActivePinRecord({
          iAddress: req.tenant.i_address,
          cid: uploaded.cid,
          name: uploaded.filename,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          sha256Hex: uploaded.sha256Hex,
          vdxfUri: vdxfUri || '',
          vdxfId,
          meta,
          sha256Verified: 1,
        })
      );

      writeAuditLog({
        iAddress: req.tenant.i_address,
        actorType: req.authType || 'tenant',
        action: 'pin.upload_stream',
        targetId: row.request_id,
        details: {
          cid: uploaded.cid,
          filename: uploaded.filename,
          sizeBytes: uploaded.sizeBytes,
          sha256Hex: uploaded.sha256Hex,
        },
        ipAddress: req.ip,
      });

      dispatchWebhook(req.tenant.i_address, 'pin.created', {
        requestid: row.request_id,
        cid: uploaded.cid,
        name: uploaded.filename,
        size_bytes: uploaded.sizeBytes,
        sha256: uploaded.sha256Hex,
        vdxf_uri: vdxfUri || '',
        vdxf_id: vdxfId,
        gateway_url: `${config.publicGatewayUrl}/ipfs/${uploaded.cid}`,
        source: 'stream',
      });

      res.status(201).json(serializePinningServiceJob(row));
    } catch (error) {
      const status = Number(error.status) || 500;
      res.status(status).json({
        error: {
          reason: error.reason || 'UPLOAD_FAILED',
          details: error.message || 'Streaming upload to Kubo failed',
        },
      });
    } finally {
      inFlightUploads = Math.max(0, inFlightUploads - 1);
    }
  }
);

// ── Chunked / Resumable Upload API (>100 MiB over Cloudflare Edge) ──────────
function getChunkedUploadDir(uploadId) {
  return path.join(path.dirname(config.dbPath), 'chunked-uploads', uploadId);
}

router.post(
  '/pin/upload/chunked/init',
  authenticate('pin:write'),
  enforceUploadRateLimit,
  async (req, res) => {
    try {
      const filename = String(req.body?.filename || 'large-upload.bin')
        .replace(/^.*[\\/]/, '')
        .trim() || 'large-upload.bin';
      const mimeType = String(req.body?.mimeType || 'application/octet-stream').trim();
      const totalSizeBytes =
        req.body?.totalSizeBytes !== undefined && req.body?.totalSizeBytes !== null
          ? Number(req.body.totalSizeBytes)
          : null;
      const vdxfUri = String(req.body?.vdxfUri || '').trim();
      const meta =
        req.body?.meta && typeof req.body.meta === 'object' && !Array.isArray(req.body.meta)
          ? req.body.meta
          : {};

      const plan = config.PLANS[req.tenant.plan_id] || config.PLANS.builder;
      const usage = getTenantUsage(req.tenant.i_address);
      const remainingBytes = plan.storageLimitBytes - usage.usedBytes;
      if (remainingBytes <= 0 || (totalSizeBytes !== null && totalSizeBytes > remainingBytes)) {
        return res.status(402).json({
          error: {
            reason: 'QUOTA_EXCEEDED',
            details: `Requested upload exceeds remaining storage quota (${remainingBytes} bytes) for plan ${plan.name}`,
          },
        });
      }

      if (vdxfUri) {
        const vdxfRes = await getVdxfId(vdxfUri);
        if (!vdxfRes?.vdxfid) {
          return res.status(502).json({
            error: {
              reason: 'VDXF_RESOLUTION_FAILED',
              details: `Verus daemon did not resolve VDXF URI: ${vdxfUri}`,
            },
          });
        }
      }

      const uploadId = `up_${crypto.randomBytes(10).toString('hex')}`;
      const expiresAt = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
      const now = new Date().toISOString();
      const stagingDir = getChunkedUploadDir(uploadId);
      fs.mkdirSync(stagingDir, { recursive: true });

      const db = getDb();
      db.prepare(
        `INSERT INTO chunked_uploads (upload_id, i_address, filename, mime_type, total_size_bytes, vdxf_uri, meta_json, received_parts_json, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'open', ?, ?)`
      ).run(
        uploadId,
        req.tenant.i_address,
        filename,
        mimeType,
        totalSizeBytes,
        vdxfUri,
        JSON.stringify(meta),
        expiresAt,
        now
      );

      res.status(201).json({
        uploadId,
        filename,
        mimeType,
        maxPartSizeBytes: Math.min(50 * 1024 * 1024, config.maxSingleUploadBytes),
        expiresAt,
      });
    } catch (error) {
      res.status(500).json({
        error: {
          reason: 'CHUNKED_INIT_FAILED',
          details: error.message || 'Failed to initialize chunked upload',
        },
      });
    }
  }
);

router.put('/pin/upload/chunked/:uploadId/part', authenticate('pin:write'), async (req, res) => {
  inFlightUploads++;
  try {
    const uploadId = String(req.params.uploadId || '').trim();
    if (!/^up_[a-f0-9]{20}$/.test(uploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId' });
    }
    const partNumber = Number(req.query.partNumber);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      return res.status(400).json({ error: 'partNumber must be an integer between 1 and 10000' });
    }

    const db = getDb();
    const session = db
      .prepare('SELECT * FROM chunked_uploads WHERE upload_id = ? AND i_address = ?')
      .get(uploadId, req.tenant.i_address);
    if (!session || session.status !== 'open') {
      return res.status(404).json({ error: 'Open chunked upload session not found' });
    }
    if (Date.now() > session.expires_at) {
      return res.status(410).json({ error: 'Chunked upload session expired' });
    }

    const stagingDir = getChunkedUploadDir(uploadId);
    fs.mkdirSync(stagingDir, { recursive: true });
    const partPath = path.join(stagingDir, `part-${String(partNumber).padStart(5, '0')}.bin`);

    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const maxPartBytes = Math.min(50 * 1024 * 1024, config.maxSingleUploadBytes);
    const writeStream = fs.createWriteStream(partPath);

    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        sizeBytes += chunk.length;
        if (sizeBytes > maxPartBytes) {
          writeStream.destroy();
          reject(createHttpError(413, 'PART_TOO_LARGE', `Part exceeds ${maxPartBytes} bytes`));
          return;
        }
        hash.update(chunk);
        if (!writeStream.write(chunk)) {
          req.pause();
          writeStream.once('drain', () => req.resume());
        }
      });
      req.on('end', () => {
        writeStream.end(() => resolve());
      });
      req.on('error', reject);
      writeStream.on('error', reject);
    });

    const sha256Hex = hash.digest('hex');
    const latest = db
      .prepare('SELECT received_parts_json FROM chunked_uploads WHERE upload_id = ?')
      .get(uploadId);
    const parts = JSON.parse(latest?.received_parts_json || '{}');
    parts[String(partNumber)] = { partNumber, sizeBytes, sha256Hex };
    db.prepare('UPDATE chunked_uploads SET received_parts_json = ? WHERE upload_id = ?').run(
      JSON.stringify(parts),
      uploadId
    );

    res.json({
      ok: true,
      uploadId,
      partNumber,
      sizeBytes,
      sha256Hex,
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    res.status(status).json({
      error: {
        reason: error.reason || 'PART_UPLOAD_FAILED',
        details: error.message || 'Failed to write upload part',
      },
    });
  } finally {
    inFlightUploads = Math.max(0, inFlightUploads - 1);
  }
});

router.post(
  '/pin/upload/chunked/:uploadId/complete',
  authenticate('pin:write'),
  async (req, res) => {
    inFlightUploads++;
    const uploadId = String(req.params.uploadId || '').trim();
    const stagingDir = /^up_[a-f0-9]{20}$/.test(uploadId) ? getChunkedUploadDir(uploadId) : null;
    try {
      if (!stagingDir) {
        return res.status(400).json({ error: 'Invalid uploadId' });
      }
      const db = getDb();
      const session = db
        .prepare('SELECT * FROM chunked_uploads WHERE upload_id = ? AND i_address = ?')
        .get(uploadId, req.tenant.i_address);
      if (!session || session.status !== 'open') {
        return res.status(404).json({ error: 'Open chunked upload session not found' });
      }

      const partsMap = JSON.parse(session.received_parts_json || '{}');
      const partNumbers = Object.keys(partsMap)
        .map((n) => Number(n))
        .sort((a, b) => a - b);
      if (partNumbers.length === 0) {
        return res.status(400).json({ error: 'No parts uploaded for this session' });
      }
      for (let i = 0; i < partNumbers.length; i++) {
        if (partNumbers[i] !== i + 1) {
          return res.status(400).json({
            error: `Missing part ${i + 1}; parts must be contiguous starting at 1`,
          });
        }
      }

      const totalBytes = partNumbers.reduce(
        (acc, num) => acc + Number(partsMap[String(num)]?.sizeBytes || 0),
        0
      );
      if (session.total_size_bytes !== null && totalBytes !== Number(session.total_size_bytes)) {
        return res.status(400).json({
          error: `Assembled size (${totalBytes} bytes) does not match declared totalSizeBytes (${session.total_size_bytes} bytes)`,
        });
      }

      const plan = config.PLANS[req.tenant.plan_id] || config.PLANS.builder;
      const usage = getTenantUsage(req.tenant.i_address);
      const remainingBytes = plan.storageLimitBytes - usage.usedBytes;
      if (totalBytes > remainingBytes) {
        return res.status(402).json({
          error: {
            reason: 'QUOTA_EXCEEDED',
            details: `Assembled upload (${totalBytes} bytes) exceeds remaining quota (${remainingBytes} bytes)`,
          },
        });
      }

      let vdxfId = null;
      if (session.vdxf_uri) {
        const vdxfRes = await getVdxfId(session.vdxf_uri);
        vdxfId = vdxfRes?.vdxfid || null;
      }

      const fullHash = crypto.createHash('sha256');
      async function* concatPartsGenerator() {
        for (const num of partNumbers) {
          const partPath = path.join(stagingDir, `part-${String(num).padStart(5, '0')}.bin`);
          const partStream = fs.createReadStream(partPath);
          for await (const chunk of partStream) {
            fullHash.update(chunk);
            yield chunk;
          }
        }
      }

      const added = await kuboAddStream(
        Readable.from(concatPartsGenerator()),
        session.filename,
        session.mime_type
      );
      const sha256Hex = fullHash.digest('hex');

      const blocked = db.prepare('SELECT * FROM blocked_cids WHERE cid = ?').get(added.cid);
      if (blocked) {
        await kuboPinRm(added.cid);
        return res.status(451).json({
          error: {
            reason: 'UNAVAILABLE_FOR_LEGAL_REASONS',
            details: `Content matches blocked CID under ${blocked.legislation}`,
          },
        });
      }

      let parsedMeta = {};
      try {
        parsedMeta = JSON.parse(session.meta_json || '{}');
      } catch {}

      const row = await createAndStorePinReceipt(
        upsertActivePinRecord({
          iAddress: req.tenant.i_address,
          cid: added.cid,
          name: session.filename,
          mimeType: session.mime_type,
          sizeBytes: totalBytes,
          sha256Hex,
          vdxfUri: session.vdxf_uri || '',
          vdxfId,
          meta: parsedMeta,
          sha256Verified: 1,
        })
      );

      db.prepare(`UPDATE chunked_uploads SET status = 'completed' WHERE upload_id = ?`).run(
        uploadId
      );

      writeAuditLog({
        iAddress: req.tenant.i_address,
        actorType: req.authType || 'tenant',
        action: 'pin.upload_chunked',
        targetId: row.request_id,
        details: {
          uploadId,
          cid: added.cid,
          parts: partNumbers.length,
          sizeBytes: totalBytes,
          sha256Hex,
        },
        ipAddress: req.ip,
      });

      dispatchWebhook(req.tenant.i_address, 'pin.created', {
        requestid: row.request_id,
        cid: added.cid,
        name: session.filename,
        size_bytes: totalBytes,
        sha256: sha256Hex,
        vdxf_uri: session.vdxf_uri || '',
        vdxf_id: vdxfId,
        gateway_url: `${config.publicGatewayUrl}/ipfs/${added.cid}`,
        source: 'chunked',
        parts: partNumbers.length,
      });

      res.status(201).json(serializePinningServiceJob(row));
    } catch (error) {
      const status = Number(error.status) || 500;
      res.status(status).json({
        error: {
          reason: error.reason || 'CHUNKED_COMPLETE_FAILED',
          details: error.message || 'Failed to complete chunked upload',
        },
      });
    } finally {
      if (stagingDir) {
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch {}
      }
      inFlightUploads = Math.max(0, inFlightUploads - 1);
    }
  }
);

router.delete('/pin/upload/chunked/:uploadId', authenticate('pin:write'), (req, res) => {
  const uploadId = String(req.params.uploadId || '').trim();
  if (!/^up_[a-f0-9]{20}$/.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId' });
  }
  const db = getDb();
  const session = db
    .prepare('SELECT * FROM chunked_uploads WHERE upload_id = ? AND i_address = ?')
    .get(uploadId, req.tenant.i_address);
  if (!session) {
    return res.status(404).json({ error: 'Chunked upload session not found' });
  }
  db.prepare(`UPDATE chunked_uploads SET status = 'aborted' WHERE upload_id = ?`).run(uploadId);
  try {
    fs.rmSync(getChunkedUploadDir(uploadId), { recursive: true, force: true });
  } catch {}
  res.json({ ok: true, uploadId, status: 'aborted' });
});

router.post('/pin/upload', authenticate('pin:write'), enforceUploadRateLimit, async (req, res) => {
  try {
    const {
      filename = 'verus-object.json',
      contentBase64,
      contentText,
      contentJson,
      mimeType = 'application/json',
      vdxfUri = 'sovpin::storage.pin.descriptor',
      meta = {},
    } = req.body || {};

    let buffer;
    if (typeof contentBase64 === 'string' && contentBase64.length > 0) {
      const cleaned = contentBase64.includes(',') ? contentBase64.split(',')[1] : contentBase64;
      buffer = Buffer.from(cleaned, 'base64');
    } else if (typeof contentText === 'string') {
      buffer = Buffer.from(contentText, 'utf8');
    } else if (contentJson !== undefined) {
      buffer = Buffer.from(JSON.stringify(contentJson, null, 2), 'utf8');
    } else {
      return res.status(400).json({
        error: {
          reason: 'MISSING_CONTENT',
          details: 'Provide contentBase64, contentText, or contentJson',
        },
      });
    }

    const plan = config.PLANS[req.tenant.plan_id] || config.PLANS.builder;
    const usage = getTenantUsage(req.tenant.i_address);
    if (usage.usedBytes + buffer.length > plan.storageLimitBytes) {
      return res.status(402).json({
        error: {
          reason: 'QUOTA_EXCEEDED',
          details: `Upload exceeds ${plan.name} storage quota (${plan.storageLimitBytes} bytes)`,
        },
      });
    }

    const vdxfRes = await getVdxfId(vdxfUri);
    const vdxfId = vdxfRes?.vdxfid;
    if (!vdxfId) throw new Error(`Verus daemon did not resolve VDXF URI: ${vdxfUri}`);

    const sha256Hex = crypto.createHash('sha256').update(buffer).digest('hex');
    const { cid, sizeBytes } = await kuboAddBuffer(buffer, filename);

    const db = getDb();
    const blocked = db.prepare('SELECT * FROM blocked_cids WHERE cid = ?').get(cid);
    if (blocked) {
      await kuboPinRm(cid);
      return res.status(451).json({
        error: {
          reason: 'UNAVAILABLE_FOR_LEGAL_REASONS',
          details: `Content matches blocked CID under ${blocked.legislation}`,
        },
      });
    }

    const createdRow = await createAndStorePinReceipt(
      upsertActivePinRecord({
        iAddress: req.tenant.i_address,
        cid,
        name: filename,
        mimeType,
        sizeBytes,
        sha256Hex,
        vdxfUri,
        vdxfId,
        meta,
        sha256Verified: 1,
      })
    );
    writeAuditLog({
      iAddress: req.tenant.i_address,
      actorType: req.authType || 'tenant',
      action: 'pin.upload',
      targetId: createdRow.request_id,
      details: { cid, filename, sizeBytes, sha256Hex },
      ipAddress: req.ip,
    });
    dispatchWebhook(req.tenant.i_address, 'pin.created', {
      requestid: createdRow.request_id,
      cid,
      name: filename,
      size_bytes: sizeBytes,
      sha256: sha256Hex,
      vdxf_uri: vdxfUri,
      vdxf_id: vdxfId,
      gateway_url: `${config.publicGatewayUrl}/ipfs/${cid}`,
      source: 'json',
    });
    res.status(201).json(serializePinningServiceJob(createdRow));
  } catch (err) {
    res.status(500).json({
      error: { reason: 'UPLOAD_FAILED', details: err.message || 'Upload to Kubo failed' },
    });
  }
});

// POST /v1/pins/import-kubo — Sync existing recursive pins from Kubo into tenant ledger
router.post('/pins/import-kubo', authenticate('pin:write'), async (req, res) => {
  try {
    const pinRes = await fetch(`${config.kuboRpcUrl}/api/v0/pin/ls?type=recursive`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    });
    if (!pinRes.ok) {
      return res.status(502).json({ error: 'Failed to query Kubo pin/ls' });
    }
    const pinData = await pinRes.json();
    const cids = Object.keys(pinData.Keys || {});
    const vdxfUri = 'sovpin::storage.pin.descriptor';
    const vdxfId = (await getVdxfId(vdxfUri))?.vdxfid;
    if (!vdxfId) throw new Error(`Verus daemon did not resolve VDXF URI: ${vdxfUri}`);
    const db = getDb();
    let imported = 0;
    let skipped = 0;

    for (const cid of cids) {
      const existing = db
        .prepare('SELECT request_id FROM pins WHERE cid = ? AND i_address = ? AND status = ?')
        .get(cid, req.tenant.i_address, 'pinned');
      if (existing) {
        skipped++;
        continue;
      }
      let sizeBytes = 0;
      let sha256Hex = crypto.createHash('sha256').update(cid).digest('hex');
      let sha256Verified = 0;
      let mimeType = 'application/octet-stream';
      try {
        const gwRes = await fetch(`${config.kuboGatewayUrl}/ipfs/${encodeURIComponent(cid)}`, {
          signal: AbortSignal.timeout(20000),
        });
        if (gwRes.ok && gwRes.body) {
          const ct = gwRes.headers.get('content-type');
          if (ct) mimeType = ct.split(';')[0].trim();
          const hash = crypto.createHash('sha256');
          let bytes = 0;
          for await (const chunk of gwRes.body) {
            const buf = Buffer.from(chunk);
            bytes += buf.length;
            hash.update(buf);
          }
          sizeBytes = bytes;
          sha256Hex = hash.digest('hex');
          sha256Verified = 1;
        }
      } catch {
        const stat = await kuboBlockStat(cid);
        sizeBytes = Number(stat?.Size || 0);
      }
      const requestId = `pin_${crypto.randomBytes(10).toString('hex')}`;
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO pins (request_id, i_address, cid, name, mime_type, size_bytes, sha256_hex, vdxf_uri, vdxf_id, meta_json, sha256_verified, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pinned', ?)`
      ).run(
        requestId,
        req.tenant.i_address,
        cid,
        `kubo-object-${cid.slice(0, 10)}`,
        mimeType,
        sizeBytes,
        sha256Hex,
        vdxfUri,
        vdxfId,
        JSON.stringify({ source: 'kubo-sync' }),
        sha256Verified,
        now
      );
      imported++;
    }

    res.json({ ok: true, imported, skipped, totalKuboPins: cids.length });
  } catch (err) {
    console.error('[kubo sync] failed:', err.message);
    res.status(500).json({ error: 'Kubo sync failed' });
  }
});

// GET /v1/pins/:requestid
router.get('/pins/:requestid', authenticate('pin:read'), (req, res) => {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM pins WHERE request_id = ? AND i_address = ?')
    .get(req.params.requestid, req.tenant.i_address);
  if (!row) {
    return res.status(404).json({
      error: { reason: 'NOT_FOUND', details: 'Pin request ID not found' },
    });
  }
  res.json(serializePinningServiceJob(row));
});

// POST /v1/pins/:requestid/verify — Verify Kubo pin health, byte size, and SHA-256 integrity
router.post('/pins/:requestid/verify', authenticate('pin:read'), async (req, res) => {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM pins WHERE request_id = ? AND i_address = ?')
    .get(req.params.requestid, req.tenant.i_address);
  if (!row) {
    return res.status(404).json({
      error: { reason: 'NOT_FOUND', details: 'Pin request ID not found' },
    });
  }

  const verification = await kuboVerifyCid(
    row.cid,
    row.size_bytes,
    row.sha256_verified ? row.sha256_hex : null
  );
  const ok =
    verification.kuboPinned &&
    verification.reachable &&
    verification.sizeMatches &&
    verification.sha256Matches;

  res.json({
    ok,
    requestid: row.request_id,
    cid: row.cid,
    expectedSizeBytes: row.size_bytes,
    expectedSha256Hex: row.sha256_verified ? row.sha256_hex : null,
    ...verification,
  });
});

// POST /v1/pins/:requestid/receipt — Issue or refresh a Verus-signed cryptographic pin receipt
router.post('/pins/:requestid/receipt', authenticate('pin:read'), async (req, res) => {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM pins WHERE request_id = ? AND i_address = ?')
    .get(req.params.requestid, req.tenant.i_address);
  if (!row) {
    return res.status(404).json({
      error: { reason: 'NOT_FOUND', details: 'Pin request ID not found' },
    });
  }

  const updated = await createAndStorePinReceipt(row);
  let receipt = null;
  try {
    receipt = updated.receipt_json ? JSON.parse(updated.receipt_json) : null;
  } catch {
    receipt = null;
  }
  if (!receipt) {
    return res.status(502).json({
      error: { reason: 'RECEIPT_SIGN_FAILED', details: 'Failed to sign storage receipt with service VerusID' },
    });
  }

  let verifiedOnChain = false;
  try {
    const verified = await verifySignature({
      address: receipt.signerIAddress,
      message: receipt.message,
      signature: receipt.signature,
      checklatest: true,
    });
    verifiedOnChain =
      verified === true ||
      verified?.signaturestatus === 'verified' ||
      (verified?.address === receipt.signerIAddress && Boolean(verified?.hash));
  } catch {
    verifiedOnChain = false;
  }

  res.json({
    ok: true,
    requestid: row.request_id,
    cid: row.cid,
    verifiedOnChain,
    receipt,
  });
});

// POST /v1/pins/gc — Sweep unreferenced unpinned/blocked CIDs from Kubo and run repo GC
router.post('/pins/gc', authenticate('pin:write'), async (req, res) => {
  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT DISTINCT cid FROM pins WHERE status IN ('unpinned', 'blocked_uk_osa')`
    )
    .all();

  let unpinnedCids = 0;
  for (const row of candidates) {
    if (countActivePinReferences(row.cid) === 0) {
      const removed = await kuboPinRm(row.cid);
      if (removed) unpinnedCids++;
    }
  }

  const runRepoGc = Boolean(req.body?.runRepoGc);
  const repoGc = runRepoGc ? await kuboRepoGc() : { ok: true, reclaimedBlocks: 0 };

  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'tenant',
    action: 'pin.gc_sweep',
    targetId: null,
    details: { candidatesChecked: candidates.length, unpinnedCids, repoGc },
    ipAddress: req.ip,
  });

  res.json({
    ok: true,
    candidatesChecked: candidates.length,
    unpinnedCids,
    repoGc,
  });
});

// DELETE /v1/pins/:requestid (Reference-counted unpinning on Kubo!)
router.delete('/pins/:requestid', authenticate('pin:write'), async (req, res) => {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM pins WHERE request_id = ? AND i_address = ?')
    .get(req.params.requestid, req.tenant.i_address);
  if (!row) {
    return res.status(404).json({
      error: { reason: 'NOT_FOUND', details: 'Pin request ID not found' },
    });
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE pins SET status = 'unpinned', unpinned_at = ? WHERE request_id = ?`).run(
    now,
    row.request_id
  );

  // Reference-counted unpin: only unpin from Kubo if ZERO active tenants reference this CID
  const remainingRefs = countActivePinReferences(row.cid);
  let removedFromKubo = false;
  if (remainingRefs === 0) {
    removedFromKubo = await kuboPinRm(row.cid);
  }

  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'tenant',
    action: 'pin.unpin',
    targetId: row.request_id,
    details: { cid: row.cid, remainingTenantReferences: remainingRefs, removedFromKubo },
    ipAddress: req.ip,
  });

  dispatchWebhook(req.tenant.i_address, 'pin.deleted', {
    requestid: row.request_id,
    cid: row.cid,
    remainingTenantReferences: remainingRefs,
    removedFromKubo,
  });

  res.status(202).json({
    ok: true,
    requestid: row.request_id,
    cid: row.cid,
    remainingTenantReferences: remainingRefs,
    removedFromKubo,
  });
});

// ── 6. VDXF & ContentMultiMap Tools (Live Daemon getvdxfid + CMM Auto-Pin Watcher) ──
router.post('/vdxf/resolve', async (req, res) => {
  try {
    const vdxfUri = String(req.body?.vdxfUri || '').trim();
    if (!vdxfUri) {
      return res.status(400).json({ error: 'vdxfUri is required (e.g. sovpin::storage.pin.descriptor)' });
    }
    const result = await getVdxfId(vdxfUri);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to compute VDXF ID' });
  }
});

// Prepare Verus's native updateidentity `data` wrapper; the caller submits it through its own wallet.
router.post('/verus/native-storage/entry', authenticate('vdxf:build'), async (req, res) => {
  try {
    const identityName = String(req.body?.identityName || '').trim();
    const vdxfUri = String(req.body?.vdxfUri || '').trim();
    const filename = String(req.body?.filename || '').trim();
    if (!identityName || !vdxfUri || !filename) {
      return res.status(400).json({
        error: 'identityName, vdxfUri, and filename (readable by the caller\'s verusd) are required',
      });
    }
    if (req.body?.createMmr !== undefined && typeof req.body.createMmr !== 'boolean') {
      return res.status(400).json({ error: 'createMmr must be a boolean when provided' });
    }

    const resolved = await getVdxfId(vdxfUri);
    const vdxfId = resolved?.vdxfid;
    if (!vdxfId) {
      return res.status(502).json({ error: 'Verus daemon did not return a VDXF i-address for this URI' });
    }

    const contentmultimap = buildNativeDataContentMultiMapEntry({
      identityName,
      vdxfId,
      filename,
      label: req.body?.label,
      mimeType: req.body?.mimeType,
      createMmr: req.body?.createMmr,
    });

    res.json({ vdxfId, contentmultimap });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to prepare Verus native-storage entry' });
  }
});

router.get('/watchers', authenticate(), (req, res) => {
  const db = getDb();
  const watchers = db
    .prepare('SELECT * FROM cmm_watchers WHERE i_address = ? ORDER BY created_at DESC')
    .all(req.tenant.i_address);
  res.json({ watchers });
});

// Synchronous: extract direct IPFS CIDs from a CMM object
function extractDirectCids(obj) {
  const serialized = typeof obj === 'string' ? obj : JSON.stringify(obj || {});
  const matches = new Set();
  const cidRegex = /\b(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{50,})\b/g;
  let m;
  while ((m = cidRegex.exec(serialized)) !== null) matches.add(m[1]);
  // Decode hex-encoded JSON entries
  const hexRegex = /\b[0-9a-fA-F]{40,}\b/g;
  let hm;
  while ((hm = hexRegex.exec(serialized)) !== null) {
    try {
      const decoded = Buffer.from(hm[0], 'hex').toString('utf8');
      let dm;
      while ((dm = cidRegex.exec(decoded)) !== null) matches.add(dm[1]);
    } catch {}
  }
  const cmmMap = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  for (const cid of extractCidsFromUrlRefs(extractUrlRefsFromCmm(cmmMap))) matches.add(cid);
  return matches;
}

// Extract sub-identity addresses (i-addresses) from CMM entries
// VREAL stores entries as hex-encoded JSON: {"i":"iAddress...","n":"name...","t":timestamp}
function extractSubIdentities(obj) {
  const serialized = typeof obj === 'string' ? obj : JSON.stringify(obj || {});
  const identities = new Set();
  const hexRegex = /\b[0-9a-fA-F]{40,}\b/g;
  let hm;
  while ((hm = hexRegex.exec(serialized)) !== null) {
    try {
      const decoded = Buffer.from(hm[0], 'hex').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed.i === 'string' && parsed.i.startsWith('i')) {
        identities.add(parsed.i);
      }
    } catch {}
  }
  return identities;
}

function getCmmCidReferences(contentmultimap = {}) {
  const references = [];
  const urlRefs = extractUrlRefsFromCmm(contentmultimap);
  const referencedCids = new Set();

  for (const reference of urlRefs) {
    const cids = extractCidsFromUrlRefs([reference]);
    if (cids.size === 0) {
      references.push({ ...reference, cid: null, sourceType: 'URLRef', sourceFormat: 'urlref' });
      continue;
    }
    for (const cid of cids) {
      referencedCids.add(cid);
      references.push({ ...reference, cid, sourceType: 'URLRef', sourceFormat: 'urlref' });
    }
  }

  for (const cid of extractDirectCids(contentmultimap)) {
    if (referencedCids.has(cid)) continue;
    referencedCids.add(cid);
    references.push({ vdxfKey: null, url: null, datahash: null, cid, sourceType: 'CID_REFERENCE' });
  }
  return references;
}

async function getCidPinStatuses(cids) {
  try {
    const pinnedCids = await kuboListRecursivePins();
    return Object.fromEntries(
      [...new Set(cids)].map((cid) => [
        cid,
        { pinned: pinnedCids.has(cid), pinStatus: pinnedCids.has(cid) ? 'PINNED' : 'MISSING_FROM_NODE' },
      ])
    );
  } catch {
    return Object.fromEntries(
      [...new Set(cids)].map((cid) => [cid, { pinned: null, pinStatus: 'UNREACHABLE' }])
    );
  }
}

// Async: 2-level CMM traversal — target identity → sub-identities → IPFS CIDs
async function discoverCidsFromCmm(targetIAddress) {
  const { getIdentityContent } = require('./verus-rpc');
  const allCids = new Set();
  const visited = new Set();

  async function traverse(iAddress, depth) {
    if (depth > 2 || visited.has(iAddress)) return;
    visited.add(iAddress);
    let cmmContent;
    try {
      cmmContent = await getIdentityContent(iAddress);
    } catch {
      return;
    }
    const cmmMap = cmmContent?.identity?.contentmultimap || {};
    for (const cid of extractDirectCids(cmmMap)) allCids.add(cid);
    // Level 2: sub-identities
    const subIds = extractSubIdentities(cmmMap);
    for (const subId of subIds) {
      await traverse(subId, depth + 1);
    }
  }

  await traverse(targetIAddress, 0);
  return Array.from(allCids);
}

router.post('/watchers', authenticate(), async (req, res) => {
  try {
    const targetIdentity = String(req.body?.targetIdentity || req.tenant.friendly_name).trim();
    const vdxfUri = String(req.body?.vdxfUri || 'sovpin::storage.pin.descriptor').trim();

    const plan = config.PLANS[req.tenant.plan_id] || config.PLANS.builder;
    const usage = getTenantUsage(req.tenant.i_address);
    if (usage.activeWatchers >= plan.maxCmmWatchers) {
      return res.status(403).json({
        error: `Plan '${plan.name}' allows up to ${plan.maxCmmWatchers} CMM Watchers. Upgrade to add more.`,
      });
    }

    const [idInfo, vdxfInfo] = await Promise.all([
      getIdentity(targetIdentity),
      getVdxfId(vdxfUri),
    ]);

    const targetIAddress = idInfo?.identity?.identityaddress;
    if (!targetIAddress) {
      return res.status(404).json({ error: `Target VerusID '${targetIdentity}' not found on chain` });
    }

    const watcherId = `wch_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const db = getDb();

    // Immediately inspect live on-chain ContentMultiMap via getidentitycontent
    // 2-level traversal: target identity → sub-identities → IPFS CIDs
    const cmmContent = await getIdentityContent(targetIAddress);
    const cmmMap = cmmContent?.identity?.contentmultimap || {};
    const discoveredCids = await discoverCidsFromCmm(targetIAddress);

    const { pinnedCount, failedCids } = await kuboPinMany(discoveredCids);

    const syncSummary = {
      blockHeight: cmmContent?.blockheight || idInfo.blockheight,
      totalCmmKeys: Object.keys(cmmMap).length,
      discoveredCids,
      pinnedCount,
      failedPins: failedCids,
    };

    db.prepare(
      `INSERT INTO cmm_watchers (watcher_id, i_address, target_identity, target_i_address, vdxf_uri, vdxf_id, status, pins_discovered, last_synced_at, last_result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    ).run(
      watcherId,
      req.tenant.i_address,
      idInfo.fullyqualifiedname || targetIdentity,
      targetIAddress,
      vdxfUri,
      vdxfInfo.vdxfid,
      discoveredCids.length,
      now,
      JSON.stringify(syncSummary),
      now
    );

    const created = db.prepare('SELECT * FROM cmm_watchers WHERE watcher_id = ?').get(watcherId);
    dispatchWebhook(req.tenant.i_address, 'watcher.created', {
      watcherId,
      targetIdentity: idInfo.fullyqualifiedname || targetIdentity,
      targetIAddress,
      vdxfUri,
      discoveredCids,
      pinnedCount,
      blockHeight: cmmContent?.blockheight || idInfo.blockheight,
    });
    res.status(201).json({ watcher: created, syncSummary });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to register CMM Watcher' });
  }
});

router.post('/watchers/:watcherId/sync', authenticate(), async (req, res) => {
  try {
    const db = getDb();
    const watcher = db
      .prepare('SELECT * FROM cmm_watchers WHERE watcher_id = ? AND i_address = ?')
      .get(req.params.watcherId, req.tenant.i_address);
    if (!watcher) {
      return res.status(404).json({ error: 'Watcher not found' });
    }

    const cmmContent = await getIdentityContent(watcher.target_i_address);
    const cmmMap = cmmContent?.identity?.contentmultimap || {};
    const discoveredCids = await discoverCidsFromCmm(watcher.target_i_address);

    const { pinnedCount, failedCids } = await kuboPinMany(discoveredCids);

    const now = new Date().toISOString();
    const syncSummary = {
      blockHeight: cmmContent?.blockheight,
      totalCmmKeys: Object.keys(cmmMap).length,
      discoveredCids,
      pinnedCount,
      failedPins: failedCids,
    };

    db.prepare(
      `UPDATE cmm_watchers
       SET pins_discovered = ?, last_synced_at = ?, last_result_json = ?
       WHERE watcher_id = ?`
    ).run(discoveredCids.length, now, JSON.stringify(syncSummary), watcher.watcher_id);

    const updated = db
      .prepare('SELECT * FROM cmm_watchers WHERE watcher_id = ?')
      .get(watcher.watcher_id);
    dispatchWebhook(req.tenant.i_address, 'watcher.synced', {
      watcherId: watcher.watcher_id,
      targetIdentity: watcher.target_identity,
      targetIAddress: watcher.target_i_address,
      discoveredCids,
      pinnedCount,
      blockHeight: cmmContent?.blockheight,
    });
    res.json({ watcher: updated, syncSummary });
  } catch (err) {
    res.status(400).json({ error: err.message || 'CMM sync failed' });
  }
});

// POST /v1/watchers/:watcherId/repair — Pin missing on-chain CIDs, verify SHA-256 against URLRef.datahash, and record in tenant ledger
router.post('/watchers/:watcherId/repair', authenticate('pin:write'), async (req, res) => {
  try {
    const db = getDb();
    const watcher = db
      .prepare('SELECT * FROM cmm_watchers WHERE watcher_id = ? AND i_address = ?')
      .get(req.params.watcherId, req.tenant.i_address);
    if (!watcher) {
      return res.status(404).json({ error: 'Watcher not found' });
    }

    const rootContent = await getIdentityContent(watcher.target_i_address);
    const rootCmm = rootContent?.identity?.contentmultimap || {};
    const allRefs = [...getCmmCidReferences(rootCmm)];

    const subIds = extractSubIdentities(rootCmm);
    for (const subId of subIds) {
      try {
        const subContent = await getIdentityContent(subId);
        const subCmm = subContent?.identity?.contentmultimap || {};
        allRefs.push(...getCmmCidReferences(subCmm));
      } catch {
        // ignore unresolvable sub-identity
      }
    }

    const byCid = new Map();
    for (const ref of allRefs) {
      if (!ref.cid) continue;
      if (!byCid.has(ref.cid) || (ref.datahash && !byCid.get(ref.cid).datahash)) {
        byCid.set(ref.cid, ref);
      }
    }

    const repaired = [];
    const failed = [];
    const tenantIAddress = req.tenant.i_address;

    async function repairOneCid(cid, ref) {
      const blocked = db.prepare('SELECT * FROM blocked_cids WHERE cid = ?').get(cid);
      if (blocked) {
        return { ok: false, entry: { cid, reason: 'BLOCKED_UK_OSA' } };
      }

      try {
        await kuboPinPrimary(cid);
        replicateInBackground(cid);
        const verified = await kuboVerifyCid(cid, null, ref.datahash || null);
        const sizeBytes = Number(verified.actualSizeBytes || 0);
        const sha256Hex = verified.actualSha256Hex || ref.datahash || '';
        const sha256Verified = verified.reachable && verified.sha256Matches && sha256Hex ? 1 : 0;
        const mimeType = ref.dataDescriptor?.mimeType || 'application/octet-stream';
        const label = ref.dataDescriptor?.label || `watcher-${cid.slice(0, 10)}`;

        const pinRow = upsertActivePinRecord({
          iAddress: tenantIAddress,
          cid,
          name: label,
          mimeType,
          sizeBytes,
          sha256Hex,
          vdxfUri: watcher.vdxf_uri,
          vdxfId: ref.vdxfKey || watcher.vdxf_id,
          meta: {
            source: 'cmm-watcher-repair',
            watcherId: watcher.watcher_id,
            targetIdentity: watcher.target_identity,
          },
          sha256Verified,
        });

        return {
          ok: true,
          entry: {
            cid,
            requestId: pinRow.request_id,
            kuboPinned: verified.kuboPinned,
            reachable: verified.reachable,
            sizeBytes,
            sha256Hex: sha256Hex || null,
            sha256MatchesOnChain: verified.sha256Matches,
          },
        };
      } catch (err) {
        return { ok: false, entry: { cid, reason: err.message || 'Kubo pin/verify failed' } };
      }
    }

    // Bounded concurrency like kuboPinMany: one slow CID must not stall repair.
    const repairEntries = [...byCid.entries()];
    for (let i = 0; i < repairEntries.length; i += 8) {
      const batch = repairEntries.slice(i, i + 8);
      const results = await Promise.allSettled(batch.map(([cid, ref]) => repairOneCid(cid, ref)));
      results.forEach((r, j) => {
        if (r.status === 'fulfilled' && r.value.ok) repaired.push(r.value.entry);
        else if (r.status === 'fulfilled') failed.push(r.value.entry);
        else failed.push({ cid: batch[j][0], reason: String(r.reason?.message || r.reason).slice(0, 160) });
      });
    }

    const now = new Date().toISOString();
    const discoveredCids = [...byCid.keys()];
    const syncSummary = {
      blockHeight: rootContent?.blockheight || 0,
      totalCmmKeys: Object.keys(rootCmm).length,
      discoveredCids,
      pinnedCount: repaired.length,
    };

    db.prepare(
      `UPDATE cmm_watchers
       SET pins_discovered = ?, last_synced_at = ?, last_result_json = ?
       WHERE watcher_id = ?`
    ).run(discoveredCids.length, now, JSON.stringify(syncSummary), watcher.watcher_id);

    writeAuditLog({
      iAddress: req.tenant.i_address,
      actorType: req.authType || 'tenant',
      action: 'watcher.repair',
      targetId: watcher.watcher_id,
      details: { repairedCount: repaired.length, failedCount: failed.length },
      ipAddress: req.ip,
    });

    dispatchWebhook(req.tenant.i_address, 'watcher.repaired', {
      watcherId: watcher.watcher_id,
      targetIdentity: watcher.target_identity,
      targetIAddress: watcher.target_i_address,
      repairedCount: repaired.length,
      failedCount: failed.length,
      repairedCids: repaired.map((r) => r.cid),
    });

    res.json({
      ok: true,
      watcherId: watcher.watcher_id,
      targetIdentity: watcher.target_identity,
      repairedCount: repaired.length,
      failedCount: failed.length,
      repaired,
      failed,
    });
  } catch (err) {
    console.error('[watcher repair] failed:', err.message);
    res.status(500).json({ error: 'Watcher repair failed' });
  }
});

router.delete('/watchers/:watcherId', authenticate(), (req, res) => {
  const db = getDb();
  const watcher = db
    .prepare('SELECT * FROM cmm_watchers WHERE watcher_id = ? AND i_address = ?')
    .get(req.params.watcherId, req.tenant.i_address);
  if (!watcher) {
    return res.status(404).json({ error: 'Watcher not found' });
  }
  db.prepare('DELETE FROM cmm_watchers WHERE watcher_id = ? AND i_address = ?').run(
    watcher.watcher_id,
    req.tenant.i_address
  );
  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'tenant',
    action: 'watcher.delete',
    targetId: watcher.watcher_id,
    details: { targetIdentity: watcher.target_identity },
    ipAddress: req.ip,
  });
  res.json({ ok: true, watcherId: watcher.watcher_id });
});

// Resolve standard Verus URLRef values in an identity's CMM and report local pin status.
router.get('/resolve/:identity', authenticate('pin:read'), async (req, res) => {
  try {
    const identityInfo = await getIdentity(req.params.identity);
    const identityAddress = identityInfo?.identity?.identityaddress;
    if (!identityAddress) {
      return res.status(404).json({ error: `VerusID '${req.params.identity}' was not found` });
    }

    let vdxfKey = String(req.query.vdxf || '').trim();
    if (vdxfKey.includes('::')) {
      const resolved = await getVdxfId(vdxfKey);
      vdxfKey = resolved?.vdxfid || '';
      if (!vdxfKey) return res.status(400).json({ error: 'Verus daemon could not resolve the VDXF URI' });
    }

    const content = await getIdentityContent(identityAddress, vdxfKey);
    const contentmultimap = content?.identity?.contentmultimap || {};
    const references = getCmmCidReferences(contentmultimap);
    const dataDescriptors = extractDataDescriptorsFromCmm(contentmultimap);
    const pinStatuses = await getCidPinStatuses(references.map((reference) => reference.cid).filter(Boolean));

    res.json({
      identity: {
        name: identityInfo.fullyqualifiedname || req.params.identity,
        iAddress: identityAddress,
      },
      blockHeight: content?.blockheight || identityInfo.blockheight || null,
      vdxfKey: vdxfKey || null,
      dataDescriptors,
      references: references.map((reference) => ({
        ...reference,
        pinStatus: reference.cid ? pinStatuses[reference.cid]?.pinStatus : 'NOT_IPFS',
        pinned: reference.cid ? pinStatuses[reference.cid]?.pinned : null,
        gatewayUrl: reference.cid ? `${config.publicGatewayUrl}/ipfs/${reference.cid}` : null,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Verus identity resolution failed' });
  }
});

// GET /v1/resolve/:identity/content — Resolve a VerusID's latest CID under `?vdxf=` and redirect (`302`) to the edge gateway
router.get('/resolve/:identity/content', async (req, res) => {
  try {
    const identityInfo = await getIdentity(req.params.identity);
    const identityAddress = identityInfo?.identity?.identityaddress;
    if (!identityAddress) {
      return res.status(404).json({ error: `VerusID '${req.params.identity}' was not found` });
    }

    let vdxfKey = String(req.query.vdxf || '').trim();
    if (vdxfKey.includes('::')) {
      const resolved = await getVdxfId(vdxfKey);
      vdxfKey = resolved?.vdxfid || '';
      if (!vdxfKey) {
        return res.status(400).json({ error: 'Verus daemon could not resolve the VDXF URI' });
      }
    }

    const content = await getIdentityContent(identityAddress, vdxfKey);
    const contentmultimap = content?.identity?.contentmultimap || {};
    const references = getCmmCidReferences(contentmultimap).filter((r) => Boolean(r.cid));
    if (references.length === 0) {
      return res.status(404).json({
        error: `No IPFS CID reference found on '${identityInfo.fullyqualifiedname || req.params.identity}'${vdxfKey ? ` for VDXF key ${vdxfKey}` : ''}`,
      });
    }

    const latestRef = references[references.length - 1];
    const cid = latestRef.cid;
    const db = getDb();
    const blocked = db.prepare('SELECT * FROM blocked_cids WHERE cid = ?').get(cid);
    if (blocked) {
      return res.status(451).json({
        error: {
          reason: 'UNAVAILABLE_FOR_LEGAL_REASONS',
          details: `CID blocked under ${blocked.legislation}: ${blocked.reason}`,
        },
      });
    }

    const blockHeight = content?.blockheight || identityInfo.blockheight || 0;
    const gatewayUrl = `${config.publicGatewayUrl}/ipfs/${cid}`;
    res.setHeader('ETag', `"${identityAddress}:${blockHeight}:${cid}"`);
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.setHeader('X-Verus-Identity', identityAddress);
    res.setHeader('X-Verus-Block-Height', String(blockHeight));
    res.setHeader('X-Ipfs-Cid', cid);
    if (latestRef.datahash) {
      res.setHeader('X-Verus-DataHash-Sha256', latestRef.datahash);
    }

    if (String(req.query.format || '').toLowerCase() === 'json') {
      return res.json({
        identity: {
          name: identityInfo.fullyqualifiedname || req.params.identity,
          iAddress: identityAddress,
        },
        blockHeight,
        vdxfKey: vdxfKey || latestRef.vdxfKey || null,
        cid,
        datahash: latestRef.datahash || null,
        dataDescriptor: latestRef.dataDescriptor || null,
        gatewayUrl,
      });
    }

    const mode = String(req.query.mode || 'redirect').toLowerCase();
    if (mode === 'stream' || mode === 'proxy') {
      const upstreamHeaders = {};
      if (req.headers.range) upstreamHeaders.Range = req.headers.range;
      const gwRes = await fetch(`${config.kuboGatewayUrl}/ipfs/${encodeURIComponent(cid)}`, {
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(60000),
      });
      if (!gwRes.ok || !gwRes.body) {
        return res.status(502).json({
          error: `Kubo gateway returned HTTP ${gwRes.status} for CID ${cid}`,
        });
      }
      const contentType =
        latestRef.dataDescriptor?.mimeType ||
        gwRes.headers.get('content-type') ||
        'application/octet-stream';
      res.status(gwRes.status);
      res.setHeader('Content-Type', contentType);
      const contentLength = gwRes.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      const contentRange = gwRes.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      const acceptRanges = gwRes.headers.get('accept-ranges');
      if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
      if (latestRef.dataDescriptor?.label) {
        const safeLabel = String(latestRef.dataDescriptor.label).replace(/[^\x20-\x7e]|["\\]/g, '_');
        res.setHeader('Content-Disposition', `inline; filename="${safeLabel}"`);
      }
      Readable.fromWeb(gwRes.body).pipe(res);
      return;
    }

    return res.redirect(302, gatewayUrl);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Verus identity content resolution failed' });
  }
});

// ── 7. UK Commercial Billing (GBP + 20% UK VAT + VerusPay On-Chain Invoices) ──
router.get('/billing/invoices', authenticate(), (req, res) => {
  const db = getDb();
  const invoices = db
    .prepare('SELECT * FROM invoices WHERE i_address = ? ORDER BY created_at DESC')
    .all(req.tenant.i_address);
  res.json({
    ukCompany: config.ukCompany,
    invoices,
  });
});

router.post('/billing/checkout', authenticate(), (req, res) => {
  const { planId, paymentRail = 'veruspay' } = req.body || {};
  const plan = config.PLANS[planId];
  if (!plan) {
    return res.status(400).json({ error: 'Invalid planId (choose builder, indie, or studio)' });
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (plan.priceGbpPence === 0) {
    db.prepare('UPDATE tenants SET plan_id = ?, updated_at = ? WHERE i_address = ?').run(
      plan.id,
      now,
      req.tenant.i_address
    );
    return res.json({
      upgraded: true,
      plan,
      invoice: null,
    });
  }

  const subtotalPence = plan.priceGbpPence;
  const vatRate = config.ukCompany.vatRate; // 20% UK VAT
  const vatPence = Math.round(subtotalPence * vatRate);
  const totalPence = subtotalPence + vatPence;
  const spotRateGbp = config.gbpPerVrscRate;
  const amountVrsc = Number((totalPence / 100 / spotRateGbp).toFixed(4));

  const invoiceId = `inv_${crypto.randomBytes(8).toString('hex')}`;
  const datePart = now.slice(0, 10).replace(/-/g, '');
  const seq = String(Math.floor(1000 + Math.random() * 9000));
  const invoiceNumber = `UK-SVP-${datePart}-${seq}`;
  const veruspayMemo = `SOVPIN:${invoiceNumber}:${req.tenant.i_address}`;

  db.prepare(
    `INSERT INTO invoices (
      invoice_id, invoice_number, i_address, plan_id, payment_rail,
      subtotal_gbp_pence, vat_rate, vat_gbp_pence, total_gbp_pence,
      vrsc_spot_gbp, amount_vrsc, receiving_identity, veruspay_memo, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(
    invoiceId,
    invoiceNumber,
    req.tenant.i_address,
    plan.id,
    paymentRail,
    subtotalPence,
    vatRate,
    vatPence,
    totalPence,
    spotRateGbp,
    amountVrsc,
    config.sovpinReceivingIdentity,
    veruspayMemo,
    now
  );

  const invoice = db.prepare('SELECT * FROM invoices WHERE invoice_id = ?').get(invoiceId);
  const sendcurrencyCli = `verus -chain=${config.verusChain} sendcurrency "*" '[{"address":"${config.sovpinReceivingIdentity}","amount":${amountVrsc},"memo":"${veruspayMemo}"}]'`;

  res.status(201).json({
    invoice,
    ukTaxSummary: {
      supplier: config.ukCompany.legalName,
      jurisdiction: config.ukCompany.jurisdiction,
      subtotalGbp: `£${(subtotalPence / 100).toFixed(2)}`,
      vat20Gbp: `£${(vatPence / 100).toFixed(2)}`,
      totalIncVatGbp: `£${(totalPence / 100).toFixed(2)}`,
      hmrcSpotRateNote: `1 VRSC = £${spotRateGbp.toFixed(2)} GBP at invoice timestamp (${now})`,
    },
    verusPayInstructions: {
      receivingIdentity: config.sovpinReceivingIdentity,
      amountVrsc,
      chain: config.verusChain,
      memo: veruspayMemo,
      sendcurrencyCli,
    },
  });
});

// Settle invoice (supports on-chain txid verification on VRSCTEST or Stripe GBP / instant Testnet settlement)
router.post('/billing/invoices/:invoiceId/settle', authenticate(), async (req, res) => {
  try {
    const db = getDb();
    const invoice = db
      .prepare('SELECT * FROM invoices WHERE invoice_id = ? AND i_address = ?')
      .get(req.params.invoiceId, req.tenant.i_address);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (invoice.status === 'paid') {
      return res.json({ invoice, alreadyPaid: true });
    }

    let settledTxid = String(req.body?.txid || '').trim();
    if (settledTxid) {
      // Verify the transaction exists on the live VRSCTEST daemon if a real 64-hex txid is passed
      if (/^[0-9a-fA-F]{64}$/.test(settledTxid)) {
        try {
          await getTransaction(settledTxid);
        } catch {
          // If not in local wallet, allow raw txid format on testnet
        }
      }
    } else {
      settledTxid =
        invoice.payment_rail === 'stripe_gbp'
          ? `stripe_gbp_pi_${crypto.randomBytes(12).toString('hex')}`
          : `vrsctest_tx_${crypto.randomBytes(16).toString('hex')}`;
    }

    const now = new Date().toISOString();
    db.prepare(`UPDATE invoices SET status = 'paid', txid = ?, paid_at = ? WHERE invoice_id = ?`).run(
      settledTxid,
      now,
      invoice.invoice_id
    );
    db.prepare('UPDATE tenants SET plan_id = ?, updated_at = ? WHERE i_address = ?').run(
      invoice.plan_id,
      now,
      req.tenant.i_address
    );

    const updatedInvoice = db
      .prepare('SELECT * FROM invoices WHERE invoice_id = ?')
      .get(invoice.invoice_id);
    const updatedTenant = db
      .prepare('SELECT * FROM tenants WHERE i_address = ?')
      .get(req.tenant.i_address);

    res.json({
      invoice: updatedInvoice,
      tenant: updatedTenant,
      plan: config.PLANS[updatedTenant.plan_id],
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to settle invoice' });
  }
});

// ── 8. UK Online Safety Act & Takedown Compliance (CID Denylist) ─────────────
router.get('/compliance/status', (req, res) => {
  const db = getDb();
  const blocked = db.prepare('SELECT cid, reason, legislation, created_at FROM blocked_cids ORDER BY created_at DESC').all();
  res.json({
    ukCompany: config.ukCompany,
    frameworks: [
      'UK Online Safety Act 2023 (Notice & Takedown + Hash Blocking)',
      'UK GDPR & Data Protection Act 2018 (ICO Micro-Entity Compliant)',
      'UK Consumer Contracts & DMCC Act (Transparent GBP + VAT Pricing & 1-Click Cancel)',
      'HMRC Cryptoasset Manual CRYPTO21000 (GBP Spot Valuation at Receipt Timestamp)',
    ],
    blockedCidCount: blocked.length,
    blockedCids: blocked,
  });
});

router.post('/compliance/takedown', authenticate(), async (req, res) => {
  const cid = String(req.body?.cid || '').trim();
  const reason = String(req.body?.reason || 'Reported violation of UK Terms of Service').trim();
  if (!cid || !/^[A-Za-z0-9]+$/.test(cid)) {
    return res.status(400).json({ error: 'Valid IPFS CID is required' });
  }

  const db = getDb();
  const isAdmin =
    config.adminIdentities.includes(req.tenant.i_address) ||
    config.adminIdentities.includes(req.tenant.friendly_name);
  const ownsPin = Boolean(
    db
      .prepare('SELECT request_id FROM pins WHERE cid = ? AND i_address = ?')
      .get(cid, req.tenant.i_address)
  );
  if (!isAdmin && !ownsPin) {
    return res.status(403).json({
      error: 'Only platform administrators or the tenant who pinned this CID can execute a statutory takedown',
    });
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO blocked_cids (cid, reason, reporter_identity, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(cid, reason, req.tenant.friendly_name, now);

  db.prepare(`UPDATE pins SET status = 'blocked_uk_osa', unpinned_at = ? WHERE cid = ?`).run(
    now,
    cid
  );
  await kuboPinRm(cid);

  writeAuditLog({
    iAddress: req.tenant.i_address,
    actorType: req.authType || 'tenant',
    action: 'compliance.takedown',
    targetId: cid,
    details: { reason },
    ipAddress: req.ip,
  });

  res.status(201).json({
    ok: true,
    cid,
    status: 451,
    message: 'CID added to UK OSA denylist and unpinned from Kubo storage node.',
  });
});

// ── CMM Traversal Tree (Visual Structure) ──────────────────────────────────
// Returns the full 2-level traversal tree for a watcher so the UI can render
// the data flow: target identity → sub-identities → IPFS CIDs.
router.get('/watchers/:watcherId/traversal', authenticate(), async (req, res) => {
  try {
    const db = getDb();
    const watcher = db
      .prepare('SELECT * FROM cmm_watchers WHERE watcher_id = ? AND i_address = ?')
      .get(req.params.watcherId, req.tenant.i_address);
    if (!watcher) {
      return res.status(404).json({ error: 'Watcher not found' });
    }

    const { getIdentity, getIdentityContent } = require('./verus-rpc');
    const root = {
      iAddress: watcher.target_i_address,
      name: watcher.target_identity,
      type: 'registry',
      cmmKeys: [],
      children: [],
      cids: [],
      cidReferences: [],
    };

    // Level 0: target identity's CMM
    const rootContent = await getIdentityContent(watcher.target_i_address);
    const rootCmm = rootContent?.identity?.contentmultimap || {};
    root.cmmKeys = Object.keys(rootCmm);
    root.blockHeight = rootContent?.blockheight;

    // Decode standard serialized URLRefs while retaining support for existing CID-only CMM data.
    root.cidReferences = getCmmCidReferences(rootCmm);
    root.dataDescriptors = extractDataDescriptorsFromCmm(rootCmm);
    root.cids = [...new Set(root.cidReferences.map((reference) => reference.cid).filter(Boolean))];

    // Level 1: sub-identities from hex-encoded entries
    const subIds = new Set();
    const serialized = JSON.stringify(rootCmm);
    const hexRegex = /\b[0-9a-fA-F]{40,}\b/g;
    let hm;
    while ((hm = hexRegex.exec(serialized)) !== null) {
      try {
        const decoded = Buffer.from(hm[0], 'hex').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed.i === 'string' && parsed.i.startsWith('i')) {
          subIds.add(parsed.i);
        }
      } catch {}
    }

    // For each sub-identity, get its CMM and extract CIDs
    for (const subId of subIds) {
      const child = {
        iAddress: subId,
        name: null,
        type: 'sub-identity',
        cmmKeys: [],
        cids: [],
        cidReferences: [],
        children: [],
      };
      try {
        const subContent = await getIdentityContent(subId);
        child.name = subContent?.fullyqualifiedname || subId;
        const subCmm = subContent?.identity?.contentmultimap || {};
        child.cmmKeys = Object.keys(subCmm);
        child.blockHeight = subContent?.blockheight;
        child.cidReferences = getCmmCidReferences(subCmm);
        child.dataDescriptors = extractDataDescriptorsFromCmm(subCmm);
        child.cids = [...new Set(child.cidReferences.map((reference) => reference.cid).filter(Boolean))];
      } catch {
        child.name = subId;
        child.error = 'Could not resolve identity';
      }
      root.children.push(child);
    }

    const cidReferences = [
      ...root.cids,
      ...root.children.flatMap((child) => child.cids),
    ];
    const pinStatuses = await getCidPinStatuses(cidReferences);
    const attachStatus = (reference) => ({
      ...reference,
      ...(reference.cid ? pinStatuses[reference.cid] : { pinned: null, pinStatus: 'NOT_IPFS' }),
      gatewayUrl: reference.cid ? `${config.publicGatewayUrl}/ipfs/${reference.cid}` : null,
    });
    root.cidReferences = root.cidReferences.map(attachStatus);
    for (const child of root.children) {
      child.cidReferences = child.cidReferences.map(attachStatus);
    }

    res.json({
      watcherId: watcher.watcher_id,
      targetIdentity: watcher.target_identity,
      targetIAddress: watcher.target_i_address,
      traversal: root,
      totalSubIdentities: subIds.size,
      totalCidReferences: cidReferences.length,
      totalCids: new Set(cidReferences).size,
    });
  } catch (err) {
    console.error('[traversal] failed:', err.message);
    res.status(500).json({ error: 'Traversal failed' });
  }
});

// ── Stripe UK Webhook Handler (GBP Billing) ────────────────────────────────
// Handles checkout.session.completed and invoice.paid events from Stripe UK.
function verifyStripeWebhookSignature(rawPayload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((part) => part.trim().split('='))
      .filter((pair) => pair.length === 2)
  );
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${rawPayload}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
  } catch {
    return false;
  }
}

router.post('/billing/stripe-webhook', async (req, res) => {
  try {
    if (!config.stripeWebhookSecret) {
      return res.status(503).json({ error: 'Stripe webhook not configured' });
    }
    const sigHeader = req.get('stripe-signature') || '';
    const rawPayload = req.rawBody || JSON.stringify(req.body || {});
    if (!verifyStripeWebhookSignature(rawPayload, sigHeader, config.stripeWebhookSecret)) {
      return res.status(401).json({ error: 'Invalid Stripe webhook signature' });
    }
    const event = req.body;
    if (!event || !event.type) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    const db = getDb();

    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object;
      const invoiceId = session?.metadata?.sovpin_invoice_id;
      if (invoiceId) {
        const invoice = db.prepare('SELECT * FROM invoices WHERE invoice_id = ?').get(invoiceId);
        if (invoice && invoice.status !== 'paid') {
          const now = new Date().toISOString();
          db.prepare(`UPDATE invoices SET status = 'paid', txid = ?, paid_at = ? WHERE invoice_id = ?`).run(
            session.payment_intent || `stripe_pi_${crypto.randomBytes(8).toString('hex')}`,
            now,
            invoiceId
          );
          db.prepare('UPDATE tenants SET plan_id = ?, updated_at = ? WHERE i_address = ?').run(
            invoice.plan_id,
            now,
            invoice.i_address
          );
          console.log(`[Stripe Webhook] Invoice ${invoice.invoice_number} settled via Stripe UK for ${invoice.i_address}`);
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── Shared block-driven watcher sync ─────────────────────────────────────────
// Used by POST /v1/internal/blocknotify (verusd -blocknotify) and by the
// dashboard's own block poller (the chain node lives in an internal-only
// docker network, so the daemon cannot push to this host; the poller calls
// the same core with trigger 'block-poll').
async function syncWatchersForBlock({ blockHeight = 0, blockHash = '', trigger = 'blocknotify' } = {}) {
  const cleanHash = String(blockHash || '').trim();
  const db = getDb();
  const watchers = db
    .prepare("SELECT watcher_id, target_i_address, i_address FROM cmm_watchers WHERE status = 'active'")
    .all();

  if (watchers.length === 0) {
    return { ok: true, blockHeight, blockHash: cleanHash || null, watchersChecked: 0, synced: 0, results: [] };
  }

  let syncedCount = 0;
  const results = [];

  for (const w of watchers) {
    try {
      const cmmContent = await getIdentityContent(w.target_i_address);
      const discoveredCids = await discoverCidsFromCmm(w.target_i_address);
      const { pinnedCount, failedCids } = await kuboPinMany(discoveredCids);

      const now = new Date().toISOString();
      const syncSummary = {
        blockHeight: cmmContent?.blockheight || blockHeight,
        totalCmmKeys: Object.keys(cmmContent?.identity?.contentmultimap || {}).length,
        discoveredCids,
        pinnedCount,
        failedPins: failedCids,
        trigger,
        blockHash: cleanHash || null,
      };

      db.prepare(
        `UPDATE cmm_watchers
         SET pins_discovered = ?, last_synced_at = ?, last_result_json = ?
         WHERE watcher_id = ?`
      ).run(discoveredCids.length, now, JSON.stringify(syncSummary), w.watcher_id);

      // Dispatch webhook for watcher.synced
      dispatchWebhook(w.i_address, 'watcher.synced', {
        watcherId: w.watcher_id,
        targetIAddress: w.target_i_address,
        discoveredCids,
        pinnedCount,
        blockHeight: cmmContent?.blockheight || blockHeight,
        trigger,
      });

      syncedCount++;
      results.push({ watcherId: w.watcher_id, ok: true, cids: discoveredCids.length });
    } catch (err) {
      results.push({ watcherId: w.watcher_id, ok: false, error: err.message });
    }
  }

  return {
    ok: true,
    blockHeight,
    blockHash: cleanHash || null,
    watchersChecked: watchers.length,
    synced: syncedCount,
    results,
  };
}

// ── Internal: Block-Driven Watcher Sync (for verusd -blocknotify) ────────────
// POST /v1/internal/blocknotify?blockHeight=<height>&blockHash=<hash>
// Called by verusd -blocknotify to trigger immediate CMM watcher syncs.
router.post('/internal/blocknotify', async (req, res) => {
  const blockHeight = Number(req.query?.blockHeight || req.body?.blockHeight || 0);
  const blockHash = String(req.query?.blockHash || req.body?.blockHash || '').trim();

  // The dashboard sits behind a Cloudflare Tunnel that connects over loopback,
  // so every public request also arrives as 127.0.0.1 — loopback alone proves
  // nothing. When a secret is configured it is required on EVERY request,
  // loopback included. With no secret configured (local dev only), loopback
  // is allowed and anything else is rejected.
  const configuredSecret = process.env.SOVPIN_INTERNAL_SECRET || '';
  if (!configuredSecret) {
    // In production, refuse to run without a secret.
    if ((process.env.NODE_ENV || 'production') !== 'development') {
      return res.status(503).json({ error: 'Internal endpoint not configured' });
    }
    const isLoopback = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    if (!isLoopback) return res.status(403).json({ error: 'Internal endpoint — loopback required' });
    return res.json(await syncWatchersForBlock({ blockHeight, blockHash, trigger: 'blocknotify' }));
  }
  const provided = req.get('x-sovpin-internal-secret') || '';
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(configuredSecret));
  } catch {
    ok = false;
  }
  if (!ok) return res.status(403).json({ error: 'Internal endpoint — valid secret required' });

  res.json(await syncWatchersForBlock({ blockHeight, blockHash, trigger: 'blocknotify' }));
});

router.runWatcherBlockSync = syncWatchersForBlock;

router.sweepExpiredState = () => {
  try {
    const db = getDb();
    const nowMs = Date.now();
    db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(nowMs);
    db.prepare('DELETE FROM login_consent_sessions WHERE expires_at < ?').run(nowMs);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowMs);

    const expiredUploads = db
      .prepare(`SELECT upload_id FROM chunked_uploads WHERE status = 'open' AND expires_at < ?`)
      .all(nowMs);
    for (const row of expiredUploads) {
      db.prepare(`UPDATE chunked_uploads SET status = 'expired' WHERE upload_id = ?`).run(
        row.upload_id
      );
      try {
        fs.rmSync(getChunkedUploadDir(row.upload_id), { recursive: true, force: true });
      } catch {}
    }
  } catch {}
};

router.runCmmAutoSync = async () => {
  router.sweepExpiredState();
  const db = getDb();
  const watchers = db
    .prepare("SELECT watcher_id, target_i_address FROM cmm_watchers WHERE status = 'active'")
    .all();
  if (watchers.length === 0) return;

  for (const w of watchers) {
    try {
      const cmmContent = await getIdentityContent(w.target_i_address);
      const cmmMap = cmmContent?.identity?.contentmultimap || {};
      const discoveredCids = await discoverCidsFromCmm(w.target_i_address);
      const { pinnedCount, failedCids } = await kuboPinMany(discoveredCids);
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE cmm_watchers SET pins_discovered = ?, last_synced_at = ?, last_result_json = ? WHERE watcher_id = ?'
      ).run(
        discoveredCids.length,
        now,
        JSON.stringify({
          blockHeight: cmmContent?.blockheight || 0,
          totalCmmKeys: Object.keys(cmmMap).length,
          discoveredCids,
          pinnedCount,
          failedPins: failedCids,
          trigger: 'auto-sync',
        }),
        w.watcher_id
      );
    } catch (err) {
      console.error(`[CMM Auto-Sync] Failed for ${w.watcher_id}:`, err.message);
    }
  }
};

module.exports = router;
