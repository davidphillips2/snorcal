import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../../api/client';
import { SETTING_GROUPS, DEFAULT_VALUES, isSettingVisible } from './settings-definitions';
import type { SettingGroup } from './settings-definitions';
import { SettingRow } from './SettingRow';

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
  targetPrinterModel?: string | null;
  /** Open the "Advanced" settings section on mount (mobile full-screen mode). */
  defaultAdvancedOpen?: boolean;
}

const MATERIAL_TYPES = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA (Nylon)', 'PC', 'PVA', 'HIPS', 'CF (Carbon Fiber)'];

// Brand / generic words stripped when tokenizing a machine profile name.
// Goal: keep only the distinctive model identifier (e.g. "P1S", "U1", "Ender").
const BRAND_WORDS = new Set([
  'bambu', 'lab', 'snapmaker', 'anker', 'anycubic', 'creality', 'voron', 'prusa',
  'printer', 'nozzle', 'all-metal', 'allmetal', 'standard', 'default', 'the',
]);

// Some printers share process profiles with a sibling model.
// Key = canonical token found in machine name, value = extra tokens to also match.
// Bambu P1S/A1/X1E all use X1C-tagged process profiles in Orca/Bambu.
const MODEL_ALIASES: Record<string, string[]> = {
  'p1s': ['x1c'],
  'p1sc': ['x1c'],
  'x1e': ['x1c'],
  'x1c': ['x1c'],
  'a1 mini': ['a1'],
  'a1mini': ['a1'],
};

/** Extract distinctive lowercase tokens from a machine profile name, with aliases. */
function extractModelTokens(modelName?: string): string[] {
  if (!modelName) return [];
  const lower = modelName.toLowerCase();
  const tokens = new Set<string>();
  // Check multi-word aliases first (e.g. "a1 mini")
  for (const [key, aliases] of Object.entries(MODEL_ALIASES)) {
    if (lower.includes(key)) {
      tokens.add(key);
      aliases.forEach(a => tokens.add(a));
    }
  }
  for (const raw of lower.split(/[^a-z0-9.]+/)) {
    if (!raw) continue;
    if (BRAND_WORDS.has(raw)) continue;
    if (/^\d+(\.\d+)?$/.test(raw)) continue;  // pure numbers like 0.4
    if (raw.length < 2) continue;
    tokens.add(raw);
    if (MODEL_ALIASES[raw]) MODEL_ALIASES[raw].forEach(a => tokens.add(a));
  }
  return Array.from(tokens);
}

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
  targetPrinterModel,
  defaultAdvancedOpen = false,
}: SettingsPanelProps) {
  // Initialize collapsed state from group defaults
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    SETTING_GROUPS.forEach(g => { initial[g.id] = g.defaultCollapsed; });
    return initial;
  });
  const [search, setSearch] = useState('');
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [printers, setPrinters] = useState<Array<{ name: string; model?: string | null }>>([]);
  const [importing, setImporting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(defaultAdvancedOpen);
  const [diffMode, setDiffMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getProfiles(engine).then(setProfiles).catch(() => setProfiles([]));
  }, [engine]);

  // When engine changes (or profile list refreshes), drop selections that no
  // longer exist in the current engine's profile set. Without this, switching
  // engine leaves a stale machine/process name in state that points at a
  // profile the new engine doesn't have → silent fallback to defaults at slice
  // time. Also auto-pick first filament if none selected.
  useEffect(() => {
    if (profiles.length === 0) return;
    const names = new Set(profiles.map(p => p.name));
    const updates: Partial<SelectedProfiles> = {};
    if (selectedProfiles.machine && !names.has(selectedProfiles.machine)) {
      updates.machine = undefined;
    }
    if (selectedProfiles.process && !names.has(selectedProfiles.process)) {
      updates.process = undefined;
    }
    if (Object.keys(updates).length > 0) {
      onProfilesChange({ ...selectedProfiles, ...updates });
    }
    // Filament slots: each slot.profile is also engine-scoped. Clear any that
    // no longer resolve to a real filament profile in the new engine's set.
    if (filamentSlots.some(s => s.profile && !names.has(s.profile))) {
      onFilamentSlotsChange(filamentSlots.map(s => (s.profile && !names.has(s.profile) ? { ...s, profile: undefined } : s)));
    }
  }, [profiles, selectedProfiles.machine, selectedProfiles.process]);

  useEffect(() => {
    api.listPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, []);

  // Filter machine dropdown to profiles matching the TARGET printer's `model`.
  // Falls back to union of all connected printers' models when no target set
  // (preserves multi-printer flow). Printers with no model = ignored.
  const effectiveModel = targetPrinterModel?.trim() || null;
  const printerModels = Array.from(new Set(
    (effectiveModel ? [effectiveModel] : printers.map(p => p.model))
      .filter((m): m is string => !!m && m.trim().length > 0)
  ));

  const machineProfilesAll = profiles.filter(p => p.profile_type === 'machine');
  const filamentProfilesAll = profiles.filter(p => p.profile_type === 'filament');

  // Filament filter: match filament profile names against printer model tokens
  // (e.g. "Bambu PLA Basic @BBL P1S 0.4 nozzle" matches tokens from "Bambu Lab
  // P1S"). Falls back to all filaments when no printer tokens — preserves the
  // "no printer selected, show generic" path.
  const printerTokens = extractModelTokens(effectiveModel ?? printerModels.join(' '));
  const filamentByPrinter = printerTokens.length === 0
    ? filamentProfilesAll
    : filamentProfilesAll.filter(p => {
        const n = p.name.toLowerCase();
        return printerTokens.some(tok => n.includes(tok));
      });
  const filamentProfiles = filamentByPrinter.length > 0 ? filamentByPrinter : filamentProfilesAll;

  // Filament slot clearer (printer-scope): when target printer changes, drop
  // any slot.profile that isn't in the printer-filtered filament list. Same
  // idea as the engine-scope clearer but keyed off the derived filament set.
  useEffect(() => {
    if (filamentByPrinter.length === 0) return; // no narrowing to do
    const allowed = new Set(filamentByPrinter.map(p => p.name));
    if (filamentSlots.some(s => s.profile && !allowed.has(s.profile))) {
      onFilamentSlotsChange(filamentSlots.map(s => (s.profile && !allowed.has(s.profile) ? { ...s, profile: undefined } : s)));
    }
  }, [filamentByPrinter]);

  const machineFiltered = printerModels.length === 0
    ? machineProfilesAll
    : machineProfilesAll.filter(p =>
        printerModels.some(m => p.name === m || p.name.startsWith(m + ' ') || p.name.startsWith(m + '('))
      );
  const machineProfiles = machineFiltered.length > 0 ? machineFiltered : machineProfilesAll;

  // Auto-select: when target printer's family has profiles, default to that
  // family's 0.4 nozzle variant. If the user's current selection is outside
  // the target family (e.g., switched target from P1S to U1), auto-switch.
  useEffect(() => {
    if (!effectiveModel) {
      // No target: only auto-pick on first load with single connected printer
      if (selectedProfiles.machine) return;
      if (printerModels.length !== 1) return;
      const family = printerModels[0];
      const candidates = machineProfilesAll.filter(p =>
        p.name === family || p.name.startsWith(family + ' ') || p.name.startsWith(family + '(')
      );
      if (candidates.length === 0) return;
      const prefer04 = candidates.find(p => /0\.4.*nozzle/i.test(p.name));
      onProfilesChange({ ...selectedProfiles, machine: (prefer04 ?? candidates[0]).name });
      return;
    }

    const candidates = machineProfilesAll.filter(p =>
      p.name === effectiveModel || p.name.startsWith(effectiveModel + ' ') || p.name.startsWith(effectiveModel + '(')
    );
    if (candidates.length === 0) return;

    // Current selection already in family → keep
    const inFamily = selectedProfiles.machine && (
      selectedProfiles.machine === effectiveModel ||
      selectedProfiles.machine.startsWith(effectiveModel + ' ') ||
      selectedProfiles.machine.startsWith(effectiveModel + '(')
    );
    if (inFamily) return;

    // Switch to 0.4 nozzle variant of target family
    const prefer04 = candidates.find(p => /0\.4.*nozzle/i.test(p.name));
    onProfilesChange({ ...selectedProfiles, machine: (prefer04 ?? candidates[0]).name });
  }, [effectiveModel, machineProfilesAll.length, selectedProfiles.machine]);

  // Process filter: key off the SELECTED machine profile, not all printers.
  // Extract distinctive tokens (drop brand words + pure numbers) and match
  // process names. STRICT — no fallback to all profiles when nothing matches.
  // Empty result = no compatible process preset for the current machine,
  // surfaced via empty-state hint in renderProfileSelect.
  const selectedMachine = selectedProfiles.machine;
  const processTokens = extractModelTokens(selectedMachine);
  const processProfilesAll = profiles.filter(p => p.profile_type === 'process');
  const processProfiles = processTokens.length === 0
    ? []
    : processProfilesAll.filter(p => {
        const n = p.name.toLowerCase();
        return processTokens.some(tok => n.includes(tok));
      });

  // Auto-select a compatible process ONLY when none is selected yet. We do NOT
  // overwrite an existing selection even if it falls outside the machine-filtered
  // list — process settings encode print intent (layer height, infill, walls)
  // that should survive a printer switch. The dropdown surfaces an out-of-filter
  // selection with a warning badge so the user knows it's not native to the
  // current machine and can re-pick if they want to.
  useEffect(() => {
    if (processProfiles.length === 0) return;
    const current = selectedProfiles.process;
    if (current) return; // keep the user's (or embedded-settings) selection
    const prefer02Standard = processProfiles.find(p => /0\.2.*standard/i.test(p.name));
    const preferStandard = processProfiles.find(p => /standard/i.test(p.name));
    onProfilesChange({ ...selectedProfiles, process: (prefer02Standard ?? preferStandard ?? processProfiles[0]).name });
  }, [processProfiles, selectedProfiles.process]);

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
  ) => {
    // If the current selection isn't in the (machine-filtered) options list,
    // surface it as an explicit "out-of-filter" option so the <select> shows
    // the actual value rather than blank, and warn that it's not native to the
    // current printer. The selection is preserved on purpose — see the process
    // auto-select useEffect above.
    const current = selectedProfiles[type];
    const inOptions = !current || options.some(o => o.name === current);
    return (
      <div className="space-y-1">
        <label className="block text-xs font-medium text-gray-400">{label}</label>
        <div className="flex gap-1">
          <select
            value={current || ''}
            onChange={(e) => onProfilesChange({ ...selectedProfiles, [type]: e.target.value || undefined })}
            className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-white min-w-0"
          >
            <option value="">Default</option>
            {options.map(p => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
            {!inOptions && current && (
              <option value={current}>{current} (not native to this printer)</option>
            )}
          </select>
          {current && (
            <button
              onClick={() => handleDeleteProfile(type, current)}
              className="px-1.5 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-gray-700 rounded"
              title="Delete profile"
            >
              &times;
            </button>
          )}
        </div>
        {options.length === 0 && (
          <p className="text-[10px] text-amber-400">
            No matching profiles for this slicer + printer combo. Use “Import profiles” in App Settings for the local slicer, or pick a different printer.
          </p>
        )}
        {!inOptions && current && (
          <p className="text-[10px] text-amber-400">
            “{current}” is from a different printer — kept for its process intent. Speed/accel may exceed this printer’s limits; re-pick below if needed.
          </p>
        )}
      </div>
    );
  };

  // Filter groups by search and/or diff-mode
  const searchLower = search.toLowerCase();
  const filteredGroups = (() => {
    let groups = SETTING_GROUPS;
    if (diffMode) {
      groups = groups
        .map(g => ({
          ...g,
          settings: g.settings.filter(s => {
            const cur = settings[s.key];
            const def = DEFAULT_VALUES[s.key];
            // Show only when user has explicitly overridden default
            return cur !== undefined && def !== undefined && String(cur) !== String(def);
          }),
        }))
        .filter(g => g.settings.length > 0);
    }
    if (search) {
      groups = groups
        .map(g => ({
          ...g,
          settings: g.settings.filter(s =>
            s.label.toLowerCase().includes(searchLower) || s.key.toLowerCase().includes(searchLower)
          ),
        }))
        .filter(g => g.settings.length > 0);
    }
    return groups;
  })();

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
      {/* Engine selector moved to App-level Settings panel */}

      {/* Filament Slots — always visible (changed every print, not "advanced") */}
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

      {/* Profile selectors — always visible (Machine/Process are core, not Advanced) */}
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
        {renderProfileSelect('Machine', 'machine', machineFiltered)}
        {renderProfileSelect('Process', 'process', processProfiles)}
      </div>

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced(s => !s)}
        className="w-full flex items-center justify-between text-xs font-medium text-gray-400 uppercase tracking-wider py-1 hover:text-gray-200"
      >
        <span>Advanced</span>
        <span className="text-gray-500 text-xs">{showAdvanced ? '\u2212' : '+'}</span>
      </button>

      {showAdvanced && (
        <>
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

      {/* Search + diff toggle */}
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Search settings..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500"
        />
        <button
          onClick={() => setDiffMode(d => !d)}
          title="Show only values that differ from defaults"
          className={`px-2 py-1.5 rounded text-xs whitespace-nowrap transition ${
            diffMode ? 'bg-amber-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Diff
        </button>
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
        </>
      )}

    </div>
  );
}
