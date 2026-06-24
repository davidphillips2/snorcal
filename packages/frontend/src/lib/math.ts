/** Trig + 2D distance helpers shared across viewer components. */

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

export const deg2rad = (deg: number): number => deg * DEG_TO_RAD;
export const rad2deg = (rad: number): number => rad * RAD_TO_DEG;

/** Squared 2D distance — use when comparing to a threshold (avoids sqrt). */
export function distSq2(dx: number, dy: number): number {
  return dx * dx + dy * dy;
}

/** Euclidean 2D distance. */
export function dist2(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}
