/**
 * player-input.ts — 玩家自由文本 → v3 CombatCommand 的确定性解析（T14，设计 2026-08-09 §3.2）
 *
 * 设计 §3.2「玩家输入（决策 B：统一 AI 解析意图）」：
 *   - 四步拼装能直接定 Command 时走结构化路径（前端 CombatActionBar 直接产 Command）；
 *   - 自由文本必须过解析器转 Command（DeclareAttack / DeclareAction / PassAttack / Flee），
 *     禁止把自由文本直接当 Command 喂内核（那是「查询工具被误当 Command」的同款坑）。
 *
 * 本模块是自由文本那条路的**规则解析实现**（设计 §3.2「自由文本才过 AI/规则解析」）：
 * 确定性关键词 + 名字匹配，零 I/O、零随机、纯函数（照 combat-intention.ts 的先例）。
 * 解析不出意图时**明确拒绝**（返回 ok:false + 人话 reason），绝不静默 fallback 成
 * PassAttack —— fallback 会吞掉玩家的决定（v2 runner 时代「查询工具静默变 pass」
 * 的同款缺陷在玩家侧的镜像）。
 *
 * 意图层级复用 v2 唯一实现 parseIntentionFromInput（中文关键词 → IntentionLevel，
 * 世界书 #837805 [战斗协议] §3 对齐）；目标/技能/道具按「文本中首次出现、同位置取
 * 长名」匹配（避免「骷髅兵」误配「骷髅兵队长」这类短名前缀坑）。
 */

import type { CombatCommand } from './types';
import { parseIntentionFromInput } from '../combat-intention';

/** 解析器认识的在场单位（前端从 v3ActiveCombat 投影后传入） */
export interface PlayerParseUnit {
  /** v3 逻辑键（= 角色名，铁律 ①） */
  id: string;
  /** 展示名（匹配文本用） */
  name: string;
  side: 'player' | 'enemy';
}

/** 解析上下文：当前行动者 + 在场单位 + （可选）技能/道具名单 */
export interface PlayerParseCtx {
  /** 当前轮到我方行动的单位（v3：awaiting.unitId） */
  actorId: string;
  /** 在场单位（存活），目标匹配范围：技能/攻击都从这里找 */
  units: ReadonlyArray<PlayerParseUnit>;
  /** 我方可用技能名（主动技能），用于「施展X」识别 */
  skills?: ReadonlyArray<string>;
  /** 我方背包可用道具名（消耗品/材料），用于「使用X」识别 */
  items?: ReadonlyArray<string>;
}

/**
 * Omit over union 的坑：`Omit<Union, K>` 里 Pick 是 mapped type（非条件类型），
 * 不会按联合分发 —— 结果是一个**扁平对象**（属性类型全部变成 union），
 * kind 判别丢失。用条件类型分发（DistributiveOmit）保持判别联合。
 */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

/** 解析产物：去掉 commandId/expectedRevision 的 Command（store 的 submitCombatCommand 会自动补） */
export type PlayerCommand = DistributiveOmit<CombatCommand, 'commandId' | 'expectedRevision'>;

/** 解析结果：成功给 Command；失败给人话 reason（UI 原样提示，不清空输入） */
export type PlayerCommandResult =
  { ok: true; command: PlayerCommand } | { ok: false; reason: string };

/** 逃跑意图（整句关键词） */
const FLEE_RE = /逃跑|撤退|逃离|开溜|脱离战斗|溜走/;

/** 防御意图（整句关键词） */
const DEFEND_RE = /防御|防守|格挡|举盾|坚守|戒备|守护/;

/** 跳过本回合攻击（整句关键词；保守集合，避免误吞「等待时机」类描述） */
const PASS_RE = /跳过|待机|按兵不动|休息|放弃攻击|放弃行动|放弃抵抗/;

/** 道具使用的动词信号：光有道具名不够（「挥舞铁剑」是攻击不是用道具），必须带使用动词 */
const USE_ITEM_RE = /使用|服用|喝下|喝掉|吃下|饮用|涂抹/;

/**
 * 文本中出现位置最靠前的候选名（同位置取长名）。
 * 返回 undefined = 一个都没出现。
 */
function firstMention(text: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestPos = Infinity;
  for (const c of candidates) {
    if (!c) continue;
    const pos = text.indexOf(c);
    if (pos === -1) continue;
    if (pos < bestPos || (pos === bestPos && c.length > (best?.length ?? 0))) {
      best = c;
      bestPos = pos;
    }
  }
  return best;
}

/** 文本中首次出现的单位（先按展示名、再按逻辑键 id 匹配） */
function firstMentionUnit(
  text: string,
  units: ReadonlyArray<PlayerParseUnit>,
): PlayerParseUnit | undefined {
  const byName = firstMention(
    text,
    units.map((u) => u.name),
  );
  if (byName !== undefined) {
    return units.find((u) => u.name === byName);
  }
  const byId = firstMention(
    text,
    units.map((u) => u.id),
  );
  if (byId !== undefined) return units.find((u) => u.id === byId);
  return undefined;
}

/**
 * 自由文本 → Command 的规则解析入口。
 *
 * 规则优先级（从上到下）：
 *   逃跑 → Flee；防御 → DeclareAction(defend)；跳过 → PassAttack；
 *   道具名命中 → DeclareAction(item)；技能名命中 → DeclareAttack(skill, 目标)；
 *   敌方单位名命中 → DeclareAttack(普攻)；都识别不出 → 明确拒绝。
 * 技能/普攻的意图层级取 parseIntentionFromInput（「打晕」「要害」「全力」等关键词提升）。
 */
export function parsePlayerInput(text: string, ctx: PlayerParseCtx): PlayerCommandResult {
  const t = (text ?? '').trim();
  if (!t) return { ok: false, reason: '输入为空' };
  if (!ctx.actorId) return { ok: false, reason: '没有可行动的单位' };

  const base = { actorId: ctx.actorId } as const;

  if (FLEE_RE.test(t)) {
    return { ok: true, command: { ...base, cost: 'both', kind: 'Flee', payload: {} } };
  }

  if (DEFEND_RE.test(t)) {
    return {
      ok: true,
      command: {
        ...base,
        cost: 'action',
        kind: 'DeclareAction',
        payload: { actionType: 'defend' },
      },
    };
  }

  if (PASS_RE.test(t)) {
    return { ok: true, command: { ...base, cost: 'attack', kind: 'PassAttack', payload: {} } };
  }

  const item = ctx.items?.length ? firstMention(t, ctx.items) : undefined;
  if (item && USE_ITEM_RE.test(t)) {
    return {
      ok: true,
      command: {
        ...base,
        cost: 'action',
        kind: 'DeclareAction',
        payload: { actionType: 'item', description: item },
      },
    };
  }

  const skill = ctx.skills?.length ? firstMention(t, ctx.skills) : undefined;
  if (skill) {
    // 技能目标不限定阵营：治疗/增益可指向友方，攻击技能指向敌方
    const target = firstMentionUnit(t, ctx.units);
    if (!target) {
      return {
        ok: false,
        reason: `施展「${skill}」需要指定目标，例如「对XX施展${skill}」`,
      };
    }
    return {
      ok: true,
      command: {
        ...base,
        cost: 'attack',
        kind: 'DeclareAttack',
        payload: { targetId: target.id, skill, intentionLevel: parseIntentionFromInput(t) },
      },
    };
  }

  const target = firstMentionUnit(
    t,
    ctx.units.filter((u) => u.side === 'enemy'),
  );
  if (target) {
    return {
      ok: true,
      command: {
        ...base,
        cost: 'attack',
        kind: 'DeclareAttack',
        payload: { targetId: target.id, intentionLevel: parseIntentionFromInput(t) },
      },
    };
  }

  return {
    ok: false,
    reason: '没看懂要怎么行动；可以试试「攻击骷髅兵」「施展火焰术」「防御」「逃跑」',
  };
}
