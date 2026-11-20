/**
 * stage-playback.ts — 逐节演出的纯状态机
 *
 * 守的是：首节完整即自动放出；流式中只放完整的节；段落临时切不切开 action_info；
 * 从临时切换到模型断点时已放出的文字不回退；waiting / finished / canAdvance 三态互斥；
 * skipAll 之后后续完整节自动放出。
 */
import { describe, expect, it } from 'vitest';
import {
  createStagePlayback,
  deriveStagePlayback,
  paragraphBreaks,
  splitStageSections,
  stepStagePlayback,
  type StagePlaybackInput,
  type StagePlaybackState,
} from '../../../src/ui/lib/stage-playback';

function input(content: string, extra: Partial<StagePlaybackInput> = {}): StagePlaybackInput {
  return { content, breaks: [], enters: [], closed: false, ...extra };
}

function visible(state: StagePlaybackState): string {
  return state.input.content.slice(0, state.cursor);
}

const A = '第一段，雨落在石阶上。';
const B = '第二段，门被推开。';
const C = '第三段，她抬起头。';

describe('splitStageSections', () => {
  it('无断点时按段落临时切，最后一节流式中不完整', () => {
    const sections = splitStageSections(input(`${A}\n\n${B}\n\n${C}`));
    expect(sections.map((s) => s.text)).toEqual([A, B, C]);
    expect(sections.map((s) => s.complete)).toEqual([true, true, false]);
  });

  it('closed 后最后一节也完整', () => {
    const sections = splitStageSections(input(`${A}\n\n${B}`, { closed: true }));
    expect(sections.every((s) => s.complete)).toBe(true);
  });

  it('分隔符后还没有正文时不算下一段开始', () => {
    expect(paragraphBreaks(`${A}\n\n`)).toEqual([]);
    expect(splitStageSections(input(`${A}\n\n`)).map((s) => s.complete)).toEqual([false]);
  });

  it('不切开 action_info 块（含未闭合的）', () => {
    const closedBlock = `${A}\n\n<action_info>\n|行动者|甲|\n\n|行动|斩|\n</action_info>\n\n${B}`;
    expect(splitStageSections(input(closedBlock)).map((s) => s.text)).toEqual([
      A,
      '<action_info>\n|行动者|甲|\n\n|行动|斩|\n</action_info>',
      B,
    ]);
    const openBlock = `${A}\n\n<item_info>\n|名|剑|\n\n|品|稀有|`;
    expect(splitStageSections(input(openBlock))).toHaveLength(2);
  });

  it('有断点时按断点切，越界与重复的断点被丢弃', () => {
    const content = `${A}\n\n${B}\n\n${C}`;
    const at = content.indexOf(C);
    const sections = splitStageSections(input(content, { breaks: [at, at, 0, 9999] }));
    expect(sections.map((s) => s.text)).toEqual([`${A}\n\n${B}`, C]);
  });

  it('空正文没有节', () => {
    expect(splitStageSections(input('  \n'))).toEqual([]);
  });
});

describe('状态机', () => {
  it('首节不完整时不放出，完整后自动放出', () => {
    let state = createStagePlayback(input(A));
    expect(state.cursor).toBe(0);
    expect(deriveStagePlayback(state)).toMatchObject({ revealedCount: 0, waiting: true });

    state = stepStagePlayback(state, { type: 'sync', input: input(`${A}\n\n${B}`) });
    expect(visible(state)).toBe(`${A}\n\n`);
    expect(deriveStagePlayback(state)).toMatchObject({
      revealedCount: 1,
      waiting: true,
      canAdvance: false,
      finished: false,
    });
  });

  it('推进只放出完整的下一节，追上后等待，closed 后放完即结束', () => {
    const content = `${A}\n\n${B}\n\n${C}`;
    let state = createStagePlayback(input(content));
    expect(deriveStagePlayback(state)).toMatchObject({ revealedCount: 1, canAdvance: true });

    state = stepStagePlayback(state, { type: 'advance' });
    expect(deriveStagePlayback(state)).toMatchObject({ revealedCount: 2, waiting: true });

    // 末节不完整：推进无效
    const stuck = stepStagePlayback(state, { type: 'advance' });
    expect(stuck).toBe(state);

    state = stepStagePlayback(state, { type: 'sync', input: input(content, { closed: true }) });
    expect(deriveStagePlayback(state)).toMatchObject({ canAdvance: true, waiting: false });

    state = stepStagePlayback(state, { type: 'advance' });
    expect(deriveStagePlayback(state)).toMatchObject({
      revealedCount: 3,
      finished: true,
      waiting: false,
      canAdvance: false,
    });
    expect(visible(state)).toBe(content);
  });

  it('从段落临时切换到模型断点：游标所在的完整节并到节尾，已放出的文字不回退', () => {
    // 流式早期：没见到断点，按段落放出了 A
    let state = createStagePlayback(input(`${A}\n\n${B}`));
    expect(visible(state)).toBe(`${A}\n\n`);

    // 模型断点出现：第一节 = A+B，第二节从 C 开始
    const content = `${A}\n\n${B}\n\n${C}`;
    state = stepStagePlayback(state, {
      type: 'sync',
      input: input(content, { breaks: [content.indexOf(C)] }),
    });
    expect(visible(state)).toBe(`${A}\n\n${B}\n\n`);
    expect(deriveStagePlayback(state)).toMatchObject({ revealedCount: 1, waiting: true });
  });

  it('游标落在尚不完整的节内部时保持原位、算作部分放出并等待', () => {
    const content = `${A}\n\n${B}`;
    // 段落临时切已放出 A
    let state = createStagePlayback(input(content));
    expect(visible(state)).toBe(`${A}\n\n`);

    // 模型断点出现但都在正文之外（下一节还没写出来）：整段为一节且未完整
    state = stepStagePlayback(state, {
      type: 'sync',
      input: input(content, { breaks: [content.length + 5] }),
    });
    expect(visible(state)).toBe(`${A}\n\n`);
    expect(deriveStagePlayback(state)).toMatchObject({
      revealedCount: 1,
      waiting: true,
      canAdvance: false,
    });
    expect(stepStagePlayback(state, { type: 'advance' })).toBe(state);

    // 流结束：该节完整，放出剩余部分
    state = stepStagePlayback(state, {
      type: 'sync',
      input: input(content, { breaks: [content.length + 5], closed: true }),
    });
    expect(visible(state)).toBe(content);
    expect(deriveStagePlayback(state)).toMatchObject({ finished: true, revealedCount: 1 });
  });

  it('skipAll 放出全部完整节，之后同步进来的完整节也直接放出', () => {
    const content = `${A}\n\n${B}\n\n${C}`;
    let state = createStagePlayback(input(content));
    state = stepStagePlayback(state, { type: 'skipAll' });
    expect(visible(state)).toBe(`${A}\n\n${B}\n\n`);
    expect(deriveStagePlayback(state).waiting).toBe(true);

    state = stepStagePlayback(state, { type: 'sync', input: input(content, { closed: true }) });
    expect(deriveStagePlayback(state)).toMatchObject({ finished: true, revealedCount: 3 });
  });

  it('正文缩短时游标收进新长度', () => {
    let state = createStagePlayback(input(`${A}\n\n${B}\n\n${C}`, { closed: true }));
    state = stepStagePlayback(state, { type: 'skipAll' });
    state = stepStagePlayback(state, { type: 'sync', input: input(A, { closed: true }) });
    expect(state.cursor).toBe(A.length);
    expect(deriveStagePlayback(state).finished).toBe(true);
  });

  it('空正文：流式中等待，closed 即结束', () => {
    expect(deriveStagePlayback(createStagePlayback(input(''))).waiting).toBe(true);
    expect(deriveStagePlayback(createStagePlayback(input('', { closed: true })))).toMatchObject({
      finished: true,
      waiting: false,
      revealedCount: 0,
    });
  });
});
