import type { SlicerBinary } from '../types/slicer.js';

export const SLICER_BINARIES: Record<string, SlicerBinary> = {
  orcaslicer: {
    engine: 'orcaslicer',
    binaryPath: '/opt/orcaslicer/bin/orca-slicer',
    profilesDir: '/opt/orcaslicer/resources',
    label: 'OrcaSlicer',
  },
  bambustudio: {
    engine: 'bambustudio',
    binaryPath: '/opt/bambustudio/bin/bambu-studio',
    profilesDir: '/opt/bambustudio/resources',
    label: 'BambuStudio',
  },
  snapmaker_orca: {
    engine: 'snapmaker_orca',
    binaryPath: '/opt/snapmaker-orca/bin/orca-slicer',
    profilesDir: '/opt/snapmaker-orca/resources',
    label: 'Snapmaker OrcaSlicer',
  },
};

const isMac = process.platform === 'darwin';

const MAC_PATHS: Record<string, { binaryPath: string; profilesDir: string }> = {
  orcaslicer: {
    binaryPath: '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer',
    profilesDir: '/Applications/OrcaSlicer.app/Contents/Resources',
  },
  bambustudio: {
    binaryPath: '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
    profilesDir: '/Applications/BambuStudio.app/Contents/Resources',
  },
  snapmaker_orca: {
    binaryPath: '/Applications/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca',
    profilesDir: '/Applications/Snapmaker Orca.app/Contents/Resources',
  },
};

export function getSlicerBinary(engine: string): SlicerBinary {
  const config = SLICER_BINARIES[engine];
  if (!config) throw new Error(`Unknown slicer engine: ${engine}`);

  // Allow env var overrides
  const envPath = process.env[`SLICER_PATH_${engine.toUpperCase()}`];
  if (envPath) {
    return { ...config, binaryPath: envPath };
  }

  // Use macOS paths when on macOS
  if (isMac && MAC_PATHS[engine]) {
    return { ...config, ...MAC_PATHS[engine] };
  }

  return config;
}
