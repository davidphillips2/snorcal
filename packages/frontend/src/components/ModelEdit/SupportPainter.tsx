import { useEffect } from 'react';
import * as THREE from 'three';
import type { SceneRefs } from '../Viewer/Scene';
import type { ProjectModel } from '../../App';
import { geometryToSTL } from '../../lib/stl-export';

interface SupportPainterProps {
  sceneRefs: SceneRefs | null;
  /** Visible meshes to raycast against (same list MeasureTool uses). */
  meshes: THREE.Mesh[];
  /** Project models parallel to `meshes` — used to resolve the parent modelId. */
  projectModels: ProjectModel[];
  active: boolean;
  pillarDiameter: number;
  /** Called with the generated pillar STL and the parent model's modelId. */
  onAdd: (file: File, parentModelId: string, positionOffset: { x: number; y: number; z: number }) => void;
}

/**
 * Click any visible mesh → drop a cylindrical support pillar from the hit
 * point straight down to the bed. Generates a centered STL and hands it to
 * the parent for upload. Position offset = hit world XZ so the pillar lines
 * up under the click.
 */
export function SupportPainter({
  sceneRefs, meshes, projectModels, active, pillarDiameter, onAdd,
}: SupportPainterProps) {
  useEffect(() => {
    if (!active || !sceneRefs) return;
    const { camera, renderer } = sceneRefs;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const canvas = renderer.domElement;
    canvas.style.cursor = 'crosshair';
    canvas.style.touchAction = 'none';

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      // Closest hit among all visible meshes
      let closestDist = Infinity;
      let closestPoint: THREE.Vector3 | null = null;
      let closestIdx = -1;
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        if (!mesh || !projectModels[i]?.visible) continue;
        const hits = raycaster.intersectObject(mesh);
        if (hits.length > 0 && hits[0].distance < closestDist) {
          closestDist = hits[0].distance;
          closestPoint = hits[0].point.clone();
          closestIdx = i;
        }
      }
      if (!closestPoint || closestIdx === -1) return;

      const parent = projectModels[closestIdx];
      if (!parent) return;

      // Pillar height = hit Y (down to bed at Y=0). Min 1mm to avoid degenerate geo.
      const height = Math.max(1, closestPoint.y);
      const radius = pillarDiameter / 2;
      const geo = new THREE.CylinderGeometry(radius, radius, height, 24);
      // Cylinder is centered on origin along Y; translate so its base sits at Y=0
      geo.translate(0, height / 2, 0);
      geo.computeVertexNormals();

      const file = geometryToSTL(geo, new THREE.Matrix4(), `support_${Date.now()}.stl`);
      onAdd(file, parent.modelId, {
        x: closestPoint.x,
        y: 0,
        z: closestPoint.z,
      });
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.style.cursor = 'grab';
      canvas.style.touchAction = '';
    };
  }, [active, sceneRefs, meshes, projectModels, pillarDiameter, onAdd]);

  return null;
}
