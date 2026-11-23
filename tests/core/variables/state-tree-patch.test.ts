/**
 * state-tree-patch.ts — 状态树补丁的区块解析与路径解析（状态树协议 §4、§5.1、§5.4）
 */
import { describe, expect, it } from 'vitest';
import {
  createDefaultCharacterState,
  type CharacterState,
  type InventoryItem,
  type Skill,
} from '../../../src/core/types/types';
import { listStateTreePaths } from '../../../src/core/variables/state-tree-spec';
import {
  normalizeTreePath,
  parseTreePatchBlock,
  resolveTreePath,
  type TreePatchParseResult,
  type TreePathResolution,
  type TreePathSnapshot,
  type TreePatchParsed,
} from '../../../src/core/variables/state-tree-patch';

function item(name: string, equippedSlot?: string): InventoryItem {
  return { name, quantity: 1, ...(equippedSlot ? { equippedSlot } : {}) } as InventoryItem;
}

function makeSnapshot(): TreePathSnapshot {
  const player = createDefaultCharacterState({
    name: '林克',
    type: 'player',
    inventory: [item('治疗药水'), item('铁剑', '武器'), item('A/B'), item('Dr.X的笔记')],
    skills: [{ name: '火球术' } as Skill],
  });
  const ella = createDefaultCharacterState({ name: '艾拉', aliases: ['小艾'] });
  const slash = createDefaultCharacterState({ name: '黑/白' });
  const dup1 = createDefaultCharacterState({ name: '甲', aliases: ['老大'] });
  const dup2 = createDefaultCharacterState({ name: '乙', aliases: ['老大'] });
  const characters: CharacterState[] = [player, ella, slash, dup1, dup2];
  return {
    characters,
    profile: {
      quests: { 寻找圣杯: {} as never },
      news: [
        { id: 'n', title: '王都快报', content: '', category: '时事', publishedAt: 0, read: false },
      ],
    },
  };
}

function asPatch(r: TreePatchParseResult): TreePatchParsed {
  if (r.kind !== 'patch') throw new Error(`期望 patch，得到 ${r.kind}`);
  return r;
}

function ok(r: TreePathResolution) {
  if (!r.ok) throw new Error(`期望解析成功，得到 ${r.code}：${r.reason}`);
  return r;
}

const snap = makeSnapshot();

function resolve(path: string, s: TreePathSnapshot = snap) {
  const n = normalizeTreePath(path);
  if (!n.ok) throw new Error(n.reason);
  return resolveTreePath(n.segments, s, n.style);
}

// ========== 区块解析 ==========

describe('区块解析', () => {
  it('完整的新形状：patch 进 ops，其余字段进 envelope', () => {
    const r = asPatch(
      parseTreePatchBlock(
        '{"version":2,"patch":[{"op":"delta","path":"/主角/生命值/当前","value":-30}],"plot":{},"diceUsed":[]}',
      ),
    );
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]).toMatchObject({
      op: 'delta',
      segments: ['主角', '生命值', '当前'],
      value: -30,
    });
    expect(r.envelope).toEqual({ version: 2, plot: {}, diceUsed: [] });
    expect(r.salvaged).toBe(false);
    expect(r.nothingRecovered).toBe(false);
  });

  it('接受已 parse 的对象与带围栏的文本', () => {
    expect(
      asPatch(parseTreePatchBlock({ patch: [{ op: 'remove', path: '/变量/a' }] })).ops,
    ).toHaveLength(1);
    const fenced =
      '说明文字\n```json\n{"patch":[{"op":"add","path":"/新闻/时事/新标题","value":"正文"}]}\n```';
    expect(asPatch(parseTreePatchBlock(fenced)).ops[0].op).toBe('add');
  });

  it('空文本是空更新，不算没救回', () => {
    const r = asPatch(parseTreePatchBlock('   '));
    expect(r.empty).toBe(true);
    expect(r.nothingRecovered).toBe(false);
  });

  it('patch 为空数组：零 op 但不是整楼拒收', () => {
    const r = asPatch(parseTreePatchBlock('{"patch":[]}'));
    expect(r.ops).toHaveLength(0);
    expect(r.nothingRecovered).toBe(false);
  });
});

describe('逐元素恢复', () => {
  it('截断输出：保住前半段，残缺的最后一条丢掉并记原因', () => {
    const text =
      '{"version":2,"patch":[{"op":"delta","path":"/主角/生命值/当前","value":-30},' +
      '{"op":"add","path":"/主角/背包/狼牙","value":{"类型":"材料","数量":2}},' +
      '{"op":"delta","path":"/关系列表/艾拉/好感度","val';
    const r = asPatch(parseTreePatchBlock(text));
    expect(r.salvaged).toBe(true);
    expect(r.ops.map((o) => o.path)).toEqual(['/主角/生命值/当前', '/主角/背包/狼牙']);
    expect(r.ops[1].value).toEqual({ 类型: '材料', 数量: 2 });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].message).toContain('截断');
    expect(r.envelope).toBeNull();
    expect(r.normalized.some((n) => n.index === -1 && n.message.includes('逐条恢复'))).toBe(true);
  });

  it('单条坏 JSON 只丢那一条，前后都保住', () => {
    const text =
      '{"patch":[{"op":"delta","path":"/主角/金钱","value":10},' +
      '{"op":"replace","path":"/主角/心里话" "value":"漏了逗号"},' +
      '{"op":"delta","path":"/命运点数","value":-1}],"plot":{}}';
    const r = asPatch(parseTreePatchBlock(text));
    expect(r.ops.map((o) => o.path)).toEqual(['/主角/金钱', '/命运点数']);
    expect(r.ops.map((o) => o.index)).toEqual([0, 2]);
    expect(r.dropped).toEqual([{ index: 1, path: '', message: '这一条 JSON 写坏了' }]);
  });

  it('字符串里的花括号不干扰配对', () => {
    const text =
      '{"patch":[{"op":"replace","path":"/主角/心里话","value":"他想：{这不对}"},{"op":"delta","path":"/主角/金钱","value":1},]}';
    const r = asPatch(parseTreePatchBlock(text));
    expect(r.ops).toHaveLength(2);
    expect(r.ops[0].value).toBe('他想：{这不对}');
  });

  it('少一个右括号把后面几条吞进来时，向内救回含 "op" 的完整对象', () => {
    const text =
      '{"patch":[{"op":"add","path":"/主角/背包/狼牙","value":{"数量":2},' +
      '{"op":"delta","path":"/主角/金钱","value":5},{"op":"delta","path":"/命运点数","value":1}]}';
    const r = asPatch(parseTreePatchBlock(text));
    expect(r.ops.map((o) => o.path)).toEqual(['/主角/金钱', '/命运点数']);
    expect(r.dropped).toHaveLength(1);
  });

  it('一条都救不回时标出 nothingRecovered', () => {
    const r = asPatch(parseTreePatchBlock('{"patch":[{"op":"delta","path":"/主角/金'));
    expect(r.ops).toHaveLength(0);
    expect(r.nothingRecovered).toBe(true);
  });

  it('JSON 完好时元素都坏（缺 path / 未知 op）只丢那几条，不算 nothingRecovered（§5.4）', () => {
    const r = asPatch(parseTreePatchBlock({ patch: [{ op: 'delta', value: 1 }] }));
    expect(r.ops).toHaveLength(0);
    expect(r.nothingRecovered).toBe(false);
    expect(r.dropped[0].message).toBe('缺少 path');
    const text = asPatch(
      parseTreePatchBlock('{"patch":[{"op":"explode","path":"/主角/金钱","value":1}]}'),
    );
    expect(text.salvaged).toBe(false);
    expect(text.nothingRecovered).toBe(false);
    expect(text.dropped).toHaveLength(1);
  });

  it('既不是 JSON 也没有 patch 数组：unparseable', () => {
    expect(parseTreePatchBlock('今天天气不错').kind).toBe('unparseable');
  });
});

describe('旧形状识别', () => {
  it('有 state / entities 而无 patch：交给旧解析器', () => {
    const r = parseTreePatchBlock('{"state":{"characters":[]},"entities":[],"plot":{}}');
    expect(r.kind).toBe('legacy');
    if (r.kind === 'legacy') {
      expect(r.payload).toMatchObject({ entities: [] });
      expect(r.note).toContain('state / entities');
    }
  });

  it('旧形状且 JSON 写坏：payload 为 null，仍走旧解析', () => {
    const r = parseTreePatchBlock('{"state":{"characters":[}');
    expect(r).toMatchObject({ kind: 'legacy', payload: null });
  });

  it('同时有 patch 与旧字段：按 patch 处理并记一条', () => {
    const r = asPatch(parseTreePatchBlock({ patch: [], effects: [] }));
    expect(r.normalized[0].message).toContain('只按 patch 处理');
  });
});

describe('op 规范化', () => {
  it.each([
    ['set', 'replace'],
    ['update', 'replace'],
    ['assign', 'replace'],
    ['insert', 'add'],
    ['push', 'add'],
    ['append', 'add'],
    ['delete', 'remove'],
    ['unset', 'remove'],
    ['inc', 'delta'],
    ['increment', 'delta'],
    ['SET', 'replace'],
  ])('op 别名 %s → %s，并记纠正', (alias, canon) => {
    const r = asPatch(
      parseTreePatchBlock({ patch: [{ op: alias, path: '/主角/金钱', value: 1 }] }),
    );
    expect(r.ops[0].op).toBe(canon);
    expect(r.normalized.some((n) => n.message.includes(alias))).toBe(true);
  });

  it('规范 op 不记纠正', () => {
    const r = asPatch(
      parseTreePatchBlock({ patch: [{ op: 'delta', path: '/主角/金钱', value: 1 }] }),
    );
    expect(r.normalized).toHaveLength(0);
  });

  it('缺 op 有 value → replace；缺 op 无 value → 丢弃', () => {
    const r = asPatch(
      parseTreePatchBlock({ patch: [{ path: '/主角/金钱', value: 3 }, { path: '/主角/金钱' }] }),
    );
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0].op).toBe('replace');
    expect(r.normalized[0].message).toContain('按 replace');
    expect(r.dropped[0]).toMatchObject({ index: 1, message: '缺少 op' });
  });

  it('未知 op、缺 value、move 缺 from 各自丢弃', () => {
    const r = asPatch(
      parseTreePatchBlock({
        patch: [
          { op: 'copy', path: '/a', from: '/b' },
          { op: 'delta', path: '/主角/金钱' },
          { op: 'move', path: '/主角/装备/铁剑', value: '武器' },
          'garbage',
        ],
      }),
    );
    expect(r.ops).toHaveLength(0);
    expect(r.dropped.map((d) => d.message)).toEqual([
      '不支持的 op「copy」',
      'delta 缺少 value',
      'move 缺少 from',
      '不是对象',
    ]);
  });

  it('move 规范化 from；replace 写 null 保留 hasValue', () => {
    const r = asPatch(
      parseTreePatchBlock({
        patch: [
          { op: 'move', from: 'stat_data.主角.背包.铁剑', path: '/主角/装备/铁剑', value: '武器' },
          { op: 'replace', path: '/主角/装备/铁剑/位置', value: null },
        ],
      }),
    );
    expect(r.ops[0]).toMatchObject({ fromSegments: ['主角', '背包', '铁剑'], fromStyle: 'dot' });
    expect(r.ops[1]).toMatchObject({ hasValue: true, value: null });
  });
});

describe('路径写法', () => {
  it('JSON Pointer，解 ~1 / ~0', () => {
    expect(normalizeTreePath('/主角/背包/A~1B/数量')).toMatchObject({
      ok: true,
      segments: ['主角', '背包', 'A/B', '数量'],
      style: 'pointer',
    });
  });

  it('点号写法与 stat_data 前缀', () => {
    const n = normalizeTreePath('stat_data.主角.生命值.当前');
    expect(n).toMatchObject({ ok: true, segments: ['主角', '生命值', '当前'], style: 'dot' });
    if (n.ok) expect(n.notes.some((x) => x.includes('stat_data'))).toBe(true);
  });

  it('点号写法里的方括号段', () => {
    expect(normalizeTreePath('关系列表["Dr. X"].好感度')).toMatchObject({
      ok: true,
      segments: ['关系列表', 'Dr. X', '好感度'],
    });
  });

  it('段数组写法', () => {
    expect(normalizeTreePath(['stat_data', '主角', '背包', 'A/B'])).toMatchObject({
      ok: true,
      segments: ['主角', '背包', 'A/B'],
      style: 'array',
    });
  });

  it('缺开头斜杠、空段都纠正', () => {
    const n = normalizeTreePath('主角//金钱/');
    expect(n).toMatchObject({ ok: true, segments: ['主角', '金钱'] });
    if (n.ok) expect(n.notes).toHaveLength(2);
  });

  it('空路径与非字符串报错', () => {
    expect(normalizeTreePath('').ok).toBe(false);
    expect(normalizeTreePath('/stat_data').ok).toBe(false);
    expect(normalizeTreePath(42).ok).toBe(false);
  });
});

describe('原型污染', () => {
  it('value 深处出现 __proto__：整楼拒收', () => {
    const r = parseTreePatchBlock(
      '{"patch":[{"op":"add","path":"/主角/背包/剑","value":{"效果":{"__proto__":{"x":1}}}}]}',
    );
    expect(r.kind).toBe('rejected');
  });

  it('envelope 里出现 constructor：整楼拒收', () => {
    expect(parseTreePatchBlock({ patch: [], plot: { constructor: 1 } }).kind).toBe('rejected');
  });

  it('路径段是 prototype：整楼拒收', () => {
    const r = parseTreePatchBlock({
      patch: [{ op: 'replace', path: '/变量/prototype', value: 1 }],
    });
    expect(r).toMatchObject({ kind: 'rejected' });
  });

  it('逐元素恢复时同样拒收', () => {
    const r = parseTreePatchBlock(
      '{"patch":[{"op":"add","path":"/a","value":{"__proto__":1}},{"op"',
    );
    expect(r.kind).toBe('rejected');
  });

  it('resolveTreePath 遇污染段返回 polluted', () => {
    expect(resolveTreePath(['变量', '__proto__'], snap)).toMatchObject({
      ok: false,
      code: 'polluted',
    });
  });

  it('字符串值里出现这些词不算污染', () => {
    expect(
      parseTreePatchBlock({
        patch: [{ op: 'replace', path: '/主角/心里话', value: 'constructor' }],
      }).kind,
    ).toBe('patch');
  });
});

// ========== 路径解析 ==========

describe('路径解析', () => {
  it('主角资源叶子', () => {
    const { target } = ok(resolve('/主角/生命值/当前'));
    expect(target).toMatchObject({
      root: 'player',
      pattern: '/主角/生命值/当前',
      readonly: false,
      person: { name: '林克', isPlayer: true, exists: true },
    });
    expect(target.spec).toMatchObject({ type: 'leaf', leaf: 'resourceCurrent' });
  });

  it('pattern 总能在词表里找到', () => {
    const patterns = new Set(listStateTreePaths().map((r) => r.pattern));
    for (const p of [
      '/主角/背包/治疗药水/数量',
      '/关系列表/艾拉/好感度',
      '/任务列表/寻找圣杯/状态',
      '/新闻/时事/王都快报',
      '/主角/登神长阶/权能/新权能/消耗',
    ]) {
      expect(patterns.has(ok(resolve(p)).target.pattern), p).toBe(true);
    }
  });

  it('关系列表：精确名、别名、主角/玩家', () => {
    expect(ok(resolve('/关系列表/艾拉/好感度')).target.person).toMatchObject({
      name: '艾拉',
      exists: true,
    });
    const alias = ok(resolve('/关系列表/小艾/好感度'));
    expect(alias.target.person?.name).toBe('艾拉');
    expect(alias.target.segments).toEqual(['关系列表', '艾拉', '好感度']);
    expect(alias.notes.some((n) => n.includes('小艾'))).toBe(true);

    const p = ok(resolve('/关系列表/主角/金钱'));
    expect(p.target).toMatchObject({ root: 'player', pointer: '/主角/金钱' });
    expect(ok(resolve('/关系列表/林克/金钱')).target.root).toBe('player');
  });

  it('别名不唯一给 ambiguous', () => {
    expect(resolve('/关系列表/老大/好感度')).toMatchObject({ ok: false, code: 'ambiguous' });
  });

  it('新人物：不存在按新建', () => {
    const { target } = ok(resolve('/关系列表/路人甲'));
    expect(target).toMatchObject({
      root: 'relation',
      isEntryRoot: true,
      person: { name: '路人甲', exists: false, isPlayer: false },
    });
  });

  it('名字含 / 时贪心拼接（人物与物品）', () => {
    const c = ok(resolve('/关系列表/黑/白/好感度'));
    expect(c.target.person?.name).toBe('黑/白');
    expect(c.target.pointer).toBe('/关系列表/黑~1白/好感度');
    expect(c.notes.some((n) => n.includes('拼成'))).toBe(true);

    const i = ok(resolve('/主角/背包/A/B/数量'));
    expect(i.target.entry).toMatchObject({ record: '背包', name: 'A/B', exists: true });
    expect(i.target.subPath).toEqual(['数量']);
  });

  it('点号写法里名字含 . 时同样贪心', () => {
    const { target } = ok(resolve('主角.背包.Dr.X的笔记.数量'));
    expect(target.entry?.name).toBe('Dr.X的笔记');
  });

  it('数组写法不拼接', () => {
    const { target } = ok(resolveTreePath(['主角', '背包', 'A/B'], snap, 'array'));
    expect(target.entry).toMatchObject({ name: 'A/B', exists: true });
  });

  it('新物品名含 / 时取「剩余段能走通」的最短拼接', () => {
    expect(ok(resolve('/主角/背包/新/物/数量')).target.entry?.name).toBe('新/物');
    expect(ok(resolve('/主角/背包/新物/数量')).target.entry).toMatchObject({
      name: '新物',
      exists: false,
    });
  });

  it('背包 / 装备条目报告物品的实际位置', () => {
    expect(ok(resolve('/主角/背包/铁剑')).target.entry).toMatchObject({
      exists: true,
      itemLocation: 'equipped',
    });
    expect(ok(resolve('/主角/装备/治疗药水')).target.entry?.itemLocation).toBe('bag');
  });

  it('/主角/地点 改写成 /世界/地点 并记纠正', () => {
    const r = ok(resolve('/主角/地点'));
    expect(r.target).toMatchObject({ root: 'world', pointer: '/世界/地点', pattern: '/世界/地点' });
    expect(r.target.person).toBeUndefined();
    expect(r.notes).toContain('主角的地点在 /世界/地点，已改写');
  });

  it('只读键：由代码维护；写时不带 _ 也命中', () => {
    const a = ok(resolve('/主角/成长/_属性点'));
    expect(a.target).toMatchObject({ readonly: true, readonlyReason: '由代码维护' });
    const b = ok(resolve('/主角/生命值/上限/基础'));
    expect(b.target).toMatchObject({ readonly: true, pointer: '/主角/生命值/上限/_基础' });
    expect(ok(resolve('/主角/生命值/上限/额外')).target.readonly).toBe(false);
  });

  it('主角等级只读并提示改累计经验值；NPC 等级可写', () => {
    const p = ok(resolve('/主角/成长/等级'));
    expect(p.target.readonly).toBe(true);
    expect(p.target.readonlyReason).toContain('由代码维护');
    expect(p.target.readonlyReason).toContain('请改累计经验值');
    expect(ok(resolve('/关系列表/艾拉/成长/等级')).target.readonly).toBe(false);
  });

  it('树外路径给出原因', () => {
    expect(resolve('/背包/剑')).toMatchObject({ ok: false, code: 'outside' });
    const r = resolve('/主角/生命值/护盾');
    expect(r).toMatchObject({ ok: false, code: 'outside' });
    if (!r.ok) expect(r.reason).toContain('护盾');
    expect(resolve('/主角/金钱/零钱')).toMatchObject({ ok: false, code: 'outside' });
    const aff = resolve('/主角/好感度');
    expect(aff).toMatchObject({ ok: false, code: 'outside' });
    if (!aff.ok) expect(aff.reason).toContain('关系列表');
  });

  it('字典型叶子可再下一段', () => {
    const { target } = ok(resolve('/主角/技能/火球术/效果/灼烧'));
    expect(target).toMatchObject({ leafKey: '灼烧', subPath: ['效果'], isEntryRoot: false });
    expect(target.entry).toMatchObject({ record: '技能', exists: true });
  });

  it('变量段原样保留；段内含 . 的报错', () => {
    const v = ok(resolve('/变量/剧情/第一章/已读'));
    expect(v.target).toMatchObject({ root: 'variables', variablePath: ['剧情', '第一章', '已读'] });
    expect(resolveTreePath(['变量', 'a.b'], snap)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('任务与新闻条目', () => {
    expect(ok(resolve('/任务列表/寻找圣杯/进展')).target.entry).toMatchObject({ exists: true });
    expect(ok(resolve('/任务列表/新任务')).target.entry).toMatchObject({ exists: false });
    const n = ok(resolve('/新闻/时事/王都快报'));
    expect(n.target.entries.map((e) => [e.record, e.name, e.exists])).toEqual([
      ['新闻', '时事', true],
      ['{栏目}', '王都快报', true],
    ]);
  });

  it('没有主角时 /主角 报 noPlayer', () => {
    expect(resolve('/主角/金钱', { characters: [] })).toMatchObject({
      ok: false,
      code: 'noPlayer',
    });
  });
});
