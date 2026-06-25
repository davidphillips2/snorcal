import type { PrintOptions } from '@snorcal/shared';

interface Props {
  protocol: 'bambu' | 'moonraker';
  options: PrintOptions;
  onChange: (o: PrintOptions) => void;
  disabled?: boolean;
}

interface ToggleDef {
  key: keyof PrintOptions;
  label: string;
  hint: string;
}

const BAMBU_TOGGLES: ToggleDef[] = [
  { key: 'timelapse', label: 'Timelapse', hint: 'Record video timelapse of print' },
  { key: 'bedLeveling', label: 'Bed leveling', hint: 'Run ABL probe before print' },
  { key: 'flowCali', label: 'Flow calibration', hint: 'Dynamic flow rate test' },
  { key: 'vibrationCali', label: 'Vibration calibration', hint: 'Measure input shaping resonance' },
];

const KLIPPER_TOGGLES: ToggleDef[] = [
  { key: 'timelapse', label: 'Timelapse', hint: 'Prompt to record timelapse' },
  { key: 'bedLeveling', label: 'Bed leveling', hint: 'Prompt to run bed mesh' },
];

export function PrintOptions({ protocol, options, onChange, disabled }: Props) {
  const toggles = protocol === 'bambu' ? BAMBU_TOGGLES : KLIPPER_TOGGLES;
  if (toggles.length === 0) return null;

  const toggle = (key: keyof PrintOptions) => {
    if (disabled) return;
    onChange({ ...options, [key]: !options[key] });
  };

  return (
    <div className="space-y-1.5 pt-1">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Pre-print options</div>
      <div className="space-y-1">
        {toggles.map(t => (
          <label
            key={t.key}
            className={`flex items-center gap-2 bg-gray-800/60 rounded p-1.5 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
          >
            <input
              type="checkbox"
              checked={options[t.key] === true}
              onChange={() => toggle(t.key)}
              disabled={disabled}
              className="accent-emerald-500"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-gray-200">{t.label}</div>
              <div className="text-[10px] text-gray-500 truncate">{t.hint}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
