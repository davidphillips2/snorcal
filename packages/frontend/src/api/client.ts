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
    id: string; name: string; faceCount: number; bounds: { x: number; y: number; z: number };
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

export async function saveFaceColors(modelId: string, faceColors: Uint8Array) {
  const base64 = btoa(String.fromCharCode(...faceColors));
  return apiFetch(`/models/${modelId}/colors`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ faceColors: base64 }),
  });
}

export async function deleteModel(id: string) {
  return apiFetch(`/models/${id}`, { method: 'DELETE' });
}

export async function getModelColors(id: string): Promise<Uint8Array | null> {
  try {
    const data = await apiFetch(`/models/${id}/colors`) as { faceColors: string | null };
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
  modelId: string; engine: string; plateIndex?: number; settings: Record<string, unknown>;
  profiles?: { machine?: string; filament?: string; process?: string };
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

export function getModelUrl(modelId: string) {
  return `${API_BASE}/files/model/${modelId}`;
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

export async function importProfiles(engine: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch(`/settings/${engine}/import`, { method: 'POST', body: formData }) as Promise<{
    imported: { type: string; name: string }[];
    errors: { file: string; error: string }[];
  }>;
}
