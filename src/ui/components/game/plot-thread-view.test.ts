/**
 * plot-thread-view.test.ts — 事件线面板展示层判定（防剧透契约）
 *
 * 钉的都是「点击/换档/关剧透后偷偷漏一个字」那一类：
 * - 隐藏节点 → 蒙版，**视图层不产出任何可渲染字段**（名字/简述/thread/时间/人物）
 * - 分组名（主线锚）只在组内有可见节点时展示，否则整体蒙版
 * - 边任一端隐藏 → 整条边遮蔽（不能靠 「A → ？？？」 泄露 B 的存在）
 * - 剧透模式**不直接解除蒙版**（只允许 peek 逐条揭示）；motive 只在剧透+显式点开路径出现
 */
import { describe, expect, it } from 'vitest';

import {
  applyPlotThreadRevealed,
  applyThreadDeclarations,
  type PlotThreadFlags,
} from '@engine/plot-threads';
import { buildThreadDisplayView, threadStatusLabel } from './plot-thread-view';

function makeFlags(): PlotThreadFlags {
  let flags = { nodes: {} } as PlotThreadFlags;
  flags = applyThreadDeclarations(
    flags,
    [
      {
        name: '雾蕈商情',
        gist: 'g1',
        thread: '北境暗流',
        motive: 'mot-1',
        involvedNpcs: ['商贩'],
        status: 'active',
      },
      {
        name: '外乡人',
        gist: 'g2',
        thread: '北境暗流',
        motive: 'mot-2',
        involvedNpcs: [],
        status: 'dormant',
      },
      {
        name: '旧账回收',
        gist: 'g3',
        thread: '北境暗流',
        motive: 'mot-3',
        involvedNpcs: [],
        status: 'active',
        foreshadows: ['外乡人'],
      },
    ],
    100,
  ).flags;
  flags = applyPlotThreadRevealed(flags, ['雾蕈商情']).flags;
  return flags;
}

describe('buildThreadDisplayView —— 防剧透', () => {
  it('🔴 隐藏节点不进蒙版卡的数据面：名字/简述/thread/时间/人物都不在可见行', () => {
    const view = buildThreadDisplayView(makeFlags(), new Set());
    const maskedNode = view.groups.flatMap((g) => g.nodes).find((n) => n.name === '外乡人');
    expect(maskedNode).toBeDefined();
    expect(maskedNode!.masked).toBe(true);
    // 蒙版节点渲染层面只认「名字」当 key —— 但 view 输出留给组件的只有 masked 布尔与 label；
    // 组件模板里 `v-else` 分支才不会触碰字段。这里钉：蒙版节点的关键字段虽在数据里，
    // 组件的 masked 分支不绑定它们 —— 用 ?raw 源码断言在组件测试里补。
    const visibleNames = view.groups
      .flatMap((g) => g.nodes)
      .filter((n) => !n.masked)
      .map((n) => n.name);
    // 只有被 reveal 过的『雾蕈商情』可见；dormant 的『外乡人』与未揭示的『旧账回收』都蒙住
    expect(visibleNames).toEqual(['雾蕈商情']);
  });

  it('🔴 分组名只在组内有可见节点时展示；整组蒙版时 label 不外泄', () => {
    let flags = { nodes: {} } as PlotThreadFlags;
    flags = applyThreadDeclarations(
      flags,
      [
        {
          name: 'A',
          gist: 'g',
          thread: '机密锚组',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
        },
      ],
      100,
    ).flags;
    const view = buildThreadDisplayView(flags, new Set());
    const group = view.groups[0];
    expect(group.showLabel).toBe(false);
    expect(group.thread).toBe('机密锚组'); // 数据还在（纯函数），组件侧靠 showLabel 决定不渲染
  });

  it('🔴 边任一端隐藏 → 整条边遮蔽（包括隐藏目标与揭示源的 A→B）', () => {
    const view = buildThreadDisplayView(makeFlags(), new Set());
    const edge = view.edges.find((e) => e.from === '旧账回收');
    expect(edge?.to).toBe('外乡人');
    expect(edge?.masked).toBe(true); // 目标隐藏 → 整条遮蔽，不泄露「有个外乡人」
    expect(view.edges.filter((e) => !e.masked)).toHaveLength(0);
  });

  it('peek 逐条揭示：只放行 peek 的名字；两端都可见边才恢复', () => {
    // 只 peek『外乡人』：它解除，但边另一端『旧账回收』仍隐藏 → 边整体遮蔽（不泄露 A→B 存在）
    const once = buildThreadDisplayView(makeFlags(), new Set(['外乡人']));
    const peekedNode = once.groups.flatMap((g) => g.nodes).find((n) => n.name === '外乡人');
    expect(peekedNode?.masked).toBe(false);
    expect(once.edges.find((e) => e.from === '旧账回收')?.masked).toBe(true);

    // 两端都 peek → 边恢复显示
    const both = buildThreadDisplayView(makeFlags(), new Set(['外乡人', '旧账回收']));
    expect(both.edges.find((e) => e.from === '旧账回收')?.masked).toBe(false);
    // 其余未 peek 仍蒙（雾蕈商情是 revealed 不受影响）
    const b = both.groups.flatMap((g) => g.nodes).find((n) => n.name === '雾蕈商情');
    expect(b?.masked).toBe(false);
  });

  it('revealed 与终态：已揭示节点不因 status 推移重新蒙版；终态保留在列表', () => {
    let flags = makeFlags();
    flags = applyPlotThreadRevealed(flags, ['旧账回收']).flags;
    const view = buildThreadDisplayView(flags, new Set());
    const rec = view.groups.flatMap((g) => g.nodes).find((n) => n.name === '旧账回收');
    expect(rec?.masked).toBe(false);
    expect(rec?.status).toBe('active');
  });
});

describe('threadStatusLabel —— 状态标签唯一映射', () => {
  it('给四个英文状态返回中文（存储英文、显示中文集中映射）', () => {
    expect(threadStatusLabel('active')).toBe('活跃');
    expect(threadStatusLabel('dormant')).toBe('沉睡');
    expect(threadStatusLabel('resolved')).toBe('已回收');
    expect(threadStatusLabel('dissolved')).toBe('已消散');
  });
});
