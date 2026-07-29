import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { SceneRefs } from './Scene';

interface Bounds {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
}

interface ModelMoverProps {
  mesh: THREE.Mesh | null;
  sceneRefs: SceneRefs;
  active: boolean;
  bounds?: Bounds | null;
  onPositionChange: (position: THREE.Vector3) => void;
  onDragEnd?: (position: THREE.Vector3) => void;
}

export function ModelMover({ mesh, sceneRefs, active, bounds, onPositionChange, onDragEnd }: ModelMoverProps) {
  const isDraggingRef = useRef(false);
  // Hold callbacks in refs so the drag effect doesn't tear down + re-attach
  // when their identities change (they do whenever projectModels changes —
  // mid-drag that would detach the pointer handlers and abort the drag, and
  // any release after a tear-down leaves state stale → snap-back).
  const onPositionChangeRef = useRef(onPositionChange);
  onPositionChangeRef.current = onPositionChange;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  useEffect(() => {
    if (!mesh || !active) return;

    const { camera, renderer, controls: orbitControls } = sceneRefs;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const dragOffset = new THREE.Vector3();

    // Invisible XZ plane at model's base height for raycasting during drag
    const planeGeo = new THREE.PlaneGeometry(500, 500);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
    const dragPlane = new THREE.Mesh(planeGeo, planeMat);
    dragPlane.rotation.x = -Math.PI / 2;
    dragPlane.position.y = mesh.position.y;
    sceneRefs.scene.add(dragPlane);

    const getMouseNDC = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;

      getMouseNDC(event);
      raycaster.setFromCamera(mouse, camera);

      // Only start drag if clicking on the model
      const intersects = raycaster.intersectObject(mesh);
      if (intersects.length === 0) return;

      // Prevent OrbitControls from orbiting
      orbitControls.enabled = false;
      isDraggingRef.current = true;

      // Set drag plane at model's current base height
      dragPlane.position.y = mesh.position.y;

      // Calculate offset so model doesn't snap to cursor
      const planeHits = raycaster.intersectObject(dragPlane);
      if (planeHits.length > 0) {
        dragOffset.copy(mesh.position).sub(planeHits[0].point);
        dragOffset.y = 0;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!isDraggingRef.current) return;

      getMouseNDC(event);
      raycaster.setFromCamera(mouse, camera);

      const planeHits = raycaster.intersectObject(dragPlane);
      if (planeHits.length > 0) {
        const newPos = planeHits[0].point.add(dragOffset);
        if (bounds) {
          newPos.x = Math.max(bounds.minX, Math.min(bounds.maxX, newPos.x));
          newPos.z = Math.max(bounds.minZ, Math.min(bounds.maxZ, newPos.z));
        }
        mesh.position.x = newPos.x;
        mesh.position.z = newPos.z;
        // Sync to state LIVE so STLViewer's positionOffset effect and the
        // mover never disagree (avoids snap-back on release when restPosition
        // is recomputed from a freshly-loaded geometry bbox).
        onPositionChangeRef.current(mesh.position.clone());
      }
    };

    const onPointerUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      orbitControls.enabled = true;
      // Final sync via onDragEnd if provided (same fn in App); live updates
      // already keep state current so this just confirms the last position.
      const cb = onDragEndRef.current || onPositionChangeRef.current;
      cb(mesh.position.clone());
    };

    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      isDraggingRef.current = false;
      orbitControls.enabled = true;
      sceneRefs.scene.remove(dragPlane);
      planeGeo.dispose();
      planeMat.dispose();
    };
  }, [mesh, active, sceneRefs, bounds]);

  return null;
}
