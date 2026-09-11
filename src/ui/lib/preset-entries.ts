/**
 * preset-entries.ts — 正文 Agent 预设（ChatPreset）的**条目级**纯操作。
 *
 * 背景：`PresetManager.vue` 此前只能开关 / 编辑条目，不能新增 / 删除 / 排序。
 * 本模块把这几条 RMW 从组件里剥出来，做成纯函数：输入 `ChatPreset` + 位置，
 * 返回**新的** `ChatPreset`（深克隆 + 盖 `updatedAt`），失败 / 越界时返回原引用。
 * 组件只负责拿返回值去 `usePresets().upsertPreset()`。
 *
 * 🔴 排序真源是 `injection_order`，不是数组下标：引擎侧 `assemblePresetContent`
 *    （preset-loader.ts:205-207）按 `(a.injection_order ?? 0) - (b.injection_order ?? 0)`
 *    排序后再拼接。所以本模块**所有**操作都先按 `injection_order` 取标准顺序，
 *    改完再按数组位置统一重编号（步长 10），让「数组顺序 = 生效顺序」在每次改动后成立。
 *
 * 🔴 纯函数、无 I/O、无 Pinia：可直接单测（见 preset-entries.test.ts）。
 */
import type { ChatPreset } from '@engine/types';

/** `ChatPreset.settings.prompts` 里单条目的形状（SillyTavern 兼容，字段全可选）。 */
export interface PresetPromptEntry {
  identifier?: string;
  name?: string;
  content?: string;
  role?: string;
  enabled?: boolean;
  injection_order?: number;
  [key: string]: unknown;
}

/** 重编号步长 —— 沿用内容包预设 10/20/30… 的既有节奏。 */
const ORDER_STEP = 10;

function rawPrompts(preset: ChatPreset): PresetPromptEntry[] {
  const prompts = (preset.settings as Record<string, unknown> | undefined)?.prompts;
  return Array.isArray(prompts) ? (prompts as PresetPromptEntry[]) : [];
}

/** 按 `injection_order`（缺省 0）稳定排序，得到与引擎一致的「生效顺序」。 */
export function canonicalPresetEntries(preset: ChatPreset): PresetPromptEntry[] {
  return [...rawPrompts(preset)].sort(
    (a, b) => (a.injection_order ?? 0) - (b.injection_order ?? 0),
  );
}

/** 按数组位置重编号（步长 10），返回新预设（深克隆 + 盖 updatedAt）。 */
function withEntries(preset: ChatPreset, entries: PresetPromptEntry[]): ChatPreset {
  const prompts = entries.map((entry, index) => ({
    ...entry,
    injection_order: (index + 1) * ORDER_STEP,
  }));
  return JSON.parse(
    JSON.stringify({
      ...preset,
      settings: { ...preset.settings, prompts },
      updatedAt: Date.now(),
    }),
  ) as ChatPreset;
}

/** 生成一个条目 id（`custom_` 前缀，与内容包的 `placeholder-*` 区分开）。 */
function defaultMakeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/** 构造一条自定义条目（未入数组；`injection_order` 由 append 时统一编排）。 */
export function makeCustomPresetEntry(
  input: { name?: string; content?: string; role?: string; enabled?: boolean },
  makeId: () => string = defaultMakeId,
): PresetPromptEntry {
  return {
    identifier: `custom_${makeId()}`,
    name: input.name ?? '',
    content: input.content ?? '',
    role: input.role ?? 'system',
    enabled: input.enabled ?? true,
  };
}

/** 追加一条到末尾（生效顺序的末尾），返回新预设。 */
export function appendPresetEntry(preset: ChatPreset, entry: PresetPromptEntry): ChatPreset {
  return withEntries(preset, [...canonicalPresetEntries(preset), entry]);
}

/** 按生效顺序的下标改一条（浅合并 patch），越界返回原引用。 */
export function updatePresetEntry(
  preset: ChatPreset,
  index: number,
  patch: Partial<PresetPromptEntry>,
): ChatPreset {
  const entries = canonicalPresetEntries(preset);
  if (index < 0 || index >= entries.length) return preset;
  entries[index] = { ...entries[index], ...patch };
  return withEntries(preset, entries);
}

/** 按生效顺序的下标删一条，越界返回原引用。 */
export function removePresetEntry(preset: ChatPreset, index: number): ChatPreset {
  const entries = canonicalPresetEntries(preset);
  if (index < 0 || index >= entries.length) return preset;
  entries.splice(index, 1);
  return withEntries(preset, entries);
}

/**
 * 复制一条到它的**正下方**（index + 1）。副本内容/名称/角色/启用态照抄，
 * 只换一个新 `identifier`（同 identifier 会让 Vue key 撞车）。越界返回原引用。
 */
export function duplicatePresetEntry(
  preset: ChatPreset,
  index: number,
  makeId: () => string = defaultMakeId,
): ChatPreset {
  const entries = canonicalPresetEntries(preset);
  if (index < 0 || index >= entries.length) return preset;
  const copy: PresetPromptEntry = { ...entries[index], identifier: `custom_${makeId()}` };
  entries.splice(index + 1, 0, copy);
  return withEntries(preset, entries);
}

/** 按生效顺序的下标上/下移一位（delta = ±1），越界返回原引用。 */
export function movePresetEntry(preset: ChatPreset, index: number, delta: number): ChatPreset {
  const entries = canonicalPresetEntries(preset);
  const target = index + delta;
  if (index < 0 || index >= entries.length || target < 0 || target >= entries.length) {
    return preset;
  }
  const [moved] = entries.splice(index, 1);
  entries.splice(target, 0, moved);
  return withEntries(preset, entries);
}
