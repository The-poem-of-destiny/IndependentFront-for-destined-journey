/**
 * per-Agent 设置的读写口（Q-18）。
 *
 * per-Agent 配置**曾经**在 settings 里摊成 12 张用同一个 agentId 作键的兄弟 map
 * （agentModels / agentWorldbookEnabled / … / agentHistorySlice）。形状正确的记录类型
 * `AgentDefaultEntry` 就在 settings-store 同一文件里，却只用于磁盘上的项目默认值文件，
 * 从不用于活状态。
 *
 * 后果是每个操作都变成一段 12 行的手抄：`saveAsDefault` 把 12 个值读进一个对象字面量、
 * `restoreAgentDefaults` 写回**两遍**（一遍来自项目默认、一遍来自硬编码兜底，两个分支
 * 只差取值来源）、settings-store 的项目默认加载器再抄一遍。加第 13 个旋钮要改七处，
 * 漏改一张 map 会产出一个「UI 上看着正常」的半恢复 Agent。
 *
 * 同一批字面默认值（0.7 / 1.0 / 0 / 0 / 16384）曾在四个文件六处重述 —— 那时取值仍然
 * 一致纯属运气，漏掉 game-pipeline 那处就是「设置页显示新默认、运行时用旧值」，
 * 这类偏差要到账单上才可见。
 *
 * ---
 *
 * **现在的形状**：`settings.agents: Record<agentId, AgentSettingsEntry>`，一个 agent 一条。
 * 老用户的 12 张 map 由 `agent-settings-migration.ts` 在 store 构造期（`ref()` 之前）
 * 折进来，所以响应式状态里**只会有新形状** —— 本模块不带兼容分支，也就没有
 * 「有时是 map、有时是 agents」这种可以漂移的两套并存形态。
 *
 * 🔴 `agentDirty`（有未保存改动）**刻意不在这里**：它是 UI 状态不是设置。混进条目会
 *    跟着 `saveAsDefault` 一路写进 `data/defaults/agent-config.json`，而那份文件的
 *    形状是 `AgentDefaultEntry` —— 两者刻意同形，别把 UI 状态塞进去。
 */

/** 一个 Agent 的全部可调项 —— 与 `AgentDefaultEntry` 同形（后者是磁盘上的项目默认值） */
export interface AgentSettingsEntry {
  model: string;
  worldBookEnabled: boolean;
  worldBookIds: string[];
  systemPrompt: string;
  template: string;
  temperature: number;
  topP: number;
  freqPen: number;
  presPen: number;
  maxTokens: number;
  /**
   * 历史对话注入层数。
   *
   * 🔴 **必须保持可缺省**，且 `getAgentSettings` **不得**给它合并默认值 ——
   * 「键不存在」在这里编码的是「按 agent 类别走引擎默认」，合并会把那条语义静默覆盖掉
   * （引擎按 story / 侧链等类别给的默认各不相同）。`historySlice` 同理。
   */
  historyLayers?: number;
  /** 每条历史正文截断字数。缺省语义同 `historyLayers` */
  historySlice?: number;
}

/**
 * 数值旋钮的默认值 —— **全应用唯一出现的地方**。
 *
 * 改 maxTokens 此前要找六处字面量。
 */
export const AGENT_SETTINGS_DEFAULTS = {
  temperature: 0.7,
  topP: 1.0,
  freqPen: 0,
  presPen: 0,
  maxTokens: 16384,
} as const;

/** settings 袋子（settings-store 的 `settings.value`） */
type SettingsBag = Record<string, any>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 只读取，绝不建结构 —— 读一个从没配过的 agent 不该在袋子里留下空壳 */
function peek(bag: SettingsBag, agentId: string): Record<string, unknown> | null {
  const agents = bag.agents;
  if (!isPlainObject(agents)) return null;
  const entry = agents[agentId];
  return isPlainObject(entry) ? entry : null;
}

/** 写入用：缺哪层补哪层 */
function ensure(bag: SettingsBag, agentId: string): Record<string, unknown> {
  if (!isPlainObject(bag.agents)) bag.agents = {};
  const agents = bag.agents as Record<string, unknown>;
  if (!isPlainObject(agents[agentId])) agents[agentId] = {};
  return agents[agentId] as Record<string, unknown>;
}

function read<T>(
  bag: SettingsBag,
  agentId: string,
  field: keyof AgentSettingsEntry,
): T | undefined {
  const entry = peek(bag, agentId);
  return entry ? (entry[field] as T | undefined) : undefined;
}

/**
 * 取一个 Agent 的完整设置，数值项合上默认。调用方从此不写 `?? 0.7`。
 *
 * `historyLayers` / `historySlice` 刻意**不合默认**（见 `AgentSettingsEntry` 上的注释）。
 */
export function getAgentSettings(bag: SettingsBag, agentId: string): AgentSettingsEntry {
  return {
    model: read<string>(bag, agentId, 'model') ?? '',
    worldBookEnabled: read<boolean>(bag, agentId, 'worldBookEnabled') ?? false,
    worldBookIds: [...(read<string[]>(bag, agentId, 'worldBookIds') ?? [])],
    systemPrompt: read<string>(bag, agentId, 'systemPrompt') ?? '',
    template: read<string>(bag, agentId, 'template') ?? '',
    temperature: read<number>(bag, agentId, 'temperature') ?? AGENT_SETTINGS_DEFAULTS.temperature,
    topP: read<number>(bag, agentId, 'topP') ?? AGENT_SETTINGS_DEFAULTS.topP,
    freqPen: read<number>(bag, agentId, 'freqPen') ?? AGENT_SETTINGS_DEFAULTS.freqPen,
    presPen: read<number>(bag, agentId, 'presPen') ?? AGENT_SETTINGS_DEFAULTS.presPen,
    maxTokens: read<number>(bag, agentId, 'maxTokens') ?? AGENT_SETTINGS_DEFAULTS.maxTokens,
    // 不合默认：缺省 = 走引擎按类别给的默认
    historyLayers: read<number>(bag, agentId, 'historyLayers'),
    historySlice: read<number>(bag, agentId, 'historySlice'),
  };
}

/**
 * 改一个 Agent 的若干项。
 *
 * `undefined` 表示**删掉这个键**而不是写入 undefined —— 对
 * `historyLayers` / `historySlice` 来说这两件事语义不同（后者会让「键存在」成立，
 * 从而挡掉引擎默认）。
 */
export function patchAgentSettings(
  bag: SettingsBag,
  agentId: string,
  patch: Partial<AgentSettingsEntry>,
): void {
  const entry = ensure(bag, agentId);
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete entry[field];
    else entry[field] = value;
  }
}

/**
 * 把一个 Agent 恢复成给定来源（项目默认值），来源缺项时落到
 * {@link AGENT_SETTINGS_DEFAULTS}。
 *
 * 这一份吸收了 `restoreAgentDefaults` 原有的**两个分支** —— 它们只差取值来源，
 * 代码路径一模一样，却各写一遍 `?? 0.7 / ?? 16384`。不传 `from` 即「恢复出厂」。
 */
export function resetAgentSettings(
  bag: SettingsBag,
  agentId: string,
  from?: Partial<AgentSettingsEntry>,
): AgentSettingsEntry {
  const src = from ?? {};
  const next: AgentSettingsEntry = {
    model: src.model ?? '',
    worldBookEnabled: src.worldBookEnabled ?? false,
    worldBookIds: [...(src.worldBookIds ?? [])],
    systemPrompt: src.systemPrompt ?? '',
    template: src.template ?? '',
    temperature: src.temperature ?? AGENT_SETTINGS_DEFAULTS.temperature,
    topP: src.topP ?? AGENT_SETTINGS_DEFAULTS.topP,
    freqPen: src.freqPen ?? AGENT_SETTINGS_DEFAULTS.freqPen,
    presPen: src.presPen ?? AGENT_SETTINGS_DEFAULTS.presPen,
    maxTokens: src.maxTokens ?? AGENT_SETTINGS_DEFAULTS.maxTokens,
    // 来源没给就**删掉键**，把「走引擎默认」这条语义还回去
    historyLayers: src.historyLayers,
    historySlice: src.historySlice,
  };
  patchAgentSettings(bag, agentId, next);
  return next;
}

/**
 * 对**尚未被用户配置过**的项补上来源里的值（项目默认值加载器用）。
 *
 * 与 `resetAgentSettings` 的区别：这个只填空位，不覆盖用户已改过的项。
 * 此前是一段 12 个 `if (!(agentId in map))` 的手抄。
 */
export function fillMissingAgentSettings(
  bag: SettingsBag,
  agentId: string,
  from: Partial<AgentSettingsEntry>,
): void {
  // 先算出「这个来源该有的完整形状」（缺项落到出厂默认），再只填空位。
  // 这样 model/systemPrompt 等在来源缺项时仍写入 '' —— 与旧逐行实现一致。
  const full = {
    model: from.model ?? '',
    worldBookEnabled: from.worldBookEnabled ?? false,
    worldBookIds: [...(from.worldBookIds ?? [])],
    systemPrompt: from.systemPrompt ?? '',
    temperature: from.temperature ?? AGENT_SETTINGS_DEFAULTS.temperature,
    topP: from.topP ?? AGENT_SETTINGS_DEFAULTS.topP,
    freqPen: from.freqPen ?? AGENT_SETTINGS_DEFAULTS.freqPen,
    presPen: from.presPen ?? AGENT_SETTINGS_DEFAULTS.presPen,
    maxTokens: from.maxTokens ?? AGENT_SETTINGS_DEFAULTS.maxTokens,
  } as Partial<AgentSettingsEntry>;

  // 这三项**只在来源真的给了才写**（旧实现如此，且对后两者是语义相关的：
  // 无条件写入会让「键存在」成立，从而挡掉引擎按类别给的默认）
  if (from.template) full.template = from.template;
  if (from.historyLayers !== undefined) full.historyLayers = from.historyLayers;
  if (from.historySlice !== undefined) full.historySlice = from.historySlice;

  const existing = peek(bag, agentId);
  const patch: Partial<AgentSettingsEntry> = {};
  for (const [field, value] of Object.entries(full)) {
    if (existing && field in existing) continue;
    (patch as Record<string, unknown>)[field] = value;
  }
  patchAgentSettings(bag, agentId, patch);
}

/**
 * 列出袋子里已有条目的 agentId。
 *
 * 12 张 map 时代要问这个问题得把 12 张表的键取并集 —— 于是没人问，
 * 每处都改成「拿一张写死的 agentList 去遍历」。合并之后它是一行。
 */
export function listConfiguredAgents(bag: SettingsBag): string[] {
  return isPlainObject(bag.agents) ? Object.keys(bag.agents) : [];
}

/**
 * 把「所有 Agent 的世界书清单」当成一张 `Record<agentId, string[]>` 来整体改写。
 *
 * 工坊装/卸要给**每个** Agent 的清单加/删同一个 bookId，那两个纯函数
 * （`grantWorkshopBookToAgents` / `revokeWorkshopBookFromAgents`）本来就是按
 * 「一张 map 进、一张 map 出」写的，并且带着自己的测试。合并之后 map 不再存在，
 * 但**没必要**把它们改成认 `agents` —— 那会把工坊的纯函数绑死在设置的存储形状上。
 * 于是投影这一步收在这里：读出来一张 map、交给调用方变换、再写回条目。
 *
 * 只动 `worldBookIds`，其余字段一个不碰（`worldBookEnabled` 尤其不能顺手开 ——
 * 见 `grantWorkshopBookToAgents` 的注释）。
 */
export function updateAgentWorldBookIds(
  bag: SettingsBag,
  transform: (current: Record<string, string[]>) => Record<string, string[]>,
): void {
  const current: Record<string, string[]> = {};
  for (const agentId of listConfiguredAgents(bag)) {
    const ids = read<string[]>(bag, agentId, 'worldBookIds');
    current[agentId] = Array.isArray(ids) ? [...ids] : [];
  }
  const next = transform(current);
  for (const [agentId, ids] of Object.entries(next)) {
    patchAgentSettings(bag, agentId, { worldBookIds: [...ids] });
  }
}
