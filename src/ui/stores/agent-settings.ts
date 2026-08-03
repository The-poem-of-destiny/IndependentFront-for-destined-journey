/**
 * per-Agent 设置的读写口（Q-18）。
 *
 * per-Agent 配置在 settings 里摊成 **13 张用同一个 agentId 作键的兄弟 map**
 * （agentModels / agentWorldbookEnabled / … / agentHistorySlice）。形状正确的记录类型
 * `AgentDefaultEntry` 就在 settings-store 同一文件里，却只用于磁盘上的项目默认值文件，
 * 从不用于活状态。
 *
 * 后果是每个操作都变成一段 13 行的手抄：`saveAsDefault` 把 13 个值读进一个对象字面量、
 * `restoreAgentDefaults` 写回**两遍**（一遍来自项目默认、一遍来自硬编码兜底，两个分支
 * 只差取值来源）、settings-store 的项目默认加载器再抄一遍。加第 14 个旋钮要改七处，
 * 漏改一张 map 会产出一个「UI 上看着正常」的半恢复 Agent。
 *
 * 同一批字面默认值（0.7 / 1.0 / 0 / 0 / 16384）在四个文件六处重述 —— 今天取值仍然
 * 一致纯属运气，漏掉 game-pipeline 那处就是「设置页显示新默认、运行时用旧值」，
 * 这类偏差要到账单上才可见。
 *
 * ---
 *
 * 本模块只做**读写口**，不改持久化形状：13 张 map 仍是磁盘格式。
 * 物理合并成 `agents: Record<string, AgentSettingsEntry>` 要配一次性迁移 +
 * 动 SettingsPage 87 处 v-model，那是独立一步；先把所有调用点收进这三个函数，
 * 那一步就退化成只改本文件。
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

/** 13 张 map 的键名 → 条目字段名。合并那一步只需删掉这张表 */
const MAP_KEY: Record<string, string> = {
  model: 'agentModels',
  worldBookEnabled: 'agentWorldbookEnabled',
  worldBookIds: 'agentWorldbookIds',
  systemPrompt: 'agentPrompts',
  template: 'agentTemplates',
  temperature: 'agentTemperature',
  topP: 'agentTopP',
  freqPen: 'agentFreqPen',
  presPen: 'agentPresPen',
  maxTokens: 'agentMaxTokens',
  historyLayers: 'agentHistoryLayers',
  historySlice: 'agentHistorySlice',
};

/** settings 袋子（settings-store 的 `settings.value`）—— 目前还是 `Record<string, any>` */
type SettingsBag = Record<string, any>;

function bucket(bag: SettingsBag, field: string): Record<string, unknown> {
  const key = MAP_KEY[field];
  if (!bag[key] || typeof bag[key] !== 'object') bag[key] = {};
  return bag[key] as Record<string, unknown>;
}

function read<T>(bag: SettingsBag, field: string, agentId: string): T | undefined {
  const map = bag[MAP_KEY[field]];
  if (!map || typeof map !== 'object') return undefined;
  return (map as Record<string, T>)[agentId];
}

/**
 * 取一个 Agent 的完整设置，数值项合上默认。调用方从此不写 `?? 0.7`。
 *
 * `historyLayers` / `historySlice` 刻意**不合默认**（见 `AgentSettingsEntry` 上的注释）。
 */
export function getAgentSettings(bag: SettingsBag, agentId: string): AgentSettingsEntry {
  return {
    model: read<string>(bag, 'model', agentId) ?? '',
    worldBookEnabled: read<boolean>(bag, 'worldBookEnabled', agentId) ?? false,
    worldBookIds: [...(read<string[]>(bag, 'worldBookIds', agentId) ?? [])],
    systemPrompt: read<string>(bag, 'systemPrompt', agentId) ?? '',
    template: read<string>(bag, 'template', agentId) ?? '',
    temperature: read<number>(bag, 'temperature', agentId) ?? AGENT_SETTINGS_DEFAULTS.temperature,
    topP: read<number>(bag, 'topP', agentId) ?? AGENT_SETTINGS_DEFAULTS.topP,
    freqPen: read<number>(bag, 'freqPen', agentId) ?? AGENT_SETTINGS_DEFAULTS.freqPen,
    presPen: read<number>(bag, 'presPen', agentId) ?? AGENT_SETTINGS_DEFAULTS.presPen,
    maxTokens: read<number>(bag, 'maxTokens', agentId) ?? AGENT_SETTINGS_DEFAULTS.maxTokens,
    // 不合默认：缺省 = 走引擎按类别给的默认
    historyLayers: read<number>(bag, 'historyLayers', agentId),
    historySlice: read<number>(bag, 'historySlice', agentId),
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
  for (const [field, value] of Object.entries(patch)) {
    if (!(field in MAP_KEY)) continue;
    const map = bucket(bag, field);
    if (value === undefined) delete map[agentId];
    else map[agentId] = value;
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
 * 此前是一段 13 个 `if (!(agentId in map))` 的手抄。
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

  const patch: Partial<AgentSettingsEntry> = {};
  for (const [field, value] of Object.entries(full)) {
    if (agentId in bucket(bag, field)) continue;
    (patch as Record<string, unknown>)[field] = value;
  }
  patchAgentSettings(bag, agentId, patch);
}
