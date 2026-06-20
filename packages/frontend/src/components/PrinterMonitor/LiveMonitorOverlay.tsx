import { useState, useEffect } from 'react';
import type { PrinterStatus } from '@snorcal/shared';

interface LiveMonitorOverlayProps {
  /** All registered printers' live statuses (id → status). */
  statuses: Record<string, PrinterStatus>;
  /** Map id → printer name. */
  names: Record<string, string>;
  /** Map id → JPEG snapshot URL via backend proxy (e.g. `/api/printers/:id/camera`). */
  cameras: Record<string, string | null | undefined>;
  /** Optional: only show when a specific printer id is the target. */
  focusPrinterId?: string | null;
}

function isPrinting(s: PrinterStatus | undefined): boolean {
  if (!s) return false;
  return s.state === 'printing' || s.state === 'paused';
}

function formatEta(sec?: number): string {
  if (!sec || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Floating overlay shown in slice view when a registered printer is actively
 * printing. Shows progress, layer, temps, ETA, and a camera snapshot
 * (refresh-busted every 10s when URL present).
 */
export function LiveMonitorOverlay({ statuses, names, cameras, focusPrinterId }: LiveMonitorOverlayProps) {
  // Pick printing printer; prefer focus printer if it's printing.
  const candidates = Object.entries(statuses).filter(([id, s]) => isPrinting(s));
  const focusCandidate = focusPrinterId ? candidates.find(([id]) => id === focusPrinterId) : undefined;
  const [printerId, status] = focusCandidate ?? candidates[0] ?? [null, null];

  const cameraUrl = printerId ? cameras[printerId] : null;
  const [bust, setBust] = useState(0);
  useEffect(() => {
    if (!cameraUrl) return;
    const iv = setInterval(() => setBust(b => b + 1), 10_000);
    return () => clearInterval(iv);
  }, [cameraUrl]);

  if (!printerId || !status) return null;

  const progress = Math.round((status.progress ?? 0) * 100);
  const name = names[printerId] ?? 'Printer';

  return (
    <div className="absolute bottom-20 right-2 z-20 w-64 max-w-[80vw] bg-gray-900/90 backdrop-blur rounded-lg shadow-lg overflow-hidden border border-emerald-700/40">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${status.state === 'printing' ? 'bg-emerald-400 animate-pulse' : 'bg-yellow-400'}`} />
          <span className="text-xs font-semibold text-gray-100 truncate">{name}</span>
        </div>
        <span className="text-[10px] text-gray-400 uppercase">{status.state}</span>
      </div>

      {cameraUrl && (
        <div className="relative h-28 bg-black">
          <img src={`${cameraUrl}?bust=${bust}`} alt="Camera" className="w-full h-full object-cover" />
        </div>
      )}

      <div className="px-3 py-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-gray-800 rounded overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-[11px] text-gray-200 tabular-nums w-9 text-right">{progress}%</span>
        </div>

        <div className="flex justify-between text-[11px] text-gray-400">
          {status.layer !== undefined && status.totalLayers !== undefined && (
            <span>Layer <span className="text-gray-200">{status.layer}/{status.totalLayers}</span></span>
          )}
          <span>ETA <span className="text-gray-200">{formatEta(status.etaSec)}</span></span>
        </div>

        {status.temps && (
          <div className="flex justify-between text-[11px] text-gray-400">
            {status.temps.hotend !== undefined && (
              <span>Hotend <span className="text-gray-200">{Math.round(status.temps.hotend)}°C</span></span>
            )}
            {status.temps.bed !== undefined && (
              <span>Bed <span className="text-gray-200">{Math.round(status.temps.bed)}°C</span></span>
            )}
          </div>
        )}

        {status.file && (
          <div className="text-[10px] text-gray-500 truncate" title={status.file}>{status.file}</div>
        )}
      </div>
    </div>
  );
}
