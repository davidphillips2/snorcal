import * as THREE from 'three';

/**
 * Convert a BufferGeometry into a binary STL Blob.
 * - Applies the supplied world matrix (geometry assumed in local space).
 * - Writes per-triangle facet normal + 3 vertices (50 bytes each).
 * - Returns a File suitable for `uploadModel(file)`.
 *
 * Caller controls the filename — default extension is `.stl`.
 */
export function geometryToSTL(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4 = new THREE.Matrix4(),
  filename = 'edited.stl',
): File {
  const baked = bakeGeometry(geometry, matrix);
  const positions = baked.getAttribute('position');
  const normals = baked.getAttribute('normal');

  const triCount = positions.count / 3;
  // 84-byte header + 50 bytes per triangle
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);

  // Header — leave zeroed, write triangle count at offset 80
  dv.setUint32(80, triCount, true);

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let off = 84;
  let attrIdx = 0;

  for (let t = 0; t < triCount; t++) {
    v0.fromBufferAttribute(positions, attrIdx);
    v1.fromBufferAttribute(positions, attrIdx + 1);
    v2.fromBufferAttribute(positions, attrIdx + 2);
    attrIdx += 3;

    // Prefer baked normals (per-vertex, first vertex of triangle) when available
    if (normals) {
      normal.fromBufferAttribute(normals, t * 3);
    } else {
      normal.copy(v1).sub(v0).cross(v2.clone().sub(v0)).normalize();
    }

    dv.setFloat32(off + 0, normal.x, true);
    dv.setFloat32(off + 4, normal.y, true);
    dv.setFloat32(off + 8, normal.z, true);
    dv.setFloat32(off + 12, v0.x, true);
    dv.setFloat32(off + 16, v0.y, true);
    dv.setFloat32(off + 20, v0.z, true);
    dv.setFloat32(off + 24, v1.x, true);
    dv.setFloat32(off + 28, v1.y, true);
    dv.setFloat32(off + 32, v1.z, true);
    dv.setFloat32(off + 36, v2.x, true);
    dv.setFloat32(off + 40, v2.y, true);
    dv.setFloat32(off + 44, v2.z, true);
    // attribute byte count — 0 (no color)
    dv.setUint16(off + 48, 0, true);
    off += 50;
  }

  return new File([buf], filename, { type: 'model/stl' });
}

/** Non-indexed, world-space geometry with computed normals. */
function bakeGeometry(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const clone = geometry.clone();
  clone.applyMatrix4(matrix);
  const nonIndexed = clone.index ? clone.toNonIndexed() : clone;
  nonIndexed.computeVertexNormals();
  return nonIndexed;
}
