const express = require('express');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const TAILSCALE_IP = '100.66.85.86';
const TUNNEL_ID = '990fae36-b92b-457b-af17-5737ed2d8a35';
const RULESET_ID = '2e7849d6314246df8346142659b21066';
const ZONE = 'sovpin.com';

app.use(express.static(path.join(__dirname, 'public')));

function runCmd(cmd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}

function kuboRpc(endpoint, method = 'POST') {
  return runCmd(`curl -sf -X ${method} -m 5 "http://${TAILSCALE_IP}:5001${endpoint}"`, 8000);
}

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
      const lines = pinResult.stdout.trim().split('\n').filter(Boolean);
      pinCount = lines.length;
    } catch { /* ignore */ }
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

// ── Cloudflare ────────────────────────────────────────────────────
app.get('/api/cloudflare', async (req, res) => {
  const [tunnel, cacheRuleset, rulesets] = await Promise.all([
    runCmd(`/home/demon/.local/bin/cf tunnels config get ${TUNNEL_ID}`, 10000),
    runCmd(`/home/demon/.local/bin/cf rulesets get ${RULESET_ID} -z ${ZONE}`, 10000),
    runCmd(`/home/demon/.local/bin/cf rulesets list -z ${ZONE}`, 10000),
  ]);

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
    runCmd('tailscale status --json', 5000),
    runCmd(`ssh -i /home/demon/.ssh/vreal_mirror_ed25519 -o ConnectTimeout=5 macbook@192.168.86.110 'uptime; free -m | head -n 2; df -h / | tail -n 1'`, 10000),
  ]);

  let tsData = {};
  try { tsData = JSON.parse(tsStatus.stdout); } catch { /* ignore */ }

  const peers = tsData.Peer || {};
  // MacBook registers as hostname "debian" on Tailscale (its OS hostname).
  // Identify it by its known Tailscale IP (100.66.85.86), not by name.
  const macbook = Object.values(peers).find(p =>
    (p.TailscaleIPs || []).includes('100.66.85.86')
  );
  // Dev machine is the Self (also named "debian" but different IP)
  const selfIps = tsData.Self?.TailscaleIPs || [];

  // Parse SSH output for system info
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

// ── Composite Health ──────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const [kubo, cf, ts] = await Promise.all([
    new Promise((resolve) => {
      kuboRpc('/api/v0/version').then(r => {
        let v = {};
        try { v = JSON.parse(r.stdout); } catch { /* ignore */ }
        resolve({ online: r.ok, version: v.Version });
      });
    }),
    runCmd(`/home/demon/.local/bin/cf tunnels config get ${TUNNEL_ID}`, 8000),
    runCmd('tailscale status --json', 5000),
  ]);

  res.json({
    healthy: kubo.online && cf.ok && ts.ok,
    kubo: kubo.online,
    cloudflare: cf.ok,
    tailscale: ts.ok,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`SovPin Dashboard running at http://127.0.0.1:${PORT}`);
});