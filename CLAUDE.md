# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## Build & Run Commands

```bash
# Dev (backend :3000, frontend :5173 with API proxy)
pnpm dev

# Build all
pnpm build                          # shared → backend + frontend parallel

# Individual packages
pnpm --filter backend dev           # tsx watch src/index.ts
pnpm --filter frontend dev          # vite dev server
pnpm --filter shared build          # tsc (build before backend/frontend)

# Backend build copies JSON alongside JS
pnpm --filter backend build         # tsc && cp src/routes/default-project-settings.json dist/routes/

# Type-check only (no emit)
pnpm --filter backend exec tsc --noEmit
pnpm --filter frontend exec tsc --noEmit
```

No tests. No linter.

## Architecture

**Monorepo**: pnpm workspaces — `packages/shared`, `packages/backend`, `packages/frontend`

### Backend (Fastify + SQLite + BullMQ)

Entry: `src/index.ts` → `src/app.ts` (buildApp)

**Database** (`src/db/`): better-sqlite3, WAL mode. Tables: `models`, `jobs`, `profiles`, `model_plates`. Schema via `migrations.ts`. No ORM — raw prepared statements.

**Slicing pipeline**:
1. `POST /api/slice` receives slice request
2. Build 3MF from STL + face colors + project settings (`threemf-builder.ts`)
3. Spawn slicer binary via `SlicerExecutor` (`xvfb-run` on Linux)
4. Progress via SSE (`/api/events`) or poll (`GET /api/jobs/:id`)
5. G-code estimates parsed from output comments

**Job queue**: BullMQ + Redis (`src/jobs/queue.ts`). Falls back to direct async when Redis down. Concurrency = 1.

**Routes**: `models.ts` (upload/CRUD, multi-plate 3MF), `slice.ts` (jobs, profile merge, multi-material), `settings.ts` (profile import/export), `files.ts` (gcode/model download), `events.ts` (SSE)

**Multi-material**: `mergeFilamentProfiles()` expands `filament_*` keys to N-element arrays, builds NxN `flush_volumes_matrix`. Controlled by `MultiMaterialConfig` in shared types.

### Frontend (React 19 + Three.js + Vite)

Entry: `src/main.tsx` → `src/App.tsx`

**State**: Local useState. localStorage persists: printer, engine, multi-material config.

**3D viewer** (`components/Viewer/`):
- `Scene.tsx` — Three.js renderer + camera + OrbitControls (always mounted)
- `STLViewer.tsx` — STL as non-indexed geometry for per-face coloring
- `FacePainter.tsx` — Raycasting + flood fill face painting
- `GcodeViewer.tsx` — Parsed gcode as colored LineSegments, rotated group (gcode Z-up → Three.js Y-up)
- `GcodeLayerSlider.tsx` — Layer navigation overlay

**Gcode parsing** (`lib/gcode-parser.ts`): Hand-written. Tracks M83/M82 E mode, `;LAYER_CHANGE`/`;Z:`/`;TYPE:`/`;HEIGHT:`. Web Worker.

**Settings** (`components/Settings/SettingsPanel.tsx`): Engine, profiles (machine/filament/process), multi-material toggle + auto-configure preset, collapsible groups.

**API client** (`api/client.ts`): Thin fetch wrapper. State in `App.tsx`, no global store.

### Shared (`@slorca/shared`)

Types (`src/types/`): `SliceRequest`, `SliceJobData`, `MultiMaterialConfig`, `SlicerEngine`, model/API types.

Constants (`src/constants/`):
- `defaults.ts` — `PROJECT_SETTING_OVERRIDES` for Snapmaker U1 + PLA SnapSpeed
- `slicers.ts` — Binary paths per engine per platform

## Critical Slicer Integration Details

**DO NOT use `--load-settings` / `--load-filaments`** — segfault in CLI mode. Embed settings as `Metadata/project_settings.config` inside 3MF (flat JSON ~520 keys). Slicer reads natively.

CLI: `<binary> --datadir <dir> --slice 0 --outputdir <dir> --arrange 0 --orient 0 --debug 2 input.3mf`

Rebuilt 3MF = single plate, so `--slice 0` always correct regardless of UI plate selection.

Key settings: `use_relative_e_distances: "1"` + `G92 E0` in `before_layer_change_gcode` / `layer_change_gcode`.

Default template: `src/routes/default-project-settings.json`. Backend build must copy to dist.

## Data Storage

- DB: `~/.slorca/slorca.db` (or `$SLORCA_DATA_DIR/slorca.db`)
- Models: `~/.slorca/models/`
- Jobs: `~/.slorca/jobs/<jobId>/` (input.3mf + output/*.gcode)
