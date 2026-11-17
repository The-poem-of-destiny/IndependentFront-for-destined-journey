/**
 * narrative-reveal.ts — 流式正文墨迹洇开的纯状态机
 *
 * 守的是：各片首尾相接恒等于正文；只有新追加的尾巴变成动画片、已显示的字绝不重播；
 * 正文缩短时静默退回公共前缀；单次 12 片、存活 48 片的上限；到期并回纯文本。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_CHUNKS_PER_DELTA,
  MAX_LIVE_CHUNKS,
  REVEAL_MS,
  advanceReveal,
  claimReveal,
  createRevealMemory,
  emptyReveal,
  hasLiveChunks,
  nextExpiry,
  releaseReveal,
  settledReveal,
  splitRevealTokens,
  type RevealState,
} from '../../../src/ui/lib/narrative-reveal';

function joined(state: RevealState): string {
  return state.pieces.map((piece) => piece.text).join('');
}

function chunkTexts(state: RevealState): string[] {
  return state.pieces.flatMap((piece) => (piece.kind === 'chunk' ? [piece.text] : []));
}

function chunkIds(state: RevealState): number[] {
  return state.pieces.flatMap((piece) => (piece.kind === 'chunk' ? [piece.id] : []));
}

describe('advanceReveal', () => {
  it('从空开始：整段都是新写出的，切成动画片且拼回原文', () => {
    const state = advanceReveal(emptyReveal(), 'hello brave world', 0);
    expect(joined(state)).toBe('hello brave world');
    expect(chunkTexts(state)).toEqual(['hello ', 'brave ', 'world']);
  });

  it('文本增长时只有追加的尾巴成为新片，已显示的片 id 不变（不重播）', () => {
    const first = advanceReveal(emptyReveal(), 'hello ', 0);
    const second = advanceReveal(first, 'hello brave ', 50);
    const third = advanceReveal(second, 'hello brave world', 100);
    expect(joined(third)).toBe('hello brave world');
    // 旧片原样保留（同 id、同出生时间），只多出新片
    expect(chunkIds(third).slice(0, chunkIds(second).length)).toEqual(chunkIds(second));
    const newest = third.pieces[third.pieces.length - 1];
    expect(newest).toMatchObject({ kind: 'chunk', text: 'world', born: 100 });
  });

  it('文本不变时不产生新片', () => {
    const first = advanceReveal(emptyReveal(), '一段话', 0);
    const again = advanceReveal(first, '一段话', 10);
    expect(chunkIds(again)).toEqual(chunkIds(first));
    expect(again.nextId).toBe(first.nextId);
  });

  it('到期的片并回纯文本，落定后只剩一个 plain 片', () => {
    const state = advanceReveal(emptyReveal(), 'one two three', 0);
    expect(hasLiveChunks(state)).toBe(true);
    expect(nextExpiry(state)).toBe(REVEAL_MS);
    const settled = advanceReveal(state, state.text, REVEAL_MS);
    expect(hasLiveChunks(settled)).toBe(false);
    expect(settled.pieces).toEqual([{ kind: 'plain', text: 'one two three' }]);
    expect(nextExpiry(settled)).toBeNull();
  });

  it('正文缩短（标记 / 注释被剥掉）时退回公共前缀，不产生任何动画片', () => {
    const shown = advanceReveal(emptyReveal(), 'abc <!-- note', 0);
    const shrunk = advanceReveal(shown, 'abc ', 10);
    expect(joined(shrunk)).toBe('abc ');
    // 前缀之内存活的片保留（没到期），但不多出新片
    expect(shrunk.nextId).toBe(shown.nextId);
  });

  it('正文改写分叉时分叉之后的内容以纯文本出现，不动画', () => {
    const shown = advanceReveal(emptyReveal(), 'abc def', 0);
    const settled = advanceReveal(shown, shown.text, REVEAL_MS);
    const forked = advanceReveal(settled, 'abc xyz tail', REVEAL_MS + 10);
    expect(joined(forked)).toBe('abc xyz tail');
    expect(hasLiveChunks(forked)).toBe(false);
  });

  it('单次增量最多 12 片：更早的部分直接落定，只有尾部 12 片动画', () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const state = advanceReveal(emptyReveal(), words, 0);
    expect(joined(state)).toBe(words);
    expect(chunkTexts(state)).toHaveLength(MAX_CHUNKS_PER_DELTA);
    expect(state.pieces[0].kind).toBe('plain');
    expect(chunkTexts(state)[chunkTexts(state).length - 1]).toBe('w29');
  });

  it('同时存活最多 48 片：超出时最老的先落定', () => {
    let state = emptyReveal();
    let text = '';
    for (let i = 0; i < 10; i++) {
      text += Array.from({ length: 10 }, (_, j) => `x${i}_${j} `).join('');
      state = advanceReveal(state, text, i); // 都还没到期
    }
    expect(joined(state)).toBe(text);
    expect(chunkTexts(state).length).toBeLessThanOrEqual(MAX_LIVE_CHUNKS);
    // 最新的那批仍在动画
    expect(chunkTexts(state)[chunkTexts(state).length - 1]).toBe('x9_9 ');
  });
});

describe('splitRevealTokens', () => {
  it('无 Intl.Segmenter 时降级：中文逐字、标点与空白跟着前一个词', () => {
    expect(splitRevealTokens('她笑了，说：好。', null)).toEqual([
      '她',
      '笑',
      '了，',
      '说：',
      '好。',
    ]);
    expect(splitRevealTokens('Hello, world!', null)).toEqual(['Hello, ', 'world!']);
  });

  it('切片首尾相接恒等于原文', () => {
    const text = '「艾琳娜」推开门 —— the door creaked.\n下一行';
    expect(splitRevealTokens(text).join('')).toBe(text);
    expect(splitRevealTokens(text, null).join('')).toBe(text);
  });
});

describe('RevealMemory', () => {
  it('换 key 重挂的段落认领文本互为前缀的旧状态，已显示的字不再动画', () => {
    const memory = createRevealMemory();
    const first = claimReveal(memory, '0-0-0', '第一段');
    const shown = advanceReveal(first, '第一段', 0);
    releaseReveal(memory, '0-0-0', advanceReveal(shown, shown.text, REVEAL_MS));

    const adopted = claimReveal(memory, '1-0-0', '第一段继续');
    const next = advanceReveal(adopted, '第一段继续', REVEAL_MS + 1);
    expect(joined(next)).toBe('第一段继续');
    expect(chunkTexts(next).join('')).toBe('继续');
  });

  it('文本不相干时不认领，从空开始', () => {
    const memory = createRevealMemory();
    releaseReveal(memory, 'a', settledReveal('旧段落'));
    expect(claimReveal(memory, 'b', '全新的一段').text).toBe('');
  });

  it('仍被占用的状态不会被别的段落抢走', () => {
    const memory = createRevealMemory();
    claimReveal(memory, 'a', '同一段');
    memory.states.set('a', settledReveal('同一段'));
    expect(claimReveal(memory, 'b', '同一段').text).toBe('');
  });
});
