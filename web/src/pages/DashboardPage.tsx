import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileCode,
  Package,
  ExternalLink,
  Trash2,
  Upload,
  Hash,
  RefreshCw,
  Key,
  Plus,
  Search,
  Copy,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  usePins,
  useApiKeys,
  useWebhooks,
  useWebhookEvents,
  useKuboStats,
  useLedgerAuthGuard,
  useUploadFile,
  useUploadJson,
  usePinCid,
  useUnpin,
  useVerifyPin,
  useCreateApiKey,
  useRevokeApiKey,
  useCreateWebhook,
  useDeleteWebhook,
  useInvalidateLedger,
  useSyncKubo,
} from '../hooks/useLedger';
import { useAuth } from '../lib/useAuth';
import { formatBytes, formatDateTime, truncateMiddle } from '../lib/format';
import { CopyInline } from '../components/CopyInline';
import { Kbd } from '../components/Kbd';
import { Dialog } from '../components/Dialog';
import { Field } from '../components/Field';
import { ConfirmDialog, type PendingConfirm } from '../components/ConfirmDialog';

const NO_ROWS: any[] = [];

export default function DashboardPage() {
  const { account, activeApiKeySample, setActiveApiKeySample } = useAuth();
  const navigate = useNavigate();

  // Table Filters (date range lives here so it can feed the server-side pins query below)
  const [searchQuery, setSearchQuery] = useState('');
  const [mimeFilter, setMimeFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const { data: pinsData, isLoading: pinsLoading, error: pinsError, refetch: refetchPins } = usePins({ from: dateFrom, to: dateTo });
  const { data: keysData, error: keysError, refetch: refetchKeys } = useApiKeys();
  const { data: webhooksData, refetch: refetchWebhooks } = useWebhooks();
  const { data: webhookEventsCatalog } = useWebhookEvents();
  const webhookEvents = webhookEventsCatalog ?? [];
  const pins = pinsData ?? NO_ROWS;
  const keys = keysData ?? NO_ROWS;
  const webhooks = webhooksData ?? NO_ROWS;
  const { data: kuboStats } = useKuboStats();
  const scopeError = useLedgerAuthGuard([pinsError, keysError]);
  const invalidate = useInvalidateLedger();
  const uploadFileMut = useUploadFile();
  const uploadJsonMut = useUploadJson();
  const pinCidMut = usePinCid();
  const unpinMut = useUnpin();
  const verifyMut = useVerifyPin();
  const createKeyMut = useCreateApiKey();
  const revokeKeyMut = useRevokeApiKey();
  const createWebhookMut = useCreateWebhook();
  const deleteWebhookMut = useDeleteWebhook();
  const syncKuboMut = useSyncKubo();
  const [showRevokedKeys, setShowRevokedKeys] = useState(false);
  const [pendingCid, setPendingCid] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [activeJob, setActiveJob] = useState<any>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Slide-over Upload / Pin Drawer state
  const [uploadModalMode, setUploadModalMode] = useState<'closed' | 'upload' | 'cid'>('closed');
  const [uploadFilename, setUploadFilename] = useState('verus-object.json');
  const [uploadMime, setUploadMime] = useState('application/json');
  const [uploadVdxfUri, setUploadVdxfUri] = useState('sovpin::storage.pin.descriptor');
  const [uploadContent, setUploadContent] = useState(
    '{\n  "schema": "sovpin::storage.pin.descriptor",\n  "app": "VREAL",\n  "version": 1\n}'
  );
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [pinCidInput, setPinCidInput] = useState('');
  const [pinCidName, setPinCidName] = useState('');
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    const check = async () => {
      try {
        setHealth(await api<any>('/healthz'));
      } catch {
        setHealth({ healthy: false });
      }
    };
    void check();
    const interval = setInterval(() => void check(), 15000);
    return () => clearInterval(interval);
  }, []);

  // Inspector Code Snippet Tab
  const [snippetTab, setSnippetTab] = useState<'cmm' | 'curl' | 'sdk' | 'ipfs'>('cmm');

  // API Key creation
  const [newKeyName, setNewKeyName] = useState('vreal-prod-backend');
  const [newKeyScopes, setNewKeyScopes] = useState('pin:read,pin:write,vdxf:build');
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [selectedWebhookEvents, setSelectedWebhookEvents] = useState<Set<string>>(new Set(['pin.created', 'pin.deleted']));
  const [webhookUrlError, setWebhookUrlError] = useState<string | null>(null);
  const [revealedWebhookSecret, setRevealedWebhookSecret] = useState('');
  const [revealedKey, setRevealedKey] = useState('');

  const [busy, setBusy] = useState('');
  const [statusBanner, setStatusBanner] = useState<{ text: string; isError?: boolean; copyValue?: string; extra?: Record<string, any> } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const loading = pinsLoading && pins.length === 0;
  const loadError =
    scopeError ?? ((pinsError as any)?.message || (keysError as any)?.message || null);

  // Reconcile selection + inspector against fresh query data (structural
  // sharing keeps `pins` referentially stable when nothing changed).
  // Syncing the external query cache into local selection is an intentional
  // external-store subscription, not render-derived state.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (pins.length === 0) {
      setActiveJob(null);
      setSelectedIds({});
      return;
    }
    const live = new Set(pins.map((r: any) => r.requestid));
    setSelectedIds((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next: Record<string, boolean> = {};
      for (const [id, v] of Object.entries(prev)) {
        if (v && live.has(id)) next[id] = true;
      }
      return next;
    });
    setActiveJob((prev: any) => {
      if (pendingCid) {
        const match = pins.find((r: any) => r.pin?.cid === pendingCid);
        if (match) {
          setPendingCid(null);
          return match;
        }
      }
      if (!prev) return pins[0];
      return pins.find((r: any) => r.requestid === prev.requestid) ?? pins[0];
    });
  }, [pins, pendingCid]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const reload = useCallback(() => {
    void Promise.all([refetchPins(), refetchKeys(), refetchWebhooks()]);
  }, [refetchPins, refetchKeys, refetchWebhooks]);

  useEffect(() => {
    if (statusBanner && !statusBanner.isError && !statusBanner.copyValue) {
      const timer = window.setTimeout(() => setStatusBanner(null), 3000);
      return () => window.clearTimeout(timer);
    }
  }, [statusBanner]);

  useEffect(() => {
    if (!account) {
      navigate('/signin');
    }
  }, [account, navigate]);

  // Keyboard shortcuts: '/' focuses filter, 'u' opens upload, 'c' opens pin-by-cid, 'Escape' closes drawer
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === '/' && !inInput) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if ((e.key === 'u' || e.key === 'U') && !inInput && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setUploadModalMode('upload');
      } else if ((e.key === 'c' || e.key === 'C') && !inInput && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setUploadModalMode('cid');
      } else if (e.key === 'Escape') {
        setUploadModalMode('closed');
        setStatusBanner(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!account) return null;

  const filteredPins = pins.filter((job) => {
    if (mimeFilter !== 'all') {
      const mime = String(job.info.mime_type || '');
      if (mimeFilter.endsWith('/*')) {
        const prefix = mimeFilter.slice(0, -1);
        if (!mime.startsWith(prefix)) return false;
      } else if (mime !== mimeFilter) {
        return false;
      }
    }
    if (dateFrom || dateTo) {
      const created = new Date(job.created_at ?? job.created).getTime();
      if (dateFrom) {
        const from = new Date(dateFrom).getTime();
        if (!Number.isNaN(from) && created < from) return false;
      }
      if (dateTo) {
        const to = new Date(dateTo).getTime();
        if (!Number.isNaN(to) && created > to + 86400000 - 1) return false;
      }
    }
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      String(job.pin.cid).toLowerCase().includes(q) ||
      String(job.pin.name).toLowerCase().includes(q) ||
      String(job.info.vdxf_uri || '').toLowerCase().includes(q)
    );
  });

  const handleSyncKubo = async () => {
    setBusy('sync');
    setStatusBanner(null);
    try {
      const res: any = await syncKuboMut.mutateAsync();
      setStatusBanner({
        text: `Kubo repo sync complete: ${res.imported} imported, ${res.skipped} already indexed (${res.totalKuboPins} total on node).`,
      });
    } catch (e: any) {
      setStatusBanner({ text: e.message, isError: true });
    } finally {
      setBusy('');
    }
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadFilename(f.name);
    setUploadMime(f.type || 'application/octet-stream');
    setUploadFile(f);
  };

  const handleUploadSubmit = async () => {
    setBusy('upload');
    setStatusBanner(null);
    setUploadProgress(null);
    try {
      if (uploadModalMode === 'cid') {
        if (!pinCidInput.trim()) throw new Error('Enter a CID to pin.');
        const res: any = await pinCidMut.mutateAsync({
          cid: pinCidInput.trim(),
          name: pinCidName.trim() || pinCidInput.trim(),
          vdxfUri: uploadVdxfUri.trim(),
        });
        setPendingCid(res.pin.cid);
        setStatusBanner({ text: `Pinned CID ${res.pin.cid}` });
      } else if (uploadFile) {
        const uri = uploadVdxfUri.trim();
        const res: any = await uploadFileMut.mutateAsync({
          file: uploadFile,
          filename: uploadFilename.trim() || uploadFile.name,
          vdxfUri: uri,
          onProgress: (done, total) => setUploadProgress({ done, total }),
        });
        setPendingCid(res.pin.cid);
        setUploadFile(null);
        setStatusBanner({ text: `Pinned ${res.pin.cid} (${formatBytes(res.info.size_bytes)})` });
      } else {
        const payload: any = {
          filename: uploadFilename.trim() || 'object.bin',
          mimeType: uploadMime.trim() || 'application/octet-stream',
          vdxfUri: uploadVdxfUri.trim() || 'sovpin::storage.pin.descriptor',
        };
        payload.contentText = uploadContent;
        const res: any = await uploadJsonMut.mutateAsync(payload);
        setPendingCid(res.pin.cid);
        setStatusBanner({ text: `Pinned ${res.pin.cid} (${formatBytes(res.info.size_bytes)})` });
      }
      setUploadModalMode('closed');
      setUploadProgress(null);
    } catch (e: any) {
      setStatusBanner({ text: e.message, isError: true });
    } finally {
      setBusy('');
      setUploadProgress(null);
    }
  };

  const doUnpin = async (ids: string[]) => {
    setStatusBanner(null);
    try {
      let last: any = null;
      for (const id of ids) {
        last = await unpinMut.mutateAsync(id);
        if (activeJob?.requestid === id) setActiveJob(null);
      }
      setStatusBanner({
        text:
          ids.length === 1
            ? `Unpinned ${last.cid} (active tenant refs remaining: ${last.remainingTenantReferences})`
            : `Unpinned ${ids.length} selected object(s).`,
      });
      setSelectedIds((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
    } catch (err: any) {
      setStatusBanner({ text: err.message, isError: true });
    }
  };

  const askUnpin = (requestId: string, name: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setConfirm({
      title: `Unpin "${name}"?`,
      body: `The object is removed from your tenant ledger. The CID stays pinned while any other tenant references it (current object: ${requestId}).`,
      confirmLabel: 'Unpin object',
      busyLabel: 'Unpinning…',
      onConfirm: () => doUnpin([requestId]),
    });
  };

  const askRevokeKey = (keyId: string, keyName: string) => {
    setConfirm({
      title: `Revoke key "${keyName}"?`,
      body: 'Backends using this bearer token lose API access immediately. This cannot be undone — mint a replacement first if anything depends on it.',
      confirmLabel: 'Revoke key',
      busyLabel: 'Revoking…',
      onConfirm: async () => {
        setBusy('key');
        setStatusBanner(null);
        try {
          await revokeKeyMut.mutateAsync(keyId);
          setStatusBanner({ text: `Revoked API key ${keyId}` });
          setConfirm(null);
        } catch (e: any) {
          setStatusBanner({ text: e.message, isError: true });
        } finally {
          setBusy('');
        }
      },
    });
  };

  const handleCreateKey = async () => {
    setBusy('key');
    setStatusBanner(null);
    try {
      const res: any = await createKeyMut.mutateAsync({
        name: newKeyName.trim() || 'api-key',
        scopes: newKeyScopes,
      });
      setRevealedKey(res.apiKey);
      setActiveApiKeySample(res.apiKey);
      setStatusBanner({
        text: `API key created successfully!`,
        isError: false,
        copyValue: res.apiKey,
        extra: {
          keyId: res.keyId,
          keyPrefix: res.keyPrefix,
          scopes: res.scopes,
          createdAt: res.createdAt,
        },
      });
    } catch (e: any) {
      setStatusBanner({ text: e.message, isError: true });
    } finally {
      setBusy('');
    }
  };

  const handleCreateWebhook = async () => {
    setBusy('webhook');
    setStatusBanner(null);
    if (!/^https?:\/\//i.test(newWebhookUrl.trim())) {
      setWebhookUrlError('Webhook URL must start with http(s)://');
      setBusy('');
      document.getElementById('dash-webhook-url')?.focus();
      return;
    }
    if (selectedWebhookEvents.size === 0) {
      setWebhookUrlError('Select at least one event to subscribe to.');
      setBusy('');
      return;
    }
    setWebhookUrlError(null);
    try {
      const res: any = await createWebhookMut.mutateAsync({
        url: newWebhookUrl.trim(),
        events: Array.from(selectedWebhookEvents).join(','),
      });
      setRevealedWebhookSecret(res.secret);
      setNewWebhookUrl('');
      setSelectedWebhookEvents(new Set(['pin.created', 'pin.deleted']));
      setStatusBanner({
        text: `Webhook registered: ${res.webhookId}\n\nSecret: ${res.secret}`,
        isError: false,
        copyValue: res.secret,
      });
    } catch (e: any) {
      setStatusBanner({ text: e.message, isError: true });
    } finally {
      setBusy('');
    }
  };

  const askDeleteWebhook = (webhookId: string, url: string) => {
    setConfirm({
      title: 'Delete webhook?',
      body: `Delivery to ${url} stops immediately. Re-register to resume pin and chain events.`,
      confirmLabel: 'Delete webhook',
      busyLabel: 'Deleting…',
      onConfirm: async () => {
        try {
          await deleteWebhookMut.mutateAsync(webhookId);
          setStatusBanner({ text: `Deleted webhook ${webhookId}` });
          setConfirm(null);
        } catch (e: any) {
          setStatusBanner({ text: e.message, isError: true });
        }
      },
    });
  };

  const selectedRequestIds = Object.keys(selectedIds).filter((id) => selectedIds[id]);

  const handleBulkVerify = async () => {
    if (selectedRequestIds.length === 0) return;
    setBusy('bulk-verify');
    try {
      let okCount = 0;
      for (const id of selectedRequestIds) {
        const res: any = await verifyMut.mutateAsync(id);
        if (res.ok) okCount++;
      }
      setStatusBanner({
        text: `Verified ${okCount}/${selectedRequestIds.length} selected pin(s) on Kubo.`,
        isError: okCount !== selectedRequestIds.length,
      });
    } catch (e: any) {
      setStatusBanner({ text: e.message, isError: true });
    } finally {
      setBusy('');
    }
  };

  const askBulkUnpin = () => {
    if (selectedRequestIds.length === 0) return;
    const ids = [...selectedRequestIds];
    setConfirm({
      title: `Unpin ${ids.length} selected object(s)?`,
      body: 'Each object is removed from your tenant ledger. CIDs referenced by other tenants stay pinned.',
      confirmLabel: `Unpin ${ids.length} object(s)`,
      busyLabel: 'Unpinning…',
      onConfirm: async () => {
        setBusy('bulk-unpin');
        try {
          await doUnpin(ids);
          setConfirm(null);
        } finally {
          setBusy('');
        }
      },
    });
  };

  const handleVerifyPin = async (requestId: string) => {
    setBusy('verify');
    try {
      const res: any = await verifyMut.mutateAsync(requestId);
      setStatusBanner({
        text: res.ok
          ? `Verified ${res.cid} on Kubo: pinned=${res.kuboPinned}, size=${formatBytes(res.actualSizeBytes)}, SHA-256 matches.`
          : `Verification mismatch for ${res.cid}: pinned=${res.kuboPinned}, sizeMatches=${res.sizeMatches}, sha256Matches=${res.sha256Matches}`,
        isError: !res.ok,
      });
    } catch (e: any) {
      setStatusBanner({ text: e.message, isError: true });
    } finally {
      setBusy('');
    }
  };

  const activeKeys = keys.filter((k) => !k.revoked);
  const displayKey =
    revealedKey ||
    activeApiKeySample ||
    (activeKeys[0]?.key_prefix ? `${activeKeys[0].key_prefix.replace('...', '')}SECRET` : 'svp_live_TOKEN');

  const usedPct = Math.min(
    100,
    (account.usage.usedBytes / Math.max(1, account.plan.storageLimitBytes)) * 100
  );
  const repoBytes = Number(kuboStats?.repoSize || 0);
  const bwOutBytes = Number(kuboStats?.bandwidth?.totalOut || 0);

  const vdxf = activeJob?.verus_vdxf;
  const activeCid = activeJob?.pin?.cid;
  const activeGatewayUrl =
    vdxf?.gatewayUrl || activeJob?.info?.gateway_url || (activeCid ? `https://ipfs.sovpin.com/ipfs/${activeCid}` : '');
  const activeSha256 = vdxf?.sha256Hex || activeJob?.info?.sha256 || null;
  const activeVdxfUri = vdxf?.vdxfUri || activeJob?.info?.vdxf_uri || 'sovpin::storage.pin.descriptor';
  const activeVdxfId = vdxf?.vdxfId || activeJob?.info?.vdxf_id || '— (App-managed CMM schema)';
  const friendlyId = account.tenant.friendly_name.replace(/@$/, '');

  const inspectorSnippets = activeJob
    ? {
        cmm: vdxf
          ? `verus -chain=VRSCTEST updateidentity '${JSON.stringify({
              ...vdxf.cmmUpdatePayload,
              name: friendlyId,
            })}'`
          : `// Uploaded without vdxfUri (application manages its own CMM schema)\n// CID: ${activeCid}\n// SHA-256: ${activeSha256 || 'n/a'}`,
        curl: `curl -X POST 'https://dashboard.sovpin.com/v1/pin/upload/stream?vdxfUri=${encodeURIComponent(activeVdxfUri)}' \\\n  -H "Authorization: Bearer ${displayKey}" \\\n  -F 'file=@./${activeJob.pin.name}'`,
        sdk: `const form = new FormData();
form.append('file', new Blob([fileBuffer], { type: '${activeJob.info.mime_type}' }), '${activeJob.pin.name}');

const res = await fetch(
  'https://dashboard.sovpin.com/v1/pin/upload/stream?vdxfUri=${encodeURIComponent(activeVdxfUri)}',
  {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ${displayKey}',
    },
    body: form,
  }
);
const { pin, info, verus_vdxf } = await res.json();
// Gateway: ${activeGatewayUrl}`,
        ipfs: `# Standard IPFS Pinning Service Spec
ipfs pin remote service add sovpin https://dashboard.sovpin.com/v1 ${displayKey}
ipfs pin remote add --service=sovpin --name="${activeJob.pin.name}" ${activeCid}`,
      }
    : null;

  return (
    <div className="space-y-4" aria-busy={loading}>
      {loading && (
        <div className="border border-[#22262E] bg-[#111317] px-3 py-2 text-xs font-mono text-[#9CA3AF]" role="status">
          Loading ledger — pins, keys, webhooks…
        </div>
      )}
      {loadError && !loading && (
        <div className="border border-red-800 bg-[#181B20] px-3 py-2 text-xs font-mono text-red-400 flex flex-wrap items-center justify-between gap-2" role="alert">
          <span>Ledger failed to load: {loadError}</span>
          <button type="button" onClick={() => reload()} className="px-2 py-0.5 border border-red-800 hover:border-red-400 cursor-pointer">
            Retry
          </button>
        </div>
      )}
      {uploadProgress && busy === 'upload' && (
        <div className="border border-[#22262E] bg-[#111317] px-3 py-2 text-xs font-mono text-[#9CA3AF]" role="status" aria-live="polite">
          <span>Uploading part {uploadProgress.done}/{uploadProgress.total}…</span>
          <div className="mt-1 h-[2px] bg-[#22262E]">
            <div className="h-full bg-[#10B981]" style={{ width: `${Math.round((uploadProgress.done / Math.max(1, uploadProgress.total)) * 100)}%` }} />
          </div>
        </div>
      )}
      {statusBanner && (
        <Dialog
          open
          tone={statusBanner.isError ? 'error' : 'success'}
          label={statusBanner.isError ? 'Error' : 'Success'}
          onClose={() => setStatusBanner(null)}
        >
          <div className="flex items-start gap-2.5">
            <span className="text-lg leading-none" aria-hidden="true">
              {statusBanner.isError ? '✕' : '✓'}
            </span>
            <span className="leading-relaxed whitespace-pre-wrap break-all">{statusBanner.text}</span>
          </div>
          {!statusBanner.isError && !statusBanner.copyValue && (
            <div className="mt-3 text-[10px] text-[#6B7280]">
              This message will auto-dismiss in 3 seconds.
            </div>
          )}
          {statusBanner.copyValue && (
            <div className="mt-3 space-y-2">
              {statusBanner.extra && (
                <div className="border border-[#22262E] bg-[#090A0C] p-3 space-y-1.5 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-[#6B7280]">Key ID:</span>
                    <span className="text-[#F3F4F6] font-mono">{statusBanner.extra.keyId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#6B7280]">Prefix:</span>
                    <span className="text-[#10B981] font-mono">{statusBanner.extra.keyPrefix}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#6B7280]">Scopes:</span>
                    <span className="text-[#9CA3AF] font-mono">{statusBanner.extra.scopes}</span>
                  </div>
                  <div className="border-t border-[#22262E] pt-2 mt-1.5">
                    <div className="text-[#6B7280] mb-1">Secret Access Key:</div>
                    <code className="text-[#F3F4F6] break-all select-all text-[11px]">{statusBanner.copyValue}</code>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const text = statusBanner.extra
                        ? `Key ID: ${statusBanner.extra.keyId}\nSecret: ${statusBanner.copyValue}\nScopes: ${statusBanner.extra.scopes}`
                        : statusBanner.copyValue!;
                      await navigator.clipboard.writeText(text);
                      setStatusBanner({ text: 'Copied to clipboard!', isError: false });
                    } catch {
                      setStatusBanner({ text: 'Copy failed — select the text manually', isError: true });
                    }
                  }}
                  className="flex-1 px-4 py-2 bg-[#10B981] text-[#090A0C] font-bold text-sm cursor-pointer flex items-center justify-center gap-2"
                >
                  <Copy className="w-4 h-4" />
                  <span>Copy All</span>
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(statusBanner.copyValue!);
                      setStatusBanner({ text: 'Secret copied to clipboard!', isError: false });
                    } catch {
                      setStatusBanner({ text: 'Copy failed — select the text manually', isError: true });
                    }
                  }}
                  className="flex-1 px-4 py-2 bg-[#181B20] border border-[#22262E] text-[#F3F4F6] font-bold text-sm cursor-pointer flex items-center justify-center gap-2 hover:border-[#10B981]"
                >
                  <Copy className="w-4 h-4" />
                  <span>Copy Secret Only</span>
                </button>
              </div>
              <div className="text-[10px] text-[#F97316] text-center">
                ⚠ This secret will NOT be shown again. Save it now.
              </div>
            </div>
          )}
        </Dialog>
      )}
      <ConfirmDialog pending={confirm} onCancel={() => setConfirm(null)} />

      {/* One-time Revealed Secret Key Strip */}
      {revealedKey && (
        <div className="bg-[#111317] border border-[#10B981] px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="px-1.5 py-0.5 bg-[#10B981] text-[#090A0C] font-bold text-[10px] uppercase shrink-0">
              Secret Key (Copy Now)
            </span>
            <code className="text-[#F3F4F6] select-all break-all text-[11px]">{revealedKey}</code>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(revealedKey);
                  setStatusBanner({ text: 'API key copied to clipboard' });
                } catch {
                  setStatusBanner({ text: 'Copy failed — select the text manually', isError: true });
                }
              }}
              className="px-3 py-1.5 bg-[#10B981] text-[#090A0C] font-bold text-xs cursor-pointer flex items-center gap-1.5"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy Key</span>
            </button>
            <button onClick={() => setRevealedKey('')} className="px-3 py-1.5 bg-[#181B20] border border-[#22262E] text-[#9CA3AF] hover:text-[#F3F4F6] text-xs cursor-pointer">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* 1. TELEMETRY & STORAGE LEDGER STRIP (4 Segmented Cells, 1px Hairline Grid) */}
      <div className="grid grid-cols-1 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-[#22262E] border border-[#22262E] bg-[#111317]">
        {/* Cell 1: Total Stored */}
        <div className="px-4 py-3 flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between text-[11px] text-[#9CA3AF] uppercase tracking-wider font-mono">
            <span>Total Stored (DAG / Repo)</span>
            <span className="text-[#10B981]">{account.plan.name}</span>
          </div>
          <div className="flex items-baseline justify-between font-mono tabular-nums">
            <span className="text-base font-bold text-[#F3F4F6]">
              {formatBytes(account.usage.usedBytes)}{' '}
              <span className="text-xs font-normal text-[#6B7280]">
                / {formatBytes(account.plan.storageLimitBytes)}
              </span>
            </span>
            <span className="text-[11px] text-[#9CA3AF]">Repo: {formatBytes(repoBytes)}</span>
          </div>
          {/* 2px Segmented Progress Bar (Pinned DAG vs Kubo Repo Overhead) */}
          <div className="w-full h-[2px] bg-[#22262E] flex overflow-hidden">
            <div
              className="h-full bg-[#10B981]"
              style={{ width: `${Math.max(2, usedPct)}%` }}
              title="Pinned Tenant DAG"
            />
            <div
              className="h-full bg-[#F97316]"
              style={{ width: '8%' }}
              title="Kubo Blockstore Overhead"
            />
          </div>
        </div>

        {/* Cell 2: Bandwidth (30d) + Inline Bar Chart */}
        <div className="px-4 py-3 flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between text-[11px] text-[#9CA3AF] uppercase tracking-wider font-mono">
            <span>Bandwidth (30d Egress)</span>
            <span className="text-[#9CA3AF]">CF Edge</span>
          </div>
          <div className="flex items-end justify-between gap-3">
            <div className="font-mono tabular-nums">
              <div className="text-base font-bold text-[#F3F4F6]">
                {formatBytes(bwOutBytes)}{' '}
                <span className="text-xs font-normal text-[#6B7280]">egress</span>
              </div>
            </div>
            {/* Compact Inline Bar Chart */}
            <div className="flex items-end gap-[2px] h-5">
              {[25, 40, 35, 60, 50, 75, 65, 90, 80, 95, 70, 100].map((h, i) => (
                <span
                  key={i}
                  className="w-[3px] bg-[#10B981]/80"
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
          </div>
          <div className="text-[11px] font-mono text-[#6B7280] tabular-nums">
            Quota: {formatBytes(account.plan.gatewayBandwidthBytes)} / mo · Cache TTL: 1yr
          </div>
        </div>

        {/* Cell 3: Total Pinned Objects */}
        <div className="px-4 py-3 flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between text-[11px] text-[#9CA3AF] uppercase tracking-wider font-mono">
            <span>Total Pinned Objects</span>
            <span className="text-[#10B981]">100% Replicated</span>
          </div>
          <div className="flex items-baseline justify-between font-mono tabular-nums">
            <span className="text-base font-bold text-[#F3F4F6]">{pins.length} CIDs</span>
            <span className="text-[11px] text-[#9CA3AF]">
              {kuboStats?.numObjects ?? 0} DAG blocks
            </span>
          </div>
          <div className="text-[11px] font-mono text-[#6B7280] tabular-nums">
            Replication: 1/1 nodes (`kubo-macbook-01`) · {account.usage.activeWatchers} CMM watcher
          </div>
        </div>

        {/* Cell 4: Dedicated Gateway */}
        <div className="px-4 py-3 flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between text-[11px] text-[#9CA3AF] uppercase tracking-wider font-mono">
            <span>Dedicated Gateway</span>
            <span className="px-1.5 py-0.2 bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30 text-[10px]">
              1yr Edge TTL
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 font-mono text-xs text-[#F3F4F6]">
            <span className="truncate">https://ipfs.sovpin.com</span>
            <CopyInline value="https://ipfs.sovpin.com" />
          </div>
          <div className="text-[11px] font-mono text-[#6B7280] truncate">
            Project VDXF keys resolved with getvdxfid
          </div>
        </div>
      </div>

      {/* 2. MAIN WORKSPACE: HIGH-DENSITY CID TABLE + SLIDE-OVER RIGHT INSPECTOR */}
      <div className="flex flex-col lg:flex-row border border-[#22262E] bg-[#111317]">
        {/* Left/Center: Filter Toolbar + High-Density Data Grid */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Table Filter & Action Toolbar */}
          <div className="px-3 py-2 border-b border-[#22262E] flex flex-wrap items-center justify-between gap-2 bg-[#090A0C]">
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[240px]">
              <div className="relative flex-1 max-w-xs">
                <Search className="w-3.5 h-3.5 text-[#6B7280] absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <label htmlFor="pin-filter" className="sr-only">Filter by CID, filename, or VDXF key</label>
                <input
                  id="pin-filter"
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter CID, filename, VDXF key..."
                  className="w-full bg-[#111317] border border-[#22262E] focus:border-[#10B981] rounded-sm pl-8 pr-7 py-1 text-xs font-mono text-[#F3F4F6] placeholder-[#6B7280] focus:outline-none"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2">
                  <Kbd>/</Kbd>
                </span>
              </div>

              <label htmlFor="mime-filter" className="sr-only">Filter by MIME type</label>
              <select
                id="mime-filter"
                value={mimeFilter}
                onChange={(e) => setMimeFilter(e.target.value)}
                className="bg-[#111317] border border-[#22262E] rounded-sm px-2.5 py-1 text-xs font-mono text-[#9CA3AF] focus:outline-none focus:border-[#10B981]"
              >
                <option value="all">MIME: All ({pins.length})</option>
                <option value="image/*">image/*</option>
                <option value="audio/*">audio/*</option>
                <option value="video/*">video/*</option>
                <option value="application/json">application/json</option>
                <option value="application/octet-stream">application/octet-stream</option>
              </select>

              <label htmlFor="date-from" className="sr-only">Filter from date</label>
              <input
                id="date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="bg-[#111317] border border-[#22262E] rounded-sm px-2.5 py-1 text-xs font-mono text-[#9CA3AF] focus:outline-none focus:border-[#10B981]"
              />
              <label htmlFor="date-to" className="sr-only">Filter to date</label>
              <input
                id="date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="bg-[#111317] border border-[#22262E] rounded-sm px-2.5 py-1 text-xs font-mono text-[#9CA3AF] focus:outline-none focus:border-[#10B981]"
              />
            </div>

            <div className="flex items-center gap-1.5">
              {selectedRequestIds.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={handleBulkVerify}
                    disabled={busy === 'bulk-verify'}
                    className="px-2.5 py-1 bg-[#111317] hover:bg-[#181B20] border border-[#10B981]/50 rounded-sm text-xs font-mono text-[#10B981] cursor-pointer"
                  >
                    {busy === 'bulk-verify'
                      ? 'Verifying...'
                      : `✓ Verify (${selectedRequestIds.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={askBulkUnpin}
                    disabled={busy === 'bulk-unpin'}
                    className="px-2.5 py-1 bg-[#111317] hover:bg-[#181B20] border border-red-800 rounded-sm text-xs font-mono text-red-400 cursor-pointer"
                  >
                    {busy === 'bulk-unpin'
                      ? 'Unpinning...'
                      : `Unpin (${selectedRequestIds.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds({})}
                    className="px-2 py-1 text-xs font-mono text-[#6B7280] hover:text-[#F3F4F6] cursor-pointer"
                  >
                    Clear
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={handleSyncKubo}
                disabled={busy === 'sync'}
                className="px-2.5 py-1 bg-[#111317] hover:bg-[#181B20] border border-[#22262E] rounded-sm text-xs font-mono text-[#9CA3AF] hover:text-[#F3F4F6] flex items-center gap-1.5 transition duration-75 cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${busy === 'sync' ? 'animate-spin' : ''}`} />
                <span>Sync Kubo</span>
              </button>

              <button
                type="button"
                onClick={() => setUploadModalMode('cid')}
                className="px-2.5 py-1 bg-[#111317] hover:bg-[#181B20] border border-[#22262E] rounded-sm text-xs font-mono text-[#F3F4F6] flex items-center gap-1.5 transition duration-75 cursor-pointer"
              >
                <Hash className="w-3 h-3 text-[#F97316]" />
                <span>Pin by CID</span>
                <Kbd>C</Kbd>
              </button>

              <button
                type="button"
                onClick={() => setUploadModalMode('upload')}
                disabled={busy === 'upload' || health?.healthy === false}
                title={health?.healthy === false ? 'Backend offline — uploads disabled' : 'Upload Object (U)'}
                className="px-3 py-1 bg-[#10B981] hover:bg-[#10B981]/90 text-[#090A0C] font-semibold rounded-sm text-xs font-mono flex items-center gap-1.5 transition duration-75 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Object</span>
                <kbd className="px-1 py-0.2 text-[10px] font-mono bg-[#090A0C]/20 text-[#090A0C] rounded-sm">
                  U
                </kbd>
              </button>
            </div>
          </div>

          {/* Inline Upload / Pin-by-CID Drawer Bar when triggered */}
          {uploadModalMode !== 'closed' && (
            <div className="p-3 border-b border-[#22262E] bg-[#181B20] space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-mono">
                  <span className="text-[#10B981] font-bold uppercase">
                    {uploadModalMode === 'cid' ? 'Pin Existing CID on Kubo' : 'Upload Object & Build VDXF Descriptor'}
                  </span>
                </div>
                <button
                  onClick={() => setUploadModalMode('closed')}
                  className="text-xs font-mono text-[#6B7280] hover:text-[#F3F4F6] flex items-center gap-1"
                >
                  <span>Close</span>
                  <Kbd>Esc</Kbd>
                </button>
              </div>

              {uploadModalMode === 'cid' ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label htmlFor="dash-pin-cid" className="sr-only">CID to pin</label>
                  <input
                    id="dash-pin-cid"
                    type="text"
                    value={pinCidInput}
                    onChange={(e) => setPinCidInput(e.target.value)}
                    placeholder="CID (Qm... or bafy...)"
                    className="bg-[#090A0C] border border-[#22262E] rounded-sm px-2.5 py-1.5 text-xs font-mono text-[#F3F4F6]"
                  />
                  <label htmlFor="dash-pin-name" className="sr-only">Object name (optional)</label>
                  <input
                    id="dash-pin-name"
                    type="text"
                    value={pinCidName}
                    onChange={(e) => setPinCidName(e.target.value)}
                    placeholder="Object name (optional)"
                    className="bg-[#090A0C] border border-[#22262E] rounded-sm px-2.5 py-1.5 text-xs font-mono text-[#F3F4F6]"
                  />
                  <button
                    onClick={handleUploadSubmit}
                    disabled={busy === 'upload'}
                    className="bg-[#10B981] text-[#090A0C] font-mono font-semibold text-xs py-1.5 px-3 rounded-sm cursor-pointer"
                  >
                    {busy === 'upload' ? 'Pinning...' : 'Execute Pin'}
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                    <label htmlFor="dash-upload-filename" className="sr-only">Filename</label>
                    <input
                      id="dash-upload-filename"
                      type="text"
                      value={uploadFilename}
                      onChange={(e) => setUploadFilename(e.target.value)}
                      placeholder="Filename"
                      className="bg-[#090A0C] border border-[#22262E] rounded-sm px-2.5 py-1.5 text-xs font-mono text-[#F3F4F6]"
                    />
                    <label htmlFor="dash-upload-mime" className="sr-only">MIME type</label>
                    <input
                      id="dash-upload-mime"
                      type="text"
                      value={uploadMime}
                      onChange={(e) => setUploadMime(e.target.value)}
                      placeholder="MIME type"
                      className="bg-[#090A0C] border border-[#22262E] rounded-sm px-2.5 py-1.5 text-xs font-mono text-[#F3F4F6]"
                    />
                    <label htmlFor="dash-upload-vdxf" className="sr-only">VDXF URI</label>
                    <input
                      id="dash-upload-vdxf"
                      type="text"
                      value={uploadVdxfUri}
                      onChange={(e) => setUploadVdxfUri(e.target.value)}
                      placeholder="VDXF URI"
                      className="bg-[#090A0C] border border-[#22262E] rounded-sm px-2.5 py-1.5 text-xs font-mono text-[#F3F4F6]"
                    />
                    <label htmlFor="dash-upload-file" className="sr-only">File to upload</label>
                    <input
                      id="dash-upload-file"
                      type="file"
                      onChange={handleFilePick}
                      className="text-xs font-mono text-[#9CA3AF] file:mr-2 file:py-1 file:px-2 file:bg-[#111317] file:border file:border-[#22262E] file:text-xs file:font-mono file:text-[#F3F4F6]"
                    />
                  </div>
                  {!uploadFile && (
                    <>
                      <label htmlFor="dash-upload-content" className="sr-only">Object content JSON</label>
                      <textarea
                        id="dash-upload-content"
                        rows={3}
                        value={uploadContent}
                        onChange={(e) => setUploadContent(e.target.value)}
                        className="w-full bg-[#090A0C] border border-[#22262E] rounded-sm p-2 text-xs font-mono text-[#F3F4F6]"
                      />
                    </>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={handleUploadSubmit}
                      disabled={busy === 'upload'}
                      className="bg-[#10B981] text-[#090A0C] font-mono font-semibold text-xs py-1.5 px-4 rounded-sm cursor-pointer"
                    >
                      {busy === 'upload' ? 'Uploading to Kubo...' : 'Pin to Kubo & Generate VDXF'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* High-Density CID Browser Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#22262E] bg-[#090A0C] text-[10px] font-mono uppercase tracking-wider text-[#6B7280]">
                  <th scope="col" className="py-2 px-3 w-8">
                    <label className="sr-only" htmlFor="select-all-pins">Select all pins</label>
                    <input
                      id="select-all-pins"
                      type="checkbox"
                      checked={filteredPins.length > 0 && filteredPins.every((p) => selectedIds[p.requestid])}
                      onChange={(e) => {
                        const next: Record<string, boolean> = {};
                        if (e.target.checked) {
                          filteredPins.forEach((p) => {
                            next[p.requestid] = true;
                          });
                        }
                        setSelectedIds(next);
                      }}
                      className="accent-[#10B981]"
                    />
                  </th>
                  <th scope="col" className="py-2 px-3">Object Name</th>
                  <th scope="col" className="py-2 px-3">IPFS CID</th>
                  <th scope="col" className="py-2 px-3">Pin Status</th>
                  <th scope="col" className="py-2 px-3">MIME Type</th>
                  <th scope="col" className="py-2 px-3 text-right">Size</th>
                  <th scope="col" className="py-2 px-3">Created (UTC)</th>
                  <th scope="col" className="py-2 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#22262E] text-xs font-mono tabular-nums">
                {filteredPins.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 px-3 text-center">
                      {pins.length === 0 ? (
                        <div className="space-y-3 max-w-md mx-auto">
                          <div className="text-[#9CA3AF] text-sm font-sans">
                            No pinned objects yet. Get started in 3 steps:
                          </div>
                          <div className="text-left space-y-2 text-[11px] text-[#6B7280]">
                            <div className="flex items-start gap-2">
                              <span className="text-[#10B981] font-bold">1.</span>
                              <span>
                                <strong className="text-[#F3F4F6]">Mint an API Key</strong> — Use the Access Keys table below to create a scoped{' '}
                                <code className="font-mono text-[#10B981]">svp_live_...</code> token.
                              </span>
                            </div>
                            <div className="flex items-start gap-2">
                              <span className="text-[#10B981] font-bold">2.</span>
                              <span>
                                <strong className="text-[#F3F4F6]">Upload an Object</strong> — Press{' '}
                                <kbd className="px-1 py-0.2 text-[10px] font-mono bg-[#090A0C] border border-[#22262E] text-[#F3F4F6] rounded-sm">U</kbd>{' '}
                                or click "Upload Object" to stream a file to Kubo and get a Verus URLRef.
                              </span>
                            </div>
                            <div className="flex items-start gap-2">
                              <span className="text-[#10B981] font-bold">3.</span>
                              <span>
                                <strong className="text-[#F3F4F6]">Anchor On-Chain</strong> — Copy the generated{' '}
                                <code className="font-mono text-[#F97316]">updateidentity</code> command and run it in your Verus wallet to commit the CID to your VerusID's ContentMultiMap.
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setUploadModalMode('upload')}
                            className="px-4 py-2 bg-[#10B981] text-[#090A0C] font-semibold text-xs cursor-pointer"
                          >
                            Upload Your First Object →
                          </button>
                        </div>
                      ) : (
                        <span>No matching CIDs. Adjust your filters or search query.</span>
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredPins.map((job) => {
                    const isSelected = activeJob?.requestid === job.requestid;
                    const isJson = String(job.info.mime_type).includes('json');
                    return (
                      <tr
                        key={job.requestid}
                        onClick={() => setActiveJob(job)}
                        className={`cursor-pointer transition duration-75 ${
                          isSelected ? 'bg-[#181B20]' : 'hover:bg-[#16191F]'
                        }`}
                      >
                        <td className="py-1.5 px-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${job.pin.name} (${job.pin.cid})`}
                            checked={Boolean(selectedIds[job.requestid])}
                            onChange={(e) =>
                              setSelectedIds((prev) => ({
                                ...prev,
                                [job.requestid]: e.target.checked,
                              }))
                            }
                            className="accent-[#10B981]"
                          />
                        </td>
                        <td className="py-1.5 px-3">
                          <div className="flex items-center gap-2">
                            {isJson ? (
                              <FileCode className="w-3.5 h-3.5 text-[#10B981] shrink-0" />
                            ) : (
                              <Package className="w-3.5 h-3.5 text-[#9CA3AF] shrink-0" />
                            )}
                            <span className="text-[#F3F4F6] font-sans font-medium truncate max-w-[190px]">
                              {job.pin.name}
                            </span>
                            <span className="text-[10px] px-1 py-0.2 bg-[#090A0C] border border-[#22262E] text-[#6B7280]">
                              {isJson ? 'JSON' : 'DAG'}
                            </span>
                          </div>
                        </td>
                        <td className="py-1.5 px-3">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[#9CA3AF]" title={job.pin.cid}>
                              {truncateMiddle(job.pin.cid, 10, 7)}
                            </span>
                            <CopyInline value={job.pin.cid} />
                          </div>
                        </td>
                        <td className="py-1.5 px-3">
                          <div className="inline-flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
                            <span className="text-[#F3F4F6]">Pinned</span>
                            <span className="text-[#6B7280] text-[10px]">1/1</span>
                          </div>
                        </td>
                        <td className="py-1.5 px-3 text-[#9CA3AF] truncate max-w-[160px]" title={job.info.mime_type}>
                          {job.info.mime_type || 'application/octet-stream'}
                        </td>
                        <td className="py-1.5 px-3 text-right text-[#F3F4F6]">
                          {formatBytes(job.info.size_bytes)}
                        </td>
                        <td className="py-1.5 px-3 text-[#9CA3AF]">
                          {formatDateTime(job.created_at ?? job.created)}
                        </td>
                        <td className="py-1.5 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex items-center gap-2">
                            <a
                              href={job.info.gateway_url}
                              target="_blank"
                              rel="noreferrer"
                              title="Open on Gateway"
                              className="text-[#9CA3AF] hover:text-[#10B981] transition duration-75"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                            <button
                              type="button"
                              onClick={(e) => askUnpin(job.requestid, job.pin.name, e)}
                              title="Unpin CID"
                              className="text-[#6B7280] hover:text-red-400 transition duration-75 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* 3. RIGHT-HAND DEVELOPER INSPECTOR DRAWER (400px Wide, #111317, Left Border #22262E) */}
        <aside className="w-full lg:w-[400px] shrink-0 border-t lg:border-t-0 lg:border-l border-[#22262E] bg-[#111317] flex flex-col">
          <div className="px-3.5 py-2 border-b border-[#22262E] bg-[#090A0C] flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-[#9CA3AF]">
              Object &amp; VDXF Inspector
            </span>
            {activeJob && (
              <span className="text-[10px] font-mono text-[#10B981]">
                {activeJob.requestid}
              </span>
            )}
          </div>

          {!activeJob ? (
            <div className="p-6 text-xs font-mono text-[#6B7280] text-center">
              Select any CID row on the left to inspect its DAG metadata, gateway endpoints, and Verus VDXF
              DataDescriptor.
            </div>
          ) : (
            <div className="p-3.5 space-y-3.5 text-xs font-mono">
              {/* Object Header */}
              <div className="space-y-1 border-b border-[#22262E] pb-3">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] text-[#6B7280] uppercase">Object Name</div>
                  <button
                    type="button"
                    onClick={() => handleVerifyPin(activeJob.requestid)}
                    disabled={busy === 'verify'}
                    className="px-2 py-0.5 bg-[#090A0C] border border-[#22262E] hover:border-[#10B981] text-[10px] text-[#10B981] cursor-pointer"
                  >
                    {busy === 'verify' ? 'Verifying...' : '✓ Verify on Kubo'}
                  </button>
                </div>
                <div className="text-sm font-sans font-bold text-[#F3F4F6] break-all">
                  {activeJob.pin.name}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-[#9CA3AF] tabular-nums pt-0.5">
                  <span>Size: {formatBytes(activeJob.info.size_bytes)}</span>
                  <span>·</span>
                  <span>MIME: {activeJob.info.mime_type}</span>
                </div>
              </div>

              {/* Technical Identifiers */}
              <div className="space-y-2 border-b border-[#22262E] pb-3">
                <div>
                  <div className="flex items-center justify-between text-[10px] text-[#6B7280] uppercase mb-0.5">
                    <span>IPFS CID</span>
                    <CopyInline value={activeCid} label="Copy" />
                  </div>
                  <div className="bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-[11px] text-[#F3F4F6] break-all">
                    {activeCid}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between text-[10px] text-[#6B7280] uppercase mb-0.5">
                    <span>Dedicated Edge Gateway URL</span>
                    <CopyInline value={activeGatewayUrl} label="Copy" />
                  </div>
                  <div className="bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-[11px] text-[#10B981] truncate">
                    {activeGatewayUrl}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-[#6B7280] uppercase mb-0.5">
                      <span>VDXF Key ID</span>
                      {vdxf?.vdxfId && <CopyInline value={vdxf.vdxfId} />}
                    </div>
                    <div className="bg-[#090A0C] border border-[#22262E] px-2 py-1 text-[11px] text-[#9CA3AF] truncate">
                      {activeVdxfId}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-[#6B7280] uppercase mb-0.5">
                      <span>SHA-256 Digest</span>
                      {activeSha256 && <CopyInline value={activeSha256} />}
                    </div>
                    <div className="bg-[#090A0C] border border-[#22262E] px-2 py-1 text-[11px] text-[#9CA3AF] truncate">
                      {activeSha256 || 'Not verified for CID-only pins'}
                    </div>
                  </div>
                </div>

                {activeJob.verus_receipt && (
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-[#6B7280] uppercase mb-0.5">
                      <span>
                        Signed Receipt ({activeJob.verus_receipt.signerIdentity} · #{activeJob.verus_receipt.blockHeight})
                      </span>
                      <div className="flex items-center gap-2">
                        <CopyInline value={activeJob.verus_receipt.verifyCliCommand} label="Copy Verify CLI" />
                        <button
                          type="button"
                          onClick={async () => {
                            setBusy('verify-receipt');
                            try {
                              const r = await api(`/v1/pins/${activeJob.requestid}/receipt`, { method: 'POST' });
                              setStatusBanner({
                                text: r.verifiedOnChain
                                  ? `Receipt verified on-chain: ${r.receipt.signerIdentity} signed at Block #${r.receipt.blockHeight}`
                                  : `Receipt signature could not be verified on-chain`,
                                isError: !r.verifiedOnChain,
                              });
                              await invalidate();
                            } catch (e: any) {
                              setStatusBanner({ text: e.message, isError: true });
                            } finally {
                              setBusy('');
                            }
                          }}
                          disabled={busy === 'verify-receipt'}
                          className="px-2 py-0.5 bg-[#090A0C] border border-[#22262E] hover:border-[#10B981] text-[10px] text-[#10B981] cursor-pointer disabled:opacity-50"
                        >
                          {busy === 'verify-receipt' ? 'Verifying...' : '✓ Verify On-Chain'}
                        </button>
                      </div>
                    </div>
                    <div className="bg-[#090A0C] border border-[#22262E] px-2 py-1 text-[11px] text-[#10B981] truncate">
                      {activeJob.verus_receipt.signature}
                    </div>
                  </div>
                )}
              </div>

              {/* Replication Nodes */}
              <div className="space-y-1.5 border-b border-[#22262E] pb-3">
                <div className="text-[10px] text-[#6B7280] uppercase">Replication &amp; Edge Status</div>
                <div className="bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 space-y-1 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="text-[#F3F4F6]">● kubo-macbook-01 (UK/Tailscale)</span>
                    <span className="text-[#10B981]">Pinned</span>
                  </div>
                  <div className="flex items-center justify-between text-[#9CA3AF]">
                    <span>● Cloudflare Edge (`ipfs.sovpin.com`)</span>
                    <span>TTL 31536000s</span>
                  </div>
                </div>
              </div>

              {/* Tabbed Code Snippet Box */}
              {inspectorSnippets && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex border border-[#22262E] bg-[#090A0C]">
                      {(
                        [
                          ['cmm', 'Verus CMM'],
                          ['curl', 'cURL'],
                          ['sdk', 'TS SDK'],
                          ['ipfs', 'IPFS CLI'],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setSnippetTab(id)}
                          className={`px-2 py-1 text-[10px] font-mono cursor-pointer ${
                            snippetTab === id
                              ? 'bg-[#10B981] text-[#090A0C] font-bold'
                              : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <CopyInline value={inspectorSnippets[snippetTab]} label="Copy" />
                  </div>
                  <pre className="bg-[#090A0C] border border-[#22262E] p-2.5 text-[11px] text-[#F3F4F6] overflow-x-auto leading-relaxed max-h-48">
                    {inspectorSnippets[snippetTab]}
                  </pre>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {/* 5. WEBHOOKS LEDGER TABLE */}
      <div className="border border-[#22262E] bg-[#111317]">
        <div className="px-3.5 py-2 border-b border-[#22262E] bg-[#090A0C] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="uppercase tracking-wider text-[#F3F4F6] font-semibold">
              Outbound Webhooks (Pin &amp; Chain Events)
            </span>
            <span className="text-[#6B7280]">
              ({webhooks.length} registered)
            </span>
          </div>
        </div>
        <div className="p-3.5 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Field label="Webhook URL" htmlFor="dash-webhook-url" error={webhookUrlError} hint="HTTPS endpoint receiving pin & chain events">
              <input
                type="text"
                value={newWebhookUrl}
                onChange={(e) => {
                  setNewWebhookUrl(e.target.value);
                  if (webhookUrlError) setWebhookUrlError(null);
                }}
                placeholder="https://your-app.com/sovpin-webhook"
                inputMode="url"
                className="flex-1 bg-[#111317] border border-[#22262E] rounded-sm px-2.5 py-1 text-xs font-mono text-[#F3F4F6] focus:outline-none focus:border-[#10B981]"
              />
            </Field>
            <div className="flex flex-wrap items-start gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase text-[#6B7280] font-mono">Events to subscribe to</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedWebhookEvents.size === webhookEvents.length) {
                        setSelectedWebhookEvents(new Set());
                      } else {
                        setSelectedWebhookEvents(new Set(webhookEvents.map((e: any) => e.event)));
                      }
                    }}
                    className="text-[10px] font-mono text-[#10B981] hover:underline cursor-pointer"
                  >
                    {selectedWebhookEvents.size === webhookEvents.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {webhookEvents.length === 0 ? (
                    <span className="text-[10px] text-[#6B7280] font-mono">Loading events...</span>
                  ) : (
                    webhookEvents.map((ev: any) => {
                      const checked = selectedWebhookEvents.has(ev.event);
                      return (
                        <label
                          key={ev.event}
                          className={`flex items-center gap-1.5 px-2 py-1 border rounded-sm cursor-pointer text-[11px] font-mono transition duration-75 ${
                            checked
                              ? 'border-[#10B981]/50 bg-[#10B981]/10 text-[#10B981]'
                              : 'border-[#22262E] bg-[#090A0C] text-[#9CA3AF] hover:border-[#9CA3AF]'
                          }`}
                          title={ev.description}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSelectedWebhookEvents((prev) => {
                                const next = new Set(prev);
                                if (next.has(ev.event)) next.delete(ev.event);
                                else next.add(ev.event);
                                return next;
                              });
                            }}
                            className="accent-[#10B981] w-3 h-3"
                          />
                          {ev.event}
                        </label>
                      );
                    })
                  )}
                </div>
                {selectedWebhookEvents.size > 0 && (
                  <div className="text-[10px] text-[#6B7280] font-mono">
                    {selectedWebhookEvents.size} of {webhookEvents.length} events selected
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={handleCreateWebhook}
              disabled={busy === 'webhook'}
              className="px-2.5 py-1 bg-[#10B981] hover:bg-[#10B981]/90 text-[#090A0C] font-mono font-semibold text-xs rounded-sm flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Register</span>
            </button>
          </div>
          {statusBanner?.isError && (
            <div className="px-3 py-2 border border-red-800 bg-[#181B20] text-red-400 text-xs font-mono">
              {statusBanner.text}
            </div>
          )}
          {revealedWebhookSecret && (
            <div className="bg-[#111317] border border-[#10B981] px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="px-1.5 py-0.5 bg-[#10B981] text-[#090A0C] font-bold text-[10px] uppercase shrink-0">
                  Webhook Secret (Copy Now)
                </span>
                <code className="text-[#F3F4F6] select-all break-all text-[11px]">{revealedWebhookSecret}</code>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(revealedWebhookSecret);
                      setStatusBanner({ text: 'Webhook secret copied to clipboard' });
                    } catch {
                      setStatusBanner({ text: 'Copy failed — select the text manually', isError: true });
                    }
                  }}
                  className="px-3 py-1.5 bg-[#10B981] text-[#090A0C] font-bold text-xs cursor-pointer flex items-center gap-1.5"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Secret</span>
                </button>
                <button onClick={() => setRevealedWebhookSecret('')} className="px-3 py-1.5 bg-[#181B20] border border-[#22262E] text-[#9CA3AF] hover:text-[#F3F4F6] text-xs cursor-pointer">
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {webhooks.length === 0 ? (
            <div className="py-4 text-center text-[#6B7280] text-xs">
              No webhooks registered. Register an HTTPS endpoint to receive pin &amp; chain events.
            </div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left border-collapse text-xs font-mono tabular-nums">
              <thead>
                <tr className="border-b border-[#22262E] text-[10px] uppercase tracking-wider text-[#6B7280] bg-[#090A0C]/50">
                  <th scope="col" className="py-1.5 px-3">URL</th>
                  <th scope="col" className="py-1.5 px-3">Events</th>
                  <th scope="col" className="py-1.5 px-3">Created</th>
                  <th scope="col" className="py-1.5 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#22262E]">
                {webhooks.map((w: any) => (
                  <tr key={w.webhook_id} className="hover:bg-[#16191F] transition duration-75">
                    <td className="py-1.5 px-3 text-[#10B981] truncate max-w-[280px]">{w.url}</td>
                    <td className="py-1.5 px-3 text-[#9CA3AF]">
                      <div className="flex flex-wrap gap-1">
                        {String(w.events || '')
                          .split(',')
                          .filter(Boolean)
                          .map((ev: string) => (
                            <span
                              key={ev}
                              className="px-1.5 py-0.5 bg-[#10B981]/10 border border-[#10B981]/30 text-[#10B981] text-[10px]"
                            >
                              {ev}
                            </span>
                          ))}
                      </div>
                    </td>
                    <td className="py-1.5 px-3 text-[#6B7280]">{formatDateTime(w.created_at)}</td>
                    <td className="py-1.5 px-3 text-right">
                      <button
                        onClick={() => askDeleteWebhook(w.webhook_id, w.url)}
                        className="text-[#9CA3AF] hover:text-red-400 cursor-pointer"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>

      {/* 4. ACCESS KEYS LEDGER TABLE (Compact, Utilitarian) */}
      <div className="border border-[#22262E] bg-[#111317]">
        <div className="px-3.5 py-2 border-b border-[#22262E] bg-[#090A0C] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-mono">
            <Key className="w-3.5 h-3.5 text-[#10B981]" />
            <span className="uppercase tracking-wider text-[#F3F4F6] font-semibold">
              Access Keys (`Authorization: Bearer svp_live_...`)
            </span>
            <span className="text-[#6B7280]">
              ({activeKeys.length} active / {keys.length} total)
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <label className="flex items-center gap-1.5 text-[10px] text-[#6B7280] cursor-pointer mr-2">
              <input
                type="checkbox"
                checked={showRevokedKeys}
                onChange={(e) => setShowRevokedKeys(e.target.checked)}
                className="accent-[#10B981]"
              />
              Show revoked ({keys.filter((k: any) => k.revoked).length})
            </label>
            {keys.filter((k: any) => k.revoked).length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setConfirm({
                    title: 'Permanently delete revoked keys?',
                    body: 'Revoked key records are purged from the ledger. This cannot be undone.',
                    confirmLabel: 'Delete revoked keys',
                    busyLabel: 'Cleaning…',
                    onConfirm: async () => {
                      setBusy('cleanup');
                      try {
                        const res = await api('/v1/keys/cleanup-revoked', { method: 'DELETE' });
                        setStatusBanner({ text: `Permanently deleted ${res.deletedCount} revoked key(s)` });
                        await invalidate();
                      } catch (e: any) {
                        setStatusBanner({ text: e.message, isError: true });
                      } finally {
                        setBusy('');
                      }
                    },
                  })
                }
                disabled={busy === 'cleanup'}
                className="px-2.5 py-1 bg-[#181B20] border border-red-800 text-red-400 hover:bg-red-900/20 font-mono text-xs rounded-sm flex items-center gap-1 cursor-pointer"
              >
                {busy === 'cleanup' ? 'Cleaning...' : `Clean up revoked (${keys.filter((k: any) => k.revoked).length})`}
              </button>
            )}
            <label htmlFor="dash-key-name" className="sr-only">New API key name</label>
            <input
              id="dash-key-name"
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="key-identifier"
              className="bg-[#111317] border border-[#22262E] rounded-sm px-2.5 py-1 text-xs font-mono text-[#F3F4F6] w-44 focus:outline-none focus:border-[#10B981]"
            />
            <label htmlFor="dash-key-scopes" className="sr-only">New API key scopes</label>
            <select
              id="dash-key-scopes"
              value={newKeyScopes}
              onChange={(e) => setNewKeyScopes(e.target.value)}
              className="bg-[#111317] border border-[#22262E] rounded-sm px-2 py-1 text-xs font-mono text-[#9CA3AF]"
            >
              <option value="pin:read,pin:write,vdxf:build">rw + vdxf:build</option>
              <option value="pin:read,vdxf:build">read-only</option>
            </select>
            <button
              type="button"
              onClick={handleCreateKey}
              disabled={busy === 'key'}
              className="px-2.5 py-1 bg-[#10B981] hover:bg-[#10B981]/90 text-[#090A0C] font-mono font-semibold text-xs rounded-sm flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Mint Key</span>
            </button>
          </div>
          {statusBanner?.isError && (
            <div className="px-3 py-2 border border-red-800 bg-[#181B20] text-red-400 text-xs font-mono">
              {statusBanner.text}
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left border-collapse text-xs font-mono tabular-nums">
          <thead>
            <tr className="border-b border-[#22262E] text-[10px] uppercase tracking-wider text-[#6B7280] bg-[#090A0C]/50">
              <th scope="col" className="py-1.5 px-3">Key Name</th>
              <th scope="col" className="py-1.5 px-3">Token Prefix</th>
              <th scope="col" className="py-1.5 px-3">Scopes</th>
              <th scope="col" className="py-1.5 px-3">Created</th>
              <th scope="col" className="py-1.5 px-3 text-right">Status / Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#22262E]">
            {keys
              .filter((k: any) => showRevokedKeys || !k.revoked)
              .map((k: any) => (
              <tr key={k.key_id} className="hover:bg-[#16191F] transition duration-75">
                <td className="py-1.5 px-3 text-[#F3F4F6]">
                  <div className="flex items-center gap-1.5">
                    {/* eslint-disable-next-line react-hooks/purity */}
{k.last_used_at && Date.now() - new Date(k.last_used_at).getTime() < 5 * 60 * 1000 && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse" title="Used in last 5 minutes" />
                    )}
                    {k.name}
                  </div>
                </td>
                <td className="py-1.5 px-3 text-[#10B981]">{k.key_prefix}</td>
                <td className="py-1.5 px-3 text-[#9CA3AF]">{k.scopes}</td>
                <td className="py-1.5 px-3 text-[#6B7280]">
                  {k.last_used_at ? `Last used ${formatDateTime(k.last_used_at)}` : 'Never used'}
                </td>
                <td className="py-1.5 px-3 text-right">
                  {k.revoked ? (
                    <span className="text-[#6B7280]">revoked</span>
                  ) : (
                    <button
                      onClick={() => askRevokeKey(k.key_id, k.name)}
                      className="text-[#9CA3AF] hover:text-red-400 cursor-pointer"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
