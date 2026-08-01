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
  /** 好感度表（characterId → -100..100） */
  affections?: Record<string, number>;
  gameTime?: GameTime;
  /** 任务表（名字 → Quest） */
  quests?: Record<string, Quest>;
  /** 玩家选中的焦点任务名 */
  focusQuest?: string;
  turn?: number;
  weather?: string;
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
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
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
    affection: (name) => {
      const c = find(name);
      if (!c) return 0;
      const v = input.affections?.[c.id];
      return typeof v === 'number' ? v : 0;
    },
    affectionLabel: (name) => {
      const c = find(name);
      if (!c) return '';
      const v = input.affections?.[c.id];
      return getAffectionLabel(typeof v === 'number' ? v : 0);
    },
  };
}

// ═══════════════════════════════════════════════════════════
// world（§3.5）
// ═══════════════════════════════════════════════════════════

function buildWorld(input: EjsCapabilityInput): Record<string, any> {
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
// quest（§3.6）
// ═══════════════════════════════════════════════════════════

function projectQuest(name: string, q: Quest): Record<string, any> {
  const anyQ = q as unknown as Record<string, any>;
  return {
    名字: name,
    状态: anyQ['status'] ?? anyQ['状态'] ?? '',
    描述: anyQ['description'] ?? anyQ['描述'] ?? '',
    目标: clone(anyQ['objectives'] ?? anyQ['目标'] ?? []),
    进度: anyQ['progress'] ?? anyQ['进度'] ?? '',
    奖励: clone(anyQ['rewards'] ?? anyQ['奖励'] ?? []),
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

  /** 取（或建）本项目的 KV 子树。落在 `vars` 下 → 随快照回退天然覆盖 */
  const bucket = (create: boolean): Record<string, unknown> | undefined => {
    if (projectId === '__proto__' || projectId === 'constructor' || projectId === 'prototype') {
      return undefined;
    }
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
    if (!k || k === '__proto__' || k === 'prototype' || k === 'constructor') return null;
    return k;
  };

  return {
    get: (key, fallback) => {
      const k = safeKey(key);
      if (!k) return fallback ?? null;
      const own = bucket(false);
      const v = own?.[k];
      return v === undefined ? (fallback ?? null) : clone(v);
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
      return own !== undefined && own[k] !== undefined;
    },
    remove: (key) => {
      const k = safeKey(key);
      if (!k) return;
      const own = bucket(false);
      if (own) delete own[k];
    },
    keys: () => Object.keys(bucket(false) ?? {}),
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

/** 能力面契约版本。**新增能力时升 minor，移除/改语义升 major** */
export const EJS_SURFACE_VERSION = '1.0.0';

/** `engine.has()` 认得的路径全表 —— 加能力时同步加行，否则创作者探测不到 */
const CAPABILITY_PATHS: ReadonlySet<string> = new Set([
  'stats',
  'vars',
  'local',
  'local.get',
  'local.set',
  'local.has',
  'local.remove',
  'local.keys',
  'char',
  'char.player',
  'char.get',
  'char.present',
  'char.all',
  'char.has',
  'char.affection',
  'char.affectionLabel',
  'world',
  'world.时间',
  'world.时间详情',
  'world.地点',
  'world.天气',
  'world.回合',
  'quest',
  'quest.all',
  'quest.active',
  'quest.get',
  'quest.has',
  'quest.focus',
  'lore',
  'lore.get',
  'lore.has',
  'lore.list',
  'chat',
  'chat.last',
  'chat.at',
  'chat.slice',
  'chat.match',
  'chat.text',
  'fmt',
  'fmt.yaml',
  'fmt.json',
  'fmt.table',
  'fmt.list',
  'fmt.num',
  'fmt.pct',
  'fmt.bar',
  'fmt.pad',
  'fmt.truncate',
  'fmt.compareName',
  'fmt.sortNames',
  'rng',
  'rng.roll',
  'rng.rollDetail',
  'rng.int',
  'rng.float',
  'rng.pick',
  'rng.pickN',
  'rng.shuffle',
  'rng.chance',
  'ui',
  'ui.notify',
  'ui.log',
  'engine',
  'engine.version',
  'engine.has',
  // stats 扩面（T3）—— 创作者据此决定要不要走守卫分支
  'stats.主角.背包',
  'stats.主角.装备',
  'stats.主角.技能',
  'stats.主角.状态效果',
  'stats.主角.登神长阶',
  'stats.主角.金钱',
  'stats.队伍',
  'stats.世界.回合',
]);

function buildEngine(input: EjsCapabilityInput): Record<string, any> {
  return {
    name: 'poem-of-destiny',
    version: input.engineVersion ?? EJS_SURFACE_VERSION,
    /**
     * 能力探测。创作者据此写「有就用、没有就退」——
     * 真机语料里作者已经在用 try/catch 猜环境了，给个正经的口更好。
     */
    has: (path: unknown) => CAPABILITY_PATHS.has(String(path ?? '')),
  };
}

// ═══════════════════════════════════════════════════════════
// 组装
// ═══════════════════════════════════════════════════════════

export interface EjsCapabilities {
  chat: EjsChat;
  char: EjsChar;
  world: Record<string, any>;
  quest: EjsQuest;
  lore: EjsLore;
  local: EjsLocal;
  ui: EjsUi;
  engine: Record<string, any>;
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
    quest: buildQuest(inp),
    lore: buildLore(inp),
    local: buildLocal(vars, inp, ui),
    ui,
    engine: buildEngine(inp),
    charLoreBook: String(inp.charLoreBook ?? ''),
  };
}
