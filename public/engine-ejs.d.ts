/**
 * engine-ejs.d.ts —— 世界书 EJS 能力面 类型定义（创作者用）
 *
 * 把本文件放进你写世界书的项目里（或在 VSCode 里 `/// <reference path="engine-ejs.d.ts" />`），
 * 写 `<% %>` 里的代码时就有补全与类型检查了。
 *
 * 契约版本：1.1.0 —— 与 `engine.version` 对应。（1.1.0 新增 `$map` 只读地块面）
 * 创作者规范：`docs/reference/worldbook-ejs-regex-authoring-guide.md`
 * 设计记录：`docs/planning/2026-08-01-ejs-capability-surface-design.md`
 *
 * ## 三件事先记住
 * 1. **只有两个地方能写**：`vars`（与 AI 共写）和 `local`（当前存档的共享 EJS KV）。
 *    角色、物品、任务、资源都是**只读**的 —— 要改它们得让 AI 输出语义指令，EJS 改不动。
 * 2. 查询能力查不到时通常返回空串 / 空数组 / null / 0；你的 JavaScript 异常或预算超限
 *    仍会让当前条目回退原文。
 * 3. **随机要用 `rng` 不要用 `Math.random`** —— 只有 `rng` 在快照回退重放时结果一致。
 */

// ═══════════════════════════════════════════════════════════
// 轴① stats —— 只读数值面
// ═══════════════════════════════════════════════════════════

interface PoemItem {
  名字: string;
  类型: string;
  品质: string;
  数量: number;
  /** 空串 = 没装备 */
  装备槽位: string;
  描述: string;
}

interface PoemSkill {
  名字: string;
  类型: '主动' | '被动';
  等级: number;
  描述: string;
  剩余冷却: number;
}

interface PoemStatusEffect {
  名字: string;
  分类: '增益' | '减益' | '特殊';
  层数: number;
  /** `null` = 永久 */
  剩余时间: number | null;
  时间单位: '回合' | '分钟' | '小时';
  描述: string;
}

interface PoemAttributes {
  力量: number;
  敏捷: number;
  体质: number;
  智力: number;
  精神: number;
  /** 未分配点数 */
  属性点: number;
}

interface PoemPlayer {
  生命值: number;
  生命值上限: number;
  法力值: number;
  法力值上限: number;
  体力值: number;
  体力值上限: number;
  等级: number;
  生命层级: string;
  累计经验值: number;
  升级所需经验: number;
  属性: PoemAttributes;
  金钱: number;
  背包: PoemItem[];
  /** `{ 槽位: 物品名 }` —— 背包里已装备物品的索引视图 */
  装备: Record<string, string>;
  技能: PoemSkill[];
  状态效果: PoemStatusEffect[];
  登神长阶: {
    已开启: boolean;
    要素: string[];
    权能: string[];
    法则: string[];
    神位: string;
    神国: string;
  };
}

/**
 * 只读数值面。**必须只读**；修改不会提交游戏状态，条目间的 mutation 表现不属于契约。
 * 需要局部整理时先复制到自己的对象。
 */
declare const stats: {
  主角?: PoemPlayer;
  队伍?: Array<{
    名字: string;
    生命值: number;
    生命值上限: number;
    等级: number;
    生命层级: string;
    种族: string;
  }>;
  命运点数?: number;
  世界?: {
    时间?: string;
    时段?: string;
    回合?: number;
    天气?: string;
    地点?: string;
  };
};

// ═══════════════════════════════════════════════════════════
// 轴② vars —— 与 AI 共写的叙事变量空间
// ═══════════════════════════════════════════════════════════

/**
 * 叙事变量空间。任意形状、任意路径、跨回合持久。
 *
 * ⚠️ AI 也在写同一棵树。**路径冲突时 AI 覆盖你**。
 * ⚠️ 对象 key 不得包含点号；点号是持久化路径分隔符且没有转义语法。
 * ⚠️ 每个提交 pass 的差量有 256 KiB 上限，超了**整份丢弃**（不会只写一半）。
 */
declare const vars: Record<string, any>;

// ═══════════════════════════════════════════════════════════
// local —— 当前存档的共享 EJS KV
// ═══════════════════════════════════════════════════════════

/**
 * 当前 1.0 实现中，所有世界书 EJS 共用当前存档的 `builtin` 桶。
 * 它不是项目隔离或秘密存储；作者必须给 key 加唯一前缀，不得保存凭据。
 * key 不得包含点号；可使用下划线、连字符、冒号或 UUID。
 * 只有带 `ejsVarsCommit` 的 Agent 才会把改动持久化（默认仅 story）。
 *
 * 上限：单值 16 KiB，整个共享桶 64 KiB（UTF-8 JSON）。超了静默忽略并记诊断。
 *
 * ## 引擎会预置几个只读键（不占桶配额）
 * `local.get` / `getLocalVar` 查不到你自己写过的值时，会回落到引擎每回合供给的种子。
 * 目前只有一个：**`runtime_geo_compact_data`**（地理投影，给 `<runtime_geo>` 那类条目用）。
 * 它们出现在 `keys()` 里、`has()` 为真，但 `remove()` 删不掉（下一回合又会供上来）；
 * 用同名 `set()` 可以就地遮蔽成你自己的值。
 */
declare const local: {
  get(key: string, fallback?: any): any;
  set(key: string, value: any): void;
  has(key: string): boolean;
  remove(key: string): void;
  keys(): string[];
};

// ═══════════════════════════════════════════════════════════
// 只读查询
// ═══════════════════════════════════════════════════════════

interface PoemCharacter {
  名字: string;
  类型: 'player' | 'npc' | 'monster' | 'summon';
  种族: string;
  身份: string[];
  职业: string[];
  生命值: number;
  生命值上限: number;
  法力值: number;
  法力值上限: number;
  体力值: number;
  体力值上限: number;
  等级: number;
  生命层级: string;
  属性: Omit<PoemAttributes, '属性点'>;
  地点: string;
}

declare const char: {
  /** 可见集合由当前 Agent 上下文决定；不得假定一定包含全存档角色。 */
  player(): PoemCharacter | null;
  /** 按名字查；查不到返回 `null` */
  get(name: string): PoemCharacter | null;
  /** 当前还站着的 */
  present(): PoemCharacter[];
  all(): PoemCharacter[];
  has(name: string): boolean;
  /** -100 ~ +100；查不到的人返回 0 */
  affection(name: string): number;
  /** 好感度的文字标签；查不到返回空串 */
  affectionLabel(name: string): string;
};

declare const world: {
  /** 规范串，如 `<纪元名>0001年-05月-24日-周日-15:30`（纪元名由内容包供给） */
  时间: string;
  时间详情: {
    纪元: string;
    年: number;
    月: number;
    日: number;
    星期: number;
    时: number;
    分: number;
    时段: string;
  } | null;
  地点: string;
  天气: string;
  /** 回合号。取代上游的 `message_id` / `TavernHelper.getLastMessageId()` */
  回合: number;
  isDaytime(): boolean;
};

// ═══════════════════════════════════════════════════════════
// $map —— 只读地块事实（地图系统 v1）
// ═══════════════════════════════════════════════════════════

interface PoemMapPlace {
  /** 地块名。🔴 这一面的键名是 ASCII（不像 `world` 那边用中文键） */
  name: string;
  /** 地形词 —— 词汇由地图包定义，引擎不认识也不翻译 */
  terrain: string;
  /** `'sea'` / `'lake'` / `null`（陆块） */
  water: 'sea' | 'lake' | null;
  impassable: boolean;
  /** 所属中层（省 / 领）；`null` = 不属于任何中层，或包里查不到 */
  midTierName: string | null;
  /** 所属国家；`null` = 无主之地，或包里查不到 */
  countryName: string | null;
}

interface PoemMapNeighbor {
  name: string;
  terrain: string;
  /** 8 方罗盘令牌（ASCII）。中文说法自己查表：`{ N: '北', NE: '东北', … }` */
  dir: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
  water: 'sea' | 'lake' | null;
  impassable: boolean;
  /** **只在与当前地块异主时**才有值 —— 同主 / 无主一律 `null`（不必自己比对） */
  ownerName: string | null;
}

interface PoemMapJourney {
  /** 目的地地块名 */
  toName: string;
  /** 计划路线上的下一站；`null` = 队伍已偏离计划路线（计划只是建议，不是约束） */
  nextName: string | null;
  /** 按**当前位置**重估的剩余天数；`null` = 无路可走或还没落位 */
  remainingDays: number | null;
}

/**
 * 当前位置的地块事实：当前块 + 严格一跳邻接 + 天气 + 在途。
 *
 * ⚠️ 没装地图包、或玩家位置还没落到某个地块上时，`currentTile` 是 `null`、
 * `neighbors` 是空数组 —— 请写 `<% if ($map.currentTile) { %>…<% } %>`，不要假设它一定有值。
 *
 * 这一面**没有函数**（所以没有 `ownerOf()`）：所有者已经在 `countryName` / `ownerName` 里。
 * 也**永远不会**给你地块 id 或像素坐标 —— 只有名字与关系。
 */
declare const $map: {
  currentTile: PoemMapPlace | null;
  /** 顺序稳定（同一份包同一个位置每回合同序）—— 别自己重排，那会让提示词前缀抖动 */
  neighbors: PoemMapNeighbor[];
  /** 天气标签（与 `world.天气` 同一个值）；`null` = 没有 */
  weatherNow: string | null;
  journey: PoemMapJourney | null;
  /** 上一次移动跨越的跳数（`1` = 相邻的正常移动）；`null` = 没有这条事实 */
  discontinuity: number | null;
};

interface PoemQuest {
  名字: string;
  状态: string;
  /** 任务详情 */
  描述: string;
  /** 引擎里的目标是**一条**描述，这里统一包成数组；没写目标时是空表 */
  目标: unknown[];
  进度: unknown;
  /** 同 `目标`：一条奖励描述包成数组，没写时空表 */
  奖励: unknown[];
  /** 关注度：`高` / `中` / `低`；没写返回空串 */
  关注度: string;
}

declare const quest: {
  all(): PoemQuest[];
  active(): PoemQuest[];
  get(name: string): PoemQuest | null;
  has(name: string): boolean;
  /** 玩家选中的焦点任务 */
  focus(): PoemQuest | null;
};

/**
 * 读另一条世界书条目的**原文**（不会嵌套求值它里面的 EJS）。
 *
 * ⚠️ 只能读**当前 Agent 可见**的条目 —— 不可见时返回空串，请写 `if (!text) { …降级… }`。
 * ⚠️ 每个条目最多调 8 次 `get`，超出返回空串。`has` 不占额度。
 */
declare const lore: {
  /** `lore.get('条目名')` 全局找第一条；`lore.get('书名', '条目名')` 限定书 */
  get(entryNameOrBook: string, entryName?: string): string;
  has(entryNameOrBook: string, entryName?: string): boolean;
  list(bookName: string): string[];
};

/**
 * 读最近的聊天正文。
 *
 * 稳定保证只覆盖当前 Agent 的历史注入窗口；不得依赖窗口外消息。
 */
declare const chat: {
  /** `chat.last('user')` = 玩家最近说的话 */
  last(role?: 'user' | 'assistant'): string;
  /** 负数从末尾数：`-1` = 最新 */
  at(index: number, role?: 'user' | 'assistant'): string;
  slice(start: number, end: number, role?: 'user' | 'assistant'): string[];
  /** 窗口内是否命中（字符串子串或正则） */
  match(pattern: string | RegExp): boolean;
  text(): string;
};

// ═══════════════════════════════════════════════════════════
// 纯工具
// ═══════════════════════════════════════════════════════════

/**
 * 格式化。
 *
 * 🔴 排版数字、排序名字请**一律走这里**，别用 `toLocaleString` / `localeCompare` ——
 * 那些的本地化行为在不同求值后端下不一致（见设计 §3.14）。
 */
declare const fmt: {
  /** YAML 序列化。喂 AI 的结构化数据推荐用它（比 JSON 省 token） */
  yaml(
    value: unknown,
    opts?: { blockQuote?: 'literal' | 'folded' | boolean; indent?: number },
  ): string;
  json(value: unknown, indent?: number): string;
  /** Markdown 表格 */
  table(rows: unknown[], columns?: string[]): string;
  list(items: unknown[], bullet?: string): string;
  /** 千分位。`fmt.num(1234567)` → `'1,234,567'` */
  num(n: unknown, digits?: number): string;
  /** `fmt.pct(0.735)` → `'73.5%'` */
  pct(n: unknown, digits?: number): string;
  /** `fmt.bar(5, 10)` → `'█████░░░░░ 50%'` */
  bar(value: unknown, max: unknown, width?: number): string;
  pad(s: unknown, width: number, align?: 'left' | 'right' | 'center'): string;
  truncate(s: unknown, max: number, ellipsis?: string): string;
  /** 中文友好比较（`第2章` 排在 `第10章` 前）。**不依赖 localeCompare** */
  compareName(a: unknown, b: unknown): number;
  sortNames(names: unknown[]): string[];
};

/**
 * 种子随机。
 *
 * 🔴 **用这个，不要用 `Math.random`**：只有 `rng` 在玩家快照回退重放时给出同样的结果，
 * 否则同一个存档点会看到不同的世界书内容。
 */
declare const rng: {
  /** `rng.roll('1d100')` / `'2d6+3'`；公式不合法返回 0 */
  roll(formula: string): number;
  rollDetail(formula: string): { 总计: number; 骰值: number[]; 修正: number };
  /** 闭区间整数 */
  int(min: number, max: number): number;
  float(): number;
  pick<T>(items: T[]): T | undefined;
  /** 不重复抽 n 个 */
  pickN<T>(items: T[], n: number): T[];
  shuffle<T>(items: T[]): T[];
  /** `rng.chance(0.3)` = 三成概率 */
  chance(p: number): boolean;
};

/**
 * 生产 QuickJS 的 25 方法兼容子集；不要依赖 Legacy 独有的
 * `toPath` / `isFunction` / `random` / `sample`。写请用 `vars` / `local`。
 */
declare const _: any;

// ═══════════════════════════════════════════════════════════
// 带外 / 元信息
// ═══════════════════════════════════════════════════════════

/**
 * 给**玩家**看的东西。这些**不会进提示词**，AI 看不到。
 *
 * ⚠️ `notify` 每个 EJS 条目最多 3 条且同文去重；提示会带「内容说：」前缀，
 * 这样玩家一眼能分清是世界书在说话还是引擎在说话。
 */
declare const ui: {
  notify(message: string, level?: 'info' | 'success' | 'warning' | 'error'): void;
  /** 调试日志。进调试面板，不刷浏览器控制台 */
  log(...args: unknown[]): void;
};

/**
 * 版本与能力探测。
 *
 * 写「有就用、没有就退」的内容时用它，别靠 `try/catch` 猜：
 * ```ejs
 * <% const 背包 = engine.has('stats.主角.背包') ? stats.主角.背包 : []; %>
 * ```
 */
declare const engine: {
  name: 'poem-of-destiny';
  /** 语义化版本，如 `'1.0.0'` */
  version: string;
  has(path: string): boolean;
};

// ═══════════════════════════════════════════════════════════
// EJS 自带
// ═══════════════════════════════════════════════════════════

/** 直接往输出里推一段文本（等价于 `<%= %>`，但可以在循环里用） */
declare function print(value: unknown): void;

// ═══════════════════════════════════════════════════════════
// 兼容别名（存量 SillyTavern 内容用；新内容请用上面的能力）
// ═══════════════════════════════════════════════════════════

/** @deprecated 用 `stats` / `vars` */
declare function getMessageVar(path: string, opts?: { defaults?: any }): any;
/** @deprecated 用 `vars` */
declare function setMessageVar(path: string, value: any): void;
/** @deprecated 用 `stats` / `vars` */
declare function getvar(key: string, opts?: { defaults?: any }): any;
/** @deprecated 用 `vars` */
declare function setvar(key: string, value: any): void;
/** @deprecated 用 `local.get` */
declare function getLocalVar(key: string, opts?: { defaults?: any }): any;
/** @deprecated 用 `local.set` */
declare function setLocalVar(key: string, value: any): void;
/** @deprecated 用 `chat.match` */
declare function matchChatMessages(pattern: string | RegExp): boolean;
/** @deprecated 用 `chat.at` */
declare function getChatMessage(index: number, role?: string): string;
/** @deprecated 用 `chat.slice` */
declare function getChatMessages(start: number, end: number, role?: string): string;
/** @deprecated 用 `lore.get` */
declare function getwi(bookName: string, entryName?: string): string;
/** @deprecated 用 `fmt.yaml` */
declare const YAML: { stringify(value: unknown, opts?: unknown): string };
/** @deprecated 用 `ui.notify` */
declare const toastr: {
  info(msg: string): void;
  success(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
};
/** @deprecated 用 `ui.notify`（本函数**不会**阻塞，只是弹个提示） */
declare function alert(message: string): void;
/** @deprecated 用 `world.回合` */
declare const message_id: number;
/** @deprecated 用 `world.回合` */
declare const lastMessageId: number;
/** @deprecated 用 `world.回合` / `variables` */
declare const TavernHelper: {
  getLastMessageId(): number;
  getVariables(opts?: unknown): { stat_data: Record<string, any> };
};
/**
 * @deprecated 用 `local`。这**不是**浏览器 localStorage，而是当前存档的共享 EJS KV；
 * 与输出美化 iframe 的 `localStorage` / `regexStorage` 也不是同一个空间。
 */
declare const localStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};
/** @deprecated 用 `ui.log` */
declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
/** 当前角色绑定的世界书名 */
declare const charLoreBook: string;
/** @deprecated 用 `stats` / `vars` */
declare const variables: { stat_data: Record<string, any> };
