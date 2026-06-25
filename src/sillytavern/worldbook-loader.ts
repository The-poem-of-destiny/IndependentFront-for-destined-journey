/**
 * 世界书加载引擎 (Phase 8)
 *
 * 职责:
 * - 从 data/worldbooks/ 加载世界书 JSON 文件
 * - 按 AgentConfig.worldBookIds 过滤 Agent 可见的世界书
 * - constant/keyword 双层激活
 * - 按 order 排序 + 格式化输出
 */

import type { WorldBook, WorldBookEntry, AgentConfig } from './types';

// ========== 加载 ==========

/** 所有可用的世界书文件路径 */
const WORLD_BOOK_FILES: Record<string, string> = {
  world_setting: 'world_setting.json',
  race: 'race.json',
  faction: 'faction.json',
  character: 'character.json',
  event: 'event.json',
  adventure_area: 'adventure_area.json',
  monster_ecology: 'monster_ecology.json',
  industry: 'industry.json',
  organization: 'organization.json',
  system_core: 'system_core.json',
  variable: 'variable.json',
  quick_feature: 'quick_feature.json',
  extra_setting: 'extra_setting.json',
  cot: 'cot.json',
  dlc: 'dlc.json',
};

/**
 * 从 data/worldbooks/ 加载指定 ID 的世界书
 * 使用动态 import 兼容 Vite 打包
 */
export async function loadWorldBooks(ids: string[]): Promise<WorldBook[]> {
  const books: WorldBook[] = [];
  for (const id of ids) {
    const filename = WORLD_BOOK_FILES[id];
    if (!filename) continue;
    try {
      // Vite 环境下用 fetch 从 public 或 data 目录加载
      // 注：data/worldbooks/ 在构建时需要配置为静态资源
      const url = `/data/worldbooks/${filename}`;
      const response = await fetch(url);
      if (!response.ok) continue;
      const book = await response.json() as WorldBook;
      books.push(book);
    } catch {
      // 文件不存在或加载失败，跳过
    }
  }
  return books;
}

/** 同步版：从预加载的对象加载（Vite import.meta.glob） */
export function loadWorldBooksSync(
  ids: string[],
  preloaded: Record<string, WorldBook>,
): WorldBook[] {
  return ids
    .filter(id => preloaded[id])
    .map(id => preloaded[id]);
}

// ========== 过滤 ==========

/**
 * 获取指定 Agent 可见的世界书条目
 * @param agentId Agent ID
 * @param configs 所有 Agent 配置
 * @param books 已加载的世界书列表
 */
export function getEntriesForAgent(
  agentId: string,
  configs: AgentConfig[],
  books: WorldBook[],
): WorldBookEntry[] {
  const config = configs.find(c => c.agentId === agentId);
  if (!config || !config.worldBookIds?.length) return [];

  const allowedIds = new Set(config.worldBookIds);
  const entries: WorldBookEntry[] = [];

  for (const book of books) {
    if (!allowedIds.has(book.id)) continue;
    for (const entry of book.entries) {
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * 过滤应激活的条目
 * enabled + (constant || keyword 命中)
 */
export function filterActiveEntries(
  entries: WorldBookEntry[],
  text: string,
): WorldBookEntry[] {
  return entries.filter(entry => {
    if (!entry.enabled) return false;
    if (entry.constant) return true;
    if (entry.key.length > 0) {
      return matchKeyword(entry, text);
    }
    return false;
  });
}

// ========== 关键词匹配 ==========

/**
 * 检查条目的关键词是否匹配文本
 * 支持 ST 格式: 普通字符串 + 正则 (/pattern/flags)
 */
export function matchKeyword(
  entry: { key: string[]; keysecondary: string[]; selectiveLogic: number },
  text: string,
): boolean {
  const { key, keysecondary, selectiveLogic } = entry;

  if (key.length === 0) return false;

  const primaryMatches = key.map(k => matchSingleKeyword(text, k));
  const anyPrimary = primaryMatches.some(Boolean);

  // 如果没有辅助关键词，主关键词任意命中即激活
  if (keysecondary.length === 0) return anyPrimary;

  const secondaryMatches = keysecondary.map(k => matchSingleKeyword(text, k));
  const allSecondary = secondaryMatches.every(Boolean);
  const anySecondary = secondaryMatches.some(Boolean);

  switch (selectiveLogic) {
    case 0: // AND_ANY: primary AND any secondary
      return anyPrimary && anySecondary;
    case 1: // NOT_ALL: primary AND NOT all secondary
      return anyPrimary && !allSecondary;
    case 2: // NOT_ANY: primary AND NOT any secondary
      return anyPrimary && !anySecondary;
    case 3: // AND_ALL: primary AND all secondary
      return anyPrimary && allSecondary;
    default:
      return anyPrimary;
  }
}

/**
 * 单关键词匹配
 * 支持正则格式: /pattern/flags
 */
function matchSingleKeyword(text: string, keyword: string): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) return false;

  // 正则格式: /pattern/flags
  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    try {
      const lastSlash = trimmed.lastIndexOf('/');
      const pattern = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      return new RegExp(pattern, flags).test(text);
    } catch {
      return false;
    }
  }

  // 普通字符串匹配（大小写不敏感）
  return text.toLowerCase().includes(trimmed.toLowerCase());
}

// ========== 格式化 ==========

/**
 * 按 order 排序 → 拼接 content
 */
export function formatWorldBookEntries(entries: WorldBookEntry[]): string {
  if (entries.length === 0) return '';

  const sorted = [...entries].sort((a, b) => a.order - b.order);

  return sorted
    .map(entry => entry.content)
    .join('\n\n');
}
