const API_BASE = '/api';

// Retries transient backend downtime (dev-mode tsx restart, proxy 502/503/504,
// network "Failed to fetch"). Without this, any click during a backend restart
// surfaces a hard error in the UI and forces a manual frontend reload.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 300;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiFetch(path: string, options?: RequestInit) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, options);
      // Retry transient proxy/gateway errors (backend mid-restart)
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const t = await res.text(); if (t) msg = t; } catch {}
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

export async function uploadModel(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch('/models', { method: 'POST', body: formData }) as Promise<{
    id: string; name: string; faceCount: number; plateCount: number; bounds: { x: number; y: number; z: number };
  }>;
}

export async function listModels() {
  try {
    return await apiFetch('/models') as Promise<any[]>;
  } catch { return []; }
}

export async function getModel(id: string) {
  return apiFetch(`/models/${id}`);
}

export async function getModelSourceSettings(id: string): Promise<Record<string, unknown> | null> {
  try {
    return await apiFetch(`/models/${id}/source-settings`);
  } catch { return null; }
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
  try {
    const params = status ? `?status=${status}` : '';
    return await apiFetch(`/jobs${params}`) as Promise<any[]>;
  } catch { return []; }
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
  protocol?: 'moonraker' | 'bambu' | 'snapmaker',
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

export function getModelUrl(modelId: string, plate?: number) {
  const params = plate && plate > 1 ? `?plate=${plate}` : '';
  return `${API_BASE}/files/model/${modelId}${params}`;
}

export async function getDefaultSettings(engine: string) {
  try {
    return await apiFetch(`/settings/${engine}/defaults`);
  } catch { return null; }
}

export async function getProfiles(engine: string, type?: string) {
  try {
    const params = type ? `?type=${type}` : '';
    return await apiFetch(`/settings/${engine}/profiles${params}`) as Promise<{
      engine: string; profile_type: string; name: string; created_at: string;
    }[]>;
  } catch { return []; }
}

export async function getProfileSettings(engine: string, type: string, name: string) {
  return apiFetch(`/settings/${engine}/profiles/${type}/${encodeURIComponent(name)}`);
}

export async function deleteProfile(engine: string, type: string, name: string) {
  return apiFetch(`/settings/${engine}/profiles/${type}/${encodeURIComponent(name)}`, { method: 'DELETE' });
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
    id: string; name: string; protocol: 'moonraker' | 'bambu' | 'snapmaker';
    ip: string; port: number; serial?: string | null; accessCode?: string | null;
    apiKey?: string | null; lastStatus?: string | null; lastSeen?: string | null;
    createdAt: string; status?: any; model?: string | null;
    bedVolume?: { x: number; y: number; z: number } | null;
    cameraStreamUrl?: string | null; cameraSnapshotUrl?: string | null;
    manualSlots?: number;
  }>>;
}

export async function listPrinterModels() {
  try {
    return await apiFetch('/printers/models') as Promise<string[]>;
  } catch { return []; }
}

export async function updatePrinter(id: string, patch: { model?: string }) {
  return apiFetch(`/printers/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function createPrinter(p: {
  name: string; protocol: 'moonraker' | 'bambu' | 'snapmaker'; ip: string; port?: number;
  serial?: string; accessCode?: string; apiKey?: string;
  cameraStreamUrl?: string; cameraSnapshotUrl?: string;
  model?: string;
  manualSlots?: number;
}) {
  return apiFetch('/printers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
}

export async function deletePrinter(id: string) {
  return apiFetch(`/printers/${id}`, { method: 'DELETE' });
}

export async function reconnectPrinter(id: string) {
  return apiFetch(`/printers/${id}/reconnect`, { method: 'POST' });
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

export async function sendToRegisteredPrinter(printerId: string, jobId: string, startPrint = true, filamentMapping?: number[]) {
  return apiFetch(`/printers/${printerId}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, startPrint, filamentMapping }),
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
  try {
    const data = await apiFetch(`/jobs/${jobId}/filaments`) as JobFilament[];
    return Array.isArray(data) ? data : [];
  } catch { return []; }
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
    const data = await apiFetch('/settings/key/bambu_cloud_token') as { value: string | null; hint: string | null };
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
    sidecars: Record<string, { url: string | null; local: boolean }>;
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
