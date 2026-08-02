/**
 * format.ts — 工坊 UI 的展示层纯函数（Phase 1 / P1-4）
 *
 * 只有「数字/时间戳 → 给人看的串」这一类无状态转换。放这里而不是各组件里各写一份，
 * 是因为同一个体积会同时出现在浏览卡片、详情模态与已装列表上，三处口径必须一致。
 *
 * 纯度约束: 无 Vue、无 store、无 I/O。
 */
import type { WorkshopNoteKind } from '@engine/types';
import type { WorkshopNoteGroups } from '@engine/workshop-types';
import { WORKSHOP_BASE_TAGS, WORKSHOP_NOTE_KINDS } from '@engine/workshop-types';

/** 字节 → 人类可读。上游 `fileSize` 缺失或为 0 时返回空串（调用方据此不渲染那一格） */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 时间戳 → `YYYY-MM-DD`。0 / 非法值返回空串 */
export function formatDate(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 版本串在 UI 上一律带 `v` 前缀；上游自己带了就不重复加（D13: 只做串比对不解析） */
export function formatVersion(version: string | undefined): string {
  const v = (version ?? '').trim();
  if (!v) return '';
  return /^v/i.test(v) ? v : `v${v}`;
}

// ═══════════════════════════════════════════════════════════
// 基础标签（对齐上游 BASE_TAG_META）
// ═══════════════════════════════════════════════════════════

/** 四个基础标签各自的配色类名 —— 与上游 `type-badge` 的四色一一对应 */
export const WORKSHOP_BASE_TAG_CLASS: Readonly<Record<string, string>> = {
  系统: 'system',
  扩展: 'extension',
  角色: 'character',
  事件: 'event',
};

/**
 * 项目的**主**基础标签 —— 一个项目可能同时挂 `系统` 和 `扩展`，徽章只能显示一个，
 * 按 {@link WORKSHOP_BASE_TAGS} 的顺序取第一个命中的。
 *
 * ★ 一个都没命中时返回**空串**，与上游不同。上游 `getBaseTag` 在这种情况下退回
 * `BASE_TAGS[0]`（也就是「系统」）—— 那是在替作者做一个他没做过的声明，一个只挂了
 * 「路边」标签的项目会被我们盖章成「系统」，而「系统」恰恰是最需要用户警惕的那类
 * （D12：标签是用户判断会不会和命定核心打架的唯一依据）。宁可不出徽章。
 */
export function baseTagOf(tags: readonly string[] | undefined): string {
  if (!Array.isArray(tags)) return '';
  return WORKSHOP_BASE_TAGS.find((base) => tags.includes(base)) ?? '';
}

/** 基础标签 → 配色类名。非基础标签返回空串（调用方据此不上色） */
export function baseTagClass(tag: string): string {
  return WORKSHOP_BASE_TAG_CLASS[tag] ?? '';
}

// ═══════════════════════════════════════════════════════════
// 审核状态（Phase 4，对齐上游 getProjectReviewBadge）
// ═══════════════════════════════════════════════════════════

/** 审核徽章。`kind` 决定配色：`warn` 待处理 / `err` 被拒 / `muted` 仅信息 */
export interface WorkshopReviewBadge {
  text: string;
  kind: 'warn' | 'err' | 'muted';
}

/**
 * 项目的审核状态 → 徽章。`null` = 一切正常，**不出徽章**。
 *
 * 只在「我的项目」视图里会看到非 null 的结果 —— 公开列表只返回已过审的项目。
 *
 * ★ 判定顺序即优先级，改动前先想清楚: 草稿的状态**压过**本体的状态。一个已过审的
 * 项目提交了新版本草稿、草稿被拒 —— 此时 `status` 是本体的 `approved`，作者要看到的
 * 却是「新版本被拒」。先判 `reviewTarget === 'draft'` 才能说对这句话。
 *
 * ★ 与上游的一处不同: 上游 `getProjectReviewBadge` **只**给草稿出徽章，本体处于
 * `pending` / `rejected` 时一个字都不说（它靠禁用「修改」按钮 + title 提示来表达）。
 * 我们没有那两个按钮可禁，于是把这两种状态也说出来 —— 一个刚投稿的作者切到「我的
 * 项目」却看不到「审核中」，只会以为投稿没成功。
 */
export function describeReviewState(
  listing:
    | {
        status: string;
        reviewTarget: string;
        hasPendingDraft: boolean;
        visibility: boolean;
      }
    | undefined,
): WorkshopReviewBadge | null {
  if (!listing) return null;

  const isDraft = listing.reviewTarget === 'draft';
  if (isDraft && listing.status === 'pending') return { text: '新版本审核中', kind: 'warn' };
  if (isDraft && listing.status === 'rejected') return { text: '新版本被拒', kind: 'err' };
  if (listing.status === 'pending') return { text: '审核中', kind: 'warn' };
  if (listing.status === 'rejected') return { text: '已被拒绝', kind: 'err' };
  if (listing.hasPendingDraft) return { text: '有新版本待审', kind: 'muted' };
  // 已隐藏排在最后：它是作者自己的选择，不是需要处理的状态
  if (!listing.visibility) return { text: '已隐藏', kind: 'muted' };
  return null;
}

// ═══════════════════════════════════════════════════════════
// 处置记录文案
// ═══════════════════════════════════════════════════════════

/**
 * 每类处置记录的标题文案 —— **口径只有一份**（折叠行、分组标题、toast 共用）。
 *
 * ★ 「未导入」这三个字**只属于 `dropped`**。曾经三类合流报「N 项内容未导入」，
 * 用户读到的是安装失败，而 `degraded` / `sideEffect` 那些正则装得好好的。
 */
export const WORKSHOP_NOTE_LABEL: Record<WorkshopNoteKind, string> = {
  dropped: '未导入',
  degraded: '已装但效果受限',
  sideEffect: '有全局副作用',
};

/** 每类的展开区副标题 —— 一句话说清「这一组到底发生了什么」 */
export const WORKSHOP_NOTE_HINT: Record<WorkshopNoteKind, string> = {
  dropped: '上游的这些内容在本引擎没有对应物，确实没装进来。',
  degraded: '这些内容已经装上并启用，只是显示效果不完整。',
  sideEffect: '这些内容已经装上，但影响范围超出规则自身，可能波及整个界面。',
};

/** 「3 项未导入」这种一段。count 为 0 时返回空串，调用方据此不渲染 */
export function formatNoteSegment(kind: WorkshopNoteKind, count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return `${count} 项${WORKSHOP_NOTE_LABEL[kind]}`;
}

/**
 * 折叠行/toast 的整句 —— 只拼**非空**的组，永不出现「0 项」。
 *
 * 三组全空时返回空串（调用方据此整块不渲染）。
 */
export function summarizeNoteGroups(groups: WorkshopNoteGroups): string {
  return WORKSHOP_NOTE_KINDS.map((kind) => formatNoteSegment(kind, groups[kind].length))
    .filter((seg) => seg.length > 0)
    .join(' · ');
}

// ═══════════════════════════════════════════════════════════
// 装前检视（详情模态的条目/正则列表）
// ═══════════════════════════════════════════════════════════

/**
 * ST 条目的 `position` → 中文。
 *
 * 数值取自 ST 的 world info：0/1 是相对角色定义的前后，4 是按深度插入。
 * 本引擎注入时**不消费**这个字段（`formatWorldBookEntries` 只按 order 拼接），
 * 所以这里的用途纯粹是「让用户看懂上游作者的意图」，不代表安装后的行为。
 */
export function describeEntryPosition(position: number): string {
  switch (position) {
    case 0:
      return '角色定义前';
    case 1:
      return '角色定义后';
    case 4:
      return '按深度插入';
    default:
      return `位置 ${position}`;
  }
}

/**
 * ST 的 `selectiveLogic` → 中文（对齐 `worldbook-loader.matchKeyword` 的四分支）。
 *
 * 只在条目**有次要关键词**时才有意义 —— 没有次要关键词时 ST 直接走「主关键词任一
 * 命中」，这个字段的值是什么都不影响结果，照实显示反而误导。
 */
export function describeSelectiveLogic(logic: number): string {
  switch (logic) {
    case 0:
      return '任一次要命中';
    case 1:
      return '非全部次要命中';
    case 2:
      return '无次要命中';
    case 3:
      return '全部次要命中';
    default:
      return `逻辑 ${logic}`;
  }
}

// ═══════════════════════════════════════════════════════════
// 登录位（Phase 3 / P3c）
// ═══════════════════════════════════════════════════════════

/** Discord 自带的默认头像 —— 用户没设过头像、或头像加载失败时的兜底 */
export const DISCORD_FALLBACK_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

/**
 * 用户快照 → 头像 URL。
 *
 * ⚠️ JWT 里的 `avatar` 是**哈希不是 URL**（见 `WorkshopAuthUser`），必须自己拼。
 * 拿 `.webp` 而非 `.png`: 同尺寸小一半，且动图头像（`a_` 开头）也能取到静态帧 ——
 * 顶栏那一格 24px 的圆图不值得为动起来多下几十 KB。
 *
 * 拼不出来（没 id / 没哈希）就回默认头像，**不返回空串** —— 空 `src` 会让浏览器
 * 去请求当前页面地址，然后画一个碎图标。
 */
export function discordAvatarUrl(user: { userId: string; avatar: string } | null): string {
  const id = (user?.userId ?? '').trim();
  const hash = (user?.avatar ?? '').trim();
  if (!id || !hash) return DISCORD_FALLBACK_AVATAR;
  return `https://cdn.discordapp.com/avatars/${id}/${hash}.webp?size=100`;
}

/**
 * 顶栏显示名。`globalName` 是 Discord 的显示名，缺了才退回 `username` ——
 * 反过来的话，改过显示名的用户会在我们这里看到一个他早就不用的旧 ID。
 */
export function discordDisplayName(user: { username: string; globalName: string } | null): string {
  const global = (user?.globalName ?? '').trim();
  if (global) return global;
  const name = (user?.username ?? '').trim();
  return name || '工坊用户';
}

/** 长文本截断 —— 折叠行的预览段，展开后看全文 */
export function truncate(text: string, max = 90): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}
