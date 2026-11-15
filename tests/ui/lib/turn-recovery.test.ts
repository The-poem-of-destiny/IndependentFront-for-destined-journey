/**
 * 从持久化消息推导回合恢复状态（审查 GAME-09 / GAME-10）
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@engine/types/types';
import {
  findUnfinishedTurn,
  groupDiscardedAttempts,
  isDiscardedAttempt,
} from '../../../src/ui/lib/turn-recovery';

const msg = (
  id: string,
  role: ChatMessage['role'],
  storyTurnStatus?: ChatMessage['storyTurnStatus'],
): ChatMessage => ({
  id,
  role,
  content: id,
  timestamp: 0,
  ...(storyTurnStatus ? { storyTurnStatus } : {}),
});

const idle = { isGenerating: false, hasLiveRecord: () => false };

describe('findUnfinishedTurn', () => {
  it('最新输入记着 failed → failed', () => {
    expect(
      findUnfinishedTurn([msg('u1', 'user', 'accepted'), msg('u2', 'user', 'failed')], idle),
    ).toEqual({ userMessageId: 'u2', reason: 'failed' });
  });

  it('最新输入记着 pending 且没有回合在跑 → interrupted', () => {
    expect(findUnfinishedTurn([msg('u1', 'user', 'pending')], idle)).toEqual({
      userMessageId: 'u1',
      reason: 'interrupted',
    });
  });

  it('accepted → 无', () => {
    expect(
      findUnfinishedTurn([msg('u1', 'user', 'accepted'), msg('a1', 'assistant', 'accepted')], idle),
    ).toBeNull();
  });

  it('旧存档无状态字段：输入后面没有正文 → no-reply；有正文 → 无', () => {
    expect(findUnfinishedTurn([msg('a0', 'assistant'), msg('u1', 'user')], idle)).toEqual({
      userMessageId: 'u1',
      reason: 'no-reply',
    });
    expect(findUnfinishedTurn([msg('u1', 'user'), msg('a1', 'assistant')], idle)).toBeNull();
    // 只有系统卡片与已废弃的尝试，不算有正文
    expect(
      findUnfinishedTurn(
        [msg('u1', 'user'), msg('s1', 'system'), msg('a1', 'assistant', 'failed')],
        idle,
      ),
    ).toEqual({ userMessageId: 'u1', reason: 'no-reply' });
  });

  it('生成中、或内存里还有这条输入的回合记录 → 无（交给回合卡片）', () => {
    const list = [msg('u1', 'user', 'failed')];
    expect(findUnfinishedTurn(list, { ...idle, isGenerating: true })).toBeNull();
    expect(findUnfinishedTurn(list, { ...idle, hasLiveRecord: (id) => id === 'u1' })).toBeNull();
  });

  it('没有玩家输入 → 无', () => {
    expect(findUnfinishedTurn([msg('a0', 'assistant')], idle)).toBeNull();
    expect(findUnfinishedTurn([], idle)).toBeNull();
  });
});

describe('groupDiscardedAttempts', () => {
  it('连续的失败正文（中间可隔系统卡片）合成一组，组首为键', () => {
    const list = [
      msg('u1', 'user', 'pending'),
      msg('a1', 'assistant', 'failed'),
      msg('s1', 'system'),
      msg('a2', 'assistant', 'failed'),
      msg('a3', 'assistant', 'accepted'),
      msg('u2', 'user'),
      msg('a4', 'assistant', 'failed'),
    ];
    const { groups, memberIds } = groupDiscardedAttempts(list);
    expect([...groups.keys()]).toEqual(['a1', 'a4']);
    expect(groups.get('a1')!.map((m) => m.id)).toEqual(['a1', 'a2']);
    expect([...memberIds]).toEqual(['a1', 'a2', 'a4']);
  });

  it('只有 assistant 的 failed 算废弃尝试', () => {
    expect(isDiscardedAttempt(msg('u', 'user', 'failed'))).toBe(false);
    expect(isDiscardedAttempt(msg('a', 'assistant', 'pending'))).toBe(false);
    expect(isDiscardedAttempt(msg('a', 'assistant', 'failed'))).toBe(true);
  });
});
