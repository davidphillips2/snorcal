import type { SlicerBinary, SlicerEngine } from '../types/slicer.js';

export const SLICER_BINARIES: Record<SlicerEngine, SlicerBinary> = {
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
  crealityprint: {
    engine: 'crealityprint',
    binaryPath: '/opt/creality-print/bin/CrealityPrint',
    profilesDir: '/opt/creality-print/resources',
    label: 'Creality Print',
  },
  prusaslicer: {
    engine: 'prusaslicer',
    binaryPath: '/opt/prusaslicer/bin/prusa-slicer',
    profilesDir: '/opt/prusaslicer/resources',
    label: 'PrusaSlicer',
  },
  elegooslicer: {
    engine: 'elegooslicer',
    binaryPath: '/opt/elegoo-slicer/bin/ElegooSlicer',
    profilesDir: '/opt/elegoo-slicer/resources',
    label: 'ElegooSlicer',
  },
  snapmakerorca: {
    engine: 'snapmakerorca',
    binaryPath: '/opt/snapmaker-orca/bin/snapmaker-orca',
    profilesDir: '/opt/snapmaker-orca/resources',
    label: 'Snapmaker Orca',
  },
};

const isMac = process.platform === 'darwin';

const MAC_PATHS: Record<SlicerEngine, { binaryPath: string; profilesDir: string }> = {
  orcaslicer: {
    binaryPath: '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer',
    profilesDir: '/Applications/OrcaSlicer.app/Contents/Resources',
  },
  bambustudio: {
    binaryPath: '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
    profilesDir: '/Applications/BambuStudio.app/Contents/Resources',
  },
  crealityprint: {
    binaryPath: '/Applications/Creality Print.app/Contents/MacOS/CrealityPrint',
    profilesDir: '/Applications/Creality Print.app/Contents/Resources',
  },
  prusaslicer: {
    binaryPath: '/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer',
    profilesDir: '/Applications/PrusaSlicer.app/Contents/Resources',
  },
  elegooslicer: {
    binaryPath: '/Applications/ElegooSlicer.app/Contents/MacOS/ElegooSlicer',
    profilesDir: '/Applications/ElegooSlicer.app/Contents/Resources',
  },
  snapmakerorca: {
    binaryPath: '/Applications/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca',
    profilesDir: '/Applications/Snapmaker Orca.app/Contents/Resources',
  },
};

export function getSlicerBinary(engine: string): SlicerBinary {
  const config = (SLICER_BINARIES as Record<string, SlicerBinary>)[engine];
  if (!config) throw new Error(`Unknown slicer engine: ${engine}`);

  // Allow env var overrides
  const envPath = process.env[`SLICER_PATH_${engine.toUpperCase()}`];
  if (envPath) {
    return { ...config, binaryPath: envPath };
  }

  // Use macOS paths when on macOS
  if (isMac && (MAC_PATHS as Record<string, { binaryPath: string; profilesDir: string }>)[engine]) {
    return { ...config, ...(MAC_PATHS as Record<string, { binaryPath: string; profilesDir: string }>)[engine] };
  }

  return config;
}

/**
 * BambuStudio-class engines share BambuStudio's CLI quirks (--skip_useless_pick,
 * project_settings.config schema, AMS-style filament arrays). Used by arg
 * builder + project-settings emitter to decide BambuStudio-specific behavior.
 *
 * Note: crealityprint + elegooslicer are NOT included — Creality Print is a
 * PrusaSlicer fork, ElegooSlicer has its own CLI quirks. Add here only if
 * confirmed to need the same BambuStudio-specific flags.
 */
export function isBambuStudioClass(engine: string): boolean {
  return engine === 'bambustudio';
}

/**
 * OrcaSlicer-class engines share OrcaSlicer's CLI (no --skip_useless_pick,
 * project_settings.config schema, paint_color format). Snapmaker Orca is a
 * distinct product from OrcaSlicer but the slicing CLI + 3MF format are
 * identical (verified Snapmaker_Orca-01.10.01.50 CLI --help).
 */
export function isOrcaSlicerClass(engine: string): boolean {
  return engine === 'orcaslicer' || engine === 'snapmakerorca';
}
