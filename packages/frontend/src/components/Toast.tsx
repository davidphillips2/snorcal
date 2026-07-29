import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional detail line (smaller, muted). */
  detail?: string;
  /** Auto-dismiss after N ms. 0 = sticky (manual close only). Default 5000. */
  duration?: number;
}

interface ToastApi {
  toast: (kind: ToastKind, message: string, detail?: string, duration?: number) => void;
  success: (message: string, detail?: string) => void;
  error: (message: string, detail?: string) => void;
  info: (message: string, detail?: string) => void;
  warning: (message: string, detail?: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const toast = useCallback((kind: ToastKind, message: string, detail?: string, duration: number = 5000) => {
    const id = nextId++;
    setToasts(prev => [...prev, { id, kind, message, detail, duration }]);
    if (duration > 0) {
      const timer = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, timer);
    }
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    toast,
    success: (m, d) => toast('success', m, d),
    error: (m, d) => toast('error', m, d, 8000),
    info: (m, d) => toast('info', m, d),
    warning: (m, d) => toast('warning', m, d, 6000),
    dismiss,
  }), [toast, dismiss]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const KIND_STYLES: Record<ToastKind, { bar: string; icon: string; iconBg: string }> = {
  success: { bar: 'bg-emerald-500', icon: '✓', iconBg: 'bg-emerald-500/20 text-emerald-300' },
  error: { bar: 'bg-red-500', icon: '✕', iconBg: 'bg-red-500/20 text-red-300' },
  warning: { bar: 'bg-amber-500', icon: '!', iconBg: 'bg-amber-500/20 text-amber-300' },
  info: { bar: 'bg-blue-500', icon: 'i', iconBg: 'bg-blue-500/20 text-blue-300' },
};

function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[min(92vw,360px)]"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map(t => {
        const s = KIND_STYLES[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === 'error' || t.kind === 'warning' ? 'alert' : 'status'}
            className="relative bg-gray-900 border border-gray-700 rounded-lg shadow-lg overflow-hidden flex animate-[slidein_0.15s_ease-out]"
          >
            <div className={`w-1 ${s.bar}`} />
            <div className="flex-1 flex items-start gap-2 p-3 min-w-0">
              <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${s.iconBg}`} aria-hidden="true">
                {s.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-100 break-words">{t.message}</div>
                {t.detail && <div className="text-xs text-gray-400 mt-0.5 break-words">{t.detail}</div>}
              </div>
              <button
                onClick={() => onDismiss(t.id)}
                aria-label="Dismiss notification"
                className="flex-shrink-0 text-gray-500 hover:text-gray-200 text-lg leading-none -mt-0.5"
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
