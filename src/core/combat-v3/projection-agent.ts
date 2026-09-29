/**
 * combat-v3/projection-agent.ts — 投影 B：CombatState → Markdown 文本面板（M2）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §十三 13.1/13.2
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §4.2（投影 B）/ §3.4
 *
 * 职责：把唯一权威 CombatState 投影成战斗 Agent 看的 Markdown/ASCII 文本面板，
 * 复用 combat-panel.ts 的格式化风格（<action_info> 三阶段模板）。
 *
 * 说明：v3 的 CombatState 字段与 v2 不同（无 state.participants/.environment，
 * 单位在 state.units），无法直接喂给 v2 的 buildOverviewPanel(state)。M2 先写一个
 * 遵循相同 <action_info> 风格、从唯一 CombatState 取数的最小面板；若后续需要精确复用
 * v2 面板函数，再补 v3→v2 CombatParticipant[] 的 adapter（plan §3.4 备注）。
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval；纯函数 + 不可变。
 */

import type { CombatView } from './types';
import type { CombatLogicalRole } from './agent-permissions';
import {
  createCombatVisibilityState,
  projectCombatStateForRole,
  type CombatVisibilityState,
} from './agent-visibility';

/**
 * 把 v3 CombatView 投影为战斗 Agent 的文本面板（战况总览 + 行动顺序）。
 *
 * 数据源：CombatView（session.snapshot() 返回的只读投影）——coordinator 边界只能
 * 拿到 view，拿不到内部 CombatState（内核把 state 藏在闭包里）。供 coordinator
 * 组装 Agent prompt 上下文（§4.3 敌方 PlayerCommand 路由用）。
 */
export function projectToAgent(
  view: Readonly<CombatView>,
  role: CombatLogicalRole = 'combat_host',
  visibility: CombatVisibilityState = createCombatVisibilityState(),
): string {
  const lines: string[] = [];
  lines.push('<action_info>');
  lines.push(`  {战况总览}`);
  lines.push(`  | 回合: ${view.round} |`);

  const projected = projectCombatStateForRole(view, role, visibility);
  const units = projected.units as Array<Record<string, unknown>>;
  for (const unit of units) {
    const sideLabel = unit.side === 'player' ? '友方' : '敌方';
    const resources =
      typeof unit.hp === 'number'
        ? `HP ${unit.hp}/${unit.maxHp} (${unit.hpPercent}%) | MP ${unit.mp}/${unit.maxMp} | SP ${unit.sp}/${unit.maxSp}`
        : `HP ${unit.hpPercent}%`;
    const slots =
      typeof unit.attacksRemaining === 'number'
        ? ` | 攻${unit.attacksRemaining} 动${unit.actionsRemaining}`
        : '';
    lines.push(`  | [${sideLabel}] ${unit.name}: ${resources}${slots} |`);
    const statuses = unit.statusEffects as Array<Record<string, unknown>>;
    if (statuses.length > 0) {
      const statusStr = statuses
        .map((status) => `${status.name}(${status.remainingTime ?? 0}回合)`)
        .join(', ');
      lines.push(`  | 状态: ${statusStr} |`);
    }
    if (unit.morale && unit.morale !== 'steady') {
      lines.push(`  | 战意: ${unit.morale} |`);
    }
    const revealedSkills = unit.revealedSkills as string[] | undefined;
    if (revealedSkills && revealedSkills.length > 0) {
      lines.push(`  | 已公开技能: ${revealedSkills.join('、')} |`);
    }
  }

  // 行动顺序
  lines.push('  {行动顺序}');
  if (view.initiativeOrder.length > 0) {
    const names = view.initiativeOrder.map((id) => view.units[id]?.name ?? id).join(' → ');
    lines.push(`  | 序列: ${names} |`);
  }

  const resources = projected.resourceSnapshots as { FP?: number } | undefined;
  if (resources?.FP !== undefined) {
    lines.push(`  | FP: ${resources.FP} |`);
  }

  lines.push('</action_info>');
  return lines.join('\n');
}
