import { useState, useEffect, useCallback } from 'react';
import * as api from '../../api/client';
import type { Spool, PrintHistoryEntry } from '../../api/client';

interface InventoryPanelProps {
  onClose: () => void;
}

type Tab = 'spools' | 'history';

const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA (Nylon)', 'PC', 'PVA', 'HIPS', 'CF'];

export function InventoryPanel({ onClose }: InventoryPanelProps) {
  const [tab, setTab] = useState<Tab>('spools');

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-100">Inventory</h2>
            <div className="flex bg-gray-800 rounded ml-2">
              {(['spools', 'history'] as Tab[]).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1 text-xs rounded transition ${tab === t ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                  {t === 'spools' ? 'Spools' : 'Print History'}
                </button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'spools' ? <SpoolsTab /> : <HistoryTab />}
        </div>
      </div>
    </div>
  );
}

function SpoolsTab() {
  const [spools, setSpools] = useState<Spool[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Spool | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setSpools(await api.listSpools(showArchived));
  }, [showArchived]);

  useEffect(() => { refresh(); }, [refresh]);

  const totalRemaining = spools.reduce((a, s) => a + s.remainingWeightG, 0);
  const totalValue = spools.reduce((a, s) => a + (s.remainingWeightG / 1000) * s.costPerKg, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-400">
          {spools.length} spools · {totalRemaining.toFixed(0)}g remaining · ${totalValue.toFixed(2)} value
        </div>
        <div className="flex gap-2">
          <label className="flex items-center gap-1 text-xs text-gray-400">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="accent-blue-500" />
            Archived
          </label>
          <button onClick={() => setCreating(true)} className="px-2 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 rounded text-white">+ Spool</button>
        </div>
      </div>

      <div className="space-y-1">
        {spools.map(s => (
          <div key={s.id} className="flex items-center gap-3 p-2 bg-gray-800/50 rounded">
            <span className="w-4 h-4 rounded-full shrink-0 border border-gray-500" style={{ backgroundColor: s.color ?? '#888' }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-200 truncate">{s.name}</span>
                {s.material && <span className="text-[10px] text-gray-500">{s.material}</span>}
                {s.archived && <span className="text-[10px] text-yellow-500">archived</span>}
              </div>
              <div className="text-[11px] text-gray-500 tabular-nums">
                {s.remainingWeightG.toFixed(0)}g / {s.totalWeightG.toFixed(0)}g
                {s.costPerKg > 0 && <> · ${s.costPerKg.toFixed(2)}/kg</>}
              </div>
              <div className="h-1 bg-gray-900 rounded overflow-hidden mt-1">
                <div className="h-full bg-blue-500" style={{ width: `${Math.min(100, (s.remainingWeightG / s.totalWeightG) * 100)}%` }} />
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              <button onClick={() => setEditing(s)} className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300">Edit</button>
              <button onClick={async () => {
                await api.updateSpool(s.id, { remainingWeightG: Math.max(0, s.remainingWeightG - 10) });
                refresh();
              }} className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300" title="Deduct 10g">−10g</button>
            </div>
          </div>
        ))}
        {spools.length === 0 && (
          <div className="text-center text-gray-500 text-sm py-8">No spools. Click "+ Spool" to add one.</div>
        )}
      </div>

      {(editing || creating) && (
        <SpoolEditor
          spool={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); refresh(); }}
        />
      )}
    </div>
  );
}

function SpoolEditor({ spool, onClose, onSaved }: { spool: Spool | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(spool?.name ?? '');
  const [color, setColor] = useState(spool?.color ?? '#888888');
  const [material, setMaterial] = useState(spool?.material ?? 'PLA');
  const [totalG, setTotalG] = useState(spool?.totalWeightG ?? 1000);
  const [remainingG, setRemainingG] = useState(spool?.remainingWeightG ?? 1000);
  const [costPerKg, setCostPerKg] = useState(spool?.costPerKg ?? 0);
  const [notes, setNotes] = useState(spool?.notes ?? '');
  const [archived, setArchived] = useState(spool?.archived ?? false);

  const save = async () => {
    const payload = { name, color, material, totalWeightG: totalG, remainingWeightG: remainingG, costPerKg, notes, archived };
    if (spool) await api.updateSpool(spool.id, payload);
    else await api.createSpool(payload);
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 rounded-lg p-4 w-full max-w-md space-y-2" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-gray-100">{spool ? 'Edit Spool' : 'New Spool'}</h3>
        <Field label="Name"><input type="text" value={name} onChange={e => setName(e.target.value)} className={inputCls} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Color"><input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-full h-8 rounded bg-gray-800" /></Field>
          <Field label="Material">
            <select value={material} onChange={e => setMaterial(e.target.value)} className={inputCls}>
              {MATERIALS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Total (g)"><input type="number" value={totalG} onChange={e => setTotalG(Number(e.target.value))} className={inputCls} /></Field>
          <Field label="Remaining (g)"><input type="number" value={remainingG} onChange={e => setRemainingG(Number(e.target.value))} className={inputCls} /></Field>
          <Field label="$/kg"><input type="number" step="0.01" value={costPerKg} onChange={e => setCostPerKg(Number(e.target.value))} className={inputCls} /></Field>
        </div>
        <Field label="Notes"><textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className={inputCls} /></Field>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} className="accent-blue-500" />
          Archived (out of rotation)
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300">Cancel</button>
          <button onClick={save} className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded text-white">Save</button>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</label>
      {children}
    </div>
  );
}

function HistoryTab() {
  const [entries, setEntries] = useState<PrintHistoryEntry[]>([]);
  const [editing, setEditing] = useState<PrintHistoryEntry | null>(null);

  const refresh = useCallback(async () => { setEntries(await api.listPrintHistory()); }, []);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-400">{entries.length} prints logged</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {entries.map(h => (
          <div key={h.id} className="bg-gray-800/50 rounded p-2 space-y-1">
            {h.photoUrl ? (
              <img src={h.photoUrl} alt={h.modelName ?? ''} className="w-full h-24 object-cover rounded" />
            ) : (
              <div className="w-full h-24 bg-gray-900/50 rounded flex items-center justify-center text-gray-600 text-xs">no photo</div>
            )}
            <div className="text-xs text-gray-200 truncate" title={h.modelName ?? ''}>{h.modelName ?? '(unknown)'}</div>
            <div className="flex items-center justify-between text-[10px] text-gray-500">
              <span>{new Date(h.completedAt).toLocaleDateString()}</span>
              <span className="text-yellow-400">{'★'.repeat(h.rating ?? 0)}<span className="text-gray-700">{'★'.repeat(5 - (h.rating ?? 0))}</span></span>
            </div>
            {h.notes && <div className="text-[10px] text-gray-400 line-clamp-2">{h.notes}</div>}
            <div className="flex gap-1">
              <button onClick={() => setEditing(h)} className="flex-1 px-2 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 rounded text-gray-300">Edit</button>
              <button onClick={async () => { await api.deletePrintHistory(h.id); refresh(); }} className="px-2 py-0.5 text-[10px] bg-gray-700 hover:bg-red-700 rounded text-gray-300">×</button>
            </div>
          </div>
        ))}
        {entries.length === 0 && (
          <div className="col-span-full text-center text-gray-500 text-sm py-8">No print history yet.</div>
        )}
      </div>

      {editing && (
        <HistoryEditor
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function HistoryEditor({ entry, onClose, onSaved }: { entry: PrintHistoryEntry; onClose: () => void; onSaved: () => void }) {
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [rating, setRating] = useState(entry.rating ?? 0);

  const save = async () => {
    await api.updatePrintHistory(entry.id, { notes, rating });
    onSaved();
  };

  const uploadPhoto = async (file: File) => {
    await api.uploadPrintHistoryPhoto(entry.id, file);
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 rounded-lg p-4 w-full max-w-md space-y-2" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-gray-100">Edit Print</h3>
        <div className="text-xs text-gray-500">{entry.modelName} · {new Date(entry.completedAt).toLocaleString()}</div>
        <Field label="Rating">
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => setRating(n)} className={`text-xl ${n <= rating ? 'text-yellow-400' : 'text-gray-700'}`}>★</button>
            ))}
          </div>
        </Field>
        <Field label="Notes"><textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className={inputCls} /></Field>
        <Field label="Photo">
          <input type="file" accept="image/*" onChange={e => {
            const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = '';
          }} className="text-xs text-gray-400" />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300">Cancel</button>
          <button onClick={save} className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded text-white">Save</button>
        </div>
      </div>
    </div>
  );
}
