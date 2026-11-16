import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Ctx } from './auth-state';
import { api } from './api';
import { queryClient, setUnauthorizedHandler } from './queryClient';

export type Tenant = {
  i_address: string;
  friendly_name: string;
  primary_address: string | null;
  plan_id: string;
  uk_vat_registered: number;
  uk_company_name: string | null;
  uk_vat_number: string | null;
  billing_country: string;
  created_at: string;
};

export type PlanInfo = {
  id: string;
  name: string;
  chainScope: string;
  priceGbpPence: number;
  priceGbpDisplay: string;
  storageLimitBytes: number;
  gatewayBandwidthBytes: number;
  maxApiKeys: number;
  maxCmmWatchers: number;
  features: string[];
};

export type UsageInfo = {
  pinCount: number;
  usedBytes: number;
  activeApiKeys: number;
  activeWatchers: number;
};

export type Account = {
  tenant: Tenant;
  plan: PlanInfo;
  usage: UsageInfo;
  ukCompany: {
    legalName: string;
    jurisdiction: string;
    registeredCountry: string;
    vatRate: number;
    currency: string;
    icoRegistrationStatus: string;
  };
};

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut' | 'error';

export type AuthCtx = {
  account: Account | null;
  loading: boolean;
  status: AuthStatus;
  authError: string | null;
  activeApiKeySample: string;
  setActiveApiKeySample: (key: string) => void;
  signIn: () => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
};

const LEGACY_SECRET_KEYS = ['sovpin_active_api_key_sample'];

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [authError, setAuthError] = useState<string | null>(null);
  // Full API secrets stay in memory only — never persisted to localStorage.
  const [activeApiKeySample, setActiveApiKeySampleState] = useState<string>('');

  const loading = status === 'loading';

  const setActiveApiKeySample = useCallback((key: string) => {
    setActiveApiKeySampleState(key);
  }, []);

  const refresh = useCallback(async () => {
    // The session rides the HttpOnly cookie; always ask the server. A 401/403
    // means signed out, anything else is transient and keeps local state.
    try {
      const acc = await api<Account>('/v1/account');
      setAccount(acc);
      setAuthError(null);
      setStatus('signedIn');
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) {
        setAccount(null);
        setActiveApiKeySampleState('');
        setStatus('signedOut');
        // Drop cached tenant data so a later sign-in never reads it.
        queryClient.removeQueries();
      } else {
        setAuthError(e?.message || 'Session check failed.');
        setStatus('error');
      }
    }
  }, []);

  useEffect(() => {
    // One-time cleanup of secrets persisted by older builds.
    for (const k of LEGACY_SECRET_KEYS) {
      try {
        localStorage.removeItem(k);
      } catch {
        // Storage may be unavailable (private mode); secrets simply stay in memory.
      }
    }
    // Session bootstrap must run exactly once on mount, not on every render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // Mutation 401s re-check the session through the same path as queries.
    setUnauthorizedHandler(() => void refresh());
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  const tenantId = account?.tenant?.i_address ?? null;
  useEffect(() => {
    // Tenant switch (or sign-out): never serve one tenant's cached rows to another.
    queryClient.removeQueries();
  }, [tenantId]);

  const signOut = useCallback(() => {
    // The server clears the HttpOnly cookie; drop local state regardless.
    void api('/v1/auth/logout', { method: 'POST' }).catch(() => {});
    setAccount(null);
    setActiveApiKeySample('');
    setStatus('signedOut');
    queryClient.removeQueries();
  }, [setActiveApiKeySample]);

  // Called after the API has set the session cookie (verify / QR poll).
  const signIn = useCallback(async () => {
    setActiveApiKeySample('');
    await refresh();
  }, [refresh, setActiveApiKeySample]);

  const value = useMemo(
    () => ({
      account,
      loading,
      status,
      authError,
      activeApiKeySample,
      setActiveApiKeySample,
      signIn,
      signOut,
      refresh,
    }),
    [account, loading, status, authError, activeApiKeySample, setActiveApiKeySample, signIn, signOut, refresh]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
    </Ctx.Provider>
  );
}