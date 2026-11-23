/**
 * state-tree-sections.ts — 状态树缓存分区（状态树协议 T4，§3.4）
 */
import { describe, expect, it } from 'vitest';
import { buildStateTree } from '../../../src/core/variables/state-tree-projection';
import {
  escapeStateTreeSegment,
  findOverlappingSections,
  joinStateTreePath,
  joinStateTreeSections,
  serializeStateTreeSections,
  serializeStateTreeValue,
  splitStateTreePath,
  splitStateTreeSections,
} from '../../../src/core/variables/state-tree-sections';
import { makeInput, makeNpc, makePlayer } from './state-tree-fixture';

const PERSON_KEYS = [
  '档案',
  '成长',
  '生命值',
  '法力值',
  '体力值',
  '金钱',
  '当前行动',
  '心里话',
  '背包',
  '装备',
  '技能',
  '状态效果',
  '登神长阶',
];

describe('splitStateTreeSections 切点', () => {
  const sections = splitStateTreeSections(buildStateTree(makeInput()));
  const paths = Object.keys(sections);

  it('世界 / 命运点数 / 新闻 / 变量整块各一个分区', () => {
    for (const p of ['/世界', '/命运点数', '/新闻', '/变量']) expect(paths).toContain(p);
  });

  it('任务逐条成分区', () => {
    expect(paths).toContain('/任务列表/寻找钥匙');
    expect(paths).toContain('/任务列表/护送商队');
    expect(paths).not.toContain('/任务列表');
  });

  it('主角每个直接子键一个分区，含背包与装备', () => {
    for (const k of PERSON_KEYS) expect(paths).toContain(`/主角/${k}`);
    expect(paths.filter((p) => p.startsWith('/主角/'))).toHaveLength(PERSON_KEYS.length);
    expect(paths).not.toContain('/主角');
  });

  it('全量关系人物每个直接子键一个分区（含在场 / 地点 / 好感度）', () => {
    // 布兰没有心里话（undefined 不出键）
    for (const k of [...PERSON_KEYS.filter((k) => k !== '心里话'), '在场', '地点', '好感度']) {
      expect(paths).toContain(`/关系列表/布兰/${k}`);
    }
    expect(paths).toContain('/关系列表/哥布林/数量');
  });

  it('摘要角色整块一个分区', () => {
    expect(sections['/关系列表/卡拉']).toEqual({ 在场: false, 地点: '王都/酒馆', 好感度: -10 });
    expect(paths.some((p) => p.startsWith('/关系列表/卡拉/'))).toBe(false);
  });

  it('改主角 HP 只影响 /主角/生命值 一个分区', () => {
    const input = makeInput();
    const [player, ...rest] = input.characters;
    const changed = makeInput({ characters: [{ ...player, hp: 1 }, ...rest] });
    const a = serializeStateTreeSections(splitStateTreeSections(buildStateTree(input)));
    const b = serializeStateTreeSections(splitStateTreeSections(buildStateTree(changed)));
    const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
    expect(diff).toEqual(['/主角/生命值']);
  });
});

describe('分区闸门', () => {
  const cases = {
    缺省可见性: buildStateTree(makeInput()),
    全部全量: buildStateTree(makeInput(), { visibility: { mode: 'all' } }),
    无任务无关系: buildStateTree({
      characters: [makePlayer()],
      profile: { ...makeInput().profile, quests: {}, news: [] },
    }),
    名字带斜杠和波浪号: buildStateTree(
      makeInput({
        characters: [makePlayer(), makeNpc('甲/乙~丙', { present: true }), makeNpc('a~1b')],
      }),
    ),
  };

  for (const [label, tree] of Object.entries(cases)) {
    describe(label, () => {
      const sections = splitStateTreeSections(tree);

      it('分区互不重叠', () => {
        expect(findOverlappingSections(Object.keys(sections))).toBeNull();
      });

      it('合起来等于整树', () => {
        expect(joinStateTreeSections(sections)).toEqual(tree);
        expect(serializeStateTreeValue(joinStateTreeSections(sections))).toBe(
          serializeStateTreeValue(tree),
        );
      });

      it('同一状态两次序列化字节相同', () => {
        const again = label === '缺省可见性' ? buildStateTree(makeInput()) : tree;
        expect(serializeStateTreeValue(again)).toBe(serializeStateTreeValue(tree));
        expect(serializeStateTreeSections(splitStateTreeSections(again))).toEqual(
          serializeStateTreeSections(sections),
        );
      });
    });
  }

  it('名字里的 / 与 ~ 按 JSON Pointer 转义', () => {
    const sections = splitStateTreeSections(cases['名字带斜杠和波浪号']);
    expect(Object.keys(sections)).toContain('/关系列表/甲~1乙~0丙/生命值');
    expect(Object.keys(sections)).toContain('/关系列表/a~01b');
  });
});

describe('路径工具', () => {
  it('转义与反转义往返', () => {
    for (const s of ['普通', 'a/b', '~1', '~/~', '']) {
      expect(splitStateTreePath(joinStateTreePath(['x', s]))).toEqual(['x', s]);
    }
    expect(escapeStateTreeSegment('~/')).toBe('~0~1');
  });

  it('不以 / 开头的路径抛错', () => {
    expect(() => splitStateTreePath('世界')).toThrow();
  });

  it('findOverlappingSections 识别相同路径与按段前缀，不把字符前缀当重叠', () => {
    expect(findOverlappingSections(['/a', '/a'])).toEqual(['/a', '/a']);
    expect(findOverlappingSections(['/a!b', '/a/c', '/a'])).toEqual(['/a', '/a/c']);
    expect(findOverlappingSections(['/ab', '/a'])).toBeNull();
  });

  it('joinStateTreeSections 遇重叠分区抛错', () => {
    expect(() => joinStateTreeSections({ '/主角': {}, '/主角/金钱': 1 })).toThrow(/重叠/);
  });
});

describe('serializeStateTreeValue', () => {
  it('对象键排序、数组保序', () => {
    expect(serializeStateTreeValue({ b: 1, a: [3, { d: 1, c: 2 }] })).toBe(
      '{"a":[3,{"c":2,"d":1}],"b":1}',
    );
  });

  it('与键插入顺序无关', () => {
    expect(serializeStateTreeValue({ x: 1, y: { p: 1, q: 2 } })).toBe(
      serializeStateTreeValue({ y: { q: 2, p: 1 }, x: 1 }),
    );
  });

  it('__proto__ 键原样保留', () => {
    const v = JSON.parse('{"__proto__":{"a":1},"b":2}');
    expect(serializeStateTreeValue(v)).toBe('{"__proto__":{"a":1},"b":2}');
  });
});
