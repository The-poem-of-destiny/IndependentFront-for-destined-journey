/**
 * Lorebook Matching Engine
 *
 * @deprecated Phase 8: 用 worldbook-loader.ts 替代。
 * 关键词匹配逻辑已迁移到 worldbook-loader.matchKeyword()。
 * 本模块仅保留供 v3 prompt-assembler.ts 兼容使用，后续版本移除。
 */

import type { Lorebook, LorebookEntry, MatchedEntry } from './types';

export class LorebookEngine {
  private lorebook: Lorebook;

  constructor(lorebook: Lorebook) {
    this.lorebook = lorebook;
  }

  scan(text: string, additionalContext?: string): MatchedEntry[] {
    const normalizedText = this.lorebook.caseSensitive ? text : text.toLowerCase();
    const normalizedContext = additionalContext
      ? this.lorebook.caseSensitive
        ? additionalContext
        : additionalContext.toLowerCase()
      : normalizedText;

    const matched: MatchedEntry[] = [];

    for (const entry of this.lorebook.entries) {
      if (entry.constant) {
        matched.push({ entry, score: -9999, matchedKeywords: ['constant'] });
        continue;
      }

      if (Math.random() * 100 >= entry.probability) {
        continue;
      }

      const isMatch = this.checkEntryMatch(entry, normalizedText, normalizedContext);

      if (isMatch) {
        matched.push({
          entry,
          score: entry.order,
          matchedKeywords: entry.keys.filter((k) =>
            this.containsKeyword(normalizedText, this.normalizeKeyword(k)),
          ),
        });
      }
    }

    return matched.sort((a, b) => a.score - b.score);
  }

  recursiveScan(
    initialText: string,
    maxDepth: number = 3,
    additionalContext?: string,
  ): MatchedEntry[] {
    if (!this.lorebook.recursiveScanning || maxDepth <= 0) {
      return this.scan(initialText, additionalContext);
    }

    const allMatched = new Map<string, MatchedEntry>();
    let currentText = initialText;
    let depth = 0;

    while (depth < maxDepth) {
      const newMatches = this.scan(currentText, additionalContext);
      let hasNewMatches = false;

      for (const match of newMatches) {
        if (!allMatched.has(match.entry.id)) {
          allMatched.set(match.entry.id, match);
          currentText += ' ' + match.entry.content;
          hasNewMatches = true;
        }
      }

      if (!hasNewMatches) break;
      depth++;
    }

    return Array.from(allMatched.values()).sort((a, b) => a.score - b.score);
  }

  groupByPosition(matched: MatchedEntry[]): Record<LorebookEntry['position'], MatchedEntry[]> {
    const grouped: Record<LorebookEntry['position'], MatchedEntry[]> = {
      before_char: [],
      after_char: [],
      before_example: [],
      after_example: [],
      at_depth: [],
      example_msg_top: [],
      example_msg_bottom: [],
      outlet: [],
    };

    for (const m of matched) {
      grouped[m.entry.position].push(m);
    }

    return grouped;
  }

  formatEntriesContent(entries: MatchedEntry[]): string {
    if (entries.length === 0) return '';
    return entries.map((e) => e.entry.content).join('\n\n');
  }

  private checkEntryMatch(entry: LorebookEntry, text: string, context: string): boolean {
    const { keys, secondaryKeys, selective, selectiveLogic } = entry;

    if (keys.length === 0) return false;

    const primaryMatches = keys.map((k) => this.containsKeyword(text, this.normalizeKeyword(k)));
    const allPrimary = primaryMatches.every((m) => m);
    const anyPrimary = primaryMatches.some((m) => m);

    let primaryOk = false;
    switch (selectiveLogic) {
      case 'and_all':
      case 'and_any':
        primaryOk = anyPrimary; // For simple frontend integration, both and_any/and_all treat primary as OR-ish trigger
        break;
      case 'not_all':
        primaryOk = !allPrimary;
        break;
      case 'not_any':
        primaryOk = !anyPrimary;
        break;
      default:
        primaryOk = anyPrimary;
    }

    if (!primaryOk) return false;

    if (!selective || secondaryKeys.length === 0) {
      return primaryOk;
    }

    const secondaryMatches = secondaryKeys.map((k) =>
      this.containsKeyword(context, this.normalizeKeyword(k)),
    );
    const allSecondary = secondaryMatches.every((m) => m);
    const anySecondary = secondaryMatches.some((m) => m);

    switch (selectiveLogic) {
      case 'and_all':
        return allSecondary;
      case 'not_all':
        return allSecondary;
      case 'and_any':
      case 'not_any':
      default:
        return anySecondary;
    }
  }

  private normalizeKeyword(keyword: string): string {
    return this.lorebook.caseSensitive ? keyword : keyword.toLowerCase();
  }

  private containsKeyword(text: string, keyword: string): boolean {
    if (this.lorebook.matchWholeWords) {
      const regex = new RegExp(`\\b${this.escapeRegex(keyword)}\\b`, 'i');
      return regex.test(text);
    }
    return text.includes(keyword);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export function createLorebookEngine(lorebook: Lorebook): LorebookEngine {
  return new LorebookEngine(lorebook);
}
