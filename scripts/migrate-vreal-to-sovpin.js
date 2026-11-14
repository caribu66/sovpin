/**
 * VREAL → SovPin Verus Standard Migration Script
 *
 * Reads a VREAL NFT identity's ContentMultiMap (CMM), extracts IPFS CIDs from
 * VREAL's JSON-in-DataDescriptor format, uploads them to SovPin, and generates
 * the Verus-standard DataDescriptor(CrossChainDataRef(URLRef)) serializedhex
 * for each media reference.
 *
 * Usage:
 *   node scripts/migrate-vreal-to-sovpin.js <nft-identity-name> [--dry-run]
 *
 * Example:
 *   node scripts/migrate-vreal-to-sovpin.js img_fesmmw3nbmne_000_25b1c6ad4c1246c7.vreal@
 *
 * Environment:
 *   SOVPIN_API_URL    SovPin API base URL (default: http://127.0.0.1:3001)
 *   SOVPIN_API_KEY    SovPin API key (svp_live_...) with pin:write scope
 *   VERUS_RPC_HOST    Verus daemon RPC host (default: 192.168.86.110)
 *   VERUS_RPC_PORT    Verus daemon RPC port (default: 25779)
 *   VERUS_RPC_USER    Verus daemon RPC user (default: test)
 *   VERUS_RPC_PASSWORD Verus daemon RPC password (default: test)
 */

const VERUS_RPC_HOST = process.env.VERUS_RPC_HOST || '192.168.86.110';
const VERUS_RPC_PORT = process.env.VERUS_RPC_PORT || '25779';
const VERUS_RPC_USER = process.env.VERUS_RPC_USER || 'test';
const VERUS_RPC_PASSWORD = process.env.VERUS_RPC_PASSWORD || 'test';
const SOVPIN_API_URL = process.env.SOVPIN_API_URL || 'http://127.0.0.1:3001';
const SOVPIN_API_KEY = process.env.SOVPIN_API_KEY || '';
const SOVPIN_SESSION_TOKEN = process.env.SOVPIN_SESSION_TOKEN || '';

const DRY_RUN = process.argv.includes('--dry-run');

async function verusRpc(method, params) {
  const url = `http://${VERUS_RPC_HOST}:${VERUS_RPC_PORT}/`;
  const auth = Buffer.from(`${VERUS_RPC_USER}:${VERUS_RPC_PASSWORD}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'migration', method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function sovpinApi(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (SOVPIN_API_KEY) headers['Authorization'] = `Bearer ${SOVPIN_API_KEY}`;
  else if (SOVPIN_SESSION_TOKEN) headers['Authorization'] = `Bearer ${SOVPIN_SESSION_TOKEN}`;
  const res = await fetch(`${SOVPIN_API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.details || data?.error || `HTTP ${res.status}`);
  return data;
}

async function migrateIdentity(identityName) {
  console.log(`\n=== Migrating ${identityName} ===\n`);

  // 1. Get identity info
  const idInfo = await verusRpc('getidentity', [identityName]);
  const iAddress = idInfo?.identity?.identityaddress;
  if (!iAddress) throw new Error(`Identity ${identityName} not found`);
  console.log(`i-address: ${iAddress}`);
  console.log(`Block height: ${idInfo.blockheight}`);

  // 2. Get CMM content
  const content = await verusRpc('getidentitycontent', [iAddress]);
  const cmm = content?.identity?.contentmultimap || {};
  console.log(`CMM keys: ${Object.keys(cmm).length}`);

  // 3. Extract VREAL's media references
  const mediaRefs = [];
  for (const [vdxfKey, entries] of Object.entries(cmm)) {
    const entryList = Array.isArray(entries) ? entries : [entries];
    for (const entry of entryList) {
      if (!entry || typeof entry !== 'object') continue;
      const dd = entry.i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv || entry;
      if (!dd || !dd.objectdata) continue;

      try {
        const objectText = Buffer.from(dd.objectdata, 'hex').toString('utf8');
        const parsed = JSON.parse(objectText);
        if (parsed && typeof parsed.uri === 'string') {
          const cidMatch = parsed.uri.match(/\b(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{50,})\b/);
          if (cidMatch) {
            mediaRefs.push({
              vdxfKey,
              label: dd.label || 'unknown',
              mimeType: dd.mimetype || 'application/octet-stream',
              cid: cidMatch[1],
              originalUri: parsed.uri,
              metadata: parsed,
            });
          }
        }
      } catch {
        // Not JSON or no uri field — skip
      }
    }
  }

  console.log(`\nFound ${mediaRefs.length} media references:`);
  for (const ref of mediaRefs) {
    console.log(`  - ${ref.label}: ${ref.cid} (${ref.mimeType})`);
    if (ref.metadata.title) console.log(`    Title: ${ref.metadata.title}`);
    if (ref.metadata.width) console.log(`    Size: ${ref.metadata.width}x${ref.metadata.height}`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes made. Remove --dry-run to execute migration.');
    return;
  }

  if (!SOVPIN_API_KEY && !SOVPIN_SESSION_TOKEN) {
    console.error('\nError: SOVPIN_API_KEY or SOVPIN_SESSION_TOKEN is required.');
    process.exit(1);
  }

  // 4. Upload each CID to SovPin
  console.log('\n--- Uploading to SovPin ---\n');
  const migrated = [];
  for (const ref of mediaRefs) {
    try {
      console.log(`Pinning ${ref.cid} (${ref.label})...`);
      const result = await sovpinApi('POST', '/v1/pins', {
        cid: ref.cid,
        name: ref.label || ref.cid.slice(0, 12),
        vdxfUri: 'vreal::nft.asset.media',
      });
      migrated.push({
        ...ref,
        sovpinRequestId: result.requestid,
        sovpinCid: result.pin.cid,
        sovpinSha256: result.info.sha256,
        serializedhex: result.verus_vdxf?.cmmUpdatePayload?.contentmultimap
          ? Object.values(result.verus_vdxf.cmmUpdatePayload.contentmultimap)[0]?.[0]?.serializedhex
          : null,
        gatewayUrl: result.info.gateway_url,
      });
      console.log(`  ✓ Pinned: ${result.requestid} (SHA-256: ${result.info.sha256 || 'N/A'})`);
    } catch (err) {
      console.log(`  ✗ Failed: ${err.message}`);
      migrated.push({ ...ref, error: err.message });
    }
  }

  // 5. Summary
  console.log('\n=== Migration Summary ===\n');
  const successful = migrated.filter((m) => !m.error);
  const failed = migrated.filter((m) => m.error);
  console.log(`Total media references: ${mediaRefs.length}`);
  console.log(`Successfully migrated: ${successful.length}`);
  console.log(`Failed: ${failed.length}`);

  if (successful.length > 0) {
    console.log('\n--- New CMM entries (Verus standard format) ---\n');
    for (const m of successful) {
      console.log(`${m.label} (${m.vdxfKey}):`);
      console.log(`  Old: DataDescriptor JSON with uri: ${m.originalUri}`);
      console.log(`  New: DataDescriptor(CrossChainDataRef(URLRef)) with SHA-256: ${m.sovpinSha256 || 'N/A'}`);
      console.log(`  SovPin request: ${m.sovpinRequestId}`);
      console.log(`  Gateway: ${m.gatewayUrl}`);
      console.log(`  Serialized hex: ${m.serializedhex?.slice(0, 80)}...`);
      console.log();
    }
  }

  if (failed.length > 0) {
    console.log('\n--- Failed migrations ---\n');
    for (const m of failed) {
      console.log(`  ${m.label} (${m.cid}): ${m.error}`);
    }
  }

  console.log('\n--- Next Steps ---\n');
  console.log('1. Review the migration results above');
  console.log('2. For each successful migration, submit an updateidentity transaction');
  console.log('   to replace the VREAL JSON entry with the SovPin serializedhex');
  console.log('3. Update VREAL mint flow to use SovPin (see docs/VREAL_MIGRATION.md)');
  console.log('4. Run SovPin watcher repair to verify all CIDs are pinned');
}

// Main
const identityName = process.argv[2];
if (!identityName) {
  console.error('Usage: node migrate-vreal-to-sovpin.js <identity-name> [--dry-run]');
  console.error('Example: node migrate-vreal-to-sovpin.js img_fesmmw3nbmne_000_25b1c6ad4c1246c7.vreal@');
  process.exit(1);
}

migrateIdentity(identityName).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});