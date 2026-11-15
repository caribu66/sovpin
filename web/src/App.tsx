import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { Routes, Route, Navigate, Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Database,
  UploadCloud,
  Radar,
  CreditCard,
  BookOpen,
  LogOut,
  Search,
  Terminal,
} from 'lucide-react';
import { AuthProvider } from './lib/auth-context';
import { useAuth } from './lib/useAuth';
import { api } from './lib/api';
import { formatBytes, truncateMiddle } from './lib/format';
import { CopyInline } from './components/CopyInline';
import { Kbd } from './components/Kbd';
const LandingPage = lazy(() => import('./pages/LandingPage'));
const SignInPage = lazy(() => import('./pages/SignInPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const PinStudioPage = lazy(() => import('./pages/PinStudioPage'));
const WatchersPage = lazy(() => import('./pages/WatchersPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const CompliancePage = lazy(() => import('./pages/CompliancePage'));

function RouteFallback() {
  return (
    <div
      className="min-h-[40vh] flex items-center justify-center text-xs font-mono text-[#9CA3AF]"
      role="status"
    >
      Loading view…
    </div>
  );
}

function FullPageFallback() {
  return (
    <div className="min-h-screen bg-[#090A0C] text-[#9CA3AF] flex items-center justify-center text-xs font-mono" role="status">
      [SOVPIN] Loading console…
    </div>
  );
}

class RouteErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-[40vh] flex items-center justify-center p-6" role="alert">
          <div className="max-w-md w-full border border-red-800 bg-[#181B20] p-5 text-xs font-mono">
            <div className="text-red-400 mb-2">This view failed to load.</div>
            <div className="text-[#9CA3AF] mb-4">The app may have been updated. Reload to fetch the latest bundle.</div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 bg-[#10B981] text-[#090A0C] font-bold cursor-pointer"
            >
              Reload console
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function LazyPage({ children }: { children: React.ReactNode }) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}

function ProtectedShell() {
  return (
    <Protected>
      <Outlet />
    </Protected>
  );
}

function PublicShell() {
  return (
    <ConsoleShell>
      <Outlet />
    </ConsoleShell>
  );
}

function ConsoleShell({ children }: { children: React.ReactNode }) {
  const { account, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState('');
  const [health, setHealth] = useState<any>(null);

  const checkHealth = useCallback(async () => {
    try {
      const h = await api<any>('/healthz');
      setHealth(h);
    } catch {
      setHealth({ healthy: false, kubo: { online: false }, verus: { online: false }, db: { online: false } });
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void checkHealth(), 0);
    const interval = setInterval(() => void checkHealth(), 15000);
    return () => { clearTimeout(t); clearInterval(interval); };
  }, [checkHealth]);

  useEffect(() => {
    document.title = health?.healthy
      ? 'SovPin Console [●]'
      : health === null
        ? 'SovPin Console'
        : 'SovPin Console [○]';
  }, [health]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setCmdOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!cmdOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = document.querySelector<HTMLElement>('[aria-label="Command palette"]');
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (el) => !el.hasAttribute('disabled')
      );
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panel) return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onTab);
    return () => {
      window.removeEventListener('keydown', onTab);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [cmdOpen]);

  if (!account) {
    return <div className="min-h-screen bg-[#090A0C] text-[#F3F4F6] p-6">{children}</div>;
  }

  const storageRoutes = [
    { to: '/dashboard', label: 'Pinned Objects', icon: Database, shortcut: 'G O' },
    { to: '/pins', label: 'Pin & VDXF Studio', icon: UploadCloud, shortcut: 'G P' },
    { to: '/watchers', label: 'CMM Watchers', icon: Radar, shortcut: 'G W' },
  ];

  const accountRoutes = [
    { to: '/billing', label: 'Usage & Billing', icon: CreditCard, shortcut: 'G B' },
    { to: '/docs', label: 'S3 / VDXF API & Legal', icon: BookOpen, shortcut: 'G D' },
  ];

  const allCommands = [
    ...storageRoutes.map((r) => ({ label: `Go to ${r.label}`, action: () => navigate(r.to), kbd: r.shortcut })),
    ...accountRoutes.map((r) => ({ label: `Go to ${r.label}`, action: () => navigate(r.to), kbd: r.shortcut })),
    {
      label: 'Copy Dedicated Gateway URL (https://ipfs.sovpin.com)',
      action: () => {
        navigator.clipboard?.writeText('https://ipfs.sovpin.com').catch(() => {});
      },
      kbd: 'C G',
    },
    {
      label: `Copy Tenant Verus i-Address (${account.tenant.i_address})`,
      action: () => {
        navigator.clipboard?.writeText(account.tenant.i_address).catch(() => {});
      },
      kbd: 'C I',
    },
  ].filter((c) => c.label.toLowerCase().includes(cmdQuery.toLowerCase()));

  const routeSegment = location.pathname.replace(/^\//, '') || 'dashboard';

  return (
    <div className="min-h-screen bg-[#090A0C] text-[#F3F4F6] flex flex-col md:flex-row">
      {/* Compact Left Sidebar (220px on desktop, top bar on mobile) */}
      <aside className="w-full md:w-[220px] shrink-0 border-b md:border-b-0 md:border-r border-[#22262E] bg-[#111317] flex flex-col md:h-screen md:sticky md:top-0 select-none">
        {/* Brand + Bucket/Identity Switcher */}
        <div className="px-3 py-2.5 border-b border-[#22262E] space-y-2">
          <Link to="/" className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 bg-[#10B981] text-[#090A0C] font-mono font-bold text-[11px] flex items-center justify-center rounded-none">
                SP
              </div>
              <span className="font-bold text-xs tracking-tight text-[#F3F4F6] uppercase font-mono">
                SovPin Ledger
              </span>
            </div>
            <span className="text-[10px] font-mono text-[#10B981] px-1 border border-[#10B981]/40">
              v2.0
            </span>
          </Link>

          <div className="bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5">
            <div className="flex items-center justify-between text-[10px] font-mono text-[#6B7280] uppercase">
              <span>VerusID Namespace</span>
              <CopyInline value={account.tenant.i_address} />
            </div>
            <div className="text-xs font-mono text-[#F3F4F6] truncate mt-0.5">
              {account.tenant.friendly_name}
            </div>
            <div className="text-[10px] font-mono text-[#6B7280] truncate">
              {truncateMiddle(account.tenant.i_address, 10, 6)}
            </div>
          </div>
        </div>

        {/* Navigation Groups */}
        <nav aria-label="Console sections" className="flex md:flex-col gap-3 overflow-x-auto md:overflow-y-auto flex-1 px-2 py-2.5 md:space-y-3 md:gap-0">
          <div className="shrink-0">
            <div className="text-[10px] font-mono text-[#6B7280] uppercase tracking-wider px-2 mb-1">
              Object Storage
            </div>
            <div className="space-y-0.5">
              {storageRoutes.map((item) => {
                const Icon = item.icon;
                const active = location.pathname === item.to;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`flex items-center justify-between whitespace-nowrap px-2.5 py-1.5 text-xs font-mono transition duration-75 ${
                      active
                        ? 'bg-[#181B20] text-[#10B981] border-l-2 border-[#10B981]'
                        : 'text-[#9CA3AF] hover:text-[#F3F4F6] hover:bg-[#16191F]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="w-3.5 h-3.5" />
                      <span>{item.label}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="shrink-0">
            <div className="text-[10px] font-mono text-[#6B7280] uppercase tracking-wider px-2 mb-1">
              System &amp; Billing
            </div>
            <div className="space-y-0.5">
              {accountRoutes.map((item) => {
                const Icon = item.icon;
                const active =
                  location.pathname === item.to ||
                  (item.to === '/docs' && location.pathname === '/compliance');
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`flex items-center justify-between whitespace-nowrap px-2.5 py-1.5 text-xs font-mono transition duration-75 ${
                      active
                        ? 'bg-[#181B20] text-[#10B981] border-l-2 border-[#10B981]'
                        : 'text-[#9CA3AF] hover:text-[#F3F4F6] hover:bg-[#16191F]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="w-3.5 h-3.5" />
                      <span>{item.label}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>

        {/* Bottom Network Telemetry */}
        <div className="px-3 py-2.5 border-t border-[#22262E] bg-[#090A0C] space-y-1.5 text-[11px] font-mono tabular-nums">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[#9CA3AF]">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  health?.kubo?.online !== false ? 'bg-[#10B981]' : 'bg-red-500'
                }`}
              />
              <span>Kubo {health?.kubo?.version ? `v${health.kubo.version}` : 'RPC'}</span>
            </span>
            <span className="text-[#10B981]">
              {health?.kubo?.online !== false ? 'Online' : 'Offline'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[#9CA3AF]">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  health?.verus?.online !== false ? 'bg-[#10B981]' : 'bg-red-500'
                }`}
              />
              <span>{health?.verus?.chain || 'VRSCTEST'} RPC</span>
            </span>
            <span className="text-[#6B7280]">
              {health?.verus?.blocks ? `#${health.verus.blocks}` : 'Online'}
            </span>
          </div>
          <div className="pt-1.5 border-t border-[#22262E] flex items-center justify-between">
            <span className="text-[10px] text-[#6B7280] uppercase">{account.plan.name}</span>
            <button
              type="button"
              onClick={() => {
                signOut();
                navigate('/');
              }}
              className="text-[11px] text-[#9CA3AF] hover:text-[#F3F4F6] flex items-center gap-1 cursor-pointer"
            >
              <LogOut className="w-3 h-3" />
              <span>Exit</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Column */}
      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        {/* Top Utility Bar */}
        <header className="sticky top-0 z-20 h-10 border-b border-[#22262E] bg-[#090A0C] px-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-mono min-w-0 overflow-hidden">
            <span className="text-[#6B7280] truncate">{account.tenant.friendly_name}</span>
            <span className="text-[#6B7280] shrink-0">/</span>
            <span className="text-[#9CA3AF] shrink-0">kubo-primary</span>
            <span className="text-[#6B7280] shrink-0">/</span>
            <span className="text-[#F3F4F6] font-semibold shrink-0">{routeSegment}</span>
          </div>

          <div className="flex items-center gap-2">
            <div
              className={`hidden sm:flex items-center gap-1.5 text-[11px] font-mono tabular-nums px-2.5 py-0.5 border ${
                health?.healthy
                  ? 'border-[#10B981]/40 text-[#10B981] bg-[#10B981]/5'
                  : health === null
                    ? 'border-[#22262E] text-[#6B7280] bg-[#111317]'
                    : 'border-red-800 text-red-400 bg-red-950/30'
              }`}
              title={
                health?.healthy
                  ? 'API, Kubo & Verus RPC online'
                  : health === null
                    ? 'Checking...'
                    : `Degraded: DB=${health?.db?.online ? 'ok' : 'down'}, Kubo=${health?.kubo?.online ? 'ok' : 'down'}, Verus=${health?.verus?.online ? 'ok' : 'down'}`
              }
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  health?.healthy
                    ? 'bg-[#10B981]'
                    : health === null
                      ? 'bg-[#6B7280]'
                      : 'bg-red-500 animate-pulse'
                }`}
              />
              <span>{health?.healthy ? 'API · OK' : health === null ? 'API...' : 'API · Degraded'}</span>
            </div>

            <div className="hidden sm:flex items-center gap-2 text-[11px] font-mono tabular-nums text-[#9CA3AF] px-2.5 py-0.5 border border-[#22262E] bg-[#111317]">
              <span>DAG: {formatBytes(account.usage.usedBytes)}</span>
              <span className="text-[#6B7280]">/</span>
              <span>{formatBytes(account.plan.storageLimitBytes)}</span>
            </div>

            <button
              type="button"
              onClick={() => setCmdOpen(true)}
              className="px-2.5 py-0.5 bg-[#111317] hover:bg-[#181B20] border border-[#22262E] text-xs font-mono text-[#9CA3AF] hover:text-[#F3F4F6] flex items-center gap-2 cursor-pointer"
            >
              <Search className="w-3 h-3" />
              <span>Command</span>
              <Kbd>⌘K</Kbd>
            </button>
          </div>
        </header>

        {/* Global Connection Banner */}
        {!health?.healthy && health !== null && (
          <div className="bg-red-950/40 border-b border-red-800 px-4 py-1.5 text-xs font-mono text-red-400 flex items-center justify-between">
            <span>
              ⚠ Backend degraded — DB: {health?.db?.online ? 'ok' : 'down'}, Kubo: {health?.kubo?.online ? 'ok' : 'down'}, Verus RPC: {health?.verus?.online ? 'ok' : 'down'}. Uploads and pinning may fail.
            </span>
            <button
              type="button"
              onClick={() => void checkHealth()}
              className="px-2 py-0.5 bg-red-900/50 border border-red-700 text-red-300 hover:text-red-100 cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {/* Workspace Body */}
        <main className="flex-1 min-w-0 p-3 sm:p-4">{children}</main>

        {/* Utilitarian Status Footer */}
        <footer className="border-t border-[#22262E] bg-[#090A0C] px-4 py-1.5 text-[11px] font-mono text-[#6B7280] flex flex-wrap items-center justify-between gap-2">
          <span>
            SovPin Technologies Ltd (England &amp; Wales) · Tenant: {account.tenant.i_address}
          </span>
          <div className="flex items-center gap-4">
            <span>Gateway: https://ipfs.sovpin.com</span>
            <Link to="/" className="text-[#9CA3AF] hover:text-[#F3F4F6]">
              Index
            </Link>
          </div>
        </footer>
      </div>

      {/* ⌘K Command Palette Modal */}
      {cmdOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-start justify-center pt-24 p-4"
          onClick={() => setCmdOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="w-full max-w-lg bg-[#181B20] border border-[#22262E] font-mono text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 border-b border-[#22262E] flex items-center gap-2 bg-[#111317]">
              <Terminal className="w-3.5 h-3.5 text-[#10B981]" aria-hidden="true" />
              <label htmlFor="cmd-palette-input" className="sr-only">Type a command or route</label>
              <input
                id="cmd-palette-input"
                autoFocus
                type="text"
                value={cmdQuery}
                onChange={(e) => setCmdQuery(e.target.value)}
                placeholder="Type a command or route..."
                className="flex-1 bg-transparent text-[#F3F4F6] placeholder-[#6B7280] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setCmdOpen(false)}
                aria-label="Close command palette"
                className="text-[#6B7280] hover:text-[#F3F4F6] text-sm leading-none cursor-pointer"
              >
                ✕
              </button>
              <Kbd>Esc</Kbd>
            </div>
            <div className="divide-y divide-[#22262E] max-h-64 overflow-y-auto">
              {allCommands.map((c, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    c.action();
                    setCmdOpen(false);
                  }}
                  className="w-full px-3 py-2 text-left flex items-center justify-between hover:bg-[#111317] text-[#F3F4F6] cursor-pointer"
                >
                  <span>{c.label}</span>
                  <Kbd>{c.kbd}</Kbd>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { account, loading, authError, refresh } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-[#090A0C] text-[#9CA3AF] flex items-center justify-center text-xs font-mono">
        [SOVPIN] Initializing session ledger...
      </div>
    );
  }
  // Token is present but the session check failed on the network/server:
  // stay on a retry screen instead of dropping into a fresh QR flow.
  if (authError && !account) {
    return (
      <div className="min-h-screen bg-[#090A0C] text-[#F3F4F6] flex items-center justify-center p-6">
        <div className="max-w-md w-full border border-red-800 bg-[#181B20] p-5 text-xs font-mono" role="alert">
          <div className="text-red-400 mb-2">Session check failed: {authError}</div>
          <div className="text-[#9CA3AF] mb-4">Your sign-in token was kept. Retry the session check.</div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="px-3 py-1.5 bg-[#10B981] text-[#090A0C] font-bold cursor-pointer"
          >
            Retry session check
          </button>
        </div>
      </div>
    );
  }
  if (!account) return <Navigate to="/signin" replace />;
  return <ConsoleShell>{children}</ConsoleShell>;
}

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<FullPageFallback />}>
      <Routes>
        <Route path="/" element={<LazyPage><LandingPage /></LazyPage>} />
        <Route path="/signin" element={<LazyPage><SignInPage /></LazyPage>} />
        <Route element={<ProtectedShell />}>
          <Route path="/dashboard" element={<LazyPage><DashboardPage /></LazyPage>} />
          <Route path="/pins" element={<LazyPage><PinStudioPage /></LazyPage>} />
          <Route path="/watchers" element={<LazyPage><WatchersPage /></LazyPage>} />
          <Route path="/billing" element={<LazyPage><BillingPage /></LazyPage>} />
        </Route>
        <Route element={<PublicShell />}>
          <Route path="/docs" element={<LazyPage><CompliancePage /></LazyPage>} />
          <Route path="/compliance" element={<LazyPage><CompliancePage /></LazyPage>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </AuthProvider>
  );
}
