import { useCallback, useEffect } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { api, uploadFileWithAutoChunking } from '../lib/api';
import { shouldRetryOnce } from '../lib/queryClient';
import { useAuth } from '../lib/useAuth';

export const ledgerKeys = {
  pins: ['pins'] as const,
  apiKeys: ['api-keys'] as const,
  webhooks: ['webhooks'] as const,
  kubo: ['kubo'] as const,
};

export function usePins() {
  return useQuery({
    queryKey: ledgerKeys.pins,
    queryFn: async () => {
      const r = await api<{ results: any[] }>('/v1/pins');
      return r.results || [];
    },
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: ledgerKeys.apiKeys,
    queryFn: async () => {
      const r = await api<{ keys: any[] }>('/v1/keys');
      return r.keys || [];
    },
  });
}

export function useWebhookEvents() {
  return useQuery({
    queryKey: ['webhook-events'] as const,
    queryFn: async () => {
      const r = await api<{ events: { event: string; description: string }[] }>('/v1/webhook-events');
      return r.events || [];
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useWebhooks() {
  return useQuery({
    queryKey: ledgerKeys.webhooks,
    queryFn: async () => {
      try {
        const r = await api<{ webhooks: any[] }>('/v1/webhooks');
        return r.webhooks || [];
      } catch (e: any) {
        // Non-auth outages keep the previous list; auth failures must surface.
        if (e?.status === 401 || e?.status === 403) throw e;
        return [];
      }
    },
  });
}

export function useKuboStats() {
  return useQuery({
    queryKey: ledgerKeys.kubo,
    queryFn: () => api('/api/kubo'),
    staleTime: 30_000,
    retry: shouldRetryOnce,
  });
}

/**
 * Watches query errors for an expired session: a 401 anywhere in the ledger
 * re-checks the session so the provider clears the token and Protected
 * redirects to sign-in. Returns the first 403 message for scoped-access UI.
 */
export function useLedgerAuthGuard(errors: unknown[]): string | null {
  const { refresh } = useAuth();
  const unauthorized = errors.some((e: any) => e?.status === 401);
  useEffect(() => {
    if (unauthorized) void refresh();
  }, [unauthorized, refresh]);
  const forbidden = errors.find((e: any) => e?.status === 403) as any;
  return forbidden ? forbidden.message || 'Insufficient scope for this view.' : null;
}

export function useInvalidateLedger() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ledgerKeys.pins }),
      qc.invalidateQueries({ queryKey: ledgerKeys.apiKeys }),
      qc.invalidateQueries({ queryKey: ledgerKeys.webhooks }),
    ]);
    await refresh();
  }, [qc, refresh]);
}

export function useUploadFile(): UseMutationResult<
  any,
  Error,
  { file: File; filename: string; vdxfUri: string; onProgress?: (done: number, total: number) => void }
> {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (vars) =>
      uploadFileWithAutoChunking({
        file: vars.file,
        filename: vars.filename,
        vdxfUri: vars.vdxfUri,
        onProgress: vars.onProgress,
      }),
    onSuccess: () => void invalidate(),
  });
}

export function usePinCid() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (vars: { cid: string; name: string; vdxfUri: string }) =>
      api('/v1/pins', {
        method: 'POST',
        body: JSON.stringify({ cid: vars.cid, name: vars.name, vdxfUri: vars.vdxfUri }),
      }),
    onSuccess: () => void invalidate(),
  });
}

export function useUnpin() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (requestId: string) => api(`/v1/pins/${requestId}`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
  });
}

export function useVerifyPin() {
  return useMutation({
    mutationFn: (requestId: string) => api(`/v1/pins/${requestId}/verify`, { method: 'POST' }),
  });
}

export function useUploadJson() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (payload: { filename: string; mimeType: string; vdxfUri: string; contentText: string }) =>
      api('/v1/pin/upload', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => void invalidate(),
  });
}

export function useSyncKubo() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: () => api('/v1/pins/import-kubo', { method: 'POST' }),
    onSuccess: () => void invalidate(),
  });
}

export function useCreateApiKey() {
  const invalidate = useInvalidateLedger();
  const { setActiveApiKeySample } = useAuth();
  return useMutation({
    mutationFn: (vars: { name: string; scopes: string }) =>
      api<{ apiKey: string; keyPrefix: string }>('/v1/keys', {
        method: 'POST',
        body: JSON.stringify({ name: vars.name, scopes: vars.scopes }),
      }),
    onSuccess: (res) => {
      setActiveApiKeySample(res.apiKey);
      void invalidate();
    },
  });
}

export function useRevokeApiKey() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (keyId: string) => api(`/v1/keys/${keyId}`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
  });
}

export function useCreateWebhook() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (vars: { url: string; events: string }) =>
      api<{ secret: string; webhookId: string }>('/v1/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: vars.url, events: vars.events }),
      }),
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteWebhook() {
  const invalidate = useInvalidateLedger();
  return useMutation({
    mutationFn: (webhookId: string) => api(`/v1/webhooks/${webhookId}`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
  });
}

export function useWatchers() {
  return useQuery({
    queryKey: ['watchers'] as const,
    queryFn: async () => {
      const r = await api<{ watchers: any[] }>('/v1/watchers');
      return r.watchers || [];
    },
  });
}

export function useCreateWatcher() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useMutation({
    mutationFn: (vars: { targetIdentity: string; vdxfUri: string }) =>
      api('/v1/watchers', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['watchers'] });
      void refresh();
    },
  });
}

export function useSyncWatcher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/watchers/${id}/sync`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['watchers'] }),
  });
}

export function useRepairWatcher() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/watchers/${id}/repair`, { method: 'POST' }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['watchers'] }),
        qc.invalidateQueries({ queryKey: ledgerKeys.pins }),
        refresh(),
      ]);
    },
  });
}

export function useDeleteWatcher() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/watchers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['watchers'] });
      void refresh();
    },
  });
}

export function usePlans() {
  return useQuery({
    queryKey: ['plans'] as const,
    queryFn: async () => {
      const info = await api<{ plans: any[] }>('/v1/public/info');
      return info.plans || [];
    },
    staleTime: 60_000,
  });
}

export function useInvoices() {
  return useQuery({
    queryKey: ['invoices'] as const,
    queryFn: async () => {
      const r = await api<{ invoices: any[] }>('/v1/billing/invoices');
      return r.invoices || [];
    },
  });
}

export function useCheckout() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useMutation({
    mutationFn: (vars: { planId: string; paymentRail: string }) =>
      api('/v1/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ planId: vars.planId, paymentRail: vars.paymentRail }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void refresh();
    },
  });
}

export function useSettleInvoice() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/billing/invoices/${id}/settle`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void refresh();
    },
  });
}

export function useSaveBillingProfile() {
  const { refresh } = useAuth();
  return useMutation({
    mutationFn: (vars: { ukCompanyName: string; ukVatNumber: string; billingCountry: string }) =>
      api('/v1/account/billing-profile', { method: 'PATCH', body: JSON.stringify(vars) }),
    onSuccess: () => void refresh(),
  });
}

export function useComplianceStatus() {
  return useQuery({
    queryKey: ['compliance-status'] as const,
    queryFn: () => api<{ blockedCids: any[] }>('/v1/compliance/status'),
    staleTime: 30_000,
  });
}

export function useVerusStats() {
  return useQuery({
    queryKey: ['verus'] as const,
    queryFn: () => api('/api/verus').catch(() => null),
    staleTime: 30_000,
    retry: shouldRetryOnce,
  });
}

export function useCloudflareStats() {
  return useQuery({
    queryKey: ['cloudflare'] as const,
    queryFn: () => api('/api/cloudflare').catch(() => null),
    staleTime: 60_000,
    retry: shouldRetryOnce,
  });
}

export function useTakedown() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  return useMutation({
    mutationFn: (vars: { cid: string; reason: string }) =>
      api('/v1/compliance/takedown', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['compliance-status'] }),
        qc.invalidateQueries({ queryKey: ledgerKeys.pins }),
        refresh(),
      ]);
    },
  });
}
