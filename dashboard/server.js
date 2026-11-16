try { process.loadEnvFile(); } catch (_) {}
const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const config = require('./src/config');
const saasRoutes = require('./src/saas-routes');
const { getDb, getSystemMetricsCounts } = require('./src/db');
const { getDaemonInfo, verusRpc } = require('./src/verus-rpc');

const app = express();
// Do not trust X-Forwarded-* headers by default; req.ip must reflect the direct peer.
// Loopback-only/admin protections use the socket peer address explicitly.
app.set('trust proxy', 1);

function getSocketIp(req) {
  return req.socket?.remoteAddress || req.connection?.remoteAddress || '';
}

function isGenuineLoopback(req) {
  const ip = getSocketIp(req);
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoopback) return false;
  // If forwarded through Cloudflare Tunnel or an external proxy, reject loopback claims:
  // external callers through cloudflared have 127.0.0.1 socket peer but carry edge headers.
  if (req.get('cf-connecting-ip') || req.get('cf-ray') || req.get('x-forwarded-for')) {
    return false;
  }
  return true;
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
function validateSensitiveConfig() {
  const isProduction = (process.env.NODE_ENV || 'production') === 'production';
  const missing = [];
  const weak = [];
  const warnings = [];

  if (!config.sovpinSignerWif) missing.push('SOVPIN_SIGNER_WIF');
  if (!config.verusRpcUser) missing.push('VERUS_RPC_USER');
  if (!config.verusRpcPassword) missing.push('VERUS_RPC_PASSWORD');
  if (config.verusRpcUser === 'test' || config.verusRpcPassword === 'test') {
    weak.push('VERUS_RPC_USER/PASSWORD must not use test defaults');
  }
  if (!config.sovpinInternalSecret) {
    missing.push('SOVPIN_INTERNAL_SECRET');
    warnings.push(
      'SOVPIN_INTERNAL_SECRET is not set: /v1/internal/blocknotify is disabled in production and loopback-only in development.'
    );
  }
  if (!config.stripeWebhookSecret) {
    warnings.push(
      'STRIPE_WEBHOOK_SECRET is not set: Stripe webhook settlement endpoint will reject requests (503) until configured.'
    );
  }

  const issues = [...missing.map((k) => `${k} is not set`), ...weak];
  if (issues.length === 0) {
    for (const w of warnings) console.warn(`[Security] ${w}`);
    return;
  }

  const prefix = '[Security] Sensitive configuration incomplete:';
  if (isProduction) {
    console.error(prefix);
    for (const issue of issues) console.error(`  - ${issue}`);
    for (const w of warnings) console.error(`  - ${w}`);
    console.error('Refusing to start in production. Set required secrets/integrations and restart.');
    process.exit(1);
  }

  console.warn(`${prefix} (development/test mode; continuing without enforcement)`);
  for (const issue of issues) console.warn(`  - ${issue}`);
  for (const w of warnings) console.warn(`  - ${w}`);
}

validateSensitiveConfig();
const PORT = config.port;
const TAILSCALE_IP = config.tailscaleIp;
const TUNNEL_ID = config.tunnelId;
const RULESET_ID = config.rulesetId;
const ZONE = config.zone;

app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => {
    // Only buffer raw body string for endpoints that require cryptographic signature verification (Stripe)
    if (req.originalUrl?.includes('stripe-webhook') || req.url?.includes('stripe-webhook')) {
      req.rawBody = buf.toString('utf8');
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Serve the production React frontend (sovpin/web/dist) at the root.
const webDist = path.join(__dirname, '..', 'web', 'dist');
const fs = require('node:fs');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
}
// Legacy /ops dashboard removed (stored-XSS surface); the React console in
// web/dist is the only UI. dashboard/public/ is deleted with it.

// Mount Verus-Native Commercial SaaS API v1
app.use('/v1', saasRoutes);

function runCmdArgs(file, args = [], timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}

function isSafeConfigToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value);
}

function kuboRpc(endpoint, method = 'POST') {
  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE']);
  const m = String(method || 'POST').toUpperCase();
  if (!allowedMethods.has(m)) throw new Error('Invalid HTTP method');
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) throw new Error('Invalid endpoint');
  // Only allow safe path characters (query strings permitted: all call
  // sites are hardcoded internal Kubo RPC paths, never user input).
  if (!/^\/[A-Za-z0-9_.\/?=&-]*$/.test(endpoint)) throw new Error('Invalid endpoint');
  return new Promise((resolve) => {
    execFile('curl', ['-sf', '-X', m, '-m', '5', `http://${TAILSCALE_IP}:5001${endpoint}`], { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}

// ── Guard: infrastructure endpoints are loopback-only (socket peer, not forwarded headers) ──────────────
function loopbackOnly(req, res, next) {
  if (isGenuineLoopback(req)) return next();
  return res.status(403).json({ error: 'Forbidden' });
}
app.use('/api', loopbackOnly);

// ── Kubo ──────────────────────────────────────────────────────────
app.get('/api/kubo', async (req, res) => {
  const [version, repo, peers, bw] = await Promise.all([
    kuboRpc('/api/v0/version'),
    kuboRpc('/api/v0/stats/repo'),
    kuboRpc('/api/v0/swarm/peers'),
    kuboRpc('/api/v0/stats/bw'),
  ]);

  let pinCount = 0;
  const pinResult = await kuboRpc('/api/v0/pin/ls?type=recursive');
  if (pinResult.ok) {
    try {
      const parsedPins = JSON.parse(pinResult.stdout);
      pinCount = parsedPins?.Keys ? Object.keys(parsedPins.Keys).length : 0;
    } catch {
      const lines = pinResult.stdout.trim().split('\n').filter(Boolean);
      pinCount = lines.length;
    }
  }

  let versionData = {};
  try { versionData = JSON.parse(version.stdout); } catch { /* ignore */ }

  let repoData = {};
  try { repoData = JSON.parse(repo.stdout); } catch { /* ignore */ }

  let peerCount = 0;
  try {
    const pd = JSON.parse(peers.stdout);
    peerCount = Array.isArray(pd.Peers) ? pd.Peers.length : 0;
  } catch { /* ignore */ }

  let bwData = {};
  try { bwData = JSON.parse(bw.stdout); } catch { /* ignore */ }

  res.json({
    online: version.ok,
    version: versionData.Version || null,
    commit: versionData.Commit || null,
    repoSize: repoData.RepoSize || 0,
    numObjects: repoData.NumObjects || 0,
    storageMax: repoData.StorageMax || 0,
    pinnedCids: pinCount,
    swarmPeers: peerCount,
    bandwidth: {
      totalIn: bwData.TotalIn || 0,
      totalOut: bwData.TotalOut || 0,
      rateIn: bwData.RateIn || 0,
      rateOut: bwData.RateOut || 0,
    },
  });
});

// ── Verus Daemon Status ───────────────────────────────────────────
app.get('/api/verus', async (req, res) => {
  try {
    const info = await getDaemonInfo();
    res.json({
      online: true,
      chain: info.name || config.verusChain,
      chainId: info.chainid,
      version: info.VRSCversion,
      blocks: info.blocks,
      longestchain: info.longestchain,
      connections: info.connections,
    });
  } catch (err) {
    res.json({
      online: false,
      chain: config.verusChain,
      error: err.message,
    });
  }
});

// ── Cloudflare ────────────────────────────────────────────────────
app.get('/api/cloudflare', async (req, res) => {
  const canQuery = isSafeConfigToken(TUNNEL_ID) && isSafeConfigToken(RULESET_ID) && isSafeConfigToken(ZONE);
  const [tunnel, cacheRuleset, rulesets] = canQuery
    ? await Promise.all([
        runCmdArgs(config.cfBin, ['tunnels', 'config', 'get', TUNNEL_ID], 10000),
        runCmdArgs(config.cfBin, ['rulesets', 'get', RULESET_ID, '-z', ZONE], 10000),
        runCmdArgs(config.cfBin, ['rulesets', 'list', '-z', ZONE], 10000),
      ])
    : [
        { ok: false, stdout: '', stderr: 'Invalid Cloudflare configuration tokens', code: 'EINVAL' },
        { ok: false, stdout: '', stderr: 'Invalid Cloudflare configuration tokens', code: 'EINVAL' },
        { ok: false, stdout: '', stderr: 'Invalid Cloudflare configuration tokens', code: 'EINVAL' },
      ];

  let tunnelData = {};
  try { tunnelData = JSON.parse(tunnel.stdout); } catch { /* ignore */ }

  let cacheData = {};
  try { cacheData = JSON.parse(cacheRuleset.stdout); } catch { /* ignore */ }

  let rateLimitExists = false;
  try {
    const rl = JSON.parse(rulesets.stdout);
    rateLimitExists = Array.isArray(rl) && rl.some(r => r.phase === 'http_ratelimit');
  } catch { /* ignore */ }

  const ingress = tunnelData?.config?.ingress || [];
  const sovpinRule = ingress.find(r => r.hostname === 'ipfs.sovpin.com');

  res.json({
    tunnel: {
      online: tunnel.ok,
      version: tunnelData.version || null,
      sovpinTarget: sovpinRule?.service || null,
      sovpinPath: sovpinRule?.path || null,
      totalRules: ingress.length,
    },
    cache: {
      online: cacheRuleset.ok,
      edgeTtl: cacheData?.rules?.[0]?.action_parameters?.edge_ttl?.mode || null,
      browserTtl: cacheData?.rules?.[0]?.action_parameters?.browser_ttl?.mode || null,
      cacheEnabled: cacheData?.rules?.[0]?.action_parameters?.cache || false,
    },
    rateLimit: {
      configured: rateLimitExists,
    },
  });
});

// ── Tailscale ─────────────────────────────────────────────────────
app.get('/api/tailscale', async (req, res) => {
  const [tsStatus, macbookSsh] = await Promise.all([
    runCmdArgs(config.tailscaleBin, ['status', '--json'], 5000),
    runCmdArgs(
      config.sshBin,
      [
        '-i',
        config.macbookSshKeyPath,
        '-o',
        'ConnectTimeout=5',
        '-o',
        'BatchMode=yes',
        config.macbookSshTarget,
        'uptime; free -m | head -n 2; df -h / | tail -n 1',
      ],
      10000
    ),
  ]);

  let tsData = {};
  try { tsData = JSON.parse(tsStatus.stdout); } catch { /* ignore */ }

  const peers = tsData.Peer || {};
  const macbook = Object.values(peers).find(p =>
    (p.TailscaleIPs || []).includes('100.66.85.86')
  );
  const selfIps = tsData.Self?.TailscaleIPs || [];

  let uptime = '';
  let memory = '';
  let disk = '';
  if (macbookSsh.ok) {
    const lines = macbookSsh.stdout.trim().split('\n');
    uptime = (lines[0] || '').trim();
    memory = (lines[2] || '').trim();
    disk = (lines[3] || '').trim();
  }

  res.json({
    online: tsStatus.ok,
    macbook: {
      online: macbook ? macbook.Online : false,
      ip: macbook ? (macbook.TailscaleIPs || [])[0] : '100.66.85.86',
      lastSeen: macbook ? macbook.LastSeen : null,
    },
    debian: {
      online: true,
      ip: selfIps[0] || '100.105.38.18',
    },
    system: {
      uptime,
      memory,
      disk,
    },
  });
});

// ── Composite Health & Readiness ──────────────────────────────────
async function evaluateCoreHealth() {
  let dbOnline = false;
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get();
    dbOnline = row?.ok === 1;
  } catch {
    dbOnline = false;
  }

  const [kubo, verus] = await Promise.all([
    kuboRpc('/api/v0/version').then((r) => {
      let v = {};
      try {
        v = JSON.parse(r.stdout);
      } catch {
        /* ignore */
      }
      return { online: r.ok, version: v.Version || null };
    }),
    getDaemonInfo()
      .then((info) => ({
        online: true,
        chain: info.name || config.verusChain,
        blocks: info.blocks || 0,
      }))
      .catch(() => ({ online: false, chain: config.verusChain, blocks: 0 })),
  ]);

  const healthy = dbOnline && kubo.online && verus.online;
  return {
    status: healthy ? 'ok' : 'degraded',
    healthy,
    db: { online: dbOnline },
    kubo,
    verus,
    inFlightUploads:
      typeof saasRoutes.getInFlightUploads === 'function' ? saasRoutes.getInFlightUploads() : 0,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

app.get(['/healthz', '/v1/healthz'], async (_req, res) => {
  const health = await evaluateCoreHealth();
  res.status(health.healthy ? 200 : 503).json(health);
});

app.get('/v1/metrics', loopbackOnly, async (_req, res) => {
  const [counts, health] = await Promise.all([
    Promise.resolve().then(() => getSystemMetricsCounts()),
    evaluateCoreHealth(),
  ]);
  res.json({
    ...counts,
    inFlightUploads: health.inFlightUploads,
    kuboOnline: health.kubo.online,
    verusOnline: health.verus.online,
    verusBlockHeight: health.verus.blocks,
    uptimeSeconds: health.uptimeSeconds,
    timestamp: health.timestamp,
  });
});

app.get('/metrics', loopbackOnly, async (_req, res) => {
  const [counts, health] = await Promise.all([
    Promise.resolve().then(() => getSystemMetricsCounts()),
    evaluateCoreHealth(),
  ]);
  const lines = [
    '# HELP sovpin_tenants_total Registered VerusID tenants',
    '# TYPE sovpin_tenants_total gauge',
    `sovpin_tenants_total ${counts.tenantsTotal}`,
    '# HELP sovpin_pins_active_total Active pinned objects across all tenants',
    '# TYPE sovpin_pins_active_total gauge',
    `sovpin_pins_active_total ${counts.pinsActiveTotal}`,
    '# HELP sovpin_pins_bytes_total Total bytes pinned across all active pins',
    '# TYPE sovpin_pins_bytes_total gauge',
    `sovpin_pins_bytes_total ${counts.pinsBytesTotal}`,
    '# HELP sovpin_pins_unpinned_total Historical unpinned records',
    '# TYPE sovpin_pins_unpinned_total gauge',
    `sovpin_pins_unpinned_total ${counts.pinsUnpinnedTotal}`,
    '# HELP sovpin_blocked_cids_total Blocked CIDs on UK OSA denylist',
    '# TYPE sovpin_blocked_cids_total gauge',
    `sovpin_blocked_cids_total ${counts.blockedCidsTotal}`,
    '# HELP sovpin_api_keys_active_total Active scoped developer API keys',
    '# TYPE sovpin_api_keys_active_total gauge',
    `sovpin_api_keys_active_total ${counts.apiKeysActiveTotal}`,
    '# HELP sovpin_watchers_active_total Active ContentMultiMap auto-pin watchers',
    '# TYPE sovpin_watchers_active_total gauge',
    `sovpin_watchers_active_total ${counts.watchersActiveTotal}`,
    '# HELP sovpin_uploads_in_flight Currently streaming uploads',
    '# TYPE sovpin_uploads_in_flight gauge',
    `sovpin_uploads_in_flight ${health.inFlightUploads}`,
    '# HELP sovpin_kubo_online Kubo IPFS RPC reachability (1 = online, 0 = offline)',
    '# TYPE sovpin_kubo_online gauge',
    `sovpin_kubo_online ${health.kubo.online ? 1 : 0}`,
    '# HELP sovpin_verus_online Verus daemon RPC reachability (1 = online, 0 = offline)',
    '# TYPE sovpin_verus_online gauge',
    `sovpin_verus_online ${health.verus.online ? 1 : 0}`,
    '# HELP sovpin_verus_block_height Current Verus chain block height',
    '# TYPE sovpin_verus_block_height gauge',
    `sovpin_verus_block_height ${health.verus.blocks}`,
    '# HELP sovpin_process_uptime_seconds Node process uptime in seconds',
    '# TYPE sovpin_process_uptime_seconds gauge',
    `sovpin_process_uptime_seconds ${health.uptimeSeconds}`,
  ];
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(`${lines.join('\n')}\n`);
});

app.get('/api/health', async (req, res) => {
  const cfCmd = isSafeConfigToken(TUNNEL_ID)
    ? runCmdArgs(config.cfBin, ['tunnels', 'config', 'get', TUNNEL_ID], 8000)
    : Promise.resolve({ ok: false, stdout: '', stderr: 'Invalid tunnel id', code: 'EINVAL' });
  const [kubo, cf, ts, verus] = await Promise.all([
    new Promise((resolve) => {
      kuboRpc('/api/v0/version').then(r => {
        let v = {};
        try { v = JSON.parse(r.stdout); } catch { /* ignore */ }
        resolve({ online: r.ok, version: v.Version });
      });
    }),
    cfCmd,
    runCmdArgs(config.tailscaleBin, ['status', '--json'], 5000),
    getDaemonInfo().then(info => ({ online: true, blocks: info.blocks })).catch(() => ({ online: false })),
  ]);

  res.json({
    healthy: kubo.online && cf.ok && ts.ok && verus.online,
    kubo: kubo.online,
    verus: verus.online,
    verusBlocks: verus.blocks || null,
    cloudflare: cf.ok,
    tailscale: ts.ok,
    timestamp: new Date().toISOString(),
  });
});

if (fs.existsSync(webDist)) {
  // SPA fallback for client-side routing (registered after all API, healthz, and metrics routes).
  // Missing hashed build assets under /assets/* must 404 instead of falling
  // through to index.html: a 200 text/html fallback for an asset URL gets
  // cached by the edge under that immutable URL and breaks lazy route chunks
  // (browsers reject it under Strict MIME checking for module scripts).
  app.get(/^\/(?!v1\/|api\/|healthz$|metrics$).*/, (req, res, next) => {
    if (req.path.startsWith('/assets/')) {
      return res.status(404).json({ error: 'ASSET_NOT_FOUND' });
    }
    const indexFile = path.join(webDist, 'index.html');
    if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
    next();
  });
}

// Global Express error handler: formats syntax errors (e.g. malformed JSON) and unexpected errors as structured JSON
app.use((err, _req, res, _next) => {
  const status = typeof err.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
  const reason = err.code || err.reason || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR');
  const details =
    status === 500 && (process.env.NODE_ENV || 'production') === 'production'
      ? 'An unexpected internal error occurred'
      : err.message || 'Request failed';
  res.status(status).json({ error: { reason, details } });
});

// ── CMM Auto-Sync & Expired State Poller ───────────────────────────────────
// Periodically sweeps expired challenges/sessions/uploads and syncs active CMM watchers.
const CMM_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
async function runCmmAutoSync() {
  if (typeof saasRoutes.runCmmAutoSync === 'function') {
    await saasRoutes.runCmmAutoSync();
  }
}
if (require.main === module) {
  const httpServer = app.listen(PORT, config.bindHost, () => {
    console.log(`SovPin SaaS & Ops Platform running at http://${config.bindHost}:${PORT}`);
  });
  // Sensitive config validation/warnings are emitted at startup (see validateSensitiveConfig).
  const cmmSyncTimer = setInterval(runCmmAutoSync, CMM_SYNC_INTERVAL_MS);
  console.log(`[CMM Auto-Sync] Poller started (interval: ${CMM_SYNC_INTERVAL_MS / 1000}s)`);

  // ── Block Poller (blocknotify equivalent) ─────────────────────────────────
  // The chain node lives in an internal-only docker network, so verusd
  // -blocknotify cannot push to this host. Poll getblockcount at a short
  // interval and run the same watcher-sync core the endpoint uses, so active
  // watchers still sync within seconds of each new block (not minutes).
  const BLOCK_POLL_INTERVAL_MS = 20 * 1000;
  let lastBlockPollHeight = 0;
  let blockPollInFlight = false;
  async function runBlockPoll() {
    if (blockPollInFlight) return;
    blockPollInFlight = true;
    try {
      const height = await verusRpc('getblockcount', [], 10000);
      if (typeof height === 'number' && height > lastBlockPollHeight) {
        lastBlockPollHeight = height;
        let blockHash = '';
        try {
          blockHash = await verusRpc('getblockhash', [height], 10000);
        } catch {
          // Hash is metadata only; sync by height when unavailable.
        }
        if (typeof saasRoutes.runWatcherBlockSync === 'function') {
          await saasRoutes.runWatcherBlockSync({
            blockHeight: height,
            blockHash: typeof blockHash === 'string' ? blockHash : '',
            trigger: 'block-poll',
          });
        }
      }
    } catch (err) {
      // Daemon unreachable or sync failed; the 5-minute auto-sync remains the
      // backstop. Log so a persistent failure is visible instead of silent.
      console.warn('[Block Poller] poll failed:', err instanceof Error ? err.message : String(err));
    } finally {
      blockPollInFlight = false;
    }
  }
  const blockPollTimer = setInterval(runBlockPoll, BLOCK_POLL_INTERVAL_MS);
  void runBlockPoll();
  console.log(`[Block Poller] Started (interval: ${BLOCK_POLL_INTERVAL_MS / 1000}s)`);

  let shuttingDown = false;
  const gracefulShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SovPin] Received ${signal}, draining in-flight uploads...`);
    clearInterval(cmmSyncTimer);
    clearInterval(blockPollTimer);
    httpServer.close(() => {
      console.log('[SovPin] HTTP server closed cleanly.');
      process.exit(0);
    });
    const drainCheck = setInterval(() => {
      const inFlight =
        typeof saasRoutes.getInFlightUploads === 'function' ? saasRoutes.getInFlightUploads() : 0;
      if (inFlight === 0) {
        clearInterval(drainCheck);
      }
    }, 250);
    setTimeout(() => {
      console.warn('[SovPin] Forced shutdown after 30s drain timeout.');
      process.exit(1);
    }, 30000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = app;
