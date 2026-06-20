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

Open http://localhost:3000. On first load, the setup wizard runs automatically
to discover your printer and pick a profile.

Three containers spin up:

| Service  | Image base         | Has                                  | Memory |
|----------|--------------------|--------------------------------------|--------|
| `app`    | node:20-slim       | Backend + frontend static            | 512M   |
| `slicer` | ubuntu:22.04       | OrcaSlicer + BambuStudio + Xvfb + sidecar HTTP | 4G     |
| `redis`  | redis:7-alpine     | BullMQ job queue                     | 128M   |

All three share the `snorcal-data` volume mounted at `/data`. DB lives at
`/data/snorcal.db`, models at `/data/models/`, jobs at `/data/jobs/`,
print photos at `/data/print-photos/`.

### Stop / update

```bash
docker compose down              # stop
docker compose pull && docker compose up -d --build   # update
```

### View logs

```bash
docker compose logs -f app
docker compose logs -f slicer
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
- Data dir: `~/.snorcal/`

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
│    - SQLite (models, jobs, profiles, spools, prints, printers)│
│    - 3MF builder (jszip + face colors + project settings)    │
│    - BullMQ worker → POSTs /slice to sidecar                 │
│    - Printer adapters (Moonraker MQTT, Bambu MQTT)           │
└──────┬──────────────────────────┬────────────────────────────┘
       │ shared /data volume      │ MQTT/HTTP to printer
┌──────▼─────────────┐  ┌────────▼─────────────────────────────┐
│  slicer container  │  │  printer (Klipper / Bambu)           │
│  - Xvfb :99        │  │    camera, status, file transfer     │
│  - OrcaSlicer      │  └──────────────────────────────────────┘
│  - BambuStudio     │
│  - HTTP :3001      │  ┌────────────────┐
│    (SSE progress)  │  │  redis:7-alpine│
└────────────────────┘  └────────────────┘
```

### Slicing pipeline

1. `POST /api/slice` → BullMQ job
2. Worker builds 3MF from STL + face colors + project settings (`threemf-builder.ts`)
3. Writes `input.3mf` to `/data/jobs/<jobId>/`
4. POSTs `{"engine","input3mf","outputDir",...}` to `http://slicer:3001/slice`
5. Sidecar spawns slicer under Xvfb, streams SSE progress events back
6. Sidecar writes gcode to `/data/jobs/<jobId>/output/`
7. Worker reads gcode from same path (shared volume), updates DB, fires SSE
8. Frontend polls job or listens to SSE for completion

CLI contract: `<binary> --datadir <dir> --slice 0 --outputdir <dir> --arrange 0 --orient 0 --debug 2 input.3mf`

Settings embedded inside the 3MF as `Metadata/project_settings.config`
(flat JSON, ~520 keys). Do NOT use `--load-settings` / `--load-filaments` —
they segfault in CLI mode.

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
| Snapmaker Orca| Snapmaker machines     | ✓ (shares OrcaSlicer binary, different datadir) |
| PrusaSlicer   | Prusa + generic Marlin | ✗ Phase 5 |
| Cura          | UltiMaker              | ✗ Phase 5 |

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

**Slice job hangs at 15%** — Sidecar Xvfb may have died. `docker compose restart slicer`.

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
| `/data/print-photos/<id>.*`    | Print history photos                  |
| `/data/settings/`              | Imported slicer profile JSONs         |

Backup: `docker compose stop app && tar czf snorcal-backup.tgz /var/lib/docker/volumes/snorcal_snorcal-data/_data` (path varies by Docker root).

---

## Security

- **No auth.** Single-user assumption. Do NOT expose port 3000 to the internet.
- Use a reverse proxy (Caddy / Traefik / nginx) with basic auth + TLS if you need remote access.
- Restrict Docker port binding to LAN: change `"${PORT:-3000}:3000"` to `"127.0.0.1:3000:3000"` in `docker-compose.yml`.

---

## License

TBD.
