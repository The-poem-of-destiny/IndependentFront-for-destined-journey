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

import type {
  BeautifierRule,
  WorkshopNote,
  WorkshopNoteKind,
  WorkshopNoteLike,
  WorkshopProject,
  WorldBookEntry,
  WorldBookPartition,
} from './types';

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

/**
 * 上游的四个基础标签（对齐上游 `BASE_TAG_META`）。
 *
 * ★ 筛选条**恒定渲染这四个**，不从当前页的项目里现采。现采的版本有两个毛病：
 * 一是翻到不含某标签的页时该标签会从筛选条里消失（用户无从得知它存在过）；
 * 二是筛选条的行数随页面内容变化，每次翻页都把下方整个网格顶上顶下 —— 这是
 * 浏览模态里最显眼的一处抖动。
 *
 * 上游项目的 `tags` 是自由文本，可以含这四个以外的值；那些只作展示（D6/D12），
 * 不进筛选条。
 */
export const WORKSHOP_BASE_TAGS: readonly string[] = ['系统', '扩展', '角色', '事件'];

/** 一个项目对应的世界书 id（D7） */
export function workshopBookId(projectId: string): string {
  return `${WORKSHOP_BOOK_ID_PREFIX}${projectId}`;
}

/** 一条工坊正则对应的美化规则 id */
export function workshopRuleId(projectId: string, sourceId: string): string {
  return `${WORKSHOP_RULE_ID_PREFIX}${projectId}:${sourceId}`;
}

// ═══════════════════════════════════════════════════════════
// 处置记录：类别、归一、分组
// ═══════════════════════════════════════════════════════════

/** 展示顺序 —— `sideEffect` 最后但在 UI 上最显眼；它是唯一会影响其它 UI 的一类 */
export const WORKSHOP_NOTE_KINDS: readonly WorkshopNoteKind[] = [
  'dropped',
  'degraded',
  'sideEffect',
] as const;

/** 造一条处置记录（产出侧的糖，省得每处都写字面量） */
export function workshopNote(kind: WorkshopNoteKind, text: string): WorkshopNote {
  return { kind, text };
}

function isNoteKind(value: unknown): value is WorkshopNoteKind {
  return typeof value === 'string' && (WORKSHOP_NOTE_KINDS as readonly string[]).includes(value);
}

/**
 * 归一一条处置记录 —— **读侧唯一入口**（铁律 2 的同一个道理）。
 *
 * 裸字符串是 P1 首版的落库形态，用户库里已经有；缺省归 `dropped`，与旧 UI
 * 「N 项内容未导入」的语气一致，不会把老数据说成「有副作用」。
 * `kind` 是脏值（老版本写的、手改过的备份）时同样退回 `dropped`，绝不抛。
 */
export function normalizeWorkshopNote(note: WorkshopNoteLike): WorkshopNote {
  if (typeof note === 'string') return { kind: 'dropped', text: note };
  const kind = isNoteKind((note as Partial<WorkshopNote>)?.kind)
    ? (note as WorkshopNote).kind
    : 'dropped';
  const raw: unknown = (note as Partial<WorkshopNote>)?.text;
  return { kind, text: typeof raw === 'string' ? raw : String(raw ?? '') };
}

/**
 * 归一整个数组，**容忍旧 `string[]` 与混合数组**。
 *
 * 非数组（`undefined` / 被备份改坏的行）一律得空数组：一条脏的展示字段不该让
 * 整个已装列表白屏。空文本的项丢掉 —— 它只会渲染成一个空 `<li>` 并把计数灌水。
 */
export function normalizeWorkshopNotes(
  notes: readonly WorkshopNoteLike[] | undefined,
): WorkshopNote[] {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((n) => n !== null && n !== undefined)
    .map((n) => normalizeWorkshopNote(n))
    .filter((n) => n.text.length > 0);
}

/** 按类别分好的处置记录 —— 三个键恒在（空组给空数组），UI 直接 `.length` 取数 */
export type WorkshopNoteGroups = Record<WorkshopNoteKind, WorkshopNote[]>;

/**
 * 归一 + 分组，一步到位。
 *
 * UI 拿它出「N 项未导入 · N 项已装但效果受限 · N 项有全局副作用」——
 * **只有 `dropped` 那一组配叫「未导入」**。
 */
export function groupWorkshopNotes(
  notes: readonly WorkshopNoteLike[] | undefined,
): WorkshopNoteGroups {
  const groups: WorkshopNoteGroups = { dropped: [], degraded: [], sideEffect: [] };
  for (const note of normalizeWorkshopNotes(notes)) groups[note.kind].push(note);
  return groups;
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
  /**
   * 处置记录（丢弃项 / 已知后果）—— **丢弃必须 loud**，但只有 `kind: 'dropped'`
   * 那一组配叫「未导入」；`degraded` / `sideEffect` 是装上了之后的表现。
   */
  droppedNotes: WorkshopNote[];
  /** 是否为更新（registry 带了已装条目） */
  isUpdate: boolean;
}

/**
 * 美化规则草稿 —— 与 `BeautifierRule` 同形，独立命名是为了标明它出自纯函数、
 * 尚未落库（`locked` 是运行时计算字段，本层永不产出）。
 */
export type BeautifierRuleDraft = Omit<BeautifierRule, 'locked'>;

// ═══════════════════════════════════════════════════════════
// 工坊书 → Agent 可见性
// ═══════════════════════════════════════════════════════════

/**
 * 把一本工坊世界书授予**所有** Agent。
 *
 * ★ 为什么需要这一步: Agent 只看得见 `AgentConfig.worldBookIds` 里点过名的书
 * （`worldbook-loader.getEntriesForAgent`）。工坊装进来的书带的是新 id
 * （`workshop:<projectId>`），不在任何 Agent 的清单里 —— 于是「装了、也在存档里
 * 勾了启用」的工坊内容，**一个 Agent 都读不到**。用户看到的是「装了等于没装」。
 *
 * 本函数只动 `worldBookIds` 名单，**不碰** `agentWorldbookEnabled`（那是另一条轴：
 * 「这个 Agent 到底用不用世界书」，项目默认里 memory_recall / plot_pre_check /
 * item_gen / combat 是刻意关掉的，替用户翻开会让它们凭空吃下整包工坊内容）。
 *
 * 条目自身的 `enabled` 与存档级 `enabledWorldBookEntries` 仍照常过滤 —— 授予可见性
 * 不等于强行注入。
 *
 * 纯函数: 返回新映射，不改入参。
 */
export function grantWorkshopBookToAgents(
  agentWorldbookIds: Readonly<Record<string, string[]>>,
  bookId: string,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [agentId, ids] of Object.entries(agentWorldbookIds)) {
    const list = Array.isArray(ids) ? ids : [];
    next[agentId] = list.includes(bookId) ? [...list] : [...list, bookId];
  }
  return next;
}

/**
 * 卸载时收回可见性 —— 与 {@link grantWorkshopBookToAgents} 成对。
 *
 * 不收回的话，Agent 清单里会积一堆指向已删书的死 id。今天无害（`getEntriesForAgent`
 * 按 id 取交集，取不到就跳过），但它会随每次装-卸不断变长，且让用户在设置页的
 * 世界书勾选列表里看到一串不存在的书。
 */
export function revokeWorkshopBookFromAgents(
  agentWorldbookIds: Readonly<Record<string, string[]>>,
  bookId: string,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [agentId, ids] of Object.entries(agentWorldbookIds)) {
    const list = Array.isArray(ids) ? ids : [];
    next[agentId] = list.filter((id) => id !== bookId);
  }
  return next;
}
