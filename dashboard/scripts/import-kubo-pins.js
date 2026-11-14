const config = require('../src/config');
const { getDb } = require('../src/db');
const { getVdxfId } = require('../src/verus-rpc');
const crypto = require('crypto');

const TAILSCALE_IP = config.tailscaleIp;
const KUBO_RPC = `http://${TAILSCALE_IP}:5001`;

async function kuboRpc(endpoint, method = 'POST') {
  const res = await fetch(`${KUBO_RPC}${endpoint}`, { method, signal: AbortSignal.timeout(10000) });
  return res;
}

async function main() {
  const db = getDb();
  const iAddress = 'iEmX7PJUtAwp1a1xxrPi215G7FMxwVr5XX';
  const friendlyName = 'vreal.VRSCTEST@';

  // Ensure tenant exists
  const tenant = db.prepare('SELECT * FROM tenants WHERE i_address = ?').get(iAddress);
  if (!tenant) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tenants (i_address, friendly_name, primary_address, plan_id, created_at, updated_at)
       VALUES (?, ?, ?, 'builder', ?, ?)`
    ).run(iAddress, friendlyName, 'RS7rjHn4MPjFGmo2k8rULJV38TJrK7pnC1', now, now);
    console.log('Created tenant for', friendlyName);
  }

  // Fetch Kubo pin list
  const pinRes = await kuboRpc('/api/v0/pin/ls?type=recursive');
  const pinData = await pinRes.json();
  const cids = Object.keys(pinData.Keys || {});
  const vdxfUri = 'sovpin::storage.pin.descriptor';
  const vdxfId = (await getVdxfId(vdxfUri))?.vdxfid;
  if (!vdxfId) throw new Error(`Verus daemon did not resolve VDXF URI: ${vdxfUri}`);
  console.log(`Found ${cids.length} pinned CIDs on Kubo`);

  let imported = 0;
  let skipped = 0;
  for (const cid of cids) {
    // Check if already tracked
    const existing = db.prepare('SELECT request_id FROM pins WHERE cid = ? AND i_address = ?').get(cid, iAddress);
    if (existing) {
      skipped++;
      continue;
    }

    // Fetch from Kubo gateway for exact byte length, MIME type, and verified SHA-256
    let sizeBytes = 0;
    let mimeType = 'application/octet-stream';
    let sha256Hex = crypto.createHash('sha256').update(cid).digest('hex');
    let sha256Verified = 0;
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
      try {
        const statRes = await kuboRpc(`/api/v0/block/stat?arg=${encodeURIComponent(cid)}`);
        const statData = await statRes.json();
        sizeBytes = Number(statData.Size || 0);
      } catch {}
    }

    // Get pin type
    const pinType = pinData.Keys[cid]?.Type || 'recursive';

    const requestId = `pin_${crypto.randomBytes(10).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO pins (request_id, i_address, cid, name, mime_type, size_bytes, sha256_hex, vdxf_uri, vdxf_id, meta_json, sha256_verified, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pinned', ?)`
    ).run(
      requestId,
      iAddress,
      cid,
      `kubo-imported-${cid.slice(0, 12)}`,
      mimeType,
      sizeBytes,
      sha256Hex,
      vdxfUri,
      vdxfId,
      JSON.stringify({ source: 'kubo-import', pinType }),
      sha256Verified,
      now
    );
    imported++;
  }

  console.log(`Imported: ${imported}, Skipped (already tracked): ${skipped}`);
  console.log(`Total pins in DB for ${friendlyName}: ${db.prepare('SELECT COUNT(*) as c FROM pins WHERE i_address = ?').get(iAddress).c}`);
}

main().catch(console.error);
