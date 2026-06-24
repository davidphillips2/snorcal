import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { SceneRefs } from '../Viewer/Scene';

interface MeasureToolProps {
  sceneRefs: SceneRefs | null;
  /** Visible meshes to raycast against (active plate + all plates). */
  meshes: THREE.Mesh[];
  active: boolean;
  onMeasurementChange?: (m: Measurement | null) => void;
}

export interface Measurement {
  a: THREE.Vector3;
  b: THREE.Vector3;
  distance: number;
  dx: number;
  dy: number;
  dz: number;
  angleXY: number;  // degrees, projected on XY
}

/**
 * Click two points on any visible mesh. Renders a red line between them with
 * a 2D overlay showing distance + axis deltas + angle. Active only when
 * `paintMode === 'measure'`. Esc / right-click clears current selection.
 */
export function MeasureTool({ sceneRefs, meshes, active, onMeasurementChange }: MeasureToolProps) {
  const lineRef = useRef<THREE.Line | null>(null);
  const markersRef = useRef<THREE.Group | null>(null);
  const firstPointRef = useRef<THREE.Vector3 | null>(null);
  const [pending, setPending] = useState<THREE.Vector3 | null>(null);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);

  // Reset on activate
  useEffect(() => {
    if (!active) {
      firstPointRef.current = null;
      setPending(null);
      setMeasurement(null);
      onMeasurementChange?.(null);
    }
  }, [active, onMeasurementChange]);

  useEffect(() => {
    onMeasurementChange?.(measurement);
  }, [measurement, onMeasurementChange]);

  // Render scene graphics whenever pending/measurement changes
  useEffect(() => {
    if (!sceneRefs) return;
    const scene = sceneRefs.scene;

    // Clear old line
    if (lineRef.current) {
      scene.remove(lineRef.current);
      lineRef.current.geometry.dispose();
      (lineRef.current.material as THREE.Material).dispose();
      lineRef.current = null;
    }
    // Reset marker group
    if (!markersRef.current) {
      markersRef.current = new THREE.Group();
      scene.add(markersRef.current);
    } else {
      while (markersRef.current.children.length > 0) {
        const c = markersRef.current.children.pop()!;
        if (c instanceof THREE.Mesh) { c.geometry.dispose(); (c.material as THREE.Material).dispose(); }
      }
    }

    const points: THREE.Vector3[] = [];
    if (pending) points.push(pending);
    if (measurement) { points.push(measurement.a); points.push(measurement.b); }

    for (const p of points) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1.2, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffff00 }),
      );
      m.position.copy(p);
      markersRef.current!.add(m);
    }

    if (measurement) {
      const geo = new THREE.BufferGeometry().setFromPoints([measurement.a, measurement.b]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffff00 }));
      scene.add(line);
      lineRef.current = line;
    }
  }, [pending, measurement, sceneRefs, active]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sceneRefs && lineRef.current) {
        sceneRefs.scene.remove(lineRef.current);
        lineRef.current.geometry.dispose();
        (lineRef.current.material as THREE.Material).dispose();
        lineRef.current = null;
      }
      if (sceneRefs && markersRef.current) {
        sceneRefs.scene.remove(markersRef.current);
        markersRef.current.traverse(o => {
          if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
        });
        markersRef.current = null;
      }
    };
  }, [sceneRefs]);

  // Click → raycast
  useEffect(() => {
    if (!sceneRefs || !active) return;
    const { camera, renderer } = sceneRefs;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) return;
      const pt = hits[0].point.clone();

      if (!firstPointRef.current) {
        firstPointRef.current = pt;
        setPending(pt);
        setMeasurement(null);
      } else {
        const a = firstPointRef.current;
        const distance = a.distanceTo(pt);
        const dx = pt.x - a.x;
        const dy = pt.y - a.y;
        const dz = pt.z - a.z;
        const angleXY = Math.atan2(dy, dx) * 180 / Math.PI;
        setMeasurement({ a: a.clone(), b: pt, distance, dx, dy, dz, angleXY });
        firstPointRef.current = null;
        setPending(null);
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      firstPointRef.current = null;
      setPending(null);
      setMeasurement(null);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        firstPointRef.current = null;
        setPending(null);
        setMeasurement(null);
      }
    };

    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKey);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKey);
    };
  }, [sceneRefs, active, meshes]);

  return null;
}
