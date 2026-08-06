/**
 * Bind outbound printer/camera sockets to a specific LAN source IP.
 *
 * Why: macOS + Tailscale combination has a known issue where long-running
 * node processes that listen on 0.0.0.0 (which snorcal does, to also serve
 * the Tailscale interface) cache routing state tied to the Tailscale utun
 * interface present at startup. When Tailscale daemon flaps (laptop sleep,
 * network change, daemon restart — utun10 → utun2 etc.), the cached state
 * points at a dead interface and new outbound sockets to LAN printers fail
 * with EHOSTUNREACH even though the system itself can route fine (curl from
 * a fresh shell works).
 *
 * Fix: when SNORCAL_LAN_SOURCE_IP is set, all WS calls to LAN printers
 * bind the source IP explicitly via the `ws` library's `localAddress`
 * option, bypassing the utun route lookup.
 *
 * Fetch path: the npm `undici` package's Agent is ABI-incompatible with
 * Node's bundled undici on Node 25 (passes npm-undici's Agent to Node's
 * fetch → "InvalidArgumentError: invalid onRequestStart method"). So
 * fetches cannot bind localAddress via a dispatcher — they rely on the
 * fresh-process state (snorcal just started) + the routing fix that
 * the WS path also benefits from. The Tailscale-flap caching issue
 * only bites long-running processes; a freshly-started snorcal routes
 * correctly without explicit source binding.
 *
 * Default unset (current behavior). Set to your en0/en1 LAN IP, e.g.
 * `SNORCAL_LAN_SOURCE_IP=192.168.4.26`.
 */
export const LAN_SOURCE_IP: string | undefined = process.env.SNORCAL_LAN_SOURCE_IP || undefined;

import http from 'node:http';
import https from 'node:https';

/**
 * Fetch wrapper that binds the source IP to SNORCAL_LAN_SOURCE_IP.
 *
 * Why: global `fetch` (undici) on Node 25 cannot bind localAddress via a
 * dispatcher (npm undici Agent is ABI-incompatible with Node's bundled
 * undici → "InvalidArgumentError: invalid onRequestStart method"). So
 * bambuddy's HTTP calls (token mint, camera, upload, webhook) route
 * through the OS default, which on long-running macOS+Tailscale processes
 * caches a dead utun route after a Tailscale daemon flap → EHOSTUNREACH.
 *
 * This helper uses Node's native http/https module, which honors
 * `localAddress` on the agent. Falls back to global `fetch` when
 * LAN_SOURCE_IP is unset (no binding needed).
 *
 * API mirrors fetch(): returns { ok, status, statusText, text(), json(),
 * arrayBuffer(), headers } for the subset bambuddy-adapter uses.
 */
export async function lanFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (!LAN_SOURCE_IP) return fetch(url, init);

  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const method = init?.method ?? 'GET';

  // Coerce HeadersInit → Record<string,string>.
  let headers: Record<string, string> = {};
  const h_in = init?.headers;
  if (h_in) {
    if (h_in instanceof Headers) {
      headers = Object.fromEntries(h_in.entries());
    } else if (Array.isArray(h_in)) {
      for (const [k, v] of h_in) headers[k] = v;
    } else {
      headers = { ...(h_in as Record<string, string>) };
    }
  }
  const body = init?.body;

  // Convert body to Buffer/string for native http. FormData falls back to
  // global fetch (LAN source binding irrelevant for the rare upload path).
  if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)
      && !(body instanceof ArrayBuffer) && !(body instanceof Blob)
      && typeof (body as { text?: unknown }).text !== 'function') {
    // FormData or unknown body type — delegate to global fetch.
    return fetch(url, init);
  }
  let bodyPayload: Buffer | string | undefined;
  if (body != null) {
    if (typeof body === 'string') bodyPayload = body;
    else if (body instanceof Uint8Array) bodyPayload = Buffer.from(body);
    else if (body instanceof ArrayBuffer) bodyPayload = Buffer.from(body);
    else if (body instanceof Blob) bodyPayload = Buffer.from(await body.arrayBuffer());
    else bodyPayload = String(body);
  }

  return new Promise<Response>((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      localAddress: LAN_SOURCE_IP,
      timeout: 30000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(new Response(buf, {
          status: res.statusCode ?? 200,
          statusText: res.statusMessage ?? '',
          headers: res.headers as Record<string, string>,
        }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('lanFetch timeout')); });
    if (bodyPayload !== undefined) req.write(bodyPayload);
    req.end();
  });
}

