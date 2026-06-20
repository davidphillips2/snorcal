import { useState, useRef, type DragEvent } from 'react';

export interface PlateEntry {
  id: string;
  name: string;
  modelCount: number;
}

interface PlateTabsProps {
  plates: PlateEntry[];
  activePlateId: string;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onAdd: () => void;
}

/**
 * Plate tabs with inline rename (dbl-click), duplicate, delete, drag-reorder.
 * Delete disabled when only one plate remains.
 */
export function PlateTabs({
  plates, activePlateId, onSelect, onRename, onDuplicate, onDelete, onReorder, onAdd,
}: PlateTabsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const commitRename = () => {
    if (editingId) onRename(editingId, draftName.trim() || 'Untitled');
    setEditingId(null);
  };

  const onDrop = (e: DragEvent, toIdx: number) => {
    e.preventDefault();
    if (dragFrom != null) onReorder(dragFrom, toIdx);
    setDragFrom(null);
  };

  return (
    <div className="px-3 py-2 border-t border-gray-700 shrink-0">
      <div className="flex items-center gap-1 overflow-x-auto">
        {plates.map((p, i) => {
          const isActive = activePlateId === p.id;
          const isEditing = editingId === p.id;
          return (
            <div
              key={p.id}
              draggable={!isEditing}
              onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDrop={(e) => onDrop(e, i)}
              onDragEnd={() => setDragFrom(null)}
              className={`group relative flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded text-xs font-medium whitespace-nowrap transition cursor-pointer select-none ${
                isActive ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              } ${dragFrom === i ? 'opacity-50' : ''}`}
              onClick={() => onSelect(p.id)}
              onDoubleClick={() => { setEditingId(p.id); setDraftName(p.name); }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuId(menuId === p.id ? null : p.id);
              }}
            >
              {isEditing ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="bg-gray-900 border border-gray-500 rounded px-1 py-0 text-xs text-white w-20 outline-none"
                />
              ) : (
                <span onDoubleClick={(e) => { e.stopPropagation(); setEditingId(p.id); setDraftName(p.name); }}>
                  {p.name}
                  {plates.length > 1 && (
                    <span className={`ml-1 ${isActive ? 'text-blue-200' : 'text-gray-400'}`}>{p.modelCount}</span>
                  )}
                </span>
              )}

              {/* Hover actions */}
              {!isEditing && (
                <span className="flex items-center">
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuId(menuId === p.id ? null : p.id); }}
                    className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-white opacity-0 group-hover:opacity-100 transition"
                    title="More"
                  >
                    ⋮
                  </button>
                  {plates.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
                      className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-red-400 opacity-0 group-hover:opacity-100 transition"
                      title="Delete plate"
                    >
                      ×
                    </button>
                  )}
                </span>
              )}

              {/* Context menu */}
              {menuId === p.id && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setMenuId(null)}
                    onContextMenu={(e) => { e.preventDefault(); setMenuId(null); }}
                  />
                  <div
                    ref={menuRef}
                    className="absolute top-full left-0 mt-1 z-40 bg-gray-800 border border-gray-600 rounded shadow-lg py-1 w-32"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => { setMenuId(null); setEditingId(p.id); setDraftName(p.name); }}
                      className="w-full text-left px-3 py-1 text-xs text-gray-200 hover:bg-gray-700"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => { setMenuId(null); onDuplicate(p.id); }}
                      className="w-full text-left px-3 py-1 text-xs text-gray-200 hover:bg-gray-700"
                    >
                      Duplicate
                    </button>
                    {plates.length > 1 && (
                      <button
                        onClick={() => { setMenuId(null); onDelete(p.id); }}
                        className="w-full text-left px-3 py-1 text-xs text-red-400 hover:bg-gray-700"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
        <button onClick={onAdd} className="px-2 py-1 rounded text-xs bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-white transition shrink-0">
          + Plate
        </button>
      </div>
    </div>
  );
}
