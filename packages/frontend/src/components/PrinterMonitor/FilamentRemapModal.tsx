import { useState, useEffect, useMemo } from 'react';
import * as api from '../../api/client';
import type { JobFilament } from '../../api/client';
import type { AmsSlot, PrinterStatus } from '@snorcal/shared';

interface Props {
  jobId: string;
  printerId: string;
  printerProtocol: 'moonraker' | 'bambu';
  printerManualSlots: number;
  printerStatus: PrinterStatus | undefined;
  onClose: () => void;
  onSent: (printerPath: string) => void;
}

interface Slot {
  /** Value to send in filamentMapping array */
  value: number;
  /** Display label */
  label: string;
  /** Hex color for swatch, if known */
  color: string | null;
  /** Filament type if known */
  type: string | null;
  /** Source — live AMS or manual config */
  source: 'ams' | 'manual';
}

function hexNormalize(c: string | null | undefined): string | null {
  if (!c) return null;
  let s = c.trim().toUpperCase().replace(/^#/, '');
  // Bambu AMS color sometimes 8-digit RGBA. Strip alpha for compare.
  if (s.length === 8) s = s.slice(0, 6);
  if (s.length === 6) return '#' + s;
  return s;
}

export function FilamentRemapModal({
  jobId, printerId, printerProtocol, printerManualSlots, printerStatus, onClose, onSent,
}: Props) {
  const [filaments, setFilaments] = useState<JobFilament[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<number[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getJobFilaments(jobId)
      .then(f => {
        if (cancelled) return;
        // Only show filaments actually used in gcode (have a Tx tool change)
        // OR if all are flagged used=false (single-filament gcode parser missed T codes), show all
        const used = f.filter(x => x.used);
        const shown = used.length > 0 ? used : f;
        setFilaments(shown);

        // Initial pre-pick by color match against slot list
        const slots = buildSlots(printerProtocol, printerManualSlots, printerStatus?.ams);
        const initial = shown.map(gcodeFil => {
          const gcodeColor = hexNormalize(gcodeFil.color);
          if (!gcodeColor) return 0;
          const match = slots.find(s => hexNormalize(s.color) === gcodeColor);
          return match?.value ?? 0;
        });
        setMapping(initial);
      })
      .catch(e => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [jobId, printerProtocol, printerManualSlots, printerStatus]);

  const slots = useMemo(
    () => buildSlots(printerProtocol, printerManualSlots, printerStatus?.ams),
    [printerProtocol, printerManualSlots, printerStatus],
  );

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      const result = await api.sendToRegisteredPrinter(printerId, jobId, true, mapping);
      onSent(result.printerPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-white">Map filaments to slots</h2>
            <p className="text-[11px] text-gray-500">
              {printerProtocol === 'bambu'
                ? 'Live AMS trays from printer'
                : `${printerManualSlots || 'no'} manual slot${printerManualSlots === 1 ? '' : 's'} configured`}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto space-y-3">
          {error && <div className="bg-red-900/40 border border-red-700 rounded px-3 py-2 text-sm text-red-200">{error}</div>}

          {loading && <div className="text-sm text-gray-400">Parsing gcode filaments…</div>}

          {!loading && filaments.length === 0 && (
            <div className="text-sm text-gray-400">No filaments detected in gcode. Send directly?</div>
          )}

          {!loading && filaments.length > 0 && slots.length === 0 && (
            <div className="bg-yellow-900/30 border border-yellow-700 rounded px-3 py-2 text-sm text-yellow-200">
              No slots available. {printerProtocol === 'bambu'
                ? 'AMS reports empty — load filament into trays.'
                : 'Set Manual Slots on this printer first.'}
            </div>
          )}

          {filaments.map((gcf, i) => (
            <div key={gcf.index} className="flex items-center gap-3 bg-gray-800/50 rounded p-2">
              <div className="flex items-center gap-2 w-32 shrink-0">
                <span className="w-5 h-5 rounded border border-gray-500" style={{ backgroundColor: gcf.color ?? '#888' }} />
                <div className="min-w-0">
                  <div className="text-xs text-gray-200 truncate">Filament {gcf.index + 1}</div>
                  <div className="text-[10px] text-gray-500 truncate">{gcf.type ?? 'unknown'}</div>
                </div>
              </div>
              <span className="text-gray-500 text-sm">→</span>
              <select
                value={mapping[i] ?? 0}
                onChange={e => setMapping(prev => prev.map((v, idx) => idx === i ? Number(e.target.value) : v))}
                className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white"
              >
                <option value={0}>— skip —</option>
                {slots.map(s => (
                  <option key={`${s.source}-${s.value}`} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          ))}

          {slots.length > 0 && (
            <div className="pt-2 border-t border-gray-800">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Available slots</div>
              <div className="flex flex-wrap gap-2">
                {slots.map(s => (
                  <div key={`${s.source}-${s.value}`} className="flex items-center gap-1 bg-gray-800 rounded px-2 py-1 text-[10px] text-gray-300">
                    <span className="w-3 h-3 rounded border border-gray-600" style={{ backgroundColor: s.color ?? '#555' }} />
                    {s.label}
                    {s.type && <span className="text-gray-500">·{s.type}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-800 flex gap-2">
          <button onClick={onClose} className="flex-1 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-200">Cancel</button>
          <button onClick={submit} disabled={sending || filaments.length === 0}
            className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/30 rounded text-sm text-white">
            {sending ? 'Sending…' : 'Send to printer'}
          </button>
        </div>
      </div>
    </div>
  );
}

function buildSlots(
  protocol: 'moonraker' | 'bambu',
  manualSlots: number,
  ams: AmsSlot[] | undefined,
): Slot[] {
  if (protocol === 'bambu' && ams && ams.length > 0) {
    return ams.map(s => ({
      value: s.trayId,
      label: `Tray ${s.trayId}`,
      color: s.color ? '#' + s.color.replace(/^#/, '').slice(0, 6) : null,
      type: s.type ?? null,
      source: 'ams' as const,
    }));
  }
  if (manualSlots > 0) {
    return Array.from({ length: manualSlots }, (_, i) => ({
      value: i,
      label: `Slot ${i + 1}`,
      color: null,
      type: null,
      source: 'manual' as const,
    }));
  }
  return [];
}
