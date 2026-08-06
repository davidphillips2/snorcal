import { useEffect, useRef, useState } from 'react';
import type { AmsSlot, PrinterRecord, PrinterStatus } from '@snorcal/shared';
import * as api from '../../api/client';
import { Modal } from '../Modal';
import { AmsEditor } from './AmsEditor';
import { useSSEEvent } from '../../hooks/useSSE';
import { connectionColor } from '../../lib/status-colors';

interface Props {
  onClose: () => void;
}

interface SlotInfo {
  color?: string;     // hex without '#', may include alpha
  type?: string;
  brand?: string;
  remain?: number;
  source: 'ams' | 'manual';
  label: string;      // tray/slot label e.g. "T1" or "Slot 2"
}

/**
 * At-a-glance view of every printer's loaded filament. Live AMS (Bambu) and
 * manual filaments (Klipper/etc.) side by side, so you can see what's where
 * without clicking into each printer.
 *
 * Reaches into the shared SSE stream for live updates; falls back to the
 * printer record's last-known status on initial load.
 */
export function FilamentsPanel({ onClose }: Props) {
  const [printers, setPrinters] = useState<PrinterRecord[]>([]);
  const [statuses, setStatuses] = useState<Record<string, PrinterStatus>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ printerId: string; slot: AmsSlot } | null>(null);

  const refresh = async () => {
    try {
      const list = await api.listPrinters();
      setPrinters(list);
      const next: Record<string, PrinterStatus> = {};
      for (const p of list) if (p.status) next[p.id] = p.status;
      setStatuses(next);
    } catch { /* swallowed by caller toast */ }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  // Live status updates via the shared SSE connection.
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useSSEEvent('printer:status', (data) => {
    if (data.printerId) setStatuses(prev => ({ ...prev, [data.printerId as string]: data as unknown as PrinterStatus }));
  });
  useSSEEvent('printer:connected', () => refreshRef.current());
  useSSEEvent('printer:disconnected', () => refreshRef.current());

  const slotsFor = (p: PrinterRecord): SlotInfo[] => {
    const status = statuses[p.id];
    const ams = status?.ams && status.ams.length > 0 ? status.ams : null;
    if (ams) {
      return ams.map(s => ({
        color: s.color, type: s.type, brand: s.brand, remain: s.remain,
        source: 'ams',
        label: `T${Number(s.trayId) + 1}`,
      }));
    }
    const manual = p.manualFilaments && p.manualFilaments.length > 0 ? p.manualFilaments : null;
    if (manual) {
      return manual.map((m, i) => ({
        color: m.color, type: m.type, brand: m.brand, remain: m.remain,
        source: 'manual',
        label: `Slot ${i + 1}`,
      }));
    }
    return [];
  };

  return (
    <Modal
      title="Loaded Filaments"
      onClose={onClose}
      widthClass="max-w-4xl"
      panelClass="bg-gray-900 rounded-xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden p-0"
    >
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading ? (
          <div className="text-center text-gray-400 py-8">Loading…</div>
        ) : printers.length === 0 ? (
          <div className="text-center text-gray-400 py-8">No printers registered.</div>
        ) : (
          printers.map(p => {
            const status = statuses[p.id];
            const connection = status?.connection ?? 'disconnected';
            const slots = slotsFor(p);
            const online = connection === 'connected';
            return (
              <div key={p.id} className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-2 h-2 rounded-full ${connectionColor(connection)}`} role="img" aria-label={`${p.name} ${connection}`} />
                  <h3 className="text-sm font-medium text-white">{p.name}</h3>
                  <span className="text-[10px] text-gray-500 uppercase tracking-wide">{p.protocol}</span>
                  {slots.length > 0 && slots[0].source === 'ams' && (
                    <span className="text-[10px] text-gray-500">· AMS</span>
                  )}
                </div>
                {!online && (
                  <div className="text-xs text-gray-500">Printer offline — showing last known filaments.</div>
                )}
                {slots.length === 0 ? (
                  <div className="text-xs text-gray-500">No filaments reported.</div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                    {slots.map((slot, i) => {
                      const hex = slot.color ? `#${slot.color.replace(/^#/, '').slice(0, 6)}` : '#444';
                      // AMS slots are editable + pushable to the printer (Bambu).
                      // Manual slots are snorcal-local only — no remote push on Klipper.
                      const canEdit = slot.source === 'ams' && p.protocol === 'bambu';
                      return (
                        <div key={i} className="flex items-center gap-2 bg-gray-800 rounded p-2">
                          <span className="w-7 h-7 rounded border border-gray-600 flex-shrink-0"
                            style={{ backgroundColor: hex }}
                            title={hex} />
                          <div className="min-w-0 flex-1">
                            <div className="text-[10px] text-gray-500">{slot.label}</div>
                            <div className="text-xs text-white truncate">{slot.type ?? 'unknown'}</div>
                            <div className="text-[10px] text-gray-500 truncate">
                              {slot.brand && <span>{slot.brand} </span>}
                              {slot.remain !== undefined && <span>{slot.remain}%</span>}
                            </div>
                          </div>
                          {canEdit && (
                            <button
                              onClick={() => {
                                const amsSlot = statuses[p.id]?.ams?.[i];
                                if (amsSlot) setEditing({ printerId: p.id, slot: amsSlot });
                              }}
                              aria-label={`Edit ${slot.label}`}
                              title="Edit + push to printer"
                              className="text-gray-400 hover:text-white text-xs px-1 shrink-0"
                            >✎</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {editing && (
        <AmsEditor
          printerId={editing.printerId}
          slot={editing.slot}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </Modal>
  );
}

