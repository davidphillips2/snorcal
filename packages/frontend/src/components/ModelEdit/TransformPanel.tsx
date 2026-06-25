import { useState } from 'react';
import type { ProjectModel } from '../../App';
import type { Scale3D, Mirror3D, Rotation3D, ModelKind } from '@snorcal/shared';
// Rotation3D re-exported from @snorcal/shared/types/job — same shape as STLViewer's.

interface TransformPanelProps {
  /** Selected models on the active plate (length 0/1/N). */
  selectedModels: ProjectModel[];
  /** Update every selected model with the same patch. */
  onUpdateAll: (patch: Partial<ProjectModel>) => void;
  /** Reset all selected models to rest transforms (origin). */
  onResetOrigin: () => void;
  boundsMM?: { x: number; y: number; z: number };
  onDuplicate: () => void;
  onLinearArray: (count: number, dx: number, dy: number) => void;
  onCircularArray: (count: number, radius: number) => void;
  onAddVolume?: (kind: ModelKind) => void;
}

const AXES: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];

/**
 * Returns the common value of `get(model)` across all selected models, or
 * undefined when values differ (mixed). Used to render empty/placeholder
 * state in multi-select numeric fields.
 */
function common<T>(models: ProjectModel[], get: (m: ProjectModel) => T): T | undefined {
  if (models.length === 0) return undefined;
  const first = get(models[0]);
  for (let i = 1; i < models.length; i++) {
    if (get(models[i]) !== first) return undefined;
  }
  return first;
}

export function TransformPanel({
  selectedModels, onUpdateAll, onResetOrigin, boundsMM,
  onDuplicate, onLinearArray, onCircularArray, onAddVolume,
}: TransformPanelProps) {
  const [uniform, setUniform] = useState(true);
  const [arrCount, setArrCount] = useState(3);
  const [arrDx, setArrDx] = useState(10);
  const [arrDy, setArrDy] = useState(0);
  const [circCount, setCircCount] = useState(6);
  const [circRadius, setCircRadius] = useState(20);

  const n = selectedModels.length;
  const disabled = n === 0;
  // Per-axis scale: if all models share the same value show it; else undefined
  // (renders as empty input — user types to overwrite all).
  const scaleCommon = common(selectedModels, m => JSON.stringify(m.scale));
  const scale: Scale3D = scaleCommon
    ? JSON.parse(scaleCommon)
    : selectedModels[0]?.scale ?? { x: 1, y: 1, z: 1 };
  const scaleMixed = !scaleCommon;
  const mirrorCommon = common(selectedModels, m => JSON.stringify(m.mirror));
  const mirror: Mirror3D = mirrorCommon
    ? JSON.parse(mirrorCommon)
    : selectedModels[0]?.mirror ?? { x: false, y: false, z: false };
  const mirrorMixed = !mirrorCommon;
  const rotCommon = common(selectedModels, m => JSON.stringify(m.rotation));
  const rotation: Rotation3D = rotCommon
    ? JSON.parse(rotCommon)
    : selectedModels[0]?.rotation ?? { x: 0, y: 0, z: 0 };
  const rotMixed = !rotCommon;

  const setScale = (axis: 'x' | 'y' | 'z', value: number) => {
    const next: Scale3D = uniform
      ? { x: value, y: value, z: value }
      : { x: axis === 'x' ? value : scale.x,
          y: axis === 'y' ? value : scale.y,
          z: axis === 'z' ? value : scale.z };
    onUpdateAll({ scale: next });
  };

  const toggleMirror = (axis: 'x' | 'y' | 'z') => {
    // For multi-select with mixed values, the button reflects the common
    // state only when uniform; otherwise clicking sets all to !axis-primary.
    const base: Mirror3D = mirrorMixed
      ? { x: false, y: false, z: false }
      : mirror;
    onUpdateAll({ mirror: { ...base, [axis]: !base[axis] } });
  };

  const setRotation = (axis: 'x' | 'y' | 'z', value: number) => {
    const base: Rotation3D = rotMixed ? { x: 0, y: 0, z: 0 } : rotation;
    onUpdateAll({ rotation: { ...base, [axis]: value } });
  };

  return (
    <div className="absolute top-14 left-2 bg-gray-800/95 backdrop-blur rounded-lg px-3 py-2.5 shadow-lg z-20 w-64 space-y-2.5">
      {n > 1 && (
        <div className="text-[10px] uppercase tracking-wide text-blue-300 bg-blue-900/30 rounded px-2 py-1">
          {n} models selected — edits apply to all
        </div>
      )}

      <Section title="Position">
        <button
          onClick={onResetOrigin}
          disabled={disabled}
          className="w-full py-1 rounded text-xs bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Reset to Origin
        </button>
      </Section>

      <Section title="Rotation (°)">
        <div className="flex items-center gap-1.5">
          {AXES.map(axis => (
            <div key={axis} className="flex items-center gap-1">
              <span className="text-xs font-medium text-gray-400 w-3">{axis.toUpperCase()}</span>
              <input
                type="number"
                step="1"
                value={rotMixed ? '' : Number(rotation[axis].toFixed(1))}
                placeholder={rotMixed ? '–' : undefined}
                disabled={disabled}
                onChange={(e) => setRotation(axis, Number(e.target.value) || 0)}
                className="w-14 bg-gray-700 border border-gray-600 rounded px-1.5 py-1 text-xs text-white text-center disabled:opacity-40"
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Mirror">
        <div className="flex gap-1">
          {AXES.map(axis => {
            const active = !mirrorMixed && mirror[axis];
            return (
              <button
                key={axis}
                onClick={() => toggleMirror(axis)}
                disabled={disabled}
                className={`flex-1 py-1 rounded text-xs font-medium transition ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                } disabled:opacity-40 disabled:cursor-not-allowed ${mirrorMixed ? 'ring-1 ring-yellow-600/40' : ''}`}
              >
                {axis.toUpperCase()} {active ? '✓' : ''}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Scale">
        <div className="flex items-center gap-1.5">
          {AXES.map(axis => (
            <div key={axis} className="flex items-center gap-1">
              <span className="text-xs font-medium text-gray-400 w-3">{axis.toUpperCase()}</span>
              <input
                type="number"
                step="0.1"
                min="0.01"
                value={scaleMixed ? '' : Number(scale[axis].toFixed(3))}
                placeholder={scaleMixed ? '–' : undefined}
                disabled={disabled}
                onChange={(e) => setScale(axis, Number(e.target.value) || 0.01)}
                className="w-14 bg-gray-700 border border-gray-600 rounded px-1.5 py-1 text-xs text-white text-center disabled:opacity-40"
              />
            </div>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs text-gray-300 mt-1">
          <input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.target.checked)} />
          Uniform
        </label>
      </Section>

      <Section title="Duplicate">
        <button
          onClick={onDuplicate}
          disabled={disabled}
          className="w-full py-1 rounded text-xs bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Duplicate
        </button>
      </Section>

      {onAddVolume && (
        <Section title="Volumes">
          <div className="flex gap-1">
            <button
              onClick={() => onAddVolume('negative')}
              disabled={disabled}
              className="flex-1 py-1 rounded text-xs bg-red-700/70 text-red-50 hover:bg-red-600/70 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              + Negative
            </button>
            <button
              onClick={() => onAddVolume('modifier')}
              disabled={disabled}
              className="flex-1 py-1 rounded text-xs bg-blue-700/70 text-blue-50 hover:bg-blue-600/70 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              + Modifier
            </button>
          </div>
        </Section>
      )}

      <Section title="Linear Array">
        <div className="flex items-center gap-1.5">
          <NumField label="N" value={arrCount} min={1} max={50} onChange={setArrCount} />
          <NumField label="ΔX" value={arrDx} onChange={setArrDx} />
          <NumField label="ΔY" value={arrDy} onChange={setArrDy} />
        </div>
        <button
          onClick={() => onLinearArray(arrCount, arrDx, arrDy)}
          disabled={disabled || arrCount < 2}
          className="w-full py-1 rounded text-xs bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed mt-1"
        >
          Array
        </button>
      </Section>

      <Section title="Circular Array">
        <div className="flex items-center gap-1.5">
          <NumField label="N" value={circCount} min={2} max={50} onChange={setCircCount} />
          <NumField label="R" value={circRadius} min={0} onChange={setCircRadius} />
        </div>
        <button
          onClick={() => onCircularArray(circCount, circRadius)}
          disabled={disabled || circCount < 2}
          className="w-full py-1 rounded text-xs bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed mt-1"
        >
          Array
        </button>
      </Section>

      {boundsMM && (
        <div className="text-[10px] text-gray-500 pt-1 border-t border-gray-700">
          Bounds: {boundsMM.x.toFixed(0)} × {boundsMM.y.toFixed(0)} × {boundsMM.z.toFixed(0)} mm
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">{title}</div>
      {children}
    </div>
  );
}

function NumField({ label, value, onChange, min, max }: {
  label: string; value: number; onChange: (n: number) => void; min?: number; max?: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-medium text-gray-400 w-3">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="w-14 bg-gray-700 border border-gray-600 rounded px-1 py-0.5 text-xs text-white text-center"
      />
    </div>
  );
}
