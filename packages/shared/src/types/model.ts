export type ModelFormat = 'stl' | 'step';

export interface ModelMetadata {
  id: string;
  name: string;
  filePath: string;
  fileSize: number;
  format: ModelFormat;
  faceCount: number;
  boundsX: number;
  boundsY: number;
  boundsZ: number;
  faceColors?: Uint8Array;
  createdAt: string;
}

export interface ModelSummary {
  id: string;
  name: string;
  format: ModelFormat;
  faceCount: number;
  fileSize: number;
  createdAt: string;
}

export interface Bounds {
  x: number;
  y: number;
  z: number;
}
