# Snorcal

Self-hosted slicing hub for 3D printers. Upload STL/3MF, paint faces, configure
printer/filament/process profiles, slice with OrcaSlicer or BambuStudio, and
send straight to a Klipper or Bambu Lab printer on your LAN.

Single-user, no auth. Designed to run on a home server or mini PC.

---

## Quick start (Docker)

Requires Docker + Docker Compose.

```bash
git clone https://github.com/<you>/snorcal.git
cd snorcal/docker
docker compose up --build -d
```

Open http://localhost:3000. Add printers + import slicer profiles via the
in-app **Settings** panel (no first-run wizard).

Services in the default `docker-compose.yml`:

| Service             | Image                              | Has                                  | Memory |
|---------------------|------------------------------------|--------------------------------------|--------|
| `app`               | built from `docker/Dockerfile.app` | Backend + frontend static            | 512M   |
| `orca-slicer-api`   | `ghcr.io/maziggy/orca-slicer-api`  | Bambuddy sidecar — OrcaSlicer HTTP   | 4G     |
| `bambu-studio-api`  | `ghcr.io/maziggy/bambu-studio-api` | Bambuddy sidecar — BambuStudio HTTP  | 4G     |
| `redis`             | `redis:7-alpine`                   | BullMQ job queue (commented out)     | 128M   |

Redis is commented out by default — slicing runs in-process via the direct
async path. Uncomment alongside `REDIS_HOST`/`REDIS_PORT` in `app` to
re-enable the queue.

The `app` container mounts the `snorcal-data` volume at `/data`. DB lives at
`/data/snorcal.db`, models at `/data/models/`, jobs at `/data/jobs/`,
imported profile JSON at `/data/settings/`. Print-history photos are written
to `~/.snorcal/print-photos/` inside the container (currently outside the
volume — does not survive `docker compose down -v`).

### Stop / update

```bash
docker compose down              # stop
docker compose pull && docker compose up -d --build   # update
```

### View logs

```bash
docker compose logs -f app
docker compose logs -f orca-slicer-api
docker compose logs -f bambu-studio-api
```

---

## Dev mode (no Docker)

For hacking on the codebase. Runs natively on macOS / Linux.

```bash
pnpm install
pnpm dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173 (proxies `/api` → :3000)
- Data dir: `packages/backend/data/` (override via `DATA_DIR` env var)

You need slicer binaries installed locally. Set env vars pointing to them:

```bash
export SLICER_PATH_ORCASLICER=/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer
export SLICER_PATH_BAMBUSTUDIO=/Applications/BambuStudio.app/Contents/MacOS/BambuStudio
```

Without these, slicing will fail with "slicer binary not found" but the rest
of the UI works (upload, paint, profiles, printer monitor).

Redis optional. If missing, queue degrades to direct async (no retry/concurrency control).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (React + Three.js)                                  │
│    Upload STL → Paint faces → Configure → Slice → Send       │
└────────────────────────┬─────────────────────────────────────┘
                         │ HTTP /api + SSE
┌────────────────────────▼─────────────────────────────────────┐
│  app container (Node + Fastify)                              │
│    - SQLite (models, jobs, profiles, plates, prints)         │
│    - 3MF builder (jszip + face colors + project settings)    │
│    - Direct async slicer path (or BullMQ when Redis enabled) │
│    - Printer adapters (Moonraker, Bambu LAN MQTT)            │
└──────┬──────────────────────────┬───────────────────────────┘
       │ shared /data volume      │ MQTT/HTTP to printer
       │ (input.3mf + output gcode share the mount)
┌──────▼─────────────┐  ┌────────▼─────────────────────────────┐
│ orca-slicer-api    │  │  printer (Klipper / Bambu)           │
│ bambu-studio-api   │  │    camera, status, file transfer     │
│ (bambuddy sidecars)│  └──────────────────────────────────────┘
│ multipart upload   │
│ /slice-async + poll│  ┌────────────────┐
│ → gcode download   │  │  redis:7-alpine│
└────────────────────┘  │  (optional)    │
                        └────────────────┘
```

### Slicing pipeline

1. `POST /api/slice` → direct async job (or BullMQ enqueue when Redis up)
2. `runSliceJob` builds 3MF from STL + face colors + project settings
   (`threemf-builder.ts`)
3. Writes `input.3mf` to `/data/jobs/<jobId>/`
4. Resolves engine URL via `getSidecarUrl(engine)`:
   - Sidecar mode (default in Docker): multipart upload to
     `http://orca-slicer-api:3003/slice-async` (or `bambu-studio-api:3001`),
     poll status, download gcode
   - Local mode (dev macOS): spawn slicer binary directly
5. Sidecar writes gcode into the shared volume; worker reads it back
6. G-code estimates parsed from output comments, DB updated, SSE fired
7. Frontend listens to SSE (`/api/events`) or polls `GET /api/jobs/:id`

CLI contract (local dev): `<binary> --datadir <dir> --slice 0 --outputdir <dir> --arrange 0 --orient 0 --debug 2 input.3mf`

Settings are embedded inside the 3MF as `Metadata/project_settings.config`
(flat JSON, ~520 keys). Snorcal never passes `--load-settings` /
`--load-filaments` — embedding is more reliable and survives profile
mismatches.

---

## Supported printers

| Protocol | Firmware / vendor            | Status | Notes                                            |
|----------|------------------------------|--------|--------------------------------------------------|
| Moonraker| Klipper (Voron, RatRig, etc) | ✓      | Requires `cors_domains` + `trusted_clients` in moonraker.conf |
| Bambu LAN| Bambu Lab (X1/P1/A1)         | ✓      | Needs LAN access code + serial. Cloud-only mode not supported |
| OctoPrint| OctoPrint                    | ✗      | Phase 5                                          |
| Repetier | Repetier Server              | ✗      | Phase 5                                          |
| Duet/RRF | DuetWiFi + RepRapFirmware    | ✗      | Phase 5                                          |

### Moonraker setup

In `moonraker.conf`:

```ini
[authorization]
trusted_clients:
  192.168.1.0/24        # your LAN
cors_domains:
  http://localhost:3000
  http://*.local
```

Restart Moonraker. Then in Snorcal: Add Printer → Moonraker → enter IP (port 7125 default).

### Bambu Lab setup

On printer LCD: **Settings → Network → LAN Access Code**. Get the 8-digit code
and printer serial (on back of printer or in Bambu Studio device page).

In Snorcal: Add Printer → Bambu Lab (LAN) → enter IP, port 8883, serial, access code.

---

## Supported slicers

| Engine        | Vendor / use           | Status |
|---------------|------------------------|--------|
| OrcaSlicer    | Universal (most mods)  | ✓      |
| BambuStudio   | Bambu Lab native       | ✓      |
| PrusaSlicer   | Prusa + generic Marlin | ✗ Phase 5 |
| Cura          | UltiMaker              | ✗ Phase 5 |

Engine picker lives in **Settings → App Settings** (global), not per-slice.

### Profiles

Bundled default: Snapmaker U1 + SnapSpeed PLA + 0.20 Standard.

For any other printer, import your own profiles via
**Settings → Profiles → Import**. Accepts OrcaSlicer/BambuStudio JSON exports.

---

## Troubleshooting

**Slicer binary not found** — In dev mode, set `SLICER_PATH_<ENGINE>` env vars.
In Docker, ensure the `slicer` service is healthy (`docker compose ps`).

**Moonraker connection refused** — Add Snorcal's IP to `trusted_clients`
in moonraker.conf. Restart Moonraker.

**Bambu printer offline** — Confirm LAN access code hasn't rotated (printer
reboot sometimes regenerates it). Re-enter on printer detail page.

**Slice job hangs at 15%** — Sidecar may be stuck. Restart the matching
engine: `docker compose restart orca-slicer-api` (or `bambu-studio-api`).

**G-code looks wrong** — Check `use_relative_e_distances: "1"` is in your
process settings. Some firmwares (RepRapFirmware) need absolute mode — not
yet auto-detected.

**Camera not loading** — Bambu uses MQTT-tunneled video which the proxy
repacks as MJPEG. Latency is high (~5s). For Moonraker, set snapshot URL
explicitly in printer settings.

**Redis not available** — App still runs but slicing jobs execute inline
(no retry, no concurrency limit). For full functionality, ensure `redis`
container is up.

**DB locked / corruption** — Stop app, run `sqlite3 /data/snorcal.db 'PRAGMA integrity_check;'`.
WAL checkpoint on restart usually recovers. Backup the file first.

---

## Data storage

| Path                           | Contents                              |
|--------------------------------|---------------------------------------|
| `/data/snorcal.db`             | SQLite: models, jobs, profiles, etc.  |
| `/data/models/<id>.stl`        | Uploaded source models                |
| `/data/jobs/<jobId>/input.3mf` | Built 3MF (pre-slice)                 |
| `/data/jobs/<jobId>/output/`   | G-code output                         |
| `/data/settings/`              | Imported slicer profile JSONs         |
| `~/.snorcal/print-photos/`     | Print history photos (not in volume)  |

Backup: `docker compose stop app && tar czf snorcal-backup.tgz /var/lib/docker/volumes/snorcal_snorcal-data/_data` (path varies by Docker root).

---

## Security

- **No auth.** Single-user assumption. Do NOT expose port 3000 to the internet.
- Use a reverse proxy (Caddy / Traefik / nginx) with basic auth + TLS if you need remote access.
- Restrict Docker port binding to LAN: change `"${PORT:-3000}:3000"` to `"127.0.0.1:3000:3000"` in `docker-compose.yml`.

---

## License

GNU Affero General Public License v3.0 or later ([AGPL-3.0-or-later](https://spdx.org/licenses/AGPL-3.0-or-later.html)). See [LICENSE](LICENSE).

In short: you can run, study, and modify Snorcal, including commercially, but **any derivative service you expose over the network must publish its full source code** under the same license.
