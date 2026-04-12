import { useState, useEffect, useRef } from 'react';
import * as api from '../../api/client';

const ENGINES = [
  { value: 'orcaslicer', label: 'OrcaSlicer' },
  { value: 'bambustudio', label: 'BambuStudio' },
  { value: 'snapmaker_orca', label: 'Snapmaker Orca' },
];

interface ProfileInfo {
  engine: string;
  profile_type: string;
  name: string;
  created_at: string;
}

interface SelectedProfiles {
  machine?: string;
  filament?: string;
  process?: string;
}

interface SettingsPanelProps {
  engine: string;
  onEngineChange: (engine: string) => void;
  settings: Record<string, string>;
  onSettingsChange: (settings: Record<string, string>) => void;
  onSlice: () => void;
  onSliceAll?: () => void;
  plateCount?: number;
  isSlicing?: boolean;
  selectedProfiles: SelectedProfiles;
  onProfilesChange: (profiles: SelectedProfiles) => void;
}

const SETTING_GROUPS = [
  {
    label: 'Layer & Shell',
    settings: [
      { key: 'layer_height', label: 'Layer Height', type: 'number', step: '0.05' },
      { key: 'initial_layer_height', label: 'First Layer Height', type: 'number', step: '0.05' },
      { key: 'wall_loops', label: 'Wall Loops', type: 'number', step: '1' },
      { key: 'top_shell_layers', label: 'Top Layers', type: 'number', step: '1' },
      { key: 'bottom_shell_layers', label: 'Bottom Layers', type: 'number', step: '1' },
    ],
  },
  {
    label: 'Infill',
    settings: [
      { key: 'sparse_infill_density', label: 'Infill Density', type: 'text' },
      { key: 'infill_pattern', label: 'Infill Pattern', type: 'select',
        options: ['gyroid', 'grid', 'honeycomb', 'lines', 'rectilinear', 'tri-hexagon', 'cubic'] },
    ],
  },
  {
    label: 'Speed',
    settings: [
      { key: 'outer_wall_speed', label: 'Outer Wall', type: 'number', step: '10' },
      { key: 'inner_wall_speed', label: 'Inner Wall', type: 'number', step: '10' },
      { key: 'sparse_infill_speed', label: 'Infill', type: 'number', step: '10' },
      { key: 'travel_speed', label: 'Travel', type: 'number', step: '10' },
    ],
  },
  {
    label: 'Support',
    settings: [
      { key: 'enable_support', label: 'Enable Support', type: 'select', options: ['0', '1'] },
      { key: 'support_type', label: 'Support Type', type: 'select',
        options: ['tree(normal)', 'tree(hybrid)', 'normal', 'none'] },
      { key: 'support_angle', label: 'Support Angle', type: 'number', step: '5' },
    ],
  },
  {
    label: 'Brim',
    settings: [
      { key: 'brim_type', label: 'Brim Type', type: 'select', options: ['auto', 'outer', 'all', 'none'] },
      { key: 'brim_width', label: 'Brim Width', type: 'number', step: '1' },
    ],
  },
];

export function SettingsPanel({
  engine, onEngineChange, settings, onSettingsChange, onSlice, onSliceAll, plateCount,
  isSlicing, selectedProfiles, onProfilesChange,
}: SettingsPanelProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load profiles when engine changes
  useEffect(() => {
    api.getProfiles(engine).then(setProfiles).catch(() => setProfiles([]));
  }, [engine]);

  const machineProfiles = profiles.filter(p => p.profile_type === 'machine');
  const filamentProfiles = profiles.filter(p => p.profile_type === 'filament');
  const processProfiles = profiles.filter(p => p.profile_type === 'process');

  const updateSetting = (key: string, value: string) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  const toggleGroup = (label: string) => {
    setCollapsed((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setImporting(true);
    try {
      for (let i = 0; i < files.length; i++) {
        await api.importProfiles(engine, files[i]);
      }
      const updated = await api.getProfiles(engine);
      setProfiles(updated);
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteProfile = async (type: string, name: string) => {
    await api.deleteProfile(engine, type, name);
    setProfiles(prev => prev.filter(p => !(p.profile_type === type && p.name === name)));
    // Clear selection if deleted profile was selected
    if (selectedProfiles[type as keyof SelectedProfiles] === name) {
      onProfilesChange({ ...selectedProfiles, [type]: undefined });
    }
  };

  const renderProfileSelect = (
    label: string,
    type: keyof SelectedProfiles,
    options: ProfileInfo[],
  ) => (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-gray-400">{label}</label>
      <div className="flex gap-1">
        <select
          value={selectedProfiles[type] || ''}
          onChange={(e) => onProfilesChange({ ...selectedProfiles, [type]: e.target.value || undefined })}
          className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-white min-w-0"
        >
          <option value="">Default</option>
          {options.map(p => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
        {selectedProfiles[type] && (
          <button
            onClick={() => handleDeleteProfile(type, selectedProfiles[type]!)}
            className="px-1.5 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-gray-700 rounded"
            title="Delete profile"
          >
            &times;
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="w-80 bg-gray-800 border-l border-gray-700 overflow-y-auto p-4 space-y-4">
      {/* Engine selector */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Slicer Engine</label>
        <select
          value={engine}
          onChange={(e) => onEngineChange(e.target.value)}
          className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
        >
          {ENGINES.map((e) => (
            <option key={e.value} value={e.value}>{e.label}</option>
          ))}
        </select>
      </div>

      {/* Profile selectors */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-300">Profiles</span>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.zip"
              multiple
              onChange={handleImport}
              className="hidden"
              id="profile-import"
            />
            <label
              htmlFor="profile-import"
              className={`px-2 py-1 rounded text-xs cursor-pointer ${
                importing
                  ? 'bg-gray-600 text-gray-400'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {importing ? 'Importing...' : 'Import'}
            </label>
          </div>
        </div>
        {renderProfileSelect('Machine', 'machine', machineProfiles)}
        {renderProfileSelect('Filament', 'filament', filamentProfiles)}
        {renderProfileSelect('Process', 'process', processProfiles)}
      </div>

      {/* Setting groups */}
      {SETTING_GROUPS.map((group) => (
        <div key={group.label}>
          <button
            onClick={() => toggleGroup(group.label)}
            className="w-full flex items-center justify-between text-sm font-medium text-gray-300 py-1"
          >
            {group.label}
            <span className="text-gray-500">{collapsed[group.label] ? '+' : '-'}</span>
          </button>

          {!collapsed[group.label] && (
            <div className="space-y-2 mt-1">
              {group.settings.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-2">
                  <label className="text-xs text-gray-400 whitespace-nowrap">{s.label}</label>
                  {s.type === 'select' ? (
                    <select
                      value={settings[s.key] || ''}
                      onChange={(e) => updateSetting(s.key, e.target.value)}
                      className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white w-28"
                    >
                      {s.options?.map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={s.type}
                      step={(s as any).step}
                      value={settings[s.key] || ''}
                      onChange={(e) => updateSetting(s.key, e.target.value)}
                      className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white w-28"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Slice button */}
      <button
        onClick={onSlice}
        disabled={isSlicing}
        className={`w-full py-3 rounded-lg font-medium text-sm transition ${
          isSlicing
            ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
            : 'bg-blue-600 text-white hover:bg-blue-500'
        }`}
      >
        {isSlicing ? 'Slicing...' : 'Slice'}
      </button>

      {/* Slice all plates button */}
      {plateCount && plateCount > 1 && (
        <button
          onClick={onSliceAll}
          disabled={isSlicing}
          className={`w-full py-3 rounded-lg font-medium text-sm transition ${
            isSlicing
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
              : 'bg-emerald-600 text-white hover:bg-emerald-500'
          }`}
        >
          {isSlicing ? 'Slicing...' : `Slice All ${plateCount} Plates`}
        </button>
      )}
    </div>
  );
}
