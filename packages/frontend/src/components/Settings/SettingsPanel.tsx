import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../../api/client';
import { SETTING_GROUPS, DEFAULT_VALUES, isSettingVisible } from './settings-definitions';
import type { SettingGroup } from './settings-definitions';
import { SettingRow } from './SettingRow';

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
  filament2?: string;
  process?: string;
}

interface MultiMaterialConfig {
  enabled: boolean;
  supportFilament: string;
  supportInterfaceFilament: string;
}

interface FilamentSlotConfig {
  color: string;
  type: string;
  profile?: string;
}

interface SettingsPanelProps {
  engine: string;
  onEngineChange: (engine: string) => void;
  settings: Record<string, string>;
  onSettingsChange: (settings: Record<string, string>) => void;
  selectedProfiles: SelectedProfiles;
  onProfilesChange: (profiles: SelectedProfiles) => void;
  multiMaterial: MultiMaterialConfig;
  onMultiMaterialChange: (config: MultiMaterialConfig) => void;
  filamentSlots: FilamentSlotConfig[];
  onFilamentSlotsChange: (slots: FilamentSlotConfig[]) => void;
  printerIp: string;
  onPrinterIpChange: (ip: string) => void;
}

const MATERIAL_TYPES = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA (Nylon)', 'PC', 'PVA', 'HIPS', 'CF (Carbon Fiber)'];

const MULTI_MATERIAL_PRESET: Record<string, string> = {
  enable_support: '1',
  support_type: 'tree(normal)',
  support_angle: '45',
  support_top_z_distance: '0.2',
  support_bottom_z_distance: '0',
  support_interface_top_layers: '3',
  support_interface_bottom_layers: '0',
  tree_support_branch_angle: '45',
  tree_support_branch_diameter: '2',
  tree_support_tip_diameter: '0.8',
  tree_support_branch_distance: '5',
  support_expansion: '0',
};

export function SettingsPanel({
  engine, onEngineChange, settings, onSettingsChange,
  selectedProfiles, onProfilesChange, multiMaterial, onMultiMaterialChange,
  filamentSlots, onFilamentSlotsChange,
  printerIp, onPrinterIpChange,
}: SettingsPanelProps) {
  // Initialize collapsed state from group defaults
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    SETTING_GROUPS.forEach(g => { initial[g.id] = g.defaultCollapsed; });
    return initial;
  });
  const [search, setSearch] = useState('');
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getProfiles(engine).then(setProfiles).catch(() => setProfiles([]));
  }, [engine]);

  const machineProfiles = profiles.filter(p => p.profile_type === 'machine');
  const filamentProfiles = profiles.filter(p => p.profile_type === 'filament');
  const processProfiles = profiles.filter(p => p.profile_type === 'process');

  const updateSetting = useCallback((key: string, value: string) => {
    onSettingsChange({ ...settings, [key]: value });
  }, [settings, onSettingsChange]);

  const handleMultiMaterialToggle = (enabled: boolean) => {
    if (enabled) {
      const changes = Object.entries(MULTI_MATERIAL_PRESET)
        .filter(([key]) => settings[key] !== MULTI_MATERIAL_PRESET[key])
        .map(([key, val]) => `  ${key}: ${settings[key] || '(unset)'} → ${val}`);
      if (changes.length > 0 && confirm(
        `Apply multi-material support settings?\n\nChanges:\n${changes.join('\n')}`,
      )) {
        onSettingsChange({ ...settings, ...MULTI_MATERIAL_PRESET });
      }
    }
    onMultiMaterialChange({ ...multiMaterial, enabled });
  };

  const toggleGroup = (id: string) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
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
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteProfile = async (type: string, name: string) => {
    await api.deleteProfile(engine, type, name);
    setProfiles(prev => prev.filter(p => !(p.profile_type === type && p.name === name)));
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

  // Filter groups by search
  const searchLower = search.toLowerCase();
  const filteredGroups = search
    ? SETTING_GROUPS.map(g => ({
        ...g,
        settings: g.settings.filter(s =>
          s.label.toLowerCase().includes(searchLower) || s.key.toLowerCase().includes(searchLower)
        ),
      })).filter(g => g.settings.length > 0)
    : SETTING_GROUPS;

  // Auto-expand groups when searching
  const isGroupCollapsed = (group: SettingGroup) => {
    if (search) return false;
    return collapsed[group.id] ?? group.defaultCollapsed;
  };

  // Count modified values per group
  const countModified = (group: SettingGroup) => {
    return group.settings.filter(s => {
      const current = settings[s.key];
      const def = DEFAULT_VALUES[s.key];
      return current !== undefined && current !== def;
    }).length;
  };

  return (
    <div className="space-y-3">
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
        {renderProfileSelect('Process', 'process', processProfiles)}
      </div>

      {/* Filament Slots */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-300">Filaments</span>
          {filamentSlots.length < 4 && (
            <button
              onClick={() => {
                const colors = ['#0099FF', '#33CC33', '#FFCC00', '#6633CC', '#CC3399'];
                onFilamentSlotsChange([
                  ...filamentSlots,
                  { color: colors[filamentSlots.length % colors.length], type: 'PLA' },
                ]);
              }}
              className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600"
            >
              + Add Slot
            </button>
          )}
        </div>
        {filamentSlots.map((slot, i) => (
          <div key={i} className="space-y-1 p-2 bg-gray-750 rounded border border-gray-600" style={{ backgroundColor: 'rgba(55,65,81,0.5)' }}>
            <div className="flex items-center gap-2">
              <label className="relative shrink-0">
                <div
                  className="w-6 h-6 rounded-full border border-gray-500"
                  style={{ backgroundColor: slot.color }}
                />
                <input
                  type="color"
                  value={slot.color}
                  onChange={(e) => {
                    const next = [...filamentSlots];
                    next[i] = { ...next[i], color: e.target.value };
                    onFilamentSlotsChange(next);
                  }}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </label>
              <select
                value={slot.type}
                onChange={(e) => {
                  const next = [...filamentSlots];
                  next[i] = { ...next[i], type: e.target.value };
                  onFilamentSlotsChange(next);
                }}
                className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white min-w-0"
              >
                {MATERIAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {filamentSlots.length > 1 && (
                <button
                  onClick={() => onFilamentSlotsChange(filamentSlots.filter((_, j) => j !== i))}
                  className="px-1.5 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-gray-700 rounded"
                >
                  &times;
                </button>
              )}
            </div>
            <select
              value={slot.profile || ''}
              onChange={(e) => {
                const next = [...filamentSlots];
                next[i] = { ...next[i], profile: e.target.value || undefined };
                onFilamentSlotsChange(next);
              }}
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
            >
              <option value="">Default profile</option>
              {filamentProfiles
                .filter(p => {
                  const mat = slot.type.toUpperCase();
                  if (!mat) return true;
                  // Show profiles matching the selected material, or generic ones
                  const name = p.name.toUpperCase();
                  if (name.includes(mat)) return true;
                  // If no profiles match the material, show all
                  return !filamentProfiles.some(fp => fp.name.toUpperCase().includes(mat));
                })
                .map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
        ))}
      </div>

      {/* Printer Connection */}
      <PrinterConnection printerIp={printerIp} onPrinterIpChange={onPrinterIpChange} />

      {/* Multi-Material Support */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={multiMaterial.enabled}
            onChange={(e) => handleMultiMaterialToggle(e.target.checked)}
            className="rounded border-gray-600 bg-gray-700"
          />
          <span className="text-sm font-medium text-gray-300">Multi-Material Supports</span>
        </label>
        {multiMaterial.enabled && (
          <div className="space-y-2 pl-2 border-l-2 border-gray-700">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-400">Support Base Filament</label>
              <select
                value={multiMaterial.supportFilament}
                onChange={(e) => onMultiMaterialChange({ ...multiMaterial, supportFilament: e.target.value })}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-white"
              >
                {filamentSlots.map((slot, i) => (
                  <option key={i} value={String(i)}>
                    Filament {i + 1} ({slot.type})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-400">Support Interface Filament</label>
              <select
                value={multiMaterial.supportInterfaceFilament}
                onChange={(e) => onMultiMaterialChange({ ...multiMaterial, supportInterfaceFilament: e.target.value })}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-white"
              >
                {filamentSlots.map((slot, i) => (
                  <option key={i} value={String(i)}>
                    Filament {i + 1} ({slot.type})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Search */}
      <div>
        <input
          type="text"
          placeholder="Search settings..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500"
        />
      </div>

      {/* Setting groups */}
      {filteredGroups.map((group) => {
        const visibleSettings = group.settings.filter(s => isSettingVisible(s, settings));
        if (visibleSettings.length === 0) return null;

        const modified = countModified(group);
        const collapsed_ = isGroupCollapsed(group);

        return (
          <div key={group.id}>
            <button
              onClick={() => toggleGroup(group.id)}
              className="w-full flex items-center justify-between text-sm font-medium text-gray-300 py-1"
            >
              <span className="flex items-center gap-1.5">
                {group.label}
                {modified > 0 && (
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-600 text-white text-[10px] leading-none">
                    {modified}
                  </span>
                )}
              </span>
              <span className="text-gray-500 text-xs">{collapsed_ ? '+' : '\u2212'}</span>
            </button>

            {!collapsed_ && (
              <div className="space-y-0.5 mt-1">
                {visibleSettings.map((s) => (
                  <SettingRow
                    key={s.key}
                    def={s}
                    value={settings[s.key] ?? DEFAULT_VALUES[s.key] ?? ''}
                    onChange={(v) => updateSetting(s.key, v)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

    </div>
  );
}

// --- Printer Connection with SSDP discovery ---

const PRINTER_KEYWORDS = ['moonraker', 'klipper', 'printer', '3d', 'prusa', 'bambu', 'snapmaker', 'creality', 'voron', 'octoprint'];

function PrinterConnection({ printerIp, onPrinterIpChange }: { printerIp: string; onPrinterIpChange: (ip: string) => void }) {
  const [isScanning, setIsScanning] = useState(false);
  const [discovered, setDiscovered] = useState<Array<{ ip: string; port: number; friendlyName: string; server: string; st: string }>>([]);
  const [showResults, setShowResults] = useState(false);

  const handleScan = async () => {
    setIsScanning(true);
    setDiscovered([]);
    setShowResults(true);
    try {
      const devices = await api.discoverPrinters(10000);
      console.log(`[SSDP] discovered ${devices.length} devices:`, devices);
      setDiscovered(devices.sort((a, b) => {
        const aScore = PRINTER_KEYWORDS.some(k => `${a.server} ${a.st} ${a.friendlyName}`.toLowerCase().includes(k)) ? 0 : 1;
        const bScore = PRINTER_KEYWORDS.some(k => `${b.server} ${b.st} ${b.friendlyName}`.toLowerCase().includes(k)) ? 0 : 1;
        return aScore - bScore || a.friendlyName.localeCompare(b.friendlyName);
      }));
    } catch (err) {
      console.error('[SSDP] scan failed:', err);
      setShowResults(false);
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="space-y-2">
      <span className="text-sm font-medium text-gray-300">Printer Connection</span>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Printer IP"
          value={printerIp}
          onChange={(e) => onPrinterIpChange(e.target.value)}
          className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-white min-w-0"
        />
        <button
          onClick={async () => {
            if (!printerIp) return;
            try {
              const result = await api.testPrinterConnection(printerIp);
              alert(result?.info ? `Connected: ${result.info}` : 'Connection failed');
            } catch (err) { alert(`Failed: ${err instanceof Error ? err.message : String(err)}`); }
          }}
          className="px-2.5 py-1.5 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 whitespace-nowrap"
        >
          Test
        </button>
        <button
          onClick={handleScan}
          disabled={isScanning}
          className={`px-2.5 py-1.5 rounded text-xs whitespace-nowrap ${
            isScanning ? 'bg-blue-600/30 text-blue-300' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          {isScanning ? 'Scanning...' : 'Scan'}
        </button>
      </div>

      {showResults && !isScanning && discovered.length > 0 && (
        <div className="bg-gray-700/50 border border-gray-600 rounded max-h-48 overflow-y-auto">
          {discovered.map((d, i) => (
            <button key={`${d.ip}:${d.port}`}
              onClick={() => { onPrinterIpChange(d.ip); setShowResults(false); }}
              className="w-full text-left px-3 py-2 hover:bg-gray-600 border-b border-gray-700/50 last:border-0 transition"
            >
              <div className="text-xs text-white font-medium">{d.friendlyName || d.ip}</div>
              <div className="text-[10px] text-gray-400">{d.ip}:{d.port}{d.server && <span className="ml-2">{d.server}</span>}</div>
            </button>
          ))}
        </div>
      )}

      {showResults && !isScanning && discovered.length === 0 && (
        <div className="text-xs text-gray-500 bg-gray-700/50 rounded px-3 py-2">No devices found.</div>
      )}
    </div>
  );
}
