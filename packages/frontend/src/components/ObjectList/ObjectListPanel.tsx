import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelKind } from '@snorcal/shared';
import type { ProjectModel } from '../../App';
import { ModelUploader } from '../ModelUploader';

interface ObjectListPanelProps {
  models: ProjectModel[];        // plate-filtered
  allModels: ProjectModel[];     // full projectModels for cross-plate linkedTo lookup
  selectedIndices: Set<number>;
  onSelect: (globalIdx: number, additive: boolean) => void;
  onRemove: (globalIdx: number) => void;
  onToggleVisible: (globalIdx: number) => void;
  onUpload: (file: File) => void;
  onUploadMany?: (files: File[]) => void;
  onAutoArrange?: () => void;
  isUploading: boolean;
  onOpenMakerworld?: () => void;
  onDuplicateAt?: (globalIdx: number) => void;
  onAddNegativeToParent?: (parentModelId: string) => void;
  // Cross-plate ops (Phase 4)
  plates: Array<{ id: string; name: string }>;
  activePlateId: string;
  onMoveToPlate?: (globalIdx: number, plateId: string) => void;
  onDuplicateToPlate?: (globalIdx: number, plateId: string) => void;
}

interface HierarchyNode {
  model: ProjectModel;
  globalIdx: number;
  children: HierarchyNode[];
  isOrphan: boolean;
}

function buildHierarchy(plateModels: ProjectModel[], allModels: ProjectModel[]): HierarchyNode[] {
  const byId = new Map<string, { model: ProjectModel; idx: number }>();
  allModels.forEach((m, i) => byId.set(m.modelId, { model: m, idx: i }));

  const roots: HierarchyNode[] = [];
  const childrenOfParent = new Map<string, HierarchyNode[]>();

  for (const pm of plateModels) {
    const globalIdx = allModels.indexOf(pm);
    const node: HierarchyNode = { model: pm, globalIdx, children: [], isOrphan: false };

    if (pm.kind === 'model' || !pm.linkedTo || pm.linkedTo.length === 0) {
      roots.push(node);
      continue;
    }

    const parentEntry = pm.linkedTo
      .map(id => byId.get(id))
      .find(p => p && p.model.plateId === pm.plateId && p.model.kind === 'model');

    if (parentEntry) {
      const arr = childrenOfParent.get(parentEntry.model.modelId) ?? [];
      arr.push(node);
      childrenOfParent.set(parentEntry.model.modelId, arr);
    } else {
      node.isOrphan = true;
      roots.push(node);
    }
  }

  for (const root of roots) {
    root.children = childrenOfParent.get(root.model.modelId) ?? [];
  }
  return roots;
}

export function ObjectListPanel({
  models, allModels, selectedIndices, onSelect, onRemove, onToggleVisible, onUpload, onUploadMany, onAutoArrange, isUploading,
  onOpenMakerworld, onDuplicateAt, onAddNegativeToParent,
  plates, activePlateId, onMoveToPlate, onDuplicateToPlate,
}: ObjectListPanelProps) {
  const hierarchy = useMemo(() => buildHierarchy(models, allModels), [models, allModels]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Collapse state keyed by ProjectModel.uid (stable across reorders, unlike
  // modelId which is shared between parent + embedded negative parts + clones).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = useCallback((uid: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  if (models.length === 0) {
    return (
      <>
        <ModelUploader onUpload={onUpload} onUploadMany={onUploadMany} isUploading={isUploading} />
        {onOpenMakerworld && (
          <div className="mt-2">
            <button
              onClick={onOpenMakerworld}
              className="w-full py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
            >
              Import from MakerWorld
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">
          Objects ({models.length})
        </label>
        <div className="flex items-center gap-1">
          {onAutoArrange && models.length > 1 && (
            <button
              onClick={onAutoArrange}
              className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
              title="Auto-arrange models on plate (shelf pack)"
            >
              Arrange
            </button>
          )}
          {onOpenMakerworld && (
            <button
              onClick={onOpenMakerworld}
              className="px-2 py-0.5 rounded text-xs bg-emerald-700 text-emerald-100 hover:bg-emerald-600 transition"
              title="Import from MakerWorld"
            >
              MW
            </button>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={isUploading}
            className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
            title="Upload model"
          >
            + Add
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".stl,.step,.stp,.3mf"
          multiple
          onChange={(e) => {
            const list = e.target.files;
            if (!list || list.length === 0) return;
            const files = Array.from(list);
            if (files.length === 1 || !onUploadMany) onUpload(files[0]);
            else onUploadMany(files);
            e.target.value = '';
          }}
          className="hidden"
        />
      </div>

      <div className="space-y-px max-h-60 overflow-y-auto">
        {hierarchy.map(node => (
          <ObjectRow
            key={node.model.uid}
            node={node}
            depth={0}
            selectedIndices={selectedIndices}
            onSelect={onSelect}
            onRemove={onRemove}
            onToggleVisible={onToggleVisible}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            onDuplicate={onDuplicateAt}
            onAddNegative={onAddNegativeToParent}
            plates={plates}
            activePlateId={activePlateId}
            onMoveToPlate={onMoveToPlate}
            onDuplicateToPlate={onDuplicateToPlate}
          />
        ))}
      </div>
    </div>
  );
}

interface ObjectRowProps {
  node: HierarchyNode;
  depth: number;
  selectedIndices: Set<number>;
  onSelect: (idx: number, additive: boolean) => void;
  onRemove: (idx: number) => void;
  onToggleVisible: (idx: number) => void;
  collapsed: Set<string>;
  onToggleCollapse: (uid: string) => void;
  onDuplicate?: (idx: number) => void;
  onAddNegative?: (parentModelId: string) => void;
  plates: Array<{ id: string; name: string }>;
  activePlateId: string;
  onMoveToPlate?: (globalIdx: number, plateId: string) => void;
  onDuplicateToPlate?: (globalIdx: number, plateId: string) => void;
}

function ObjectRow({
  node, depth, selectedIndices, onSelect, onRemove, onToggleVisible,
  collapsed, onToggleCollapse, onDuplicate, onAddNegative,
  plates, activePlateId, onMoveToPlate, onDuplicateToPlate,
}: ObjectRowProps) {
  const { model, globalIdx, children, isOrphan } = node;
  const isActive = selectedIndices.has(globalIdx);
  const isCollapsed = collapsed.has(model.uid);
  const hasChildren = children.length > 0;
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <div
        onClick={(e) => onSelect(globalIdx, e.shiftKey)}
        className={`group relative flex items-center h-7 pr-1 rounded cursor-pointer transition text-sm ${
          isActive
            ? 'bg-blue-600/20 text-blue-200'
            : 'text-gray-300 hover:bg-gray-700/40'
        } ${isOrphan ? 'ring-1 ring-yellow-600/40' : ''}`}
        title={isOrphan ? 'Parent missing or on another plate' : undefined}
      >
        {/* Indent guides — vertical line per depth level */}
        <div className="flex shrink-0 h-full">
          {Array.from({ length: depth }).map((_, i) => (
            <span key={i} className="w-3 h-full border-l border-gray-700/60 ml-3" />
          ))}
        </div>

        {/* Chevron column — fixed width */}
        <div className="shrink-0 w-5 flex items-center justify-center">
          {hasChildren ? (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse(model.uid); }}
              className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-white text-[10px]"
              title={isCollapsed ? 'Expand' : 'Collapse'}
            >
              {isCollapsed ? '\u25B6' : '\u25BC'}
            </button>
          ) : null}
        </div>

        {/* Selection indicator — green check when active */}
        <div className="shrink-0 w-4 flex items-center justify-center">
          {isActive ? (
            <svg className="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8.5l3 3 7-7" />
            </svg>
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-gray-600 group-hover:bg-gray-500" />
          )}
        </div>

        {/* Kind icon */}
        <KindIcon kind={model.kind} />

        {/* Name */}
        <span className={`truncate flex-1 text-xs ml-1 ${!model.visible ? 'opacity-40' : ''}`}>
          {model.name}
        </span>

        {/* Hover-only actions */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
          {model.kind === 'model' && onAddNegative && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddNegative(model.modelId); }}
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-red-400/80 hover:text-red-300 hover:bg-red-600/20 text-xs"
              title="Add negative volume to this object"
            >
              {'\u2296'}
            </button>
          )}
          {onDuplicate && (
            <button
              onClick={(e) => { e.stopPropagation(); onDuplicate(globalIdx); }}
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-gray-600/50 text-[10px]"
              title="Duplicate"
            >
              {'\u2398'}
            </button>
          )}
          {onMoveToPlate && onDuplicateToPlate && plates.length > 1 && (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v); }}
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-gray-600/50 text-xs"
                title="Move / duplicate to plate"
              >
                {'\u22EF'}
              </button>
              {menuOpen && (
                <PlateMenu
                  plates={plates}
                  activePlateId={activePlateId}
                  onClose={() => setMenuOpen(false)}
                  onMove={(plateId) => { onMoveToPlate(globalIdx, plateId); setMenuOpen(false); }}
                  onDuplicate={(plateId) => { onDuplicateToPlate(globalIdx, plateId); setMenuOpen(false); }}
                />
              )}
            </div>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onToggleVisible(globalIdx); }}
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-gray-600/50"
            title={model.visible ? 'Hide' : 'Show'}
          >
            {model.visible ? '\u25C9' : '\u25EF'}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(globalIdx); }}
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-red-400 hover:bg-red-600/20 text-xs"
            title="Remove"
          >
            &times;
          </button>
        </div>
      </div>

      {hasChildren && !isCollapsed && children.map(child => (
        <ObjectRow
          key={child.model.uid}
          node={child}
          depth={depth + 1}
          selectedIndices={selectedIndices}
          onSelect={onSelect}
          onRemove={onRemove}
          onToggleVisible={onToggleVisible}
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
          onDuplicate={onDuplicate}
          onAddNegative={onAddNegative}
          plates={plates}
          activePlateId={activePlateId}
          onMoveToPlate={onMoveToPlate}
          onDuplicateToPlate={onDuplicateToPlate}
        />
      ))}
    </>
  );
}

function PlateMenu({
  plates, activePlateId, onClose, onMove, onDuplicate,
}: {
  plates: Array<{ id: string; name: string }>;
  activePlateId: string;
  onClose: () => void;
  onMove: (plateId: string) => void;
  onDuplicate: (plateId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const targets = plates.filter(p => p.id !== activePlateId);
  return (
    <div
      ref={ref}
      className="absolute right-0 top-6 z-30 w-44 bg-gray-800 border border-gray-700 rounded shadow-xl py-1 text-xs"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">Move to</div>
      {targets.length === 0 ? (
        <div className="px-2 py-1 text-gray-500">No other plates</div>
      ) : targets.map(p => (
        <button
          key={p.id}
          onClick={() => onMove(p.id)}
          className="block w-full text-left px-2 py-1 hover:bg-gray-700 text-gray-200"
        >
          {p.name}
        </button>
      ))}
      <div className="border-t border-gray-700 my-1" />
      <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">Duplicate to</div>
      {targets.length === 0 ? (
        <div className="px-2 py-1 text-gray-500">No other plates</div>
      ) : targets.map(p => (
        <button
          key={p.id}
          onClick={() => onDuplicate(p.id)}
          className="block w-full text-left px-2 py-1 hover:bg-gray-700 text-gray-200"
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}

function KindIcon({ kind }: { kind: ModelKind }) {
  if (kind === 'part') {
    return (
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-emerald-400 text-xs" title="Assembly part">
        {'\u25AD'}
      </span>
    );
  }
  if (kind === 'negative') {
    return (
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-red-400 text-xs" title="Negative volume">
        {'\u2296'}
      </span>
    );
  }
  if (kind === 'modifier') {
    return (
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-blue-400 text-xs" title="Modifier">
        {'\u2699'}
      </span>
    );
  }
  if (kind === 'support') {
    return (
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-purple-400 text-xs" title="Custom support">
        {'\u25BF'}
      </span>
    );
  }
  return (
    <span className="shrink-0 w-4 h-4 flex items-center justify-center text-gray-400 text-xs" title="Model">
      {'\u25A3'}
    </span>
  );
}
