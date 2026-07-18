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
  // Secrets are never returned by the backend, so the fields start empty.
  // A `dirty` flag tracks whether the operator typed a new value — only then
  // is it included in the PATCH (omitting = keep the existing secret).
  const [accessCode, setAccessCode] = useState('');
  const [accessCodeDirty, setAccessCodeDirty] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [cameraStreamUrl, setCameraStreamUrl] = useState(printer.cameraStreamUrl ?? '');
  const [cameraSnapshotUrl, setCameraSnapshotUrl] = useState(printer.cameraSnapshotUrl ?? '');
  const [bambuddyMode, setBambuddyMode] = useState(printer.connectionMode === 'bambuddy');
  const [bambuddyUrl, setBambuddyUrl] = useState(printer.bambuddyUrl ?? '');
  const [bambuddyPrinterId, setBambuddyPrinterId] = useState<number | ''>(printer.bambuddyPrinterId ?? '');
  const [bambuddyApiKey, setBambuddyApiKey] = useState('');
  const [bambuddyApiKeyDirty, setBambuddyApiKeyDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(printer.name);
    setIp(printer.ip);
    setPort(printer.port);
    setAccessCode(''); setAccessCodeDirty(false);
    setApiKey(''); setApiKeyDirty(false);
    setCameraStreamUrl(printer.cameraStreamUrl ?? '');
    setCameraSnapshotUrl(printer.cameraSnapshotUrl ?? '');
    setBambuddyMode(printer.connectionMode === 'bambuddy');
    setBambuddyUrl(printer.bambuddyUrl ?? '');
    setBambuddyPrinterId(printer.bambuddyPrinterId ?? '');
    setBambuddyApiKey(''); setBambuddyApiKeyDirty(false);
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
        // Only send secrets when the user typed a value — otherwise omit so
        // the backend keeps the existing one (PATCH is partial).
        ...(accessCodeDirty ? { accessCode: accessCode.trim() || null } : {}),
        ...(apiKeyDirty ? { apiKey: apiKey.trim() || null } : {}),
        cameraStreamUrl: cameraStreamUrl.trim() || null,
        cameraSnapshotUrl: cameraSnapshotUrl.trim() || null,
        // Connection mode + bambuddy config. Always send mode so toggling back
        // to direct persists; send proxy fields when in bambuddy mode.
        connectionMode: isBambu ? (bambuddyMode ? 'bambuddy' : 'direct') : null,
        ...(isBambu ? {
          bambuddyUrl: bambuddyMode ? (bambuddyUrl.trim() || null) : null,
          bambuddyPrinterId: bambuddyMode && bambuddyPrinterId !== '' ? Number(bambuddyPrinterId) : null,
        } : {}),
        ...(bambuddyApiKeyDirty ? { bambuddyApiKey: bambuddyApiKey.trim() || null } : {}),
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
          <>
            {/* Connection mode toggle */}
            <div className="flex gap-2">
              {([false, true] as const).map(mode => (
                <button key={String(mode)} type="button" onClick={() => setBambuddyMode(mode)}
                  className={`flex-1 px-3 py-1.5 rounded text-xs ${
                    bambuddyMode === mode ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}>
                  {mode ? 'Bambuddy proxy' : 'Direct LAN (MQTT)'}
                </button>
              ))}
            </div>

            {!bambuddyMode ? (
              <Field label="LAN Access Code">
                <input
                  type="password"
                  value={accessCode}
                  onChange={(e) => { setAccessCode(e.target.value); setAccessCodeDirty(true); }}
                  placeholder={accessCodeDirty ? '' : '•••••• (leave blank to keep current)'}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white"
                />
              </Field>
            ) : (
              <>
                <Field label="Bambuddy URL">
                  <input value={bambuddyUrl} onChange={(e) => setBambuddyUrl(e.target.value)}
                    placeholder="http://100.122.105.27:8000"
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
                </Field>
                <Field label="Bambuddy Printer ID">
                  <input type="number" min={1} value={bambuddyPrinterId}
                    onChange={(e) => setBambuddyPrinterId(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="1"
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
                </Field>
                <Field label="Bambuddy API Key (optional)">
                  <input type="password" value={bambuddyApiKey}
                    onChange={(e) => { setBambuddyApiKey(e.target.value); setBambuddyApiKeyDirty(true); }}
                    placeholder={bambuddyApiKeyDirty ? '' : 'bb_... (leave blank to keep current)'}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
                </Field>
              </>
            )}
          </>
        )}

        {!isBambu && (
          <Field label="API key (optional)">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setApiKeyDirty(true); }}
              placeholder={apiKeyDirty ? '' : '•••••• (leave blank to keep current)'}
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white"
            />
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
