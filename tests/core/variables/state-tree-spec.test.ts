/**
 * state-tree-spec.ts — 状态树中文键词表（状态树协议 §3.1–3.3）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERSON_NODE_CHILDREN,
  STATE_TREE_ENUM_VALUES,
  STATE_TREE_SLOT_VALUES,
  STATE_TREE_SPEC,
  findChildSpec,
  isReadonlyKey,
  isReadonlyNode,
  listStateTreePaths,
  type StateTreeBranchSpec,
  type StateTreeNodeSpec,
} from '../../../src/core/variables/state-tree-spec';

function rowAt(pattern: string) {
  const row = listStateTreePaths().find((r) => r.pattern === pattern);
  if (!row) throw new Error(`词表缺路径 ${pattern}`);
  return row;
}

function collectBranches(node: StateTreeNodeSpec, out: StateTreeBranchSpec[] = []) {
  if (node.type === 'branch') {
    out.push(node);
    node.children.forEach((c) => collectBranches(c, out));
  } else if (node.type === 'record') {
    collectBranches(node.entry, out);
  }
  return out;
}

describe('词表结构', () => {
  it('每个分支下的键唯一（含去掉 `_` 前缀后也不撞）', () => {
    for (const b of collectBranches(STATE_TREE_SPEC)) {
      const keys = b.children.map((c) => c.key);
      expect(new Set(keys).size, `${b.key} 有重复键`).toBe(keys.length);
      const bare = keys.map((k) => k.replace(/^_+/, ''));
      expect(new Set(bare).size, `${b.key} 去前缀后撞键`).toBe(bare.length);
    }
  });

  it('展平后的路径模式无重复', () => {
    const patterns = listStateTreePaths().map((r) => r.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it('覆盖 §3.1 骨架的全部顶层与人物节点', () => {
    expect(STATE_TREE_SPEC.children.map((c) => c.key)).toEqual([
      '世界',
      '命运点数',
      '主角',
      '关系列表',
      '任务列表',
      '新闻',
      '变量',
    ]);
    for (const p of [
      '/世界/时间',
      '/世界/地点',
      '/世界/_时段',
      '/世界/_天气',
      '/世界/_回合',
      '/主角/档案/身份',
      '/主角/成长/_属性/力量',
      '/主角/生命值/当前',
      '/主角/生命值/上限/_基础',
      '/主角/生命值/上限/额外',
      '/主角/法力值/上限/额外',
      '/主角/体力值/上限/额外',
      '/主角/金钱',
      '/主角/背包/{物品名}/数量',
      '/主角/装备/{物品名}/位置',
      '/主角/装备/{物品名}/耐久/上限',
      '/主角/技能/{技能名}/消耗',
      '/主角/状态效果/{状态名}/剩余时间',
      '/主角/登神长阶/是否开启',
      '/主角/登神长阶/权能/{权能名}/消耗',
      '/主角/登神长阶/神国/名称',
      '/关系列表/{人物名}/在场',
      '/关系列表/{人物名}/好感度',
      '/关系列表/{人物名}/档案/类别',
      '/任务列表/{任务名}/关注度',
      '/新闻/{栏目}/{标题}',
      '/变量',
    ]) {
      expect(() => rowAt(p)).not.toThrow();
    }
  });

  it('背包条目不带位置，装备条目带位置', () => {
    expect(listStateTreePaths().some((r) => r.pattern === '/主角/背包/{物品名}/位置')).toBe(false);
    expect(rowAt('/主角/装备/{物品名}/位置').spec).toMatchObject({ leaf: 'slot' });
  });

  it('主角节点不含关系列表专属键，关系列表人物含', () => {
    const player = findChildSpec(STATE_TREE_SPEC, '主角') as StateTreeBranchSpec;
    expect(player.children.some((c) => c.key === '在场' || c.key === '好感度')).toBe(false);
    expect(PERSON_NODE_CHILDREN.filter((c) => c.relationOnly).map((c) => c.key)).toEqual([
      '在场',
      '地点',
      '好感度',
      '数量',
    ]);
  });

  it('不加 fitSlot、不加槽位别名：装备位置只列内核槽位', () => {
    expect(STATE_TREE_SLOT_VALUES).toEqual([
      '武器',
      '副手',
      '头部',
      '身体',
      '手部',
      '脚部',
      '腰带',
      '饰品',
    ]);
    expect(listStateTreePaths().some((r) => /适配|fitSlot/.test(r.pattern))).toBe(false);
  });

  it('叶子类型与内核字段登记正确（抽样）', () => {
    expect(rowAt('/主角/生命值/当前').spec).toMatchObject({
      leaf: 'resourceCurrent',
      field: 'CharacterState.hp',
    });
    expect(rowAt('/主角/生命值/上限/额外').spec).toMatchObject({
      leaf: 'capBonus',
      field: 'CharacterState.maxHpBonus',
    });
    expect(rowAt('/主角/生命值/上限').spec).toMatchObject({
      type: 'branch',
      scalarLeaf: 'capBonus',
    });
    expect(rowAt('/主角/状态效果/{状态名}/剩余时间').spec).toMatchObject({ leaf: 'duration' });
    expect(rowAt('/主角/技能/{技能名}/类型').spec).toMatchObject({
      leaf: 'enum',
      enumKind: 'skillType',
    });
    expect(rowAt('/命运点数').spec).toMatchObject({ leaf: 'fatePoints' });
    expect(rowAt('/变量').spec).toMatchObject({ leaf: 'variables' });
    expect(rowAt('/关系列表/{人物名}').spec).toMatchObject({ type: 'branch', entity: 'character' });
    expect(rowAt('/主角/背包/{物品名}').spec).toMatchObject({ entity: 'item' });
  });

  it('枚举可选值来自 field-enums 与内核固定集合', () => {
    expect(STATE_TREE_ENUM_VALUES.rarity).toContain('传说');
    expect(STATE_TREE_ENUM_VALUES.questPriority).toEqual(['低', '中', '高']);
    expect(STATE_TREE_ENUM_VALUES.skillType).toEqual(['主动', '被动']);
  });
});

describe('只读约定', () => {
  it('`_` 前缀即只读，并沿路径向下继承', () => {
    expect(isReadonlyKey('_基础')).toBe(true);
    expect(isReadonlyKey('额外')).toBe(false);
    expect(rowAt('/主角/生命值/上限/_基础').readonly).toBe(true);
    expect(rowAt('/主角/成长/_属性/力量').readonly).toBe(true);
    expect(rowAt('/主角/生命值/上限/额外').readonly).toBe(false);
  });

  it('等级：键名不带 `_`，NPC 可写、主角只读', () => {
    const lv = rowAt('/主角/成长/等级');
    expect(lv.spec.key).toBe('等级');
    expect(lv.readonly).toBe(false);
    expect(isReadonlyNode(lv.spec, true)).toBe(true);
    expect(isReadonlyNode(lv.spec, false)).toBe(false);
    expect(listStateTreePaths().some((r) => r.pattern.endsWith('/_等级'))).toBe(false);
  });
});

describe('findChildSpec', () => {
  const world = findChildSpec(STATE_TREE_SPEC, '世界') as StateTreeBranchSpec;

  it('精确匹配优先，其次忽略 `_` 前缀', () => {
    expect(findChildSpec(world, '时间')?.key).toBe('时间');
    expect(findChildSpec(world, '天气')?.key).toBe('_天气');
    const growth = findChildSpec(
      findChildSpec(STATE_TREE_SPEC, '主角') as StateTreeBranchSpec,
      '成长',
    ) as StateTreeBranchSpec;
    expect(findChildSpec(growth, '_等级')?.key).toBe('等级');
  });

  it('不做模糊匹配', () => {
    expect(findChildSpec(world, '时')).toBeUndefined();
    expect(findChildSpec(world, '时间 ')).toBeUndefined();
    expect(findChildSpec(world, 'time')).toBeUndefined();
  });
});

describe('依赖边界', () => {
  it('只 import content/field-enums', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../src/core/variables/state-tree-spec.ts'),
      'utf8',
    );
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['../content/field-enums']);
  });
});
