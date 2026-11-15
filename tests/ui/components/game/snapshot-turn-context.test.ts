/**
 * snapshot-turn-context.test.ts — 快照 → 那一回合消息的映射（SNP-01）
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@engine/types/types';
import {
  SNAPSHOT_INPUT_EXCERPT_MAX,
  findSnapshotTurnContext,
  firstSentenceOf,
  truncateText,
} from '../../../../src/ui/components/game/snapshot-turn-context';

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage {
  return { content: '', timestamp: 0, ...over };
}

const snap = { turn: 2, createdAt: 1000 };

describe('findSnapshotTurnContext', () => {
  it('按 turn 找玩家输入，并取其后同回合正文的首句', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '第一回合输入', turn: 1, timestamp: 100 }),
      msg({ id: 'a1', role: 'assistant', content: '第一回合正文。', turn: 1, timestamp: 200 }),
      msg({ id: 'u2', role: 'user', content: '  攻击守卫  ', turn: 2, timestamp: 300 }),
      msg({ id: 's2', role: 'system', content: '系统卡片', turn: 2, timestamp: 350 }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '守卫倒下了！你听见脚步声。',
        turn: 2,
        timestamp: 400,
      }),
    ];
    expect(findSnapshotTurnContext(snap, messages)).toEqual({
      input: '攻击守卫',
      inputExcerpt: '攻击守卫',
      narrativeLead: '守卫倒下了！',
    });
  });

  it('比快照晚的同号消息不算（恢复后重新打出的回合不能安到旧快照上）', () => {
    const messages = [
      msg({ id: 'u2', role: 'user', content: '新的输入', turn: 2, timestamp: 2000 }),
    ];
    expect(findSnapshotTurnContext(snap, messages)).toBeNull();
  });

  it('消息已不在（被裁剪 / 不在当前分支）时返回 null', () => {
    expect(findSnapshotTurnContext(snap, [])).toBeNull();
  });

  it('跳过失败 / 诊断消息；没有正文时首句为空串', () => {
    const messages = [
      msg({ id: 'u2', role: 'user', content: '输入', turn: 2, timestamp: 300 }),
      msg({
        id: 'a2x',
        role: 'assistant',
        content: '失败的尝试。',
        turn: 2,
        timestamp: 400,
        storyTurnStatus: 'failed',
      }),
      msg({
        id: 'd2',
        role: 'assistant',
        content: '诊断。',
        turn: 2,
        timestamp: 450,
        diagnostic: true,
      }),
    ];
    expect(findSnapshotTurnContext(snap, messages)?.narrativeLead).toBe('');
  });

  it('长输入截断成摘录，全文保留', () => {
    const long = '字'.repeat(SNAPSHOT_INPUT_EXCERPT_MAX + 5);
    const ctx = findSnapshotTurnContext(snap, [
      msg({ id: 'u2', role: 'user', content: long, turn: 2, timestamp: 300 }),
    ]);
    expect(ctx?.input).toBe(long);
    expect(ctx?.inputExcerpt).toBe(`${'字'.repeat(SNAPSHOT_INPUT_EXCERPT_MAX)}…`);
  });
});

describe('firstSentenceOf / truncateText', () => {
  it('去掉标签与多余空白，取到第一个句末标点', () => {
    expect(firstSentenceOf('<maintext>\n  夜色  深沉。\n远处有灯。</maintext>')).toBe(
      '夜色 深沉。',
    );
  });

  it('句末带引号时一并保留', () => {
    expect(firstSentenceOf('「快走！」他喊道。')).toBe('「快走！」');
  });

  it('没有句末标点时整段（截断）返回', () => {
    expect(firstSentenceOf('没有标点的一段话')).toBe('没有标点的一段话');
    expect(truncateText('abcdef', 3)).toBe('abc…');
  });
});
