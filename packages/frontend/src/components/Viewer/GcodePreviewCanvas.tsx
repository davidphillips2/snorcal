import { useEffect, useRef, useCallback } from 'react';
import { init, type WebGLPreview } from 'gcode-preview';

interface GcodePreviewCanvasProps {
  gcode: string | null;
  layer: number;
  singleLayerMode: boolean;
  extrusionColors?: string[];
  buildVolume?: { x: number; y: number; z: number };
  onLayerCountReady?: (count: number) => void;
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

  // Create preview instance when canvas mounts
  useEffect(() => {
    if (!canvasRef.current) return;

    const colors = extrusionColors?.length
      ? extrusionColors
      : ['#ff3333', '#ffcc00', '#33cc33', '#00cccc', '#6699ff'];

    const preview = init({
      canvas: canvasRef.current,
      extrusionColor: colors,
      backgroundColor: '#1a1a2e',
      renderTravel: false,
      buildVolume: buildVolume ?? { x: 200, y: 200, z: 200 },
      renderTubes: true,
      extrusionWidth: 0.45,
      lineHeight: 0.2,
    });

    previewRef.current = preview;

    // Resize observer
    const observer = new ResizeObserver(() => {
      if (previewRef.current) previewRef.current.resize();
    });
    observer.observe(canvasRef.current);

    return () => {
      observer.disconnect();
      preview.dispose();
      previewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Process gcode when it changes
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !gcode) return;

    preview.clear();
    preview.processGCode(gcode);
    preview.endLayer = preview.layers.length;
    preview.render();

    onLayerCountReady?.(preview.layers.length);
  }, [gcode, onLayerCountReady]);

  // Update layer when slider changes
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || preview.layers.length === 0) return;

    preview.singleLayerMode = singleLayerMode;
    preview.endLayer = layer + 1; // library uses 1-based layers

    if (!singleLayerMode) {
      preview.startLayer = undefined;
    }

    preview.render();
  }, [layer, singleLayerMode]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ display: gcode ? 'block' : 'none' }}
    />
  );
}
