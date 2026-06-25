import * as THREE from 'three';

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'world' | 'local';

export interface SnapSettings {
  enabled: boolean;
  translateMM: number;   // default 1
  rotateDeg: number;     // default 15
}

export interface AABB {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export interface CollisionPair {
  a: number;  // projectModels index
  b: number;
  overlapVolume: number;
}

/**
 * World-space AABB for a mesh — accounts for current matrixWorld.
 * Caller must ensure mesh.matrixWorld is up to date.
 */
export function computeWorldAABB(mesh: THREE.Object3D): AABB {
  const box = new THREE.Box3().setFromObject(mesh);
  return { min: box.min.clone(), max: box.max.clone() };
}

/**
 * Geometric center of the given meshes' world AABBs.
 */
export function computeSelectionCenter(meshes: THREE.Object3D[]): THREE.Vector3 {
  if (meshes.length === 0) return new THREE.Vector3();
  const acc = new THREE.Vector3();
  for (const m of meshes) {
    const box = new THREE.Box3().setFromObject(m);
    const c = new THREE.Vector3();
    box.getCenter(c);
    acc.add(c);
  }
  return acc.divideScalar(meshes.length);
}

/**
 * Pairwise AABB overlap test. Returns overlap volume for each colliding pair.
 * O(n^2) — fine for typical Slorca model counts (<20/plate).
 */
export function detectAABBOverlaps(boxes: Array<{ idx: number; aabb: AABB }>): CollisionPair[] {
  const pairs: CollisionPair[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i].aabb;
      const B = boxes[j].aabb;
      const overlapX = Math.max(0, Math.min(A.max.x, B.max.x) - Math.max(A.min.x, B.min.x));
      const overlapY = Math.max(0, Math.min(A.max.y, B.max.y) - Math.max(A.min.y, B.min.y));
      const overlapZ = Math.max(0, Math.min(A.max.z, B.max.z) - Math.max(A.min.z, B.min.z));
      const vol = overlapX * overlapY * overlapZ;
      if (vol > 0) {
        pairs.push({ a: boxes[i].idx, b: boxes[j].idx, overlapVolume: vol });
      }
    }
  }
  return pairs;
}

/**
 * Distance in millimeters between the world-space centers of two meshes.
 */
export function centerDistance(a: THREE.Object3D, b: THREE.Object3D): number {
  const ca = new THREE.Vector3();
  const cb = new THREE.Vector3();
  new THREE.Box3().setFromObject(a).getCenter(ca);
  new THREE.Box3().setFromObject(b).getCenter(cb);
  return ca.distanceTo(cb);
}

/**
 * Returns true if the user's primary pointer is touch (no fine cursor).
 * Used to skip TransformControls gizmo on mobile — handles are too fiddly.
 */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}
