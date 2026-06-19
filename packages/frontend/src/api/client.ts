const API_BASE = '/api';

async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const t = await res.text(); if (t) msg = t; } catch {}
    throw new Error(msg);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Unknown error');
  return json.data;
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

export function getGcodeUrl(jobId: string) {
  return `${API_BASE}/files/gcode/${jobId}`;
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
    id: string; name: string; protocol: 'moonraker' | 'bambu';
    ip: string; port: number; serial?: string | null; accessCode?: string | null;
    apiKey?: string | null; lastStatus?: string | null; lastSeen?: string | null;
    createdAt: string; status?: any; model?: string | null;
    cameraStreamUrl?: string | null; cameraSnapshotUrl?: string | null;
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
  name: string; protocol: 'moonraker' | 'bambu'; ip: string; port?: number;
  serial?: string; accessCode?: string; apiKey?: string;
  cameraStreamUrl?: string; cameraSnapshotUrl?: string;
  model?: string;
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

export async function sendToRegisteredPrinter(printerId: string, jobId: string, startPrint = true) {
  return apiFetch(`/printers/${printerId}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, startPrint }),
  }) as Promise<{ printerPath: string }>;
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
