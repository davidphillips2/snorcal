import { useCallback } from 'react';
import * as THREE from 'three';
import { autoOrient, type Rotation3D } from '../components/Viewer/STLViewer';
import { type ProjectModel, makeUid } from '../lib/project-types';

interface UseModelTransformsArgs {
  activeModelIndex: number | null;
  activeModel: ProjectModel | null;
  activeMesh: THREE.Mesh | null;
  projectModels: ProjectModel[];
  selectedIndices: Set<number>;
  /** Map of uid → mesh. Needed for auto-orient (reads geometry) and
   *  position drag (reads userData.restPosition). */
  meshRefs: React.MutableRefObject<Record<string, THREE.Mesh | null>>;
  /** Tracked model setter (snapshots undo state before applying). */
  updateModels: (updater: ProjectModel[] | ((prev: ProjectModel[]) => ProjectModel[])) => void;
  setSelectedIndices: (next: Set<number>) => void;
  selectSingle: (idx: number | null) => void;
  /** Exit the current tool mode (e.g. back to orbit after lay-on-face). */
  exitToolMode: () => void;
}

/**
 * Model transform operations: rotate/orient/lay/position, patch setters
 * (active + all-selected), reset-origin, visibility, duplicate (+to-plate),
 * move-to-plate, and linear/circular arrays.
 *
 * Extracted verbatim from App.tsx — same logic, no behavior change. Each
 * handler reads the live state it needs from the args (closure-captured by
 * useCallback deps) so callers must keep this hook rendered while the
 * workspace is active.
 */
export function useModelTransforms({
  activeModelIndex, activeModel, activeMesh, projectModels, selectedIndices,
  meshRefs, updateModels, setSelectedIndices, selectSingle, exitToolMode,
}: UseModelTransformsArgs) {
  const handleAutoOrient = useCallback(() => {
    if (!activeMesh || activeModelIndex == null) return;
    const newRotation = autoOrient(activeMesh.geometry);
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, rotation: newRotation } : p));
  }, [activeMesh, activeModelIndex, updateModels]);

  const handleLayOnFace = useCallback((newRotation: Rotation3D) => {
    if (activeModelIndex == null) return;
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, rotation: newRotation } : p));
    exitToolMode();
  }, [activeModelIndex, updateModels, exitToolMode]);

  const handleRotationChange = useCallback((rotation: Rotation3D) => {
    if (activeModelIndex == null) return;
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, rotation } : p));
  }, [activeModelIndex, updateModels]);

  const handlePositionChange = useCallback((pos: THREE.Vector3) => {
    if (activeModelIndex == null) return;
    const pm = projectModels[activeModelIndex];
    if (!pm) return;
    const mesh = meshRefs.current[pm.uid];
    const rest = mesh?.userData?.restPosition as { x: number; y: number; z: number } | undefined;
    if (!rest) return;
    // pos is absolute mesh position; subtract rest (centering offset) to get pure user offset
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? {
      ...p,
      positionOffset: { x: pos.x - rest.x, y: pos.y - rest.y, z: pos.z - rest.z }
    } : p));
  }, [activeModelIndex, projectModels, meshRefs, updateModels]);

  // --- Transform ops (mirror / scale / duplicate / array) ---

  const handleUpdateActiveModel = useCallback((patch: Partial<ProjectModel>) => {
    if (activeModelIndex == null) return;
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, ...patch } : p));
  }, [activeModelIndex, updateModels]);

  // Apply the same patch to every selected model (Phase 3 multi-aware panel).
  const handleUpdateAllSelected = useCallback((patch: Partial<ProjectModel>) => {
    if (selectedIndices.size === 0) return;
    updateModels(prev => prev.map((p, i) => selectedIndices.has(i) ? { ...p, ...patch } : p));
  }, [selectedIndices, updateModels]);

  // Reset every selected model's rotation/positionOffset to identity (origin).
  const handleResetOrigin = useCallback(() => {
    if (selectedIndices.size === 0) return;
    updateModels(prev => prev.map((p, i) => selectedIndices.has(i)
      ? { ...p, rotation: { x: 0, y: 0, z: 0 }, positionOffset: { x: 0, y: 0, z: 0 } }
      : p));
  }, [selectedIndices, updateModels]);

  const handleToggleVisible = useCallback((idx: number) => {
    updateModels(prev => prev.map((p, i) => i === idx ? { ...p, visible: !p.visible } : p));
  }, [updateModels]);

  const handleDuplicateAt = useCallback((idx: number) => {
    const src = projectModels[idx];
    if (!src) return;
    const dup: ProjectModel = {
      ...src,
      uid: makeUid(),
      positionOffset: {
        x: src.positionOffset.x + 20,
        y: src.positionOffset.y,
        z: src.positionOffset.z,
      },
    };
    updateModels(prev => [...prev, dup]);
  }, [projectModels, updateModels]);

  const handleDuplicate = useCallback(() => {
    if (activeModelIndex == null) return;
    handleDuplicateAt(activeModelIndex);
    // After dup, the clone is appended at the end — switch selection to it.
    setSelectedIndices(new Set([projectModels.length]));
  }, [activeModelIndex, handleDuplicateAt, projectModels.length, setSelectedIndices]);

  // Cross-plate ops (Phase 4). Move = change plateId in place. Duplicate-to
  // creates a clone on the target plate (offset to plate origin) and selects it.
  const handleMoveToPlate = useCallback((globalIdx: number, plateId: string) => {
    updateModels(prev => prev.map((p, i) => i === globalIdx
      ? { ...p, plateId, positionOffset: { x: 0, y: 0, z: 0 } }
      : p));
    selectSingle(globalIdx);
  }, [updateModels, selectSingle]);

  const handleDuplicateToPlate = useCallback((globalIdx: number, plateId: string) => {
    const src = projectModels[globalIdx];
    if (!src) return;
    const dup: ProjectModel = {
      ...src,
      uid: makeUid(),
      plateId,
      positionOffset: { x: 0, y: 0, z: 0 },
    };
    updateModels(prev => [...prev, dup]);
    setSelectedIndices(new Set([projectModels.length]));
  }, [projectModels, updateModels, setSelectedIndices]);

  const handleLinearArray = useCallback((count: number, dx: number, dy: number) => {
    if (!activeModel || count < 2) return;
    const copies: ProjectModel[] = [];
    for (let i = 1; i < count; i++) {
      copies.push({
        ...activeModel,
        uid: makeUid(),
        positionOffset: {
          x: activeModel.positionOffset.x + dx * i,
          y: activeModel.positionOffset.y,
          z: activeModel.positionOffset.z + dy * i,  // Three.js Z = bed Y
        },
      });
    }
    updateModels(prev => [...prev, ...copies]);
  }, [activeModel, updateModels]);

  const handleCircularArray = useCallback((count: number, radius: number) => {
    if (!activeModel || count < 2) return;
    const copies: ProjectModel[] = [];
    const cx = activeModel.positionOffset.x;
    const cz = activeModel.positionOffset.z;
    for (let i = 1; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      copies.push({
        ...activeModel,
        uid: makeUid(),
        positionOffset: {
          x: cx + Math.cos(angle) * radius,
          y: activeModel.positionOffset.y,
          z: cz + Math.sin(angle) * radius,
        },
        rotation: {
          x: activeModel.rotation.x,
          y: activeModel.rotation.y,
          z: activeModel.rotation.z + (angle * 180 / Math.PI),
        },
      });
    }
    updateModels(prev => [...prev, ...copies]);
  }, [activeModel, updateModels]);

  return {
    handleAutoOrient, handleLayOnFace, handleRotationChange, handlePositionChange,
    handleUpdateActiveModel, handleUpdateAllSelected, handleResetOrigin,
    handleToggleVisible, handleDuplicateAt, handleDuplicate,
    handleMoveToPlate, handleDuplicateToPlate,
    handleLinearArray, handleCircularArray,
  };
}
