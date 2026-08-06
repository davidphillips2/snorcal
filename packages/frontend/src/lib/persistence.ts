/**
 * localStorage persistence for the slice project. Extracted from App.tsx.
 *
 * One blob (`snorcal_project`) holds the full workspace state so a reload
 * lands the user where they left off. Legacy `slorca_*` keys are migrated
 * one-shot for the old project name.
 */
import type { ModelKind, Scale3D, Mirror3D, FilamentSlot } from '@snorcal/shared';
import type { Rotation3D } from '../components/Viewer/STLViewer';
import type { TransformMode, TransformSpace } from './transforms';

interface PersistedModel {
  uid?: string; // optional for backwards compat (older saves lack this)
  modelId: string;
  name: string;
  faceCount: number;
  plateCount: number;
  plateId: string;
  rotation: Rotation3D;
  positionOffset: { x: number; y: number; z: number };
  scale?: Scale3D;
  mirror?: Mirror3D;
  visible: boolean;
  kind?: ModelKind;
  linkedTo?: string[];
  settings?: Record<string, unknown>;
  negativePartRef?: { parentModelId: string; plate: number; part: number };
  printablePartRef?: { parentModelId: string; plate: number; part: number };
}

export interface PersistedState {
  plates: Array<{ id: string; name: string }>;
  activePlateId: string;
  models: PersistedModel[];
  /** @deprecated use selectedIndices — kept for restore migration */
  activeModelIndex?: number | null;
  selectedIndices?: number[];
  engine: string;
  settings: Record<string, string>;
  selectedProfiles: { machine?: string; filament?: string; filament2?: string; process?: string };
  filamentSlots: FilamentSlot[];
  multiMaterial: { enabled: boolean; supportFilament: string; supportInterfaceFilament: string };
  printerIp: string;
  // UI state — restored across reloads so user lands where they left off
  view?: 'home' | 'slice' | 'jobs' | 'printer' | 'settings';
  showSidebar?: boolean;
  showSettings?: boolean;
  showJobs?: boolean;
  showInventory?: boolean;
  paintMode?: string;
  activeColor?: string;
  selectedPrinterId?: string | null;
  targetPrinterId?: string | null;
  viewer3DEnabled?: boolean;
  previewJobId?: string | null;
  gcodeColorMode?: 'filament' | 'lineType' | 'speed';
  showAllLayers?: boolean;
  currentPreviewLayer?: number;
  // Transform gizmo (Phase 2)
  transformMode?: TransformMode;
  transformSpace?: TransformSpace;
  snapEnabled?: boolean;
  snapTranslateMM?: number;
  snapRotateDeg?: number;
}

const STORAGE_KEY = 'snorcal_project';

/** Migrate legacy slorca_* localStorage keys → snorcal_* (one-shot per key). */
export function migrateLegacyKeys(): void {
  const keys = [
    'snorcal_project', 'snorcal_engine', 'snorcal_filament_slots',
    'snorcal_printer_ip', 'snorcal_multi_material', 'snorcal_target_printer',
  ];
  for (const k of keys) {
    const oldKey = k.replace('snorcal_', 'slorca_');
    if (localStorage.getItem(k) === null && localStorage.getItem(oldKey) !== null) {
      localStorage.setItem(k, localStorage.getItem(oldKey)!);
      localStorage.removeItem(oldKey);
    }
  }
  // printers.ts STORAGE_KEY legacy
  if (localStorage.getItem('snorcal_printer') === null && localStorage.getItem('slorca_printer') !== null) {
    localStorage.setItem('snorcal_printer', localStorage.getItem('slorca_printer')!);
    localStorage.removeItem('slorca_printer');
  }
}

export function loadPersistedState(): PersistedState | null {
  try {
    migrateLegacyKeys();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

export function savePersistedState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* localStorage full */ }
}
