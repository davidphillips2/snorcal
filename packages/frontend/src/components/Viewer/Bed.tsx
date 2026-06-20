import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { SceneRefs } from './Scene';

interface BedProps {
  sceneRefs: SceneRefs | null;
  size: { x: number; y: number; z: number };
}

/**
 * Renders the printer bed grid + outline into the shared scene.
 * Re-builds when size changes. Cleans up on unmount.
 * Grid is centered at origin in the XZ plane (Three.js Y-up).
 */
export function Bed({ sceneRefs, size }: BedProps) {
  const groupRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    if (!sceneRefs) return;
    const scene = sceneRefs.scene;
    // Dispose previous
    if (groupRef.current) {
      scene.remove(groupRef.current);
      groupRef.current.traverse(obj => {
        if (obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      groupRef.current = null;
    }

    const { x: bedX, y: bedY } = size;
    // GridHelper is centered at origin; divisions ~ every 10mm
    const divisions = Math.max(10, Math.round(Math.max(bedX, bedY) / 10));
    const grid = new THREE.GridHelper(Math.max(bedX, bedY), divisions, 0x444444, 0x333333);
    // Grid is in XZ plane natively; keep default orientation — matches STLViewer's coordinate assumption.

    // Bed outline (rectangle in XZ)
    const hx = bedX / 2;
    const hz = bedY / 2;  // map bed Y → Three.js Z
    const outlinePoints = [
      new THREE.Vector3(-hx, 0, -hz),
      new THREE.Vector3(hx, 0, -hz),
      new THREE.Vector3(hx, 0, hz),
      new THREE.Vector3(-hx, 0, hz),
      new THREE.Vector3(-hx, 0, -hz),
    ];
    const outlineGeo = new THREE.BufferGeometry().setFromPoints(outlinePoints);
    const outline = new THREE.Line(outlineGeo, new THREE.LineBasicMaterial({ color: 0x666666 }));

    const group = new THREE.Group();
    group.add(grid);
    group.add(outline);
    scene.add(group);
    groupRef.current = group;

    return () => {
      if (groupRef.current) {
        scene.remove(groupRef.current);
        groupRef.current.traverse(obj => {
          if (obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
            obj.geometry.dispose();
            (obj.material as THREE.Material).dispose();
          }
        });
        groupRef.current = null;
      }
    };
  }, [sceneRefs, size.x, size.y, size.z]);

  return null;
}
