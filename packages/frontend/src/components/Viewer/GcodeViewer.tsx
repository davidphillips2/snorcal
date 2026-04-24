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
  hiddenTypes: Set<MoveType>;
  currentStep: number;
}

export function GcodeViewer({ sceneRef, parsedGcode, currentLayer, showAllLayers, hiddenTypes, currentStep }: GcodeViewerProps) {
  const groupRef = useRef<THREE.Group | null>(null);
  const linesRef = useRef<THREE.LineSegments | null>(null);
  const sceneRefs = sceneRef.current;

  // Create group — no rotation, gcode coordinates map directly to Three.js
  // The slicer uses the same coordinate system as the STL, so the gcode
  // preview orientation matches the STL viewer automatically.
  useEffect(() => {
    if (!sceneRefs) return;
    const { scene } = sceneRefs;

    const group = new THREE.Group();
    scene.add(group);
    groupRef.current = group;

    return () => {
      scene.remove(group);
      if (linesRef.current) {
        group.remove(linesRef.current);
        linesRef.current.geometry.dispose();
        (linesRef.current.material as THREE.Material).dispose();
        linesRef.current = null;
      }
      groupRef.current = null;
    };
  }, [sceneRefs]);

  // Build geometry when layers change
  useEffect(() => {
    if (!groupRef.current) return;
    const group = groupRef.current;

    // Force-hide any STL mesh in the scene
    if (sceneRefs) {
      sceneRefs.scene.traverse((obj: any) => {
        if (obj.isMesh) obj.visible = false;
      });
    }

    const { layers, bounds } = parsedGcode;
    if (layers.length === 0) return;

    const endLayer = Math.min(currentLayer + 1, layers.length);
    const startLayer = showAllLayers ? 0 : currentLayer;
    const maxVisible = currentStep >= 0 ? currentStep + 1 : -1;

    let extrusionCount = 0;
    for (let i = startLayer; i < endLayer; i++) {
      for (const seg of layers[i].segments) {
        if (seg.type !== 'travel' && !hiddenTypes.has(seg.type)) {
          if (maxVisible < 0 || extrusionCount < maxVisible) extrusionCount++;
        }
      }
    }

    // Center like STL viewer: center X and Z, shift Y so bottom is at 0
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;

    const positions = new Float32Array(extrusionCount * 6);
    const colors = new Float32Array(extrusionCount * 6);

    let ei = 0;
    for (let i = startLayer; i < endLayer; i++) {
      for (const seg of layers[i].segments) {
        if (seg.type === 'travel' || hiddenTypes.has(seg.type)) continue;
        if (maxVisible >= 0 && ei >= maxVisible) break;
        // Direct mapping: gcode X→Three X, gcode Y→Three Y (up), gcode Z→Three Z
        // Same as STL viewer convention — model orientation matches automatically
        positions[ei * 6]     = seg.from.x - cx;
        positions[ei * 6 + 1] = seg.from.y - bounds.minY;
        positions[ei * 6 + 2] = seg.from.z - cz;
        positions[ei * 6 + 3] = seg.to.x - cx;
        positions[ei * 6 + 4] = seg.to.y - bounds.minY;
        positions[ei * 6 + 5] = seg.to.z - cz;

        const c = MOVE_COLORS[seg.type];
        colors[ei * 6] = c[0]; colors[ei * 6 + 1] = c[1]; colors[ei * 6 + 2] = c[2];
        colors[ei * 6 + 3] = c[0]; colors[ei * 6 + 4] = c[1]; colors[ei * 6 + 5] = c[2];
        ei++;
      }
      if (maxVisible >= 0 && ei >= maxVisible) break;
    }

    if (linesRef.current) {
      group.remove(linesRef.current);
      linesRef.current.geometry.dispose();
      (linesRef.current.material as THREE.Material).dispose();
      linesRef.current = null;
    }

    if (extrusionCount > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 1 });
      const lines = new THREE.LineSegments(geo, mat);
      group.add(lines);
      linesRef.current = lines;
    }
  }, [groupRef.current, parsedGcode, currentLayer, showAllLayers, hiddenTypes, currentStep]);

  // Frame camera — match STL viewer exactly
  useEffect(() => {
    if (!sceneRefs) return;
    if (parsedGcode.layers.length === 0) return;

    const { camera, controls } = sceneRefs;
    const { bounds } = parsedGcode;
    const sizeX = bounds.maxX - bounds.minX;
    const sizeY = bounds.maxY - bounds.minY; // Y is vertical (matches STL)
    const sizeZ = bounds.maxZ - bounds.minZ;

    const maxDim = Math.max(sizeX, sizeY, sizeZ);
    const distance = maxDim * 2;
    const centerY = sizeY / 2;

    // Same camera as STL viewer: isometric from (d, d, d) looking at center
    camera.position.set(distance, distance, distance);
    camera.lookAt(0, centerY, 0);
    camera.updateProjectionMatrix();
    controls.target.set(0, centerY, 0);
    controls.update();
    (controls as any).target0.set(0, centerY, 0);
    (controls as any).position0.copy(camera.position);
  }, [parsedGcode, sceneRefs]);

  return null;
}
