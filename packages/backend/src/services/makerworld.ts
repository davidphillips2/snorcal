/**
 * MakerWorld API service.
 *
 * Thin async client for MakerWorld's `/v1/design-service/*` endpoints on
 * api.bambulab.com (not Cloudflare-protected like makerworld.com itself).
 *
 * Metadata endpoints (design / instances) are anonymous. Downloading a 3MF
 * requires a signed CDN URL minted via the user's Bambu Lab bearer token —
 * reusing the same SSO backend MakerWorld itself uses (no separate OAuth).
 *
 * Port of bambuddy's `backend/app/services/makerworld.py`.
 */

// api.bambulab.com is the Bambu Cloud backend MakerWorld's web UI talks to.
// Direct fetch bypasses Cloudflare bot detection on makerworld.com.
const MAKERWORLD_API_BASE = 'https://api.bambulab.com/v1/design-service';
const MAKERWORLD_HOST = 'makerworld.com';
const MAKERWORLD_CDN_HOSTS = new Set(['makerworld.bblmw.com', 'public-cdn.bblmw.com']);
const ALLOWED_DOWNLOAD_SUFFIXES = ['.amazonaws.com'];

const MAX_3MF_BYTES = 200 * 1024 * 1024; // 200 MB hard cap
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;

const CLIENT_HEADERS: Record<string, string> = {
  'User-Agent': 'Snorcal/1.0',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://makerworld.com/',
};

const MODEL_ID_RE = /\/models\/(\d+)/;
const PROFILE_ID_RE = /#profileId[-=](\d+)/;

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const REFUSED_THUMBNAIL_MIMES = new Set(['text/html', 'text/plain', 'application/json']);

// --- Errors ---

export class MakerWorldError extends Error { constructor(m: string) { super(m); this.name = 'MakerWorldError'; } }
export class MakerWorldAuthError extends MakerWorldError { constructor(m: string) { super(m); this.name = 'MakerWorldAuthError'; } }
export class MakerWorldForbiddenError extends MakerWorldError { constructor(m: string) { super(m); this.name = 'MakerWorldForbiddenError'; } }
export class MakerWorldNotFoundError extends MakerWorldError { constructor(m: string) { super(m); this.name = 'MakerWorldNotFoundError'; } }
export class MakerWorldUrlError extends MakerWorldError { constructor(m: string) { super(m); this.name = 'MakerWorldUrlError'; } }

// --- Types ---

export interface ParsedMakerWorldUrl {
  numericModelId: string;
  profileId?: string;
}

export interface MakerWorldDesign {
  alphanumericId: string;
  title: string;
  creatorName: string;
  coverUrl: string;
  summary: string;
}

export interface MakerWorldInstance {
  profileId: string;
  name: string;
  coverUrl: string;
  thumbUrl: string;
}

export interface SignedDownload {
  url: string;
  name: string;
}

// --- URL parsing ---

export function parseUrl(url: string): ParsedMakerWorldUrl {
  if (!url || typeof url !== 'string') throw new MakerWorldUrlError('URL is empty');
  const candidate = url.trim();
  const withScheme = candidate.includes('://') ? candidate : `https://${candidate}`;

  let parsed: URL;
  try { parsed = new URL(withScheme); }
  catch (e) { throw new MakerWorldUrlError(`Could not parse URL: ${e}`); }

  const host = (parsed.hostname || '').toLowerCase();
  if (host !== MAKERWORLD_HOST && !host.endsWith(`.${MAKERWORLD_HOST}`)) {
    throw new MakerWorldUrlError(`Not a MakerWorld URL (host=${host}); expected makerworld.com`);
  }

  const modelMatch = MODEL_ID_RE.exec(parsed.pathname);
  if (!modelMatch) throw new MakerWorldUrlError('URL missing /models/{id} segment');
  const numericModelId = modelMatch[1]!;

  let profileId: string | undefined;
  if (parsed.hash) {
    const profileMatch = PROFILE_ID_RE.exec(`#${parsed.hash}`);
    if (profileMatch) profileId = profileMatch[1];
  }

  return { numericModelId, profileId };
}

// --- Internal helpers ---

function extractUpstreamError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as Record<string, unknown>;
  for (const key of ['error', 'message', 'detail']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

async function getJson(path: string, token?: string): Promise<Record<string, unknown>> {
  const url = `${MAKERWORLD_API_BASE}${path}`;
  const headers: Record<string, string> = { ...CLIENT_HEADERS };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: 'manual' });
  } catch (e) {
    throw new MakerWorldError(`MakerWorld request failed: ${e}`);
  }

  // Retry once on 418 (Cloudflare bot challenge often clears immediately)
  if (res.status === 418) {
    await new Promise(r => setTimeout(r, 1500));
    try { res = await fetch(url, { headers, redirect: 'manual' }); }
    catch (e) { throw new MakerWorldError(`MakerWorld request failed: ${e}`); }
  }

  if (res.status === 401) {
    const body = await safeJson(res);
    throw new MakerWorldAuthError(extractUpstreamError(body) ?? `MakerWorld rejected token for ${path}`);
  }
  if (res.status === 403) {
    const body = await safeJson(res);
    throw new MakerWorldForbiddenError(extractUpstreamError(body) ?? `MakerWorld refused access to ${path}`);
  }
  if (res.status === 404) throw new MakerWorldNotFoundError(`MakerWorld resource not found: ${path}`);
  if (res.status === 418) throw new MakerWorldError(`MakerWorld blocked request (HTTP 418) for ${path}`);
  if (res.status === 429) throw new MakerWorldError(`MakerWorld rate-limited (HTTP 429) for ${path}`);
  if (res.status >= 500) throw new MakerWorldError(`MakerWorld server error (${res.status}) for ${path}`);
  if (res.status !== 200) throw new MakerWorldError(`MakerWorld unexpected status ${res.status} for ${path}`);

  const data = await safeJson(res);
  if (typeof data !== 'object' || data === null) {
    throw new MakerWorldError(`MakerWorld returned unexpected JSON shape for ${path}`);
  }
  return data as Record<string, unknown>;
}

async function safeJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

// --- Public API ---

export async function getDesign(numericId: string): Promise<MakerWorldDesign> {
  const data = await getJson(`/design/${numericId}`);

  // design object fields — bambuddy notes MakerWorld uses varying shapes; be defensive
  const title = str(data.title) || str(data.name) || `Model ${numericId}`;
  const summary = str(data.summary) || str(data.description) || '';
  const coverUrl = str(data.coverUrl) || str(data.cover_url) || str(data.cover) || '';

  let creatorName = '';
  const creator = (data.creator ?? data.author) as Record<string, unknown> | undefined;
  if (creator && typeof creator === 'object') {
    creatorName = str(creator.name) || str(creator.nick_name) || str(creator.nickname) || '';
  }

  // alphanumericId is the internal model_id used for download URL minting
  const alphanumericId = str(data.modelId) || str(data.model_id) || str(data.alphanumericId) || str(data.designId) || '';

  return { alphanumericId, title, creatorName, coverUrl, summary };
}

export async function listInstances(numericId: string): Promise<MakerWorldInstance[]> {
  const data = await getJson(`/design/${numericId}/instances`);
  const hits = (data.hits ?? data.instances ?? data.list) as unknown[] | undefined;
  if (!Array.isArray(hits)) return [];

  return hits.map((h) => {
    const o = (h ?? {}) as Record<string, unknown>;
    return {
      profileId: String(o.profileId ?? o.profile_id ?? o.id ?? ''),
      name: str(o.name) || str(o.title) || 'Untitled plate',
      coverUrl: str(o.coverUrl) || str(o.cover) || str(o.cover_url) || '',
      thumbUrl: str(o.thumbUrl) || str(o.thumb) || str(o.coverUrl) || str(o.cover) || '',
    };
  }).filter(i => i.profileId);
}

export async function getSignedDownloadUrl(
  profileId: string,
  alphanumericId: string,
  token: string,
): Promise<SignedDownload> {
  if (!token) throw new MakerWorldAuthError('Bambu cloud token required');

  const url = `https://api.bambulab.com/v1/iot-service/api/user/profile/${profileId}?model_id=${encodeURIComponent(alphanumericId)}`;
  const headers: Record<string, string> = { ...CLIENT_HEADERS, Authorization: `Bearer ${token}` };

  let res: Response;
  try { res = await fetch(url, { headers, redirect: 'manual' }); }
  catch (e) { throw new MakerWorldError(`Bambu Lab request failed: ${e}`); }

  if (res.status === 401) {
    const body = await safeJson(res);
    throw new MakerWorldAuthError(extractUpstreamError(body) ?? 'Bambu Lab rejected token');
  }
  if (res.status === 403) {
    const body = await safeJson(res);
    throw new MakerWorldForbiddenError(extractUpstreamError(body) ?? `Bambu Lab refused access to profile ${profileId}`);
  }
  if (res.status === 404) throw new MakerWorldNotFoundError(`Profile not found: ${profileId}`);
  if (res.status !== 200) throw new MakerWorldError(`Bambu Lab unexpected status ${res.status}`);

  const data = await safeJson(res);
  if (typeof data !== 'object' || data === null) {
    throw new MakerWorldError('Bambu Lab returned non-JSON for profile download');
  }
  const obj = data as Record<string, unknown>;
  const signedUrl = str(obj.url) ?? str(obj.download_url) ?? str(obj.signed_url);
  if (!signedUrl) throw new MakerWorldError('Bambu Lab response missing signed URL');

  const name = str(obj.name) ?? str(obj.file_name) ?? 'model.3mf';
  return { url: signedUrl, name };
}

export async function download3mf(signedUrl: string): Promise<Buffer> {
  let parsed: URL;
  try { parsed = new URL(signedUrl); }
  catch (e) { throw new MakerWorldUrlError(`Invalid download URL: ${e}`); }

  const host = (parsed.hostname || '').toLowerCase();
  const isAllowed = MAKERWORLD_CDN_HOSTS.has(host) || ALLOWED_DOWNLOAD_SUFFIXES.some(s => host.endsWith(s));
  if (!isAllowed) throw new MakerWorldUrlError(`Refusing to download from non-MakerWorld host: ${host}`);

  const pathTail = (parsed.pathname.split('/').pop() || 'model.3mf').split('?')[0]!;

  let res: Response;
  try {
    res = await fetch(signedUrl, {
      headers: { 'User-Agent': CLIENT_HEADERS['User-Agent']! },
      redirect: 'manual',
    });
  } catch (e) { throw new MakerWorldError(`3MF download failed: ${e}`); }

  if (res.status !== 200) throw new MakerWorldError(`3MF download returned HTTP ${res.status}`);

  // Stream into buffer with size cap
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new MakerWorldError('3MF download: no response body');

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_3MF_BYTES) {
        throw new MakerWorldError(`3MF exceeds ${MAX_3MF_BYTES / (1024 * 1024)} MB cap`);
      }
      chunks.push(Buffer.from(value));
    }
  }

  return Buffer.concat(chunks);
  // pathTail unused — filename comes from parent caller
  void pathTail;
}

export async function fetchThumbnail(url: string): Promise<{ data: Buffer; contentType: string }> {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch (e) { throw new MakerWorldUrlError(`Invalid thumbnail URL: ${e}`); }

  const host = (parsed.hostname || '').toLowerCase();
  if (!MAKERWORLD_CDN_HOSTS.has(host)) {
    throw new MakerWorldUrlError(`Refusing thumbnail fetch from non-MakerWorld host: ${host}`);
  }

  let res: Response;
  try { res = await fetch(url, { headers: CLIENT_HEADERS, redirect: 'manual' }); }
  catch (e) { throw new MakerWorldError(`Thumbnail fetch failed: ${e}`); }

  if (res.status !== 200) throw new MakerWorldError(`Thumbnail fetch returned HTTP ${res.status}`);

  const upstreamType = (res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
  if (REFUSED_THUMBNAIL_MIMES.has(upstreamType)) {
    throw new MakerWorldError(`Thumbnail upstream returned non-image content-type: ${upstreamType}`);
  }

  const pathLower = parsed.pathname.toLowerCase();
  let extMime: string | null = null;
  for (const [ext, mime] of Object.entries(IMAGE_EXT_TO_MIME)) {
    if (pathLower.endsWith(ext)) { extMime = mime; break; }
  }

  let contentType: string;
  if (upstreamType.startsWith('image/')) contentType = upstreamType;
  else if (extMime) contentType = extMime;
  else throw new MakerWorldError(`Thumbnail upstream returned ${upstreamType} with no image extension`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_THUMBNAIL_BYTES) {
    throw new MakerWorldError(`Thumbnail exceeds ${MAX_THUMBNAIL_BYTES / (1024 * 1024)} MB cap`);
  }

  return { data: buf, contentType };
}

// --- Bambu Lab login (email + password → access token) ---

export interface BambuLoginResult {
  success: boolean;
  token?: string;
  needsTfa?: boolean;
  tfaKey?: string;
  needsEmailCode?: boolean;
  message?: string;
}

export async function bambuLogin(args: { email: string; password?: string; code?: string }): Promise<BambuLoginResult> {
  const url = 'https://api.bambulab.com/v1/user-service/user/login';
  const body: Record<string, unknown> = { account: args.email };
  if (args.code) body['code'] = args.code;
  else if (args.password) body['password'] = args.password;
  else throw new MakerWorldError('password or code required');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS },
      redirect: 'manual',
      body: JSON.stringify(body),
    });
  } catch (e) { throw new MakerWorldError(`Bambu login request failed: ${e}`); }

  let data: unknown = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  const obj = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const accessToken = str(obj.accessToken);
  const loginType = str(obj.loginType);
  const tfaKey = str(obj.tfaKey);
  const message = str(obj.message) || str(obj.error);

  if (res.status === 200 && accessToken) {
    return { success: true, token: accessToken };
  }

  // 2FA TOTP required
  if (loginType === 'tfa' || (tfaKey && loginType !== 'verifyCode')) {
    return { success: false, needsTfa: true, tfaKey: tfaKey || undefined, message: 'Enter TOTP code from authenticator app' };
  }
  // Email verification code required
  if (loginType === 'verifyCode') {
    return { success: false, needsEmailCode: true, message: 'Verification code sent to email' };
  }

  return { success: false, message: message || `Login failed (HTTP ${res.status})` };
}

// --- Helpers ---

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

/**
 * Extract `Metadata/project_settings.config` JSON from a 3MF bundle.
 * Returns null if not present or unparseable. MakerWorld bundles ship
 * full slicer settings (printer_model, filament, process keys) — captured
 * at import time so the user can apply them later.
 */
export async function extractProjectSettings(buffer: Buffer): Promise<Record<string, unknown> | null> {
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    const file = zip.file('Metadata/project_settings.config');
    if (!file) return null;
    const text = await file.async('text');
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}
