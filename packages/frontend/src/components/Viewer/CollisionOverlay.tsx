import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { SceneRefs } from './Scene';
import type { ProjectModel } from '../../App';
import { computeWorldAABB, detectAABBOverlaps, type AABB } from '../../lib/transforms';

interface Props {
  sceneRefs: SceneRefs | null;
  /** Models on the active plate (filtered by caller). Length + order must
   *  match `meshes`. */
  models: ProjectModel[];
  /** Meshes parallel to `models`. */
  meshes: THREE.Mesh[];
  /** Toggle: when false overlay is removed. */
  enabled: boolean;
}

/**
 * Phase 5 — AABB pairwise overlap overlay. Renders a red wireframe box around
 * each model that participates in any colliding pair. Recomputes on transform
 * changes (debounced 60ms). Collision is advisory only — slicing is unaffected.
 */
export function CollisionOverlay({ sceneRefs, models, meshes, enabled }: Props) {
  const groupRef = useRef<THREE.Group | null>(null);
  const [collidingIdx, setCollidingIdx] = useState<Set<number>>(new Set());

  // Build a signature of all model transforms so we recompute on movement.
  const signature = useMemo(() => models.map(m => [
    m.uid,
    m.positionOffset.x.toFixed(3),
    m.positionOffset.y.toFixed(3),
    m.positionOffset.z.toFixed(3),
    m.rotation.x.toFixed(3), m.rotation.y.toFixed(3), m.rotation.z.toFixed(3),
    m.scale.x.toFixed(3), m.scale.y.toFixed(3), m.scale.z.toFixed(3),
    m.mirror.x, m.mirror.y, m.mirror.z,
  ].join(',')).join('|'), [models]);

  // Debounced overlap detection.
  useEffect(() => {
    if (!enabled) { setCollidingIdx(new Set()); return; }
    const timer = setTimeout(() => {
      // Force matrixWorld update on the parent scene before reading AABBs.
      if (sceneRefs) sceneRefs.scene.updateMatrixWorld(true);
      const boxes: Array<{ idx: number; aabb: AABB }> = [];
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        if (!mesh || !models[i]?.visible) continue;
        boxes.push({ idx: i, aabb: computeWorldAABB(mesh) });
      }
      const pairs = detectAABBOverlaps(boxes);
      const next = new Set<number>();
      for (const p of pairs) { next.add(p.a); next.add(p.b); }
      setCollidingIdx(next);
    }, 60);
    return () => clearTimeout(timer);
  }, [enabled, signature, sceneRefs, meshes, models]);

  // (Re)build wireframe group when collidingIdx changes.
  useEffect(() => {
    if (!sceneRefs) return;
    // Clear prior group.
    if (groupRef.current) {
      sceneRefs.scene.remove(groupRef.current);
      groupRef.current.traverse(o => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry!.dispose();
        const mat = (o as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach(m => m.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      });
      groupRef.current = null;
    }
    if (collidingIdx.size === 0) return;

    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.85 });
    for (const i of collidingIdx) {
      const mesh = meshes[i];
      if (!mesh) continue;
      const box = new THREE.Box3().setFromObject(mesh);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
      const edges = new THREE.EdgesGeometry(geo);
      const lines = new THREE.LineSegments(edges, mat);
      lines.position.copy(center);
      group.add(lines);
      geo.dispose();
    }
    sceneRefs.scene.add(group);
    groupRef.current = group;

    return () => {
      if (groupRef.current && sceneRefs) {
        try { sceneRefs.scene.remove(groupRef.current); } catch {}
      }
    };
  }, [sceneRefs, collidingIdx, meshes]);

  return null;
}
