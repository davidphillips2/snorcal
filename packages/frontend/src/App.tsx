import { useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { Scene, type SceneRefs } from './components/Viewer/Scene';
import { STLViewer, extractFaceColors, autoOrient, type Rotation3D } from './components/Viewer/STLViewer';
import { FacePainter, type PaintMode } from './components/Viewer/FacePainter';
import { ViewerToolbar } from './components/Viewer/ViewerToolbar';
import { AxisIndicator } from './components/Viewer/AxisIndicator';
import { ModelMover } from './components/Viewer/ModelMover';
import { ModelUploader } from './components/ModelUploader';
import { JobList } from './components/Jobs/JobList';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { PrinterSelect } from './components/PrinterSelect';
import { GcodePreviewCanvas } from './components/Viewer/GcodePreviewCanvas';
import { GcodeLayerSlider } from './components/Viewer/GcodeLayerSlider';
import { PRINTERS, getSavedPrinter, savePrinter } from './config/printers';
import { useSSE } from './hooks/useSSE';
import * as api from './api/client';

// --- Types ---

interface ProjectModel {
  modelId: string;
  name: string;
  faceCount: number;
  plateCount: number;
  plateId: string; // which plate this model belongs to
  rotation: Rotation3D;
  positionOffset: { x: number; y: number; z: number };
  faceColors: Uint8Array | null;
  visible: boolean;
}

interface Job {
  id: string;
  modelName?: string;
  engine: string;
  status: string;
  progress: number;
  currentStep?: string;
  gcodeSize?: number;
  estimatedTime?: string;
  filamentUsedG?: number;
  filamentCost?: number;
  errorMessage?: string;
  plateIndex?: number;
  createdAt: string;
}

// --- Persistence ---

interface PersistedState {
  plates: Array<{ id: string; name: string }>;
  activePlateId: string;
  models: Array<{
    modelId: string;
    name: string;
    faceCount: number;
    plateCount: number;
    plateId: string;
    rotation: Rotation3D;
    positionOffset: { x: number; y: number; z: number };
    visible: boolean;
  }>;
  activeModelIndex: number | null;
  engine: string;
  settings: Record<string, string>;
  selectedProfiles: { machine?: string; filament?: string; filament2?: string; process?: string };
  filamentSlots: Array<{ color: string; type: string; profile?: string }>;
  multiMaterial: { enabled: boolean; supportFilament: string; supportInterfaceFilament: string };
  printerIp: string;
}

function loadPersistedState(): PersistedState | null {
  try {
    const raw = localStorage.getItem('slorca_project');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function savePersistedState(state: PersistedState) {
  try {
    localStorage.setItem('slorca_project', JSON.stringify(state));
  } catch { /* localStorage full */ }
}

// --- App ---

export default function App() {
  const [isUploading, setIsUploading] = useState(false);
  const [sceneRefs, setSceneRefs] = useState<SceneRefs | null>(null);
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const sidebarUploadRef = useRef<HTMLInputElement>(null);
  const [paintMode, setPaintMode] = useState<PaintMode>('orbit');
  const [activeColor, setActiveColor] = useState('#FF0000');

  // Multi-model project state
  const persisted = useRef(loadPersistedState());
  const defaultPlateId = 'plate-1';
  const [plates, setPlates] = useState<Array<{ id: string; name: string }>>(() => persisted.current?.plates ?? [{ id: defaultPlateId, name: 'Plate 1' }]);
  const [activePlateId, setActivePlateId] = useState(() => persisted.current?.activePlateId ?? defaultPlateId);
  const [projectModels, setProjectModels] = useState<ProjectModel[]>([]);
  const [activeModelIndex, setActiveModelIndex] = useState<number | null>(null);

  // Models on the active plate
  const activePlateModels = projectModels.filter(m => m.plateId === activePlateId);

  // Printer
  const [printerId, setPrinterId] = useState<string | null>(() => getSavedPrinter()?.id ?? null);
  const printer = printerId ? PRINTERS.find(p => p.id === printerId) : null;

  // Slicer config
  const [jobs, setJobs] = useState<Job[]>([]);
  const [engine, setEngineRaw] = useState(() => persisted.current?.engine || localStorage.getItem('slorca_engine') || printer?.engine || 'orcaslicer');
  const setEngine = useCallback((e: string) => {
    localStorage.setItem('slorca_engine', e);
    setEngineRaw(e);
  }, []);
  const [settings, setSettings] = useState<Record<string, string>>(() => persisted.current?.settings || {});
  const [selectedProfiles, setSelectedProfiles] = useState(() => persisted.current?.selectedProfiles || {});
  const [filamentSlots, setFilamentSlots] = useState<Array<{ color: string; type: string; profile?: string }>>(() =>
    persisted.current?.filamentSlots || (() => { try { return JSON.parse(localStorage.getItem('slorca_filament_slots') || 'null'); } catch { return null; } })() || [{ color: '#FF0000', type: 'PLA' }]
  );
  const [printerIp, setPrinterIp] = useState(() => persisted.current?.printerIp || localStorage.getItem('slorca_printer_ip') || '');
  const [multiMaterial, setMultiMaterial] = useState(() =>
    persisted.current?.multiMaterial || (() => { try { return JSON.parse(localStorage.getItem('slorca_multi_material') || 'null'); } catch { return null; } })() || { enabled: false, supportFilament: '1', supportInterfaceFilament: '1' }
  );

  // UI
  const [showSidebar, setShowSidebar] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [showJobs, setShowJobs] = useState(false);

  // Gcode preview
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [gcodeText, setGcodeText] = useState<string | null>(null);
  const [currentPreviewLayer, setCurrentPreviewLayer] = useState(0);
  const [showAllLayers, setShowAllLayers] = useState(true);
  const [isParsingGcode, setIsParsingGcode] = useState(false);
  const [layerCount, setLayerCount] = useState(0);

  const handleLayerCountReady = useCallback((count: number) => {
    setLayerCount(count);
    setCurrentPreviewLayer(count - 1);
    setShowAllLayers(true);
  }, []);

  const { messages: sseMsgs } = useSSE('/api/events');

  // Load jobs on mount + restore project from persistence
  useEffect(() => {
    api.listJobs().then((data: any[]) => {
      setJobs(data.map(j => ({
        id: j.id, modelName: j.modelName, engine: j.engine, status: j.status,
        progress: j.progress, currentStep: j.currentStep, gcodeSize: j.gcodeSize,
        estimatedTime: j.estimatedTime, filamentUsedG: j.filamentUsedG,
        filamentCost: j.filamentCost, errorMessage: j.errorMessage, createdAt: j.createdAt,
      })));
    }).catch(console.error);

    // Restore project models
    const saved = persisted.current;
    if (saved && saved.models.length > 0) {
      const restored: ProjectModel[] = saved.models.map(m => ({
        ...m,
        plateId: m.plateId || defaultPlateId, // backwards compat
        faceColors: null, // will be fetched via effect below
      }));
      setProjectModels(restored);
      setActiveModelIndex(saved.activeModelIndex);
    }
    persisted.current = null; // only use once
  }, []);

  // Fetch face colors for each model on load
  useEffect(() => {
    for (const pm of projectModels) {
      if (pm.faceColors !== null) continue;
      api.getModelColors(pm.modelId).then(colors => {
        setProjectModels(prev => prev.map(p => p.modelId === pm.modelId ? { ...p, faceColors: colors } : p));
      }).catch(() => {});
    }
  }, [projectModels.length]); // re-run when models added

  // Load default settings when engine or printer changes
  useEffect(() => {
    if (printer) {
      setSelectedProfiles(printer.defaultProfiles);
      const presets: Record<string, string> = {};
      for (const [key, val] of Object.entries(printer.settings)) {
        if (typeof val === 'string') presets[key] = val;
      }
      setSettings(presets);
    } else {
      api.getDefaultSettings(engine).then((data) => {
        if (data?.process) setSettings(data.process);
      }).catch(console.error);
    }
  }, [engine, printer]);

  // Persist state on changes (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      savePersistedState({
        plates,
        activePlateId,
        models: projectModels.map(m => ({
          modelId: m.modelId, name: m.name, faceCount: m.faceCount, plateCount: m.plateCount,
          plateId: m.plateId, rotation: m.rotation, positionOffset: m.positionOffset, visible: m.visible,
        })),
        activeModelIndex,
        engine,
        settings,
        selectedProfiles,
        filamentSlots,
        multiMaterial,
        printerIp,
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [projectModels, plates, activePlateId, activeModelIndex, engine, settings, selectedProfiles, filamentSlots, multiMaterial, printerIp]);

  const handleSelectPrinter = useCallback((id: string) => {
    savePrinter(id);
    setPrinterId(id);
    const p = PRINTERS.find(pr => pr.id === id);
    if (p) setEngine(p.engine);
  }, []);

  // SSE updates
  useEffect(() => {
    for (const msg of sseMsgs) {
      const jobId = msg.data.jobId as string;
      if (!jobId) continue;
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? { ...j, status: msg.type === 'job:completed' ? 'completed' : msg.type === 'job:failed' ? 'failed' : 'running',
                progress: (msg.data.progress as number) ?? j.progress,
                currentStep: msg.data.currentStep as string | undefined,
                errorMessage: msg.data.error as string | undefined }
            : j
        ),
      );
    }
  }, [sseMsgs]);

  // Poll running jobs
  useEffect(() => {
    const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
    if (running.length === 0) return;
    const interval = setInterval(async () => {
      for (const job of running) {
        try {
          const updated = await api.getJob(job.id);
          setJobs((prev) => prev.map((j) => j.id === job.id ? {
            ...j, status: updated.status, progress: updated.progress, currentStep: updated.currentStep,
            errorMessage: updated.errorMessage, gcodeSize: updated.gcodeSize, modelName: updated.modelName,
            estimatedTime: updated.estimatedTime, filamentUsedG: updated.filamentUsedG, filamentCost: updated.filamentCost,
          } : j));
        } catch {}
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [jobs.length, jobs.filter((j) => j.status === 'running' || j.status === 'queued').length]);

  // Upload: add to project (not replace)
  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    try {
      const model = await api.uploadModel(file);
      // Auto-offset so new models don't overlap
      const offset = projectModels.length * 50;
      const newPm: ProjectModel = {
        modelId: model.id,
        name: model.name,
        faceCount: model.faceCount,
        plateCount: model.plateCount ?? 1,
        plateId: activePlateId,
        rotation: { x: 0, y: 0, z: 0 },
        positionOffset: { x: offset, y: 0, z: 0 },
        faceColors: null,
        visible: true,
      };
      setProjectModels(prev => [...prev, newPm]);
      setActiveModelIndex(projectModels.length); // select new model
    } catch (err) {
      alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsUploading(false);
    }
  }, [projectModels.length]);

  // Remove model from project
  const handleRemoveModel = useCallback((idx: number) => {
    setProjectModels(prev => prev.filter((_, i) => i !== idx));
    meshRefs.current = meshRefs.current.filter((_, i) => i !== idx);
    setActiveModelIndex(prev => {
      if (prev === null) return null;
      if (prev === idx) return prev > 0 ? prev - 1 : (prev < projectModels.length - 2 ? prev : null);
      return prev > idx ? prev - 1 : prev;
    });
  }, [projectModels.length]);

  // Slice: send first visible model (multi-model slicing to be added later)
  const saveAllColors = useCallback(async () => {
    for (let i = 0; i < projectModels.length; i++) {
      const mesh = meshRefs.current[i];
      const pm = projectModels[i];
      if (mesh && pm.visible && pm.plateId === activePlateId) {
        const colors = extractFaceColors(mesh.geometry);
        if (colors.length > 0) api.saveFaceColors(pm.modelId, colors).catch(() => {});
      }
    }
  }, [projectModels, activePlateId]);

  const sliceModels = useCallback(async (models: ProjectModel[]) => {
    if (models.length === 0) return;
    const processSettings: Record<string, string> = {};
    if (printer) { for (const [key, val] of Object.entries(printer.settings)) { if (typeof val === 'string') processSettings[key] = val; } }
    Object.assign(processSettings, settings);
    return api.submitSliceJob({
      models: models.map(pm => ({ modelId: pm.modelId, rotation: pm.rotation, positionOffset: pm.positionOffset })),
      engine,
      settings: { process: processSettings, machine: {}, filaments: [{}] },
      profiles: selectedProfiles,
      multiMaterial: multiMaterial.enabled ? multiMaterial : undefined,
      filamentSlots: filamentSlots.length > 1 ? filamentSlots : undefined,
      buildVolume: printer?.buildVolume,
    });
  }, [engine, settings, printer, selectedProfiles, multiMaterial, filamentSlots]);

  const handleSlicePlate = useCallback(async () => {
    const visible = activePlateModels.filter(m => m.visible);
    if (visible.length === 0) return;
    try {
      await saveAllColors();
      const result = await sliceModels(visible);
      if (result) {
        setJobs(prev => [{ id: result.jobId, engine, status: 'queued', progress: 0, createdAt: new Date().toISOString() }, ...prev]);
        setShowJobs(true);
      }
    } catch (err) {
      console.error('Slice failed:', err);
      alert(`Slice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activePlateModels, saveAllColors, sliceModels, engine]);

  const handleSliceAll = useCallback(async () => {
    const allVisible = projectModels.filter(m => m.visible);
    if (allVisible.length === 0) return;
    try {
      await saveAllColors();
      // One job per plate that has visible models
      const plateIds = [...new Set(allVisible.map(m => m.plateId))];
      for (const pid of plateIds) {
        const plateModels = allVisible.filter(m => m.plateId === pid);
        const result = await sliceModels(plateModels);
        if (result) {
          setJobs(prev => [{ id: result.jobId, engine, status: 'queued', progress: 0, createdAt: new Date().toISOString() }, ...prev]);
        }
      }
      setShowJobs(true);
    } catch (err) {
      console.error('Slice all failed:', err);
      alert(`Slice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [projectModels, saveAllColors, sliceModels, engine]);

  const handleSaveColors = useCallback(async () => {
    const idx = activeModelIndex;
    if (idx == null) return;
    const mesh = meshRefs.current[idx];
    const pm = projectModels[idx];
    if (!mesh || !pm) return;
    try {
      const colors = extractFaceColors(mesh.geometry);
      await api.saveFaceColors(pm.modelId, colors);
    } catch (err) { console.error('Save failed:', err); }
  }, [activeModelIndex, projectModels]);

  const handleUndo = useCallback(() => {
    const undo = (window as any).__slorca_undo as (() => void) | undefined;
    if (undo) undo();
  }, []);

  const handleCancelJob = useCallback(async (jobId: string) => {
    await api.cancelJob(jobId);
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'cancelled' } : j));
  }, []);

  const handleDownloadGcode = useCallback((jobId: string) => { window.open(api.getGcodeUrl(jobId), '_blank'); }, []);
  const handleDownloadThreemf = useCallback((jobId: string) => { window.open(api.getThreemfUrl(jobId), '_blank'); }, []);

  const handlePreviewJob = useCallback(async (jobId: string) => {
    setIsParsingGcode(true);
    setPreviewJobId(jobId);
    setGcodeText(null);
    setLayerCount(0);
    setShowSidebar(false);
    try {
      const response = await fetch(api.getGcodeUrl(jobId));
      const text = await response.text();
      setGcodeText(text);
      setIsParsingGcode(false);
    } catch { setIsParsingGcode(false); setPreviewJobId(null); }
  }, []);

  const handleSendToPrinter = useCallback(async (jobId: string) => {
    const ip = printerIp || prompt('Enter your printer IP address:');
    if (!ip) return;
    try {
      const result = await api.sendToPrinter(jobId, ip);
      alert(result?.message || 'Gcode sent to printer!');
      if (!printerIp) { setPrinterIp(ip); localStorage.setItem('slorca_printer_ip', ip); }
    } catch (err) { alert(`Send failed: ${err instanceof Error ? err.message : String(err)}`); }
  }, [printerIp]);

  const handleExitPreview = useCallback(() => { setPreviewJobId(null); setGcodeText(null); setCurrentPreviewLayer(0); setLayerCount(0); }, []);

  // Per-model geometry ready callback
  const [meshRevision, setMeshRevision] = useState(0);
  const handleGeometryReady = useCallback((idx: number, geometry: THREE.BufferGeometry, mesh: THREE.Mesh) => {
    meshRefs.current[idx] = mesh;
    setMeshRevision(prev => prev + 1); // force re-render so activeMesh updates
  }, []);

  // Fit camera to all visible meshes when geometry loads
  useEffect(() => {
    if (!sceneRefs || projectModels.length === 0) return;
    const visibleMeshes = projectModels
      .map((pm, i) => ({ pm, mesh: meshRefs.current[i] }))
      .filter(({ pm, mesh }) => pm.visible && mesh);
    if (visibleMeshes.length === 0) return;
    const box = new THREE.Box3();
    for (const { mesh } of visibleMeshes) {
      mesh!.updateMatrixWorld(true);
      box.expandByObject(mesh!);
    }
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = maxDim * 1.8;
    const cam = sceneRefs.camera;
    cam.position.set(center.x + distance, center.y + distance, center.z + distance);
    cam.lookAt(center);
    sceneRefs.controls.target.copy(center);
    sceneRefs.controls.update();
  }, [meshRevision, sceneRefs]); // only reframe when meshes load, not on position changes

  // Active model helpers — ensure active model is on active plate
  const activeModel = activeModelIndex != null && projectModels[activeModelIndex]?.plateId === activePlateId
    ? projectModels[activeModelIndex] : null;
  const activeMesh = activeModel != null ? meshRefs.current[activeModelIndex!] : null;

  const handleAutoOrient = useCallback(() => {
    if (!activeMesh || activeModelIndex == null) return;
    const newRotation = autoOrient(activeMesh.geometry);
    setProjectModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, rotation: newRotation } : p));
  }, [activeMesh, activeModelIndex]);

  const handleLayOnFace = useCallback((newRotation: Rotation3D) => {
    if (activeModelIndex == null) return;
    setProjectModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, rotation: newRotation } : p));
    setPaintMode('orbit');
  }, [activeModelIndex]);

  const handleRotationChange = useCallback((rotation: Rotation3D) => {
    if (activeModelIndex == null) return;
    setProjectModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, rotation } : p));
  }, [activeModelIndex]);

  const handlePositionChange = useCallback((pos: THREE.Vector3) => {
    if (activeModelIndex == null) return;
    const mesh = meshRefs.current[activeModelIndex];
    const rest = mesh?.userData?.restPosition as { x: number; y: number; z: number } | undefined;
    if (!rest) return;
    // pos is absolute mesh position; subtract rest (centering offset) to get pure user offset
    setProjectModels(prev => prev.map((p, i) => i === activeModelIndex ? {
      ...p,
      positionOffset: { x: pos.x - rest.x, y: pos.y - rest.y, z: pos.z - rest.z }
    } : p));
  }, [activeModelIndex]);

  const isSlicing = jobs.some(j => j.status === 'running' || j.status === 'queued');
  const hasVisibleModels = activePlateModels.some(m => m.visible);
  const hasVisibleOnAnyPlate = projectModels.some(m => m.visible);
  const plateCount = plates.length;

  // Orbit controls — right-click orbits in any mode, but disabled during active paint strokes
  const isPaintingRef = useRef(false);
  useEffect(() => {
    if (!sceneRefs) return;
    const isPaintMode = paintMode === 'paint' || paintMode === 'fill' || paintMode === 'lay';

    sceneRefs.controls.mouseButtons = {
      LEFT: paintMode === 'orbit' ? THREE.MOUSE.ROTATE : undefined,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: isPaintMode ? undefined : THREE.MOUSE.ROTATE,
    };

    // During paint/fill/lay, disable orbit entirely while left mouse is held
    if (isPaintMode) {
      const canvas = sceneRefs.renderer.domElement;
      const onDown = (e: PointerEvent) => { if (e.button === 0) { isPaintingRef.current = true; sceneRefs.controls.enabled = false; } };
      const onUp = () => { isPaintingRef.current = false; sceneRefs.controls.enabled = true; };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointerup', onUp);
      return () => {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        sceneRefs.controls.enabled = true;
        isPaintingRef.current = false;
      };
    } else {
      sceneRefs.controls.enabled = true;
      return () => { sceneRefs.controls.enabled = true; };
    }
  }, [sceneRefs, paintMode]);

  // Click-to-select: in orbit mode, click a mesh to select it as active model
  useEffect(() => {
    if (!sceneRefs || paintMode !== 'orbit' || activePlateModels.length <= 1) return;
    const { camera } = sceneRefs;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let downX = 0, downY = 0;

    const onPointerDown = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY; };
    const onPointerUp = (e: PointerEvent) => {
      // Only select on click (not drag)
      const dx = e.clientX - downX, dy = e.clientY - downY;
      if (dx * dx + dy * dy > 25) return;
      const rect = sceneRefs.renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      // Check all meshes, find closest hit
      let closestIdx = -1, closestDist = Infinity;
      for (let i = 0; i < meshRefs.current.length; i++) {
        const mesh = meshRefs.current[i];
        if (!mesh || !projectModels[i]?.visible || projectModels[i]?.plateId !== activePlateId) continue;
        const hits = raycaster.intersectObject(mesh);
        if (hits.length > 0 && hits[0].distance < closestDist) {
          closestDist = hits[0].distance;
          closestIdx = i;
        }
      }
      if (closestIdx >= 0 && closestIdx !== activeModelIndex) {
        setActiveModelIndex(closestIdx);
      }
    };
    const canvas = sceneRefs.renderer.domElement;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
    };
  }, [sceneRefs, paintMode, projectModels, activeModelIndex]);

  if (!printerId) return <PrinterSelect onSelect={handleSelectPrinter} />;

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-bold tracking-tight">Slorca</h1>
          {printer && (
            <button onClick={() => setPrinterId(null)} className="text-xs text-gray-400 hover:text-white bg-gray-700 px-2 py-0.5 rounded transition" title="Change printer">
              {printer.name}
            </button>
          )}
        </div>
      </div>

      {/* Scrollable */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Model list */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Models</label>
            <button
              onClick={() => sidebarUploadRef.current?.click()}
              disabled={isUploading}
              className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
              title="Upload model"
            >
              + Add
            </button>
            <input ref={sidebarUploadRef} type="file" accept=".stl,.step,.stp,.3mf"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ''; }}
              className="hidden" />
          </div>
          {activePlateModels.length === 0 ? (
            <ModelUploader onUpload={handleUpload} isUploading={isUploading} />
          ) : (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {activePlateModels.map((pm) => {
                const idx = projectModels.indexOf(pm);
                return (
                <div key={pm.modelId}
                  onClick={() => setActiveModelIndex(idx)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition text-sm ${
                    activeModelIndex === idx
                      ? 'bg-blue-600/20 text-blue-300 border border-blue-600/30'
                      : 'bg-gray-700/30 text-gray-300 hover:bg-gray-700/60 border border-transparent'
                  }`}>
                  <span className="truncate flex-1 text-xs">{pm.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRemoveModel(idx); }}
                    className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-500 hover:text-red-400 hover:bg-red-600/20 text-xs"
                    title="Remove"
                  >
                    &times;
                  </button>
                </div>
              );
            })}
            </div>
          )}
        </div>

        {/* Settings */}
        <div>
          <button onClick={() => setShowSettings(!showSettings)}
            className="w-full flex items-center justify-between text-xs font-medium text-gray-400 uppercase tracking-wider py-1">
            <span>Settings</span>
            <span className="text-gray-500 text-xs">{showSettings ? '\u2212' : '+'}</span>
          </button>
          {showSettings && (
            <SettingsPanel
              engine={engine} onEngineChange={setEngine} settings={settings} onSettingsChange={setSettings}
              selectedProfiles={selectedProfiles} onProfilesChange={setSelectedProfiles}
              multiMaterial={multiMaterial} onMultiMaterialChange={(mm) => { setMultiMaterial(mm); localStorage.setItem('slorca_multi_material', JSON.stringify(mm)); }}
              filamentSlots={filamentSlots} onFilamentSlotsChange={(slots) => { setFilamentSlots(slots); localStorage.setItem('slorca_filament_slots', JSON.stringify(slots)); }}
              printerIp={printerIp} onPrinterIpChange={(ip) => { setPrinterIp(ip); localStorage.setItem('slorca_printer_ip', ip); }}
            />
          )}
        </div>

        {/* Jobs */}
        <div>
          <button onClick={() => setShowJobs(!showJobs)}
            className="w-full flex items-center justify-between text-xs font-medium text-gray-400 uppercase tracking-wider py-1">
            <span>Jobs ({jobs.length})</span>
            <span className="text-gray-500 text-xs">{showJobs ? '\u2212' : '+'}</span>
          </button>
          {showJobs && (
            <div className="mt-2">
              <JobList jobs={jobs} onCancel={handleCancelJob} onDownload={handleDownloadGcode}
                onDownloadThreemf={handleDownloadThreemf} onPreview={handlePreviewJob} onSendToPrinter={handleSendToPrinter} />
            </div>
          )}
        </div>
      </div>

      {/* Plate tabs */}
      <div className="px-3 py-2 border-t border-gray-700 shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto">
          {plates.map((p, i) => (
            <button key={p.id}
              onClick={() => { setActivePlateId(p.id); setActiveModelIndex(null); }}
              className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition ${
                activePlateId === p.id ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}>
              {p.name}
              {plates.length > 1 && (
                <span className="ml-1 text-gray-400">{projectModels.filter(m => m.plateId === p.id).length}</span>
              )}
            </button>
          ))}
          <button onClick={() => {
            const n = plates.length + 1;
            const id = `plate-${Date.now()}`;
            setPlates(prev => [...prev, { id, name: `Plate ${n}` }]);
            setActivePlateId(id);
            setActiveModelIndex(null);
          }} className="px-2 py-1 rounded text-xs bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-white transition shrink-0">
            + Plate
          </button>
        </div>
      </div>

      {/* Slice buttons */}
      <div className="p-3 border-t border-gray-700 shrink-0 space-y-2">
        <button onClick={handleSlicePlate} disabled={isSlicing || !hasVisibleModels}
          className={`w-full py-2.5 rounded-lg font-semibold text-sm transition ${
            isSlicing || !hasVisibleModels ? 'bg-gray-600 text-gray-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-500'
          }`}>
          {isSlicing ? 'Slicing...' : 'Slice Plate'}
        </button>
        {plateCount > 1 && (
          <button onClick={handleSliceAll} disabled={isSlicing || !hasVisibleOnAnyPlate}
            className={`w-full py-2 rounded-lg text-sm transition ${
              isSlicing || !hasVisibleOnAnyPlate ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
            }`}>
            Slice All Plates
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-dvh flex bg-gray-900 text-white overflow-hidden">
      {showSidebar && <div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={() => setShowSidebar(false)} />}

      <aside className={`w-72 bg-gray-800 border-r border-gray-700 flex flex-col shrink-0
        fixed md:relative z-40 top-0 left-0 h-full transition-transform duration-200 ease-in-out
        ${showSidebar ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        {sidebarContent}
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden relative">
        {/* Mobile header */}
        <div className="md:hidden flex items-center gap-3 px-3 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
          <button onClick={() => setShowSidebar(!showSidebar)} className="p-1.5 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600 transition">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="text-sm font-bold">Slorca</span>
          {printer && <span className="text-xs text-gray-400 ml-auto">{printer.name}</span>}
        </div>

        {/* 3D Viewer */}
        <div className="flex-1 relative overflow-hidden">
          <Scene onReady={setSceneRefs} />

          {/* Multi-model STL viewers — only active plate */}
          {sceneRefs && !previewJobId && projectModels.filter(m => m.visible && m.plateId === activePlateId).map((pm, idx) => {
            const realIdx = projectModels.indexOf(pm);
            return (
              <STLViewer
                key={pm.modelId}
                modelUrl={api.getModelUrl(pm.modelId)}
                faceColors={pm.faceColors || undefined}
                rotation={pm.rotation}
                positionOffset={new THREE.Vector3(pm.positionOffset.x, pm.positionOffset.y, pm.positionOffset.z)}
                sceneRef={{ current: sceneRefs }}
                onGeometryReady={(geometry, mesh) => handleGeometryReady(realIdx, geometry, mesh)}
              />
            );
          })}

          {/* Active model interaction */}
          {sceneRefs && hasVisibleModels && !previewJobId && (
            <>
              <AxisIndicator sceneRefs={sceneRefs} />
              <ModelMover
                mesh={activeMesh}
                sceneRefs={sceneRefs}
                active={paintMode === 'orbit'}
                onPositionChange={handlePositionChange}
                onDragEnd={handlePositionChange}
              />
              <FacePainter
                mesh={activeMesh}
                renderer={sceneRefs.renderer}
                activeColor={activeColor}
                paintMode={paintMode}
                onLayOnFace={handleLayOnFace}
              />
              <ViewerToolbar
                paintMode={paintMode}
                onModeChange={setPaintMode}
                activeColor={activeColor}
                onColorChange={setActiveColor}
                onUndo={handleUndo}
                onSave={handleSaveColors}
                rotation={activeModel?.rotation || { x: 0, y: 0, z: 0 }}
                onRotationChange={handleRotationChange}
                onAutoOrient={handleAutoOrient}
                filamentColors={filamentSlots.map(s => s.color)}
              />
            </>
          )}

          {/* Gcode preview */}
          {previewJobId && gcodeText && (
            <>
              <GcodePreviewCanvas gcode={gcodeText} layer={currentPreviewLayer} singleLayerMode={!showAllLayers}
                extrusionColors={filamentSlots.map(s => s.color)} buildVolume={printer?.buildVolume} onLayerCountReady={handleLayerCountReady} />
              {layerCount > 0 && (
                <GcodeLayerSlider currentLayer={currentPreviewLayer} totalLayers={layerCount} showAllLayers={showAllLayers}
                  onLayerChange={setCurrentPreviewLayer} onShowAllLayersChange={setShowAllLayers} onExit={handleExitPreview} />
              )}
            </>
          )}
          {previewJobId && isParsingGcode && (
            <div className="absolute inset-0 flex items-center justify-center z-10 bg-gray-900/50">
              <div className="text-gray-300 text-sm">Parsing gcode...</div>
            </div>
          )}

          {/* Empty state — no models on active plate */}
          {!hasVisibleModels && !previewJobId && activePlateModels.length === 0 && projectModels.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-500 z-10 cursor-pointer"
              onClick={() => uploadInputRef.current?.click()}
              onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file && /\.(stl|step|stp|3mf)$/i.test(file.name)) handleUpload(file); }}
              onDragOver={(e) => e.preventDefault()}>
              <input ref={uploadInputRef} type="file" accept=".stl,.step,.stp,.3mf"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} className="hidden" />
              <div className="text-center px-4">
                <svg className="w-16 h-16 mx-auto mb-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                <p className="text-lg">Click or drop a file to upload</p>
                <p className="text-sm mt-1">Supports .stl, .step, .3mf</p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
