import React, { useEffect, useState } from 'react';
import { ExternalLink, Trash2 } from 'lucide-react';
import {
  usePins,
  useLedgerAuthGuard,
  useUploadFile,
  useUploadJson,
  usePinCid,
  useUnpin,
} from '../hooks/useLedger';
import { useAuth } from '../lib/useAuth';
import { formatBytes, formatDateTime, truncateMiddle } from '../lib/format';
import { CopyInline } from '../components/CopyInline';
import { Dialog } from '../components/Dialog';
import { ConfirmDialog, type PendingConfirm } from '../components/ConfirmDialog';

const NO_PINS: any[] = [];

export default function PinStudioPage() {
  const { account } = useAuth();

  const [tab, setTab] = useState<'json' | 'file' | 'cid'>('json');
  const [filename, setFilename] = useState('verus-nft-manifest.json');
  const [vdxfUri, setVdxfUri] = useState('sovpin::storage.pin.descriptor');
  const [mimeType, setMimeType] = useState('application/json');
  const [contentText, setContentText] = useState(
    JSON.stringify(
      {
        schema: 'sovpin::storage.pin.descriptor',
        app: 'VREAL',
        title: 'Sovereign Genesis Artifact',
      },
      null,
      2
    )
  );
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileSize, setFileSize] = useState<number>(0);
  const [existingCid, setExistingCid] = useState('');
  const [existingCidName, setExistingCidName] = useState('external-verus-asset');

  const [selectedJob, setSelectedJob] = useState<any>(null);
  const [pendingCid, setPendingCid] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);

  const { data: pinsData, isLoading: loading, error: pinsError } = usePins();
  const pins = pinsData ?? NO_PINS;
  useLedgerAuthGuard([pinsError]);
  const uploadFileMut = useUploadFile();
  const uploadJsonMut = useUploadJson();
  const pinCidMut = usePinCid();
  const unpinMut = useUnpin();

  // Reconcile the studio selection against fresh query data.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSelectedJob((prev: any) => {
      if (pendingCid) {
        const match = pins.find((j: any) => j.pin?.cid === pendingCid);
        if (match) {
          setPendingCid(null);
          return match;
        }
      }
      if (!prev) return pins[0] ?? null;
      return pins.find((j: any) => j.requestid === prev.requestid) ?? pins[0] ?? null;
    });
  }, [pins, pendingCid]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (pinsError && (pinsError as any)?.status !== 401) {
      setNotice({ text: (pinsError as any).message, tone: 'error' });
    }
  }, [pinsError]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (notice && notice.tone !== 'error') {
      const timer = window.setTimeout(() => setNotice(null), 3000);
      return () => window.clearTimeout(timer);
    }
  }, [notice]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFilename(f.name);
    setMimeType(f.type || 'application/octet-stream');
    setFileSize(f.size);
    setSelectedFile(f);
  };

  const handleUpload = async () => {
    setBusy(true);
    setNotice(null);
    setUploadProgress(null);
    try {
      if (tab === 'cid') {
        if (!existingCid.trim()) throw new Error('Enter a CID to pin.');
        const res: any = await pinCidMut.mutateAsync({
          cid: existingCid.trim(),
          name: existingCidName.trim() || existingCid.trim(),
          vdxfUri: vdxfUri.trim(),
        });
        setPendingCid(res.pin.cid);
        setNotice({ text: `Pinned CID ${res.pin.cid}`, tone: 'success' });
      } else if (tab === 'file') {
        if (!selectedFile) throw new Error('Select a file first');
        const uri = vdxfUri.trim();
        const res: any = await uploadFileMut.mutateAsync({
          file: selectedFile,
          filename: filename.trim() || selectedFile.name,
          vdxfUri: uri,
          onProgress: (done, total) => setUploadProgress({ done, total }),
        });
        setPendingCid(res.pin.cid);
        setSelectedFile(null);
        setFileSize(0);
        setNotice({
          text: `Pinned ${res.pin.cid} (${formatBytes(res.info.size_bytes)})`,
          tone: 'success',
        });
      } else {
        const payload: any = {
          filename: filename.trim() || 'artifact.json',
          vdxfUri: vdxfUri.trim() || 'sovpin::storage.pin.descriptor',
          mimeType: mimeType.trim() || 'application/octet-stream',
        };
        payload.contentText = contentText;
        const res: any = await uploadJsonMut.mutateAsync(payload);
        setPendingCid(res.pin.cid);
        setNotice({
          text: `Pinned ${res.pin.cid} (${formatBytes(res.info.size_bytes)})`,
          tone: 'success',
        });
      }
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };

  const askUnpin = (requestId: string, name: string) => {
    setConfirm({
      title: `Unpin "${name}"?`,
      body: 'The object is removed from your tenant ledger. The CID stays pinned while any other tenant references it.',
      confirmLabel: 'Unpin object',
      busyLabel: 'Unpinning…',
      onConfirm: async () => {
        try {
          const res: any = await unpinMut.mutateAsync(requestId);
          setNotice({
            text: `Unpinned ${res.cid} (remaining refs: ${res.remainingTenantReferences})`,
            tone: 'success',
          });
          if (selectedJob?.requestid === requestId) setSelectedJob(null);
          setConfirm(null);
        } catch (e: any) {
          setNotice({ text: e.message, tone: 'error' });
        }
      },
    });
  };

  const vdxf = selectedJob?.verus_vdxf;
  const selectedCid = selectedJob?.pin?.cid;
  const selectedGatewayUrl =
    vdxf?.gatewayUrl || selectedJob?.info?.gateway_url || (selectedCid ? `https://ipfs.sovpin.com/ipfs/${selectedCid}` : '');
  const selectedSha256 = vdxf?.sha256Hex || selectedJob?.info?.sha256 || null;
  const friendlyId = account?.tenant?.friendly_name?.replace(/@$/, '') || vdxf?.cmmUpdatePayload?.name;
  const personalizedUpdateCmd = vdxf
    ? `verus -chain=VRSCTEST updateidentity '${JSON.stringify({
        ...vdxf.cmmUpdatePayload,
        name: friendlyId,
      })}'`
    : '';

  return (
    <div className="space-y-4" aria-busy={loading}>
      {loading && (
        <div className="border border-[#22262E] bg-[#111317] px-3 py-2 text-xs font-mono text-[#9CA3AF]" role="status">
          Loading pinned objects…
        </div>
      )}
      {uploadProgress && busy && (
        <div className="border border-[#22262E] bg-[#111317] px-3 py-2 text-xs font-mono text-[#9CA3AF]" role="status" aria-live="polite">
          <span>Uploading part {uploadProgress.done}/{uploadProgress.total}…</span>
          <div className="mt-1 h-[2px] bg-[#22262E]">
            <div className="h-full bg-[#10B981]" style={{ width: `${Math.round((uploadProgress.done / Math.max(1, uploadProgress.total)) * 100)}%` }} />
          </div>
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

      <div className="grid grid-cols-1 lg:grid-cols-12 border border-[#22262E] bg-[#111317] divide-y lg:divide-y-0 lg:divide-x divide-[#22262E]">
        {/* Left: Ingest & VDXF Builder */}
        <div className="lg:col-span-5 flex flex-col">
          <div className="px-3.5 py-2 border-b border-[#22262E] bg-[#090A0C] flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-[#9CA3AF]">
              Ingest Pipeline &amp; VDXF Builder
            </span>
            <div className="flex border border-[#22262E] bg-[#111317]">
              {(
                [
                  ['json', 'JSON'],
                  ['file', 'File'],
                  ['cid', 'CID'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`px-2.5 py-0.5 text-[10px] font-mono cursor-pointer ${
                    tab === id
                      ? 'bg-[#10B981] text-[#090A0C] font-bold'
                      : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-3.5 space-y-3 text-xs font-mono">
            {tab === 'cid' ? (
              <>
                <div>
                  <label className="block text-[10px] uppercase text-[#6B7280] mb-1">
                    IPFS CID (`Qm...` / `bafy...`)
                  </label>
                  <input
                    value={existingCid}
                    aria-label="IPFS CID to pin"
                    onChange={(e) => setExistingCid(e.target.value)}
                    placeholder="QmdJN78YiEAzh8xQ59YMsMW635cXtr24RDSz6zuJr1NyFk"
                    className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase text-[#6B7280] mb-1">
                    Object Label
                  </label>
                  <input
                    value={existingCidName}
                    aria-label="Object label"
                    onChange={(e) => setExistingCidName(e.target.value)}
                    className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] uppercase text-[#6B7280] mb-1">Filename</label>
                    <input
                      value={filename}
                      aria-label="Filename"
                      onChange={(e) => setFilename(e.target.value)}
                      className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase text-[#6B7280] mb-1">MIME Type</label>
                    <input
                      value={mimeType}
                      aria-label="MIME type"
                      onChange={(e) => setMimeType(e.target.value)}
                      className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
                    />
                  </div>
                </div>

                {tab === 'file' ? (
                  <div className="border border-dashed border-[#22262E] bg-[#090A0C] p-4 text-center space-y-2">
                    <label htmlFor="pin-studio-file" className="block text-[10px] uppercase text-[#6B7280] mb-1">File to upload</label>
                    <input
                      id="pin-studio-file"
                      type="file"
                      onChange={handleFileChange}
                      className="block w-full text-xs text-[#9CA3AF] file:mr-2 file:py-1 file:px-2.5 file:bg-[#111317] file:border file:border-[#22262E] file:text-xs file:font-mono file:text-[#F3F4F6]"
                    />
                    {selectedFile && (
                      <div className="text-[11px] text-[#10B981]">
                        Staged: {filename} ({formatBytes(fileSize)})
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <label className="block text-[10px] uppercase text-[#6B7280] mb-1">
                      Object Payload
                    </label>
                    <textarea
                      rows={6}
                      aria-label="Object payload JSON"
                      value={contentText}
                      onChange={(e) => setContentText(e.target.value)}
                      className="w-full bg-[#090A0C] border border-[#22262E] p-2.5 text-xs text-[#F3F4F6]"
                    />
                  </div>
                )}
              </>
            )}

            <div>
              <label className="block text-[10px] uppercase text-[#6B7280] mb-1">
                VDXF Key URI (`getvdxfid`)
              </label>
              <input
                value={vdxfUri}
                aria-label="VDXF key URI"
                onChange={(e) => setVdxfUri(e.target.value)}
                className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
              />
            </div>

            <button
              type="button"
              onClick={handleUpload}
              disabled={busy}
              className="w-full py-2 px-3 bg-[#10B981] hover:bg-[#10B981]/90 text-[#090A0C] font-semibold text-xs cursor-pointer"
            >
              {busy ? 'Streaming to Kubo...' : 'Upload to Kubo & Build Verus URLRef'}
            </button>
          </div>
        </div>

        {/* Right: Verus URLRef / DataDescriptor Output */}
        <div className="lg:col-span-7 flex flex-col">
          <div className="px-3.5 py-2 border-b border-[#22262E] bg-[#090A0C] flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-[#9CA3AF]">
              Verus URLRef &amp; ContentMultiMap Output
            </span>
            {selectedGatewayUrl && (
              <a
                href={selectedGatewayUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] font-mono text-[#10B981] hover:underline flex items-center gap-1"
              >
                <span>Gateway</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>

          {!selectedJob ? (
            <div className="p-8 text-xs font-mono text-[#6B7280] text-center">
              No pin selected.
            </div>
          ) : (
            <div className="p-3.5 space-y-3 text-xs font-mono">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-[#090A0C] border border-[#22262E] p-2.5 tabular-nums">
                <div>
                  <span className="text-[#6B7280]">CID: </span>
                  <span className="text-[#10B981]">{truncateMiddle(selectedCid, 12, 8)}</span>{' '}
                  <CopyInline value={selectedCid} />
                </div>
                <div>
                  <span className="text-[#6B7280]">VDXF ID: </span>
                  <span className="text-[#F3F4F6]">{vdxf?.vdxfId || '— (App CMM)'}</span>{' '}
                  {vdxf?.vdxfId && <CopyInline value={vdxf.vdxfId} />}
                </div>
                <div className="sm:col-span-2">
                  <span className="text-[#6B7280]">SHA-256: </span>
                  {selectedSha256 ? (
                    <>
                      <span className="text-[#9CA3AF]">{selectedSha256}</span>{' '}
                      <CopyInline value={selectedSha256} />
                    </>
                  ) : (
                    <span className="text-[#6B7280]">Not available for CID-only pins</span>
                  )}
                </div>
              </div>

              {personalizedUpdateCmd && (
                <div>
                  <div className="flex items-center justify-between text-[10px] uppercase text-[#6B7280] mb-1">
                    <span>1. updateidentity ContentMultiMap Command ({friendlyId}@)</span>
                    <CopyInline value={personalizedUpdateCmd} label="Copy" />
                  </div>
                  <pre className="bg-[#090A0C] border border-[#22262E] p-2.5 text-[11px] text-[#10B981] overflow-x-auto">
                    {personalizedUpdateCmd}
                  </pre>
                </div>
              )}

              {vdxf?.signdataCommand && (
                <div>
                  <div className="flex items-center justify-between text-[10px] uppercase text-[#6B7280] mb-1">
                    <span>2. signdata SHA-256 Command</span>
                    <CopyInline value={vdxf.signdataCommand} label="Copy" />
                  </div>
                  <pre className="bg-[#090A0C] border border-[#22262E] p-2.5 text-[11px] text-[#F97316] overflow-x-auto">
                    {vdxf.signdataCommand}
                  </pre>
                </div>
              )}

              {vdxf?.dataDescriptor ? (
                <div>
                  <div className="flex items-center justify-between text-[10px] uppercase text-[#6B7280] mb-1">
                    <span>3. Verus DataDescriptor JSON (containing the URLRef)</span>
                    <CopyInline value={JSON.stringify(vdxf.dataDescriptor, null, 2)} label="Copy" />
                  </div>
                  <pre className="bg-[#090A0C] border border-[#22262E] p-2.5 text-[11px] text-[#9CA3AF] overflow-x-auto max-h-36">
                    {JSON.stringify(vdxf.dataDescriptor, null, 2)}
                  </pre>
                </div>
              ) : (
                <div className="bg-[#090A0C] border border-[#22262E] p-2.5 text-[11px] text-[#9CA3AF]">
                  This object was uploaded without a SovPin VDXF URI (the application manages its own Verus CMM schema).
                </div>
              )}

              {selectedJob?.verus_receipt && (
                <div>
                  <div className="flex items-center justify-between text-[10px] uppercase text-[#6B7280] mb-1">
                    <span>
                      4. Verus-Signed Storage Receipt ({selectedJob.verus_receipt.signerIdentity} · Block #{selectedJob.verus_receipt.blockHeight})
                    </span>
                    <CopyInline value={selectedJob.verus_receipt.verifyCliCommand} label="Copy Verify CLI" />
                  </div>
                  <pre className="bg-[#090A0C] border border-[#22262E] p-2.5 text-[11px] text-[#10B981] overflow-x-auto max-h-28">
                    {selectedJob.verus_receipt.verifyCliCommand}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Recent Pinned Objects Selector Table */}
      <div className="border border-[#22262E] bg-[#111317] font-mono text-xs tabular-nums">
        <div className="px-3.5 py-2 border-b border-[#22262E] bg-[#090A0C] flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-[#9CA3AF]">
            Pinned Objects in Namespace ({pins.length})
          </span>
          <span className="text-[10px] text-[#6B7280]">Click any row to load into VDXF Studio</span>
        </div>
        <div className="divide-y divide-[#22262E] max-h-64 overflow-y-auto">
          {pins.length === 0 ? (
            <div className="py-6 px-3 text-center text-[#6B7280]">No pins in ledger yet.</div>
          ) : (
            pins.map((job: any) => {
              const active = selectedJob?.requestid === job.requestid;
              return (
                <div
                  key={job.requestid}
                  onClick={() => setSelectedJob(job)}
                  className={`px-3.5 py-2 flex items-center justify-between gap-3 cursor-pointer ${
                    active ? 'bg-[#181B20]' : 'hover:bg-[#16191F]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-[#F3F4F6] font-sans font-medium truncate max-w-[220px]">
                      {job.pin.name}
                    </span>
                    <span className="text-[#10B981]">{truncateMiddle(job.pin.cid, 10, 7)}</span>
                    <span className="text-[#6B7280]">{formatBytes(job.info.size_bytes)}</span>
                  </div>
                  <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                    <span className="text-[#6B7280] hidden sm:inline">
                      {formatDateTime(job.created)}
                    </span>
                    <button
                      type="button"
                      onClick={() => askUnpin(job.requestid, job.pin.name)}
                      title="Unpin CID"
                      className="text-[#6B7280] hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
