import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { SceneRefs } from './Scene';
import type { ProjectModel } from '../../App';
import { centerDistance } from '../../lib/transforms';

interface Props {
  sceneRefs: SceneRefs | null;
  models: ProjectModel[];
  meshes: THREE.Mesh[];
  enabled: boolean;
}

/**
 * Phase 6 — distance line + label between first and last selected model
 * centers. Updates live as either mesh moves (driven by projectModels prop
 * changes from App). Label is an HTML element repositioned each frame via
 * camera projection.
 */
export function MultiMeasureOverlay({ sceneRefs, models, meshes, enabled }: Props) {
  const lineRef = useRef<THREE.Line | null>(null);
  const [labelScreen, setLabelScreen] = useState<{ x: number; y: number; dist: number; n: number } | null>(null);

  const active = enabled && meshes.length >= 2;

  // Signature of transforms so we recompute on movement.
  const signature = useMemo(() => models.map(m => [
    m.uid,
    m.positionOffset.x.toFixed(3), m.positionOffset.y.toFixed(3), m.positionOffset.z.toFixed(3),
    m.rotation.x.toFixed(3), m.rotation.y.toFixed(3), m.rotation.z.toFixed(3),
    m.scale.x.toFixed(3), m.scale.y.toFixed(3), m.scale.z.toFixed(3),
  ].join(',')).join('|'), [models]);

  // Build / teardown line in scene.
  useEffect(() => {
    if (!sceneRefs) return;
    // Clear prior line.
    if (lineRef.current) {
      sceneRefs.scene.remove(lineRef.current);
      lineRef.current.geometry.dispose();
      (lineRef.current.material as THREE.Material).dispose();
      lineRef.current = null;
    }
    if (!active || meshes.length < 2) return;

    const a = meshes[0];
    const b = meshes[meshes.length - 1];
    if (!a || !b) return;
    const ca = new THREE.Vector3();
    const cb = new THREE.Vector3();
    new THREE.Box3().setFromObject(a).getCenter(ca);
    new THREE.Box3().setFromObject(b).getCenter(cb);
    const geo = new THREE.BufferGeometry().setFromPoints([ca, cb]);
    const mat = new THREE.LineBasicMaterial({ color: 0x66ddff, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geo, mat);
    sceneRefs.scene.add(line);
    lineRef.current = line;

    return () => {
      if (lineRef.current && sceneRefs) {
        try { sceneRefs.scene.remove(lineRef.current); } catch {}
        lineRef.current.geometry.dispose();
        (lineRef.current.material as THREE.Material).dispose();
        lineRef.current = null;
      }
    };
  }, [sceneRefs, active, signature, meshes]);

  // Per-frame: project midpoint to screen + compute distance.
  useEffect(() => {
    if (!sceneRefs || !active || meshes.length < 2) {
      setLabelScreen(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const a = meshes[0];
      const b = meshes[meshes.length - 1];
      if (!a || !b) { setLabelScreen(null); return; }
      const ca = new THREE.Vector3();
      const cb = new THREE.Vector3();
      new THREE.Box3().setFromObject(a).getCenter(ca);
      new THREE.Box3().setFromObject(b).getCenter(cb);
      const mid = ca.clone().add(cb).multiplyScalar(0.5);
      const dist = ca.distanceTo(cb);
      const proj = mid.clone().project(sceneRefs.camera);
      const w = sceneRefs.renderer.domElement.clientWidth;
      const h = sceneRefs.renderer.domElement.clientHeight;
      const x = (proj.x * 0.5 + 0.5) * w;
      const y = (-proj.y * 0.5 + 0.5) * h;
      setLabelScreen(prev => {
        const next = { x, y, dist, n: meshes.length };
        if (prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5 && Math.abs(prev.dist - dist) < 0.01) {
          return prev;
        }
        return next;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sceneRefs, active, signature, meshes]);

  if (!active || !labelScreen) return null;

  return (
    <div
      className="absolute pointer-events-none z-30 -translate-x-1/2 -translate-y-1/2"
      style={{ left: labelScreen.x, top: labelScreen.y }}
    >
      <div className="px-1.5 py-0.5 rounded bg-cyan-500/90 text-white text-[10px] font-mono shadow">
        {labelScreen.dist.toFixed(1)} mm
        {labelScreen.n > 2 && <span className="ml-1 text-cyan-100/80">({labelScreen.n} sel)</span>}
      </div>
    </div>
  );
}
