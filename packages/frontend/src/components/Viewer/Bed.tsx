import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { SceneRefs } from './Scene';

interface PlateLayout {
  id: string;
  offset: { x: number; y: number; z: number };
  active: boolean;
}

interface BedProps {
  sceneRefs: SceneRefs | null;
  size: { x: number; y: number; z: number };
  plates: PlateLayout[];
  onSelectPlate?: (id: string) => void;
}

/**
 * Renders one bed grid + outline per plate, side-by-side. Active plate gets a
 * brighter outline. Optional click-to-select via raycasting on the outline planes.
 */
export function Bed({ sceneRefs, size, plates, onSelectPlate }: BedProps) {
  const groupRef = useRef<THREE.Group | null>(null);
  const pickTargetRef = useRef<{ mesh: THREE.Object3D; plateId: string }[]>([]);

  useEffect(() => {
    if (!sceneRefs) return;
    const scene = sceneRefs.scene;

    // Dispose previous
    if (groupRef.current) {
      scene.remove(groupRef.current);
      disposeGroup(groupRef.current);
      groupRef.current = null;
    }
    pickTargetRef.current = [];

    const { x: bedX, y: bedY } = size;
    const divisions = Math.max(10, Math.round(Math.max(bedX, bedY) / 10));
    const hx = bedX / 2;
    const hz = bedY / 2;  // bed Y → Three.js Z

    const group = new THREE.Group();

    for (const plate of plates) {
      const px = plate.offset.x;

      // Sub-group per plate so we can offset easily
      const plateGroup = new THREE.Group();
      plateGroup.position.set(px, 0, 0);

      // Grid
      const grid = new THREE.GridHelper(Math.max(bedX, bedY), divisions, 0x444444, 0x333333);
      plateGroup.add(grid);

      // Outline (rectangle in XZ plane)
      const outlinePoints = [
        new THREE.Vector3(-hx, 0, -hz),
        new THREE.Vector3(hx, 0, -hz),
        new THREE.Vector3(hx, 0, hz),
        new THREE.Vector3(-hx, 0, hz),
        new THREE.Vector3(-hx, 0, -hz),
      ];
      const outlineGeo = new THREE.BufferGeometry().setFromPoints(outlinePoints);
      const outlineColor = plate.active ? 0x3b82f6 : 0x666666;
      const outline = new THREE.Line(outlineGeo, new THREE.LineBasicMaterial({ color: outlineColor }));

      // Invisible plane used as click target (raycaster needs a surface)
      const planeGeo = new THREE.PlaneGeometry(bedX, bedY);
      planeGeo.rotateX(-Math.PI / 2);
      const planeMat = new THREE.MeshBasicMaterial({ visible: false });
      const plane = new THREE.Mesh(planeGeo, planeMat);
      plateGroup.add(outline);
      plateGroup.add(plane);

      group.add(plateGroup);
      pickTargetRef.current.push({ mesh: plane, plateId: plate.id });
    }

    scene.add(group);
    groupRef.current = group;

    return () => {
      if (groupRef.current) {
        scene.remove(groupRef.current);
        disposeGroup(groupRef.current);
        groupRef.current = null;
      }
      pickTargetRef.current = [];
    };
  }, [sceneRefs, size.x, size.y, size.z, JSON.stringify(plates.map(p => `${p.id}:${p.active}:${p.offset.x}`))]);

  // Click-to-select: raycast on pointerdown using sceneRefs.renderer.domElement
  useEffect(() => {
    if (!sceneRefs || !onSelectPlate) return;
    const { camera, renderer } = sceneRefs;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const onPointerDown = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const targets = pickTargetRef.current.map(t => t.mesh);
      const hits = raycaster.intersectObjects(targets, false);
      if (hits.length === 0) return;
      const hit = hits[0].object;
      const found = pickTargetRef.current.find(t => t.mesh === hit);
      if (found) onSelectPlate(found.plateId);
    };
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', onPointerDown);
    return () => canvas.removeEventListener('pointerdown', onPointerDown);
  }, [sceneRefs, onSelectPlate]);

  return null;
}

function disposeGroup(group: THREE.Object3D) {
  group.traverse(obj => {
    if (obj instanceof THREE.LineSegments || obj instanceof THREE.Line || obj instanceof THREE.Mesh) {
      obj.geometry?.dispose?.();
      const mat = (obj as any).material;
      if (Array.isArray(mat)) mat.forEach((m: THREE.Material) => m.dispose());
      else mat?.dispose?.();
    }
  });
}
