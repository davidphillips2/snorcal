import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { Scale3D, Mirror3D, ModelKind } from '@snorcal/shared';

export interface Rotation3D {
  x: number;
  y: number;
  z: number;
}

interface STLViewerProps {
  modelUrl: string;
  faceColors?: Uint8Array;
  rotation?: Rotation3D;
  positionOffset?: THREE.Vector3;
  scale?: Scale3D;
  mirror?: Mirror3D;
  kind?: ModelKind;
  sceneRef: React.MutableRefObject<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
  } | null>;
  onGeometryReady?: (geometry: THREE.BufferGeometry, mesh: THREE.Mesh) => void;
}

export function STLViewer({ modelUrl, faceColors, rotation, positionOffset, scale, mirror, kind = 'model', sceneRef, onGeometryReady }: STLViewerProps) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const faceColorsRef = useRef<Uint8Array | undefined>(undefined);
  faceColorsRef.current = faceColors;

  // Cleanup on unmount — remove mesh from scene
  useEffect(() => {
    return () => {
      if (meshRef.current && sceneRef.current) {
        sceneRef.current.scene.remove(meshRef.current);
        meshRef.current.geometry.dispose();
        (meshRef.current.material as THREE.Material).dispose();
        meshRef.current = null;
        geometryRef.current = null;
      }
    };
  }, []);

  // Load geometry when model URL changes
  useEffect(() => {
    if (!sceneRef.current || !modelUrl) return;

    const { scene, camera } = sceneRef.current;
    const loader = new STLLoader();

    loader.load(
      modelUrl,
      (geometry) => {
        // Remove old mesh
        if (meshRef.current) {
          scene.remove(meshRef.current);
          meshRef.current.geometry.dispose();
          (meshRef.current.material as THREE.Material).dispose();
        }

        geometry.computeVertexNormals();

        // Initialize color attribute — default light gray
        const vertexCount = geometry.attributes.position.count;
        const colors = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
          colors[i * 3] = 0.7;
          colors[i * 3 + 1] = 0.7;
          colors[i * 3 + 2] = 0.7;
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        // Track which faces have been explicitly painted (not default gray)
        geometry.userData.paintedFaces = new Set<number>();

        // Translate geometry so bottom is at Y=0 and X/Z centered on grid
        geometry.computeBoundingBox();
        if (geometry.boundingBox) {
          const box = geometry.boundingBox;
          const cx = (box.min.x + box.max.x) / 2;
          const cz = (box.min.z + box.max.z) / 2;
          geometry.translate(-cx, -box.min.y, -cz);
          geometry.computeBoundingBox();
        }

        const material = makeMaterialForKind(kind);

        const mesh = new THREE.Mesh(geometry, material);
        meshRef.current = mesh;
        geometryRef.current = geometry;

        scene.add(mesh);

        // Apply face colors if already available (handles race where colors arrive before geometry)
        if (faceColorsRef.current && faceColorsRef.current.length > 0) {
          applyFaceColors(geometry, faceColorsRef.current);
        }

        if (onGeometryReady) {
          onGeometryReady(geometry, mesh);
        }
      },
      undefined,
      (error) => {
        console.error('Failed to load STL:', error);
      },
    );
  }, [modelUrl, kind]);

  // Apply face colors when they change (without reloading geometry)
  useEffect(() => {
    const geometry = geometryRef.current;
    if (!geometry || !faceColors || faceColors.length === 0) return;
    applyFaceColors(geometry, faceColors);
  }, [faceColors]);

  // Apply rotation when it changes — reposition to keep bottom on build plate
  useEffect(() => {
    if (!meshRef.current || !rotation) return;
    const mesh = meshRef.current;
    const deg2rad = Math.PI / 180;

    // Reset position, apply rotation
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(rotation.x * deg2rad, rotation.y * deg2rad, rotation.z * deg2rad);
    // Apply non-uniform scale + mirror (signed scale)
    const s = scale ?? { x: 1, y: 1, z: 1 };
    const m = mirror ?? { x: false, y: false, z: false };
    mesh.scale.set(
      s.x * (m.x ? -1 : 1),
      s.y * (m.y ? -1 : 1),
      s.z * (m.z ? -1 : 1),
    );
    mesh.updateMatrixWorld(true);

    // Compute world-space bounding box and reposition
    const box = new THREE.Box3().setFromObject(mesh);
    const center = new THREE.Vector3();
    box.getCenter(center);
    // Bottom at Y=0, centered on X/Z
    const ox = positionOffset ? positionOffset.x : 0;
    const oy = positionOffset ? positionOffset.y : 0;
    const oz = positionOffset ? positionOffset.z : 0;
    const restX = -center.x;
    const restY = -box.min.y;
    const restZ = -center.z;
    mesh.position.set(restX + ox, restY + oy, restZ + oz);
    // Store rest position so parent can compute user offset from absolute drag position
    mesh.userData.restPosition = { x: restX, y: restY, z: restZ };
  }, [rotation, positionOffset, scale, mirror]);

  return null; // This is a logic-only component, rendering happens in Scene
}

/** Material per object kind. `model` = solid + vertex colors; others = translucent. */
function makeMaterialForKind(kind: ModelKind): THREE.Material {
  if (kind === 'negative') {
    return new THREE.MeshStandardMaterial({
      color: 0xff4444,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
      roughness: 0.5,
    });
  }
  if (kind === 'modifier') {
    return new THREE.MeshStandardMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
      roughness: 0.5,
    });
  }
  if (kind === 'support') {
    return new THREE.MeshStandardMaterial({
      color: 0x9933cc,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
      roughness: 0.5,
    });
  }
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    side: THREE.DoubleSide,
    metalness: 0.1,
    roughness: 0.6,
  });
}

/**
 * Auto-orient: place the largest flat face on the build plate (OrcaSlicer-style).
 *
 * Aggregates face area by quantized outward-normal direction, then picks the
 * direction with the most area. A 1% downward bias only breaks ties between
 * equal-area faces (prefers the one already facing -Y). Outward direction is
 * recovered via centroid − bbox center, so STLs with inconsistent winding
 * still score correctly.
 */
export function autoOrient(geometry: THREE.BufferGeometry): Rotation3D {
  const posAttr = geometry.attributes.position;
  const faceCount = posAttr.count / 3;

  // Bbox center for outward-direction heuristic — STL winding may be inconsistent,
  // so we use centroid−center to disambiguate inward vs outward normals.
  geometry.computeBoundingBox();
  const meshCenter = new THREE.Vector3();
  geometry.boundingBox!.getCenter(meshCenter);

  const Q = 10;
  const quantize = (v: number) => Math.round(v * Q);

  const normalAreas = new Map<string, number>();
  const normalDirs = new Map<string, THREE.Vector3>();

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const outward = new THREE.Vector3();

  for (let f = 0; f < faceCount; f++) {
    const i0 = f * 3;
    v0.fromBufferAttribute(posAttr, i0);
    v1.fromBufferAttribute(posAttr, i0 + 1);
    v2.fromBufferAttribute(posAttr, i0 + 2);

    edge1.subVectors(v1, v0);
    edge2.subVectors(v2, v0);
    normal.crossVectors(edge1, edge2);

    const area = normal.length() * 0.5;
    normal.normalize();

    // Flip normal to outward-facing using centroid direction from bbox center
    centroid.copy(v0).add(v1).add(v2).multiplyScalar(1 / 3);
    outward.copy(centroid).sub(meshCenter);
    if (normal.dot(outward) < 0) normal.negate();

    const key = `${quantize(normal.x)}_${quantize(normal.y)}_${quantize(normal.z)}`;
    normalAreas.set(key, (normalAreas.get(key) || 0) + area);
    if (!normalDirs.has(key)) normalDirs.set(key, normal.clone());
  }

  // Score each direction: area dominates (largest flat face down = OrcaSlicer-style).
  // Small downward bias (1%) only breaks ties between equal-area faces, so an
  // already-downward face wins over an upward one of the same size.
  let bestKey = '';
  let bestScore = -Infinity;
  for (const [key, area] of normalAreas) {
    const dir = normalDirs.get(key)!;
    const score = area * (1 - 0.01 * dir.y);
    if (score > bestScore) { bestScore = score; bestKey = key; }
  }

  if (!bestKey) return { x: 0, y: 0, z: 0 };

  const bestNormal = normalDirs.get(bestKey)!;
  if (bestNormal.y < -0.999) return { x: 0, y: 0, z: 0 };
  return rotationFromNormalToDown(bestNormal);
}

/**
 * Stable rotation (degrees XYZ) that maps `normal` to world-down (0,-1,0).
 * Handles the antiparallel case explicitly by rotating around the axis most
 * perpendicular to `normal`, avoiding `setFromUnitVectors` axis ambiguity.
 */
export function rotationFromNormalToDown(normal: THREE.Vector3): Rotation3D {
  const target = new THREE.Vector3(0, -1, 0);
  const dot = normal.dot(target);

  const quat = new THREE.Quaternion();
  if (dot <= -0.999999) {
    // 180° rotation: pick the world axis least aligned with `normal`
    const absX = Math.abs(normal.x);
    const absZ = Math.abs(normal.z);
    const axis = absX < absZ
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 0, 1);
    quat.setFromAxisAngle(axis, Math.PI);
  } else if (dot < 0.999999) {
    quat.setFromUnitVectors(normal, target);
  }
  // else ~identity

  const euler = new THREE.Euler().setFromQuaternion(quat);
  const rad2deg = 180 / Math.PI;
  return {
    x: Math.round(euler.x * rad2deg),
    y: Math.round(euler.y * rad2deg),
    z: Math.round(euler.z * rad2deg),
  };
}

/**
 * Apply per-face colors to a non-indexed BufferGeometry.
 * faceColors: Uint8Array of RGBA values, 4 bytes per face
 */
export function applyFaceColors(geometry: THREE.BufferGeometry, faceColors: Uint8Array) {
  const colorAttr = geometry.attributes.color as THREE.BufferAttribute;
  if (!colorAttr) return;

  const faceCount = Math.min(faceColors.length / 4, colorAttr.count / 3);
  const painted = (geometry.userData.paintedFaces as Set<number>) || new Set<number>();
  geometry.userData.paintedFaces = painted;

  for (let f = 0; f < faceCount; f++) {
    const a = faceColors[f * 4 + 3]; // alpha
    if (a === 0) continue; // skip unpainted

    const r = faceColors[f * 4] / 255;
    const g = faceColors[f * 4 + 1] / 255;
    const b = faceColors[f * 4 + 2] / 255;

    // Each face has 3 vertices in non-indexed geometry
    colorAttr.setXYZ(f * 3, r, g, b);
    colorAttr.setXYZ(f * 3 + 1, r, g, b);
    colorAttr.setXYZ(f * 3 + 2, r, g, b);
    painted.add(f);
  }
  colorAttr.needsUpdate = true;
}

/**
 * Extract face colors from geometry as compact Uint8Array (RGBA per face).
 */
export function extractFaceColors(geometry: THREE.BufferGeometry): Uint8Array {
  const colorAttr = geometry.attributes.color as THREE.BufferAttribute;
  if (!colorAttr) return new Uint8Array(0);

  const faceCount = colorAttr.count / 3;
  const faceColors = new Uint8Array(faceCount * 4);
  const painted = geometry.userData.paintedFaces as Set<number> | undefined;

  for (let f = 0; f < faceCount; f++) {
    // Read first vertex color (all 3 of a face should be same)
    faceColors[f * 4] = Math.round(colorAttr.getX(f * 3) * 255);
    faceColors[f * 4 + 1] = Math.round(colorAttr.getY(f * 3) * 255);
    faceColors[f * 4 + 2] = Math.round(colorAttr.getZ(f * 3) * 255);
    faceColors[f * 4 + 3] = painted?.has(f) ? 255 : 0;
  }

  return faceColors;
}
