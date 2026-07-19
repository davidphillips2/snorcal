/**
 * Quick-set material presets. Click → sets hotend + bed via set_temp command.
 * Values are typical first-layer / print temps per material spec sheets.
 */
export interface MaterialPreset {
  label: string;
  hotend: number;
  bed: number;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { label: 'PLA',  hotend: 200, bed: 60 },
  { label: 'PETG', hotend: 230, bed: 70 },
  { label: 'ABS',  hotend: 245, bed: 100 },
  { label: 'ASA',  hotend: 245, bed: 100 },
  { label: 'TPU',  hotend: 220, bed: 50 },
  { label: 'PA',   hotend: 260, bed: 90 },
  { label: 'PC',   hotend: 270, bed: 110 },
];
