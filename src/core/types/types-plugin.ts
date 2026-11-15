/**
 * 插件系统的类型分册（ADR-36 暂定）。
 * 设计契约见 docs/planning/2026-11-15-plugin-system-design.md（§3.2 包格式、§3.5 存储、§5 插件 API）。
 *
 * 名称表与上限（命令、投影、事件、贡献点、文件类型）不在这里，单一来源是
 * `src/core/plugins/plugin-surface.ts`。
 */
import type { CharacterState, SaveProfile } from './types';

/** UI 贡献点（§5.7）；P1b 只开 `game.toolbar`，其余随 P2 */
export type PluginSlot = 'game.toolbar' | 'game.menu' | 'game.overlay' | 'panel.items.footer';

/** 贡献的界面形态：应用内浮动窗 / 游戏页上方的层 / 面板内插槽 */
export type PluginSurfaceKind = 'window' | 'overlay' | 'panel';

/** manifest 里的一条 UI 贡献 */
export interface PluginContribution {
  slot: PluginSlot;
  /** 插件内唯一 */
  id: string;
  /** 只做文本插值，不当 HTML */
  label: string;
  /** 包内相对路径；按 §4.4 规则二处理 */
  icon?: string;
  surface: PluginSurfaceKind;
  /** 包内的 HTML 入口文件 */
  entry: string;
  width?: number;
  height?: number;
}

/** 声明即契约（§3.6）：未声明的命令、投影、事件一律 `DENIED` */
export interface PluginCapabilities {
  read: string[];
  commands: string[];
  events: string[];
  ai: string[];
  storage: string[];
}

/** 规整后的 manifest（`coercePluginManifest` 的产物，认不出的字段已丢弃） */
export interface PluginManifest {
  manifestVersion: 1;
  /** ^[a-z0-9][a-z0-9._-]{2,63}$，全局唯一键 */
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  /** 需要的宿主 API 版本范围，如 "^1.0" */
  pluginApi: string;
  contributions: PluginContribution[];
  /** 可选的常驻后台页面入口（不可见） */
  background?: string;
  /** 已校验的联网域名；缺省规整为空数组 = 未声明联网域名（不等于离线） */
  network: string[];
  capabilities: PluginCapabilities;
}

/** 一次风险确认的记录（安装时、按存档启用时） */
export interface PluginConsent {
  version: string;
  contentHash: string;
  /** `network` 的规范哈希；变了必须重新确认 */
  networkHash: string;
  at: number;
}

/**
 * `plugins` 表的行（Dexie v34，主键 `id`）。设备本地，不进 FullBackup。
 * 按存档的确认只存在这里（`saveConsents[saveId]`），所以导入的存档一律要在本机重新确认。
 */
export interface PluginRecord {
  id: string;
  manifest: PluginManifest;
  source: 'local' | 'workshop';
  contentHash: string;
  networkHash: string;
  fileCount: number;
  totalBytes: number;
  installedAt: number;
  updatedAt: number;
  installConsent: PluginConsent;
  saveConsents: Record<string, PluginConsent>;
}

/** `pluginFiles` 表的行（主键 `[pluginId+path]`）。字节不进任何备份 */
export interface PluginFileRecord {
  pluginId: string;
  /** 包内相对路径，`/` 分段，已过 `isSafePluginRelPath` */
  path: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
}

/** `pluginKv` 表的行（主键 `[pluginId+key]`）：插件的全局数据，跨存档、进 FullBackup */
export interface PluginKvRecord {
  pluginId: string;
  key: string;
  /** JSON 值（写入时已经过一次 JSON 往返规整） */
  value: unknown;
  /** 计入配额的字节数（键 + 值的 UTF-8 JSON） */
  bytes: number;
}

/** 桥协议错误码（§5.1） */
export type PluginErrorCode =
  | 'BUSY'
  | 'IN_COMBAT'
  | 'DENIED'
  | 'INVALID'
  | 'PRECONDITION_FAILED'
  | 'NOT_FOUND'
  | 'QUOTA'
  | 'NO_SAVE';

/** 宿主对插件调用的统一结果；`index` 指向出错的命令或断言下标 */
export type PluginResult<T = undefined> =
  { ok: true; value?: T } | { ok: false; code: PluginErrorCode; message: string; index?: number };

/** `commit` 的前置条件（§5.4），在写锁和事务内求值 */
export type PluginExpect =
  | { view: 'player.money'; gte: number }
  | { item: string; owner?: string; gte: number }
  | { var: string; gte: number }
  | { var: string; eq: unknown }
  | { var: string; exists: boolean };

/** 锁内复检运行态：生成中返回 `BUSY`，战斗中返回 `IN_COMBAT` */
export type PluginRunGuard = () => 'ok' | 'BUSY' | 'IN_COMBAT';

/** 求值 `PluginExpect` 所需的状态切面 */
export interface PluginExpectState {
  characters: CharacterState[];
  profile: SaveProfile;
}

/** 本回合装配提示词时注入的插件文本（只含本机已启用插件的） */
export interface PluginPromptInputs {
  notes: { pluginName: string; text: string }[];
  contexts: { pluginName: string; text: string }[];
}
