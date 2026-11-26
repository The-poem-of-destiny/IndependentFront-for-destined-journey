/**
 * 直出区块定位与计数（审查 A1，2026-11-25）：思考块或前置文字里提到标签名不再整楼拒收，
 * 计数只认「闭标签向前配最近开标签」的完整块，真截断与多块仍拒收。
 */
import { describe, expect, it } from 'vitest';
import { locateDirectBlocks } from '../../../src/core/agents/direct-blocks';
import { parseDirectOutput } from '../../../src/core/agents/direct-output';
import type { DirectDicePool } from '../../../src/core/agents/direct-dice';

const POOL: DirectDicePool = [{ sides: 20, values: [7] }];
const UPDATES = {
  version: 1,
  world: {},
  time: { delta_time: 5 },
  entities: [],
  state: {},
  effects: [],
  plot: {},
  combat: null,
  diceUsed: [],
};
const BODY = '<maintext>铁匠抬头看了你一眼。</maintext><options>1. 等待\n2. 离开</options>';
const TAIL = `<character_updates>{"characters":[]}</character_updates><direct_updates>${JSON.stringify(UPDATES)}</direct_updates>`;
const VALID = BODY + TAIL;

describe('locateDirectBlocks：只认完整块', () => {
  it('合法输出：一块正文、一块更新', () => {
    const layout = locateDirectBlocks(VALID);
    expect(layout.envelopeOk).toBe(true);
    expect(layout.updatesOpens).toBe(1);
    expect(JSON.parse(layout.updatesInner!)).toEqual(UPDATES);
  });

  it('think / thinking 块里的标签不参与计数', () => {
    const raw = `<think>先写 <maintext> 再写 <direct_updates>{"x":1}</think><thinking><maintext>草稿</maintext></thinking>${VALID}`;
    const layout = locateDirectBlocks(raw);
    expect(layout.envelopeOk).toBe(true);
    expect(layout.updatesOpens).toBe(1);
    expect(layout.text).not.toContain('草稿');
  });

  it('被后一个同名开标签越过的开标签算孤立提及', () => {
    const raw = `我要用 <maintext> 包正文，再用 <direct_updates> 写更新。\n${VALID}`;
    const layout = locateDirectBlocks(raw);
    expect(layout.envelopeOk).toBe(true);
    expect(JSON.parse(layout.updatesInner!)).toEqual(UPDATES);
    // 孤立开标签已从投影文本剔除
    expect(layout.text.match(/<maintext>/g)).toHaveLength(1);
  });

  it('最后一个闭标签之后的未配开标签算截断', () => {
    expect(locateDirectBlocks(`${VALID}<direct_updates>{`).updatesInner).toBeNull();
    expect(locateDirectBlocks(`${VALID}<maintext>续写`).envelopeOk).toBe(false);
  });

  it('两个完整块不算唯一', () => {
    expect(
      locateDirectBlocks(`${VALID}<direct_updates>{}</direct_updates>`).updatesInner,
    ).toBeNull();
    expect(locateDirectBlocks(`${BODY}${VALID}`).envelopeOk).toBe(false);
  });
});

describe('parseDirectOutput：标签提及不再整楼拒收（A1）', () => {
  it('<think> 内提到 <maintext>、<direct_updates>，后接合法输出 → 接纳', () => {
    const raw = `<think>按格式先写 <maintext> 正文，再写 <direct_updates> 更新块，别忘了 </direct_updates>。</think>\n${VALID}`;
    const draft = parseDirectOutput(raw, POOL);
    expect(draft.content).toBe('铁匠抬头看了你一眼。');
    expect(draft.options).toEqual(['等待', '离开']);
    expect(draft.updates.time).toEqual({ delta_time: 5 });
    expect(draft.updatesMissing).toBeUndefined();
    expect(draft.raw).toBe(raw);
  });

  it('无包裹的前置文字提到两个开标签，后接合法输出 → 接纳，正文与 JSON 取真实块', () => {
    const raw = `好的，我先用 <maintext> 写正文（这里不是正文），然后用 <direct_updates> 写更新（这里也不是）。\n${VALID}`;
    const draft = parseDirectOutput(raw, POOL);
    expect(draft.content).toBe('铁匠抬头看了你一眼。');
    expect(draft.updates.time).toEqual({ delta_time: 5 });
    expect(draft.normalized).toBeUndefined();
  });

  it('两个完整 direct_updates 块仍拒收', () => {
    expect(() =>
      parseDirectOutput(
        `${VALID}<direct_updates>${JSON.stringify(UPDATES)}</direct_updates>`,
        POOL,
      ),
    ).toThrow('需要一个完整的 direct_updates 区块');
  });

  it('两个完整 maintext 块仍拒收', () => {
    expect(() => parseDirectOutput(`<maintext>前文</maintext>${VALID}`, POOL)).toThrow(
      '需要一个完整的 maintext（或 gametxt）区块',
    );
  });

  it('真截断（有开无闭）仍拒收', () => {
    expect(() => parseDirectOutput(`${BODY}<direct_updates>{"version":1`, POOL)).toThrow(
      '需要一个完整的 direct_updates 区块',
    );
    expect(() => parseDirectOutput(`<maintext>铁匠抬头看了你一眼。${TAIL}`, POOL)).toThrow(
      '需要一个完整的 maintext（或 gametxt）区块',
    );
  });

  it('前置提及 + 真块截断仍拒收', () => {
    expect(() =>
      parseDirectOutput(`先写 <direct_updates> 更新。\n${BODY}<direct_updates>{"version":1`, POOL),
    ).toThrow('需要一个完整的 direct_updates 区块');
  });

  it('零个开标签仍按 updatesMissing 接纳', () => {
    const draft = parseDirectOutput(
      `${BODY}<character_updates>{"characters":[]}</character_updates>`,
      POOL,
    );
    expect(draft.updatesMissing).toBe(true);
  });

  it('正文内部再写一次 <maintext>：接纳但丢掉前半段（与前置提及结构上无法区分，已接受）', () => {
    const raw = `<maintext>他提起笔，在纸上写下 <maintext> 这个词，又把笔放下。</maintext><options>1. 等待\n2. 离开</options>${TAIL}`;
    const draft = parseDirectOutput(raw, POOL);
    // 闭标签配最近的那个开标签，真正的开标签被当成孤立提及剔除：正文只剩后半段
    expect(draft.content).toBe('这个词，又把笔放下。');
    expect(draft.content).not.toContain('他提起笔');
    expect(draft.updates.time).toEqual({ delta_time: 5 });
    expect(draft.raw).toBe(raw);
  });

  it('整份输出包在闭合的 <think> 内 → 拒收（思考块整块剔除后没有正文）', () => {
    expect(() => parseDirectOutput(`<think>${VALID}</think>`, POOL)).toThrow(
      '需要一个完整的 maintext（或 gametxt）区块',
    );
  });

  it('只在思考块里提到 direct_updates 等同零个开标签', () => {
    const draft = parseDirectOutput(
      `<think>这轮不用写 <direct_updates></direct_updates></think>${BODY}<character_updates>{"characters":[]}</character_updates>`,
      POOL,
    );
    expect(draft.updatesMissing).toBe(true);
    expect(draft.content).toBe('铁匠抬头看了你一眼。');
  });
});
