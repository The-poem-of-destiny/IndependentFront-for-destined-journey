/**
 * session-import-messages.ts —— 单存档导入体检结果 → 给人看的中文告警行
 *
 * `checkSessionSaveDependencies` 回的是**结构化的缺失清单**（token / packId /
 * 预设 id），照着渲染等于把内部标识摆给玩家看。这一层把它翻成一句句人话，
 * 供导入前的确认弹窗逐行列出。
 *
 * 🔴 **纯函数、零副作用、除类型外零依赖** —— 它是「导入前到底会缺什么」这句话的
 *    唯一措辞来源。措辞散进组件模板里，两个入口（首页导入 / 日后别处）就会各说各的，
 *    而这些句子恰恰是用户决定「还导不导」的全部依据。
 *
 * 🔴 **告警不是错误**：缺内容照样导得进去（引擎侧刻意不抛），所以这里的句子一律是
 *    陈述而不是阻拦语气。
 */

import type { SessionImportCheck } from '@engine/session-backup';

/** 条目标题一行最多列几个，多出来的用「等 N 条」收尾 */
const MAX_TITLES_PER_BOOK = 5;

/** 解析不出书名的条目归到这一组 —— 导出方自己都缺的条目，收件人更可能缺，不能藏起来 */
const UNKNOWN_BOOK = '未知世界书';

/**
 * 体检结果 → 告警行（顺序：世界书条目 → 内容包 → 正文预设）。
 *
 * 体检通过（`ok === true`，三项皆空）时返回空数组 —— 调用方据此决定连弹窗都不必开。
 */
export function buildSessionImportWarnings(check: SessionImportCheck): string[] {
  const lines: string[] = [];

  // ── 世界书条目：按书名归组（UI 粒度是「哪本书缺了几条」，不是一长串 token）──
  const byBook = new Map<string, string[]>();
  for (const entry of check.missingEntries ?? []) {
    const book = entry.bookName || UNKNOWN_BOOK;
    // 条目名缺席时退回 token：宁可给个能搜的标识，也不要一个空引号
    const title = entry.entryTitle || entry.token;
    const bucket = byBook.get(book);
    if (bucket) bucket.push(title);
    else byBook.set(book, [title]);
  }
  for (const [book, titles] of byBook) {
    const shown = titles.slice(0, MAX_TITLES_PER_BOOK).join('、');
    const tail = titles.length > MAX_TITLES_PER_BOOK ? ` 等 ${titles.length} 条` : '';
    lines.push(`世界书『${book}』缺少 ${titles.length} 个条目：${shown}${tail}`);
  }

  // ── 内容包：没装 / 版本不同，两句话的处置完全不同，不合并 ──
  for (const pack of check.packMismatches ?? []) {
    const name = pack.name || pack.packId;
    if (pack.installedVersion === null) {
      lines.push(`未安装内容包『${name}』（导出端为 v${pack.expectedVersion}）`);
    } else {
      lines.push(
        `内容包『${name}』版本不同（导出端 v${pack.expectedVersion} / 本机 v${pack.installedVersion}）`,
      );
    }
  }

  // ── 正文预设：全局设置，与存档数据无关，必须在句子里说清楚 ──
  if (check.missingStoryPreset) {
    lines.push(
      `本机没有导出端使用的正文预设『${check.missingStoryPreset.name}』（全局设置，不影响存档数据）`,
    );
  }

  return lines;
}
