/**
 * protocol.test.ts —— 战斗协议正文装载（条目挑选 / 排序 / 注入壳）
 */
import { describe, it, expect, vi } from 'vitest';
import type { WorldBook, WorldBookEntry } from '../../../../src/core/types/types';
import {
  COMBAT_EXTRA_BOOK_ID,
  COMBAT_PROTOCOL_ENTRY_NAMES,
  assembleCombatProtocolText,
  loadCombatProtocolText,
} from '../../../../src/core/combat/sandbox/protocol';

function entry(overrides: Partial<WorldBookEntry> & { name: string }): WorldBookEntry {
  return {
    uid: 1,
    content: '',
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 0,
    position: 0,
    ...overrides,
  };
}

describe('assembleCombatProtocolText', () => {
  it('只挑协议相关条目，按 order 升序拼接', () => {
    const text = assembleCombatProtocolText([
      entry({ name: '战斗生产规则', content: '生产', order: 30 }),
      entry({ name: '无关条目', content: '忽略我', order: 0 }),
      entry({ name: '战斗协议', content: '协议', order: 20 }),
      entry({ name: '战前资源推演', content: '推演', order: 10 }),
    ]);
    expect(text).toBe('推演\n\n协议\n\n生产');
  });

  it('条目名包含协议名即命中（"战斗协议概览" 也命中）', () => {
    const text = assembleCombatProtocolText([
      entry({ name: '战斗协议概览', content: '概览' }),
      entry({ name: '核心数值表', content: '数值' }),
    ]);
    expect(text).toBe('概览\n\n数值');
  });

  it('不看 enabled —— Code 点名取文，关闭的条目也能取到', () => {
    const text = assembleCombatProtocolText([
      entry({ name: '战斗协议', content: '正文', enabled: false }),
    ]);
    expect(text).toBe('正文');
  });

  it('无命中 / 空正文 → 空串', () => {
    expect(assembleCombatProtocolText([entry({ name: '叙事约定', content: 'x' })])).toBe('');
    expect(assembleCombatProtocolText([entry({ name: '战斗协议', content: '   ' })])).toBe('');
    expect(assembleCombatProtocolText([])).toBe('');
  });

  it('导出常量覆盖六条协议条目名', () => {
    expect(COMBAT_PROTOCOL_ENTRY_NAMES).toContain('战斗协议');
    expect(COMBAT_PROTOCOL_ENTRY_NAMES).toContain('核心数值表');
  });
});

describe('loadCombatProtocolText', () => {
  it('用注入的 getWorldBook 取书并拼正文', async () => {
    const book: WorldBook = {
      id: COMBAT_EXTRA_BOOK_ID,
      name: '战斗额外世界书',
      partition: 'combat_extra',
      entries: [entry({ name: '战斗协议', content: '协议正文' })],
    };
    const getWorldBook = vi.fn(async () => book);
    const text = await loadCombatProtocolText({ getWorldBook });
    expect(text).toBe('协议正文');
    expect(getWorldBook).toHaveBeenCalledWith(COMBAT_EXTRA_BOOK_ID);
  });

  it('书不存在 → 空串', async () => {
    const text = await loadCombatProtocolText({ getWorldBook: async () => undefined });
    expect(text).toBe('');
  });
});
