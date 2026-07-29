import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  /** Accessible title (rendered in header + used as aria-label). */
  title: ReactNode;
  /** Optional subtitle rendered under the title. */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Footer actions row (e.g. Cancel / Save). Optional. */
  footer?: ReactNode;
  /** Max width class for the panel. Default: max-w-md. */
  widthClass?: string;
  /** Extra classes for the inner panel (padding, bg, border overrides). */
  panelClass?: string;
  /** Click outside to close. Default true. */
  closeOnBackdrop?: boolean;
  /** Close on Escape. Default true. */
  closeOnEscape?: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Shared modal primitive. Replaces the ~11 ad-hoc `fixed inset-0` overlays.
 *
 * Accessibility: role=dialog + aria-modal, focus trap (Tab cycles within),
 * Esc to close, focus restored to trigger on unmount, close button has
 * aria-label. Backdrop click closes by default.
 *
 * Styling: dark panel matching the existing Tailwind palette. Override
 * width/padding via widthClass/panelClass for the few variants.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  widthClass = 'max-w-md',
  panelClass = 'bg-gray-800 border border-gray-700 rounded-lg p-5 space-y-4',
  closeOnBackdrop = true,
  closeOnEscape = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Focus the panel (or first focusable) on mount so screen readers land
    // inside the dialog and keyboard users don't Tab out into the page behind.
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    // Capture so this fires before any inner keydown handlers that might
    // also act on Escape (e.g. MeasureTool, PlateTabs).
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closeOnEscape, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) { e.preventDefault(); panel.focus(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // aria-labelledby needs an id; derive a stable one from the title text if
  // it's a string, else generate one.
  const titleId = typeof title === 'string'
    ? `modal-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`
    : undefined;

  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : (typeof title === 'string' ? title : undefined)}
        className={`w-full ${widthClass} ${panelClass} outline-none`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-white truncate">{title}</h2>
            {subtitle && <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="text-gray-400 hover:text-white text-xl leading-none -mt-0.5 shrink-0"
          >
            ×
          </button>
        </div>
        {children}
        {footer && <div className="flex justify-end gap-2 pt-1">{footer}</div>}
      </div>
    </div>
  );
}
