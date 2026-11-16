import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/useAuth';
import { CopyInline } from '../components/CopyInline';

export default function LandingPage() {
  const { account } = useAuth();
  const navigate = useNavigate();
  const [publicInfo, setPublicInfo] = useState<any>(null);
  const [activeCodeTab, setActiveCodeTab] = useState<'upload' | 'response' | 'cmm' | 'resolve'>('upload');

  useEffect(() => {
    api('/v1/public/info').then(setPublicInfo).catch(() => {});
  }, []);

  const codeSnippets = {
    upload: `// 1. POST /v1/pin/upload/stream — Stream binary/media to Kubo & build Verus URLRef
const form = new FormData();
form.append('file', new Blob([fileBytes], { type: 'image/png' }), 'genesis-nft.png');

const res = await fetch(
  'https://dashboard.sovpin.com/v1/pin/upload/stream?vdxfUri=vreal%3A%3Anft.asset.media',
  {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer svp_live_9b646822414fa7fcc30781cb...',
    },
    body: form,
  }
);
const { pin, info, verus_vdxf, verus_receipt } = await res.json();`,
    response: `{
  "requestid": "pin_9935ff8da5c0f9015b6b",
  "status": "pinned",
  "pin": {
    "cid": "QmRaoqwaY9ssb3FbRKQTsmgbxvaR8HkFSrZQZwxzyFAepn",
    "name": "nft-metadata.json"
  },
  "info": {
    "size_bytes": 184,
    "sha256": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
    "gateway_url": "https://ipfs.sovpin.com/ipfs/QmRaoqwaY9ssb3FbRKQTsmgbxvaR8HkFSrZQZwxzyFAepn",
    "vdxf_uri": "sovpin::storage.pin.descriptor",
    "vdxf_id": "iF2rzXajbfTdsUyhYd9SqAjMhZxknjk5CU"
  },
  "verus_vdxf": {
    "dataDescriptor": {
      "version": 1,
      "flags": 96,
      "label": "nft-metadata.json",
      "mimetype": "application/json",
      "objectdata": "<CrossChainDataRef(URLRef)>"
    },
    "urlRef": {
      "version": 2,
      "flags": 1,
      "datahash": "<sha256-of-uploaded-bytes>",
      "url": "ipfs://<cid>"
    },
    "cmmUpdatePayload": {
      "name": "vreal.VRSCTEST",
      "contentmultimap": {
        "<resolved-application-vdxf-i-address>": [
          { "serializedhex": "<DataDescriptor(CrossChainDataRef(URLRef))>" }
        ]
      }
    }
  },
  "verus_receipt": {
    "signerIdentity": "sovpin.VRSCTEST@",
    "blockHeight": 13684,
    "signature": "AgV0NQAAAUEgLH76TKr0..."
  }
}`,
    cmm: `verus -chain=VRSCTEST updateidentity '{
  "name": "vreal.VRSCTEST",
  "contentmultimap": {
    "<resolved-application-vdxf-i-address>": [{
      "serializedhex": "<DataDescriptor(CrossChainDataRef(URLRef))>"
    }]
  }
}'`,
    resolve: `// 4. Resolve & stream any VerusID's on-chain CMM asset directly by VDXF key
// A) Direct <img /> / <video /> embed (302 redirect to 1yr edge cache or ?mode=stream)
<img src="https://dashboard.sovpin.com/v1/resolve/vreal@/content?vdxf=sovpin::storage.pin.descriptor" />

// B) Inspect decoded DataDescriptor + URLRef + Kubo pin health as JSON
const res = await fetch(
  'https://dashboard.sovpin.com/v1/resolve/vreal@?vdxf=sovpin::storage.pin.descriptor',
  { headers: { 'Authorization': 'Bearer svp_live_...' } }
);
const { identity, blockHeight, dataDescriptors, references } = await res.json();`,
  };

  return (
    <div className="min-h-screen bg-[#090A0C] text-[#F3F4F6] flex flex-col">
      {/* Top Industrial Bar */}
      <header className="sticky top-0 z-30 h-11 border-b border-[#22262E] bg-[#090A0C] px-6 flex items-center justify-between font-mono text-xs">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 bg-[#10B981] text-[#090A0C] font-bold flex items-center justify-center text-[11px]">
            SP
          </div>
          <span className="font-bold tracking-tight uppercase text-[#F3F4F6]">SovPin</span>
          <span className="text-[#6B7280]">|</span>
          <span className="text-[#9CA3AF] hidden sm:inline">
            IPFS &amp; VDXF Object Storage Ledger
          </span>
        </div>

        <div className="flex items-center gap-5">
          <a href="#workflow" className="text-[#9CA3AF] hover:text-[#F3F4F6]">
            Architecture
          </a>
          <a href="#pricing" className="text-[#9CA3AF] hover:text-[#F3F4F6]">
            Pricing (£ / VRSC)
          </a>
          <Link to="/docs" className="text-[#9CA3AF] hover:text-[#F3F4F6]">
            Specification
          </Link>
          <button
            type="button"
            onClick={() => navigate(account ? '/dashboard' : '/signin')}
            className="px-3 py-1 bg-[#10B981] text-[#090A0C] font-semibold cursor-pointer"
          >
            {account ? `Console (${account.tenant.friendly_name}) →` : 'Authenticate VerusID →'}
          </button>
        </div>
      </header>

      {/* Main Split Grid */}
      <section className="max-w-7xl w-full mx-auto px-6 py-12 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start border-b border-[#22262E]">
        <div className="lg:col-span-6 space-y-5">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 border border-[#22262E] bg-[#111317] text-[11px] font-mono tabular-nums text-[#9CA3AF]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
            <span>
              {publicInfo?.verusDaemon?.online
                ? `${publicInfo.verusDaemon.chain} #${publicInfo.verusDaemon.blocks}`
                : 'VRSCTEST ONLINE'}{' '}
              · KUBO v0.43.1 · EDGE: ipfs.sovpin.com
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#F3F4F6] leading-tight">
            Deterministic IPFS Object Pinning &amp; VDXF Engine for Verus Builders.
          </h1>

          <p className="text-sm text-[#9CA3AF] leading-relaxed">
            Tenants are keyed to their canonical on-chain Verus <code className="font-mono text-[#10B981]">i-address</code>.
            Ingest files or JSON via REST, pin to dedicated Kubo storage, receive Verus's serialized{' '}
            <code className="font-mono text-[#F3F4F6]">DataDescriptor(CrossChainDataRef(URLRef))</code>{' '}
            with a byte-hash commitment, and index on-chain <code className="font-mono text-[#F3F4F6]">ContentMultiMap</code> updates automatically.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-1 font-mono text-xs">
            <button
              type="button"
              onClick={() => navigate(account ? '/dashboard' : '/signin')}
              className="px-4 py-2 bg-[#10B981] text-[#090A0C] font-bold flex items-center gap-2 cursor-pointer"
            >
              <span>{account ? 'Open Storage Ledger' : 'Provision Free 1 GB Namespace'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/docs')}
              className="px-4 py-2 bg-[#111317] border border-[#22262E] hover:border-[#9CA3AF] text-[#F3F4F6] cursor-pointer"
            >
              REST &amp; VDXF API Spec
            </button>
          </div>

          <div className="grid grid-cols-3 divide-x divide-[#22262E] border border-[#22262E] bg-[#111317] font-mono text-xs tabular-nums">
            <div className="p-3">
              <div className="text-[10px] text-[#6B7280] uppercase">Auth Protocol</div>
              <div className="text-[#F3F4F6] font-bold mt-0.5">LoginConsent / CLI</div>
            </div>
            <div className="p-3">
              <div className="text-[10px] text-[#6B7280] uppercase">Edge Cache TTL</div>
              <div className="text-[#10B981] font-bold mt-0.5">31,536,000s (1yr)</div>
            </div>
            <div className="p-3">
              <div className="text-[10px] text-[#6B7280] uppercase">Settlement</div>
              <div className="text-[#F3F4F6] font-bold mt-0.5">VRSC &amp; £ GBP + VAT</div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-6 border border-[#22262E] bg-[#111317] font-mono text-xs">
          <div className="px-3 py-2 border-b border-[#22262E] bg-[#090A0C] flex items-center justify-between">
            <div className="flex border border-[#22262E]">
              {(
                [
                  ['upload', '1. Upload'],
                  ['response', '2. VDXF + Receipt'],
                  ['cmm', '3. updateidentity'],
                  ['resolve', '4. Resolve'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveCodeTab(id)}
                  className={`px-2.5 py-1 text-[10px] cursor-pointer ${
                    activeCodeTab === id
                      ? 'bg-[#10B981] text-[#090A0C] font-bold'
                      : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <CopyInline value={codeSnippets[activeCodeTab]} label="Copy" />
          </div>
          <pre className="p-4 text-[11px] text-[#F3F4F6] overflow-x-auto leading-relaxed">
            {codeSnippets[activeCodeTab]}
          </pre>
        </div>
      </section>

      {/* 4-Cell Architecture Pipeline */}
      <section id="workflow" className="max-w-7xl w-full mx-auto px-6 py-10 space-y-4 border-b border-[#22262E]">
        <div className="text-xs font-mono uppercase tracking-wider text-[#9CA3AF]">
          System Architecture &amp; Developer Pipeline
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-[#22262E] border border-[#22262E] bg-[#111317] font-mono text-xs">
          <div className="p-4 space-y-1.5">
            <div className="text-[10px] text-[#10B981]">01 / IDENTITY</div>
            <div className="text-sm font-sans font-bold text-[#F3F4F6]">VerusID i-Address Auth</div>
            <p className="text-xs font-sans text-[#9CA3AF]">
              Sign in via Verus Mobile QR (`LoginConsent`) or `verus signdata`. Account state is bound to your
              permanent i-address.
            </p>
          </div>
          <div className="p-4 space-y-1.5">
            <div className="text-[10px] text-[#10B981]">02 / ACCESS KEYS</div>
            <div className="text-sm font-sans font-bold text-[#F3F4F6]">Scoped Bearer Tokens</div>
            <p className="text-xs font-sans text-[#9CA3AF]">
              Generate `svp_live_...` keys scoped to `pin:write`, `pin:read`, and `vdxf:build` for backend services.
            </p>
          </div>
          <div className="p-4 space-y-1.5">
            <div className="text-[10px] text-[#10B981]">03 / VDXF INGEST</div>
            <div className="text-sm font-sans font-bold text-[#F3F4F6]">Kubo Pin + DataDescriptor</div>
            <p className="text-xs font-sans text-[#9CA3AF]">
              Every upload computes SHA-256, pins to Kubo, and returns a canonical Verus `DataDescriptor` JSON payload.
            </p>
          </div>
          <div className="p-4 space-y-1.5">
            <div className="text-[10px] text-[#10B981]">04 / CMM INDEXER</div>
            <div className="text-sm font-sans font-bold text-[#F3F4F6]">On-Chain CMM Auto-Pin</div>
            <p className="text-xs font-sans text-[#9CA3AF]">
              Register any VerusID to watch via `getidentitycontent` and automatically pin referenced CIDs.
            </p>
          </div>
        </div>
      </section>

      {/* Pricing Ledger */}
      <section id="pricing" className="max-w-7xl w-full mx-auto px-6 py-10 space-y-4 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
          <span className="uppercase tracking-wider text-[#9CA3AF]">
            UK Commercial Tiers (SovPin Technologies Ltd · 20% UK VAT &amp; VerusPay VRSC)
          </span>
          <span className="text-[#10B981]">Spot Reference: 1 VRSC = £{Number(publicInfo?.gbpPerVrscRate || 3.0).toFixed(2)} GBP</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#22262E] border border-[#22262E] bg-[#111317] font-mono text-xs tabular-nums">
          {(publicInfo?.plans || []).map((p: any) => {
            const vatPence = Math.round(Number(p.priceGbpPence || 0) / 5);
            const totalPence = Number(p.priceGbpPence || 0) + vatPence;
            const totalIncVat = (totalPence / 100).toFixed(2);
            const liveRate = Number(publicInfo?.gbpPerVrscRate || 3.0);
            const totalVrsc = Number(p.priceGbpPence || 0) > 0 ? (Math.round((totalPence / 100 / liveRate) * 1e8) / 1e8).toFixed(4) : '0.0000';
            return (
              <div key={p.id} className="p-5 flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-[#F3F4F6] uppercase">{p.name}</span>
                    <span className="text-[10px] text-[#6B7280]">{p.chainScope}</span>
                  </div>
                  <div className="border-y border-[#22262E] py-2">
                    <span className="text-2xl font-bold text-[#F3F4F6]">{p.priceGbpDisplay}</span>
                    <span className="text-[11px] text-[#6B7280]">
                      / mo {p.priceGbpPence > 0 ? `(ex VAT · £${totalIncVat} inc VAT)` : ''}
                    </span>
                    <div className="text-[11px] text-[#10B981] mt-0.5">
                      {Number(p.priceGbpPence || 0) > 0 ? `${totalVrsc} VRSC / mo (inc VAT)` : '0.00 VRSC (Free Testnet Quota)'}
                    </div>
                  </div>
                  <ul className="space-y-1 text-[11px] text-[#9CA3AF]">
                    {(p.features || []).map((f: string, idx: number) => (
                      <li key={idx}>+ {f}</li>
                    ))}
                  </ul>
                </div>

                <button
                  type="button"
                  onClick={() => navigate(account ? '/billing' : '/signin')}
                  className="w-full py-1.5 px-3 bg-[#181B20] border border-[#22262E] hover:border-[#10B981] text-[#F3F4F6] font-semibold cursor-pointer"
                >
                  {p.priceGbpPence === 0 ? 'Authenticate & Provision' : `Select ${p.name}`}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <footer className="border-t border-[#22262E] px-6 py-3 font-mono text-[11px] text-[#6B7280] flex flex-wrap justify-between gap-4">
        <span>SovPin Technologies Ltd (England &amp; Wales) · UK Online Safety Act 2023 &amp; UK GDPR</span>
        <span>Gateway: https://ipfs.sovpin.com</span>
      </footer>
    </div>
  );
}
