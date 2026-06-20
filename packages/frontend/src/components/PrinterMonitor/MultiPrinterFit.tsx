interface PrinterEntry {
  id: string;
  name: string;
  model?: string | null;
  bedVolume?: { x: number; y: number; z: number } | null;
}

interface MultiPrinterFitProps {
  printers: PrinterEntry[];
  /** Combined bounds (mm) of all visible models on the active plate. */
  plateBounds: { x: number; y: number; z: number } | null;
  activePrinterId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Fit-check list: shows whether the active plate's combined model bounds
 * fit in each registered printer's bed volume. Highlights the active
 * printer. Lets user switch target printer from the list.
 */
export function MultiPrinterFit({ printers, plateBounds, activePrinterId, onSelect }: MultiPrinterFitProps) {
  if (printers.length === 0 || !plateBounds) return null;

  return (
    <div className="space-y-0.5">
      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">Fit on other printers</div>
      {printers.map(p => {
        const bed = p.bedVolume;
        const fits = bed ? (plateBounds.x <= bed.x && plateBounds.y <= bed.y && plateBounds.z <= bed.z) : null;
        const util = bed ? Math.min(1, (plateBounds.x * plateBounds.y) / (bed.x * bed.y)) : 0;
        const isActive = p.id === activePrinterId;
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={`w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition ${
              isActive ? 'bg-blue-600/20 text-blue-200 ring-1 ring-blue-600/30' : 'text-gray-300 hover:bg-gray-700/50'
            }`}
          >
            <span className={`shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-[10px] ${
              fits === null ? 'bg-gray-600 text-gray-300'
              : fits ? 'bg-emerald-600/30 text-emerald-300'
              : 'bg-red-600/30 text-red-300'
            }`}>
              {fits === null ? '?' : fits ? '✓' : '✗'}
            </span>
            <span className="flex-1 truncate text-left">
              {p.name}
              {p.model ? <span className="text-gray-500"> · {p.model}</span> : null}
            </span>
            <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
              {bed ? `${bed.x}×${bed.y}×${bed.z}` : '—'}
            </span>
            <span className="text-[10px] text-gray-400 tabular-nums w-8 text-right shrink-0">
              {bed ? `${Math.round(util * 100)}%` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}
