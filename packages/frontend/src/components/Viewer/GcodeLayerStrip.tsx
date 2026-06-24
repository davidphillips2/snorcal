import { useMemo } from 'react';
import { typeColorOpt as colorForType } from '../../lib/gcode-colors';

interface GcodeLayerStripProps {
  currentLayer: number;
  totalLayers: number;
  /** Map of layer index → dominant ;TYPE: label (optional, used for color coding). */
  layerTypes?: Map<number, string>;
  onLayerChange: (layer: number) => void;
}

/**
 * Horizontal filmstrip of layer ticks. Color-coded by dominant ;TYPE: per
 * layer when available; click any tick to jump.
 *
 * Renders a CSS-only strip — no per-layer canvas rendering (kept light).
 * Cap on visible ticks (~200) — when more layers exist, each tick covers
 * multiple layers and the tick is labelled with its midpoint.
 */
export function GcodeLayerStrip({ currentLayer, totalLayers, layerTypes, onLayerChange }: GcodeLayerStripProps) {
  const MAX_TICKS = 200;
  const stride = Math.max(1, Math.ceil(totalLayers / MAX_TICKS));
  const ticks = useMemo(() => {
    const arr: Array<{ layer: number; color?: string }> = [];
    for (let l = 0; l < totalLayers; l += stride) {
      arr.push({ layer: l, color: colorForType(layerTypes?.get(l)) });
    }
    return arr;
  }, [totalLayers, stride, layerTypes]);

  if (totalLayers <= 1) return null;

  return (
    <div className="absolute bottom-16 left-2 right-14 z-10 bg-gray-800/85 backdrop-blur rounded-lg border border-gray-600 px-2 py-1.5 overflow-hidden">
      <div className="flex items-center gap-px overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'thin' }}>
        {ticks.map((t, i) => {
          const isActive = t.layer <= currentLayer && (i === ticks.length - 1 || ticks[i + 1].layer > currentLayer);
          return (
            <button
              key={t.layer}
              onClick={() => onLayerChange(t.layer)}
              title={`Layer ${t.layer + 1}${t.color ? ` · ${t.color}` : ''}`}
              className="relative h-5 min-w-[6px] flex-1 shrink-0 rounded-sm transition"
              style={{
                backgroundColor: t.color ?? (isActive ? '#3b82f6' : '#374151'),
                opacity: isActive ? 1 : 0.55,
                transform: isActive ? 'scaleY(1.2)' : 'scaleY(1)',
              }}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-1 text-[10px] text-gray-400">
        <span>L1</span>
        <span className="text-gray-300">L{currentLayer + 1}/{totalLayers}</span>
        <span>L{totalLayers}</span>
      </div>
    </div>
  );
}
