/**
 * usePresetKnobs — 某生成方式（story / direct / direct_cached）生效预设的「旋钮」视图。
 *
 * 设置页 PresetManager 与游戏内「预设」抽屉共用：汇出生效预设（已套玩家的条目开关覆写）、
 * 是否只读、互斥组及其状态、生效总览（token 估算）、已调整条数，以及三个动作。
 *
 * 🔴 写入一律经 `usePresets().setEntriesEnabled` / `resetEntryToggles`：只读预设只写覆写层
 *    （`settings.presetEntryToggles`），玩家预设直接改行。本文件不自己碰 Dexie 或设置袋。
 * 🔴 互斥组的选中状态就是条目自身的 `enabled`（引擎 `prompts/preset-groups.ts`），这里不存第二份。
 */
import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';
import {
  diffPresetEntryToggles,
  readPresetGroups,
  resolvePresetGroupState,
  selectPresetGroupOption,
  type PresetGroup,
  type PresetGroupState,
} from '@engine/prompts/preset-groups';
import { summarizePresetEntries, type PresetInsightSummary } from '@engine/prompts/preset-insight';
import type { PresetProfile } from '@engine/prompts/preset-resolution';
import type { AgentPreset, ChatPreset } from '@engine/types/types';
import { useSettingsStore } from '../stores/settings-store';
import { usePresets } from './usePresets';

/** 一个互斥组连同它的当前状态 */
interface PresetKnobGroup {
  group: PresetGroup;
  state: PresetGroupState;
}

export interface PresetKnobs {
  /** 生效预设 id（解析不到时为空串） */
  presetId: ComputedRef<string>;
  /** 生效预设（已套开关覆写）；解析不到为 null */
  preset: ComputedRef<ChatPreset | null>;
  /** 是否只读（内容包 / 出厂 / 内置）：只读时开关写进覆写层 */
  readonly: ComputedRef<boolean>;
  groups: ComputedRef<PresetKnobGroup[]>;
  summary: ComputedRef<PresetInsightSummary>;
  /** 覆写后与原始行实际不同的条目数（不按覆写键数算；玩家预设恒为 0） */
  adjustedCount: ComputedRef<number>;
  /** 选中组内一项（`null` = 一个都不选，仅 `allowNone` 组）；不合法返回 false */
  selectOption: (groupId: string, identifier: string | null) => Promise<boolean>;
  /** 翻转一条的开关；未知 identifier 忽略 */
  toggleEntry: (identifier: string) => Promise<void>;
  /** 清掉这个预设的全部开关覆写 */
  resetToggles: () => void;
}

export function usePresetKnobs(profile: MaybeRefOrGetter<PresetProfile>): PresetKnobs {
  const cfg = useSettingsStore();
  const {
    catalog,
    effectivePreset,
    pristineEffectivePreset,
    setEntriesEnabled,
    resetEntryToggles,
  } = usePresets();

  const effective = computed(() => effectivePreset(toValue(profile)));
  const presetId = computed(() => effective.value.presetId);
  const preset = computed(() => effective.value.preset);
  const readonly = computed(() => {
    const id = presetId.value;
    if (!id) return false;
    return catalog.value.find((e) => e.preset.id === id)?.readonly ?? false;
  });

  const groups = computed<PresetKnobGroup[]>(() => {
    const current = preset.value;
    if (!current) return [];
    return readPresetGroups(current).map((group) => ({
      group,
      state: resolvePresetGroupState(current, group),
    }));
  });

  const summary = computed(() =>
    summarizePresetEntries(preset.value as unknown as AgentPreset | null),
  );

  // 组选择会整组钉住（与原始行相同的键也留着），所以按「与原始行实际不同」计数
  const adjustedCount = computed(() => {
    const toggles = cfg.settings.presetEntryToggles?.[presetId.value];
    if (!toggles) return 0;
    const pristine = pristineEffectivePreset(toValue(profile)).preset;
    return pristine ? Object.keys(diffPresetEntryToggles(pristine, toggles)).length : 0;
  });

  async function selectOption(groupId: string, identifier: string | null): Promise<boolean> {
    const current = preset.value;
    const group = groups.value.find((g) => g.group.id === groupId)?.group;
    if (!current || !group) return false;
    const patch = selectPresetGroupOption(current, group, identifier);
    if (!patch) return false;
    await setEntriesEnabled(current.id, patch, { pin: true });
    return true;
  }

  async function toggleEntry(identifier: string): Promise<void> {
    const current = preset.value;
    if (!current) return;
    const prompts = (current.settings as { prompts?: unknown } | undefined)?.prompts;
    if (!Array.isArray(prompts)) return;
    const entry = prompts.find(
      (p): p is { identifier: string; enabled?: unknown } =>
        p !== null &&
        typeof p === 'object' &&
        (p as { identifier?: unknown }).identifier === identifier,
    );
    if (!entry) return;
    await setEntriesEnabled(current.id, { [identifier]: entry.enabled === false });
  }

  function resetToggles(): void {
    if (presetId.value) resetEntryToggles(presetId.value);
  }

  return {
    presetId,
    preset,
    readonly,
    groups,
    summary,
    adjustedCount,
    selectOption,
    toggleEntry,
    resetToggles,
  };
}
