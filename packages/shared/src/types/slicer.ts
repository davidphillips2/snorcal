// Slicer engine identifiers
export type SlicerEngine =
  | 'orcaslicer'
  | 'bambustudio'
  | 'crealityprint'
  | 'prusaslicer'
  | 'elegooslicer'
  | 'snapmakerorca';

export interface SlicerBinary {
  engine: SlicerEngine;
  binaryPath: string;
  profilesDir: string;
  label: string;
}

export interface PrintSettings {
  layerHeight: number;
  initialLayerHeight: number;
  wallLoops: number;
  infillPattern: string;
  infillDensity: number;
  sparseInfillSpeed: number;
  innerWallSpeed: number;
  outerWallSpeed: number;
  travelSpeed: number;
  enableSupport: boolean;
  supportType: string;
  supportAngle: number;
  brimType: string;
  brimWidth: number;
  [key: string]: unknown;
}

export interface MachineSettings {
  printerModel: string;
  printableArea: string; // "0 0 250 250"
  printableHeight: number;
  nozzleDiameter: number;
  maxPrintSpeed: number;
  [key: string]: unknown;
}

export interface FilamentSettings {
  filamentType: string;
  nozzleTemperature: number;
  bedTemperature: number;
  color: string;
  maxVolumetricSpeed: number;
  fanSpeed: number;
  [key: string]: unknown;
}

export interface SlicerSettings {
  process: PrintSettings;
  machine: MachineSettings;
  filaments: FilamentSettings[];
}
