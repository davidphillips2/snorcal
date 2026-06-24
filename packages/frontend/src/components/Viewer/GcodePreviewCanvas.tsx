import { useEffect, useRef, useState, useMemo } from 'react';
import { init, type WebGLPreview } from 'gcode-preview';
import { TYPE_COLORS } from '../../lib/gcode-colors';

export type GcodeColorMode = 'filament' | 'lineType' | 'speed';

interface GcodePreviewCanvasProps {
  gcode: string | null;
  layer: number;
  singleLayerMode: boolean;
  extrusionColors?: string[];
  buildVolume?: { x: number; y: number; z: number };
  colorMode?: GcodeColorMode;
  onLayerCountReady?: (count: number) => void;
}

// Tubes create ~100 vertices per segment; 100K segments ≈ 10M vertices ≈ OOM threshold.
// Mobile Safari tabs crash past ~300MB — drop the limit aggressively there.
const isMobile = typeof navigator !== 'undefined'
  && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const isSmallScreen = typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 600;
const mobileOrSmall = isMobile || isSmallScreen;
const TUBE_SEGMENT_LIMIT = mobileOrSmall ? 8_000 : 100_000;
// Mobile cap on extrusion moves: above this, refuse to render preview and
// show a warning instead of OOM-crashing the tab.
const MOBILE_RENDER_LIMIT = 60_000;

// Speed color ramp (mm/s): blue → cyan → green → yellow → orange → red
function speedToColor(mms: number): string {
  // Buckets at 20, 40, 60, 80, 100, 120, 150 mm/s
  if (mms < 20) return '#3b82f6';
  if (mms < 40) return '#06b6d4';
  if (mms < 60) return '#10b981';
  if (mms < 80) return '#84cc16';
  if (mms < 100) return '#eab308';
  if (mms < 120) return '#f97316';
  if (mms < 150) return '#ef4444';
  return '#dc2626';
}

function countExtrusionMoves(gcode: string): number {
  let count = 0;
  for (const line of gcode.split('\n')) {
    if (line.match(/^G1\s/)?.input && /E-?\d/.test(line)) count++;
  }
  return count;
}

/**
 * Rewrite gcode so `T<n>` tool-change commands follow `;TYPE:` comments and
 * speed transitions, letting gcode-preview's toolColors drive line-type or
 * speed coloring. Original T0/Tn commands (filament swaps) are stripped
 * since we only care about per-segment color in these modes.
 *
 * Returns the rewritten gcode plus a toolColors map indexed by tool number.
 */
function rewriteForColorMode(gcode: string, mode: GcodeColorMode): {
  gcode: string;
  toolColors: Record<number, string>;
} {
  const toolColors: Record<number, string> = { 0: '#ffffff' };
  const typeToTool = new Map<string, number>();
  const speedToTool = new Map<number, number>();
  let nextTool = 1;
  let currentTool = 0;

  const lines = gcode.split('\n');
  let currentType = '';
  let currentFMmMin = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (mode === 'lineType') {
      const typeMatch = trimmed.match(/^;TYPE:\s*(.+)/i);
      if (typeMatch) {
        currentType = typeMatch[1].trim().toLowerCase();
        let tool = typeToTool.get(currentType);
        if (tool === undefined) {
          tool = nextTool++;
          typeToTool.set(currentType, tool);
          toolColors[tool] = TYPE_COLORS[currentType] ?? '#bbbbbb';
        }
        currentTool = tool;
        lines[i] = `${line}\nT${currentTool}`;
        continue;
      }
    }

    if (mode === 'speed') {
      // Track current feedrate from G1 F= commands (mm/min)
      const fMatch = trimmed.match(/^G[01]\s.*F(\d+(?:\.\d+)?)/i);
      if (fMatch) {
        const f = parseFloat(fMatch[1]);
        if (f > 0 && f !== currentFMmMin) {
          currentFMmMin = f;
          const mms = f / 60;
          // Bucket speed to nearest 5 mm/s to limit tool count
          const bucket = Math.round(mms / 5) * 5;
          let tool = speedToTool.get(bucket);
          if (tool === undefined) {
            tool = nextTool++;
            speedToTool.set(bucket, tool);
            toolColors[tool] = speedToColor(bucket);
          }
          currentTool = tool;
          lines[i] = `${line}\nT${currentTool}`;
        }
      }
    }
  }

  return { gcode: lines.join('\n'), toolColors };
}

export function GcodePreviewCanvas({
  gcode,
  layer,
  singleLayerMode,
  extrusionColors,
  buildVolume,
  colorMode = 'filament',
  onLayerCountReady,
}: GcodePreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<WebGLPreview | null>(null);
  const [usingTubes, setUsingTubes] = useState(true);

  // Rewrite gcode for non-filament color modes (memoized)
  const processed = useMemo(() => {
    if (!gcode) return null;
    if (colorMode === 'filament') return { gcode, toolColors: undefined as Record<number, string> | undefined };
    return rewriteForColorMode(gcode, colorMode);
  }, [gcode, colorMode]);

  const effectiveGcode = processed?.gcode ?? gcode;

  // Mobile guard: bail out entirely if the gcode is large enough to OOM the tab.
  // Bigger gcodes still parse fine on desktop.
  const moveCount = useMemo(
    () => effectiveGcode ? countExtrusionMoves(effectiveGcode) : 0,
    [effectiveGcode],
  );
  const mobileBlocked = mobileOrSmall && moveCount > MOBILE_RENDER_LIMIT;

  useEffect(() => {
    if (!canvasRef.current) return;
    if (mobileBlocked) return; // skip init entirely on mobile OOM risk

    const colors = extrusionColors?.length
      ? extrusionColors
      : ['#ff3333', '#ffcc00', '#33cc33', '#00cccc', '#6699ff'];

    // Auto-disable tubes for large gcode to prevent OOM
    let useTubes = true;
    if (effectiveGcode) {
      const moves = countExtrusionMoves(effectiveGcode);
      useTubes = moves < TUBE_SEGMENT_LIMIT;
      setUsingTubes(useTubes);
    }

    const preview = init({
      canvas: canvasRef.current,
      extrusionColor: colors,
      backgroundColor: '#1a1a2e',
      renderTravel: false,
      buildVolume: buildVolume ?? { x: 200, y: 200, z: 200 },
      renderTubes: useTubes,
      extrusionWidth: 0.45,
      lineHeight: 0.2,
      // In lineType/speed modes, toolColors (set on preview below after init) drive per-segment color
    });

    // Apply tool colors. In filament mode, map T0/T1/T2... → slot colors.
    // Without this, gcode-preview falls back to extrusionColor[0] for all
    // tool changes → multi-extruder gcode renders as a single color.
    if (processed?.toolColors) {
      (preview as unknown as { toolColors: Record<number, string> }).toolColors = processed.toolColors;
    } else if (extrusionColors && extrusionColors.length > 0) {
      const tc: Record<number, string> = {};
      extrusionColors.forEach((c, i) => { tc[i] = c; });
      (preview as unknown as { toolColors: Record<number, string> }).toolColors = tc;
    }

    previewRef.current = preview;

    const observer = new ResizeObserver(() => {
      if (previewRef.current) previewRef.current.resize();
    });
    observer.observe(canvasRef.current);

    return () => {
      observer.disconnect();
      preview.dispose();
      previewRef.current = null;
    };
  }, [effectiveGcode, extrusionColors, buildVolume, processed, mobileBlocked]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !effectiveGcode) return;
    if (mobileBlocked) return; // do not processGcode on mobile when over limit

    preview.clear();
    preview.processGCode(effectiveGcode);
    preview.endLayer = preview.layers.length;
    preview.render();

    onLayerCountReady?.(preview.layers.length);
  }, [effectiveGcode, onLayerCountReady, mobileBlocked]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || preview.layers.length === 0) return;

    preview.singleLayerMode = singleLayerMode;
    preview.endLayer = layer + 1;
    if (!singleLayerMode) preview.startLayer = undefined;
    preview.render();
  }, [layer, singleLayerMode]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ display: (gcode && !mobileBlocked) ? 'block' : 'none' }}
      />
      {!usingTubes && gcode && !mobileBlocked && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-gray-900/80 text-gray-400 text-xs px-3 py-1 rounded pointer-events-none">
          Line mode (large gcode)
        </div>
      )}
      {mobileBlocked && gcode && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <div className="bg-gray-900/90 text-gray-300 text-sm px-4 py-3 rounded max-w-xs">
            G-code preview disabled on this device to avoid crashing the tab.
            Open on desktop to view.
          </div>
        </div>
      )}
    </>
  );
}
