export type ModelFormat = 'stl' | 'step';

/**
 * Object kind carried through to 3MF as `<object type="...">`.
 * - `model` — printable geometry
 * - `negative` — subtractive volume (3MF `negative_part`)
 * - `modifier` — settings override region (3MF `modifier`)
 * - `support` — custom support pillar (3MF `support_model`)
 */
export type ModelKind = 'model' | 'negative' | 'modifier' | 'support';

/** Non-uniform scale factors per axis. */
export interface Scale3D {
  x: number;
  y: number;
  z: number;
}

/** Per-axis mirror flags. */
export interface Mirror3D {
  x: boolean;
  y: boolean;
  z: boolean;
}

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
