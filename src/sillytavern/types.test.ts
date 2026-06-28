/**
 * types.ts — 纯函数与类型辅助测试
 */
import { describe, it, expect } from 'vitest';
import {
  createDefaultCharacterState,
  resolvePlotTree,
  DEFAULT_AGENT_PIPELINE,
  DEFAULT_SETTINGS,
  DEFAULT_AGENT_PIPELINE as pipeline,
} from './types';
import type { PlotEvent, PlotEventNode } from './types';

// ========== createDefaultCharacterState ==========

describe('createDefaultCharacterState', () => {
  it('应该返回一个 id 不为空的角色', () => {
    const c = createDefaultCharacterState();
    expect(c.id).toBeTruthy();
    expect(typeof c.id).toBe('string');
  });

  it('默认类型应为 npc', () => {
    const c = createDefaultCharacterState();
    expect(c.type).toBe('npc');
  });

  it('默认种族应为人类', () => {
    const c = createDefaultCharacterState();
    expect(c.race).toBe('人类');
  });

  it('默认生命层级为 t1 普通', () => {
    const c = createDefaultCharacterState();
    expect(c.tier).toBe(1);
    expect(c.tierName).toBe('普通');
  });

  it('默认等级 1，经验 0', () => {
    const c = createDefaultCharacterState();
    expect(c.level).toBe(1);
    expect(c.totalExp).toBe(0);
    expect(c.expToNext).toBe(100);
  });

  it('五维属性默认 10', () => {
    const c = createDefaultCharacterState();
    expect(c.attributes).toEqual({ str: 10, dex: 10, con: 10, int: 10, spi: 10 });
    expect(c.freeAttrPoints).toBe(0);
  });

  it('默认 HP/MP/SP 正确', () => {
    const c = createDefaultCharacterState();
    expect(c.hp).toBe(100);
    expect(c.maxHp).toBe(100);
    expect(c.mp).toBe(50);
    expect(c.maxMp).toBe(50);
    expect(c.sp).toBe(50);
    expect(c.maxSp).toBe(50);
  });

  it('登神长阶默认 disabled', () => {
    const c = createDefaultCharacterState();
    expect(c.ascension.enabled).toBe(false);
    expect(c.ascension.elements).toEqual([]);
    expect(c.ascension.authority).toEqual([]);
    expect(c.ascension.law).toEqual([]);
    expect(c.ascension.deityPosition).toBe('');
    expect(c.ascension.divineKingdom).toEqual({ name: '', description: '' });
  });

  it('装备/技能/背包/状态 默认空数组', () => {
    const c = createDefaultCharacterState();
    expect(c.equipment).toEqual([]);
    expect(c.skills).toEqual([]);
    expect(c.inventory).toEqual([]);
    expect(c.statusEffects).toEqual([]);
  });

  it('金钱默认 0，冒险者等级默认未评级', () => {
    const c = createDefaultCharacterState();
    expect(c.money).toBe(0);
    expect(c.adventurerRank).toBe('未评级');
  });

  it('overrides 应覆盖默认值', () => {
    const c = createDefaultCharacterState({
      type: 'player',
      name: '测试主角',
      level: 5,
      hp: 200,
      maxHp: 200,
      attributes: { str: 15, dex: 12, con: 14, int: 10, spi: 8 },
      money: 500,
      location: '北方-诺斯加德',
    });
    expect(c.type).toBe('player');
    expect(c.name).toBe('测试主角');
    expect(c.level).toBe(5);
    expect(c.hp).toBe(200);
    expect(c.maxHp).toBe(200);
    expect(c.attributes.str).toBe(15);
    expect(c.attributes.dex).toBe(12);
    expect(c.money).toBe(500);
    expect(c.location).toBe('北方-诺斯加德');
  });

  it('overrides 不覆盖的字段保持默认', () => {
    const c = createDefaultCharacterState({ name: 'OnlyName' });
    expect(c.name).toBe('OnlyName');
    expect(c.race).toBe('人类');
    expect(c.level).toBe(1);
  });

  it('每次调用生成不同 id', () => {
    const a = createDefaultCharacterState();
    const b = createDefaultCharacterState();
    expect(a.id).not.toBe(b.id);
  });
});

// ========== resolvePlotTree ==========

describe('resolvePlotTree', () => {
  function makeEvent(overrides: Partial<PlotEvent> = {}): PlotEvent {
    return {
      id: crypto.randomUUID(),
      saveId: 'save_1',
      title: 'Test Event',
      description: '',
      status: 'pending',
      childrenIds: [],
      parentId: undefined,
      order: 0,
      relatedCharacterIds: [],
      location: undefined,
      worldLineChanged: false,
      depth: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  it('空列表返回空数组', () => {
    expect(resolvePlotTree([])).toEqual([]);
  });

  it('单个无父子事件应返回单根', () => {
    const e = makeEvent({ id: 'e1', title: 'Root' });
    const tree = resolvePlotTree([e]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('e1');
    expect(tree[0].children).toEqual([]);
  });

  it('应正确重建父子关系', () => {
    const root = makeEvent({ id: 'root', title: 'Root' });
    const child = makeEvent({ id: 'child', title: 'Child', parentId: 'root', depth: 1 });
    root.childrenIds = ['child'];

    const tree = resolvePlotTree([root, child]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('root');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe('child');
    expect(tree[0].children[0].title).toBe('Child');
  });

  it('应支持三层嵌套', () => {
    const root = makeEvent({ id: 'r', title: 'R' });
    const c1 = makeEvent({ id: 'c1', title: 'C1', parentId: 'r', depth: 1 });
    const c2 = makeEvent({ id: 'c2', title: 'C2', parentId: 'c1', depth: 2 });
    root.childrenIds = ['c1'];
    c1.childrenIds = ['c2'];

    const tree = resolvePlotTree([root, c1, c2]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].id).toBe('c2');
  });

  it('应正确处理多个根', () => {
    const r1 = makeEvent({ id: 'r1', title: 'R1' });
    const r2 = makeEvent({ id: 'r2', title: 'R2' });

    const tree = resolvePlotTree([r1, r2]);
    expect(tree).toHaveLength(2);
    expect(tree.map(n => n.id).sort()).toEqual(['r1', 'r2']);
  });

  it('应按 order 排序子节点', () => {
    const root = makeEvent({ id: 'r', title: 'R' });
    const c1 = makeEvent({ id: 'c1', title: 'C1', parentId: 'r', order: 3 });
    const c2 = makeEvent({ id: 'c2', title: 'C2', parentId: 'r', order: 1 });
    const c3 = makeEvent({ id: 'c3', title: 'C3', parentId: 'r', order: 2 });
    root.childrenIds = ['c1', 'c2', 'c3'];

    const tree = resolvePlotTree([root, c1, c2, c3]);
    expect(tree[0].children.map(n => n.id)).toEqual(['c2', 'c3', 'c1']);
  });

  it('父节点不存在时子节点升为根', () => {
    // orphan: parentId points to non-existent event
    const orphan = makeEvent({ id: 'orphan', title: 'Orphan', parentId: 'ghost' });

    const tree = resolvePlotTree([orphan]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('orphan');
  });

  it('返回的是 PlotEventNode（含 children 而非 childrenIds）', () => {
    const e = makeEvent({ id: 'e' });
    const tree = resolvePlotTree([e]);
    const node = tree[0] as PlotEventNode;
    expect(Array.isArray(node.children)).toBe(true);
    // PlotEventNode shouldn't have childrenIds
    expect('childrenIds' in node).toBe(false);
  });
});

// ========== DEFAULT_AGENT_PIPELINE ==========

describe('DEFAULT_AGENT_PIPELINE', () => {
  it('应有 6 个阶段', () => {
    expect(DEFAULT_AGENT_PIPELINE.stages).toHaveLength(6);
  });

  it('第一阶段 (memory_recall + plot_pre_check) 并行，无依赖', () => {
    const s = DEFAULT_AGENT_PIPELINE.stages[0];
    expect(s.agents).toContain('memory_recall');
    expect(s.agents).toContain('plot_pre_check');
    expect(s.waitFor).toEqual([]);
  });

  it('第二阶段 (story) 依赖第一阶段的 2 个 Agent', () => {
    const s = DEFAULT_AGENT_PIPELINE.stages[1];
    expect(s.agents).toEqual(['story']);
    expect(s.waitFor).toContain('memory_recall');
    expect(s.waitFor).toContain('plot_pre_check');
  });

  it('第三阶段 (vars_update) 依赖 story', () => {
    const s = DEFAULT_AGENT_PIPELINE.stages[2];
    expect(s.agents).toEqual(['vars_update']);
    expect(s.waitFor).toEqual(['story']);
  });

  it('第四阶段 (char_update) 依赖 story + vars_update', () => {
    const s = DEFAULT_AGENT_PIPELINE.stages[3];
    expect(s.agents).toEqual(['char_update']);
    expect(s.waitFor).toContain('story');
    expect(s.waitFor).toContain('vars_update');
  });

  it('第五阶段 (memory_summary) 依赖 story', () => {
    const s = DEFAULT_AGENT_PIPELINE.stages[4];
    expect(s.agents).toEqual(['memory_summary']);
  });

  it('第六阶段 (plot_post_check) 依赖 story + memory_summary', () => {
    const s = DEFAULT_AGENT_PIPELINE.stages[5];
    expect(s.agents).toEqual(['plot_post_check']);
    expect(s.waitFor).toContain('story');
    expect(s.waitFor).toContain('memory_summary');
  });

  it('总超时应为 120s', () => {
    expect(DEFAULT_AGENT_PIPELINE.timeout).toBe(120000);
  });

  it('失败应重试', () => {
    expect(DEFAULT_AGENT_PIPELINE.retryOnFail).toBe(true);
  });
});

// ========== DEFAULT_SETTINGS v4 字段 ==========

describe('DEFAULT_SETTINGS — v4 字段', () => {
  it('应有 apiEndpoints 且默认空数组', () => {
    expect(DEFAULT_SETTINGS.apiEndpoints).toEqual([]);
  });

  it('应有 agentConfigs 且默认空数组', () => {
    expect(DEFAULT_SETTINGS.agentConfigs).toEqual([]);
  });

  it('应有 agentPipeline 且等于 DEFAULT_AGENT_PIPELINE', () => {
    expect(DEFAULT_SETTINGS.agentPipeline).toEqual(DEFAULT_AGENT_PIPELINE);
  });

  it('cacheStrategy 默认为 userid_isolated', () => {
    expect(DEFAULT_SETTINGS.cacheStrategy).toBe('userid_isolated');
  });

  it('maxSnapshotsPerSave 默认为 30', () => {
    expect(DEFAULT_SETTINGS.maxSnapshotsPerSave).toBe(30);
  });

  it('maxMemoriesRecall 默认为 20', () => {
    expect(DEFAULT_SETTINGS.maxMemoriesRecall).toBe(20);
  });

  it('v3 字段仍存在且不变', () => {
    expect(DEFAULT_SETTINGS.apiMode).toBe('single');
    expect(DEFAULT_SETTINGS.theme).toBe('dark');
    expect(DEFAULT_SETTINGS.language).toBe('zh');
    expect(DEFAULT_SETTINGS.autoSave).toBe(true);
    expect(DEFAULT_SETTINGS.uiMode).toBe('game');
  });
});

// ========== DEFAULT_FORMAT_PROMPT ==========

import { DEFAULT_FORMAT_PROMPT } from './types';

describe('DEFAULT_FORMAT_PROMPT', () => {
  it('应包含必需的 XML 标签', () => {
    expect(DEFAULT_FORMAT_PROMPT).toContain('<thinking>');
    expect(DEFAULT_FORMAT_PROMPT).toContain('<maintext>');
    expect(DEFAULT_FORMAT_PROMPT).toContain('<option>');
    expect(DEFAULT_FORMAT_PROMPT).toContain('<sum>');
    expect(DEFAULT_FORMAT_PROMPT).toContain('<vars>');
  });
});

// ========== createDefaultPreset ==========

import { createDefaultPreset } from './types';

describe('createDefaultPreset', () => {
  it('应返回一个不含 id/createdAt/updatedAt 的预设', () => {
    const preset = createDefaultPreset();
    expect(preset.name).toBe('默认预设');
    expect(preset.settings.temp_openai).toBe(0.8);
    // 不应有 id（由调用方添加）
    expect('id' in preset).toBe(false);
    expect('createdAt' in preset).toBe(false);
  });
});
