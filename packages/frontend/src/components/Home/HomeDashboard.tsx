import { useEffect, useState } from 'react';
import type { PrinterRecord, PrinterStatus } from '@snorcal/shared';
import * as api from '../../api/client';
import { CameraView } from '../PrinterMonitor/CameraView';
import { PrinterDashboard } from '../PrinterMonitor/PrinterDashboard';

interface JobSummary {
  id: string;
  status: string;
  modelName?: string;
  createdAt?: string;
  progress?: number;
}

interface Props {
  onSlice: () => void;
  onOpenJob: (jobId: string) => void;
  onOpenPrinter: (id: string) => void;
  onImportMakerworld: () => void;
}

export function HomeDashboard({ onSlice, onOpenJob, onOpenPrinter, onImportMakerworld }: Props) {
  const [printers, setPrinters] = useState<PrinterRecord[]>([]);
  const [statuses, setStatuses] = useState<Record<string, PrinterStatus>>({});
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [showPrinterMgmt, setShowPrinterMgmt] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const [list, jobList] = await Promise.all([
        api.listPrinters().catch(() => []),
        api.listJobs().catch(() => []),
      ]);
      setPrinters(list);
      const next: Record<string, PrinterStatus> = {};
      for (const p of list) if (p.status) next[p.id] = p.status;
      setStatuses(next);
      setJobs((jobList as any[]).slice(0, 5));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    const es = new EventSource('/api/events');
    const onMsg = (type: string, event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (type === 'printer:status' && data.printerId) {
          setStatuses(prev => ({ ...prev, [data.printerId]: data }));
        }
        if (type === 'job:progress' || type === 'job:completed' || type === 'job:failed') {
          refresh();
        }
      } catch {}
    };
    for (const t of ['printer:status', 'job:progress', 'job:completed', 'job:failed']) {
      es.addEventListener(t, (e) => onMsg(t, e as MessageEvent));
    }
    return () => es.close();
  }, []);

  const printingCount = Object.values(statuses).filter(s => s.state === 'printing').length;
  const totalJobs = jobs.length;

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900">
      <div className="max-w-6xl mx-auto p-6 space-y-8">

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Printers" value={printers.length} sub={`${printingCount} printing`} color="emerald" />
          <StatCard label="Active Job" value={printingCount} sub={printingCount > 0 ? 'in progress' : 'idle'} color="blue" />
          <StatCard label="Recent Jobs" value={totalJobs} sub="last 24h" color="gray" />
        </div>

        {/* Quick actions */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onSlice}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white"
          >
            + New Slice
          </button>
          <button
            onClick={onImportMakerworld}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm text-white"
          >
            Import from MakerWorld
          </button>
        </div>

        {/* Printers section */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Printers</h2>
            <div className="flex gap-2">
              <button onClick={() => setShowPrinterMgmt(true)}
                className="text-xs text-gray-400 hover:text-white px-2 py-1">Manage</button>
              <button onClick={() => setShowPrinterMgmt(true)}
                className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white">+ Add</button>
            </div>
          </div>

          {printers.length === 0 ? (
            <EmptyState
              title="No printers yet"
              body="Add a Moonraker or Bambu Lab printer to start monitoring."
              cta="Add Printer"
              onCta={() => setShowPrinterMgmt(true)}
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {printers.map(p => (
                <PrinterTile key={p.id} printer={p} status={statuses[p.id]}
                  onReconnect={() => api.reconnectPrinter(p.id)}
                  onOpen={() => onOpenPrinter(p.id)} />
              ))}
            </div>
          )}
        </section>

        {/* Recent jobs */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Recent Jobs</h2>
            <button onClick={onSlice}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">+ Slice</button>
          </div>

          {jobs.length === 0 ? (
            <EmptyState
              title="No jobs yet"
              body="Slice a model to see jobs here."
              cta="Slice a Model"
              onCta={onSlice}
            />
          ) : (
            <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
              {jobs.map((j, i) => (
                <button key={j.id} onClick={() => onOpenJob(j.id)}
                  className={`w-full flex items-center justify-between px-4 py-3 hover:bg-gray-750 text-left ${
                    i < jobs.length - 1 ? 'border-b border-gray-700/50' : ''
                  }`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <JobStatusIcon status={j.status} />
                    <div className="min-w-0">
                      <div className="text-sm text-white truncate">{j.modelName || j.id.slice(0, 8)}</div>
                      <div className="text-xs text-gray-500">{j.createdAt ? formatRelative(j.createdAt) : ''}</div>
                    </div>
                  </div>
                  {j.status === 'running' && j.progress !== undefined && (
                    <div className="text-xs text-blue-300">{Math.round(j.progress)}%</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {showPrinterMgmt && (
        <PrinterDashboard onClose={() => { setShowPrinterMgmt(false); refresh(); }} />
      )}
    </div>
  );
}

function PrinterTile({ printer, status, onReconnect, onOpen }: {
  printer: PrinterRecord; status?: PrinterStatus; onReconnect: () => void; onOpen: () => void;
}) {
  const connection = status?.connection ?? 'disconnected';
  const state = status?.state ?? 'offline';
  const connColor = {
    connected: 'bg-green-500', connecting: 'bg-yellow-500',
    disconnected: 'bg-red-500', error: 'bg-red-500',
  }[connection] || 'bg-gray-500';

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex items-stretch gap-3 min-w-0 hover:border-gray-500 transition-colors">
      <button onClick={onOpen} className="focus:outline-none">
        <CameraView printer={printer} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connColor} flex-shrink-0`} />
          <h3 className="text-sm font-medium text-white truncate cursor-pointer hover:text-blue-300"
              onClick={onOpen}>{printer.name}</h3>
          {(connection === 'disconnected' || connection === 'error') && (
            <button onClick={onReconnect}
              className="ml-auto text-xs text-blue-400 hover:text-blue-300 flex-shrink-0">Reconnect</button>
          )}
        </div>
        <div className="text-xs text-gray-400 mt-0.5 capitalize">{state}</div>

        {/* Temps + fan row */}
        {(status?.temps?.hotend !== undefined || status?.temps?.bed !== undefined || status?.fanSpeed !== undefined) && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-300 mt-1.5">
            {status?.temps?.hotend !== undefined && (
              <span title="Hotend">
                <span className="text-red-400">●</span> {Math.round(status.temps.hotend)}°C
                {status.temps.hotendTarget !== undefined && status.temps.hotendTarget > 0 && (
                  <span className="text-gray-500"> / {Math.round(status.temps.hotendTarget)}°</span>
                )}
              </span>
            )}
            {status?.temps?.bed !== undefined && (
              <span title="Bed">
                <span className="text-orange-400">●</span> {Math.round(status.temps.bed)}°C
                {status.temps.bedTarget !== undefined && status.temps.bedTarget > 0 && (
                  <span className="text-gray-500"> / {Math.round(status.temps.bedTarget)}°</span>
                )}
              </span>
            )}
            {status?.fanSpeed !== undefined && status.fanSpeed > 0 && (
              <span title="Fan" className="text-cyan-400">⛶ {Math.round(status.fanSpeed)}%</span>
            )}
          </div>
        )}

        {/* AMS color dots */}
        {status?.ams && status.ams.length > 0 && (
          <div className="flex gap-1 mt-1.5">
            {status.ams.slice(0, 8).map((slot, i) => (
              <span key={i} className="w-3 h-3 rounded-full border border-gray-600"
                title={`${slot.type ?? 'unknown'} ${slot.remain !== undefined ? `${slot.remain}%` : ''}`}
                style={{ backgroundColor: slot.color ? `#${slot.color.slice(0, 6)}` : '#444' }} />
            ))}
          </div>
        )}

        {/* Progress */}
        {status?.progress !== undefined && status.progress > 0 && (
          <div className="mt-2">
            <div className="h-1 bg-gray-700 rounded overflow-hidden">
              <div className="h-full bg-blue-500" style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
            <div className="text-[10px] text-gray-500 mt-0.5 flex justify-between">
              <span>{Math.round(status.progress * 100)}%</span>
              {status.layer !== undefined && status.totalLayers !== undefined && (
                <span>L{status.layer}/{status.totalLayers}</span>
              )}
              {status.etaSec !== undefined && status.etaSec > 0 && (
                <span>ETA {formatDuration(status.etaSec)}</span>
              )}
            </div>
          </div>
        )}
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

function StatCard({ label, value, sub, color }: { label: string; value: number; sub: string; color: string }) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-400',
    blue: 'text-blue-400',
    gray: 'text-gray-300',
  };
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-3xl font-light mt-1 ${colors[color]}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-1">{sub}</div>
    </div>
  );
}

function EmptyState({ title, body, cta, onCta }: { title: string; body: string; cta: string; onCta: () => void }) {
  return (
    <div className="bg-gray-800/50 border border-dashed border-gray-700 rounded-lg p-8 text-center">
      <div className="text-sm text-gray-300 font-medium">{title}</div>
      <div className="text-xs text-gray-500 mt-1">{body}</div>
      <button onClick={onCta}
        className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">{cta}</button>
    </div>
  );
}

function JobStatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <span className="text-green-400 text-lg">✓</span>;
  if (status === 'failed') return <span className="text-red-400 text-lg">✗</span>;
  if (status === 'running') return <span className="text-blue-400 text-lg animate-pulse">●</span>;
  return <span className="text-gray-500 text-lg">○</span>;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return d.toLocaleDateString();
}
