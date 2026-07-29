import type { PrintOptions } from '@snorcal/shared';

const API_BASE = '/api';

// Retries transient backend downtime (dev-mode tsx restart, proxy 502/503/504,
// network "Failed to fetch"). Without this, any click during a backend restart
// surfaces a hard error in the UI and forces a manual frontend reload.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 300;

// Notified on any 401 so the AuthGate can flip back to the login screen.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(cb: () => void) { onUnauthorized = cb; }

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiFetch(path: string, options?: RequestInit) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // credentials:'include' so the same-origin auth cookie rides along
      // (same-origin in both prod — backend serves bundle — and dev — Vite proxy).
      const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...options });
      // 401 = session expired/missing. Don't retry; surface to AuthGate.
      if (res.status === 401) {
        try { onUnauthorized?.(); } catch {}
        let msg = 'Unauthorized';
        try { const t = await res.text(); if (t) msg = t; } catch {}
        throw new Error(msg);
      }
      // Retry transient proxy/gateway errors (backend mid-restart)
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const t = await res.text();
          if (t) {
            // Prefer the structured error field when the body is JSON
            // (backend returns { ok:false, error:"..." }), else the raw text.
            try { const j = JSON.parse(t); if (j?.error) msg = j.error; else msg = t; }
            catch { msg = t; }
          }
        } catch {}
        throw new Error(msg);
      }
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Unknown error');
      return json.data;
    } catch (err) {
      lastErr = err;
      // TypeError = fetch itself failed (backend down, ECONNREFUSED via proxy).
      // Other Errors come from explicit throw above (HTTP status) — only retry
      // while we still have attempts left AND it's not a known-permanent case.
      const isNetworkErr = err instanceof TypeError;
      const httpMsg = err instanceof Error ? err.message : '';
      const isRetryableStatus = /^\s*(502|503|504)\b/.test(httpMsg);
      if ((isNetworkErr || isRetryableStatus) && attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// --- Auth ---

export interface AuthStatus {
  disabled: boolean;
  requiresSetup: boolean;
  authenticated: boolean;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return apiFetch('/auth/status') as Promise<AuthStatus>;
}

/**
 * Throttled auth probe for SSE onerror handlers. EventSource can't read the
 * HTTP status of its handshake, so a 401 (expired cookie) looks like a silent
 * failure — UI keeps stale status forever and shows "offline" instead of
 * redirecting to login. On SSE error we hit /auth/status via apiFetch, which
 * triggers onUnauthorized on 401 → AuthGate flips to login. Throttled 30s
 * so a flapping SSE doesn't hammer the backend.
 */
let lastAuthProbe = 0;
export async function probeAuthOnSSEError(): Promise<void> {
  const now = Date.now();
  if (now - lastAuthProbe < 30_000) return;
  lastAuthProbe = now;
  try { await apiFetch('/auth/status'); } catch { /* onUnauthorized already fired */ }
}

export async function login(password: string): Promise<void> {
  await apiFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

export async function setupPassword(password: string): Promise<void> {
  await apiFetch('/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

export interface NegativePartMeta {
  plateIndex: number;
  partIndex: number;
  faceCount: number;
  boundsMin?: { x: number; y: number; z: number };
  boundsMax?: { x: number; y: number; z: number };
}

export interface PrintablePartMeta {
  plateIndex: number;
  partIndex: number;
  faceCount: number;
  name?: string;
  extruder?: number;
  boundsMin?: { x: number; y: number; z: number };
  boundsMax?: { x: number; y: number; z: number };
}

export async function uploadModel(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch('/models', { method: 'POST', body: formData }) as Promise<{
    id: string; name: string; faceCount: number; plateCount: number;
    bounds: { x: number; y: number; z: number };
    boundsMin?: { x: number; y: number; z: number };
    boundsMax?: { x: number; y: number; z: number };
    plates?: Array<{ index: number; faceCount: number; bounds: { x: number; y: number; z: number }; objectNames?: string[] }>;
    negativeParts?: NegativePartMeta[];
    parts?: PrintablePartMeta[];
  }>;
}

export async function listModels() {
  return apiFetch('/models') as Promise<any[]>;
}

export async function getModel(id: string) {
  return apiFetch(`/models/${id}`);
}

/**
 * Fetch a model's embedded project_settings.config. Throws on network/server
 * errors; the caller distinguishes benign "no settings" (404) from real
 * failures. We deliberately don't swallow here — silent failure hid import bugs.
 */
export async function getModelSourceSettings(id: string): Promise<Record<string, unknown> | null> {
  return apiFetch(`/models/${id}/source-settings`);
}

export async function saveFaceColors(modelId: string, faceColors: Uint8Array, plate?: number) {
  const chunks: string[] = [];
  for (let i = 0; i < faceColors.length; i += 8192) {
    const slice = faceColors.subarray(i, Math.min(i + 8192, faceColors.length));
    chunks.push(String.fromCharCode(...slice));
  }
  const base64 = btoa(chunks.join(''));
  const params = plate && plate > 1 ? `?plate=${plate}` : '';
  return apiFetch(`/models/${modelId}/colors${params}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ faceColors: base64 }),
  });
}

export async function deleteModel(id: string) {
  return apiFetch(`/models/${id}`, { method: 'DELETE' });
}

export async function getModelColors(id: string, plate?: number): Promise<Uint8Array | null> {
  try {
    const params = plate && plate > 1 ? `?plate=${plate}` : '';
    const data = await apiFetch(`/models/${id}/colors${params}`) as { faceColors: string | null };
    if (!data.faceColors) return null;
    const binary = atob(data.faceColors);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export async function submitSliceJob(data: {
  modelId?: string; models?: { modelId: string; rotation?: { x: number; y: number; z: number }; positionOffset?: { x: number; y: number; z: number } }[];
  engine: string; plateIndex?: number; settings: Record<string, unknown>;
  profiles?: { machine?: string; filament?: string; filament2?: string; process?: string };
  multiMaterial?: { enabled: boolean; supportFilament: string; supportInterfaceFilament: string };
  filamentSlots?: { color: string; type: string; profile?: string }[];
  rotation?: { x: number; y: number; z: number };
  positionOffset?: { x: number; y: number; z: number };
  buildVolume?: { x: number; y: number; z: number };
}) {
  return apiFetch('/slice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }) as Promise<{ jobId: string }>;
}

export async function listJobs(status?: string) {
  const params = status ? `?status=${status}` : '';
  return apiFetch(`/jobs${params}`) as Promise<any[]>;
}

export async function getJob(id: string) {
  return apiFetch(`/jobs/${id}`);
}

export async function cancelJob(id: string) {
  return apiFetch(`/jobs/${id}/cancel`, { method: 'POST' });
}

export function getGcodeUrl(jobId: string, paused?: boolean) {
  return `${API_BASE}/files/gcode/${jobId}${paused ? '?paused=1' : ''}`;
}

export interface PausePoint {
  layer: number;
  label?: string;
}

export async function getJobPauses(jobId: string): Promise<PausePoint[]> {
  const data = await apiFetch(`/jobs/${jobId}/pauses`);
  return Array.isArray(data) ? data : [];
}

export async function setJobPauses(
  jobId: string,
  pauses: PausePoint[],
  protocol?: 'moonraker' | 'bambu',
) {
  return apiFetch(`/jobs/${jobId}/pauses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pauses, protocol }),
  });
}

export function getThreemfUrl(jobId: string) {
  return `${API_BASE}/files/threemf/${jobId}`;
}

/**
 * Build the input 3MF (same body as submitSliceJob) without slicing.
 * Returns an object URL suitable for `<a href>` download. Caller must
 * `URL.revokeObjectURL` after the click fires.
 */
export async function buildPreview3mf(data: Parameters<typeof submitSliceJob>[0]): Promise<{ url: string; filename: string }> {
  const res = await fetch(`${API_BASE}/files/preview-3mf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${txt}`);
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename="([^"]+)"/);
  const filename = m?.[1] ?? 'preview.3mf';
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), filename };
}

export function getModelUrl(modelId: string, plate?: number) {
  const params = plate && plate > 1 ? `?plate=${plate}` : '';
  return `${API_BASE}/files/model/${modelId}${params}`;
}

export function getNegativePartUrl(modelId: string, plate: number, part: number) {
  return `${API_BASE}/files/model/${modelId}/negative/${plate}/${part}`;
}

export function getPrintablePartUrl(modelId: string, plate: number, part: number) {
  return `${API_BASE}/files/model/${modelId}/part/${plate}/${part}`;
}

export async function getPrintablePartColors(modelId: string, plate: number, part: number): Promise<Uint8Array | null> {
  try {
    const data = await apiFetch(`/models/${modelId}/parts/${plate}/${part}/colors`) as { faceColors: string | null };
    if (!data.faceColors) return null;
    const binary = atob(data.faceColors);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export async function getDefaultSettings(engine: string) {
  return apiFetch(`/settings/${engine}/defaults`);
}

export async function getProfiles(engine: string, type?: string) {
  const params = type ? `?type=${type}` : '';
  return apiFetch(`/settings/${engine}/profiles${params}`) as Promise<{
    engine: string; profile_type: string; name: string; created_at: string;
  }[]>;
}

export async function getProfileSettings(engine: string, type: string, name: string) {
  return apiFetch(`/settings/${engine}/profiles/${type}/${encodeURIComponent(name)}`);
}

export async function deleteProfile(engine: string, type: string, name: string) {
  return apiFetch(`/settings/${engine}/profiles/${type}/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/**
 * Synthesize machine/process/filament profiles from an embedded 3MF
 * project_settings blob, named by their `*_settings_id` keys. Returns the
 * names to select in the dropdowns. Idempotent on the backend.
 */
export async function synthesizeEmbeddedProfiles(
  engine: string,
  blob: Record<string, unknown>,
): Promise<{ machine?: string; process?: string; filament?: string }> {
  return apiFetch(`/settings/${engine}/embedded-profiles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(blob),
  });
}

export async function testPrinterConnection(printerIp: string, printerPort?: number) {
  return apiFetch('/printers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ printerIp, printerPort }),
  }) as Promise<{ ok: boolean; info?: string; error?: string }>;
}

export async function discoverPrinters(timeout: number = 10000) {
  const res = await apiFetch(`/printers/discover?timeout=${timeout}`);
  return (res || []) as Array<{ ip: string; port: number; location: string; friendlyName: string; server: string; st: string; usn: string }>;
}

export async function sendToPrinter(jobId: string, printerIp: string, printerPort?: number) {
  // Legacy — use sendToRegisteredPrinter
  return apiFetch('/printers/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, printerIp, printerPort }),
  }) as Promise<{ ok: boolean; message?: string; error?: string; warning?: string }>;
}

// --- Registered printers (monitoring + control) ---

export async function listPrinters() {
  return apiFetch('/printers') as Promise<Array<{
    id: string; name: string; protocol: 'moonraker' | 'bambu';
    ip: string; port: number; serial?: string | null; accessCode?: string | null;
    apiKey?: string | null; lastStatus?: string | null; lastSeen?: string | null;
    createdAt: string; status?: any; model?: string | null;
    bedVolume?: { x: number; y: number; z: number } | null;
    cameraStreamUrl?: string | null; cameraSnapshotUrl?: string | null;
    manualSlots?: number;
    manualFilaments?: Array<{ color: string; type: string; brand?: string; remain?: number }>;
  }>>;
}

export async function listPrinterModels() {
  try {
    return await apiFetch('/printers/models') as Promise<string[]>;
  } catch { return []; }
}

export async function updatePrinter(id: string, patch: {
  name?: string;
  ip?: string;
  port?: number;
  accessCode?: string | null;
  apiKey?: string | null;
  cameraStreamUrl?: string | null;
  cameraSnapshotUrl?: string | null;
  model?: string | null;
  manualSlots?: number;
  manualFilaments?: Array<{ color: string; type: string; brand?: string; remain?: number }>;
  connectionMode?: 'direct' | 'bambuddy' | null;
  bambuddyUrl?: string | null;
  bambuddyPrinterId?: number | null;
  bambuddyApiKey?: string | null;
}) {
  // Snake-case keys for backend PATCH body
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.ip !== undefined) body.ip = patch.ip;
  if (patch.port !== undefined) body.port = patch.port;
  if (patch.accessCode !== undefined) body.access_code = patch.accessCode;
  if (patch.apiKey !== undefined) body.api_key = patch.apiKey;
  if (patch.cameraStreamUrl !== undefined) body.camera_stream_url = patch.cameraStreamUrl;
  if (patch.cameraSnapshotUrl !== undefined) body.camera_snapshot_url = patch.cameraSnapshotUrl;
  if (patch.model !== undefined) body.model = patch.model;
  if (patch.manualSlots !== undefined) body.manual_slots = patch.manualSlots;
  if (patch.manualFilaments !== undefined) body.manual_filaments = JSON.stringify(patch.manualFilaments);
  if (patch.connectionMode !== undefined) body.connection_mode = patch.connectionMode;
  if (patch.bambuddyUrl !== undefined) body.bambuddy_url = patch.bambuddyUrl;
  if (patch.bambuddyPrinterId !== undefined) body.bambuddy_printer_id = patch.bambuddyPrinterId;
  if (patch.bambuddyApiKey !== undefined) body.bambuddy_api_key = patch.bambuddyApiKey;
  return apiFetch(`/printers/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function createPrinter(p: {
  name: string; protocol: 'moonraker' | 'bambu'; ip: string; port?: number;
  serial?: string; accessCode?: string; apiKey?: string;
  cameraStreamUrl?: string; cameraSnapshotUrl?: string;
  model?: string;
  manualSlots?: number;
  connectionMode?: 'direct' | 'bambuddy';
  bambuddyUrl?: string;
  bambuddyPrinterId?: number;
  bambuddyApiKey?: string;
}) {
  return apiFetch('/printers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
}

export async function deletePrinter(id: string) {
  return apiFetch(`/printers/${id}`, { method: 'DELETE' });
}

export async function reconnectPrinter(id: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch(`/printers/${id}/reconnect`, { method: 'POST' });
}

export async function disconnectPrinter(id: string) {
  return apiFetch(`/printers/${id}/disconnect`, { method: 'POST' });
}

export interface PrintQueueItem {
  id: string;
  printerId: string;
  jobId: string;
  addedAt: string;
  modelName: string | null;
  jobStatus: string | null;
  printerName: string | null;
}

export async function listPrintQueue(printerId: string): Promise<PrintQueueItem[]> {
  return apiFetch(`/printers/${printerId}/queue`) as Promise<PrintQueueItem[]>;
}

export async function addToPrintQueue(printerId: string, jobId: string): Promise<{ id: string; duplicate?: boolean }> {
  return apiFetch(`/printers/${printerId}/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  }) as Promise<{ id: string; duplicate?: boolean }>;
}

export async function removeFromPrintQueue(printerId: string, itemId: string): Promise<void> {
  await apiFetch(`/printers/${printerId}/queue/${itemId}`, { method: 'DELETE' });
}

export async function sendPrinterCommand(printerId: string, command: string, args?: Record<string, unknown>) {
  return apiFetch(`/printers/${printerId}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });
}

/**
 * Set a single AMS tray's filament metadata on the printer.
 * amsId is 0-indexed unit; trayId is 1-indexed slot within that unit.
 * Color must be 8-hex (RRGGBBAA) — caller is responsible for format.
 */
export async function setAmsFilament(
  printerId: string,
  amsId: number,
  trayId: number,
  data: { type?: string; color?: string; brand?: string },
) {
  return sendPrinterCommand(printerId, 'set_ams_filament', { amsId, trayId, ...data });
}

export async function sendToRegisteredPrinter(
  printerId: string,
  jobId: string,
  startPrint = true,
  filamentMapping?: number[],
  printOptions?: PrintOptions,
) {
  return apiFetch(`/printers/${printerId}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, startPrint, filamentMapping, printOptions }),
  }) as Promise<{ printerPath: string }>;
}

// --- External file upload (no slice job required) ---

export interface StagedFilament {
  index: number;
  color: string | null;
  type: string | null;
  weightG: number | null;
  used: boolean;
}

export interface StageFileResponse {
  stageId: string;
  filename: string;
  isGcode3mf: boolean;
  plates: number[];
  filaments: StagedFilament[];
}

/** Upload a .gcode / .gcode.3mf to backend staging + parse filaments. */
export async function stageFileToPrinter(printerId: string, file: File): Promise<StageFileResponse> {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch(`/printers/${printerId}/stage-file`, { method: 'POST', body: formData }) as Promise<StageFileResponse>;
}

/** Send a staged file to the printer (upload + optional start print). */
export async function sendStagedFileToPrinter(
  printerId: string,
  stageId: string,
  opts: { startPrint?: boolean; filamentMapping?: number[]; plate?: number; printOptions?: PrintOptions } = {},
): Promise<{ printerPath: string }> {
  return apiFetch(`/printers/${printerId}/send-file`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stageId,
      startPrint: opts.startPrint,
      filamentMapping: opts.filamentMapping,
      plate: opts.plate,
      printOptions: opts.printOptions,
    }),
  }) as Promise<{ printerPath: string }>;
}

export interface JobFilament {
  index: number;
  color: string | null;
  type: string | null;
  weightG: number | null;
  used: boolean;
}

export async function getJobFilaments(jobId: string): Promise<JobFilament[]> {
  // 404 = job has no parsed filament info yet (single-filament job, fresh
  // slice). Benign empty. Anything else (500, network) must surface — the
  // caller (Send to Printer) uses the count to decide whether to show the
  // filament-remap dialog, and silently returning [] skipped the dialog and
  // sent the wrong mapping.
  try {
    const data = await apiFetch(`/jobs/${jobId}/filaments`) as JobFilament[];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 404|not found/i.test(msg)) return [];
    throw err;
  }
}

export function cameraUrl(printerId: string): string {
  return `${API_BASE}/printers/${printerId}/camera`;
}

export async function importProfiles(engine: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch(`/settings/${engine}/import`, { method: 'POST', body: formData }) as Promise<{
    imported: { type: string; name: string }[];
    errors: { file: string; error: string }[];
  }>;
}

// --- Inventory: spools + print history ---

export interface Spool {
  id: string; name: string; color: string | null; material: string | null;
  totalWeightG: number; remainingWeightG: number; costPerKg: number;
  purchasedAt: string | null; notes: string | null; archived: boolean;
  createdAt: string;
}

export interface PrintHistoryEntry {
  id: string; jobId: string | null; printerId: string | null;
  modelName: string | null; completedAt: string;
  photoPath: string | null; photoUrl: string | null;
  rating: number | null; notes: string | null;
  createdAt: string;
}

export async function listSpools(archived = false) {
  return apiFetch(`/inventory/spools?archived=${archived}`) as Promise<Spool[]>;
}

export async function createSpool(data: Partial<Spool> & { name: string }) {
  return apiFetch('/inventory/spools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }) as Promise<Spool>;
}

export async function updateSpool(id: string, fields: Partial<Spool>) {
  return apiFetch(`/inventory/spools/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  }) as Promise<Spool>;
}

export async function deleteSpool(id: string) {
  return apiFetch(`/inventory/spools/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>;
}

export async function listPrintHistory(limit = 100) {
  return apiFetch(`/inventory/print-history?limit=${limit}`) as Promise<PrintHistoryEntry[]>;
}

export async function createPrintHistory(data: Partial<PrintHistoryEntry>) {
  return apiFetch('/inventory/print-history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }) as Promise<PrintHistoryEntry>;
}

export async function updatePrintHistory(id: string, fields: Partial<PrintHistoryEntry>) {
  return apiFetch(`/inventory/print-history/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  }) as Promise<PrintHistoryEntry>;
}

export async function uploadPrintHistoryPhoto(id: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch(`/inventory/print-history/${id}/photo`, { method: 'POST', body: formData }) as Promise<PrintHistoryEntry>;
}

export async function deletePrintHistory(id: string) {
  return apiFetch(`/inventory/print-history/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>;
}

// --- MakerWorld import ---

export interface MakerWorldInstance {
  profileId: string;
  name: string;
  coverUrl: string;
  thumbUrl: string;
}

export interface ResolvedMakerworld {
  numericId: string;
  alphanumericId: string;
  title: string;
  creator: string;
  coverUrl: string;
  summary: string;
  instances: MakerWorldInstance[];
  profileId?: string;
}

export async function resolveMakerworld(url: string): Promise<ResolvedMakerworld> {
  return apiFetch('/makerworld/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

export async function importMakerworld(args: {
  numericId: string; alphanumericId: string; profileId: string; name?: string;
}): Promise<{ modelId: string; name: string; plateCount: number; deduped: boolean }> {
  return apiFetch('/makerworld/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export function makerworldThumbnailUrl(url: string): string {
  return `${API_BASE}/makerworld/thumbnail?url=${encodeURIComponent(url)}`;
}

export async function getCloudTokenHint(): Promise<string | null> {
  try {
    // Secret keys return only { hint } — value is intentionally withheld.
    const data = await apiFetch('/settings/key/bambu_cloud_token') as { hint?: string | null; value?: string | null };
    return data.hint ?? data.value ?? null;
  } catch { return null; }
}

export async function setCloudToken(token: string): Promise<void> {
  await apiFetch('/settings/key/bambu_cloud_token', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: token }),
  });
}

export interface BambuLoginResult {
  success: boolean;
  token?: string;
  needsTfa?: boolean;
  tfaKey?: string;
  needsEmailCode?: boolean;
  message?: string;
}

export async function bambuLogin(email: string, password?: string, code?: string): Promise<BambuLoginResult> {
  const data = await apiFetch('/makerworld/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, code }),
  });
  return data as BambuLoginResult;
}

// --- System info ---

export interface SystemInfo {
  version?: string;
  git?: { sha: string | null; branch: string | null; dirty: boolean | null };
  installMode?: 'docker' | 'bare-metal' | 'unknown';
  storage: {
    dataDir: string;
    dbSize: number | null;
    modelsSize: number;
    jobsSize: number;
    diskFree: number | null;
    diskTotal: number | null;
  };
  counts: { models: number; jobs: number; printers: number };
  queue: { state: 'connected' | 'fallback'; redisHost: string; redisPort: number };
  slicer: {
    sidecars: Record<string, {
      url: string | null;
      local: boolean;
      binaryExists?: boolean;
      overridePath?: string | null;
      defaultPath?: string;
    }>;
    local: boolean;
  };
  host: {
    hostname: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    uptime: number;
  };
}

export type SidecarStatus = 'ok' | 'down' | 'unset';

export interface SidecarTestResult {
  redis: 'ok' | 'down';
  sidecars: Record<string, { url: string | null; status: SidecarStatus }>;
}

export async function getSystemInfo(): Promise<SystemInfo> {
  return apiFetch('/system/info') as Promise<SystemInfo>;
}

export async function testSidecar(): Promise<SidecarTestResult> {
  return apiFetch('/system/test-sidecar');
}

export async function getAvailableEngines(): Promise<string[]> {
  try {
    const data = await apiFetch('/system/engines') as { engines: string[] };
    return Array.isArray(data.engines) ? data.engines : [];
  } catch { return []; }
}

/**
 * Per-engine binary path overrides (DB-backed via app_settings). Shape:
 * `{ orcaslicer: "/path", bambustudio: "/path" }`. Missing/invalid returns `{}`.
 */
export async function getSlicerPathOverrides(): Promise<Record<string, string>> {
  try {
    const data = await apiFetch('/settings/key/slicer_path_overrides') as { value: string | null; hint: string | null };
    if (!data.value) return {};
    const parsed = JSON.parse(data.value);
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      return out;
    }
  } catch { /* malformed or missing */ }
  return {};
}

/** Persist the full overrides map (replaces existing). Removes key when undefined. */
export async function setSlicerPathOverrides(overrides: Record<string, string>): Promise<void> {
  await apiFetch('/settings/key/slicer_path_overrides', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(overrides) }),
  });
}

export interface SlicerPathTestResult {
  exists: boolean;
  executable: boolean;
  error?: string;
}

/** Validate a user-entered binary path before saving. No DB writes. */
export async function testSlicerPath(engine: string, binaryPath: string): Promise<SlicerPathTestResult> {
  return apiFetch('/system/test-slicer-path', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, path: binaryPath }),
  }) as Promise<SlicerPathTestResult>;
}

export type CleanupMode = 'completed_jobs' | 'all_jobs' | 'orphaned_models' | 'all';

export interface CleanupResult {
  mode: CleanupMode;
  olderThanDays: number;
  dryRun: boolean;
  jobCount: number;
  modelCount: number;
  bytesReclaimable: number;
  jobIds: string[];
  modelIds: string[];
}

/**
 * Bulk-purge old jobs + orphaned models. Caller MUST call with dryRun=true
 * first to preview; same call with dryRun=false performs the delete (DB rows
 * + on-disk dirs). Server refuses to delete running/queued jobs (HTTP 409).
 */
export async function cleanupStorage(body: {
  mode: CleanupMode;
  olderThanDays: number;
  dryRun: boolean;
}): Promise<CleanupResult> {
  return apiFetch('/system/cleanup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Promise<CleanupResult>;
}

export interface LocalProfileImportResult {
  scanned: number;
  imported: Record<string, number>;
  skippedCount: number;
  errorCount: number;
  errors: { file: string; error: string }[];
}

export async function importLocalProfiles(engine: string): Promise<LocalProfileImportResult> {
  return apiFetch(`/settings/${encodeURIComponent(engine)}/import-local`, { method: 'POST' }) as Promise<LocalProfileImportResult>;
}

export interface CheckUpdateResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
}

export async function checkUpdate(): Promise<CheckUpdateResult> {
  const data = await apiFetch('/system/check-update') as CheckUpdateResult;
  return data;
}

export interface UpdateStep {
  name: string;
  code: number;
  stderrTail?: string;
}

export interface UpdateResult {
  previousVersion: string;
  newVersion: string;
  steps: UpdateStep[];
  requiresRestart: boolean;
}

export async function performUpdate(): Promise<UpdateResult> {
  const data = await apiFetch('/system/update', { method: 'POST' }) as UpdateResult;
  return data;
}

export async function restartBackend(): Promise<{ ok: boolean; message?: string }> {
  return apiFetch('/system/restart', { method: 'POST' });
}
