import React, { useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/useAuth';
import {
  useWatchers,
  useLedgerAuthGuard,
  useCreateWatcher,
  useSyncWatcher,
  useRepairWatcher,
  useDeleteWatcher,
} from '../hooks/useLedger';
import { formatDateTime, truncateMiddle } from '../lib/format';
import { CopyInline } from '../components/CopyInline';
import { Dialog } from '../components/Dialog';

export default function WatchersPage() {
  const { account } = useAuth();
  const [target, setTarget] = useState(account?.tenant?.friendly_name || 'NftIndex.vreal@');
  const [vdxfUri, setVdxfUri] = useState('sovpin::storage.pin.descriptor');
  const { data: watchers = [], isLoading: loading, error: watchersError, refetch } = useWatchers();
  useLedgerAuthGuard([watchersError]);
  const createWatcherMut = useCreateWatcher();
  const syncWatcherMut = useSyncWatcher();
  const repairWatcherMut = useRepairWatcher();
  const deleteWatcherMut = useDeleteWatcher();
  const [resolveUri, setResolveUri] = useState('vrsc::system.identity.content.datadirectory');
  const [resolveOut, setResolveOut] = useState<any>(null);
  const [resolveIdentityInput, setResolveIdentityInput] = useState(
    account?.tenant?.friendly_name || 'vreal@'
  );
  const [resolveIdentityVdxf, setResolveIdentityVdxf] = useState('sovpin::storage.pin.descriptor');
  const [resolveIdentityOut, setResolveIdentityOut] = useState<any>(null);
  const [traversalTree, setTraversalTree] = useState<any>(null);
  const [traversalLoading, setTraversalLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (watchersError && (watchersError as any)?.status !== 401) {
      setNotice({ text: (watchersError as any).message, tone: 'error' });
    }
  }, [watchersError]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (notice && notice.tone !== 'error') {
      const timer = window.setTimeout(() => setNotice(null), 3000);
      return () => window.clearTimeout(timer);
    }
  }, [notice]);

  const handleCreate = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r: any = await createWatcherMut.mutateAsync({
        targetIdentity: target.trim(),
        vdxfUri: vdxfUri.trim(),
      });
      setNotice({
        text: `Registered CMM Watcher for ${r.watcher.target_identity} at Block #${r.syncSummary.blockHeight} (${r.syncSummary.discoveredCids.length} CIDs discovered)`,
        tone: 'success',
      });
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async (id: string) => {
    setNotice(null);
    try {
      const r: any = await syncWatcherMut.mutateAsync(id);
      setNotice({
        text: `Synced ${r.watcher.target_identity} at Block #${r.syncSummary.blockHeight} (${r.syncSummary.discoveredCids.length} CIDs)`,
        tone: 'success',
      });
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    }
  };

  const handleRepairWatcher = async (id: string) => {
    setNotice(null);
    setBusy(true);
    try {
      const r: any = await repairWatcherMut.mutateAsync(id);
      setNotice({
        text: `Repaired & verified ${r.repairedCount} on-chain CID(s) for ${r.targetIdentity} into tenant ledger.`,
        tone: 'success',
      });
      if (traversalTree?.watcherId === id) {
        const updatedTree = await api(`/v1/watchers/${id}/traversal`);
        setTraversalTree(updatedTree);
      }
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async () => {
    setNotice(null);
    try {
      const r = await api('/v1/vdxf/resolve', {
        method: 'POST',
        body: JSON.stringify({ vdxfUri: resolveUri.trim() }),
      });
      setResolveOut(r);
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    }
  };

  const handleResolveIdentity = async () => {
    setNotice(null);
    try {
      const q = resolveIdentityVdxf.trim()
        ? `?vdxf=${encodeURIComponent(resolveIdentityVdxf.trim())}`
        : '';
      const r = await api(
        `/v1/resolve/${encodeURIComponent(resolveIdentityInput.trim())}${q}`
      );
      setResolveIdentityOut(r);
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    }
  };

  const handleViewTraversal = async (watcherId: string) => {
    setTraversalLoading(true);
    setTraversalTree(null);
    try {
      const r = await api(`/v1/watchers/${watcherId}/traversal`);
      setTraversalTree(r);
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    } finally {
      setTraversalLoading(false);
    }
  };

  const handleDeleteWatcher = async (watcherId: string) => {
    setNotice(null);
    try {
      await deleteWatcherMut.mutateAsync(watcherId);
      setNotice({ text: `Removed CMM Watcher ${watcherId}`, tone: 'success' });
      if (traversalTree?.watcherId === watcherId) setTraversalTree(null);
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    }
  };

  return (
    <div className="space-y-4 font-mono text-xs" aria-busy={loading}>
      {loading && (
        <div className="border border-[#22262E] bg-[#111317] px-3 py-2 text-[#9CA3AF]" role="status">
          Loading CMM watchers…
        </div>
      )}
      {/* Status Modal Overlay */}
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

      <div className="grid grid-cols-1 lg:grid-cols-12 border border-[#22262E] bg-[#111317] divide-y lg:divide-y-0 lg:divide-x divide-[#22262E]">
        {/* Left: Register Watcher + VDXF Resolver */}
        <div className="lg:col-span-4 divide-y divide-[#22262E]">
          <div className="p-3.5 space-y-3">
            <div className="flex items-center justify-between border-b border-[#22262E] pb-2">
              <span className="text-[11px] uppercase tracking-wider text-[#9CA3AF]">
                Register On-Chain CMM Watcher
              </span>
              <span className="text-[10px] text-[#10B981]">getidentitycontent</span>
            </div>

            <div>
              <label className="block text-[10px] uppercase text-[#6B7280] mb-1" htmlFor="watcher-target">
                Target VerusID / i-Address
              </label>
              <input
                id="watcher-target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="NftIndex.vreal@"
                className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
              />
              <div className="flex gap-2 mt-1 text-[10px] text-[#9CA3AF]">
                <button
                  type="button"
                  onClick={() => setTarget(account?.tenant?.friendly_name || 'vreal@')}
                  className="hover:text-[#10B981] cursor-pointer"
                >
                  [{account?.tenant?.friendly_name}]
                </button>
                <button
                  type="button"
                  onClick={() => setTarget('NftIndex.vreal@')}
                  className="hover:text-[#10B981] cursor-pointer"
                >
                  [NftIndex.vreal@]
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] uppercase text-[#6B7280] mb-1">
                VDXF Namespace URI
              </label>
              <input
                aria-label="VDXF namespace URI"
                value={vdxfUri}
                onChange={(e) => setVdxfUri(e.target.value)}
                className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
              />
            </div>

            <button
              type="button"
              onClick={handleCreate}
              disabled={busy}
              className="w-full py-1.5 px-3 bg-[#10B981] text-[#090A0C] font-semibold cursor-pointer"
            >
              {busy ? 'Polling Daemon...' : '+ Register CMM Watcher & Sync'}
            </button>
          </div>

          {/* VDXF Resolver */}
          <div className="p-3.5 space-y-2.5">
            <div className="text-[11px] uppercase tracking-wider text-[#9CA3AF]">
              Deterministic VDXF Key Calculator (`getvdxfid`)
            </div>
            <div className="flex gap-1.5">
              <input
                aria-label="VDXF key URI to resolve"
                value={resolveUri}
                onChange={(e) => setResolveUri(e.target.value)}
                className="flex-1 bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
              />
              <button
                type="button"
                onClick={handleResolve}
                className="px-3 py-1.5 bg-[#181B20] border border-[#22262E] text-[#F3F4F6] hover:border-[#10B981] cursor-pointer"
              >
                Resolve
              </button>
            </div>
            {resolveOut && (
              <pre className="bg-[#090A0C] border border-[#22262E] p-2.5 text-[11px] text-[#10B981] overflow-x-auto">
                {JSON.stringify(resolveOut, null, 2)}
              </pre>
            )}
          </div>

          {/* Live VerusID CMM & Content Resolver */}
          <div className="p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wider text-[#9CA3AF]">
                VerusID CMM Resolver (`/v1/resolve/:id`)
              </span>
              <a
                href={`/v1/resolve/${encodeURIComponent(resolveIdentityInput.trim() || 'vreal@')}/content${
                  resolveIdentityVdxf.trim()
                    ? `?vdxf=${encodeURIComponent(resolveIdentityVdxf.trim())}&format=json`
                    : '?format=json'
                }`}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-[#10B981] hover:underline"
              >
                /content ↗
              </a>
            </div>
            <input
              aria-label="VerusID or i-address to inspect"
              value={resolveIdentityInput}
              onChange={(e) => setResolveIdentityInput(e.target.value)}
              placeholder="VerusID or i-address (e.g. vreal@)"
              className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
            />
            <div className="flex gap-1.5">
              <input
                aria-label="Optional VDXF filter"
              value={resolveIdentityVdxf}
                onChange={(e) => setResolveIdentityVdxf(e.target.value)}
                placeholder="Optional VDXF filter (URI or i-address)"
                className="flex-1 bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
              />
              <button
                type="button"
                onClick={handleResolveIdentity}
                className="px-3 py-1.5 bg-[#181B20] border border-[#22262E] text-[#F3F4F6] hover:border-[#10B981] cursor-pointer"
              >
                Inspect CMM
              </button>
            </div>
            {resolveIdentityOut && (
              <pre className="bg-[#090A0C] border border-[#22262E] p-2.5 text-[11px] text-[#10B981] overflow-x-auto max-h-48">
                {JSON.stringify(resolveIdentityOut, null, 2)}
              </pre>
            )}
          </div>
        </div>

        {/* Right: Watchers Table */}
        <div className="lg:col-span-8 min-w-0 flex flex-col overflow-hidden">
          <div className="px-3.5 py-2 border-b border-[#22262E] bg-[#090A0C] flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-[#9CA3AF]">
              Active CMM Watchers ({watchers.length}/{account?.plan?.maxCmmWatchers ?? 1})
            </span>
            <button onClick={() => void refetch()} className="text-[11px] text-[#9CA3AF] hover:text-[#F3F4F6]">
              Refresh
            </button>
          </div>

          <div className="divide-y divide-[#22262E]">
            <div className="hidden xl:grid xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1.2fr)_72px_48px_112px_auto] gap-2 px-2.5 py-1.5 bg-[#090A0C]/50 text-[9px] uppercase text-[#6B7280]">
              <span>Target identity</span>
              <span>VDXF filter</span>
              <span>Block</span>
              <span className="text-right">CIDs</span>
              <span>Last synced · UTC</span>
              <span className="text-right">Actions</span>
            </div>
            {watchers.length === 0 ? (
              <div className="py-8 px-3 text-center text-[#6B7280]">No active CMM watchers.</div>
            ) : (
              watchers.map((w: any) => {
                let summary: any = {};
                try {
                  summary = JSON.parse(w.last_result_json || '{}');
                } catch {}
                return (
                  <article key={w.watcher_id} className="px-2.5 py-2 hover:bg-[#16191F] transition duration-75">
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1.2fr)_72px_48px_112px_auto] gap-x-2 gap-y-1.5 items-center">
                      <div className="min-w-0">
                        <div className="text-[#F3F4F6] font-semibold break-words">{w.target_identity}</div>
                        <div className="flex items-center gap-1 text-[10px] text-[#6B7280] font-mono">
                          <span className="truncate" title={w.target_i_address}>{w.target_i_address}</span>
                          <CopyInline value={w.target_i_address} />
                        </div>
                      </div>
                      <div className="min-w-0 text-[10px] text-[#9CA3AF] break-all xl:break-words" title={w.vdxf_uri}>
                        <span className="xl:hidden text-[#6B7280] mr-1">VDXF</span>{w.vdxf_uri}
                      </div>
                      <div className="text-[#F3F4F6] tabular-nums">
                        <span className="xl:hidden text-[9px] text-[#6B7280] mr-1">Block</span>#{summary.blockHeight || '—'}
                      </div>
                      <div className="text-right text-[#10B981] font-bold tabular-nums">
                        <span className="xl:hidden text-[9px] text-[#6B7280] font-normal mr-1">CIDs</span>{w.pins_discovered}
                      </div>
                      <div className="text-[10px] text-[#6B7280] tabular-nums">
                        <span className="xl:hidden text-[9px] text-[#6B7280] mr-1">Sync</span>{formatDateTime(w.last_synced_at)}
                      </div>
                      <div className="flex items-center justify-start xl:justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => handleSync(w.watcher_id)}
                          className="px-1.5 py-1 bg-[#090A0C] border border-[#22262E] hover:border-[#10B981] text-[#F3F4F6] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                        >
                          <RefreshCw className="w-3 h-3" />
                          <span>Sync</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRepairWatcher(w.watcher_id)}
                          disabled={busy}
                          title="Pin & verify discovered on-chain CIDs into tenant ledger"
                          className="px-1.5 py-1 bg-[#090A0C] border border-[#22262E] hover:border-[#10B981] text-[#10B981] cursor-pointer disabled:opacity-50 whitespace-nowrap"
                        >
                          Repair
                        </button>
                        <button
                          type="button"
                          onClick={() => handleViewTraversal(w.watcher_id)}
                          disabled={traversalLoading}
                          className="px-1.5 py-1 bg-[#090A0C] border border-[#22262E] hover:border-[#10B981] text-[#F3F4F6] cursor-pointer disabled:opacity-50 whitespace-nowrap"
                        >
                          {traversalLoading ? 'Loading' : 'Inspect map'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteWatcher(w.watcher_id)}
                          title="Remove Watcher"
                          className="px-1.5 py-1 bg-[#090A0C] border border-[#22262E] hover:border-red-500 text-[#6B7280] hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </div>

      </div>

      {/* Full-width traversal panel, outside the two-column watcher layout */}
      {traversalTree && (
        <section className="w-full min-w-0 border border-[#22262E] bg-[#111317]">
          <div className="px-3.5 py-2 border-b border-[#22262E] flex flex-wrap items-center justify-between gap-2 bg-[#090A0C]">
            <div>
              <div className="text-[11px] font-mono uppercase tracking-wider text-[#F3F4F6]">
                Content discovery map
              </div>
              <div className="mt-0.5 text-[10px] font-mono text-[#6B7280]">
                Registry → asset identities → IPFS objects
              </div>
            </div>
            <div className="flex items-center gap-3 text-[10px] font-mono tabular-nums">
              <span className="text-[#9CA3AF]">{traversalTree.totalSubIdentities} asset identities</span>
              <span className="text-[#10B981]">{traversalTree.totalCidReferences} references</span>
              <span className="text-[#10B981]">{traversalTree.totalCids} unique objects</span>
              <button
                onClick={() => setTraversalTree(null)}
                className="px-2 py-1 border border-[#22262E] text-[#9CA3AF] hover:text-[#F3F4F6] hover:border-[#9CA3AF] cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>

          <div className="p-3.5 space-y-3">
            {/* Root registry */}
            <div className="border-l-2 border-[#10B981] bg-[#090A0C] px-3 py-2.5">
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-2 items-start">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-[#10B981]">Verus registry · level 0</div>
                  <div className="mt-1 text-sm text-[#F3F4F6] font-semibold break-words">
                    {traversalTree.traversal.name}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-[#9CA3AF]">
                    <span className="whitespace-nowrap" title={traversalTree.traversal.iAddress}>
                      {truncateMiddle(traversalTree.traversal.iAddress, 12, 8)}
                    </span>
                    <CopyInline value={traversalTree.traversal.iAddress} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono tabular-nums text-[#9CA3AF]">
                  <span>{traversalTree.traversal.cmmKeys.length} CMM keys</span>
                  <span>Block #{traversalTree.traversal.blockHeight}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[10px] font-mono text-[#6B7280]">
              <span className="w-4 border-t border-[#22262E]" />
              <span>Registry entries reference these asset identities</span>
            </div>

            {/* Asset identity rows */}
            <div className="border border-[#22262E] overflow-hidden">
              <div className="hidden md:grid md:grid-cols-[minmax(0,2fr)_minmax(190px,1.2fr)_110px_minmax(220px,1.3fr)] gap-3 px-3 py-1.5 bg-[#090A0C] border-b border-[#22262E] text-[9px] uppercase tracking-wider text-[#6B7280] font-mono">
                <span>Asset identity</span>
                <span>Verus i-address</span>
                <span>On-chain state</span>
                <span>Discovered IPFS objects</span>
              </div>

              <div className="divide-y divide-[#22262E]">
                {traversalTree.traversal.children.map((child: any, ci: number) => (
                  <article key={child.iAddress || ci} className="px-3 py-2.5 hover:bg-[#16191F] transition-colors duration-75">
                    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(190px,1.2fr)_110px_minmax(220px,1.3fr)] gap-x-3 gap-y-2 items-start">
                      <div className="min-w-0">
                        <div className="md:hidden mb-1 text-[9px] uppercase tracking-wider text-[#6B7280]">Asset identity</div>
                        <div className="text-xs text-[#F3F4F6] break-words">{child.name || 'Unresolved identity'}</div>
                        {child.error && <div className="mt-1 text-[10px] text-red-400">Identity lookup failed: {child.error}</div>}
                      </div>

                      <div className="min-w-0">
                        <div className="md:hidden mb-1 text-[9px] uppercase tracking-wider text-[#6B7280]">Verus i-address</div>
                        <div className="flex items-start gap-1.5 font-mono text-[10px] text-[#9CA3AF]">
                          <span className="min-w-0 whitespace-nowrap" title={child.iAddress}>
                            {truncateMiddle(child.iAddress, 12, 8)}
                          </span>
                          <CopyInline value={child.iAddress} />
                        </div>
                      </div>

                      <div>
                        <div className="md:hidden mb-1 text-[9px] uppercase tracking-wider text-[#6B7280]">On-chain state</div>
                        <div className="text-[10px] font-mono text-[#9CA3AF]">{child.cmmKeys.length} CMM keys</div>
                        <div className="text-[10px] font-mono text-[#6B7280]">Block #{child.blockHeight || '—'}</div>
                      </div>

                      <div className="min-w-0">
                        <div className="md:hidden mb-1 text-[9px] uppercase tracking-wider text-[#6B7280]">Discovered IPFS objects</div>
                        {(child.cidReferences || []).length === 0 && child.cids.length === 0 ? (
                          <div className="text-[10px] text-[#6B7280]">No CID found in this identity&apos;s content</div>
                        ) : (
                          <div className="space-y-1">
                            {(child.cidReferences?.length
                              ? child.cidReferences
                              : child.cids.map((cid: string) => ({ cid, pinStatus: 'UNKNOWN' }))
                            ).map((reference: any, referenceIndex: number) => (
                              <div key={`${reference.vdxfKey || 'cid'}-${reference.cid || reference.url}-${referenceIndex}`} className="min-w-0">
                                <div className="flex items-start gap-1.5 min-w-0">
                                  <span className={`mt-1 w-1.5 h-1.5 shrink-0 rounded-full ${
                                    reference.pinStatus === 'PINNED' ? 'bg-[#10B981]' :
                                    reference.pinStatus === 'MISSING_FROM_NODE' ? 'bg-amber-400' :
                                    reference.pinStatus === 'UNREACHABLE' ? 'bg-red-400' : 'bg-[#6B7280]'
                                  }`} />
                                  <span className="min-w-0 whitespace-nowrap text-[10px] font-mono text-[#10B981]" title={reference.cid || reference.url}>
                                    {reference.cid ? truncateMiddle(reference.cid, 14, 10) : truncateMiddle(reference.url || 'External URLRef', 22, 12)}
                                  </span>
                                  {(reference.dataDescriptor?.mimeType || reference.mimeType) && (
                                    <span className="shrink-0 text-[9px] px-1 py-0.2 bg-[#090A0C] border border-[#22262E] text-[#6B7280]">
                                      {reference.dataDescriptor?.mimeType || reference.mimeType}
                                    </span>
                                  )}
                                  {reference.cid && <CopyInline value={reference.cid} />}
                                  <span className={`ml-auto shrink-0 text-[9px] font-mono ${
                                    reference.pinStatus === 'PINNED' ? 'text-[#10B981]' :
                                    reference.pinStatus === 'MISSING_FROM_NODE' ? 'text-amber-400' :
                                    reference.pinStatus === 'UNREACHABLE' ? 'text-red-400' : 'text-[#6B7280]'
                                  }`}>
                                    {reference.pinStatus || 'UNKNOWN'}
                                  </span>
                                </div>
                                {reference.datahash && (
                                  <div className="ml-3 text-[9px] font-mono text-[#6B7280]">
                                    URLRef SHA-256 committed · {reference.vdxfKey || 'VDXF key unavailable'}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-[#22262E] pt-2 text-[10px] font-mono text-[#6B7280]">
              <span><span className="text-[#10B981]">Registry</span> — identity whose ContentMultiMap indexes assets</span>
              <span><span className="text-[#F97316]">Asset identity</span> — identity entry followed by SovPin</span>
              <span><span className="text-[#10B981]">IPFS CID</span> — content-addressed object found in the asset identity</span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
