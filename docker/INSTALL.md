# Snorcal — Quick Start for Friends

You're 10 minutes away from slicing. Three steps: install Docker, download one file, run one command.

---

## 1. Install Docker Desktop

Download and install Docker Desktop for your OS:

- **Mac**: <https://www.docker.com/products/docker-desktop/>
  - Apple Silicon (M1/M2/M3): pick the "Apple Silicon" download.
  - Intel Mac: pick the "Intel Chip" download.
- **Windows**: same link, pick "Windows".

Open Docker Desktop once installed. You should see a little whale icon in your menu bar / system tray. Wait until it says "Engine running".

---

## 2. Download the compose file

Make a folder somewhere you'll remember (Desktop is fine) and download this one file into it:

<https://raw.githubusercontent.com/davidphillips2/snorcal/main/docker/docker-compose.example.yml>

Easiest way:

- **Mac**: open Terminal, paste:
  ```
  mkdir -p ~/snorcal && cd ~/snorcal && curl -O https://raw.githubusercontent.com/davidphillips2/snorcal/main/docker/docker-compose.example.yml
  ```

- **Windows**: open PowerShell, paste:
  ```
  mkdir $HOME\snorcal ; cd $HOME\snorcal ; curl.exe -O https://raw.githubusercontent.com/davidphillips2/snorcal/main/docker/docker-compose.example.yml
  ```

You should now have a single file called `docker-compose.example.yml` in that folder.

---

## 3. Start everything

In the same terminal, from the same folder:

```
docker compose -f docker-compose.example.yml up -d
```

First run will download ~2 GB of images (Snorcal + two slicer sidecars). Coffee time. When it's done you'll see "Container ... Started" for three containers.

---

## 4. Open the app

Browser → <http://localhost:3000>

You'll be prompted to add a printer. Have ready:

- **Bambu Lab** (X1/P1/A1): printer's IP address, LAN access code (on the printer's LCD: Settings → Network), and serial number.
- **Klipper/Moonraker** (Voron, RatRig, Snapmaker, Creality Hi / Spark X i7, anything running Klipper): printer's IP address. That's it.

You can try "Scan Network" but on Mac/Windows Docker Desktop it usually won't find anything (multicast doesn't traverse the Docker VM). Just type the IP directly — the printer's IP from its LCD/settings page.

> **Creality Spark X i7 / Hi note:** pick "Creality Spark X i7" (or "Creality Hi") from the model dropdown. The OrcaSlicer engine ships a matching machine profile under the "Creality Hi" name — select that when slicing.

---

## 5. Slice something

1. Drop an STL or 3MF into the window.
2. Pick a printer, an engine (OrcaSlicer or BambuStudio), and a filament profile.
3. Click Slice.
4. When it's done, send the gcode straight to the printer.

---

## Stopping / restarting

- Stop: `docker compose -f docker-compose.example.yml down`
- Start again: `docker compose -f docker-compose.example.yml up -d`
- Your printers + settings + models persist in a Docker volume between restarts.

## Updating to a new version

```
docker compose -f docker-compose.example.yml pull
docker compose -f docker-compose.example.yml up -d
```

## Troubleshooting

**Port 3000 in use?** Edit the file, change `"${PORT:-3000}:3000"` to `"${PORT:-3654}:3000"`, then open `http://localhost:3654` instead.

**"Cannot connect to Redis"?** You can ignore this — Snorcal runs fine without Redis (it's optional, used only for the BullMQ job queue). Slices run in-process instead.

**Slicer jobs stay queued forever?** Slicer sidecars (OrcaSlicer / BambuStudio) use a lot of memory. Give Docker Desktop at least 8 GB in Settings → Resources.

**Printer not found in scan?** Bridge networking in Docker can't always see mDNS. Type the IP manually — works just as well.

---

Need help? File an issue: <https://github.com/davidphillips2/snorcal/issues>
