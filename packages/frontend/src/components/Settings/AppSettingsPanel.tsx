import { useEffect, useState } from 'react';
import * as api from '../../api/client';

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function AppSettingsPanel() {
  const [info, setInfo] = useState<api.SystemInfo | null>(null);
  const [sidecarTest, setSidecarTest] = useState<{ redis: 'ok' | 'down'; slicer?: 'ok' | 'down' | 'unset' } | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [i, t] = await Promise.all([api.getSystemInfo(), api.testSidecar()]);
      setInfo(i);
      setSidecarTest(t);
    } catch (e) {
      console.error('Failed to load system info:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const handleTest = async () => {
    setTesting(true);
    try { setSidecarTest(await api.testSidecar()); }
    finally { setTesting(false); }
  };

  if (loading || !info) {
    return <div className="text-xs text-gray-500">Loading…</div>;
  }

  return (
    <div className="space-y-6 text-sm">
      {/* Storage */}
      <Section title="Storage">
        <Row label="Data directory" value={<code className="text-gray-300 text-xs">{info.storage.dataDir}</code>} />
        <Row label="Database size" value={formatBytes(info.storage.dbSize)} />
        <Row label="Models" value={`${formatBytes(info.storage.modelsSize)} (${info.counts.models} files)`} />
        <Row label="Jobs" value={`${formatBytes(info.storage.jobsSize)} (${info.counts.jobs} files)`} />
        {info.storage.diskTotal != null && info.storage.diskFree != null && (
          <Row
            label="Disk free"
            value={`${formatBytes(info.storage.diskFree)} / ${formatBytes(info.storage.diskTotal)} (${((info.storage.diskFree / info.storage.diskTotal) * 100).toFixed(0)}%)`}
          />
        )}
      </Section>

      {/* Queue / sidecar */}
      <Section
        title="Queue & Sidecar"
        action={
          <button
            onClick={handleTest}
            disabled={testing}
            className="px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
        }
      >
        <Row
          label="Redis"
          value={
            <span>
              <code className="text-gray-300 text-xs">{info.queue.redisHost}:{info.queue.redisPort}</code>
              {' '}
              <StatusBadge ok={sidecarTest?.redis === 'ok'} label={sidecarTest?.redis === 'ok' ? 'connected' : 'down (fallback)'} />
            </span>
          }
        />
        <Row
          label="Slicer"
          value={
            info.slicer.local
              ? <span><StatusBadge ok={true} label="local binary" /></span>
              : (
                <span>
                  <code className="text-gray-300 text-xs">{info.slicer.sidecarUrl}</code>
                  {' '}
                  <StatusBadge ok={sidecarTest?.slicer === 'ok'} label={sidecarTest?.slicer ?? 'unset'} />
                </span>
              )
          }
        />
        {info.slicer.datadir && (
          <Row label="Slicer datadir" value={<code className="text-gray-300 text-xs">{info.slicer.datadir}</code>} />
        )}
      </Section>

      {/* MakerWorld (moved from slicer settings) */}
      <MakerWorldSection />

      {/* Host */}
      <Section title="Host">
        <Row label="Hostname" value={info.host.hostname} />
        <Row label="Platform" value={`${info.host.platform} / ${info.host.arch}`} />
        <Row label="Node" value={info.host.nodeVersion} />
        <Row label="Uptime" value={formatUptime(info.host.uptime)} />
        <Row label="Printers" value={String(info.counts.printers)} />
      </Section>

      <div className="text-[10px] text-gray-500 pt-4 border-t border-gray-800">
        Server-side config (data dir, Redis, slicer sidecar) is read from environment variables at startup.
        Edit <code>.env</code> or <code>docker-compose.yml</code> + restart to change.
      </div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{title}</h2>
        {action}
      </div>
      <div className="bg-gray-800 border border-gray-700 rounded-lg divide-y divide-gray-700/50">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="text-xs text-gray-200 text-right">{value}</span>
    </div>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] ${ok ? 'bg-emerald-900/40 text-emerald-300' : 'bg-red-900/40 text-red-300'}`}>
      {label}
    </span>
  );
}

// MakerWorld login + token — moved here from the slicer SettingsPanel since
// it's an app-level integration, not a per-slice setting.
function MakerWorldSection() {
  const [hint, setHint] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState<'totp' | 'email' | null>(() => {
    try {
      const saved = localStorage.getItem('snorcal_login_pending');
      return saved === 'totp' || saved === 'email' ? saved : null;
    } catch { return null; }
  });
  const [expanded, setExpanded] = useState(() => localStorage.getItem('snorcal_login_pending') !== null);

  useEffect(() => { api.getCloudTokenHint().then(setHint); }, []);
  useEffect(() => {
    if (!email) {
      try {
        const saved = localStorage.getItem('snorcal_login_email');
        if (saved) setEmail(saved);
      } catch { /* ignore */ }
    }
  }, []);
  useEffect(() => {
    try {
      if (needsCode && email) {
        localStorage.setItem('snorcal_login_pending', needsCode);
        localStorage.setItem('snorcal_login_email', email);
      } else {
        localStorage.removeItem('snorcal_login_pending');
        localStorage.removeItem('snorcal_login_email');
      }
    } catch { /* ignore */ }
  }, [needsCode, email]);

  const handleLogin = async () => {
    if (!email.trim()) return;
    if (!needsCode && !password) return;
    if (needsCode && !code.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const result = await api.bambuLogin(
        email.trim(),
        needsCode ? undefined : password,
        needsCode ? code.trim() : undefined,
      );
      if (result.success) {
        setHint(await api.getCloudTokenHint());
        setMsg('Logged in');
        setPassword(''); setCode(''); setNeedsCode(null);
      } else if (result.needsTfa) {
        setNeedsCode('totp');
        setMsg(result.message ?? 'Enter TOTP code');
      } else if (result.needsEmailCode) {
        setNeedsCode('email');
        setMsg(result.message ?? 'Enter email code');
      } else {
        setMsg(result.message ?? 'Login failed');
      }
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="MakerWorld"
      action={
        <button
          onClick={() => setExpanded(s => !s)}
          className="px-2 py-0.5 text-xs text-gray-500 hover:text-gray-300"
        >
          {expanded ? '−' : '+'}
        </button>
      }
    >
      {expanded ? (
        <div className="px-3 py-3 space-y-2">
          {hint && (
            <div className="text-[10px] text-gray-500">
              Current token: <span className="font-mono">{hint}</span>
            </div>
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Bambu account email"
            autoComplete="email"
            disabled={busy}
            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
          />
          {!needsCode && (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              placeholder="Password"
              autoComplete="current-password"
              disabled={busy}
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
            />
          )}
          {needsCode && (
            <>
              <div className="text-[10px] text-gray-400">
                {needsCode === 'totp' ? 'Enter code from authenticator app' : 'Enter code sent to email'}
              </div>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                placeholder="6-digit code"
                autoComplete="one-time-code"
                disabled={busy}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
              />
            </>
          )}
          <button
            onClick={handleLogin}
            disabled={busy || !email.trim() || (!needsCode && !password) || (!!needsCode && !code.trim())}
            className="w-full py-1 rounded text-xs bg-gray-600 hover:bg-gray-500 disabled:opacity-50 text-white"
          >
            {busy ? 'Logging in…' : needsCode ? 'Verify code' : 'Log in'}
          </button>
          {msg && <div className="text-[10px] text-gray-400">{msg}</div>}
          <div className="text-[10px] text-gray-500">
            Token auto-saved on success. Required for MakerWorld 3MF downloads (metadata fetches are anonymous).
          </div>
        </div>
      ) : (
        <div className="px-3 py-2 text-xs text-gray-400">
          {hint ? `Token set (${hint})` : 'Not logged in'}
        </div>
      )}
    </Section>
  );
}
