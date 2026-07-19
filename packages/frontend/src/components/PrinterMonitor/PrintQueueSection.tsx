import { useEffect, useState, useCallback } from 'react';
import type { PrinterRecord, PrinterStatus } from '@snorcal/shared';
import * as api from '../../api/client';
import type { PrintQueueItem } from '../../api/client';

interface Props {
  printer: PrinterRecord;
  printerStatus?: PrinterStatus;
}

export function PrintQueueSection({ printer, printerStatus }: Props) {
  const [items, setItems] = useState<PrintQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listPrintQueue(printer.id);
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [printer.id]);

  useEffect(() => { refresh(); }, [refresh]);

  const remove = async (itemId: string) => {
    try {
      await api.removeFromPrintQueue(printer.id, itemId);
      setItems(prev => prev.filter(i => i.id !== itemId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sendNow = async (item: PrintQueueItem) => {
    setSendingId(item.id);
    setError(null);
    try {
      // Reuse the existing /send flow (handles filament mapping + protocol).
      // No mapping passed — backend uses identity mapping (filament N → tray N).
      await api.sendToRegisteredPrinter(printer.id, item.jobId, true);
      // Sent — drop from queue.
      await api.removeFromPrintQueue(printer.id, item.id);
      setItems(prev => prev.filter(i => i.id !== item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSendingId(null);
    }
  };

  const printerBusy = printerStatus?.state === 'printing' || printerStatus?.state === 'paused';

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-white">Print queue</h3>
        <span className="text-[10px] text-gray-500">{items.length} item{items.length === 1 ? '' : 's'}</span>
      </div>

      {error && (
        <div className="text-[11px] text-red-400 mb-2">{error}</div>
      )}

      {loading ? (
        <div className="text-xs text-gray-500">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-gray-500">
          Empty. Add completed jobs from the slice view's job list ("Queue on {printer.name}").
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map(item => (
            <li key={item.id} className="bg-gray-900 border border-gray-700 rounded p-2 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-white truncate">{item.modelName ?? item.jobId}</div>
                <div className="text-[10px] text-gray-500">
                  {new Date(item.addedAt).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() => sendNow(item)}
                disabled={sendingId === item.id}
                title={printerBusy ? 'Printer busy — finish or cancel current print first' : 'Upload + start print'}
                className={`text-xs px-2 py-1 rounded whitespace-nowrap ${
                  printerBusy
                    ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 disabled:cursor-wait'
                }`}
              >
                {sendingId === item.id ? 'Sending…' : 'Send'}
              </button>
              <button
                onClick={() => remove(item.id)}
                title="Remove from queue"
                className="text-xs text-gray-500 hover:text-red-400 px-1"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}

      {printerBusy && items.length > 0 && (
        <div className="text-[10px] text-amber-400 mt-2">
          Printer busy. Clear plate + finish current print before sending next.
        </div>
      )}
    </div>
  );
}
