/**
 * preset-groups.ts — 正文预设的「互斥组」与「开关覆写层」（纯函数，无 I/O、无 Vue / Pinia）。
 *
 * 互斥组元数据放在 `settings.extensions.poem.groups`：
 *   `[{ id, label, description?, allowNone?, options: [{ identifier, label }] }]`
 * 同一组里的条目只能启用一个（UI 显示为单选）。🔴 选中状态就是条目自身的 `enabled`，
 * 本模块不引入第二份真源，引擎装配逻辑也不读组元数据。
 *
 * 开关覆写层：只读的内容包预设按玩家另存 `Record<identifier, boolean>`，只覆盖 `enabled`，
 * 读取时用 `applyPresetEntryToggles` 套到预设视图上，不写回预设行。
 * 写入经 `mergePresetEntryToggles` 归一：单条开关只留与原始行不同的键；组选择「整组钉住」——
 * 组内全部成员的键都留着（哪怕与原始行相同），出厂默认日后改了，玩家的选择也不会被静默顶掉。
 *
 * 🔴 五区占位条目（`story_zone_1…5`）恒启用、不可停用，不能作为组选项（读取时丢弃）。
 */
import type { ChatPreset } from '../types/types';
import { isStoryZonePlaceholder } from './story-zone-placeholders';

/** 互斥组的一个选项：指向 `settings.prompts[]` 里的一条目。 */
interface PresetGroupOption {
  identifier: string;
  label: string;
}

/** 互斥组（读取并清洗后的形状）。 */
export interface PresetGroup {
  id: string;
  label: string;
  description?: string;
  /** 是否允许一个都不选。 */
  allowNone: boolean;
  options: PresetGroupOption[];
}

/** 组的当前状态：恰好一个启用 / 一个都没启用 / 多个同时启用（冲突）。 */
export type PresetGroupState =
  | { status: 'ok'; selected: string }
  | { status: 'none' }
  | { status: 'conflict'; enabled: string[] };

/** 条目开关覆写 / 补丁：identifier → enabled。 */
export type PresetEntryToggles = Record<string, boolean>;

interface RawPromptEntry {
  identifier?: unknown;
  enabled?: unknown;
  [key: string]: unknown;
}

function rawPrompts(preset: ChatPreset): RawPromptEntry[] {
  const prompts = (preset?.settings as Record<string, unknown> | undefined)?.prompts;
  return Array.isArray(prompts)
    ? (prompts.filter((p) => p !== null && typeof p === 'object') as RawPromptEntry[])
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** identifier → 条目（重复 identifier 取第一条）。 */
function entryIndex(preset: ChatPreset): Map<string, RawPromptEntry> {
  const index = new Map<string, RawPromptEntry>();
  for (const entry of rawPrompts(preset)) {
    const id = entry.identifier;
    if (typeof id === 'string' && !index.has(id)) index.set(id, entry);
  }
  return index;
}

function isEntryEnabled(entry: RawPromptEntry | undefined): boolean {
  return entry !== undefined && entry.enabled !== false;
}

/**
 * 读取并清洗预设的互斥组。容错，不抛异常：
 * - 丢弃没有 id、或清洗后 options 为空的组；组 id 重复时取第一个；
 * - 丢弃引用不存在 identifier 的选项、引用五区占位条目的选项；
 * - 同一 identifier 出现在多个组（或同组多次）时，只保留第一次出现。
 * 缺失的 label 回退为 id / identifier。
 */
export function readPresetGroups(preset: ChatPreset): PresetGroup[] {
  try {
    const settings = preset?.settings as Record<string, unknown> | undefined;
    const extensions = isRecord(settings) ? settings.extensions : undefined;
    const poem = isRecord(extensions) ? extensions.poem : undefined;
    const rawGroups = isRecord(poem) ? poem.groups : undefined;
    if (!Array.isArray(rawGroups)) return [];

    const entries = entryIndex(preset);
    const seenGroupIds = new Set<string>();
    const claimed = new Set<string>();
    const groups: PresetGroup[] = [];

    for (const raw of rawGroups) {
      if (!isRecord(raw)) continue;
      const id = nonEmptyString(raw.id);
      if (id === null || seenGroupIds.has(id)) continue;
      if (!Array.isArray(raw.options)) continue;

      const options: PresetGroupOption[] = [];
      for (const rawOption of raw.options) {
        if (!isRecord(rawOption)) continue;
        const identifier = nonEmptyString(rawOption.identifier);
        if (identifier === null || claimed.has(identifier)) continue;
        const entry = entries.get(identifier);
        if (entry === undefined || isStoryZonePlaceholder(entry)) continue;
        claimed.add(identifier);
        options.push({ identifier, label: nonEmptyString(rawOption.label) ?? identifier });
      }
      if (options.length === 0) continue;

      seenGroupIds.add(id);
      const group: PresetGroup = {
        id,
        label: nonEmptyString(raw.label) ?? id,
        allowNone: raw.allowNone === true,
        options,
      };
      const description = nonEmptyString(raw.description);
      if (description !== null) group.description = description;
      groups.push(group);
    }
    return groups;
  } catch {
    return [];
  }
}

/** 组的当前状态。启用判定为 `enabled !== false`（与 ST 缺省一致）。 */
export function resolvePresetGroupState(preset: ChatPreset, group: PresetGroup): PresetGroupState {
  const entries = entryIndex(preset);
  const enabled = group.options
    .map((option) => option.identifier)
    .filter((identifier) => isEntryEnabled(entries.get(identifier)));
  if (enabled.length === 0) return { status: 'none' };
  if (enabled.length === 1) return { status: 'ok', selected: enabled[0] };
  return { status: 'conflict', enabled };
}

/**
 * 选中组内某一项（或 `null` = 一个都不选），返回 identifier → enabled 补丁（覆盖组内全部选项）。
 * 不合法时返回 `null`：identifier 不在组内，或传 `null` 但组不允许不选。
 */
export function selectPresetGroupOption(
  _preset: ChatPreset,
  group: PresetGroup,
  identifier: string | null,
): PresetEntryToggles | null {
  if (identifier === null) {
    if (!group.allowNone) return null;
  } else if (!group.options.some((option) => option.identifier === identifier)) {
    return null;
  }
  const patch: PresetEntryToggles = {};
  for (const option of group.options) patch[option.identifier] = option.identifier === identifier;
  return patch;
}

/**
 * 把开关覆写套到预设上，返回新预设；没有任何条目变化时返回原引用。
 * 不修改入参；未知 identifier 忽略；五区占位条目恒启用，不受覆写影响。
 */
export function applyPresetEntryToggles(
  preset: ChatPreset,
  toggles: PresetEntryToggles | null | undefined,
): ChatPreset {
  if (!isRecord(toggles)) return preset;
  const prompts = (preset?.settings as Record<string, unknown> | undefined)?.prompts;
  if (!Array.isArray(prompts)) return preset;

  let changed = false;
  const next = prompts.map((entry: unknown) => {
    if (!isRecord(entry) || isStoryZonePlaceholder(entry)) return entry;
    const id = entry.identifier;
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(toggles, id)) return entry;
    const wanted = toggles[id];
    if (typeof wanted !== 'boolean' || isEntryEnabled(entry) === wanted) return entry;
    changed = true;
    return { ...entry, enabled: wanted };
  });
  if (!changed) return preset;
  return { ...preset, settings: { ...preset.settings, prompts: next } };
}

/**
 * 只保留与预设原始行不同的覆写键（未知 identifier、五区占位、非布尔值一并丢弃）。
 * `keep` 里的 identifier 即使与原始行相同也保留（整组钉住用）。
 */
export function diffPresetEntryToggles(
  preset: ChatPreset,
  toggles: PresetEntryToggles | null | undefined,
  keep?: ReadonlySet<string>,
): PresetEntryToggles {
  const diff: PresetEntryToggles = {};
  if (!isRecord(toggles)) return diff;
  const entries = entryIndex(preset);
  for (const [identifier, wanted] of Object.entries(toggles)) {
    if (typeof wanted !== 'boolean') continue;
    const entry = entries.get(identifier);
    if (entry === undefined || isStoryZonePlaceholder(entry)) continue;
    if (isEntryEnabled(entry) !== wanted || keep?.has(identifier)) diff[identifier] = wanted;
  }
  return diff;
}

/**
 * 把补丁并进现有覆写并归一，返回新的覆写表（不修改入参）。
 * - `pin: true`（组选择）：补丁里的键全部钉住，与原始行相同也保留；
 * - 现有覆写里有任一成员键的互斥组视为已钉住，整组成员键继续保留；
 * - 不钉住的补丁（单条开关）碰到某个已钉住组的成员时，该组解除钉住，整组回到按 diff 归一。
 */
export function mergePresetEntryToggles(
  preset: ChatPreset,
  current: PresetEntryToggles | null | undefined,
  patch: PresetEntryToggles,
  options: { pin?: boolean } = {},
): PresetEntryToggles {
  const base = isRecord(current) ? current : {};
  const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
  const keep = new Set<string>(options.pin ? Object.keys(patch) : []);
  for (const group of readPresetGroups(preset)) {
    const ids = group.options.map((option) => option.identifier);
    if (!ids.some((id) => has(base, id))) continue;
    if (!options.pin && ids.some((id) => has(patch, id))) continue;
    for (const id of ids) keep.add(id);
  }
  return diffPresetEntryToggles(preset, { ...base, ...patch }, keep);
}
