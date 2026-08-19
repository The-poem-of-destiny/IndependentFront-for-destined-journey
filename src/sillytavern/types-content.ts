/**
 * types-content.ts — 内容-引擎分离（波 1）的纯类型集中定义。
 *
 * 设计全文: `docs/planning/2026-08-05-content-engine-separation-design.md`（本文件
 * 是该设计 §4 的内容包格式 + §5.1 的 planner 产出类型）。
 *
 * 为什么与 types.ts 分开:
 * `types.ts` 是唯一类型来源，但 CLAUDE.md「设计约定」明确允许**大型联合类型拆分为
 * `types-*.ts`**。先例是 `types-audio.ts` / `types-image.ts`。本分册**只**承载内容包
 * 子系统的过程类型（pack 载荷 / 安装计划 / 校验记录 / 基线），落库实体（`WorldBook` /
 * `ChatPreset` / `BeautifierRule` / `LocationNode` / `MapMarker` / `Bloodline` /
 * `AgentSettingsEntry`）继续住在 types.ts，本文件只 import 它们。
 *
 * 🔴 本文件**只 import types.ts 做 type-only 引用**，不引入运行时（与 types-image.ts
 * 同一规矩），边不成环。
 *
 * 设计: docs/planning/2026-08-05-content-engine-separation-design.md §4 / §5.1 / D8 / D17 / D19 / D20
 */

import type {
  AssetType,
  BeautifierRule,
  ChatPreset,
  LocationNode,
  MapMarker,
  WorkshopNote,
  WorldBook,
  WorldBookPartition,
} from './types';
// 第 13 分节 `randomEvents` 的形状真源在随机事件分册（type-only，边不成环）
import type { PackRandomEventsSection } from './types-random-events';

// ═══════════════════════════════════════════════════════════
// agent 默认值（pack 承载的 per-Agent 配置）
// ═══════════════════════════════════════════════════════════

/**
 * pack 承载的单个 Agent 的默认配置（§4：`agentDefaults.agents[agentId]`）。
 *
 * 🔴 **与 UI 层 `AgentSettingsEntry`（`src/ui/stores/agent-settings.ts`）刻意同形**——
 * 后者既是磁盘上的 `data/defaults/agent-config.json` 的形状，也是活状态 `settings.agents`
 * 袋子里每个 agent 的形状。三者（pack / 磁盘默认 / 活状态覆写）刻意同形，是为了让
 * provider 的 `resolve(agentId, key) = 覆写层 ?? 默认层` 能直接整行比对而不做字段映射。
 *
 * 为什么不直接 import UI 层那份:
 * 本文件是**引擎层**类型（`src/sillytavern/`），UI 层（`src/ui/stores/`）依赖引擎层，
 * 而不是反过来。引擎层 import UI 层会把依赖边翻转。等 D44 的 agents 分层改造落地时，
 * 这份类型应当被**提升**进引擎层做权威，UI 层改成从引擎 import；本波（T1）先本地声明
 * 保持同形，T8 接手 agents 分层时统一收口。
 *
 * `historyLayers` / `historySlice` 刻意**可缺省**: 缺省 = 按 agent 类别走引擎默认，
 * 合并默认值会把那条语义静默覆盖掉（见 agent-settings.ts 同名字段注释）。
 */
export interface AgentProjectDefaults {
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
  /** 历史对话注入层数（缺省 = 按 agent 类别引擎默认） */
  historyLayers?: number;
  /** 每条历史正文截断字数（缺省 = 按 agent 类别引擎默认） */
  historySlice?: number;
}

// ═══════════════════════════════════════════════════════════
// 内容包格式 v1（§4 / D17）
// ═══════════════════════════════════════════════════════════

/**
 * 内容包顶层格式版本。
 *
 * 🔴 唯一合法值当前是 `1`（§4：formatVersion 必读必校验，不满足 → 拒绝 + 报消息）。
 * 校验器对未知值一律记成 `PackValidationNote` 而不是直接 throw（设计 §4 规则：
 * malformed 不 throw、validate 先于任何写入）。
 */
export type PackFormatVersion = 1;

/** `minEngineVersion` 的 semver 比对结果（D40） */
export interface EngineVersionGate {
  /** pack 要求的最低引擎版本（semver 串）；undefined = pack 没声明，放行 */
  packMin: string | undefined;
  /**
   * 当前引擎版本（`__ENGINE_VERSION__`）。
   *
   * 🔴 **本波先接受缺省=跳过 version 门**：`__ENGINE_VERSION__` 的 vite define 注入
   * 是 D26 的活，落在 T13。`typeof __ENGINE_VERSION__ === 'undefined'` 时校验器
   * 把 `engineVersion` 填成 `undefined`，gate 返回 `'skipped'`，记一条 TODO 注释
   * 指明 T13 补注入后这条分支会自然退路到 `'ok'` / `'too-new'`，并补「过新包被拒绝」
   * 的测试。设计文档 §5.2 的「不满足 → 拒绝 + 报消息」在缺省时**不触发**。
   */
  engineVersion: string | undefined;
  /** `'ok'` 放行 / `'too-new'` 引擎过旧拒绝 / `'skipped'` 引擎版本未注入跳过 */
  result: 'ok' | 'too-new' | 'skipped';
}

// ── 各分节：absent = 本包对该域无话可说（别动）；[] = 刻意清空；rows = 替换 ──

/** 世界书分节（§4：WorldBook[]，15 本，builtIn:true，真实分区名，真实 uid 空间） */
export type PackWorldBooksSection = readonly WorldBook[];

/**
 * agent 默认配置分节（§4）。
 *
 * `agents` 袋子里每个 agentId 一份 {@link AgentProjectDefaults}（与 settings-store 的
 * 活状态、磁盘上的 `data/defaults/agent-config.json` 三者刻意同形——见
 * `AgentProjectDefaults` 注释与 agent-settings.ts 头注释）。
 *
 * `version` 字段对齐 `data/defaults/agent-config.json` 的顶层 `version: 1`，留作
 * 将来 agent 默认值结构变更的迁移闸门。
 */
export interface PackAgentDefaultsSection {
  version: number;
  agents: Readonly<Record<string, AgentProjectDefaults>>;
}

/**
 * story 预设分节（§4：ChatPreset[]，若在 agentDefaults 之外单发）。
 *
 * 占位预设与 pack 预设**用不同的固定 id**（D20），pack 安装 = 按 pack `presetId`
 * 整行 upsert（不 mint 新 UUID）。
 */
export type PackPresetsSection = readonly ChatPreset[];

/**
 * 美化规则分节（§4）。
 *
 * 🔴 pack 规则走 provider 内存层（`presetRules` 语义，`isBuiltin: true`，
 * 参与 `builtinDisabled` 门控），**不写用户表**——卸载天然免费（D20）。
 * 🔴 无 `builtinDisabled` 字段（v1.2 删）：那是用户设置不是默认值文件的一部分。
 */
export interface PackBeautifierRulesSection {
  version: number;
  rules: readonly BeautifierRule[];
}

/** 地图标记分节（§4：MapMarker[]） */
export type PackMapMarkersSection = readonly MapMarker[];

/**
 * 捏人目录分节（§4：七池——装备/物品/技能、背景、命定核心、种族/身份点数、起始地树）。
 *
 * 🔴 机制件（`DIFFICULTY_PRESETS` / `GENDER_OPTIONS` / `BACKGROUND_RESTRICTIONS`）
 * **不进 pack**（D24），随 `start-catalog-mechanics.ts` 留引擎。这里只收纯数据池/表数组。
 * 因为目录池的真实形状由 T2/T3 定义（目录数据驱动化改造），本波先用 `unknown` 占位，
 * planner 透传、不解释其结构；T2 会把它收窄成具体类型。
 */
export interface PackCatalogSection {
  /** 自由结构数据池（T2 接手后改具体类型） */
  data: unknown;
}

/** 地点节点分节（§4：LocationNode[]，34 节点） */
export type PackLocationsSection = readonly LocationNode[];

/**
 * 血脉分节（§4：KNOWN_BLOODLINES 形状）。
 *
 * 🔴 真实形状是 `Record<raceKey, BloodlineInfo>`（`data/content/bloodlines.json` 同形，
 * 运行态 `getBloodlineSet()` 直接消费整块；pack 整块替换，无逐项冲突语义——planner
 * 走 planOpaqueSection）。曾写 `{bloodlines: readonly Bloodline[]}` 是数组假设，
 * 已随 planner 修正作废。
 */
export interface PackBloodlinesSection {
  /** raceKey → 血脉信息（含 description 等叙事字段） */
  bloodlines: Record<string, unknown>;
}

/**
 * 名字池分节（§4：NAME_POOLS / HAIR_COLORS / EYE_COLORS / PERSONALITY_POOL）。
 *
 * 与 `PackCatalogSection` 同理，真实形状由 T3 定义；本波先透传。
 */
export interface PackNamePoolsSection {
  data: unknown;
}

/**
 * 品牌面分节（§4 / D26）。
 *
 * `era` 在 save 创建时盖章进 SaveProfile，此后只读存档、永不活读 pack（D9）。
 * `workshopApiBase` 未设置时工坊入口渲染「未配置社区源」空态（D41）。
 */
export interface PackBrandingSection {
  appTitle?: string;
  /** 产品短名 → 设置页「关于 X」 */
  shortName?: string;
  /** 首页大标题分行 */
  titleLines?: string[];
  /** 首页标题下那行小字 */
  tagline?: string;
  subtitles?: string[];
  credits?: string;
  /** “关于”分区的世界速览块 */
  worldSummary?: { title?: string; lines?: string[] };
  about?: string;
  /** 关于分区页脚的版权行 */
  copyright?: string;
  /** save 创建时盖章用；无 epochYear（D9） */
  era?: string;
  /** 设置页剧情分区的大纲示例（防剧透预览）；空数组 = 不渲染预览卡 */
  plotTemplate?: Array<{ title?: string; body?: string }>;
  /** 地图图源（D23）。🔴 是 `{key,name,url}` 对象数组，不是裸 URL 串数组 */
  mapSources?: Array<{ key?: string; name?: string; url?: string }>;
  /** 工坊 API 基址（D41） */
  workshopApiBase?: string;
  workshopLoginHint?: string;
}

/**
 * 提示词方言分节（图像 v2 / C4）—— 内容注册表第 7 面。
 *
 * 🔴 **整节替换，走 `locations`/`bloodlines` 那一档而不是 `catalog` 的 `.data` 档**：
 * 落盘形状本来就是 `{ dialects: [...] }`，再包一层 `data` 只是多一层没人需要的壳。
 *
 * 形状与 `ImageDialect[]` 同构，但这里保持 `unknown[]` 透传（与 catalog/namePools 同口径）:
 * 方言来自第三方内容包，收窄留给引擎侧的容错解析器 `parseImageDialects`——
 * 那里认不出的旋钮回落默认值、认不出的条目跳过，**planner 不解释结构**。
 */
export interface PackImageDialectsSection {
  dialects: readonly unknown[];
}

/**
 * 地图内容包分节（地图系统 v1 / 设计 §3.3）—— 内容注册表**第 8 面**。
 *
 * 🔴 **整节替换，走 `branding`/`imageDialects` 那一档而不是 `catalog` 的 `.data` 档**：
 * 落盘形状（`data/content/map-pack.json`）就是 `MapPack` 本身，再包一层 `data` 只是多一层壳。
 *
 * 🔴 **刻意不写成 `MapPack`**（尽管那才是它的真实形状）：这一节来自第三方内容包，
 * 校验器只判「是不是 JSON 对象」，收窄留给引擎侧的容错解析器 `coerceMapPack`
 * —— 那里认不出的条目跳过、认不出的旋钮回落，**planner 不解释结构**（口径同
 * `PackImageDialectsSection`）。声明成 `MapPack` 会让读代码的人以为 pack 里的东西
 * 已经被谁校验过了，而事实是**没有**。
 */
type PackMapPackSection = Readonly<Record<string, unknown>>;

/**
 * 远程素材分节的一行（远程素材 v1）—— 第 14 分节 `remoteAssets`。
 *
 * 🔴 与 `imageDialects` / `mapPack` 那一档**不同**: 这一节就是一个**裸数组**，
 * 没有 `{ data }` 或 `{ dialects }` 那层壳 —— 每一行都是独立的一条声明，没有任何
 * 需要挂在整节上的配置。
 *
 * `type` 缺省 = `头像`（同文件名约定的缺省类型）；`variant` 缺省 = 基图位。
 * 逐行的容错收窄归引擎侧的 `normalizePackRemoteAssets`（`remote-asset-catalogue.ts`）——
 * **校验器只判形状、不解释内容**，口径同 `PackImageDialectsSection`。
 */
interface RemoteAssetPackEntry {
  /** 角色名，`===` 匹配素材行的 name（D2 不归一化） */
  name: string;
  /** http/https 绝对地址 */
  url: string;
  /** 缺省 `头像` */
  type?: AssetType;
  /** 缺省 = 基图位 */
  variant?: string;
}

/**
 * 远程素材分节（第 14 面）—— 裸数组，三态语义同其它分节。
 *
 * 🔴 与 `PackMapPackSection` 同款**不导出**: 消费方（`normalizePackRemoteAssets`）
 * 收的是 `unknown` —— 这一节来自第三方内容包，拿一个「已经是对的」的类型去接它，
 * 只会让读代码的人以为有谁校验过。要导出等到真有跨模块引用时再说（死代码棘轮盯着）。
 */
type PackRemoteAssetsSection = readonly RemoteAssetPackEntry[];

/**
 * 内容包顶层结构（§4）。
 *
 * 分节**全部可选**，三态语义：
 * - `undefined`（absent）= 本包对该域无话可说（**别动**当前状态）
 * - `[]`（空数组）= 刻意清空该域
 * - `rows`（非空数组/对象）= 替换该域
 *
 * 🔴 `formatVersion` 是必读必校验的字段，校验器对它单独立门（不在三态语义里）。
 * 🔴 `sectionHashes` 用途仅限 D40 升级 diff 展示与快速比对；冲突判定/对账用的
 *    逐书基线一律从 `payload` 现算（per-item），两者不许混用（D18 hash 分工）。
 */
export interface ContentPack {
  /** 🔴 必读必校验（§4）。不满足 → 拒绝 + 报消息 */
  formatVersion: PackFormatVersion;
  /** 包身份（如 `fated-poem-official`），跨版本稳定 */
  packId: string;
  /** semver，驱动升级判定（D40） */
  packVersion: string;
  /** 与 `__ENGINE_VERSION__` 比对；不满足 → 拒绝（D26/D40） */
  minEngineVersion?: string;
  /** 人类可读名 */
  name?: string;
  description?: string;
  /** 导出时间戳（epoch ms）；缺失时校验器不报，仅记 note */
  exportedAt?: number;

  // ── 分节（全部可选，三态语义）──
  worldBooks?: PackWorldBooksSection;
  agentDefaults?: PackAgentDefaultsSection;
  presets?: PackPresetsSection;
  beautifierRules?: PackBeautifierRulesSection;
  mapMarkers?: PackMapMarkersSection;
  catalog?: PackCatalogSection;
  locations?: PackLocationsSection;
  bloodlines?: PackBloodlinesSection;
  namePools?: PackNamePoolsSection;
  branding?: PackBrandingSection;
  imageDialects?: PackImageDialectsSection;
  /** 地图内容包（地图系统 v1 / §3.3）—— 注册表第 8 面，整节替换 */
  mapPack?: PackMapPackSection;
  /**
   * 随机事件（随机事件系统 v1 / §3.3）—— 注册表**第 13 面**。
   *
   * 形状 `{ config?, defs }` 的真源在 `types-random-events.ts`（随机事件全部类型的分册）。
   *
   * 🔴 与 `mapPack` / `imageDialects` **同一档：整节替换，无 `.data` 壳**（落盘形状
   * `data/content/random-events.json` 就是这个对象本身）。
   *
   * 🔴 **声明的形状比事实强**（与 `PackMapPackSection` 刻意写成 `Record<string, unknown>`
   * 的理由相反，这里迁就的是「形状真源只有一份」）：这一节来自第三方内容包，校验器只判
   * 「是不是 JSON 对象」，`defs` 里每一条到底能不能用由引擎侧的容错解析器
   * `coerceRandomEventPack` 说了算（坏定义整条跳过、坏子项逐条丢）。**planner 不解释结构**。
   */
  randomEvents?: PackRandomEventsSection;
  /**
   * 远程素材声明（远程素材 v1）—— 注册表**第 14 面**。
   *
   * 三态语义照旧（absent = 别动 / `[]` = 刻意清空 / rows = 替换）。
   * 🔴 这一节只声明「从哪下」，**下载与落库全在 UI 侧**：pack 装上并不等于图已经到本地，
   * 引擎层对它做的唯一一件事是把行收窄成 `RemoteAssetDecl`。
   */
  remoteAssets?: PackRemoteAssetsSection;

  /**
   * 构建器逐节盖章的 hash 清单。
   *
   * 🔴 用途仅限 D40 升级 diff 展示与快速比对；冲突判定/对账的逐书基线从 payload 现算。
   * 校验器**不**用 `sectionHashes` 判冲突（D18）。
   */
  sectionHashes?: Readonly<Record<string, string>>;
}

// ═══════════════════════════════════════════════════════════
// 校验产出（§5.2：validate 先于任何写入）
// ═══════════════════════════════════════════════════════════

/** 校验产出的问题级别（参考 WorkshopNote 的三分类语气，但语义独立） */
export type PackValidationLevel = 'error' | 'warning';

/**
 * 一条校验问题记录。
 *
 * 🔴 malformed 包**不 throw**（§4 规则），而是返回 `PackValidationNote[]`。
 * `error` 级别的 note 阻止安装（调用方据 `notes.some(n => n.level === 'error')` 判）；
 * `warning` 级别的 note 只提示、不阻断。
 *
 * 与 `WorkshopNote`（dropped/degraded/sideEffect）刻意分开：那是**安装后的处置记录**，
 * 本类型是**安装前的格式/版本问题**，两者阶段不同、语义不同，混在一起会让 UI 报错语气错乱。
 */
export interface PackValidationNote {
  level: PackValidationLevel;
  /** 机器可读的 code，方便调用方按错误类型分支（如 `'bad-format-version'`） */
  code: string;
  /** 人类可读说明 */
  text: string;
}

// ═══════════════════════════════════════════════════════════
// 内容态（D16 / §5.1）
// ═══════════════════════════════════════════════════════════

/**
 * 应用级内容态（D16）。content-store 暴露给 UI 的状态字段。
 *
 * - `placeholder` —— 未装内容包，运行在演示级占位内容上
 * - `pack` —— 已装内容包（设计文档写作 `pack:<id>@<ver>`，本枚举只存离散值，
 *   packId/packVersion 由 content-store 另存字段）
 * - `needs_attention` —— 装包后状态失配（如 FullBackup 恢复后对账发现 pack 拥有项
 *   缺失或被替换，§5.7），需用户二选
 * - `error` —— 内容加载失败（进状态而不是静默，§5.5）
 */
export type ContentStatus = 'placeholder' | 'pack' | 'needs_attention' | 'error';

// ═══════════════════════════════════════════════════════════
// 基线 hash 集合（D18 / D20）
// ═══════════════════════════════════════════════════════════

/**
 * 逐书/逐项基线 hash 集合（D20 四态规则的操作数）。
 *
 * 🔴 **基线来源 = 构建期生成、随引擎打包的占位 hash 清单**
 * （`placeholder-hashes.json`，D20），**不许运行时 fetch `/data/*` 现算**（D20 裁定：
 * overlay 生效时那里是真实内容树，现算会把作者刚编辑的真书误判成「未动过的占位」而
 * 静默覆盖）。planner 是纯函数，基线由调用方作参数传入。
 *
 * `byBook` 键 = 世界书 id；值 = 该书正文的确定性 hash（同步算，不依赖 crypto.subtle）。
 * 预留 `byPreset` / `byBeautifierRule` 等键供 D20 其它分节的四态规则在 T6 接线时填入。
 */
export interface PackBaseline {
  /** 世界书 id → 正文确定性 hash */
  byBook?: Readonly<Record<string, string>>;
  /** 预设 id → 整行确定性 hash（T6 接线） */
  byPreset?: Readonly<Record<string, string>>;
  /** 美化规则 id → 整行确定性 hash（T6 接线） */
  byBeautifierRule?: Readonly<Record<string, string>>;
}

// ═══════════════════════════════════════════════════════════
// 安装计划（D19 / D20）
// ═══════════════════════════════════════════════════════════

/**
 * 一次安装/升级/卸载的**单个分节**的决策。
 *
 * 四态（D20）:
 * - `added` —— 新增项（当前不存在）
 * - `updated` —— 覆盖项（当前存在且 hash 匹配基线 → 静默覆盖；或用户已确认后覆盖）
 * - `removed` —— 刻意清空项（pack 声明 `[]`）
 * - `conflicted` —— 当前存在且 hash 不匹配任何基线 → 需用户确认（两阶段提交）
 *
 * 本波只立类型骨架（T1）；planner 的四态判定逻辑在 T6 实现。
 */
export interface PackSectionPlan<T = unknown> {
  added: T[];
  updated: T[];
  removed: T[];
  conflicted: Array<{
    /** 当前库里该项的唯一键（世界书 = id，预设 = id，…） */
    key: string;
    /** 该项的人类可读名，给确认对话框用 */
    name: string;
    /** 当前库里该项的 hash */
    currentHash: string;
    /** pack 声明该项应有的 hash */
    packHash: string;
  }>;
}

/** 空分节计划（planner 对 absent 分节返回此值，语义 = 别动） */
export function emptySectionPlan<T = unknown>(): PackSectionPlan<T> {
  return { added: [], updated: [], removed: [], conflicted: [] };
}

/**
 * 存档 uid 迁移步骤（D43）。
 *
 * 占位书与真实书同分区不同 uid 空间（占位 uid ∈ 900001+ 保留段，D43）→ 占位期建的
 * 存档在装包后核心分区会被静默滤成零条。迁移优先**按名配对**（D43 v1.2 裁定，工坊先例）：
 * 配对产出 old→new 重写映射；配不上的单选钉选分区（`system_core`/`character`）键标记
 * `needs_selection`，UI 强制重选后写新键；多选分区的失配键允许清除 + note。
 *
 * 本波只立类型骨架（T1）；迁移执行逻辑在后续波次实现。
 */
export interface PackSaveUidMigration {
  /** `partition:oldUid` → `partition:newUid` 的重写映射（按名配对的幸存者） */
  rewrite: Readonly<Record<string, number>>;
  /** 标记 `needs_selection` 的单选钉选分区（裸删会触发内容通胀，D43） */
  needsSelectionPartitions: WorldBookPartition[];
}

/**
 * `planPackInstall` 的产物 —— 一次安装/升级的**全部决策**（§5.1 / D19）。
 *
 * 逐节 added/updated/removed/conflicted + 存档 uid 迁移步骤 + 处置记录。
 *
 * 🔴 本波（T1）只立**类型骨架**：`planPackInstall` 的具体四态判定逻辑是 T6 的任务，
 *    T1 的实现只返回 `// TODO(T6)` 占位（空计划）。但 hash 工具与 `validatePackOrThrow`
 *    必须完整实现（planner 完整实现依赖它们）。
 */
export interface PackInstallPlan {
  packId: string;
  packVersion: string;
  /** 各分节计划；absent 分节不出现于此键（语义 = 别动） */
  sections: {
    worldBooks?: PackSectionPlan<WorldBook>;
    presets?: PackSectionPlan<ChatPreset>;
    beautifierRules?: PackSectionPlan<BeautifierRule>;
    mapMarkers?: PackSectionPlan<MapMarker>;
    catalog?: PackSectionPlan<unknown>;
    locations?: PackSectionPlan<LocationNode>;
    bloodlines?: PackSectionPlan<PackBloodlinesSection>;
    namePools?: PackSectionPlan<unknown>;
    /**
     * 随机事件（第 13 面，§3.3）—— **整节替换**，走 bloodlines/catalog 那一档
     * （`planOpaqueSection`）：事件定义没有 id，逐项键只能是事件名，而同名后装覆盖的
     * 判定已经在 `coerceRandomEventPack` 里做过一次了 —— planner 再做一遍就是两处口径。
     */
    randomEvents?: PackSectionPlan<PackRandomEventsSection>;
  };
  agentDefaults?: {
    /** 默认层键集合（D44：解析名册 = 默认层键 ∪ 覆写层键） */
    agentIds: string[];
  };
  branding?: {
    /** 该 pack 声明了哪些 branding 子字段（用于运行时覆盖判定） */
    declaredKeys: string[];
  };
  /** 存档 uid 迁移步骤（D43）。无 worldBooks 分节时省略 */
  saveUidMigration?: PackSaveUidMigration;
  /** 处置记录（参考 WorkshopNote 形状） */
  notes: WorkshopNote[];
  /** 校验阶段产出的 error 级问题（非空时调用方应阻止安装） */
  validationErrors: PackValidationNote[];
}
