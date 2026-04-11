export interface PrinterPreset {
  id: string;
  name: string;
  engine: string;
  description: string;
  settings: Record<string, string | string[]>;
}

export const PRINTERS: PrinterPreset[] = [
  {
    id: 'snapmaker_u1',
    name: 'Snapmaker U1',
    engine: 'orcaslicer',
    description: '270 x 270 x 270 mm',
    settings: {
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
      // Process defaults
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
      // Filament defaults
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
    },
  },
  {
    id: 'bambu_p1s',
    name: 'Bambu Lab P1S',
    engine: 'orcaslicer',
    description: '256 x 256 x 256 mm',
    settings: {
      printer_model: 'Bambu Lab P1S',
      printer_technology: 'FFF',
      gcode_flavor: 'marlin',
      nozzle_diameter: ['0.4'],
      printable_area: ['0x0', '256x0', '256x256', '0x256'],
      printable_height: '256',
      max_print_height: '256',
      use_relative_e_distances: '1',
      before_layer_change_gcode: 'G92 E0',
      layer_change_gcode: 'G92 E0',
      // Process defaults
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
      travel_speed: '500',
      enable_support: '0',
      support_type: 'tree(auto)',
      brim_type: 'no_brim',
      line_width: '0.42',
      elefant_foot_compensation: '0.15',
      // Filament defaults (generic PLA)
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
    },
  },
];

const STORAGE_KEY = 'slorca_printer';

export function getSavedPrinter(): PrinterPreset | null {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    if (!id) return null;
    return PRINTERS.find(p => p.id === id) || null;
  } catch {
    return null;
  }
}

export function savePrinter(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage not available
  }
}
