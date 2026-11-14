import { MutationCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export function shouldRetry(failureCount: number, error: unknown): boolean {
  // Auth failures are handled by the session provider (redirect / retry
  // screen) — retrying them only delays the inevitable.
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return false;
  }
  return failureCount < 2;
}

/** Single-attempt variant for cheap status probes (kubo/verus/cloudflare). */
export function shouldRetryOnce(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && shouldRetry(failureCount, error);
}

let unauthorizedHandler: (() => void) | null = null;

/** Registered once by the session provider; invoked on any mutation 401. */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error) => {
      // An expired session surfacing from any mutation re-checks the session
      // so the provider clears the token and Protected redirects to sign-in.
      if (error instanceof ApiError && error.status === 401) {
        unauthorizedHandler?.();
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: shouldRetry,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
