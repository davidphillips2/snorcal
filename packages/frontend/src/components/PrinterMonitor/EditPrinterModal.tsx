import { useEffect, useState } from 'react';
import * as api from '../../api/client';
import type { PrinterRecord } from '@snorcal/shared';

interface Props {
  printer: PrinterRecord;
  onClose: () => void;
  onSaved: () => void;
}

export function EditPrinterModal({ printer, onClose, onSaved }: Props) {
  const [name, setName] = useState(printer.name);
  const [ip, setIp] = useState(printer.ip);
  const [port, setPort] = useState<number | ''>(printer.port);
  const [accessCode, setAccessCode] = useState(printer.accessCode ?? '');
  const [apiKey, setApiKey] = useState(printer.apiKey ?? '');
  const [cameraStreamUrl, setCameraStreamUrl] = useState(printer.cameraStreamUrl ?? '');
  const [cameraSnapshotUrl, setCameraSnapshotUrl] = useState(printer.cameraSnapshotUrl ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(printer.name);
    setIp(printer.ip);
    setPort(printer.port);
    setAccessCode(printer.accessCode ?? '');
    setApiKey(printer.apiKey ?? '');
    setCameraStreamUrl(printer.cameraStreamUrl ?? '');
    setCameraSnapshotUrl(printer.cameraSnapshotUrl ?? '');
  }, [printer.id]);

  const submit = async () => {
    setError(null);
    if (!name.trim() || !ip.trim()) { setError('Name and IP required'); return; }
    setSubmitting(true);
    try {
      await api.updatePrinter(printer.id, {
        name: name.trim(),
        ip: ip.trim(),
        port: port === '' ? undefined : Number(port),
        accessCode: accessCode.trim() || null,
        apiKey: apiKey.trim() || null,
        cameraStreamUrl: cameraStreamUrl.trim() || null,
        cameraSnapshotUrl: cameraSnapshotUrl.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const isBambu = printer.protocol === 'bambu';

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-lg w-full max-w-md p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Edit Printer</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">&times;</button>
        </div>

        {error && <div className="bg-red-900/40 border border-red-700 rounded px-3 py-2 text-sm text-red-200">{error}</div>}

        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
        </Field>

        <div className="flex gap-2">
          <Field label="IP">
            <input value={ip} onChange={(e) => setIp(e.target.value)}
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white min-w-0" />
          </Field>
          <Field label="Port">
            <input type="number" value={port} onChange={(e) => setPort(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-24 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
          </Field>
        </div>

        {isBambu && (
          <Field label="LAN Access Code">
            <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
          </Field>
        )}

        {!isBambu && (
          <Field label="API key (optional)">
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
          </Field>
        )}

        <details className="border border-gray-700 rounded" open>
          <summary className="px-3 py-2 text-sm text-gray-300 cursor-pointer hover:bg-gray-700/50">
            Camera URLs
          </summary>
          <div className="p-3 space-y-3 border-t border-gray-700">
            <Field label="Snapshot URL (JPEG)">
              <input value={cameraSnapshotUrl} onChange={(e) => setCameraSnapshotUrl(e.target.value)}
                placeholder={`http://${ip || 'ip'}/webcam/snapshot.jpg`}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
            </Field>
            <Field label="Stream URL (MJPEG or WebRTC)">
              <input value={cameraStreamUrl} onChange={(e) => setCameraStreamUrl(e.target.value)}
                placeholder={`http://${ip || 'ip'}/webcam/?action=stream  OR  http://${ip || 'ip'}/webcam/webrtc`}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
            </Field>
            <p className="text-[11px] text-gray-500">
              Detected by URL: <code>/webcam/webrtc</code> or <code>/stream</code> → WebRTC player.
              Otherwise MJPEG via &lt;img&gt;.
            </p>
          </div>
        </details>

        <div className="flex gap-2 pt-2">
          <button onClick={onClose}
            className="flex-1 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-200">Cancel</button>
          <button onClick={submit} disabled={submitting}
            className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/40 rounded text-sm text-white">
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-400 mb-1">{label}</span>
      {children}
    </label>
  );
}
