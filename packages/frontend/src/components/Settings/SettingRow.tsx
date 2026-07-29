import { memo } from 'react';
import type { SettingDef } from './settings-definitions';

interface SettingRowProps {
  def: SettingDef;
  value: string;
  onChange: (value: string) => void;
}

/** Label + optional help tooltip. Help uses native title (hover) so it works
 *  without a tooltip library and is keyboard-focusable via the button. */
function SettingLabel({ def }: { def: SettingDef }) {
  if (!def.help) {
    return <span className="text-xs text-gray-400 truncate mr-2" title={def.label}>{def.label}</span>;
  }
  return (
    <span className="flex items-center gap-1 min-w-0 mr-2">
      <span className="text-xs text-gray-400 truncate" title={def.label}>{def.label}</span>
      <span
        className="shrink-0 w-3.5 h-3.5 rounded-full border border-gray-500 text-gray-400 flex items-center justify-center text-[9px] leading-none cursor-help"
        role="img"
        aria-label={`${def.label}: ${def.help}`}
        title={def.help}
      >
        ?
      </span>
    </span>
  );
}

export const SettingRow = memo(function SettingRow({ def, value, onChange }: SettingRowProps) {
  const { type } = def;

  if (type === 'toggle') {
    const isOn = value === '1';
    return (
      <div className="flex items-center justify-between py-0.5">
        <SettingLabel def={def} />
        <button
          type="button"
          onClick={() => onChange(isOn ? '0' : '1')}
          className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${isOn ? 'bg-blue-600' : 'bg-gray-600'}`}
          aria-label={def.label}
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
        <SettingLabel def={def} />
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
        <div className="mb-0.5"><SettingLabel def={def} /></div>
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
        <SettingLabel def={def} />
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
      <SettingLabel def={def} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-xs text-white w-24 text-right shrink-0"
      />
    </div>
  );
});
