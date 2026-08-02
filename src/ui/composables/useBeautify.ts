/**
 * useBeautify — 文本美化 composable（从 ChatFlow.vue 抽出，CombatMessageFlow 复用）
 *
 * 职责: 合并预设规则 + 用户规则 → processRules 美化 → 段落包裹 <p>。
 * autoEnable 解析以当前存档为准（命定核心/启用角色的世界书条目 uid），
 * 与 BeautifierSection 同口径：美化绑定**启用的世界书条目**，不按角色名。
 *
 * 对齐 docs/design.md §2.5（首行缩进）/ §1（叙事衬线）。
 */
import {
  processRules,
  escapeHtml,
  collectActiveSignalsFromEntries,
  resolveAutoEnable,
} from '@engine/beautifier';
import type { BeautifierRule, ChatMessage } from '@engine/types';
import { useSettingsStore } from '../stores/settings-store';
import { useGameStore } from '../stores/game-store';
import { useBeautifierStore } from '../stores/beautifier-store';

export function useBeautify() {
  const settings = useSettingsStore();
  const s = settings.settings;
  const game = useGameStore();
  // Phase 0b: 规则从 beautifier-store 取 —— 用户规则在 Dexie，预设规则是纯内存派生缓存。
  // `beautifierEnabled` 仍是 settings 里的开关，不动。
  const beautifier = useBeautifierStore();

  /**
   * 合并预设规则 + 用户规则，返回完整美化规则列表。
   *
   * autoEnable 以当前存档为准：命定核心选择走独立 uid（不改世界书条目 enabled），
   * 存于 save.metadata.enabledWorldBookEntries。规则按**启用的世界书条目 uid**
   * 匹配激活（与 BeautifierSection 同源信号）。
   */
  function getBeautifierRules(): BeautifierRule[] {
    const preset = beautifier.presetRules;
    const user = beautifier.userRules;
    const presetIds = new Set(preset.map((r) => r.id));

    const enabledEntries: string[] =
      (game.activeSave?.metadata as any)?.enabledWorldBookEntries ?? [];
    const { activeWorldBookIds, activeEntryUids } = collectActiveSignalsFromEntries(enabledEntries);

    // 美化绑定启用的世界书（worldBookIds / worldBookEntryUids 二维），
    // 不按角色名 —— 角色是否在场不影响规则激活。
    const resolved = resolveAutoEnable(preset, activeWorldBookIds, activeEntryUids, new Set());

    return [...resolved, ...user.filter((r) => !presetIds.has(r.id))];
  }

  /** 将双换行分隔的纯文本块包裹成 <p>，保留已有 HTML 标签不变（避免 block-in-inline 非法嵌套） */
  function wrapParagraphs(html: string): string {
    const tags: string[] = [];
    const placeholder = html.replace(/<[^>]+>/g, (match) => {
      tags.push(match);
      return `\x00TAG${tags.length - 1}\x00`;
    });
    const parts = placeholder.split(/\n\n+/);
    const wrapped = parts
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return '';
        if (/^\x00TAG(\d+)\x00$/.test(trimmed)) return trimmed;
        return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
    return wrapped.replace(/\x00TAG(\d+)\x00/g, (_, i) => tags[Number(i)]);
  }

  /** 美化 ChatMessage（未启用美化时走纯文本 + <br>） */
  function beautifyText(msg: ChatMessage): string {
    const raw = msg.content;
    if (!s.beautifierEnabled) {
      return escapeHtml(raw).replace(/\n/g, '<br>');
    }
    const rules = getBeautifierRules();
    return wrapParagraphs(processRules(raw, 'maintext', rules));
  }

  /** 流式文本实时美化（跳过 wrapParagraphs 避免边界闪烁） */
  function beautifyStreamingText(raw: string): string {
    if (!raw) return '';
    if (!s.beautifierEnabled) {
      return escapeHtml(raw).replace(/\n/g, '<br>');
    }
    const rules = getBeautifierRules();
    return processRules(raw, 'maintext', rules).replace(/\n/g, '<br>');
  }

  /** 美化裸文本（战斗叙事等，非 ChatMessage）— 与 beautifyText 同逻辑但不依赖 msg 对象 */
  function beautifyPlain(raw: string): string {
    if (!raw) return '';
    if (!s.beautifierEnabled) {
      return escapeHtml(raw).replace(/\n/g, '<br>');
    }
    const rules = getBeautifierRules();
    return wrapParagraphs(processRules(raw, 'maintext', rules));
  }

  return { beautifyText, beautifyStreamingText, beautifyPlain, getBeautifierRules, wrapParagraphs };
}
