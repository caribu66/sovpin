const BASE = '';

export function getToken(): string {
  return localStorage.getItem('sovpin_session_token') || '';
}
export function setToken(t: string) {
  if (t) localStorage.setItem('sovpin_session_token', t);
  else localStorage.removeItem('sovpin_session_token');
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers || {});
  if (!(opts.body instanceof FormData) && !(opts.body instanceof Blob)) {
    headers.set('Content-Type', 'application/json');
  }
  const t = getToken();
  if (t) headers.set('Authorization', `Bearer ${t}`);
  let res: Response;
  try {
    res = await fetch(BASE + path, { ...opts, headers });
  } catch (err: any) {
    throw new ApiError(0, `Network unreachable: ${err?.message || 'fetch failed'}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any)?.error?.details || (data as any)?.error || `Request failed (${res.status})`;
    throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data as T;
}

const SINGLE_REQUEST_MAX_BYTES = 80 * 1024 * 1024; // 80 MiB (stays safely under Cloudflare 100 MB limit)
const CHUNK_PART_SIZE_BYTES = 40 * 1024 * 1024; // 40 MiB per part

export async function uploadFileWithAutoChunking(opts: {
  file: File;
  filename?: string;
  vdxfUri?: string;
  onProgress?: (doneParts: number, totalParts: number) => void;
}): Promise<any> {
  const filename = (opts.filename || opts.file.name || 'upload.bin').trim();
  const vdxfUri = (opts.vdxfUri || '').trim();
  const mimeType = opts.file.type || 'application/octet-stream';

  if (opts.file.size <= SINGLE_REQUEST_MAX_BYTES) {
    const form = new FormData();
    form.append('file', opts.file, filename);
    const query = vdxfUri ? `?vdxfUri=${encodeURIComponent(vdxfUri)}` : '';
    opts.onProgress?.(0, 1);
    const res = await api(`/v1/pin/upload/stream${query}`, {
      method: 'POST',
      body: form,
    });
    opts.onProgress?.(1, 1);
    return res;
  }

  const initRes = await api<{ uploadId: string }>('/v1/pin/upload/chunked/init', {
    method: 'POST',
    body: JSON.stringify({
      filename,
      mimeType,
      totalSizeBytes: opts.file.size,
      vdxfUri,
    }),
  });

  const totalParts = Math.ceil(opts.file.size / CHUNK_PART_SIZE_BYTES);
  opts.onProgress?.(0, totalParts);
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    const start = (partNumber - 1) * CHUNK_PART_SIZE_BYTES;
    const end = Math.min(start + CHUNK_PART_SIZE_BYTES, opts.file.size);
    const slice = opts.file.slice(start, end, mimeType);
    await api(
      `/v1/pin/upload/chunked/${encodeURIComponent(initRes.uploadId)}/part?partNumber=${partNumber}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: slice,
      }
    );
    opts.onProgress?.(partNumber, totalParts);
  }

  return api(`/v1/pin/upload/chunked/${encodeURIComponent(initRes.uploadId)}/complete`, {
    method: 'POST',
  });
}
