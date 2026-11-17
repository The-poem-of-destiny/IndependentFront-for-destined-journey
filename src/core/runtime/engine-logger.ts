/**
 * engine-logger.ts — 统一引擎日志器（带级别），最后手段的调试依据（2026-11-16 T1）。
 *
 * 记录完整的 wire prompt / 响应、提示装配脚手架与其他关键事件。本模块只管「记」：
 * 分级闸门、回合作用域、payload 序列化与脱敏、console 采集、缓冲与串行批量交付。
 * 落盘由注入的 sink 负责（生产实现 `persistence/engine-log-store.ts` 的
 * `createDexieEngineLogSink`，由前端在 `src/ui/main.ts` 安装；引擎默认不装）。
 *
 * 关键约定：
 * - **热路径只做一次整数比较**：`threshold` 是当前最低级别的序号，关闭时为 +∞。
 *   关闭或级别不够时 thunk 不执行、payload 不序列化，也不排任何定时器 —— 零写库。
 * - **payload 在记录时就序列化成 JSON 文本**：自写的深拷贝切断 Vue/Pinia Proxy，
 *   循环引用 → `"[Circular]"`，BigInt / 函数 / Error / Map / Set / 二进制均有可读降级；
 *   单个字符串超过 2,000,000 字符截断并标注原长度。序列化失败不抛，降级成说明性字符串。
 * - **脱敏两层，都不靠启发式**：①按键名的结构化脱敏（纵深防御）—— 对象键名（不区分大小写、
 *   只匹配完整键名）属于 `SENSITIVE_KEYS` 的值一律 `***`；键名为 `headerOverrides` / `headers`
 *   的对象只保留头名、值全部 `***`（短于 6 字符的头值登记不进精确替换，只能靠这一层）。
 *   ②`registerLogSecret` 登记值的精确替换。调用点仍应只记白名单字段，别把整份端点配置交进来。
 *   🔴 不要在这里跑「长串一律抹掉」的启发式（`utils/redact-secrets.ts` 那种）——
 *      提示词里的 UUID 和哈希都是调试要看的东西。
 * - **回合作用域按 saveId 环境化**：`beginLogScope` 开的作用域在 `end` 之前一直活跃；
 *   不带 saveId 的调用（深层纯函数）归入最近一个活跃作用域。
 * - **写入串行、不进 withSaveWriteLock**：上一批写完再写下一批；sink 失败只用原始
 *   console 报一次，绝不抛到调用方；配额耗尽则停写并通知注册的监听者。
 */

// ═══════════════════════════════════════════════════════════
// 级别与条目
// ═══════════════════════════════════════════════════════════

export type EngineLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** 级别从低到高；设置页的下拉选项按此顺序列出 */
export const ENGINE_LOG_LEVELS: readonly EngineLogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
];

const LEVEL_RANK: Readonly<Record<EngineLogLevel, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** 应用级条目的 saveId：不属于任何存档（启动、设置、无作用域的 console 采集等） */
export const APP_LOG_SAVE_ID = '';

/**
 * 无回合条目的层号。真实回合层从 1 开始编号；层 0 = 不属于任何回合
 * （应用级条目恒为层 0；有 saveId 但不在活跃作用域里的条目也落层 0）。
 */
export const NO_TURN_LAYER = 0;

/** 一条落盘的引擎日志 */
export interface EngineLogEntry {
  /** 自增主键（sink 写入时分配；写入前不存在） */
  seq?: number;
  ts: number;
  level: EngineLogLevel;
  cat: string;
  /** `APP_LOG_SAVE_ID`（空串）= 应用级 */
  saveId: string;
  /** `NO_TURN_LAYER`（0）= 无回合；≥1 = 回合层 */
  layer: number;
  turn?: number;
  turnId?: string;
  /** 该层的来源玩家消息 id（开层依据）；只在回合层条目上出现，供刷新后续接层号 */
  layerKey?: string;
  agentId?: string;
  callId?: string;
  invocationId?: string;
  msg: string;
  /** JSON 文本（空串 = 无 payload） */
  payload: string;
  /** payload 的字符数 */
  size: number;
}

/** 调用点可显式给出的上下文；缺省字段取自活跃作用域 */
export interface EngineLogContext {
  /** 显式给 `APP_LOG_SAVE_ID` = 强制记为应用级 */
  saveId?: string;
  turn?: number;
  turnId?: string;
  agentId?: string;
  callId?: string;
  invocationId?: string;
}

/** 某存档当前最大层号及其开层依据（sink 查库给出，用于刷新后续接层号） */
export interface EngineLogLayerHead {
  layer: number;
  layerKey?: string;
}

/** 落盘缝。`write` 失败应抛出（日志器负责兜底），`getLayerHead` 无记录时返回 `{ layer: 0 }` */
export interface EngineLogSink {
  write(entries: EngineLogEntry[]): Promise<void>;
  getLayerHead(saveId: string): Promise<EngineLogLayerHead>;
}

export interface EngineLogScopeOptions {
  saveId: string;
  turnId: string;
  turn?: number;
  /** 来源玩家消息 id：与该存档上一个不同才开新层；缺省 = 归入当前层 */
  layerKey?: string;
}

export interface EngineLogScope {
  /** 结束作用域（幂等）；同时触发一次 flush */
  end(status?: string): void;
}

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 单个字符串的截断上限 */
const MAX_STRING_CHARS = 2_000_000;
/** 缓冲累计超过此字符数立即交付一批；也是单批的大致上限 */
const BATCH_CHARS = 2_000_000;
/** 积压上限：超过后丢最旧的 */
const BACKLOG_CHARS = 64_000_000;
const FLUSH_DELAY_MS = 500;
/** 深拷贝的深度上限（Proxy 与原对象混出来的环兜底） */
const MAX_DEPTH = 100;
/** 短于此长度的「密钥」不登记：精确替换短串会把正文大面积改花 */
const MIN_SECRET_LENGTH = 6;
const REDACTED = '***';
/**
 * 按键名结构化脱敏的键（小写比较、完整键名匹配）。
 * 🔴 只认完整键名：`maxTokens` / `tokensUsed` / `promptTokens` 是调试要看的计数，不能误伤。
 * 🔴 刻意**不含** `token` / `secret`：本仓里它们是业务字段（世界书条目 uid
 *    `legacyEntry.token`、剧情选角计划的 `PlotCastPlanEntry.secret`），排查时正要看；
 *    凭据只会以 apiKey / Authorization / 请求头的形态出现，已由本表与头映射覆盖。
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'apikey',
  'api_key',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'password',
]);
/** 值是「头名 → 头值」映射的键：保留头名，值全部脱敏 */
const HEADER_MAP_KEYS: ReadonlySet<string> = new Set(['headeroverrides', 'headers']);

// ═══════════════════════════════════════════════════════════
// 模块状态
// ═══════════════════════════════════════════════════════════

/** 当前最低记录级别的序号；关闭（或配额停写）时为 +∞ */
let threshold = Number.POSITIVE_INFINITY;
let enabled = false;
let configuredRank = LEVEL_RANK.info;
/** 配额耗尽后停写；需要经「关 → 开」才恢复 */
let halted = false;

let sink: EngineLogSink | null = null;
const secrets = new Set<string>();
/** 登记密钥在 JSON 文本里的转义形态（含引号/反斜杠/控制字符的密钥才与原文不同） */
const escapedSecrets = new Set<string>();
const quotaListeners = new Set<(error: unknown) => void>();

/** 重入计数：>0 时 console tap 直通、不采集（日志器自己或 sink 兜底在打 console） */
let reentry = 0;
let reportedWriteFailure = false;

interface LayerSlot {
  layer: number | null;
  layerKey?: string;
}

interface SaveLayerState {
  resolved: boolean;
  layer: number;
  layerKey?: string;
  pending: Array<{ key?: string; slot: LayerSlot }>;
  ready: Promise<void>;
}

interface ActiveScope {
  saveId: string;
  turnId: string;
  turn?: number;
  slot: LayerSlot;
  state: SaveLayerState;
}

const layerStates = new Map<string, SaveLayerState>();
/** 活跃作用域，按开启顺序；「最近一个」= 末尾 */
const activeScopes: ActiveScope[] = [];

interface Pending {
  entry: EngineLogEntry;
  scope?: ActiveScope;
  chars: number;
}

let queue: Pending[] = [];
let queueChars = 0;
let droppedCount = 0;
let droppedChars = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let writer: Promise<void> | null = null;

// ═══════════════════════════════════════════════════════════
// 配置与闸门
// ═══════════════════════════════════════════════════════════

/** 开关与最低级别。开启时装 console tap，关闭时卸下并把已记下的条目交付掉 */
export function configureEngineLogger(options: { enabled: boolean; level?: EngineLogLevel }): void {
  const rank = options.level !== undefined ? LEVEL_RANK[options.level] : undefined;
  if (rank !== undefined) configuredRank = rank;
  const wasEnabled = enabled;
  enabled = options.enabled === true;
  if (enabled && !wasEnabled) halted = false;
  threshold = enabled && !halted ? configuredRank : Number.POSITIVE_INFINITY;
  if (threshold !== Number.POSITIVE_INFINITY) {
    installConsoleTap();
  } else {
    uninstallConsoleTap();
    if (queue.length > 0) void kick();
  }
}

/** 该级别此刻会不会被记录（调用方可据此跳过昂贵的准备工作） */
export function isEngineLogEnabled(level: EngineLogLevel): boolean {
  return (LEVEL_RANK[level] ?? -1) >= threshold;
}

/**
 * 记一条日志。`payload` 若是函数则视为 thunk：只在会被记录时调用。
 * 永不抛。
 */
export function logEngine(
  level: EngineLogLevel,
  category: string,
  msg: string,
  payload?: unknown,
  ctx?: EngineLogContext,
): void {
  if ((LEVEL_RANK[level] ?? -1) < threshold) return;
  record(level, category, msg, payload, ctx);
}

/** 登记一个密钥值：此后所有条目里该值的精确出现都替换成 `***` */
export function registerLogSecret(value: string | null | undefined): void {
  if (typeof value !== 'string') return;
  const secret = value.trim();
  if (secret.length < MIN_SECRET_LENGTH || secrets.has(secret)) return;
  secrets.add(secret);
  const escaped = JSON.stringify(secret).slice(1, -1);
  if (escaped !== secret) escapedSecrets.add(escaped);
}

/** 安装（或以 null 卸下）落盘 sink。装上后立即尝试交付已积压的条目 */
export function installEngineLogSink(next: EngineLogSink | null): void {
  sink = next;
  reportedWriteFailure = false;
  // 层号来源变了：已解析的存档状态作废，下次开作用域时向新 sink 重查（未解析的保持原 promise）
  for (const [saveId, state] of layerStates) {
    if (state.resolved) layerStates.delete(saveId);
  }
  if (next && queue.length > 0) void kick();
}

/**
 * 存储配额耗尽、日志器停写时回调。返回取消订阅函数。
 * 前端（`src/ui/main.ts` → `ui/lib/engine-log-storage-full.ts`）据此提示并把设置里的开关关掉，
 * 设置 watch 再推 `configureEngineLogger({ enabled: false })`；用户导出清空后重新打开即恢复。
 */
export function onEngineLogStorageFull(listener: (error: unknown) => void): () => void {
  quotaListeners.add(listener);
  return () => {
    quotaListeners.delete(listener);
  };
}

// ═══════════════════════════════════════════════════════════
// 回合作用域
// ═══════════════════════════════════════════════════════════

const NOOP_SCOPE: EngineLogScope = { end: () => undefined };

/**
 * 开一个回合作用域。`layerKey` 与该存档上一个不同才开新层（层号 +1），相同或缺省归入
 * 当前层（重新生成、润色、战斗等同一楼的后续操作）。该存档还没有任何层时总是开第 1 层之后的新层。
 * 层号跨刷新延续：本会话首次碰到某存档时向 sink 查当前最大层（异步，条目在交付前统一回填层号）。
 */
export function beginLogScope(options: EngineLogScopeOptions): EngineLogScope {
  if (threshold === Number.POSITIVE_INFINITY) return NOOP_SCOPE;
  try {
    const state = getLayerState(options.saveId);
    const slot: LayerSlot = { layer: null };
    if (state.resolved) assignLayer(state, options.layerKey, slot);
    else state.pending.push({ key: options.layerKey, slot });
    const scope: ActiveScope = {
      saveId: options.saveId,
      turnId: options.turnId,
      turn: options.turn,
      slot,
      state,
    };
    activeScopes.push(scope);
    logEngine('debug', 'scope', 'scope.begin', () => ({ layerKey: options.layerKey ?? null }), {
      saveId: options.saveId,
    });
    let ended = false;
    return {
      end(status?: string) {
        if (ended) return;
        ended = true;
        logEngine('debug', 'scope', 'scope.end', () => ({ status: status ?? null }), {
          saveId: scope.saveId,
        });
        const index = activeScopes.lastIndexOf(scope);
        if (index >= 0) activeScopes.splice(index, 1);
        void flushEngineLog();
      },
    };
  } catch (error) {
    rawConsoleError('[engine-log] 开启作用域失败', error);
    return NOOP_SCOPE;
  }
}

function getLayerState(saveId: string): SaveLayerState {
  const existing = layerStates.get(saveId);
  if (existing) return existing;
  const state: SaveLayerState = {
    resolved: false,
    layer: NO_TURN_LAYER,
    pending: [],
    ready: Promise.resolve(),
  };
  layerStates.set(saveId, state);
  const current = sink;
  if (!current) {
    resolveLayerState(state, { layer: NO_TURN_LAYER });
    return state;
  }
  state.ready = Promise.resolve()
    .then(() => current.getLayerHead(saveId))
    .then(
      (head) => resolveLayerState(state, head),
      (error: unknown) => {
        rawConsoleError('[engine-log] 读取日志层号失败，按无历史处理', error);
        resolveLayerState(state, { layer: NO_TURN_LAYER });
      },
    );
  return state;
}

function resolveLayerState(state: SaveLayerState, head: EngineLogLayerHead): void {
  const layer = Number.isFinite(head?.layer) ? Math.max(NO_TURN_LAYER, Math.floor(head.layer)) : 0;
  state.layer = layer;
  state.layerKey = head?.layerKey;
  state.resolved = true;
  for (const item of state.pending) assignLayer(state, item.key, item.slot);
  state.pending = [];
}

function assignLayer(state: SaveLayerState, key: string | undefined, slot: LayerSlot): void {
  if (state.layer < 1 || (key !== undefined && key !== state.layerKey)) {
    state.layer += 1;
    state.layerKey = key;
  }
  slot.layer = state.layer;
  slot.layerKey = state.layerKey;
}

function findScope(saveId: string | undefined): ActiveScope | undefined {
  if (saveId === APP_LOG_SAVE_ID) return undefined;
  for (let i = activeScopes.length - 1; i >= 0; i--) {
    const scope = activeScopes[i];
    if (saveId === undefined || scope.saveId === saveId) return scope;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════
// 记录
// ═══════════════════════════════════════════════════════════

function record(
  level: EngineLogLevel,
  category: string,
  msg: string,
  payload: unknown,
  ctx: EngineLogContext | undefined,
): void {
  reentry++;
  try {
    let value: unknown;
    if (typeof payload === 'function') {
      try {
        value = (payload as () => unknown)();
      } catch (error) {
        value = { thunkError: describeError(error) };
      }
    } else {
      value = payload;
    }
    const payloadText = redact(serializePayload(value), true);
    const msgText = redact(truncateString(typeof msg === 'string' ? msg : String(msg)), false);
    const scope = findScope(ctx?.saveId);
    const saveId = ctx?.saveId ?? scope?.saveId ?? APP_LOG_SAVE_ID;
    const entry: EngineLogEntry = {
      ts: Date.now(),
      level,
      cat: String(category),
      saveId,
      layer: NO_TURN_LAYER,
      msg: msgText,
      payload: payloadText,
      size: payloadText.length,
    };
    const turn = ctx?.turn ?? scope?.turn;
    const turnId = ctx?.turnId ?? scope?.turnId;
    if (turn !== undefined) entry.turn = turn;
    if (turnId !== undefined) entry.turnId = turnId;
    if (ctx?.agentId !== undefined) entry.agentId = ctx.agentId;
    if (ctx?.callId !== undefined) entry.callId = ctx.callId;
    if (ctx?.invocationId !== undefined) entry.invocationId = ctx.invocationId;
    enqueue({ entry, scope, chars: payloadText.length + msgText.length });
  } catch (error) {
    rawConsoleError('[engine-log] 记录失败', error);
  } finally {
    reentry--;
  }
}

function enqueue(item: Pending): void {
  queue.push(item);
  queueChars += item.chars;
  while (queueChars > BACKLOG_CHARS && queue.length > 0) {
    const old = queue.shift()!;
    queueChars -= old.chars;
    droppedCount++;
    droppedChars += old.chars;
  }
  if (queueChars >= BATCH_CHARS) void kick();
  else scheduleTimer();
}

// ═══════════════════════════════════════════════════════════
// 序列化与脱敏
// ═══════════════════════════════════════════════════════════

function truncateString(text: string): string {
  if (text.length <= MAX_STRING_CHARS) return text;
  return `${text.slice(0, MAX_STRING_CHARS)}…[已截断：原长度 ${text.length} 字符]`;
}

function describeError(error: unknown): string {
  try {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  } catch {
    return '未知错误';
  }
}

function serializePayload(value: unknown): string {
  if (value === undefined) return '';
  try {
    const plain = toPlain(value, new Set<object>(), 0);
    const text = JSON.stringify(plain);
    return text === undefined ? '' : text;
  } catch (error) {
    return JSON.stringify(`[序列化失败：${describeError(error)}]`);
  }
}

function readKey(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch (error) {
    return `[读取失败：${describeError(error)}]`;
  }
}

/** 深拷贝成纯 JSON 值：切断 Proxy、标记环、降级不可序列化的类型 */
function toPlain(value: unknown, ancestors: Set<object>, depth: number): unknown {
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING_CHARS ? truncateString(redact(value, false)) : value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
    case 'undefined':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
  }
  if (value === null) return null;
  const obj = value as object;
  if (ancestors.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[深度超限]';
  ancestors.add(obj);
  try {
    const next = (child: unknown): unknown => toPlain(child, ancestors, depth + 1);
    if (obj instanceof Error) {
      const out: Record<string, unknown> = { name: obj.name, message: obj.message };
      if (obj.stack) out.stack = obj.stack;
      if ('cause' in obj) out.cause = next((obj as { cause?: unknown }).cause);
      for (const key of Object.keys(obj)) {
        if (!(key in out)) out[key] = plainField(key, readKey(obj, key), next);
      }
      return out;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => {
        const plain = next(item);
        return plain === undefined ? null : plain;
      });
    }
    if (obj instanceof Map) {
      return {
        '[Map]': [...obj.entries()].map(([k, v]) => [
          next(k),
          typeof k === 'string' ? (plainField(k, v, next) ?? null) : next(v),
        ]),
      };
    }
    if (obj instanceof Set) return { '[Set]': [...obj].map((item) => next(item)) };
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
      return `[${obj.constructor?.name ?? 'Binary'} ${obj.byteLength} bytes]`;
    }
    if (typeof Blob !== 'undefined' && obj instanceof Blob) return `[Blob ${obj.size} bytes]`;
    const toJSON = readKey(obj, 'toJSON');
    if (typeof toJSON === 'function') {
      const json: unknown = (toJSON as () => unknown).call(obj);
      return json === obj ? '[toJSON 自引用]' : next(json);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const plain = plainField(key, readKey(obj, key), next);
      if (plain !== undefined) out[key] = plain;
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

/** 对象字段的深拷贝：按键名结构化脱敏，其余照常递归 */
function plainField(key: string, value: unknown, next: (child: unknown) => unknown): unknown {
  if (value === undefined) return undefined;
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return value === null ? null : REDACTED;
  if (HEADER_MAP_KEYS.has(lower)) return redactHeaderMap(value);
  return next(value);
}

/**
 * 头映射只保留头名：对象 → 同键全 `***`；`[名, 值]` 对数组 → `[名, '***']`；
 * 纯字符串元素（只是头名清单）原样保留；其他形态整体 `***`
 */
function redactHeaderMap(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((pair) => {
      if (typeof pair === 'string') return pair;
      return Array.isArray(pair) && pair.length > 0 ? [String(pair[0]), REDACTED] : REDACTED;
    });
  }
  if (typeof value === 'object') {
    const out: Record<string, string> = {};
    try {
      for (const name of Object.keys(value)) out[name] = REDACTED;
    } catch {
      return REDACTED;
    }
    return out;
  }
  return REDACTED;
}

/** 登记密钥的精确替换；`json` 为真时额外替换密钥的 JSON 转义形态 */
function redact(text: string, json: boolean): string {
  if (secrets.size === 0 || text.length === 0) return text;
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  if (json) {
    for (const secret of escapedSecrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 交付
// ═══════════════════════════════════════════════════════════

function scheduleTimer(): void {
  if (timer || !sink || halted) return;
  timer = setTimeout(() => {
    timer = null;
    void kick();
  }, FLUSH_DELAY_MS);
}

function hasWork(): boolean {
  return sink !== null && !halted && (queue.length > 0 || droppedCount > 0);
}

function kick(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!writer) {
    writer = drain().finally(() => {
      writer = null;
      if (hasWork()) scheduleTimer();
    });
  }
  return writer;
}

/** 把此刻已记下的条目全部交付给 sink（无 sink 或已停写时立即返回）。永不 reject */
export async function flushEngineLog(): Promise<void> {
  // 上限只是防御：正常情况下一两轮就排空
  for (let round = 0; round < 1000; round++) {
    if (!writer && !hasWork()) return;
    await kick();
  }
}

function takeBatch(): Pending[] {
  const batch: Pending[] = [];
  let chars = 0;
  if (droppedCount > 0) {
    const payload = JSON.stringify({ dropped: droppedCount, chars: droppedChars });
    batch.push({
      entry: {
        ts: Date.now(),
        level: 'warn',
        cat: 'log',
        saveId: APP_LOG_SAVE_ID,
        layer: NO_TURN_LAYER,
        msg: 'log.dropped',
        payload,
        size: payload.length,
      },
      chars: payload.length,
    });
    droppedCount = 0;
    droppedChars = 0;
  }
  while (queue.length > 0 && (batch.length === 0 || chars < BATCH_CHARS)) {
    const item = queue.shift()!;
    queueChars -= item.chars;
    chars += item.chars;
    batch.push(item);
  }
  return batch;
}

async function drain(): Promise<void> {
  while (hasWork()) {
    const target = sink!;
    const batch = takeBatch();
    const waits = new Set<Promise<void>>();
    for (const item of batch) {
      if (item.scope && !item.scope.state.resolved) waits.add(item.scope.state.ready);
    }
    if (waits.size > 0) await Promise.all(waits);
    const entries = batch.map(({ entry, scope }) => {
      if (scope) {
        entry.layer = scope.slot.layer ?? NO_TURN_LAYER;
        if (scope.slot.layerKey !== undefined) entry.layerKey = scope.slot.layerKey;
      }
      return entry;
    });
    try {
      await target.write(entries);
    } catch (error) {
      handleWriteError(error);
    }
  }
}

function isQuotaExceeded(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  return isQuotaExceeded((error as { inner?: unknown }).inner, depth + 1);
}

function handleWriteError(error: unknown): void {
  if (isQuotaExceeded(error)) {
    halted = true;
    threshold = Number.POSITIVE_INFINITY;
    queue = [];
    queueChars = 0;
    droppedCount = 0;
    droppedChars = 0;
    uninstallConsoleTap();
    rawConsoleError('[engine-log] 存储空间不足，引擎日志已停写', error);
    for (const listener of quotaListeners) {
      try {
        listener(error);
      } catch {
        // 监听者自己的错误不影响日志器
      }
    }
    return;
  }
  if (reportedWriteFailure) return;
  reportedWriteFailure = true;
  rawConsoleError('[engine-log] 日志写入失败（后续同类失败不再提示）', error);
}

// ═══════════════════════════════════════════════════════════
// console 采集
// ═══════════════════════════════════════════════════════════

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';
type ConsoleFn = (...args: unknown[]) => void;

const TAP_LEVELS: Readonly<Record<ConsoleMethod, EngineLogLevel>> = {
  log: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

let tapOriginals: Partial<Record<ConsoleMethod, ConsoleFn>> | null = null;
let tapWrappers: Partial<Record<ConsoleMethod, ConsoleFn>> = {};

/** 用未被 tap 的原始 console 报错（sink 兜底用，不会被再次采集） */
function rawConsoleError(...args: unknown[]): void {
  reentry++;
  try {
    const fn = tapOriginals?.error ?? (console.error as ConsoleFn);
    fn.apply(console, args);
  } catch {
    // console 本身不可用就算了
  } finally {
    reentry--;
  }
}

function summarizeConsoleArgs(args: unknown[]): string {
  const parts = args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    if (arg === null || typeof arg !== 'object') return String(arg);
    return Array.isArray(arg) ? '[Array]' : '[Object]';
  });
  const text = parts.join(' ');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function installConsoleTap(): void {
  if (tapOriginals || typeof console === 'undefined') return;
  const originals: Partial<Record<ConsoleMethod, ConsoleFn>> = {};
  const wrappers: Partial<Record<ConsoleMethod, ConsoleFn>> = {};
  for (const method of Object.keys(TAP_LEVELS) as ConsoleMethod[]) {
    const original = console[method] as ConsoleFn | undefined;
    if (typeof original !== 'function') continue;
    const level = TAP_LEVELS[method];
    const wrapper: ConsoleFn = (...args: unknown[]) => {
      original.apply(console, args);
      if (reentry > 0 || LEVEL_RANK[level] < threshold) return;
      let msg = '';
      try {
        msg = summarizeConsoleArgs(args);
      } catch {
        msg = `console.${method}`;
      }
      record(level, 'console', msg, args, undefined);
    };
    originals[method] = original;
    wrappers[method] = wrapper;
    console[method] = wrapper;
  }
  tapOriginals = originals;
  tapWrappers = wrappers;
}

function uninstallConsoleTap(): void {
  if (!tapOriginals) return;
  for (const method of Object.keys(tapOriginals) as ConsoleMethod[]) {
    // 别人在我们之上又包了一层时不去拆它：我们的包装在关闭后只是直通
    if (console[method] === tapWrappers[method]) console[method] = tapOriginals[method]!;
  }
  tapOriginals = null;
  tapWrappers = {};
}

// ═══════════════════════════════════════════════════════════
// 测试辅助
// ═══════════════════════════════════════════════════════════

/** 测试用：回到模块初始状态（关闭、卸 sink、清空缓冲/作用域/层号/密钥/监听者） */
export function resetEngineLoggerForTest(): void {
  uninstallConsoleTap();
  if (timer) clearTimeout(timer);
  timer = null;
  writer = null;
  threshold = Number.POSITIVE_INFINITY;
  enabled = false;
  configuredRank = LEVEL_RANK.info;
  halted = false;
  sink = null;
  secrets.clear();
  escapedSecrets.clear();
  quotaListeners.clear();
  reentry = 0;
  reportedWriteFailure = false;
  layerStates.clear();
  activeScopes.length = 0;
  queue = [];
  queueChars = 0;
  droppedCount = 0;
  droppedChars = 0;
}
