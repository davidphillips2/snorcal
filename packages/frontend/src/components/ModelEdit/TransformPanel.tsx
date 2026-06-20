import { useState } from 'react';
import type { ProjectModel } from '../../App';
import type { Scale3D, Mirror3D, ModelKind } from '@slorca/shared';

interface TransformPanelProps {
  model: ProjectModel | null;
  boundsMM?: { x: number; y: number; z: number };
  onUpdate: (patch: Partial<ProjectModel>) => void;
  onDuplicate: () => void;
  onLinearArray: (count: number, dx: number, dy: number) => void;
  onCircularArray: (count: number, radius: number) => void;
  onAddVolume?: (kind: ModelKind) => void;
}

const AXES: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];

export function TransformPanel({
  model, boundsMM, onUpdate, onDuplicate, onLinearArray, onCircularArray, onAddVolume,
}: TransformPanelProps) {
  const [uniform, setUniform] = useState(true);
  const [arrCount, setArrCount] = useState(3);
  const [arrDx, setArrDx] = useState(10);
  const [arrDy, setArrDy] = useState(0);
  const [circCount, setCircCount] = useState(6);
  const [circRadius, setCircRadius] = useState(20);

  const disabled = !model;

  const scale = model?.scale ?? { x: 1, y: 1, z: 1 };
  const mirror = model?.mirror ?? { x: false, y: false, z: false };

  const setScale = (axis: 'x' | 'y' | 'z', value: number) => {
    if (!model) return;
    const next: Scale3D = uniform
      ? { x: value, y: value, z: value }
      : { ...scale, [axis]: value };
    onUpdate({ scale: next });
  };

  const toggleMirror = (axis: 'x' | 'y' | 'z') => {
    if (!model) return;
    const next: Mirror3D = { ...mirror, [axis]: !mirror[axis] };
    onUpdate({ mirror: next });
  };

  return (
    <div className="absolute top-14 left-2 bg-gray-800/95 backdrop-blur rounded-lg px-3 py-2.5 shadow-lg z-20 w-64 space-y-2.5">
      <Section title="Mirror">
        <div className="flex gap-1">
          {AXES.map(axis => (
            <button
              key={axis}
              onClick={() => toggleMirror(axis)}
              disabled={disabled}
              className={`flex-1 py-1 rounded text-xs font-medium transition ${
                mirror[axis]
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {axis.toUpperCase()} {mirror[axis] ? '✓' : ''}
            </button>
          ))}
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
                value={Number(scale[axis].toFixed(3))}
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
