import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../lib/useAuth';
import {
  useComplianceStatus,
  useKuboStats,
  useVerusStats,
  useCloudflareStats,
  useLedgerAuthGuard,
  useTakedown,
} from '../hooks/useLedger';
import { formatBytes } from '../lib/format';
import { CopyInline } from '../components/CopyInline';
import { Dialog } from '../components/Dialog';
import { ConfirmDialog, type PendingConfirm } from '../components/ConfirmDialog';

export default function CompliancePage() {
  const { account, activeApiKeySample } = useAuth();
  const [cid, setCid] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);

  const { data: compliance } = useComplianceStatus();
  const { data: kuboStats } = useKuboStats();
  const { data: verusStats } = useVerusStats();
  const { data: cfStats } = useCloudflareStats();
  const takedownMut = useTakedown();
  const blocked = compliance?.blockedCids || [];
  useLedgerAuthGuard([compliance]);

  useEffect(() => {
    if (notice && notice.tone !== 'error') {
      const timer = window.setTimeout(() => setNotice(null), 3000);
      return () => window.clearTimeout(timer);
    }
  }, [notice]);

  const askTakedown = () => {
    const targetCid = cid.trim();
    if (!targetCid) {
      setNotice({ text: 'Enter a CID to block.', tone: 'error' });
      return;
    }
    setConfirm({
      title: `Block CID ${targetCid.slice(0, 18)}…?`,
      body: 'The object is served HTTP 451, unpinned from Kubo, and added to the statutory denylist. State the legal basis in the reason field before confirming.',
      confirmLabel: 'Execute 451 block',
      busyLabel: 'Blocking…',
      onConfirm: async () => {
        setNotice(null);
        try {
          const r: any = await takedownMut.mutateAsync({ cid: targetCid, reason: reason.trim() });
          setNotice({ text: r.message, tone: 'success' });
          setCid('');
          setReason('');
          setConfirm(null);
        } catch (e: any) {
          setNotice({ text: e.message, tone: 'error' });
        }
      },
    });
  };

  const keyPlaceholder = activeApiKeySample || 'svp_live_YOUR_API_KEY';

  const endpointsDoc = [
    {
      method: 'POST',
      path: '/v1/pin/upload',
      scope: 'pin:write',
      desc: 'Compatibility endpoint for JSON and text uploads. Returns a standard Verus URLRef CMM payload.',
      sample: `curl -X POST https://dashboard.sovpin.com/v1/pin/upload \\
  -H "Authorization: Bearer ${keyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -d '{"filename":"nft-manifest.json","vdxfUri":"sovpin::storage.pin.descriptor","contentJson":{"verusid":"${account?.tenant?.friendly_name || 'vreal@'}"}}'`,
    },
    {
      method: 'POST',
      path: '/v1/pin/upload/stream?vdxfUri=<application-key>',
      scope: 'pin:write',
      desc: 'Streaming multipart upload for large files (up to 100 MiB single-request over Cloudflare edge). Streams the file to Kubo and returns a standard URLRef CMM payload without Base64 buffering.',
      sample: `curl -X POST 'https://dashboard.sovpin.com/v1/pin/upload/stream?vdxfUri=myapp%3A%3Aasset.media' \\
  -H "Authorization: Bearer ${keyPlaceholder}" \\
  -F 'file=@./large-asset.bin'`,
    },
    {
      method: 'POST',
      path: '/v1/pins/:requestid/verify',
      scope: 'pin:read',
      desc: 'Verify Kubo recursive pin status, gateway reachability, exact byte length, and SHA-256 integrity for a pinned object.',
      sample: `curl -X POST https://dashboard.sovpin.com/v1/pins/pin_0123456789abcdefabcd/verify \\
  -H "Authorization: Bearer ${keyPlaceholder}"`,
    },
    {
      method: 'POST',
      path: '/v1/pins/:requestid/receipt',
      scope: 'pin:read',
      desc: 'Issue or refresh a Verus-signed cryptographic storage attestation (sovpin.VRSCTEST@) committing to { tenantIAddress, cid, sha256, sizeBytes, blockHeight } and verify it via verifysignature.',
      sample: `curl -X POST https://dashboard.sovpin.com/v1/pins/pin_0123456789abcdefabcd/receipt \\
  -H "Authorization: Bearer ${keyPlaceholder}"`,
    },
    {
      method: 'GET',
      path: '/v1/resolve/:identity/content?vdxf=<uri>&mode=<redirect|stream>',
      scope: 'public',
      desc: 'Direct Content-Streaming Resolver: resolves a VerusID on-chain ContentMultiMap by VDXF key and either 302-redirects to the 1yr edge cache or streams the verified bytes (?mode=stream) with ETag + X-Verus-Block-Height headers.',
      sample: `curl -i "https://dashboard.sovpin.com/v1/resolve/vreal@/content?vdxf=sovpin::storage.pin.descriptor"`,
    },
    {
      method: 'POST',
      path: '/v1/watchers/:watcherId/repair',
      scope: 'pin:write',
      desc: 'One-click on-chain pin repair: traverses the watched VerusID 2-level CMM tree, pins all discovered CIDs to Kubo, verifies byte SHA-256 against on-chain URLRef.datahash, and registers them in your protected tenant ledger.',
      sample: `curl -X POST https://dashboard.sovpin.com/v1/watchers/wch_0123456789abcdef/repair \\
  -H "Authorization: Bearer ${keyPlaceholder}"`,
    },
    {
      method: 'GET',
      path: '/healthz & /metrics',
      scope: 'public',
      desc: 'Liveness/readiness check (SQLite, Kubo RPC, Verus RPC) and Prometheus metrics exposition endpoint.',
      sample: `curl https://dashboard.sovpin.com/healthz && curl https://dashboard.sovpin.com/metrics`,
    },
    {
      method: 'POST',
      path: '/v1/pins',
      scope: 'pin:write',
      desc: 'IPFS Pinning Service Spec: Pin an existing CID by hash & build VDXF DataDescriptor.',
      sample: `curl -X POST https://dashboard.sovpin.com/v1/pins \\
  -H "Authorization: Bearer ${keyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -d '{"cid":"QmdJN78YiEAzh8xQ59YMsMW635cXtr24RDSz6zuJr1NyFk","name":"genesis-asset"}'`,
    },
    {
      method: 'GET',
      path: '/v1/pins',
      scope: 'pin:read',
      desc: 'List pinned objects for your VerusID tenant with SHA-256 digests and VDXF descriptors.',
      sample: `curl https://dashboard.sovpin.com/v1/pins -H "Authorization: Bearer ${keyPlaceholder}"`,
    },
    {
      method: 'POST',
      path: '/v1/watchers',
      scope: 'session / key',
      desc: 'Register an on-chain VerusID to poll via getidentitycontent and auto-pin discovered CMM CIDs.',
      sample: `curl -X POST https://dashboard.sovpin.com/v1/watchers \\
  -H "Authorization: Bearer ${keyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -d '{"targetIdentity":"NftIndex.vreal@","vdxfUri":"sovpin::storage.pin.descriptor"}'`,
    },
  ];

  return (
    <div className="space-y-4 font-mono text-xs tabular-nums">
      {!account && (
        <div className="flex items-center justify-between border-b border-[#22262E] pb-3">
          <Link to="/" className="text-[#9CA3AF] hover:text-[#F3F4F6] flex items-center gap-1.5">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Index</span>
          </Link>
          <Link to="/signin" className="text-[#10B981] hover:underline">
            Authenticate VerusID →
          </Link>
        </div>
      )}

      {/* Status Modal Overlay */}
      <ConfirmDialog pending={confirm} onCancel={() => setConfirm(null)} />
      <Dialog
        open={notice !== null}
        tone={notice?.tone === 'error' ? 'error' : 'success'}
        label={notice?.tone === 'error' ? 'Error' : 'Success'}
        onClose={() => setNotice(null)}
      >
        {notice && (
          <>
            <div className="flex items-start gap-2.5">
              <span className="text-lg leading-none" aria-hidden="true">
                {notice.tone === 'error' ? '✕' : '✓'}
              </span>
              <span className="leading-relaxed">{notice.text}</span>
            </div>
            {notice.tone !== 'error' && (
              <div className="mt-3 text-[10px] text-[#6B7280]">
                This message will auto-dismiss in 3 seconds.
              </div>
            )}
          </>
        )}
      </Dialog>

      {/* 4-Cell Infrastructure Telemetry Strip */}
      <div className="grid grid-cols-1 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-[#22262E] border border-[#22262E] bg-[#111317]">
        <div className="px-4 py-3 space-y-1">
          <div className="text-[10px] uppercase text-[#6B7280]">Verus RPC Daemon</div>
          <div className="text-sm font-bold text-[#F3F4F6]">
            {verusStats?.online ? `${verusStats.chain} #${verusStats.blocks}` : 'Connecting...'}
          </div>
          <div className="text-[11px] text-[#10B981]">{verusStats?.version || 'verusd v1.2.18'}</div>
        </div>

        <div className="px-4 py-3 space-y-1">
          <div className="text-[10px] uppercase text-[#6B7280]">Kubo Storage Engine</div>
          <div className="text-sm font-bold text-[#F3F4F6]">
            {kuboStats?.online ? `Online (v${kuboStats.version})` : 'Connecting...'}
          </div>
          <div className="text-[11px] text-[#9CA3AF]">
            Repo: {formatBytes(kuboStats?.repoSize)} · {kuboStats?.pinnedCids ?? 0} pins
          </div>
        </div>

        <div className="px-4 py-3 space-y-1">
          <div className="text-[10px] uppercase text-[#6B7280]">Dedicated Edge Gateway</div>
          <div className="text-sm font-bold text-[#F3F4F6]">ipfs.sovpin.com</div>
          <div className="text-[11px] text-[#9CA3AF]">
            TTL: 31536000s · {cfStats?.rateLimit?.configured ? '200 req/10s RL' : 'Active'}
          </div>
        </div>

        <div className="px-4 py-3 space-y-1">
          <div className="text-[10px] uppercase text-[#6B7280]">Verus Media Reference</div>
          <div className="text-xs font-bold text-[#10B981] truncate">
            DataDescriptor → CrossChainDataRef → URLRef
          </div>
          <div className="text-[10px] text-[#6B7280] truncate">
            CMM value uses Verus serializedhex
          </div>
        </div>
      </div>

      {/* REST API Reference Table */}
      <div className="border border-[#22262E] bg-[#111317]">
        <div className="px-3.5 py-2 border-b border-[#22262E] bg-[#090A0C] text-[11px] uppercase tracking-wider text-[#9CA3AF]">
          REST &amp; VDXF Endpoint Specification
        </div>
        <div className="divide-y divide-[#22262E]">
          {endpointsDoc.map((ep, idx) => (
            <div key={idx} className="p-3.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/40 font-bold text-[10px]">
                    {ep.method}
                  </span>
                  <span className="text-[#F3F4F6] font-bold">{ep.path}</span>
                  <span className="text-[#6B7280]">[{ep.scope}]</span>
                </div>
                <CopyInline value={ep.sample} label="Copy cURL" />
              </div>
              <div className="text-[#9CA3AF] font-sans text-xs">{ep.desc}</div>
              <pre className="bg-[#090A0C] border border-[#22262E] p-2.5 text-[11px] text-[#F3F4F6] overflow-x-auto">
                {ep.sample}
              </pre>
            </div>
          ))}
        </div>
      </div>

      {/* UK Statutory Compliance & HTTP 451 Denylist */}
      <div className="grid grid-cols-1 lg:grid-cols-12 border border-[#22262E] bg-[#111317] divide-y lg:divide-y-0 lg:divide-x divide-[#22262E]">
        <div className="lg:col-span-6 p-3.5 space-y-2.5">
          <div className="text-[11px] uppercase tracking-wider text-[#9CA3AF] border-b border-[#22262E] pb-2">
            UK Statutory Compliance (England &amp; Wales)
          </div>
          <ul className="space-y-2 text-[#9CA3AF] font-sans text-xs leading-relaxed">
            <li>
              <strong className="text-[#F3F4F6]">UK Online Safety Act 2023:</strong> Automated CID hash-blocking (
              <code className="font-mono text-[#F97316]">HTTP 451 Unavailable For Legal Reasons</code>) and immediate
              Kubo unpinning on verified notice.
            </li>
            <li>
              <strong className="text-[#F3F4F6]">UK GDPR &amp; DPA 2018:</strong> Pseudonymous VerusID (
              <code className="font-mono text-[#10B981]">i-address</code>) ledger. Supports client-side Sapling{' '}
              <code className="font-mono">zs-</code> viewing-key encryption.
            </li>
            <li>
              <strong className="text-[#F3F4F6]">HMRC CRYPTO21000:</strong> Dual GBP (£) + VerusPay (VRSC) accounting
              with spot GBP valuation recorded at invoice timestamp + 20% UK VAT.
            </li>
          </ul>
        </div>

        <div className="lg:col-span-6 p-3.5 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-[#9CA3AF] border-b border-[#22262E] pb-2">
            Notice &amp; Takedown / HTTP 451 CID Block ({blocked.length} Blocked)
          </div>
          {account && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <label htmlFor="takedown-cid" className="sr-only">CID to block</label>
              <input
                id="takedown-cid"
                placeholder="CID (Qm... / bafy...)"
                value={cid}
                onChange={(e) => setCid(e.target.value)}
                className="bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
              />
              <label htmlFor="takedown-reason" className="sr-only">Statutory reason</label>
              <input
                id="takedown-reason"
                placeholder="Statutory reason / ref"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
              />
              <button
                type="button"
                onClick={askTakedown}
                className="py-1.5 px-3 bg-[#F97316] text-[#090A0C] font-bold cursor-pointer"
              >
                Execute 451 Block
              </button>
            </div>
          )}
          <div className="space-y-1">
            {blocked.length === 0 ? (
              <div className="text-[#6B7280]">Denylist empty (0 blocked CIDs).</div>
            ) : (
              blocked.map((b: any) => (
                <div key={b.cid} className="bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 flex justify-between">
                  <span className="text-red-400">{b.cid}</span>
                  <span className="text-[#6B7280]">{b.reason}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
