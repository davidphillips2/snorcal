import { useEffect, useRef, useState } from 'react';
import { init, type WebGLPreview } from 'gcode-preview';

interface GcodePreviewCanvasProps {
  gcode: string | null;
  layer: number;
  singleLayerMode: boolean;
  extrusionColors?: string[];
  buildVolume?: { x: number; y: number; z: number };
  onLayerCountReady?: (count: number) => void;
}

// Tubes create ~100 vertices per segment; 100K segments ≈ 10M vertices ≈ OOM threshold
const TUBE_SEGMENT_LIMIT = 100_000;

function countExtrusionMoves(gcode: string): number {
  let count = 0;
  for (const line of gcode.split('\n')) {
    // G1 with E parameter = extrusion move
    if (line.match(/^G1\s/)?.input && /E-?\d/.test(line)) count++;
  }
  return count;
}

export function GcodePreviewCanvas({
  gcode,
  layer,
  singleLayerMode,
  extrusionColors,
  buildVolume,
  onLayerCountReady,
}: GcodePreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<WebGLPreview | null>(null);
  const [usingTubes, setUsingTubes] = useState(true);

  useEffect(() => {
    if (!canvasRef.current) return;

    const colors = extrusionColors?.length
      ? extrusionColors
      : ['#ff3333', '#ffcc00', '#33cc33', '#00cccc', '#6699ff'];

    // Auto-disable tubes for large gcode to prevent OOM
    let useTubes = true;
    if (gcode) {
      const moves = countExtrusionMoves(gcode);
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
    });

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
  }, [gcode, extrusionColors, buildVolume]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !gcode) return;

    preview.clear();
    preview.processGCode(gcode);
    preview.endLayer = preview.layers.length;
    preview.render();

    onLayerCountReady?.(preview.layers.length);
  }, [gcode, onLayerCountReady]);

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
        style={{ display: gcode ? 'block' : 'none' }}
      />
      {!usingTubes && gcode && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-gray-900/80 text-gray-400 text-xs px-3 py-1 rounded pointer-events-none">
          Line mode (large gcode)
        </div>
      )}
    </>
  );
}
