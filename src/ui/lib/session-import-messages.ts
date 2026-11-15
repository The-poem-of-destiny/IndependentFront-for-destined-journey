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

import type { SessionImportCheck, SessionPluginRef } from '@engine/persistence/session-backup';

/** 条目标题一行最多列几个，多出来的用「等 N 条」收尾 */
const MAX_TITLES_PER_BOOK = 5;

/** 解析不出书名的条目归到这一组 —— 导出方自己都缺的条目，收件人更可能缺，不能藏起来 */
const UNKNOWN_BOOK = '未知世界书';

/** 缺失插件一行最多列几个 */
const MAX_PLUGINS_LISTED = 5;

/** 插件显示名：有名字用名字（带版本），没有就退回 id —— 给个能搜的标识 */
function pluginLabel(ref: SessionPluginRef): string {
  const name = ref.name || ref.id;
  return ref.version ? `${name} v${ref.version}` : name;
}

/**
 * 「导入的存档要在本机重新确认插件」这句提示。存档没勾选插件时返回 null。
 *
 * 体检通过（不弹告警窗）时调用方也该在导入后把它亮给玩家：同意从不随存档走，
 * 存档里勾着的插件导进来一律处于「待确认」状态。
 */
export function buildSessionImportPluginNote(check: SessionImportCheck): string | null {
  const count = check.enabledPlugins?.length ?? 0;
  if (count === 0) return null;
  return `这份存档启用了 ${count} 个插件；插件授权不随存档迁移，导入后需在本机逐个重新确认才会启用`;
}

/**
 * 体检结果 → 告警行（顺序：世界书条目 → 内容包 → 正文预设 → 插件）。
 *
 * 体检通过（`ok === true`，各项皆空）时返回空数组 —— 调用方据此决定连弹窗都不必开。
 * 有告警且存档勾选了插件时，末尾附上重新确认的提示（`buildSessionImportPluginNote`）。
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

  // ── 插件：缺了只告警，存档里的插件数据原样保留，装上后可续用 ──
  const missingPlugins = check.missingPlugins ?? [];
  if (missingPlugins.length > 0) {
    const shown = missingPlugins.slice(0, MAX_PLUGINS_LISTED).map(pluginLabel).join('、');
    const tail =
      missingPlugins.length > MAX_PLUGINS_LISTED ? ` 等 ${missingPlugins.length} 个` : '';
    lines.push(
      `本机未安装存档启用的 ${missingPlugins.length} 个插件：${shown}${tail}（插件数据会原样保留，安装后可继续使用）`,
    );
  }

  if (lines.length > 0) {
    const note = buildSessionImportPluginNote(check);
    if (note) lines.push(note);
  }

  return lines;
}
