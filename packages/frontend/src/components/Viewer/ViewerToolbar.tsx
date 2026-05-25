import type { ReactNode } from 'react';
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

function IconOrbit() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3a9 9 0 0 1 0 18" />
      <path d="M12 21a9 9 0 0 1 0-18" />
    </svg>
  );
}

function IconRotate() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" />
    </svg>
  );
}

function IconLayFlat() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18M5 15l7 7 7-7" />
    </svg>
  );
}

function IconPaint() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  );
}

function IconFill() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 22l1-1h3l9-9M3 21l9-9" />
      <path d="M10.5 7.5L16 2l4 4-5.5 5.5" />
      <path d="M19 14c.5.5 2 2.5 2 4a3 3 0 0 1-6 0c0-1.5 1.5-3 2-4z" fill="currentColor" />
    </svg>
  );
}

function IconUndo() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 0 1 15.4-6.4L21 9" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

const MODES: { key: PaintMode; label: string; Icon: () => ReactNode }[] = [
  { key: 'orbit', label: 'Orbit', Icon: IconOrbit },
  { key: 'rotate', label: 'Rotate', Icon: IconRotate },
  { key: 'lay', label: 'Lay Flat', Icon: IconLayFlat },
  { key: 'paint', label: 'Paint', Icon: IconPaint },
  { key: 'fill', label: 'Fill', Icon: IconFill },
];

export function ViewerToolbar({
  paintMode, onModeChange, activeColor, onColorChange, onUndo, onSave,
  rotation, onRotationChange, onAutoOrient, filamentColors,
}: ViewerToolbarProps) {
  const palette = filamentColors && filamentColors.length > 0 ? filamentColors : PALETTE;
  const isPainting = paintMode === 'paint' || paintMode === 'fill';

  return (
    <>
      {/* Toolbar */}
      <div className="absolute top-2 left-2 right-2 z-20 flex items-center gap-2">
        <div className="flex items-center gap-1 bg-gray-800/90 backdrop-blur rounded-lg px-2 py-1.5 shadow-lg">
          {MODES.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => onModeChange(key)}
              title={label}
              className={`w-8 h-8 flex items-center justify-center rounded-md transition ${
                paintMode === key
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-300 hover:bg-gray-700'
              }`}
            >
              <Icon />
            </button>
          ))}

          <div className="w-px h-6 bg-gray-600 mx-1" />

          <button
            onClick={onUndo}
            title="Undo"
            className="w-8 h-8 flex items-center justify-center rounded-md text-gray-300 hover:bg-gray-700 transition"
          >
            <IconUndo />
          </button>
          <button
            onClick={onSave}
            title="Save colors"
            className="w-8 h-8 flex items-center justify-center rounded-md text-green-400 hover:bg-gray-700 transition"
          >
            <IconSave />
          </button>

          {isPainting && (
            <>
              <div className="w-px h-6 bg-gray-600 mx-1" />
              <label className="relative shrink-0">
                <div
                  className="w-7 h-7 rounded-full border-2 border-white/50"
                  style={{ backgroundColor: activeColor }}
                />
                <input
                  type="color"
                  value={activeColor}
                  onChange={(e) => onColorChange(e.target.value)}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </label>
              <div className="hidden sm:flex gap-0.5 ml-1">
                {palette.map((color) => (
                  <button
                    key={color}
                    onClick={() => onColorChange(color)}
                    className={`w-5 h-5 rounded-full border transition ${
                      activeColor === color ? 'border-white scale-110' : 'border-gray-600 hover:border-gray-400'
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
                <label className="w-5 h-5 rounded-full border border-gray-600 cursor-pointer overflow-hidden relative">
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
        </div>
      </div>

      {/* Rotation panel */}
      {paintMode === 'rotate' && (
        <div className="absolute top-14 left-2 bg-gray-800/90 backdrop-blur rounded-lg px-3 py-2 shadow-lg z-20">
          <div className="flex items-center gap-2">
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
              Auto
            </button>
            <button
              onClick={() => onRotationChange({ x: 0, y: 0, z: 0 })}
              className="px-2 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {/* Lay on face hint */}
      {paintMode === 'lay' && (
        <div className="absolute top-14 left-2 bg-gray-800/90 backdrop-blur rounded-lg px-4 py-2 shadow-lg z-20">
          <p className="text-xs text-gray-300 whitespace-nowrap">Click a face to lay it on the build plate</p>
        </div>
      )}
    </>
  );
}
