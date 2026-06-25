import type { AmsSlot } from '@snorcal/shared';

export interface Slot {
  /** Value to send in filamentMapping array */
  value: number;
  /** Display label */
  label: string;
  /** Hex color for swatch, if known */
  color: string | null;
  /** Filament type if known */
  type: string | null;
  /** Source — live AMS or manual config */
  source: 'ams' | 'manual';
}

/**
 * Build the list of physical filament slots available on a printer.
 * Bambu uses live AMS tray data; Moonraker / Klipper use a configured
 * manual slot count (drives T-code rewriting upstream).
 */
export function buildSlots(
  protocol: 'moonraker' | 'bambu',
  manualSlots: number,
  ams: AmsSlot[] | undefined,
): Slot[] {
  if (protocol === 'bambu' && ams && ams.length > 0) {
    return ams.map(s => ({
      value: s.trayId,
      label: `Tray ${s.trayId}`,
      color: s.color ? '#' + s.color.replace(/^#/, '').slice(0, 6) : null,
      type: s.type ?? null,
      source: 'ams' as const,
    }));
  }
  if (manualSlots > 0) {
    return Array.from({ length: manualSlots }, (_, i) => ({
      value: i,
      label: `Slot ${i + 1}`,
      color: null,
      type: null,
      source: 'manual' as const,
    }));
  }
  return [];
}

/** Normalize hex strings ('#RRGGBB', 'RRGGBBAA', etc.) for color match. */
export function hexNormalize(c: string | null | undefined): string | null {
  if (!c) return null;
  let s = c.trim().toUpperCase().replace(/^#/, '');
  if (s.length === 8) s = s.slice(0, 6); // strip alpha
  if (s.length === 6) return '#' + s;
  return s;
}
