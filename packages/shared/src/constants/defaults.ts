/**
 * Default project settings for the slicer CLI.
 *
 * These are embedded in the 3MF as `Metadata/project_settings.config`.
 * The format is a flat JSON with string values (and arrays for multi-extruder).
 * This is the slicer's native "project settings" format.
 *
 * Settings base: Snapmaker Orca exported defaults
 * Override for: Snapmaker U1 (0.4 nozzle) + Snapmaker PLA SnapSpeed + 0.20 Standard
 */

// Key overrides for the default U1 + SnapSpeed + 0.20 Standard profile
export const PROJECT_SETTING_OVERRIDES: Record<string, string | string[]> = {
  // Machine - Snapmaker U1
  printer_model: 'Snapmaker U1',
  printer_technology: 'FFF',
  gcode_flavor: 'marlin',
  nozzle_diameter: ['0.4'],
  printable_area: ['0x0', '270x0', '270x270', '0x270'],
  printable_height: '270',
  max_print_height: '270',
  use_relative_e_distances: '1',
  before_layer_change_gcode: 'G92 E0',
  layer_change_gcode: 'G92 E0',

  // Process - 0.20 Standard
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
  travel_speed: '500',
  enable_support: '0',
  support_type: 'tree(auto)',
  brim_type: 'no_brim',
  line_width: '0.42',
  elefant_foot_compensation: '0.15',

  // Filament - Snapmaker PLA SnapSpeed
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
};

// Legacy names kept for type compat
export const DEFAULT_PROCESS_SETTINGS: Record<string, string> = {};
export const DEFAULT_MACHINE_SETTINGS: Record<string, string> = {};
export const DEFAULT_FILAMENT_SETTINGS: Record<string, string> = {};
