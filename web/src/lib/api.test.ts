import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, getToken, setToken } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  setToken('');
});

function mockFetch(res: { ok: boolean; status: number; json: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: res.ok,
      status: res.status,
      json: async () => {
        if (typeof res.json === 'function') throw new Error('no json');
        return res.json;
      },
    }))
  );
}

describe('api()', () => {
  it('returns parsed JSON on success', async () => {
    mockFetch({ ok: true, status: 200, json: { pins: [] } });
    await expect(api('/v1/pins')).resolves.toEqual({ pins: [] });
  });

  it('throws ApiError carrying the HTTP status', async () => {
    mockFetch({ ok: false, status: 401, json: { error: 'SESSION_EXPIRED' } });
    const err = await api('/v1/pins').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('SESSION_EXPIRED');
  });

  it('maps network failures to status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    const err = await api('/v1/pins').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Network unreachable/);
  });

  it('handles non-JSON error bodies', async () => {
    mockFetch({ ok: false, status: 500, json: (() => {}) as unknown });
    const err = await api('/v1/pins').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Request failed (500)');
  });

  it('sends the session token as a Bearer header', async () => {
    setToken('tok123');
    const fetchMock = vi.fn(async (_url: string, _init?: { headers?: Headers }) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await api('/v1/account');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers?.get('Authorization')).toBe('Bearer tok123');
    expect(getToken()).toBe('tok123');
  });

  it('does not set Content-Type for FormData bodies', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { headers?: Headers }) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.bin');
    await api('/v1/pin/upload/stream', { method: 'POST', body: form });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers?.get('Content-Type')).toBeNull();
  });
});
