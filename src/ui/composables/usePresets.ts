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
  buildPresetCatalog,
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
import type { ChatPreset } from '@engine/types/types';
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

/**
 * 出厂预设 id（settings-store 播种时登记：agent-config 内嵌预设 ∪ `/data/defaults/presets.json`）。
 * 📌 2026-11-14：这些行虽然落在 Dexie 里，却归内容所有 —— 目录里算 `content`（只读），
 *    不能因为「在盘上」就显示成「我的预设」。
 */
const factoryPresetIds = ref<ReadonlySet<string>>(new Set());

export function registerFactoryPresetIds(ids: Iterable<string>): void {
  factoryPresetIds.value = new Set(ids);
}

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

/** 当前内容包（含受保护包解锁后的明文）与出厂文件拥有的预设 id */
function contentPresetIds(): string[] {
  return [
    ...(getActivePackPayload()?.presets ?? []).map((preset) => preset.id),
    ...factoryPresetIds.value,
  ];
}

/** 前端各处共用的目录装配：存储行 + 默认层内嵌 + 内置直出预设 */
function buildUiPresetCatalog(
  storedRows: readonly ChatPreset[],
  agentDefaults: PresetAgentDefaults | undefined,
): PresetCatalogEntry[] {
  return buildPresetCatalog({
    storedRows,
    agentDefaults,
    builtins: builtinDirectPresets(),
    contentOwnedIds: contentPresetIds(),
  });
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
  presets: Readonly<Ref<ChatPreset[]>>;
  catalog: ComputedRef<PresetCatalogEntry[]>;
  effectivePreset: (profile: PresetProfile) => EffectivePreset;
  defaultPreset: (profile: PresetProfile) => EffectivePreset;
  selectPreset: (profile: PresetProfile, id: string) => void;
  duplicateAsUser: (id: string, scope?: PresetScope, name?: string) => Promise<ChatPreset | null>;
  loadPresets: typeof loadPresets;
  upsertPreset: typeof upsertPreset;
  removePreset: typeof removePreset;
} {
  const cfg = useSettingsStore();
  const agentDefaults = (): PresetAgentDefaults | undefined => cfg.projectAgentDefaults?.agents;
  const catalog = computed(() => buildUiPresetCatalog(presetsRef.value, agentDefaults()));

  function effectivePreset(profile: PresetProfile): EffectivePreset {
    return resolveEffectivePreset({
      profile,
      selection: presetSelection(cfg.settings, profile),
      agentDefaults: agentDefaults(),
      catalog: catalog.value,
    });
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

  /** 选中默认那条 = 存空串（跟随默认），其余存 id */
  function selectPreset(profile: PresetProfile, id: string): void {
    writeSelection(cfg.settings, profile, id === defaultPreset(profile).presetId ? '' : id);
  }

  async function duplicateAsUser(
    id: string,
    scope?: PresetScope,
    name?: string,
  ): Promise<ChatPreset | null> {
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

  return {
    presets: presetsRef,
    catalog,
    effectivePreset,
    defaultPreset,
    selectPreset,
    duplicateAsUser,
    loadPresets,
    upsertPreset: upsertUserPreset,
    removePreset: removeUserPreset,
  };
}
