/**
 * 插件读投影构建器（设计 §4.5 红线 A、§5.2）。
 *
 * 读接口是**白名单投影**，不是「按路径读任意状态」：输入类型只收角色、存档档案、
 * 对话消息、剧情事件四样（外加几个运行态原始值），设置、API 源、调试回合一概进不来 ——
 * 想塞进来就是类型错误（测试用 `@ts-expect-error` 钉住）。
 *
 * 输出是纯 JSON 的深拷贝：与入参零共享引用，Pinia 代理也会被剥成普通对象，
 * 可以直接 postMessage。数据字段规范里的账务字段（id / saveId / 时间戳 / 年龄锚点 /
 * FP 流水等，铁律 3）不出现在任何投影里；剧情事件的 `id` 例外，见 {@link projectPlotEvent}。
 *
 * 纯函数：不碰 Dexie、I/O、Vue。
 */
import { buildStatData } from '../character/stat-projection';
import type { GenerationMode } from '../story/generation-mode';
import type { CharacterState, ChatMessage, PlotEvent, SaveProfile } from '../types/types';
import { redactSecrets } from '../utils/redact-secrets';
import type { PLUGIN_VIEWS } from './plugin-surface';

/** 读投影名（§5.2），取值见 `PLUGIN_VIEWS` */
export type PluginView = (typeof PLUGIN_VIEWS)[number];

/** `run` 投影的运行态（只收原始值） */
interface PluginRunSnapshot {
  generating: boolean;
  inCombat: boolean;
  /** 回合号 */
  turn: number;
  mode: GenerationMode;
}

/**
 * 投影构建的全部输入。🔴 只许加「不可能含凭据」的字段：设置、API 源、图像连接、
 * 调试回合、提示词会话都不许出现在这里（§4.5 机器闸门同时扫标识符）。
 */
export interface PluginProjectionInput {
  /** 全部角色；主角 = 首个 `type === 'player'` */
  characters: readonly CharacterState[];
  profile: SaveProfile;
  /** 当前分支的对话历史（按时间顺序） */
  messages: readonly ChatMessage[];
  plotEvents: readonly PlotEvent[];
  run: PluginRunSnapshot;
  /** 当前天气，只喂 `stats.世界.天气`，与 EJS stats 面同一份推导；缺省则不含该键 */
  weather?: string;
}

/** `messages` 投影最多给的条数（取最近的） */
export const PLUGIN_MESSAGES_VIEW_LIMIT = 50;

/** 角色身上的账务字段（铁律 3：由 Code 补、不交给 AI，也不交给插件） */
const CHARACTER_LEDGER_FIELDS = ['id', 'saveId', 'ageAnchor', 'introducedBy'] as const;

/** 剧情事件的账务字段；`id` 保留，因为 `childrenIds` / `parentId` 与 `plot.updateEvent` 都按它寻址 */
const PLOT_LEDGER_FIELDS = ['saveId', 'createdAt', 'updatedAt'] as const;

type JsonObject = Record<string, unknown>;

/**
 * 深拷贝成纯 JSON。走一次 JSON 往返：代理会被剥掉，函数 / `undefined` 丢弃，
 * 非有限数变 `null` —— 结果保证能过结构化克隆，也不和入参共享任何引用。
 */
function toJson<T>(value: T): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function omit(obj: JsonObject, keys: readonly string[]): JsonObject {
  for (const key of keys) delete obj[key];
  return obj;
}

/** 背包 / 技能 / 状态的旧版 `id` 已废弃（逻辑键 = 名字），一并剥掉 */
function stripEntryIds(list: unknown): unknown[] {
  if (!Array.isArray(list)) return [];
  return list.map((entry) =>
    entry && typeof entry === 'object' ? omit(entry as JsonObject, ['id']) : entry,
  );
}

function projectCharacter(character: CharacterState): JsonObject {
  const out = omit(toJson(character) as JsonObject, CHARACTER_LEDGER_FIELDS);
  out.inventory = stripEntryIds(out.inventory);
  out.skills = stripEntryIds(out.skills);
  out.statusEffects = stripEntryIds(out.statusEffects);
  return out;
}

function findPlayer(input: PluginProjectionInput): CharacterState | undefined {
  return input.characters.find((c) => c.type === 'player');
}

/** 主角的某个条目数组；没有主角时给空数组 */
function playerList(input: PluginProjectionInput, key: 'inventory' | 'skills' | 'statusEffects') {
  const player = findPlayer(input);
  return player ? stripEntryIds(toJson(player[key])) : [];
}

function projectPlotEvent(event: PlotEvent): JsonObject {
  return omit(toJson(event) as JsonObject, PLOT_LEDGER_FIELDS);
}

/**
 * 已接纳的对话（照 `memory-context.ts` 的口径）：只要 user / assistant，排除系统事件卡片、
 * 诊断文本、未接纳的回合尝试。
 */
function isVisibleMessage(message: ChatMessage): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') return false;
  if (message.systemEvent || message.diagnostic) return false;
  return message.storyTurnStatus === undefined || message.storyTurnStatus === 'accepted';
}

function projectMessages(messages: readonly ChatMessage[]): JsonObject[] {
  return messages
    .filter(isVisibleMessage)
    .slice(-PLUGIN_MESSAGES_VIEW_LIMIT)
    .map((m) => {
      const out: JsonObject = {
        id: m.id,
        role: m.role,
        content: redactSecrets(String(m.content ?? '')),
        timestamp: m.timestamp,
      };
      if (typeof m.turn === 'number') out.turn = m.turn;
      return toJson(out) as JsonObject;
    });
}

/**
 * 构建一个读投影。返回值是纯 JSON 深拷贝，调用方可直接发给插件。
 * 没有主角时 `player` 为 `null`，三个主角数组为空数组。
 */
export function buildPluginView(view: PluginView, input: PluginProjectionInput): unknown {
  const { profile } = input;
  switch (view) {
    case 'player': {
      const player = findPlayer(input);
      return player ? projectCharacter(player) : null;
    }
    case 'player.inventory':
      return playerList(input, 'inventory');
    case 'player.skills':
      return playerList(input, 'skills');
    case 'player.statusEffects':
      return playerList(input, 'statusEffects');
    case 'characters':
      return input.characters.map(projectCharacter);
    case 'stats':
      return toJson(
        buildStatData({
          characters: [...input.characters],
          gameTime: profile.gameTime,
          fp: profile.fp,
          turn: input.run.turn,
          ...(input.weather !== undefined ? { weather: input.weather } : {}),
        }),
      );
    case 'vars':
      return toJson(profile.variables ?? {});
    case 'quests':
      return toJson(profile.quests ?? {});
    case 'affections':
      return toJson(profile.affections ?? {});
    case 'news':
      // 新闻的 id / publishedAt / read 都是 Code 补的账务字段
      return (profile.news ?? []).map((n) =>
        toJson({ title: n.title, content: n.content, category: n.category }),
      );
    case 'fp':
      // 只给余额，FP 流水（fpHistory）是账本
      return toJson(profile.fp);
    case 'time':
      return toJson(profile.gameTime);
    case 'plot':
      return input.plotEvents.map(projectPlotEvent);
    case 'map': {
      const flags = (profile.worldFlags ?? {}) as JsonObject;
      return { map: toJson(flags.map ?? null), mapFacts: toJson(flags.mapFacts ?? null) };
    }
    case 'messages':
      return projectMessages(input.messages);
    case 'run': {
      const { generating, inCombat, turn, mode } = input.run;
      return toJson({ generating, inCombat, turn, mode });
    }
  }
}
