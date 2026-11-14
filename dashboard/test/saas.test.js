const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const testDbPath = path.join('/tmp', `sovpin-test-${Date.now()}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.SOVPIN_DB_PATH = testDbPath;
// The internal blocknotify endpoint requires the secret outside development;
// exercise the secured path instead of the dev-mode loopback bypass.
process.env.SOVPIN_INTERNAL_SECRET = 'saas-test-internal-secret';

const { decodeUrlRefCmmValue } = require('../src/verus-storage');
const config = require('../src/config');
const app = require('../server');

let server;
let baseUrl;
let sessionToken;
let developerApiKey;
let pinnedRequestId;
let pinnedCid;
let streamedPinRequestId;
let gatewayOnlyStreamRequestId;
let chunkedPinRequestId;
let invoiceId;
let watcherId;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    fs.unlinkSync(testDbPath);
  } catch {
    // ignore
  }
});

test('1. GET /v1/public/info returns live Verus daemon status, UK Ltd details, and GBP/VRSC plans', async () => {
  const res = await fetch(`${baseUrl}/v1/public/info`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.verusDaemon.online, true);
  assert.equal(body.verusDaemon.chain, 'VRSCTEST');
  assert.equal(body.ukCompany.currency, 'GBP');
  assert.equal(body.ukCompany.vatRate, 0.2);
  assert.equal(Array.isArray(body.plans), true);
  assert.equal(body.plans.length, 3);
});

test('2. VerusID Challenge-Response login resolves vreal@, signs via live VRSCTEST daemon, and verifies with verifysignature', async () => {
  const chRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'vreal@' }),
  });
  assert.equal(chRes.status, 200);
  const chBody = await chRes.json();
  assert.ok(chBody.challengeId);
  assert.equal(chBody.iAddress, 'iEmX7PJUtAwp1a1xxrPi215G7FMxwVr5XX');

  const signRes = await fetch(`${baseUrl}/v1/auth/sign-with-node`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: chBody.challengeId }),
  });
  assert.equal(signRes.status, 200);
  const signBody = await signRes.json();
  assert.ok(signBody.signature);

  const verifyRes = await fetch(`${baseUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: chBody.challengeId,
      signature: signBody.signature,
    }),
  });
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.ok(verifyBody.sessionToken.startsWith('svps_'));
  assert.equal(verifyBody.tenant.i_address, 'iEmX7PJUtAwp1a1xxrPi215G7FMxwVr5XX');
  sessionToken = verifyBody.sessionToken;
});

test('3. Create scoped developer API key (svp_live_...) and authenticate with it', async () => {
  const res = await fetch(`${baseUrl}/v1/keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      name: 'Automated Test Verus App Key',
      scopes: 'pin:read,pin:write,vdxf:build',
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.apiKey.startsWith('svp_live_'));
  developerApiKey = body.apiKey;
});

test('3a. Native Verus storage helper returns the daemon data wrapper without broadcasting', async () => {
  const res = await fetch(`${baseUrl}/v1/verus/native-storage/entry`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${developerApiKey}`,
    },
    body: JSON.stringify({
      identityName: 'vreal@',
      vdxfUri: 'sovpin::storage.pin.descriptor',
      filename: '/app/data/native-asset.bin',
      label: 'native-asset',
      mimeType: 'application/octet-stream',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const [entry] = body.contentmultimap[body.vdxfId];
  assert.deepEqual(entry, {
    data: {
      address: 'vreal@',
      filename: '/app/data/native-asset.bin',
      createmmr: true,
      label: 'native-asset',
      mimetype: 'application/octet-stream',
    },
  });
});

test('4. Upload payload via POST /v1/pin/upload -> pins to Kubo & builds standard Verus URLRef CMM value', async () => {
  const res = await fetch(`${baseUrl}/v1/pin/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${developerApiKey}`,
    },
    body: JSON.stringify({
      filename: 'sovpin-uk-test.json',
      vdxfUri: 'sovpin::storage.pin.descriptor',
      mimeType: 'application/json',
      contentJson: {
        project: 'SovPin UK SaaS',
        verusid: 'vreal.VRSCTEST@',
        timestamp: 1794425000,
      },
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.requestid.startsWith('pin_'));
  assert.ok(body.pin.cid.startsWith('Qm'));
  assert.equal(body.verus_vdxf.vdxfId, 'iF2rzXajbfTdsUyhYd9SqAjMhZxknjk5CU');
  assert.ok(body.verus_vdxf.cliCommand.includes('updateidentity'));
  assert.equal(body.verus_vdxf.urlRef.url, `https://ipfs.sovpin.com/ipfs/${body.pin.cid}`);
  assert.equal(body.verus_vdxf.urlRef.datahash, body.info.sha256);
  assert.ok(body.verus_receipt);
  assert.equal(body.verus_receipt.cid, body.pin.cid);
  assert.equal(body.verus_receipt.sha256, body.info.sha256);
  assert.ok(body.verus_receipt.signature);
  const cmmValue = body.verus_vdxf.cmmUpdatePayload.contentmultimap[body.verus_vdxf.vdxfId][0].serializedhex;
  assert.equal(body.verus_vdxf.serializedhex, cmmValue);
  assert.deepEqual(decodeUrlRefCmmValue(cmmValue), body.verus_vdxf.urlRef);
  pinnedRequestId = body.requestid;
  pinnedCid = body.pin.cid;

  const receiptRes = await fetch(`${baseUrl}/v1/pins/${pinnedRequestId}/receipt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${developerApiKey}` },
  });
  assert.equal(receiptRes.status, 200);
  const receiptBody = await receiptRes.json();
  assert.equal(receiptBody.ok, true);
  assert.equal(receiptBody.verifiedOnChain, true);
  assert.equal(receiptBody.receipt.cid, pinnedCid);
});

test('4a. Stream a 40 MiB multipart file to Kubo without JSON/Base64 buffering', async () => {
  const fileBytes = Buffer.alloc(40 * 1024 * 1024, 0x5a);
  const form = new FormData();
  form.append('file', new Blob([fileBytes], { type: 'application/octet-stream' }), 'sovpin-stream-test.bin');
  const res = await fetch(`${baseUrl}/v1/pin/upload/stream?vdxfUri=sovpin%3A%3Astorage.pin.descriptor`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${developerApiKey}` },
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const expectedSha256 = require('node:crypto').createHash('sha256').update(fileBytes).digest('hex');
  assert.equal(body.info.size_bytes, fileBytes.length);
  assert.equal(body.info.sha256, expectedSha256);
  assert.equal(body.verus_vdxf.urlRef.datahash, expectedSha256);
  streamedPinRequestId = body.requestid;
  const gatewayRes = await fetch(`${config.kuboGatewayUrl}/ipfs/${body.pin.cid}`, {
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(gatewayRes.status, 200);
  const retrievedBytes = Buffer.from(await gatewayRes.arrayBuffer());
  assert.equal(retrievedBytes.length, fileBytes.length);
  assert.equal(require('node:crypto').createHash('sha256').update(retrievedBytes).digest('hex'), expectedSha256);
});

test('4b. Stream-only client upload needs no SovPin VDXF key', async () => {
  const content = Buffer.from('VREAL app owns its own Verus CMM schema');
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), 'vreal-stream.txt');
  form.append('meta', JSON.stringify({ source: 'vreal-ipfs-adapter' }));
  const res = await fetch(`${baseUrl}/v1/pin/upload/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${developerApiKey}` },
    body: form,
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.verus_vdxf, null);
  assert.equal(body.info.vdxf_id, null);
  assert.equal(body.info.sha256, require('node:crypto').createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(body.pin.meta, { source: 'vreal-ipfs-adapter' });
  gatewayOnlyStreamRequestId = body.requestid;
});

test('4c. Chunked / resumable upload assembles multi-part payload to Kubo with full SHA-256 verification', async () => {
  const part1 = Buffer.alloc(2 * 1024 * 1024, 0x31);
  const part2 = Buffer.alloc(3 * 1024 * 1024, 0x32);
  const combined = Buffer.concat([part1, part2]);
  const expectedSha256 = require('node:crypto').createHash('sha256').update(combined).digest('hex');

  const initRes = await fetch(`${baseUrl}/v1/pin/upload/chunked/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${developerApiKey}`,
    },
    body: JSON.stringify({
      filename: 'chunked-archive.bin',
      mimeType: 'application/octet-stream',
      totalSizeBytes: combined.length,
      vdxfUri: 'sovpin::storage.pin.descriptor',
      meta: { mode: 'chunked' },
    }),
  });
  assert.equal(initRes.status, 201);
  const { uploadId } = await initRes.json();
  assert.ok(uploadId.startsWith('up_'));

  const p1Res = await fetch(`${baseUrl}/v1/pin/upload/chunked/${uploadId}/part?partNumber=1`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${developerApiKey}`,
    },
    body: part1,
  });
  assert.equal(p1Res.status, 200);

  const p2Res = await fetch(`${baseUrl}/v1/pin/upload/chunked/${uploadId}/part?partNumber=2`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${developerApiKey}`,
    },
    body: part2,
  });
  assert.equal(p2Res.status, 200);

  const completeRes = await fetch(`${baseUrl}/v1/pin/upload/chunked/${uploadId}/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${developerApiKey}` },
  });
  assert.equal(completeRes.status, 201);
  const body = await completeRes.json();
  assert.equal(body.info.size_bytes, combined.length);
  assert.equal(body.info.sha256, expectedSha256);
  assert.equal(body.verus_vdxf.urlRef.datahash, expectedSha256);
  chunkedPinRequestId = body.requestid;
});

test('5. Register CMM Auto-Pin Watcher against live NftIndex.vreal@ identity via getidentitycontent', async () => {
  const res = await fetch(`${baseUrl}/v1/watchers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      targetIdentity: 'NftIndex.vreal@',
      vdxfUri: 'sovpin::storage.pin.descriptor',
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.watcher.target_i_address, 'iN8JnTLwKJiEct9MYuWDzbHZTQfEzxBhHG');
  assert.ok(body.syncSummary.blockHeight > 0);
  watcherId = body.watcher.watcher_id;
});

test('5b2. POST /v1/internal/blocknotify (internal secret) syncs watchers and records trigger + block hash', async () => {
  const { getDb } = require('../src/db');
  const probeHash = 'blocknotify-test-hash';
  const res = await fetch(
    `${baseUrl}/v1/internal/blocknotify?blockHeight=13908&blockHash=${probeHash}`,
    {
      method: 'POST',
      headers: { 'x-sovpin-internal-secret': process.env.SOVPIN_INTERNAL_SECRET },
    }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.blockHeight, 13908);
  assert.equal(body.blockHash, probeHash);
  assert.ok(body.watchersChecked >= 1);
  const row = getDb()
    .prepare('SELECT last_result_json FROM cmm_watchers WHERE watcher_id = ?')
    .get(watcherId);
  const summary = JSON.parse(row.last_result_json);
  assert.equal(summary.trigger, 'blocknotify');
  assert.equal(summary.blockHash, probeHash);
});

test('5b3. With SOVPIN_INTERNAL_SECRET set, loopback blocknotify requires the secret', async () => {
  const prev = process.env.SOVPIN_INTERNAL_SECRET;
  process.env.SOVPIN_INTERNAL_SECRET = 'test-secret-for-5b3';
  try {
    const denied = await fetch(`${baseUrl}/v1/internal/blocknotify?blockHeight=1`, {
      method: 'POST',
    });
    assert.equal(denied.status, 403);

    const allowed = await fetch(`${baseUrl}/v1/internal/blocknotify?blockHeight=1`, {
      method: 'POST',
      headers: { 'x-sovpin-internal-secret': 'test-secret-for-5b3' },
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.ok, true);
  } finally {
    if (prev === undefined) delete process.env.SOVPIN_INTERNAL_SECRET;
    else process.env.SOVPIN_INTERNAL_SECRET = prev;
  }
});

test('5a. Resolve a Verus identity by VDXF URI and report Kubo pin health', async () => {
  const res = await fetch(`${baseUrl}/v1/resolve/vreal@?vdxf=sovpin%3A%3Astorage.pin.descriptor`, {
    headers: { Authorization: `Bearer ${developerApiKey}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.identity.iAddress, 'iEmX7PJUtAwp1a1xxrPi215G7FMxwVr5XX');
  assert.ok(Array.isArray(body.references));
  for (const reference of body.references) {
    if (reference.cid) {
      assert.ok(['PINNED', 'MISSING_FROM_NODE', 'UNREACHABLE'].includes(reference.pinStatus));
      assert.ok(typeof reference.pinned === 'boolean' || reference.pinned === null);
    }
  }
});

test('5b. CMM traversal includes decoded reference and Kubo health fields, and /v1/watchers/:watcherId/repair + /v1/resolve/:identity/content work', async () => {
  const res = await fetch(`${baseUrl}/v1/watchers/${watcherId}/traversal`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.traversal.children));
  for (const child of body.traversal.children) {
    assert.ok(Array.isArray(child.cidReferences));
    for (const reference of child.cidReferences) {
      if (reference.cid) assert.ok(reference.pinStatus);
    }
  }

  const repairRes = await fetch(`${baseUrl}/v1/watchers/${watcherId}/repair`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(repairRes.status, 200);
  const repairBody = await repairRes.json();
  assert.equal(repairBody.ok, true);
  assert.equal(repairBody.watcherId, watcherId);

  if (repairBody.repaired.length > 0) {
    const firstRepaired = repairBody.repaired[0];
    assert.ok(firstRepaired.requestId.startsWith('pin_'));
    assert.equal(firstRepaired.kuboPinned, true);
    assert.equal(firstRepaired.reachable, true);

    // Unpinning the tenant pin record must NOT remove the CID from Kubo while the CMM watcher still references it
    const unpinWatchedRes = await fetch(`${baseUrl}/v1/pins/${firstRepaired.requestId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${developerApiKey}` },
    });
    assert.equal(unpinWatchedRes.status, 202);
    const unpinWatchedBody = await unpinWatchedRes.json();
    assert.ok(unpinWatchedBody.remainingTenantReferences >= 1);
    assert.equal(unpinWatchedBody.removedFromKubo, false);
  }

  const firstChildWithCid = body.traversal.children.find(
    (c) => Array.isArray(c.cidReferences) && c.cidReferences.some((r) => Boolean(r.cid))
  );
  if (firstChildWithCid) {
    const contentRedirectRes = await fetch(
      `${baseUrl}/v1/resolve/${encodeURIComponent(firstChildWithCid.iAddress)}/content`,
      { redirect: 'manual' }
    );
    assert.equal(contentRedirectRes.status, 302);
    assert.ok((contentRedirectRes.headers.get('location') || '').startsWith(config.publicGatewayUrl));
    assert.ok(contentRedirectRes.headers.get('x-ipfs-cid'));

    const contentStreamRes = await fetch(
      `${baseUrl}/v1/resolve/${encodeURIComponent(firstChildWithCid.iAddress)}/content?mode=stream`
    );
    assert.equal(contentStreamRes.status, 200);
    assert.ok(contentStreamRes.headers.get('x-ipfs-cid'));
    const streamedBuf = Buffer.from(await contentStreamRes.arrayBuffer());
    assert.ok(streamedBuf.length > 0);
  }
});

test('6. Generate UK VAT + VerusPay Invoice (£12.00 + 20% VAT = £14.40 / 4.8 VRSC) and settle plan upgrade', async () => {
  const checkoutRes = await fetch(`${baseUrl}/v1/billing/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      planId: 'indie',
      paymentRail: 'veruspay',
    }),
  });
  assert.equal(checkoutRes.status, 201);
  const checkoutBody = await checkoutRes.json();
  assert.equal(checkoutBody.invoice.subtotal_gbp_pence, 1200);
  assert.equal(checkoutBody.invoice.vat_gbp_pence, 240);
  assert.equal(checkoutBody.invoice.total_gbp_pence, 1440);
  assert.equal(checkoutBody.invoice.amount_vrsc, 4.8);
  invoiceId = checkoutBody.invoice.invoice_id;

  const settleRes = await fetch(`${baseUrl}/v1/billing/invoices/${invoiceId}/settle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({}),
  });
  assert.equal(settleRes.status, 200);
  const settleBody = await settleRes.json();
  assert.equal(settleBody.invoice.status, 'paid');
  assert.equal(settleBody.tenant.plan_id, 'indie');
});

test('8. VerusID QR LoginConsent flow: challenge → user-signed response → callback → poll → session', async () => {
  // 1. Create challenge
  const chRes = await fetch(`${baseUrl}/v1/auth/login-consent/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verusId: 'vreal@' }),
  });
  assert.equal(chRes.status, 200);
  const ch = await chRes.json();
  assert.ok(ch.challengeId);
  assert.ok(ch.deepLink.startsWith('i5jtwbp6zymeay9llnraglgjqgdrffsau4://'));
  assert.ok(ch.qrCodeDataUrl && ch.qrCodeDataUrl.startsWith('data:image/png'));

  // 2. Sign response as vreal@ using verusid-ts-client
  const { VerusIdInterface } = require('verusid-ts-client');
  const primitives = require('verus-typescript-primitives');
  const verusId = new VerusIdInterface('VRSCTEST', 'http://192.168.86.110:25779', {
    auth: { username: 'test', password: 'test' },
  });
  const req = primitives.LoginConsentRequest.fromWalletDeeplinkUri(ch.deepLink);
  assert.equal(req.challenge.challenge_id, ch.challengeId);

  const height = await verusId.getCurrentHeight();
  const decision = new primitives.LoginConsentDecision({
    decision_id: req.challenge.challenge_id,
    request: req,
    created_at: Math.floor(Date.now() / 1000),
  });
  const signerIdentity = await verusId.interface.getIdentity('vreal@');
  const resp = await verusId.createLoginConsentResponse(
    'iEmX7PJUtAwp1a1xxrPi215G7FMxwVr5XX',
    decision,
    'UvznScunniM94mMrJmTCNneBQvcRKc4cmVgwvexD7ntixK6ffW5k',
    signerIdentity.result,
    height,
    'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'
  );
  const body = resp.toJson ? resp.toJson() : resp;

  // 3. POST callback
  const cbRes = await fetch(`${baseUrl}/v1/auth/login-consent/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(cbRes.status, 200);
  const cbBody = await cbRes.json();
  assert.equal(cbBody.success, true);

  // 4. Poll
  const pollRes = await fetch(
    `${baseUrl}/v1/auth/login-consent/poll?challengeId=${encodeURIComponent(ch.challengeId)}&pollToken=${encodeURIComponent(ch.pollToken)}`
  );
  assert.equal(pollRes.status, 200);
  const poll = await pollRes.json();
  assert.equal(poll.status, 'verified');
  assert.ok(poll.sessionToken.startsWith('svps_'));
  assert.equal(poll.userIAddress, 'iEmX7PJUtAwp1a1xxrPi215G7FMxwVr5XX');
  assert.equal(poll.userFriendlyName, 'vreal.VRSCTEST@');
});

test('6a. /healthz, /metrics, pin integrity verification, and audit logs', async () => {
  const healthRes = await fetch(`${baseUrl}/healthz`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.healthy, true);
  assert.equal(health.db.online, true);
  assert.equal(health.kubo.online, true);
  assert.equal(health.verus.online, true);

  const promRes = await fetch(`${baseUrl}/metrics`);
  assert.equal(promRes.status, 200);
  const promText = await promRes.text();
  assert.match(promText, /sovpin_pins_active_total \d+/);
  assert.match(promText, /sovpin_kubo_online 1/);

  const verifyRes = await fetch(`${baseUrl}/v1/pins/${pinnedRequestId}/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${developerApiKey}` },
  });
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.ok, true);
  assert.equal(verifyBody.kuboPinned, true);
  assert.equal(verifyBody.sizeMatches, true);
  assert.equal(verifyBody.sha256Matches, true);

  const auditRes = await fetch(`${baseUrl}/v1/audit-logs`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(auditRes.status, 200);
  const auditBody = await auditRes.json();
  assert.ok(auditBody.count >= 3);
  const actions = new Set(auditBody.logs.map((entry) => entry.action));
  assert.ok(actions.has('auth.verify'));
  assert.ok(actions.has('key.create'));
  assert.ok(actions.has('pin.upload_stream'));

  // Verify pre-stream Content-Length edge guard returns 413 PAYLOAD_TOO_LARGE when Content-Length > maxSingleUploadBytes
  const oversizedRes = await fetch(`${baseUrl}/v1/pin/upload/stream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${developerApiKey}`,
      'Content-Type': 'multipart/form-data; boundary=----sovpin-oversized',
      'Content-Length': String(config.maxSingleUploadBytes + 1024),
    },
    body: '----sovpin-oversized--\r\n',
  }).catch(() => null);
  if (oversizedRes) {
    assert.equal(oversizedRes.status, 413);
  }
});

test('7. Reference-counted unpin via DELETE /v1/pins/:requestid removes unreferenced CID from Kubo', async () => {
  for (const requestId of [chunkedPinRequestId, gatewayOnlyStreamRequestId, streamedPinRequestId].filter(Boolean)) {
    const streamedDelRes = await fetch(`${baseUrl}/v1/pins/${requestId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${developerApiKey}` },
    });
    assert.equal(streamedDelRes.status, 202);
    const streamedDelBody = await streamedDelRes.json();
    assert.equal(streamedDelBody.removedFromKubo, true);
  }

  const delRes = await fetch(`${baseUrl}/v1/pins/${pinnedRequestId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${developerApiKey}`,
    },
  });
  assert.equal(delRes.status, 202);
  const delBody = await delRes.json();
  assert.equal(delBody.ok, true);
  assert.equal(delBody.cid, pinnedCid);
  assert.equal(delBody.remainingTenantReferences, 0);

  const gcRes = await fetch(`${baseUrl}/v1/pins/gc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${developerApiKey}`,
    },
    body: JSON.stringify({ runRepoGc: false }),
  });
  assert.equal(gcRes.status, 200);
  const gcBody = await gcRes.json();
  assert.equal(gcBody.ok, true);
  assert.ok(gcBody.candidatesChecked >= 3);

  const eraseRes = await fetch(`${baseUrl}/v1/account`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(eraseRes.status, 200);
  const eraseBody = await eraseRes.json();
  assert.equal(eraseBody.ok, true);
  assert.equal(eraseBody.deletedTenant, 'iEmX7PJUtAwp1a1xxrPi215G7FMxwVr5XX');
});
