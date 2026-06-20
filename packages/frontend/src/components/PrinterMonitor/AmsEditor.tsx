import { useEffect, useMemo, useState } from 'react';
import type { AmsSlot } from '@snorcal/shared';
import * as api from '../../api/client';
import type { Spool } from '../../api/client';

interface Props {
  printerId: string;
  slot: AmsSlot;
  onClose: () => void;
  onSaved?: () => void;
}

const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS', 'PEEK', 'OTHER'];

/** Convert "#RRGGBB" (browser color input) → "RRGGBBAA" (printer protocol). */
function hexToPrinter(hex: string | null | undefined): string {
  if (!hex) return 'FFFFFFFF';
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  if (s.length === 6) return (s + 'FF').toUpperCase();
  if (s.length === 8) return s.toUpperCase();
  return 'FFFFFFFF';
}

/** Convert "RRGGBBAA" or "RRGGBB" → "#RRGGBB" for browser color input. */
function printerToHex(s: string | null | undefined): string {
  if (!s) return '#888888';
  let v = s.replace(/^#/, '');
  if (v.length === 8) v = v.slice(0, 6);
  if (v.length === 6) return '#' + v.toLowerCase();
  return '#888888';
}

export function AmsEditor({ printerId, slot, onClose, onSaved }: Props) {
  const [type, setType] = useState(slot.type ?? 'PLA');
  const [color, setColor] = useState(printerToHex(slot.color));
  const [brand, setBrand] = useState(slot.brand ?? '');
  const [spools, setSpools] = useState<Spool[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listSpools(false).then(setSpools).catch(() => {});
  }, []);

  const sortedSpools = useMemo(
    () => [...spools].sort((a, b) => a.name.localeCompare(b.name)),
    [spools],
  );

  const applySpool = (id: string) => {
    if (!id) return;
    const spool = spools.find(s => s.id === id);
    if (!spool) return;
    if (spool.material && MATERIALS.includes(spool.material.toUpperCase())) {
      setType(spool.material.toUpperCase());
    } else if (spool.material) {
      setType(spool.material);
    }
    if (spool.color) setColor(printerToHex(spool.color));
    if (spool.name) setBrand(spool.name);
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setAmsFilament(printerId, slot.id, slot.trayId, {
        type,
        color: hexToPrinter(color),
        brand,
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-white">Edit AMS Tray</h2>
            <p className="text-[11px] text-gray-500">
              Unit {slot.id} · Tray {slot.trayId}
              {slot.remain !== undefined && ` · ${slot.remain}% remain`}
            </p>
          </div>
          <button onClick={onClose}
                  className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-3">
          {error && (
            <div className="bg-red-900/40 border border-red-700 rounded px-3 py-2 text-sm text-red-200">{error}</div>
          )}

          {sortedSpools.length > 0 && (
            <label className="block">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider">Fill from inventory spool</span>
              <select
                onChange={e => { applySpool(e.target.value); e.target.value = ''; }}
                defaultValue=""
                className="mt-1 w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white"
              >
                <option value="">— pick a spool —</option>
                {sortedSpools.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.material ? ` · ${s.material}` : ''}{s.remainingWeightG ? ` · ${Math.round(s.remainingWeightG)}g` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex items-center gap-3">
            <label className="flex flex-col items-center gap-1 w-16 shrink-0">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider">Color</span>
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                className="w-12 h-12 rounded border border-gray-600 bg-transparent cursor-pointer"
              />
            </label>
            <label className="flex-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider block">Material</span>
              <select
                value={type}
                onChange={e => setType(e.target.value)}
                className="mt-1 w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white"
              >
                {MATERIALS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Brand / Name</span>
            <input
              type="text"
              value={brand}
              onChange={e => setBrand(e.target.value)}
              placeholder="e.g. Generic, Polymaker, Bambu Lab"
              className="mt-1 w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white"
            />
          </label>

          <div className="pt-1 text-[10px] text-gray-500">
            Sends <code className="text-gray-400">ams_filament_setting</code> to printer — updates tray metadata
            used for filament matching at print time.
          </div>
        </div>

        <div className="px-5 py-3 border-t border-gray-800 flex gap-2">
          <button onClick={onClose}
                  className="flex-1 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-200">Cancel</button>
          <button onClick={submit} disabled={saving}
                  className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/30 rounded text-sm text-white">
            {saving ? 'Saving…' : 'Save to tray'}
          </button>
        </div>
      </div>
    </div>
  );
}
