import { PRINTERS } from '../config/printers';

interface PrinterSelectProps {
  onSelect: (printerId: string) => void;
}

export function PrinterSelect({ onSelect }: PrinterSelectProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900">
      <div className="max-w-lg w-full mx-4 text-center">
        <img src="/icon-512.png" alt="" className="w-20 h-20 mx-auto mb-3" />
        <h1 className="text-3xl font-bold mb-2">Snorcal</h1>
        <p className="text-gray-400 mb-8">Select your printer to get started</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {PRINTERS.map((printer) => (
            <button
              key={printer.id}
              onClick={() => onSelect(printer.id)}
              className="bg-gray-800 border-2 border-gray-700 hover:border-blue-500 rounded-xl p-6 text-left transition group"
            >
              <div className="text-lg font-semibold text-white group-hover:text-blue-400 transition">
                {printer.name}
              </div>
              <div className="text-sm text-gray-400 mt-1">{printer.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
