import { useEffect, useRef, useState } from 'react';
import type { PrinterRecord, PrinterStatus } from '@slorca/shared';
import * as api from '../../api/client';
import { AddPrinterModal } from './AddPrinterModal';

interface Props {
  onClose: () => void;
}

export function PrinterDashboard({ onClose }: Props) {
  const [printers, setPrinters] = useState<PrinterRecord[]>([]);
  const [statuses, setStatuses] = useState<Record<string, PrinterStatus>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const list = await api.listPrinters();
      setPrinters(list);
      const next: Record<string, PrinterStatus> = {};
      for (const p of list) if (p.status) next[p.id] = p.status;
      setStatuses(next);
    } catch (e) {
      console.error('listPrinters failed', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Listen to SSE for printer status updates
  useEffect(() => {
    const es = new EventSource('/api/events');
    const onMsg = (type: string, event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (type === 'printer:status' && data.printerId) {
          setStatuses(prev => ({ ...prev, [data.printerId]: data }));
        }
        if (type === 'printer:connected' || type === 'printer:disconnected') {
          refresh();
        }
      } catch {}
    };
    for (const t of ['printer:status', 'printer:connected', 'printer:disconnected']) {
      es.addEventListener(t, (e) => onMsg(t, e as MessageEvent));
    }
    return () => es.close();
  }, []);

  const onDelete = async (id: string) => {
    if (!confirm('Remove this printer?')) return;
    await api.deletePrinter(id);
    await refresh();
  };

  const onCommand = async (printerId: string, command: string, args?: Record<string, unknown>) => {
    try {
      await api.sendPrinterCommand(printerId, command, args);
    } catch (e) {
      alert(`Command failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex flex-col">
      <header className="bg-gray-900 border-b border-gray-700 px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Printers</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowAdd(true)}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">
            + Add Printer
          </button>
          <button onClick={onClose}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-200">
            Close
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center text-gray-400 mt-8">Loading…</div>
        ) : printers.length === 0 ? (
          <div className="text-center text-gray-400 mt-8">
            No printers registered.
            <div className="mt-2">
              <button onClick={() => setShowAdd(true)}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">
                Add your first printer
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {printers.map(p => (
              <PrinterCard
                key={p.id}
                printer={p}
                status={statuses[p.id]}
                expanded={expandedId === p.id}
                onToggle={() => setExpandedId(expandedId === p.id ? null : p.id)}
                onDelete={() => onDelete(p.id)}
                onCommand={(cmd, args) => onCommand(p.id, cmd, args)}
              />
            ))}
          </div>
        )}
      </div>

      {showAdd && (
        <AddPrinterModal
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); refresh(); }}
        />
      )}
    </div>
  );
}

interface CardProps {
  printer: PrinterRecord;
  status?: PrinterStatus;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onCommand: (cmd: string, args?: Record<string, unknown>) => void;
}

function PrinterCard({ printer, status, expanded, onToggle, onDelete, onCommand }: CardProps) {
  const connection = status?.connection ?? 'disconnected';
  const state = status?.state ?? 'offline';
  const connColor = {
    connected: 'bg-green-500', connecting: 'bg-yellow-500',
    disconnected: 'bg-red-500', error: 'bg-red-500',
  }[connection] || 'bg-gray-500';

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
      <div className="p-3 flex items-start gap-3">
        <CameraView printerId={printer.id} protocol={printer.protocol} connection={connection} expanded={expanded} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${connColor}`} />
            <h3 className="text-sm font-medium text-white truncate">{printer.name}</h3>
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            {printer.protocol} · {printer.ip}:{printer.port}
          </div>
          <div className="text-xs text-gray-300 mt-1 capitalize">{state}</div>
          {status?.temps && (status.temps.bed !== undefined || status.temps.hotend !== undefined) && (
            <div className="text-xs text-gray-300 mt-1">
              {status.temps.hotend !== undefined && (
                <span>Hotend: {Math.round(status.temps.hotend)}°C{status.temps.hotendTarget ? ` / ${status.temps.hotendTarget}°C` : ''} </span>
              )}
              {status.temps.bed !== undefined && (
                <span>Bed: {Math.round(status.temps.bed)}°C{status.temps.bedTarget ? ` / ${status.temps.bedTarget}°C` : ''}</span>
              )}
            </div>
          )}
          {status?.progress !== undefined && status.progress > 0 && (
            <div className="mt-2">
              <div className="h-1.5 bg-gray-700 rounded overflow-hidden">
                <div className="h-full bg-blue-500" style={{ width: `${Math.round(status.progress * 100)}%` }} />
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {Math.round(status.progress * 100)}%
                {status.layer !== undefined && status.totalLayers !== undefined && (
                  <span className="ml-2">Layer {status.layer}/{status.totalLayers}</span>
                )}
                {status.etaSec !== undefined && status.etaSec > 0 && (
                  <span className="ml-2">ETA {formatDuration(status.etaSec)}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="px-3 pb-2 flex gap-2 border-t border-gray-700/50 pt-2">
        <button onClick={onToggle}
          className="text-xs text-gray-300 hover:text-white px-2 py-1 rounded hover:bg-gray-700">
          {expanded ? 'Less' : 'Controls'}
        </button>
        {state === 'printing' && (
          <>
            <button onClick={() => onCommand('pause')}
              className="text-xs text-yellow-300 hover:text-yellow-200 px-2 py-1 rounded hover:bg-gray-700">Pause</button>
            <button onClick={() => onCommand('cancel')}
              className="text-xs text-red-300 hover:text-red-200 px-2 py-1 rounded hover:bg-gray-700">Cancel</button>
          </>
        )}
        {state === 'paused' && (
          <button onClick={() => onCommand('resume')}
            className="text-xs text-green-300 hover:text-green-200 px-2 py-1 rounded hover:bg-gray-700">Resume</button>
        )}
        <button onClick={onDelete}
          className="ml-auto text-xs text-red-400 hover:text-red-300 px-2 py-1">Remove</button>
      </div>

      {expanded && (
        <ExpandedControls printer={printer} status={status} onCommand={onCommand} />
      )}
    </div>
  );
}

function ExpandedControls({ printer, status, onCommand }: {
  printer: PrinterRecord; status?: PrinterStatus; onCommand: (cmd: string, args?: Record<string, unknown>) => void;
}) {
  const [gcode, setGcode] = useState('');
  const [hotend, setHotend] = useState(status?.temps?.hotendTarget ?? 200);
  const [bed, setBed] = useState(status?.temps?.bedTarget ?? 60);

  const hasJog = printer.protocol === 'moonraker';

  return (
    <div className="px-3 pb-3 space-y-3 border-t border-gray-700/50 pt-2">
      {/* Temps */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <span className="w-12">Hotend</span>
          <input type="range" min="0" max="300" value={hotend}
            onChange={(e) => setHotend(Number(e.target.value))}
            className="flex-1" />
          <span className="w-12 text-right">{hotend}°C</span>
          <button onClick={() => onCommand('set_temp', { heater: 'hotend', value: hotend })}
            className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-white">Set</button>
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <span className="w-12">Bed</span>
          <input type="range" min="0" max="120" value={bed}
            onChange={(e) => setBed(Number(e.target.value))}
            className="flex-1" />
          <span className="w-12 text-right">{bed}°C</span>
          <button onClick={() => onCommand('set_temp', { heater: 'bed', value: bed })}
            className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-white">Set</button>
        </label>
      </div>

      {/* Jog (Moonraker only) */}
      {hasJog && (
        <div className="space-y-1">
          <div className="text-xs text-gray-400">Jog (10mm)</div>
          <div className="flex gap-1 flex-wrap">
            <button onClick={() => onCommand('home', { axes: ['x', 'y', 'z'] })}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-white">Home All</button>
            <button onClick={() => onCommand('jog', { axis: 'x', amount: 10 })}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-white">X+</button>
            <button onClick={() => onCommand('jog', { axis: 'x', amount: -10 })}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-white">X-</button>
            <button onClick={() => onCommand('jog', { axis: 'y', amount: 10 })}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-white">Y+</button>
            <button onClick={() => onCommand('jog', { axis: 'y', amount: -10 })}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-white">Y-</button>
            <button onClick={() => onCommand('jog', { axis: 'z', amount: 1 })}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-white">Z+</button>
            <button onClick={() => onCommand('jog', { axis: 'z', amount: -1 })}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-white">Z-</button>
          </div>
        </div>
      )}

      {/* AMS for Bambu */}
      {printer.protocol === 'bambu' && status?.ams && status.ams.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-gray-400">AMS</div>
          <div className="flex gap-2 flex-wrap">
            {status.ams.map((slot, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-gray-700/50 rounded px-2 py-1">
                <span className="w-3 h-3 rounded-full border border-gray-500"
                  style={{ backgroundColor: slot.color ? `#${slot.color.slice(0, 6)}` : '#888' }} />
                <span className="text-xs text-gray-300">{slot.type ?? 'unknown'}</span>
                {slot.remain !== undefined && <span className="text-[10px] text-gray-500">{slot.remain}%</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gcode console */}
      <div className="space-y-1">
        <div className="text-xs text-gray-400">G-code</div>
        <div className="flex gap-1">
          <input
            value={gcode}
            onChange={(e) => setGcode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && gcode.trim()) {
                onCommand('send_gcode', { script: gcode });
                setGcode('');
              }
            }}
            placeholder="M119"
            className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white min-w-0"
          />
          <button
            onClick={() => { if (gcode.trim()) { onCommand('send_gcode', { script: gcode }); setGcode(''); } }}
            className="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">Send</button>
        </div>
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60); const s = Math.round(sec % 60);
  if (m < 60) return `${m}m${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60); const mm = m % 60;
  return `${h}h${mm.toString().padStart(2, '0')}m`;
}

import { CameraView } from './CameraView';
