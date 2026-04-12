interface GcodeLayerSliderProps {
  currentLayer: number;
  totalLayers: number;
  currentZ: number;
  maxZ: number;
  showAllLayers: boolean;
  onLayerChange: (layer: number) => void;
  onShowAllLayersChange: (show: boolean) => void;
  onExit: () => void;
}

export function GcodeLayerSlider({
  currentLayer, totalLayers, currentZ, maxZ,
  showAllLayers, onLayerChange, onShowAllLayersChange, onExit,
}: GcodeLayerSliderProps) {
  if (totalLayers === 0) return null;

  return (
    <div className="absolute bottom-2 left-2 right-2 z-10 bg-gray-800/90 backdrop-blur rounded-xl border border-gray-600 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-300 font-mono">
            Layer {currentLayer + 1} / {totalLayers}
          </span>
          <span className="text-xs text-gray-500 font-mono">
            Z: {currentZ.toFixed(2)} / {maxZ.toFixed(2)} mm
          </span>
        </div>
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
          <button
            onClick={onExit}
            className="px-3 py-1 text-xs rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
          >
            Back to Model
          </button>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={totalLayers - 1}
        step={1}
        value={currentLayer}
        onChange={(e) => onLayerChange(parseInt(e.target.value))}
        className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
      />
    </div>
  );
}
