// src/sillytavern/describe-automaton.ts
/**
 * describe-automaton.ts —— EffectAutomatonDecl（DSL 自由效果）→ 人类可读中文摘要
 *
 * 纯函数模块：零 I/O、零 Vue、零 Dexie。automaton 是 DSL 内部表示，不适合裸展示；
 * 本模块把「订阅窗口 + 触发条件 + intents」翻译成玩家能懂的中文行。
 *
 * 设计：docs/superpowers/specs/2026-08-02-item-detail-summary-design.md §3.2
 */

import type { EffectAutomatonDecl, EffectIntent, ModifierSlot, WindowKey } from './combat-v3/types';

/** 18 窗口 → 中文（按 combat-v3/types.ts WindowKey 全量） */
const WINDOW_CN: Record<WindowKey, string> = {
  'round.open': '回合开始时',
  'round.close': '回合结束时',
  'initiative.before': '先攻判定前',
  'initiative.after': '先攻判定后',
  'turn.open': '回合开始时',
  'turn.close': '回合结束时',
  'action.declared': '声明行动时',
  'check.intent': '检定意图时',
  'check.hit': '命中检定时',
  collect_attacker_mods: '攻击修正收集中',
  collect_defender_mods: '防御修正收集中',
  'damage.preview': '伤害预览时',
  'damage.compute': '伤害计算时',
  'damage.after': '受击时',
  'unit.beforeDown': '单位倒地前',
  'morale.before': '士气判定前',
  'morale.after': '士气判定后',
  'settlement.before': '战斗结算前',
};

/** ModifierSlot → 中文 */
const SLOT_CN: Record<ModifierSlot, string> = {
  fixedDamage: '固伤',
  damageMult: '伤害倍率',
  damageTaken: '受伤',
  hitBonus: '命中',
  dodge: '闪避',
  initiative: '先攻',
  dr: '减伤',
  penetration: '穿透',
  critThreshold: '暴击阈值',
  critDmg: '暴击伤害',
  attribute: '属性',
};

/** DamageType → 中文（effect-types 里是中文枚举，直接透传） */
function damageTypeCN(t: string): string {
  const map: Record<string, string> = {
    physical: '物理',
    energy: '能量',
    mental: '精神',
    true: '真实',
  };
  return map[t] ?? t;
}

/** statusId → 中文（常见状态名的英文 id；未知原样透传） */
const STATUS_CN: Record<string, string> = {
  bleed: '流血',
  poison: '中毒',
  burn: '灼烧',
  stun: '眩晕',
  freeze: '冰冻',
  slow: '减速',
  weaken: '虚弱',
  shield: '护盾',
  regen: '再生',
};

/** 单个 intent → 中文 */
function describeIntent(intent: EffectIntent): string {
  switch (intent.kind) {
    case 'AddModifier': {
      const v = intent.value;
      const sign = typeof v === 'number' && v >= 0 ? '+' : '';
      return `${SLOT_CN[intent.slot] ?? intent.slot} ${sign}${v}`;
    }
    case 'DealDamage':
      return `造成 ${intent.amount} 点${damageTypeCN(intent.damageType)}伤害`;
    case 'Heal':
      return `回复 ${intent.amount} 点HP`;
    case 'ApplyStatus':
      return `附加 ${STATUS_CN[intent.statusId] ?? intent.statusId}${intent.layers && intent.layers > 1 ? ` ${intent.layers}层` : ''}`;
    case 'RemoveStatus':
      return `移除${STATUS_CN[intent.statusId] ?? intent.statusId}`;
    case 'SpendResource':
      return `消耗 ${intent.amount} 点${intent.resource.toUpperCase()}`;
    case 'PreventDeath':
      return '免死一次';
    case 'ConsumeCharge':
      return `消耗 ${intent.amount ?? 1} 次充能`;
    case 'EmitNarrativeCue':
      return `提示：${intent.text}`;
    case 'OverrideIntent':
      return `覆盖${intent.ruleKey}行动`;
    case 'ScheduleIntent':
      return `延后：${describeIntent(intent.intent)}`;
    case 'SpawnOrDespawnIntent':
      return `${intent.op === 'spawn' ? '召唤' : '移除'} ${intent.unitId}`;
    case 'RequestChoiceIntent':
      return `要求选择：${intent.prompt}`;
  }
}

/** trigger 表达式 → 条件中文（常见形态；识别不了原样保留） */
function translateTrigger(trigger: string): string {
  const t = trigger.trim();
  if (t === 'true' || t === '') return '';
  const hp = t.match(/target\.hpPercent\s*<\s*([\d.]+)/);
  if (hp) return `目标HP<${Math.round(parseFloat(hp[1]) * 100)}%`;
  const hpGt = t.match(/target\.hpPercent\s*>\s*([\d.]+)/);
  if (hpGt) return `目标HP>${Math.round(parseFloat(hpGt[1]) * 100)}%`;
  const status = t.match(/target\.hasStatus\(['"](\w+)['"]\)/);
  if (status) return `目标处于${status[1]}状态`;
  return t;
}

/** 一个 automaton → 中文行数组（每 intent 一行，行首带窗口+条件） */
export function describeAutomaton(a: EffectAutomatonDecl): string[] {
  const windowCN = WINDOW_CN[a.subscribe] ?? a.subscribe;
  const cond = translateTrigger(a.trigger);
  const prefix = cond ? `${windowCN}[${cond}]：` : `${windowCN}：`;
  const lines = a.intents.map(describeIntent).filter((s) => s.length > 0);
  return lines.map((line) => prefix + line);
}

/** 批量翻译，空数组返回空 */
export function describeAutomata(list: EffectAutomatonDecl[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap(describeAutomaton);
}
