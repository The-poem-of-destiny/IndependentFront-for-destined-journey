/**
 * 制作请求装配 — AI 工具参数 + 角色状态 + 骰带 → `CraftActionRequest`（Q-21 刀三）
 *
 * ## 为什么单独一个文件
 *
 * `craft_check` 与 `craft_settle` 此前**各自**逐字段装配同一个 15 字段对象：
 * 同样的六个 `??` 兜底（'锻造'/'成品'/'未命名制品'/'普通'/1/'未知材料'）、
 * 同样的 `materials` 映射、同样的 `...collectCraftBonuses(character)` 展开，
 * 连中文注释都一模一样。加一个字段要改两处，漏一处就是「预检说 A、结算做 B」。
 *
 * 放在这里而不是 `craft-resolver.ts`：那是结算数学 + `$craft` 门面。把
 * 「AI 说了什么」翻译成「引擎认的请求」是**翻译层**的活，与结算无关；
 * 而且这一层要认识 `CharacterState` 与 `Modifier`，结算层不必。
 *
 * ## 骰子是显式输入（对齐 combat-v3 铁律 1）
 *
 * 🔴 本模块**纯函数、无随机**。骰带由调用方（工具边界）掷好传进来。
 *
 *    此前两个工具都写 `d20Rolls: []`，注释写着「Will be rolled inside craftResolver」——
 *    那句是错的：`resolveCheck` 把空数组原样透传给 `calcCraftCheck`，
 *    `rollCraftDice` 落到 `d20Rolls[0] ?? 10`。于是**生产环境每一次制作检定都是 d20=10**，
 *    连带两条规则整个死掉：
 *      - **大失败不可达** —— 判据是 `diceValue === 1 && d20Rolls.length === 1`，而 length 是 0；
 *      - **优势/劣势是死规则** —— `determineAdvantage` 每次都算，但 `rollCraftDice`
 *        要 `length >= 2` 才会取高/取低，永远取不到。
 *    这与 Q-01（战斗恒定 10）同形状，只是那次的修复只覆盖了 combat-v3 的 coordinator。
 *
 * ## 骰数由优/劣势决定，不是「多掷几颗留着用」
 *
 * `craftCheckDiceCount` 精确给出这次要几颗。**不能图省事一律掷 2 颗** ——
 * 那会让常规检定的 `d20Rolls.length === 2`，把大失败判据永久打掉（同一个 bug 换个姿势）。
 */

import type {
  CharacterState,
  CraftActionRequest,
  CraftDiceTape,
  CraftIndustry,
  CraftMaterial,
  CraftStage,
  CraftToolArgs,
  QualityLevel,
} from './types';
import type { Modifier, CheckModifier } from './effect-types';
import { determineAdvantage } from './craft-dc';

/**
 * 这次检定要掷几颗 d20。
 *
 * 制作者层级 vs 目标品质对应层级：高 → 优势（2 颗取高）、低 → 劣势（2 颗取低）、
 * 齐平 → 正常 1 颗。判定本身在 `determineAdvantage`，这里只把它翻成颗数，
 * 好让掷骰方与 `rollCraftDice` 对同一件事有同一个答案。
 */
export function craftCheckDiceCount(crafterTier: number, targetQuality: QualityLevel): 1 | 2 {
  const { advantage, disadvantage } = determineAdvantage(crafterTier, targetQuality);
  return advantage || disadvantage ? 2 : 1;
}

/**
 * 制作行业 → 核心属性值。
 *
 * 行业缺省（AI 没给或给了表外的值）时取五维最大 —— 沿用工具层原有口径。
 */
export function getCraftCoreAttribute(char: CharacterState, industry?: string): number {
  switch (industry) {
    case '锻造':
      return char.attributes.str;
    case '炼金':
      return char.attributes.int;
    case '烹饪':
      return char.attributes.spi;
    case '裁缝':
      return char.attributes.dex;
    default:
      return Math.max(
        char.attributes.str,
        char.attributes.dex,
        char.attributes.con,
        char.attributes.int,
        char.attributes.spi,
      );
  }
}

/**
 * 🆕 制造反向链路 S2+S4（2026-08-01，见 2026-08-01-item-gen-combat-link-plan.md §3 S2b）：
 * 从角色收集「生产检定」modifier → 检定加值。
 *
 * 世界书依据：
 *  - 《品质效果限定》检定类含「生产检定修正」（稀+[2-4]/史+[5-7]/传+[8-10]/神+[11-15]）
 *  - 《生产制作协议》检定加值 = 属性[A] + 技能[B] + 道具[C] + 身份[D] → 进 fixedBonus
 *
 * - toolBonus（道具 C 位）：只统计 equippedSlot 非空的物品（躺背包不算正在使用）
 * - skillBonus（技能 B 位）：技能「生产检定」modifier（S4 补 Skill 落库 modifiers 字段后收 S2-2）
 */
export function collectCraftBonuses(char: CharacterState): {
  toolBonus: number;
  skillBonus: number;
} {
  const isCraftCheck = (m: Modifier): m is CheckModifier =>
    m.category === '检定' && m.checkType === '生产';
  const toolBonus = char.inventory
    .filter((i) => i.equippedSlot)
    .flatMap((i) => i.modifiers ?? [])
    .filter(isCraftCheck)
    .reduce((sum, m) => sum + m.bonus, 0);
  const skillBonus = (char.skills ?? [])
    .flatMap((s) => s.modifiers ?? [])
    .filter(isCraftCheck)
    .reduce((sum, m) => sum + m.bonus, 0);
  return { toolBonus, skillBonus };
}

/**
 * 装配一次制作请求 —— 全仓**唯一**的 `CraftActionRequest` 装配处。
 *
 * 兜底默认值、「名字即逻辑键」铁律、bonus 收集从此只有这一份。
 */
export function buildCraftRequest(
  character: CharacterState,
  args: CraftToolArgs,
  dice: CraftDiceTape,
): CraftActionRequest {
  const materials: CraftMaterial[] = (args.materials ?? []).map((m, i) => ({
    itemId: `mat_${i}`,
    itemName: m.name ?? '未知材料',
    quantity: m.quantity ?? 1,
    quality: (m.quality ?? '普通') as QualityLevel,
    dcModifier: 0, // 由 craft-quality 在结算时计算
  }));

  return {
    // CraftActionRequest 沿用历史字段名，但 StatePatch 的逻辑键必须是角色名（铁律 ①）。
    characterId: character.name,
    industry: (args.industry ?? '锻造') as CraftIndustry,
    stage: (args.stage ?? '成品') as CraftStage,
    productName: args.productName ?? '未命名制品',
    targetQuality: (args.targetQuality ?? '普通') as QualityLevel,
    quantity: args.quantity ?? 1,
    hasRecipe: args.hasRecipe ?? false,
    materials,
    crafterTier: character.tier,
    crafterLevel: character.level,
    coreAttributeValue: getCraftCoreAttribute(character, args.industry),
    resourceCosts: { hp: 0, mp: 0, sp: 0 },
    currentResources: { hp: character.hp, mp: character.mp, sp: character.sp },
    d20Rolls: [...dice.d20Rolls],
    d20MaterialSave: dice.d20MaterialSave,
    d20QualityUpgrade: dice.d20QualityUpgrade,
    ...collectCraftBonuses(character),
  };
}

/**
 * 「同一次制作」的稳定指纹 —— `craft_check` 掷的骰带留给 `craft_settle` 用的键。
 *
 * ## 为什么用指纹而不是让 AI 回传一个 id
 *
 * 骰带必须留在**引擎侧**。让 AI 携带 `checkId`（更别说携带骰值）就等于把
 * 「这次检定掷出了什么」交给它 —— 而 Agentic 模式存在的全部理由就是
 * 「禁止 AI 编造数值」。指纹从工具参数本身算出，AI 不需要、也无法参与。
 *
 * 附带两个正确的后果：
 *  - **同一次制作重复 check 是幂等的** —— 「再算一次」不会变成偷偷重掷；
 *  - **换了任何一项（品质/材料/数量）就是另一次制作**，自动重掷。
 *
 * 材料保持给定顺序参与指纹：顺序对 `materials[i]` 的 DC 修正下标是有意义的。
 */
export function craftRequestFingerprint(characterName: string, args: CraftToolArgs): string {
  return JSON.stringify([
    characterName,
    args.industry ?? '',
    args.stage ?? '',
    args.productName ?? '',
    args.targetQuality ?? '',
    args.quantity ?? 1,
    (args.materials ?? []).map((m) => [m.name ?? '', m.quantity ?? 1, m.quality ?? '']),
  ]);
}
