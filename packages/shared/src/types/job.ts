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
