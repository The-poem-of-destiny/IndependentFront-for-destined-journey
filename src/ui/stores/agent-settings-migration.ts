/**
 * per-Agent 设置的形状迁移：12 张并行 map → 一张 `agents` 表（Q-18 第 4 步）。
 *
 * ## 与「六步迁移」的关系
 *
 * `legacy-dexie-migration.ts` 那套六步是给 **localStorage → Dexie** 用的：跨存储、
 * 要销毁唯一副本，所以必须有标志位、单事务、回读校验、校验过了才删源。
 *
 * 本迁移**不是**那一类：它在**同一个 settings 对象内**重排字段，一个字节都不跨存储。
 * 于是这里刻意做得更简单，而且更安全：
 *
 * - **没有标志位**。「旧键还在不在」本身就是信号，合并完它们就没了 —— 幂等由构造保证，
 *   不需要第二个真相来源来记「做过没有」。
 * - **在 `ref()` 之前跑**（settings-store 构造期，同步）。于是响应式状态从第一拍起
 *   就只有新形状，读取侧**不需要**兼容分支 —— 没有「有时是 map、有时是 agents」这种
 *   两套并存的形态可以漂移。
 * - **纯函数、无 I/O**。落盘由 store 原有的 deep watch 负责；本函数只改内存对象。
 *
 * 最坏情况是这个函数什么都没干（旧键原样留着），用户的设置一个字节都不会丢 ——
 * 这与 Dexie 那套「删错了就没了」的风险级别不是一回事，所以不必套同一副护具。
 *
 * ## 冲突口径：`agents` 赢
 *
 * 正常情况下 `agents` 与旧 map 不会同时存在。真的同时存在只可能是**另一个标签页
 * 用旧版本代码写回了 localStorage**。这时以 `agents` 为准，旧 map 只填 `agents`
 * 里还没有的 agentId —— 反过来会让旧标签页的陈旧值盖掉新标签页刚改的设置。
 */
import type { AgentSettingsEntry } from './agent-settings';

/**
 * 旧键名 → `AgentSettingsEntry` 字段名。
 *
 * 🔴 `agentDirty` **不在这张表里**，也不进 `AgentSettingsEntry`：它是「有未保存的改动」
 *    这个 UI 状态，不是一项设置。混进条目会让它跟着 `saveAsDefault` 一路写进
 *    `data/defaults/agent-config.json`（那份文件的形状是 `AgentDefaultEntry`，
 *    两者刻意同形）。它继续作为自己的一张 map 存在。
 *
 * `agentPromptEdited` 同理不在这里 —— 它压根不是 per-Agent 的，是个全局布尔。
 */
export const LEGACY_AGENT_MAPS: ReadonlyArray<readonly [string, keyof AgentSettingsEntry]> = [
  ['agentModels', 'model'],
  ['agentWorldbookEnabled', 'worldBookEnabled'],
  ['agentWorldbookIds', 'worldBookIds'],
  ['agentPrompts', 'systemPrompt'],
  ['agentTemplates', 'template'],
  ['agentTemperature', 'temperature'],
  ['agentTopP', 'topP'],
  ['agentFreqPen', 'freqPen'],
  ['agentPresPen', 'presPen'],
  ['agentMaxTokens', 'maxTokens'],
  ['agentHistoryLayers', 'historyLayers'],
  ['agentHistorySlice', 'historySlice'],
] as const;

export interface AgentMapsMigrationResult {
  /** 本次真的搬了东西吗（false = 旧键一个都不在，全新用户或已迁过） */
  migrated: boolean;
  /** 搬进 `agents` 的 agentId（按首次出现顺序，便于测试与排查） */
  agentIds: string[];
  /** 实际删掉的旧键 */
  removedKeys: string[];
  /**
   * 因为 `agents` 里已有同名 agentId 而被丢弃的旧 map 值（跨标签页写回才会发生）。
   * 有值就说明用户开着两个版本的标签页 —— 值得记一笔，不值得为它做别的事。
   */
  skippedAgentIds: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 就地把 12 张旧 map 折进 `bag.agents`，然后删掉旧键。
 *
 * **必须在 settings 被 `ref()` 包起来之前调用**（见文件头）。调用后 `bag.agents`
 * 一定是一个对象；旧键一定不存在。
 *
 * 语义逐条保留：
 * - `historyLayers` / `historySlice` **只在旧 map 里真的有这个键时才写**。
 *   写 `undefined` 与不写在这里语义不同 —— 前者会让 `'historyLayers' in entry` 成立，
 *   从而挡掉引擎按 agent 类别给的默认。
 * - 其余字段缺省不补默认值：合默认是**读取时**（`getAgentSettings`）的事，
 *   在这里补会把「用户从没设过」与「用户设成了恰好等于默认的值」永久混为一谈。
 */
export function migrateLegacyAgentMaps(bag: Record<string, unknown>): AgentMapsMigrationResult {
  const present = LEGACY_AGENT_MAPS.filter(([key]) => isPlainObject(bag[key]));

  if (!isPlainObject(bag.agents)) bag.agents = {};
  const agents = bag.agents as Record<string, Partial<AgentSettingsEntry>>;

  if (present.length === 0) {
    // 旧键一个都不在：全新用户，或上一次已经搬完。什么都不做。
    return { migrated: false, agentIds: [], removedKeys: [], skippedAgentIds: [] };
  }

  // 🔴 **进循环前**把「本来就在 agents 里的 agentId」snapshot 下来。
  //    不能在循环里现查 —— 第一张 map 就会为 'story' 建好 `agents.story`，
  //    于是第二张 map 的 'story' 会被自己刚建的那条判成冲突而跳过，
  //    一个 agent 只能搬到一个字段。
  const preexisting = new Set(Object.keys(agents));

  const agentIds: string[] = [];
  const skipped = new Set<string>();

  for (const [legacyKey, field] of present) {
    const map = bag[legacyKey] as Record<string, unknown>;
    for (const agentId of Object.keys(map)) {
      // 冲突口径：`agents` 本来就有这个 agent 就不动它（见文件头）
      if (preexisting.has(agentId)) {
        skipped.add(agentId);
        continue;
      }
      if (!agentIds.includes(agentId)) agentIds.push(agentId);
      const entry = (agents[agentId] ??= {}) as Record<string, unknown>;
      entry[field] = map[agentId];
    }
  }

  // 删源放在最后：上面任何一步抛了，旧键都还在，下次启动原样重来
  const removedKeys = present.map(([key]) => key);
  for (const key of removedKeys) delete bag[key];

  return {
    migrated: agentIds.length > 0 || removedKeys.length > 0,
    agentIds,
    removedKeys,
    skippedAgentIds: [...skipped],
  };
}
