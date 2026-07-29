import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import type { SceneRefs } from '../Viewer/Scene';
import { geometryToSTL } from '../../lib/stl-export';

type KeepMode = 'both' | 'upper' | 'lower';
type ResultMode = 'objects' | 'parts';

export interface CutPiece {
  file: File;
  name: string;
  kind: 'upper' | 'lower';
}

interface CutToolProps {
  sceneRefs: SceneRefs | null;
  mesh: THREE.Mesh | null;
  baseName?: string;
  active: boolean;
  onCutComplete: (pieces: CutPiece[], mode: ResultMode) => void;
  onCancel: () => void;
}

const DEG = Math.PI / 180;

/**
 * OrcaSlicer-style cut tool. Translucent plane through the mesh with two
 * rotation rings (tilt around local X, yaw around local Y) you can drag, plus
 * a numeric panel for precise control. Single angled cut → 2 pieces.
 *
 * Drag model copied from ModelMover.tsx: raycast the rings/plane on the WebGL
 * canvas, convert screen delta to an angle (rings) or offset (plane body),
 * disable OrbitControls during the drag.
 *
 * CSG cutter is built in the gizmo's local space (thin slab along local Z) and
 * placed via gizmo.matrixWorld — three-bvh-csg honors each brush's matrixWorld
 * (operationsUtils.js applies it per-triangle), so an arbitrarily oriented
 * cutter works without pre-rotating vertices.
 */
export function CutTool({ sceneRefs, mesh, baseName = 'cut', active, onCutComplete, onCancel }: CutToolProps) {
  // Plane orientation: Euler in DEGREES for the inputs; gizmo reads radians.
  const [tiltDeg, setTiltDeg] = useState(0);   // rotation around local X
  const [yawDeg, setYawDeg] = useState(0);     // rotation around local Y
  const [rollDeg, setRollDeg] = useState(0);   // rotation around local Z (rarely needed)
  const [offset, setOffset] = useState(0);     // signed distance along plane normal from mesh center
  const [keepMode, setKeepMode] = useState<KeepMode>('both');
  const [resultMode, setResultMode] = useState<ResultMode>('parts');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gizmoRef = useRef<THREE.Group | null>(null);
  const tiltRingRef = useRef<THREE.Mesh | null>(null);
  const yawRingRef = useRef<THREE.Mesh | null>(null);
  const planeMeshRef = useRef<THREE.Mesh | null>(null);
  const boundsRef = useRef<THREE.Box3 | null>(null);
  const centerRef = useRef<THREE.Vector3>(new THREE.Vector3());

  // Compute mesh bounds + center; reset offset to center when mesh changes.
  useEffect(() => {
    if (!mesh) { boundsRef.current = null; return; }
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    boundsRef.current = box;
    box.getCenter(centerRef.current);
    setOffset(0);
  }, [mesh]);

  // Build / rebuild the gizmo group whenever orientation/offset/active/mesh change.
  useEffect(() => {
    if (!sceneRefs) return;
    const scene = sceneRefs.scene;

    // Tear down previous gizmo
    const disposeGizmo = () => {
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
    disposeGizmo();
    if (!active || !mesh || !boundsRef.current) return;

    const size = new THREE.Vector3();
    boundsRef.current.getSize(size);
    const planeSize = Math.max(size.x, size.y, size.z) * 1.5 + 10;
    const half = planeSize / 2;

    const group = new THREE.Group();

    // Translucent plane body — also the offset-drag target.
    const planeGeo = new THREE.PlaneGeometry(planeSize, planeSize);
    const planeMat = new THREE.MeshBasicMaterial({
      color: 0xff3366, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false,
    });
    const plane = new THREE.Mesh(planeGeo, planeMat);
    plane.userData.cutHandle = 'plane';
    group.add(plane);
    planeMeshRef.current = plane;

    // Border
    const borderPoints = [
      new THREE.Vector3(-half, -half, 0), new THREE.Vector3(half, -half, 0),
      new THREE.Vector3(half, half, 0), new THREE.Vector3(-half, half, 0),
      new THREE.Vector3(-half, -half, 0),
    ];
    const border = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(borderPoints),
      new THREE.LineBasicMaterial({ color: 0xff3366 }),
    );
    group.add(border);

    // Two rotation rings at the plane edge. Torus lies in the plane's local XY
    // (default TorusGeometry orientation). Ring A (tilt) rotates around local X,
    // Ring B (yaw) around local Y — visualized by rotating the torus itself so
    // its disc faces along that axis. Both share the plane's center.
    const ringRadius = half * 0.95;
    const tube = 0.8;

    // Tilt ring: torus rotated so its disc is in local YZ (rotates around X).
    const tiltRingGeo = new THREE.TorusGeometry(ringRadius, tube, 8, 64);
    const tiltRing = new THREE.Mesh(
      tiltRingGeo,
      new THREE.MeshBasicMaterial({ color: 0x33aaff, side: THREE.DoubleSide }),
    );
    tiltRing.rotation.y = Math.PI / 2; // disc faces along X
    tiltRing.userData.cutHandle = 'tilt';
    group.add(tiltRing);
    tiltRingRef.current = tiltRing;

    // Yaw ring: torus rotated so its disc is in local XZ (rotates around Y).
    const yawRingGeo = new THREE.TorusGeometry(ringRadius * 0.7, tube, 8, 64);
    const yawRing = new THREE.Mesh(
      yawRingGeo,
      new THREE.MeshBasicMaterial({ color: 0x33ff99, side: THREE.DoubleSide }),
    );
    yawRing.rotation.x = Math.PI / 2; // disc faces along Y
    yawRing.userData.cutHandle = 'yaw';
    group.add(yawRing);
    yawRingRef.current = yawRing;

    // Apply the user's orientation (local-space rotation) + position.
    // Plane's local +Z is the cut normal; we offset along it from mesh center.
    group.rotation.set(tiltDeg * DEG, yawDeg * DEG, rollDeg * DEG);
    const normal = new THREE.Vector3(0, 0, 1).applyEuler(group.rotation);
    group.position.copy(centerRef.current).addScaledVector(normal, offset);

    scene.add(group);
    gizmoRef.current = group;

    return disposeGizmo;
  }, [sceneRefs, mesh, active, tiltDeg, yawDeg, rollDeg, offset]);

  // Pointer drag handlers — attach to canvas only while active.
  useEffect(() => {
    if (!sceneRefs || !active || !mesh) return;
    const { camera, renderer, controls } = sceneRefs;
    const canvas = renderer.domElement;

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const getNDC = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    let dragging: null | 'tilt' | 'yaw' | 'plane' = null;
    // Drag helpers — for ring drags we track the angle of the cursor around
    // the rotation axis at drag start, and apply the delta.
    let startAngle = 0;
    let startTilt = 0;
    let startYaw = 0;
    let startOffset = 0;
    // For plane-body drag, track world hit point + a helper plane to raycast.
    const helperPlane = new THREE.Plane();
    let startPoint = new THREE.Vector3();

    const angleAroundAxis = (worldPoint: THREE.Vector3, axis: 'x' | 'y'): number => {
      // Project world point into gizmo-local space, then atan2 around the axis.
      const gizmo = gizmoRef.current!;
      const local = worldPoint.clone().sub(gizmo.position);
      // Inverse-rotate by gizmo rotation to get local-space offset.
      const invQuat = gizmo.quaternion.clone().invert();
      local.applyQuaternion(invQuat);
      return axis === 'x' ? Math.atan2(local.z, local.y) : Math.atan2(local.x, local.z);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (!gizmoRef.current) return;
      getNDC(e);
      raycaster.setFromCamera(ndc, camera);

      // Check rings first (they sit on top visually), then plane body.
      const tiltHits = tiltRingRef.current ? raycaster.intersectObject(tiltRingRef.current) : [];
      const yawHits = yawRingRef.current ? raycaster.intersectObject(yawRingRef.current) : [];
      const planeHits = planeMeshRef.current ? raycaster.intersectObject(planeMeshRef.current) : [];

      if (tiltHits.length > 0) {
        dragging = 'tilt';
        startAngle = angleAroundAxis(tiltHits[0].point, 'x');
        startTilt = tiltDeg;
      } else if (yawHits.length > 0) {
        dragging = 'yaw';
        startAngle = angleAroundAxis(yawHits[0].point, 'y');
        startYaw = yawDeg;
      } else if (planeHits.length > 0) {
        dragging = 'plane';
        startPoint = planeHits[0].point.clone();
        startOffset = offset;
      } else {
        return; // miss — let orbit handle it
      }

      controls.enabled = false;
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || !gizmoRef.current) return;
      getNDC(e);
      raycaster.setFromCamera(ndc, camera);

      if (dragging === 'tilt' || dragging === 'yaw') {
        // Raycast a large helper plane through the gizmo, perpendicular to the
        // relevant ring's axis, to get a stable world point for the cursor.
        const axisDir = new THREE.Vector3(
          dragging === 'tilt' ? 1 : 0,
          dragging === 'yaw' ? 1 : 0,
          0,
        ).applyQuaternion(gizmoRef.current.quaternion);
        helperPlane.setFromNormalAndCoplanarPoint(axisDir, gizmoRef.current.position);
        const hit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(helperPlane, hit)) return;
        const cur = angleAroundAxis(hit, dragging === 'tilt' ? 'x' : 'y');
        let delta = cur - startAngle;
        // Unwrap jumps across the ±π boundary.
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        // Sensitivity multiplier: atan2 gives 1:1 rad→deg but cursor sweep on a
        // distant helper plane produces tiny angular deltas per pixel. 3× makes
        // the ring feel like Orca's responsive dial.
        const deg = (dragging === 'tilt' ? startTilt : startYaw) + (delta / DEG) * 3;
        if (dragging === 'tilt') setTiltDeg(deg);
        else setYawDeg(deg);
      } else {
        // Plane body → drag along plane normal. Raycast the cut plane itself.
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(gizmoRef.current.quaternion);
        helperPlane.setFromNormalAndCoplanarPoint(normal, gizmoRef.current.position);
        const hit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(helperPlane, hit)) return;
        const deltaWorld = hit.clone().sub(startPoint);
        const signed = deltaWorld.dot(normal);
        setOffset(startOffset + signed);
      }
    };

    const onPointerUp = () => {
      if (dragging) {
        dragging = null;
        controls.enabled = true;
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      controls.enabled = true; // safety: never leave orbit stuck off
    };
  }, [sceneRefs, active, mesh, tiltDeg, yawDeg, offset]);

  if (!active || !mesh) return null;

  const performCut = async () => {
    if (!mesh || !boundsRef.current || !gizmoRef.current) return;
    setBusy(true);
    setError(null);
    try {
      // Bake world matrix into subject geometry (CSG works in world space).
      const subjectGeo = mesh.geometry.clone();
      subjectGeo.applyMatrix4(mesh.matrixWorld);
      if (subjectGeo.index) subjectGeo.toNonIndexed();
      subjectGeo.computeVertexNormals();
      const subject = new Brush(subjectGeo, new THREE.MeshBasicMaterial());
      subject.updateMatrixWorld(true);

      // Cutter slab in GIZMO LOCAL space: thin along local Z (the normal),
      // oversized in local X/Y to cover the mesh's projection onto the plane.
      const box = boundsRef.current;
      const size = new THREE.Vector3();
      box.getSize(size);
      const localExtent = Math.max(size.x, size.y, size.z) * 2 + 20; // generous cover
      // Project mesh onto the plane normal to size the slab thickness.
      const normal = new THREE.Vector3(0, 0, 1).applyEuler(gizmoRef.current.rotation);
      const corners = [
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.min.y, box.min.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z),
        new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.max.z),
        new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
      ];
      const center = centerRef.current;
      const projections = corners.map(c => c.clone().sub(center).dot(normal));
      const thickness = (Math.max(...projections) - Math.min(...projections)) + 20;

      // Half-brush: covers one side of the plane. keepUpper=true → the half
      // with +Z (above the plane) — used as the cutter to REMOVE the lower half.
      const makeHalfBrush = (keepUpper: boolean): Brush => {
        const geo = new THREE.BoxGeometry(localExtent, localExtent, thickness);
        // Position in local space: slab centered at ±thickness/2 along Z so its
        // near face lies on the plane (z=0). Then bake gizmo world transform.
        geo.translate(0, 0, (keepUpper ? thickness / 2 : -thickness / 2));
        const b = new Brush(geo, new THREE.MeshBasicMaterial());
        // Match the gizmo: same rotation + same world position (which already
        // includes the offset along the normal).
        b.position.copy(gizmoRef.current!.position);
        b.quaternion.copy(gizmoRef.current!.quaternion);
        b.updateMatrixWorld(true);
        return b;
      };

      const evaluator = new Evaluator();
      evaluator.attributes = ['position', 'normal'];

      // CSG runs in world space (subject had matrixWorld baked). Translate the
      // result back into the mesh's LOCAL frame so the exported STL matches the
      // original upload's coordinate system — STLViewer then recenters it and
      // applies positionOffset exactly like any other model. Without this, the
      // world-baked coords fought STLViewer's recenter+offset and halves landed
      // at plate center with a broken restPosition (snap-back on drag).
      const invMeshMatrix = mesh.matrixWorld.clone().invert();

      const pieces: CutPiece[] = [];
      const keep = (label: 'upper' | 'lower', keepUpper: boolean) => {
        const cutter = makeHalfBrush(!keepUpper); // remove the OTHER side
        const result = evaluator.evaluate(subject, cutter, SUBTRACTION);
        const localGeo = result.geometry.clone();
        localGeo.applyMatrix4(invMeshMatrix);
        localGeo.computeVertexNormals();
        pieces.push({
          file: geometryToSTL(localGeo, new THREE.Matrix4(), `${baseName}_${label}.stl`),
          name: `${baseName}_${label}`,
          kind: label,
        });
      };

      if (keepMode === 'both' || keepMode === 'upper') keep('upper', true);
      if (keepMode === 'both' || keepMode === 'lower') keep('lower', false);

      onCutComplete(pieces, resultMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute top-14 left-2 bg-gray-800/95 backdrop-blur rounded-lg px-3 py-2.5 shadow-lg z-20 w-64 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-gray-400">Cut</div>
        <button
          onClick={onCancel}
          aria-label="Cancel cut"
          className="text-gray-400 hover:text-white text-lg leading-none -mt-1"
        >×</button>
      </div>

      {/* Rotation — drag the rings in the viewer, or type here */}
      <div className="space-y-1">
        <div className="text-[10px] text-gray-500">Drag the rings in the viewer, or enter exact angles</div>
        <NumField label="Tilt" suffix="°" color="text-blue-400" value={tiltDeg} onChange={setTiltDeg} />
        <NumField label="Yaw" suffix="°" color="text-emerald-400" value={yawDeg} onChange={setYawDeg} />
        <NumField label="Roll" suffix="°" color="text-gray-400" value={rollDeg} onChange={setRollDeg} />
        <button
          onClick={() => { setTiltDeg(0); setYawDeg(0); setRollDeg(0); }}
          className="text-[10px] text-gray-500 hover:text-gray-300 underline"
        >reset rotation</button>
      </div>

      <label className="flex items-center gap-2">
        <span className="text-xs text-gray-400 w-12">Offset</span>
        <input
          type="number"
          step="0.5"
          value={Number(offset.toFixed(2))}
          onChange={(e) => setOffset(Number(e.target.value) || 0)}
          className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
        />
        <span className="text-xs text-gray-500">mm</span>
      </label>

      <div>
        <div className="text-[10px] text-gray-500 mb-1">Keep</div>
        <div className="flex gap-1">
          {(['both', 'upper', 'lower'] as const).map(m => (
            <button
              key={m}
              onClick={() => setKeepMode(m)}
              className={`flex-1 py-1 rounded text-xs font-medium capitalize transition ${
                keepMode === m ? 'bg-pink-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >{m}</button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] text-gray-500 mb-1">Result</div>
        <div className="flex gap-1">
          <button
            onClick={() => setResultMode('parts')}
            className={`flex-1 py-1 rounded text-xs font-medium transition ${
              resultMode === 'parts' ? 'bg-pink-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            title="Pieces grouped under the original model — move and slice together"
          >Cut to Parts</button>
          <button
            onClick={() => setResultMode('objects')}
            className={`flex-1 py-1 rounded text-xs font-medium transition ${
              resultMode === 'objects' ? 'bg-pink-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            title="Each piece becomes an independent model"
          >Separate</button>
        </div>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <button
        onClick={performCut}
        disabled={busy}
        className="w-full py-1.5 rounded text-xs bg-pink-600 text-white hover:bg-pink-500 disabled:opacity-50"
      >
        {busy ? 'Cutting…' : 'Cut'}
      </button>

      <div className="text-[10px] text-gray-500">
        {resultMode === 'parts'
          ? 'Pieces grouped under the original. Slice as one assembly.'
          : 'Each piece becomes its own model on the plate.'}
      </div>
    </div>
  );
}

function NumField({ label, suffix, color, value, onChange }: {
  label: string; suffix?: string; color?: string; value: number; onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className={`text-xs w-10 ${color ?? 'text-gray-400'}`}>{label}</span>
      <input
        type="number"
        step="1"
        value={Number(value.toFixed(1))}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
      />
      {suffix && <span className="text-xs text-gray-500">{suffix}</span>}
    </label>
  );
}
