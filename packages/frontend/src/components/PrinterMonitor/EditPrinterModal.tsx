import { useEffect, useState } from 'react';
import * as api from '../../api/client';
import type { PrinterRecord } from '@snorcal/shared';
import { Modal } from '../Modal';

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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

  const validate = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Required';
    if (!ip.trim()) errs.ip = 'Required';
    else if (!/^[a-zA-Z0-9._-]+$/.test(ip.trim())) errs.ip = 'Host or IP only — no http://, port, or path';
    if (port !== '' && (Number(port) < 1 || Number(port) > 65535)) errs.port = '1–65535';
    // Access code only validated when the user is editing it (field starts empty
    // since the backend never returns secrets).
    if (accessCodeDirty && accessCode.trim() && !/^\d{8}$/.test(accessCode.trim())) {
      errs.accessCode = 'Must be 8 digits';
    }
    if (isBambu && bambuddyMode) {
      if (!bambuddyUrl.trim()) errs.bambuddyUrl = 'Required';
      if (bambuddyPrinterId === '') errs.bambuddyPrinterId = 'Required';
    }
    return errs;
  };

  const submit = async () => {
    setError(null);
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      setError('Fix the highlighted fields');
      return;
    }
    setFieldErrors({});
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
    <Modal
      title="Edit Printer"
      onClose={onClose}
      widthClass="max-w-md"
      panelClass="bg-gray-800 border border-gray-700 rounded-lg p-5 space-y-4"
      closeOnBackdrop={false}
      footer={
        <>
          <button onClick={onClose}
            className="flex-1 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-200">Cancel</button>
          <button onClick={submit} disabled={submitting}
            className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/40 rounded text-sm text-white">
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {error && <div className="bg-red-900/40 border border-red-700 rounded px-3 py-2 text-sm text-red-200">{error}</div>}

        <Field label="Name" error={fieldErrors.name}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            className={`w-full bg-gray-700 border rounded px-2 py-1.5 text-sm text-white ${fieldErrors.name ? 'border-red-500' : 'border-gray-600'}`} />
        </Field>

        <div className="flex gap-2">
          <Field label="IP" error={fieldErrors.ip}>
            <input value={ip} onChange={(e) => setIp(e.target.value)}
              className={`flex-1 bg-gray-700 border rounded px-2 py-1.5 text-sm text-white min-w-0 ${fieldErrors.ip ? 'border-red-500' : 'border-gray-600'}`} />
          </Field>
          <Field label="Port" error={fieldErrors.port}>
            <input type="number" value={port} onChange={(e) => setPort(e.target.value === '' ? '' : Number(e.target.value))}
              className={`w-24 bg-gray-700 border rounded px-2 py-1.5 text-sm text-white ${fieldErrors.port ? 'border-red-500' : 'border-gray-600'}`} />
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
              <Field label="LAN Access Code" error={fieldErrors.accessCode}>
                <input
                  type="password"
                  value={accessCode}
                  onChange={(e) => { setAccessCode(e.target.value); setAccessCodeDirty(true); }}
                  placeholder={accessCodeDirty ? '' : '•••••• (leave blank to keep current)'}
                  inputMode="numeric"
                  className={`w-full bg-gray-700 border rounded px-2 py-1.5 text-sm text-white ${fieldErrors.accessCode ? 'border-red-500' : 'border-gray-600'}`}
                />
              </Field>
            ) : (
              <>
                <Field label="Bambuddy URL" error={fieldErrors.bambuddyUrl}>
                  <input value={bambuddyUrl} onChange={(e) => setBambuddyUrl(e.target.value)}
                    placeholder="http://100.122.105.27:8000"
                    className={`w-full bg-gray-700 border rounded px-2 py-1.5 text-sm text-white ${fieldErrors.bambuddyUrl ? 'border-red-500' : 'border-gray-600'}`} />
                </Field>
                <Field label="Bambuddy Printer ID" error={fieldErrors.bambuddyPrinterId}>
                  <input type="number" min={1} value={bambuddyPrinterId}
                    onChange={(e) => setBambuddyPrinterId(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="1"
                    className={`w-full bg-gray-700 border rounded px-2 py-1.5 text-sm text-white ${fieldErrors.bambuddyPrinterId ? 'border-red-500' : 'border-gray-600'}`} />
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
    </Modal>
  );
}

function Field({ label, children, error }: { label: string; children: React.ReactNode; error?: string }) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-400 mb-1">{label}</span>
      {children}
      {error && <span className="block text-[10px] text-red-400 mt-1">{error}</span>}
    </label>
  );
}
