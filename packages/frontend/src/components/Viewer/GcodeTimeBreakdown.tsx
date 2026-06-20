import { useMemo, useState } from 'react';
import { analyzeGcodeTime, formatDuration, typeColor } from '../../lib/gcode-stats';

interface GcodeTimeBreakdownProps {
  gcode: string;
}

/**
 * Stacked-bar breakdown of print time per gcode `;TYPE:` section.
 * Collapsible overlay shown alongside the gcode preview.
 */
export function GcodeTimeBreakdown({ gcode }: GcodeTimeBreakdownProps) {
  const [open, setOpen] = useState(false);
  const entries = useMemo(() => analyzeGcodeTime(gcode).slice(0, 10), [gcode]);
  const total = entries.reduce((a, b) => a + b.seconds, 0);
  if (entries.length === 0) return null;

  return (
    <div className="absolute top-2 right-2 z-20 w-60 max-w-[60vw] bg-gray-900/85 backdrop-blur rounded-lg shadow-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-left"
      >
        <span className="text-xs font-semibold text-gray-200">
          Time breakdown · {formatDuration(total)}
        </span>
        <span className="text-gray-500 text-xs">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-0.5">
          {/* Stacked bar */}
          <div className="flex h-1.5 w-full rounded overflow-hidden bg-gray-800">
            {entries.map(e => (
              <div
                key={e.type}
                style={{ width: `${e.fraction * 100}%`, backgroundColor: typeColor(e.type) }}
                title={`${e.type}: ${formatDuration(e.seconds)}`}
              />
            ))}
          </div>

          {entries.map(e => (
            <div key={e.type} className="flex items-center gap-1.5 py-0.5 text-[11px]">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: typeColor(e.type) }}
              />
              <span className="text-gray-300 capitalize flex-1 truncate">{e.type}</span>
              <span className="text-gray-400 tabular-nums">{(e.fraction * 100).toFixed(1)}%</span>
              <span className="text-gray-200 tabular-nums w-14 text-right">{formatDuration(e.seconds)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
