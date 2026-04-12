import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { SceneRefs } from './Scene';
import type { ParsedGcode, MoveType } from '../../lib/gcode-parser';

const MOVE_COLORS: Record<MoveType, [number, number, number]> = {
  outer_wall: [1, 0.2, 0.2],
  inner_wall: [1, 0.8, 0],
  infill: [0.2, 0.8, 0.2],
  top_surface: [0, 0.8, 0.8],
  bottom_surface: [0.4, 0.6, 1],
  solid_infill: [0.2, 0.7, 0.2],
  bridge: [1, 0.6, 0],
  support: [0.6, 0.4, 1],
  skirt: [0.6, 0.6, 0.6],
  travel: [0.4, 0.4, 0.4],
  other: [0.5, 0.5, 0.5],
};

interface GcodeViewerProps {
  sceneRef: React.MutableRefObject<SceneRefs | null>;
  parsedGcode: ParsedGcode;
  currentLayer: number;
  showAllLayers: boolean;
}

export function GcodeViewer({ sceneRef, parsedGcode, currentLayer, showAllLayers }: GcodeViewerProps) {
  const extrusionRef = useRef<THREE.LineSegments | null>(null);
  const centeredRef = useRef(false);

  // Build geometry when layers change
  useEffect(() => {
    if (!sceneRef.current) return;
    const { scene } = sceneRef.current;

    const { layers, bounds } = parsedGcode;
    if (layers.length === 0) return;

    // Determine which layers to render
    const endLayer = Math.min(currentLayer + 1, layers.length);
    const startLayer = showAllLayers ? 0 : currentLayer;

    let extrusionCount = 0;
    for (let i = startLayer; i < endLayer; i++) {
      for (const seg of layers[i].segments) {
        if (seg.type !== 'travel') extrusionCount++;
      }
    }

    // Center offset
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;

    // Build extrusion geometry
    const exPositions = new Float32Array(extrusionCount * 6);
    const exColors = new Float32Array(extrusionCount * 6);

    let ei = 0;
    for (let i = startLayer; i < endLayer; i++) {
      for (const seg of layers[i].segments) {
        if (seg.type === 'travel') continue;

        const fx = seg.from.x - cx, fy = seg.from.y, fz = seg.from.z - cz;
        const tx = seg.to.x - cx, ty = seg.to.y, tz = seg.to.z - cz;

        exPositions[ei * 6] = fx;
        exPositions[ei * 6 + 1] = fy;
        exPositions[ei * 6 + 2] = fz;
        exPositions[ei * 6 + 3] = tx;
        exPositions[ei * 6 + 4] = ty;
        exPositions[ei * 6 + 5] = tz;
        const c = MOVE_COLORS[seg.type];
        exColors[ei * 6] = c[0]; exColors[ei * 6 + 1] = c[1]; exColors[ei * 6 + 2] = c[2];
        exColors[ei * 6 + 3] = c[0]; exColors[ei * 6 + 4] = c[1]; exColors[ei * 6 + 5] = c[2];
        ei++;
      }
    }

    // Remove old objects
    if (extrusionRef.current) {
      scene.remove(extrusionRef.current);
      extrusionRef.current.geometry.dispose();
      (extrusionRef.current.material as THREE.Material).dispose();
      extrusionRef.current = null;
    }

    // Create extrusion lines
    if (extrusionCount > 0) {
      const exGeo = new THREE.BufferGeometry();
      exGeo.setAttribute('position', new THREE.BufferAttribute(exPositions, 3));
      exGeo.setAttribute('color', new THREE.BufferAttribute(exColors, 3));
      const exMat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 1 });
      const exLines = new THREE.LineSegments(exGeo, exMat);
      scene.add(exLines);
      extrusionRef.current = exLines;
    }
  }, [sceneRef, parsedGcode, currentLayer, showAllLayers]);

  // Camera framing on first render
  useEffect(() => {
    if (!sceneRef.current || centeredRef.current) return;
    if (parsedGcode.layers.length === 0) return;

    const { camera, controls } = sceneRef.current;
    const { bounds } = parsedGcode;

    const sizeX = bounds.maxX - bounds.minX;
    const sizeY = bounds.maxY - bounds.minY;
    const sizeZ = bounds.maxZ - bounds.minZ;
    const maxDim = Math.max(sizeX, sizeY, sizeZ);

    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;

    camera.position.set(cx, cy + maxDim * 1.2, cz + maxDim * 1.2);
    camera.lookAt(cx, cy, cz);
    camera.updateProjectionMatrix();

    if (controls) {
      controls.target.set(cx, cy, cz);
      controls.update();
    }

    centeredRef.current = true;
  }, [sceneRef, parsedGcode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sceneRef.current) {
        const { scene } = sceneRef.current;
        if (extrusionRef.current) {
          scene.remove(extrusionRef.current);
          extrusionRef.current.geometry.dispose();
          (extrusionRef.current.material as THREE.Material).dispose();
        }
      }
    };
  }, [sceneRef]);

  return null;
}
