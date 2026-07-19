/**
 * Format a stale-status hint from a printer's `updatedAt` ISO timestamp.
 * Returns null when fresh (<60s) — UI shows nothing in the healthy case.
 *
 * Use case: heartbeat/WS still "connected" but no status emitted in minutes
 * usually means TCP half-open that the watchdog hasn't caught yet, or the
 * printer is genuinely idle (Bambu P1S sends sparse ticks between prints).
 */
export function formatLastSeen(updatedAt?: string): string | null {
  if (!updatedAt) return null;
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return null;
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return null;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
