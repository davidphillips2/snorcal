import type { SlicerBinary } from '../types/slicer.js';

export const SLICER_BINARIES: Record<string, SlicerBinary> = {
  orcaslicer: {
    engine: 'orcaslicer',
    binaryPath: '/opt/orcaslicer/OrcaSlicer',
    profilesDir: '/opt/orcaslicer/resources',
    label: 'OrcaSlicer',
  },
  bambustudio: {
    engine: 'bambustudio',
    binaryPath: '/opt/bambustudio/BambuStudio',
    profilesDir: '/opt/bambustudio/resources',
    label: 'BambuStudio',
  },
  snapmaker_orca: {
    engine: 'snapmaker_orca',
    binaryPath: '/opt/snapmaker-orca/SnapmakerOrcaSlicer',
    profilesDir: '/opt/snapmaker-orca/resources',
    label: 'Snapmaker OrcaSlicer',
  },
};

// For local development (outside Docker), check for env overrides
export function getSlicerBinary(engine: string): SlicerBinary {
  const config = SLICER_BINARIES[engine];
  if (!config) throw new Error(`Unknown slicer engine: ${engine}`);

  // Allow env var overrides for dev
  const envPath = process.env[`SLICER_PATH_${engine.toUpperCase()}`];
  if (envPath) {
    return { ...config, binaryPath: envPath };
  }
  return config;
}
