/**
 * Build the POST /api/slice request body from the current workspace state.
 * Extracted from App.tsx as a pure function — same logic, no React deps.
 */
import type { FilamentSlot, MultiMaterialConfig } from '@snorcal/shared';
import { DEFAULT_VALUES } from '../components/Settings/settings-definitions';
import type { ProjectModel } from './project-types';

export interface SelectedProfiles {
  machine?: string;
  filament?: string;
  filament2?: string;
  process?: string;
}

export interface SliceBodyContext {
  engine: string;
  settings: Record<string, string>;
  selectedProfiles: SelectedProfiles;
  multiMaterial: MultiMaterialConfig;
  filamentSlots: FilamentSlot[];
  bedVolume: { x: number; y: number; z: number } | null;
  plates: Array<{ id: string; name: string }>;
  targetPrinterId: string | null;
}

/**
 * Construct the slice request body.
 *
 * Layer DEFAULT_VALUES first so UI source-of-truth wins over backend
 * default-project-settings.json (backend defaults otherwise mismatch UI —
 * e.g. enable_prime_tower: backend "1" vs UI "0" → user sees tower they
 * never asked for). User toggles in `settings` override both.
 *
 * Auto-detects multi-material: counts distinct extruder IDs across the
 * painted faces of every model being sliced. ≥2 unique extruders means
 * the model uses 2+ filaments in a single print (multi-color paint,
 * multi-material assembly) → slicer needs the full slot list + flush
 * volumes + T<n> toolchange emission. With <2 unique, send only the
 * primary slot — otherwise an imported 3MF carrying 4 AMS-bay colours
 * would force a 4-filament slice for what's physically a single-spool
 * print. Manual toggle still ORs in (user can force multi-material e.g.
 * for support/interface on a different extruder, which the paint data
 * doesn't reflect).
 */
export function buildSliceBody(models: ProjectModel[], ctx: SliceBodyContext) {
  if (models.length === 0) throw new Error('No models');

  const processSettings: Record<string, string> = {};
  Object.assign(processSettings, DEFAULT_VALUES);
  Object.assign(processSettings, ctx.settings);
  const firstPlateIdx = ctx.plates.findIndex(p => p.id === models[0].plateId) + 1 || 1;
  const anyMultiPlate = models.some(m => m.plateCount > 1);
  const backendIdx = models[0].backendPlateIndex;

  const usedExtruders = new Set<number>();
  for (const pm of models) {
    if (pm.faceColors) {
      for (const e of pm.faceColors) usedExtruders.add(e);
    }
  }
  const autoMulti = usedExtruders.size >= 2;
  const effectiveMulti = ctx.multiMaterial.enabled || autoMulti;

  return {
    models: models.map(pm => ({
      modelId: pm.modelId,
      rotation: pm.rotation,
      positionOffset: pm.positionOffset,
      scale: pm.scale,
      mirror: pm.mirror,
      kind: pm.kind,
      linkedTo: pm.linkedTo,
      name: pm.name,
      settings: pm.settings,
      visible: pm.visible,
      negativePartRef: pm.negativePartRef,
      printablePartRef: pm.printablePartRef,
    })),
    engine: ctx.engine,
    plateIndex: backendIdx ?? (anyMultiPlate ? firstPlateIdx : undefined),
    settings: { process: processSettings, machine: {}, filaments: [{}] },
    profiles: ctx.selectedProfiles,
    multiMaterial: effectiveMulti ? ctx.multiMaterial : undefined,
    filamentSlots: ctx.filamentSlots.length > 0
      ? (effectiveMulti ? ctx.filamentSlots : [ctx.filamentSlots[0]])
      : undefined,
    buildVolume: ctx.bedVolume ?? undefined,
    printerId: ctx.targetPrinterId ?? undefined,
  } as const;
}
