/**
 * Default printer profiles seeded into the database on first run.
 * Each printer gets a machine, filament, and process profile.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface DefaultProfile {
  engine: string;
  type: string;
  name: string;
  settings: Record<string, unknown>;
}

// Map source dir → snorcal engine tag. CrealityPrint JSON format is
// OrcaSlicer-compatible, so we re-tag its profiles as orcaslicer.
const ENGINE_MAP: Record<string, string> = {
  orcaslicer: 'orcaslicer',
  bambustudio: 'bambustudio',
  crealityprint: 'orcaslicer',
};
const TYPE_MAP: Record<string, string> = {
  machine: 'machine',
  filament: 'filament',
  print: 'process',
  process: 'process',
};

// Pick latest version value from a {version: value} map
function latestVersionValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  const map = v as Record<string, unknown>;
  const versions = Object.keys(map);
  if (versions.length === 0) return null;
  // Sort by version string descending (semver-ish)
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return map[versions[0]];
}

function normalizeSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    out[key] = latestVersionValue(val);
  }
  return out;
}

interface DiskProfile {
  slicer: string;
  profile_type: string;
  name: string;
  vendor?: string;
  settings: Record<string, unknown>;
}

function seedProfileDir(db: {
  upsertProfile: (engine: string, type: string, name: string, settings: string) => void;
  getProfile: (engine: string, type: string, name: string) => unknown;
}): { imported: number; skipped: number; errors: number } {
  const baseDir = path.join(os.homedir(), 'slicer-profiles-db', 'profiles');
  if (!fs.existsSync(baseDir)) return { imported: 0, skipped: 0, errors: 0 };

  let imported = 0, skipped = 0, errors = 0;

  for (const engine of fs.readdirSync(baseDir)) {
    const dbEngine = ENGINE_MAP[engine];
    if (!dbEngine) continue;
    const engineDir = path.join(baseDir, engine);
    if (!fs.statSync(engineDir).isDirectory()) continue;

    // engine/{vendor}/{type}/*.json
    for (const vendor of fs.readdirSync(engineDir)) {
      const vendorDir = path.join(engineDir, vendor);
      if (!fs.statSync(vendorDir).isDirectory()) continue;

      for (const typeDirName of fs.readdirSync(vendorDir)) {
        const mappedType = TYPE_MAP[typeDirName.toLowerCase()];
        if (!mappedType) continue;
        const typeDir = path.join(vendorDir, typeDirName);
        if (!fs.statSync(typeDir).isDirectory()) continue;

        for (const file of fs.readdirSync(typeDir)) {
          if (!file.endsWith('.json')) continue;
          const filePath = path.join(typeDir, file);
          try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DiskProfile;
            if (!raw.name || !raw.profile_type) { errors++; continue; }
            const name = raw.name;
            if (db.getProfile(dbEngine, mappedType, name)) { skipped++; continue; }
            const settings = normalizeSettings(raw.settings || {});
            db.upsertProfile(dbEngine, mappedType, name, JSON.stringify(settings));
            imported++;
          } catch {
            errors++;
          }
        }
      }
    }
  }

  console.log(`[Seed] Imported ${imported} profiles, skipped ${skipped} existing, ${errors} errors from ${baseDir}`);
  return { imported, skipped, errors };
}

const PROFILES: DefaultProfile[] = [
  // ── Snapmaker U1 ──────────────────────────────────────────
  {
    engine: 'orcaslicer',
    type: 'machine',
    name: 'Snapmaker U1 (0.4 nozzle)',
    settings: {
      type: 'machine',
      name: 'Snapmaker U1 (0.4 nozzle)',
      printer_model: 'Snapmaker U1',
      printer_technology: 'FFF',
      gcode_flavor: 'marlin',
      nozzle_diameter: ['0.4'],
      printable_area: ['0x0', '270x0', '270x270', '0x270'],
      printable_height: '270',
      max_print_height: '270',
      machine_max_speed_e: ['100'],
      machine_max_speed_x: ['500'],
      machine_max_speed_y: ['500'],
      machine_max_speed_z: ['20'],
      machine_max_acceleration_e: ['5000'],
      machine_max_acceleration_x: ['500'],
      machine_max_acceleration_y: ['500'],
      machine_max_acceleration_z: ['100'],
      use_relative_e_distances: '1',
      before_layer_change_gcode: 'G92 E0',
      layer_change_gcode: 'G92 E0',
      retract_length: ['0.8'],
      retract_speed: ['30'],
      deretract_speed: ['30'],
      retract_before_wipe: ['1'],
      retract_restart_extra: ['0'],
      retract_lift_above: ['0'],
      retract_lift_below: ['270'],
    },
  },
  {
    engine: 'orcaslicer',
    type: 'filament',
    name: 'Snapmaker PLA SnapSpeed',
    settings: {
      type: 'filament',
      name: 'Snapmaker PLA SnapSpeed',
      filament_type: ['PLA'],
      nozzle_temperature: ['220'],
      nozzle_temperature_initial_layer: ['220'],
      hot_plate_temp: ['65'],
      hot_plate_temp_initial_layer: ['65'],
      cool_plate_temp: ['60'],
      cool_plate_temp_initial_layer: ['60'],
      fan_min_speed: ['100'],
      fan_max_speed: ['100'],
      filament_max_volumetric_speed: ['20'],
      filament_flow_ratio: ['0.966'],
      filament_density: ['1.24'],
      filament_cost: ['20'],
      filament_colour: ['#FFFFFF'],
      filament_vendor: ['Snapmaker'],
      pressure_advance: ['0.02'],
      close_fan_the_first_x_layers: ['1'],
      filament_deretraction_speed: ['0'],
      filament_retraction_distances: ['0.8'],
      filament_retract_lift_above: ['0'],
      filament_retract_lift_below: ['270'],
      filament_minimal_purge_on_wipe_tower: ['15'],
    },
  },
  {
    engine: 'orcaslicer',
    type: 'process',
    name: '0.20 Standard @Snapmaker U1',
    settings: {
      type: 'process',
      name: '0.20 Standard @Snapmaker U1',
      layer_height: '0.2',
      initial_layer_height: '0.25',
      wall_loops: '3',
      top_shell_layers: '5',
      bottom_shell_layers: '3',
      sparse_infill_density: '15%',
      sparse_infill_pattern: 'grid',
      initial_layer_speed: '50',
      outer_wall_speed: '200',
      inner_wall_speed: '300',
      sparse_infill_speed: '270',
      internal_solid_infill_speed: '300',
      top_surface_speed: '200',
      travel_speed: '500',
      enable_support: '0',
      support_type: 'tree(auto)',
      support_angle: '30',
      brim_type: 'no_brim',
      line_width: '0.42',
      initial_layer_line_width: '0.5',
      outer_wall_line_width: '0.42',
      inner_wall_line_width: '0.45',
      sparse_infill_line_width: '0.45',
      elefant_foot_compensation: '0.15',
      ironing_type: 'no',
      seam_position: 'aligned',
    },
  },

  // ── Bambu Lab P1S ─────────────────────────────────────────
  {
    engine: 'orcaslicer',
    type: 'machine',
    name: 'Bambu Lab P1S (0.4 nozzle)',
    settings: {
      type: 'machine',
      name: 'Bambu Lab P1S (0.4 nozzle)',
      printer_model: 'Bambu Lab P1S',
      printer_technology: 'FFF',
      gcode_flavor: 'marlin',
      nozzle_diameter: ['0.4'],
      printable_area: ['0x0', '256x0', '256x256', '0x256'],
      printable_height: '256',
      max_print_height: '256',
      machine_max_speed_e: ['100'],
      machine_max_speed_x: ['500'],
      machine_max_speed_y: ['500'],
      machine_max_speed_z: ['20'],
      machine_max_acceleration_e: ['5000'],
      machine_max_acceleration_x: ['500'],
      machine_max_acceleration_y: ['500'],
      machine_max_acceleration_z: ['100'],
      use_relative_e_distances: '1',
      before_layer_change_gcode: 'G92 E0',
      layer_change_gcode: 'G92 E0',
      retract_length: ['0.4'],
      retract_speed: ['30'],
      deretract_speed: ['30'],
      retract_before_wipe: ['1'],
      retract_restart_extra: ['0'],
      retract_lift_above: ['0'],
      retract_lift_below: ['256'],
    },
  },
  {
    engine: 'orcaslicer',
    type: 'filament',
    name: 'Bambu PLA Basic',
    settings: {
      type: 'filament',
      name: 'Bambu PLA Basic',
      filament_type: ['PLA'],
      nozzle_temperature: ['220'],
      nozzle_temperature_initial_layer: ['220'],
      hot_plate_temp: ['55'],
      hot_plate_temp_initial_layer: ['55'],
      cool_plate_temp: ['55'],
      cool_plate_temp_initial_layer: ['55'],
      fan_min_speed: ['100'],
      fan_max_speed: ['100'],
      filament_max_volumetric_speed: ['21'],
      filament_flow_ratio: ['0.95'],
      filament_density: ['1.24'],
      filament_cost: ['20'],
      filament_colour: ['#FFFFFF'],
      filament_vendor: ['Bambu Lab'],
      pressure_advance: ['0.02'],
      close_fan_the_first_x_layers: ['1'],
      filament_deretraction_speed: ['0'],
      filament_retraction_distances: ['0.4'],
      filament_retract_lift_above: ['0'],
      filament_retract_lift_below: ['256'],
      filament_minimal_purge_on_wipe_tower: ['15'],
    },
  },
  {
    engine: 'orcaslicer',
    type: 'process',
    name: '0.20 Standard @Bambu P1S',
    settings: {
      type: 'process',
      name: '0.20 Standard @Bambu P1S',
      layer_height: '0.2',
      initial_layer_height: '0.25',
      wall_loops: '3',
      top_shell_layers: '4',
      bottom_shell_layers: '3',
      sparse_infill_density: '15%',
      sparse_infill_pattern: 'grid',
      initial_layer_speed: '50',
      outer_wall_speed: '200',
      inner_wall_speed: '300',
      sparse_infill_speed: '270',
      internal_solid_infill_speed: '300',
      top_surface_speed: '200',
      travel_speed: '500',
      enable_support: '0',
      support_type: 'tree(auto)',
      support_angle: '30',
      brim_type: 'no_brim',
      line_width: '0.42',
      initial_layer_line_width: '0.5',
      outer_wall_line_width: '0.42',
      inner_wall_line_width: '0.45',
      sparse_infill_line_width: '0.45',
      elefant_foot_compensation: '0.15',
      ironing_type: 'no',
      seam_position: 'aligned',
    },
  },
];

/**
 * Seed default profiles into the database if they don't already exist.
 */
export function seedDefaultProfiles(db: {
  upsertProfile: (engine: string, type: string, name: string, settings: string) => void;
  getProfile: (engine: string, type: string, name: string) => unknown;
}): void {
  for (const profile of PROFILES) {
    const existing = db.getProfile(profile.engine, profile.type, profile.name);
    if (!existing) {
      db.upsertProfile(profile.engine, profile.type, profile.name, JSON.stringify(profile.settings));
    }
  }
  // Also seed from on-disk profile DB at ~/slicer-profiles-db/profiles
  seedProfileDir(db);
}
