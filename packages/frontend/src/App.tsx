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

interface Model {
  id: string;
  name: string;
  format: string;
  faceCount: number;
  fileSize: number;
  plateCount?: number;
  createdAt: string;
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

export default function App() {
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Three.js refs — only set once Scene reports ready
  const [sceneRefs, setSceneRefs] = useState<SceneRefs | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [paintMode, setPaintMode] = useState<PaintMode>('orbit');
  const [activeColor, setActiveColor] = useState('#FF0000');
  const [faceColors, setFaceColors] = useState<Uint8Array | null>(null);
  const [rotation, setRotation] = useState<Rotation3D>({ x: 0, y: 0, z: 0 });
  const [positionOffset, setPositionOffset] = useState<THREE.Vector3 | null>(null);
  const [selectedPlate, setSelectedPlate] = useState(1);
  const [plateCount, setPlateCount] = useState(1);

  // Printer selection — persisted in localStorage
  const [printerId, setPrinterId] = useState<string | null>(() => getSavedPrinter()?.id ?? null);
  const printer = printerId ? PRINTERS.find(p => p.id === printerId) : null;

  const [jobs, setJobs] = useState<Job[]>([]);
  const [engine, setEngineRaw] = useState(() => localStorage.getItem('slorca_engine') || printer?.engine || 'orcaslicer');
  const setEngine = useCallback((e: string) => {
    localStorage.setItem('slorca_engine', e);
    setEngineRaw(e);
  }, []);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [selectedProfiles, setSelectedProfiles] = useState<{
    machine?: string; filament?: string; filament2?: string; process?: string;
  }>({});
  const [filamentSlots, setFilamentSlots] = useState<Array<{ color: string; type: string; profile?: string }>>(() => {
    try {
      const saved = localStorage.getItem('slorca_filament_slots');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [{ color: '#FF0000', type: 'PLA' }];
  });
  const [printerIp, setPrinterIp] = useState(() => localStorage.getItem('slorca_printer_ip') || '');
  const [multiMaterial, setMultiMaterial] = useState<{
    enabled: boolean; supportFilament: string; supportInterfaceFilament: string;
  }>(() => {
    try {
      const saved = localStorage.getItem('slorca_multi_material');
      return saved ? JSON.parse(saved) : { enabled: false, supportFilament: '1', supportInterfaceFilament: '1' };
    } catch { return { enabled: false, supportFilament: '1', supportInterfaceFilament: '1' }; }
  });

  // Mobile panel toggles
  const [showLeftPanel, setShowLeftPanel] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [showJobsPanel, setShowJobsPanel] = useState(false);

  // Gcode preview state
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

  // SSE
  const { messages: sseMsgs } = useSSE('/api/events');

  // Load models and jobs on mount
  useEffect(() => {
    api.listModels().then(setModels).catch(console.error);
    api.listJobs().then((data: any[]) => {
      setJobs(data.map(j => ({
        id: j.id,
        modelName: j.modelName,
        engine: j.engine,
        status: j.status,
        progress: j.progress,
        currentStep: j.currentStep,
        gcodeSize: j.gcodeSize,
        estimatedTime: j.estimatedTime,
        filamentUsedG: j.filamentUsedG,
        filamentCost: j.filamentCost,
        errorMessage: j.errorMessage,
        createdAt: j.createdAt,
      })));
    }).catch(console.error);
  }, []);

  // Fetch face colors when selecting a model or plate
  useEffect(() => {
    if (!selectedModelId) { setFaceColors(null); return; }
    setFaceColors(null);
    api.getModelColors(selectedModelId, selectedPlate).then(colors => {
      setFaceColors(colors);
      // Auto-import unique painted colors into filament slots
      if (colors) {
        const uniqueColors: string[] = [];
        const seen = new Set<string>();
        let hasUnpainted = false;
        for (let i = 0; i < colors.length; i += 4) {
          if (colors[i + 3] === 0) { hasUnpainted = true; continue; }
          const hex = '#' + [colors[i], colors[i + 1], colors[i + 2]]
            .map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
          if (!seen.has(hex)) {
            seen.add(hex);
            uniqueColors.push(hex);
          }
        }
        const needsSlots = uniqueColors.length > 1 || (uniqueColors.length === 1 && hasUnpainted);
        if (needsSlots) {
          setFilamentSlots(prev => {
            let newSlots: Array<{ color: string; type: string; profile?: string }>;
            if (hasUnpainted) {
              // Slot 0 = default/unpainted extruder, painted colors fill remaining slots
              newSlots = [{ color: prev[0]?.color ?? '#FFFFFF', type: prev[0]?.type ?? 'PLA', profile: prev[0]?.profile }];
              for (const color of uniqueColors) {
                newSlots.push({ color, type: 'PLA', profile: undefined });
              }
            } else {
              // All faces painted — map colors directly to slots
              newSlots = uniqueColors.map((color, idx) => ({
                color,
                type: prev[idx]?.type ?? 'PLA',
                profile: prev[idx]?.profile,
              }));
            }
            localStorage.setItem('slorca_filament_slots', JSON.stringify(newSlots));
            return newSlots;
          });
        }
      }
    }).catch(() => setFaceColors(null));
  }, [selectedModelId, selectedPlate]);

  // Load default settings when engine or printer changes
  useEffect(() => {
    if (printer) {
      setSelectedProfiles(printer.defaultProfiles);
      // Use printer preset defaults
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
            ? {
                ...j,
                status: msg.type === 'job:completed' ? 'completed' : msg.type === 'job:failed' ? 'failed' : 'running',
                progress: (msg.data.progress as number) ?? j.progress,
                currentStep: msg.data.currentStep as string | undefined,
                errorMessage: msg.data.error as string | undefined,
              }
            : j,
        ),
      );
    }
  }, [sseMsgs]);

  // Poll running jobs for progress (fallback when SSE is unavailable)
  useEffect(() => {
    const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
    if (running.length === 0) return;

    const interval = setInterval(async () => {
      for (const job of running) {
        try {
          const updated = await api.getJob(job.id);
          setJobs((prev) =>
            prev.map((j) =>
              j.id === job.id
                ? {
                    ...j,
                    status: updated.status,
                    progress: updated.progress,
                    currentStep: updated.currentStep,
                    errorMessage: updated.errorMessage,
                    gcodeSize: updated.gcodeSize,
                    modelName: updated.modelName,
                    estimatedTime: updated.estimatedTime,
                    filamentUsedG: updated.filamentUsedG,
                    filamentCost: updated.filamentCost,
                  }
                : j,
            ),
          );
        } catch {}
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [jobs.length, jobs.filter((j) => j.status === 'running' || j.status === 'queued').length]);

  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    try {
      const model = await api.uploadModel(file);
      setModels((prev) => [
        { id: model.id, name: model.name, format: 'stl', faceCount: model.faceCount, fileSize: 0, plateCount: model.plateCount, createdAt: new Date().toISOString() },
        ...prev,
      ]);
      setSelectedModelId(model.id);
      setPlateCount(model.plateCount ?? 1);
      setSelectedPlate(1);
    } catch (err) {
      alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsUploading(false);
    }
  }, []);

  const handleSlice = useCallback(async () => {
    if (!selectedModelId) return;
    try {
      // Save colors in background — don't block slicing
      if (meshRef.current) {
        const colors = extractFaceColors(meshRef.current.geometry);
        if (colors.length > 0) {
          api.saveFaceColors(selectedModelId, colors, selectedPlate).catch(() => {});
        }
      }
      // Build process settings: printer defaults + UI overrides
      const processSettings: Record<string, string> = {};
      if (printer) {
        for (const [key, val] of Object.entries(printer.settings)) {
          if (typeof val === 'string') processSettings[key] = val;
        }
      }
      // UI overrides take precedence
      Object.assign(processSettings, settings);

      const result = await api.submitSliceJob({
        modelId: selectedModelId,
        engine,
        plateIndex: selectedPlate,
        settings: { process: processSettings, machine: {}, filaments: [{}] },
        profiles: selectedProfiles,
        multiMaterial: multiMaterial.enabled ? multiMaterial : undefined,
        filamentSlots: filamentSlots.length > 1 ? filamentSlots : undefined,
        rotation,
        positionOffset: positionOffset ? { x: positionOffset.x, y: positionOffset.y, z: positionOffset.z } : undefined,
        buildVolume: printer?.buildVolume,
      });
      setJobs((prev) => [
        { id: result.jobId, engine, status: 'queued', progress: 0, createdAt: new Date().toISOString() },
        ...prev,
      ]);
      // Auto-switch to Jobs panel on mobile
      setShowLeftPanel(false);
      setShowRightPanel(false);
      setShowJobsPanel(true);
    } catch (err) {
      console.error('Slice failed:', err);
      alert(`Slice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selectedModelId, engine, settings, printer, selectedProfiles, selectedPlate, multiMaterial, filamentSlots, rotation, positionOffset]);

  const handleSliceAll = useCallback(async () => {
    if (!selectedModelId || plateCount <= 1) return;
    try {
      const processSettings: Record<string, string> = {};
      if (printer) {
        for (const [key, val] of Object.entries(printer.settings)) {
          if (typeof val === 'string') processSettings[key] = val;
        }
      }
      Object.assign(processSettings, settings);

      const newJobs: Job[] = [];
      for (let p = 1; p <= plateCount; p++) {
        const result = await api.submitSliceJob({
          modelId: selectedModelId,
          engine,
          plateIndex: p,
          settings: { process: processSettings, machine: {}, filaments: [{}] },
          profiles: selectedProfiles,
          multiMaterial: multiMaterial.enabled ? multiMaterial : undefined,
          filamentSlots: filamentSlots.length > 1 ? filamentSlots : undefined,
          rotation,
          positionOffset: positionOffset ? { x: positionOffset.x, y: positionOffset.y, z: positionOffset.z } : undefined,
          buildVolume: printer?.buildVolume,
        });
        newJobs.push({ id: result.jobId, engine, status: 'queued', progress: 0, plateIndex: p, createdAt: new Date().toISOString() });
      }
      setJobs((prev) => [...newJobs, ...prev]);
      setShowLeftPanel(false);
      setShowRightPanel(false);
      setShowJobsPanel(true);
    } catch (err) {
      console.error('Slice all failed:', err);
      alert(`Slice all failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selectedModelId, engine, settings, printer, selectedProfiles, plateCount, multiMaterial, filamentSlots, rotation, positionOffset]);

  const handleSaveColors = useCallback(async () => {
    if (!selectedModelId || !meshRef.current) return;
    try {
      const colors = extractFaceColors(meshRef.current.geometry);
      await api.saveFaceColors(selectedModelId, colors, selectedPlate);
    } catch (err) {
      console.error('Save failed:', err);
    }
  }, [selectedModelId, selectedPlate]);

  const handleUndo = useCallback(() => {
    const undo = (window as any).__slorca_undo as (() => void) | undefined;
    if (undo) undo();
  }, []);

  const handleCancelJob = useCallback(async (jobId: string) => {
    await api.cancelJob(jobId);
    setJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, status: 'cancelled' } : j));
  }, []);

  const handleDownloadGcode = useCallback((jobId: string) => {
    window.open(api.getGcodeUrl(jobId), '_blank');
  }, []);

  const handlePreviewJob = useCallback(async (jobId: string) => {
    setIsParsingGcode(true);
    setPreviewJobId(jobId);
    setGcodeText(null);
    setLayerCount(0);
    // Close sidebars
    setShowLeftPanel(false);
    setShowRightPanel(false);
    setShowJobsPanel(false);
    try {
      const response = await fetch(api.getGcodeUrl(jobId));
      const text = await response.text();
      setGcodeText(text);
      setIsParsingGcode(false);
    } catch {
      setIsParsingGcode(false);
      setPreviewJobId(null);
    }
  }, [sceneRefs]);

  const handleSendToPrinter = useCallback(async (jobId: string) => {
    const ip = printerIp || prompt('Enter your printer IP address:');
    if (!ip) return;
    try {
      const result = await api.sendToPrinter(jobId, ip);
      alert(result?.message || 'Gcode sent to printer!');
      if (!printerIp) {
        setPrinterIp(ip);
        localStorage.setItem('slorca_printer_ip', ip);
      }
    } catch (err) {
      alert(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [printerIp]);

  const handleExitPreview = useCallback(() => {
    setPreviewJobId(null);
    setGcodeText(null);
    setCurrentPreviewLayer(0);
    setLayerCount(0);
  }, []);

  const handleGeometryReady = useCallback((geometry: THREE.BufferGeometry, mesh: THREE.Mesh) => {
    meshRef.current = mesh;
    setRotation({ x: 0, y: 0, z: 0 });
    setPositionOffset(null);
  }, []);

  const handleAutoOrient = useCallback(() => {
    if (!meshRef.current) return;
    const newRotation = autoOrient(meshRef.current.geometry);
    setRotation(newRotation);
  }, []);

  const handleLayOnFace = useCallback((newRotation: Rotation3D) => {
    setRotation(newRotation);
    setPaintMode('orbit');
  }, []);

  const modelUrl = selectedModelId ? api.getModelUrl(selectedModelId, selectedPlate) : null;

  const closeMobilePanels = useCallback(() => {
    setShowLeftPanel(false);
    setShowRightPanel(false);
    setShowJobsPanel(false);
  }, []);

  // Disable orbit controls when painting
  useEffect(() => {
    if (sceneRefs && (paintMode === 'paint' || paintMode === 'fill' || paintMode === 'lay')) {
      sceneRefs.controls.enabled = false;
      return () => { sceneRefs.controls.enabled = true; };
    }
  }, [sceneRefs, paintMode]);

  // Show printer selection on first visit
  if (!printerId) {
    return <PrinterSelect onSelect={handleSelectPrinter} />;
  }

  return (
    <div className="h-dvh flex flex-col bg-gray-900 text-white overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-tight">Slorca</h1>
          {printer && (
            <button
              onClick={() => setPrinterId(null)}
              className="text-xs text-gray-400 hover:text-white bg-gray-700 px-2 py-0.5 rounded transition"
              title="Change printer"
            >
              {printer.name}
            </button>
          )}
        </div>
        <span className="text-xs text-gray-500 hidden sm:inline">Self-Hosted 3D Slicing Hub</span>
        {/* Panel toggles */}
        <div className="flex gap-2">
          <button
            onClick={() => { setShowLeftPanel(!showLeftPanel); setShowRightPanel(false); setShowJobsPanel(false); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${showLeftPanel ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            Models
          </button>
          <button
            onClick={() => { setShowJobsPanel(!showJobsPanel); setShowRightPanel(false); setShowLeftPanel(false); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${showJobsPanel ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            Jobs
          </button>
          <button
            onClick={() => { setShowRightPanel(!showRightPanel); setShowLeftPanel(false); setShowJobsPanel(false); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${showRightPanel ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            Settings
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Backdrop */}
        {(showLeftPanel || showRightPanel || showJobsPanel) && (
          <div
            className="fixed inset-0 bg-black/50 z-10"
            onClick={closeMobilePanels}
          />
        )}

        {/* Left sidebar */}
        <div className={`
          w-72 bg-gray-800 border-r border-gray-700 flex flex-col overflow-hidden shrink-0
          absolute z-20 top-0 left-0 h-full
          transition-transform duration-200 ease-in-out
          ${showLeftPanel ? 'translate-x-0' : '-translate-x-full pointer-events-none'}
        `}>
          <div className="p-3 space-y-3 overflow-y-auto flex-1">
            <ModelUploader onUpload={handleUpload} isUploading={isUploading} />

            {models.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">Models</h3>
                {models.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setSelectedModelId(m.id);
                      setPlateCount(m.plateCount ?? 1);
                      setSelectedPlate(1);
                      setShowLeftPanel(false);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                      selectedModelId === m.id
                        ? 'bg-blue-600/20 text-blue-300 border border-blue-600/30'
                        : 'bg-gray-700/50 text-gray-300 hover:bg-gray-700'
                    }`}
                  >
                    <div className="font-medium truncate">{m.name}</div>
                    <div className="text-xs text-gray-500">{m.faceCount.toLocaleString()} faces</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Center: 3D Viewer — Scene is always mounted */}
        <div className="flex-1 relative overflow-hidden">
          <Scene onReady={setSceneRefs} />
          {plateCount > 1 && modelUrl && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 bg-gray-800/90 rounded-lg px-3 py-1.5 border border-gray-600">
              <span className="text-xs text-gray-400">Plate:</span>
              {Array.from({ length: plateCount }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  onClick={() => setSelectedPlate(p)}
                  className={`w-7 h-7 rounded text-xs font-medium transition ${
                    selectedPlate === p
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
          {sceneRefs && modelUrl && !previewJobId && (
            <>
              <AxisIndicator sceneRefs={sceneRefs} />
              <STLViewer
                modelUrl={modelUrl}
                faceColors={faceColors || undefined}
                rotation={rotation}
                positionOffset={positionOffset || undefined}
                sceneRef={{ current: sceneRefs }}
                onGeometryReady={handleGeometryReady}
              />
              <ModelMover
                mesh={meshRef.current}
                sceneRefs={sceneRefs}
                active={paintMode === 'orbit'}
                onPositionChange={setPositionOffset}
              />
              <FacePainter
                mesh={meshRef.current}
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
                rotation={rotation}
                onRotationChange={setRotation}
                onAutoOrient={handleAutoOrient}
                filamentColors={filamentSlots.map(s => s.color)}
              />
            </>
          )}
          {/* Gcode preview mode */}
          {previewJobId && gcodeText && (
            <>
              <GcodePreviewCanvas
                gcode={gcodeText}
                layer={currentPreviewLayer}
                singleLayerMode={!showAllLayers}
                extrusionColors={filamentSlots.map(s => s.color)}
                buildVolume={printer?.buildVolume}
                onLayerCountReady={handleLayerCountReady}
              />
              {layerCount > 0 && (
                <GcodeLayerSlider
                  currentLayer={currentPreviewLayer}
                  totalLayers={layerCount}
                  showAllLayers={showAllLayers}
                  onLayerChange={setCurrentPreviewLayer}
                  onShowAllLayersChange={setShowAllLayers}
                  onExit={handleExitPreview}
                />
              )}
            </>
          )}
          {previewJobId && isParsingGcode && (
            <div className="absolute inset-0 flex items-center justify-center z-10 bg-gray-900/50">
              <div className="text-gray-300 text-sm">Parsing gcode...</div>
            </div>
          )}
          {!modelUrl && !previewJobId && (
            <div
              className="absolute inset-0 flex items-center justify-center text-gray-500 z-10 cursor-pointer"
              onClick={() => uploadInputRef.current?.click()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file && /\.(stl|step|stp|3mf)$/i.test(file.name)) handleUpload(file);
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              <input
                ref={uploadInputRef}
                type="file"
                accept=".stl,.step,.stp,.3mf"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
                className="hidden"
              />
              <div className="text-center px-4">
                <div className="text-6xl mb-4">&#9881;</div>
                <p className="text-lg">Click or drop a file to upload</p>
                <p className="text-sm mt-1">Supports .stl, .step, .3mf</p>
              </div>
            </div>
          )}
        </div>

        {/* Jobs slide-in panel */}
        <div className={`
          w-80 bg-gray-800 border-l border-gray-700 overflow-y-auto shrink-0
          absolute z-20 top-0 right-0 h-full
          transition-transform duration-200 ease-in-out
          ${showJobsPanel ? 'translate-x-0' : 'translate-x-full pointer-events-none'}
        `}>
          <div className="p-4">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Jobs</h3>
            <JobList jobs={jobs} onCancel={handleCancelJob} onDownload={handleDownloadGcode} onPreview={handlePreviewJob} onSendToPrinter={handleSendToPrinter} />
          </div>
        </div>

        {/* Right sidebar */}
        <div className={`
          w-80 bg-gray-800 border-l border-gray-700 overflow-y-auto shrink-0
          absolute z-20 top-0 right-0 h-full
          transition-transform duration-200 ease-in-out
          ${showRightPanel ? 'translate-x-0' : 'translate-x-full pointer-events-none'}
        `}>
          <SettingsPanel
            engine={engine}
            onEngineChange={setEngine}
            settings={settings}
            onSettingsChange={setSettings}
            onSlice={handleSlice}
            onSliceAll={handleSliceAll}
            plateCount={plateCount}
            isSlicing={jobs.some((j) => j.status === 'running' || j.status === 'queued')}
            selectedProfiles={selectedProfiles}
            onProfilesChange={setSelectedProfiles}
            multiMaterial={multiMaterial}
            onMultiMaterialChange={(mm) => {
              setMultiMaterial(mm);
              localStorage.setItem('slorca_multi_material', JSON.stringify(mm));
            }}
            filamentSlots={filamentSlots}
            onFilamentSlotsChange={(slots) => {
              setFilamentSlots(slots);
              localStorage.setItem('slorca_filament_slots', JSON.stringify(slots));
            }}
            printerIp={printerIp}
            onPrinterIpChange={(ip) => {
              setPrinterIp(ip);
              localStorage.setItem('slorca_printer_ip', ip);
            }}
          />
        </div>
      </div>
    </div>
  );
}
