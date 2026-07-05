import { useEffect, useRef, useState, useMemo } from 'react';
import { init, type WebGLPreview } from 'gcode-preview';
import { typeColor } from '../../lib/gcode-stats';

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

// Tubes create ~100 vertices per segment vs ~2 for plain lines. The old
// desktop tube limit (100k) was itself the OOM threshold, so big real-world
// files (150k–210k extrusion moves) crashed even after falling back to line
// mode — because the gcode was being copied/re-split multiple times. With the
// split-once rewrite below, line mode now holds for those sizes; tubes are
// reserved for small/medium files where they're safe.
const TUBE_SEGMENT_LIMIT = 40_000;
// Hard cap above which we refuse to render at all (any platform) and show a
// "preview disabled" message instead of OOM-crashing the tab. 300k covers the
// largest normal prints (~multi-day, dense toolpaths) while refusing the
// pathological cases that would OOM even in line mode.
const MAX_MOVES = 300_000;

// OrcaSlicer-style line-type colors
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

/** Count G1 extrusion moves from a pre-split line array (no string copy). */
function countExtrusionMoves(lines: readonly string[]): number {
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.charCodeAt(0) === 71 /* G */ && line.charCodeAt(1) === 49 /* 1 */
      && /E-?\d/.test(line)) count++;
  }
  return count;
}

/**
 * Rewrite gcode so `T<n>` tool-change commands follow `;TYPE:` comments and
 * speed transitions, letting gcode-preview's toolColors drive line-type or
 * speed coloring. Original T0/Tn commands (filament swaps) are stripped
 * since we only care about per-segment color in these modes.
 *
 * Operates on and returns a **line array** — never re-joins to a string —
 * so the result can be passed straight to processGCode(string[]) without a
 * second full copy of the gcode.
 */
function rewriteForColorMode(lines: readonly string[], mode: GcodeColorMode): {
  lines: string[];
  toolColors: Record<number, string>;
} {
  const toolColors: Record<number, string> = { 0: '#ffffff' };
  const typeToTool = new Map<string, number>();
  const speedToTool = new Map<number, number>();
  let nextTool = 1;
  let currentTool = 0;

  // Copy so we can append T<n> entries in place without mutating the caller's array.
  const out: string[] = new Array(lines.length);
  let currentType = '';
  let currentFMmMin = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    out[i] = line;

    if (mode === 'lineType') {
      const typeMatch = trimmed.match(/^;TYPE:\s*(.+)/i);
      if (typeMatch) {
        currentType = typeMatch[1].trim().toLowerCase();
        let tool = typeToTool.get(currentType);
        if (tool === undefined) {
          tool = nextTool++;
          typeToTool.set(currentType, tool);
          toolColors[tool] = typeColor(currentType);
        }
        currentTool = tool;
        out[i] = `${line}\nT${currentTool}`;
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
          out[i] = `${line}\nT${currentTool}`;
        }
      }
    }
  }

  return { lines: out, toolColors };
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

  // Split the gcode into lines ONCE and reuse the array everywhere. This is
  // the central memory fix: previously the gcode string was re-split (and, in
  // lineType/speed modes, re-joined) in countExtrusionMoves, rewriteForColorMode,
  // processGCode's internal parse, and both gcode-stats parsers — holding ~3
  // full copies of a 6MB gcode simultaneously. The single array is shared by
  // all of them now, and processGCode accepts string[] so the library skips
  // its own split.
  const baseLines = useMemo(() => (gcode ? gcode.split('\n') : null), [gcode]);

  // Rewrite for non-filament color modes (operates on the line array, no re-join).
  const processed = useMemo(() => {
    if (!baseLines) return null;
    if (colorMode === 'filament') return { lines: baseLines, toolColors: undefined as Record<number, string> | undefined };
    return rewriteForColorMode(baseLines, colorMode);
  }, [baseLines, colorMode]);

  const effectiveLines = processed?.lines ?? baseLines;

  // Single extrusion-move count — computed once, reused by both the OOM guard
  // and the tube-vs-line decision (was computed twice before).
  const moveCount = useMemo(
    () => effectiveLines ? countExtrusionMoves(effectiveLines) : 0,
    [effectiveLines],
  );
  // Hard cap (all platforms): refuse to render past this to avoid OOM-crashing
  // the tab. Replaces the old mobile-only block.
  const blocked = moveCount > MAX_MOVES;

  useEffect(() => {
    if (!canvasRef.current) return;
    if (blocked) return; // skip init entirely when over the hard cap

    const colors = extrusionColors?.length
      ? extrusionColors
      : ['#ff3333', '#ffcc00', '#33cc33', '#00cccc', '#6699ff'];

    // Tubes are ~50× heavier per segment than lines; only use them for small/
    // medium files. `moveCount` is already computed above (no recount).
    const useTubes = moveCount < TUBE_SEGMENT_LIMIT;
    setUsingTubes(useTubes);

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
  }, [moveCount, extrusionColors, buildVolume, processed, blocked]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !effectiveLines) return;
    if (blocked) return; // do not processGcode when over the hard cap

    preview.clear();
    // Pass the line array directly — the library accepts string[] and skips
    // its own internal split, avoiding another full copy of the gcode.
    preview.processGCode(effectiveLines);
    preview.endLayer = preview.layers.length;
    preview.render();

    onLayerCountReady?.(preview.layers.length);
  }, [effectiveLines, onLayerCountReady, blocked]); // eslint-disable-line react-hooks/exhaustive-deps

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
        style={{ display: (gcode && !blocked) ? 'block' : 'none' }}
      />
      {!usingTubes && gcode && !blocked && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-gray-900/80 text-gray-400 text-xs px-3 py-1 rounded pointer-events-none">
          Line mode (large gcode)
        </div>
      )}
      {blocked && gcode && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <div className="bg-gray-900/90 text-gray-300 text-sm px-4 py-3 rounded max-w-xs">
            G-code preview disabled — this file has {moveCount.toLocaleString()} extrusion moves,
            above the {MAX_MOVES.toLocaleString()}-move render limit to avoid crashing the tab.
          </div>
        </div>
      )}
    </>
  );
}
