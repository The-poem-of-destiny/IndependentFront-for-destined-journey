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
 * 其余上游字段（`publishedProjectId` `authorId` `status` `reviewedAt` …）属身份/
 * 审核面，**刻意丢弃**。上游原始响应不整包存库 —— 否则即第二真相来源，违反铁律 4。
 *
 * ⚠️ 社交计数（`likesCount` / `userLiked` / …）在 Phase 3 起**被解析**，但落点是
 * 另一个类型 {@link WorkshopSocialMeta}，**不并入本类型**。理由见那边的注释：
 * 本类型是落库实体的投影，社交面是纯内存展示层，混在一起就等于把一份会随时变、
 * 且随调用者身份变的数据写进了库。
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
// 上游 → 内部：社交面（D22，Phase 3）
// ═══════════════════════════════════════════════════════════

/**
 * 一个项目的社交计数与「我」的旗标（D22）。
 *
 * 🔴 **纯内存展示层，绝不落库**。D13 的存储禁令一个字都没松动：
 * 本类型不进 {@link WorkshopProjectMeta}、不进 `WorkshopProject`、不进 Dexie、
 * 不进 FullBackup，`workshopProjects` 表结构零改动。
 *
 * 为什么它必须留在内存里，而不是「顺手存一份省得每次拉」:
 * - `userLiked` / `userSubscribed` 是**按调用者的 JWT 填充**的（上游 `utils/db.ts`）。
 *   落库就等于把「当前这个人的旗标」写成了「这个项目的属性」—— 换个账号登录、
 *   或者登出之后，库里那个 `true` 会继续告诉 UI「你赞过」。
 * - 三个计数每时每刻都在被别人改。库里的数字从写入那一刻起就是错的，
 *   而 UI 上一个静止的错数字比没有数字更糟。
 *
 * 所以它只有两个来源：列表/详情响应顺带解析（零新增请求，D22），以及 toggle
 * 响应的权威回值（D23）。刷新页面即消失，正是我们想要的。
 *
 * 缺字段一律 0 / false（见 `workshop-manifest.parseSocialMeta`）。
 * ⚠️ `false` **不是权威负证据** —— 上游异常兜底路径会硬编码 `userLiked: false`
 * （§1.3），未登录时它也恒为 false。只有 toggle 响应说的才算数。
 */
export interface WorkshopSocialMeta {
  likesCount: number;
  subscribesCount: number;
  /**
   * 下载计数。⚠️ **仅供展示，不做任何逻辑依赖** —— 上游只在拉载荷文件时 +1，
   * 而载荷带 `s-maxage=86400`，绝大多数下载被边缘缓存挡在计数之前（§1.3）。
   */
  downloadsCount: number;
  /** 「我」赞过没有。未登录恒 false */
  userLiked: boolean;
  /** 「我」订阅了没有。未登录恒 false */
  userSubscribed: boolean;
}

/**
 * 一个项目的**目录展示面**（Phase 4）—— 作者身份与审核状态。
 *
 * 🔴 与 {@link WorkshopSocialMeta} 同一条纪律：**纯内存展示层，绝不落库**。
 * 不进 {@link WorkshopProjectMeta}、不进 `WorkshopProject`、不进 Dexie、不进 FullBackup。
 *
 * 为什么这些字段不能并进 `WorkshopProjectMeta`: 那个类型是**落库实体的投影**
 * （`Pick<WorkshopProject, …>`），进去的每个字段都会被写进 `workshopProjects` 表。
 * 而这里的每一项都会变:
 * - `status` / `reviewTarget` / `rejectReason` —— 审核状态，作者改一版就翻篇。存下来
 *   等于让用户在「已安装」列表里永远看到一条三个月前的「审核中」。
 * - `visibility` / `hasPendingDraft` —— 同上，且只对作者本人有意义。
 * - `authorAvatarUrl` —— Discord 头像哈希换了旧 URL 就 404。
 *
 * 与社交面并列成第二个 sidecar 而不是塞进同一个: 两者的**来源不同**。社交面还有
 * toggle 回执这条权威更新路径（D23），本类型只有列表/详情响应一条。混在一起之后，
 * 「toggle 回来该覆盖哪几个字段」就再没有类型上的答案了。
 */
export interface WorkshopListingMeta {
  /** 上游作者 id（Discord snowflake）。用于判「这是不是我的项目」 */
  authorId: string;
  /**
   * 作者头像的**完整 URL**。上游 `/api/projects` 与 `/api/my/projects` 都已在服务端
   * 拼好（`cdn.discordapp.com/avatars/<id>/<hash>.webp`），我们不重复拼；万一将来
   * 上游改回只给哈希，`parseListingMeta` 会替我们兜住。拿不到就空串（调用方据此
   * 走默认头像，**不渲染空 src**）。
   */
  authorAvatarUrl: string;
  /** 上游审核状态：`approved` / `pending` / `rejected`。未知值原样保留 */
  status: string;
  /** 审核对象：`project`（项目本体）/ `draft`（新版本草稿） */
  reviewTarget: string;
  /** 被拒原因。没有就空串 */
  rejectReason: string;
  /** 有一个待审核的新版本草稿 */
  hasPendingDraft: boolean;
  /** 作者是否把它设为公开 */
  visibility: boolean;
  /** 上游的更新时间戳（ISO 串）。用作封面的缓存版本号，见 lib/workshop-cover.ts */
  updatedAt: string;
}

/**
 * toggle 端点（点赞/订阅）的回执 —— 上游返回 `{liked|subscribed, count}`，
 * 两个动作的字段名不同但语义同构，故在读侧统一成一个形状。
 *
 * ★ 它是社交值**唯一的权威来源**：翻转语义（有行删、无行插、再重数）下，
 * 本地推算的「+1」只是乐观显示，服务端数到几就是几（D23）。
 */
export interface WorkshopToggleAck {
  /** 翻转后的状态：true = 现在赞着/订阅着 */
  active: boolean;
  /** 翻转后的总数（服务端重数的结果） */
  count: number;
}

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
