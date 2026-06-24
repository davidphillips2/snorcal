/**
 * Axis-aligned bounding box of a flat [x,y,z, x,y,z, ...] positions array.
 *
 * Returns the 6-component min/max. Used by 3MF builder (post-transform
 * vertices) and parser (loaded positions). Tight per-face loops that
 * interleave bounds tracking with other writes (binary STL read, multi-array
 * copies) should inline the comparison instead — call overhead dominates
 * at 100k+ faces.
 */
export interface BoundsXYZ {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function computeBounds(positions: ArrayLike<number>): BoundsXYZ {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}
