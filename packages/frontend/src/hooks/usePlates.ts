import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { ProjectModel } from '../lib/project-types';

export interface Plate {
  id: string;
  name: string;
}

interface UsePlatesArgs {
  /** Initial plates (from persistence). */
  initialPlates: Plate[];
  /** Initial active plate id (from persistence). */
  initialActivePlateId: string;
  projectModels: ProjectModel[];
  /** Tracked model setter (snapshots undo state before applying). */
  updateModels: (updater: ProjectModel[] | ((prev: ProjectModel[]) => ProjectModel[])) => void;
  /** Clear the model selection (indices no longer match after plate changes). */
  clearSelection: () => void;
  /** Allow the parent to observe active-plate changes (e.g. persistence). */
  onActivePlateChange?: (id: string) => void;
}

/**
 * Plate (tab) management: rename, duplicate (clones that plate's models with
 * fresh modelIds + relinked linkedTo), delete (with active fallback), and
 * reorder. Owns the plates array + activePlateId so callers don't thread the
 * state through.
 *
 * Extracted verbatim from App.tsx — same logic, no behavior change.
 */
export function usePlates({
  initialPlates, initialActivePlateId, projectModels, updateModels, clearSelection, onActivePlateChange,
}: UsePlatesArgs) {
  const [plates, setPlates] = useState<Plate[]>(initialPlates);
  const [activePlateId, setActivePlateIdState] = useState<string>(initialActivePlateId);

  // Accept either a plain id or a functional updater (matches the raw state
  // setter shape callers used before extraction). Fires onActivePlateChange
  // with the resolved id either way.
  const setActivePlateId = useCallback((idOrUpdater: string | ((prev: string) => string)) => {
    setActivePlateIdState(prev => {
      const next = typeof idOrUpdater === 'function' ? idOrUpdater(prev) : idOrUpdater;
      onActivePlateChange?.(next);
      return next;
    });
  }, [onActivePlateChange]);

  const handleRenamePlate = useCallback((id: string, name: string) => {
    setPlates(prev => prev.map(p => p.id === id ? { ...p, name } : p));
  }, []);

  const handleDuplicatePlate = useCallback((id: string) => {
    const idx = plates.findIndex(p => p.id === id);
    if (idx < 0) return;
    const src = plates[idx];
    const newId = `plate-${Date.now()}`;
    const modelIdMap = new Map<string, string>();
    const clones: ProjectModel[] = projectModels
      .filter(m => m.plateId === id)
      .map(m => {
        const newMid = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        modelIdMap.set(m.modelId, newMid);
        return { ...m, modelId: newMid, plateId: newId, faceColors: m.faceColors ? new Uint8Array(m.faceColors) : null };
      });
    clones.forEach(c => {
      if (c.linkedTo) c.linkedTo = c.linkedTo.map(lid => modelIdMap.get(lid) ?? lid);
    });
    setPlates(prev => [
      ...prev.slice(0, idx + 1),
      { id: newId, name: `${src.name} copy` },
      ...prev.slice(idx + 1),
    ]);
    updateModels(pm => [...pm, ...clones]);
    setActivePlateId(newId);
    clearSelection();
  }, [plates, projectModels, updateModels, setActivePlateId, clearSelection]);

  const handleDeletePlate = useCallback((id: string) => {
    if (plates.length <= 1) return;
    const idx = plates.findIndex(p => p.id === id);
    if (idx < 0) return;
    setPlates(prev => prev.filter(p => p.id !== id));
    updateModels(pm => pm.filter(m => m.plateId !== id));
    if (activePlateId === id) {
      const fallbackIdx = Math.max(0, idx - 1);
      setActivePlateId(prev => {
        const next = plates.filter(p => p.id !== id);
        return next[Math.min(fallbackIdx, next.length - 1)]?.id ?? prev;
      });
      clearSelection();
    }
  }, [plates, activePlateId, updateModels, setActivePlateId, clearSelection]);

  const handleReorderPlates = useCallback((fromIdx: number, toIdx: number) => {
    setPlates(prev => {
      if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= prev.length || toIdx >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);

  return {
    plates, setPlates,
    activePlateId, setActivePlateId,
    handleRenamePlate, handleDuplicatePlate, handleDeletePlate, handleReorderPlates,
  };
}
