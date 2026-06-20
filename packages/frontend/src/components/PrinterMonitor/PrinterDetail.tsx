import { useEffect, useState } from 'react';
import type { PrinterRecord, PrinterStatus } from '@snorcal/shared';
import * as api from '../../api/client';
import { CameraView } from './CameraView';

interface Props {
  id: string;
  onBack: () => void;
}

export function PrinterDetail({ id, onBack }: Props) {
  const [printer, setPrinter] = useState<PrinterRecord | null>(null);
  const [status, setStatus] = useState<PrinterStatus | undefined>(undefined);
  const [gcode, setGcode] = useState('');
  const [hotend, setHotend] = useState(status?.temps?.hotendTarget ?? 200);
  const [bed, setBed] = useState(status?.temps?.bedTarget ?? 60);

  useEffect(() => {
    api.listPrinters().then(list => {
      const p = list.find(x => x.id === id);
      if (p) {
        setPrinter(p);
        if (p.status) setStatus(p.status);
      }
    }).catch(() => {});
  }, [id]);

  useEffect(() => {
    const es = new EventSource('/api/events');
    const onMsg = (type: string, event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (type === 'printer:status' && data.printerId === id) {
          setStatus(data);
        }
      } catch {}
    };
    for (const t of ['printer:status', 'printer:connected', 'printer:disconnected']) {
      es.addEventListener(t, (e) => onMsg(t, e as MessageEvent));
    }
    return () => es.close();
  }, [id]);

  const connection = status?.connection ?? 'disconnected';
  const state = status?.state ?? 'offline';
  const connColor = {
    connected: 'bg-green-500', connecting: 'bg-yellow-500',
    disconnected: 'bg-red-500', error: 'bg-red-500',
  }[connection] || 'bg-gray-500';

  if (!printer) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        Loading printer…
      </div>
    );
  }

  const onCommand = async (command: string, args?: Record<string, unknown>) => {
    try {
      await api.sendPrinterCommand(printer.id, command, args);
    } catch (e) {
      alert(`Command failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onReconnect = async () => {
    try { await api.reconnectPrinter(printer.id); } catch (e) {
      alert(`Reconnect failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const hasJog = printer.protocol === 'moonraker';

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">

        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={onBack}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-200">← Back</button>
          <span className={`w-2.5 h-2.5 rounded-full ${connColor}`} />
          <h1 className="text-xl font-semibold text-white">{printer.name}</h1>
          <span className="text-xs text-gray-400 capitalize px-2 py-0.5 bg-gray-800 rounded">{state}</span>
          <span className="text-xs text-gray-500">{printer.protocol} · {printer.ip}</span>
          <div className="ml-auto flex gap-2">
            {(connection === 'disconnected' || connection === 'error') && (
              <button onClick={onReconnect}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">Reconnect</button>
            )}
          </div>
        </div>

        {/* Big camera */}
        <div className="bg-black rounded-lg overflow-hidden border border-gray-700">
          <CameraView printerId={printer.id} protocol={printer.protocol} connection={connection} expanded />
        </div>

        {/* Job progress (if printing) */}
        {status?.progress !== undefined && status.progress > 0 && (
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            <div className="flex items-center justify-between text-sm text-gray-300 mb-2">
              <span className="truncate">{status.file ?? 'printing'}</span>
              <span className="ml-2 flex-shrink-0">{Math.round(status.progress * 100)}%</span>
            </div>
            <div className="h-2 bg-gray-700 rounded overflow-hidden">
              <div className="h-full bg-blue-500" style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
            <div className="flex gap-4 mt-2 text-xs text-gray-400">
              {status.layer !== undefined && status.totalLayers !== undefined && (
                <span>Layer {status.layer}/{status.totalLayers}</span>
              )}
              {status.etaSec !== undefined && status.etaSec > 0 && (
                <span>ETA {formatDuration(status.etaSec)}</span>
              )}
            </div>
          </div>
        )}

        {/* Status grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <TempCard label="Hotend" current={status?.temps?.hotend} target={status?.temps?.hotendTarget} max={300} />
          <TempCard label="Bed" current={status?.temps?.bed} target={status?.temps?.bedTarget} max={120} />
          <StatCard label="Fan" value={status?.fanSpeed !== undefined ? `${Math.round(status.fanSpeed)}%` : '—'} />
          <StatCard label="Layer"
            value={status?.layer !== undefined && status?.totalLayers !== undefined
              ? `${status.layer}/${status.totalLayers}` : '—'} />
        </div>

        {/* AMS */}
        {printer.protocol === 'bambu' && status?.ams && status.ams.length > 0 && (
          <Section title="AMS">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {status.ams.map((slot, i) => (
                <div key={i} className="bg-gray-800 rounded p-2 flex items-center gap-2">
                  <span className="w-6 h-6 rounded border border-gray-600 flex-shrink-0"
                    style={{ backgroundColor: slot.color ? `#${slot.color.slice(0, 6)}` : '#444' }} />
                  <div className="min-w-0">
                    <div className="text-xs text-white truncate">{slot.type ?? 'unknown'}</div>
                    <div className="text-[10px] text-gray-500">
                      {slot.brand && <span className="truncate">{slot.brand} </span>}
                      {slot.remain !== undefined && <span>{slot.remain}%</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Print controls */}
        <Section title="Controls">
          <div className="flex gap-2 flex-wrap">
            {state === 'printing' && (
              <>
                <button onClick={() => onCommand('pause')}
                  className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 rounded text-sm text-white">Pause</button>
                <button onClick={() => onCommand('cancel')}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded text-sm text-white">Cancel</button>
              </>
            )}
            {state === 'paused' && (
              <button onClick={() => onCommand('resume')}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded text-sm text-white">Resume</button>
            )}
            {(connection === 'disconnected' || connection === 'error') && (
              <button onClick={onReconnect}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">Reconnect</button>
            )}
          </div>
        </Section>

        {/* Temps */}
        <Section title="Temperatures">
          <div className="flex gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <span className="w-14">Hotend</span>
              <input type="number" min="0" max="300" value={hotend}
                onChange={(e) => setHotend(Number(e.target.value))}
                className="w-24 px-2 py-1 bg-gray-700 rounded text-white" />
              <span className="text-gray-400">°C</span>
              <button onClick={() => onCommand('set_temp', { heater: 'hotend', value: hotend })}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white">Set</button>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <span className="w-14">Bed</span>
              <input type="number" min="0" max="120" value={bed}
                onChange={(e) => setBed(Number(e.target.value))}
                className="w-24 px-2 py-1 bg-gray-700 rounded text-white" />
              <span className="text-gray-400">°C</span>
              <button onClick={() => onCommand('set_temp', { heater: 'bed', value: bed })}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white">Set</button>
            </label>
          </div>
        </Section>

        {/* Jog */}
        {hasJog && (
          <Section title="Jog (10mm)">
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => onCommand('home', { axes: ['x', 'y', 'z'] })}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-white">Home All</button>
              <JogBtn label="X-" onClick={() => onCommand('jog', { axis: 'x', amount: -10 })} />
              <JogBtn label="X+" onClick={() => onCommand('jog', { axis: 'x', amount: 10 })} />
              <JogBtn label="Y-" onClick={() => onCommand('jog', { axis: 'y', amount: -10 })} />
              <JogBtn label="Y+" onClick={() => onCommand('jog', { axis: 'y', amount: 10 })} />
              <JogBtn label="Z-" onClick={() => onCommand('jog', { axis: 'z', amount: -1 })} />
              <JogBtn label="Z+" onClick={() => onCommand('jog', { axis: 'z', amount: 1 })} />
            </div>
          </Section>
        )}

        {/* Gcode */}
        <Section title="G-code Console">
          <div className="flex gap-2">
            <input
              value={gcode}
              onChange={(e) => setGcode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && gcode.trim()) {
                  onCommand('send_gcode', { script: gcode });
                  setGcode('');
                }
              }}
              placeholder="e.g. M104 S200"
              className="flex-1 px-3 py-1.5 bg-gray-700 rounded text-sm text-white placeholder-gray-500"
            />
            <button
              onClick={() => { if (gcode.trim()) { onCommand('send_gcode', { script: gcode }); setGcode(''); } }}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">Send</button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function JogBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm text-white">{label}</button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-lg text-white mt-1">{value}</div>
    </div>
  );
}

function TempCard({ label, current, target, max }: { label: string; current?: number; target?: number; max: number }) {
  const cur = current ?? 0;
  const tgt = target ?? 0;
  const pct = Math.min(100, Math.max(0, (cur / max) * 100));
  const tgtPct = Math.min(100, Math.max(0, (tgt / max) * 100));
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-lg text-white mt-1">
        {current !== undefined ? Math.round(current) : '—'}°C
      </div>
      {target !== undefined && (
        <div className="text-[10px] text-gray-500">target {Math.round(target)}°C</div>
      )}
      <div className="h-1 bg-gray-700 rounded mt-2 relative overflow-hidden">
        <div className="h-full bg-red-500/60" style={{ width: `${tgtPct}%` }} />
        <div className="h-full bg-red-400 absolute top-0 left-0" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
