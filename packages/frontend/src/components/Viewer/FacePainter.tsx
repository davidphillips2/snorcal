import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import type { Rotation3D } from './STLViewer';

export type PaintMode = 'orbit' | 'paint' | 'fill' | 'rotate' | 'lay';

interface FacePainterProps {
  mesh: THREE.Mesh | null;
  renderer: THREE.WebGLRenderer | null;
  activeColor: string;
  paintMode: PaintMode;
  onPaint?: (faceIndex: number, color: string) => void;
  onLayOnFace?: (rotation: Rotation3D) => void;
}

function getPosAttr(geometry: THREE.BufferGeometry): THREE.BufferAttribute {
  return geometry.attributes.position as THREE.BufferAttribute;
}

/**
 * Three.js raycaster-based face painter.
 * Supports single-face paint and flood fill of connected same-colored faces.
 */
export function FacePainter({ mesh, renderer, activeColor, paintMode, onPaint, onLayOnFace }: FacePainterProps) {
  const undoStackRef = useRef<Uint8Array[]>([]);
  const adjacencyRef = useRef<Map<number, number[]> | null>(null);

  const getAdjacency = useCallback((geometry: THREE.BufferGeometry): Map<number, number[]> => {
    if (adjacencyRef.current) return adjacencyRef.current;

    const posAttr = getPosAttr(geometry);
    const faceCount = posAttr.count / 3;
    const adjacency = new Map<number, number[]>();
    const edgeToFaces = new Map<string, number[]>();

    for (let f = 0; f < faceCount; f++) {
      const v = [
        vertexKey(posAttr, f * 3),
        vertexKey(posAttr, f * 3 + 1),
        vertexKey(posAttr, f * 3 + 2),
      ];

      const edges = [edgeKey(v[0], v[1]), edgeKey(v[1], v[2]), edgeKey(v[0], v[2])];
      for (const edge of edges) {
        if (!edgeToFaces.has(edge)) edgeToFaces.set(edge, []);
        edgeToFaces.get(edge)!.push(f);
      }
    }

    for (const faces of edgeToFaces.values()) {
      if (faces.length === 2) {
        const [a, b] = faces;
        if (!adjacency.has(a)) adjacency.set(a, []);
        if (!adjacency.has(b)) adjacency.set(b, []);
        adjacency.get(a)!.push(b);
        adjacency.get(b)!.push(a);
      }
    }

    adjacencyRef.current = adjacency;
    return adjacency;
  }, []);

  const pushUndo = useCallback((geometry: THREE.BufferGeometry) => {
    const colorAttr = geometry.attributes.color as THREE.BufferAttribute;
    const data = new Float32Array(colorAttr.array);
    undoStackRef.current.push(new Uint8Array(data.buffer.slice(0)));
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
  }, []);

  const paintFace = useCallback((geometry: THREE.BufferGeometry, faceIndex: number, hexColor: string) => {
    const colorAttr = geometry.attributes.color as THREE.BufferAttribute;
    const color = new THREE.Color(hexColor);
    colorAttr.setXYZ(faceIndex * 3, color.r, color.g, color.b);
    colorAttr.setXYZ(faceIndex * 3 + 1, color.r, color.g, color.b);
    colorAttr.setXYZ(faceIndex * 3 + 2, color.r, color.g, color.b);
    colorAttr.needsUpdate = true;
    // Track this face as explicitly painted
    const painted = geometry.userData.paintedFaces as Set<number>;
    if (painted) painted.add(faceIndex);
  }, []);

  const floodFill = useCallback((geometry: THREE.BufferGeometry, startFace: number, hexColor: string) => {
    const colorAttr = geometry.attributes.color as THREE.BufferAttribute;
    const adjacency = getAdjacency(geometry);

    const startR = colorAttr.getX(startFace * 3);
    const startG = colorAttr.getY(startFace * 3);
    const startB = colorAttr.getZ(startFace * 3);
    const newColor = new THREE.Color(hexColor);

    if (Math.abs(startR - newColor.r) < 0.01 &&
        Math.abs(startG - newColor.g) < 0.01 &&
        Math.abs(startB - newColor.b) < 0.01) return;

    const visited = new Set<number>();
    const queue = [startFace];
    let filled = 0;

    while (queue.length > 0 && filled < 100000) {
      const face = queue.shift()!;
      if (visited.has(face)) continue;
      visited.add(face);

      const fr = colorAttr.getX(face * 3);
      const fg = colorAttr.getY(face * 3);
      const fb = colorAttr.getZ(face * 3);
      if (Math.abs(fr - startR) > 0.01 || Math.abs(fg - startG) > 0.01 || Math.abs(fb - startB) > 0.01) continue;

      paintFace(geometry, face, hexColor);
      filled++;

      for (const n of (adjacency.get(face) || [])) {
        if (!visited.has(n)) queue.push(n);
      }
    }
  }, [getAdjacency, paintFace]);

  useEffect(() => {
    if (!mesh || !renderer || paintMode === 'orbit' || paintMode === 'rotate') return;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let isPainting = false;
    let lastClientX = 0;
    let lastClientY = 0;

    const paintAtPoint = (clientX: number, clientY: number) => {
      const geometry = mesh.geometry;
      const canvas = renderer.domElement;
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

      const camera = (renderer as any).__slorca_camera as THREE.Camera | undefined;
      if (!camera) return;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObject(mesh);
      if (intersects.length === 0) return;

      const faceIndex = intersects[0].faceIndex;
      if (faceIndex == null) return;

      paintFace(geometry, faceIndex, activeColor);
      // Also paint adjacent faces for a thicker brush
      const adjacency = getAdjacency(geometry);
      const neighbors = adjacency.get(faceIndex);
      if (neighbors) {
        for (const n of neighbors) {
          paintFace(geometry, n, activeColor);
        }
      }
      if (onPaint) onPaint(faceIndex, activeColor);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;

      const geometry = mesh.geometry;
      const canvas = renderer.domElement;
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      const camera = (renderer as any).__slorca_camera as THREE.Camera | undefined;
      if (!camera) return;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObject(mesh);
      if (intersects.length === 0) return;

      const faceIndex = intersects[0].faceIndex;
      if (faceIndex == null) return;

      // Lay on face mode — rotate model so clicked face sits on bed
      if (paintMode === 'lay') {
        const posAttr = geometry.attributes.position as THREE.BufferAttribute;
        const i0 = faceIndex * 3;
        const v0 = new THREE.Vector3().fromBufferAttribute(posAttr, i0);
        const v1 = new THREE.Vector3().fromBufferAttribute(posAttr, i0 + 1);
        const v2 = new THREE.Vector3().fromBufferAttribute(posAttr, i0 + 2);
        const edge1 = new THREE.Vector3().subVectors(v1, v0);
        const edge2 = new THREE.Vector3().subVectors(v2, v0);
        const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

        // We want this face's normal to point DOWN (-Y) so the face sits on the bed
        const targetDown = new THREE.Vector3(0, -1, 0);
        const quat = new THREE.Quaternion().setFromUnitVectors(normal, targetDown);
        const euler = new THREE.Euler().setFromQuaternion(quat);
        const rad2deg = 180 / Math.PI;

        if (onLayOnFace) {
          onLayOnFace({
            x: Math.round(euler.x * rad2deg),
            y: Math.round(euler.y * rad2deg),
            z: Math.round(euler.z * rad2deg),
          });
        }
        return;
      }

      pushUndo(geometry);

      if (paintMode === 'fill') {
        floodFill(geometry, faceIndex, activeColor);
      } else {
        paintFace(geometry, faceIndex, activeColor);
        // Paint adjacent faces for brush width
        const adjacency = getAdjacency(geometry);
        const neighbors = adjacency.get(faceIndex);
        if (neighbors) {
          for (const n of neighbors) {
            paintFace(geometry, n, activeColor);
          }
        }
        isPainting = true;
        lastClientX = event.clientX;
        lastClientY = event.clientY;
      }

      if (onPaint) onPaint(faceIndex, activeColor);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!isPainting || paintMode !== 'paint') return;

      // Interpolate between last and current position to fill gaps
      const dx = event.clientX - lastClientX;
      const dy = event.clientY - lastClientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.ceil(dist / 4)); // sample every 4px

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        paintAtPoint(lastClientX + dx * t, lastClientY + dy * t);
      }

      lastClientX = event.clientX;
      lastClientY = event.clientY;
    };

    const handlePointerUp = () => { isPainting = false; };

    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.style.cursor = paintMode === 'lay' ? 'pointer' : 'crosshair';
    canvas.style.touchAction = 'none';

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.style.cursor = 'grab';
      canvas.style.touchAction = '';
    };
  }, [mesh, renderer, paintMode, activeColor, onPaint, onLayOnFace, pushUndo, floodFill, paintFace]);

  // Undo
  const undo = useCallback(() => {
    if (!mesh || undoStackRef.current.length === 0) return;
    const prev = undoStackRef.current.pop()!;
    const colorAttr = mesh.geometry.attributes.color as THREE.BufferAttribute;
    const restored = new Float32Array(prev.buffer);
    colorAttr.array.set(restored);
    colorAttr.needsUpdate = true;
  }, [mesh]);

  useEffect(() => {
    (window as any).__slorca_undo = undo;
    return () => { delete (window as any).__slorca_undo; };
  }, [undo]);

  return null;
}

function vertexKey(attr: THREE.BufferAttribute, index: number): string {
  return `${attr.getX(index).toFixed(4)},${attr.getY(index).toFixed(4)},${attr.getZ(index).toFixed(4)}`;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
