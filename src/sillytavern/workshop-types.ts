/**
 * workshop-types.ts — 创意工坊纯类型 + 常量（Phase 1 / P1-1）
 *
 * 为什么存在: 工坊的三个纯函数模块（manifest / regex-map / install-plan）共享一组
 * **过程形状** —— 上游 ST 原始条目的规范化中间态、安装计划、冲突记录。它们不是落库
 * 实体（落库实体 `WorkshopProject` / `WorldBook` / `BeautifierRule` 住在 types.ts），
 * 所以按 asset-* 系列的规矩本地声明本地导出，不污染 types.ts。
 *
 * 纯度约束: 本文件只有 type / interface / const / 纯字符串函数。无 I/O、无 Dexie、
 * 无 Vue、无浏览器全局。
 *
 * 设计: docs/planning/2026-07-31-creative-workshop-compat-design.md D6/D7/D8/D13/D14/D15/D16
 */

import type { BeautifierRule, WorkshopProject, WorldBookEntry, WorldBookPartition } from './types';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * 工坊分区（D6）—— **所有**工坊条目一律归此分区，无论上游标成系统/角色/事件/DLC。
 *
 * 分区在本引擎是**信任域边界**，不是内容学分类：工坊内容来自无审查的社区投稿，
 * 必须能被整体识别、整体开关、整体排除。上游 `tags` 只作展示与筛选（D6）。
 */
export const WORKSHOP_PARTITION: WorldBookPartition = 'creative_workshop';

/** 工坊世界书 id 前缀 —— `workshop:<projectId>`（D7，一项目一本书） */
export const WORKSHOP_BOOK_ID_PREFIX = 'workshop:';

/** 工坊美化规则 id 前缀 —— `workshop-rule:<projectId>:<sourceId>` */
export const WORKSHOP_RULE_ID_PREFIX = 'workshop-rule:';

/** 美化规则分组名前缀（D16）—— `创意工坊 · <项目名>` */
export const WORKSHOP_RULE_GROUP_PREFIX = '创意工坊 · ';

/** 工坊美化规则的 order 起始值 —— 排在内置规则之后 */
export const WORKSHOP_RULE_ORDER_BASE = 1000;

/** 一个项目对应的世界书 id（D7） */
export function workshopBookId(projectId: string): string {
  return `${WORKSHOP_BOOK_ID_PREFIX}${projectId}`;
}

/** 一条工坊正则对应的美化规则 id */
export function workshopRuleId(projectId: string, sourceId: string): string {
  return `${WORKSHOP_RULE_ID_PREFIX}${projectId}:${sourceId}`;
}

// ═══════════════════════════════════════════════════════════
// 上游 → 内部：项目元数据（D13）
// ═══════════════════════════════════════════════════════════

/**
 * 上游 `project` 响应中我们**要**的那部分（D13）。
 *
 * 用 `Pick<WorkshopProject, ...>` 而非重新写一遍字段，是为了让「上游侧字段」与
 * 落库实体永远同形 —— types.ts 改字段类型时这里跟着红，不会悄悄漂移。
 *
 * 其余 17 个上游字段（`publishedProjectId` `authorId` `status` `reviewedAt`
 * `likesCount` `userLiked` …）属身份/审核/社交面，**刻意丢弃**，Phase 3+ 再说。
 * 上游原始响应不整包存库 —— 否则即第二真相来源，违反铁律 4。
 */
export type WorkshopProjectMeta = Pick<
  WorkshopProject,
  | 'id'
  | 'rootProjectId'
  | 'name'
  | 'description'
  | 'version'
  | 'authorName'
  | 'tags'
  | 'coverUrl'
  | 'downloadUrl'
  | 'fileSize'
>;

// ═══════════════════════════════════════════════════════════
// 上游 → 内部：载荷（规范化后的 ST 形状）
// ═══════════════════════════════════════════════════════════

/**
 * 规范化后的上游世界书条目。
 *
 * ⚠️ 上游有**两种**世界书条目形状，本类型是二者的交集规范化结果：
 * - 详情接口的 `worldbookEntriesPreview`：`uid` 是**字符串**，有 `enabled`，有 `extra`
 * - `downloadUrl` 载荷文件：`uid` 是**数字**，无 `enabled` 只有 `disable`，无 `extra`
 *
 * `sourceUid` 保留原始形态（`string | number`）供 `extra.workshop.sourceUid` 溯源；
 * 它**不参与任何判定**（D8：uid 由分区级分配器重发，逻辑键是名字）。
 */
export interface WorkshopSourceEntry {
  /** 上游原始 uid，原样保留仅供溯源（D8/D14） */
  sourceUid: string | number;
  /** 上游 `comment` —— 本引擎的 `name`，即 D15 按名匹配的逻辑键 */
  name: string;
  content: string;
  enabled: boolean;
  key: string[];
  keysecondary: string[];
  selectiveLogic: 0 | 1 | 2 | 3;
  order: number;
  position: number;
}

/**
 * 规范化后的上游 ST 正则条目（13 字段）。
 *
 * ⚠️ `substituteRegex` 是**枚举不是布尔**（实测值 0 与 2），故类型为 number。
 * 曾经把它当布尔的实现会在值为 2 时静默走错分支。
 */
export interface WorkshopSourceRegex {
  /** 上游 uuid；缺失时由 manifest 层用序号补 `#<index>` */
  id: string;
  scriptName: string;
  /** ⚠️ 两种形态：裸 pattern 与 `/pattern/flags`，见 workshop-regex-map.parseFindRegex */
  findRegex: string;
  replaceString: string;
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  trimStrings: string[];
  /** ⚠️ 枚举非布尔（实测 0 / 2）—— 本引擎无对应物，丢弃并记 note */
  substituteRegex: number;
  minDepth: number | null;
  maxDepth: number | null;
  placement: number[];
}

/** `parsePayload()` 的产物 —— 两条内容轴 */
export interface WorkshopPayload {
  worldbookEntries: WorkshopSourceEntry[];
  regexEntries: WorkshopSourceRegex[];
}

/** `planInstall()` 的第一参数：载荷 + 它属于哪个项目 */
export interface WorkshopInstallInput extends WorkshopPayload {
  project: WorkshopProjectMeta;
}

// ═══════════════════════════════════════════════════════════
// 安装计划（D8/D14/D15）
// ═══════════════════════════════════════════════════════════

/**
 * 分区级 uid 分配器的状态 + 本项目当前已装条目。
 *
 * `nextUid` 是**整个 `creative_workshop` 分区共享**的游标，全局单调递增（D8）。
 * 多本书共用一个分区，而 `filterBooksByEnabledEntries()` 以 partition 为键建
 * uid 允许表 —— 跨项目撞号会让 `creative_workshop:5` 同时命中所有工坊书的 uid=5。
 * 上游每个项目 uid 都从 0 起编（实测），撞号是必然，故必须重新发号。
 *
 * **卸载不回收号段**：回收会让旧存档的 `enabledWorldBookEntries` 指向新项目的
 * 条目 —— 静默的内容错位，比浪费号段严重得多。
 */
export interface InstallRegistry {
  /** 分区级分配游标，下一个可发的 uid */
  nextUid: number;
  /** 本项目当前已装的条目（更新时按名匹配用）；首装省略或传空数组 */
  existingEntries?: WorldBookEntry[];
}

/** 更新时检出的「用户改过的条目会被覆盖」记录（D15） */
export interface InstallConflict {
  uid: number;
  /** 条目名（= 上游 comment） */
  name: string;
  /** 安装时记录的正文哈希 */
  sourceHash: string;
  /** 当前库里正文的哈希 */
  currentHash: string;
}

/**
 * `planInstall()` 的产物 —— 一次安装/更新的**全部决策**。
 *
 * store 拿到它之后只做一件蠢事：照单写行（`worldBooks` / `workshopProjects` /
 * `BeautifierRule[]`），不含任何转换逻辑。
 */
export interface InstallPlan {
  projectId: string;
  projectName: string;
  /** 目标世界书 id（D7） */
  bookId: string;
  partition: WorldBookPartition;
  /** 本项目安装后应有的**完整**条目列表（覆盖式，D15） */
  entries: WorldBookEntry[];
  /** 由上游正则映射来的美化规则（D16） */
  rules: BeautifierRuleDraft[];
  /**
   * 覆盖 `entries` 全部 uid 的闭开区间 `[start, end)`。
   * 零条目时退化为 `{ start: nextUid, end: nextUid }`（空区间）。
   */
  uidRange: { start: number; end: number };
  /** 本次操作**新发**的号段 `[start, end)`；纯更新且无新增条目时为空区间 */
  allocatedUidRange: { start: number; end: number };
  /** 更新后的分区级游标 —— store 必须把它写回分配器 */
  nextUid: number;
  /** 上游已移除、就此退休的 uid（不回收，D8）；存档里的残留引用惰性失效 */
  retiredUids: number[];
  /** 用户改过、将被本次更新覆盖的条目（D15）—— 非空时 store 须先弹警告 */
  conflicts: InstallConflict[];
  /** 处置记录（丢弃项 / 已知后果）—— **丢弃必须 loud**，UI 明示「N 项未导入」 */
  droppedNotes: string[];
  /** 是否为更新（registry 带了已装条目） */
  isUpdate: boolean;
}

/**
 * 美化规则草稿 —— 与 `BeautifierRule` 同形，独立命名是为了标明它出自纯函数、
 * 尚未落库（`locked` 是运行时计算字段，本层永不产出）。
 */
export type BeautifierRuleDraft = Omit<BeautifierRule, 'locked'>;
