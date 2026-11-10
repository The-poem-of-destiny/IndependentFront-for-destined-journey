import type { ChatMessage } from '../types/types';
import type { LlmMessage, NativeLlmContent } from '../types/types-api';

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
  messages: LlmMessage[];
  revision: number;
  rebaseReason?: string;
}

const sessions = new Map<string, DirectCacheRecord>();
const pending = new Map<DirectCacheTicket, DirectCacheRecord>();
const generations = new Map<string, object>();
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

export const DIRECT_CACHE_PROTOCOL = `上下文采用直出缓存会话。direct_context 是本轮权威输入：set 中的每个顶层字段整块替换旧值，remove 明确删除旧字段；禁止把替换解释成数值增减或追加物品。未变化的字段沿用最近值。旧 assistant 中的状态声明只属于历史，不再执行或重复领奖。turn_context.dice_pool 的每项为 [骰面数,骰值]，数组下标就是 diceUsed.index。每轮只使用最新 turn_context 的玩家输入、骰池与召回，不使用旧轮骰池。战斗与资源以本轮 app 状态为准。`;

export async function prepareDirectContext(input: {
  saveId: string;
  signature: string;
  frame: DirectContextFrame;
  turn: string;
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
  const signature = serializeDirectContext([input.signature, input.frame.prefix]);
  const sections = JSON.parse(serializeDirectContext(input.frame.sections)) as Record<
    string,
    unknown
  >;
  const pack = (set: Record<string, unknown>, remove: string[]) => ({
    role: 'user' as const,
    content: `<direct_context>\n${serializeDirectContext({ set, remove })}\n</direct_context>\n${input.turn}`,
  });
  const fresh = [...input.frame.prefix, ...input.frame.history, pack(sections, [])];
  let reason = !previous
    ? 'missing_session'
    : previous.protocol !== 'direct-cache-v1'
      ? 'protocol_changed'
      : reentered
        ? 'reentered'
        : previous.signature !== signature
          ? 'configuration_or_lore_changed'
          : previous.source.some(
                (m, i) => serializeDirectContext(m) !== serializeDirectContext(currentSource[i]),
              )
            ? 'history_changed'
            : previous.revision >= 8
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
    // Always reaffirm combat and current resources, even if the model's last reply claimed otherwise.
    for (const key of ['combat', 'resources']) if (key in sections) changed[key] = sections[key];
    messages = [
      ...previous.transcript,
      pack(
        changed,
        Object.keys(previous.sections).filter((k) => !(k in sections)),
      ),
    ];
    if (size(messages) > size(fresh) * 1.4) reason = 'transcript_growth';
    else if (
      input.contextWindowTokens &&
      Math.ceil(size(messages) / 1.5) + input.outputBudget > input.contextWindowTokens
    )
      reason = 'context_budget';
    if (reason) messages = fresh;
  }
  if (
    input.contextWindowTokens &&
    Math.ceil(size(messages) / 1.5) + input.outputBudget > input.contextWindowTokens
  )
    throw new Error('直出缓存基线上下文仍超出模型窗口，请缩短历史或调整输出预留');
  const revision = reason ? 1 : previous!.revision + 1;
  const ticket: DirectCacheTicket = {
    saveId: input.saveId,
    messages,
    revision,
    rebaseReason: reason,
  };
  pending.set(ticket, {
    key: directCacheKey(input.saveId),
    saveId: input.saveId,
    agentId: 'direct_cached',
    protocol: 'direct-cache-v1',
    signature,
    transcript: structuredClone(messages),
    sections,
    source: currentSource,
    revision,
  });
  return ticket;
}

/** Called only after the originating state/message transaction has been accepted. */
export async function acceptDirectContext(
  ticket: DirectCacheTicket,
  result: {
    rawResponse: string;
    nativeAssistant?: NativeLlmContent;
    acceptedMessages: ChatMessage[];
  },
): Promise<void> {
  const record = pending.get(ticket);
  if (!record) return;
  pending.delete(ticket);
  record.transcript.push({
    role: 'assistant',
    content: result.rawResponse,
    native: result.nativeAssistant,
  });
  const ids = new Set(record.source.map((m) => m.id));
  record.source.push(...source(result.acceptedMessages).filter((m) => !ids.has(m.id)));
  sessions.set(ticket.saveId, record);
  try {
    await store?.save(record);
  } catch {
    /* A failed cache write must never replay accepted gameplay. */
  }
}

export function invalidateDirectContext(saveId: string): void {
  generations.delete(saveId);
  sessions.delete(saveId);
  for (const ticket of pending.keys()) if (ticket.saveId === saveId) pending.delete(ticket);
  void store?.delete(saveId).catch(() => undefined);
}
