# Slicer CLI + color

How snorcal drives OrcaSlicer / BambuStudio, with and without per-face paint.
All of this was verified by direct binary invocation against the slicer CLI;
citations point to the OrcaSlicer source where a behavior originated.

## TL;DR

- Snorcal **never** passes `--load-settings` / `--load-filaments` for embedded
  color. All slice settings ride inside the 3MF as `Metadata/project_settings.config`.
- Single-color prints: `filament_colour` has 1 entry, no `paint_color` blob.
- Multi-color prints: `filament_colour` has N entries + a `paint_color` blob per
  object that says "these faces → extruder N".
- The slicer's tool-change emission mode depends on `nozzle_diameter` being
  padded to the filament count. Pad it always for multi-color.

## CLI invocation

### Sidecar mode (production)

Two bambuddy sidecar containers serve OrcaSlicer + BambuStudio over HTTP.
Snorcal uploads the embedded 3MF via `POST /slice-async` (multipart `file`
field, no profile files), polls status, downloads gcode. Internally the
sidecar runs essentially:

```bash
<slicer> --slice 0 --arrange 0 --orient 0 --outputdir /out input.3mf
```

Sidecar additionally uploads profile **stubs** via bambuddy's
`slice_with_profiles` path (`slicer_api.py:198-307`). Stub protocol
(`_resolve_standard` in `preset_resolver.py:254-277`): minimal JSON
`{name, inherits: name, from: "system", type}` per profile. Sidecar walks
`inherits` against bundled slicer presets → full resolved profile →
`--load-settings` / `--load-filaments`.

Engine URL resolution: `getSidecarUrl(engine)` in
`packages/backend/src/services/slicer-executor.ts` checks
`SLICER_URL_<ENGINE_UPPER>` (e.g. `SLICER_URL_ORCASLICER`,
`SLICER_URL_BAMBUSTUDIO`), falls back to deprecated `SLICER_URL` for both
engines, then `null` (local mode).

### Local mode (dev macOS)

Direct spawn of `/Applications/OrcaSlicer.app/...`:

```bash
<binary> --datadir <dir> --slice 0 --outputdir <dir> \
  --arrange 0 --orient 0 --debug 2 input.3mf
```

Snorcal rebuilt 3MF is always single-plate, so `--slice 0` is correct
regardless of which plate the user picked in the UI.

### Local-debug recipe

```bash
<slicer> --debug 4 --outputdir /tmp/x input.3mf
```

Snapmaker Orca binary: `/Applications/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca`
Creality Print:       `/Applications/Creality Print.app/Contents/MacOS/CrealityPrint`
OrcaSlicer source (mirrors Snapmaker Orca closely):
`git clone https://github.com/SoftFever/OrcaSlicer.git`

Key OrcaSlicer source files:
- `src/OrcaSlicer.cpp` — CLI main, flush volume + filament color logic at 3340-3508
- `src/libslic3r/Format/bbs_3mf.cpp` — 3MF importer
  - Application gate at 3946-3956 (rejects files from newer slicer versions)
  - `project_settings.config` load at 2632-2654

## 3MF embedding strategy

All slice settings live as `Metadata/project_settings.config` inside a fresh
3MF — flat JSON with ~520 keys. The slicer reads them natively. No external
flags. Painted colors are also embedded inside the 3MF (no CLI paint flag).

Key settings snorcal forces:

- `use_relative_e_distances: "1"` + `G92 E0` in `before_layer_change_gcode`
  and `layer_change_gcode` — slicer exit 205 if these mismatch.
- `nozzle_diameter` padded to filament slot count (see below).
- Sentinel strip: `-1` inherit-from-parent values stripped from
  `project_settings.config` before writing. Allowlist:
  `raft_first_layer_expansion`, `tree_support_wall_count`,
  `prime_tower_brim_width`. (Bambuddy's allowlist omits `ironing_angle`;
  add new keys to `SENTINEL_KEYS` in slice.ts if "invalid preset" recurs.)

## Single-color path (no paint)

`project_settings.config`:

```json
{
  "filament_colour": "[\"#CCCCCC\"]",
  "filament_type": "[\"PETG\"]",
  "filament_settings_id": "[\"SUNLU PETG @BBL X1C\"]",
  "nozzle_diameter": "[\"0.4\"]"
}
```

- 1-element arrays everywhere.
- `nozzle_diameter` matches the machine profile (single toolhead → 1 entry).
- No `paint_color` block on the `<object>`.
- Slicer emits a single continuous extrusion, no tool changes.

## Multi-color path (painted)

`project_settings.config`:

```json
{
  "filament_colour": "[\"#FF0000\",\"#00FF00\",\"#0000FF\"]",
  "filament_type": "[\"PLA\",\"PLA\",\"PLA\"]",
  "filament_settings_id": "[\"...\",\"...\",\"...\"]",
  "nozzle_diameter": "[\"0.4\",\"0.4\",\"0.4\"]",
  "flush_volumes_matrix": "[70,70,70,70,70,70,70,70,70]"
}
```

Each `<object>` in the 3MF model file carries a `paint_color` attribute —
a hex string encoding a per-face bitstream that says which extruder each
triangle belongs to.

### paint_color encoding (TriangleSelector bitstream)

`extruderToPaintColor(n)` → `4 / 8 / 0C / 1C / ...` for extruders 1 / 2 / 3 / 4.

Format is OrcaSlicer's `TriangleSelector.cpp` serialize:
- State 1 (extruder 1) = 2 bits `01` → hex nibble `4`
- State 2 (extruder 2) = 2 bits `10` → hex nibble `8`
- State ≥ 3 = escape `11` + 4 bits (state - 3) → e.g. extruder 3 = `11 0000` → `0C`,
  extruder 4 = `11 0001` → `1C`

**Critical:** do NOT use Bambu Studio's `5C / 6C / 7C` format. OrcaSlicer 2.4.0's
bitstream parser maps those to extruders 8 / 9 / 10 and the model slices
all-white. Verified by direct binary slice 2026-06-23: same geometry +
`4/8/0C` = 3 colors, same geometry + `5C/6C/7C` = 1 color.

Decoder (for reading existing 3MFs back) lives in
`extractPaintColors` in `packages/backend/src/services/threemf-parser.ts`.
Rightmost hex char, bits 2-3 = code; escape `11` + next nibble + 3 for state ≥ 3.

### nozzle_diameter padding → T-codes vs AMS markers

The slicer's tool-change emission mode is decided by `nozzle_diameter` length:

- **Machine-profile length (1 for single-toolhead AMS printers)**: slicer
  runs in "Auto For Flush" mode. Sets `master_extruder_id=1` +
  `filament_map=1,1`. All `M624` / `M625` AMS markers carry extruder-1 payload.
  Output looks multi-color in slicer stats but the printer AMS receives no
  switching commands — single-color output even with `filament_colour` and
  `paint_color` populated.
- **Padded to slot count (e.g. 4 entries for a 4-filament print)**: slicer
  emits per-filament `T0` / `T1` / `T2` / `T3` tool changes AND honors
  `paint_color` segmentation. This is what we want.

`expandFilamentSlots` in slice.ts and the post-user-settings re-apply block
in `runSliceJob` both pad `nozzle_diameter` to the target count. Always.
Earlier doc claim that padding "suppresses AMS tool-change commands" was
wrong — it's the opposite.

### Why T-codes matter beyond the printer

The in-browser gcode-preview library only understands `T0`..`T7` tool
changes. It does NOT parse Bambu `M624` / `M625` AMS markers. So padded
`nozzle_diameter` (which forces T-code emission) is required not just for
correct slicing but also for the preview to render colors at all. Verified
against the library's parser: `case "t0".."t7"` only — first-token match
required, so `T25000` (M204 jerk param) and `M109 S220 T1` (heat cmd) do
not trigger toolchange.

### Multi-color gotchas (all fixed, kept as reference)

1. `expandFilamentSlots` once indexed a 4x4 source `flush_volumes_matrix`
   with 3x3 target coords → corrupt matrix → slicer exit 154. Fix:
   compute `srcDim = round(sqrt(len))`, index source as `r*srcDim+c`.
2. `extruderToPaintColor` once used wrong format (see encoding section).
3. Negative parts + scene-clones duplicated cuts in 3MF. Fix: filter
   body.models to `kind=model`; dedupe negatives by `parentModelId`.
4. `extractPaintColors` once decoded via `parseInt(pc, 16) / divisor`.
   Broke for extruder 4+ (`1C` → 7, `2C` → 11). Fixed with proper
   TriangleSelector bitstream decode.

## Sidecar multi-color requirements

Two extra things must be present or the sidecar SIGSEGVs:

1. **`<plate>` element in `model_settings.config`**: `buildModelSettings`
   in `threemf-builder.ts` emits `<object>` + `<part>` entries. Without a
   wrapping `<plate>` element, the sidecar's plate resolver returns null
   and BambuStudio + OrcaSlicer SIGSEGV during orientation analysis.
   Single-color slices skip the file entirely (only emitted when
   `allObjects.length > 1 OR extruder > 1`) so they were unaffected.
2. **Profile stub uploads**: Snorcal v0.1.13 dropped profile uploads and
   the sidecar ran bare `--slice N input.3mf`. Bambuddy works because it
   uploads profiles via `slice_with_profiles`. Re-added in v0.1.19 using
   bambuddy's stub protocol.

## Common errors

| Exit | Meaning | Snorcal response |
|------|---------|------------------|
| 0    | Success | G-code parsed + estimates extracted |
| 154  | Flush matrix dimension mismatch | `expandFilamentSlots` indexes source by `srcDim` |
| 156  | Gcode template vector placeholder | Use `{first_layer_bed_temperature[0]}` not `{first_layer_bed_temperature}` |
| 194  | Real slicer error (e.g. malformed 3MF) | Surfaced in UI |
| 205  | Ooze prevention OR relative-E without G92 E0 | `sanitizeSentinelsAndZeroFilaments` forces both |
| 232  | File version newer than slicer | `APP_BY_ENGINE` map pins per-engine version |
| 139  | SIGSEGV (fork-specific) | Creality Print + Snapmaker Orca are CLI-broken — document, no fix |

`; no filament colors found in projects` warning at `OrcaSlicer.cpp:3507`
is BENIGN — fires when slicer doesn't recompute flush volumes (already set
OR no multi-color). NOT the cause of segfault.
