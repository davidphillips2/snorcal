import type { PaintMode } from './FacePainter';
import type { Rotation3D } from './STLViewer';

interface ViewerToolbarProps {
  paintMode: PaintMode;
  onModeChange: (mode: PaintMode) => void;
  activeColor: string;
  onColorChange: (color: string) => void;
  onUndo: () => void;
  onSave: () => void;
  rotation: Rotation3D;
  onRotationChange: (rotation: Rotation3D) => void;
  onAutoOrient: () => void;
  filamentColors?: string[];
}

const PALETTE = [
  '#FF0000', '#FF6600', '#FFCC00', '#33CC33', '#0099FF',
  '#6633CC', '#CC3399', '#FFFFFF', '#999999', '#333333',
  '#FF9999', '#FFCC99', '#FFFF99', '#99FF99', '#99CCFF',
];

const MODES: { key: PaintMode; label: string }[] = [
  { key: 'orbit', label: 'Orbit' },
  { key: 'rotate', label: 'Rotate' },
  { key: 'lay', label: 'Lay Flat' },
  { key: 'paint', label: 'Paint' },
  { key: 'fill', label: 'Fill' },
];

export function ViewerToolbar({
  paintMode, onModeChange, activeColor, onColorChange, onUndo, onSave,
  rotation, onRotationChange, onAutoOrient, filamentColors,
}: ViewerToolbarProps) {
  const palette = filamentColors && filamentColors.length > 0 ? filamentColors : PALETTE;
  return (
    <>
      {/* Rotation panel — shown above toolbar when rotate mode is active */}
      {paintMode === 'rotate' && (
        <div className="absolute bottom-16 sm:bottom-20 left-1/2 -translate-x-1/2 bg-gray-800/90 backdrop-blur rounded-xl px-3 py-2 shadow-lg flex items-center gap-2 sm:gap-3 z-20">
          {(['x', 'y', 'z'] as const).map((axis) => (
            <div key={axis} className="flex items-center gap-1">
              <span className="text-xs font-medium text-gray-400 w-3">{axis.toUpperCase()}</span>
              <input
                type="number"
                value={rotation[axis]}
                onChange={(e) => onRotationChange({ ...rotation, [axis]: Number(e.target.value) || 0 })}
                className="w-14 bg-gray-700 border border-gray-600 rounded px-1.5 py-1 text-xs text-white text-center"
              />
            </div>
          ))}
          <div className="w-px h-6 bg-gray-600" />
          <button
            onClick={onAutoOrient}
            className="px-2 py-1 rounded text-xs bg-purple-600 text-white hover:bg-purple-500 transition whitespace-nowrap"
          >
            Auto Orient
          </button>
          <button
            onClick={() => onRotationChange({ x: 0, y: 0, z: 0 })}
            className="px-2 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
          >
            Reset
          </button>
        </div>
      )}

      {/* Lay on face hint */}
      {paintMode === 'lay' && (
        <div className="absolute bottom-16 sm:bottom-20 left-1/2 -translate-x-1/2 bg-gray-800/90 backdrop-blur rounded-xl px-4 py-2 shadow-lg z-20">
          <p className="text-xs text-gray-300 whitespace-nowrap">Click a face to lay it on the build plate</p>
        </div>
      )}

      <div className="absolute bottom-2 left-2 right-2 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:bottom-4 flex flex-col sm:flex-row items-center gap-2 sm:gap-3 bg-gray-800/90 backdrop-blur rounded-xl px-3 py-2 shadow-lg max-w-full sm:max-w-none">
        <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          {/* Mode buttons */}
          <div className="flex gap-1 shrink-0">
            {MODES.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => onModeChange(key)}
                className={`px-2 sm:px-2.5 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition ${
                  paintMode === key
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Paint controls — only shown in paint/fill modes */}
          {(paintMode === 'paint' || paintMode === 'fill') && (
            <>
              {/* Mobile: clickable color indicator opens color picker */}
              <label className="sm:hidden shrink-0 relative">
                <div
                  className="w-7 h-7 rounded-full border-2 border-white"
                  style={{ backgroundColor: activeColor }}
                />
                <input
                  type="color"
                  value={activeColor}
                  onChange={(e) => onColorChange(e.target.value)}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </label>

              {/* Divider (desktop) */}
              <div className="hidden sm:block w-px h-8 bg-gray-600" />

              {/* Color palette (desktop) */}
              <div className="hidden sm:flex gap-1">
                {palette.map((color) => (
                  <button
                    key={color}
                    onClick={() => onColorChange(color)}
                    className={`w-6 h-6 rounded-full border-2 transition ${
                      activeColor === color ? 'border-white scale-110' : 'border-gray-600 hover:border-gray-400'
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
                <label className="w-6 h-6 rounded-full border-2 border-gray-600 cursor-pointer overflow-hidden relative">
                  <input
                    type="color"
                    value={activeColor}
                    onChange={(e) => onColorChange(e.target.value)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className="w-full h-full" style={{ background: `conic-gradient(red, yellow, lime, aqua, blue, magenta, red)` }} />
                </label>
              </div>
            </>
          )}

          {/* Actions */}
          <div className="flex gap-1 shrink-0 ml-auto sm:ml-0">
            <button
              onClick={onUndo}
              className="px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
            >
              Undo
            </button>
            <button
              onClick={onSave}
              className="px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm bg-green-600 text-white hover:bg-green-500 transition"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
