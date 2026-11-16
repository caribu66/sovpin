const os = require('os');
const path = require('path');

const PLANS = {
  builder: {
    id: 'builder',
    name: 'Testnet Builder',
    chainScope: 'VRSCTEST',
    priceGbpPence: 0,
    priceGbpDisplay: '£0',
    priceVrsc: 0,
    storageLimitBytes: 1 * 1024 * 1024 * 1024, // 1 GB
    gatewayBandwidthBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    maxApiKeys: 2,
    maxCmmWatchers: 1,
    features: [
      '1 GB Sovereign IPFS Pinning',
      '10 GB / mo Cloudflare Edge Gateway',
      'VerusID Challenge-Response Auth',
      'VDXF DataDescriptor JSON Builder',
      '1 Automated VRSCTEST CMM Watcher',
    ],
  },
  indie: {
    id: 'indie',
    name: 'Mainnet Indie',
    chainScope: 'VRSC + VRSCTEST',
    priceGbpPence: 1200, // £12.00 ex VAT
    priceGbpDisplay: '£12',
    priceVrsc: 4.0,
    storageLimitBytes: 100 * 1024 * 1024 * 1024, // 100 GB
    gatewayBandwidthBytes: 500 * 1024 * 1024 * 1024, // 500 GB
    maxApiKeys: 10,
    maxCmmWatchers: 5,
    features: [
      '100 GB Sovereign IPFS Pinning',
      '500 GB / mo Cloudflare Edge Gateway',
      'Up to 10 Scoped API Keys',
      '5 Automated Mainnet/Testnet CMM Watchers',
      'Instant VDXF DataDescriptor + MMR Signing Payloads',
      'UK VAT Invoices (GBP £ & VerusPay VRSC)',
    ],
  },
  studio: {
    id: 'studio',
    name: 'Sovereign Studio',
    chainScope: 'VRSC + VRSCTEST + PBaaS',
    priceGbpPence: 4900, // £49.00 ex VAT
    priceGbpDisplay: '£49',
    priceVrsc: 16.3333, // 49.00 / 3.0 spot rate
    storageLimitBytes: 1024 * 1024 * 1024 * 1024, // 1 TB
    gatewayBandwidthBytes: 5 * 1024 * 1024 * 1024 * 1024, // 5 TB
    maxApiKeys: 50,
    maxCmmWatchers: 25,
    features: [
      '1 TB Sovereign IPFS Pinning',
      '5 TB / mo Cloudflare Edge Gateway',
      '50 Scoped API Keys & PBaaS Support',
      '25 Automated CMM ContentMultiMap Watchers',
      'Sapling z-Address Encrypted Pin Helpers',
      'Priority SLA & UK HMRC VAT Receipts',
    ],
  },
};

const UK_VAT_RATE = 0.20; // 20% UK Standard VAT

const config = {
  port: Number(process.env.PORT || 3001),
  bindHost: process.env.BIND_HOST || '127.0.0.1',
  dbPath: process.env.SOVPIN_DB_PATH || path.join(__dirname, '..', 'data', 'sovpin.sqlite'),
  tailscaleIp: process.env.TAILSCALE_IP || '100.66.85.86',
  kuboRpcUrl: process.env.KUBO_RPC_URL || 'http://100.66.85.86:5001',
  kuboReplicaUrls: (process.env.KUBO_REPLICA_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  kuboGatewayUrl: process.env.KUBO_GATEWAY_URL || 'http://100.66.85.86:8080',
  publicGatewayUrl: process.env.PUBLIC_GATEWAY_URL || 'https://ipfs.sovpin.com',
  maxSingleUploadBytes: Number(process.env.MAX_SINGLE_UPLOAD_BYTES || 100 * 1024 * 1024),
  uploadRateLimitPerMin: Number(process.env.UPLOAD_RATE_LIMIT_PER_MIN || 60),
  tunnelId: process.env.CF_TUNNEL_ID || '990fae36-b92b-457b-af17-5737ed2d8a35',
  rulesetId: process.env.CF_RULESET_ID || '2e7849d6314246df8346142659b21066',
  zone: process.env.CF_ZONE || 'sovpin.com',
  cfBin: process.env.CF_BIN || path.join(os.homedir(), '.local/bin/cf'),
  tailscaleBin: process.env.TAILSCALE_BIN || 'tailscale',
  sshBin: process.env.SSH_BIN || 'ssh',
  macbookSshKeyPath: process.env.MACBOOK_SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'vreal_mirror_ed25519'),
  macbookSshTarget: process.env.MACBOOK_SSH_TARGET || 'macbook@192.168.86.110',
  verusRpcHost: process.env.VERUS_RPC_HOST || process.env.TAILSCALE_IP || '100.66.85.86',
  verusRpcPort: Number(process.env.VERUS_RPC_PORT || 25779),
  // No credential defaults: require explicit configuration per environment.
  verusRpcUser: process.env.VERUS_RPC_USER || '',
  verusRpcPassword: process.env.VERUS_RPC_PASSWORD || '',
  verusChain: process.env.VERUS_CHAIN || 'VRSCTEST',
  chainIAddress: process.env.VERUS_CHAIN_I_ADDRESS || 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq',
  sovpinReceivingIdentity: process.env.SOVPIN_RECEIVING_ID || 'vreal.VRSCTEST@',
  sovpinSignerIdentity: process.env.SOVPIN_SIGNER_ID || 'sovpin.VRSCTEST@',
  sovpinSignerIAddress: process.env.SOVPIN_SIGNER_I_ADDRESS || 'iCyhNFeRiKdX7rgAYJdz54z2pTT9M1RYUt',
  sovpinSignerWif: process.env.SOVPIN_SIGNER_WIF || '',
  sovpinInternalSecret: process.env.SOVPIN_INTERNAL_SECRET || '',
  sovpinCallbackHost: process.env.SOVPIN_CALLBACK_HOST || 'https://dashboard.sovpin.com',
  allowPublicNodeSign: process.env.ALLOW_PUBLIC_NODE_SIGN === 'true',
  adminIdentities: (
    process.env.ADMIN_IDENTITIES ||
    'iEmX7PJUtAwp1a1xxrPi215G7FMxwVr5XX,iCyhNFeRiKdX7rgAYJdz54z2pTT9M1RYUt,vreal.VRSCTEST@,sovpin.VRSCTEST@'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  gbpPerVrscRate: Number(process.env.GBP_PER_VRSC_RATE || 3.0), // Spot reference £3.00 / VRSC
  // No secret defaults: configure per environment when integrations are enabled.
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  ukCompany: {
    legalName: process.env.UK_COMPANY_NAME || 'SovPin Technologies Ltd',
    jurisdiction: 'England & Wales',
    registeredCountry: 'United Kingdom',
    vatRate: UK_VAT_RATE,
    currency: 'GBP',
    icoRegistrationStatus: 'UK GDPR Data Controller — Sovereign Content-Addressed Storage',
  },
  PLANS,
};

module.exports = config;
