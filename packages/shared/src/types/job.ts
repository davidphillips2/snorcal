import type { SlicerEngine, SlicerSettings } from './slicer.js';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MultiMaterialConfig {
  enabled: boolean;
  supportFilament: '0' | '1';
  supportInterfaceFilament: '0' | '1';
}

export interface FilamentSlot {
  color: string;
  type: string;
  profile?: string;
  // Rich filament metadata extracted from a 3MF's project_settings.config.
  // All strings to match the slicer schema exactly (avoids float-format drift).
  // Populated on 3MF load; optional so old persisted slots still load.
  vendor?: string;      // filament_vendor  (e.g. "eSUN")
  diameter?: string;    // filament_diameter (e.g. "1.75")
  density?: string;     // filament_density  (e.g. "1.25")
  cost?: string;        // filament_cost     (e.g. "22.99")
}

export interface Rotation3D {
  x: number;
  y: number;
  z: number;
}

export interface SliceModelEntry {
  modelId: string;
  rotation?: Rotation3D;
  positionOffset?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  mirror?: { x: boolean; y: boolean; z: boolean };
  kind?: 'model' | 'part' | 'negative' | 'modifier' | 'support';
  linkedTo?: string[];  // parent modelId(s) for part/negative/modifier
  name?: string;
  settings?: Record<string, unknown>; // per-object override (modifier subset)
  visible?: boolean; // false = exclude from 3MF build entirely
  negativePartRef?: { parentModelId: string; plate: number; part: number };
  printablePartRef?: { parentModelId: string; plate: number; part: number };
}

export interface SliceRequest {
  modelId?: string; // single model (backwards compat)
  models?: SliceModelEntry[]; // multi-model (preferred)
  engine: SlicerEngine;
  plateIndex?: number;
  settings: SlicerSettings;
  profiles?: {
    machine?: string;
    filament?: string;
    filament2?: string;
    process?: string;
  };
  multiMaterial?: MultiMaterialConfig;
  filamentSlots?: FilamentSlot[];
  rotation?: Rotation3D;
  positionOffset?: { x: number; y: number; z: number };
  buildVolume?: { x: number; y: number; z: number };
  printerId?: string;
}

export interface SliceJobData {
  jobId: string;
  modelId: string;
  engine: SlicerEngine;
  plateIndex: number;
  settings: SlicerSettings;
  profiles?: {
    machine?: string;
    filament?: string;
    filament2?: string;
    process?: string;
  };
  multiMaterial?: MultiMaterialConfig;
  filamentSlots?: FilamentSlot[];
  workDir: string;
}

export interface SliceResult {
  gcodePath: string;
  gcodeSize: number;
  thumbnailPath?: string;
  estimatedTime?: string;
  estimatedFilament?: string;
}

export interface JobRecord {
  id: string;
  modelId: string;
  engine: SlicerEngine;
  status: JobStatus;
  progress: number;
  currentStep?: string;
  settings: string; // JSON
  outputDir?: string;
  gcodeSize?: number;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface JobSummary {
  id: string;
  modelId: string;
  engine: SlicerEngine;
  status: JobStatus;
  progress: number;
  currentStep?: string;
  createdAt: string;
}
