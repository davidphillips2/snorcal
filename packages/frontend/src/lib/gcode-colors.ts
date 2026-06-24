/** OrcaSlicer-style line-type colors. Single source for gcode type → hex. */

export const TYPE_COLORS: Record<string, string> = {
  custom: '#888888',
  'outer wall': '#ff3030',
  'inner wall': '#ff8c1a',
  'top surface': '#ffd700',
  'bottom surface': '#ffea66',
  'solid skin': '#ffd700',
  'sparse infill': '#33cc33',
  'internal solid infill': '#2da32d',
  bridge: '#33cccc',
  'internal bridge': '#33cccc',
  support: '#9933cc',
  'support interface': '#cc66ff',
  'support transition': '#cc66ff',
  skirt: '#888888',
  brim: '#888888',
  'prime tower': '#ff66cc',
  'wipe tower': '#ff66cc',
  'gap infill': '#66cc66',
  ironing: '#cc99cc',
};

/** Color for a gcode `;TYPE:` label. Unknown types → fallback gray. */
export function typeColor(type: string): string {
  return TYPE_COLORS[type.toLowerCase()] ?? '#9ca3af';
}

/** Same as typeColor but returns undefined for unknown (caller wants opacity skip). */
export function typeColorOpt(type?: string): string | undefined {
  if (!type) return undefined;
  return TYPE_COLORS[type.toLowerCase()] ?? undefined;
}
