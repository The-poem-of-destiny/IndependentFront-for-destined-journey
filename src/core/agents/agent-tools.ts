/**
 * Agent 工具注册表与执行器 — Phase 8.5 Agentic 系统核心
 *
 * 职责:
 * 1. 定义所有 Agentic 工具的 OpenAI 兼容 function schema
 * 2. 每 Agent 的工具白名单映射
 * 3. executeToolCall() 分发器 — 将工具名映射到真实 Code 函数
 *
 * 设计原则:
 * - 工具定义是声明式的（OpenAI function calling 格式）
 * - 工具执行是 Code 层真实计算（不是 AI 幻觉）
 * - 非纯函数工具通过 ToolExecutionContext 获取运行时数据
 */

import type {
  ToolDefinition,
  ToolExecutionContext,
  CraftDiceTape,
  CraftToolArgs,
  QualityLevel,
  CharacterState,
  ToolResult,
} from '../types/types';
import { d20, d100, roll, rollDice, rollDie } from '../utils/dice';
import { normalizeItemType } from '../content/field-enums';
import {
  buildCraftRequest,
  craftCheckDiceCount,
  craftRequestFingerprint,
} from '../crafting/craft-request';
import {
  randomName,
  randomNameSeed,
  randomHairColor,
  randomEyeColor,
  randomPersonality,
  rollAttributes,
  randomAppearanceSummary,
} from './random-tables';
import { getContentRegistry } from '../content/content-registry-runtime';
import { COMBAT_SANDBOX_TOOL_DEFINITIONS } from '../combat/sandbox/tools';

// ═══════════════════════════════════════════════════════════
// Group A0: 品牌面注入（D26）
// ═══════════════════════════════════════════════════════════

/**
 * 注册表未就绪（或 pack 没声明 `branding.appTitle`）时用的**中性**世界称谓。
 *
 * 🔴 兜底文案里不许出现任何 IP 专名（D26）：这条描述会原样发给模型，
 * 写死作品名等于把内容焊进引擎。真实作品名由内容包的 `branding.appTitle` 供给。
 */
const NEUTRAL_WORLD_LABEL = '当前';

/**
 * 当前生效的世界称谓（同步读注册表 `branding` 面）。
 *
 * 有 `appTitle` → `《作品名》`；没有 / 面未就绪 / 形状不对 → {@link NEUTRAL_WORLD_LABEL}。
 */
function brandingWorldLabel(): string {
  const branding: unknown = getContentRegistry().branding;
  if (branding && typeof branding === 'object' && !Array.isArray(branding)) {
    const title = (branding as { appTitle?: unknown }).appTitle;
    if (typeof title === 'string' && title.length > 0) return `《${title}》`;
  }
  return NEUTRAL_WORLD_LABEL;
}

/**
 * `random_name` 的工具描述（**唯一**一处作者面文案；中性基线与品牌版共用它）。
 */
function randomNameToolDescription(worldLabel: string): string {
  return `随机生成一个符合${worldLabel}世界观的角色名称。根据种族和性别从名称池中随机选取，自动避开与已有角色重名。`;
}

/**
 * 给一条工具定义套上品牌面（D26）。
 *
 * 🔴 `ALL_TOOL_DEFINITIONS` 是模块加载时求值的常量，而注册表在 boot 链上才灌注——
 * 所以品牌相关的描述只能在**读取时**解析。常量里存的是中性基线（直接读它也安全），
 * 本函数在 `getToolsForAgent` / `getToolDefinition` 出口处覆盖。
 */
function withBranding(def: ToolDefinition): ToolDefinition {
  if (def.function.name !== 'random_name') return def;
  const label = brandingWorldLabel();
  if (label === NEUTRAL_WORLD_LABEL) return def;
  return {
    ...def,
    function: { ...def.function, description: randomNameToolDescription(label) },
  };
}

// ═══════════════════════════════════════════════════════════
// Group A: 工具定义（OpenAI function schemas）
// ═══════════════════════════════════════════════════════════

export const ALL_TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── Dice Tools ──
  {
    type: 'function',
    function: {
      name: 'roll_d20',
      description:
        '掷一个d20骰子。当需要判定成败、检定、对抗时调用此工具。禁止自己编造骰值。支持加值、优势（掷两次取高）、劣势（掷两次取低）。',
      parameters: {
        type: 'object',
        properties: {
          modifier: { type: 'integer', description: '加值（可为负），默认 0' },
          advantage: { type: 'boolean', description: '是否优势（掷两次取高）' },
          disadvantage: { type: 'boolean', description: '是否劣势（掷两次取低）' },
          reason: { type: 'string', description: '掷骰原因简述（如"制作长剑的检定"）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_d100',
      description: '掷一个d100骰子（1-100）。用于百分比概率判定。',
      parameters: {
        type: 'object',
        properties: {
          modifier: { type: 'integer', description: '加值（可为负），默认 0' },
          reason: { type: 'string', description: '掷骰原因简述' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_dice',
      description: '掷任意骰子公式。如 2d6, 3d8+2, 4d6 等。用于属性随机、伤害随机等场景。',
      parameters: {
        type: 'object',
        properties: {
          formula: { type: 'string', description: '骰子公式，如 2d6, 3d8+2, 4d6' },
          modifier: { type: 'integer', description: '额外加值，默认 0' },
          reason: { type: 'string', description: '掷骰原因简述' },
        },
        required: ['formula'],
      },
    },
  },

  // ── Craft Tools ──
  {
    type: 'function',
    function: {
      name: 'craft_check',
      description:
        '执行制作检定。输入制作者名字、行业、目标品质、材料等，返回完整的检定分解（基础DC、材料DC修正、最终DC、骰值、评级）。这是真实计算，不是猜测。掷出的骰子会留给随后**同参数**的 craft_settle 复用 —— 因此这里给出的评级就是最终结果，重复调用返回同一个值，不会重掷。',
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: '制作者角色名（兼容旧 UUID）' },
          industry: {
            type: 'string',
            enum: ['锻造', '炼金', '烹饪', '裁缝'],
            description: '制作行业',
          },
          stage: {
            type: 'string',
            enum: ['基础加工', '半成品', '成品'],
            description: '制作阶段',
          },
          productName: { type: 'string', description: '目标产物名称' },
          targetQuality: {
            type: 'string',
            enum: ['普通', '优良', '稀有', '史诗', '传说', '神话'],
            description: '目标品质',
          },
          quantity: { type: 'integer', description: '制作数量，默认 1' },
          materials: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '材料名称' },
                quantity: { type: 'integer', description: '数量' },
                quality: { type: 'string', description: '材料品质' },
              },
            },
            description: '投入材料列表',
          },
        },
        required: ['characterId', 'industry', 'targetQuality'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'craft_get_base_dc',
      description: '查询某种品质的基准 DC（不含材料修正）。',
      parameters: {
        type: 'object',
        properties: {
          quality: {
            type: 'string',
            enum: ['普通', '优良', '稀有', '史诗', '传说', '神话'],
            description: '目标品质',
          },
        },
        required: ['quality'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'craft_get_production_bonus',
      description: '查询某品质级别的产能加成（DC减免、资源节省、材料保护、精益求精阈值等）。',
      parameters: {
        type: 'object',
        properties: {
          quality: {
            type: 'string',
            enum: ['普通', '优良', '稀有', '史诗', '传说', '神话'],
            description: '制作者品质级别',
          },
        },
        required: ['quality'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'craft_settle',
      description:
        '执行完整制作管线（准备+检定+结算）。返回成功/失败、产出品质、经验奖励、FP奖励、材料损耗、精益求精增益。与 craft_check 不同，此工具会实际消耗资源并产出成品。仅在最终确认制作时调用。参数必须与之前那次 craft_check **完全一致**：一致则沿用同一组骰子（检定结论即结算结论），改动任何一项都会被判成另一次制作并重新掷骰。',
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: '制作者角色名（兼容旧 UUID）' },
          industry: {
            type: 'string',
            enum: ['锻造', '炼金', '烹饪', '裁缝'],
            description: '制作行业',
          },
          stage: { type: 'string', enum: ['基础加工', '半成品', '成品'], description: '制作阶段' },
          productName: { type: 'string', description: '目标产物名称' },
          targetQuality: {
            type: 'string',
            enum: ['普通', '优良', '稀有', '史诗', '传说', '神话'],
            description: '目标品质',
          },
          quantity: { type: 'integer', description: '制作数量，默认 1' },
          materials: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                quantity: { type: 'integer' },
                quality: { type: 'string' },
              },
            },
            description: '投入材料列表',
          },
        },
        required: ['characterId', 'industry', 'targetQuality'],
      },
    },
  },

  // ── NPC Generation Tools (random-tables) ──
  {
    type: 'function',
    function: {
      name: 'random_name',
      // 中性基线；有内容包时由 withBranding() 在读取出口换成带作品名的版本（D26）
      description: randomNameToolDescription(NEUTRAL_WORLD_LABEL),
      parameters: {
        type: 'object',
        properties: {
          race: { type: 'string', description: '种族，如 人类/精灵/矮人/翼民/兽族/血族/巨龙' },
          gender: { type: 'string', enum: ['男', '女'], description: '性别' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'random_name_seed',
      description:
        '生成 IPA 音素种子（按种族的发音风格加权抽样，如 "t/a/ʃ/i/n/ɑ"）。种子是取名灵感，不是成品名——按命名规则把音素组合想象成发音，再转写成独特的中文名。适合为新 NPC 起多样、不重复的名字；快速取名可直接用 random_name。',
      parameters: {
        type: 'object',
        properties: {
          race: { type: 'string', description: '种族，如 人类/精灵/矮人/翼民/兽族/血族/巨龙' },
          count: { type: 'integer', description: '生成几组候选种子（1-3，缺省 1）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'random_hair_color',
      description: '随机生成符合种族特征的发色。魔法世界中发色可多样化，受种族、血统、元素影响。',
      parameters: {
        type: 'object',
        properties: {
          race: { type: 'string', description: '种族' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'random_eye_color',
      description:
        '随机生成符合种族特征的瞳色。魔法世界中眼瞳可为竖瞳、重瞳等特殊形态，颜色多样化。',
      parameters: {
        type: 'object',
        properties: {
          race: { type: 'string', description: '种族' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'random_personality',
      description:
        '随机生成角色性格。使用 wOaGz(A) 五维模型（亲/疏、显/隐、急/缓、刚/柔、执/逸）+ 稳定性（S/A/F）。返回编码和描述。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'random_appearance',
      description:
        '随机生成角色外貌摘要（外观年龄、体型）。发色和瞳色请分别调用 random_hair_color 和 random_eye_color。',
      parameters: {
        type: 'object',
        properties: {
          race: { type: 'string', description: '种族' },
          gender: { type: 'string', enum: ['男', '女'], description: '性别' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_attributes',
      description:
        '按生命层级（Tier）和等级随机生成五维属性。使用三池分配模型：[基础池0-25]+[层级固定tier-1]+[等级额外level-1]。自动遵循层级属性上限。',
      parameters: {
        type: 'object',
        properties: {
          tier: {
            type: 'integer',
            minimum: 1,
            maximum: 7,
            description: '角色的生命层级 (1-7)',
          },
          level: {
            type: 'integer',
            minimum: 1,
            maximum: 25,
            description: '角色的等级 (1-25)，每级增加 1 点可分配属性',
          },
        },
        required: ['tier'],
      },
    },
  },

  // ── Character Query Tools ──
  {
    type: 'function',
    function: {
      name: 'get_character',
      description:
        '查询角色数据。返回角色属性、技能列表（skills）与已装备物品（equipment，含槽位）。可用于查重（避免重名）、获取角色属性用于制作检定、读取技能/装备用于战斗决策等。',
      parameters: {
        type: 'object',
        properties: {
          characterId: {
            type: 'string',
            description: '角色名（兼容旧 UUID）。不填则返回所有角色列表。',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_inventory',
      description:
        '查询角色背包中的所有物品。返回物品名称、数量、类型、品质、效果词条。craft_gen 必须调用此工具获取材料清单，禁止凭空编造材料。',
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: '角色名（兼容旧 UUID）' },
          type: {
            type: 'string',
            enum: ['consumable', 'material', 'quest'],
            description: '按类型筛选（可选）',
          },
        },
        required: ['characterId'],
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════
// Group B: 每 Agent 工具白名单
// ═══════════════════════════════════════════════════════════

export const AGENT_TOOL_MAP: Record<string, string[]> = {
  craft_gen: [
    'roll_d20',
    'roll_d100',
    'roll_dice',
    'craft_check',
    'craft_settle',
    'craft_get_base_dc',
    'craft_get_production_bonus',
    'get_character',
    'get_inventory',
  ],
  // 🔴 2026-10-02 硬改名：char_gen + item_gen 合并为 entity_gen（工具并集，
  //   运行时按 entityType 收窄 —— 角色用随机表/roll_attributes，物品用 get_character/get_inventory）。
  //   提示词里写明「按需调用」，多做一次查询无害；未实现「按 type 收窄白名单」是刻意的：
  //   同一次调用可能既产角色又产其装备（战斗召唤），静态分桶会误伤。
  entity_gen: [
    'roll_d20',
    'roll_d100',
    'roll_dice',
    'random_name',
    'random_name_seed',
    'random_hair_color',
    'random_eye_color',
    'random_personality',
    'random_appearance',
    'roll_attributes',
    'get_character',
    'get_inventory',
  ],
  vars_update: ['get_character', 'get_inventory'],
  // Combat Agent（Phase 2 战斗重写）— 真源是 `combat/sandbox/tools.ts` 的
  //   COMBAT_SANDBOX_TOOL_DEFINITIONS（单一 DM 依协议主持，工具就地维护 CombatState）。
  //   这里列的是同一批沙盒工具名；`getToolsForAgent('combat')` 直接从沙盒定义取，
  //   不走 ALL_TOOL_DEFINITIONS（避免与通用 get_character/get_inventory/roll_* 同名冲突）。
  combat: [
    'combat_add_unit',
    'combat_update_unit',
    'combat_remove_unit',
    'combat_add_status',
    'combat_remove_status',
    'combat_set_meta',
    'combat_yield_to_player',
    'get_character',
    'get_inventory',
    'roll_d20',
    'roll_d100',
    'roll_dice',
    'calc',
    'calc_damage',
    'calc_initiative',
  ],
};

// ═══════════════════════════════════════════════════════════
// Group C: 工具获取
// ═══════════════════════════════════════════════════════════

/** 获取指定 Agent 的工具定义列表（过滤白名单） */
export function getToolsForAgent(agentId: string): ToolDefinition[] {
  const allowed = AGENT_TOOL_MAP[agentId];
  if (!allowed) return [];
  const allowedSet = new Set(allowed);
  // 战斗沙盒工具的真源在 combat/sandbox/tools.ts（不走 ALL_TOOL_DEFINITIONS，
  // 避免与通用 get_character / get_inventory / roll_* 同名定义冲突）。
  const pool = agentId === 'combat' ? COMBAT_SANDBOX_TOOL_DEFINITIONS : ALL_TOOL_DEFINITIONS;
  return pool.filter((t) => allowedSet.has(t.function.name)).map(withBranding);
}

/** 根据工具名获取单个工具定义 */
export function getToolDefinition(functionName: string): ToolDefinition | undefined {
  const def = ALL_TOOL_DEFINITIONS.find((t) => t.function.name === functionName);
  return def === undefined ? undefined : withBranding(def);
}

// ═══════════════════════════════════════════════════════════
// Group D: 工具执行器
// ═══════════════════════════════════════════════════════════

/**
 * 执行单个工具调用。
 *
 * **失败一律 throw**（Q-14）——「工具失败长什么样」只在一处定义：
 * `agent-client.chatWithTools` 的既有 catch 把异常包成 `{"error": message}` 的 tool 消息
 * 回喂给模型。执行器自己再造一种 `return { error }` 的话，同一个分发口里「参数不合法」
 * 就有两种长相，prompt 侧没法统一教模型如何应对。
 *
 * 注意区分：**查询未命中不是失败**。`get_character` 对不存在的角色返回
 * `{ found: false, characterId }` 是这个工具的正常回答，不在上面这条规则内。
 *
 * @param functionName 工具名（如 'roll_d20', 'craft_check'）
 * @param args AI 传入的参数对象
 * @param context 运行时上下文（用于需要角色数据的工具）
 * @returns 工具执行结果（会被 JSON.stringify 后发回 AI）
 * @throws 参数缺失/不合法、目标不存在、工具未接线
 */
export async function executeToolCall(
  functionName: string,
  args: Record<string, any>,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  switch (functionName) {
    // ── Dice ──
    // 骰子三口都写成 `{ ...result }` 而非 `result`：具名 interface 没有索引签名，
    // 不能直接当 ToolResult（Record<string, unknown>）；展开成对象字面量即可，
    // 且这一步本来就要发生 —— 结果马上要被 JSON.stringify 回喂模型。
    case 'roll_d20': {
      const result = d20(args.modifier ?? 0, args.advantage, args.disadvantage);
      return args.reason ? { ...result, reason: args.reason } : { ...result };
    }
    case 'roll_d100': {
      const result = d100(args.modifier ?? 0);
      return args.reason ? { ...result, reason: args.reason } : { ...result };
    }
    case 'roll_dice': {
      const formula = args.formula;
      if (!formula) {
        throw new Error('缺少必需参数: formula');
      }
      const result = roll(formula, args.modifier ?? 0);
      return args.reason ? { ...result, reason: args.reason } : { ...result };
    }

    // ── Craft ──
    case 'craft_check': {
      const { $craft } = await import('../crafting/craft-resolver');
      const character = findCharacter(args.characterId, context);
      if (!character) {
        throw new Error(`未找到角色: ${args.characterId}`);
      }

      // Q-21：装配收在 buildCraftRequest 一处；骰带在这里（工具边界）掷、留给 craft_settle。
      const request = buildCraftRequest(character, args, takeCraftTape(context, character, args));

      // 先跑 validate 获取准备阶段的问题（品质继承/层级封顶/管制物等）
      const validation = $craft.validate(request);
      const prepIssues = validation.issues;

      // Only run the check phase (not the full startProject)
      const checkResult = $craft.check(request);
      return {
        baseDC: checkResult.breakdown.baseDC,
        materialDCModifier: checkResult.breakdown.materialDCModifier,
        finalDC: checkResult.breakdown.finalDC,
        fixedBonus: checkResult.breakdown.fixedBonus,
        diceValue: checkResult.breakdown.diceValue,
        diceRolls: checkResult.breakdown.diceRolls,
        totalValue: checkResult.breakdown.totalValue,
        rating: checkResult.breakdown.rating,
        // 准备阶段问题 — AI 据此调整材料或品质，而不是盲目重试
        prepPassed: prepIssues.length === 0,
        prepIssues: prepIssues.length > 0 ? prepIssues : undefined,
      };
    }
    case 'craft_get_base_dc': {
      const { CRAFT_DC_BASE } = await import('../types/types');
      return { quality: args.quality, baseDC: CRAFT_DC_BASE[args.quality as QualityLevel] ?? 0 };
    }
    case 'craft_get_production_bonus': {
      const { CRAFT_PRODUCTION_BONUSES } = await import('../types/types');
      const bonus = CRAFT_PRODUCTION_BONUSES[args.quality as QualityLevel];
      // Q-14: 品质不在表里 = 参数越界（schema 里 quality 本就是 enum），照统一口径 throw。
      // 旧实现返回裸 `null` —— 模型收到一个没有任何说明的 null，既不知道错在哪也不知道能重试。
      if (!bonus) {
        throw new Error(
          `未知品质 "${args.quality}"，可用: ${Object.keys(CRAFT_PRODUCTION_BONUSES).join(', ')}`,
        );
      }
      return { ...bonus };
    }
    case 'craft_settle': {
      const { $craft } = await import('../crafting/craft-resolver');
      const { createStateManager } = await import('../state/state-manager');
      const character = findCharacter(args.characterId, context);
      if (!character) throw new Error(`未找到角色: ${args.characterId}`);

      // ★ 取走 craft_check 掷过的那一条骰带（没 check 过就现掷）——
      //   AI 看到的 DC/评级与真正落库的结果从此同源。取走即消费：
      //   同一件东西连做两次，第二次会重新掷。
      const request = buildCraftRequest(
        character,
        args,
        takeCraftTape(context, character, args, { consume: true }),
      );

      const result = $craft.startProject(request);

      // 提交产生的 StatePatch（HP/MP/SP 消耗、EXP、FP、材料）
      let patchesApplied = 0;
      if (result.patches && result.patches.length > 0) {
        if (context.stageCraftSettlement) {
          context.stageCraftSettlement(result.patches);
        } else {
          const sm = createStateManager(context.saveId);
          await sm.commitDomainCommand(result.patches);
          patchesApplied = result.patches.length;
        }
      }

      return {
        success: result.success,
        productName: result.productName,
        outputQuality: result.outputQuality,
        productQuantity: result.productQuantity,
        xpGained: result.xpGained,
        fpGained: result.fpGained,
        // Deferred settlement reports zero until the complete command commits.
        patchesApplied,
      };
    }

    // ── NPC Generation ──
    case 'random_name': {
      const race = args.race ?? '人类';
      const gender = args.gender ?? '男';
      // 防重名（2026-08-15）：把存档已有角色名喂给抽样器。比较「·」前的给定名——
      // 已有「奥斯瓦尔德·狼牙」时不再抽出第二个「奥斯瓦尔德」（真机撞名教训）。
      const avoid = context.characters.map((c) => c.name).filter(Boolean);
      const name = randomName(race, gender, undefined, avoid);
      return { name, race, gender };
    }
    case 'random_name_seed': {
      const race = args.race ?? '人类';
      const count = Math.min(Math.max(Math.floor(Number(args.count) || 1), 1), 3);
      const seeds = randomNameSeed(race, count);
      // 空数组 = 该种族没有种子配置（内容面缺席）——提示 AI 走 random_name，别让
      // 它对着空结果自行编音素（那是绕过 Code 随机，又回到模式坍缩）
      if (seeds.length === 0) {
        return {
          race,
          seeds: [],
          hint: '该种族暂无音素种子配置，请改用 random_name 取名',
        };
      }
      return { race, seeds };
    }
    case 'random_hair_color': {
      const race = args.race ?? '人类';
      return { color: randomHairColor(race), race };
    }
    case 'random_eye_color': {
      const race = args.race ?? '人类';
      return { color: randomEyeColor(race), race };
    }
    case 'random_personality': {
      const result = randomPersonality();
      return result;
    }
    case 'random_appearance': {
      const race = args.race ?? '人类';
      const gender = args.gender ?? '男';
      return randomAppearanceSummary(race, gender);
    }
    case 'roll_attributes': {
      const tier = args.tier ?? 1;
      const level = args.level ?? 1;
      return rollAttributes(tier, level);
    }

    // ── Character Query ──
    case 'get_character': {
      if (args.characterId) {
        const char = findCharacter(args.characterId, context);
        if (!char) return { found: false, characterId: args.characterId };
        return {
          found: true,
          id: char.id,
          name: char.name,
          race: char.race,
          type: char.type,
          tier: char.tier,
          tierName: char.tierName,
          level: char.level,
          attributes: char.attributes,
          hp: char.hp,
          maxHp: char.maxHp,
          mp: char.mp,
          maxMp: char.maxMp,
          sp: char.sp,
          maxSp: char.maxSp,
          location: char.location,
          occupation: char.occupation,
          identity: char.identity,
          // 技能列表（战斗沙盒 calc_damage / 决策读取）
          skills: (char.skills ?? []).map((s) => ({
            name: s.name,
            type: s.type,
            description: s.description,
            cost: s.cost,
            cooldown: s.cooldown,
            maxCooldown: s.maxCooldown,
            effects: s.effects ?? {},
            skillPower: s.skillPower,
            relevantAttribute: s.relevantAttribute,
          })),
          // 🆕 combat session revamp §2.2: 已装备物品（inventory 中 equippedSlot 非空）
          equipment: (char.inventory ?? [])
            .filter((i) => i.equippedSlot)
            .map((i) => ({
              name: i.name,
              slot: i.equippedSlot,
              rarity: i.rarity ?? '普通',
              effects: i.effects ?? {},
              description: i.description ?? '',
            })),
        };
      }
      // Return list of all character IDs/names for dedup
      return {
        characters: context.characters.map((c) => ({
          id: c.id,
          name: c.name,
          race: c.race,
          type: c.type,
          tier: c.tier,
        })),
      };
    }
    case 'get_inventory': {
      const char = findCharacter(args.characterId, context);
      if (!char) throw new Error(`未找到角色: ${args.characterId}`);
      let items = char.inventory ?? [];
      if (args.type) {
        const normalizedType = normalizeItemType(args.type);
        if (!normalizedType) {
          throw new Error(`未知物品类型: ${args.type}`);
        }
        items = items.filter((i) => normalizeItemType(i.type ?? '') === normalizedType);
      }
      return {
        characterId: args.characterId,
        characterName: char.name,
        itemCount: items.length,
        items: items.map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          type: i.type ?? 'unknown',
          rarity: i.rarity ?? '普通',
          effects: i.effects ?? {},
          description: i.description ?? '',
        })),
      };
    }

    default:
      // 🔴 2026-08-08 真机：旧版 char_gen 提示词把 `call_item_gen` 列为可用工具，
      // 但白名单（AGENT_TOOL_MAP）没有它 —— 模型一调就报「未知工具」，随即放弃
      // **全部**工具、手编随机值（性格编码 WoAgy(F) 等）。报错必须可行动：
      // 告诉模型别调它、以及正确的替代做法，而不是一句冷冰冰的「未知工具」。
      throw new Error(
        `工具 ${functionName} 未注册或不在本 Agent 白名单，不可调用。请只使用提示词「可用工具」列出的工具；` +
          `如需生成角色/技能/装备/道具/状态/登神，直接输出 <entity_result> XML（一个 Agent 独立完成，不再有下游生成 Agent）。`,
      );
  }
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

/** Agent 工具统一寻址：规范名优先；UUID 仅保留给旧工具调用兼容。 */
function findCharacter(key: string, ctx: ToolExecutionContext): CharacterState | undefined {
  return findCharacterByName(key, ctx) ?? ctx.characters.find((c) => c.id === key);
}

/**
 * 按名寻址（铁律1：AI 永不产 id，combat/status 工具收到的都是角色名）。
 * 多个同名取第一个；找不到返回 undefined。
 */
function findCharacterByName(name: string, ctx: ToolExecutionContext): CharacterState | undefined {
  return ctx.characters.find((c) => c.name === name);
}

/**
 * 取这次制作要用的骰带（Q-21）。
 *
 * `craft_check` 掷一次并存进**本次 run 的工具上下文**；随后的 `craft_settle`
 * 按同一个指纹取走同一条带 —— AI 看到的 DC/评级与真正落库的结果从此同源。
 *
 * 骰带不出引擎：AI 既不携带 id 也不携带骰值（理由见 `craftRequestFingerprint`）。
 * 缓存挂在 ToolExecutionContext 上 —— 那是 per-run 对象，跟着这一轮 Agentic 循环生灭。
 *
 * 掷骰在这里而不在 resolver 里：与 combat-v3「内核禁 Math.random，随机源在内核外」
 * 同一条口径（Q-01 的修法）。resolver 与 craft-request 都保持纯函数。
 *
 * @param opts.consume settle 传 true —— 取走即删，同一件东西再做一次会重新掷。
 */
function takeCraftTape(
  context: ToolExecutionContext,
  character: CharacterState,
  args: CraftToolArgs,
  opts: { consume?: boolean } = {},
): CraftDiceTape {
  const cache = (context.craftDice ??= {});
  const key = craftRequestFingerprint(character.name, args);

  const cached = cache[key];
  if (cached) {
    if (opts.consume) delete cache[key];
    return cached;
  }

  const count = craftCheckDiceCount(character.tier, (args.targetQuality ?? '普通') as QualityLevel);
  const tape: CraftDiceTape = {
    d20Rolls: rollDice(count, 20),
    d20MaterialSave: rollDie(20),
    d20QualityUpgrade: rollDie(20),
  };
  // check 存起来给 settle 用；settle 自己现掷的没有下一个消费者，不必留
  if (!opts.consume) cache[key] = tape;
  return tape;
}
