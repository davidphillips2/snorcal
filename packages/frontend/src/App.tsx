import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { Scene, type SceneRefs } from './components/Viewer/Scene';
import { STLViewer, extractFaceColors, autoOrient, type Rotation3D } from './components/Viewer/STLViewer';
import { FacePainter, type PaintMode } from './components/Viewer/FacePainter';
import { ViewerToolbar } from './components/Viewer/ViewerToolbar';
import { TransformPanel } from './components/ModelEdit/TransformPanel';
import { MeasureTool, type Measurement } from './components/ModelEdit/MeasureTool';
import { CutTool } from './components/ModelEdit/CutTool';
import { AddVolumeModal } from './components/ModelEdit/AddVolumeModal';
import { SupportPainter } from './components/ModelEdit/SupportPainter';
import { ObjectListPanel } from './components/ObjectList/ObjectListPanel';
import { MakerworldImportModal } from './components/ModelUploader/MakerworldImportModal';
import { PlateTabs } from './components/Plates/PlateTabs';
import { AxisIndicator } from './components/Viewer/AxisIndicator';
import { Bed } from './components/Viewer/Bed';
import { ModelMover } from './components/Viewer/ModelMover';
import { ModelUploader } from './components/ModelUploader';
import { JobList } from './components/Jobs/JobList';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { AppSettingsPanel } from './components/Settings/AppSettingsPanel';
import { GcodePreviewCanvas } from './components/Viewer/GcodePreviewCanvas';
import { GcodeLayerSlider } from './components/Viewer/GcodeLayerSlider';
import { GcodeTimeBreakdown } from './components/Viewer/GcodeTimeBreakdown';
import { GcodeLayerStrip } from './components/Viewer/GcodeLayerStrip';
import { PrinterDashboard } from './components/PrinterMonitor/PrinterDashboard';
import { InventoryPanel } from './components/Inventory/InventoryPanel';
import { MultiPrinterFit } from './components/PrinterMonitor/MultiPrinterFit';
import { LiveMonitorOverlay } from './components/PrinterMonitor/LiveMonitorOverlay';
import { FilamentRemapModal } from './components/PrinterMonitor/FilamentRemapModal';
import { AddPrinterModal } from './components/PrinterMonitor/AddPrinterModal';
import type { PrinterStatus } from '@snorcal/shared';
import { HomeDashboard } from './components/Home/HomeDashboard';
import { PrinterDetail } from './components/PrinterMonitor/PrinterDetail';
import { useSSE } from './hooks/useSSE';
import * as api from './api/client';
import type { PausePoint } from './api/client';
import { shelfPack } from './lib/pack';
import { extractLayerTypes } from './lib/gcode-stats';
import { TransformGizmo } from './components/Viewer/TransformGizmo';
import { CollisionOverlay } from './components/Viewer/CollisionOverlay';
import { MultiMeasureOverlay } from './components/Viewer/MultiMeasureOverlay';
import { isCoarsePointer, type TransformMode, type TransformSpace, type SnapSettings } from './lib/transforms';
import type { ModelKind, Scale3D, Mirror3D } from '@snorcal/shared';

// --- Types ---

export interface ProjectModel {
  uid: string; // stable instance id (survives array reorders) — used as React key + meshRefs key
  modelId: string;
  name: string;
  faceCount: number;
  plateCount: number;
  plateId: string; // which plate this model belongs to
  rotation: Rotation3D;
  positionOffset: { x: number; y: number; z: number };
  scale: Scale3D;                  // default {1,1,1}
  mirror: Mirror3D;                // default {false,false,false}
  faceColors: Uint8Array | null;
  visible: boolean;
  kind: ModelKind;                 // default 'model'
  linkedTo?: string[];             // parent modelId(s) for negative/modifier
  settings?: Record<string, unknown>; // per-object override (modifier subset)
  /** Set when this ProjectModel is an embedded negative part (sourced from a
   *  3MF upload). Renders via /files/model/:parentId/negative/:plate/:part. */
  negativePartRef?: { parentModelId: string; plate: number; part: number };
  /** Set when this ProjectModel is a printable sub-object of a 3MF assembly
   *  (one `<object>` inside the parent 3MF). Renders via
   *  /files/model/:parentId/part/:plate/:part. */
  printablePartRef?: { parentModelId: string; plate: number; part: number };
}

const DEFAULT_SCALE: Scale3D = { x: 1, y: 1, z: 1 };
const DEFAULT_MIRROR: Mirror3D = { x: false, y: false, z: false };

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

// crypto.randomUUID requires a secure context (https or localhost). LAN IPs
// over plain http don't qualify on Safari, so fall back to getRandomValues.
function makeUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const buf = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build child ProjectModels (kind=negative) for every embedded negative part
 * that ships with a 3MF (e.g. MakerWorld keyring holes). Each child links to
 * its parent via `linkedTo` and carries a `negativePartRef` so the slicer can
 * resolve geometry via /files/model/:parentId/negative/:plate/:part.
 *
 * Delta offset puts the child next to the parent after STLViewer's per-mesh
 * centering (parent gets centered to origin; child needs to compensate).
 */
function buildNegativeChildPms(
  model: {
    id: string;
    name: string;
    negativeParts?: Array<{ plateIndex: number; partIndex: number; faceCount: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number } }>;
    boundsMin?: { x: number; y: number; z: number };
    boundsMax?: { x: number; y: number; z: number };
  },
  plateId: string,
  offset: number,
): ProjectModel[] {
  if (!model.negativeParts || model.negativeParts.length === 0 || !model.boundsMin || !model.boundsMax) {
    return [];
  }
  const pCx = (model.boundsMin.x + model.boundsMax.x) / 2;
  const pCz = (model.boundsMin.z + model.boundsMax.z) / 2;
  const pMinY = model.boundsMin.y;
  const children: ProjectModel[] = [];
  for (const np of model.negativeParts) {
    if (np.plateIndex !== 1) continue; // multi-plate imports surface only plate-1 children on the freshly-created pm
    if (!np.boundsMin || !np.boundsMax) continue;
    const cCx = (np.boundsMin.x + np.boundsMax.x) / 2;
    const cCz = (np.boundsMin.z + np.boundsMax.z) / 2;
    children.push({
      uid: makeUid(),
      modelId: model.id, // child reuses parent id; URL resolved via negativePartRef
      name: `${model.name} (neg ${np.partIndex})`,
      faceCount: np.faceCount,
      plateCount: 1,
      plateId,
      rotation: { x: 0, y: 0, z: 0 },
      positionOffset: {
        x: offset + (cCx - pCx),
        y: np.boundsMin.y - pMinY,
        z: cCz - pCz,
      },
      scale: { ...DEFAULT_SCALE },
      mirror: { ...DEFAULT_MIRROR },
      faceColors: null,
      visible: true,
      kind: 'negative',
      linkedTo: [model.id],
      negativePartRef: { parentModelId: model.id, plate: np.plateIndex, part: np.partIndex },
    });
  }
  return children;
}

/**
 * Build child ProjectModels (kind=part) for every printable sub-object in a
 * 3MF assembly (each `<object>` in the source file). Mirrors
 * `buildNegativeChildPms` but for printable parts that compose the parent
 * assembly rather than cutters that subtract from it.
 *
 * Each child links via `linkedTo` and carries a `printablePartRef` so the
 * slicer resolves geometry via /files/model/:parentId/part/:plate/:part.
 */
function buildPrintableChildPms(
  model: {
    id: string;
    name: string;
    parts?: Array<{ plateIndex: number; partIndex: number; faceCount: number; name?: string; extruder?: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number } }>;
  },
  plateId: string,
): ProjectModel[] {
  if (!model.parts || model.parts.length === 0) return [];
  // Only plate-1 parts attach to the freshly-created pm (mirrors the
  // negative-parts rule). Multi-plate uploads create one pm per plate.
  return model.parts
    .filter(pp => pp.plateIndex === 1)
    .map(pp => ({
      uid: makeUid(),
      modelId: model.id,
      name: pp.name ?? `${model.name} (part ${pp.partIndex})`,
      faceCount: pp.faceCount,
      plateCount: 1,
      plateId,
      // Identity transform — the per-part STL already has Y-up coordinates
      // captured at parse time. Parent's plate-centering happens in
      // threemf-builder, applied via the parentOffset mechanism that all
      // children share.
      rotation: { x: 0, y: 0, z: 0 },
      positionOffset: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      mirror: { x: false, y: false, z: false },
      faceColors: null,
      visible: true,
      kind: 'part',
      linkedTo: [model.id],
      printablePartRef: { parentModelId: model.id, plate: pp.plateIndex, part: pp.partIndex },
    }));
}

interface PersistedModel {
  uid?: string; // optional for backwards compat (older saves lack this)
  modelId: string;
  name: string;
  faceCount: number;
  plateCount: number;
  plateId: string;
  rotation: Rotation3D;
  positionOffset: { x: number; y: number; z: number };
  scale?: Scale3D;
  mirror?: Mirror3D;
  visible: boolean;
  kind?: ModelKind;
  linkedTo?: string[];
  settings?: Record<string, unknown>;
  negativePartRef?: { parentModelId: string; plate: number; part: number };
  printablePartRef?: { parentModelId: string; plate: number; part: number };
}

interface PersistedState {
  plates: Array<{ id: string; name: string }>;
  activePlateId: string;
  models: PersistedModel[];
  /** @deprecated use selectedIndices — kept for restore migration */
  activeModelIndex?: number | null;
  selectedIndices?: number[];
  engine: string;
  settings: Record<string, string>;
  selectedProfiles: { machine?: string; filament?: string; filament2?: string; process?: string };
  filamentSlots: Array<{ color: string; type: string; profile?: string }>;
  multiMaterial: { enabled: boolean; supportFilament: string; supportInterfaceFilament: string };
  printerIp: string;
  // UI state — restored across reloads so user lands where they left off
  view?: 'home' | 'slice' | 'jobs' | 'printer' | 'settings';
  showSidebar?: boolean;
  showSettings?: boolean;
  showJobs?: boolean;
  showInventory?: boolean;
  paintMode?: string;
  activeColor?: string;
  selectedPrinterId?: string | null;
  targetPrinterId?: string | null;
  viewer3DEnabled?: boolean;
  previewJobId?: string | null;
  gcodeColorMode?: 'filament' | 'lineType' | 'speed';
  showAllLayers?: boolean;
  currentPreviewLayer?: number;
  // Transform gizmo (Phase 2)
  transformMode?: TransformMode;
  transformSpace?: TransformSpace;
  snapEnabled?: boolean;
  snapTranslateMM?: number;
  snapRotateDeg?: number;
}

// Migrate legacy slorca_* localStorage keys → snorcal_* (one-shot per key)
function migrateLegacyKeys() {
  const keys = [
    'snorcal_project', 'snorcal_engine', 'snorcal_filament_slots',
    'snorcal_printer_ip', 'snorcal_multi_material', 'snorcal_target_printer',
  ];
  for (const k of keys) {
    const oldKey = k.replace('snorcal_', 'slorca_');
    if (localStorage.getItem(k) === null && localStorage.getItem(oldKey) !== null) {
      localStorage.setItem(k, localStorage.getItem(oldKey)!);
      localStorage.removeItem(oldKey);
    }
  }
  // printers.ts STORAGE_KEY legacy
  if (localStorage.getItem('snorcal_printer') === null && localStorage.getItem('slorca_printer') !== null) {
    localStorage.setItem('snorcal_printer', localStorage.getItem('slorca_printer')!);
    localStorage.removeItem('slorca_printer');
  }
}

function loadPersistedState(): PersistedState | null {
  try {
    migrateLegacyKeys();
    const raw = localStorage.getItem('snorcal_project');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function savePersistedState(state: PersistedState) {
  try {
    localStorage.setItem('snorcal_project', JSON.stringify(state));
  } catch { /* localStorage full */ }
}

/** World-space bounding box dimensions in mm for a mesh. */
function computeMeshBoundsMM(mesh: THREE.Mesh): { x: number; y: number; z: number } {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { x: size.x, y: size.y, z: size.z };
}

// --- App ---

export default function App() {
  const [isUploading, setIsUploading] = useState(false);
  const [sceneRefs, setSceneRefs] = useState<SceneRefs | null>(null);
  const meshRefs = useRef<Record<string, THREE.Mesh | null>>({});
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Multi-model project state
  const persisted = useRef(loadPersistedState());
  const defaultPlateId = 'plate-1';
  const [paintMode, setPaintMode] = useState<PaintMode>(() => (persisted.current?.paintMode as PaintMode) || 'orbit');
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [addVolumeKind, setAddVolumeKind] = useState<'negative' | 'modifier' | null>(null);
  // Optional explicit parent for the next AddVolumeModal submit (set by
  // per-row ⊖ button in ObjectListPanel). Falls back to activeModel.modelId.
  const [addVolumeParentId, setAddVolumeParentId] = useState<string | null>(null);
  const [activeColor, setActiveColor] = useState(() => persisted.current?.activeColor || '#FF0000');
  const [plates, setPlates] = useState<Array<{ id: string; name: string }>>(() => persisted.current?.plates ?? [{ id: defaultPlateId, name: 'Plate 1' }]);
  const [activePlateId, setActivePlateId] = useState(() => persisted.current?.activePlateId ?? defaultPlateId);
  const [projectModels, setProjectModels] = useState<ProjectModel[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  // Derived single-active index (first of set or null) — kept for back-compat
  // with handlers that were written for single-select. Multi-select aware
  // components read selectedIndices directly.
  const activeModelIndex = selectedIndices.size > 0 ? Math.min(...selectedIndices) : null;
  const selectSingle = useCallback((idx: number | null) => {
    setSelectedIndices(idx == null ? new Set() : new Set([idx]));
  }, []);
  const toggleMulti = useCallback((idx: number) => {
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  // Transform gizmo state (Phase 2)
  const [transformMode, setTransformMode] = useState<TransformMode>(() => (persisted.current?.transformMode as TransformMode) || 'translate');
  const [transformSpace, setTransformSpace] = useState<TransformSpace>(() => (persisted.current?.transformSpace as TransformSpace) || 'world');
  const [snapEnabled, setSnapEnabled] = useState<boolean>(() => persisted.current?.snapEnabled ?? false);
  const [snapTranslateMM, setSnapTranslateMM] = useState<number>(() => persisted.current?.snapTranslateMM ?? 1);
  const [snapRotateDeg, setSnapRotateDeg] = useState<number>(() => persisted.current?.snapRotateDeg ?? 15);

  // --- Undo/redo history (50-step stack of projectModels snapshots) ---
  const undoStackRef = useRef<ProjectModel[][]>([]);
  const redoStackRef = useRef<ProjectModel[][]>([]);
  const projectModelsRef = useRef(projectModels);
  projectModelsRef.current = projectModels;
  const [, forceUndoTick] = useState(0);

  const pushUndo = useCallback(() => {
    undoStackRef.current.push(projectModelsRef.current.map(p => ({ ...p })));
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
    forceUndoTick(t => t + 1);
  }, []);

  // Tracked setter — snapshots current state before applying updater
  const updateModels = useCallback((updater: ProjectModel[] | ((prev: ProjectModel[]) => ProjectModel[])) => {
    pushUndo();
    setProjectModels(updater);
  }, [pushUndo]);

  // --- Plate manager handlers ---
  const handleRenamePlate = useCallback((id: string, name: string) => {
    setPlates(prev => prev.map(p => p.id === id ? { ...p, name } : p));
  }, []);
  const handleDuplicatePlate = useCallback((id: string) => {
    const idx = plates.findIndex(p => p.id === id);
    if (idx < 0) return;
    const src = plates[idx];
    const newId = `plate-${Date.now()}`;
    const modelIdMap = new Map<string, string>();
    const clones: ProjectModel[] = projectModels
      .filter(m => m.plateId === id)
      .map(m => {
        const newMid = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        modelIdMap.set(m.modelId, newMid);
        return { ...m, modelId: newMid, plateId: newId, faceColors: m.faceColors ? new Uint8Array(m.faceColors) : null };
      });
    clones.forEach(c => {
      if (c.linkedTo) c.linkedTo = c.linkedTo.map(lid => modelIdMap.get(lid) ?? lid);
    });
    setPlates(prev => [
      ...prev.slice(0, idx + 1),
      { id: newId, name: `${src.name} copy` },
      ...prev.slice(idx + 1),
    ]);
    updateModels(pm => [...pm, ...clones]);
    setActivePlateId(newId);
    selectSingle(null);
  }, [plates, projectModels, updateModels]);
  const handleDeletePlate = useCallback((id: string) => {
    if (plates.length <= 1) return;
    const idx = plates.findIndex(p => p.id === id);
    if (idx < 0) return;
    setPlates(prev => prev.filter(p => p.id !== id));
    updateModels(pm => pm.filter(m => m.plateId !== id));
    if (activePlateId === id) {
      const fallbackIdx = Math.max(0, idx - 1);
      setActivePlateId(prev => {
        const next = plates.filter(p => p.id !== id);
        return next[Math.min(fallbackIdx, next.length - 1)]?.id ?? prev;
      });
      selectSingle(null);
    }
  }, [plates, activePlateId, updateModels]);
  const handleReorderPlates = useCallback((fromIdx: number, toIdx: number) => {
    setPlates(prev => {
      if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= prev.length || toIdx >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);
  // Toggle anti-warp brim preset: brim_ears + 8mm width
  const toggleBrim = useCallback(() => {
    setSettings(prev => {
      const isOn = prev.brim_type === 'brim_ears' && Number(prev.brim_width || 0) > 0;
      return {
        ...prev,
        brim_type: isOn ? 'auto_brim' : 'brim_ears',
        brim_width: isOn ? '0' : '8',
      };
    });
  }, []);
  const toggleHollow = useCallback(() => {
    setSettings(prev => {
      const isOn = prev.sparse_infill_density === '0%'
        && Number(prev.top_shell_layers || 99) === 0
        && Number(prev.bottom_shell_layers || 99) === 0;
      return {
        ...prev,
        sparse_infill_density: isOn ? '15%' : '0%',
        top_shell_layers: isOn ? '4' : '0',
        bottom_shell_layers: isOn ? '3' : '0',
        wall_loops: isOn ? prev.wall_loops : (prev.wall_loops || '3'),
      };
    });
  }, []);

  const handleUndo = useCallback(() => {
    // Paint undo takes precedence (most recent action); fall back to project-models
    const paintUndo = (window as any).__snorcal_undo as (() => boolean) | undefined;
    if (paintUndo && paintUndo()) return;
    if (undoStackRef.current.length > 0) {
      const present = projectModelsRef.current.map(p => ({ ...p }));
      const past = undoStackRef.current.pop()!;
      redoStackRef.current.push(present);
      setProjectModels(past);
      selectSingle(null);
      forceUndoTick(t => t + 1);
      return;
    }
  }, []);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const present = projectModelsRef.current.map(p => ({ ...p }));
    const future = redoStackRef.current.pop()!;
    undoStackRef.current.push(present);
    setProjectModels(future);
    selectSingle(null);
    forceUndoTick(t => t + 1);
  }, []);

  const canUndo = undoStackRef.current.length > 0
    || ((window as any).__snorcal_paint_undo_count ?? 0) > 0;
  const canRedo = redoStackRef.current.length > 0;

  // Undo/redo keyboard shortcuts (Ctrl/Cmd+Z, Ctrl+Shift+Z, Ctrl+Y)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      // Ignore when typing in an input/textarea/select or color picker
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      if (key === 'y' || (key === 'z' && e.shiftKey)) {
        handleRedo();
      } else {
        handleUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo]);

  // Models on the active plate
  const activePlateModels = projectModels.filter(m => m.plateId === activePlateId);

  // Printer target (registered printers fetched below)
  // Legacy hardcoded PRINTERS list removed in favor of DB-registered printers.

  // Slicer config
  const [jobs, setJobs] = useState<Job[]>([]);
  const [engine, setEngineRaw] = useState(() => persisted.current?.engine || localStorage.getItem('snorcal_engine') || 'orcaslicer');
  const setEngine = useCallback((e: string) => {
    localStorage.setItem('snorcal_engine', e);
    setEngineRaw(e);
  }, []);
  const [settings, setSettings] = useState<Record<string, string>>(() => persisted.current?.settings || {});
  const [selectedProfiles, setSelectedProfiles] = useState(() => persisted.current?.selectedProfiles || {});
  const [filamentSlots, setFilamentSlots] = useState<Array<{ color: string; type: string; profile?: string }>>(() =>
    persisted.current?.filamentSlots || (() => { try { return JSON.parse(localStorage.getItem('snorcal_filament_slots') || 'null'); } catch { return null; } })() || [{ color: '#FF0000', type: 'PLA' }]
  );
  const [printerIp, setPrinterIp] = useState(() => persisted.current?.printerIp || localStorage.getItem('snorcal_printer_ip') || '');
  const [multiMaterial, setMultiMaterial] = useState(() =>
    persisted.current?.multiMaterial || (() => { try { return JSON.parse(localStorage.getItem('snorcal_multi_material') || 'null'); } catch { return null; } })() || { enabled: false, supportFilament: '1', supportInterfaceFilament: '1' }
  );

  // UI
  const [view, setView] = useState<'home' | 'slice' | 'jobs' | 'printer' | 'settings'>(() => persisted.current?.view ?? 'home');
  // 3D viewer toggle. Default OFF on mobile (huge STLs OOM iOS Safari),
  // ON on desktop. User can flip from the slice view.
  const isMobileUA = typeof navigator !== 'undefined'
    && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const [viewer3DEnabled, setViewer3DEnabled] = useState(() => persisted.current?.viewer3DEnabled ?? !isMobileUA);
  const [selectedPrinterId, setSelectedPrinterId] = useState<string | null>(() => persisted.current?.selectedPrinterId ?? null);
  const [showSidebar, setShowSidebar] = useState(() => persisted.current?.showSidebar ?? false);
  const [showSettings, setShowSettings] = useState(() => persisted.current?.showSettings ?? true);
  const [showJobs, setShowJobs] = useState(() => persisted.current?.showJobs ?? false);
  const [showPrinters, setShowPrinters] = useState(false);
  const [showInventory, setShowInventory] = useState(() => persisted.current?.showInventory ?? false);
  const [showMwImport, setShowMwImport] = useState(false);
  const [showAddPrinter, setShowAddPrinter] = useState(false);

  // Registered printers (for target picker + Send)
  const [printers, setPrinters] = useState<Array<{ id: string; name: string; model?: string | null; protocol: string; bedVolume?: { x: number; y: number; z: number } | null; cameraSnapshotUrl?: string | null; protocolCamId?: string; manualSlots?: number }>>([]);
  const [printerStatuses, setPrinterStatuses] = useState<Record<string, PrinterStatus>>({});
  const [targetPrinterId, setTargetPrinterId] = useState<string | null>(() => localStorage.getItem('snorcal_target_printer'));
  const [bedVolume, setBedVolume] = useState<{ x: number; y: number; z: number } | null>(null);
  useEffect(() => {
    api.listPrinters().then(list => {
      setPrinters(list.map(p => ({ id: p.id, name: p.name, model: p.model, protocol: p.protocol, bedVolume: p.bedVolume ?? null, cameraSnapshotUrl: p.cameraSnapshotUrl ?? null, manualSlots: p.manualSlots ?? 0 })));
      // Auto-pick first if none selected
      if (list.length > 0) {
        setTargetPrinterId(cur => {
          const resolved = cur && list.some(p => p.id === cur) ? cur : list[0].id;
          localStorage.setItem('snorcal_target_printer', resolved);
          return resolved;
        });
      } else {
        setShowAddPrinter(true);
      }
    }).catch(() => {});
  }, []);

  // Sync bed volume from target printer's record
  useEffect(() => {
    if (!targetPrinterId) { setBedVolume(null); return; }
    api.listPrinters().then(list => {
      const p = list.find(x => x.id === targetPrinterId);
      setBedVolume(p?.bedVolume ?? null);
    }).catch(() => {});
  }, [targetPrinterId]);

  // Auto-arrange visible models on active plate via shelf packing
  const handleAutoArrange = useCallback(() => {
    if (!bedVolume) return;
    const items: Array<{ id: string; width: number; depth: number }> = [];
    for (const pm of projectModels) {
      if (pm.plateId !== activePlateId || !pm.visible) continue;
      const mesh = meshRefs.current[pm.uid];
      if (!mesh) continue;
      mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      const size = new THREE.Vector3();
      box.getSize(size);
      items.push({ id: pm.uid, width: size.x, depth: size.z });
    }
    if (items.length === 0) return;
    const { positions } = shelfPack(items, bedVolume.x, bedVolume.y, 5);
    updateModels(prev => prev.map(pm => {
      const p = positions.get(pm.uid);
      if (!p) return pm;
      // Bed X → world X, bed Y → world Z (same convention as plate layout)
      // shelfPack centers packed region on bed center; positions returned relative to bed origin (top-left → bottom-right)
      return { ...pm, positionOffset: { x: p.x - bedVolume.x / 2, y: 0, z: p.z - bedVolume.y / 2 } };
    }));
  }, [projectModels, activePlateId, bedVolume, updateModels]);

  // Plate layout: render all plates side-by-side on X axis. plateOffsets maps
  // plateId → world-space center offset so each plate's bed sits next to others.
  const bedForLayout = bedVolume ?? { x: 200, y: 200, z: 200 };
  const PLATE_GAP = 20;
  const plateOffsets = useMemo(() => {
    const n = plates.length;
    const step = bedForLayout.x + PLATE_GAP;
    const totalWidth = n * bedForLayout.x + (n - 1) * PLATE_GAP;
    const startX = -totalWidth / 2 + bedForLayout.x / 2;
    const out: Record<string, { x: number; y: number; z: number }> = {};
    plates.forEach((p, i) => {
      out[p.id] = { x: startX + i * step, y: 0, z: 0 };
    });
    return out;
  }, [plates, bedForLayout.x, bedForLayout.y, bedForLayout.z]);

  // Gcode preview
  // previewJobId is session-scoped: never restore across reloads, since the
  // matching gcode payload isn't in memory anymore and STLViewer is gated on
  // !previewJobId (stale value would hide the model on next session).
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [gcodeText, setGcodeText] = useState<string | null>(null);
  const [currentPreviewLayer, setCurrentPreviewLayer] = useState(() => persisted.current?.currentPreviewLayer ?? 0);
  const [showAllLayers, setShowAllLayers] = useState(() => persisted.current?.showAllLayers ?? true);
  const [gcodeColorMode, setGcodeColorMode] = useState<'filament' | 'lineType' | 'speed'>(() => persisted.current?.gcodeColorMode ?? 'filament');
  const [isParsingGcode, setIsParsingGcode] = useState(false);
  const [layerCount, setLayerCount] = useState(0);
  const [jobPauses, setJobPauses] = useState<PausePoint[]>([]);
  const layerTypes = useMemo(() => gcodeText ? extractLayerTypes(gcodeText) : new Map<number, string>(), [gcodeText]);
  // Stable colors array — inline .map() would create a new ref every render
  // and re-trigger GcodePreviewCanvas's init effect, disposing the preview.
  const previewExtrusionColors = useMemo(() => filamentSlots.map(s => s.color), [filamentSlots]);

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
        uid: m.uid ?? makeUid(), // backwards compat: old saves lack uid
        plateId: m.plateId || defaultPlateId, // backwards compat
        scale: m.scale ?? { ...DEFAULT_SCALE },
        mirror: m.mirror ?? { ...DEFAULT_MIRROR },
        kind: m.kind ?? 'model',
        faceColors: null, // will be fetched via effect below
        negativePartRef: m.negativePartRef,
        printablePartRef: m.printablePartRef,
      }));
      setProjectModels(restored);
      // Migrate from old activeModelIndex single-select to selectedIndices
      if (Array.isArray(saved.selectedIndices)) {
        setSelectedIndices(new Set(saved.selectedIndices));
      } else if (typeof saved.activeModelIndex === 'number') {
        setSelectedIndices(new Set([saved.activeModelIndex]));
      }
    }
    persisted.current = null; // only use once
  }, []);

  // Fetch face colors for each unique model on load (dedupe by modelId).
  // Skip entirely when 3D viewer is off — colors only needed for painting UI.
  useEffect(() => {
    if (!viewer3DEnabled) return;
    const seen = new Set<string>();
    // Parents whose geometry is replaced by per-part STLs — their merged face_colors
    // blob has indices that don't map to any rendered mesh, so skip the fetch.
    const parentsWithParts = new Set(
      projectModels
        .filter(pm => pm.printablePartRef)
        .map(pm => pm.printablePartRef!.parentModelId),
    );
    for (const pm of projectModels) {
      if (pm.faceColors !== null) continue;
      // Negatives/modifiers/support use solid translucent material — no per-face paint.
      if (pm.kind === 'negative' || pm.kind === 'modifier' || pm.kind === 'support') continue;
      // Parents covered by per-part STLs: their merged blob has no rendered target.
      if (pm.kind === 'model' && parentsWithParts.has(pm.modelId)) continue;
      // Parts: per-part face_colors blob. Parent's merged blob uses different face indices.
      if (pm.printablePartRef) {
        const ref = pm.printablePartRef;
        const key = `part:${ref.parentModelId}:${ref.plate}:${ref.part}`;
        if (seen.has(key)) continue;
        seen.add(key);
        api.getPrintablePartColors(ref.parentModelId, ref.plate, ref.part).then(colors => {
          setProjectModels(prev => prev.map(p =>
            p.printablePartRef?.parentModelId === ref.parentModelId &&
            p.printablePartRef?.plate === ref.plate &&
            p.printablePartRef?.part === ref.part
              ? { ...p, faceColors: colors }
              : p,
          ));
        }).catch(() => {});
        continue;
      }
      if (seen.has(pm.modelId)) continue;
      seen.add(pm.modelId);
      api.getModelColors(pm.modelId).then(colors => {
        setProjectModels(prev => prev.map(p => p.modelId === pm.modelId ? { ...p, faceColors: colors } : p));
      }).catch(() => {});
    }
  }, [projectModels.length, viewer3DEnabled]);

  // Load default settings when engine changes
  useEffect(() => {
    api.getDefaultSettings(engine).then((data) => {
      if (data?.process) setSettings(data.process);
    }).catch(console.error);
  }, [engine]);

  // Persist state on changes (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      savePersistedState({
        plates,
        activePlateId,
        models: projectModels.map(m => ({
          uid: m.uid, modelId: m.modelId, name: m.name, faceCount: m.faceCount, plateCount: m.plateCount,
          plateId: m.plateId, rotation: m.rotation, positionOffset: m.positionOffset,
          scale: m.scale, mirror: m.mirror, visible: m.visible,
          kind: m.kind, linkedTo: m.linkedTo, settings: m.settings,
          negativePartRef: m.negativePartRef,
          printablePartRef: m.printablePartRef,
        })),
        activeModelIndex,    // legacy — kept for back-compat restore
        selectedIndices: Array.from(selectedIndices),
        engine,
        settings,
        selectedProfiles,
        filamentSlots,
        multiMaterial,
        printerIp,
        view,
        showSidebar,
        showSettings,
        showJobs,
        showInventory,
        paintMode,
        activeColor,
        selectedPrinterId,
        targetPrinterId,
        viewer3DEnabled,
        gcodeColorMode,
        showAllLayers,
        currentPreviewLayer,
        transformMode,
        transformSpace,
        snapEnabled,
        snapTranslateMM,
        snapRotateDeg,
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [projectModels, plates, activePlateId, activeModelIndex, engine, settings, selectedProfiles, filamentSlots, multiMaterial, printerIp, view, showSidebar, showSettings, showJobs, showInventory, paintMode, activeColor, selectedPrinterId, targetPrinterId, viewer3DEnabled, gcodeColorMode, showAllLayers, currentPreviewLayer, transformMode, transformSpace, snapEnabled, snapTranslateMM, snapRotateDeg]);

  // SSE updates
  useEffect(() => {
    let printerListDirty = false;
    for (const msg of sseMsgs) {
      const jobId = msg.data.jobId as string;
      if (msg.type === 'printer:status' && msg.data.printerId) {
        setPrinterStatuses(prev => ({ ...prev, [msg.data.printerId as string]: msg.data as unknown as PrinterStatus }));
        continue;
      }
      if (msg.type === 'printer:connected' || msg.type === 'printer:disconnected') {
        printerListDirty = true;
      }
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
    if (printerListDirty) {
      api.listPrinters().then(list => {
        setPrinters(list.map(p => ({ id: p.id, name: p.name, model: p.model, protocol: p.protocol, bedVolume: p.bedVolume ?? null, cameraSnapshotUrl: p.cameraSnapshotUrl ?? null, manualSlots: p.manualSlots ?? 0 })));
      }).catch(() => {});
    }
  }, [sseMsgs]);

  // Poll running jobs
  const hasRunningJobs = jobs.some((j) => j.status === 'running' || j.status === 'queued');
  useEffect(() => {
    if (!hasRunningJobs) return;
    const interval = setInterval(async () => {
      // Re-read latest job IDs at tick time — avoid stale closure + avoid
      // re-running this effect on every job state change.
      setJobs((prev) => {
        const running = prev.filter((j) => j.status === 'running' || j.status === 'queued');
        if (running.length === 0) return prev;
        Promise.all(running.map(j => api.getJob(j.id).catch(() => null))).then((results) => {
          setJobs((cur) => cur.map((j) => {
            const r = results.find((u, i) => u && running[i].id === j.id);
            if (!r) return j;
            return {
              ...j, status: r.status, progress: r.progress, currentStep: r.currentStep,
              errorMessage: r.errorMessage, gcodeSize: r.gcodeSize, modelName: r.modelName,
              estimatedTime: r.estimatedTime, filamentUsedG: r.filamentUsedG, filamentCost: r.filamentCost,
            };
          }));
        });
        return prev;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [hasRunningJobs]);

  // Upload: add to project (not replace)
  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    try {
      const model = await api.uploadModel(file);
      const offset = projectModels.length * 50;
      const newPm: ProjectModel = {
        uid: makeUid(),
        modelId: model.id,
        name: model.name,
        faceCount: model.faceCount,
        plateCount: model.plateCount ?? 1,
        plateId: activePlateId,
        rotation: { x: 0, y: 0, z: 0 },
        positionOffset: { x: offset, y: 0, z: 0 },
        scale: { ...DEFAULT_SCALE },
        mirror: { ...DEFAULT_MIRROR },
        faceColors: null,
        visible: true,
        kind: 'model',
      };

      // Surface embedded negative parts (e.g. MakerWorld keyring holes) as
      // child ProjectModels kind=negative. Each gets a delta offset so the
      // part lines up with the parent after STLViewer's per-mesh centering.
      const negativePms = buildNegativeChildPms(model, activePlateId, offset);
      // Surface printable sub-objects (kind=part) — each `<object>` in a
      // 3MF assembly becomes its own row, interactable independently.
      const partPms = buildPrintableChildPms(model, activePlateId);

      updateModels(prev => [...prev, newPm, ...partPms, ...negativePms]);
      selectSingle(projectModels.length); // select new model

      // 3MF uploads may carry filament_colour/type arrays in their embedded
      // project_settings.config — populate slots the same way MW imports do.
      await applySourceSettings(model.id);
    } catch (err) {
      alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsUploading(false);
    }
  }, [projectModels.length]);

  // Sequential multi-file upload — preserves order, sets isUploading once for batch
  const handleUploadMany = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setIsUploading(true);
    try {
      for (const file of files) {
        try {
          const model = await api.uploadModel(file);
          const offset = projectModels.length * 50;
          const newPm: ProjectModel = {
            uid: makeUid(),
            modelId: model.id,
            name: model.name,
            faceCount: model.faceCount,
            plateCount: model.plateCount ?? 1,
            plateId: activePlateId,
            rotation: { x: 0, y: 0, z: 0 },
            positionOffset: { x: offset, y: 0, z: 0 },
            scale: { ...DEFAULT_SCALE },
            mirror: { ...DEFAULT_MIRROR },
            faceColors: null,
            visible: true,
            kind: 'model',
          };
          updateModels(prev => [...prev, newPm]);
          selectSingle(projectModels.length);
        } catch (err) {
          console.error(`Upload failed for ${file.name}:`, err);
        }
      }
    } finally {
      setIsUploading(false);
    }
  }, [projectModels.length, activePlateId, updateModels]);

  // MakerWorld import — backend already registered the 3MF, just fetch metadata + add to scene
  const handleMakerworldImported = useCallback(async (m: { modelId: string; name: string; plateCount: number }) => {
    try {
      const meta = await api.getModel(m.modelId) as any;
      const offset = projectModels.length * 50;
      const newPm: ProjectModel = {
        uid: makeUid(),
        modelId: m.modelId,
        name: m.name,
        faceCount: meta?.faceCount ?? 0,
        plateCount: meta?.plateCount ?? m.plateCount ?? 1,
        plateId: activePlateId,
        rotation: { x: 0, y: 0, z: 0 },
        positionOffset: { x: offset, y: 0, z: 0 },
        scale: { ...DEFAULT_SCALE },
        mirror: { ...DEFAULT_MIRROR },
        faceColors: null,
        visible: true,
        kind: 'model',
      };
      // Surface embedded negatives (same path as plain uploads). Without this,
      // MakerWorld imports silently lost their cutters / keyring holes.
      const negativePms = buildNegativeChildPms(
        {
          id: m.modelId,
          name: m.name,
          negativeParts: meta?.negativeParts,
          boundsMin: meta?.boundsMin,
          boundsMax: meta?.boundsMax,
        },
        activePlateId,
        offset,
      );
      // Surface printable sub-objects (same path as plain uploads).
      const partPms = buildPrintableChildPms(
        { id: m.modelId, name: m.name, parts: meta?.parts },
        activePlateId,
      );
      updateModels(prev => [...prev, newPm, ...partPms, ...negativePms]);
      selectSingle(projectModels.length);

      // MakerWorld imports explicitly overwrite project settings (user opted
      // into the bundle's full slicer config). Plain uploads use the same
      // helper but skip the settings overwrite.
      await applySourceSettings(m.modelId, { overwriteSettings: true });
    } catch (err) {
      alert(`MakerWorld import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [projectModels.length, activePlateId, updateModels]);

  /**
   * Fetch a model's embedded project_settings.config and sync its
   * filament_colour / filament_type arrays into the per-slot UI state.
   *
   * `overwriteSettings` controls whether the full settings blob replaces the
   * user's current project settings — true for MakerWorld imports (user
   * explicitly opted into the bundle), false for plain uploads (we only want
   * the filament slots, not the printer profile / gcode macros).
   */
  const applySourceSettings = useCallback(async (modelId: string, opts?: { overwriteSettings?: boolean }) => {
    const sourceSettings = await api.getModelSourceSettings(modelId);
    if (!sourceSettings || typeof sourceSettings !== 'object') return;

    if (opts?.overwriteSettings) {
      const coerced: Record<string, string> = {};
      for (const [k, v] of Object.entries(sourceSettings)) {
        if (v == null) continue;
        if (k.endsWith('_gcode')) continue;  // preserve user's printer-specific macros
        coerced[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      setSettings(prev => ({ ...prev, ...coerced }));
    }

    const colors = sourceSettings.filament_colour;
    const types = sourceSettings.filament_type;
    if (Array.isArray(colors) && colors.length > 0) {
      const newSlots = colors.map((c: unknown, i: number) => ({
        color: typeof c === 'string' ? c : '#FFFFFF',
        type: Array.isArray(types) && typeof types[i] === 'string' ? (types[i] as string) : 'PLA',
      }));
      setFilamentSlots(newSlots);
    }
  }, []);

  // Remove model from project
  const handleRemoveModel = useCallback((idx: number) => {
    updateModels(prev => {
      const target = prev[idx];
      if (!target) return prev;
      // Cascade-delete children linked to this parent (only if removing a model parent)
      const childIds = target.kind === 'model'
        ? new Set(prev.filter(m => m.linkedTo?.includes(target.modelId)).map(m => m.modelId))
        : new Set<string>();
      const removed = prev.filter((p, i) => i !== idx && !childIds.has(p.modelId));
      // Cleanup meshRefs for removed entries
      const removedUids = new Set(prev.filter((p, i) => i === idx || childIds.has(p.modelId)).map(p => p.uid));
      for (const uid of removedUids) delete meshRefs.current[uid];
      return removed;
    });
    setSelectedIndices(prev => {
      const next = new Set<number>();
      for (const i of prev) {
        if (i === idx) continue;          // drop deleted
        if (i > idx) next.add(i - 1);     // shift down
        else next.add(i);
      }
      return next;
    });
  }, [projectModels.length]);

  // Slice: send first visible model (multi-model slicing to be added later)
  const saveAllColors = useCallback(async () => {
    const plateIndex = plates.findIndex(p => p.id === activePlateId) + 1 || 1;
    const savedModelIds = new Set<string>();
    const updates: Array<{ uid: string; colors: Uint8Array }> = [];
    const saves: Promise<unknown>[] = [];
    for (const pm of projectModels) {
      // Skip negative/modifier/support volumes — they share parent's modelId
      // (App.tsx:659) and would overwrite the parent's paint with their own
      // (smaller, often all-default) colors under the same DB row.
      if (pm.kind && pm.kind !== 'model') continue;
      if (pm.negativePartRef) continue;
      if (pm.printablePartRef) continue;
      if (pm.plateId !== activePlateId || !pm.visible) continue;
      // First instance per modelId wins. Multiple clones in the scene share
      // one DB row (face_colors keyed by modelId+plate). Later clones often
      // carry stale geometry (e.g. 1440-face buffer from a prior upload) that
      // would overwrite the first clone's correct full-size paint.
      if (savedModelIds.has(pm.modelId)) continue;
      savedModelIds.add(pm.modelId);
      const mesh = meshRefs.current[pm.uid];
      if (!mesh) continue;
      const colors = extractFaceColors(mesh.geometry);
      if (colors.length > 0) {
        // MUST await before slice — fire-and-forget lets sliceModels beat the
        // save to the server, producing a stale-color 3MF.
        saves.push(
          api.saveFaceColors(pm.modelId, colors, pm.plateCount > 1 ? plateIndex : undefined)
            .catch(err => console.error('saveFaceColors failed', pm.modelId, err)),
        );
        // Mirror the saved blob into ProjectModel state so a later STLViewer
        // remount (e.g. after gcode preview unmounts the 3D view) reapplies
        // the paint instead of falling back to the pre-paint prop.
        updates.push({ uid: pm.uid, colors });
      }
    }
    if (updates.length > 0) {
      const byUid = new Map(updates.map(u => [u.uid, u.colors]));
      setProjectModels(prev => prev.map(pm => {
        const c = byUid.get(pm.uid);
        return c ? { ...pm, faceColors: c } : pm;
      }));
    }
    // Await all saves so callers (sliceModels, handleSaveColors) know the
    // server has the new blobs before they read them back.
    await Promise.all(saves);
  }, [projectModels, activePlateId, plates]);

  const sliceModels = useCallback(async (models: ProjectModel[]) => {
    if (models.length === 0) return;
    const processSettings: Record<string, string> = {};
    Object.assign(processSettings, settings);
    // Derive 1-based plate index from the first model's plateId so multi-plate
    // 3MFs read the correct plate's colors + STL during slice.
    const firstPlateIdx = plates.findIndex(p => p.id === models[0].plateId) + 1 || 1;
    const anyMultiPlate = models.some(m => m.plateCount > 1);
    return api.submitSliceJob({
      models: models.map(pm => ({
        modelId: pm.modelId,
        rotation: pm.rotation,
        positionOffset: pm.positionOffset,
        scale: pm.scale,
        mirror: pm.mirror,
        kind: pm.kind,
        linkedTo: pm.linkedTo,
        name: pm.name,
        settings: pm.settings,
        visible: pm.visible,
        negativePartRef: pm.negativePartRef,
        printablePartRef: pm.printablePartRef,
      })),
      engine,
      plateIndex: anyMultiPlate ? firstPlateIdx : undefined,
      settings: { process: processSettings, machine: {}, filaments: [{}] },
      profiles: selectedProfiles,
      multiMaterial: multiMaterial.enabled ? multiMaterial : undefined,
      filamentSlots: filamentSlots.length > 1 ? filamentSlots : undefined,
      buildVolume: bedVolume ?? undefined,
    });
  }, [engine, settings, selectedProfiles, multiMaterial, filamentSlots, bedVolume, plates]);

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
    const pm = projectModels[idx];
    if (!pm) return;
    const mesh = meshRefs.current[pm.uid];
    if (!mesh) return;
    try {
      const colors = extractFaceColors(mesh.geometry);
      const plateIndex = plates.findIndex(p => p.id === pm.plateId) + 1 || 1;
      await api.saveFaceColors(pm.modelId, colors, pm.plateCount > 1 ? plateIndex : undefined);
    } catch (err) { console.error('Save failed:', err); }
  }, [activeModelIndex, projectModels, plates]);

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
    setJobPauses([]);
    setShowSidebar(false);
    try {
      const [response, pauses] = await Promise.all([
        fetch(api.getGcodeUrl(jobId)),
        api.getJobPauses(jobId).catch(() => []),
      ]);
      const text = await response.text();
      setGcodeText(text);
      setJobPauses(pauses);
      setIsParsingGcode(false);
    } catch { setIsParsingGcode(false); setPreviewJobId(null); }
  }, []);

  // Toggle pause at layer N — writes to backend immediately, updates local state on success
  const handleTogglePause = useCallback(async (layer: number) => {
    if (!previewJobId) return;
    const exists = jobPauses.some(p => p.layer === layer);
    const next = exists
      ? jobPauses.filter(p => p.layer !== layer)
      : [...jobPauses, { layer }];
    // Optimistic update
    setJobPauses(next);
    try {
      // Resolve protocol from selected printer if any
      const printer = printers.find(p => p.id === targetPrinterId);
      await api.setJobPauses(previewJobId, next, printer?.protocol as 'moonraker' | 'bambu' | undefined);
    } catch (err) {
      // Revert on failure
      setJobPauses(jobPauses);
      alert(`Failed to update pauses: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [previewJobId, jobPauses, printers, targetPrinterId]);

  const [remapJobId, setRemapJobId] = useState<string | null>(null);

  const handleSendToPrinter = useCallback(async (jobId: string) => {
    if (!targetPrinterId) {
      alert('No target printer selected. Add a printer first.');
      return;
    }
    const printer = printers.find(p => p.id === targetPrinterId);
    if (!printer) { alert('Target printer not found'); return; }

    // Check if remap UI is needed: gcode has >1 filament, OR printer has multi-slots (AMS or manual)
    let filaments: api.JobFilament[] = [];
    try { filaments = await api.getJobFilaments(jobId); } catch { /* ignore */ }
    const usedCount = filaments.filter(f => f.used).length;
    const hasAms = printer.protocol === 'bambu' && printerStatuses[targetPrinterId]?.ams && printerStatuses[targetPrinterId]!.ams!.length > 0;
    const hasManualSlots = (printer.manualSlots ?? 0) > 0;
    const needsRemap = usedCount > 1 || ((hasAms || hasManualSlots) && filaments.length > 0);

    if (needsRemap) {
      setRemapJobId(jobId);
      return;
    }

    // Direct send — no remap
    try {
      const result = await api.sendToRegisteredPrinter(targetPrinterId, jobId, true);
      alert(`Sent to printer. Path: ${result.printerPath}`);
    } catch (err) { alert(`Send failed: ${err instanceof Error ? err.message : String(err)}`); }
  }, [targetPrinterId, printers, printerStatuses]);

  const handleExitPreview = useCallback(() => { setPreviewJobId(null); setGcodeText(null); setCurrentPreviewLayer(0); setLayerCount(0); setJobPauses([]); }, []);

  // Per-model geometry ready callback
  const [meshRevision, setMeshRevision] = useState(0);
  const handleGeometryReady = useCallback((uid: string, geometry: THREE.BufferGeometry, mesh: THREE.Mesh) => {
    meshRefs.current[uid] = mesh;
    setMeshRevision(prev => prev + 1); // force re-render so activeMesh updates
  }, []);

  // Fit camera to all visible meshes + full plate layout when geometry loads
  useEffect(() => {
    if (!sceneRefs || projectModels.length === 0) return;
    const visibleMeshes = projectModels
      .map(pm => ({ pm, mesh: meshRefs.current[pm.uid] }))
      .filter(({ pm, mesh }) => pm.visible && mesh);
    if (visibleMeshes.length === 0) return;
    const box = new THREE.Box3();
    for (const { mesh } of visibleMeshes) {
      mesh!.updateMatrixWorld(true);
      box.expandByObject(mesh!);
    }
    // Expand to full plate layout extent so all plates stay in view
    const n = plates.length;
    if (n > 0) {
      const totalWidth = n * bedForLayout.x + (n - 1) * PLATE_GAP;
      const minX = -totalWidth / 2;
      const maxX = totalWidth / 2;
      const hz = bedForLayout.y / 2;
      box.expandByPoint(new THREE.Vector3(minX, 0, -hz));
      box.expandByPoint(new THREE.Vector3(maxX, 0, hz));
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
  }, [meshRevision, sceneRefs, plates.length, bedForLayout.x, bedForLayout.y]);

  // Active model helpers — ensure active model is on active plate
  const activeModel = activeModelIndex != null && projectModels[activeModelIndex]?.plateId === activePlateId
    ? projectModels[activeModelIndex] : null;
  const activeMesh = activeModel != null ? meshRefs.current[activeModel.uid] : null;

  // Selected models on the active plate, with parallel mesh + global-index arrays
  // for TransformGizmo (Phase 2).
  const selectedGlobalIndicesArr = useMemo(
    () => Array.from(selectedIndices).sort((a, b) => a - b),
    [selectedIndices],
  );
  const selectedModelsForGizmo = useMemo(
    () => selectedGlobalIndicesArr
      .map(i => projectModels[i])
      .filter((pm): pm is ProjectModel => !!pm && pm.plateId === activePlateId),
    [selectedGlobalIndicesArr, projectModels, activePlateId],
  );
  const selectedMeshesForGizmo = useMemo(
    () => selectedModelsForGizmo
      .map(pm => meshRefs.current[pm.uid])
      .filter((m): m is THREE.Mesh => !!m),
    [selectedModelsForGizmo, meshRefs],
  );
  const snapSettings: SnapSettings = useMemo(
    () => ({ enabled: snapEnabled, translateMM: snapTranslateMM, rotateDeg: snapRotateDeg }),
    [snapEnabled, snapTranslateMM, snapRotateDeg],
  );

  // Active-plate models + parallel meshes (for collision overlay).
  const [collisionEnabled, setCollisionEnabled] = useState(true);
  const [measureEnabled, setMeasureEnabled] = useState(false);
  const activePlateMeshes = useMemo(
    () => activePlateModels
      .map(pm => meshRefs.current[pm.uid])
      .filter((m): m is THREE.Mesh => !!m),
    [activePlateModels, meshRefs],
  );

  // Gizmo drag-end: apply patches to each touched ProjectModel via tracked
  // updateModels so a single undo entry is pushed per drag (not per frame).
  const handleGizmoTransform = useCallback((patches: Array<{ idx: number; patch: Partial<ProjectModel> }>) => {
    if (patches.length === 0) return;
    updateModels(prev => prev.map((pm, i) => {
      const p = patches.find(x => x.idx === i);
      return p ? { ...pm, ...p.patch } : pm;
    }));
  }, [updateModels]);

  // Active plate world bounds for ModelMover clamp (plate X offset + bed half-size)
  const activePlateBounds = useMemo(() => {
    const off = plateOffsets[activePlateId];
    if (!off) return null;
    const hx = bedForLayout.x / 2;
    const hz = bedForLayout.y / 2;  // bed Y → world Z
    return { minX: off.x - hx, maxX: off.x + hx, minZ: -hz, maxZ: hz };
  }, [plateOffsets, activePlateId, bedForLayout.x, bedForLayout.y]);

  // Combined XYZ bounds (mm) of all visible models on the active plate — for fit-check.
  const activePlateModelBounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let found = false;
    for (const pm of projectModels) {
      if (pm.plateId !== activePlateId || !pm.visible) continue;
      const mesh = meshRefs.current[pm.uid];
      if (!mesh) continue;
      mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      if (!isFinite(box.min.x)) continue;
      minX = Math.min(minX, box.min.x); maxX = Math.max(maxX, box.max.x);
      minY = Math.min(minY, box.min.y); maxY = Math.max(maxY, box.max.y);
      minZ = Math.min(minZ, box.min.z); maxZ = Math.max(maxZ, box.max.z);
      found = true;
    }
    if (!found) return null;
    return { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  }, [projectModels, activePlateId, meshRevision]);

  const handleAutoOrient = useCallback(() => {
    if (!activeMesh || activeModelIndex == null) return;
    const newRotation = autoOrient(activeMesh.geometry);
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, rotation: newRotation } : p));
  }, [activeMesh, activeModelIndex, updateModels]);

  const handleLayOnFace = useCallback((newRotation: Rotation3D) => {
    if (activeModelIndex == null) return;
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, rotation: newRotation } : p));
    setPaintMode('orbit');
  }, [activeModelIndex, updateModels]);

  const handleRotationChange = useCallback((rotation: Rotation3D) => {
    if (activeModelIndex == null) return;
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, rotation } : p));
  }, [activeModelIndex, updateModels]);

  const handlePositionChange = useCallback((pos: THREE.Vector3) => {
    if (activeModelIndex == null) return;
    const pm = projectModels[activeModelIndex];
    if (!pm) return;
    const mesh = meshRefs.current[pm.uid];
    const rest = mesh?.userData?.restPosition as { x: number; y: number; z: number } | undefined;
    if (!rest) return;
    // pos is absolute mesh position; subtract rest (centering offset) to get pure user offset
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? {
      ...p,
      positionOffset: { x: pos.x - rest.x, y: pos.y - rest.y, z: pos.z - rest.z }
    } : p));
  }, [activeModelIndex, projectModels, updateModels]);

  // --- Transform ops (mirror / scale / duplicate / array) ---

  const handleUpdateActiveModel = useCallback((patch: Partial<ProjectModel>) => {
    if (activeModelIndex == null) return;
    updateModels(prev => prev.map((p, i) => i === activeModelIndex ? { ...p, ...patch } : p));
  }, [activeModelIndex, updateModels]);

  // Apply the same patch to every selected model (Phase 3 multi-aware panel).
  const handleUpdateAllSelected = useCallback((patch: Partial<ProjectModel>) => {
    if (selectedIndices.size === 0) return;
    updateModels(prev => prev.map((p, i) => selectedIndices.has(i) ? { ...p, ...patch } : p));
  }, [selectedIndices, updateModels]);

  // Reset every selected model's rotation/positionOffset to identity (origin).
  const handleResetOrigin = useCallback(() => {
    if (selectedIndices.size === 0) return;
    updateModels(prev => prev.map((p, i) => selectedIndices.has(i)
      ? { ...p, rotation: { x: 0, y: 0, z: 0 }, positionOffset: { x: 0, y: 0, z: 0 } }
      : p));
  }, [selectedIndices, updateModels]);

  const handleToggleVisible = useCallback((idx: number) => {
    updateModels(prev => prev.map((p, i) => i === idx ? { ...p, visible: !p.visible } : p));
  }, [updateModels]);

  const handleDuplicateAt = useCallback((idx: number) => {
    const src = projectModels[idx];
    if (!src) return;
    const dup: ProjectModel = {
      ...src,
      uid: makeUid(),
      positionOffset: {
        x: src.positionOffset.x + 20,
        y: src.positionOffset.y,
        z: src.positionOffset.z,
      },
    };
    updateModels(prev => [...prev, dup]);
  }, [projectModels, updateModels]);

  const handleDuplicate = useCallback(() => {
    if (activeModelIndex == null) return;
    handleDuplicateAt(activeModelIndex);
    // After dup, the clone is appended at the end — switch selection to it.
    setSelectedIndices(new Set([projectModels.length]));
  }, [activeModelIndex, handleDuplicateAt, projectModels.length]);

  // Cross-plate ops (Phase 4). Move = change plateId in place. Duplicate-to
  // creates a clone on the target plate (offset to plate origin) and selects it.
  const handleMoveToPlate = useCallback((globalIdx: number, plateId: string) => {
    updateModels(prev => prev.map((p, i) => i === globalIdx
      ? { ...p, plateId, positionOffset: { x: 0, y: 0, z: 0 } }
      : p));
    selectSingle(globalIdx);
  }, [updateModels, selectSingle]);

  const handleDuplicateToPlate = useCallback((globalIdx: number, plateId: string) => {
    const src = projectModels[globalIdx];
    if (!src) return;
    const dup: ProjectModel = {
      ...src,
      uid: makeUid(),
      plateId,
      positionOffset: { x: 0, y: 0, z: 0 },
    };
    updateModels(prev => [...prev, dup]);
    setSelectedIndices(new Set([projectModels.length]));
  }, [projectModels, updateModels]);

  const handleLinearArray = useCallback((count: number, dx: number, dy: number) => {
    if (!activeModel || count < 2) return;
    const copies: ProjectModel[] = [];
    for (let i = 1; i < count; i++) {
      copies.push({
        ...activeModel,
        uid: makeUid(),
        positionOffset: {
          x: activeModel.positionOffset.x + dx * i,
          y: activeModel.positionOffset.y,
          z: activeModel.positionOffset.z + dy * i,  // Three.js Z = bed Y
        },
      });
    }
    updateModels(prev => [...prev, ...copies]);
  }, [activeModel, updateModels]);

  const handleCircularArray = useCallback((count: number, radius: number) => {
    if (!activeModel || count < 2) return;
    const copies: ProjectModel[] = [];
    const cx = activeModel.positionOffset.x;
    const cz = activeModel.positionOffset.z;
    for (let i = 1; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      copies.push({
        ...activeModel,
        uid: makeUid(),
        positionOffset: {
          x: cx + Math.cos(angle) * radius,
          y: activeModel.positionOffset.y,
          z: cz + Math.sin(angle) * radius,
        },
        rotation: {
          x: activeModel.rotation.x,
          y: activeModel.rotation.y,
          z: activeModel.rotation.z + (angle * 180 / Math.PI),
        },
      });
    }
    updateModels(prev => [...prev, ...copies]);
  }, [activeModel, updateModels]);

  // Cut — CSG halves upload as new models; original active model is removed
  const handleCutComplete = useCallback(async (files: { file: File; name: string }[]) => {
    if (files.length === 0) return;
    setIsUploading(true);
    try {
      const uploaded = await Promise.all(files.map(f => api.uploadModel(f.file)));
      const newModels: ProjectModel[] = uploaded.map(m => ({
        uid: makeUid(),
        modelId: m.id,
        name: m.name,
        faceCount: m.faceCount,
        plateCount: m.plateCount ?? 1,
        plateId: activePlateId,
        rotation: { x: 0, y: 0, z: 0 },
        positionOffset: activeModel ? { ...activeModel.positionOffset } : { x: 0, y: 0, z: 0 },
        scale: { ...DEFAULT_SCALE },
        mirror: { ...DEFAULT_MIRROR },
        faceColors: null,
        visible: true,
        kind: 'model',
      }));
      // Remove the original, append halves
      updateModels(prev => {
        const without = activeModelIndex == null ? prev : prev.filter((_, i) => i !== activeModelIndex);
        return [...without, ...newModels];
      });
      // After cut: original removed, halves appended at end of array.
      // Closure captures pre-update projectModels.length, so first new index = N-1.
      setSelectedIndices(new Set([projectModels.length - 1]));
      setPaintMode('orbit');
    } catch (err) {
      alert(`Cut upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsUploading(false);
    }
  }, [activeModel, activeModelIndex, activePlateId]);

  // Add negative/modifier volume — uploads primitive STL, links to active model
  // (or to addVolumeParentId when triggered from a per-row ⊖ button).
  const handleAddVolume = useCallback(async (file: File, settings?: Record<string, unknown>) => {
    const kind = addVolumeKind;
    if (!kind) return;
    const parentId = addVolumeParentId ?? activeModel?.modelId;
    const parentPm = parentId ? projectModels.find(p => p.modelId === parentId) : undefined;
    setAddVolumeKind(null);
    setAddVolumeParentId(null);
    if (!parentId) {
      alert('Select a model first to attach a volume.');
      return;
    }
    setIsUploading(true);
    try {
      const uploaded = await api.uploadModel(file);
      const newPm: ProjectModel = {
        uid: makeUid(),
        modelId: uploaded.id,
        name: uploaded.name,
        faceCount: uploaded.faceCount,
        plateCount: uploaded.plateCount ?? 1,
        plateId: parentPm?.plateId ?? activePlateId,
        rotation: { x: 0, y: 0, z: 0 },
        positionOffset: parentPm ? { ...parentPm.positionOffset } : (activeModel ? { ...activeModel.positionOffset } : { x: 0, y: 0, z: 0 }),
        scale: { ...DEFAULT_SCALE },
        mirror: { ...DEFAULT_MIRROR },
        faceColors: null,
        visible: true,
        kind,
        linkedTo: [parentId],
        settings,
      };
      updateModels(prev => [...prev, newPm]);
    } catch (err) {
      alert(`Add volume failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsUploading(false);
    }
  }, [addVolumeKind, addVolumeParentId, activeModel, projectModels, activePlateId, updateModels]);

  // Per-row ⊖ button: opens AddVolumeModal with kind=negative and the
  // target parent baked in. Closes the loop without requiring active selection.
  const handleAddNegativeToParent = useCallback((parentId: string) => {
    setAddVolumeParentId(parentId);
    setAddVolumeKind('negative');
  }, []);

  // Support painter — click mesh → upload pillar STL linked to that parent
  const [supportDiameter, setSupportDiameter] = useState(5);
  // Paint-by-layer: constrain paint/fill to Z range (null = no constraint)
  const [paintZRange, setPaintZRange] = useState<{ min: number; max: number } | null>(null);
  const paintZBounds = useMemo(() => {
    if (!activeMesh) return null;
    activeMesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(activeMesh);
    return { min: box.min.y, max: box.max.y };
  }, [activeMesh, meshRevision]);
  const handleAddSupport = useCallback(async (file: File, parentModelId: string, positionOffset: { x: number; y: number; z: number }) => {
    setIsUploading(true);
    try {
      const uploaded = await api.uploadModel(file);
      const parentPm = projectModels.find(p => p.modelId === parentModelId);
      const newPm: ProjectModel = {
        uid: makeUid(),
        modelId: uploaded.id,
        name: uploaded.name,
        faceCount: uploaded.faceCount,
        plateCount: uploaded.plateCount ?? 1,
        plateId: parentPm?.plateId ?? activePlateId,
        rotation: { x: 0, y: 0, z: 0 },
        positionOffset,
        scale: { ...DEFAULT_SCALE },
        mirror: { ...DEFAULT_MIRROR },
        faceColors: null,
        visible: true,
        kind: 'support',
        linkedTo: [parentModelId],
      };
      updateModels(prev => [...prev, newPm]);
    } catch (err) {
      alert(`Add support failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsUploading(false);
    }
  }, [projectModels, activePlateId, updateModels]);

  const isSlicing = jobs.some(j => j.status === 'running' || j.status === 'queued');
  const hasVisibleModels = activePlateModels.some(m => m.visible);
  const hasVisibleOnAnyPlate = projectModels.some(m => m.visible);
  const plateCount = plates.length;

  // Orbit controls — right-click orbits in any mode, but disabled during active paint strokes
  const isPaintingRef = useRef(false);
  useEffect(() => {
    if (!sceneRefs) return;
    const isPaintMode = paintMode === 'paint' || paintMode === 'fill' || paintMode === 'lay' || paintMode === 'support';

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
    if (!sceneRefs || paintMode !== 'orbit' || projectModels.filter(m => m.visible).length <= 1) return;
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
      for (let i = 0; i < projectModels.length; i++) {
        const pm = projectModels[i];
        if (!pm.visible) continue;
        const mesh = meshRefs.current[pm.uid];
        if (!mesh) continue;
        const hits = raycaster.intersectObject(mesh);
        if (hits.length > 0 && hits[0].distance < closestDist) {
          closestDist = hits[0].distance;
          closestIdx = i;
        }
      }
      if (closestIdx >= 0 && closestIdx !== activeModelIndex) {
        if (e.shiftKey) {
          toggleMulti(closestIdx);
        } else {
          selectSingle(closestIdx);
        }
        // Switch active plate to the picked model's plate so sidebar reflects it
        const pickedPlate = projectModels[closestIdx]?.plateId;
        if (pickedPlate && pickedPlate !== activePlateId) setActivePlateId(pickedPlate);
      } else if (!e.shiftKey && closestIdx < 0) {
        // Click empty space clears selection (unless shift held)
        selectSingle(null);
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

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 shrink-0">
        <div className="flex items-center justify-between" />
      </div>

      {/* Scrollable */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Object list */}
        <ObjectListPanel
          models={activePlateModels}
          allModels={projectModels}
          selectedIndices={selectedIndices}
          onSelect={(idx, additive) => additive ? toggleMulti(idx) : selectSingle(idx)}
          onRemove={handleRemoveModel}
          onToggleVisible={handleToggleVisible}
          onUpload={handleUpload}
          onUploadMany={handleUploadMany}
          onAutoArrange={handleAutoArrange}
          isUploading={isUploading}
          onOpenMakerworld={() => setShowMwImport(true)}
          onDuplicateAt={handleDuplicateAt}
          onAddNegativeToParent={handleAddNegativeToParent}
          plates={plates}
          activePlateId={activePlateId}
          onMoveToPlate={handleMoveToPlate}
          onDuplicateToPlate={handleDuplicateToPlate}
        />

        {/* Target printer picker */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Target</label>
            <div className="flex gap-2">
              <button onClick={() => setShowInventory(true)}
                className="text-[10px] text-gray-500 hover:text-gray-300">inventory</button>
              <button onClick={() => setShowPrinters(true)}
                className="text-[10px] text-gray-500 hover:text-gray-300">manage</button>
            </div>
          </div>
          {printers.length === 0 ? (
            <button onClick={() => setShowPrinters(true)}
              className="w-full px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-medium text-white">
              + Add Printer
            </button>
          ) : (
            <>
              <select
                value={targetPrinterId ?? ''}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setTargetPrinterId(v);
                  if (v) localStorage.setItem('snorcal_target_printer', v);
                }}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-white">
                {printers.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.model ? ` · ${p.model}` : ''}
                  </option>
                ))}
              </select>
              {activePlateModelBounds && (
                <div className="mt-1.5">
                  <MultiPrinterFit
                    printers={printers}
                    plateBounds={activePlateModelBounds}
                    activePrinterId={targetPrinterId}
                    onSelect={(id) => { setTargetPrinterId(id); localStorage.setItem('snorcal_target_printer', id); }}
                  />
                </div>
              )}
            </>
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
              multiMaterial={multiMaterial} onMultiMaterialChange={(mm) => { setMultiMaterial(mm); localStorage.setItem('snorcal_multi_material', JSON.stringify(mm)); }}
              filamentSlots={filamentSlots} onFilamentSlotsChange={(slots) => { setFilamentSlots(slots); localStorage.setItem('snorcal_filament_slots', JSON.stringify(slots)); }}
              targetPrinterModel={printers.find(p => p.id === targetPrinterId)?.model ?? null}
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
      <PlateTabs
        plates={plates.map(p => ({ id: p.id, name: p.name, modelCount: projectModels.filter(m => m.plateId === p.id).length }))}
        activePlateId={activePlateId}
        onSelect={(id) => { setActivePlateId(id); selectSingle(null); }}
        onRename={handleRenamePlate}
        onDuplicate={handleDuplicatePlate}
        onDelete={handleDeletePlate}
        onReorder={handleReorderPlates}
        onAdd={() => {
          const n = plates.length + 1;
          const id = `plate-${Date.now()}`;
          setPlates(prev => [...prev, { id, name: `Plate ${n}` }]);
          setActivePlateId(id);
          selectSingle(null);
        }}
      />

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
    <div className="h-dvh flex flex-col bg-gray-900 text-white overflow-hidden">
      {/* Top nav */}
      <header className="flex items-center justify-between px-4 py-2 bg-gray-950 border-b border-gray-800 shrink-0 z-20">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <img src="/icon-192.png" alt="" className="w-6 h-6" />
            <span className="text-base font-semibold tracking-tight">snorcal</span>
          </div>
          <nav className="flex gap-1">
            {(['home', 'slice', 'settings'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 rounded text-sm capitalize ${
                  view === v ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`}>
                {v}
              </button>
            ))}
          </nav>
        </div>
        <div className="text-xs text-gray-500">{engine}</div>
      </header>

      {/* View content */}
      {view === 'home' && (
        <HomeDashboard
          onSlice={() => setView('slice')}
          onOpenJob={(jobId) => { setPreviewJobId(jobId); setView('slice'); }}
          onOpenPrinter={(id) => { setSelectedPrinterId(id); setView('printer'); }}
          onImportMakerworld={() => setShowMwImport(true)}
        />
      )}

      {showMwImport && (
        <MakerworldImportModal
          onClose={() => setShowMwImport(false)}
          onImported={(m) => {
            setShowMwImport(false);
            handleMakerworldImported(m);
            setView('slice');
          }}
        />
      )}

      {view === 'printer' && selectedPrinterId && (
        <PrinterDetail id={selectedPrinterId} onBack={() => { setSelectedPrinterId(null); setView('home'); }} />
      )}

      {view === 'jobs' && (
        <div className="flex-1 overflow-y-auto p-6 max-w-4xl mx-auto w-full">
          <JobList jobs={jobs} onCancel={handleCancelJob} onDownload={handleDownloadGcode}
            onDownloadThreemf={handleDownloadThreemf}
            onPreview={(jid) => { setPreviewJobId(jid); setView('slice'); }}
            onSendToPrinter={handleSendToPrinter} />
        </div>
      )}

      {view === 'settings' && (
        <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto w-full">
          <AppSettingsPanel engine={engine} onEngineChange={setEngine} />
        </div>
      )}

      {view === 'slice' && (
        <div className="flex flex-1 overflow-hidden">
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
        </div>

        {/* 3D Viewer */}
        <div className="flex-1 relative overflow-hidden">
          <Scene onReady={setSceneRefs} />

          {/* Viewer enable/disable toggle — escape hatch for mobile OOM */}
          <button
            type="button"
            onClick={() => setViewer3DEnabled(v => !v)}
            className="absolute top-2 right-2 z-20 px-2 py-1 text-xs rounded bg-gray-800/80 text-gray-200 hover:bg-gray-700/80 border border-gray-600/50"
            title={viewer3DEnabled ? 'Disable 3D viewer (saves memory on mobile)' : 'Enable 3D viewer'}
          >
            {viewer3DEnabled ? '3D: On' : '3D: Off'}
          </button>
          {!viewer3DEnabled && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm bg-gray-900/60 pointer-events-none">
              3D viewer disabled — tap "3D: Off" (top-right) to re-enable
            </div>
          )}

          {/* Multi-model STL viewers — all visible models across all plates.
              On mobile or when viewer disabled, skip — full 3D for 100k+ face
              STLs OOM-kills iOS Safari tab. Toggle lives in slice toolbar. */}
          {sceneRefs && !previewJobId && viewer3DEnabled && (() => {
            const isMobile = typeof navigator !== 'undefined'
              && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
            // Parent renders alongside its printable parts so user can
            // select + paint either. (Was filtered for perf, but that
            // blocked painting the merged main object.)
            const visible = projectModels.filter(m => m.visible);
            // Mobile: only active model (if any). Desktop: all visible.
            const capped = isMobile && activeModelIndex != null
              ? visible.filter((_, i) => i === activeModelIndex)
              : isMobile ? visible.slice(0, 1) : visible;
            return capped.map((pm) => {
            const plateOff = plateOffsets[pm.plateId] ?? { x: 0, y: 0, z: 0 };
            const combined = new THREE.Vector3(
              pm.positionOffset.x + plateOff.x,
              pm.positionOffset.y + plateOff.y,
              pm.positionOffset.z + plateOff.z,
            );
            return (
              <STLViewer
                key={pm.uid}
                modelUrl={
                  pm.negativePartRef
                    ? api.getNegativePartUrl(pm.negativePartRef.parentModelId, pm.negativePartRef.plate, pm.negativePartRef.part)
                    : pm.printablePartRef
                      ? api.getPrintablePartUrl(pm.printablePartRef.parentModelId, pm.printablePartRef.plate, pm.printablePartRef.part)
                      : api.getModelUrl(pm.modelId)
                }
                faceColors={pm.faceColors || undefined}
                rotation={pm.rotation}
                positionOffset={combined}
                scale={pm.scale}
                mirror={pm.mirror}
                kind={pm.kind}
                sceneRef={{ current: sceneRefs }}
                onGeometryReady={(geometry, mesh) => handleGeometryReady(pm.uid, geometry, mesh)}
              />
            );
          });
          })()}

          {/* Bed grids — one per plate, side-by-side; active plate highlighted */}
          {sceneRefs && (
            <Bed
              sceneRefs={sceneRefs}
              size={bedVolume ?? { x: 200, y: 200, z: 200 }}
              plates={plates.map(p => ({
                id: p.id,
                offset: plateOffsets[p.id] ?? { x: 0, y: 0, z: 0 },
                active: p.id === activePlateId,
              }))}
              onSelectPlate={setActivePlateId}
            />
          )}

          {/* Active model interaction */}
          {sceneRefs && hasVisibleModels && !previewJobId && (
            <>
              <AxisIndicator sceneRefs={sceneRefs} />
              <ModelMover
                mesh={activeMesh}
                sceneRefs={sceneRefs}
                active={paintMode === 'orbit'}
                bounds={activePlateBounds}
                onPositionChange={handlePositionChange}
                onDragEnd={handlePositionChange}
              />
              {paintMode === 'transform' && !isCoarsePointer() && selectedMeshesForGizmo.length > 0 && (
                <TransformGizmo
                  sceneRefs={sceneRefs}
                  selectedMeshes={selectedMeshesForGizmo}
                  selectedModels={selectedModelsForGizmo}
                  selectedGlobalIndices={selectedGlobalIndicesArr}
                  mode={transformMode}
                  space={transformSpace}
                  snap={snapSettings}
                  onTransformApplied={handleGizmoTransform}
                />
              )}
              <CollisionOverlay
                sceneRefs={sceneRefs}
                models={activePlateModels}
                meshes={activePlateMeshes}
                enabled={collisionEnabled}
              />
              <MultiMeasureOverlay
                sceneRefs={sceneRefs}
                models={selectedModelsForGizmo}
                meshes={selectedMeshesForGizmo}
                enabled={measureEnabled}
              />
              <FacePainter
                mesh={activeMesh}
                renderer={sceneRefs.renderer}
                activeColor={activeColor}
                paintMode={paintMode}
                zRange={paintZRange}
                onLayOnFace={handleLayOnFace}
              />
              <MeasureTool
                sceneRefs={sceneRefs}
                meshes={Object.values(meshRefs.current).filter((m): m is THREE.Mesh => !!m)}
                active={paintMode === 'measure'}
                onMeasurementChange={setMeasurement}
              />
              <SupportPainter
                sceneRefs={sceneRefs}
                meshes={Object.values(meshRefs.current).filter((m): m is THREE.Mesh => !!m)}
                projectModels={projectModels}
                active={paintMode === 'support'}
                pillarDiameter={supportDiameter}
                onAdd={handleAddSupport}
              />
              <CutTool
                sceneRefs={sceneRefs}
                mesh={activeMesh}
                baseName={activeModel?.name}
                active={paintMode === 'cut'}
                onCutComplete={handleCutComplete}
                onCancel={() => setPaintMode('orbit')}
              />
              <ViewerToolbar
                paintMode={paintMode}
                onModeChange={setPaintMode}
                activeColor={activeColor}
                onColorChange={setActiveColor}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={canUndo}
                canRedo={canRedo}
                onSave={handleSaveColors}
                rotation={activeModel?.rotation || { x: 0, y: 0, z: 0 }}
                onRotationChange={handleRotationChange}
                onAutoOrient={handleAutoOrient}
                filamentColors={filamentSlots.map(s => s.color)}
                supportDiameter={supportDiameter}
                onSupportDiameterChange={setSupportDiameter}
                paintZRange={paintZRange}
                paintZBounds={paintZBounds}
                onPaintZRangeChange={setPaintZRange}
                onToggleBrim={toggleBrim}
                brimOn={settings.brim_type === 'brim_ears' && Number(settings.brim_width || 0) > 0}
                onToggleHollow={toggleHollow}
                hollowOn={settings.sparse_infill_density === '0%'
                  && Number(settings.top_shell_layers || 99) === 0
                  && Number(settings.bottom_shell_layers || 99) === 0}
                transformMode={transformMode}
                onTransformModeChange={setTransformMode}
                transformSpace={transformSpace}
                onTransformSpaceChange={setTransformSpace}
                snapEnabled={snapEnabled}
                onSnapToggle={setSnapEnabled}
                snapTranslateMM={snapTranslateMM}
                onSnapTranslateMMChange={setSnapTranslateMM}
                snapRotateDeg={snapRotateDeg}
                onSnapRotateDegChange={setSnapRotateDeg}
                isCoarsePointer={isCoarsePointer()}
                collisionEnabled={collisionEnabled}
                onCollisionToggle={setCollisionEnabled}
                measureEnabled={measureEnabled}
                onMeasureToggle={setMeasureEnabled}
              />
              {paintMode === 'transform' && (
                <TransformPanel
                  selectedModels={selectedModelsForGizmo}
                  onUpdateAll={handleUpdateAllSelected}
                  onResetOrigin={handleResetOrigin}
                  boundsMM={activeMesh ? computeMeshBoundsMM(activeMesh) : undefined}
                  onDuplicate={handleDuplicate}
                  onLinearArray={handleLinearArray}
                  onCircularArray={handleCircularArray}
                  onAddVolume={(k) => setAddVolumeKind(k as 'negative' | 'modifier')}
                />
              )}

              {addVolumeKind && (
                <AddVolumeModal
                  kind={addVolumeKind}
                  onAdd={handleAddVolume}
                  onCancel={() => setAddVolumeKind(null)}
                />
              )}

              {paintMode === 'measure' && (
                <div className="absolute top-14 left-2 bg-gray-800/95 backdrop-blur rounded-lg px-3 py-2 shadow-lg z-20 text-xs text-gray-300 max-w-xs">
                  {measurement ? (
                    <div className="space-y-0.5 font-mono">
                      <div className="text-yellow-300 text-sm font-bold">{measurement.distance.toFixed(2)} mm</div>
                      <div>ΔX {measurement.dx.toFixed(2)}</div>
                      <div>ΔY {measurement.dy.toFixed(2)}</div>
                      <div>ΔZ {measurement.dz.toFixed(2)}</div>
                      <div>∠XY {measurement.angleXY.toFixed(1)}°</div>
                      <div className="text-gray-500 mt-1">Right-click / Esc to clear</div>
                    </div>
                  ) : (
                    <div>Click two points on a model</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Gcode preview */}
          {previewJobId && gcodeText && (
            <>
              <GcodePreviewCanvas gcode={gcodeText} layer={currentPreviewLayer} singleLayerMode={!showAllLayers}
                extrusionColors={previewExtrusionColors} buildVolume={bedVolume ?? undefined}
                colorMode={gcodeColorMode} onLayerCountReady={handleLayerCountReady} />
              <GcodeTimeBreakdown gcode={gcodeText} />
              <GcodeLayerStrip
                currentLayer={currentPreviewLayer}
                totalLayers={layerCount}
                layerTypes={layerTypes}
                onLayerChange={setCurrentPreviewLayer}
              />
              <LiveMonitorOverlay
                statuses={printerStatuses}
                names={Object.fromEntries(printers.map(p => [p.id, p.name]))}
                cameras={Object.fromEntries(printers.map(p => [p.id, p.cameraSnapshotUrl ?? `/api/printers/${p.id}/camera`]))}
                focusPrinterId={targetPrinterId}
              />
              {layerCount > 0 && (
                <GcodeLayerSlider currentLayer={currentPreviewLayer} totalLayers={layerCount} showAllLayers={showAllLayers}
                  onLayerChange={setCurrentPreviewLayer} onShowAllLayersChange={setShowAllLayers} onExit={handleExitPreview}
                  colorMode={gcodeColorMode} onColorModeChange={setGcodeColorMode}
                  pauses={jobPauses} onTogglePause={handleTogglePause} />
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
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files).filter(f => /\.(stl|step|stp|3mf)$/i.test(f.name));
                if (files.length === 1) handleUpload(files[0]);
                else if (files.length > 1) handleUploadMany(files);
              }}
              onDragOver={(e) => e.preventDefault()}>
              <input ref={uploadInputRef} type="file" accept=".stl,.step,.stp,.3mf" multiple
                onChange={(e) => {
                  const list = e.target.files;
                  if (!list || list.length === 0) return;
                  const files = Array.from(list);
                  if (files.length === 1) handleUpload(files[0]);
                  else handleUploadMany(files);
                  e.target.value = '';
                }} className="hidden" />
              <div className="text-center px-4">
                <svg className="w-16 h-16 mx-auto mb-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                <p className="text-lg">Click or drop files to upload</p>
                <p className="text-sm mt-1">Supports .stl, .step, .3mf — multiple OK</p>
              </div>
            </div>
          )}
        </div>
      </main>
        </div>
      )}

      {showPrinters && <PrinterDashboard onClose={() => setShowPrinters(false)} />}
      {showInventory && <InventoryPanel onClose={() => setShowInventory(false)} />}
      {remapJobId && targetPrinterId && (() => {
        const p = printers.find(x => x.id === targetPrinterId);
        if (!p) return null;
        return (
          <FilamentRemapModal
            jobId={remapJobId}
            printerId={targetPrinterId}
            printerProtocol={p.protocol as 'moonraker' | 'bambu'}
            printerManualSlots={p.manualSlots ?? 0}
            printerStatus={printerStatuses[targetPrinterId]}
            onClose={() => setRemapJobId(null)}
            onSent={(printerPath) => {
              setRemapJobId(null);
              alert(`Sent to printer. Path: ${printerPath}`);
            }}
          />
        );
      })()}
      {showAddPrinter && (
        <AddPrinterModal
          onClose={() => setShowAddPrinter(false)}
          onAdded={() => {
            setShowAddPrinter(false);
            api.listPrinters().then(list => {
              setPrinters(list.map(p => ({ id: p.id, name: p.name, model: p.model, protocol: p.protocol, bedVolume: p.bedVolume ?? null, cameraSnapshotUrl: p.cameraSnapshotUrl ?? null, manualSlots: p.manualSlots ?? 0 })));
            }).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
