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

export function AppSettingsPanel(props: {
  engine: string;
  onEngineChange: (engine: string) => void;
}) {
  const { engine, onEngineChange } = props;
  const [info, setInfo] = useState<api.SystemInfo | null>(null);
  const [sidecarTest, setSidecarTest] = useState<api.SidecarTestResult | null>(null);
  const [availableEngines, setAvailableEngines] = useState<string[] | null>(null);
  const [pathOverrides, setPathOverrides] = useState<Record<string, string>>({});
  const [pathDrafts, setPathDrafts] = useState<Record<string, string>>({});
  const [pathTests, setPathTests] = useState<Record<string, { testing?: boolean; result?: api.SlicerPathTestResult }>>({});
  const [pathSaving, setPathSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  // Per-engine import status. Keyed by engine id so each row tracks its own.
  const [importStates, setImportStates] = useState<
    Record<string, { status: 'running' | 'done' | 'error'; message: string }>
  >({});

  const ENGINE_LABELS: Record<string, string> = {
    orcaslicer: 'OrcaSlicer',
    bambustudio: 'BambuStudio',
    prusaslicer: 'PrusaSlicer',
  };

  const SLICER_INSTALL_URLS: Record<string, { label: string; url: string }> = {
    orcaslicer: { label: 'OrcaSlicer', url: 'https://github.com/SoftFever/OrcaSlicer/releases' },
    bambustudio: { label: 'BambuStudio', url: 'https://github.com/bambulab/BambuStudio/releases' },
    prusaslicer: { label: 'PrusaSlicer', url: 'https://www.prusa3d.com/page/prusaslicer_424/' },
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const [i, t, e, po] = await Promise.all([
        api.getSystemInfo(), api.testSidecar(), api.getAvailableEngines(), api.getSlicerPathOverrides(),
      ]);
      setInfo(i);
      setSidecarTest(t);
      setAvailableEngines(e);
      setPathOverrides(po);
      setPathDrafts({});
      setPathTests({});
    } catch (err) {
      console.error('Failed to load system info:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Auto-switch to an available engine if current pick isn't usable.
  useEffect(() => {
    if (!availableEngines || availableEngines.length === 0) return;
    if (!availableEngines.includes(engine)) {
      onEngineChange(availableEngines[0]);
    }
  }, [availableEngines, engine, onEngineChange]);

  const handleTest = async () => {
    setTesting(true);
    try { setSidecarTest(await api.testSidecar()); }
    finally { setTesting(false); }
  };

  // Test a draft binary path against the filesystem (backend validation).
  const handleTestPath = async (eng: string, draft: string) => {
    setPathTests(s => ({ ...s, [eng]: { testing: true } }));
    try {
      const result = await api.testSlicerPath(eng, draft);
      setPathTests(s => ({ ...s, [eng]: { result } }));
    } catch (e) {
      setPathTests(s => ({ ...s, [eng]: { result: { exists: false, executable: false, error: e instanceof Error ? e.message : String(e) } } }));
    }
  };

  // Persist one engine's override (or clear it when draft empty).
  const handleSavePath = async (eng: string, draft: string) => {
    setPathSaving(eng);
    try {
      const next = { ...pathOverrides };
      if (draft.trim()) next[eng] = draft.trim();
      else delete next[eng];
      await api.setSlicerPathOverrides(next);
      const [i, e] = await Promise.all([api.getSystemInfo(), api.getAvailableEngines()]);
      setInfo(i);
      setAvailableEngines(e);
      setPathOverrides(next);
      setPathDrafts(s => { const n = { ...s }; delete n[eng]; return n; });
      setPathTests(s => { const n = { ...s }; delete n[eng]; return n; });
    } catch (e) {
      console.error('Failed to save slicer path override:', e);
    } finally {
      setPathSaving(null);
    }
  };

  // Clear one engine's override + refresh state.
  const handleResetPath = async (eng: string) => {
    setPathSaving(eng);
    try {
      const next = { ...pathOverrides };
      delete next[eng];
      await api.setSlicerPathOverrides(next);
      const [i, e] = await Promise.all([api.getSystemInfo(), api.getAvailableEngines()]);
      setInfo(i);
      setAvailableEngines(e);
      setPathOverrides(next);
      setPathDrafts(s => { const n = { ...s }; delete n[eng]; return n; });
      setPathTests(s => { const n = { ...s }; delete n[eng]; return n; });
    } catch (e) {
      console.error('Failed to reset slicer path override:', e);
    } finally {
      setPathSaving(null);
    }
  };

  // Bulk-import every bundled preset from the locally-installed slicer.
  // Confirm first — overwrites any same-named existing profiles in snorcal's DB.
  const handleImportLocal = async (eng: string, label: string) => {
    const ok = window.confirm(
      `Import all machine / process / filament profiles from local ${label} into snorcal?\n` +
      `Same-named existing profiles will be overwritten.`,
    );
    if (!ok) return;
    setImportStates(s => ({ ...s, [eng]: { status: 'running', message: 'Scanning slicer profile dir…' } }));
    try {
      const res = await api.importLocalProfiles(eng);
      const i = res.imported;
      const parts = [
        i.machine ? `${i.machine} machine` : null,
        i.process ? `${i.process} process` : null,
        i.filament ? `${i.filament} filament` : null,
      ].filter(Boolean);
      const summary = parts.length
        ? `Imported ${parts.join(', ')} (${res.scanned} scanned, ${res.skippedCount} skipped, ${res.errorCount} errors).`
        : `No profiles imported (${res.scanned} scanned, ${res.skippedCount} skipped, ${res.errorCount} errors).`;
      setImportStates(s => ({ ...s, [eng]: { status: res.errorCount > 0 ? 'error' : 'done', message: summary } }));
    } catch (e) {
      setImportStates(s => ({ ...s, [eng]: {
        status: 'error',
        message: `Import failed: ${e instanceof Error ? e.message : String(e)}`,
      } }));
    }
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

      {/* Cleanup (bulk purge) */}
      <CleanupSection
        modelsSize={info.storage.modelsSize}
        jobsSize={info.storage.jobsSize}
        modelCount={info.counts.models}
        jobCount={info.counts.jobs}
        onPurged={() => refresh()}
      />

      {/* Version + updates */}
      <VersionSection info={info} onRestarted={() => refresh()} />

      {/* Slicer engine + sidecars */}
      <Section
        title="Slicer"
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
        <div className="px-3 py-2">
          <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Engine</label>
          {availableEngines && availableEngines.length === 0 ? (
            <div className="space-y-2">
              <div className="text-xs text-amber-400">No slicers detected.</div>
              <div className="text-[11px] text-gray-400">
                Install one of:
                <span className="ml-1 flex flex-wrap gap-x-3 gap-y-1 mt-1">
                  {Object.entries(SLICER_INSTALL_URLS)
                    .filter(([eng]) => !info.slicer.sidecars[eng]?.url)
                    .map(([eng, info]) => (
                      <a
                        key={eng}
                        href={info.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 underline"
                      >
                        {info.label} ↗
                      </a>
                    ))}
                </span>
              </div>
              <div className="text-[10px] text-gray-500">
                Or set a custom binary path per engine below. Sidecar URLs (<code>SLICER_URL_&lt;ENGINE&gt;</code>) work too.
              </div>
            </div>
          ) : (
            <select
              value={engine}
              onChange={(e) => onEngineChange(e.target.value)}
              disabled={!availableEngines}
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white disabled:opacity-50"
            >
              {Object.entries(ENGINE_LABELS)
                .filter(([value]) => !availableEngines || availableEngines.includes(value))
                .map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
            </select>
          )}
        </div>
        {Object.entries(info.slicer.sidecars).map(([eng, cfg]) => {
          const status = sidecarTest?.sidecars[eng];
          const label = ENGINE_LABELS[eng] ?? eng;
          const canImportLocal = !cfg.url && cfg.binaryExists;
          const importState = importStates[eng];
          const overrideActive = !!cfg.overridePath;
          const draft = pathDrafts[eng] ?? (overrideActive ? (cfg.overridePath ?? '') : '');
          const draftDirty = (pathDrafts[eng] ?? '') !== (cfg.overridePath ?? '');
          const showEditor = !cfg.url && (!cfg.binaryExists || overrideActive);
          const testInfo = pathTests[eng];
          return (
            <div key={eng} className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-gray-400">{label}</span>
                <span className="text-xs text-gray-200 text-right flex items-center gap-2 flex-wrap justify-end">
                  {cfg.url ? (
                    <>
                      <code className="text-gray-300 text-xs">{cfg.url}</code>
                      <StatusBadge ok={status?.status === 'ok'} label={status?.status ?? 'unset'} />
                    </>
                  ) : overrideActive && cfg.binaryExists ? (
                    <StatusBadge ok={true} label="custom path" />
                  ) : cfg.binaryExists ? (
                    <StatusBadge ok={true} label="local binary" />
                  ) : overrideActive ? (
                    <StatusBadge ok={false} label="custom: not found" />
                  ) : (
                    <StatusBadge ok={false} label="not found" />
                  )}
                  {canImportLocal && (
                    <button
                      onClick={() => handleImportLocal(eng, label)}
                      disabled={importState?.status === 'running'}
                      className="px-2 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50"
                    >
                      {importState?.status === 'running' ? 'Importing…' : 'Import profiles'}
                    </button>
                  )}
                </span>
              </div>

              {showEditor && (
                <div className="mt-2 space-y-1">
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={draft}
                      onChange={(e) => setPathDrafts(s => ({ ...s, [eng]: e.target.value }))}
                      placeholder={cfg.defaultPath || `/path/to/${eng}-binary`}
                      className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-0.5 text-[11px] text-white font-mono"
                      spellCheck={false}
                    />
                    <button
                      onClick={() => handleTestPath(eng, draft)}
                      disabled={!draft.trim() || testInfo?.testing}
                      className="px-2 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 rounded text-gray-300 disabled:opacity-50"
                    >
                      {testInfo?.testing ? '…' : 'Test'}
                    </button>
                    <button
                      onClick={() => handleSavePath(eng, draft)}
                      disabled={!draft.trim() || !draftDirty || pathSaving === eng}
                      className="px-2 py-0.5 text-[10px] bg-blue-700/40 hover:bg-blue-700/60 rounded text-blue-200 disabled:opacity-40"
                    >
                      {pathSaving === eng ? '…' : 'Save'}
                    </button>
                    {overrideActive && (
                      <button
                        onClick={() => handleResetPath(eng)}
                        disabled={pathSaving === eng}
                        className="px-2 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 rounded text-gray-400"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  {testInfo?.result && !testInfo.testing && (
                    <div className={`text-[10px] ${
                      testInfo.result.exists && testInfo.result.executable ? 'text-emerald-400'
                        : testInfo.result.exists ? 'text-amber-400'
                        : 'text-red-400'
                    }`}>
                      {testInfo.result.exists && testInfo.result.executable
                        ? '✓ file exists + executable'
                        : testInfo.result.exists
                          ? '⚠ exists but not executable'
                          : `✗ ${testInfo.result.error ?? 'file does not exist'}`}
                    </div>
                  )}
                </div>
              )}

              {importState?.message && (
                <div className={`mt-1 text-[10px] ${importState.status === 'error' ? 'text-red-400' : 'text-gray-400'}`}>
                  {importState.message}
                </div>
              )}
            </div>
          );
        })}
      </Section>

      {/* Queue / sidecar */}
      <Section
        title="Queue"
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

// Version display + self-update UI. Shows current version + git SHA, fetches
// latest tag from GitHub on demand, and (for bare-metal installs) runs the
// update flow (git pull + pnpm install + build) then triggers a restart.
// Docker installs show a "use docker pull" hint instead of the update button.
function VersionSection(props: { info: api.SystemInfo; onRestarted: () => void }) {
  const { info, onRestarted } = props;
  const [checkResult, setCheckResult] = useState<api.CheckUpdateResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRestart, setPendingRestart] = useState(false);

  const version = info.version ?? '?';
  const sha = info.git?.sha ? info.git.sha.slice(0, 8) : null;
  const isDocker = info.installMode === 'docker';

  const handleCheck = async () => {
    setChecking(true); setError(null);
    try { setCheckResult(await api.checkUpdate()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  };

  const handleUpdate = async () => {
    setUpdating(true); setError(null);
    try {
      const res = await api.performUpdate();
      setPendingRestart(true);
      setCheckResult({ current: res.previousVersion, latest: `v${res.newVersion}`, hasUpdate: false });
      setError(`Updated to ${res.newVersion}. Restart required.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setUpdating(false); }
  };

  const handleRestart = async () => {
    setRestarting(true); setError(null);
    try {
      await api.restartBackend();
      // Poll health — backend will be down briefly during restart.
      const start = Date.now();
      let ok = false;
      while (Date.now() - start < 30_000) {
        try {
          const r = await fetch('/api/health', { cache: 'no-store' });
          if (r.ok) { ok = true; break; }
        } catch { /* still down */ }
        await new Promise(res => setTimeout(res, 1000));
      }
      if (ok) {
        setPendingRestart(false);
        setRestarting(false);
        onRestarted();
      } else {
        setError('Backend did not return within 30s. Check service logs.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRestarting(false);
    }
  };

  return (
    <Section title="Version">
      <Row
        label="Installed"
        value={
          <span className="text-xs text-gray-200">
            v{version}{sha && <span className="text-gray-500 font-mono"> ({sha})</span>}
            {info.git?.dirty && <span className="text-amber-400 ml-1">dirty</span>}
          </span>
        }
      />
      <Row
        label="Install mode"
        value={
          <span className="text-xs text-gray-400">
            {isDocker ? 'Docker container' : info.installMode === 'bare-metal' ? 'Bare-metal (git checkout)' : 'Unknown'}
          </span>
        }
      />
      {checkResult?.latest && (
        <Row
          label="Latest release"
          value={
            <span className="text-xs text-gray-200">
              {checkResult.latest}
              {checkResult.hasUpdate && <span className="text-emerald-400 ml-1">(update available)</span>}
            </span>
          }
        />
      )}

      {!isDocker ? (
        <div className="px-3 py-3 space-y-2">
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleCheck}
              disabled={checking || updating || restarting}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-200 disabled:opacity-50"
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
            {checkResult?.hasUpdate && (
              <button
                onClick={handleUpdate}
                disabled={updating || restarting}
                className="px-2 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 rounded text-white disabled:opacity-50"
              >
                {updating ? 'Updating…' : `Update to ${checkResult.latest}`}
              </button>
            )}
            {pendingRestart && (
              <button
                onClick={handleRestart}
                disabled={restarting}
                className="px-2 py-1 text-xs bg-blue-700 hover:bg-blue-600 rounded text-white disabled:opacity-50"
              >
                {restarting ? 'Restarting…' : 'Restart now'}
              </button>
            )}
          </div>
          {error && <div className="text-[10px] text-amber-400 break-all">{error}</div>}
          <div className="text-[10px] text-gray-500">
            Self-update runs <code>git fetch</code> + <code>git reset --hard &lt;tag&gt;</code> + <code>pnpm install</code> + <code>pnpm build</code>. Refuses if working tree is dirty.
          </div>
        </div>
      ) : (
        <div className="px-3 py-2 text-[10px] text-gray-500">
          Running in Docker — update via <code>docker pull</code> + restart container. Self-update disabled.
        </div>
      )}
    </Section>
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

// Bulk-purge old jobs + orphaned models. Two-step flow:
// 1. Pick mode + age threshold, hit Preview → backend returns counts + sample IDs.
// 2. Purge button (enabled only after a successful preview with non-zero counts)
//    fires window.confirm with the breakdown, then executes if user OKs.
// Mode/days changes clear preview so user can't stale-fire Purge after edits.
function CleanupSection(props: {
  modelsSize: number;
  jobsSize: number;
  modelCount: number;
  jobCount: number;
  onPurged: () => void;
}) {
  const { modelsSize, jobsSize, modelCount, jobCount, onPurged } = props;
  const [mode, setMode] = useState<api.CleanupMode>('completed_jobs');
  const [days, setDays] = useState(30);
  const [preview, setPreview] = useState<api.CleanupResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetPreview = () => setPreview(null);

  const handlePreview = async () => {
    setPreviewing(true);
    setError(null);
    try {
      const res = await api.cleanupStorage({ mode, olderThanDays: days, dryRun: true });
      setPreview(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const handlePurge = async () => {
    if (!preview) return;
    const total = preview.jobCount + preview.modelCount;
    if (total === 0) return;
    const msg = `Purging will delete ${preview.jobCount} job(s) + ${preview.modelCount} model(s) (~${formatBytes(preview.bytesReclaimable)}).\n\nThis cannot be undone. Proceed?`;
    if (!window.confirm(msg)) return;
    setPurging(true);
    setError(null);
    try {
      await api.cleanupStorage({ mode, olderThanDays: days, dryRun: false });
      setPreview(null);
      onPurged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPurging(false);
    }
  };

  const MODE_LABELS: Record<api.CleanupMode, string> = {
    completed_jobs: 'Completed / failed / cancelled jobs',
    all_jobs: 'All jobs (any status)',
    orphaned_models: 'Models with no recent slices',
    all: 'Everything (jobs + models)',
  };

  const purgeDisabled =
    !preview
    || preview.dryRun !== true
    || (preview.jobCount + preview.modelCount) === 0
    || purging;

  const isAllMode = mode === 'all';

  return (
    <Section title="Cleanup">
      <div className="px-3 py-3 space-y-2">
        <div className="text-[10px] text-gray-500">
          Reclaim disk by purging old slice outputs + orphaned models. Current usage: {formatBytes(modelsSize)} models / {formatBytes(jobsSize)} jobs.
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={mode}
            onChange={(e) => { setMode(e.target.value as api.CleanupMode); resetPreview(); }}
            disabled={previewing || purging}
            className={`bg-gray-700 border rounded px-2 py-1 text-xs ${isAllMode ? 'border-red-700/60 text-red-300' : 'border-gray-600 text-white'}`}
          >
            {(Object.entries(MODE_LABELS) as [api.CleanupMode, string][]).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <label className="text-xs text-gray-400 flex items-center gap-1">
            Older than
            <input
              type="number"
              min={0}
              value={days}
              onChange={(e) => { setDays(Math.max(0, parseInt(e.target.value) || 0)); resetPreview(); }}
              disabled={previewing || purging}
              className="w-16 bg-gray-700 border border-gray-600 rounded px-1 py-0.5 text-xs text-white"
            />
            days
          </label>
        </div>
        {days === 0 && (
          <div className="text-[10px] text-gray-500">Age filter off — matches everything in scope.</div>
        )}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handlePreview}
            disabled={previewing || purging}
            className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-200 disabled:opacity-50"
          >
            {previewing ? 'Previewing…' : 'Preview'}
          </button>
          <button
            onClick={handlePurge}
            disabled={purgeDisabled}
            className={`px-2 py-1 text-xs rounded disabled:opacity-40 ${
              isAllMode
                ? 'bg-red-700/50 hover:bg-red-700/70 text-red-100'
                : 'bg-red-700/30 hover:bg-red-700/50 text-red-200'
            }`}
          >
            {purging ? 'Purging…' : 'Purge'}
          </button>
        </div>
        {preview && (
          <div className="text-[11px] text-gray-300 space-y-1">
            <div>
              <span className="font-semibold">{formatBytes(preview.bytesReclaimable)}</span> reclaimable —{' '}
              <span className="text-gray-400">{preview.jobCount} job(s)</span>,{' '}
              <span className="text-gray-400">{preview.modelCount} model(s)</span>
            </div>
            {(preview.jobIds.length > 0 || preview.modelIds.length > 0) && (
              <div className="text-[10px] text-gray-500 font-mono break-all">
                {preview.jobIds.length > 0 && <div>jobs: {preview.jobIds.slice(0, 8).join(', ')}{preview.jobCount > 8 ? ` …(+${preview.jobCount - 8})` : ''}</div>}
                {preview.modelIds.length > 0 && <div>models: {preview.modelIds.slice(0, 8).join(', ')}{preview.modelCount > 8 ? ` …(+${preview.modelCount - 8})` : ''}</div>}
              </div>
            )}
            {preview.jobCount + preview.modelCount === 0 && (
              <div className="text-[10px] text-gray-500">Nothing matches this filter.</div>
            )}
          </div>
        )}
        {error && <div className="text-[10px] text-red-400 break-all">{error}</div>}
      </div>
    </Section>
  );
}
