import { useState } from 'react';
import * as THREE from 'three';
import type { ModelKind } from '@snorcal/shared';
import { geometryToSTL } from '../../lib/stl-export';

type Primitive = 'box' | 'cylinder' | 'sphere';

interface AddVolumeModalProps {
  kind: ModelKind;  // 'negative' or 'modifier'
  onAdd: (file: File, settings?: Record<string, unknown>) => void;
  onCancel: () => void;
}

const PRIMITIVES: { key: Primitive; label: string }[] = [
  { key: 'box', label: 'Box' },
  { key: 'cylinder', label: 'Cylinder' },
  { key: 'sphere', label: 'Sphere' },
];

/**
 * Primitive picker for adding negative/modifier volumes. Generates the
 * geometry client-side, exports to STL, and hands the File back to the parent.
 * For modifier volumes, an optional settings-override panel is shown.
 */
export function AddVolumeModal({ kind, onAdd, onCancel }: AddVolumeModalProps) {
  const [prim, setPrim] = useState<Primitive>('box');
  const [box, setBox] = useState({ x: 20, y: 20, z: 20 });
  const [radius, setRadius] = useState(10);
  const [height, setHeight] = useState(20);
  const [busy, setBusy] = useState(false);

  // Modifier settings
  const [layerHeight, setLayerHeight] = useState<string>('');
  const [infill, setInfill] = useState<string>('');
  const [wallLoops, setWallLoops] = useState<string>('');
  const [support, setSupport] = useState<boolean | ''>('');

  const buildGeometry = (): THREE.BufferGeometry => {
    let geo: THREE.BufferGeometry;
    if (prim === 'box') {
      geo = new THREE.BoxGeometry(box.x, box.y, box.z);
    } else if (prim === 'cylinder') {
      geo = new THREE.CylinderGeometry(radius, radius, height, 32);
      // Cylinder is along Y in three.js — already what we want (bed normal)
    } else {
      geo = new THREE.SphereGeometry(radius, 32, 16);
    }
    // Center on X/Z, bottom at Y=0 so it sits on plate like other models
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    geo.translate(-cx, -bb.min.y, -cz);
    geo.computeVertexNormals();
    return geo;
  };

  const handleAdd = async () => {
    setBusy(true);
    try {
      const geo = buildGeometry();
      const kindLabel = kind === 'modifier' ? 'modifier' : 'negative';
      const file = geometryToSTL(geo, new THREE.Matrix4(), `${kindLabel}_${prim}.stl`);

      let settings: Record<string, unknown> | undefined;
      if (kind === 'modifier') {
        const s: Record<string, unknown> = {};
        if (layerHeight) s.layer_height = layerHeight;
        if (infill) s.sparse_infill_density = infill;
        if (wallLoops) s.wall_loops = wallLoops;
        if (support !== '') s.enable_support = support ? '1' : '0';
        if (Object.keys(s).length > 0) settings = s;
      }
      onAdd(file, settings);
    } finally {
      setBusy(false);
    }
  };

  const title = kind === 'modifier' ? 'Add Modifier Volume' : 'Add Negative Volume';
  const accent = kind === 'modifier' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-red-600 hover:bg-red-500';

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={onCancel}>
      <div
        className="bg-gray-800 rounded-lg shadow-2xl w-80 p-5 space-y-4 border border-gray-700"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-white font-medium">{title}</h2>
          <button onClick={onCancel} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Shape</div>
          <div className="flex gap-1">
            {PRIMITIVES.map(p => (
              <button
                key={p.key}
                onClick={() => setPrim(p.key)}
                className={`flex-1 py-1.5 rounded text-xs font-medium ${
                  prim === p.key ? 'bg-gray-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          {prim === 'box' && (
            <div className="grid grid-cols-3 gap-2">
              {(['x', 'y', 'z'] as const).map(axis => (
                <NumInput key={axis} label={`${axis.toUpperCase()} (mm)`} value={box[axis]}
                  onChange={(v) => setBox(b => ({ ...b, [axis]: v }))} />
              ))}
            </div>
          )}
          {prim === 'cylinder' && (
            <div className="grid grid-cols-2 gap-2">
              <NumInput label="Radius (mm)" value={radius} onChange={setRadius} />
              <NumInput label="Height (mm)" value={height} onChange={setHeight} />
            </div>
          )}
          {prim === 'sphere' && (
            <NumInput label="Radius (mm)" value={radius} onChange={setRadius} />
          )}
        </div>

        {kind === 'modifier' && (
          <details className="text-xs">
            <summary className="text-gray-400 cursor-pointer">Override settings (optional)</summary>
            <div className="space-y-2 mt-2">
              <TextInput label="Layer height (mm)" value={layerHeight} onChange={setLayerHeight} placeholder="0.2" />
              <TextInput label="Infill density (%)" value={infill} onChange={setInfill} placeholder="15" />
              <TextInput label="Wall loops" value={wallLoops} onChange={setWallLoops} placeholder="2" />
              <div className="flex items-center gap-2">
                <span className="text-gray-400 w-28">Support</span>
                <select
                  value={String(support)}
                  onChange={(e) => setSupport(e.target.value === '' ? '' : e.target.value === '1')}
                  className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
                >
                  <option value="">inherit</option>
                  <option value="0">off</option>
                  <option value="1">on</option>
                </select>
              </div>
            </div>
          </details>
        )}

        <button
          onClick={handleAdd}
          disabled={busy}
          className={`w-full py-2 rounded text-white text-sm ${accent} disabled:opacity-50`}
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function NumInput({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="block">
      <span className="text-[10px] text-gray-400">{label}</span>
      <input
        type="number"
        value={value}
        min={0.1}
        onChange={(e) => onChange(Number(e.target.value) || 0.1)}
        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
      />
    </label>
  );
}

function TextInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (s: string) => void; placeholder?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-400 w-28">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
      />
    </div>
  );
}
