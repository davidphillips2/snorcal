import { useEffect, useState, type ReactNode } from 'react';
import * as api from '../../api/client';

interface Props {
  children: ReactNode;
}

type Gate =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'login' }
  | { kind: 'ready' };

/**
 * Top-level gate. Renders setup / login screens until authenticated, then the
 * app. Polls /auth/status once on mount; subsequent 401s from apiFetch invoke
 * the unauthorized handler (set below) and flip back to the login screen.
 */
export function AuthGate({ children }: Props) {
  const [gate, setGate] = useState<Gate>({ kind: 'loading' });

  const refresh = async () => {
    try {
      const st = await api.getAuthStatus();
      if (st.disabled || st.authenticated) setGate({ kind: 'ready' });
      else if (st.requiresSetup) setGate({ kind: 'setup' });
      else setGate({ kind: 'login' });
    } catch {
      // Backend unreachable — show login so the retry loop can keep trying.
      setGate({ kind: 'login' });
    }
  };

  useEffect(() => {
    refresh();
    // When apiFetch sees a 401, drop back to login.
    api.setUnauthorizedHandler(() => setGate({ kind: 'login' }));
    return () => api.setUnauthorizedHandler(() => {});
  }, []);

  if (gate.kind === 'loading') {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center text-gray-400">
        Loading…
      </div>
    );
  }
  if (gate.kind === 'setup') {
    return <SetupScreen onDone={() => setGate({ kind: 'ready' })} />;
  }
  if (gate.kind === 'login') {
    return <LoginScreen onDone={() => setGate({ kind: 'ready' })} />;
  }
  return <>{children}</>;
}

function LoginScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.login(password);
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="snorcal">
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-white"
        />
        {err && <div className="text-xs text-red-300 bg-red-900/40 border border-red-700 rounded px-2 py-1">{err}</div>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm text-white"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Shell>
  );
}

function SetupScreen({ onDone }: { onDone: () => void }) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw1.length < 6) { setErr('Password must be at least 6 characters'); return; }
    if (pw1 !== pw2) { setErr('Passwords do not match'); return; }
    setBusy(true); setErr(null);
    try {
      await api.setupPassword(pw1);
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="snorcal — set a password">
      <p className="text-xs text-gray-400 mb-3">
        Choose a password to protect this instance. It will be required each time you sign in.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          autoFocus
          value={pw1}
          onChange={(e) => setPw1(e.target.value)}
          placeholder="New password"
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-white"
        />
        <input
          type="password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          placeholder="Confirm password"
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-white"
        />
        {err && <div className="text-xs text-red-300 bg-red-900/40 border border-red-700 rounded px-2 py-1">{err}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm text-white"
        >
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-gray-800 border border-gray-700 rounded-lg p-5">
        <h1 className="text-lg font-semibold text-white mb-4">{title}</h1>
        {children}
      </div>
    </div>
  );
}
