import type { SlicerEngine, SlicerSettings } from './slicer.js';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SliceRequest {
  modelId: string;
  engine: SlicerEngine;
  plateIndex?: number;
  settings: SlicerSettings;
  profiles?: {
    machine?: string;
    filament?: string;
    process?: string;
  };
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
    process?: string;
  };
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
