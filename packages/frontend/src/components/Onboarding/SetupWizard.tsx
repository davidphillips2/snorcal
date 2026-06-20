import { useState, useEffect } from 'react';
import * as api from '../../api/client';
import type { DiscoveredDevice } from '@snorcal/shared';

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

type Step = 'welcome' | 'protocol' | 'discover' | 'credentials' | 'test';

type Prot = 'moonraker' | 'bambu' | 'snapmaker';

const PROT_DEFAULT_PORT: Record<Prot, number> = {
  moonraker: 7125,
  bambu: 8883,
  snapmaker: 8883,
};

export function SetupWizard({ onClose, onAdded }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [protocol, setProtocol] = useState<Prot>('moonraker');
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState<number | ''>('');
  const [serial, setSerial] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelChoice, setModelChoice] = useState<string>('');
  const [modelCustom, setModelCustom] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [manualSlots, setManualSlots] = useState<number>(4);      // snapmaker direct-feed spool count

  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; info?: string; error?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listPrinterModels().then(setAvailableModels).catch(() => setAvailableModels([]));
  }, []);

  const scan = async () => {
    setScanning(true);
    setDiscovered([]);
    setError(null);
    try {
      const devices = await api.discoverPrinters(8000);
      setDiscovered(devices);
      if (devices.length === 0) setError('No printers found. Enter IP manually below.');
    } catch (e) {
      setError(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const pick = (d: DiscoveredDevice) => {
    setIp(d.ip);
    setPort(d.port);
    if (d.st === 'bambu-lan') setProtocol('bambu');
    else if (d.st === 'snapmaker') setProtocol('snapmaker');
    else if (d.st === 'moonraker') setProtocol('moonraker');
    if (!name) setName(d.friendlyName || `Printer ${d.ip}`);
    setStep('credentials');
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const r = await api.testPrinterConnection(ip.trim(), port === '' ? undefined : Number(port));
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!name.trim() || !ip.trim()) { setError('Name and IP required'); return; }
    if (protocol === 'bambu' && (!serial.trim() || !accessCode.trim())) {
      setError('Bambu requires serial and access code');
      return;
    }
    if (protocol === 'snapmaker' && !accessCode.trim()) {
      setError('Snapmaker requires LAN access code');
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
        model: modelChoice === '__other__' ? modelCustom.trim() : (modelChoice || undefined),
        manualSlots: protocol === 'snapmaker' ? manualSlots : undefined,
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
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-white">Welcome to Snorcal</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">Step {stepIndex(step)} of 5</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-gray-800">
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${(stepIndex(step) / 5) * 100}%` }} />
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          {error && <div className="mb-3 bg-red-900/40 border border-red-700 rounded px-3 py-2 text-sm text-red-200">{error}</div>}

          {step === 'welcome' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-300">
                Snorcal slices STL/3MF files and sends them straight to your 3D printer over the local network.
              </p>
              <ul className="text-xs text-gray-400 space-y-1 list-disc list-inside">
                <li>Supports Klipper (Moonraker) and Bambu Lab printers</li>
                <li>Slice with OrcaSlicer or BambuStudio</li>
                <li>Paint faces, manage filament inventory, monitor live prints</li>
              </ul>
              <p className="text-xs text-gray-500">
                You'll need: printer IP, and for Bambu Lab the LAN access code (on printer LCD).
              </p>
              <button onClick={() => setStep('protocol')} className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white font-medium">
                Get started
              </button>
              <button onClick={onClose} className="w-full text-xs text-gray-500 hover:text-gray-400">
                Skip — I'll add a printer later
              </button>
            </div>
          )}

          {step === 'protocol' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-300">What kind of printer do you have?</p>
              <button onClick={() => { setProtocol('moonraker'); setStep('discover'); }}
                className="w-full text-left p-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg">
                <div className="text-sm font-medium text-white">Klipper / Moonraker</div>
                <div className="text-xs text-gray-400 mt-1">Voron, RatRig, Sofabed, any Klipperized machine. Port 7125 default.</div>
              </button>
              <button onClick={() => { setProtocol('bambu'); setStep('discover'); }}
                className="w-full text-left p-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg">
                <div className="text-sm font-medium text-white">Bambu Lab (LAN)</div>
                <div className="text-xs text-gray-400 mt-1">X1, P1, A1 series. Needs LAN access code + serial. Port 8883 default.</div>
              </button>
              <button onClick={() => { setProtocol('snapmaker'); setStep('discover'); }}
                className="w-full text-left p-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg">
                <div className="text-sm font-medium text-white">Snapmaker (LAN)</div>
                <div className="text-xs text-gray-400 mt-1">J1, Artisan, U1, J1S. mTLS via touchscreen LAN access code. Port 8883 default.</div>
              </button>
              <p className="text-[11px] text-gray-500">
                Don't see yours? OctoPrint / Repetier / Duet support coming in Phase 5.
              </p>
            </div>
          )}

          {step === 'discover' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-300">Let's find your printer.</p>
              <button onClick={scan} disabled={scanning}
                className={`w-full px-4 py-2.5 rounded text-sm font-medium ${scanning ? 'bg-blue-600/40 text-blue-200' : 'bg-gray-700 hover:bg-gray-600 text-white'}`}>
                {scanning ? 'Scanning network…' : 'Scan my network'}
              </button>
              {discovered.length > 0 && (
                <div className="max-h-48 overflow-y-auto bg-gray-950 rounded border border-gray-700 divide-y divide-gray-800">
                  {discovered.map(d => (
                    <button key={`${d.ip}:${d.port}`} onClick={() => pick(d)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-800">
                      <div className="text-sm text-white">{d.friendlyName}</div>
                      <div className="text-[11px] text-gray-400">{d.ip}:{d.port} · {d.server}</div>
                    </button>
                  ))}
                </div>
              )}
              <div className="pt-2 border-t border-gray-800">
                <button onClick={() => setStep('credentials')} className="text-xs text-blue-400 hover:text-blue-300">
                  Enter IP manually →
                </button>
              </div>
            </div>
          )}

          {step === 'credentials' && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <button onClick={() => setProtocol('moonraker')}
                  className={`flex-1 px-3 py-1.5 rounded text-xs ${protocol === 'moonraker' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
                  Moonraker
                </button>
                <button onClick={() => setProtocol('bambu')}
                  className={`flex-1 px-3 py-1.5 rounded text-xs ${protocol === 'bambu' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
                  Bambu Lab
                </button>
                <button onClick={() => setProtocol('snapmaker')}
                  className={`flex-1 px-3 py-1.5 rounded text-xs ${protocol === 'snapmaker' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
                  Snapmaker
                </button>
              </div>
              <Field label="Printer name">
                <input value={name} onChange={e => setName(e.target.value)} placeholder="My Printer"
                  className={inputCls} />
              </Field>
              <Field label="Printer model">
                <select value={modelChoice} onChange={e => setModelChoice(e.target.value)} className={inputCls}>
                  <option value="">Select model…</option>
                  {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                  <option value="__other__">Other / not in list</option>
                </select>
                {modelChoice === '__other__' && (
                  <input value={modelCustom} onChange={e => setModelCustom(e.target.value)}
                    placeholder="e.g. Creality Ender 3" className={`${inputCls} mt-2`} />
                )}
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <Field label="IP address">
                    <input value={ip} onChange={e => setIp(e.target.value)} placeholder="192.168.1.50" className={inputCls} />
                  </Field>
                </div>
                <Field label="Port">
                  <input type="number" value={port} onChange={e => setPort(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder={String(PROT_DEFAULT_PORT[protocol])} className={inputCls} />
                </Field>
              </div>

              {protocol === 'bambu' && (
                <>
                  <Field label="Serial number">
                    <input value={serial} onChange={e => setSerial(e.target.value)} placeholder="00M00C000000000" className={inputCls} />
                  </Field>
                  <Field label="LAN access code (8 digits)">
                    <input value={accessCode} onChange={e => setAccessCode(e.target.value)} placeholder="12345678" className={inputCls} />
                  </Field>
                  <p className="text-[11px] text-gray-500">
                    Find on printer LCD: Settings → Network → LAN Access Code.
                  </p>
                </>
              )}

              {protocol === 'snapmaker' && (
                <>
                  <Field label="LAN access code">
                    <input value={accessCode} onChange={e => setAccessCode(e.target.value)} placeholder="touchscreen code" className={inputCls} />
                  </Field>
                  <Field label="Direct-feed spool count">
                    <input type="number" min={0} max={8} value={manualSlots}
                      onChange={e => setManualSlots(Math.max(0, Math.min(8, Number(e.target.value) || 0)))}
                      className={inputCls} />
                  </Field>
                  <p className="text-[11px] text-gray-500">
                    On printer touchscreen: Settings → LAN → LAN Access Code. Snorcal bootstraps mTLS to your printer using this code.
                    <br />Spool count = how many direct-feed slots the printer has (U1 = 4). Used at print
                    time to remap gcode T-codes — printer has no readable slot state.
                  </p>
                </>
              )}

              {protocol === 'moonraker' && (
                <Field label="API key (optional)">
                  <input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="blank if trusted" className={inputCls} />
                </Field>
              )}

              <div className="flex gap-2 pt-2">
                <button onClick={() => setStep('discover')} className="flex-1 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300">Back</button>
                <button onClick={() => setStep('test')} disabled={!ip.trim() || !name.trim()}
                  className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/30 rounded text-sm text-white">
                  Test connection
                </button>
              </div>
            </div>
          )}

          {step === 'test' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-300">Testing {ip}:{port || PROT_DEFAULT_PORT[protocol]}…</p>
              {!testing && !testResult && (
                <button onClick={test} className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">Run test</button>
              )}
              {testing && <div className="text-xs text-gray-400 animate-pulse">Probing…</div>}
              {testResult && (
                <div className={`rounded border px-3 py-2 text-sm ${testResult.ok ? 'bg-emerald-900/30 border-emerald-700 text-emerald-200' : 'bg-red-900/40 border-red-700 text-red-200'}`}>
                  {testResult.ok ? `✓ ${testResult.info ?? 'Connected'}` : `✗ ${testResult.error ?? 'Failed'}`}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button onClick={() => setStep('credentials')} className="flex-1 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-300">Back</button>
                <button onClick={test} disabled={testing || !ip.trim()} className="flex-1 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-200">Re-test</button>
                <button onClick={submit} disabled={submitting || (testResult?.ok === false)}
                  className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/30 rounded text-sm text-white">
                  {submitting ? 'Saving…' : 'Save printer'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function stepIndex(s: Step): number {
  return { welcome: 1, protocol: 2, discover: 3, credentials: 4, test: 5 }[s];
}

const inputCls = "w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-400 mb-1">{label}</span>
      {children}
    </label>
  );
}
