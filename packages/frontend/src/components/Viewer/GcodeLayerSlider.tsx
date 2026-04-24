import type { MoveType } from '../../lib/gcode-parser';

const TYPE_LABELS: Record<MoveType, string> = {
  outer_wall: 'Walls',
  inner_wall: 'Inner',
  infill: 'Infill',
  top_surface: 'Top',
  bottom_surface: 'Bottom',
  solid_infill: 'Solid',
  bridge: 'Bridge',
  support: 'Support',
  skirt: 'Skirt',
  travel: 'Travel',
  other: 'Other',
};

const TYPE_COLORS: Record<MoveType, string> = {
  outer_wall: '#ff3333',
  inner_wall: '#ffcc00',
  infill: '#33cc33',
  top_surface: '#00cccc',
  bottom_surface: '#6699ff',
  solid_infill: '#33b233',
  bridge: '#ff9900',
  support: '#9966ff',
  skirt: '#999999',
  travel: '#666666',
  other: '#808080',
};

interface GcodeLayerSliderProps {
  currentLayer: number;
  totalLayers: number;
  currentZ: number;
  maxZ: number;
  showAllLayers: boolean;
  onLayerChange: (layer: number) => void;
  onShowAllLayersChange: (show: boolean) => void;
  onExit: () => void;
  hiddenTypes: Set<MoveType>;
  onHiddenTypesChange: (types: Set<MoveType>) => void;
  currentStep: number;
  totalSegmentsInLayer: number;
  onStepChange: (step: number) => void;
}

export function GcodeLayerSlider({
  currentLayer, totalLayers, currentZ, maxZ,
  showAllLayers, onLayerChange, onShowAllLayersChange, onExit,
  hiddenTypes, onHiddenTypesChange,
  currentStep, totalSegmentsInLayer, onStepChange,
}: GcodeLayerSliderProps) {
  if (totalLayers === 0) return null;

  return (
    <>
      {/* Vertical layer slider on right edge — CSS rotation for reliable vertical drag */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-1 bg-gray-800/90 backdrop-blur rounded-xl border border-gray-600 px-2 py-3">
        <span className="text-[10px] text-gray-400 font-mono">{maxZ.toFixed(1)}</span>
        <div style={{ width: '1.5rem', height: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
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
        </div>
        <span className="text-[10px] text-gray-400 font-mono">0</span>
        <span className="text-xs text-gray-300 font-mono mt-1">
          L{currentLayer + 1}/{totalLayers}
        </span>
        <span className="text-[10px] text-gray-500 font-mono">
          {currentZ.toFixed(1)}mm
        </span>
      </div>

      {/* Bottom bar: info + type checkboxes */}
      <div className="absolute bottom-2 left-2 right-14 z-10 bg-gray-800/90 backdrop-blur rounded-xl border border-gray-600 px-4 py-2">
        <div className="flex items-center justify-between mb-1">
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
          </div>
          <button
            onClick={onExit}
            className="px-3 py-1 text-xs rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
          >
            Back to Model
          </button>
        </div>
        {/* Horizontal path-tracing slider */}
        {totalSegmentsInLayer > 0 && (
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] text-gray-500 font-mono whitespace-nowrap">
              {currentStep >= 0 ? currentStep + 1 : totalSegmentsInLayer}/{totalSegmentsInLayer}
            </span>
            <input
              type="range"
              min={0}
              max={totalSegmentsInLayer - 1}
              step={1}
              value={currentStep >= 0 ? Math.min(currentStep, totalSegmentsInLayer - 1) : totalSegmentsInLayer - 1}
              onChange={(e) => onStepChange(parseInt(e.target.value))}
              className="flex-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 h-1"
            />
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {(Object.keys(TYPE_LABELS) as MoveType[]).map((type) => (
            <label key={type} className="flex items-center gap-1 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={!hiddenTypes.has(type)}
                onChange={() => {
                  const next = new Set(hiddenTypes);
                  if (next.has(type)) next.delete(type); else next.add(type);
                  onHiddenTypesChange(next);
                }}
                className="rounded border-gray-600 bg-gray-700"
              />
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
              <span className="text-gray-400">{TYPE_LABELS[type]}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}
