const config = require('./config');

let idCounter = 1;
const vdxfIdCache = new Map();
let cachedDaemonInfo = null;
let cachedDaemonInfoAt = 0;

async function verusRpcOnce(method, params = [], timeoutMs = 12000) {
  const url = `http://${config.verusRpcHost}:${config.verusRpcPort}/`;
  const auth = Buffer.from(`${config.verusRpcUser}:${config.verusRpcPassword}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      jsonrpc: '1.0',
      id: `sovpin-${idCounter++}`,
      method,
      params,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Verus daemon (${res.status}): ${text.slice(0, 180)}`);
  }

  if (parsed.error) {
    const err = new Error(parsed.error.message || 'Verus RPC error');
    err.code = parsed.error.code;
    throw err;
  }

  return parsed.result;
}

async function verusRpc(method, params = [], timeoutMs = 12000) {
  try {
    return await verusRpcOnce(method, params, timeoutMs);
  } catch (err) {
    // Do not retry application-level RPC errors (where err.code is set by verusd)
    if (err && err.code !== undefined) throw err;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return verusRpcOnce(method, params, timeoutMs);
  }
}

async function getDaemonInfo() {
  const now = Date.now();
  if (cachedDaemonInfo && now - cachedDaemonInfoAt < 3000) {
    return cachedDaemonInfo;
  }
  try {
    const info = await verusRpc('getinfo', [], 8000);
    cachedDaemonInfo = info;
    cachedDaemonInfoAt = Date.now();
    return info;
  } catch (err) {
    if (cachedDaemonInfo && Date.now() - cachedDaemonInfoAt < 30000) {
      return cachedDaemonInfo;
    }
    throw err;
  }
}

async function getIdentity(nameOrIAddress) {
  return verusRpc('getidentity', [nameOrIAddress]);
}

async function getIdentityContent(nameOrIAddress, vdxfKey = '') {
  const args = vdxfKey
    ? [nameOrIAddress, 0, 0, false, 0, vdxfKey]
    : [nameOrIAddress];
  return verusRpc('getidentitycontent', args);
}

async function getVdxfId(vdxfUri) {
  const key = String(vdxfUri || '').trim();
  if (key && vdxfIdCache.has(key)) {
    return vdxfIdCache.get(key);
  }
  const res = await verusRpc('getvdxfid', [vdxfUri]);
  if (key && res?.vdxfid) {
    vdxfIdCache.set(key, res);
  }
  return res;
}

async function verifySignature({ address, message, signature, checklatest = true }) {
  return verusRpc('verifysignature', [
    {
      address,
      message,
      signature,
      checklatest,
    },
  ]);
}

async function signData({ address, message, datahash, vdxfkeys }) {
  const payload = { address };
  if (message !== undefined) payload.message = message;
  if (datahash !== undefined) payload.datahash = datahash;
  if (vdxfkeys !== undefined) payload.vdxfkeys = vdxfkeys;
  return verusRpc('signdata', [payload]);
}

async function getTransaction(txid) {
  return verusRpc('gettransaction', [txid, true]);
}

async function getRawTransaction(txid, verbose = 1) {
  return verusRpc('getrawtransaction', [txid, verbose]);
}

module.exports = {
  verusRpc,
  getDaemonInfo,
  getIdentity,
  getIdentityContent,
  getVdxfId,
  verifySignature,
  signData,
  getTransaction,
  getRawTransaction,
};
