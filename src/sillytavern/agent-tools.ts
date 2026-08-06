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
} from './types';
import { d20, d100, roll, rollDice, rollDie } from './dice';
import { normalizeItemType } from './field-enums';
import { buildCraftRequest, craftCheckDiceCount, craftRequestFingerprint } from './craft-request';
import {
  randomName,
  randomHairColor,
  randomEyeColor,
  randomPersonality,
  rollAttributes,
  randomAppearanceSummary,
} from './random-tables';

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
      description:
        '随机生成一个符合《命定之诗》世界观的角色名称。根据种族和性别从名称池中随机选取。',
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
      description: '查询角色数据。可用于查重（避免重名）、获取角色属性用于制作检定等。',
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
      name: 'get_hp_percent',
      description: '查询角色的 HP 百分比 (0-100)。',
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: '角色名（兼容旧 UUID）' },
        },
        required: ['characterId'],
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
  {
    type: 'function',
    function: {
      name: 'get_script_reference',
      description:
        '查询脚本沙盒中可用的 $ API 签名、变量路径约定、生命周期hook 列表。当需要编写 skill/equipment/item/element/authority 的 scripts 时调用此工具获取正确的 API 文档。返回 Markdown 格式的参考文本。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              '查询分类 — "all"=全部参考, "events"=事件系统($event.on/off/emit), "resources"=资源操作($resource), "status"=状态效果($status), "dice"=骰子($dice), "paths"=变量路径+跨对象引用($call/@语法)',
            enum: ['all', 'events', 'resources', 'status', 'dice', 'paths'],
          },
        },
      },
    },
  },

  // ── Combat V3 工具集（M2 新增，对应 AGENT_TOOL_MAP['combat_v3']）──
  //   v3 工具集只有 6 个（§4.4），一次工具调用 = 一个 Command = 一个槽位或一次 pass。
  //   v2 的 19 个 combat 工具（AGENT_TOOL_MAP['combat']）已随 M5 真正退役删除。
  {
    type: 'function',
    function: {
      name: 'declare_attack',
      description:
        '（v3）声明一次攻击/技能攻击。为当前行动单位填入目标、技能名、意图层级。骰值与伤害由内核真实计算，你只负责战术决策——禁止传骰值。',
      parameters: {
        type: 'object',
        properties: {
          actorName: { type: 'string', description: '攻击方角色名（当前行动单位）' },
          targetName: { type: 'string', description: '目标角色名' },
          skillName: { type: 'string', description: '使用的技能名（可选，缺省为普通攻击）' },
          intentionLevel: {
            type: 'string',
            description: '意图层级：非致死/常规/战术/机能/核心/抹杀/概念/处决',
          },
          costs: {
            type: 'object',
            properties: {
              mp: { type: 'integer', description: '本次攻击消耗的 MP（可选）' },
              sp: { type: 'integer', description: '本次攻击消耗的 SP（可选）' },
            },
          },
        },
        required: ['actorName', 'targetName', 'intentionLevel'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'declare_action',
      description: '（v3）执行一个战术动作：道具 / 移动 / 专注 / 防御 / 格挡。占据动作槽。',
      parameters: {
        type: 'object',
        properties: {
          actorName: { type: 'string', description: '执行者角色名' },
          actionType: {
            type: 'string',
            enum: ['道具', '移动', '专注', '防御', '格挡'],
            description: '动作类型',
          },
          payload: {
            type: 'object',
            description: '动作载荷（如道具名 / 移动目标）',
          },
        },
        required: ['actorName', 'actionType'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pass_slot',
      description: '（v3）显式放弃当前行动单位的某个行动槽（1 攻击 或 1 动作）。放弃仍消费槽位。',
      parameters: {
        type: 'object',
        properties: {
          actorName: { type: 'string', description: '角色名' },
          slot: {
            type: 'string',
            enum: ['attack', 'action'],
            description: '放弃的槽位：attack=攻击槽 / action=动作槽',
          },
        },
        required: ['actorName', 'slot'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'flee',
      description: '（v3）当前行动单位尝试逃跑。消耗攻击+动作双槽，做逃跑检定。',
      parameters: {
        type: 'object',
        properties: {
          actorName: { type: 'string', description: '逃跑者角色名' },
        },
        required: ['actorName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_adjudication',
      description:
        '（v3）提出有界裁决：当标准动作无法表达一个创意效果时，用此工具申请法则级裁决。M2 先定义 schema，执行暂不支持。',
      parameters: {
        type: 'object',
        properties: {
          effectDescription: { type: 'string', description: '期望达成的效果描述' },
          divinity: { type: 'integer', minimum: 0, maximum: 8, description: '登神强度' },
          verifiableBounds: { type: 'object', description: '可验证的数值边界' },
          requestedRuleOverride: { type: 'string', description: '请求覆盖的 RuleKey（可选）' },
          reason: { type: 'string', description: '裁决理由' },
        },
        required: ['effectDescription', 'divinity', 'verifiableBounds', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_summary',
      description:
        '（v3）在战斗终局写一段不超过 500 字的战斗摘要，供回注 Story。这是收尾动作，不产出 Command。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '战斗摘要（≤500 字）' },
        },
        required: ['text'],
      },
    },
  },

  // ── Combat Query (只读查询, M4 任务 5.3 新建) ──
  {
    type: 'function',
    function: {
      name: 'get_combat_state',
      description:
        '查询当前战斗快照（回合/行动轴/各方 HP）。底层映射 $combat.getState。只读查询，不改状态。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },

  // ── 标签词库（图像 v1.4）──
  //   image_prompt 侧链专用：目录里只有中文名字，标签本体靠这两个工具取。
  //   🔴 两者都是**纯查询**：不掷骰、不写状态、不花钱。词库由调用方经
  //      `ToolExecutionContext.tagBank` 交进来，工具本身不碰 Dexie。
  {
    type: 'function',
    function: {
      name: 'get_image_tags',
      description:
        '按词库目录里的中文名字取它对应的 danbooru 标签。一次可传多个名字。' +
        '返回的 tags 里：逗号分隔的是可同时使用；竖线 | 分隔的是同类候选（通常择一，按画面挑最贴切的那个）。' +
        '名字必须与目录里的写法一致；同名条目可写成「分类:名字」消歧。查不到的名字会原样列在 notFound 里——' +
        '那说明目录里没这一条，改用 search_image_tags 换个说法找，或者自己写标签。',
      parameters: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: '目录里的条目名，如 ["温泉", "兽耳"]',
          },
        },
        required: ['names'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_image_tags',
      description:
        '按中文关键词在标签词库里模糊查找（匹配条目名与它的全部别名）。' +
        '用在目录里一眼没找到、但觉得词库里应该有的时候——例如查「猫耳」能找到名为「兽耳」的那条。' +
        '返回结果直接带标签，不必再调 get_image_tags。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '中文关键词，如「猫耳」「雨天」' },
          limit: { type: 'integer', description: '最多返回几条，缺省 12' },
        },
        required: ['query'],
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
  char_gen: [
    'roll_d20',
    'roll_d100',
    'roll_dice',
    'random_name',
    'random_hair_color',
    'random_eye_color',
    'random_personality',
    'random_appearance',
    'roll_attributes',
    'get_character',
    'get_inventory',
  ],
  item_gen: ['get_script_reference', 'get_character', 'get_inventory'],
  vars_update: ['get_script_reference', 'get_character', 'get_inventory'],
  // Combat Agent V3（M2 新增，对应 v3 内核）— 见 docs/reference/combat-system-architecture-v3.md §4.4
  //   v3 工具集只有 6+4 个（6 个战斗工具 + 4 个只读）。v2 的 ['combat'] 已随 M5 真正退役删除。
  combat_v3: [
    // 战斗控制（一次工具调用 = 一个 Command）
    'declare_attack',
    'declare_action',
    'pass_slot',
    'flee',
    'submit_adjudication',
    'write_summary',
    // 只读查询（复用现有）
    'get_character',
    'get_hp_percent',
    'get_inventory',
    'get_combat_state',
  ],
  /**
   * image_prompt（图像 v1.4）——**只有查词库这两口**。
   *
   * 🔴 别往这里加别的工具。这条侧链每张图都要跑，它的职责只有「中文场景 → 标签串」；
   *    给它 get_character / roll_d20 之类既不会让标签更准，又给了模型一条编数值的路。
   *    没导入词库时 `getToolsForAgent` 照样返回这两个定义，但调用方会走无工具的老路径
   *    （见 `image-prompt-agent.callImagePromptAgent`）——空词库不该白发两份 schema。
   */
  image_prompt: ['get_image_tags', 'search_image_tags'],
};

// ═══════════════════════════════════════════════════════════
// Group C: 工具获取
// ═══════════════════════════════════════════════════════════

/** 获取指定 Agent 的工具定义列表（过滤白名单） */
export function getToolsForAgent(agentId: string): ToolDefinition[] {
  const allowed = AGENT_TOOL_MAP[agentId];
  if (!allowed) return [];
  const allowedSet = new Set(allowed);
  return ALL_TOOL_DEFINITIONS.filter((t) => allowedSet.has(t.function.name));
}

/** 根据工具名获取单个工具定义 */
export function getToolDefinition(functionName: string): ToolDefinition | undefined {
  return ALL_TOOL_DEFINITIONS.find((t) => t.function.name === functionName);
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
 * 注意区分：**查询未命中不是失败**。`status_query` 对不存在的角色返回
 * `{ found: false, message }` 是这个工具的正常回答，不在上面这条规则内。
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
      const { $craft } = await import('./craft-resolver');
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
      const { CRAFT_DC_BASE } = await import('./types');
      return { quality: args.quality, baseDC: CRAFT_DC_BASE[args.quality as QualityLevel] ?? 0 };
    }
    case 'craft_get_production_bonus': {
      const { CRAFT_PRODUCTION_BONUSES } = await import('./types');
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
      const { $craft } = await import('./craft-resolver');
      const { createStateManager } = await import('./state-manager');
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
        const sm = createStateManager(context.saveId);
        const commitResult = await sm.commitChatState(result.patches);
        patchesApplied = commitResult.patchesApplied;
        if (commitResult.errors.length > 0) {
          console.error('[AgentTools] craft patches 提交失败:', commitResult.errors);
        }
      }

      return {
        success: result.success,
        productName: result.productName,
        outputQuality: result.outputQuality,
        productQuantity: result.productQuantity,
        xpGained: result.xpGained,
        fpGained: result.fpGained,
        // 🔒 P1-07: 返回实际 commit 成功数（库存不足等会让部分 patch 失败），而非计划数
        patchesApplied,
      };
    }

    // ── NPC Generation ──
    case 'random_name': {
      const race = args.race ?? '人类';
      const gender = args.gender ?? '男';
      const name = randomName(race, gender);
      return { name, race, gender };
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
    case 'get_hp_percent': {
      const char = findCharacter(args.characterId, context);
      if (!char) throw new Error(`未找到角色: ${args.characterId}`);
      const percent = char.maxHp > 0 ? Math.round((char.hp / char.maxHp) * 100) : 0;
      return { characterId: args.characterId, hpPercent: percent, hp: char.hp, maxHp: char.maxHp };
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

    // ── Script Reference (Phase 9) ──
    case 'get_script_reference': {
      const query = args.query ?? 'all';

      const SCRIPT_REF = {
        events: `## 事件系统 (持久订阅)
$event.on(eventType, scriptKey) → handle  // 订阅事件，返回句柄。scriptKey 必须是字符串 key（当前对象 scripts 池中的键名），不能传内联函数
$event.off(handleOrType)                 // 取消订阅，传入 handle 字符串或 eventType

⚠️ 事件类型是自定义字符串，不存在预定义的系统事件。
  你可以使用 'combat_round_start' | 'combat_round_end' | 'hp_below_50' | 'skill_cast' | 'on_hit' | 'on_kill' 等作为示例参考，但这些都是你**自己定义和 emit 的**，不是系统自带的。
❌ 不存在 $event.getTargets()，不要编造。
❌ $event.on(eventType, function() {...}) — 第二个参数必须传字符串 key，不能传内联代码。
生命周期约定: init=装备/获得时执行一次 | cast=主动使用时执行 | tick=每回合/时间单位执行 | cleanup=移除/卸下时执行`,
        resources: `## 资源操作
$resource.modifyHp(charId, amount)       // amount: 正数=恢复, 负数=伤害
$resource.modifyStat(charId, stat, amount) // stat: 'str'|'dex'|'con'|'int'|'spi'
$resource.getHp(charId) → number
$resource.getMaxHp(charId) → number

⚠️ 沙盒行为说明:
- $resource.getHp / getMaxHp 在脚本执行时**始终返回 0**（stub），不能用于条件判断。如需 HP 阈值逻辑，改用事件 payload 传值给脚本。
- $resource.modifyHp / modifyStat 正常工作，是产生 Side Effect 的主要方式。
- ❌ 不存在 $resource.getTargets() / getEnemies() 等查询函数。`,
        status: `## 状态效果
$status.add(charId, { name, description, category, stacks, maxStacks, remainingTime, timeUnit, effects, effectDescriptions, scripts })
$status.remove(charId, effectId)
$status.setStacks(charId, effectId, stacks)
$status.getStacks(charId, effectId) → number
timeUnit: '回合' | '分钟' | '小时'
category: '增益' | '减益' | '特殊'

⚠️ 沙盒行为说明:
- $status.getStacks 在脚本执行时**始终返回 0**（stub），不能用于条件判断。改用 self.stacks 读取自身层数（self 是自身状态快照，真实值）。
- $status.add 的第一个参数必须是 charId 字符串（owner 或 target），不是地点名如 '战场'。
- $status.remove 的第二个参数是 effectId（效果名的小写蛇形，如 'burn_seal'），不是分类名。`,
        dice: `## 骰子系统 (脚本内可用)
$dice.d20() → number
$dice.d100() → number
$dice.roll(formula) → number  // formula: '2d6+3', '4d8' 等

⚠️ 沙盒行为说明:
- $dice 函数每次调用生成**新鲜随机数**（不是游戏状态快照），可用于概率型条件判断（如随机触发效果）。
- 骰值结果用于传给 $resource.modifyHp / $status.add 的参数，决定实际数值。`,
        paths: `## 变量路径命名空间约定
sys.<path>     — 引擎管理变量 (如 sys.世界.地点.城市)
char.<角色>.<path> — 按角色分组 (如 char.player.hp；玩家固定用 player，见 namespace-normalizer 映射)
user.<path>    — 玩家变量 (如 user.settings.language)
world.<path>   — 世界设定 (如 world.历史.纪元)
temp.<path>    — 会话临时 (不持久化)

## 跨对象脚本引用 ($call)
@parent.<scriptKey>        — 引用父级对象的脚本
@skill.<技能名>.<scriptKey> — 引用指定技能的脚本
@item.<物品名>.<scriptKey>  — 引用指定物品的脚本
@status.<效果名>.<scriptKey> — 引用指定状态效果的脚本
@ascension.<要素名>.<scriptKey> — 引用登神要素的脚本

⚠️ 沙盒行为说明:
- 变量读写只能用于写入 Side Effect 参数，不能用于读取状态做条件分支。
- 脚本中 owner 和 target 是纯 string（charId），不是对象引用。owner.tier / target.hp 会报错。
- self 对象是自身状态快照，可读：self.stacks / self.remainingTime / self.name。`,
      };

      if (query === 'all') {
        const allParts = Object.entries(SCRIPT_REF)
          .map(([_key, text]) => text)
          .join('\n\n');
        return { query: 'all', reference: allParts };
      }
      if (SCRIPT_REF[query as keyof typeof SCRIPT_REF]) {
        return { query, reference: SCRIPT_REF[query as keyof typeof SCRIPT_REF] };
      }
      // Q-14: 参数不合法一律 throw（此处旧实现返回 { query, error } —— 同一个执行器里
      // 「参数不合法」有两种长相，模型侧无法统一教。可用分类清单原样保留在异常消息里，
      // chatWithTools 会把它包成 {"error": …} 的 tool 消息，模型照样能读能重试。
      throw new Error(`未知分类 "${query}"，可用: ${Object.keys(SCRIPT_REF).join(', ')}`);
    }

    // ── Async dispatch: call_item_gen (Phase 9 removed — orchest now calls item_gen directly) ──
    // call_item_gen has been removed from the registry. char_gen no longer dispatches item_gen
    // asynchronously; the orchestrator calls item_gen directly after char_gen completes.

    // ── Combat Control (M4 任务 5.3) ──
    // 底层走管道版 (combat-pipeline.ts / combat-actions-pipeline.ts / combat-settlement-pipeline.ts),
    // 需 PipelineContext (EventBus + combatants + 战斗实例)。
    // 当前 ToolExecutionContext 只有 { characters, variables, saveId }，缺 bus/combatants/战斗实例,
    // 暂留占位等 M4 orchestrator 接入 (任务 5.2/5.7) 后再把 PipelineContext 注入进来。
    case 'combat_start':
    case 'combat_attack':
    case 'combat_use_skill':
    case 'combat_use_item':
    case 'combat_block':
    case 'combat_move':
    case 'combat_focus':
    case 'combat_flee':
    case 'combat_end':
    case 'get_combat_state':
      throw new Error(
        `combat 工具「${functionName}」需 M4 orchestrator 接入 PipelineContext (EventBus + combatants + 战斗实例) 后生效，` +
          `当前 ToolExecutionContext 仅含 { characters, variables, saveId }。详见 docs/reference/combat-agent-api.md §8。`,
      );

    // ── Status Tools (M4 任务 5.3) ──
    // status_query: 只读查询角色 buff, ToolExecutionContext 有 characters 即可, 接真函数。
    // status_apply / status_remove: 底层 status-api 能生成 patches, 但战斗内 buff 需配合
    //   PipelineContext 协调落库时机 + ADR-21 统一走 state-manager.commitChatState,
    //   为避免脱离战斗上下文乱上 buff, 暂留占位。
    case 'status_apply':
    case 'status_remove':
      throw new Error(
        `status 工具「${functionName}」需 M4 orchestrator 接入 PipelineContext 协调落库时机后生效。` +
          `当前 ToolExecutionContext 缺 bus/combatants。详见 docs/reference/combat-agent-api.md §2.2/§8。`,
      );
    case 'status_query': {
      const target = args.target;
      const char = findCharacterByName(target, context);
      if (!char) {
        return { target, found: false, message: `未找到角色: ${target}` };
      }
      const effects = char.statusEffects ?? [];
      const query = args.buffIdOrName;
      if (!query) {
        // 缺省返回全部 StatusEffect
        return {
          target,
          found: true,
          characterName: char.name,
          count: effects.length,
          statusEffects: effects,
        };
      }
      // 完整 buffId（"sourceKey.name"，含点号）→ 精确单匹配；
      // 裸 name（不含点号）→ 匹配所有同名并聚合层数。
      const hasDot = query.includes('.');
      const matched = hasDot
        ? effects.filter((e) => buffIdMatches(e, query))
        : effects.filter((e) => e.name === query);
      if (matched.length === 0) {
        return { target, has: false, query, stacks: 0 };
      }
      // 聚合层数（同名多源取和；精确匹配通常 1 个）
      const totalStacks = matched.reduce((s, e) => s + (e.stacks ?? 1), 0);
      return {
        target,
        has: true,
        query,
        stacks: totalStacks,
        matched,
      };
    }

    // ── 标签词库（图像 v1.4）──
    case 'get_image_tags': {
      const names = Array.isArray(args.names) ? args.names : [];
      if (names.length === 0) {
        throw new Error('缺少必需参数: names（目录里的条目名数组）');
      }
      const { lookupTagEntries } = await import('./image-tag-bank');
      // 🔴 词库缺席 = 一条都查不到，**不是**空结果：报成「全部 notFound」，
      //    模型据此知道该自己写标签，而不是以为这些条目本来就没有标签。
      return { ...lookupTagEntries(context.tagBank ?? [], names) };
    }
    case 'search_image_tags': {
      const query = typeof args.query === 'string' ? args.query : '';
      if (query.trim() === '') {
        throw new Error('缺少必需参数: query（中文关键词）');
      }
      const { searchTagEntries, SEARCH_DEFAULT_LIMIT } = await import('./image-tag-bank');
      const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? Math.floor(args.limit)
          : SEARCH_DEFAULT_LIMIT;
      return { ...searchTagEntries(context.tagBank ?? [], query, limit) };
    }

    default:
      throw new Error(`未知工具: ${functionName}`);
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
 * buffId 精确匹配：buff 的完整 id 形如 "sourceKey.name"（见 buff-registry.buffIdOf）。
 * StatusEffect 上没有单独的 buffId 字段，这里用 sourceKey + name 组装比对。
 * query 既可能是完整 buffId（"剑.流血"）也可能是裸 name，裸 name 由调用方走 name 相等分支。
 */
function buffIdMatches(effect: { name: string; sourceKey?: string }, query: string): boolean {
  const fullId = effect.sourceKey ? `${effect.sourceKey}.${effect.name}` : effect.name;
  return fullId === query || effect.name === query;
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
