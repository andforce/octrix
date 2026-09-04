export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function cookie(name: string): string {
  return document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
    const csrf = cookie('octrix_csrf');
    if (csrf) headers.set('x-csrf-token', csrf);
  }
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, payload?.error?.code ?? 'request_failed', payload?.error?.message ?? '请求失败，请稍后重试');
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export function safeNext(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/dashboard';
  return value;
}

export function normalizeDeviceCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export function formatDeviceCode(value: string): string {
  const normalized = normalizeDeviceCode(value);
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}
