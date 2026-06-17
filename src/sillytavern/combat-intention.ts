/**
 * 战斗意图解析引擎 — Layer 3 流程级 (AI 不可见)
 *
 * 职责: 根据用户输入中的关键词判定意图层级，执行层级对抗检定。
 * 对齐世界书 #837805 [战斗协议] 第三阶段 §3「意图与压制解析」。
 *
 * 6 级意图: 非致死 / 常规 / 战术 / 机能 / 核心 / 抹杀 / 概念 / 处决
 *
 * 判定规则:
 *   - 非致死/常规: 无需对抗检定
 *   - 战术/机能/核心/抹杀/概念: 对抗检定 (攻方T×5+d20) vs (守方T×5+d20+意图难度)
 *   - 层级压制: 若 攻方T < 守方T-1 → 强制无效
 *   - 失能目标: 自动成功
 *   - 处决目标: 战意动摇/崩溃 + 处决意图 → 自动成功
 *   - 非致死: HP≤0 时评级≤有效→HP锁定1+昏迷; 暴击+→失手致死
 */

import type { IntentionLevel, IntentionResult, IntentionConfig } from './types';
import { INTENTION_CONFIGS } from './types';

// ========== 意图关键词解析 ==========

/** 意图关键词映射表 — 中文输入 → IntentionLevel */
const KEYWORD_INTENTION_MAP: Array<{ keywords: string[]; level: IntentionLevel }> = [
  { keywords: ['打晕', '活捉', '不要杀死', '留活口', '制服'], level: '非致死' },
  { keywords: ['斩首', '断头', '枭首'], level: '抹杀' },
  { keywords: ['湮灭', '吞噬灵魂', '抹除存在', '概念抹消'], level: '概念' },
  { keywords: ['粉碎心脏', '贯穿要害', '致命一击', '必杀', '处决'], level: '抹杀' },
  { keywords: ['魔力回路', '权能节点', '法则具象', '神位', '灵魂攻击'], level: '核心' },
  { keywords: ['眼', '喉', '关节', '弱点', '要害', '瞄准'], level: '战术' },
  { keywords: ['全力攻击', '奋力一击', '最后一击', '全力'], level: '常规' },
];

/**
 * 从用户输入关键词解析意图层级。
 * 模糊描述 ("最后一击"/"全力攻击"/"砍向敌人") → 常规。
 * 仅当包含明确部位/超凡概念/抹杀描述时才提升意图。
 */
export function parseIntentionFromInput(userInput: string): IntentionLevel {
  if (!userInput || userInput.trim().length === 0) return '常规';

  const input = userInput.toLowerCase();

  for (const entry of KEYWORD_INTENTION_MAP) {
    for (const kw of entry.keywords) {
      if (input.includes(kw.toLowerCase())) {
        return entry.level;
      }
    }
  }

  return '常规';
}

// ========== 意图配置查询 ==========

/** 获取意图配置 */
export function getIntentionConfig(level: IntentionLevel): IntentionConfig {
  const config = INTENTION_CONFIGS[level];
  if (!config) return INTENTION_CONFIGS['常规'];
  return config;
}

// ========== 意图判定核心 ==========

export interface IntentionCheckInput {
  /** 解析出的意图层级 */
  intentionLevel: IntentionLevel;
  /** 攻方生命层级 (1-7) */
  attackerTier: number;
  /** 守方生命层级 (1-7) */
  defenderTier: number;
  /** 守方是否失能（无法行动/闪避） */
  defenderIncapacitated: boolean;
  /** 守方战意状态 (Phase 6c) */
  defenderMorale?: 'steady' | 'shaken' | 'wavering' | 'routing';
  /** 攻方是否意图处决（仅当战意动摇时自动成功） */
  isExecutionIntent: boolean;
  /** 是否非致死声明 */
  nonLethal: boolean;
  /** d20 骰值（外部提供，支持骰池） */
  attackerD20: number;
  defenderD20: number;
}

/**
 * 执行完整的意图判定。
 *
 * 判定顺序 (对齐世界书):
 * 1. 非致死/常规 → 无需判定
 * 2. 层级压制 (攻方T < 守方T-1) → 强制无效
 * 3. 失能目标 → 自动成功
 * 4. 处决目标 (战意动摇/崩溃 + 处决意图) → 自动成功
 * 5. 对抗检定
 */
export function resolveIntention(input: IntentionCheckInput): IntentionResult {
  const config = getIntentionConfig(input.intentionLevel);
  const { attackerTier, defenderTier } = input;

  // 非致死/常规 → 无需判定
  if (config.requiresContest === false && input.intentionLevel !== '处决') {
    return {
      level: input.intentionLevel,
      verdict: '无需判定',
      coefficient: config.coefficient,
      extraEffects: [],
      narrativeNote:
        input.intentionLevel === '非致死'
          ? '非致死攻击，HP≤0时锁定为1并施加昏迷'
          : '常规攻击，直接进入攻击检定',
    };
  }

  // 层级压制: 攻方T < 守方T-1 → 强制无效
  if (attackerTier < defenderTier - 1) {
    return {
      level: input.intentionLevel,
      verdict: '强制无效',
      coefficient: 1.0,
      extraEffects: [],
      narrativeNote: `攻方层级(T${attackerTier})低于守方层级(T${defenderTier})超过1级 → 层级压制，意图强制无效`,
    };
  }

  // 失能目标 → 自动成功
  if (input.defenderIncapacitated) {
    return {
      level: input.intentionLevel,
      verdict: '自动成功',
      coefficient: config.coefficient,
      extraEffects: config.triggersExtraEffects ? [`${input.intentionLevel}意图额外效果`] : [],
      narrativeNote: '目标处于失能状态(禁锢/眩晕/昏迷)，意图判定自动成功',
    };
  }

  // 处决目标 → 自动成功 (战意动摇/崩溃 + 处决意图)
  if (
    input.isExecutionIntent &&
    input.defenderMorale &&
    (input.defenderMorale === 'shaken' || input.defenderMorale === 'wavering' || input.defenderMorale === 'routing')
  ) {
    return {
      level: '处决',
      verdict: '自动成功',
      coefficient: INTENTION_CONFIGS['处决'].coefficient, // 2.0
      extraEffects: ['闪避修正无效', '评级保底为暴击(1.3)'],
      narrativeNote: '目标战意动摇/崩溃 + 攻方意图处决 → 自动成功，闪避无效，评级保底为暴击',
    };
  }

  // 对抗检定: (攻方T×5 + d20) vs (守方T×5 + d20 + 意图难度)
  const attackerValue = attackerTier * 5 + input.attackerD20;
  const defenderValue = defenderTier * 5 + input.defenderD20 + config.difficulty;

  const success = attackerValue >= defenderValue;

  return {
    level: input.intentionLevel,
    verdict: success ? '成功' : '失败',
    contested: {
      attackerFormula: `(T${attackerTier}×5 + d20[${input.attackerD20}])`,
      attackerValue,
      defenderFormula: `(T${defenderTier}×5 + d20[${input.defenderD20}] + 意图难度[${config.difficulty}])`,
      defenderValue,
    },
    coefficient: success ? config.coefficient : 1.0,
    extraEffects: success && config.triggersExtraEffects ? [`${input.intentionLevel}意图额外效果`] : [],
    narrativeNote: success
      ? `${input.intentionLevel}意图判定成功 (${attackerValue} ≥ ${defenderValue})`
      : `${input.intentionLevel}意图判定失败 (${attackerValue} < ${defenderValue})，系数重置为1.0，无额外状态`,
  };
}

// ========== 非致死判定 ==========

export interface NonLethalCheckInput {
  /** 是否为非致死攻击 */
  nonLethal: boolean;
  /** 命中评级系数 */
  ratingCoefficient: number;
  /** 计算后的最终伤害 */
  finalDamage: number;
  /** 目标当前 HP */
  currentHp: number;
}

export interface NonLethalCheckResult {
  /** 是否应用非致死规则 */
  applied: boolean;
  /** 修正后的 HP (非致死时锁定为1) */
  adjustedHp: number;
  /** 是否昏迷 (非致死 + HP本应≤0) */
  unconscious: boolean;
  /** 是否失手致死 (非致死 + 暴击1.3+ + HP≤0) */
  accidentalKill: boolean;
  narrative: string;
}

/**
 * 非致死判定 — 仅当用户明确声明时生效。
 * 规则 (对齐世界书):
 *   - 评级 ≤ 有效(1.0) → HP锁定为1并施加[昏迷]
 *   - 评级 ≥ 暴击(1.3) → 失手致死 (无法非致死)
 */
export function checkNonLethal(input: NonLethalCheckInput): NonLethalCheckResult {
  if (!input.nonLethal) {
    return {
      applied: false,
      adjustedHp: Math.max(0, input.currentHp - input.finalDamage),
      unconscious: false,
      accidentalKill: false,
      narrative: '',
    };
  }

  const wouldBeZero = input.currentHp - input.finalDamage <= 0;

  if (!wouldBeZero) {
    // 伤害不足以致死，正常结算
    return {
      applied: false,
      adjustedHp: input.currentHp - input.finalDamage,
      unconscious: false,
      accidentalKill: false,
      narrative: '非致死攻击，但伤害不足以致死，正常结算',
    };
  }

  // 伤害本应致死
  if (input.ratingCoefficient >= 1.3) {
    // 暴击及以上 → 失手致死
    return {
      applied: true,
      adjustedHp: 0,
      unconscious: false,
      accidentalKill: true,
      narrative: `非致死攻击但评级系数≥暴击(${input.ratingCoefficient}) → 失手致死！`,
    };
  }

  // 有效(1.0)、勉强(0.8)、擦伤(0.3) → HP锁定为1 + 昏迷
  return {
    applied: true,
    adjustedHp: 1,
    unconscious: true,
    accidentalKill: false,
    narrative: `非致死攻击，评级系数≤有效(${input.ratingCoefficient}) → HP锁定为1并施加[昏迷]`,
  };
}

// ========== 集群意图限制 ==========

/** 集群单位无法触发意图/部位攻击 (世界书 §5 集群修正) */
export function isClusterIntentionBlocked(isClusterTarget: boolean): boolean {
  return isClusterTarget;
}
