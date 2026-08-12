/**
 * ejs-capabilities.ts —— 引擎侧能力面（能力面设计 §3.3-§3.8 / §3.11-§3.12，切片 T4+T5）
 *
 * 建 `chat` / `char` / `world` / `quest` / `lore` / `local` / `ui` / `engine` 八个命名空间。
 * 纯函数模块：**不碰 Dexie、不碰 Vue、不发请求**——需要引擎数据时一律经 `EjsCapabilityInput`
 * 由调用方喂进来（注入缝口径同 audio / asset 两个子系统）。
 *
 * ## 三条贯穿全文件的规矩
 * 1. **永不抛**（设计 P1/P3）：缺参、越界、不可见一律给安全默认值（`''`/`[]`/`{}`/`null`/`0`）。
 *    抛异常会把整条目推去 D8 回退，而回退的观感是**模板源码直喂 AI**，比一个空值糟得多。
 * 2. **只读即孤儿**（P4）：所有查询返回深拷贝，创作者就地改不回流引擎。
 * 3. **写只有两个口**（P2）：`local`（私有 KV）与 `vars`（共写草稿）。
 *    角色 / 物品 / 任务 / 资源一律只读 —— 那些走 AI 语义 op 与 `StateManager`（ADR-21）。
 */

import type { CharacterState, Quest } from './types';
import { formatGameTime, getTimeOfDay, type GameTime } from './time-system';
import { getAffectionLabel } from './affection-system';
import { DANGEROUS_PATH_SEGMENTS } from './var-resolver';
// 地图 v1 §5：`$map` 的数据形状。**type-only** —— 快照由调用方算好交进来，
// 本模块不 import `map-runtime` / `map-index`（能力面是纯投影，不碰注入缝也不建索引）。
import type {
  MapSnapshot,
  MapSnapshotJourney,
  MapSnapshotNeighbor,
  MapSnapshotPlace,
} from './map-context';

// ═══════════════════════════════════════════════════════════
// 注入面
// ═══════════════════════════════════════════════════════════

/** 世界书条目查询回调 —— 由调用方按 **Agent 可见性分区** 实现（§3.7 边界，安全相关） */
export interface LoreLookup {
  /** 找条目正文；不可见/不存在返回 `null`。`bookName` 省略 = 全局按名找第一条 */
  get(entryName: string, bookName?: string): string | null;
  /** 列出某本书的条目名；不可见返回 `[]` */
  list(bookName: string): string[];
}

/** 能力面的全部外部输入。字段全可选 —— 缺哪块哪块降级，不影响其余 */
export interface EjsCapabilityInput {
  /** 注入窗口内的聊天层（**不是全部聊天记录**，§3.8 明确降级） */
  history?: Array<{ role: string; content: string }>;
  /** 本 Agent 上下文可见的角色 */
  characters?: CharacterState[];
  /**
   * 好感度表（**角色名字** → -100..100）。
   *
   * 🔴 键是名字不是 id —— `SaveProfile.affections` 由 `state-manager` 按 `charName` 写入
   * （改名迁移也按名字搬键）。早先这里按 `c.id` 取，真实存档一次都取不中、永远返回 0。
   */
  affections?: Record<string, number>;
  gameTime?: GameTime;
  /** 任务表（名字 → Quest） */
  quests?: Record<string, Quest>;
  /** 玩家选中的焦点任务名 */
  focusQuest?: string;
  turn?: number;
  weather?: string;
  /**
   * 地图只读快照（`map-context.buildMapSnapshot()` 的产出）——`$map` 的全部数据（地图 v1 §5）。
   *
   * 不给（空包 / 从未落位 / 老调用方）→ `$map` 各格为空值而**不是** `undefined`：
   * 世界书 EJS 照常能写 `if ($map.currentTile)`，不必先判 `typeof $map`。
   */
  mapSnapshot?: MapSnapshot;
  /**
   * 引擎供给的**只读**局部变量种子：`local.get` / `getLocalVar` 查不到自己写的那份时回落到这里。
   *
   * 为什么不直接 `local.set` 一份：`local` 的桶落在 `vars._local.<projectId>` 里，
   * 而 `vars` 是**共写草稿**——写进去会经 `ejs-vars-diff` 落进存档变量，等于每回合把一份
   * 引擎随时能重算的派生数据持久化一遍（地图投影动辄几 KB，还会顶到 `LOCAL_PROJECT_MAX_BYTES`）。
   * 种子是**读侧回落层**：不落库、不进 diff，条目照旧可以用同名 `local.set` 就地遮蔽它。
   *
   * 🔴 **不按项目隔离**（与桶相反）：种子是引擎供的事实（如 `runtime_geo_compact_data`），
   *    不是某个项目的私有状态；写仍然各归各的项目。
   */
  localSeed?: Record<string, unknown>;
  /** 当前角色绑定的世界书名（上游 `charLoreBook` 别名的来源） */
  charLoreBook?: string;
  /** 世界书查询（不给 = `lore.*` 全部返回空） */
  lore?: LoreLookup;
  /** 本条目所属项目 id —— `local` KV 的命名空间。内置书用 `'builtin'` */
  projectId?: string;
  /** 给玩家的提示出口（不给 = 静默丢弃，绝不抛） */
  notify?: (message: string, level: 'info' | 'success' | 'warning' | 'error') => void;
  /** 调试日志出口（不给 = 丢弃，**绝不落真 console**，免得刷屏） */
  log?: (args: unknown[]) => void;
  /** 引擎版本号（`engine.version`） */
  engineVersion?: string;
}

// ═══════════════════════════════════════════════════════════
// 预算（§6.2）
// ═══════════════════════════════════════════════════════════

/** 每 pass 最多 3 条提示 + 同文去重 —— 装配一次刷屏比不提示更糟 */
export const NOTIFY_PER_PASS = 3;
/** 调试日志环形上限 */
export const LOG_PER_PASS = 512;
/** 单条目 `lore.get` 次数上限（防「绕过激活机制的全量注入」，§12 待拷问 2） */
export const LORE_GET_PER_ENTRY = 8;
/** 单次 `lore.get` 返回上限 */
export const LORE_GET_MAX_CHARS = 64 * 1024;
/** `local` 单键 / 单项目上限 */
export const LOCAL_KEY_MAX_BYTES = 16 * 1024;
export const LOCAL_PROJECT_MAX_BYTES = 64 * 1024;
/** `local` KV 在草稿里的落点（`vars._local.<projectId>.<key>`，随快照回退天然覆盖） */
export const LOCAL_ROOT = '_local';

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

/** 深拷贝纯数据（只读孤儿契约）；非纯数据原样带过 */
function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>)) {
    if (DANGEROUS_PATH_SEGMENTS.has(k)) continue;
    out[k] = clone((v as Record<string, unknown>)[k]);
  }
  return out as unknown as T;
}

function byteLength(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;
}

// ═══════════════════════════════════════════════════════════
// chat（§3.8）
// ═══════════════════════════════════════════════════════════

export interface EjsChat {
  last(role?: string): string;
  at(index: number, role?: string): string;
  slice(start: number, end: number, role?: string): string[];
  match(pattern: unknown): boolean;
  text(): string;
}

function buildChat(input: EjsCapabilityInput, historyText: string): EjsChat {
  const all = Array.isArray(input.history) ? input.history : [];
  const pick = (role?: string): Array<{ role: string; content: string }> =>
    role ? all.filter((m) => m.role === role) : all;

  const at = (index: number, role?: string): string => {
    const list = pick(role);
    const i = Number(index);
    if (!Number.isFinite(i)) return '';
    // 负数从末尾数：-1 = 最新（对齐上游 getChatMessage(-1, 'user')）
    const idx = i < 0 ? list.length + i : i;
    return list[idx]?.content ?? '';
  };

  return {
    last: (role) => at(-1, role),
    at,
    slice: (start, end, role) => {
      const list = pick(role);
      const s = Number(start);
      const e = Number(end);
      if (!Number.isFinite(s) || !Number.isFinite(e)) return [];
      return list
        .slice(s < 0 ? list.length + s : s, e < 0 ? list.length + e : e)
        .map((m) => m.content);
    },
    match: (pattern) => {
      const text = historyText ?? '';
      if (typeof pattern === 'string') return text.includes(pattern);
      if (pattern instanceof RegExp) {
        // 剥 g/y：带 lastIndex 的正则连续 test 结果会漂移
        return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(text);
      }
      return false;
    },
    text: () => historyText ?? '',
  };
}

// ═══════════════════════════════════════════════════════════
// char（§3.4）
// ═══════════════════════════════════════════════════════════

/** 角色只读投影（与 `stats.主角` 同构 + 身份信息） */
function projectChar(c: CharacterState): Record<string, any> {
  return {
    名字: c.name,
    类型: c.type,
    种族: c.race ?? '',
    身份: clone(c.identity ?? []),
    职业: clone(c.occupation ?? []),
    生命值: c.hp,
    生命值上限: c.maxHp,
    法力值: c.mp,
    法力值上限: c.maxMp,
    体力值: c.sp,
    体力值上限: c.maxSp,
    等级: c.level,
    生命层级: c.tierName,
    属性: {
      力量: c.attributes?.str ?? 0,
      敏捷: c.attributes?.dex ?? 0,
      体质: c.attributes?.con ?? 0,
      智力: c.attributes?.int ?? 0,
      精神: c.attributes?.spi ?? 0,
    },
    地点: c.location ?? '',
  };
}

export interface EjsChar {
  player(): Record<string, any> | null;
  get(name: string): Record<string, any> | null;
  present(): Array<Record<string, any>>;
  all(): Array<Record<string, any>>;
  has(name: string): boolean;
  affection(name: string): number;
  affectionLabel(name: string): string;
}

function buildChar(input: EjsCapabilityInput): EjsChar {
  const chars = Array.isArray(input.characters) ? input.characters : [];
  const find = (name: string): CharacterState | undefined => {
    const key = String(name ?? '').trim();
    if (!key) return undefined;
    return chars.find((c) => c.name === key);
  };

  return {
    player: () => {
      const p = chars.find((c) => c.type === 'player');
      return p ? projectChar(p) : null;
    },
    get: (name) => {
      const c = find(name);
      return c ? projectChar(c) : null;
    },
    // 「在场」= 还站着。判宽了最多多列一个，判窄了会漏掉该出场的人
    present: () => chars.filter((c) => c.hp > 0).map(projectChar),
    all: () => chars.map(projectChar),
    has: (name) => find(name) !== undefined,
    // 好感表按**名字**索引（见 EjsCapabilityInput.affections）。这里仍先经 find() 解析一道，
    // 是为了让别名/空白等入参归一化后再查表，且查不到的人稳稳落回 0 / ''。
    affection: (name) => {
      const c = find(name);
      if (!c) return 0;
      const v = input.affections?.[c.name];
      return typeof v === 'number' ? v : 0;
    },
    affectionLabel: (name) => {
      const c = find(name);
      if (!c) return '';
      const v = input.affections?.[c.name];
      return getAffectionLabel(typeof v === 'number' ? v : 0);
    },
  };
}

// ═══════════════════════════════════════════════════════════
// world（§3.5）
// ═══════════════════════════════════════════════════════════

/**
 * 游戏时间的分解投影。**中文字段名逐字保留** —— 它是创作者契约的一部分（Q-09）。
 */
export interface EjsWorldTimeDetail {
  纪元: string;
  年: number;
  月: number;
  日: number;
  星期: number;
  时: number;
  分: number;
  时段: string;
}

/**
 * `world` namespace（§3.5）。
 *
 * Q-09：此前是 `Record<string, any>`，于是「`isDaytime` 是函数，过 JSON 编组会整个
 * 丢掉」这件事只能写在 QuickJS 后端的注释里 —— guest 里调它抛 TypeError、整条目回退
 * 原文，而 Legacy 下工作正常，两个后端渲染出不同字节且都报 ok。
 * 有了类型，那条分界就能写成 {@link marshalWorld} 这个有签名的函数。
 */
export interface EjsWorld {
  时间: string;
  时间详情: EjsWorldTimeDetail | null;
  地点: string;
  天气: string;
  回合: number;
  isDaytime(): boolean;
}

/**
 * `world` 过 JSON 边界时的显式分界（Q-09）。
 *
 * `data` 是能安全序列化的部分；`isDaytime` 求值成布尔常量随之过去，
 * guest 侧据它装一个返回常量的 shim。此前这条分界散在 `installCapabilities` 的两段注释里。
 */
export function marshalWorld(w: EjsWorld): {
  data: Omit<EjsWorld, 'isDaytime'>;
  isDaytime: boolean;
} {
  const { isDaytime, ...data } = w;
  return { data, isDaytime: isDaytime.call(w) };
}

function buildWorld(input: EjsCapabilityInput): EjsWorld {
  const t = input.gameTime;
  const player = (input.characters ?? []).find((c) => c.type === 'player');
  return {
    时间: t ? formatGameTime(t) : '',
    时间详情: t
      ? {
          纪元: t.era,
          年: t.year,
          月: t.month,
          日: t.day,
          星期: t.weekday,
          时: t.hour,
          分: t.minute,
          时段: getTimeOfDay(t),
        }
      : null,
    地点: player?.location ?? '',
    天气: input.weather ?? '',
    // 取代上游 `message_id` / `TavernHelper.getLastMessageId()`
    回合: input.turn ?? 0,
    isDaytime: () => (t ? t.hour >= 6 && t.hour < 18 : true),
  };
}

// ═══════════════════════════════════════════════════════════
// $map（地图 v1 §5 / §8.1）—— 只读地块事实
// ═══════════════════════════════════════════════════════════

/**
 * `$map` namespace（地图 v1 §5）。story 的 `MAP_CONTEXT` 世界书条目就从这里渲染。
 *
 * 🔴 **刻意全是数据、一个函数都没有**（所以设计里那个 `ownerOf()` 不在这里）：
 *    函数过不了 JSON 编组 —— `world.isDaytime` 就是这么在 QuickJS 下抛 `not a function`
 *    而在 Legacy 下工作正常的（Q-09）。所有者信息已经在 `currentTile.countryName` 与
 *    `neighbors[].ownerName` 里，给一个查询函数只会换来一条两后端不一致的路。
 * 🔴 名字全是 ASCII（`world` 那边是中文键）：这一面的**数据**来自 pack（换图即换词汇），
 *    只有键名是引擎契约；`map-*.ts` 的结构闸门禁 CJK 字面量，键名跟着一起保持 ASCII，
 *    渲染层（占位符 / 世界书条目）自己查中文表。
 * 🔴 AI 永远看不到 tileId 与像素坐标（§8.3）—— `MapSnapshot` 本身就不带这两样，
 *    本层原样转发，不做「顺手补一个 id 方便调试」那种事。
 */
interface EjsMap {
  /** 当前地块；`null` = 空包 / 从未成功落位（渲染层写「未定位」，不是错误） */
  currentTile: MapSnapshotPlace | null;
  /** 严格一跳邻接，顺序稳定（权威在 `map-index.buildNeighbors`）；未落位时空数组 */
  neighbors: MapSnapshotNeighbor[];
  /** 天气标签串（包词汇原文）；`null` = 这一格不写 */
  weatherNow: string | null;
  /** 在途摘要；`null` = 不在途 */
  journey: MapSnapshotJourney | null;
  /**
   * 上一次移动跨越的跳数（`1` = 相邻的正常移动）；`null` = 没有这条事实。
   *
   * 在表里是因为 `MAP_CONTEXT` 的**提示行**（§8.1 四类行的第四类）只有它能渲染 ——
   * 少了这一格，渲染层要么印不出那行，要么去别处再找一遍同一个事实。
   */
  discontinuity: number | null;
}

/**
 * 快照 → `$map`。
 *
 * 空快照与「有快照但没落位」走同一条出口（合同不是异常，见 `MapSnapshot` 的说明）。
 * 深拷贝是只读孤儿契约（P4）：条目改了返回值不会漏进下一个条目，也漏不回宿主那份输入。
 */
function buildMap(input: EjsCapabilityInput): EjsMap {
  const snap = input.mapSnapshot;
  const neighbors = snap?.neighbors;
  return {
    currentTile: snap?.current ? clone(snap.current) : null,
    neighbors: Array.isArray(neighbors) ? clone(neighbors) : [],
    weatherNow: snap?.weatherLabel ?? null,
    journey: snap?.journey ? clone(snap.journey) : null,
    discontinuity: snap?.discontinuity ?? null,
  };
}

// ═══════════════════════════════════════════════════════════
// quest（§3.6）
// ═══════════════════════════════════════════════════════════

/**
 * 任务只读投影。
 *
 * 🔴 字段一律取 `Quest`（types.ts）的**真字段**：`status` / `detail` / `objective` /
 * `progress` / `reward` / `priority`。早先这里读的是 `description` / `objectives` /
 * `rewards` —— 引擎里根本没有这三个字段，真实任务表投出来永远是 描述 '' / 目标 [] / 奖励 []。
 *
 * `objective` / `reward` 在引擎里是**单数串**，但契约（`public/engine-ejs.d.ts`）承诺数组，
 * 故在这里包一层（空串 → 空表，创作者的 `for` 循环天然跳过）。
 */
function projectQuest(name: string, q: Quest): Record<string, any> {
  const anyQ = q as unknown as Record<string, any>;
  /** 取第一个非空串（中文键兜底：存量内容可能直接塞中文键的任务对象） */
  const pickStr = (...keys: string[]): string => {
    for (const k of keys) {
      const v = anyQ[k];
      if (typeof v === 'string' && v !== '') return v;
    }
    return '';
  };
  /** 单值 → 数组（已是数组则原样深拷贝） */
  const toList = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return clone(v);
    if (v === undefined || v === null || v === '') return [];
    return [clone(v)];
  };
  return {
    名字: name,
    状态: pickStr('status', '状态'),
    描述: pickStr('detail', '详情', '描述'),
    目标: toList(anyQ['objective'] ?? anyQ['目标']),
    进度: anyQ['progress'] ?? anyQ['进度'] ?? '',
    奖励: toList(anyQ['reward'] ?? anyQ['奖励']),
    关注度: pickStr('priority', '关注度'),
  };
}

export interface EjsQuest {
  all(): Array<Record<string, any>>;
  active(): Array<Record<string, any>>;
  get(name: string): Record<string, any> | null;
  has(name: string): boolean;
  focus(): Record<string, any> | null;
}

function buildQuest(input: EjsCapabilityInput): EjsQuest {
  const table = input.quests ?? {};
  const entries = (): Array<[string, Quest]> => Object.entries(table);
  const isActive = (q: Quest): boolean => {
    const s = String((q as unknown as Record<string, any>)['status'] ?? '');
    return s === '进行中' || s === 'active' || s === '';
  };

  return {
    all: () => entries().map(([n, q]) => projectQuest(n, q)),
    active: () =>
      entries()
        .filter(([, q]) => isActive(q))
        .map(([n, q]) => projectQuest(n, q)),
    get: (name) => {
      const key = String(name ?? '');
      const q = table[key];
      return q ? projectQuest(key, q) : null;
    },
    has: (name) => Object.prototype.hasOwnProperty.call(table, String(name ?? '')),
    focus: () => {
      const key = input.focusQuest;
      if (!key) return null;
      const q = table[key];
      return q ? projectQuest(key, q) : null;
    },
  };
}

// ═══════════════════════════════════════════════════════════
// lore（§3.7）—— 跨条目读，**受可见性约束**
// ═══════════════════════════════════════════════════════════

export interface EjsLore {
  get(a: string, b?: string): string;
  has(a: string, b?: string): boolean;
  list(bookName: string): string[];
}

function buildLore(input: EjsCapabilityInput): EjsLore {
  let budget = LORE_GET_PER_ENTRY;
  const lookup = input.lore;

  /**
   * 两种调用形态都收：
   * - `lore.get(书名, 条目名)` —— 上游 `getwi(book, entry)` 的形状
   * - `lore.get(条目名)`      —— 全局按名找第一条
   */
  const resolve = (a: string, b?: string): string | null => {
    if (!lookup) return null;
    const first = String(a ?? '');
    if (!first) return null;
    return b === undefined ? lookup.get(first) : lookup.get(String(b), first);
  };

  return {
    get: (a, b) => {
      // 预算耗尽即静默返回空 —— 内容会走自己的 `if (!wbEntry)` 降级分支（语料实测写法）
      if (budget <= 0) return '';
      budget--;
      const text = resolve(a, b);
      if (typeof text !== 'string') return '';
      return text.length > LORE_GET_MAX_CHARS ? text.slice(0, LORE_GET_MAX_CHARS) : text;
    },
    // has 不吃预算：它是判断，不是注入
    has: (a, b) => typeof resolve(a, b) === 'string',
    list: (bookName) => {
      if (!lookup) return [];
      const list = lookup.list(String(bookName ?? ''));
      return Array.isArray(list) ? list.slice() : [];
    },
  };
}

// ═══════════════════════════════════════════════════════════
// local（§3.3）—— 条目私有持久 KV，取代上游 localStorage
// ═══════════════════════════════════════════════════════════

export interface EjsLocal {
  get(key: string, fallback?: unknown): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  remove(key: string): void;
  keys(): string[];
}

function buildLocal(vars: Record<string, any>, input: EjsCapabilityInput, ui: EjsUi): EjsLocal {
  const projectId = String(input.projectId ?? 'builtin');

  /**
   * 引擎供的只读种子（`EjsCapabilityInput.localSeed`）。
   *
   * 读优先级：**本项目自己写过的桶 > 种子 > 调用方的 fallback**。桶在前是关键 ——
   * 条目用同名 `local.set` 就地遮蔽引擎值这条路必须留着（种子是缺省，不是强制）。
   * `remove` 只删桶里那份，删完又读回种子：种子每回合由引擎重新供给，
   * 「删得掉」是一句守不住的承诺。
   */
  const seedOf = (key: string): unknown => {
    const seed = input.localSeed;
    if (seed === null || typeof seed !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(seed, key) ? seed[key] : undefined;
  };

  /** 取（或建）本项目的 KV 子树。落在 `vars` 下 → 随快照回退天然覆盖 */
  const bucket = (create: boolean): Record<string, unknown> | undefined => {
    if (DANGEROUS_PATH_SEGMENTS.has(projectId)) return undefined;
    let root = vars[LOCAL_ROOT];
    if (root === null || typeof root !== 'object') {
      if (!create) return undefined;
      root = {};
      vars[LOCAL_ROOT] = root;
    }
    let own = (root as Record<string, any>)[projectId];
    if (own === null || typeof own !== 'object') {
      if (!create) return undefined;
      own = {};
      (root as Record<string, any>)[projectId] = own;
    }
    return own as Record<string, unknown>;
  };

  const safeKey = (key: unknown): string | null => {
    const k = String(key ?? '');
    if (!k || DANGEROUS_PATH_SEGMENTS.has(k)) return null;
    return k;
  };

  return {
    get: (key, fallback) => {
      const k = safeKey(key);
      if (!k) return fallback ?? null;
      const own = bucket(false);
      const v = own?.[k];
      if (v !== undefined) return clone(v);
      const seeded = seedOf(k);
      return seeded === undefined ? (fallback ?? null) : clone(seeded);
    },
    set: (key, value) => {
      const k = safeKey(key);
      if (!k) return;
      let serialized: string;
      try {
        serialized = JSON.stringify(value) ?? '';
      } catch {
        ui.log(['[local] 值不可序列化，已忽略：', k]);
        return;
      }
      if (byteLength(serialized) > LOCAL_KEY_MAX_BYTES) {
        ui.log(['[local] 单键超限，已忽略：', k]);
        return;
      }
      const own = bucket(true);
      if (!own) return;
      const projected = { ...own, [k]: value };
      let projectedSize = 0;
      try {
        projectedSize = byteLength(JSON.stringify(projected) ?? '');
      } catch {
        projectedSize = Number.POSITIVE_INFINITY;
      }
      if (projectedSize > LOCAL_PROJECT_MAX_BYTES) {
        ui.log(['[local] 项目总量超限，已忽略：', k]);
        return;
      }
      own[k] = clone(value);
    },
    has: (key) => {
      const k = safeKey(key);
      if (!k) return false;
      const own = bucket(false);
      if (own !== undefined && own[k] !== undefined) return true;
      // 种子也算「有」—— 否则 `if (local.has(k)) local.get(k)` 这种守卫写法
      // 会把引擎供的值挡在门外，而 `get` 明明取得到（两个答案不一致，且无声）
      return seedOf(k) !== undefined;
    },
    remove: (key) => {
      const k = safeKey(key);
      if (!k) return;
      const own = bucket(false);
      if (own) delete own[k];
    },
    keys: () => {
      const own = Object.keys(bucket(false) ?? {});
      const seed = input.localSeed;
      if (seed === null || typeof seed !== 'object') return own;
      // 桶在前、种子补后：与 `get` 的优先级同序，且已被遮蔽的种子键不重复出现
      return [...own, ...Object.keys(seed).filter((k) => !own.includes(k))];
    },
  };
}

// ═══════════════════════════════════════════════════════════
// ui（§3.11）—— 带外通道，**不进提示词一个字节**
// ═══════════════════════════════════════════════════════════

export interface EjsUi {
  notify(message: string, level?: 'info' | 'success' | 'warning' | 'error'): void;
  log(...args: unknown[]): void;
}

function buildUi(input: EjsCapabilityInput): EjsUi {
  let notifyBudget = NOTIFY_PER_PASS;
  let logBudget = LOG_PER_PASS;
  const seen = new Set<string>();

  return {
    notify: (message, level = 'info') => {
      const text = String(message ?? '').trim();
      if (!text) return;
      // 同文去重 + 限频：装配一次刷三条以上就是骚扰
      if (seen.has(text) || notifyBudget <= 0) return;
      seen.add(text);
      notifyBudget--;
      try {
        input.notify?.(text, level);
      } catch {
        // 宿主 toast 挂了不该连累条目
      }
    },
    log: (...args) => {
      if (logBudget <= 0) return;
      logBudget--;
      try {
        input.log?.(args);
      } catch {
        /* 同上 */
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// engine（§3.12）—— 版本与能力探测
// ═══════════════════════════════════════════════════════════

/**
 * 能力面契约版本。**新增能力时升 minor，移除/改语义升 major**
 *
 * 1.1.0：`$map` 只读面（地图 v1 §5）。纯新增，旧条目一字不受影响。
 */
export const EJS_SURFACE_VERSION = '1.1.0';

/**
 * 🔴 **能力面唯一真源（Q-09）**。
 *
 * 此前「沙盒里存在哪些符号」由四处独立维护：本文件的 `CAPABILITY_PATHS`（供
 * `engine.has()` 探测）、`ejs-preflight.ts` 的两张 Set、guest 侧的
 * `fmtNames` / `rngNames` 字符串数组。四份靠人眼保持一致，而且**已经对不上**：
 * `world.isDaytime` 与 `engine.name` 都是真实能力，却不在探测表里 ——
 * 创作者写 `engine.has('world.isDaytime')` 拿到 `false`，于是他的守卫分支
 * 反过来禁用了一个可用能力，且完全无声。
 *
 * 现在四处全部从这里派生。加能力只动这张表。
 *
 * 中文键名（`world.时间` 等）**必须逐字保留** —— 它们是两个后端与创作者共同
 * 认定的契约，改名是静默破坏。
 */
export const EJS_SURFACE = {
  /** namespace → 该 namespace 下的成员名 */
  namespaces: {
    local: ['get', 'set', 'has', 'remove', 'keys'],
    char: ['player', 'get', 'present', 'all', 'has', 'affection', 'affectionLabel'],
    // isDaytime 是函数，过 JSON 编组会丢；QuickJS 侧另有常量 shim 顶上
    world: ['时间', '时间详情', '地点', '天气', '回合', 'isDaytime'],
    // 地图 v1 §5：**全是数据**（见 EjsMap 的说明——函数在这一面是禁忌）
    $map: ['currentTile', 'neighbors', 'weatherNow', 'journey', 'discontinuity'],
    quest: ['all', 'active', 'get', 'has', 'focus'],
    lore: ['get', 'has', 'list'],
    chat: ['last', 'at', 'slice', 'match', 'text'],
    fmt: [
      'yaml',
      'json',
      'table',
      'list',
      'num',
      'pct',
      'bar',
      'pad',
      'truncate',
      'compareName',
      'sortNames',
    ],
    rng: ['roll', 'rollDetail', 'int', 'float', 'pick', 'pickN', 'shuffle', 'chance'],
    ui: ['notify', 'log'],
    engine: ['name', 'version', 'has'],
  },
  /**
   * 顶层符号里**没有成员**的那些。
   *
   * `stats` / `vars` 是数据树（不是 namespace，成员由存档决定）；
   * `print` / `_` 是语言/库层面的符号，创作者不会去 `engine.has` 它们 ——
   * 所以它们进预检的符号表，但**不进** `engine.has` 的路径表（见 `bareProbePaths`）。
   */
  bareTopLevel: ['stats', 'vars', 'print', '_'],
  /** 上面那批里，仍然值得让 `engine.has` 认得的 */
  bareProbePaths: ['stats', 'vars'],
  /** 兼容别名（§5）—— 认得，但预检会提示改用新面 */
  aliases: [
    'getMessageVar',
    'setMessageVar',
    'getvar',
    'setvar',
    'getLocalVar',
    'setLocalVar',
    'matchChatMessages',
    'getChatMessage',
    'getChatMessages',
    'getwi',
    'YAML',
    'TavernHelper',
    'toastr',
    'alert',
    'message_id',
    'lastMessageId',
    'charLoreBook',
    'localStorage',
    'console',
    'variables',
  ],
  /**
   * `stats` 下的扩面路径 —— 创作者据此决定要不要走守卫分支。
   * 它们不是 namespace 成员（`stats` 是一棵数据树），单列。
   */
  statsPaths: [
    'stats.主角.背包',
    'stats.主角.装备',
    'stats.主角.技能',
    'stats.主角.状态效果',
    'stats.主角.登神长阶',
    'stats.主角.金钱',
    'stats.队伍',
    'stats.世界.回合',
  ],
} as const;

/** 能力面 §3 的顶层符号（namespace + 裸符号）—— 预检用 */
export const EJS_TOP_LEVEL_SYMBOLS: ReadonlySet<string> = new Set([
  ...Object.keys(EJS_SURFACE.namespaces),
  ...EJS_SURFACE.bareTopLevel,
]);

/** 兼容别名集合 —— 预检用 */
export const EJS_ALIAS_SYMBOLS: ReadonlySet<string> = new Set(EJS_SURFACE.aliases);

/** `fmt` / `rng` 的成员名 —— guest 门面按它生成，不再在字符串里手写一份 */
export const EJS_FMT_NAMES: readonly string[] = EJS_SURFACE.namespaces.fmt;
export const EJS_RNG_NAMES: readonly string[] = EJS_SURFACE.namespaces.rng;

/** `engine.has()` 认得的路径全表。**由 EJS_SURFACE 展平，不再手抄** */
const CAPABILITY_PATHS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(EJS_SURFACE.namespaces),
  ...EJS_SURFACE.bareProbePaths,
  ...Object.entries(EJS_SURFACE.namespaces).flatMap(([ns, members]) =>
    (members as readonly string[]).map((m) => `${ns}.${m}`),
  ),
  ...EJS_SURFACE.statsPaths,
]);

/**
 * `engine` namespace。
 *
 * Q-09：`name` 此前有实现却不在 `CAPABILITY_PATHS` 里，`engine.has('engine.name')`
 * 返回 false。现在两者同源（{@link EJS_SURFACE}）。
 */
export interface EjsEngine {
  name: string;
  version: string;
  /** 能力探测。创作者据此写「有就用、没有就退」 */
  has(path: string): boolean;
}

function buildEngine(input: EjsCapabilityInput): EjsEngine {
  return {
    name: 'poem-of-destiny',
    version: input.engineVersion ?? EJS_SURFACE_VERSION,
    /**
     * 能力探测。创作者据此写「有就用、没有就退」——
     * 真机语料里作者已经在用 try/catch 猜环境了，给个正经的口更好。
     */
    has: (path: string) => CAPABILITY_PATHS.has(String(path ?? '')),
  };
}

// ═══════════════════════════════════════════════════════════
// 组装
// ═══════════════════════════════════════════════════════════

export interface EjsCapabilities {
  chat: EjsChat;
  char: EjsChar;
  world: EjsWorld;
  /** 地图 v1 §5。名字带 `$` 是刻意的：`map` 是语料里极常见的局部变量名，撞名就被遮蔽 */
  $map: EjsMap;
  quest: EjsQuest;
  lore: EjsLore;
  local: EjsLocal;
  ui: EjsUi;
  engine: EjsEngine;
  /** 上游 `charLoreBook` 环境变量 */
  charLoreBook: string;
}

/**
 * 造一次求值所需的全部引擎侧能力。
 *
 * ⚠️ **每条目调一次**（不是每 pass）：`lore.get` 与 `ui.notify` 的预算是**条目级**的，
 * 复用同一份实例会让第一个条目把预算吃光，后面全部静默失效。
 */
export function buildEjsCapabilities(
  vars: Record<string, any>,
  historyText: string,
  input: EjsCapabilityInput | undefined,
): EjsCapabilities {
  const inp = input ?? {};
  const ui = buildUi(inp);
  return {
    chat: buildChat(inp, historyText),
    char: buildChar(inp),
    world: buildWorld(inp),
    $map: buildMap(inp),
    quest: buildQuest(inp),
    lore: buildLore(inp),
    local: buildLocal(vars, inp, ui),
    ui,
    engine: buildEngine(inp),
    charLoreBook: String(inp.charLoreBook ?? ''),
  };
}
