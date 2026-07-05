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
  prusaslicer: {
    engine: 'prusaslicer',
    binaryPath: '/opt/prusaslicer/bin/prusa-slicer',
    profilesDir: '/opt/prusaslicer/resources',
    label: 'PrusaSlicer',
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
  prusaslicer: {
    binaryPath: '/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer',
    profilesDir: '/Applications/PrusaSlicer.app/Contents/Resources',
  },
};

/**
 * Resolve the binary + profiles dir for an engine.
 *
 * Priority (highest wins):
 *   1. `overridePath` — explicit arg, typically from the DB-backed
 *      `slicer_path_overrides` app setting (user-set via App Settings UI).
 *   2. `SLICER_PATH_<ENGINE_UPPER>` env var — admin/server-side config.
 *   3. Platform default — `/Applications/<Name>.app/...` on macOS,
 *      `/opt/<name>/bin/...` on Linux.
 *
 * Only `binaryPath` is affected by overrides; `profilesDir` stays at the
 * platform default (slicer CLI doesn't read profiles when settings are
 * embedded in the 3MF, so an off-default binary location rarely needs a
 * matching profiles dir override).
 */
export function getSlicerBinary(engine: string, overridePath?: string): SlicerBinary {
  const config = (SLICER_BINARIES as Record<string, SlicerBinary>)[engine];
  if (!config) throw new Error(`Unknown slicer engine: ${engine}`);

  // DB-backed override (highest priority)
  if (overridePath) {
    return { ...config, binaryPath: overridePath };
  }

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
 */
export function isBambuStudioClass(engine: string): boolean {
  return engine === 'bambustudio';
}

/**
 * OrcaSlicer-class engines share OrcaSlicer's CLI (no --skip_useless_pick,
 * project_settings.config schema, paint_color format).
 */
export function isOrcaSlicerClass(engine: string): boolean {
  return engine === 'orcaslicer';
}
