import * as THREE from 'three';

/**
 * Outward-facing unit normal of triangle (i0, i0+1, i0+2) in `posAttr`.
 *
 * Computes face normal via cross product, then flips it to point away from
 * `meshCenter` (using the face centroid direction). Returns a fresh Vector3.
 *
 * For one-shot queries (raycast hits, click handlers). Hot loops (e.g.
 * auto-orient walking 100k+ faces) should inline this with pre-allocated
 * temps to avoid per-face allocation.
 */
export function outwardNormalFromFace(
  posAttr: THREE.BufferAttribute,
  i0: number,
  meshCenter: THREE.Vector3,
): THREE.Vector3 {
  const v0 = new THREE.Vector3().fromBufferAttribute(posAttr, i0);
  const v1 = new THREE.Vector3().fromBufferAttribute(posAttr, i0 + 1);
  const v2 = new THREE.Vector3().fromBufferAttribute(posAttr, i0 + 2);
  const edge1 = new THREE.Vector3().subVectors(v1, v0);
  const edge2 = new THREE.Vector3().subVectors(v2, v0);
  const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
  const centroid = new THREE.Vector3().add(v0).add(v1).add(v2).multiplyScalar(1 / 3);
  const outward = centroid.clone().sub(meshCenter).normalize();
  if (normal.dot(outward) < 0) normal.negate();
  return normal;
}
