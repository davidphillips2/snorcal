import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { SceneRefs } from './Scene';
import type { ProjectModel } from '../../App';
import type { TransformMode, TransformSpace, SnapSettings } from '../../lib/transforms';

interface Props {
  sceneRefs: SceneRefs | null;
  /** Meshes for currently-selected models (filtered to active plate). */
  selectedMeshes: THREE.Mesh[];
  /** Corresponding ProjectModel entries (same length + order as selectedMeshes). */
  selectedModels: ProjectModel[];
  /** Global projectModels indices, parallel to selectedModels. */
  selectedGlobalIndices: number[];
  mode: TransformMode;
  space: TransformSpace;
  snap: SnapSettings;
  /** Fired once on drag end with patches to apply to each ProjectModel. */
  onTransformApplied: (patches: Array<{ idx: number; patch: Partial<ProjectModel> }>) => void;
}

/**
 * Three.js TransformControls gizmo. Attaches to the single active mesh, or to
 * a surrogate Object3D positioned at the selection center when multiple models
 * are selected. Multi-select gizmo supports translate only (rotate/scale on
 * surrogate would need pivot-around-center math that interacts awkwardly with
 * each model's per-mesh restPosition). For per-model rotate/scale the user
 * selects a single model.
 *
 * Snap settings feed TransformControls.translationSnap / rotationSnap.
 * OrbitControls is disabled while the user is dragging the gizmo.
 *
 * Mobile guard: caller skips rendering this component when isCoarsePointer().
 */
export function TransformGizmo({
  sceneRefs, selectedMeshes, selectedModels, selectedGlobalIndices, mode, space, snap, onTransformApplied,
}: Props) {
  const tcRef = useRef<TransformControls | null>(null);
  const surrogateRef = useRef<THREE.Object3D | null>(null);
  // Snapshot taken at drag-start, used to compute delta on drag-end.
  const snapshotRef = useRef<Array<{ idx: number; startPos: THREE.Vector3; meshStartPos: THREE.Vector3; meshStartRot: THREE.Euler; meshStartScale: THREE.Vector3 }> | null>(null);
  const surrogateStartRef = useRef<{ pos: THREE.Vector3; rot: THREE.Euler; scale: THREE.Vector3 } | null>(null);
  // Track whether React prop changes (mode/space/snap) are mid-drag — those
  // should not re-attach because that would lose the in-progress transform.
  const draggingRef = useRef(false);

  // Create TransformControls once when scene becomes available.
  useEffect(() => {
    if (!sceneRefs) return;
    const tc = new TransformControls(sceneRefs.camera, sceneRefs.renderer.domElement);
    tc.addEventListener('dragging-changed', (e: any) => {
      draggingRef.current = e.value;
      // Disable orbit while dragging so the gizmo owns pointer input.
      sceneRefs.controls.enabled = !e.value;
    });
    tc.addEventListener('objectChange', () => {
      // No-op — we read final state on drag-end via 'mouseUp' below.
    });
    // three's TransformControls emits mouseUp when a drag ends.
    tc.addEventListener('mouseUp', () => flushPatch());
    // three 0.170+: TransformControls extends Controls (not Object3D), so we
    // must add the helper Object3D to the scene, not the controls themselves.
    const helper = tc.getHelper();
    sceneRefs.scene.add(helper);
    tcRef.current = tc;

    return () => {
      try { sceneRefs.scene.remove(helper); } catch {}
      tc.dispose();
      tcRef.current = null;
    };
  }, [sceneRefs]);

  // Update mode / space / snap when props change.
  useEffect(() => {
    const tc = tcRef.current;
    if (!tc) return;
    tc.setMode(mode);
    tc.setSpace(space);
    tc.translationSnap = snap.enabled ? snap.translateMM : null;
    tc.rotationSnap = snap.enabled ? (snap.rotateDeg * Math.PI) / 180 : null;
  }, [mode, space, snap.enabled, snap.translateMM, snap.rotateDeg]);

  // Attach / detach based on selection. Re-runs whenever selection changes.
  useEffect(() => {
    const tc = tcRef.current;
    if (!tc || !sceneRefs) return;
    if (draggingRef.current) return; // don't disturb an in-progress drag

    // Clean up any prior surrogate
    if (surrogateRef.current) {
      sceneRefs.scene.remove(surrogateRef.current);
      surrogateRef.current = null;
    }

    if (selectedMeshes.length === 0) {
      tc.detach();
      return;
    }

    if (selectedMeshes.length === 1) {
      // Attach directly to the mesh. TransformControls mutates mesh.position/
      // rotation/scale during drag. On mouseUp we read final values.
      tc.attach(selectedMeshes[0]);
    } else {
      // Multi-select: surrogate Object3D at selection center.
      // Only translate supported in this mode (see component doc).
      const center = new THREE.Vector3();
      for (const m of selectedMeshes) {
        const box = new THREE.Box3().setFromObject(m);
        const c = new THREE.Vector3();
        box.getCenter(c);
        center.add(c);
      }
      center.divideScalar(selectedMeshes.length);
      const surrogate = new THREE.Object3D();
      surrogate.position.copy(center);
      sceneRefs.scene.add(surrogate);
      surrogateRef.current = surrogate;
      tc.attach(surrogate);
      // Force translate mode for multi-select regardless of `mode` prop.
      tc.setMode('translate');
    }
  }, [sceneRefs, selectedMeshes]);

  // If mode changes mid-multi-select, snap back to translate.
  useEffect(() => {
    const tc = tcRef.current;
    if (!tc) return;
    if (surrogateRef.current && mode !== 'translate') {
      tc.setMode('translate');
    }
  }, [mode, selectedMeshes.length]);

  const flushPatch = () => {
    const tc = tcRef.current;
    if (!tc) return;
    const snapshot = snapshotRef.current;
    const surStart = surrogateStartRef.current;
    if (!snapshot || (surrogateRef.current && !surStart)) {
      // Single-select path — no snapshot, just read live mesh transform.
      // Snapshot is taken at drag-start (mouseDown listener below).
    }

    if (surrogateRef.current && surStart && snapshot) {
      // Multi-select translate: delta added to each model's positionOffset.
      const delta = surrogateRef.current.position.clone().sub(surStart.pos);
      if (delta.lengthSq() < 1e-9) return;
      const patches = snapshot.map(s => ({
        idx: s.idx,
        patch: {
          positionOffset: {
            x: s.startPos.x + delta.x,
            y: s.startPos.y + delta.y,
            z: s.startPos.z + delta.z,
          },
        },
      }));
      onTransformApplied(patches);
      // Reposition surrogate back to selection center based on updated state.
      // (Caller's state update will re-run the attach effect, which will
      // recreate the surrogate at the new center.)
    } else if (snapshot && snapshot.length === 1) {
      // Single-select: read final mesh transform. Note STLViewer applies
      // transforms from props, so we mirror them back into ProjectModel.
      const s = snapshot[0];
      const mesh = selectedMeshes[0];
      if (!mesh) return;
      const patches = [{
        idx: s.idx,
        patch: {
          // mesh.rotation is in radians; ProjectModel.rotation is in degrees.
          rotation: {
            x: THREE.MathUtils.radToDeg(mesh.rotation.x),
            y: THREE.MathUtils.radToDeg(mesh.rotation.y),
            z: THREE.MathUtils.radToDeg(mesh.rotation.z),
          },
          // mesh.position is absolute scene coords; positionOffset is the
          // delta from restPosition. We compute it as
          // (mesh.position - mesh.userData.restPosition) projected onto axes.
          positionOffset: mesh.userData.restPosition
            ? {
                x: mesh.position.x - mesh.userData.restPosition.x,
                y: mesh.position.y - mesh.userData.restPosition.y,
                z: mesh.position.z - mesh.userData.restPosition.z,
              }
            : { x: s.startPos.x, y: s.startPos.y, z: s.startPos.z },
          // mesh.scale is signed (mirror = negative). Decompose back to abs
          // scale + mirror flags.
          scale: {
            x: Math.abs(mesh.scale.x),
            y: Math.abs(mesh.scale.y),
            z: Math.abs(mesh.scale.z),
          },
          mirror: {
            x: mesh.scale.x < 0,
            y: mesh.scale.y < 0,
            z: mesh.scale.z < 0,
          },
        } as Partial<ProjectModel>,
      }];
      onTransformApplied(patches);
    }

    snapshotRef.current = null;
    surrogateStartRef.current = null;
  };

  // Take snapshot on drag start. TransformControls emits mouseDown at drag start.
  useEffect(() => {
    const tc = tcRef.current;
    if (!tc) return;
    const onMouseDown = () => {
      snapshotRef.current = selectedModels.map((pm, i) => {
        const mesh = selectedMeshes[i];
        return {
          idx: selectedGlobalIndices[i] ?? -1,
          startPos: new THREE.Vector3(pm.positionOffset.x, pm.positionOffset.y, pm.positionOffset.z),
          meshStartPos: mesh ? mesh.position.clone() : new THREE.Vector3(),
          meshStartRot: mesh ? mesh.rotation.clone() : new THREE.Euler(),
          meshStartScale: mesh ? mesh.scale.clone() : new THREE.Vector3(),
        };
      });
      if (surrogateRef.current) {
        surrogateStartRef.current = {
          pos: surrogateRef.current.position.clone(),
          rot: surrogateRef.current.rotation.clone(),
          scale: surrogateRef.current.scale.clone(),
        };
      }
    };
    tc.addEventListener('mouseDown', onMouseDown);
    return () => tc.removeEventListener('mouseDown', onMouseDown);
  }, [selectedModels, selectedMeshes, selectedGlobalIndices]);

  return null;
}
