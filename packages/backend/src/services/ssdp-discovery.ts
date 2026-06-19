import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { DiscoveredDevice } from '@slorca/shared';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// --- SSDP (UPnP) discovery ---

function buildMsearch(st: string, mx: number): string {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${st}`,
    '',
    '',
  ].join('\r\n');
}

function parseSsdpResponse(data: Buffer, rinfo: { address: string; port: number }): DiscoveredDevice | null {
  const text = data.toString('utf-8');
  if (!text.startsWith('HTTP/')) return null;

  const headers: Record<string, string> = {};
  for (const line of text.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
    }
  }

  const location = headers['LOCATION'] || '';
  let port = rinfo.port;
  try { const u = new URL(location); if (u.port) port = parseInt(u.port); } catch {}

  const server = headers['SERVER'] || '';
  const friendlyName = server || headers['USN']?.split('::')[0] || rinfo.address;

  return {
    ip: rinfo.address,
    port,
    location,
    friendlyName,
    server,
    st: headers['ST'] || '',
    usn: headers['USN'] || '',
  };
}

function discoverSsdp(timeoutMs: number): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const devices = new Map<string, DiscoveredDevice>();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      resolve([...devices.values()]);
    };

    socket.on('message', (data, rinfo) => {
      const device = parseSsdpResponse(data, rinfo);
      if (!device) return;
      const key = device.usn || `${device.ip}:${device.port}`;
      devices.set(key, device);
    });

    socket.on('error', () => finish());

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.setMulticastTTL(4);

      const mx = Math.ceil(timeoutMs / 1000);
      // Standard SSDP + Bambu custom SSDP ports (1990/2021)
      const ports = [SSDP_PORT, 1990, 2021];
      for (const port of ports) {
        for (const st of ['ssdp:all', 'upnp:rootdevice']) {
          const msg = Buffer.from(buildMsearch(st, mx));
          socket.send(msg, port, SSDP_ADDR, () => {});
        }
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

// --- mDNS/Bonjour discovery ---

function discoverMdns(timeoutMs: number): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const isMac = process.platform === 'darwin';
    const cmd = isMac ? 'dns-sd' : 'avahi-browse';
    const args = isMac
      ? ['-B', '_printer._tcp', 'local.']
      : ['-rpt', '_printer._tcp'];

    const child = execFile(cmd, args, { timeout: timeoutMs + 2000 }, (err, stdout, stderr) => {
      // dns-sd on macOS writes output to stderr
      const output = isMac ? (stderr || '') + (stdout || '') : (stdout || '');
      if (!output) { resolve([]); return; }
      resolve(parseMdnsOutput(output, isMac));
    });

    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);
  });
}

function parseMdnsOutput(output: string, isMac: boolean): DiscoveredDevice[] {
  const devices: DiscoveredDevice[] = [];

  if (isMac) {
    // dns-sd -B output lines like:
    // 16:05:09.378  Add        2  15 local.  _printer._tcp.  Brother DCP-L2550DW series
    const lines = output.split('\n');
    const names: string[] = [];
    for (const line of lines) {
      if (!line.includes('Add')) continue;
      const parts = line.split(/\s{2,}/);
      const name = parts[parts.length - 1]?.trim();
      if (name && !name.includes('STARTING') && !name.includes('Timestamp')) {
        names.push(name);
      }
    }

    // For each name, we'll return a placeholder — the frontend can resolve
    // or we return them with .local hostnames
    for (const name of names) {
      devices.push({
        ip: '', // will be resolved below
        port: 0,
        location: '',
        friendlyName: name,
        server: 'mDNS/Bonjour',
        st: '_printer._tcp',
        usn: `mdns:${name}`,
      });
    }
  } else {
    // avahi-browse -rpt output:
    // =;eth0;IPv4;Brother DCP-L2550DW;_printer._tcp;local;hostname.local;192.168.1.100;515;
    for (const line of output.split('\n')) {
      if (!line.startsWith('=')) continue;
      const parts = line.split(';');
      if (parts.length < 9) continue;
      const name = parts[3];
      const host = parts[6];
      const ip = parts[7];
      const port = parseInt(parts[8]) || 0;
      if (name && ip) {
        devices.push({
          ip,
          port,
          location: `http://${host}:${port}`,
          friendlyName: name,
          server: 'mDNS/Bonjour',
          st: '_printer._tcp',
          usn: `mdns:${name}@${ip}`,
        });
      }
    }
  }

  return devices;
}

// On macOS, resolve mDNS names to IPs using dns-sd -L
async function resolveMdnsDevices(devices: DiscoveredDevice[], timeoutMs: number): Promise<DiscoveredDevice[]> {
  if (process.platform !== 'darwin') return devices; // avahi already gives IPs

  const perDevice = Math.min(2000, Math.floor(timeoutMs / Math.max(devices.length, 1)));
  const resolved: DiscoveredDevice[] = [];

  for (const d of devices) {
    if (d.ip) { resolved.push(d); continue; }

    const ip = await new Promise<string>((res) => {
      const child = execFile('dns-sd', ['-L', d.friendlyName, '_printer._tcp', 'local.'], { timeout: perDevice }, (err, stdout, stderr) => {
        const output = (stderr || '') + (stdout || '');
        if (!output) { res(''); return; }
        const match = output.match(/can be reached at\s+(\S+?)\.local\S*:(\d+)/);
        if (match) {
          const hostname = match[1];
          const port = parseInt(match[2]) || 0;
          (d as any)._port = port;
          execFile('dns-sd', ['-G', 'v4', `${hostname}.local.`], { timeout: 2000 }, (err2, stdout2, stderr2) => {
            const out2 = (stderr2 || '') + (stdout2 || '');
            const ipMatch = out2.match(/(\d+\.\d+\.\d+\.\d+)/);
            res(ipMatch ? ipMatch[1] : `${hostname}.local`);
          });
        } else {
          res('');
        }
      });
      setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, perDevice);
    });

    const port = (d as any)._port || d.port;
    resolved.push({ ip: ip || d.friendlyName, port, location: d.location, friendlyName: d.friendlyName, server: d.server, st: d.st, usn: d.usn });
  }

  return resolved;
}

// --- Subnet port scanning for 3D printers ---

interface HttpProbe {
  type: 'http';
  port: number;
  label: string;
  path: string;
  identify: (res: Response, ip: string, port: number) => Promise<DiscoveredDevice | null>;
}

interface TcpProbe {
  type: 'tcp';
  port: number;
  label: string;
  toDevice: (ip: string, port: number) => DiscoveredDevice;
}

type PrinterProbe = HttpProbe | TcpProbe;

const PRINTER_PROBES: PrinterProbe[] = [
  // HTTP probes first — better identification
  {
    type: 'http',
    port: 7125,
    label: 'Moonraker/Klipper',
    path: '/printer/info',
    identify: async (res, ip, port) => {
      if (!res.ok) return null;
      try {
        const json = await res.json() as any;
        if (!json.result) return null;
        const state = json.result.state || 'unknown';
        const version = json.result.software_version || '';
        const hostname = json.result.hostname || '';
        return {
          ip, port,
          location: `http://${ip}:${port}`,
          friendlyName: hostname ? `Klipper (${hostname})` : `Klipper @ ${ip}`,
          server: `Moonraker/Klipper ${state}${version ? ` (${version})` : ''}`,
          st: 'moonraker',
          usn: `moonraker:${ip}`,
        };
      } catch { return null; }
    },
  },
  {
    type: 'tcp',
    port: 7125,
    label: 'Moonraker (TCP)',
    toDevice: (ip, port) => ({
      ip, port,
      location: `http://${ip}:${port}`,
      friendlyName: `Device @ ${ip} (port 7125)`,
      server: 'Possible Moonraker/Klipper (port open)',
      st: 'moonraker',
      usn: `moonraker:${ip}`,
    }),
  },
  {
    type: 'tcp',
    port: 8883,
    label: 'MQTT/TLS (TCP)',
    toDevice: (ip, port) => ({
      ip, port,
      location: `mqtt://${ip}:${port}`,
      friendlyName: `Device @ ${ip} (port 8883)`,
      server: 'Possible Bambu Lab MQTT (port open)',
      st: 'bambu-lan',
      usn: `bambu:${ip}`,
    }),
  },
  {
    type: 'http',
    port: 6001,
    label: 'Bambu Lab (HTTP)',
    path: '/system/info',
    identify: async (res, ip, port) => {
      const serverHeader = res.headers.get('server') || '';
      if (/eero/i.test(serverHeader)) return null;
      try {
        const text = await res.text();
        const json = JSON.parse(text);
        if (json && (json.device || json.hw_ver || json.sn || json.model || json.printer_name)) {
          const name = json.printer_name || json.model || 'Bambu Lab';
          return {
            ip, port,
            location: `http://${ip}:${port}`,
            friendlyName: `${name} @ ${ip}`,
            server: `Bambu Lab (LAN)${json.hw_ver ? ` ${json.hw_ver}` : ''}`,
            st: 'bambu-lan',
            usn: `bambu:${ip}`,
          };
        }
      } catch {}
      return null;
    },
  },
  {
    type: 'http',
    port: 80,
    label: 'OctoPrint',
    path: '/api/version',
    identify: async (res, ip, port) => {
      if (!res.ok) return null;
      try {
        const json = await res.json() as any;
        if (!json.server && !json.api) return null;
        return {
          ip, port,
          location: `http://${ip}:${port}`,
          friendlyName: `OctoPrint @ ${ip}`,
          server: `OctoPrint ${json.server || ''}`.trim(),
          st: 'octoprint',
          usn: `octoprint:${ip}`,
        };
      } catch { return null; }
    },
  },
];

function getSubnets(): Array<{ base: number; mask: number }> {
  const interfaces = os.networkInterfaces();
  const subnets: Array<{ base: number; mask: number }> = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    // Skip VPN/tunnel interfaces
    if (/^(utun|tun|wg|tailscale)/i.test(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const parts = addr.address.split('.').map(Number);
      const maskParts = addr.netmask.split('.').map(Number);
      const ip = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
      let mask = ((maskParts[0] << 24) | (maskParts[1] << 16) | (maskParts[2] << 8) | maskParts[3]) >>> 0;
      // macOS often reports 255.255.255.255 for Wi-Fi — assume /24 for private ranges
      if (mask === 0xFFFFFFFF) {
        mask = 0xFFFFFF00; // /24
      }
      subnets.push({ base: ip & mask, mask });
    }
  }
  return subnets;
}

function subnetHosts(base: number, mask: number): string[] {
  const hosts: string[] = [];
  const wildcard = ~mask >>> 0;
  // Limit to /16 or smaller subnets (max 65534 hosts)
  if (wildcard > 65534) return [];
  const count = Math.min(wildcard - 1, 1024); // cap at 1024 hosts for speed
  for (let i = 1; i <= count; i++) {
    const host = ((base + i) >>> 0);
    const ip = `${(host >>> 24) & 0xFF}.${(host >>> 16) & 0xFF}.${(host >>> 8) & 0xFF}.${host & 0xFF}`;
    hosts.push(ip);
  }
  return hosts;
}

async function probeTcp(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.connect(port, ip, () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
  });
}

async function probeIp(ip: string, timeoutMs: number): Promise<DiscoveredDevice[]> {
  const found: DiscoveredDevice[] = [];
  const perProbe = Math.max(500, Math.floor(timeoutMs * 0.4));

  // Run all probes in parallel, take first match per IP (HTTP probes preferred)
  const results = await Promise.all(PRINTER_PROBES.map(async (probe) => {
    try {
      if (probe.type === 'tcp') {
        const open = await probeTcp(ip, probe.port, perProbe);
        return open ? probe.toDevice(ip, probe.port) : null;
      } else {
        const res = await fetch(`http://${ip}:${probe.port}${probe.path}`, {
          signal: AbortSignal.timeout(perProbe),
        });
        return await probe.identify(res, ip, probe.port);
      }
    } catch { return null; }
  }));

  // Prefer HTTP-confirmed matches (have real identification) over TCP-only guesses
  for (const r of results) {
    if (r && r.st !== 'bambu-lan') { found.push(r); return found; }
  }
  // Fall back to any TCP match (labeled "possible")
  for (const r of results) {
    if (r) { found.push(r); return found; }
  }
  return found;
}

async function discoverSubnet(timeoutMs: number): Promise<DiscoveredDevice[]> {
  const subnets = getSubnets();
  if (subnets.length === 0) return [];

  // Limit scan time
  const scanTimeout = Math.min(timeoutMs, 8000);
  const allHosts: string[] = [];
  for (const { base, mask } of subnets) {
    allHosts.push(...subnetHosts(base, mask));
  }
  if (allHosts.length === 0) return [];

  // Probe in batches of 64 concurrent connections
  const batchSize = 64;
  const devices: DiscoveredDevice[] = [];
  const deadline = Date.now() + scanTimeout;

  for (let i = 0; i < allHosts.length && Date.now() < deadline; i += batchSize) {
    const batch = allHosts.slice(i, i + batchSize);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const results = await Promise.all(
      batch.map(ip => probeIp(ip, remaining)),
    );
    for (const found of results) devices.push(...found);
  }

  return devices;
}

// --- Combined discovery ---

export async function discoverDevices(timeoutMs: number = 5000): Promise<DiscoveredDevice[]> {
  const ssdpHalf = Math.floor(timeoutMs * 0.3);
  const mdnsHalf = Math.floor(timeoutMs * 0.3);
  // Subnet scan runs in parallel, uses up to 8s of the total timeout

  // Run all three in parallel
  const [ssdpDevices, rawMdnsDevices, subnetDevices] = await Promise.all([
    discoverSsdp(ssdpHalf).catch(() => [] as DiscoveredDevice[]),
    discoverMdns(mdnsHalf).catch(() => [] as DiscoveredDevice[]),
    discoverSubnet(timeoutMs).catch(() => [] as DiscoveredDevice[]),
  ]);

  // Resolve mDNS IPs (macOS only, avahi already gives IPs)
  const mdnsDevices = await resolveMdnsDevices(rawMdnsDevices, mdnsHalf);

  // Merge, dedupe by IP — only keep 3D printers
  const PRINTER_TYPES = new Set(['moonraker', 'bambu-lan', 'octoprint']);
  const seen = new Set<string>();
  const all: DiscoveredDevice[] = [];
  for (const d of [...subnetDevices, ...mdnsDevices, ...ssdpDevices]) {
    if (!PRINTER_TYPES.has(d.st)) continue;
    const key = d.ip || d.friendlyName;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(d);
  }

  return all;
}
