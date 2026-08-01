/**
 * CombatItemValidator — 战斗物品产出契约校验 (M4 战斗 v2 · 任务 5.5a)
 *
 * 职责: 给定 item_gen 产出的 modifier / buff 对象（unknown 入参），返回违规原因数组。
 *  - **纯校验函数**，零运行时依赖（只 import ts type 做类型对齐，不执行任何引擎逻辑）。
 *  - 空 reasons 数组 = 合规；非空 = 违规原因列表（供调用方打回 AI 或日志告警）。
 *  - **不接入解析链路**（char-gen-agent.ts / craft-gen-chain.ts 的接入由主线后续做）。
 *
 * 对齐:
 *  - docs/reference/combat-agent-api.md §6.1（modifier 6 大类格式）/ §6.2（divinity）/ §6.3（buff 契约）/ §6.6（校验规则 6 条）
 *  - src/sillytavern/effect-types.ts（Modifier 联合 + 6 接口 + EffectCategory）
 *  - src/sillytavern/types.ts（StatusEffect / DivinityLevel / AttributeName）
 *
 * 铁律（贯穿 §6.6）:
 *  1. category 必须存在且 ∈ 6 类
 *  2. 非检定类不得直接改五维（五维只能走检定类 checkType='属性'）
 *  3. AI 生成的 buff 必须带 sourceKey（裸名仅环境 buff）
 *  4. divinity ∈ 0-8 整数
 *  5. （脚本契约结构完整，属 5.5b 范畴，本文件不覆盖）
 *  6. （不可计算概念已翻译，属 prompt 侧约束，本文件不覆盖）
 */

import type { Modifier, EffectCategory } from './effect-types';
import type { StatusEffect } from './types';

// ═══════════════════════════════════════════════════════════
// 常量（对齐 effect-types.ts 枚举 + §6.1 / §6.3 文档枚举）
// ═══════════════════════════════════════════════════════════

/** modifier 6 大类合法值（对齐 EffectCategory） */
const VALID_CATEGORIES: ReadonlySet<EffectCategory> = new Set([
  '固伤',
  '百分比',
  '资源',
  '检定',
  '附加效果',
  '特殊机制',
]);

/** 百分比类 target 合法值（§6.1） */
const VALID_PERCENT_TARGETS: ReadonlySet<string> = new Set(['damage', 'heal', 'resource']);

/** 资源类 resource 合法值（§6.1） */
const VALID_RESOURCES: ReadonlySet<string> = new Set(['hp', 'mp', 'sp']);

/** 检定类 checkType 合法值（§6.1）——🆕 '生产'（2026-08-01 制造反向链路 S2）：由物品/技能声明生产检定修正，只进制造 fixedBonus，不编译进战斗 */
const VALID_CHECK_TYPES: ReadonlySet<string> = new Set([
  '命中',
  '闪避',
  '先攻',
  '抵抗',
  '属性',
  '生产',
]);

/** 属性检定的五维合法值（AttributeName） */
const VALID_ATTRIBUTES: ReadonlySet<string> = new Set(['str', 'dex', 'con', 'int', 'spi']);

/** 特殊类 mechanism 合法值（§6.1） */
const VALID_MECHANISMS: ReadonlySet<string> = new Set([
  'DR',
  '穿透',
  '暴击倍率',
  '召唤',
  '光环',
  '规则改写',
]);

/** buff category 合法值（§6.3） */
const VALID_BUFF_CATEGORIES: ReadonlySet<string> = new Set(['增益', '减益', '特殊']);

/** buff timeUnit 合法值（§6.3） */
const VALID_TIME_UNITS: ReadonlySet<string> = new Set(['回合', '分钟', '小时']);

/** 附加效果 lifecycle 合法值（§6.1） */
const VALID_LIFECYCLES: ReadonlySet<string> = new Set(['战斗', '持续', '触发', '条件']);

/** 五维字段的中文别名（语义校验：非检定类不得直接改五维） */
const FIVE_DIM_ALIASES: ReadonlySet<string> = new Set([
  'str',
  'dex',
  'con',
  'int',
  'spi',
  '体',
  '力',
  '敏',
  '智',
  '精',
]);

// ═══════════════════════════════════════════════════════════
// 类型守卫（窄化 unknown → 可读字段）
// ═══════════════════════════════════════════════════════════

/** 是否为可读字段的对象（非 null、非数组） */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ═══════════════════════════════════════════════════════════
// 公共子校验
// ═══════════════════════════════════════════════════════════

/** divinity 合法性（§6.2）：缺失=合规（可选）；提供须是 0-8 整数 */
function checkDivinity(v: Record<string, unknown>, label: string, reasons: string[]): void {
  if (v.divinity === undefined) return;
  const d = v.divinity;
  if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 8) {
    reasons.push(`${label}：divinity 必须是 0-8 整数，当前=${JSON.stringify(d)}`);
  }
}

/**
 * 语义校验：非检定类不得直接改五维（§6.6 规则 2 / 铁律 #265160）。
 *
 * 扫描对象顶层 key + effects（若存在）的 key，命中五维别名（str/dex/con/int/spi 或 体/力/敏/智/精）
 * 且 category≠'检定' → 违规「五维只能走检定类」。
 */
function checkNoFiveDimOutsideCheck(v: Record<string, unknown>, reasons: string[]): void {
  // 顶层 key 直接命中（如 { str: 5 }）
  for (const k of Object.keys(v)) {
    if (FIVE_DIM_ALIASES.has(k)) {
      reasons.push(
        `非检定类 modifier 不得直接改五维（字段 "${k}" 命中五维别名），五维只能走检定类 checkType='属性'`,
      );
      return; // 一条违规足够，不重复堆叠
    }
  }
  // effects 子对象 key 命中（如附加效果/资源类挂带 effects）
  const eff = v.effects;
  if (isRecord(eff)) {
    for (const k of Object.keys(eff)) {
      if (FIVE_DIM_ALIASES.has(k)) {
        reasons.push(
          `非检定类 modifier 的 effects 不得含五维字段（"${k}" 命中五维别名），五维只能走检定类 checkType='属性'`,
        );
        return;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 校验入口：validateModifier
// ═══════════════════════════════════════════════════════════

/**
 * 校验单个 modifier（§6.1 / §6.6）。
 *
 * @param mod unknown 入参（item_gen 产出的 modifier 对象）
 * @returns 违规原因数组，空数组 = 合规
 */
export function validateModifier(mod: unknown): string[] {
  const reasons: string[] = [];
  if (!isRecord(mod)) {
    reasons.push(`modifier 必须是对象，当前类型=${typeof mod}`);
    return reasons;
  }

  // ── 规则 1：category 必须存在且 ∈ 6 类（§6.6 #1）
  const cat = mod.category;
  if (typeof cat !== 'string' || !VALID_CATEGORIES.has(cat as EffectCategory)) {
    reasons.push(
      `category 必须是 6 类之一（固伤/百分比/资源/检定/附加效果/特殊机制），当前=${JSON.stringify(cat)}`,
    );
    return reasons; // category 不合法后续分支无意义，直接返回
  }

  // ── source 必填（§6.1 ModifierBase）
  if (typeof mod.source !== 'string' || (mod.source as string).trim() === '') {
    reasons.push(`source 必填（声明来源物品/技能名），当前=${JSON.stringify(mod.source)}`);
  }

  // ── divinity 校验（§6.2）
  checkDivinity(mod, 'modifier', reasons);

  // ── 五维铁律（§6.6 #2，仅非检定类校验）
  if (cat !== '检定') {
    checkNoFiveDimOutsideCheck(mod, reasons);
  }

  // ── 各类别必填字段（§6.1）
  switch (cat) {
    case '固伤':
      if (typeof mod.amount !== 'number' || Number.isNaN(mod.amount)) {
        reasons.push(`固伤类：amount 必须是 number，当前=${JSON.stringify(mod.amount)}`);
      }
      break;

    case '百分比':
      if (typeof mod.coefficient !== 'number' || Number.isNaN(mod.coefficient)) {
        reasons.push(
          `百分比类：coefficient 必须是 number，当前=${JSON.stringify(mod.coefficient)}`,
        );
      }
      if (typeof mod.target !== 'string' || !VALID_PERCENT_TARGETS.has(mod.target)) {
        reasons.push(
          `百分比类：target 必须是 damage/heal/resource 之一，当前=${JSON.stringify(mod.target)}`,
        );
      }
      break;

    case '资源':
      if (typeof mod.resource !== 'string' || !VALID_RESOURCES.has(mod.resource)) {
        reasons.push(`资源类：resource 必须是 hp/mp/sp 之一，当前=${JSON.stringify(mod.resource)}`);
      }
      if (typeof mod.amount !== 'number' || Number.isNaN(mod.amount)) {
        reasons.push(`资源类：amount 必须是 number，当前=${JSON.stringify(mod.amount)}`);
      }
      break;

    case '检定':
      if (typeof mod.checkType !== 'string' || !VALID_CHECK_TYPES.has(mod.checkType)) {
        reasons.push(
          `检定类：checkType 必须是 命中/闪避/先攻/抵抗/属性/生产 之一，当前=${JSON.stringify(mod.checkType)}`,
        );
      } else if (mod.checkType === '属性') {
        // checkType='属性' 时必须有 attribute ∈ 五维（§6.1）
        if (typeof mod.attribute !== 'string' || !VALID_ATTRIBUTES.has(mod.attribute)) {
          reasons.push(
            `检定类 attribute 模式：attribute 必须是 str/dex/con/int/spi 之一，当前=${JSON.stringify(mod.attribute)}`,
          );
        }
      }
      if (typeof mod.bonus !== 'number' || Number.isNaN(mod.bonus)) {
        reasons.push(`检定类：bonus 必须是 number，当前=${JSON.stringify(mod.bonus)}`);
      }
      break;

    case '附加效果':
      if (typeof mod.buffName !== 'string' || (mod.buffName as string).trim() === '') {
        reasons.push(`附加效果类：buffName 必填，当前=${JSON.stringify(mod.buffName)}`);
      }
      if (typeof mod.sourceKey !== 'string' || (mod.sourceKey as string).trim() === '') {
        reasons.push(
          `附加效果类：sourceKey 必填（buff id 前缀），当前=${JSON.stringify(mod.sourceKey)}`,
        );
      }
      if (
        mod.lifecycle !== undefined &&
        (typeof mod.lifecycle !== 'string' || !VALID_LIFECYCLES.has(mod.lifecycle))
      ) {
        reasons.push(
          `附加效果类：lifecycle 必须是 战斗/持续/触发/条件 之一，当前=${JSON.stringify(mod.lifecycle)}`,
        );
      }
      break;

    case '特殊机制':
      if (typeof mod.mechanism !== 'string' || !VALID_MECHANISMS.has(mod.mechanism)) {
        reasons.push(
          `特殊机制类：mechanism 必须是 DR/穿透/暴击倍率/召唤/光环/规则改写 之一，当前=${JSON.stringify(mod.mechanism)}`,
        );
      }
      if (typeof mod.value !== 'number' || Number.isNaN(mod.value)) {
        reasons.push(`特殊机制类：value 必须是 number，当前=${JSON.stringify(mod.value)}`);
      }
      break;
  }

  return reasons;
}

// ═══════════════════════════════════════════════════════════
// 校验入口：validateBuff
// ═══════════════════════════════════════════════════════════

/**
 * 校验单个 buff（§6.3 / §6.6）。
 *
 * @param buff unknown 入参（item_gen 产出的 StatusEffect 对象）
 * @returns 违规原因数组，空数组 = 合规
 */
export function validateBuff(buff: unknown): string[] {
  const reasons: string[] = [];
  if (!isRecord(buff)) {
    reasons.push(`buff 必须是对象，当前类型=${typeof buff}`);
    return reasons;
  }

  // ── 必填字段完整性（§6.3 6+ 字段）
  if (typeof buff.name !== 'string' || (buff.name as string).trim() === '') {
    reasons.push(`name 必填（简练标识符），当前=${JSON.stringify(buff.name)}`);
  }
  if (typeof buff.description !== 'string' || (buff.description as string).trim() === '') {
    reasons.push(`description 必填（中文描述），当前=${JSON.stringify(buff.description)}`);
  }
  if (typeof buff.category !== 'string' || !VALID_BUFF_CATEGORIES.has(buff.category)) {
    reasons.push(`category 必须是 增益/减益/特殊 之一，当前=${JSON.stringify(buff.category)}`);
  }
  if (typeof buff.stacks !== 'number' || Number.isNaN(buff.stacks)) {
    reasons.push(`stacks 必须是 number，当前=${JSON.stringify(buff.stacks)}`);
  }
  // remainingTime: number | null（null=永久）；允许 0（已到期边界）
  if (
    buff.remainingTime !== null &&
    (typeof buff.remainingTime !== 'number' || Number.isNaN(buff.remainingTime))
  ) {
    reasons.push(
      `remainingTime 必须是 number 或 null（永久），当前=${JSON.stringify(buff.remainingTime)}`,
    );
  }
  if (typeof buff.timeUnit !== 'string' || !VALID_TIME_UNITS.has(buff.timeUnit)) {
    reasons.push(`timeUnit 必须是 回合/分钟/小时 之一，当前=${JSON.stringify(buff.timeUnit)}`);
  }
  if (typeof buff.source !== 'string' || (buff.source as string).trim() === '') {
    reasons.push(
      `source 必填（"[分类]-[施加者];[解除方式]"），当前=${JSON.stringify(buff.source)}`,
    );
  }
  // effects 必填且是对象（数值化效果，允许空对象 {}）
  if (!isRecord(buff.effects)) {
    reasons.push(
      `effects 必填且为对象（数值化效果 {defense:0.5,...}），当前=${JSON.stringify(buff.effects)}`,
    );
  }

  // ── sourceKey 必填（§6.6 #3：AI 生成的 buff 必须带 sourceKey，裸名仅环境 buff）
  if (typeof buff.sourceKey !== 'string' || (buff.sourceKey as string).trim() === '') {
    reasons.push(
      `sourceKey 必填（AI 生成的 buff 必须带物品/技能前缀，裸名仅代码预置环境 buff 才允许）`,
    );
  }

  // ── divinity 校验（§6.2）
  checkDivinity(buff, 'buff', reasons);

  return reasons;
}

// ═══════════════════════════════════════════════════════════
// 校验入口：validateItemOutput（汇总一个物品产出）
// ═══════════════════════════════════════════════════════════

/** 物品产出汇总校验结果 */
export interface ItemOutputValidationResult {
  /** 每个 modifier 的违规原因列表（与入参 modifiers 顺序对齐） */
  modifierErrors: string[][];
  /** 每个 buff 的违规原因列表（与入参 buffs 顺序对齐） */
  buffErrors: string[][];
  /** 全部合规 = true（modifierErrors 和 buffErrors 都为空数组） */
  valid: boolean;
}

/**
 * 汇总校验一个物品产出的全部 modifier + buff（§6.6）。
 *
 * @param output 物品产出对象，含可选 modifiers[] / buffs[]
 * @returns 每条 modifier/buff 的违规原因二维数组 + 总 valid 标记
 */
export function validateItemOutput(output: {
  modifiers?: unknown[];
  buffs?: unknown[];
}): ItemOutputValidationResult {
  const modifierErrors = (output.modifiers ?? []).map((m) => validateModifier(m));
  const buffErrors = (output.buffs ?? []).map((b) => validateBuff(b));
  const valid =
    modifierErrors.every((r) => r.length === 0) && buffErrors.every((r) => r.length === 0);
  return { modifierErrors, buffErrors, valid };
}

// ═══════════════════════════════════════════════════════════
// v3 编译期校验（M3 战斗 v3，供 automata/compile.ts 调用）
// ═══════════════════════════════════════════════════════════
// 保留 v2 运行时入口（validateModifier / validateBuff / validateItemOutput）不删。
// 这里是战斗 v3 的 EffectAutomaton DSL 编译期共享校验（架构 §七 7.4 / plan §5.5）。

/** 18 个 ReactionWindow 清单（架构 §五 5.1） */
export const V3_WINDOW_KEYS: ReadonlySet<string> = new Set([
  'round.open',
  'round.close',
  'initiative.before',
  'initiative.after',
  'turn.open',
  'turn.close',
  'action.declared',
  'check.intent',
  'check.hit',
  'collect_attacker_mods',
  'collect_defender_mods',
  'damage.preview',
  'damage.compute',
  'damage.after',
  'unit.beforeDown',
  'morale.before',
  'morale.after',
  'settlement.before',
]);

/** 8 大类 EffectIntent kind + Outcome 子类（架构 §六 6.1） */
export const V3_INTENT_KINDS: ReadonlySet<string> = new Set([
  'AddModifier',
  'DealDamage',
  'Heal',
  'ApplyStatus',
  'RemoveStatus',
  'SpendResource',
  'PreventDeath',
  'ConsumeCharge',
  'EmitNarrativeCue',
  'OverrideIntent',
  'ScheduleIntent',
  'SpawnOrDespawnIntent',
  'RequestChoiceIntent',
]);

/** closed RuleKey 白名单（架构 §八 8.2） */
export const V3_RULE_KEYS: ReadonlySet<string> = new Set([
  'morale.forceState',
  'terminal.forceTerminal',
  'action.freezeSlot',
  'death.threshold',
]);

/** 校验 subscribe 是否为合法窗口（返回中文违规原因或 null） */
export function validateV3Window(subscribe: unknown): string | null {
  if (typeof subscribe !== 'string' || !V3_WINDOW_KEYS.has(subscribe)) {
    return `subscribe 必须是 18 窗口之一，当前=${JSON.stringify(subscribe)}（架构 §五 5.1）`;
  }
  return null;
}

/** 校验 intent kind 是否 ∈ 8 大类（返回中文违规原因或 null） */
export function validateV3IntentKind(kind: unknown): string | null {
  if (typeof kind !== 'string' || !V3_INTENT_KINDS.has(kind)) {
    return `intents[].kind 必须是 8 大类之一，当前=${JSON.stringify(kind)}（架构 §六 6.1）`;
  }
  return null;
}

/** 校验 OverrideIntent.ruleKey ∈ closed 白名单（返回中文违规原因或 null，合法则 null） */
export function validateV3RuleKey(ruleKey: unknown): string | null {
  if (typeof ruleKey !== 'string' || !V3_RULE_KEYS.has(ruleKey)) {
    return `OverrideIntent.ruleKey 必须在 closed RuleKey 白名单内，当前=${JSON.stringify(ruleKey)}（架构 §八 8.2）`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// 类型再导出（仅类型，零运行时依赖）—— 方便调用方一处 import
// ═══════════════════════════════════════════════════════════

export type { Modifier, StatusEffect };
