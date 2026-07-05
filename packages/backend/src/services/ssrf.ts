import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {}

export interface AssertSafeUrlOptions {
  /**
   * When false (default), block loopback / link-local / private / reserved IPs.
   * Printer endpoints must pass allowPrivate:true because printers legitimately
   * live on LAN (192.168.x / 10.x / 100.64 Tailscale).
   */
  allowPrivate?: boolean;
}

// Hostnames used by cloud instance metadata services. Fetching these from the
// backend would leak credentials / allow instance takeover — always blocked.
const METADATA_HOSTS = new Set([
  '169.254.169.254',       // AWS / Azure / GCP / DigitalOcean
  'metadata.google.internal', // GCP (also resolves to 169.254.169.254)
  'metadata.azure.com',    // Azure
  'metadata',              // generic
]);

function isPrivateHost(hostname: string): boolean {
  // Strip brackets from IPv6 literal ([::1]) and lowercase.
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // IPv4 literal?
  const family = isIP(h);
  if (family === 4) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10) return true;                              // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                // 192.168.0.0/16
    if (a === 127) return true;                             // loopback
    if (a === 169 && b === 254) return true;                // link-local (incl. 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT 100.64.0.0/10 (Tailscale)
    if (a === 0) return true;                               // 0.0.0.0/8
    return false;
  }
  if (family === 6) {
    if (h === '::1' || h === '::') return true;             // loopback / unspecified
    if (h.startsWith('fe80')) return true;                  // link-local
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA
    return false;
  }
  // Hostname (not an IP literal) — can't reliably classify without DNS.
  // Metadata hostnames are blocked above; everything else is allowed.
  return false;
}

/**
 * Validate a URL before fetching it. Returns the parsed URL.
 * Throws UnsafeUrlError on any disallowed input.
 *
 * NOTE: residual risk = DNS rebinding (a hostname that resolves to a public IP
 * at check time but a private IP at fetch time). Fully mitigating requires
 * pinning the resolved IP on the socket, which is out of scope for this
 * defense-in-depth layer (all SSRF sites are already auth-gated).
 */
export function assertSafeUrl(raw: string, opts: AssertSafeUrlOptions = {}): URL {
  const allowPrivate = opts.allowPrivate ?? false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`invalid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`disallowed scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (METADATA_HOSTS.has(host)) {
    throw new UnsafeUrlError(`blocked metadata host: ${host}`);
  }
  if (!allowPrivate && isPrivateHost(host)) {
    throw new UnsafeUrlError(`private/loopback host blocked: ${host}`);
  }
  return parsed;
}

/**
 * fetch() wrapper that validates the URL and disables automatic redirect
 * following (so a 3xx can't retarget to an internal host after the check).
 * Mirrors the pattern already used in services/makerworld.ts.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  opts: AssertSafeUrlOptions = {},
): Promise<Response> {
  assertSafeUrl(raw, opts);
  return fetch(raw, { ...init, redirect: 'manual' });
}

/** True if `raw` parses as a safe http(s) URL (does not throw). */
export function isSafeUrl(raw: string, opts?: AssertSafeUrlOptions): boolean {
  try { assertSafeUrl(raw, opts); return true; } catch { return false; }
}
