/**
 * types-random-events.ts — 随机事件子系统的类型分册（随机事件系统 v1，设计 2026-08-15 §3）
 *
 * 装什么: 随机事件 v1 的**全部**类型 —— 内容侧的事件定义（`RandomEventDef` 及其成员：
 *         触发器 / 条件 DSL / 权重修正 / 槽位表）、每存档那一小袋可变状态
 *         （`RandomEventSaveFlags` = `SaveProfile.worldFlags.randomEvents` 的形状）、
 *         内容包分节（`PackRandomEventsSection`）、以及调度纯函数吃的只读快照
 *         （`RandomEventRollContext`）。
 * 不装什么: 任何函数、任何 I/O。容错解析在 `random-event-pack.ts`，调度/条件求值在
 *           `random-event-scheduler.ts`，注入块的数据面在 `random-event-context.ts`。
 *           **唯一的例外是 `DEFAULT_RANDOM_EVENT_CONFIG`** —— 它是三个数字的兜底常量
 *           （裁定 §13-6），与 `RandomEventConfig` 的形状是一件事的两半，分开放只会让
 *           「类型在这、默认值在那」多一处漂移点。它没有逻辑、不读任何东西。
 *
 * 为什么与 types.ts 分开:
 * 先例 `types-map.ts` / `types-image.ts` —— 与地图分册同款理由：本子系统**不新增 Dexie 表**、
 * 与 types.ts 的既有实体零交织（唯一的交界是 `worldFlags`，而它是 `Record<string, any>`，
 * 不需要类型握手）。
 * 🔴 **本分册不 import types.ts**（照两个先例的规矩），边不成环。
 *
 * 🔴 **与 `worldFlags.map` 的契约刚好相反**（设计 §3.2）：这里存的是**事实不是派生态**
 *    （足迹与触发档案不可重算），所以**没有 packStamp 自愈清空**。定义包更新后按名字续用，
 *    名字对不上的 pending 条目按铁则 4 静默剔除。
 *
 * 🔴 **逻辑键 = 事件名，AI 永不见 id**（铁则 1 / 数据字段规范铁律 1）。本分册里没有任何
 *    `id` 字段，这是刻意的：`<event_trigger name="...">` 的回执是逐字名字匹配。
 *
 * 🔴 **P2 预留字段名，v1 刻意不声明**（§3.1 记档防撞）：`onTrigger`（声明式效果表，
 *    裁定 §13-1）、`weightScript`（QuickJS 权重钩子，§8.3）、`scope.granularity`
 *    （域级首访，裁定 §13-7）。加它们的时候记得回来看这三行。
 *
 * 设计全文: `docs/planning/2026-08-15-random-event-system-design.md`
 * （§3 数据模型 / §4 调度器 / §5 AI 集成 / §10 测试）。词汇在根目录 `CONTEXT.md`
 * 「随机事件系统」节（随机事件定义 / 候选池 / 入池 / 触发 / 全局冷却 / 足迹 / 地点键）。
 */

// ═══════════════════════════════════════════════════════════
// 声明式条件 DSL（§3.1）
// ═══════════════════════════════════════════════════════════

/**
 * 条件 DSL —— **全部字段可选，同一对象内多字段 = AND**。
 *
 * 求值器在 `random-event-scheduler.evaluateEventCondition`，两条契约写在那里而不是这里
 * （类型只声明形状）：
 *   · **缺数据 = 假**（保守）—— 唯一的例外是 `var.exists === false`，它匹配的正是「不存在」
 *   · 认不出的多余字段一律忽略、绝不抛（定义来自第三方内容包）
 *
 * 🔴 `available`（硬门槛）与 `weights[].when`（情境权重）共用这一个类型，但语义不同，
 *    见 `RandomEventDef.available` 那条注释。
 */
export interface EventCondition {
  /** 地点键 + 位置路径全段的包含匹配（两者都比，见求值器） */
  location?: { anyOf?: string[]; noneOf?: string[] };
  /** 是否在途（`worldFlags.map.journey` 存在）*/
  journey?: boolean;
  playerLevel?: { gte?: number; lte?: number };
  time?: { seasonAnyOf?: string[]; timeOfDayAnyOf?: string[] };
  /** `path` 是点分路径，落在 `RandomEventRollContext.variables` 这棵树上 */
  var?: { path: string; eq?: unknown; gte?: number; lte?: number; exists?: boolean };
  quest?: { name: string; statusAnyOf: string[] };
  char?: { name: string; affectionGte?: number; affectionLte?: number };
  all?: EventCondition[];
  any?: EventCondition[];
  not?: EventCondition;
}

/**
 * 条件求值的**只读快照** —— 调度纯函数认识世界的唯一窗口。
 *
 * 🔴 **组装在接线层（StateManager 侧），不在纯函数叶**：组装要碰中文变量路径、SaveProfile
 *    与地图落位结果，理由同 `projectLocationFlags` 写在 state-manager 而非纯函数里
 *    （设计 §4.1 末条）。W1 只消费它。
 *
 * 🔴 **每一格都可缺席**，缺席时相关叶条件求值为假（不是「通过」）—— 一个还没接线的字段
 *    应该让事件**不触发**，而不是让全部事件无差别放行。
 */
export interface RandomEventRollContext {
  /** 地点键：落位成功 = 地块名，失败 = 位置路径最深段（§2 词汇表） */
  placeKey?: string;
  /** 位置路径全文（`CharacterState.location` 自由文本，`-` 分段） */
  locationPath?: string;
  journeyActive?: boolean;
  playerLevel?: number;
  /** 季节键 / 时段键 —— 引擎不认识它们的取值，只做串比较（同 `map-weather` 的 seasonKey） */
  season?: string;
  timeOfDay?: string;
  /** 变量树（通常是 `variables.sys` + `variables.user` 的合并只读视图） */
  variables?: Record<string, unknown>;
  /** 任务名 → 状态串 */
  quests?: Record<string, string>;
  /** 角色名 → 好感度 */
  affections?: Record<string, number>;
}

// ═══════════════════════════════════════════════════════════
// 事件定义（内容侧，纯数据）
// ═══════════════════════════════════════════════════════════

/** 权重修正链的一环：`when` 命中时把权重乘以 `multiply`（多条命中即连乘） */
export interface WeightModifier {
  when: EventCondition;
  multiply: number;
}

/**
 * 组装槽位表 —— 入池时**种子化抽一条**并固化进 brief（此后重放稳定）。
 *
 * `weights` 与 `pick` 按下标对齐；缺席 / 认不出的那一格读作 1（等权）。
 */
export interface SlotTable {
  pick: string[];
  weights?: number[];
}

/**
 * 地点过滤器。匹配的是**地点键**（地块名或位置路径最深段），不是 tileId ——
 * 足迹要在换图后存活，名字比编号稳定（§4.2）。
 *
 * 🔴 `anyOf` **必填且必须非空**（裁定 §13-3）：`first_visit` 只认作者点名的地块，
 *    「普通新地点不起事件」是有意语义，不是遗漏。
 */
interface PlaceFilter {
  anyOf: string[];
}

/**
 * 触发器。两种形态语义完全不同：
 * - `mtth`：平均每 `mtthDays` 天触发一次（权重 ×1 时），逐天掷骰 `p = min(1, w / mtthDays)`
 * - `first_visit`：`scope` 命中的地点首次到访时**强制入池**（绕过 MTTH 与全局冷却）
 */
export type RandomEventTrigger =
  { type: 'mtth'; mtthDays: number } | { type: 'first_visit'; scope: PlaceFilter };

/**
 * 一条随机事件定义。全部叙事字段是中文自由文本，**引擎零解释**。
 *
 * 🔴 `available`（硬门槛）vs `weights` ×0（情境权重）的分工（§3.1）：
 *    前者是「这个事件在本局叙事里存在吗」—— 不满足时**不掷骰、首访不选它、已入池的条目也撤下**；
 *    后者是「事件存在，只是此时此地概率为零」。首访事件没有权重链，`available` 是唯一能门住
 *    它的方式。撤下 forced 条目时**不记足迹** —— 条件重新满足后再次到达仍会强制入池。
 */
export interface RandomEventDef {
  /** 逻辑键（唯一），AI 面向；`<event_trigger name>` 逐字匹配它 */
  name: string;
  /** 默认 0；越大越优先（进注入块给 AI 参考 + 池满淘汰依据） */
  priority?: number;
  /** 给 AI 的事件简报，可含 `{{槽名}}` / `{{place}}` 占位（入池时替换固化） */
  brief: string;
  /** 更长的演绎指引（可选，注入块折叠展示）—— 只在 offer 里出现，不进 pending */
  detail?: string;
  trigger: RandomEventTrigger;
  available?: EventCondition;
  /** 全存档只触发一次（独特事件） */
  once?: boolean;
  /** 个体冷却（与全局冷却独立，可选） */
  cooldownDays?: number;
  /** 权重修正链，乘法叠加；任一 ×0 即不可触发 */
  weights?: WeightModifier[];
  /** 组装槽位：入池时种子化采样并固化进 brief */
  slots?: Record<string, SlotTable>;
}

// ═══════════════════════════════════════════════════════════
// 每存档状态（`worldFlags.randomEvents`，§3.2）
// ═══════════════════════════════════════════════════════════

/**
 * 候选池里的一条实例。
 *
 * 🔴 `brief` 是**已采样固化**的成品（入池即定型）—— 不是模板。每回合重新采样会让同一个
 *    候选在 AI 眼里每次都换一副面孔，且快照回退后对不上。
 */
export interface PendingRandomEvent {
  name: string;
  armedDay: number;
  /**
   * `armedDay + offerTtlDays`。
   * 🔴 **可选**：首访强制条目**不设过期**（缺席 = 永不过期），它的撤池条件是「离开该地点」
   *    或「`available` 不再满足」，而不是时间。用 `Number.MAX_SAFE_INTEGER` 冒充「不过期」
   *    会让「这条为什么还在池里」变成一道要读数字的谜题。
   */
  expiresDay?: number;
  /** 首访强制（永不被池满淘汰，永不因过期/权重 0 撤下） */
  forced?: boolean;
  /** 首访条目所属地点键（离开即撤池） */
  placeKey?: string;
  priority: number;
  brief: string;
}

/**
 * `SaveProfile.worldFlags.randomEvents` 的形状。全字段可选 —— 空袋是合法起点
 * （`getRandomEventFlags` 对存量存档返回 `{}`）。
 */
export interface RandomEventSaveFlags {
  /** 候选池（上限 `maxPending`，priority 高者留） */
  pending?: PendingRandomEvent[];
  /** 全局冷却锚点（gameDay 整数） */
  lastTriggerDay?: number;
  /** 已掷到哪一天（防漏掷/重掷；首次 ensure 时置当天，**不补历史**） */
  lastRollDay?: number;
  /** 首访足迹（地点键集合）—— 只在**触发时**记账，不在入池时（§4.2） */
  visited?: string[];
  /** 触发档案（`once` 与个体冷却的依据） */
  fired?: Record<string, { count: number; lastDay: number }>;
}

// ═══════════════════════════════════════════════════════════
// 内容包分节 + 配置（§3.3）
// ═══════════════════════════════════════════════════════════

/** pack 级配置（三态语义照旧：整节缺席 = 全用默认值） */
export interface RandomEventConfig {
  /** 任一事件触发后，所有 MTTH 掷骰暂停 N 天（首访强制不受限） */
  globalCooldownDays: number;
  /** 入池后多少天没被 AI 认领就过期（forced 条目不适用） */
  offerTtlDays: number;
  /** 候选池上限 */
  maxPending: number;
}

/**
 * 引擎兜底配置（裁定 §13-6：冷却 3 天 / TTL 5 天 / 池上限 3）。
 *
 * 🔴 **不冻结但也别改**：`coerceRandomEventPack` 只读它、每次返回**新对象**（照
 *    `createEmptyMapPack` 那条理由 —— 导出的引用被下游 push/改一次，此后所有走兜底
 *    路径的调用都被污染，而兜底恰恰是没人手工验的那条）。
 */
export const DEFAULT_RANDOM_EVENT_CONFIG: RandomEventConfig = {
  globalCooldownDays: 3,
  offerTtlDays: 5,
  maxPending: 3,
};

/**
 * `ContentPack.randomEvents` 分节（第 13 面）。
 *
 * `config` 是**部分覆盖**：只写 `maxPending` 的包，另外两项仍取默认值。
 */
export interface PackRandomEventsSection {
  config?: Partial<RandomEventConfig>;
  defs: RandomEventDef[];
}
