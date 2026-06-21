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
3. Dispatch to slicer via `SlicerExecutor`:
   - If `SLICER_URL_<ENGINE>` set: HTTP multipart upload to bambuddy sidecar (`/slice-async` → poll → download gcode)
   - Otherwise: spawn local slicer binary via `xvfb-run` (Linux) or direct (macOS dev)
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

**Settings** (`components/Settings/`):
- `SettingsPanel.tsx` — per-slice slicer settings (profiles, multi-material toggle, collapsible groups)
- `AppSettingsPanel.tsx` — global app settings (engine selector, sidecar URLs + status, storage, queue, host info, MakerWorld login)

**API client** (`api/client.ts`): Thin fetch wrapper. State in `App.tsx`, no global store.

### Shared (`@snorcal/shared`)

Types (`src/types/`): `SliceRequest`, `SliceJobData`, `MultiMaterialConfig`, `SlicerEngine`, model/API types.

Constants (`src/constants/`):
- `defaults.ts` — `PROJECT_SETTING_OVERRIDES` for Snapmaker U1 + PLA SnapSpeed
- `slicers.ts` — Binary paths per engine per platform

## Critical Slicer Integration Details

**Settings embedding strategy:** Snorcal embeds all slice settings as `Metadata/project_settings.config` inside a fresh 3MF (flat JSON ~520 keys). The slicer reads them natively. No `--load-settings` / `--load-filaments` CLI flags used.

**Sidecar mode (production):** Two bambuddy sidecar containers serve OrcaSlicer + BambuStudio over HTTP. Snorcal uploads the embedded 3MF via `POST /slice-async` (multipart `file` field, no profile files), polls status, downloads gcode. Sidecar runs essentially `--slice 0 --arrange 0 --orient 0 --outputdir /out input.3mf` internally.

**Local mode (dev macOS):** Direct spawn of local `/Applications/OrcaSlicer.app/...` binary. CLI: `<binary> --datadir <dir> --slice 0 --outputdir <dir> --arrange 0 --orient 0 --debug 2 input.3mf`.

**Engine URL resolution:** `getSidecarUrl(engine)` in `services/slicer-executor.ts` checks `SLICER_URL_<ENGINE_UPPER>` (e.g. `SLICER_URL_ORCASLICER`, `SLICER_URL_BAMBUSTUDIO`), falls back to deprecated `SLICER_URL` for both engines, then null (local mode).

Rebuilt 3MF = single plate, so `--slice 0` always correct regardless of UI plate selection.

Key settings: `use_relative_e_distances: "1"` + `G92 E0` in `before_layer_change_gcode` / `layer_change_gcode`.

Default template: `src/routes/default-project-settings.json`. Backend build must copy to dist.

## Data Storage

Resolved by `getDataDir()` in `packages/backend/src/services/model-parser.ts`:
`process.env.DATA_DIR || path.resolve(process.cwd(), 'data')`.

When running `pnpm --filter backend dev` from the repo, cwd = `packages/backend/`, so data lives at:

- DB: `packages/backend/data/snorcal.db`
- Models: `packages/backend/data/models/`
- Jobs: `packages/backend/data/jobs/<jobId>/` (input.3mf + output/*.gcode)

Override by setting `DATA_DIR=/some/path` before starting backend.

Print-history photos always write to `~/.snorcal/print-photos/` regardless (see `inventory.ts`).
