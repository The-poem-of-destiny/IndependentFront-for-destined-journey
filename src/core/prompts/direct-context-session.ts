import type { ChatMessage, DirectCacheDiagnostics } from '../types/types';
import type { LlmMessage } from '../types/types-api';

export interface DirectContextFrame {
  prefix: LlmMessage[];
  history: LlmMessage[];
  sections: Record<string, unknown>;
}

export interface DirectCacheRecord {
  key: string;
  saveId: string;
  agentId: 'direct_cached';
  protocol: 'direct-cache-v1';
  signature: string;
  transcript: LlmMessage[];
  sections: Record<string, unknown>;
  source: Array<Pick<ChatMessage, 'id' | 'role' | 'content'>>;
  revision: number;
}

export interface DirectCacheStore {
  load(saveId: string): Promise<DirectCacheRecord | undefined>;
  save(record: DirectCacheRecord): Promise<void>;
  delete(saveId: string): Promise<void>;
}

export interface DirectCacheTicket {
  saveId: string;
  /** 本次实际发出的整份请求：已留存的会话 + 本轮留存消息 + 不留存的本轮尾部 */
  messages: LlmMessage[];
  /** `messages` 前多少条会留存进会话（其后是不留存的尾部），供断点定位 */
  retainedCount: number;
  revision: number;
  rebaseReason?: string;
  diagnostics: DirectCacheDiagnostics;
}

const sessions = new Map<string, DirectCacheRecord>();
const pending = new Map<DirectCacheTicket, DirectCacheRecord>();
const generations = new Map<string, object>();
/**
 * 自上次接纳以来连续丢弃的尝试数。供应商 200 却截断/安全拦截等「软失败」可能源于会话本身，
 * 一直复用同一前缀会反复失败；连续达到上限后下一次冷建，与旧行为一样自愈。
 */
const MAX_CONSECUTIVE_DISCARDS = 2;
/** 重建时机的默认值：一段会话最多接纳几楼、请求长度相对重建基线的倍数上限。 */
export const DIRECT_CACHE_REBUILD_DEFAULTS = { maxTurns: 8, growthLimit: 1.4 } as const;
/** 重建时机的可调范围；设置页滑块与引擎校验共用这一份。 */
export const DIRECT_CACHE_REBUILD_RANGE = {
  maxTurns: { min: 2, max: 24, step: 1 },
  growthLimit: { min: 1.2, max: 3, step: 0.1 },
} as const;

/** 把用户设置收敛成合法的重建时机：缺席或非数字用默认值，越界夹到范围内，楼数取整。 */
export function normalizeDirectCacheRebuild(input?: {
  maxTurns?: unknown;
  growthLimit?: unknown;
}): { maxTurns: number; growthLimit: number } {
  const pick = (value: unknown, fallback: number, range: { min: number; max: number }) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(range.max, Math.max(range.min, value))
      : fallback;
  return {
    maxTurns: Math.round(
      pick(
        input?.maxTurns,
        DIRECT_CACHE_REBUILD_DEFAULTS.maxTurns,
        DIRECT_CACHE_REBUILD_RANGE.maxTurns,
      ),
    ),
    // 滑块步长 0.1，四舍五入掉浮点尾数
    growthLimit:
      Math.round(
        pick(
          input?.growthLimit,
          DIRECT_CACHE_REBUILD_DEFAULTS.growthLimit,
          DIRECT_CACHE_REBUILD_RANGE.growthLimit,
        ) * 100,
      ) / 100,
  };
}

/** 诊断里逐条列出的分区上限，其余合并成一项。 */
const MAX_DIAGNOSTIC_SECTIONS = 30;
/** 尾部重申现值的分区：每轮都可能变，且以 app 状态为准。 */
const CURRENT_SECTIONS = ['combat', 'resources'] as const;
const discards = new Map<string, number>();
let store: DirectCacheStore | undefined;

export function installDirectCacheStore(value?: DirectCacheStore): void {
  store = value;
}

export function directCacheKey(saveId: string): string {
  return `${saveId}\u0000direct_cached`;
}

function source(messages: readonly ChatMessage[]): DirectCacheRecord['source'] {
  return messages.map(({ id, role, content }) => ({ id, role, content }));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

export function serializeDirectContext(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'undefined';
}

function size(messages: LlmMessage[]): number {
  return messages.reduce(
    (n, m) => n + (m.native ? JSON.stringify(m.native.value) : (m.content ?? '')).length,
    0,
  );
}

export const DIRECT_CACHE_PROTOCOL = `上下文采用直出缓存会话。direct_context 是本轮权威输入：set 中的每个顶层字段整块替换旧值，remove 明确删除旧字段；禁止把替换解释成数值增减或追加物品。未变化的字段沿用最近值。character/角色名/profile、skills、inventory、statusEffects 分别是该角色的档案、技能、库存和状态效果，character/角色名/state 是该角色当前的位置、是否在场、当前行动、金钱、经验与心里话；资源单列在 resources，按 name 对应角色。空数组表示已清空，remove 后该分区不再有效。若出现 memory/记忆编号 分区，每个分区是一条长期记忆，所有仍有效的 memory/ 分区合起来就是完整记忆库：新记忆只出现在当轮 set，未再出现的旧记忆依然有效，被 remove 的记忆已删除。currentLore、regionLore、turnLore 及 authoredTurn 只以最新分区为准，被替换或移除的旧条目不再是本轮激活规则。历史中的 assistant 只保留正文，不含当时的状态声明；状态一律以 direct_context 与本轮 turn_context 为准。历史里只有正文不代表可以只输出正文，每轮仍须按输出协议输出完整结构。玩家输入在每轮 direct_context 之后的 player_input 中。turn_context 只随当前这一轮出现，历史里不保留旧轮的召回与骰池；只使用本轮 turn_context 的召回与骰池。turn_context.dice_pool 的每项为 [骰面数,骰值]，数组下标就是 diceUsed.index。turn_context.current 若出现，其中的战斗与资源现值是本轮 app 状态，优先于历史中的旧值；同一轮 direct_context.set 里给出的 combat 与 resources 同样是现值。`;

function diagnoseSections(
  set: Record<string, unknown>,
  remove: string[],
): Pick<DirectCacheDiagnostics, 'sections' | 'otherSections'> {
  const all = [
    ...Object.entries(set).map(([key, value]) => ({
      key,
      action: 'set' as const,
      chars: serializeDirectContext(value).length,
    })),
    ...remove.map((key) => ({ key, action: 'remove' as const, chars: 0 })),
  ].sort((a, b) => b.chars - a.chars || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const rest = all.slice(MAX_DIAGNOSTIC_SECTIONS);
  return {
    sections: all.slice(0, MAX_DIAGNOSTIC_SECTIONS),
    ...(rest.length
      ? { otherSections: { count: rest.length, chars: rest.reduce((n, s) => n + s.chars, 0) } }
      : {}),
  };
}

export async function prepareDirectContext(input: {
  saveId: string;
  signature: string;
  frame: DirectContextFrame;
  /** 本轮玩家输入：随留存消息进入会话历史 */
  playerInput: string;
  /**
   * 本轮资料（召回、骰池、尾部指令等）：只随本次请求的尾部发出，不留存进会话。
   * 战斗与资源现值（不在本次 set 里时）由本模块从分区补进 `current`，调用方不必重复。
   */
  turnContext: Record<string, unknown>;
  /**
   * 重建时机（用户设置）：先经 `normalizeDirectCacheRebuild` 收敛。
   * 刻意不进会话签名：调阈值只影响之后的判定，不让当前会话立即重建。
   */
  rebuild?: { maxTurns?: number; growthLimit?: number };
  history: ChatMessage[];
  contextWindowTokens?: number;
  outputBudget: number;
  signal?: AbortSignal;
}): Promise<DirectCacheTicket> {
  const generation = {};
  const reentered = [...pending.keys()].some((t) => t.saveId === input.saveId);
  for (const ticket of pending.keys()) if (ticket.saveId === input.saveId) pending.delete(ticket);
  generations.set(input.saveId, generation);
  let previous = sessions.get(input.saveId);
  if (!previous && store) {
    try {
      previous = await store.load(input.saveId);
    } catch {
      /* Rebuildable cache; the save remains authoritative. */
    }
  }
  if (input.signal?.aborted || generations.get(input.saveId) !== generation)
    throw new DOMException('Context preparation cancelled', 'AbortError');
  const currentSource = source(input.history);
  const rebuild = normalizeDirectCacheRebuild(input.rebuild);
  const signature = serializeDirectContext([input.signature, input.frame.prefix]);
  const sections = JSON.parse(serializeDirectContext(input.frame.sections)) as Record<
    string,
    unknown
  >;
  const pack = (set: Record<string, unknown>, remove: string[]) => ({
    role: 'user' as const,
    content: `<direct_context>\n${serializeDirectContext({ set, remove })}\n</direct_context>\n<player_input>\n${input.playerInput}\n</player_input>`,
  });
  // 不留存的尾部：本轮资料 + 战斗与资源现值。现值只补「本次 set 里没给」的那些，
  // 已在 set 里的不重复；一个都不缺时不出 current 键。故尾部随每份请求的 set 各自构造。
  const tailFor = (set: Record<string, unknown>) => {
    const current = Object.fromEntries(
      CURRENT_SECTIONS.filter((key) => key in sections && !(key in set)).map((key) => [
        key,
        sections[key],
      ]),
    );
    return {
      role: 'user' as const,
      content: `<turn_context>\n${serializeDirectContext({
        ...input.turnContext,
        ...(Object.keys(current).length ? { current } : {}),
      })}\n</turn_context>`,
    };
  };
  const freshTail = tailFor(sections);
  const fresh = [...input.frame.prefix, ...input.frame.history, pack(sections, []), freshTail];
  let tail = freshTail;
  let set = sections;
  let remove: string[] = [];
  let reason = !previous
    ? 'missing_session'
    : previous.protocol !== 'direct-cache-v1'
      ? 'protocol_changed'
      : reentered
        ? 'reentered'
        : (discards.get(input.saveId) ?? 0) >= MAX_CONSECUTIVE_DISCARDS
          ? 'repeated_rejection'
          : previous.signature !== signature
            ? 'configuration_or_lore_changed'
            : previous.source.some(
                  (m, i) => serializeDirectContext(m) !== serializeDirectContext(currentSource[i]),
                )
              ? 'history_changed'
              : previous.revision >= rebuild.maxTurns
                ? 'turn_limit'
                : undefined;
  let messages = fresh;
  if (previous && !reason) {
    const changed = Object.fromEntries(
      Object.entries(sections).filter(
        ([key, value]) =>
          serializeDirectContext(value) !== serializeDirectContext(previous!.sections[key]),
      ),
    );
    const removed = Object.keys(previous.sections).filter((k) => !(k in sections));
    // 增长与窗口预算都按实际会发出的整份请求（含尾部）计，与冷建请求同一口径
    const reusedTail = tailFor(changed);
    messages = [...previous.transcript, pack(changed, removed), reusedTail];
    if (size(messages) > size(fresh) * rebuild.growthLimit) reason = 'transcript_growth';
    else if (
      input.contextWindowTokens &&
      Math.ceil(size(messages) / 1.5) + input.outputBudget > input.contextWindowTokens
    )
      reason = 'context_budget';
    if (reason) messages = fresh;
    else {
      set = changed;
      remove = removed;
      tail = reusedTail;
    }
  }
  if (
    input.contextWindowTokens &&
    Math.ceil(size(messages) / 1.5) + input.outputBudget > input.contextWindowTokens
  )
    throw new Error('直出缓存基线上下文仍超出模型窗口，请缩短历史或调整输出预留');
  const revision = reason ? 1 : previous!.revision + 1;
  const retainedCount = messages.length - 1;
  const ticket: DirectCacheTicket = {
    saveId: input.saveId,
    messages,
    retainedCount,
    revision,
    rebaseReason: reason,
    diagnostics: {
      rebased: !!reason,
      requestChars: size(messages),
      baselineChars: size(fresh),
      growthLimit: rebuild.growthLimit,
      tailChars: tail.content.length,
      ...diagnoseSections(set, remove),
    },
  };
  pending.set(ticket, {
    key: directCacheKey(input.saveId),
    saveId: input.saveId,
    agentId: 'direct_cached',
    protocol: 'direct-cache-v1',
    signature,
    // 尾部不留存：召回、骰池与现值每轮都换，留在历史里只会推高累计长度
    transcript: structuredClone(messages.slice(0, retainedCount)),
    sections,
    source: currentSource,
    revision,
  });
  return ticket;
}

/** Called only after the originating state/message transaction has been accepted. */
export async function acceptDirectContext(
  ticket: DirectCacheTicket,
  result: { acceptedMessages: ChatMessage[] },
): Promise<void> {
  const record = pending.get(ticket);
  if (!record) return;
  pending.delete(ticket);
  // 历史里只留玩家看到的正文；状态声明不进历史，现状一律由 direct_context 与本轮尾部给出
  record.transcript.push({
    role: 'assistant',
    content: result.acceptedMessages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n\n'),
  });
  const ids = new Set(record.source.map((m) => m.id));
  record.source.push(...source(result.acceptedMessages).filter((m) => !ids.has(m.id)));
  sessions.set(ticket.saveId, record);
  discards.delete(ticket.saveId);
  try {
    await store?.save(record);
  } catch {
    /* A failed cache write must never replay accepted gameplay. */
  }
}

/**
 * 丢弃一次未接纳的尝试：模型输出被拒绝、取消或提交前校验失败时，存档未变，
 * 上一份已接纳的会话仍与历史一致，下一次尝试继续复用其前缀。已接纳或已丢弃的票据为空操作。
 * 连续丢弃达到上限后，下一次准备改为冷建（`repeated_rejection`）。
 */
export function discardDirectContext(ticket: DirectCacheTicket): void {
  if (!pending.delete(ticket)) return;
  discards.set(ticket.saveId, (discards.get(ticket.saveId) ?? 0) + 1);
}

export function invalidateDirectContext(saveId: string): void {
  generations.delete(saveId);
  discards.delete(saveId);
  sessions.delete(saveId);
  for (const ticket of pending.keys()) if (ticket.saveId === saveId) pending.delete(ticket);
  void store?.delete(saveId).catch(() => undefined);
}
