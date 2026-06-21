import { useEffect, useState } from 'react';
import {
  resolveMakerworld,
  importMakerworld,
  makerworldThumbnailUrl,
  getCloudTokenHint,
  type ResolvedMakerworld,
} from '../../api/client';

interface MakerworldImportModalProps {
  onImported: (model: { modelId: string; name: string; plateCount: number }) => void;
  onClose: () => void;
}

type State =
  | { kind: 'empty' }
  | { kind: 'resolving' }
  | { kind: 'resolved'; data: ResolvedMakerworld }
  | { kind: 'importing'; profileId: string }
  | { kind: 'error'; message: string };

export function MakerworldImportModal({ onImported, onClose }: MakerworldImportModalProps) {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<State>({ kind: 'empty' });
  const [tokenHint, setTokenHint] = useState<string | null>(null);

  useEffect(() => {
    getCloudTokenHint().then(setTokenHint);
  }, []);

  const handleResolve = async () => {
    if (!url.trim()) return;
    setState({ kind: 'resolving' });
    try {
      const data = await resolveMakerworld(url.trim());
      setState({ kind: 'resolved', data });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleImport = async (profileId: string, name: string) => {
    if (state.kind !== 'resolved') return;
    const data = state.data;
    setState({ kind: 'importing', profileId });
    try {
      const result = await importMakerworld({
        numericId: data.numericId,
        alphanumericId: data.alphanumericId,
        profileId,
        name,
      });
      onImported({ modelId: result.modelId, name: result.name, plateCount: result.plateCount });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const importingProfileId = state.kind === 'importing' ? state.profileId : null;

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-gray-800 rounded-lg shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden border border-gray-700 flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-white font-medium">Import from MakerWorld</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {tokenHint === null && (
            <div className="mb-3 text-xs bg-yellow-900/30 border border-yellow-700/40 text-yellow-200 rounded px-3 py-2">
              No Bambu cloud token set — metadata resolves but downloads require a token (Settings → MakerWorld).
            </div>
          )}

          {/* URL input + resolve */}
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleResolve()}
              placeholder="https://makerworld.com/models/..."
              disabled={state.kind === 'resolving' || state.kind === 'importing'}
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-500"
            />
            <button
              onClick={handleResolve}
              disabled={!url.trim() || state.kind === 'resolving' || state.kind === 'importing'}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 disabled:opacity-50 text-white text-sm rounded"
            >
              {state.kind === 'resolving' ? 'Resolving…' : 'Resolve'}
            </button>
          </div>

          {state.kind === 'error' && (
            <div className="mb-3 text-xs bg-red-900/30 border border-red-700/40 text-red-200 rounded px-3 py-2">
              {state.message}
            </div>
          )}

          {/* Resolved model card */}
          {state.kind === 'resolved' && (
            <div className="space-y-4">
              <div className="flex gap-3 bg-gray-750 rounded p-3 border border-gray-700">
                {state.data.coverUrl && (
                  <img
                    src={makerworldThumbnailUrl(state.data.coverUrl)}
                    alt=""
                    className="w-24 h-24 object-cover rounded border border-gray-700"
                    onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="text-white font-medium text-sm truncate">{state.data.title}</h3>
                  {state.data.creator && <p className="text-gray-400 text-xs">by {state.data.creator}</p>}
                  {state.data.summary && (
                    <p className="text-gray-500 text-xs mt-1 line-clamp-3">{state.data.summary}</p>
                  )}
                </div>
              </div>

              <div>
                <div className="text-xs text-gray-400 mb-2">Plates ({state.data.instances.length})</div>
                <div className="grid grid-cols-2 gap-2">
                  {state.data.instances.map(inst => (
                    <InstanceCard
                      key={inst.profileId}
                      instance={inst}
                      highlight={inst.profileId === state.data.profileId}
                      importing={importingProfileId === inst.profileId}
                      disabled={importingProfileId !== null}
                      onImport={() => handleImport(inst.profileId, inst.name)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {state.kind === 'importing' && (
            <div className="text-center py-8 text-sm text-gray-400">
              Downloading + registering 3MF…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InstanceCard({
  instance,
  highlight,
  importing,
  disabled,
  onImport,
}: {
  instance: { profileId: string; name: string; coverUrl: string; thumbUrl: string };
  highlight: boolean;
  importing: boolean;
  disabled: boolean;
  onImport: () => void;
}) {
  return (
    <div className={`bg-gray-750 rounded p-2 border ${highlight ? 'border-blue-600' : 'border-gray-700'} flex flex-col`}>
      {instance.thumbUrl && (
        <img
          src={makerworldThumbnailUrl(instance.thumbUrl)}
          alt=""
          className="w-full h-24 object-cover rounded mb-2 border border-gray-700"
          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
        />
      )}
      <div className="text-xs text-white truncate mb-2" title={instance.name}>{instance.name}</div>
      <button
        onClick={onImport}
        disabled={disabled}
        className="mt-auto w-full py-1 bg-gray-600 hover:bg-gray-500 disabled:opacity-50 text-white text-xs rounded"
      >
        {importing ? 'Importing…' : 'Import'}
      </button>
    </div>
  );
}
