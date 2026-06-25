import { useState, useMemo, useRef } from 'react';
import type { PrinterRecord, PrinterStatus, PrintOptions } from '@snorcal/shared';
import * as api from '../../api/client';
import { buildSlots, hexNormalize } from '../../lib/printer-slots';
import { PrintOptions as PrintOptionsUI } from './PrintOptions';

interface Props {
  printer: PrinterRecord;
  printerStatus: PrinterStatus | undefined;
}

type Phase = 'idle' | 'parsing' | 'remap' | 'sending' | 'done' | 'error';

export function UploadFileSection({ printer, printerStatus }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<api.StageFileResponse | null>(null);
  const [startPrint, setStartPrint] = useState(true);
  const [plate, setPlate] = useState(1);
  const [mapping, setMapping] = useState<number[]>([]);
  const [printOptions, setPrintOptions] = useState<PrintOptions>({});
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const protocol = (printer.protocol === 'bambu' ? 'bambu' : 'moonraker') as 'bambu' | 'moonraker';
  const slots = useMemo(
    () => buildSlots(protocol, printer.manualSlots ?? 0, printerStatus?.ams),
    [protocol, printer.manualSlots, printerStatus],
  );

  const reset = () => {
    setPhase('idle');
    setFile(null);
    setStage(null);
    setStartPrint(true);
    setPlate(1);
    setMapping([]);
    setPrintOptions({});
    setResultPath(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onFile = async (f: File | null) => {
    if (!f) return;
    setFile(f);
    setPhase('parsing');
    setError(null);
    setResultPath(null);
    try {
      const res = await api.stageFileToPrinter(printer.id, f);
      setStage(res);
      setPlate(res.plates[0] ?? 1);
      // Pre-pick slot by color match; fall back to slot index (or 0 = skip)
      const initial = res.filaments.map((gf, i) => {
        const c = hexNormalize(gf.color);
        if (c) {
          const m = slots.find(s => hexNormalize(s.color) === c);
          if (m) return m.value;
        }
        return slots[i]?.value ?? 0;
      });
      setMapping(initial);
      setPhase('remap');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const send = async () => {
    if (!stage) return;
    setPhase('sending');
    setError(null);
    try {
      const result = await api.sendStagedFileToPrinter(printer.id, stage.stageId, {
        startPrint,
        filamentMapping: mapping.length > 0 ? mapping : undefined,
        plate: stage.isGcode3mf ? plate : undefined,
        printOptions: startPrint ? printOptions : undefined,
      });
      setResultPath(result.printerPath);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Stage dir was deleted on backend's finally — must re-stage to retry
      setPhase('error');
      setStage(null);
    }
  };

  return (
    <div>
      <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Upload File</div>
      <div className="bg-gray-800/40 border border-gray-700 rounded-lg p-3 space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".gcode,.gcode.3mf,.3mf"
          disabled={phase === 'parsing' || phase === 'sending'}
          onChange={e => onFile(e.target.files?.[0] ?? null)}
          className="block w-full text-xs text-gray-300 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-gray-700 file:text-gray-200 hover:file:bg-gray-600"
        />

        {phase === 'parsing' && (
          <div className="text-xs text-gray-400">Parsing filaments…</div>
        )}

        {(phase === 'remap' || phase === 'sending' || phase === 'done') && stage && (
          <>
            <div className="text-xs text-gray-400 truncate">
              {stage.filename}
              {stage.isGcode3mf && <span className="ml-2 px-1.5 py-0.5 bg-gray-700 rounded text-[10px]">.gcode.3mf</span>}
            </div>

            {stage.isGcode3mf && stage.plates.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-gray-300">
                Plate
                <select
                  value={plate}
                  onChange={e => setPlate(Number(e.target.value))}
                  className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white"
                >
                  {stage.plates.map(p => <option key={p} value={p}>Plate {p}</option>)}
                </select>
              </label>
            )}

            {stage.filaments.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">Map filaments → slots</div>
                {stage.filaments.map((gf, i) => (
                  <div key={gf.index} className="flex items-center gap-2 bg-gray-800/60 rounded p-1.5">
                    <span
                      className="w-4 h-4 rounded border border-gray-500 shrink-0"
                      style={{ backgroundColor: gf.color ?? '#888' }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-gray-200 truncate">Filament {gf.index + 1}</div>
                      <div className="text-[10px] text-gray-500 truncate">{gf.type ?? 'unknown'}</div>
                    </div>
                    <select
                      value={mapping[i] ?? 0}
                      onChange={e => setMapping(prev => prev.map((v, idx) => idx === i ? Number(e.target.value) : v))}
                      className="bg-gray-700 border border-gray-600 rounded px-1.5 py-1 text-[11px] text-white"
                    >
                      <option value={0}>— skip —</option>
                      {slots.map(s => (
                        <option key={`${s.source}-${s.value}`} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                ))}
                {slots.length === 0 && (
                  <div className="text-[10px] text-yellow-300">
                    No slots available — {protocol === 'bambu' ? 'AMS reports empty.' : 'set Manual Slots on this printer.'}
                  </div>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-gray-200 pt-1">
              <input
                type="checkbox"
                checked={startPrint}
                onChange={e => setStartPrint(e.target.checked)}
                disabled={phase !== 'remap' && phase !== 'done'}
              />
              Start print after upload
            </label>

            {startPrint && (
              <PrintOptionsUI
                protocol={protocol}
                options={printOptions}
                onChange={setPrintOptions}
                disabled={phase !== 'remap' && phase !== 'done'}
              />
            )}

            {phase === 'remap' && (
              <button
                onClick={send}
                className="w-full px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm text-white"
              >
                Send to printer
              </button>
            )}

            {phase === 'sending' && (
              <div className="text-xs text-gray-400">Sending…</div>
            )}

            {phase === 'done' && (
              <div className="space-y-1">
                <div className="text-xs text-emerald-300 break-all">Sent: {resultPath}</div>
                <button
                  onClick={reset}
                  className="text-xs text-blue-300 hover:text-blue-200 underline"
                >
                  Upload another
                </button>
              </div>
            )}
          </>
        )}

        {phase === 'error' && (
          <div className="space-y-1">
            <div className="text-xs text-red-300 break-words">{error}</div>
            <button
              onClick={reset}
              className="text-xs text-blue-300 hover:text-blue-200 underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
