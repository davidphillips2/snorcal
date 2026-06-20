import { useMemo, useRef } from 'react';
import type { ModelKind } from '@slorca/shared';
import type { ProjectModel } from '../../App';
import { ModelUploader } from '../ModelUploader';

interface ObjectListPanelProps {
  models: ProjectModel[];        // plate-filtered
  allModels: ProjectModel[];     // full projectModels for cross-plate linkedTo lookup
  activeIndex: number | null;
  onSelect: (globalIdx: number) => void;
  onRemove: (globalIdx: number) => void;
  onToggleVisible: (globalIdx: number) => void;
  onUpload: (file: File) => void;
  isUploading: boolean;
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
  models, allModels, activeIndex, onSelect, onRemove, onToggleVisible, onUpload, isUploading,
}: ObjectListPanelProps) {
  const hierarchy = useMemo(() => buildHierarchy(models, allModels), [models, allModels]);
  const fileRef = useRef<HTMLInputElement>(null);

  if (models.length === 0) {
    return <ModelUploader onUpload={onUpload} isUploading={isUploading} />;
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">
          Objects ({models.length})
        </label>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={isUploading}
          className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition"
          title="Upload model"
        >
          + Add
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".stl,.step,.stp,.3mf"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }}
          className="hidden"
        />
      </div>

      <div className="space-y-0.5 max-h-60 overflow-y-auto">
        {hierarchy.map(node => (
          <ObjectRow
            key={node.model.modelId}
            node={node}
            depth={0}
            activeIndex={activeIndex}
            onSelect={onSelect}
            onRemove={onRemove}
            onToggleVisible={onToggleVisible}
          />
        ))}
      </div>
    </div>
  );
}

function ObjectRow({
  node, depth, activeIndex, onSelect, onRemove, onToggleVisible,
}: {
  node: HierarchyNode;
  depth: number;
  activeIndex: number | null;
  onSelect: (idx: number) => void;
  onRemove: (idx: number) => void;
  onToggleVisible: (idx: number) => void;
}) {
  const { model, globalIdx, children, isOrphan } = node;
  const isActive = activeIndex === globalIdx;

  return (
    <>
      <div
        onClick={() => onSelect(globalIdx)}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={`flex items-center gap-1.5 pr-2 py-1.5 rounded-lg cursor-pointer transition text-sm border ${
          isActive
            ? 'bg-blue-600/20 text-blue-300 border-blue-600/30'
            : 'bg-gray-700/30 text-gray-300 hover:bg-gray-700/60 border-transparent'
        } ${isOrphan ? 'ring-1 ring-yellow-600/40' : ''}`}
        title={isOrphan ? 'Parent missing or on another plate' : undefined}
      >
        <KindIcon kind={model.kind} />
        <span className={`truncate flex-1 text-xs ${!model.visible ? 'opacity-40' : ''}`}>
          {model.name}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleVisible(globalIdx); }}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-500 hover:text-white hover:bg-gray-600/50"
          title={model.visible ? 'Hide' : 'Show'}
        >
          {model.visible ? '◉' : '◯'}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(globalIdx); }}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-500 hover:text-red-400 hover:bg-red-600/20 text-xs"
          title="Remove"
        >
          &times;
        </button>
      </div>

      {children.map(child => (
        <ObjectRow
          key={child.model.modelId}
          node={child}
          depth={depth + 1}
          activeIndex={activeIndex}
          onSelect={onSelect}
          onRemove={onRemove}
          onToggleVisible={onToggleVisible}
        />
      ))}
    </>
  );
}

function KindIcon({ kind }: { kind: ModelKind }) {
  if (kind === 'negative') {
    return (
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-red-400 text-xs" title="Negative volume">
        ⊖
      </span>
    );
  }
  if (kind === 'modifier') {
    return (
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-blue-400 text-xs" title="Modifier">
        ⚙
      </span>
    );
  }
  return (
    <span className="shrink-0 w-4 h-4 flex items-center justify-center text-gray-400 text-xs" title="Model">
      ▣
    </span>
  );
}
