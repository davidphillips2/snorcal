import { memo } from 'react';
import type { SettingDef } from './settings-definitions';

interface SettingRowProps {
  def: SettingDef;
  value: string;
  onChange: (value: string) => void;
}

export const SettingRow = memo(function SettingRow({ def, value, onChange }: SettingRowProps) {
  const { type, label } = def;

  if (type === 'toggle') {
    const isOn = value === '1';
    return (
      <div className="flex items-center justify-between py-0.5">
        <span className="text-xs text-gray-400 truncate mr-2" title={label}>{label}</span>
        <button
          type="button"
          onClick={() => onChange(isOn ? '0' : '1')}
          className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${isOn ? 'bg-blue-600' : 'bg-gray-600'}`}
          aria-label={label}
        >
          <span
            className={`absolute left-0.5 top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${isOn ? 'translate-x-4' : 'translate-x-0'}`}
          />
        </button>
      </div>
    );
  }

  if (type === 'select') {
    return (
      <div className="flex items-center justify-between py-0.5">
        <span className="text-xs text-gray-400 truncate mr-2" title={label}>{label}</span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-xs text-white w-32 shrink-0"
        >
          {def.options?.map((opt) => (
            <option key={opt} value={opt}>
              {def.optionLabels?.[opt] ?? opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (type === 'textarea') {
    return (
      <div className="py-0.5">
        <span className="text-xs text-gray-400 block mb-0.5" title={label}>{label}</span>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="w-full bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-xs text-white font-mono resize-y"
        />
      </div>
    );
  }

  if (type === 'number') {
    return (
      <div className="flex items-center justify-between py-0.5">
        <span className="text-xs text-gray-400 truncate mr-2" title={label}>{label}</span>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          step={def.step}
          className="bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-xs text-white w-20 text-right shrink-0"
        />
      </div>
    );
  }

  // text
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-xs text-gray-400 truncate mr-2" title={label}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-xs text-white w-24 text-right shrink-0"
      />
    </div>
  );
});
