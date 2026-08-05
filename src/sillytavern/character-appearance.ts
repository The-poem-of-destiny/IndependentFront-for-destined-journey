/**
 * character-appearance.ts — 角色外貌的**属性槽**模型与合并（D56 / D58）
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md`「v1.2 修订」一节。
 *
 * ---
 *
 * ## 为什么是槽，不是一整串文本
 *
 * 三方对照实验（`tmp/nai-live/appearance-experiment.live.ts`，9 张真图）逮到一条定律：
 * **锚里没钉住的属性，模型每张图都重新决定一次。** 混合变体在第 2 阶段就把头发画短了
 * —— 剧本里那一刀是第 3 阶段才砍的，没有任何标签要求变短，只是身份锚
 * （`silver hair, golden eyes, slender`）与可变层都没提长度，于是「没说」＝「随便画」。
 *
 * 拼字符串时，「没提到」与「明确不变」长得一模一样。改成具名槽之后这两件事分开了：
 * **基线里每个槽都有值**，会话层只覆盖它真的写了的槽 —— 模型再没有自由发挥的余地。
 *
 * ## 两份定义（D56）
 *
 * - **基线（base）**：这个角色「本来长什么样」。全局、跨存档共用、**只有用户能写**。
 *   **每个槽都必须有值**（`CharacterAppearance` 的字段全是必填）。
 * - **会话（session）**：按存档跟踪，由出图 AI 自动写入。**是个 patch**
 *   （`CharacterAppearancePatch`，字段全可选），只覆盖它真的观察到的变化。
 *
 * 🔴 **为什么必须两份**：一份可变的会被幻觉逐步腐蚀且回不了头 —— 模型某次写错发色，
 * 之后每张图都从那个错的基线继续演化。两份的结构保证基线永远干净，会话那份怎么漂
 * 都能一键重置。这也是「自动写入」能被接受的前提：写的是副本，不是真源。
 *
 * 🔴 **没有基线的角色，AI 即兴出来的那份也只落会话层**（v1.3 裁定，2026-08-05）——
 * 差量基准是全空。此前 D57 让 AI 为这类角色现建一份**基线**，而基线是全局的：
 * A 周目里的即兴会成为 B 周目的定义，两个重置口都够不着它。「AI 一个字节都碰不到
 * 基线」这条现在是无条件的。判定与合并的唯一实现在 `character-appearance-resolve.ts`。
 *
 * 本文件是**纯函数层**：没有 Dexie、没有网络、没有随机、没有时钟。
 */

// ═══════════════════════════════════════════════════════════
// 槽
// ═══════════════════════════════════════════════════════════

/**
 * 外貌属性槽。**顺序即渲染顺序**（danbooru 里靠前的权重更高），所以这张表的字段顺序
 * 不是随手排的：先说这是谁（人数/性别），再说不常变的身份特征，最后才是这一刻的状态。
 *
 * 🔴 新增槽要同时改三处：本接口、{@link APPEARANCE_SLOT_ORDER}、
 *    {@link EMPTY_APPEARANCE}。漏掉第二处 = 新槽永远不进提示词（静默失效）；
 *    漏掉第三处 = 类型不完整，编译期就会拦下。
 */
export interface CharacterAppearance {
  /** 人数与性别，如 `1girl` / `1boy`。🔴 由 Code 定，不问 AI（多角色时靠它对齐槽位） */
  count: string;
  /** 发色，如 `silver hair` */
  hairColor: string;
  /** 发长/发型，如 `very long hair` / `short hair, bob cut` */
  hairStyle: string;
  /** 瞳色，如 `golden eyes` */
  eyes: string;
  /** 体型与年龄感，如 `slender, teenage` */
  build: string;
  /** 显著的固有特征：疤痕、纹身、义肢、兽耳…… 永久改变落在这里 */
  features: string;
  /** 当前穿戴，如 `white mage robe, gold trim` */
  outfit: string;
  /** 当前身体状态：湿透、沾泥、负伤、疲惫…… **临时**，不该进基线 */
  condition: string;
  /** 表情，如 `calm expression`。同样偏临时 */
  expression: string;
}

/** 会话层的覆盖。**字段全可选** —— 没写的槽保留基线的值（D58 的全部要点） */
export type CharacterAppearancePatch = Partial<CharacterAppearance>;

/**
 * 渲染顺序 = 提示词里的先后 = 权重高低。
 *
 * `count` 必须第一个：NAI 的多角色槽靠它判断这一格画几个人。
 * `condition` / `expression` 压在最后 —— 它们是这一刻的状态，不该盖过身份特征。
 */
export const APPEARANCE_SLOT_ORDER: readonly (keyof CharacterAppearance)[] = [
  'count',
  'hairColor',
  'hairStyle',
  'eyes',
  'build',
  'features',
  'outfit',
  'condition',
  'expression',
];

/**
 * 全空基线 —— 建新角色时的起点，也是「这个槽存在但还没人填」的表示。
 *
 * 🔴 空串是合法值，`undefined` 不是：基线里**每个槽都必须存在**，哪怕是空的。
 *    这样「没填」是一个看得见的空槽（UI 能提示、AI 能补），而不是一个不存在的键。
 */
export const EMPTY_APPEARANCE: CharacterAppearance = {
  count: '',
  hairColor: '',
  hairStyle: '',
  eyes: '',
  build: '',
  features: '',
  outfit: '',
  condition: '',
  expression: '',
};

// ═══════════════════════════════════════════════════════════
// 合并
// ═══════════════════════════════════════════════════════════

/**
 * 基线 + 会话覆盖 → 这一次出图该用的外貌。
 *
 * 逐槽覆盖，**不是整份替换**：
 * - patch 里**没有**这个键 → 用基线的值
 * - patch 里有值 → 用 patch 的（这就是「换了衣服」「剪了头发」）
 * - patch 里是**空串** → 也算覆盖，表示「这个槽现在没有内容」
 *   （例：脱掉外袍之后 `outfit` 被清空是有意义的，与「没提到 outfit」不是一回事）
 *
 * 🔴 空串与「键不存在」的区别是本函数的**全部要害**。写成 `patch.outfit || base.outfit`
 *    会把「明确清空」悄悄退回基线值 —— 那正是 D58 要消灭的那种歧义。
 */
export function mergeAppearance(
  base: CharacterAppearance,
  patch: CharacterAppearancePatch | undefined,
): CharacterAppearance {
  if (!patch) return { ...base };
  const out = { ...base };
  for (const slot of APPEARANCE_SLOT_ORDER) {
    const value = patch[slot];
    // 🔴 `in` 而不是真值判断：空串是「明确清空」，undefined 才是「没说」
    if (value !== undefined) out[slot] = value;
  }
  return out;
}

/**
 * 会话 patch 之间的叠加（新的压旧的）—— AI 每回合可能只报一两个槽的变化。
 *
 * 与 {@link mergeAppearance} 同一条规则：`undefined` 是没说，空串是清空。
 */
export function stackPatches(
  older: CharacterAppearancePatch | undefined,
  newer: CharacterAppearancePatch | undefined,
): CharacterAppearancePatch {
  const out: CharacterAppearancePatch = { ...(older ?? {}) };
  if (!newer) return out;
  for (const slot of APPEARANCE_SLOT_ORDER) {
    const value = newer[slot];
    if (value !== undefined) out[slot] = value;
  }
  return out;
}

/**
 * 这个 patch 有没有真的改变什么 —— 用来决定「值不值得落库」。
 *
 * AI 每次出图都会报一份当前外貌，其中绝大多数与基线一模一样；照单全收会让会话表
 * 迅速堆满等价于基线的噪音行，「重置」也就失去了意义（重置回一个满是复制品的状态）。
 */
export function isMeaningfulPatch(
  base: CharacterAppearance,
  patch: CharacterAppearancePatch | undefined,
): boolean {
  if (!patch) return false;
  return APPEARANCE_SLOT_ORDER.some((slot) => {
    const value = patch[slot];
    return value !== undefined && value !== base[slot];
  });
}

/** 只留与基线**不同**的槽 —— 落库前的瘦身，让会话行只记「差异」而不是全量快照 */
export function diffFromBase(
  base: CharacterAppearance,
  next: CharacterAppearance,
): CharacterAppearancePatch {
  const out: CharacterAppearancePatch = {};
  for (const slot of APPEARANCE_SLOT_ORDER) {
    if (next[slot] !== base[slot]) out[slot] = next[slot];
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 渲染
// ═══════════════════════════════════════════════════════════

/**
 * 槽 → danbooru 标签串（角色槽的 `positive`）。
 *
 * 空槽直接跳过，绝不产出 `", ,"` 或首尾逗号 —— 与 `image-prompt.joinSegments` 同一条
 * 不变式。这里不调那个函数是因为它在 `image-prompt.ts` 里是私有的，而本模块刻意
 * **不依赖** `image-prompt`（依赖方向是反的：装配层用本模块，不是本模块用装配层）。
 *
 * 🔴 不做归一化、不动权重语法：`{{...}}` / `[...]` / `2::x::` 是用户与 AI 都会写的
 *    NAI 语法，改了就等于改画面。归一化在装配层统一做一次（`normalizeTagString`）。
 */
export function renderAppearanceDanbooru(appearance: CharacterAppearance): string {
  const parts: string[] = [];
  for (const slot of APPEARANCE_SLOT_ORDER) {
    const value = appearance[slot].trim();
    if (value !== '') parts.push(value);
  }
  return parts.join(', ');
}

/**
 * 槽 → 一句自然语；v2 的 `prose` 方言用（OpenAI/Gemini 那类吃句子的模型，D11）。
 *
 * 现在没有消费者，**但它存在本身就是槽模型的理由之一**：同一份结构，两种渲染。
 * 手写两串文本才是会漂移的那条路。
 */
export function renderAppearanceProse(appearance: CharacterAppearance): string {
  const order: (keyof CharacterAppearance)[] = [
    'build',
    'hairColor',
    'hairStyle',
    'eyes',
    'features',
    'outfit',
    'condition',
    'expression',
  ];
  const parts = order.map((slot) => appearance[slot].trim()).filter((v) => v !== '');
  return parts.join('; ');
}

/**
 * 一个角色的一次外貌上报（`character-appearance-agent` 的抽取产物）。
 *
 * 🔴 类型住在本文件而不是 agent 那边，是为了**不成环**：`types-image` 要引用它，
 *    而 agent 模块 import 了 `image-prompt`，`image-prompt` 又 import `types-image`。
 *    本文件零依赖，谁都可以引。
 */
export interface ParsedCharacterAppearance {
  /** 🔴 原样，不归一化（铁律 1）—— 要与标记里的 `characters` `===` 对上 */
  name: string;
  patch: CharacterAppearancePatch;
}
