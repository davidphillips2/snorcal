/**
 * Core project types shared across the slice workspace. Extracted from App.tsx
 * so handlers, persistence, and slice-body construction can live in lib/.
 */
import type { ModelKind, Scale3D, Mirror3D, FilamentSlot } from '@snorcal/shared';
import type { Rotation3D } from '../components/Viewer/STLViewer';

/** A single object instance on the bed (model, modifier, negative, support). */
export interface ProjectModel {
  /** Stable instance id (survives array reorders) — used as React key + meshRefs key. */
  uid: string;
  modelId: string;
  name: string;
  faceCount: number;
  plateCount: number;
  /** Backend plate index inside a multi-plate 3MF (1-based). Set when this pm
   *  represents one plate of a multi-plate import. Undefined for single-plate
   *  uploads and for user-created UI plates that don't map to a backend plate. */
  backendPlateIndex?: number;
  /** Object names extracted from the 3MF's model_settings.config for the plate
   *  this pm represents. Labels the plate tab with what's on it (e.g.
   *  "Mickey1.step") instead of the meaningless filename. */
  backendPlateObjectNames?: string[];
  /** Which plate this model belongs to. */
  plateId: string;
  rotation: Rotation3D;
  positionOffset: { x: number; y: number; z: number };
  scale: Scale3D;                  // default {1,1,1}
  mirror: Mirror3D;                // default {false,false,false}
  faceColors: Uint8Array | null;
  visible: boolean;
  kind: ModelKind;                 // default 'model'
  /** Parent modelId(s) for negative/modifier volumes. */
  linkedTo?: string[];
  /** Per-object override (modifier subset). */
  settings?: Record<string, unknown>;
  /** Set when this ProjectModel is an embedded negative part (sourced from a
   *  3MF upload). Renders via /files/model/:parentId/negative/:plate/:part. */
  negativePartRef?: { parentModelId: string; plate: number; part: number };
  /** Set when this ProjectModel is a printable sub-object of a 3MF assembly
   *  (one `<object>` inside the parent 3MF). Renders via
   *  /files/model/:parentId/part/:plate/:part. */
  printablePartRef?: { parentModelId: string; plate: number; part: number };
}

export const DEFAULT_SCALE: Scale3D = { x: 1, y: 1, z: 1 };
export const DEFAULT_MIRROR: Mirror3D = { x: false, y: false, z: false };

/** Frontend job view-model (subset of backend job row). */
export interface Job {
  id: string;
  modelName?: string;
  engine: string;
  status: string;
  progress: number;
  currentStep?: string;
  gcodeSize?: number;
  estimatedTime?: string;
  filamentUsedG?: number;
  filamentCost?: number;
  errorMessage?: string;
  plateIndex?: number;
  createdAt: string;
}

export type { Rotation3D, ModelKind, Scale3D, Mirror3D, FilamentSlot };

/**
 * Generate a stable unique id. crypto.randomUUID requires a secure context
 * (https or localhost); LAN IPs over plain http don't qualify on Safari, so
 * fall back to getRandomValues.
 */
export function makeUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const buf = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

/** Upload metadata shape returned by POST /models (subset used by builders). */
export interface UploadModelMeta {
  id: string;
  name: string;
  boundsMin?: { x: number; y: number; z: number };
  boundsMax?: { x: number; y: number; z: number };
  negativeParts?: Array<{ plateIndex: number; partIndex: number; faceCount: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number } }>;
  parts?: Array<{ plateIndex: number; partIndex: number; faceCount: number; name?: string; extruder?: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number } }>;
}

/**
 * Build child ProjectModels (kind=negative) for every embedded negative part
 * that ships with a 3MF (e.g. MakerWorld keyring holes). Each child links to
 * its parent via `linkedTo` and carries a `negativePartRef` so the slicer can
 * resolve geometry via /files/model/:parentId/negative/:plate/:part.
 *
 * Delta offset puts the child next to the parent after STLViewer's per-mesh
 * centering (parent gets centered to origin; child needs to compensate).
 */
export function buildNegativeChildPms(model: UploadModelMeta, plateId: string, offset: number): ProjectModel[] {
  if (!model.negativeParts || model.negativeParts.length === 0 || !model.boundsMin || !model.boundsMax) {
    return [];
  }
  const pCx = (model.boundsMin.x + model.boundsMax.x) / 2;
  const pCz = (model.boundsMin.z + model.boundsMax.z) / 2;
  const pMinY = model.boundsMin.y;
  const children: ProjectModel[] = [];
  for (const np of model.negativeParts) {
    if (np.plateIndex !== 1) continue; // multi-plate imports surface only plate-1 children on the freshly-created pm
    if (!np.boundsMin || !np.boundsMax) continue;
    const cCx = (np.boundsMin.x + np.boundsMax.x) / 2;
    const cCz = (np.boundsMin.z + np.boundsMax.z) / 2;
    children.push({
      uid: makeUid(),
      modelId: model.id, // child reuses parent id; URL resolved via negativePartRef
      name: `${model.name} (neg ${np.partIndex})`,
      faceCount: np.faceCount,
      plateCount: 1,
      plateId,
      rotation: { x: 0, y: 0, z: 0 },
      positionOffset: {
        x: offset + (cCx - pCx),
        y: np.boundsMin.y - pMinY,
        z: cCz - pCz,
      },
      scale: { ...DEFAULT_SCALE },
      mirror: { ...DEFAULT_MIRROR },
      faceColors: null,
      visible: true,
      kind: 'negative',
      linkedTo: [model.id],
      negativePartRef: { parentModelId: model.id, plate: np.plateIndex, part: np.partIndex },
    });
  }
  return children;
}

/**
 * Build child ProjectModels (kind=part) for every printable sub-object in a
 * 3MF assembly (each `<object>` in the source file). Mirrors
 * `buildNegativeChildPms` but for printable parts that compose the parent
 * assembly rather than cutters that subtract from it.
 *
 * Each child links via `linkedTo` and carries a `printablePartRef` so the
 * slicer resolves geometry via /files/model/:parentId/part/:plate/:part.
 */
export function buildPrintableChildPms(model: UploadModelMeta, plateId: string): ProjectModel[] {
  if (!model.parts || model.parts.length === 0) return [];
  // Only plate-1 parts attach to the freshly-created pm (mirrors the
  // negative-parts rule). Multi-plate uploads create one pm per plate.
  return model.parts
    .filter(pp => pp.plateIndex === 1)
    .map(pp => ({
      uid: makeUid(),
      modelId: model.id,
      name: pp.name ?? `${model.name} (part ${pp.partIndex})`,
      faceCount: pp.faceCount,
      plateCount: 1,
      plateId,
      // Identity transform — the per-part STL already has Y-up coordinates
      // captured at parse time. Parent's plate-centering happens in
      // threemf-builder, applied via the parentOffset mechanism that all
      // children share.
      rotation: { x: 0, y: 0, z: 0 },
      positionOffset: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      mirror: { x: false, y: false, z: false },
      faceColors: null,
      visible: true,
      kind: 'part',
      linkedTo: [model.id],
      printablePartRef: { parentModelId: model.id, plate: pp.plateIndex, part: pp.partIndex },
    }));
}
