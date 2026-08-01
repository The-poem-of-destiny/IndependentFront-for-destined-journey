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

/**
 * 把 v3 CombatView 投影为战斗 Agent 的文本面板（战况总览 + 行动顺序）。
 *
 * 数据源：CombatView（session.snapshot() 返回的只读投影）——coordinator 边界只能
 * 拿到 view，拿不到内部 CombatState（内核把 state 藏在闭包里）。供 coordinator
 * 组装 Agent prompt 上下文（§4.3 敌方 PlayerCommand 路由用）。
 */
export function projectToAgent(view: Readonly<CombatView>): string {
  const lines: string[] = [];
  lines.push('<action_info>');
  lines.push(`  {战况总览}`);
  lines.push(`  | 回合: ${view.round} |`);

  // 沿 initiativeOrder 顺序列单位（view.units 唯一源）
  const order = view.initiativeOrder.length > 0 ? view.initiativeOrder : Object.keys(view.units);
  for (const id of order) {
    const u = view.units[id];
    if (!u) continue;
    const sideLabel = u.side === 'player' ? '友方' : '敌方';
    const hpPct = u.maxHp > 0 ? Math.round((u.hp / u.maxHp) * 100) : 0;
    lines.push(
      `  | [${sideLabel}] ${u.name}: HP ${u.hp}/${u.maxHp} (${hpPct}%) | MP ${u.mp}/${u.maxMp} | SP ${u.sp}/${u.maxSp} | 攻${u.attacksRemaining} 动${u.actionsRemaining} |`,
    );
    if (u.statusEffects.length > 0) {
      const statusStr = u.statusEffects
        .map((s) => `${s.name}(${s.remainingTime ?? 0}回合)`)
        .join(', ');
      lines.push(`  | 状态: ${statusStr} |`);
    }
    if (u.morale && u.morale !== 'steady') {
      lines.push(`  | 战意: ${u.morale} |`);
    }
  }

  // 行动顺序
  lines.push('  {行动顺序}');
  if (view.initiativeOrder.length > 0) {
    const names = view.initiativeOrder.map((id) => view.units[id]?.name ?? id).join(' → ');
    lines.push(`  | 序列: ${names} |`);
  }

  const fp = view.resourceSnapshots?.FP;
  if (fp !== undefined) {
    lines.push(`  | FP: ${fp} |`);
  }

  lines.push('</action_info>');
  return lines.join('\n');
}
