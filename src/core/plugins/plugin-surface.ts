/**
 * 插件 API 面的单一来源（设计 §8，照 `EJS_SURFACE` 的口径）：命令、投影、事件、
 * AI 手段、存储、贡献点、包内文件类型与各项上限都只在这里定义，文档与校验都从这里推导。
 *
 * 纯数据 + 纯函数：不碰 Dexie、I/O、Vue。
 */
import type { StatePatchOp } from '../types/types';
import type { PluginSlot } from '../types/types-plugin';

/** 宿主 API 版本（语义化）。只增不改算小版本，删改命令或投影字段算大版本 */
export const PLUGIN_API_VERSION = '1.0.0';

/**
 * 命令名 → 它翻译成的 StatePatchOp（§5.3）。一条命令可能对应多个 op（如 `resource.set`
 * 按资源种类落到 `set_hp` / `set_mp` / `set_sp`）。
 *
 * 🔴 引擎增删 `StatePatchOp` 时这里必须同步：每个 op 要么在这张表里，要么在
 *    `PLUGIN_DEFERRED_OPS` 或 `PLUGIN_CLOSED_OPS` 里，`plugin-surface.test.ts` 钉着这条。
 */
export const PLUGIN_COMMANDS = {
  'vars.set': ['set_variable'],
  'vars.delta': ['delta_variable'],
  'vars.remove': ['remove_variable'],
  'vars.move': ['move_variable'],
  'vars.insert': ['insert_variable'],
  // FP 走 `delta_variable` + `target='profile.fp'` 的账务分支
  'fp.add': ['delta_variable'],
  'fp.spend': ['delta_variable'],
  'character.update': ['update_character'],
  'money.add': ['update_character'],
  'money.spend': ['update_character'],
  'resource.set': ['set_hp', 'set_mp', 'set_sp'],
  'resource.delta': ['delta_hp', 'delta_mp', 'delta_sp'],
  'character.add': ['add_character'],
  'character.remove': ['remove_character'],
  'character.rename': ['rename_character'],
  'status.add': ['add_status_effect'],
  'status.update': ['update_status_effect'],
  'status.remove': ['remove_status_effect'],
  'item.grant': ['add_item'],
  'item.remove': ['remove_item'],
  'item.update': ['update_item'],
  'item.transfer': ['transfer_item'],
  'item.equip': ['equip_item'],
  'item.unequip': ['unequip_item'],
  'skill.add': ['add_skill'],
  'skill.update': ['update_skill'],
  'skill.remove': ['remove_skill'],
  'location.set': ['set_location'],
  'quest.upsert': ['update_quest'],
  'quest.remove': ['remove_quest'],
  'affection.set': ['set_affection'],
  'affection.delta': ['delta_affection'],
  'news.add': ['add_news'],
  'plot.updateEvent': ['update_plot_event'],
  'map.tile.statusAdd': ['tile_status_add'],
  'map.tile.statusRemove': ['tile_status_remove'],
  'map.tile.buildingAdd': ['tile_building_add'],
  'map.tile.buildingUpdate': ['tile_building_update'],
  'map.tile.devProgressAdd': ['tile_dev_progress_add'],
  'map.tile.historyNote': ['tile_history_note'],
  // 插件只给正文 / 关键词 / 重要度；记忆 id 由引擎在全局写锁内、提交事务里分配
  'memory.add': ['add_memory'],
} as const satisfies Record<string, readonly StatePatchOp[]>;

/**
 * 推迟开放的 op。当前为空：`add_memory` 已在 P2 经 `memory.add` 接入（全局写锁在外、
 * 存档写锁在内，id 在事务里分配）。以后有需要先占位、再单独设计接入方式的 op，加在这里。
 */
export const PLUGIN_DEFERRED_OPS: readonly StatePatchOp[] = [];

/**
 * 明确不开放给插件的 op。当前为空：§5.3 的「不开放」项（快照、时间推进、回合提交、
 * 消息直写等）都不是 `StatePatchOp`。引擎新增 op 而又不想开放时，加在这里。
 */
export const PLUGIN_CLOSED_OPS: readonly StatePatchOp[] = [];

/** 读投影（§5.2） */
export const PLUGIN_VIEWS = [
  'player',
  'player.inventory',
  'player.skills',
  'player.statusEffects',
  'characters',
  'stats',
  'vars',
  'quests',
  'affections',
  'news',
  'fp',
  'time',
  'plot',
  'map',
  'messages',
  'run',
] as const;

/** 生命周期与订阅事件（§5.5），全部是通知、不能否决 */
export const PLUGIN_EVENTS = [
  'save.enter',
  'save.leave',
  'turn.start',
  'turn.end',
  'turn.failed',
  'combat.start',
  'combat.end',
  'timeline.restored',
  'state.changed',
] as const;

/** AI 交互手段（§5.8）：一次性告知 / 常驻提示块 */
export const PLUGIN_AI = ['note', 'context'] as const;

/** 存储（§5.6）：随存档的 `worldFlags.plugins[id]` / 跨存档的 `pluginKv` */
export const PLUGIN_STORAGE = ['save', 'global'] as const;

/** UI 贡献点（§5.7） */
export const PLUGIN_SLOTS = [
  'game.toolbar',
  'game.menu',
  'game.overlay',
  'panel.items.footer',
] as const satisfies readonly PluginSlot[];

/**
 * 包内允许的文件扩展名（小写、不带点）→ 帧内建 `blob:` URL 时用的 MIME。
 * 不在表里的扩展名不安装。🔴 服务端 `server/plugin-dir.ts` 另有一份，两边必须逐项一致（一致性测试钉住）。
 */
export const PLUGIN_FILE_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

const KB = 1024;
const MB = 1024 * KB;

/** 各项上限（§3.5、§5.1、§5.5、§5.8、§4.2、§4.6） */
export const PLUGIN_LIMITS = {
  /** 单条桥消息序列化后的上限 */
  messageBytes: 256 * KB,
  /** 一次 commit 序列化后的上限 */
  commitBytes: 256 * KB,
  /** 每插件每秒消息数 */
  messagesPerSecond: 60,
  /** 包内单文件（同 `PLUGIN_DIR_LIMITS.maxFileBytes`） */
  fileBytes: 5 * MB,
  /** 单插件总体积（同 `PLUGIN_DIR_LIMITS.maxPluginBytes`） */
  pluginBytes: 20 * MB,
  /** manifest.json（同 `PLUGIN_DIR_LIMITS.maxManifestBytes`） */
  manifestBytes: 64 * KB,
  /** 单个路径段长度（UTF-16 码元） */
  pathSegmentChars: 128,
  /** 相对路径整体长度 */
  pathChars: 512,
  /** 相对路径段数（含文件名） */
  pathDepth: 16,
  /** 单插件文件数 */
  files: 1000,
  /** `worldFlags.plugins[id]` 每插件 */
  saveBagBytes: 256 * KB,
  /** `pluginKv` 每插件 */
  globalBytes: 1 * MB,
  /** `network` 声明的域名数 */
  networkHosts: 16,
  /** 同时启用的带后台页面的插件数 */
  backgroundPlugins: 8,
  /** `host.ai.note` 单条字数 */
  noteChars: 2000,
  /** 待告知队列长度 */
  noteQueue: 16,
  /** `host.ai.context.set` 字数 */
  contextChars: 4000,
} as const;

/** 保留设备名按「第一个点之前、去掉尾随空格」的主干判定：`NUL.txt`、`con .js` 都算 */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i;
const WINDOWS_INVALID_CHARS = /[<>"|?*]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * 包内相对路径的逐段校验（§4.6）：`/` 分段；拒绝空路径、过长或过深的路径，以及每段的
 * `..`、`.`、空段（含绝对路径）、过长段、反斜杠、`:`、控制字符、Windows 非法字符、
 * 尾随点或空格、Windows 保留设备名（带不带扩展名都算）。
 * 🔴 与 `server/plugin-dir.ts` 的 `checkPluginRelPath` 同规则，由一致性测试钉住；改一边必须改另一边。
 */
export function isSafePluginRelPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.length > PLUGIN_LIMITS.pathChars) return false;
  const segments = path.split('/');
  if (segments.length > PLUGIN_LIMITS.pathDepth) return false;
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
    if (seg.length > PLUGIN_LIMITS.pathSegmentChars) return false;
    if (seg.includes('\\') || seg.includes(':')) return false;
    if (CONTROL_CHARS.test(seg) || WINDOWS_INVALID_CHARS.test(seg)) return false;
    if (/[. ]$/.test(seg)) return false;
    if (RESERVED_DEVICE_NAME.test(seg.split('.')[0].replace(/ +$/, ''))) return false;
  }
  return true;
}
