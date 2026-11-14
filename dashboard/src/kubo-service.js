const config = require('./config');
const crypto = require('node:crypto');
const { buildUrlRefCmmValue } = require('./verus-storage');
const { Readable } = require('node:stream');

async function replicatePinToSecondaryNodes(cid) {
  const replicas = Array.isArray(config.kuboReplicaUrls) ? config.kuboReplicaUrls : [];
  if (replicas.length === 0) return [];
  const results = await Promise.all(
    replicas.map(async (replicaUrl) => {
      try {
        const res = await fetch(
          `${replicaUrl.replace(/\/+$/, '')}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&recursive=true`,
          { method: 'POST', signal: AbortSignal.timeout(30000) }
        );
        return { replicaUrl, ok: res.ok };
      } catch {
        return { replicaUrl, ok: false };
      }
    })
  );
  return results;
}

async function kuboAddBuffer(fileBuffer, filename = 'file.bin') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(fileBuffer)]), filename);

  const res = await fetch(
    `${config.kuboRpcUrl}/api/v0/add?pin=true&wrap-with-directory=false&cid-version=0`,
    {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Kubo add failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data || typeof data.Hash !== 'string') {
    throw new Error('Kubo add returned no CID Hash');
  }

  await replicatePinToSecondaryNodes(data.Hash);

  return {
    cid: data.Hash,
    sizeBytes: fileBuffer.length,
    kuboSizeBytes: Number(data.Size || fileBuffer.length),
  };
}

async function kuboAddStream(fileStream, filename = 'file.bin', mimeType = 'application/octet-stream', signal) {
  const boundary = `----sovpin-${crypto.randomBytes(18).toString('hex')}`;
  const safeFilename = String(filename).replace(/[^\x20-\x7e]|["\\\r\n]/g, '_').slice(0, 180) || 'file.bin';
  const safeMimeType = /^[\w.+-]+\/[\w.+-]+$/.test(String(mimeType))
    ? mimeType
    : 'application/octet-stream';

  async function* multipartBody() {
    yield Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${safeMimeType}\r\n\r\n`,
      'utf8'
    );
    for await (const chunk of fileStream) yield chunk;
    yield Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  }

  const body = Readable.from(multipartBody());
  const uploadTimeout = AbortSignal.timeout(15 * 60 * 1000);
  const requestSignal = signal ? AbortSignal.any([signal, uploadTimeout]) : uploadTimeout;
  const res = await fetch(
    `${config.kuboRpcUrl}/api/v0/add?pin=true&wrap-with-directory=false&cid-version=0`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: 'half',
      signal: requestSignal,
    }
  );

  const responseText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Kubo streaming add failed (${res.status}): ${responseText.slice(0, 240)}`);
  }

  let addResult = null;
  for (const line of responseText.split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      if (typeof item.Hash === 'string') addResult = item;
    } catch {
      // Kubo emits newline-delimited JSON for add; ignore non-JSON progress lines.
    }
  }
  if (!addResult) throw new Error('Kubo streaming add returned no CID Hash');
  await replicatePinToSecondaryNodes(addResult.Hash);
  return { cid: addResult.Hash, kuboSizeBytes: Number(addResult.Size || 0) };
}

async function kuboPinAdd(cid) {
  const res = await fetch(
    `${config.kuboRpcUrl}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&recursive=true`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Kubo pin/add failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  await replicatePinToSecondaryNodes(cid);
  return res.json();
}

async function kuboPinRm(cid) {
  const res = await fetch(
    `${config.kuboRpcUrl}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}&recursive=true`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    }
  );
  const replicas = Array.isArray(config.kuboReplicaUrls) ? config.kuboReplicaUrls : [];
  if (replicas.length > 0) {
    await Promise.all(
      replicas.map((replicaUrl) =>
        fetch(
          `${replicaUrl.replace(/\/+$/, '')}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}&recursive=true`,
          { method: 'POST', signal: AbortSignal.timeout(15000) }
        ).catch(() => null)
      )
    );
  }
  if (!res.ok) {
    return false;
  }
  return true;
}

async function kuboBlockStat(cid) {
  const res = await fetch(
    `${config.kuboRpcUrl}/api/v0/block/stat?arg=${encodeURIComponent(cid)}`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) return null;
  return res.json();
}

async function kuboListRecursivePins() {
  const res = await fetch(`${config.kuboRpcUrl}/api/v0/pin/ls?type=recursive`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Kubo pin/ls failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return new Set(Object.keys(data.Keys || {}));
}

async function kuboVerifyCid(cid, expectedSizeBytes = null, expectedSha256Hex = null) {
  const pinnedSet = await kuboListRecursivePins().catch(() => new Set());
  const kuboPinned = pinnedSet.has(cid);
  const res = await fetch(`${config.kuboGatewayUrl}/ipfs/${encodeURIComponent(cid)}`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok || !res.body) {
    return {
      kuboPinned,
      reachable: false,
      actualSizeBytes: null,
      actualSha256Hex: null,
      sizeMatches: false,
      sha256Matches: false,
    };
  }
  const hash = crypto.createHash('sha256');
  let actualSizeBytes = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    actualSizeBytes += buf.length;
    hash.update(buf);
  }
  const actualSha256Hex = hash.digest('hex');
  const sizeMatches =
    expectedSizeBytes === null || expectedSizeBytes === undefined
      ? true
      : actualSizeBytes === Number(expectedSizeBytes);
  const sha256Matches =
    !expectedSha256Hex
      ? true
      : actualSha256Hex.toLowerCase() === String(expectedSha256Hex).toLowerCase();

  return {
    kuboPinned,
    reachable: true,
    actualSizeBytes,
    actualSha256Hex,
    sizeMatches,
    sha256Matches,
  };
}

async function kuboRepoGc() {
  const res = await fetch(`${config.kuboRpcUrl}/api/v0/repo/gc?silent=true`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) return { ok: false, reclaimedBlocks: 0 };
  const text = await res.text().catch(() => '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  return { ok: true, reclaimedBlocks: lines.length };
}

function buildVdxfDescriptor({
  cid,
  sha256Hex,
  vdxfUri,
  vdxfId,
  identityName,
  label,
  mimeType,
  contentHashVerified = false,
}) {
  const gatewayUrl = `${config.publicGatewayUrl}/ipfs/${cid}`;
  if (!vdxfId) throw new Error('Resolve the VDXF URI with getvdxfid before building the CMM payload');
  const effectiveVdxfId = vdxfId;
  const urlRefEntry = buildUrlRefCmmValue({
    url: gatewayUrl,
    sha256Hex: contentHashVerified ? sha256Hex : undefined,
    label,
    mimeType,
  });
  const dataDescriptor = urlRefEntry.dataDescriptor;

  const targetIdentity = identityName || 'yourid@';
  const cleanName = targetIdentity.replace(/@$/, '');

  const cmmUpdatePayload = {
    name: cleanName,
    contentmultimap: {
      [effectiveVdxfId]: [{ serializedhex: urlRefEntry.serializedhex }],
    },
  };

  const cliCommand = `verus -chain=${config.verusChain} updateidentity '${JSON.stringify(cmmUpdatePayload)}'`;

  const signdataCommand = contentHashVerified ? `verus -chain=${config.verusChain} signdata '${JSON.stringify({
    address: targetIdentity,
    datahash: sha256Hex,
    vdxfkeys: [effectiveVdxfId],
  })}'` : null;

  return {
    cid,
    gatewayUrl,
    sha256Hex: contentHashVerified ? sha256Hex : null,
    vdxfUri: vdxfUri || 'sovpin::storage.pin.descriptor',
    vdxfId: effectiveVdxfId,
    dataDescriptor,
    serializedhex: urlRefEntry.serializedhex,
    urlRef: urlRefEntry.urlRef,
    cmmUpdatePayload,
    cliCommand,
    signdataCommand,
  };
}

module.exports = {
  kuboAddBuffer,
  kuboAddStream,
  kuboPinAdd,
  kuboPinRm,
  kuboBlockStat,
  kuboListRecursivePins,
  kuboVerifyCid,
  kuboRepoGc,
  buildVdxfDescriptor,
};
