/**
 * 预设目录与「当前生效预设」的唯一解析处（纯函数，无 I/O）。
 *
 * 🔴 运行时（game-pipeline）、设置页、存档导出与「保存为默认」都从这里取生效预设，
 *    任何调用方都不许自己再拼一遍回退链。
 *
 * 选择键的语义：
 *   · 空串 = 跟随默认（内容默认 → 内置/首个内容预设）。
 *   · 指向目录里不存在、或不属于该生成方式的 id = 读取时忽略、照常走默认，
 *     **但不从设置里删掉** —— 受保护内容包锁定时它的预设会暂时缺席，解锁后要回得来。
 */
import type { ChatPreset, PresetScope } from '../types/types';
import {
  createCachedDirectPreset,
  createDirectPreset,
  DIRECT_CACHED_PRESET_ID,
  DIRECT_PRESET_ID,
} from './direct-prompt';

export type PresetProfile = 'story' | 'direct' | 'direct_cached';
/** content = 内容包或占位内容；builtin = 引擎内置；user = 玩家自己的 */
type PresetOrigin = 'content' | 'builtin' | 'user';
/** 定义在 types.ts；此处转出口，保留既有 import 路径 */
export type { PresetScope };
export type PresetSelectionKey = 'activePresetId' | 'directPresetId' | 'directCachedPresetId';
type PresetDefaultsKey = 'story' | 'direct_main' | 'direct_cached';

export const PRESET_PROFILES: readonly PresetProfile[] = ['story', 'direct', 'direct_cached'];

export const PRESET_SELECTION_KEYS: Readonly<Record<PresetProfile, PresetSelectionKey>> = {
  story: 'activePresetId',
  direct: 'directPresetId',
  direct_cached: 'directCachedPresetId',
};

const PRESET_DEFAULTS_KEYS: Readonly<Record<PresetProfile, PresetDefaultsKey>> = {
  story: 'story',
  direct: 'direct_main',
  direct_cached: 'direct_cached',
};

/** 公开仓占位 story 预设的 id —— 装包后它可能仍躺在盘上，不再是默认时视作遗留 */
export const PLACEHOLDER_STORY_PRESET_ID = 'placeholder-story-v1';

const BUILTIN_IDS: ReadonlyMap<string, 'direct' | 'direct_cached'> = new Map<
  string,
  'direct' | 'direct_cached'
>([
  [DIRECT_PRESET_ID, 'direct'],
  [DIRECT_CACHED_PRESET_ID, 'direct_cached'],
]);

export function isBuiltinPresetId(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

export function profileScope(profile: PresetProfile): PresetScope {
  return profile === 'story' ? 'story' : 'direct';
}

/**
 * 预设 scope 是否对该生成方式可见（唯一判定处，UI 不许自己再写一遍）。
 * 缺省 = 全部；direct = 两种直出；direct_main / direct_cached = 只对那一种。
 */
export function presetScopeMatches(
  scope: PresetScope | undefined,
  profile: PresetProfile,
): boolean {
  switch (scope) {
    case undefined:
      return true;
    case 'story':
      return profile === 'story';
    case 'direct':
      return profile === 'direct' || profile === 'direct_cached';
    case 'direct_main':
      return profile === 'direct';
    case 'direct_cached':
      return profile === 'direct_cached';
  }
}

/**
 * 复制预设（「复制为我的预设」/ 写时复制）时副本的 scope：
 * 来源钉死在单一直出方式的保持原样，其余按当前生成方式取 `profileScope`。
 */
export function copyScopeFor(entry: { scope?: PresetScope }, profile: PresetProfile): PresetScope {
  if (entry.scope === 'direct_main' || entry.scope === 'direct_cached') return entry.scope;
  return profileScope(profile);
}

/** Agent 设置/默认层的 agentId → 预设生成方式（不对应预设的 agent 返回 null） */
export function presetProfileForAgent(agentId: string): PresetProfile | null {
  if (agentId === 'story') return 'story';
  if (agentId === 'direct_main') return 'direct';
  if (agentId === 'direct_cached') return 'direct_cached';
  return null;
}

/** 引擎内置的直出预设（每次调用给新对象，调用方可放心改） */
export function builtinDirectPresets(): Partial<Record<'direct' | 'direct_cached', ChatPreset>> {
  return { direct: createDirectPreset(), direct_cached: createCachedDirectPreset() };
}

/** 默认层里与预设有关的两个字段；形状宽松，运行期逐个校验 */
interface PresetDefaultsEntry {
  presetId?: unknown;
  preset?: unknown;
}
export type PresetAgentDefaults = Readonly<Record<string, PresetDefaultsEntry | undefined>>;

export interface PresetCatalogEntry {
  preset: ChatPreset;
  origin: PresetOrigin;
  /** 缺省 = 对所有生成方式可见 */
  scope?: PresetScope;
  readonly: boolean;
  /** 内置预设对应的生成方式（只有 builtin 有） */
  builtinFor?: 'direct' | 'direct_cached';
}

function isPresetLike(value: unknown): value is ChatPreset {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id !== ''
  );
}

function defaultPresetId(
  agentDefaults: PresetAgentDefaults | undefined,
  profile: PresetProfile,
): string {
  const id = agentDefaults?.[PRESET_DEFAULTS_KEYS[profile]]?.presetId;
  return typeof id === 'string' ? id : '';
}

export interface BuildPresetCatalogInput {
  /** Dexie 行 + 受保护内容包的内存叠加层（已合并） */
  storedRows: readonly ChatPreset[];
  agentDefaults?: PresetAgentDefaults;
  builtins?: Partial<Record<'direct' | 'direct_cached', ChatPreset>>;
  /** 内容包（或占位内容）拥有的预设 id */
  contentOwnedIds?: Iterable<string>;
}

/**
 * 合并出预设目录。优先级：存储行 > 默认层内嵌预设 > 内置预设（同 id 只留优先者）。
 */
export function buildPresetCatalog(input: BuildPresetCatalogInput): PresetCatalogEntry[] {
  const { storedRows, agentDefaults, builtins } = input;
  const contentIds = new Set(input.contentOwnedIds ?? []);
  contentIds.add(PLACEHOLDER_STORY_PRESET_ID);
  const embedded: ChatPreset[] = [];
  const storyRefs = new Set<string>();
  const directRefs = new Set<string>();
  for (const [agentId, entry] of Object.entries(agentDefaults ?? {})) {
    if (!entry) continue;
    const profile = presetProfileForAgent(agentId);
    const refs = profile === 'story' ? storyRefs : profile ? directRefs : null;
    if (typeof entry.presetId === 'string' && entry.presetId) {
      contentIds.add(entry.presetId);
      refs?.add(entry.presetId);
    }
    if (isPresetLike(entry.preset)) {
      embedded.push(entry.preset);
      contentIds.add(entry.preset.id);
      refs?.add(entry.preset.id);
    }
  }

  const rows: ChatPreset[] = [];
  const seen = new Set<string>();
  const push = (preset: ChatPreset) => {
    if (seen.has(preset.id)) return;
    seen.add(preset.id);
    rows.push(preset);
  };
  for (const row of storedRows) if (isPresetLike(row)) push(row);
  for (const preset of embedded) push(preset);
  for (const preset of Object.values(builtins ?? {})) if (preset) push(preset);

  return rows.map((preset) => {
    const builtinFor = BUILTIN_IDS.get(preset.id);
    if (builtinFor)
      return { preset, origin: 'builtin', scope: 'direct', readonly: true, builtinFor };
    if (contentIds.has(preset.id)) {
      const inStory = storyRefs.has(preset.id);
      const inDirect = directRefs.has(preset.id);
      const scope: PresetScope | undefined =
        preset.scope ?? (inDirect ? (inStory ? undefined : 'direct') : 'story');
      return { preset, origin: 'content', scope, readonly: true };
    }
    return { preset, origin: 'user', scope: preset.scope, readonly: false };
  });
}

function inScope(entry: PresetCatalogEntry, profile: PresetProfile): boolean {
  return presetScopeMatches(entry.scope, profile);
}

export interface ResolvePresetInput {
  profile: PresetProfile;
  /** 设置里的选择键原值（空串/缺省 = 跟随默认） */
  selection: string | null | undefined;
  agentDefaults?: PresetAgentDefaults;
  catalog: readonly PresetCatalogEntry[];
}

export interface EffectivePreset {
  /** 生效预设 id；`source === 'none'` 时为空串 */
  presetId: string;
  preset: ChatPreset | null;
  followsDefault: boolean;
  source: 'selection' | 'content-default' | 'builtin-default' | 'none';
  /** 选择键非空但读取时被忽略（目录里没有或不属于本生成方式） */
  staleSelection: boolean;
}

/** 不看选择键时，默认链解析到哪一条 */
function resolveDefaultEntry(
  profile: PresetProfile,
  agentDefaults: PresetAgentDefaults | undefined,
  catalog: readonly PresetCatalogEntry[],
): { entry: PresetCatalogEntry; source: 'content-default' | 'builtin-default' } | null {
  const defaultId = defaultPresetId(agentDefaults, profile);
  if (defaultId) {
    const entry = catalog.find((e) => e.preset.id === defaultId);
    if (entry) {
      return { entry, source: entry.origin === 'builtin' ? 'builtin-default' : 'content-default' };
    }
  }
  if (profile === 'story') {
    const entry = catalog.find((e) => e.origin === 'content' && e.scope === 'story');
    return entry ? { entry, source: 'content-default' } : null;
  }
  const entry = catalog.find((e) => e.origin === 'builtin' && e.builtinFor === profile);
  return entry ? { entry, source: 'builtin-default' } : null;
}

export function resolveEffectivePreset(input: ResolvePresetInput): EffectivePreset {
  const { profile, agentDefaults, catalog } = input;
  const selection = input.selection || '';
  const fallback = resolveDefaultEntry(profile, agentDefaults, catalog);
  const defaultId = fallback?.entry.preset.id ?? '';
  if (selection) {
    const picked = catalog.find((e) => e.preset.id === selection);
    if (picked && inScope(picked, profile)) {
      return {
        presetId: picked.preset.id,
        preset: picked.preset,
        followsDefault: selection === defaultId,
        source: 'selection',
        staleSelection: false,
      };
    }
  }
  const staleSelection = selection !== '';
  if (!fallback) {
    return { presetId: '', preset: null, followsDefault: true, source: 'none', staleSelection };
  }
  return {
    presetId: fallback.entry.preset.id,
    preset: fallback.entry.preset,
    followsDefault: true,
    source: fallback.source,
    staleSelection,
  };
}

/**
 * 选择键归一（幂等）：与默认链结果相同、或是不再作为默认的遗留占位 story 预设 id → 空串；
 * 其余原样返回。🔴 **绝不**因为目录里暂时找不到就清掉（受保护包锁定时会缺席）。
 *
 * 📌 2026-11-14：内置直出预设 id **不再**在这里清空 —— 内容包自带直出默认时，玩家仍可
 *    显式选引擎内置那份。旧版落盘行的迁移（仅那一次）在 `migrateBuiltinPresetRows` 里清。
 */
export function normalizePresetSelection(input: ResolvePresetInput): string {
  const selection = input.selection || '';
  if (!selection) return '';
  const fallback = resolveDefaultEntry(input.profile, input.agentDefaults, input.catalog);
  if (selection === fallback?.entry.preset.id) return '';
  if (selection === PLACEHOLDER_STORY_PRESET_ID) return '';
  return selection;
}
