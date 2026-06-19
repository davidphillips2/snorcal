import { useState } from 'react';
import * as api from '../../api/client';
import type { DiscoveredDevice } from '@slorca/shared';

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

export function AddPrinterModal({ onClose, onAdded }: Props) {
  const [protocol, setProtocol] = useState<'moonraker' | 'bambu'>('moonraker');
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState<number | ''>('');
  const [serial, setSerial] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setDiscovered([]);
    try {
      const devices = await api.discoverPrinters(8000);
      setDiscovered(devices);
    } catch (e) {
      setError(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const pick = (d: DiscoveredDevice) => {
    setIp(d.ip);
    setPort(d.port);
    // Sniff protocol from probe type
    if (d.st === 'bambu-lan') setProtocol('bambu');
    else if (d.st === 'moonraker') setProtocol('moonraker');
    if (!name) setName(d.friendlyName || `Printer ${d.ip}`);
  };

  const submit = async () => {
    setError(null);
    if (!name.trim() || !ip.trim()) { setError('Name and IP required'); return; }
    if (protocol === 'bambu' && (!serial.trim() || !accessCode.trim())) {
      setError('Bambu requires serial and access code');
      return;
    }
    setSubmitting(true);
    try {
      await api.createPrinter({
        name: name.trim(),
        protocol,
        ip: ip.trim(),
        port: port === '' ? undefined : Number(port),
        serial: serial.trim() || undefined,
        accessCode: accessCode.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-lg w-full max-w-md p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Add Printer</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">&times;</button>
        </div>

        {error && <div className="bg-red-900/40 border border-red-700 rounded px-3 py-2 text-sm text-red-200">{error}</div>}

        {/* Protocol toggle */}
        <div className="flex gap-2">
          {(['moonraker', 'bambu'] as const).map(p => (
            <button key={p} onClick={() => setProtocol(p)}
              className={`flex-1 px-3 py-2 rounded text-sm capitalize ${
                protocol === p ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}>
              {p === 'moonraker' ? 'Moonraker / Klipper' : 'Bambu Lab (LAN)'}
            </button>
          ))}
        </div>

        {/* Scan */}
        <div>
          <button onClick={scan} disabled={scanning}
            className={`w-full px-3 py-2 rounded text-sm ${
              scanning ? 'bg-blue-600/40 text-blue-200' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
            }`}>
            {scanning ? 'Scanning…' : 'Scan Network'}
          </button>
          {discovered.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto bg-gray-900 rounded border border-gray-700">
              {discovered.map(d => (
                <button key={`${d.ip}:${d.port}`} onClick={() => pick(d)}
                  className="w-full text-left px-3 py-1.5 hover:bg-gray-700 border-b border-gray-800 last:border-0">
                  <div className="text-xs text-white">{d.friendlyName}</div>
                  <div className="text-[10px] text-gray-400">{d.ip}:{d.port} · {d.server}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Fields */}
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Printer"
            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
        </Field>
        <div className="flex gap-2">
          <Field label="IP">
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50"
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white min-w-0" />
          </Field>
          <Field label="Port">
            <input type="number" value={port} onChange={(e) => setPort(e.target.value === '' ? '' : Number(e.target.value))}
              placeholder={protocol === 'bambu' ? '8883' : '7125'}
              className="w-24 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
          </Field>
        </div>

        {protocol === 'bambu' && (
          <>
            <Field label="Serial Number">
              <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="00M00C000000000"
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
            </Field>
            <Field label="LAN Access Code (8-digit)">
              <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="12345678"
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
            </Field>
            <p className="text-xs text-gray-400">
              Find on printer LCD: Settings → Network → LAN Access Code.
            </p>
          </>
        )}

        {protocol === 'moonraker' && (
          <Field label="API Key (optional)">
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="blank if trusted"
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white" />
          </Field>
        )}

        <div className="flex gap-2 pt-2">
          <button onClick={onClose}
            className="flex-1 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-200">Cancel</button>
          <button onClick={submit} disabled={submitting}
            className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/40 rounded text-sm text-white">
            {submitting ? 'Adding…' : 'Add Printer'}
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
