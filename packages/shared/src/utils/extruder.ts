/**
 * Machine extruder count detection.
 *
 * Reads `nozzle_diameter` (array length = toolhead count) and special-cases
 * the Snapmaker U1 (J1 toolhead — always 4) since its profile may load with
 * a single nozzle entry. Uses `Math.max` so a profile claiming fewer nozzles
 * than the U1 baseline never shrinks the count.
 */

export function getMachineExtruderCount(projectSettings: Record<string, unknown> | null | undefined): number {
  const nozzleArr = projectSettings?.nozzle_diameter as unknown[] | undefined;
  let count = Array.isArray(nozzleArr) ? nozzleArr.length : 1;
  const pModel = projectSettings?.printer_model;
  if (typeof pModel === 'string' && pModel.includes('U1')) {
    count = Math.max(count, 4);
  }
  return count;
}
