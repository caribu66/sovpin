import{c as f,u as b,a as v,r as o,b as u,j as e,L as j,C as g}from"./index-DCbRWY3I.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const F=f("ArrowRight",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"m12 5 7 7-7 7",key:"xquz4c"}]]);function y(){var d;const{account:a}=b(),i=v(),[t,l]=o.useState(null),[n,x]=o.useState("upload");o.useEffect(()=>{u("/v1/public/info").then(l).catch(()=>{})},[]);const c={upload:`// 1. POST /v1/pin/upload/stream — Stream binary/media to Kubo & build Verus URLRef
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
const { pin, info, verus_vdxf, verus_receipt } = await res.json();`,response:`{
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
}`,cmm:`verus -chain=VRSCTEST updateidentity '{
  "name": "vreal.VRSCTEST",
  "contentmultimap": {
    "<resolved-application-vdxf-i-address>": [{
      "serializedhex": "<DataDescriptor(CrossChainDataRef(URLRef))>"
    }]
  }
}'`,resolve:`// 4. Resolve & stream any VerusID's on-chain CMM asset directly by VDXF key
// A) Direct <img /> / <video /> embed (302 redirect to 1yr edge cache or ?mode=stream)
<img src="https://dashboard.sovpin.com/v1/resolve/vreal@/content?vdxf=sovpin::storage.pin.descriptor" />

// B) Inspect decoded DataDescriptor + URLRef + Kubo pin health as JSON
const res = await fetch(
  'https://dashboard.sovpin.com/v1/resolve/vreal@?vdxf=sovpin::storage.pin.descriptor',
  { headers: { 'Authorization': 'Bearer svp_live_...' } }
);
const { identity, blockHeight, dataDescriptors, references } = await res.json();`};return e.jsxs("div",{className:"min-h-screen bg-[#090A0C] text-[#F3F4F6] flex flex-col",children:[e.jsxs("header",{className:"sticky top-0 z-30 h-11 border-b border-[#22262E] bg-[#090A0C] px-6 flex items-center justify-between font-mono text-xs",children:[e.jsxs("div",{className:"flex items-center gap-3",children:[e.jsx("div",{className:"w-5 h-5 bg-[#10B981] text-[#090A0C] font-bold flex items-center justify-center text-[11px]",children:"SP"}),e.jsx("span",{className:"font-bold tracking-tight uppercase text-[#F3F4F6]",children:"SovPin"}),e.jsx("span",{className:"text-[#6B7280]",children:"|"}),e.jsx("span",{className:"text-[#9CA3AF] hidden sm:inline",children:"IPFS & VDXF Object Storage Ledger"})]}),e.jsxs("div",{className:"flex items-center gap-5",children:[e.jsx("a",{href:"#workflow",className:"text-[#9CA3AF] hover:text-[#F3F4F6]",children:"Architecture"}),e.jsx("a",{href:"#pricing",className:"text-[#9CA3AF] hover:text-[#F3F4F6]",children:"Pricing (£ / VRSC)"}),e.jsx(j,{to:"/docs",className:"text-[#9CA3AF] hover:text-[#F3F4F6]",children:"Specification"}),e.jsx("button",{type:"button",onClick:()=>i(a?"/dashboard":"/signin"),className:"px-3 py-1 bg-[#10B981] text-[#090A0C] font-semibold cursor-pointer",children:a?`Console (${a.tenant.friendly_name}) →`:"Authenticate VerusID →"})]})]}),e.jsxs("section",{className:"max-w-7xl w-full mx-auto px-6 py-12 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start border-b border-[#22262E]",children:[e.jsxs("div",{className:"lg:col-span-6 space-y-5",children:[e.jsxs("div",{className:"inline-flex items-center gap-2 px-2.5 py-1 border border-[#22262E] bg-[#111317] text-[11px] font-mono tabular-nums text-[#9CA3AF]",children:[e.jsx("span",{className:"w-1.5 h-1.5 rounded-full bg-[#10B981]"}),e.jsxs("span",{children:[(d=t==null?void 0:t.verusDaemon)!=null&&d.online?`${t.verusDaemon.chain} #${t.verusDaemon.blocks}`:"VRSCTEST ONLINE"," ","· KUBO v0.43.1 · EDGE: ipfs.sovpin.com"]})]}),e.jsx("h1",{className:"text-3xl sm:text-4xl font-bold tracking-tight text-[#F3F4F6] leading-tight",children:"Deterministic IPFS Object Pinning & VDXF Engine for Verus Builders."}),e.jsxs("p",{className:"text-sm text-[#9CA3AF] leading-relaxed",children:["Tenants are keyed to their canonical on-chain Verus ",e.jsx("code",{className:"font-mono text-[#10B981]",children:"i-address"}),". Ingest files or JSON via REST, pin to dedicated Kubo storage, receive Verus's serialized"," ",e.jsx("code",{className:"font-mono text-[#F3F4F6]",children:"DataDescriptor(CrossChainDataRef(URLRef))"})," ","with a byte-hash commitment, and index on-chain ",e.jsx("code",{className:"font-mono text-[#F3F4F6]",children:"ContentMultiMap"})," updates automatically."]}),e.jsxs("div",{className:"flex flex-wrap items-center gap-3 pt-1 font-mono text-xs",children:[e.jsxs("button",{type:"button",onClick:()=>i(a?"/dashboard":"/signin"),className:"px-4 py-2 bg-[#10B981] text-[#090A0C] font-bold flex items-center gap-2 cursor-pointer",children:[e.jsx("span",{children:a?"Open Storage Ledger":"Provision Free 1 GB Namespace"}),e.jsx(F,{className:"w-3.5 h-3.5"})]}),e.jsx("button",{type:"button",onClick:()=>i("/docs"),className:"px-4 py-2 bg-[#111317] border border-[#22262E] hover:border-[#9CA3AF] text-[#F3F4F6] cursor-pointer",children:"REST & VDXF API Spec"})]}),e.jsxs("div",{className:"grid grid-cols-3 divide-x divide-[#22262E] border border-[#22262E] bg-[#111317] font-mono text-xs tabular-nums",children:[e.jsxs("div",{className:"p-3",children:[e.jsx("div",{className:"text-[10px] text-[#6B7280] uppercase",children:"Auth Protocol"}),e.jsx("div",{className:"text-[#F3F4F6] font-bold mt-0.5",children:"LoginConsent / CLI"})]}),e.jsxs("div",{className:"p-3",children:[e.jsx("div",{className:"text-[10px] text-[#6B7280] uppercase",children:"Edge Cache TTL"}),e.jsx("div",{className:"text-[#10B981] font-bold mt-0.5",children:"31,536,000s (1yr)"})]}),e.jsxs("div",{className:"p-3",children:[e.jsx("div",{className:"text-[10px] text-[#6B7280] uppercase",children:"Settlement"}),e.jsx("div",{className:"text-[#F3F4F6] font-bold mt-0.5",children:"VRSC & £ GBP + VAT"})]})]})]}),e.jsxs("div",{className:"lg:col-span-6 border border-[#22262E] bg-[#111317] font-mono text-xs",children:[e.jsxs("div",{className:"px-3 py-2 border-b border-[#22262E] bg-[#090A0C] flex items-center justify-between",children:[e.jsx("div",{className:"flex border border-[#22262E]",children:[["upload","1. Upload"],["response","2. VDXF + Receipt"],["cmm","3. updateidentity"],["resolve","4. Resolve"]].map(([s,r])=>e.jsx("button",{type:"button",onClick:()=>x(s),className:`px-2.5 py-1 text-[10px] cursor-pointer ${n===s?"bg-[#10B981] text-[#090A0C] font-bold":"text-[#9CA3AF] hover:text-[#F3F4F6]"}`,children:r},s))}),e.jsx(g,{value:c[n],label:"Copy"})]}),e.jsx("pre",{className:"p-4 text-[11px] text-[#F3F4F6] overflow-x-auto leading-relaxed",children:c[n]})]})]}),e.jsxs("section",{id:"workflow",className:"max-w-7xl w-full mx-auto px-6 py-10 space-y-4 border-b border-[#22262E]",children:[e.jsx("div",{className:"text-xs font-mono uppercase tracking-wider text-[#9CA3AF]",children:"System Architecture & Developer Pipeline"}),e.jsxs("div",{className:"grid grid-cols-1 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-[#22262E] border border-[#22262E] bg-[#111317] font-mono text-xs",children:[e.jsxs("div",{className:"p-4 space-y-1.5",children:[e.jsx("div",{className:"text-[10px] text-[#10B981]",children:"01 / IDENTITY"}),e.jsx("div",{className:"text-sm font-sans font-bold text-[#F3F4F6]",children:"VerusID i-Address Auth"}),e.jsx("p",{className:"text-xs font-sans text-[#9CA3AF]",children:"Sign in via Verus Mobile QR (`LoginConsent`) or `verus signdata`. Account state is bound to your permanent i-address."})]}),e.jsxs("div",{className:"p-4 space-y-1.5",children:[e.jsx("div",{className:"text-[10px] text-[#10B981]",children:"02 / ACCESS KEYS"}),e.jsx("div",{className:"text-sm font-sans font-bold text-[#F3F4F6]",children:"Scoped Bearer Tokens"}),e.jsx("p",{className:"text-xs font-sans text-[#9CA3AF]",children:"Generate `svp_live_...` keys scoped to `pin:write`, `pin:read`, and `vdxf:build` for backend services."})]}),e.jsxs("div",{className:"p-4 space-y-1.5",children:[e.jsx("div",{className:"text-[10px] text-[#10B981]",children:"03 / VDXF INGEST"}),e.jsx("div",{className:"text-sm font-sans font-bold text-[#F3F4F6]",children:"Kubo Pin + DataDescriptor"}),e.jsx("p",{className:"text-xs font-sans text-[#9CA3AF]",children:"Every upload computes SHA-256, pins to Kubo, and returns a canonical Verus `DataDescriptor` JSON payload."})]}),e.jsxs("div",{className:"p-4 space-y-1.5",children:[e.jsx("div",{className:"text-[10px] text-[#10B981]",children:"04 / CMM INDEXER"}),e.jsx("div",{className:"text-sm font-sans font-bold text-[#F3F4F6]",children:"On-Chain CMM Auto-Pin"}),e.jsx("p",{className:"text-xs font-sans text-[#9CA3AF]",children:"Register any VerusID to watch via `getidentitycontent` and automatically pin referenced CIDs."})]})]})]}),e.jsxs("section",{id:"pricing",className:"max-w-7xl w-full mx-auto px-6 py-10 space-y-4 flex-1",children:[e.jsxs("div",{className:"flex flex-wrap items-center justify-between gap-2 font-mono text-xs",children:[e.jsx("span",{className:"uppercase tracking-wider text-[#9CA3AF]",children:"UK Commercial Tiers (SovPin Technologies Ltd · 20% UK VAT & VerusPay VRSC)"}),e.jsx("span",{className:"text-[#10B981]",children:"Spot Reference: 1 VRSC = £3.00 GBP"})]}),e.jsx("div",{className:"grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#22262E] border border-[#22262E] bg-[#111317] font-mono text-xs tabular-nums",children:((t==null?void 0:t.plans)||[]).map(s=>{const r=(s.priceGbpPence*1.2/100).toFixed(2),p=(s.priceVrsc*1.2).toFixed(2);return e.jsxs("div",{className:"p-5 flex flex-col justify-between space-y-4",children:[e.jsxs("div",{className:"space-y-3",children:[e.jsxs("div",{className:"flex items-center justify-between",children:[e.jsx("span",{className:"text-sm font-bold text-[#F3F4F6] uppercase",children:s.name}),e.jsx("span",{className:"text-[10px] text-[#6B7280]",children:s.chainScope})]}),e.jsxs("div",{className:"border-y border-[#22262E] py-2",children:[e.jsx("span",{className:"text-2xl font-bold text-[#F3F4F6]",children:s.priceGbpDisplay}),e.jsxs("span",{className:"text-[11px] text-[#6B7280]",children:["/ mo ",s.priceGbpPence>0?`(ex VAT · £${r} inc VAT)`:""]}),e.jsx("div",{className:"text-[11px] text-[#10B981] mt-0.5",children:s.priceVrsc>0?`${p} VRSC / mo (inc VAT)`:"0.00 VRSC (Free Testnet Quota)"})]}),e.jsx("ul",{className:"space-y-1 text-[11px] text-[#9CA3AF]",children:(s.features||[]).map((m,h)=>e.jsxs("li",{children:["+ ",m]},h))})]}),e.jsx("button",{type:"button",onClick:()=>i(a?"/billing":"/signin"),className:"w-full py-1.5 px-3 bg-[#181B20] border border-[#22262E] hover:border-[#10B981] text-[#F3F4F6] font-semibold cursor-pointer",children:s.priceGbpPence===0?"Authenticate & Provision":`Select ${s.name}`})]},s.id)})})]}),e.jsxs("footer",{className:"border-t border-[#22262E] px-6 py-3 font-mono text-[11px] text-[#6B7280] flex flex-wrap justify-between gap-4",children:[e.jsx("span",{children:"SovPin Technologies Ltd (England & Wales) · UK Online Safety Act 2023 & UK GDPR"}),e.jsx("span",{children:"Gateway: https://ipfs.sovpin.com"})]})]})}export{y as default};
//# sourceMappingURL=LandingPage-4hNGXWua.js.map
