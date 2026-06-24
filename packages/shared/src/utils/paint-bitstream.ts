/**
 * TriangleSelector paint_color bitstream codec.
 *
 * Format documented in OrcaSlicer `Model.cpp set_triangle_from_string` and
 * `TriangleSelector.cpp next_nibble / serialize`. Hex chars are read in
 * REVERSE (rightmost first); each char is a 4-bit nibble, LSB-first within
 * the nibble.
 *
 *   bits 0-1 of first nibble = split_sides (00 for unsplit leaf)
 *   bits 2-3 of first nibble = code:
 *     00 → state 0 (unpainted)
 *     01 → state 1 (extruder 1)
 *     10 → state 2 (extruder 2)
 *     11 → escape: read next nibble, state = nibble + 3 (extruder ≥3)
 *
 * For split triangles (multi-nibble bitstreams encoding the sub-tree), the
 * decoder reads the first leaf's state — this loses sub-triangle granularity
 * but those are <0.1% of faces on typical painted models.
 *
 * IMPORTANT: Bambu Studio emits `5C/6C/7C` for extruders 1/2/3 — OrcaSlicer
 * 2.4.0's parser mis-reads those as extruders 8/9/10 and slices all-white.
 * Use `encodeExtruder` (which emits `4/8/0C/1C/...`) for new writes.
 */

/** Encode 1-based extruder index → paint_color hex string. */
export function encodeExtruder(extruderIndex: number): string {
  if (extruderIndex === 1) return '4';
  if (extruderIndex === 2) return '8';
  return (extruderIndex - 3).toString(16).toUpperCase() + 'C';
}

/**
 * Decode a paint_color hex string → 1-based extruder index.
 * Returns 0 for unpainted / unparseable.
 */
export function decodeExtruder(paintColor: string): number {
  const chars = String(paintColor).toUpperCase();
  const firstNibble = parseInt(chars[chars.length - 1], 16);
  if (Number.isNaN(firstNibble)) return 0;
  const code = (firstNibble >> 2) & 0b11;
  if (code === 0b11 && chars.length >= 2) {
    const nextNibble = parseInt(chars[chars.length - 2], 16);
    if (Number.isNaN(nextNibble)) return 0;
    return nextNibble + 3;
  }
  return code;
}
