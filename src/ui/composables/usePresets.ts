import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import { deletePreset, getDatabase, savePreset } from '@engine/persistence/database';
import {
  getActivePackPayload,
  isProtectedContentInstalled,
  isProtectedPackPresetId,
  getRuntimePackPresets,
  overlayRows,
  subscribePackRuntime,
} from '@engine/content/pack-runtime';
import {
  builtinDirectPresets,
  isBuiltinPresetId,
  normalizePresetSelection,
  PRESET_PROFILES,
  PRESET_SELECTION_KEYS,
  resolveEffectivePreset,
  type EffectivePreset,
  type PresetAgentDefaults,
  type PresetCatalogEntry,
  type PresetProfile,
  type PresetScope,
} from '@engine/prompts/preset-resolution';
import { mergePresetEntryToggles, type PresetEntryToggles } from '@engine/prompts/preset-groups';
import type { ChatPreset } from '@engine/types/types';
import {
  applyCatalogEntryToggles,
  presetUsesToggleLayer,
  setPresetEntriesEnabled,
} from '../lib/preset-entries';
import { buildUiPresetCatalog } from '../lib/preset-catalog';
import { useSettingsStore } from '../stores/settings-store';
import type { UiSettings } from '../stores/settings-types';

// Disk is the source for user/local presets; authenticated pack presets exist only in this memory view.
const diskPresets = ref<ChatPreset[]>([]);
const packOverlayPresets = shallowRef(getRuntimePackPresets());
subscribePackRuntime(() => {
  packOverlayPresets.value = getRuntimePackPresets();
});
const presetsRef = computed(() => overlayRows(diskPresets.value, packOverlayPresets.value));
let loaded = false;

export async function loadPresets(): Promise<ChatPreset[]> {
  diskPresets.value = await getDatabase().presets.toArray();
  loaded = true;
  return presetsRef.value;
}

/**
 * 只读的底线（不依赖目录）：内置直出预设与受保护内容包的预设一律不许写。
 * 📌 2026-11-14：受保护包的预设此前「改了只进内存、刷新就没」—— 现在直接拒绝，
 *    界面先复制成玩家预设再改（写时复制在 PresetManager）。
 */
function assertWritable(id: string): void {
  if (isBuiltinPresetId(id)) throw new Error('内置预设只读，请先复制为自己的预设');
  if (isProtectedPackPresetId(id)) {
    if (isProtectedContentInstalled() && !getActivePackPayload()) {
      throw new Error('内容包已锁定，无法编辑预设');
    }
    throw new Error('内容包预设只读，请先复制为自己的预设');
  }
}

export async function upsertPreset(preset: ChatPreset): Promise<void> {
  assertWritable(preset.id);
  await savePreset(preset);
  diskPresets.value = overlayRows(diskPresets.value, [preset]);
}

export async function removePreset(id: string): Promise<void> {
  assertWritable(id);
  await deletePreset(id);
  diskPresets.value = diskPresets.value.filter((preset) => preset.id !== id);
}

type SelectionBag = Pick<UiSettings, 'activePresetId' | 'directPresetId' | 'directCachedPresetId'>;

function presetSelection(settings: SelectionBag, profile: PresetProfile): string {
  return settings[PRESET_SELECTION_KEYS[profile]] || '';
}

function writeSelection(settings: SelectionBag, profile: PresetProfile, value: string): void {
  const key = PRESET_SELECTION_KEYS[profile];
  if (key === 'activePresetId') settings.activePresetId = value;
  else if (value) settings[key] = value;
  else delete settings[key];
}

/** 给定行与默认层，解析某生成方式的生效预设（不依赖响应式状态，管线外的读者用它） */
export function effectivePresetFrom(
  settings: SelectionBag,
  profile: PresetProfile,
  storedRows: readonly ChatPreset[],
  agentDefaults: PresetAgentDefaults | undefined,
): EffectivePreset {
  return resolveEffectivePreset({
    profile,
    selection: presetSelection(settings, profile),
    agentDefaults,
    catalog: buildUiPresetCatalog(storedRows, agentDefaults),
  });
}

/** 三个选择键一次归一（幂等），只清「与默认等价」的值 */
export function normalizeSelections(
  settings: SelectionBag,
  storedRows: readonly ChatPreset[],
  agentDefaults: PresetAgentDefaults | undefined,
): void {
  const catalog = buildUiPresetCatalog(storedRows, agentDefaults);
  for (const profile of PRESET_PROFILES) {
    const current = presetSelection(settings, profile);
    const next = normalizePresetSelection({ profile, selection: current, agentDefaults, catalog });
    if (next !== current) writeSelection(settings, profile, next);
  }
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as any)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => stableEqual((a as any)[k], (b as any)[k]));
}

/** 时间戳与播种指纹不算内容：只改过 updatedAt、或带着 factorySeedHash 的行仍视为原样 */
function sameContent(row: ChatPreset, pristine: ChatPreset): boolean {
  const strip = ({ createdAt: _c, updatedAt: _u, factorySeedHash: _f, ...rest }: ChatPreset) =>
    rest;
  return stableEqual(strip(row), strip(pristine));
}

/**
 * 一次性迁移（幂等）：旧版曾把内置直出预设写进 Dexie 且可就地编辑。
 * 原样的行直接删；改过的另存为玩家预设（新 id、名字加「（我的修改）」、scope=direct），
 * 并把指向内置 id 的选择键改指副本，然后删掉内置 id 那一行。
 */
export async function migrateBuiltinPresetRows(settings: SelectionBag): Promise<boolean> {
  const db = getDatabase();
  const builtins = builtinDirectPresets();
  let changed = false;
  for (const pristine of Object.values(builtins)) {
    if (!pristine) continue;
    const row = await db.presets.get(pristine.id);
    if (!row) continue;
    if (!sameContent(row, pristine)) {
      const now = Date.now();
      const copy: ChatPreset = {
        ...row,
        id: crypto.randomUUID(),
        name: `${row.name}（我的修改）`,
        scope: 'direct',
        createdAt: now,
        updatedAt: now,
      };
      // 副本是玩家预设，不带出厂播种指纹（2026-11-17）
      delete copy.factorySeedHash;
      await savePreset(copy);
      for (const profile of PRESET_PROFILES) {
        if (presetSelection(settings, profile) === pristine.id) {
          writeSelection(settings, profile, copy.id);
        }
      }
    } else {
      // 📌 2026-11-14：原样的旧落盘行被删掉时，指向它的选择键清成「跟随默认」。
      //    只在这里清 —— 平时显式选中引擎内置预设是合法的（normalizePresetSelection 不碰它）。
      for (const profile of PRESET_PROFILES) {
        if (presetSelection(settings, profile) === pristine.id) {
          writeSelection(settings, profile, '');
        }
      }
    }
    await deletePreset(pristine.id);
    changed = true;
  }
  if (changed && loaded) await loadPresets();
  return changed;
}

export function usePresets(): {
  /** 存储行原样（不套开关覆写） */
  presets: Readonly<Ref<ChatPreset[]>>;
  /** 预设目录；只读条目已套玩家的开关覆写（`settings.presetEntryToggles`） */
  catalog: ComputedRef<PresetCatalogEntry[]>;
  effectivePreset: (profile: PresetProfile) => EffectivePreset;
  /** 同 `effectivePreset`，但取原始行、不套开关覆写（「保存为项目默认」等写回内容的路径用） */
  pristineEffectivePreset: (profile: PresetProfile) => EffectivePreset;
  defaultPreset: (profile: PresetProfile) => EffectivePreset;
  selectPreset: (profile: PresetProfile, id: string) => void;
  duplicateAsUser: (id: string, scope?: PresetScope, name?: string) => Promise<ChatPreset | null>;
  setEntriesEnabled: (
    presetId: string,
    patch: PresetEntryToggles,
    options?: { pin?: boolean },
  ) => Promise<void>;
  resetEntryToggles: (presetId: string) => void;
  loadPresets: typeof loadPresets;
  upsertPreset: typeof upsertPreset;
  removePreset: typeof removePreset;
} {
  const cfg = useSettingsStore();
  const agentDefaults = (): PresetAgentDefaults | undefined => cfg.projectAgentDefaults?.agents;
  /** 原始目录：播种 / 装包 / 保存为默认 / 覆写归一都读它 */
  const pristineCatalog = computed(() => buildUiPresetCatalog(presetsRef.value, agentDefaults()));
  // 🔴 覆写层是 enabled 的第二来源，前端只在这里套用（另一处是 GamePipeline.loadPresets）
  const catalog = computed(() =>
    applyCatalogEntryToggles(pristineCatalog.value, cfg.settings.presetEntryToggles),
  );

  function resolveFrom(
    profile: PresetProfile,
    entries: readonly PresetCatalogEntry[],
  ): EffectivePreset {
    return resolveEffectivePreset({
      profile,
      selection: presetSelection(cfg.settings, profile),
      agentDefaults: agentDefaults(),
      catalog: entries,
    });
  }

  function effectivePreset(profile: PresetProfile): EffectivePreset {
    return resolveFrom(profile, catalog.value);
  }

  function pristineEffectivePreset(profile: PresetProfile): EffectivePreset {
    return resolveFrom(profile, pristineCatalog.value);
  }

  /** 不看选择键时的默认那一份（= 选择为空时的生效结果） */
  function defaultPreset(profile: PresetProfile): EffectivePreset {
    return resolveEffectivePreset({
      profile,
      selection: '',
      agentDefaults: agentDefaults(),
      catalog: catalog.value,
    });
  }

  /**
   * 选择键的唯一写入口：选中默认那条 = 存空串（跟随默认），其余存 id。
   * 传空串即「回到跟随默认」（「全部恢复默认」也走这里，不直接写选择键）。
   */
  function selectPreset(profile: PresetProfile, id: string): void {
    writeSelection(cfg.settings, profile, id === defaultPreset(profile).presetId ? '' : id);
  }

  async function duplicateAsUser(
    id: string,
    scope?: PresetScope,
    name?: string,
  ): Promise<ChatPreset | null> {
    // 复制源取套过开关覆写的目录：副本带上玩家当前看到的开关（2026-11-21）
    const source = catalog.value.find((entry) => entry.preset.id === id)?.preset;
    if (!source) return null;
    const now = Date.now();
    const copy: ChatPreset = {
      ...(JSON.parse(JSON.stringify(source)) as ChatPreset),
      id: crypto.randomUUID(),
      name: name ?? `${source.name}（副本）`,
      createdAt: now,
      updatedAt: now,
    };
    if (scope) copy.scope = scope;
    else delete copy.scope;
    // 副本是玩家预设：不带出厂播种指纹，否则启动播种会把它当成出厂行（2026-11-17）
    delete copy.factorySeedHash;
    await upsertPreset(copy);
    return copy;
  }

  /** 目录里标了只读的（内容包 / 出厂 / 内置）一律不许写 —— 界面要先复制 */
  function assertNotReadonly(id: string): void {
    if (catalog.value.find((entry) => entry.preset.id === id)?.readonly) {
      throw new Error('只读预设不能直接修改，请先复制为自己的预设');
    }
  }

  async function upsertUserPreset(preset: ChatPreset): Promise<void> {
    assertNotReadonly(preset.id);
    await upsertPreset(preset);
  }

  async function removeUserPreset(id: string): Promise<void> {
    assertNotReadonly(id);
    await removePreset(id);
  }

  /** 写覆写层的唯一出口：空表删键，换新对象让 deep watch 必然看见 */
  function writeEntryToggles(presetId: string, toggles: PresetEntryToggles): void {
    const { [presetId]: _dropped, ...rest } = cfg.settings.presetEntryToggles ?? {};
    cfg.settings.presetEntryToggles =
      Object.keys(toggles).length > 0 ? { ...rest, [presetId]: toggles } : rest;
  }

  /**
   * 批量设置条目开关（identifier → enabled）。
   * - 只读预设（内容包 / 出厂 / 内置）：只写覆写层，经 `mergePresetEntryToggles` 归一——
   *   单条开关与原始行相同的键丢掉；`pin: true`（组选择）整组钉住、键全留；归一后为空就删掉该预设的键。
   *   预设行、播种指纹、选择键都不动。
   * - 玩家预设：按 identifier 直接改行再落库。
   * 未知预设 id / 未知 identifier / 五区占位条目一律忽略。
   */
  async function setEntriesEnabled(
    presetId: string,
    patch: PresetEntryToggles,
    options: { pin?: boolean } = {},
  ): Promise<void> {
    const entry = pristineCatalog.value.find((e) => e.preset.id === presetId);
    if (!entry) return;
    if (presetUsesToggleLayer(entry)) {
      const current = cfg.settings.presetEntryToggles?.[presetId] ?? {};
      writeEntryToggles(presetId, mergePresetEntryToggles(entry.preset, current, patch, options));
      return;
    }
    const next = setPresetEntriesEnabled(entry.preset, patch);
    if (next !== entry.preset) await upsertUserPreset(next);
  }

  /** 清掉某预设的全部开关覆写（回到预设原样） */
  function resetEntryToggles(presetId: string): void {
    if (cfg.settings.presetEntryToggles?.[presetId]) writeEntryToggles(presetId, {});
  }

  return {
    presets: presetsRef,
    catalog,
    effectivePreset,
    pristineEffectivePreset,
    defaultPreset,
    selectPreset,
    duplicateAsUser,
    setEntriesEnabled,
    resetEntryToggles,
    loadPresets,
    upsertPreset: upsertUserPreset,
    removePreset: removeUserPreset,
  };
}
