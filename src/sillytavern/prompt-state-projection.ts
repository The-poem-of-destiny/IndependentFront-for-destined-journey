/**
 * prompt-state-projection.ts — 读取型投影与纯 diff（LLM 组装层 Delta 会话 · T1）
 *
 * 用途：把「当前权威状态」投影成只读、幂等的 `PromptStateProjection`，再对两份投影
 *       做纯 diff 产出 `PromptDeltaOp[]`，最后序列化进 `<context_delta>` 外壳。
 *       它是 `prompt-session-assembler.ts`（T2）的纯函数基座 —— 本模块**无 I/O、
 *       无全局状态、无 Math.random、无时钟**，也不 import StateManager / database /
 *       UI store / provider client（设计 §7 / 计划 §5 的纯度约束）。
 *
 * 设计真源：
 *   docs/planning/2026-08-22-llm-assembly-delta-architecture-scratch.md §7
 *     （7.1 不复用 StatePatch / 7.2 最小操作集 / 7.3 投影粒度 / 7.4 占位符分类）
 *   + docs/planning/2026-08-22-llm-assembly-delta-implementation-plan.md §5（T1）。
 *
 * 关键不变量：
 * - `PromptScope` 是**封闭联合**，不接受任意路径字符串；v1 支持面从设计 §7.4 的
 *   projection-backed 占位符 + 现状 `AgentContext` 可读字段推导（映射表见 scope 注释）。
 * - delta 数据面只有 `set` / `upsert` / `remove` 三种 op（设计 §7.2）；`rebase` 是给
 *   session assembler 的**控制信号**（NARRATIVE 检测到历史被编辑/删除/重排时），
 *   **永不渲染进 context_delta**（renderPromptDelta 收到即抛错）。
 * - 所有集合先按**逻辑名字**归一化成 Map 再比较（数组重排不产生 delta）。
 * - 变化判断一律用规范化内容深比较（`deepEqualValues`），**禁止**对象引用 `!==`。
 * - 输出按 scope / owner / name / field 固定排序，value 递归按键排序后 JSON 序列化，
 *   保证「相同输入多次渲染字节一致」。
 * - 名字（owner / name）一律是 AI 可见名称（角色名 / 物品名 / 技能名 / 任务名 /
 *   变量全名），**不是内部 id**；含中文 / 点号 / 方括号的名字只作为 JSON 值存在，
 *   从不拼路径。
 */

import type {
  AgentContext,
  CharacterState,
  ChatMessage,
  InventoryItem,
  MemoryRecord,
  Skill,
  StatusEffect,
} from './types';

// ═══════════════════════════════════════════════════════════
// 封闭 scope 联合
// ═══════════════════════════════════════════════════════════

/**
 * v1 支持的投影 scope（封闭联合，不接受任意路径字符串）。
 *
 * 推导依据（设计 §7.4 projection-backed 占位符 → AgentContext 可读字段）：
 *
 * | scope           | 来源占位符             | 粒度 / op                                  | 索引                          |
 * | --------------- | ---------------------- | ------------------------------------------ | ----------------------------- |
 * | `character`     | CHARACTER_STATE        | 角色基础字段（不含资源）：`set`            | owner=角色名, field=字段名    |
 * | `resource`      | CHARACTER_STATE        | hp/mp/sp：`set`                            | owner=角色名, field=资源字段  |
 * | `inventory`     | INVENTORY              | 背包物品整元素：`upsert`/`remove`          | owner=角色名, name=物品名     |
 * | `skill`         | SKILL_STATE            | 技能整元素：`upsert`/`remove`              | owner=角色名, name=技能名     |
 * | `status_effect` | ACTIVE_EFFECTS         | 状态效果整元素：`upsert`/`remove`          | owner=角色名, name=效果名     |
 * | `quest`         | QUEST_STATE            | 任务整元素：`upsert`/`remove`              | name=任务名                   |
 * | `affection`     | GAME_TIME（好感度）    | 好感度标量：`set`                          | owner=角色名, field='value'   |
 * | `variable`      | GAME_TIME（世界键）    | 叙事变量标量：`set`/`remove`               | name=变量全名（含命名空间）   |
 * | `time`          | GAME_TIME              | 游戏时间标量：`set`                        | field=时间字段                |
 * | `plot`          | PLOT_EVENTS            | 剧情进度快照：`set`                        | field='value'                 |
 * | `map`           | MAP_CONTEXT            | 地图上下文整块：`upsert`/`remove`          | name='context'                |
 * | `lore_dynamic`  | LORE_BOOK_DYNAMIC      | 动态世界书整块：`upsert`/`remove`          | name='dynamic'                |
 * | `memory`        | MEMORY_ENTRIES         | 记忆条目整元素：`upsert`/`remove`          | name=记忆 id（AI 已见）       |
 * | `narrative`     | NARRATIVE              | 历史 append：`upsert`；异常时 `rebase`     | name=消息 id（append cursor） |
 *
 * 不进入投影（设计 §7.3 / §7.4）：`USER_INPUT`、`RANDOM_EVENTS`、`RECENT_COMBAT`、
 * `AGENT.*` 与链占位符 —— 它们属于每轮的 `turn_context`，不是持久状态。
 */
export type PromptScope =
  | 'character'
  | 'resource'
  | 'inventory'
  | 'skill'
  | 'status_effect'
  | 'quest'
  | 'affection'
  | 'variable'
  | 'time'
  | 'plot'
  | 'map'
  | 'lore_dynamic'
  | 'memory'
  | 'narrative';

/**
 * delta 操作（设计 §7.2 最小操作集 + narrative 控制信号）。
 *
 * 数据面只有三种：
 * - `set`    标量字段（时间 / 位置 / HP / 好感度 / 普通变量 / 剧情进度快照）。
 * - `upsert` 按名字寻址的完整集合元素（技能 / 物品 / 状态效果 / 任务 / 记忆 /
 *            历史消息 / 整块富文本 block）。存在则更新、不存在则新增。
 * - `remove` 删除按名字寻址的集合元素。
 *
 * `rebase` 是**控制信号**：NARRATIVE 检测到已表示消息被修改 / 删除 / 重排（或
 * previous/current 属于不同 Agent）时返回，表示「必须重基线」，**不产伪 delta**。
 * 它只给 session assembler 读，renderPromptDelta 收到会抛错（调用方应先判断重基线）。
 */
export type PromptDeltaOp =
  | { op: 'set'; scope: PromptScope; owner?: string; name?: string; field: string; value: unknown }
  | { op: 'upsert'; scope: PromptScope; owner?: string; name: string; value: unknown }
  | { op: 'remove'; scope: PromptScope; owner?: string; name: string }
  | { op: 'rebase'; reason: PromptRebaseReason };

/** rebase 的控制原因（机器可读 token，供 T2 记日志 / 判据用） */
export type PromptRebaseReason = 'narrative_changed' | 'narrative_truncated' | 'agent_changed';

/**
 * 读取型、幂等的状态投影 —— session assembler 保存的 diff 起点（设计 §5.2）。
 *
 * 语义：只描述「现在是什么」，不描述「为何变成这样」（设计 §7.1，不复用 StatePatch）。
 * 除 `agentId` 与 `narrative` 外全部按**逻辑名字**归一化成 Map / 标量。
 */
export interface PromptStateProjection {
  /** 投影所属 Agent id（自校验：跨 Agent 的 diff 是调用方 bug → rebase） */
  agentId: string;
  /** 角色基础字段：角色名 → 字段名 → 值（不含资源 / 集合 / customFields） */
  characters: Record<string, Record<string, unknown>>;
  /** 角色资源：角色名 → 资源字段名 → 数值（hp/maxHp/mp/maxMp/sp/maxSp） */
  resources: Record<string, Record<string, number>>;
  /** 背包物品：角色名 → 物品名 → 整元素投影 */
  inventory: Record<string, Record<string, unknown>>;
  /** 技能：角色名 → 技能名 → 整元素投影 */
  skills: Record<string, Record<string, unknown>>;
  /** 状态效果：角色名 → 效果名 → 整元素投影 */
  statusEffects: Record<string, Record<string, unknown>>;
  /** 任务：任务名 → 整元素投影 */
  quests: Record<string, unknown>;
  /** 好感度：角色名 → 数值 */
  affections: Record<string, number>;
  /** 叙事变量：变量全名（含命名空间点号，如 `sys.天气`）→ 值 */
  variables: Record<string, unknown>;
  /** 游戏时间：时间字段 → 值；null = 无时钟 */
  time: Record<string, string | number> | null;
  /** 剧情进度快照（PLOT_EVENTS 的 active/pending 摘要）；null = 无剧情进度 */
  plot: unknown;
  /** 地图上下文快照（派生态 + 事实态 + 天气）；null = 未启用地图 */
  map: unknown;
  /** 动态世界书求值结果（整块 upsert 的 value）；null = 无动态区 */
  loreDynamic: string | null;
  /** 记忆条目：记忆 id → 整元素投影（剥离 AI 不可见字段） */
  memories: Record<string, unknown>;
  /** 历史消息（含 id —— append cursor 依据；只保留 AI 可见字段） */
  narrative: Array<Pick<ChatMessage, 'id' | 'role' | 'content'>>;
}

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 角色基础字段投影时排除的顶层键（资源 / 集合 / 内部 id / 自由扩展） */
const CHARACTER_BASE_EXCLUDED: ReadonlySet<string> = new Set([
  'id',
  'saveId',
  'name', // name 是 owner 索引，不重复 set
  'hp',
  'maxHp',
  'mp',
  'maxMp',
  'sp',
  'maxSp',
  'skills',
  'inventory',
  'statusEffects',
  'customFields',
]);

/** 资源 scope 的字段（与 CharacterState 资源区一一对应） */
const RESOURCE_FIELDS = ['hp', 'maxHp', 'mp', 'maxMp', 'sp', 'maxSp'] as const;

/** 时间 scope 的字段（GameTime 六个标量 + 纪元标签） */
const TIME_FIELDS = ['era', 'year', 'month', 'day', 'weekday', 'hour', 'minute'] as const;

/** 地图整块 upsert 的固定 name */
const MAP_BLOCK_NAME = 'context';
/** 动态世界书整块 upsert 的固定 name */
const LORE_DYNAMIC_BLOCK_NAME = 'dynamic';

// ═══════════════════════════════════════════════════════════
// 纯函数工具
// ═══════════════════════════════════════════════════════════

/** 纯对象判定（排除 null / 数组 / Date 等宿主对象） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** 自有可枚举键检查（防御原型污染键 `__proto__` 之类，绝不当作路径） */
function hasOwn(obj: object | null | undefined, key: string): boolean {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** 两数组的并集（保序、去重） */
function union<T>(a: readonly T[], b: readonly T[]): T[] {
  return Array.from(new Set([...a, ...b]));
}

/**
 * 规范化内容深比较（设计 §7.3：禁止用对象引用判断变化）。
 *
 * - 原始值 `===`；NaN 视为相等。
 * - 数组：长度 + 逐元素深比较（顺序有语义，**但集合在归一化成 Map 之前不经过这里**）。
 * - 纯对象：键集合相同 + 逐值深比较（键序无关）。
 * - 其余（宿主对象 / 函数等）：按 `===`（投影数据是 JSON-ish，出现即越界）。
 */
function deepEqualValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualValues(a[i], b[i])) return false;
    }
    return true;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!hasOwn(b, key)) return false;
      if (!deepEqualValues(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * 递归把对象键排序，产出字节稳定的 JSON 值（供渲染时保证「相同输入多次渲染字节一致」）。
 * 只做纯数据的键排序，不改数组顺序、不改值本身。
 */
function normalizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForJson(item));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalizeForJson(value[key]);
    }
    return out;
  }
  return value;
}

/** 字符串比较（排序用） */
function cmpString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 取 op 的排序字段：只有 `set` 有 field，其余空串 */
function opSortField(op: PromptDeltaOp): string {
  return op.op === 'set' ? op.field : '';
}

/** op 的 scope / owner / name 取法（rebase 无这些字段，作哨兵值） */
function opScopeOf(op: PromptDeltaOp): string {
  return op.op === 'rebase' ? '~rebase' : op.scope;
}
function opOwnerOf(op: PromptDeltaOp): string {
  return op.op === 'rebase' ? '' : (op.owner ?? '');
}
function opNameOf(op: PromptDeltaOp): string {
  return op.op === 'rebase' ? '' : (op.name ?? '');
}

/**
 * op 固定排序：scope → owner → name → field（设计 §7.2「按固定 scope、owner、name、field
 * 排序后用 JSON 序列化」）。同 key 的相对序无关紧要（不会重复），保持稳定即可。
 */
function compareOps(a: PromptDeltaOp, b: PromptDeltaOp): number {
  return (
    cmpString(opScopeOf(a), opScopeOf(b)) ||
    cmpString(opOwnerOf(a), opOwnerOf(b)) ||
    cmpString(opNameOf(a), opNameOf(b)) ||
    cmpString(opSortField(a), opSortField(b))
  );
}

/**
 * 把带 `name` 键的元素数组按逻辑名字归一化成 Map（重复名字沿用上游「稳定取最早」，
 * 不做恢复系统 —— 设计 §7.3）。无名（空串）元素不投影。
 */
function toNameMap<T extends { name: string }>(
  items: readonly T[],
  project: (item: T) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of items) {
    const key = item.name;
    if (key === '') continue;
    if (!hasOwn(out, key)) out[key] = project(item);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 投影（projectPromptState）
// ═══════════════════════════════════════════════════════════

/** 角色基础字段投影：顶层键 - 排除集（资源/集合/内部 id/自由扩展） */
function projectCharacterBase(character: CharacterState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const source = character as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (CHARACTER_BASE_EXCLUDED.has(key)) continue;
    out[key] = source[key];
  }
  return out;
}

/** 背包物品整元素投影：剥离 deprecated 内部 id，其余整元素保留（T1 不细分内部字段） */
function projectInventoryItem(item: InventoryItem): unknown {
  const { id: _internalId, ...rest } = item;
  return rest;
}

/** 技能整元素投影：同上 */
function projectSkill(skill: Skill): unknown {
  const { id: _internalId, ...rest } = skill;
  return rest;
}

/** 状态效果整元素投影：同上 */
function projectStatusEffect(effect: StatusEffect): unknown {
  const { id: _internalId, ...rest } = effect;
  return rest;
}

/** 记忆整元素投影：剥离 AI 不可见字段（embedding 向量 / 暗线 / 召回索引） */
function projectMemory(memory: MemoryRecord): unknown {
  return {
    id: memory.id,
    timeRange: memory.timeRange,
    importance: memory.importance,
    content: memory.content,
  };
}

/**
 * 叙事变量扁平化：`variables` 是命名空间嵌套（`{ user: {...}, sys: {...} }`），
 * 摊平成 `变量全名（ns.key）→ 值`。键名自身含点号/方括号时仍作为完整名字，不转义。
 */
function flattenVariables(variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ns of Object.keys(variables)) {
    const value = variables[ns];
    if (isPlainObject(value)) {
      for (const key of Object.keys(value)) {
        out[`${ns}.${key}`] = value[key];
      }
    } else {
      out[ns] = value;
    }
  }
  return out;
}

/**
 * 生成读取型投影（设计 §7.1 / 计划 §5）。
 *
 * @param agentId             投影所属 Agent id（T2 传 session 的 agentId，供自校验）
 * @param context             当前 AgentContext（权威状态；读 `history` 需含消息 id）
 * @param renderedDynamicLore 动态世界书本 pass 的 EJS 求值结果（空串 = 无动态区）
 */
export function projectPromptState(
  agentId: string,
  context: AgentContext,
  renderedDynamicLore: string,
): PromptStateProjection {
  const characters: Record<string, Record<string, unknown>> = {};
  const resources: Record<string, Record<string, number>> = {};
  const inventory: Record<string, Record<string, unknown>> = {};
  const skills: Record<string, Record<string, unknown>> = {};
  const statusEffects: Record<string, Record<string, unknown>> = {};

  // characterId → 角色名（affections 的键是 id，AI 只认名字 —— 设计不变量 8）
  const nameById = new Map<string, string>();

  for (const character of context.characters ?? []) {
    if (character.name === '') continue;
    if (!nameById.has(character.id)) nameById.set(character.id, character.name);
    characters[character.name] = projectCharacterBase(character);
    resources[character.name] = {
      hp: character.hp,
      maxHp: character.maxHp,
      mp: character.mp,
      maxMp: character.maxMp,
      sp: character.sp,
      maxSp: character.maxSp,
    };
    inventory[character.name] = toNameMap(character.inventory ?? [], projectInventoryItem);
    skills[character.name] = toNameMap(character.skills ?? [], projectSkill);
    statusEffects[character.name] = toNameMap(character.statusEffects ?? [], projectStatusEffect);
  }

  const quests: Record<string, unknown> = {};
  for (const [name, quest] of Object.entries(context.quests ?? {})) {
    if (name === '') continue;
    quests[name] = quest;
  }

  const affections: Record<string, number> = {};
  for (const [characterId, value] of Object.entries(context.affections ?? {})) {
    const name = nameById.get(characterId);
    if (name !== undefined) affections[name] = value;
  }

  // 剧情进度快照：active/pending 事件按 order 排序的 `{title, status}` 摘要（标量 set 的 value）
  const plotEvents = (context.plotEvents ?? [])
    .filter((e) => e.status === 'active' || e.status === 'pending')
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ title: e.title, status: e.status }));
  const plot: unknown = plotEvents.length > 0 ? { events: plotEvents } : null;

  // 地图上下文：派生态 + 事实态 + 天气（原始数据快照，整块 upsert；渲染归 T2/resolver）
  const hasWeather = typeof context.weather === 'string' && context.weather.trim() !== '';
  const map: unknown =
    context.mapFlags !== undefined || context.mapFacts !== undefined || hasWeather
      ? {
          flags: context.mapFlags ?? null,
          facts: context.mapFacts ?? null,
          weather: context.weather ?? null,
        }
      : null;

  const memories: Record<string, unknown> = {};
  for (const memory of context.memories ?? []) {
    if (memory.id === '') continue;
    if (!hasOwn(memories, memory.id)) memories[memory.id] = projectMemory(memory);
  }

  const narrative = (context.history ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
  }));

  const loreDynamic = renderedDynamicLore.trim() === '' ? null : renderedDynamicLore;

  return {
    agentId,
    characters,
    resources,
    inventory,
    skills,
    statusEffects,
    quests,
    affections,
    variables: flattenVariables(context.variables ?? {}),
    time: context.gameTime
      ? {
          era: context.gameTime.era,
          year: context.gameTime.year,
          month: context.gameTime.month,
          day: context.gameTime.day,
          weekday: context.gameTime.weekday,
          hour: context.gameTime.hour,
          minute: context.gameTime.minute,
        }
      : null,
    plot,
    map,
    loreDynamic,
    memories,
    narrative,
  };
}

// ═══════════════════════════════════════════════════════════
// 纯 diff（diffPromptState）
// ═══════════════════════════════════════════════════════════

/**
 * NARRATIVE append cursor（设计 §7.4）：previous 的历史必须是 current 的**纯前缀**
 * （同 id、同 role、同 content 逐条相等）。是 → 只对新消息产 upsert；否 → 只返回
 * rebase 控制信号，不产伪 delta。
 */
function diffNarrative(
  previous: PromptStateProjection['narrative'],
  current: PromptStateProjection['narrative'],
  out: PromptDeltaOp[],
): boolean {
  const prefixLength = previous.length;
  if (current.length < prefixLength) {
    // 历史变短 = 被删除 / historyLayers 收窄 → 前缀被改，必须重基线
    out.push({ op: 'rebase', reason: 'narrative_truncated' });
    return false;
  }
  for (let i = 0; i < prefixLength; i += 1) {
    const prev = previous[i];
    const cur = current[i];
    if (prev.id !== cur.id || prev.role !== cur.role || prev.content !== cur.content) {
      // 已表示消息被修改或重排（含中间插入）→ 必须重基线
      out.push({ op: 'rebase', reason: 'narrative_changed' });
      return false;
    }
  }
  for (let i = prefixLength; i < current.length; i += 1) {
    const message = current[i];
    out.push({
      op: 'upsert',
      scope: 'narrative',
      name: message.id,
      value: { role: message.role, content: message.content },
    });
  }
  return true;
}

/** 角色基础字段 diff：标量 set（新增角色发全字段；消失/字段消失不产 op —— remove 只按名寻址） */
function diffCharacterFields(
  previous: PromptStateProjection['characters'],
  current: PromptStateProjection['characters'],
  out: PromptDeltaOp[],
): void {
  for (const name of union(Object.keys(previous), Object.keys(current))) {
    const prevFields = previous[name];
    const curFields = current[name];
    if (prevFields === undefined && curFields !== undefined) {
      for (const field of Object.keys(curFields)) {
        out.push({ op: 'set', scope: 'character', owner: name, field, value: curFields[field] });
      }
    } else if (prevFields !== undefined && curFields !== undefined) {
      for (const field of Object.keys(curFields)) {
        if (!hasOwn(prevFields, field) || !deepEqualValues(prevFields[field], curFields[field])) {
          out.push({ op: 'set', scope: 'character', owner: name, field, value: curFields[field] });
        }
      }
    }
  }
}

/** 角色资源 diff：hp/mp/sp 标量 set（与基础字段分开 —— 资源变化不重发整名角色） */
function diffResources(
  previous: PromptStateProjection['resources'],
  current: PromptStateProjection['resources'],
  out: PromptDeltaOp[],
): void {
  for (const name of union(Object.keys(previous), Object.keys(current))) {
    const prevRes = previous[name];
    const curRes = current[name];
    if (prevRes === undefined && curRes !== undefined) {
      for (const field of RESOURCE_FIELDS) {
        out.push({ op: 'set', scope: 'resource', owner: name, field, value: curRes[field] });
      }
    } else if (prevRes !== undefined && curRes !== undefined) {
      for (const field of RESOURCE_FIELDS) {
        const prevValue = prevRes[field];
        const curValue = curRes[field];
        if (curValue !== prevValue) {
          out.push({ op: 'set', scope: 'resource', owner: name, field, value: curValue });
        }
      }
    }
  }
}

/**
 * 按 (owner, name) 寻址的集合元素 diff（技能/物品/状态效果/任务/记忆共用）：
 * 先归一化成 Map，再新增 → upsert、内容变化 → upsert、消失 → remove。顺序无关。
 */
function diffNameKeyedElements(
  scope: PromptScope,
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  owner: string | undefined,
  out: PromptDeltaOp[],
): void {
  for (const name of union(Object.keys(previous), Object.keys(current))) {
    const prevHas = hasOwn(previous, name);
    const curHas = hasOwn(current, name);
    if (prevHas && curHas) {
      if (!deepEqualValues(previous[name], current[name])) {
        out.push({ op: 'upsert', scope, owner, name, value: current[name] });
      }
    } else if (curHas && !prevHas) {
      out.push({ op: 'upsert', scope, owner, name, value: current[name] });
    } else if (prevHas && !curHas) {
      out.push({ op: 'remove', scope, owner, name });
    }
  }
}

/** 好感度 diff：标量 set（owner=角色名） */
function diffAffections(
  previous: PromptStateProjection['affections'],
  current: PromptStateProjection['affections'],
  out: PromptDeltaOp[],
): void {
  for (const name of union(Object.keys(previous), Object.keys(current))) {
    const prevValue = previous[name];
    const curValue = current[name];
    if (curValue !== undefined && curValue !== prevValue) {
      out.push({ op: 'set', scope: 'affection', owner: name, field: 'value', value: curValue });
    }
  }
}

/** 叙事变量 diff：标量 set / 按名 remove（名字含点号/方括号时只是 JSON 值，不拼路径） */
function diffVariables(
  previous: PromptStateProjection['variables'],
  current: PromptStateProjection['variables'],
  out: PromptDeltaOp[],
): void {
  for (const name of union(Object.keys(previous), Object.keys(current))) {
    const prevHas = hasOwn(previous, name);
    const curHas = hasOwn(current, name);
    if (prevHas && curHas) {
      if (!deepEqualValues(previous[name], current[name])) {
        out.push({ op: 'set', scope: 'variable', name, field: 'value', value: current[name] });
      }
    } else if (curHas && !prevHas) {
      out.push({ op: 'set', scope: 'variable', name, field: 'value', value: current[name] });
    } else if (prevHas && !curHas) {
      out.push({ op: 'remove', scope: 'variable', name });
    }
  }
}

/** 游戏时间 diff：逐字段标量 set */
function diffTime(
  previous: PromptStateProjection['time'],
  current: PromptStateProjection['time'],
  out: PromptDeltaOp[],
): void {
  if (previous === null && current === null) return;
  if (previous !== null && current !== null) {
    for (const field of TIME_FIELDS) {
      const prevValue = previous[field];
      const curValue = current[field];
      if (curValue !== prevValue) {
        out.push({ op: 'set', scope: 'time', field, value: curValue });
      }
    }
    return;
  }
  if (current !== null) {
    for (const field of TIME_FIELDS) {
      out.push({ op: 'set', scope: 'time', field, value: current[field] });
    }
  }
  // 有 → 无：时间不会消失，不产 op
}

/**
 * 对两份投影做纯 diff（设计 §7.2 / 计划 §5）。
 *
 * 顺序：
 * 1. `agentId` 自校验（跨 Agent 是调用方 bug → rebase）。
 * 2. NARRATIVE append cursor（异常 → 只返回 rebase 信号）。
 * 3. 角色基础字段 / 资源 → set。
 * 4. 技能/物品/状态效果/任务/记忆 → 按 (owner,name) 整元素 upsert/remove。
 * 5. 好感度 / 变量 / 时间 → set。
 * 6. 剧情进度 → 标量 set；地图 / 动态世界书 → 整块 upsert/remove。
 */
export function diffPromptState(
  previous: PromptStateProjection,
  current: PromptStateProjection,
): PromptDeltaOp[] {
  const out: PromptDeltaOp[] = [];

  if (previous.agentId !== current.agentId) {
    return [{ op: 'rebase', reason: 'agent_changed' }];
  }

  if (!diffNarrative(previous.narrative, current.narrative, out)) {
    return out; // 只含 rebase 信号，不继续产伪 delta
  }

  diffCharacterFields(previous.characters, current.characters, out);
  diffResources(previous.resources, current.resources, out);

  for (const owner of union(Object.keys(previous.inventory), Object.keys(current.inventory))) {
    diffNameKeyedElements(
      'inventory',
      previous.inventory[owner] ?? {},
      current.inventory[owner] ?? {},
      owner,
      out,
    );
  }
  for (const owner of union(Object.keys(previous.skills), Object.keys(current.skills))) {
    diffNameKeyedElements(
      'skill',
      previous.skills[owner] ?? {},
      current.skills[owner] ?? {},
      owner,
      out,
    );
  }
  for (const owner of union(
    Object.keys(previous.statusEffects),
    Object.keys(current.statusEffects),
  )) {
    diffNameKeyedElements(
      'status_effect',
      previous.statusEffects[owner] ?? {},
      current.statusEffects[owner] ?? {},
      owner,
      out,
    );
  }

  diffNameKeyedElements('quest', previous.quests, current.quests, undefined, out);

  // 记忆是一层结构（name=记忆 id，无 owner 维度）—— 与 quest 同形，不做两层遍历
  diffNameKeyedElements('memory', previous.memories, current.memories, undefined, out);

  diffAffections(previous.affections, current.affections, out);
  diffVariables(previous.variables, current.variables, out);
  diffTime(previous.time, current.time, out);

  if (!deepEqualValues(previous.plot, current.plot)) {
    if (current.plot !== null) {
      out.push({ op: 'set', scope: 'plot', field: 'value', value: current.plot });
    }
  }

  if (!deepEqualValues(previous.map, current.map)) {
    if (current.map !== null) {
      out.push({ op: 'upsert', scope: 'map', name: MAP_BLOCK_NAME, value: current.map });
    } else {
      out.push({ op: 'remove', scope: 'map', name: MAP_BLOCK_NAME });
    }
  }

  if (!deepEqualValues(previous.loreDynamic, current.loreDynamic)) {
    if (current.loreDynamic !== null) {
      out.push({
        op: 'upsert',
        scope: 'lore_dynamic',
        name: LORE_DYNAMIC_BLOCK_NAME,
        value: current.loreDynamic,
      });
    } else {
      out.push({ op: 'remove', scope: 'lore_dynamic', name: LORE_DYNAMIC_BLOCK_NAME });
    }
  }

  return out;
}

// ═══════════════════════════════════════════════════════════
// 渲染（renderPromptDelta）
// ═══════════════════════════════════════════════════════════

/**
 * 把 delta 序列化进 `<context_delta>` 外壳（设计 §6.2 / §7.2）。
 *
 * - 固定排序：scope → owner → name → field；value 递归按键排序，保证字节稳定。
 * - 每个 op 一行（`JSON.stringify` 后的完整 JSON 对象），便于 AI 解析与增量语义
 *   （同一 (scope, owner, name, field) 以 revision 最大者为当前值）。
 * - 空 ops → 返回空串（调用方应跳过本轮 delta 区块，不产生空标签）。
 * - 收到 `rebase` 控制信号 → 抛错：重基线信号只给 session assembler，不可渲染。
 */
export function renderPromptDelta(revision: number, ops: PromptDeltaOp[]): string {
  const dataOps = ops.filter((op) => op.op !== 'rebase');
  if (dataOps.length !== ops.length) {
    throw new Error(
      '[prompt-state-projection] renderPromptDelta 收到 rebase 控制信号 —— 调用方应先处理重基线，' +
        '不应把控制信号渲染进 context_delta',
    );
  }
  if (dataOps.length === 0) return '';

  const sorted = [...dataOps].sort(compareOps);
  const lines = sorted.map((op) => JSON.stringify(normalizeForJson(op)));
  return `<context_delta revision="${revision}">\n${lines.join('\n')}\n</context_delta>`;
}
