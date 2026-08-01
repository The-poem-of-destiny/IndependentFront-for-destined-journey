/**
 * workshop-enable.ts — 工坊项目「启用轴」纯函数（Phase 1 / P1-5）
 *
 * 设计: docs/planning/2026-07-31-creative-workshop-compat-design.md D10/D12
 *
 * 工坊条目与其它条目**一视同仁**: 启用信息就是存档 `metadata.enabledWorldBookEntries`
 * 里的 `creative_workshop:<uid>` 串，与 `system_core:413` 无异。本模块**不**引入第二
 * 套启用存储、**不**给工坊分区加缺省反转、**不**碰 `filterBooksByEnabledEntries`。
 *
 * 存在的理由只有一个: UI 粒度是**项目**，存储粒度是**条目**（D12）。把「项目 ↔ 一组
 * uid 串」这层展开/回读做成纯函数，捏人页（建档前）与每存档面板（建档后）就能共用
 * 同一套语义 —— 两处各写一遍必然在「取消勾选要删哪些串」上分叉。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局。
 */
import type { WorkshopProject, WorldBook } from '@engine/types';
import { WORKSHOP_PARTITION, workshopBookId } from '@engine/workshop-types';

/** `creative_workshop:` —— 存档 token 的前缀 */
const TOKEN_PREFIX = `${WORKSHOP_PARTITION}:`;

/**
 * 一个可勾选的工坊项目 —— 项目元数据 + 它展开成的那组 uid。
 *
 * `tags` / `description` 必须原样带到 UI: D12 明确不做命定核心冲突拦截，
 * 「显著展示 tags 与简介，由用户判断」是本设计里唯一的冲突提示手段。
 */
export interface WorkshopEnableOption {
  projectId: string;
  name: string;
  description: string;
  authorName: string;
  version: string;
  tags: string[];
  /** 该项目全部条目的 uid（升序、去重）。空数组 = 项目装着但没有世界书条目（可能只带正则） */
  entryUids: number[];
}

/**
 * 已装项目 + 全量世界书 → 可勾选项列表。
 *
 * 以 `projects`（`workshopProjects` 表）为准而非以书为准: **未安装的项目不出现在列表**，
 * 而残留的书（理论上不该有）也不会凭空造出一个没有元数据的勾选项。
 * 找不到对应书 / 书里没条目的项目仍会出现，只是 `entryUids` 为空 —— 由 UI 标注，
 * 不在这里静默过滤掉（用户装了它，看不到会以为没装上）。
 */
export function buildWorkshopEnableOptions(
  projects: readonly WorkshopProject[],
  books: readonly WorldBook[],
): WorkshopEnableOption[] {
  const bookById = new Map<string, WorldBook>();
  for (const book of books) {
    if (book?.partition === WORKSHOP_PARTITION && typeof book.id === 'string') {
      bookById.set(book.id, book);
    }
  }
  const options: WorkshopEnableOption[] = [];
  for (const project of projects) {
    if (!project || typeof project.id !== 'string' || !project.id) continue;
    const book = bookById.get(workshopBookId(project.id));
    const uids = new Set<number>();
    for (const entry of book?.entries ?? []) {
      if (Number.isFinite(entry?.uid)) uids.add(Math.trunc(entry.uid));
    }
    options.push({
      projectId: project.id,
      name: project.name || project.id,
      description: project.description || '',
      authorName: project.authorName || '',
      version: project.installedVersion || project.version || '',
      tags: Array.isArray(project.tags) ? [...project.tags] : [],
      entryUids: [...uids].sort((a, b) => a - b),
    });
  }
  return options;
}

/** 一个项目展开成的存档 token（D12: 勾一个项目 = 写入其**全部**条目） */
export function workshopTokensFor(option: WorkshopEnableOption): string[] {
  return option.entryUids.map((uid) => `${TOKEN_PREFIX}${uid}`);
}

/** 从 token 数组里挑出工坊分区的那些 uid */
function workshopUidsIn(tokens: readonly string[]): Set<number> {
  const uids = new Set<number>();
  for (const token of tokens) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) continue;
    const uid = Number(token.slice(TOKEN_PREFIX.length));
    if (Number.isFinite(uid)) uids.add(Math.trunc(uid));
  }
  return uids;
}

/**
 * 该项目在这份 token 里算不算「已启用」。
 *
 * 要求**全部**条目在场: 项目是一个作品（D12），少一条就不是用户勾的那个东西，
 * 显示成半启用只会让人以为自己勾过。没有条目的项目恒为 false —— 它没有可启用之物。
 */
export function isWorkshopProjectEnabled(
  option: WorkshopEnableOption,
  tokens: readonly string[],
): boolean {
  if (option.entryUids.length === 0) return false;
  const present = workshopUidsIn(tokens);
  return option.entryUids.every((uid) => present.has(uid));
}

/** 回读: 这份 token 里哪些项目是勾着的（顺序随 options） */
export function selectedWorkshopProjectIds(
  options: readonly WorkshopEnableOption[],
  tokens: readonly string[],
): string[] {
  return options.filter((o) => isWorkshopProjectEnabled(o, tokens)).map((o) => o.projectId);
}

/**
 * 把一份「勾了哪些项目」写回 token 数组。
 *
 * 语义刻意粗暴: **先清掉所有 `creative_workshop:` token**，再按勾选重铺。
 * - 取消勾选 → 该项目的串一条不剩（否则半残留会让下次回读显示成还勾着）。
 * - 已卸载项目留下的陈旧串一并清掉 —— 它指向的条目已经不存在，留着只会让
 *   「面板显示没勾任何项目、实际却过滤着整个分区」这种鬼状态永久化。
 *
 * 非工坊 token（`system_core:` / `character:`）**原样按序保留** —— 三条轴互不干扰
 * 是这个函数最重要的性质。
 */
export function applyWorkshopSelection(
  tokens: readonly string[],
  options: readonly WorkshopEnableOption[],
  enabledProjectIds: readonly string[] | ReadonlySet<string>,
): string[] {
  const enabled =
    enabledProjectIds instanceof Set ? enabledProjectIds : new Set(enabledProjectIds as string[]);
  const kept = tokens.filter((t) => typeof t === 'string' && !t.startsWith(TOKEN_PREFIX));
  const added: string[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    if (!enabled.has(option.projectId)) continue;
    for (const token of workshopTokensFor(option)) {
      if (seen.has(token)) continue;
      seen.add(token);
      added.push(token);
    }
  }
  return [...kept, ...added];
}
