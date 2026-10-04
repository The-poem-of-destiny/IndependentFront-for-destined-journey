/**
 * 战斗沙盒工具面（Phase 2 战斗重写）
 *
 * 单一 DM Agent 用这些工具维护权威 `CombatState`，并用 Code 侧纯函数做随机与计算。
 *
 * 🔴 失败一律 throw（承 agent-tools Q-14 口径）：agent-client 的既有 catch 会把异常
 *    包成 `{"error": message}` 的 tool 消息回喂模型；工具层不再自造第二种失败形状。
 * 🔴 骰值一律由 Code 掷（roll_* 工具），AI 禁止自带骰值 —— 与 v3「内核禁 Math.random，
 *    随机源在内核外」同一条口径。
 */

import type {
  CharacterState,
  CombatParticipant,
  DamageType,
  ToolDefinition,
  ToolResult,
} from '../../types/types';
import { d100, d20, roll, rollDie } from '../../utils/dice';
import { runDamagePipeline } from '../combat-damage';
import { rollInitiative } from '../combat-turn';
import {
  addCombatUnit,
  addStatusEffect,
  applyOps,
  removeCombatUnit,
  removeStatusEffect,
  setCombatMeta,
} from './state';
import type {
  CombatSide,
  CombatState,
  CombatStatusEffect,
  CombatUnit,
  CombatUnitOp,
} from './types';

const DAMAGE_TYPES: DamageType[] = ['物理', '能量', '精神', '真实'];

// ═══════════════════════════════════════════════════════════
// 安全算术求值（只认数字 / 四则 / 括号）
// ═══════════════════════════════════════════════════════════

type ArithToken = number | '+' | '-' | '*' | '/' | '(' | ')';

function tokenizeArithmetic(expression: string): ArithToken[] {
  const tokens: ArithToken[] = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
      tokens.push(ch);
      i += 1;
      continue;
    }
    const match = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(expression.slice(i));
    if (!match) {
      throw new Error(`calc 只接受数字与 + - * / ( )，无法解析: "${ch}"`);
    }
    tokens.push(Number(match[0]));
    i += match[0].length;
  }
  return tokens;
}

/**
 * 安全纯算术表达式求值：只认十进制数字、`+ - * /`、括号与一元正负号。
 * 不 eval、不认变量/函数/标识符，除零与非有限结果直接 throw。
 */
export function evaluateArithmetic(expression: string): number {
  const tokens = tokenizeArithmetic(expression);
  if (tokens.length === 0) throw new Error('calc 表达式为空');
  let pos = 0;
  const peek = (): ArithToken | undefined => tokens[pos];
  const next = (): ArithToken | undefined => tokens[pos++];

  function parseFactor(): number {
    const tok = peek();
    if (tok === '-') {
      next();
      return -parseFactor();
    }
    if (tok === '+') {
      next();
      return parseFactor();
    }
    if (tok === '(') {
      next();
      const value = parseExpression();
      if (next() !== ')') throw new Error('calc 括号不匹配');
      return value;
    }
    if (typeof tok === 'number') {
      next();
      return tok;
    }
    throw new Error(`calc 无法解析的片段: ${String(tok)}`);
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const rhs = parseFactor();
      if (op === '*') value *= rhs;
      else {
        if (rhs === 0) throw new Error('calc 除以零');
        value /= rhs;
      }
    }
    return value;
  }

  function parseExpression(): number {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error(`calc 表达式含多余内容: ${expression}`);
  if (!Number.isFinite(result)) throw new Error('calc 结果非有限数');
  return result;
}

// ═══════════════════════════════════════════════════════════
// 工具定义（OpenAI function schema）
// ═══════════════════════════════════════════════════════════

export const COMBAT_SANDBOX_TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── 状态维护 ──
  {
    type: 'function',
    function: {
      name: 'combat_add_unit',
      description:
        '向战斗加入一个单位（召唤物/援军/临时对手）。从存档角色参战时由 Code 开局建好，中途新增走这里。名字即键，重名覆盖。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '单位名' },
          side: { type: 'string', enum: ['ally', 'enemy'], description: '阵营' },
          tier: { type: 'integer', description: '生命层级 1-7' },
          level: { type: 'integer', description: '等级' },
          race: { type: 'string', description: '种族' },
          hp: { type: 'integer', description: '当前 HP（缺省=上限）' },
          maxHp: { type: 'integer', description: 'HP 上限（缺省按 tier 推演）' },
          mp: { type: 'integer' },
          maxMp: { type: 'integer' },
          sp: { type: 'integer' },
          maxSp: { type: 'integer' },
          attributes: {
            type: 'object',
            properties: {
              str: { type: 'integer' },
              dex: { type: 'integer' },
              con: { type: 'integer' },
              int: { type: 'integer' },
              spi: { type: 'integer' },
            },
          },
          pos: { type: 'number', description: '战场坐标/排位' },
          morale: { type: 'string', description: '战意：steady/shaken/wavering/routing' },
        },
        required: ['name', 'side'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'combat_update_unit',
      description:
        '修改单位字段（批量操作）。field 可用顶层字段（hp/maxHp/mp/maxMp/sp/maxSp/pos/facing/slots.attack/slots.action/alive/canAct/morale/attributes.str 等）或 extras.<键>（战斗局部标量）。op=set/inc/dec/remove。违规（负数/超上限）会被记日志但照写。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '单位名' },
          ops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['set', 'inc', 'dec', 'remove'] },
                field: { type: 'string' },
                value: {},
              },
              required: ['op', 'field'],
            },
          },
        },
        required: ['name', 'ops'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'combat_remove_unit',
      description: '移除单位（退场/彻底移除）。同时从行动轴摘除。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '单位名' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'combat_add_status',
      description:
        '给单位挂/刷新一个状态效果（同名覆盖）。tempSource 标 蓄力/定位/临时 表示战斗临时效果（终局丢弃）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '单位名' },
          status: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '状态名' },
              description: { type: 'string' },
              category: { type: 'string', enum: ['增益', '减益', '特殊'] },
              stacks: { type: 'integer' },
              remainingTime: { type: ['integer', 'null'] },
              timeUnit: { type: 'string', enum: ['回合', '分钟', '小时'] },
              source: { type: 'string' },
              tempSource: { type: 'string', enum: ['蓄力', '定位', '临时'] },
              effects: { type: 'object' },
            },
            required: ['name'],
          },
        },
        required: ['name', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'combat_remove_status',
      description: '移除单位身上的某个状态效果。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '单位名' },
          statusName: { type: 'string', description: '状态名' },
        },
        required: ['name', 'statusName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'combat_set_meta',
      description:
        '合并写战斗元信息（round/combatType/environment/coordinateRange/actionOrder/phase/regions/outcome/notes 等）。终局时把 phase 置为 "ended" 并写 outcome；有 FP 获得规则时写 fpReward。',
      parameters: {
        type: 'object',
        properties: { patch: { type: 'object', description: '要合并的元信息字段' } },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'combat_write_summary',
      description:
        '🔴 终局时调用一次：用**一段自然语言**复述这整场战斗（谁和谁交手、过程与结果、我方现在的状况），供主叙事 AI 接着往下写。像讲故事一样，**不要罗列数值或面板**。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '整场战斗的自然语言简述（一段话）' },
        },
        required: ['summary'],
      },
    },
  },
  // ── 只读查询 ──
  {
    type: 'function',
    function: {
      name: 'get_character',
      description:
        '只读查询某个参战/存档角色的层级、等级、种族、五维、资源、技能、装备与状态效果。name 用单位名。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '角色/单位名' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_inventory',
      description: '只读查询某个存档角色的背包物品清单。name 用角色名。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '角色名' } },
        required: ['name'],
      },
    },
  },

  // ── 骰子（Code 掷）──
  {
    type: 'function',
    function: {
      name: 'roll_d20',
      description: '掷 d20（Code 真实随机）。禁止自己编骰值。支持加值/优势/劣势。',
      parameters: {
        type: 'object',
        properties: {
          modifier: { type: 'integer' },
          advantage: { type: 'boolean' },
          disadvantage: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_d100',
      description: '掷 d100（Code 真实随机）。',
      parameters: {
        type: 'object',
        properties: { modifier: { type: 'integer' }, reason: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_dice',
      description: '掷任意骰式，如 2d6 / 3d8+2 / 4d6（Code 真实随机）。',
      parameters: {
        type: 'object',
        properties: {
          formula: { type: 'string' },
          modifier: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['formula'],
      },
    },
  },

  // ── 计算 ──
  {
    type: 'function',
    function: {
      name: 'calc',
      description: '安全纯算术求值：只认数字与 + - * / ( )。用于协议公式的确定性计算。',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc_damage',
      description:
        '跑完整 8 步伤害管线（Code 纯函数），返回逐步分解与最终伤害。参数对应世界书伤害公式，缺省按 0/1 兜底。',
      parameters: {
        type: 'object',
        properties: {
          relevantAttribute: { type: 'integer', description: '关联属性值' },
          attackerTier: { type: 'integer' },
          skillPower: { type: 'integer' },
          weaponAtk: { type: 'integer' },
          multiHitCount: { type: 'integer' },
          defenderDefense: { type: 'integer' },
          penetrationRate: { type: 'number', description: '穿透率 0~1' },
          damageType: { type: 'string', enum: ['物理', '能量', '精神', '真实'] },
          defenderAttributes: {
            type: 'object',
            properties: {
              str: { type: 'integer' },
              dex: { type: 'integer' },
              con: { type: 'integer' },
              int: { type: 'integer' },
              spi: { type: 'integer' },
            },
          },
          ratingCoefficient: { type: 'number' },
          intentionCoefficient: { type: 'number' },
          drRate: { type: 'number' },
          isClusterTarget: { type: 'boolean' },
          fixedDamageBonus: { type: 'integer' },
        },
        required: ['relevantAttribute', 'attackerTier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc_initiative',
      description: '按协议先攻公式（敏捷 + d20 + 修正）计算行动顺序值。不传 d20 时由 Code 掷。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          dex: { type: 'integer', description: '敏捷' },
          tier: { type: 'integer' },
          level: { type: 'integer' },
          speedModifiers: { type: 'array', items: { type: 'number' } },
          fixedInitiativeBonus: { type: 'number' },
          canAct: { type: 'boolean' },
          d20: { type: 'integer', description: '指定骰值（不传=Code 掷）' },
        },
        required: ['dex'],
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════
// 参数解析
// ═══════════════════════════════════════════════════════════

function statusFromArgs(raw: unknown): CombatStatusEffect {
  if (!raw || typeof raw !== 'object') throw new Error('combat_add_status: status 必须是对象');
  const r = raw as Record<string, unknown>;
  if (!r.name) throw new Error('combat_add_status: status.name 必填');
  const out: CombatStatusEffect = { name: String(r.name) };
  if (r.description !== undefined) out.description = String(r.description);
  if (r.category !== undefined) out.category = r.category as CombatStatusEffect['category'];
  if (r.stacks !== undefined) out.stacks = Number(r.stacks);
  if (r.remainingTime !== undefined) {
    out.remainingTime = r.remainingTime === null ? null : Number(r.remainingTime);
  }
  if (r.timeUnit !== undefined) out.timeUnit = r.timeUnit as CombatStatusEffect['timeUnit'];
  if (r.source !== undefined) out.source = String(r.source);
  if (r.tempSource !== undefined) out.tempSource = r.tempSource as CombatStatusEffect['tempSource'];
  if (r.effects !== undefined) out.effects = r.effects as Record<string, number>;
  return out;
}

function unitFromAddArgs(args: Record<string, any>): {
  name: string;
  side: CombatSide;
  tier?: number;
  level?: number;
  race?: string;
  hp?: number;
  maxHp?: number;
  mp?: number;
  maxMp?: number;
  sp?: number;
  maxSp?: number;
  attributes?: Partial<CombatUnit['attributes']>;
  pos?: number;
  morale?: CombatUnit['morale'];
} {
  if (!args.name) throw new Error('combat_add_unit: 缺少 name');
  if (args.side !== 'ally' && args.side !== 'enemy') {
    throw new Error(`combat_add_unit: side 必须是 ally/enemy，收到 "${String(args.side)}"`);
  }
  return {
    name: String(args.name),
    side: args.side,
    tier: args.tier !== undefined ? Number(args.tier) : undefined,
    level: args.level !== undefined ? Number(args.level) : undefined,
    race: args.race !== undefined ? String(args.race) : undefined,
    hp: args.hp !== undefined ? Number(args.hp) : undefined,
    maxHp: args.maxHp !== undefined ? Number(args.maxHp) : undefined,
    mp: args.mp !== undefined ? Number(args.mp) : undefined,
    maxMp: args.maxMp !== undefined ? Number(args.maxMp) : undefined,
    sp: args.sp !== undefined ? Number(args.sp) : undefined,
    maxSp: args.maxSp !== undefined ? Number(args.maxSp) : undefined,
    attributes: args.attributes,
    pos: args.pos !== undefined ? Number(args.pos) : undefined,
    morale: args.morale,
  };
}

function requireUnit(state: CombatState, name: unknown): string {
  if (!name) throw new Error('缺少单位名 name');
  const key = String(name);
  if (!state.units[key]) throw new Error(`单位不存在: ${key}`);
  return key;
}

function calcDamageArgs(args: Record<string, any>): ToolResult {
  const damageType = (args.damageType ?? '物理') as DamageType;
  if (!DAMAGE_TYPES.includes(damageType)) {
    throw new Error(`calc_damage: 未知伤害类型 "${String(args.damageType)}"`);
  }
  const breakdown = runDamagePipeline({
    relevantAttribute: Number(args.relevantAttribute ?? 0),
    attackerTier: Number(args.attackerTier ?? 1),
    skillPower: Number(args.skillPower ?? 0),
    weaponAtk: Number(args.weaponAtk ?? 0),
    multiHitCount: Number(args.multiHitCount ?? 1),
    defenderDefense: Number(args.defenderDefense ?? 0),
    penetrationRate: Number(args.penetrationRate ?? 0),
    damageType,
    defenderAttributes: {
      str: Number(args.defenderAttributes?.str ?? 0),
      dex: Number(args.defenderAttributes?.dex ?? 0),
      con: Number(args.defenderAttributes?.con ?? 0),
      int: Number(args.defenderAttributes?.int ?? 0),
      spi: Number(args.defenderAttributes?.spi ?? 0),
    },
    ratingCoefficient: Number(args.ratingCoefficient ?? 1),
    intentionCoefficient: Number(args.intentionCoefficient ?? 1),
    drRate: Number(args.drRate ?? 0),
    isClusterTarget: Boolean(args.isClusterTarget),
    currentHp: Number(args.currentHp ?? 0),
    fixedDamageBonus: Number(args.fixedDamageBonus ?? 0),
  });
  return { ...breakdown } as ToolResult;
}

function calcInitiativeArgs(args: Record<string, any>): ToolResult {
  const participant: CombatParticipant = {
    characterId: args.name ? String(args.name) : '',
    name: args.name ? String(args.name) : '',
    tier: Number(args.tier ?? 1),
    level: Number(args.level ?? 1),
    attributes: { str: 0, dex: Number(args.dex ?? 0), con: 0, int: 0, spi: 0 },
    hp: 0,
    maxHp: 0,
    mp: 0,
    maxMp: 0,
    sp: 0,
    maxSp: 0,
    defense: 0,
    dr: 0,
    penetration: 0,
    hitBonus: 0,
    dodgeBonus: 0,
    speedModifiers: Array.isArray(args.speedModifiers) ? args.speedModifiers.map(Number) : [],
    fixedInitiativeBonus: Number(args.fixedInitiativeBonus ?? 0),
    attacksRemaining: 0,
    actionsRemaining: 0,
    statusEffects: [],
    weaponAtk: 0,
    side: 'ally',
    canAct: args.canAct !== false,
  };
  const d20Roll = args.d20 !== undefined ? Number(args.d20) : rollDie(20);
  return { ...rollInitiative(participant, d20Roll) } as ToolResult;
}

// ═══════════════════════════════════════════════════════════
// 执行器（绑定到一个 CombatState 实例，就地更新）
// ═══════════════════════════════════════════════════════════

/**
 * 执行单个战斗沙盒工具。**就地更新 `state`**（units/meta 引用会被替换）。
 * `characters` 供 `get_character` / `get_inventory` 只读查询（缺省时退回在办单位面）。
 */
export async function executeCombatTool(
  functionName: string,
  args: Record<string, any>,
  state: CombatState,
  characters?: ReadonlyArray<CharacterState>,
): Promise<ToolResult> {
  switch (functionName) {
    case 'combat_add_unit': {
      const input = unitFromAddArgs(args);
      const next = addCombatUnit(state, input);
      Object.assign(state, next);
      return { ok: true, unit: state.units[input.name] as unknown as Record<string, unknown> };
    }
    case 'combat_update_unit': {
      const key = requireUnit(state, args.name);
      const ops: CombatUnitOp[] = Array.isArray(args.ops) ? args.ops : [];
      const next = applyOps(state, key, ops);
      Object.assign(state, next);
      return { ok: true, unit: state.units[key] as unknown as Record<string, unknown> };
    }
    case 'combat_remove_unit': {
      const key = requireUnit(state, args.name);
      Object.assign(state, removeCombatUnit(state, key));
      return { ok: true, removed: key };
    }
    case 'combat_add_status': {
      const key = requireUnit(state, args.name);
      const status = statusFromArgs(args.status);
      Object.assign(state, addStatusEffect(state, key, status));
      return { ok: true, unit: key, status: status.name };
    }
    case 'combat_remove_status': {
      const key = requireUnit(state, args.name);
      if (!args.statusName) throw new Error('combat_remove_status: 缺少 statusName');
      Object.assign(state, removeStatusEffect(state, key, String(args.statusName)));
      return { ok: true, unit: key, removed: String(args.statusName) };
    }
    case 'combat_set_meta': {
      if (!args.patch || typeof args.patch !== 'object') {
        throw new Error('combat_set_meta: patch 必须是对象');
      }
      Object.assign(state, setCombatMeta(state, args.patch));
      return { ok: true, meta: state.meta as unknown as Record<string, unknown> };
    }
    case 'combat_write_summary': {
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (!summary) throw new Error('combat_write_summary: 缺少 summary');
      Object.assign(state, setCombatMeta(state, { summary }));
      return { ok: true };
    }
    case 'roll_d20': {
      const result = d20(args.modifier ?? 0, args.advantage, args.disadvantage);
      return args.reason ? { ...result, reason: args.reason } : { ...result };
    }
    case 'roll_d100': {
      const result = d100(args.modifier ?? 0);
      return args.reason ? { ...result, reason: args.reason } : { ...result };
    }
    case 'roll_dice': {
      if (!args.formula) throw new Error('roll_dice: 缺少 formula');
      const result = roll(String(args.formula), args.modifier ?? 0);
      return args.reason ? { ...result, reason: args.reason } : { ...result };
    }

    case 'calc': {
      if (!args.expression) throw new Error('calc: 缺少 expression');
      return { value: evaluateArithmetic(String(args.expression)) };
    }
    case 'calc_damage':
      return calcDamageArgs(args);
    case 'calc_initiative':
      return calcInitiativeArgs(args);

    case 'get_character': {
      if (!args.name) throw new Error('get_character: 缺少 name');
      const key = String(args.name);
      const unit = state.units[key];
      if (unit) {
        return {
          name: unit.name,
          tier: unit.tier,
          level: unit.level,
          race: unit.race,
          attributes: unit.attributes,
          hp: unit.hp,
          maxHp: unit.maxHp,
          mp: unit.mp,
          maxMp: unit.maxMp,
          sp: unit.sp,
          maxSp: unit.maxSp,
          statusEffects: unit.statusEffects,
          skills: unit.skills ?? [],
          equipment: unit.equipment ?? [],
        };
      }
      const saved = characters?.find((c) => c.name === key);
      if (!saved) throw new Error(`get_character: 角色不存在 ${key}`);
      return {
        name: saved.name,
        tier: saved.tier,
        level: saved.level,
        race: saved.race,
        attributes: saved.attributes,
        hp: saved.hp,
        maxHp: saved.maxHp,
        mp: saved.mp,
        maxMp: saved.maxMp,
        sp: saved.sp,
        maxSp: saved.maxSp,
        statusEffects: saved.statusEffects ?? [],
        skills: saved.skills ?? [],
        equipment: (saved.inventory ?? []).filter((i) => i.equippedSlot),
      };
    }
    case 'get_inventory': {
      if (!args.name) throw new Error('get_inventory: 缺少 name');
      const key = String(args.name);
      const saved = characters?.find((c) => c.name === key);
      if (!saved) throw new Error(`get_inventory: 角色不存在 ${key}`);
      return { name: key, inventory: saved.inventory ?? [] };
    }

    default:
      throw new Error(`战斗沙盒工具未注册: ${functionName}`);
  }
}

/** 绑定到一个 CombatState 实例的工具运行时 */
export interface CombatToolBinding {
  readonly definitions: ToolDefinition[];
  getState(): CombatState;
  execute(name: string, args: Record<string, any>): Promise<ToolResult>;
}

/** 建工具绑定：所有工具调用就地维护 `initial` 状态；`characters` 供只读查询 */
export function createCombatToolBinding(
  initial: CombatState,
  characters?: ReadonlyArray<CharacterState>,
): CombatToolBinding {
  const state = initial;
  return {
    definitions: COMBAT_SANDBOX_TOOL_DEFINITIONS,
    getState: () => state,
    execute: (name, args) => executeCombatTool(name, args, state, characters),
  };
}
