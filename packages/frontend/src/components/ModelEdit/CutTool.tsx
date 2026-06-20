import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import type { SceneRefs } from '../Viewer/Scene';
import { geometryToSTL } from '../../lib/stl-export';

type Axis = 'x' | 'y' | 'z';
type KeepMode = 'both' | 'upper' | 'lower';

interface CutToolProps {
  sceneRefs: SceneRefs | null;
  mesh: THREE.Mesh | null;
  baseName?: string;
  active: boolean;
  onCutComplete: (files: { file: File; name: string }[]) => void;
  onCancel: () => void;
}

/**
 * Cut-plane gizmo + three-bvh-csg boolean. User picks axis + offset, sees a
 * translucent plane through the active mesh, then chooses what to keep.
 * Each kept half becomes a binary STL File via `geometryToSTL`.
 */
export function CutTool({ sceneRefs, mesh, baseName = 'cut', active, onCutComplete, onCancel }: CutToolProps) {
  const [axis, setAxis] = useState<Axis>('y');
  const [offset, setOffset] = useState(0);
  const [keepMode, setKeepMode] = useState<KeepMode>('both');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gizmoRef = useRef<THREE.Group | null>(null);
  const boundsRef = useRef<THREE.Box3 | null>(null);

  // Compute mesh bounds + reset offset when mesh changes
  useEffect(() => {
    if (!mesh) { boundsRef.current = null; return; }
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    boundsRef.current = box;
    const center = new THREE.Vector3();
    box.getCenter(center);
    setOffset(center[axis]);
  }, [mesh, axis]);

  // Render gizmo plane
  useEffect(() => {
    if (!sceneRefs) return;
    const scene = sceneRefs.scene;

    // Clear previous
    if (gizmoRef.current) {
      scene.remove(gizmoRef.current);
      gizmoRef.current.traverse(o => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          o.geometry.dispose();
          ((o as any).material as THREE.Material).dispose();
        }
      });
      gizmoRef.current = null;
    }

    if (!active || !mesh || !boundsRef.current) return;

    // Size plane to mesh bounds with padding
    const size = new THREE.Vector3();
    boundsRef.current.getSize(size);
    const planeSize = Math.max(size.x, size.y, size.z) * 1.5 + 10;

    const group = new THREE.Group();

    // Filled translucent plane
    const planeGeo = new THREE.PlaneGeometry(planeSize, planeSize);
    const planeMat = new THREE.MeshBasicMaterial({
      color: 0xff3366, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false,
    });
    const plane = new THREE.Mesh(planeGeo, planeMat);
    group.add(plane);

    // Border
    const half = planeSize / 2;
    const borderPoints = [
      new THREE.Vector3(-half, -half, 0),
      new THREE.Vector3(half, -half, 0),
      new THREE.Vector3(half, half, 0),
      new THREE.Vector3(-half, half, 0),
      new THREE.Vector3(-half, -half, 0),
    ];
    const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPoints);
    const border = new THREE.Line(borderGeo, new THREE.LineBasicMaterial({ color: 0xff3366 }));
    group.add(border);

    // Orient + position per axis + offset
    // Default plane is XY (facing +Z). Rotate to align with cut plane.
    if (axis === 'x') {
      group.rotation.y = Math.PI / 2;
      group.position.set(offset, 0, 0);
    } else if (axis === 'y') {
      group.rotation.x = Math.PI / 2;
      group.position.set(0, offset, 0);
    } else {
      // z: default orientation, just offset
      group.position.set(0, 0, offset);
    }

    scene.add(group);
    gizmoRef.current = group;

    return () => {
      if (gizmoRef.current) {
        scene.remove(gizmoRef.current);
        gizmoRef.current.traverse(o => {
          if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
            o.geometry.dispose();
            ((o as any).material as THREE.Material).dispose();
          }
        });
        gizmoRef.current = null;
      }
    };
  }, [sceneRefs, mesh, active, axis, offset]);

  if (!active || !mesh) return null;

  const performCut = async () => {
    if (!mesh || !boundsRef.current) return;
    setBusy(true);
    setError(null);
    try {
      // Bake world matrix into subject geometry
      const subjectGeo = mesh.geometry.clone();
      subjectGeo.applyMatrix4(mesh.matrixWorld);
      if (subjectGeo.index) subjectGeo.toNonIndexed();
      subjectGeo.computeVertexNormals();

      const subject = new Brush(subjectGeo, new THREE.MeshBasicMaterial());
      subject.updateMatrixWorld(true);

      // Build cutter box covering the full mesh extent, thick on the cut axis
      const box = boundsRef.current;
      const size = new THREE.Vector3();
      box.getSize(size);
      const padding = Math.max(size.x, size.y, size.z) + 10;

      const makeHalfBrush = (keepUpper: boolean): Brush => {
        // Box of length `padding` along cut axis, centered so its far face sits
        // `padding/2` past the cut, and its near face is exactly on the plane.
        // For "above the plane" (keepUpper=true), box center = offset + padding/2.
        const geo = new THREE.BoxGeometry(
          axis === 'x' ? padding : size.x * 2 + 20,
          axis === 'y' ? padding : size.y * 2 + 20,
          axis === 'z' ? padding : size.z * 2 + 20,
        );
        const center = new THREE.Vector3();
        box.getCenter(center);
        if (axis === 'x') center.x = offset + (keepUpper ? padding / 2 : -padding / 2);
        if (axis === 'y') center.y = offset + (keepUpper ? padding / 2 : -padding / 2);
        if (axis === 'z') center.z = offset + (keepUpper ? padding / 2 : -padding / 2);
        geo.translate(center.x, center.y, center.z);
        const b = new Brush(geo, new THREE.MeshBasicMaterial());
        b.updateMatrixWorld(true);
        return b;
      };

      const evaluator = new Evaluator();
      evaluator.attributes = ['position', 'normal'];

      const files: { file: File; name: string }[] = [];

      const keep = (label: 'upper' | 'lower', keepUpper: boolean) => {
        const cutter = makeHalfBrush(!keepUpper);  // cutter removes the OTHER side
        const result = evaluator.evaluate(subject, cutter, SUBTRACTION);
        const file = geometryToSTL(result.geometry, new THREE.Matrix4(), `${baseName}_${label}.stl`);
        files.push({ file, name: `${baseName}_${label}` });
      };

      if (keepMode === 'both' || keepMode === 'upper') keep('upper', true);
      if (keepMode === 'both' || keepMode === 'lower') keep('lower', false);

      onCutComplete(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute top-14 left-2 bg-gray-800/95 backdrop-blur rounded-lg px-3 py-2.5 shadow-lg z-20 w-64 space-y-2.5">
      <div className="text-xs uppercase tracking-wide text-gray-400">Cut</div>

      <div className="flex gap-1">
        {(['x', 'y', 'z'] as const).map(a => (
          <button
            key={a}
            onClick={() => setAxis(a)}
            className={`flex-1 py-1 rounded text-xs font-medium transition ${
              axis === a ? 'bg-pink-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {a.toUpperCase()}
          </button>
        ))}
      </div>

      <div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 w-12">Offset</span>
          <input
            type="number"
            step="0.5"
            value={Number(offset.toFixed(2))}
            onChange={(e) => setOffset(Number(e.target.value) || 0)}
            className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
          />
          <span className="text-xs text-gray-500">mm</span>
        </div>
      </div>

      <div className="flex gap-1">
        {(['both', 'upper', 'lower'] as const).map(m => (
          <button
            key={m}
            onClick={() => setKeepMode(m)}
            className={`flex-1 py-1 rounded text-xs font-medium capitalize transition ${
              keepMode === m ? 'bg-pink-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-1">
        <button
          onClick={performCut}
          disabled={busy}
          className="flex-1 py-1.5 rounded text-xs bg-pink-600 text-white hover:bg-pink-500 disabled:opacity-50"
        >
          {busy ? 'Cutting…' : 'Cut'}
        </button>
        <button
          onClick={onCancel}
          className="px-2 py-1.5 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600"
        >
          ✕
        </button>
      </div>

      <div className="text-[10px] text-gray-500">
        Each kept half uploads as a new model.
      </div>
    </div>
  );
}
