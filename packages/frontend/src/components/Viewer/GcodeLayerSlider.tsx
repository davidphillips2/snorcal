import type { GcodeColorMode } from './GcodePreviewCanvas';
import type { PausePoint } from '../../api/client';

interface GcodeLayerSliderProps {
  currentLayer: number;
  totalLayers: number;
  showAllLayers: boolean;
  onLayerChange: (layer: number) => void;
  onShowAllLayersChange: (show: boolean) => void;
  onExit: () => void;
  colorMode: GcodeColorMode;
  onColorModeChange: (mode: GcodeColorMode) => void;
  pauses: PausePoint[];
  onTogglePause: (layer: number) => void;
}

const COLOR_MODES: Array<{ key: GcodeColorMode; label: string }> = [
  { key: 'filament', label: 'Filament' },
  { key: 'lineType', label: 'Type' },
  { key: 'speed', label: 'Speed' },
];

export function GcodeLayerSlider({
  currentLayer, totalLayers,
  showAllLayers, onLayerChange, onShowAllLayersChange, onExit,
  colorMode, onColorModeChange,
  pauses, onTogglePause,
}: GcodeLayerSliderProps) {
  if (totalLayers === 0) return null;

  const pausedAtCurrent = pauses.some(p => p.layer === currentLayer);
  const sortedPauses = [...pauses].sort((a, b) => a.layer - b.layer);

  return (
    <>
      {/* Vertical layer slider on right edge */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-1 bg-gray-800/90 backdrop-blur rounded-xl border border-gray-600 px-2 py-3">
        <span className="text-[10px] text-gray-400 font-mono">{totalLayers}</span>
        <div
          className="relative"
          style={{ width: '1.5rem', height: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
        >
          <input
            type="range"
            min={0}
            max={totalLayers - 1}
            step={1}
            value={currentLayer}
            onChange={(e) => onLayerChange(parseInt(e.target.value))}
            className="bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            style={{ width: '200px', transform: 'rotate(-90deg)', transformOrigin: 'center center' }}
          />
          {/* Pause tick marks — absolute-positioned along slider */}
          {sortedPauses.map(p => {
            if (totalLayers <= 1) return null;
            const pct = (p.layer / (totalLayers - 1)) * 100;
            // Slider is rotated -90deg, so its left% (in original orientation)
            // maps to bottom% in display orientation. We invert.
            return (
              <div
                key={p.layer}
                className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-amber-400 border border-amber-200 shadow pointer-events-none"
                style={{ bottom: `calc(${pct}% - 6px)` }}
                title={`Pause at L${p.layer + 1}${p.label ? `: ${p.label}` : ''}`}
              />
            );
          })}
        </div>
        <span className="text-[10px] text-gray-400 font-mono">1</span>
        <span className="text-xs text-gray-300 font-mono mt-1">
          L{currentLayer + 1}/{totalLayers}
        </span>
        {/* Toggle pause at current layer */}
        <button
          onClick={() => onTogglePause(currentLayer)}
          className={`mt-1 px-2 py-0.5 text-[10px] rounded transition ${
            pausedAtCurrent
              ? 'bg-amber-500 text-black hover:bg-amber-400'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
          title={pausedAtCurrent ? `Remove pause at L${currentLayer + 1}` : `Add pause at L${currentLayer + 1}`}
        >
          {pausedAtCurrent ? '⏸ ON' : '+ Pause'}
        </button>
        {pauses.length > 0 && (
          <span className="text-[10px] text-amber-400 font-mono">{pauses.length} pause{pauses.length > 1 ? 's' : ''}</span>
        )}
      </div>

      {/* Bottom bar */}
      <div className="absolute bottom-2 left-2 right-14 z-10 bg-gray-800/90 backdrop-blur rounded-xl border border-gray-600 px-4 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showAllLayers}
                onChange={(e) => onShowAllLayersChange(e.target.checked)}
                className="rounded border-gray-600 bg-gray-700"
              />
              All layers
            </label>

            {/* Color mode segmented control */}
            <div className="flex items-center gap-0.5 bg-gray-900/60 rounded p-0.5">
              {COLOR_MODES.map(m => (
                <button
                  key={m.key}
                  onClick={() => onColorModeChange(m.key)}
                  className={`px-2 py-0.5 text-[10px] rounded transition ${
                    colorMode === m.key
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-400 hover:text-white'
                  }`}
                  title={`Color by ${m.label.toLowerCase()}`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {pauses.length > 0 && (
              <span className="text-[11px] text-amber-300">
                ⏸ {pauses.length} manual pause{pauses.length > 1 ? 's' : ''} — download w/ pauses enabled
              </span>
            )}
          </div>
          <button
            onClick={onExit}
            className="px-3 py-1 text-xs rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
          >
            Back to Model
          </button>
        </div>
      </div>
    </>
  );
}
