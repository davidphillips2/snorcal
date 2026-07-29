import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { Scene, type SceneRefs } from './components/Viewer/Scene';
import { STLViewer, extractFaceColors, autoOrient, type Rotation3D } from './components/Viewer/STLViewer';
import { FacePainter, type PaintMode } from './components/Viewer/FacePainter';
import { ViewerToolbar } from './components/Viewer/ViewerToolbar';
import { TransformPanel } from './components/ModelEdit/TransformPanel';
import { MeasureTool, type Measurement } from './components/ModelEdit/MeasureTool';
import { CutTool, type CutPiece } from './components/ModelEdit/CutTool';
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
import { DEFAULT_VALUES } from './components/Settings/settings-definitions';
import { PRINTERS, getSavedPrinter } from './config/printers';
import { GcodePreviewCanvas } from './components/Viewer/GcodePreviewCanvas';
import { GcodeLayerSlider } from './components/Viewer/GcodeLayerSlider';
import { GcodeTimeBreakdown } from './components/Viewer/GcodeTimeBreakdown';
import { GcodeLayerStrip } from './components/Viewer/GcodeLayerStrip';
import { PrinterDashboard } from './components/PrinterMonitor/PrinterDashboard';
import { InventoryPanel } from './components/Inventory/InventoryPanel';
import { MultiPrinterFit } from './components/PrinterMonitor/MultiPrinterFit';
import { LiveMonitorOverlay } from './components/PrinterMonitor/LiveMonitorOverlay';
import { useToast } from './components/Toast';
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
import {
  type ProjectModel, type Job, type UploadModelMeta,
  DEFAULT_SCALE, DEFAULT_MIRROR, makeUid,
  buildNegativeChildPms, buildPrintableChildPms,
} from './lib/project-types';
// Re-export ProjectModel so existing `import { ProjectModel } from './App'`
// sites keep working. Long-term these should import from lib/project-types.
export type { ProjectModel };
import { type PersistedState, loadPersistedState, savePersistedState } from './lib/persistence';
import { buildSliceBody as buildSliceBodyFn } from './lib/slice-body';
import { TransformGizmo } from './components/Viewer/TransformGizmo';
import { CollisionOverlay } from './components/Viewer/CollisionOverlay';
import { MultiMeasureOverlay } from './components/Viewer/MultiMeasureOverlay';
import { isCoarsePointer, type TransformMode, type TransformSpace, type SnapSettings } from './lib/transforms';
import type { ModelKind, Scale3D, Mirror3D, FilamentSlot } from '@snorcal/shared';

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
  const toast = useToast();
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
  const [filamentSlots, setFilamentSlots] = useState<FilamentSlot[]>(() =>
    persisted.current?.filamentSlots || (() => { try { return JSON.parse(localStorage.getItem('snorcal_filament_slots') || 'null'); } catch { return null; } })() || [{ color: '#FF0000', type: 'PLA' }]
  );
  // Pending embedded slicer settings offered to the user on 3MF load. When
  // present, a banner renders with Apply/Dismiss. We don't auto-apply printer/
  // process keys because that silently swaps the user's selected printer.
  const [embeddedSettingsPrompt, setEmbeddedSettingsPrompt] = useState<{ blob: Record<string, unknown>; summary: string } | null>(null);
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
  // Auto-disable 3D viewer on mobile when project has multiple plates. Each
  // plate's STL can be 400k+ faces; loading any one OOM-kills iOS Safari
  // before the user can toggle the viewer off. Re-enabled automatically if
  // plates drop back to 1 (e.g. user deletes extra plates).
  useEffect(() => {
    if (isMobileUA && plates.length > 1 && viewer3DEnabled) {
      setViewer3DEnabled(false);
    }
  }, [isMobileUA, plates.length, viewer3DEnabled]);
  const [selectedPrinterId, setSelectedPrinterId] = useState<string | null>(() => persisted.current?.selectedPrinterId ?? null);
  const [showSidebar, setShowSidebar] = useState(() => persisted.current?.showSidebar ?? false);
  const [showSettings, setShowSettings] = useState(() => persisted.current?.showSettings ?? true);
  const [showJobs, setShowJobs] = useState(() => persisted.current?.showJobs ?? false);
  const [showPrinters, setShowPrinters] = useState(false);
  const [showInventory, setShowInventory] = useState(() => persisted.current?.showInventory ?? false);
  const [showMwImport, setShowMwImport] = useState(false);
  const [showAddPrinter, setShowAddPrinter] = useState(false);

  // Registered printers (for target picker + Send)
  const [printers, setPrinters] = useState<Array<{ id: string; name: string; model?: string | null; protocol: string; bedVolume?: { x: number; y: number; z: number } | null; cameraSnapshotUrl?: string | null; protocolCamId?: string; manualSlots?: number; manualFilaments?: Array<{ color: string; type: string; brand?: string; remain?: number }> }>>([]);
  const [printerStatuses, setPrinterStatuses] = useState<Record<string, PrinterStatus>>({});
  const [targetPrinterId, setTargetPrinterId] = useState<string | null>(() => localStorage.getItem('snorcal_target_printer'));
  const [bedVolume, setBedVolume] = useState<{ x: number; y: number; z: number } | null>(null);
  useEffect(() => {
    api.listPrinters().then(list => {
      setPrinters(list.map(p => ({ id: p.id, name: p.name, model: p.model, protocol: p.protocol, bedVolume: p.bedVolume ?? null, cameraSnapshotUrl: p.cameraSnapshotUrl ?? null, manualSlots: p.manualSlots ?? 0, manualFilaments: p.manualFilaments })));
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
    if (!targetPrinterId) {
      // No DB printer selected — fall back to legacy PRINTERS preset (if any)
      // so gcode-preview renders the correct bed size. Without this, the
      // preview falls back to 200x200 and objects centered for a 270-bed
      // printer look off-center, with prime tower drawn outside the visible bed.
      const legacy = PRINTERS.find(p => p.id === getSavedPrinter()?.id);
      setBedVolume(legacy?.buildVolume ?? null);
      return;
    }
    api.listPrinters().then(list => {
      const p = list.find(x => x.id === targetPrinterId);
      // DB record may have null bedVolume (older entries, or model field not
      // matched against machine profile). Fall back to PRINTERS preset by
      // model/name — DB printer rows use uuid ids that never equal preset
      // ids (e.g. "bambu_p1s"), so the previous `lp.id === p?.id` lookup
      // always missed. Without this, gcode-preview defaults to 200x200 and
      // objects centered for a 256/270-bed printer appear shifted off plate.
      const legacy = !p?.bedVolume
        ? PRINTERS.find(lp => {
            const model = (p?.model ?? '').toLowerCase();
            const name = (p?.name ?? '').toLowerCase();
            return (model && lp.name.toLowerCase() === model)
              || (name && lp.name.toLowerCase() === name)
              || (model && lp.name.toLowerCase().includes(model));
          })?.buildVolume
        : undefined;
      setBedVolume(p?.bedVolume ?? legacy ?? null);
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
  // Split once; share the line array with the parsers and the preview to avoid
  // 3+ simultaneous full copies of large gcodes (was an OOM driver).
  const gcodeLines = useMemo(() => gcodeText ? gcodeText.split('\n') : null, [gcodeText]);
  const layerTypes = useMemo(() => gcodeLines ? extractLayerTypes(gcodeLines) : new Map<number, string>(), [gcodeLines]);
  // Stable colors array — inline .map() would create a new ref every render
  // and re-trigger GcodePreviewCanvas's init effect, disposing the preview.
  const previewExtrusionColors = useMemo(() => filamentSlots.map(s => {
    // Filament slots store RGBA (Bambu format, 8 hex). Three.Color rejects
    // anything ≠ 6 hex → invalid color warning → defaults white. Strip alpha.
    const c = s.color.replace(/^#/, '');
    return c.length === 8 ? `#${c.slice(0, 6)}` : s.color;
  }), [filamentSlots]);

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
        filamentCost: j.filamentCost, errorMessage: j.errorMessage,
        printerName: j.printerName, createdAt: j.createdAt,
      })));
    }).catch(err => {
      console.error('listJobs failed', err);
      toast.error('Failed to load jobs', err instanceof Error ? err.message : String(err));
    });

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
    // Mobile multi-plate: only fetch colors for the active plate. Each blob
    // is faceCount × 9 bytes (non-indexed) — 4-plate imports hit 10MB+ and
    // OOM-kill iOS Safari before the user can toggle the viewer off.
    const isMobileUA = typeof navigator !== 'undefined'
      && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const mobileMultiPlate = isMobileUA && plates.length > 1;
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
      if (mobileMultiPlate && pm.plateId !== activePlateId) continue;
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
      const plate = pm.backendPlateIndex;
      api.getModelColors(pm.modelId, plate).then(colors => {
        setProjectModels(prev => prev.map(p =>
          p.modelId === pm.modelId && p.backendPlateIndex === plate
            ? { ...p, faceColors: colors }
            : p,
        ));
      }).catch(() => {});
    }
  }, [projectModels.length, viewer3DEnabled, plates.length, activePlateId]);

  // Load default settings when engine actually changes. Previously this effect
  // ran on every mount (engine is just the initial value, deps compare ===),
  // overwriting persisted settings — user imports 3MF, applies wall_loops=6,
  // reloads, this effect fires setSettings(backendDefaults) and silently
  // wipes the applied value back to default. Gate on whether we already have
  // persisted settings for this engine; only seed defaults on first run.
  const seededEngineRef = useRef<string | null>(null);
  useEffect(() => {
    const hadPersisted = persisted.current !== null || Object.keys(settings).length > 0;
    if (hadPersisted && seededEngineRef.current === engine) return;
    seededEngineRef.current = engine;
    api.getDefaultSettings(engine).then((data) => {
      if (data?.process) {
        // Merge over existing so user edits + applied 3MF values survive —
        // backend defaults are just a base layer for keys the user hasn't
        // touched.
        setSettings(prev => ({ ...data.process, ...prev }));
      }
    }).catch(err => {
      console.error('getDefaultSettings failed', err);
      toast.error('Failed to load default slicer settings', err instanceof Error ? err.message : String(err));
    });
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
          // Multi-plate tags — without these, reload forgets which backend
          // plate a pm maps to (wrong STL/slice target) + loses object-name
          // summaries in the plate tabs.
          backendPlateIndex: m.backendPlateIndex,
          backendPlateObjectNames: m.backendPlateObjectNames,
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
        prev.map((j) => {
          if (j.id !== jobId) return j;
          // job:completed/job:failed events carry only jobId — force progress
          // to 100 (or last for failed) so the bar doesn't freeze at whatever
          // the last progress tick happened to land on.
          if (msg.type === 'job:completed') {
            return { ...j, status: 'completed', progress: 100, currentStep: undefined, errorMessage: undefined };
          }
          if (msg.type === 'job:failed') {
            return { ...j, status: 'failed', errorMessage: (msg.data.error as string) ?? j.errorMessage };
          }
          // job:progress
          return {
            ...j, status: 'running',
            progress: (msg.data.progress as number) ?? j.progress,
            currentStep: (msg.data.currentStep as string) ?? j.currentStep,
          };
        }),
      );
    }
    if (printerListDirty) {
      api.listPrinters().then(list => {
        setPrinters(list.map(p => ({ id: p.id, name: p.name, model: p.model, protocol: p.protocol, bedVolume: p.bedVolume ?? null, cameraSnapshotUrl: p.cameraSnapshotUrl ?? null, manualSlots: p.manualSlots ?? 0, manualFilaments: p.manualFilaments })));
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
      await addModelToProject(model);
    } catch (err) {
      toast.error('Upload failed', err instanceof Error ? err.message : String(err));
    } finally {
      setIsUploading(false);
    }
  }, [projectModels.length]);

  /** Shared insertion logic for handleUpload + handleUploadMany.
   *  Multi-plate 3MFs expand to one UI plate per backend plate; each pm
   *  carries `backendPlateIndex` so STL fetch + slice request hit the right
   *  backend plate. Single-plate uploads land on the active UI plate as-is. */
  const addModelToProject = useCallback(async (model: {
    id: string; name: string; faceCount: number; plateCount: number;
    bounds: { x: number; y: number; z: number };
    boundsMin?: { x: number; y: number; z: number };
    boundsMax?: { x: number; y: number; z: number };
    plates?: Array<{ index: number; faceCount: number; bounds: { x: number; y: number; z: number }; objectNames?: string[] }>;
    negativeParts?: Array<{ plateIndex: number; partIndex: number; faceCount: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number } }>;
    parts?: Array<{ plateIndex: number; partIndex: number; faceCount: number; name?: string; extruder?: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number } }>;
  }) => {
    const baseOffset = projectModels.length * 50;

    // Multi-plate: one UI plate per backend plate. Each pm tags backendPlateIndex
    // so /files/model/:id?plate=N + slice plateIndex + color save/load all hit
    // the right backend plate.
    if ((model.plateCount ?? 1) > 1 && model.plates && model.plates.length > 0) {
      const newPlates: Array<{ id: string; name: string }> = [];
      const newPms: ProjectModel[] = [];
      model.plates.forEach((p, i) => {
        const plateId = `plate-${Date.now()}-${i}`;
        // Tab label stays short ("Plate N") so the horizontal tab strip
        // doesn't explode in width. Object names go into the subtitle line
        // below the tab where they have room to wrap.
        const label = `Plate ${p.index}`;
        newPlates.push({ id: plateId, name: label });
        newPms.push({
          uid: makeUid(),
          modelId: model.id,
          name: label,
          faceCount: p.faceCount,
          plateCount: model.plateCount,
          backendPlateIndex: p.index,
          backendPlateObjectNames: p.objectNames,
          plateId,
          rotation: { x: 0, y: 0, z: 0 },
          positionOffset: { x: 0, y: 0, z: 0 },
          scale: { ...DEFAULT_SCALE },
          mirror: { ...DEFAULT_MIRROR },
          faceColors: null,
          visible: true,
          kind: 'model',
        });
      });
      setPlates(prev => [...prev, ...newPlates]);
      updateModels(prev => [...prev, ...newPms]);
      if (newPlates.length > 0) {
        setActivePlateId(newPlates[0].id);
        selectSingle(projectModels.length);
      }
    } else {
      const newPm: ProjectModel = {
        uid: makeUid(),
        modelId: model.id,
        name: model.name,
        faceCount: model.faceCount,
        plateCount: model.plateCount ?? 1,
        plateId: activePlateId,
        rotation: { x: 0, y: 0, z: 0 },
        positionOffset: { x: baseOffset, y: 0, z: 0 },
        scale: { ...DEFAULT_SCALE },
        mirror: { ...DEFAULT_MIRROR },
        faceColors: null,
        visible: true,
        kind: 'model',
      };
      const negativePms = buildNegativeChildPms(model, activePlateId, baseOffset);
      const partPms = buildPrintableChildPms(model, activePlateId);
      updateModels(prev => [...prev, newPm, ...partPms, ...negativePms]);
      selectSingle(projectModels.length);
    }

    await applySourceSettings(model.id);
  }, [projectModels.length, activePlateId, updateModels]);

  // Sequential multi-file upload — preserves order, sets isUploading once for batch
  const handleUploadMany = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setIsUploading(true);
    try {
      for (const file of files) {
        try {
          const model = await api.uploadModel(file);
          await addModelToProject(model);
        } catch (err) {
          console.error(`Upload failed for ${file.name}:`, err);
        }
      }
    } finally {
      setIsUploading(false);
    }
  }, [addModelToProject]);

  // MakerWorld import — backend already registered the 3MF, just fetch metadata + add to scene
  const handleMakerworldImported = useCallback(async (m: { modelId: string; name: string; plateCount: number }) => {
    try {
      const meta = await api.getModel(m.modelId) as any;
      await addModelToProject({
        id: m.modelId,
        name: m.name,
        faceCount: meta?.faceCount ?? 0,
        plateCount: meta?.plateCount ?? m.plateCount ?? 1,
        bounds: meta?.bounds ?? { x: 0, y: 0, z: 0 },
        boundsMin: meta?.boundsMin,
        boundsMax: meta?.boundsMax,
        plates: meta?.plates,
        negativeParts: meta?.negativeParts,
        parts: meta?.parts,
      });
      // MakerWorld imports explicitly overwrite project settings (user opted
      // into the bundle's full slicer config). Plain uploads use the same
      // helper but skip the settings overwrite.
      await applySourceSettings(m.modelId);
    } catch (err) {
      toast.error('MakerWorld import failed', err instanceof Error ? err.message : String(err));
    }
  }, [addModelToProject]);

  /**
   * Fetch a model's embedded project_settings.config and sync its
   * filament_colour / filament_type arrays into the per-slot UI state.
   *
   * `overwriteSettings` controls whether the full settings blob replaces the
   * user's current project settings — true for MakerWorld imports (user
   * explicitly opted into the bundle), false for plain uploads (we only want
   * the filament slots, not the printer profile / gcode macros).
   */
  /**
   * Apply embedded 3MF settings on load. Used by BOTH plain upload and
   * MakerWorld import (same behavior — no more silent printer-swap on MW).
   *
   * - Filament metadata (color/type/vendor/diameter/density/cost) is always
   *   extracted into filamentSlots.
   * - Full embedded printer/process settings are NOT auto-applied. If they
   *   differ from the user's current selection, a banner prompts Apply/Dismiss.
   * - 404 ("no embedded settings") is silent (model just has no config).
   *   Other errors surface as an alert so loads don't fail invisibly.
   */
  const applySourceSettings = useCallback(async (modelId: string) => {
    let sourceSettings: Record<string, unknown> | null;
    try {
      sourceSettings = await api.getModelSourceSettings(modelId);
    } catch (err) {
      // 404 = model has no embedded settings — benign, nothing to apply.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not found|no source settings/i.test(msg)) {
        toast.error('Failed to load embedded settings', msg);
      }
      return;
    }
    if (!sourceSettings || typeof sourceSettings !== 'object') return;

    // Helper: read a filament_* key as a string array (the slicer schema shape).
    const arr = (k: string): string[] | undefined => {
      const v = sourceSettings[k];
      return Array.isArray(v) ? v.map(x => typeof x === 'string' ? x : String(x)) : undefined;
    };

    // Rich filament-slot extraction (was color+type only).
    const colors = arr('filament_colour');
    if (colors && colors.length > 0) {
      const vendors = arr('filament_vendor');
      const types = arr('filament_type');
      const diameters = arr('filament_diameter');
      const densities = arr('filament_density');
      const costs = arr('filament_cost');
      const newSlots: FilamentSlot[] = colors.map((c, i) => ({
        color: c || '#FFFFFF',
        type: types?.[i] || 'PLA',
        vendor: vendors?.[i],
        diameter: diameters?.[i],
        density: densities?.[i],
        cost: costs?.[i],
      }));
      setFilamentSlots(newSlots);
    }

    // Auto-apply ONLY filament color/type metadata (visible slot state).
    // Full printer/process/profile overlay waits for explicit user Apply
    // via the banner below — auto-applying silently overwrote user's PETG
    // choice + bed_type + per-key numeric edits every reload.
    const cur = (k: string): string | undefined => {
      const v = sourceSettings[k];
      if (v == null) return undefined;
      return typeof v === 'string' ? v : JSON.stringify(v);
    };
    const printerModel = cur('printer_model') ?? '';
    const process = cur('print_settings_id') ?? cur('process_class') ?? '';
    const summary = [printerModel, process].filter(Boolean).join(' · ') || 'embedded slicer profile';
    // Keep the RAW blob — synthesize endpoint needs original nested/array
    // values to build profiles correctly.
    setEmbeddedSettingsPrompt({ blob: sourceSettings, summary });
  }, []);

  // Apply embedded settings: synthesize profiles into the DB (named by the
  // blob's *_settings_id keys) so the dropdowns can select them, then overlay
  // the raw numeric settings onto `settings` and select the new profiles.
  const handleApplyEmbeddedSettings = useCallback(async () => {
    if (!embeddedSettingsPrompt) return;
    const { blob } = embeddedSettingsPrompt;
    try {
      const names = await api.synthesizeEmbeddedProfiles(engine, blob);
      setSelectedProfiles(prev => ({
        ...prev,
        machine: names.machine ?? prev.machine,
        process: names.process ?? prev.process,
        filament: names.filament ?? prev.filament,
      }));
    } catch (err) {
      console.warn('synthesizeEmbeddedProfiles failed:', err);
    }
    // Skip gcode blobs + speed/accel/jerk (let user's existing tune win).
    const isSpeedAccel = (k: string): boolean =>
      k.endsWith('_speed') || k.endsWith('_acceleration') || k.endsWith('_jerk')
      || k === 'default_acceleration' || k === 'default_jerk'
      || k === 'accelerate_to_speed' || k === 'slow_down_layers';
    const coerced: Record<string, string> = {};
    for (const [k, v] of Object.entries(blob)) {
      if (v == null || k.endsWith('_gcode')) continue;
      if (isSpeedAccel(k)) continue;
      coerced[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    setSettings(prev => ({ ...prev, ...coerced }));
    setEmbeddedSettingsPrompt(null);
  }, [embeddedSettingsPrompt, engine]);

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
          api.saveFaceColors(pm.modelId, colors, pm.backendPlateIndex ?? (pm.plateCount > 1 ? plateIndex : undefined))
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
    return api.submitSliceJob(buildSliceBody(models));
  }, [engine, settings, selectedProfiles, multiMaterial, filamentSlots, bedVolume, plates]);

  // Build a SliceRequest body for the given models. Shared by `sliceModels`
  // (POST /api/slice) and `handleSaveThreemf` (POST /api/files/preview-3mf)
  // so the pre-slice download is byte-identical to what would have been sent.
  const buildSliceBody = useCallback((models: ProjectModel[]) => {
    return buildSliceBodyFn(models, {
      engine, settings, selectedProfiles, multiMaterial, filamentSlots,
      bedVolume, plates, targetPrinterId,
    });
  }, [engine, settings, selectedProfiles, multiMaterial, filamentSlots, bedVolume, plates, targetPrinterId]);

  // Save the input 3MF without slicing — useful when slice fails and you want
  // to inspect the exact bytes snorcal would have sent, or to slice in
  // OrcaSlicer / bambuddy UI directly.
  const handleSaveThreemf = useCallback(async () => {
    const visible = activePlateModels.filter(m => m.visible);
    if (visible.length === 0) return;
    try {
      await saveAllColors();
      const { url, filename } = await api.buildPreview3mf(buildSliceBody(visible));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error('Save 3MF failed:', err);
      toast.error('Save 3MF failed', err instanceof Error ? err.message : String(err));
    }
  }, [activePlateModels, saveAllColors, buildSliceBody]);

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
      toast.error('Slice failed', err instanceof Error ? err.message : String(err));
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
      toast.error('Slice failed', err instanceof Error ? err.message : String(err));
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
      await api.saveFaceColors(pm.modelId, colors, pm.backendPlateIndex ?? (pm.plateCount > 1 ? plateIndex : undefined));
    } catch (err) { console.error('Save failed:', err); }
  }, [activeModelIndex, projectModels, plates]);

  const handleCancelJob = useCallback(async (jobId: string) => {
    try {
      await api.cancelJob(jobId);
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'cancelled' } : j));
      toast.info('Job cancelled');
    } catch (err) {
      toast.error('Cancel failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [toast]);

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
      toast.error('Failed to update pauses', err instanceof Error ? err.message : String(err));
    }
  }, [previewJobId, jobPauses, printers, targetPrinterId]);

  const [remapJobId, setRemapJobId] = useState<string | null>(null);

  const handleSendToPrinter = useCallback(async (jobId: string) => {
    if (!targetPrinterId) {
      toast.warning('No target printer selected', 'Add a printer first.');
      return;
    }
    const printer = printers.find(p => p.id === targetPrinterId);
    if (!printer) { toast.error('Target printer not found'); return; }

    // Check if the send dialog is needed. Bambu printers always need the
    // dialog — print options (bed leveling, flow cali, vibration comp,
    // timelapse) apply on every send, and AMS mapping may be needed even
    // for single-filament prints. Moonraker/Klipper only needs the dialog
    // when filament remapping is required (multi-filament gcode or manual
    // slots on the printer).
    let filaments: api.JobFilament[] = [];
    try {
      filaments = await api.getJobFilaments(jobId);
    } catch (err) {
      toast.error('Could not read job filaments', err instanceof Error ? err.message : String(err));
      return;
    }
    const usedCount = filaments.filter(f => f.used).length;
    const hasAms = printer.protocol === 'bambu' && printerStatuses[targetPrinterId]?.ams && printerStatuses[targetPrinterId]!.ams!.length > 0;
    const hasManualSlots = (printer.manualSlots ?? 0) > 0;
    const needsRemap = printer.protocol === 'bambu'
      || usedCount > 1
      || ((hasAms || hasManualSlots) && filaments.length > 0);

    if (needsRemap) {
      setRemapJobId(jobId);
      return;
    }

    // Direct send — no remap
    try {
      const result = await api.sendToRegisteredPrinter(targetPrinterId, jobId, true);
      toast.success('Sent to printer', result.printerPath);
    } catch (err) { toast.error('Send failed', err instanceof Error ? err.message : String(err)); }
  }, [targetPrinterId, printers, printerStatuses, toast]);

  const handleQueueOnPrinter = useCallback(async (jobId: string) => {
    if (!targetPrinterId) {
      toast.warning('No target printer selected', 'Add a printer first.');
      return;
    }
    try {
      const result = await api.addToPrintQueue(targetPrinterId, jobId);
      toast.info(result.duplicate ? 'Already in queue' : 'Added to queue');
    } catch (err) {
      toast.error('Queue failed', err instanceof Error ? err.message : String(err));
    }
  }, [targetPrinterId, toast]);

  const targetPrinter = printers.find(p => p.id === targetPrinterId);

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
  const handleCutComplete = useCallback(async (pieces: CutPiece[], mode: 'objects' | 'parts') => {
    if (pieces.length === 0) return;
    const parentId = activeModel?.modelId;
    setIsUploading(true);
    try {
      const uploaded = await Promise.all(pieces.map(p => api.uploadModel(p.file)));
      // Both modes place each piece at the original's position so the cut
      // result sits where the source sat. Geometry is already world-baked in
      // CutTool, so identity rotation is correct here.
      const newModels: ProjectModel[] = uploaded.map((m, i) => ({
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
        // 'parts' mode: link halves to the original as printable parts so they
        // slice together as one assembly (threemf-builder treats a parent with
        // kind:'part' children as a container and emits the parts' geometry).
        // 'objects' mode: independent models, no link.
        kind: mode === 'parts' && parentId ? 'part' : 'model',
        linkedTo: mode === 'parts' && parentId ? [parentId] : undefined,
      }));

      updateModels(prev => {
        if (mode === 'parts' && parentId) {
          // Keep the original as the assembly container; append halves as parts.
          // Parent's own mesh is dropped at slice time because it has part
          // children (threemf-builder parentsWithParts).
          return [...prev, ...newModels];
        }
        // objects mode: replace the original with the independent halves.
        const without = activeModelIndex == null ? prev : prev.filter((_, i) => i !== activeModelIndex);
        return [...without, ...newModels];
      });

      // Selection: jump to the first new model. Compute its index from the
      // current array length (parts mode appends; objects mode removes 1 then
      // appends N). Either way the first new index = pre-update length minus
      // (1 if original removed, else 0).
      const firstNewIdx = mode === 'parts'
        ? projectModels.length
        : projectModels.length - 1;
      setSelectedIndices(new Set([firstNewIdx]));
      setPaintMode('orbit');
    } catch (err) {
      toast.error('Cut upload failed', err instanceof Error ? err.message : String(err));
    } finally {
      setIsUploading(false);
    }
  }, [activeModel, activeModelIndex, activePlateId, projectModels.length]);

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
      toast.warning('Select a model first', 'Attach a volume to a selected model.');
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
      toast.error('Add volume failed', err instanceof Error ? err.message : String(err));
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
      toast.error('Add support failed', err instanceof Error ? err.message : String(err));
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

  // Plate tabs — single source of truth. Rendered in BOTH the sidebar (desktop
  // layout + mobile-with-viewer-on) and the viewer-off settings panel, so
  // mobile users without 3D can still switch plates without opening the sidebar.
  const plateTabs = plates.length > 1 && (
    <PlateTabs
      plates={plates.map(p => {
        const pms = projectModels.filter(m => m.plateId === p.id && m.kind === 'model');
        // Prefer backend-extracted object names (real source-of-truth from the
        // 3MF). Fall back to the pm name with extension/suffix stripped.
        const cleanName = (n: string) => n
          .replace(/\s*\(plate\s+\d+\)\s*$/i, '')
          .replace(/\.(3mf|stl|step|stp)$/i, '');
        const summary = pms.map(m => m.backendPlateObjectNames?.length
          ? m.backendPlateObjectNames.join(', ')
          : cleanName(m.name),
        ).filter(Boolean).join(', ') || undefined;
        return {
          id: p.id,
          name: p.name,
          modelCount: pms.length,
          summary,
        };
      })}
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
      onClearAll={() => {
        const defaultId = `plate-${Date.now()}`;
        setPlates([{ id: defaultId, name: 'Plate 1' }]);
        setActivePlateId(defaultId);
        setProjectModels([]);
        selectSingle(null);
      }}
    />
  );

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
                onDownloadThreemf={handleDownloadThreemf} onPreview={handlePreviewJob} onSendToPrinter={handleSendToPrinter} onQueue={handleQueueOnPrinter} queueLabel={targetPrinter?.name} />
            </div>
          )}
        </div>
      </div>

      {/* Plate tabs */}
      {plateTabs}

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
        <button onClick={handleSaveThreemf} disabled={isSlicing || !hasVisibleModels}
          className={`w-full py-2 rounded-lg text-sm transition ${
            isSlicing || !hasVisibleModels ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}>
          Save 3MF
        </button>
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
          <nav className="flex gap-1 items-center">
            {(['home', 'slice', 'jobs', 'settings'] as const).map(v => {
              const label = v === 'home' ? 'Printers' : v;
              const runningCount = v === 'jobs' ? jobs.filter(j => j.status === 'running' || j.status === 'queued').length : 0;
              return (
                <button key={v} onClick={() => setView(v)}
                  className={`px-3 py-1.5 rounded text-sm capitalize flex items-center gap-1.5 ${
                    view === v ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}>
                  {label}
                  {runningCount > 0 && (
                    <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[10px] font-semibold rounded-full bg-blue-600 text-white" aria-label={`${runningCount} active job${runningCount === 1 ? '' : 's'}`}>
                      {runningCount}
                    </span>
                  )}
                </button>
              );
            })}
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
          <h1 className="text-lg font-semibold text-white mb-4">Slicing Jobs</h1>
          <JobList jobs={jobs} onCancel={handleCancelJob} onDownload={handleDownloadGcode}
            onDownloadThreemf={handleDownloadThreemf}
            onPreview={(jid) => { setPreviewJobId(jid); setView('slice'); }}
            onSendToPrinter={handleSendToPrinter} onQueue={handleQueueOnPrinter} queueLabel={targetPrinter?.name} />
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
        {/* Mobile header — always visible so sidebar (plate tabs, settings,
            jobs) is reachable even when 3D viewer is off. Previously gated
            on viewer3DEnabled, which trapped the user in the slice-settings
            full-screen panel on multi-plate imports (viewer auto-disables). */}
        <div className="md:hidden flex items-center gap-3 px-3 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
          <button onClick={() => setShowSidebar(!showSidebar)} aria-label={showSidebar ? 'Hide sidebar' : 'Show sidebar'} aria-expanded={showSidebar} className="p-1.5 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600 transition">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        </div>

        {/* 3D Viewer */}
        <div className="flex-1 relative overflow-hidden">
          {embeddedSettingsPrompt && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-lg px-3 py-2 flex items-center gap-3 max-w-[90%]">
              <span className="text-xs text-gray-200 truncate">
                Embedded settings: <span className="text-gray-400">{embeddedSettingsPrompt.summary}</span>
              </span>
              <button
                onClick={handleApplyEmbeddedSettings}
                className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white whitespace-nowrap"
              >
                Apply
              </button>
              <button
                onClick={() => setEmbeddedSettingsPrompt(null)}
                className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-200 whitespace-nowrap"
              >
                Dismiss
              </button>
            </div>
          )}
          <Scene onReady={setSceneRefs} onContextLost={() => {
            console.warn('[3D] WebGL context lost — auto-disabling viewer');
            setViewer3DEnabled(false);
          }} />

          {!viewer3DEnabled && !previewJobId && (
            <div className="absolute inset-0 overflow-auto bg-gray-900/95">
              <div className="max-w-md mx-auto p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-gray-300 text-sm font-semibold">Slice settings</span>
                  <button
                    onClick={() => setViewer3DEnabled(true)}
                    className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                  >
                    Show 3D viewer
                  </button>
                </div>

                {/* Plate tabs — surfaced here so mobile users with viewer off
                    can switch plates without opening the sidebar. Sidebar
                    copy stays too (desktop + mobile-with-viewer-on paths). */}
                {plateTabs}

                {/* Objects */}
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

                <SettingsPanel
                  engine={engine} onEngineChange={setEngine} settings={settings} onSettingsChange={setSettings}
                  selectedProfiles={selectedProfiles} onProfilesChange={setSelectedProfiles}
                  multiMaterial={multiMaterial} onMultiMaterialChange={(mm) => { setMultiMaterial(mm); localStorage.setItem('snorcal_multi_material', JSON.stringify(mm)); }}
                  filamentSlots={filamentSlots} onFilamentSlotsChange={(slots) => { setFilamentSlots(slots); localStorage.setItem('snorcal_filament_slots', JSON.stringify(slots)); }}
                  targetPrinterModel={printers.find(p => p.id === targetPrinterId)?.model ?? null}
                  defaultAdvancedOpen
                />

                {/* Slice buttons (mirror sidebar footer) */}
                <div className="space-y-2">
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
                  <button onClick={handleSaveThreemf} disabled={isSlicing || !hasVisibleModels}
                    className={`w-full py-2 rounded-lg text-sm transition ${
                      isSlicing || !hasVisibleModels ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}>
                    Save 3MF
                  </button>
                </div>

                {/* Jobs list */}
                {jobs.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-gray-400 uppercase tracking-wider py-1">Jobs ({jobs.length})</div>
                    <JobList jobs={jobs} onCancel={handleCancelJob} onDownload={handleDownloadGcode}
                      onDownloadThreemf={handleDownloadThreemf} onPreview={handlePreviewJob} onSendToPrinter={handleSendToPrinter} onQueue={handleQueueOnPrinter} queueLabel={targetPrinter?.name} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Multi-model STL viewers — all visible models across all plates.
              On mobile or when viewer disabled, skip — full 3D for 100k+ face
              STLs OOM-kills iOS Safari tab. Toggle lives in slice toolbar. */}
          {sceneRefs && !previewJobId && viewer3DEnabled && (() => {
            const isMobile = typeof navigator !== 'undefined'
              && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
            // Mobile multi-plate: any single plate's STL can be 400k+ faces
            // and OOM-kills iOS Safari on its own. Block the viewer entirely
            // and tell the user to slice directly or use desktop. Slicing
            // doesn't need geometry in memory — backend reads STL from disk.
            if (isMobile && plates.length > 1) {
              return (
                <div className="absolute inset-0 overflow-auto p-3 space-y-2">
                  <div className="text-xs text-gray-500 pb-1">
                    3D viewer off for multi-plate on mobile. Tap a plate to select it; slice runs server-side.
                  </div>
                  {plates.map(pl => {
                    const pms = projectModels.filter(m => m.plateId === pl.id && m.kind === 'model');
                    const isActive = pl.id === activePlateId;
                    return (
                      <button
                        key={pl.id}
                        onClick={() => { setActivePlateId(pl.id); selectSingle(null); }}
                        className={`w-full text-left rounded p-2 border transition-colors ${isActive ? 'bg-gray-700 border-gray-500' : 'bg-gray-800 border-gray-700'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs text-white font-medium truncate">{pl.name}</div>
                          <div className="text-[10px] text-gray-500 flex-shrink-0">
                            {pms.length === 0 ? 'empty' : `${pms.length} object${pms.length > 1 ? 's' : ''}`}
                          </div>
                        </div>
                        {pms.map(pm => (
                          <div key={pm.uid} className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
                            <span
                              className="w-3 h-3 rounded-sm border border-gray-600 flex-shrink-0"
                              style={{ backgroundColor: pm.faceColors && pm.faceColors.length >= 3
                                ? `rgb(${pm.faceColors[0]},${pm.faceColors[1]},${pm.faceColors[2]})`
                                : '#9ca3af' }}
                            />
                            <span className="truncate flex-1">{pm.name}</span>
                            <span className="text-gray-600 flex-shrink-0">{(pm.faceCount / 1000).toFixed(0)}k</span>
                          </div>
                        ))}
                      </button>
                    );
                  })}
                </div>
              );
            }
            // Parent renders alongside its printable parts so user can
            // select + paint either. (Was filtered for perf, but that
            // blocked painting the merged main object.)
            const visible = projectModels.filter(m => m.visible);
            // Mobile single-plate: only render the first visible pm. Desktop:
            // render all visible (multi-material layout side-by-side).
            const capped = isMobile
              ? visible.filter(m => m.plateId === activePlateId).slice(0, 1)
              : visible;
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
                      : api.getModelUrl(pm.modelId, pm.backendPlateIndex)
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
              {viewer3DEnabled && <AxisIndicator sceneRefs={sceneRefs} />}
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
              {(viewer3DEnabled || !isMobileUA) && (
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
                viewer3DEnabled={viewer3DEnabled}
                onToggleViewer3D={() => setViewer3DEnabled(v => !v)}
              />
              )}
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
              <GcodeTimeBreakdown gcode={gcodeLines ?? gcodeText} />
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

          {/* Empty state — no models on active plate. Skipped when the 3D
              viewer is off: the viewer-off settings panel already carries its
              own upload affordance (ObjectListPanel), and this overlay would
              sit on top (z-10 > z-auto) and swallow clicks meant for the
              MakerWorld button + other settings-panel controls. */}
          {viewer3DEnabled && !hasVisibleModels && !previewJobId && activePlateModels.length === 0 && projectModels.length === 0 && (
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
            printerManualFilaments={p.manualFilaments}
            printerStatus={printerStatuses[targetPrinterId]}
            onClose={() => setRemapJobId(null)}
            onSent={(printerPath) => {
              setRemapJobId(null);
              toast.success('Sent to printer', printerPath);
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
              setPrinters(list.map(p => ({ id: p.id, name: p.name, model: p.model, protocol: p.protocol, bedVolume: p.bedVolume ?? null, cameraSnapshotUrl: p.cameraSnapshotUrl ?? null, manualSlots: p.manualSlots ?? 0, manualFilaments: p.manualFilaments })));
            }).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
