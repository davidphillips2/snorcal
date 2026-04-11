import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { SceneRefs } from './Scene';

interface AxisIndicatorProps {
  sceneRefs: SceneRefs;
}

// BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
// After Y↔Z swap: Three.js +Y = printing Z-up (Top), Three.js +Z = printing +Y (Back)
const FACE_INFO = [
  { label: 'Left',   color: 0x773333, hover: 0xcc5555 },
  { label: 'Right',  color: 0x884444, hover: 0xdd7777 },
  { label: 'Top',    color: 0x445588, hover: 0x7799dd },
  { label: 'Bottom', color: 0x334477, hover: 0x5577bb },
  { label: 'Back',   color: 0x448844, hover: 0x77cc77 },
  { label: 'Front',  color: 0x337733, hover: 0x55bb55 },
];

function createFaceTexture(label: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#666';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, 248, 248);
  ctx.font = 'bold 56px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#eee';
  ctx.fillText(label, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 32, 32);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.35, 0.35, 1);
  return sprite;
}

interface HitRegion {
  type: 'face' | 'edge' | 'corner';
  faceIndices: number[];
}

export function AxisIndicator({ sceneRefs }: AxisIndicatorProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const size = 200;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(size, size);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);
    const canvas = renderer.domElement;

    const scene = new THREE.Scene();
    const d = 1.6;
    const camera = new THREE.OrthographicCamera(-d, d, d, -d, 0.1, 100);
    camera.position.set(0, 0, 5);

    // Cube with labeled faces
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const materials = FACE_INFO.map(info =>
      new THREE.MeshBasicMaterial({ map: createFaceTexture(info.label), transparent: true, opacity: 0.92 })
    );
    const cube = new THREE.Mesh(boxGeo, materials);
    scene.add(cube);

    // Edge lines
    scene.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(boxGeo),
      new THREE.LineBasicMaterial({ color: 0xbbbbbb }),
    ));

    // Axis lines extending from Front-Left-Bottom corner (-X, -Y, -Z)
    // In 3D printing convention: X=red right, Y=green depth, Z=blue up
    // After swap: Three.js +Y = up = printing Z, Three.js +Z = depth = printing Y
    const axisLines: { dir: THREE.Vector3; color: number; label: string; labelColor: string }[] = [
      { dir: new THREE.Vector3(-1, 0, 0), color: 0xee3333, label: 'X', labelColor: '#ee3333' },
      { dir: new THREE.Vector3(0, 1, 0), color: 0x3388ee, label: 'Z', labelColor: '#3388ee' },  // +Y = Z-up
      { dir: new THREE.Vector3(0, 0, 1), color: 0x33cc33, label: 'Y', labelColor: '#33cc33' },  // +Z = Y-depth
    ];

    const corner = new THREE.Vector3(0.5, -0.5, -0.5); // Front-Left-Bottom
    for (const ax of axisLines) {
      // Line from corner extending outward
      const points = [corner.clone(), corner.clone().add(ax.dir.clone().multiplyScalar(1.2))];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({ color: ax.color, linewidth: 2 });
      scene.add(new THREE.Line(lineGeo, lineMat));

      // Arrowhead cone
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.06, 0.18, 8),
        new THREE.MeshBasicMaterial({ color: ax.color })
      );
      const tipPos = corner.clone().add(ax.dir.clone().multiplyScalar(1.2));
      cone.position.copy(tipPos);
      // Rotate cone to point along axis
      if (ax.dir.x === 1) cone.rotation.set(0, 0, -Math.PI / 2);
      else if (ax.dir.y === 1) cone.rotation.set(0, 0, 0);
      else cone.rotation.set(Math.PI / 2, 0, 0);
      scene.add(cone);

      // Label sprite
      const label = makeLabel(ax.label, ax.labelColor);
      label.position.copy(corner.clone().add(ax.dir.clone().multiplyScalar(1.5)));
      scene.add(label);
    }

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Analyze hit point to find region (face / edge / corner) and affected face indices
    const getHitRegion = (localPoint: THREE.Vector3): HitRegion | null => {
      const threshold = 0.2;
      const axes = [localPoint.x, localPoint.y, localPoint.z];
      const near = axes.map(v => Math.abs(v) > (0.5 - threshold));

      // Face indices: +X=0, -X=1, +Y=2, -Y=3, +Z=4, -Z=5
      const faceForAxis = (axis: number, sign: number) => axis * 2 + (sign > 0 ? 0 : 1);
      const faces: number[] = [];
      for (let i = 0; i < 3; i++) {
        if (near[i]) faces.push(faceForAxis(i, axes[i] > 0 ? 1 : -1));
      }
      if (faces.length === 0) return null;

      const type = faces.length === 1 ? 'face' : faces.length === 2 ? 'edge' : 'corner';
      return { type, faceIndices: faces };
    };

    const getSnapDirection = (localPoint: THREE.Vector3): THREE.Vector3 => {
      const threshold = 0.2;
      const axes = [localPoint.x, localPoint.y, localPoint.z];
      const near = axes.map(v => Math.abs(v) > (0.5 - threshold));
      const dir = new THREE.Vector3();
      for (let i = 0; i < 3; i++) {
        if (near[i]) dir.setComponent(i, axes[i] > 0 ? 1 : -1);
      }
      return dir.normalize();
    };

    const snapCameraTo = (direction: THREE.Vector3) => {
      const { camera: mainCamera, controls } = sceneRefs;
      const target = controls.target.clone();
      const distance = mainCamera.position.distanceTo(target);
      const dest = target.clone().add(direction.clone().normalize().multiplyScalar(distance));
      const startPos = mainCamera.position.clone();
      const startTime = performance.now();
      const duration = 300;

      const animateSnap = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        mainCamera.position.lerpVectors(startPos, dest, ease);
        controls.update();
        if (t < 1) requestAnimationFrame(animateSnap);
      };
      requestAnimationFrame(animateSnap);
    };

    const updateMouse = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const onClick = (event: MouseEvent) => {
      updateMouse(event);
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObject(cube);
      if (intersects.length > 0) {
        const localPt = cube.worldToLocal(intersects[0].point.clone());
        const dir = getSnapDirection(localPt);
        if (dir.lengthSq() > 0) snapCameraTo(dir);
      }
    };

    // Hover highlighting
    let highlightedFaces = new Set<number>();

    const highlightFaces = (indices: number[]) => {
      // Reset old
      for (const fi of highlightedFaces) {
        materials[fi].color.setHex(0xffffff);
        materials[fi].opacity = 0.92;
      }
      highlightedFaces.clear();
      // Set new
      for (const fi of indices) {
        materials[fi].color.setHex(FACE_INFO[fi].hover);
        materials[fi].opacity = 1.0;
      }
      highlightedFaces = new Set(indices);
    };

    const clearHighlight = () => {
      for (const fi of highlightedFaces) {
        materials[fi].color.setHex(0xffffff);
        materials[fi].opacity = 0.92;
      }
      highlightedFaces.clear();
    };

    const onPointerMove = (event: MouseEvent) => {
      updateMouse(event);
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObject(cube);

      if (intersects.length > 0) {
        const localPt = cube.worldToLocal(intersects[0].point.clone());
        const region = getHitRegion(localPt);
        if (region) {
          highlightFaces(region.faceIndices);
          canvas.style.cursor = 'pointer';
          return;
        }
      }
      clearHighlight();
      canvas.style.cursor = 'default';
    };

    const onPointerLeave = () => {
      clearHighlight();
      canvas.style.cursor = 'default';
    };

    canvas.addEventListener('click', onClick);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);

    // Animation loop
    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      scene.quaternion.copy(sceneRefs.camera.quaternion).invert();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      renderer.dispose();
      materials.forEach(m => { m.map?.dispose(); m.dispose(); });
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, [sceneRefs]);

  return (
    <div
      ref={containerRef}
      className="absolute top-3 left-3 z-10"
      style={{ width: 200, height: 200 }}
    />
  );
}
