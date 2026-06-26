import { useState } from 'react';
import type { PrinterRecord } from '@snorcal/shared';
import * as api from '../../api/client';

interface Props {
  printer: PrinterRecord;
  onSaved: () => void;
}

interface ManualFilamentEntry {
  color: string;
  type: string;
  brand?: string;
  remain?: number;
}

const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS', 'PEEK', 'OTHER'];

function pad(arr: ManualFilamentEntry[], n: number): ManualFilamentEntry[] {
  const base = (arr ?? []).slice(0, n);
  while (base.length < n) {
    base.push({ color: '#888888', type: 'PLA' });
  }
  return base;
}

function printerToHex(s: string | null | undefined): string {
  if (!s) return '#888888';
  let v = s.replace(/^#/, '');
  if (v.length === 8) v = v.slice(0, 6);
  if (v.length === 6) return '#' + v.toLowerCase();
  return '#888888';
}

function hexToPrinter(hex: string): string {
  let s = hex.replace(/^#/, '');
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  if (s.length === 6) return (s + 'FF').toUpperCase();
  return 'FFFFFFFF';
}

export function ManualFilamentsEditor({ printer, onSaved }: Props) {
  const [count, setCount] = useState(printer.manualSlots ?? 0);
  const [slots, setSlots] = useState<ManualFilamentEntry[]>(pad(printer.manualFilaments ?? [], printer.manualSlots ?? 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resize = (n: number) => {
    const clamped = Math.max(0, Math.min(16, n));
    setCount(clamped);
    setSlots(prev => pad(prev, clamped));
  };

  const update = (i: number, patch: Partial<ManualFilamentEntry>) => {
    setSlots(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updatePrinter(printer.id, {
        manualSlots: count,
        manualFilaments: pad(slots, count),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded px-3 py-2 text-xs text-red-200">{error}</div>
      )}

      <div className="flex items-center gap-2 text-xs text-gray-300">
        <span className="text-gray-500 uppercase tracking-wider w-16">Slots</span>
        <button
          onClick={() => resize(count - 1)}
          className="w-7 h-7 bg-gray-700 hover:bg-gray-600 rounded text-white"
          disabled={saving}
        >−</button>
        <span className="w-8 text-center text-white">{count}</span>
        <button
          onClick={() => resize(count + 1)}
          className="w-7 h-7 bg-gray-700 hover:bg-gray-600 rounded text-white"
          disabled={saving}
        >+</button>
        <span className="text-[10px] text-gray-500 ml-2">Drives T0/T1/… tool changes when slicing for this printer</span>
      </div>

      {slots.length === 0 && (
        <div className="text-xs text-gray-500">
          No manual slots. Add one so Snorcal knows which filament is loaded.
        </div>
      )}

      <div className="space-y-1.5">
        {slots.map((s, i) => (
          <div key={i} className="flex items-center gap-2 bg-gray-800/60 rounded p-1.5">
            <span className="text-[10px] text-gray-500 w-6 shrink-0">T{i}</span>
            <input
              type="color"
              value={printerToHex(s.color)}
              onChange={e => update(i, { color: hexToPrinter(e.target.value) })}
              className="w-8 h-8 rounded border border-gray-600 bg-transparent cursor-pointer shrink-0"
            />
            <select
              value={MATERIALS.includes((s.type ?? '').toUpperCase()) ? s.type!.toUpperCase() : 'OTHER'}
              onChange={e => update(i, { type: e.target.value })}
              className="bg-gray-700 border border-gray-600 rounded px-1.5 py-1 text-[11px] text-white w-20"
            >
              {MATERIALS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <input
              type="text"
              value={s.brand ?? ''}
              onChange={e => update(i, { brand: e.target.value })}
              placeholder="brand"
              className="flex-1 min-w-0 bg-gray-700 border border-gray-600 rounded px-1.5 py-1 text-[11px] text-white placeholder-gray-500"
            />
            <input
              type="number"
              min={0}
              max={100}
              value={s.remain ?? ''}
              onChange={e => update(i, { remain: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="%"
              className="w-12 bg-gray-700 border border-gray-600 rounded px-1.5 py-1 text-[11px] text-white placeholder-gray-500"
            />
          </div>
        ))}
      </div>

      <button
        onClick={submit}
        disabled={saving}
        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/30 rounded text-xs text-white"
      >
        {saving ? 'Saving…' : 'Save slots'}
      </button>
    </div>
  );
}
