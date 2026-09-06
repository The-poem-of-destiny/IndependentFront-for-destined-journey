/**
 * useBeautify — 文本美化 composable（从 ChatFlow.vue 抽出，CombatMessageFlow 复用）
 *
 * 职责：按当前存档合并预设规则与用户规则，供统一 narrative renderer 编译。
 * autoEnable 解析以当前存档为准（命定核心/启用角色的世界书条目 uid），
 * 与 BeautifierSection 同口径：美化绑定**启用的世界书条目**，不按角色名。
 *
 * 对齐 docs/design.md §2.5（首行缩进）/ §1（叙事衬线）。
 */
import { collectActiveSignalsFromEntries, resolveAutoEnable } from '@engine/beautifier';
import type { BeautifierRule } from '@engine/types';
import { useSettingsStore } from '../stores/settings-store';
import { useGameStore } from '../stores/game-store';
import { useBeautifierStore } from '../stores/beautifier-store';
import { useWorkshopStore } from '../stores/workshop-store';
import { useWorldBookStore } from '../stores/worldbook-store';
import { buildWorkshopEnableOptions, selectedWorkshopProjectIds } from '../lib/workshop-enable';
import { workshopBookId } from '@engine/workshop-types';

export function useBeautify() {
  const settings = useSettingsStore();
  const s = settings.settings;
  const game = useGameStore();
  // Phase 0b: 规则从 beautifier-store 取 —— 用户规则在 Dexie，预设规则是纯内存派生缓存。
  // `beautifierEnabled` 仍是 settings 里的开关，不动。
  const beautifier = useBeautifierStore();
  const workshop = useWorkshopStore();
  const worldbooks = useWorldBookStore();

  /**
   * 合并预设规则 + 用户规则，返回完整美化规则列表。
   *
   * autoEnable 以当前存档为准：命定核心选择走独立 uid（不改世界书条目 enabled），
   * 存于 save.metadata.enabledWorldBookEntries。规则按**启用的世界书条目 uid**
   * 匹配激活（与 BeautifierSection 同源信号）。
   */
  function getBeautifierRules(): BeautifierRule[] {
    const preset = beautifier.presetRules;
    const user = beautifier.userRules;

    const enabledEntries: string[] =
      (game.activeSave?.metadata as any)?.enabledWorldBookEntries ?? [];
    const { activeWorldBookIds, activeEntryUids } = collectActiveSignalsFromEntries(enabledEntries);

    // Workshop rule bindings use `workshop:<projectId>`, while the save stores
    // `creative_workshop:<entryUid>`. Resolve that project-level seam here so an
    // installed rule only runs in saves where its whole project is enabled.
    const workshopOptions = buildWorkshopEnableOptions(workshop.projects, worldbooks.books);
    const activeWorkshopProjectIds = selectedWorkshopProjectIds(workshopOptions, enabledEntries);
    for (const projectId of activeWorkshopProjectIds) {
      activeWorldBookIds.add(workshopBookId(projectId));
    }

    // 美化绑定启用的世界书（worldBookIds / worldBookEntryUids 二维），
    // 不按角色名 —— 角色是否在场不影响规则激活。
    const resolved = resolveAutoEnable(preset, activeWorldBookIds, activeEntryUids, new Set());
    const scopedUserRules = user.map((rule) => {
      const workshopBindings =
        rule.autoEnable?.worldBookIds?.filter((id) => id.startsWith('workshop:')) ?? [];
      if (workshopBindings.length === 0) return rule;
      return {
        ...rule,
        enabled:
          rule.enabled && workshopBindings.some((binding) => activeWorldBookIds.has(binding)),
      };
    });

    // 文档契约「同名 ID 用户优先」（F15）：与 mergeRules 同语义 ——
    // 用户规则 ID 命中非 locked 预设 → 在原槽位整条替换；locked 预设不可替换；
    // 独有用户规则按用户顺序追加。
    const scopedById = new Map<string, BeautifierRule>();
    for (const r of scopedUserRules) scopedById.set(r.id, r);
    const effective = resolved.map((r) => ({ ...r }));
    const presetIdSet = new Set(effective.map((r) => r.id));
    const overridden = new Set<string>();
    for (const preset of effective) {
      if (preset.locked) continue;
      const override = scopedById.get(preset.id);
      if (override) {
        Object.assign(preset, override);
        overridden.add(preset.id);
      }
    }
    for (const id of overridden) scopedById.delete(id);
    // locked 预设命中：用户规则不可替换也不追加（受保护，避免重复 ID）
    for (const id of presetIdSet) scopedById.delete(id);
    return [
      ...effective,
      ...scopedUserRules.filter((r) => scopedById.has(r.id) && !overridden.has(r.id)),
    ];
  }

  function isBeautifierEnabled(): boolean {
    return s.beautifierEnabled;
  }

  return { getBeautifierRules, isBeautifierEnabled };
}
