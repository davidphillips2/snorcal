import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

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
  sceneRef: React.MutableRefObject<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
  } | null>;
  onGeometryReady?: (geometry: THREE.BufferGeometry, mesh: THREE.Mesh) => void;
}

export function STLViewer({ modelUrl, faceColors, rotation, positionOffset, sceneRef, onGeometryReady }: STLViewerProps) {
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

        const material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          flatShading: true,
          side: THREE.DoubleSide,
          metalness: 0.1,
          roughness: 0.6,
        });

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
  }, [modelUrl]);

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
  }, [rotation, positionOffset]);

  return null; // This is a logic-only component, rendering happens in Scene
}

/**
 * Auto-orient: find the largest flat face and place it on the bottom (build plate).
 * Returns rotation in degrees { x, y, z } to apply.
 */
export function autoOrient(geometry: THREE.BufferGeometry): Rotation3D {
  const posAttr = geometry.attributes.position;
  const faceCount = posAttr.count / 3;

  // Quantize step for grouping similar normals
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

    const key = `${quantize(normal.x)}_${quantize(normal.y)}_${quantize(normal.z)}`;
    normalAreas.set(key, (normalAreas.get(key) || 0) + area);
    if (!normalDirs.has(key)) {
      normalDirs.set(key, normal.clone());
    }
  }

  // Find the normal with the largest area (best "bottom" candidate)
  let bestKey = '';
  let bestArea = 0;
  for (const [key, area] of normalAreas) {
    if (area > bestArea) {
      bestArea = area;
      bestKey = key;
    }
  }

  if (!bestKey) return { x: 0, y: 0, z: 0 };

  const bestNormal = normalDirs.get(bestKey)!;
  // We want this face on the bottom, so its normal should point DOWN (-Y)
  const targetDown = new THREE.Vector3(0, -1, 0);

  // If the normal already points down, no rotation needed
  if (bestNormal.y < -0.999) return { x: 0, y: 0, z: 0 };

  // Compute quaternion that rotates bestNormal to targetDown
  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(bestNormal, targetDown);

  // Convert to Euler
  const euler = new THREE.Euler();
  euler.setFromQuaternion(quat);

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
