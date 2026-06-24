/**
 * Hex color string → component forms.
 *
 * Single source for hex parsing across the backend (3MF builder/parser, slice
 * settings merge) and (eventually) frontend. Accepts `#RGB`, `#RRGGBB`, and
 * `#RRGGBBAA` (with or without leading `#`). Invalid input → null.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface RGBA extends RGB {
  a: number;
}

/** Strict 6-hex (`#RRGGBB`) → `{r,g,b}`. Returns null on parse failure. */
export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Permissive `#RGB`/`#RRGGBB`/`#RRGGBBAA` → `[r,g,b]`. Null if not hex-shaped. */
export function parseCSSColor(css: string): [number, number, number] | null {
  if (!css || !css.startsWith('#')) return null;
  const clean = css.replace('#', '');
  if (clean.length < 6) return null;
  return [
    parseInt(clean.substring(0, 2), 16),
    parseInt(clean.substring(2, 4), 16),
    parseInt(clean.substring(4, 6), 16),
  ];
}

/** Permissive `#RRGGBB`/`#RRGGBBAA` → `[r,g,b,a]` (a defaults to 255). No validation. */
export function parseHexColor(hex: string): [number, number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  const a = clean.length >= 8 ? parseInt(clean.substring(6, 8), 16) : 255;
  return [r, g, b, a];
}
