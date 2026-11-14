import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QrCode, Terminal, RefreshCw, ArrowLeft } from 'lucide-react';
import { api, setToken } from '../lib/api';
import { useAuth } from '../lib/useAuth';
import { CopyInline } from '../components/CopyInline';

export default function SignInPage() {
  const { account, signInWithToken, loading } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<'qr' | 'cli'>('qr');
  const [identityFilter, setIdentityFilter] = useState('');
  const [cliIdentity, setCliIdentity] = useState('vreal@');
  const [challenge, setChallenge] = useState<any>(null);
  const [signature, setSignature] = useState('');
  const [qr, setQr] = useState<any>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const pollRef = useRef<any>(null);

  useEffect(() => {
    if (account) {
      navigate('/dashboard', { replace: true });
    }
  }, [account, navigate]);

  const startQrChallenge = useCallback(
    async (verusIdOverride?: string) => {
      setErrMsg('');
      setQrLoading(true);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      try {
        const targetId = (verusIdOverride ?? identityFilter).trim();
        const res = await api('/v1/auth/login-consent/challenge', {
          method: 'POST',
          body: JSON.stringify(targetId ? { verusId: targetId } : {}),
        });
        setQr(res);
        pollRef.current = setInterval(async () => {
          try {
            const p = await api(
              `/v1/auth/login-consent/poll?challengeId=${encodeURIComponent(
                res.challengeId
              )}&pollToken=${encodeURIComponent(res.pollToken)}`
            );
            if (p.status === 'verified' && p.sessionToken) {
              clearInterval(pollRef.current);
              pollRef.current = null;
              setMsg(`Authenticated ${p.userFriendlyName}. Opening ledger...`);
              setToken(p.sessionToken);
              await signInWithToken(p.sessionToken);
              navigate('/dashboard', { replace: true });
            } else if (p.status === 'expired') {
              clearInterval(pollRef.current);
              pollRef.current = null;
              setErrMsg('Challenge expired. Refresh QR.');
            }
          } catch {
            // transient poll error
          }
        }, 2000);
      } catch (e: any) {
        setErrMsg(e.message || 'Failed to generate LoginConsent QR');
      } finally {
        setQrLoading(false);
      }
    },
    [identityFilter, navigate, signInWithToken]
  );

  // Mount-once challenge bootstrap: re-running on identityFilter keystrokes
  // would invalidate the QR the user is about to scan.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!account && !loading) {
      void startQrChallenge('');
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [account, loading]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const requestCliChallenge = async () => {
    setErrMsg('');
    setMsg('');
    try {
      const res = await api('/v1/auth/challenge', {
        method: 'POST',
        body: JSON.stringify({ identity: cliIdentity }),
      });
      setChallenge(res);
    } catch (e: any) {
      setErrMsg(e.message);
    }
  };

  const signWithNode = async () => {
    if (!challenge) return;
    setErrMsg('');
    try {
      const r = await api('/v1/auth/sign-with-node', {
        method: 'POST',
        body: JSON.stringify({ challengeId: challenge.challengeId }),
      });
      setSignature(r.signature);
      await verifyCli(r.signature);
    } catch (e: any) {
      setErrMsg(e.message);
    }
  };

  const verifyCli = async (sig?: string) => {
    if (!challenge) return;
    setErrMsg('');
    try {
      const r = await api('/v1/auth/verify', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          signature: sig ?? signature,
        }),
      });
      setToken(r.sessionToken);
      await signInWithToken(r.sessionToken);
      navigate('/dashboard', { replace: true });
    } catch (e: any) {
      setErrMsg(e.message);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#090A0C] text-[#9CA3AF] flex items-center justify-center font-mono text-xs">
        [SOVPIN] Verifying session...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#090A0C] text-[#F3F4F6] flex flex-col font-mono text-xs">
      <header className="h-10 border-b border-[#22262E] px-6 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 text-[#9CA3AF] hover:text-[#F3F4F6]">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Index</span>
        </Link>
        <div className="text-[#6B7280]">
          Signer: <span className="text-[#10B981]">sovpin.VRSCTEST@</span> (iCyhNFeRiKdX7rgAYJdz54z2pTT9M1RYUt)
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-3xl w-full border border-[#22262E] bg-[#111317] grid grid-cols-1 md:grid-cols-12 divide-y md:divide-y-0 md:divide-x divide-[#22262E]">
          {/* Left Specs */}
          <div className="md:col-span-5 p-5 flex flex-col justify-between space-y-6 bg-[#090A0C]/40">
            <div className="space-y-3">
              <div className="text-[10px] text-[#10B981] uppercase tracking-wider">
                VerusID Authentication
              </div>
              <h1 className="text-lg font-sans font-bold text-[#F3F4F6] tracking-tight">
                Authenticate Tenant Namespace
              </h1>
              <p className="text-xs font-sans text-[#9CA3AF] leading-relaxed">
                Tenants are keyed to their canonical on-chain Verus <code className="font-mono text-[#F3F4F6]">i-address</code>.
                First authentication provisions your 1.00 GB Testnet Builder ledger automatically.
              </p>
            </div>

            <div className="space-y-2 border-t border-[#22262E] pt-3 text-[11px] text-[#9CA3AF]">
              <div className="flex justify-between">
                <span className="text-[#6B7280]">Protocol:</span>
                <span className="text-[#F3F4F6]">LoginConsent / signdata</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#6B7280]">Default Quota:</span>
                <span className="text-[#10B981]">1.00 GB DAG / 2 Keys</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#6B7280]">Chain:</span>
                <span className="text-[#F3F4F6]">VRSCTEST</span>
              </div>
            </div>
          </div>

          {/* Right Auth Panel */}
          <div className="md:col-span-7 flex flex-col">
            <div className="grid grid-cols-2 border-b border-[#22262E] bg-[#090A0C]">
              <button
                type="button"
                onClick={() => setMode('qr')}
                className={`py-2 px-3 flex items-center justify-center gap-2 cursor-pointer ${
                  mode === 'qr'
                    ? 'bg-[#111317] text-[#10B981] border-b-2 border-[#10B981] font-bold'
                    : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                }`}
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>Verus Mobile QR</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('cli')}
                className={`py-2 px-3 flex items-center justify-center gap-2 cursor-pointer ${
                  mode === 'cli'
                    ? 'bg-[#111317] text-[#10B981] border-b-2 border-[#10B981] font-bold'
                    : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Verus CLI / RPC</span>
              </button>
            </div>

            <div className="p-4 space-y-3">
              {errMsg && (
                <div className="px-3 py-2 border border-red-800 bg-[#181B20] text-red-400" role="alert">
                  {errMsg}
                </div>
              )}
              {msg && (
                <div className="px-3 py-2 border border-[#10B981]/50 bg-[#090A0C] text-[#10B981]" role="status">
                  {msg}
                </div>
              )}

              {mode === 'qr' ? (
                <div className="space-y-3">
                  <div className="flex gap-1.5">
                    <label htmlFor="qr-subject-lock" className="sr-only">Optional subject lock VerusID</label>
                    <input
                      id="qr-subject-lock"
                      value={identityFilter}
                      autoComplete="off"
                      onChange={(e) => setIdentityFilter(e.target.value)}
                      placeholder="Optional subject lock (e.g. ads.vreal@)"
                      className="flex-1 bg-[#090A0C] border border-[#22262E] px-2.5 py-1 text-xs text-[#F3F4F6]"
                    />
                    <button
                      type="button"
                      onClick={() => startQrChallenge(identityFilter)}
                      disabled={qrLoading}
                      className="px-2.5 py-1 bg-[#181B20] border border-[#22262E] hover:border-[#10B981] text-[#F3F4F6] flex items-center gap-1 cursor-pointer"
                    >
                      <RefreshCw className={`w-3 h-3 ${qrLoading ? 'animate-spin' : ''}`} />
                      <span>{identityFilter.trim() ? 'Scope' : 'Refresh'}</span>
                    </button>
                  </div>

                  <div className="bg-[#090A0C] border border-[#22262E] p-4 flex flex-col items-center space-y-2.5">
                    {qr?.qrCodeDataUrl ? (
                      <img
                        src={qr.qrCodeDataUrl}
                        alt="LoginConsent QR"
                        className="bg-white p-2 border border-[#22262E]"
                        style={{ width: 200, height: 200 }}
                      />
                    ) : (
                      <div
                        className="bg-[#111317] border border-[#22262E] flex items-center justify-center text-[#6B7280]"
                        style={{ width: 200, height: 200 }}
                      >
                        Generating challenge...
                      </div>
                    )}

                    <div className="flex items-center gap-2 text-[11px] text-[#F97316]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#F97316] animate-pulse" />
                      <span>Awaiting Verus Mobile callback...</span>
                    </div>

                    {qr?.deepLink && (
                      <div className="w-full pt-2 border-t border-[#22262E] flex items-center justify-between text-[11px]">
                        <a href={qr.deepLink} className="text-[#10B981] hover:underline">
                          Launch Wallet URI ↗
                        </a>
                        <CopyInline value={qr.deepLink} label="Copy URI" />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex gap-1.5">
                    <label htmlFor="cli-identity" className="sr-only">VerusID identity</label>
                    <input
                      id="cli-identity"
                      value={cliIdentity}
                      autoComplete="off"
                      onChange={(e) => setCliIdentity(e.target.value)}
                      placeholder="vreal@"
                      className="flex-1 bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
                    />
                    <button
                      type="button"
                      onClick={requestCliChallenge}
                      className="px-3 py-1.5 bg-[#10B981] text-[#090A0C] font-bold cursor-pointer"
                    >
                      Challenge
                    </button>
                  </div>

                  {challenge && (
                    <div className="space-y-2.5 pt-2 border-t border-[#22262E]">
                      <div className="bg-[#090A0C] border border-[#22262E] p-2 text-[11px] space-y-0.5">
                        <div className="flex justify-between">
                          <span className="text-[#6B7280]">Identity:</span>
                          <span className="text-[#F3F4F6]">{challenge.friendlyName}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[#6B7280]">i-Address:</span>
                          <span className="text-[#10B981]">{challenge.iAddress}</span>
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between text-[10px] text-[#6B7280] uppercase mb-1">
                          <span>CLI Command</span>
                          <CopyInline value={challenge.cliCommand} label="Copy" />
                        </div>
                        <pre className="bg-[#090A0C] border border-[#22262E] p-2 text-[11px] text-[#F97316] overflow-x-auto">
                          {challenge.cliCommand}
                        </pre>
                      </div>

                      {challenge.canLocalSign && (
                        <button
                          type="button"
                          onClick={signWithNode}
                          className="w-full py-1.5 px-3 bg-[#10B981] text-[#090A0C] font-bold cursor-pointer"
                        >
                          Sign via Connected VRSCTEST Daemon &amp; Authenticate
                        </button>
                      )}

                      <div className="flex gap-1.5">
                        <label htmlFor="cli-signature" className="sr-only">Paste base64 signature</label>
                        <input
                          id="cli-signature"
                          value={signature}
                          autoComplete="off"
                          onChange={(e) => setSignature(e.target.value)}
                          placeholder="Paste base64 signature..."
                          className="flex-1 bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
                        />
                        <button
                          type="button"
                          onClick={() => verifyCli()}
                          className="px-3 py-1.5 bg-[#181B20] border border-[#22262E] hover:border-[#10B981] text-[#F3F4F6] cursor-pointer"
                        >
                          Verify
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
