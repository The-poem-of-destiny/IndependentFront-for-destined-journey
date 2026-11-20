/**
 * stage-entrance.ts — 新角色登场演出的纯判定
 *
 * 守的是：开楼名册（含别名）里的人不演；enter 标记按偏移落节；
 * 接纳后新建却没标记的按名字首现节补锚；同一人只演一次。
 */
import { describe, expect, it } from 'vitest';
import { resolveEntrances } from '../../../src/ui/lib/stage-entrance';
import { splitStageSections } from '../../../src/ui/lib/stage-playback';

const S0 = '雨夜，酒馆里只剩炉火。';
const S1 = '门被推开，一个披着斗篷的女人走了进来。她自称莉娅。';
const S2 = '老板托马斯擦着杯子，冲阿尔文点了点头。';
const CONTENT = `${S0}\n\n${S1}\n\n${S2}`;
const AT1 = CONTENT.indexOf(S1);
const AT2 = CONTENT.indexOf(S2);
const SECTIONS = splitStageSections({
  content: CONTENT,
  breaks: [AT1, AT2],
  enters: [],
  closed: true,
});

describe('resolveEntrances', () => {
  it('enter 标记按偏移落到所在节', () => {
    expect(resolveEntrances([{ name: '莉娅', at: AT1 }], [], [], SECTIONS)).toEqual([
      { name: '莉娅', sectionIndex: 1 },
    ]);
  });

  it('名字或别名在开楼名册里的不演', () => {
    const roster = [{ name: '阿尔文·铁砧', aliases: ['阿尔文'] }];
    expect(
      resolveEntrances(
        [
          { name: '阿尔文', at: AT2 },
          { name: ' 阿尔文·铁砧 ', at: AT2 },
        ],
        roster,
        [],
        SECTIONS,
      ),
    ).toEqual([]);
  });

  it('接纳后新建、没有标记的角色按名字首现节补锚；正文里找不到就不演', () => {
    const created = [{ name: '托马斯' }, { name: '莉娅' }, { name: '不在正文里' }];
    expect(resolveEntrances([], [], created, SECTIONS)).toEqual([
      { name: '莉娅', sectionIndex: 1 },
      { name: '托马斯', sectionIndex: 2 },
    ]);
  });

  it('别名命中也能补锚，且标记写别名时与新建角色合并为一次登场', () => {
    const created = [{ name: '莉娅·晨星', aliases: ['莉娅'] }];
    expect(resolveEntrances([], [], created, SECTIONS)).toEqual([
      { name: '莉娅·晨星', sectionIndex: 1 },
    ]);
    expect(resolveEntrances([{ name: '莉娅', at: AT1 }], [], created, SECTIONS)).toEqual([
      { name: '莉娅·晨星', sectionIndex: 1 },
    ]);
  });

  it('同一人重复标记只演一次，取最早的节', () => {
    expect(
      resolveEntrances(
        [
          { name: '托马斯', at: AT2 },
          { name: '托马斯', at: AT1 },
        ],
        [],
        [],
        SECTIONS,
      ),
    ).toEqual([{ name: '托马斯', sectionIndex: 1 }]);
  });

  it('结果按节序排列；偏移在正文末尾归最后一节；空名与无节输入返回空', () => {
    expect(
      resolveEntrances(
        [
          { name: '乙', at: CONTENT.length },
          { name: '甲', at: 0 },
          { name: '  ', at: 0 },
        ],
        [],
        [],
        SECTIONS,
      ),
    ).toEqual([
      { name: '甲', sectionIndex: 0 },
      { name: '乙', sectionIndex: 2 },
    ]);
    expect(resolveEntrances([{ name: '甲', at: 0 }], [], [], [])).toEqual([]);
  });

  it('新建角色同时在开楼名册里（别名撞名）时不演', () => {
    expect(resolveEntrances([], [{ name: '托马斯' }], [{ name: '托马斯' }], SECTIONS)).toEqual([]);
  });

  it('不拿新建名单过滤：标了 enter、不在开楼名册的名字都演（含没建档的临时人物）', () => {
    const enters = [
      { name: '莉娅', at: AT1 },
      { name: '路人', at: AT1 },
    ];
    expect(resolveEntrances(enters, [], [{ name: '莉娅' }], SECTIONS).map((e) => e.name)).toEqual([
      '莉娅',
      '路人',
    ]);
  });
});
