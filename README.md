# Snorcal

Self-hosted slicing hub for 3D printers. Upload STL/3MF, paint faces, configure
printer/filament/process profiles, slice with OrcaSlicer or BambuStudio, and
send straight to a Klipper or Bambu Lab printer on your LAN.

Single-user, password-protected. Designed to run on a home server or mini PC
on your LAN — **not for internet exposure**.

---

## Quick start (Docker)

Requires Docker + Docker Compose.

```bash
git clone https://github.com/<you>/snorcal.git
cd snorcal/docker
docker compose up --build -d
```

Open http://localhost:3000. On first load you'll set a password (see
[Authentication](#authentication)), then the setup wizard runs to discover
your printer and pick a profile.

One container runs everything — the Node app plus your choice of slicer
binary, fetched on first boot from the
[SimplyPrint/slicer-builds](https://github.com/SimplyPrint/slicer-builds)
nightly release and cached in the data volume. Slicing uses the same
`executeLocal` code path as bare-metal, so output matches.

Pick your slicer with the `SLICER_ENGINE` env var:

| `SLICER_ENGINE` | Slicer fetched                  | Notes |
|-----------------|---------------------------------|-------|
| `orca` (default) | OrcaSlicer                     | Covers Orca mods, Bambu/Snapmaker via Orca profiles |
| `bambu`         | BambuStudio                     | Bambu-purists wanting the native engine |
| `both`          | OrcaSlicer + BambuStudio        | Power users wanting both engines |

To change slicers later, set the env and clear `/data/slicers/` (or just the
relevant subdir) so the entrypoint re-fetches.

Redis is optional (commented out in the compose file). Without it, slices run
in-process via the direct path — fine for single-user setups.

Data lives in the `snorcal-data` volume mounted at `/data`. DB at
`/data/snorcal.db`, models at `/data/models/`, jobs at `/data/jobs/`,
print photos at `/data/print-photos/`.

### Using an external slicer sidecar (legacy mode)

If you'd rather run the slicer as a separate container (the old multi-service
shape), set `SLICER_URL_ORCASLICER=http://host:port` in the app's environment.
When set, snorcal uses the HTTP sidecar path instead of the in-image binary.
Useful if you already run [bambuddy](https://github.com/maziggy/bambuddy)
sidecars or want to share one slicer across multiple snorcal instances.

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
export SLICER_PATH_PRUSASLICER=/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer   # optional
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
│  snorcal container (Node + Fastify + bundled slicer)         │
│    - SQLite (models, jobs, profiles, spools, prints, printers)│
│    - 3MF builder (jszip + face colors + project settings)    │
│    - SlicerExecutor spawns OrcaSlicer under `xvfb-run`       │
│      (same code path bare-metal uses; output matches)        │
│    - Printer adapters (Moonraker MQTT, Bambu MQTT)           │
│    - /data volume: DB, models, jobs, photos                  │
└──────────────────────────┬───────────────────────────────────┘
                           │ MQTT/HTTP to printer
              ┌────────────▼─────────────────────────────────┐
              │  printer (Klipper / Bambu)                   │
              │    camera, status, file transfer             │
              └──────────────────────────────────────────────┘

  (optional) redis:7-alpine — BullMQ job queue. Without it, slices run
  in-process. Only needed for queueing/concurrency control.
```

### Slicing pipeline

1. `POST /api/slice` → job (BullMQ if Redis present, else direct in-process)
2. Worker builds 3MF from STL + face colors + project settings (`threemf-builder.ts`)
3. Writes `input.3mf` to `/data/jobs/<jobId>/`
4. Spawns `orca-slicer --datadir <dir> --slice 0 --outputdir <dir> ... input.3mf`
   under `xvfb-run` (in-image binary; no HTTP hop)
5. Reads gcode from `/data/jobs/<jobId>/output/`, updates DB, fires SSE
6. Frontend listens to SSE for completion

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
| PrusaSlicer   | Prusa + generic Marlin | experimental (engine wired, not fully tested) |
| Cura          | UltiMaker              | ✗ Phase 5 |

Snapmaker machines (U1 etc.) slice via the **OrcaSlicer** engine with Snapmaker
printer/filament profiles — there is no separate "Snapmaker Orca" engine.

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

## Authentication

Snorcal is **password-protected by default**. On first launch (with no password
configured) the UI shows a one-time setup screen to pick a password. After that,
every request needs a signed session cookie. Cookies are httpOnly + SameSite=Lax,
secure-when-served-over-HTTPS, valid 30 days.

To preconfigure the password (headless deploys, reprovisioning), generate a hash
and set it as an env var:

```bash
pnpm --filter backend exec tsx scripts/hash-password.ts
# → SNORCAL_PASSWORD_HASH=scrypt$N=32768$r=8$p=1$...
```

Set `SNORCAL_PASSWORD_HASH` in the environment (e.g. `docker-compose.yml` under
`app.environment`, or `~/.snorcal/snorcal.env` for bare-metal). When set, the
setup screen is skipped.

| Variable | Default | Purpose |
|---|---|---|
| `SNORCAL_PASSWORD_HASH` | _(unset → setup screen on first launch)_ | scrypt hash of the login password. Skips setup if set. |
| `SNORCAL_SESSION_SECRET` | _(auto-generated, persisted in DB)_ | Signs session cookies. Set explicitly to rotate/invalidate all sessions. |
| `SNORCAL_AUTH_DISABLED` | `0` | `1` disables auth entirely (**dangerous** — every route open). Only for fully trusted isolated networks. |

See `.env.example` for the full list.

---

## Security

- **LAN-only by design.** Snorcal assumes a trusted home/LAN network. Auth
  prevents accidental access, not a determined attacker — **do not expose
  port 3000 to the internet.** Use Tailscale / WireGuard / a VPN for remote
  access, not a public port forward.
- **Secrets encrypted at rest.** Printer access codes, API keys, and the Bambu
  cloud token are AES-256-GCM encrypted in the SQLite DB, keyed off a DEK file
  at `/data/.secret-key` (chmod 600). Protects DB backups/copies; not a defense
  against full host compromise.
- **SSRF-hardened.** Camera / WebRTC / connection-test endpoints validate URLs
  and block cloud-metadata hosts. Printer endpoints allow LAN/Tailscale IPs
  (printers live there) but reject `javascript:`/`data:`/`file:` schemes.
- **Reverse proxy optional.** For TLS, put Caddy / Traefik / nginx in front.
  `trustProxy` is enabled so secure cookies work behind a TLS-terminating proxy.
  To restrict Docker port binding to loopback, change `"${PORT:-3000}:3000"`
  to `"127.0.0.1:3000:3000"` in `docker-compose.yml`.

---

## License

GNU Affero General Public License v3.0 or later ([AGPL-3.0-or-later](https://spdx.org/licenses/AGPL-3.0-or-later.html)). See [LICENSE](LICENSE).

In short: you can run, study, and modify Snorcal, including commercially, but **any derivative service you expose over the network must publish its full source code** under the same license.
