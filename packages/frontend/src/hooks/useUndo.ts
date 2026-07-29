import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ProjectModel } from '../lib/project-types';

interface UseUndoArgs {
  projectModels: ProjectModel[];
  setProjectModels: Dispatch<SetStateAction<ProjectModel[]>>;
  /** Clear the selection on undo/redo (the indices no longer match). */
  clearSelection: () => void;
  /** Max snapshots kept in the undo stack. Default 50. */
  limit?: number;
}

/**
 * Undo/redo for the project-models array, with a tracked setter
 * (`updateModels`) that auto-snapshots before each mutation.
 *
 * Paint-undo (FacePainter) takes precedence via the global
 * `window.__snorcal_undo` bridge — if a paint action is the most recent, it
 * undoes that first, then falls through to project-models undo. canUndo
 * accounts for both so the toolbar button enables correctly.
 *
 * Extracted verbatim from App.tsx — same stack logic, no behavior change.
 */
export function useUndo({ projectModels, setProjectModels, clearSelection, limit = 50 }: UseUndoArgs) {
  const undoStackRef = useRef<ProjectModel[][]>([]);
  const redoStackRef = useRef<ProjectModel[][]>([]);
  const projectModelsRef = useRef(projectModels);
  projectModelsRef.current = projectModels;
  const [, forceUndoTick] = useState(0);

  const pushUndo = useCallback(() => {
    undoStackRef.current.push(projectModelsRef.current.map(p => ({ ...p })));
    if (undoStackRef.current.length > limit) undoStackRef.current.shift();
    redoStackRef.current = [];
    forceUndoTick(t => t + 1);
  }, [limit]);

  // Tracked setter — snapshots current state before applying updater.
  const updateModels = useCallback((updater: ProjectModel[] | ((prev: ProjectModel[]) => ProjectModel[])) => {
    pushUndo();
    setProjectModels(updater);
  }, [pushUndo, setProjectModels]);

  const handleUndo = useCallback(() => {
    // Paint undo takes precedence (most recent action); fall back to project-models
    const paintUndo = (window as any).__snorcal_undo as (() => boolean) | undefined;
    if (paintUndo && paintUndo()) return;
    if (undoStackRef.current.length > 0) {
      const present = projectModelsRef.current.map(p => ({ ...p }));
      const past = undoStackRef.current.pop()!;
      redoStackRef.current.push(present);
      setProjectModels(past);
      clearSelection();
      forceUndoTick(t => t + 1);
      return;
    }
  }, [setProjectModels, clearSelection]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const present = projectModelsRef.current.map(p => ({ ...p }));
    const future = redoStackRef.current.pop()!;
    undoStackRef.current.push(present);
    setProjectModels(future);
    clearSelection();
    forceUndoTick(t => t + 1);
  }, [setProjectModels, clearSelection]);

  const canUndo = undoStackRef.current.length > 0
    || ((window as any).__snorcal_paint_undo_count ?? 0) > 0;
  const canRedo = redoStackRef.current.length > 0;

  return { pushUndo, updateModels, handleUndo, handleRedo, canUndo, canRedo };
}
