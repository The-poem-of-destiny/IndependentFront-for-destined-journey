/**
 * 预设目录工厂：GamePipeline 与设置页（usePresets）共用的唯一装配口径。
 *
 * 目录 = 存储行 + 默认层内嵌 + 内置直出预设；内容所有的 id = 当前内容包预设 ∪ 出厂预设。
 * 📌 2026-11-25（R7）：此前管线只登记内容包 id、设置页还登记出厂 id，同一行在两边只读与否不同，
 *    靠 `presetUsesToggleLayer` 的播种指纹判据兜底。现在两边都调本工厂，同输入同输出。
 * 🔴 本工厂只出**原始目录**（不套开关覆写）；覆写层只在 `usePresets().catalog` 与
 *    `GamePipeline.loadPresets` 两处经 `applyCatalogEntryToggles` 套用。
 */
import { ref } from 'vue';
import { getActivePackPayload } from '@engine/content/pack-runtime';
import {
  buildPresetCatalog,
  builtinDirectPresets,
  type PresetAgentDefaults,
  type PresetCatalogEntry,
} from '@engine/prompts/preset-resolution';
import type { ChatPreset } from '@engine/types/types';

/**
 * 出厂预设 id（settings-store 播种时登记：agent-config 内嵌预设 ∪ `/data/defaults/presets.json`）。
 * 这些行虽然落在 Dexie 里，却归内容所有 —— 目录里算 `content`（只读），不显示成「我的预设」。
 * 用 ref 是为了让 `usePresets().catalog` 在登记后重算。
 */
const factoryPresetIds = ref<ReadonlySet<string>>(new Set());

export function registerFactoryPresetIds(ids: Iterable<string>): void {
  factoryPresetIds.value = new Set(ids);
}

/** 当前内容包（含受保护包解锁后的明文）与出厂文件拥有的预设 id */
function contentOwnedPresetIds(): string[] {
  return [
    ...(getActivePackPayload()?.presets ?? []).map((preset) => preset.id),
    ...factoryPresetIds.value,
  ];
}

/** 唯一的目录装配入口：存储行 + 默认层内嵌 + 内置直出预设（原始行，不套开关覆写） */
export function buildUiPresetCatalog(
  storedRows: readonly ChatPreset[],
  agentDefaults: PresetAgentDefaults | undefined,
): PresetCatalogEntry[] {
  return buildPresetCatalog({
    storedRows,
    agentDefaults,
    builtins: builtinDirectPresets(),
    contentOwnedIds: contentOwnedPresetIds(),
  });
}
