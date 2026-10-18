/**
 * DHAROHAR REST API Client
 *
 * Typed communication between the React frontend and the Express + PostGIS backend.
 * Relative '/api' by default so a deployed build talks to its own origin; Vite proxies
 * '/api' to the Express server in development. Override with VITE_API_BASE at build time.
 */

import { BackendHealthInfo, FieldInspectionRecord, LandParcel } from '../../types';

const API_BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '');
const TOKEN_KEY = 'dharohar.jwt.token.v4';
const REQUEST_TIMEOUT_MS = 12000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getStoredAuthToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Whether an authenticated session exists. Pre-login code must not call authenticated routes.
 */
export function hasStoredAuthSession(): boolean {
  return Boolean(getStoredAuthToken());
}

export function setStoredAuthToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function authHeaders(): HeadersInit {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/**
 * One request path that surfaces failure instead of swallowing it. Returning `null` for
 * "offline", "401" and "the server rejected this record" alike meant the UI could show a
 * successful seal for a write that never happened.
 */
async function request<T>(
  path: string,
  init: { method?: string; body?: any; auth?: boolean } = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method || 'GET',
      headers: init.auth === false ? { 'Content-Type': 'application/json' } : authHeaders(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new ApiError(
      err?.name === 'AbortError' ? 'The server took too long to respond.' : 'The API server is unreachable.',
      0
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    if (!res.ok) throw new ApiError(`Server returned HTTP ${res.status}.`, res.status);
    throw new ApiError('Server returned a response that was not JSON.', res.status);
  }

  if (!res.ok || payload?.success === false) {
    throw new ApiError(
      payload?.error?.message || `Request failed with HTTP ${res.status}.`,
      res.status,
      payload?.error?.code
    );
  }

  return payload as T;
}

// 1. Health check
export async function fetchBackendHealth(): Promise<BackendHealthInfo> {
  try {
    const data = await request<any>('/health', { auth: false });
    return {
      status: 'connected',
      storageMode: data.storageMode || 'dev-fallback',
      postgisAvailable: Boolean(data.postgisAvailable),
      version: data.postgisVersion || undefined,
      database: data.database || undefined,
      uptimeSeconds: data.uptimeSeconds || 0,
      lastSync: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'dev-fallback',
      storageMode: 'dev-fallback',
      postgisAvailable: false,
      lastSync: new Date().toISOString(),
    };
  }
}

// 2. Authentication
export async function loginToBackend(
  identifier: string,
  password: string
): Promise<{ token: string; user: any } | null> {
  if (!identifier || !password) {
    throw new ApiError('Officer identifier and password are both required.', 400, 'MISSING_CREDENTIALS');
  }

  const json = await request<{ success: boolean; data: { token: string; user: any } }>('/auth/login', {
    method: 'POST',
    body: { email: identifier, password },
    auth: false,
  });

  if (json?.data?.token) setStoredAuthToken(json.data.token);
  return json?.data ?? null;
}

// 3. Parcels: List
export async function fetchParcelsFromBackend(filters?: {
  search?: string;
  filter?: string;
  status?: string;
}): Promise<{ storageMode: string; parcels: LandParcel[] }> {
  const params = new URLSearchParams();
  if (filters?.search) params.append('search', filters.search);
  if (filters?.filter) params.append('filter', filters.filter);
  if (filters?.status) params.append('status', filters.status);

  const qs = params.toString();
  const json = await request<any>(`/parcels${qs ? `?${qs}` : ''}`);

  return {
    storageMode: json.storageMode || 'dev-fallback',
    parcels: Array.isArray(json.data?.parcels) ? json.data.parcels : [],
  };
}

// 4. Parcels: Create
export async function createParcelOnBackend(
  parcel: Partial<LandParcel>
): Promise<{ parcel: LandParcel; storageMode: string }> {
  const json = await request<any>('/parcels', { method: 'POST', body: parcel });
  return { parcel: json.data?.parcel, storageMode: json.storageMode || 'dev-fallback' };
}

// 5. Parcels: Update
export async function updateParcelOnBackend(
  id: string,
  patch: Partial<LandParcel>
): Promise<{ parcel: LandParcel; storageMode: string }> {
  const json = await request<any>(`/parcels/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  return { parcel: json.data?.parcel, storageMode: json.storageMode || 'dev-fallback' };
}

// 6a. Documents: link an existing scanned record to a parcel (or detach it with null).
//
// Without this call the link lived only in browser state: land_documents.parcel_id stayed NULL, so
// the record appeared attached until reload, and then belonged to no parcel at all.
export async function linkDocumentOnBackend(
  documentId: string,
  parcelId: string | null
): Promise<{ documentId: string; parcelId: string | null; district: string | null; storageMode: string }> {
  const json = await request<any>(`/documents/${encodeURIComponent(documentId)}/link`, {
    method: 'POST',
    body: { parcelId },
  });
  return {
    documentId: json.data?.documentId ?? documentId,
    parcelId: json.data?.parcelId ?? null,
    district: json.data?.district ?? null,
    storageMode: json.storageMode || 'dev-fallback',
  };
}

// 6. Parcels: Archive
export async function archiveParcelOnBackend(
  id: string,
  reason: string
): Promise<{ storageMode: string }> {
  const json = await request<any>(`/parcels/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: { reason },
  });
  return { storageMode: json.storageMode || 'dev-fallback' };
}

// 7. Field Inspection: Submit
export async function submitFieldInspectionToBackend(inspection: FieldInspectionRecord): Promise<{
  success: boolean;
  data?: any;
  storageMode?: string;
  error?: string;
}> {
  try {
    const json = await request<any>('/verifications/field-inspection', {
      method: 'POST',
      body: inspection,
    });
    return { success: true, data: json.data, storageMode: json.storageMode };
  } catch (err: any) {
    return { success: false, error: err instanceof ApiError ? err.message : String(err) };
  }
}

// 8. Verification: Officer Digital Seal
export async function sealRecordOnBackend(payload: {
  parcelId?: string;
  documentId?: string;
  officerNotes?: string;
  forceOverride?: boolean;
}): Promise<{
  certificateNumber: string;
  signatureHash: string;
  sealedAt: string;
  storageMode: string;
}> {
  const json = await request<any>('/verifications/seal', { method: 'POST', body: payload });
  return {
    certificateNumber: json.data?.certificateNumber,
    signatureHash: json.data?.signatureHash,
    sealedAt: json.data?.sealedAt,
    storageMode: json.storageMode || 'dev-fallback',
  };
}
