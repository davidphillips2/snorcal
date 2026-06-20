/**
 * Shelf-based 2D bin packing for plate auto-arrange.
 *
 * Items are sorted by descending Y footprint, placed left-to-right on a
 * shelf; when shelf overflows, start a new shelf above the tallest item
 * in the current one. Output positions are translated so the packed
 * region is centered on the bed origin.
 *
 * Margins are added around each item (half each side) and between
 * shelves so adjacent models never touch.
 */

export interface PackItem {
  id: string;
  /** Item XY footprint in mm. */
  width: number;
  depth: number;
}

export interface PackResult {
  /** Map of id → { x, z } center position relative to bed origin (0,0). */
  positions: Map<string, { x: number; z: number }>;
  bounds: { width: number; depth: number };
}

export function shelfPack(
  items: PackItem[],
  bedWidth: number,
  bedDepth: number,
  margin = 5,
): PackResult {
  if (items.length === 0) return { positions: new Map(), bounds: { width: 0, depth: 0 } };

  // Sort by depth desc (shelves stack vertically; tallest first minimises wasted vertical)
  const sorted = [...items].sort((a, b) => b.depth - a.depth || b.width - a.width);

  const positions = new Map<string, { x: number; z: number }>();
  let shelfX = margin;
  let shelfZ = margin;
  let shelfDepth = 0;
  let totalWidth = 0;
  let totalDepth = 0;

  for (const item of sorted) {
    const w = item.width + 2 * margin;
    const d = item.depth + 2 * margin;

    if (shelfX + w > bedWidth + margin) {
      // Wrap to next shelf
      shelfZ += shelfDepth;
      shelfX = margin;
      shelfDepth = 0;
    }

    // Center of item within its margin cell
    positions.set(item.id, {
      x: shelfX + margin + item.width / 2,
      z: shelfZ + margin + item.depth / 2,
    });

    shelfX += w;
    shelfDepth = Math.max(shelfDepth, d);
    totalWidth = Math.max(totalWidth, shelfX);
    totalDepth = Math.max(totalDepth, shelfZ + shelfDepth);
  }

  // Recenter packing region on bed center
  const offX = (bedWidth - totalWidth) / 2;
  const offZ = (bedDepth - totalDepth) / 2;
  for (const [id, pos] of positions) {
    pos.x += offX;
    pos.z += offZ;
  }

  return { positions, bounds: { width: totalWidth, depth: totalDepth } };
}
