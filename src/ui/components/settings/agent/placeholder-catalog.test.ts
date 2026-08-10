/**
 * 占位符目录（Q-25 第 9 步）
 *
 * 这两张表编码的是 **DAG 的偏序** 与 **侧链归属**。写错方向不会编译报错，
 * 只会让模板里出现一个装配时恒为空串的占位符 —— 那是真机上才看得见的缺陷。
 * 搬成纯模块之前，验这件事要挂起整个设置页。
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_PLACEHOLDER_META,
  getPlaceholdersForAgent,
  type PlaceholderBadge,
} from './placeholder-catalog';

const keysFor = (agentId: string): string[] => getPlaceholdersForAgent(agentId).map((p) => p.key);

describe('ALL_PLACEHOLDER_META', () => {
  it('key 不重复（重复会让面板出现两个一样的徽章）', () => {
    const keys = ALL_PLACEHOLDER_META.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每一项四个字段都非空', () => {
    for (const p of ALL_PLACEHOLDER_META as PlaceholderBadge[]) {
      expect(p.key, JSON.stringify(p)).toBeTruthy();
      expect(p.desc, p.key).toBeTruthy();
      expect(p.category, p.key).toBeTruthy();
      expect(p.color, p.key).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('同一 category 用同一个颜色（配色是按分类给的，不是随机取的）', () => {
    const byCategory = new Map<string, Set<string>>();
    for (const p of ALL_PLACEHOLDER_META) {
      if (!byCategory.has(p.category)) byCategory.set(p.category, new Set());
      byCategory.get(p.category)!.add(p.color);
    }
    for (const [cat, colors] of byCategory) {
      expect([...colors], `分类「${cat}」用了多个颜色`).toHaveLength(1);
    }
  });
});

describe('getPlaceholdersForAgent — 公共批', () => {
  it('12 个公共占位符对每个 Agent 都可见', () => {
    const common = [
      'SYS_PROMPT',
      'LORE_BOOK',
      'LORE_BOOK_STATIC',
      'LORE_BOOK_DYNAMIC',
      'NARRATIVE',
      'USER_INPUT',
      'CHARACTER_STATE',
      'INVENTORY',
      'GAME_TIME',
      'ACTIVE_EFFECTS',
      'MEMORY_ENTRIES',
      'PLOT_EVENTS',
    ];
    for (const agentId of ['story', 'char_gen', 'memory_recall', '完全没登记过的_agent']) {
      expect(keysFor(agentId), agentId).toEqual(expect.arrayContaining(common));
    }
  });

  it('没登记过的 Agent 只拿到公共批，不报错', () => {
    expect(keysFor('未来的新_agent')).toHaveLength(12);
  });
});

describe('getPlaceholdersForAgent — DAG 偏序', () => {
  it('🔴 story 只看得到跑在它前面的两个（memory_recall / plot_pre_check）', () => {
    const k = keysFor('story');
    expect(k).toContain('AGENT.MEMORY_RECALL');
    expect(k).toContain('AGENT.PLOT_PRE_CHECK');
    // story 自己的输出、以及所有跑在它之后的，都不该出现
    expect(k).not.toContain('AGENT.STORY');
    expect(k).not.toContain('AGENT.REQUEST_DISPATCHER');
    expect(k).not.toContain('AGENT.VARS_UPDATE');
    expect(k).not.toContain('AGENT.MEMORY_SUMMARY');
  });

  it('vars_update 看得到 story 与调度器（它在两者之后）', () => {
    const k = keysFor('vars_update');
    expect(k).toContain('AGENT.STORY');
    expect(k).toContain('AGENT.REQUEST_DISPATCHER');
    expect(k).not.toContain('AGENT.VARS_UPDATE'); // 不该看见自己的输出
  });

  it('plot_post_check 在最后，看得到 story 与记忆总结', () => {
    const k = keysFor('plot_post_check');
    expect(k).toContain('AGENT.STORY');
    expect(k).toContain('AGENT.MEMORY_SUMMARY');
  });

  it('🔴 没有任何 Agent 看得见自己的输出（那必然是空串）', () => {
    const selfKey: Record<string, string> = {
      memory_recall: 'AGENT.MEMORY_RECALL',
      plot_pre_check: 'AGENT.PLOT_PRE_CHECK',
      story: 'AGENT.STORY',
      request_dispatcher: 'AGENT.REQUEST_DISPATCHER',
      vars_update: 'AGENT.VARS_UPDATE',
      memory_summary: 'AGENT.MEMORY_SUMMARY',
    };
    for (const [agentId, own] of Object.entries(selfKey)) {
      expect(keysFor(agentId), `${agentId} 看见了自己的输出`).not.toContain(own);
    }
  });

  it('memory_recall 跑在最前，一个上游输出都看不到', () => {
    expect(keysFor('memory_recall').filter((k) => k.startsWith('AGENT.'))).toEqual([]);
  });
});

describe('getPlaceholdersForAgent — 侧链专属', () => {
  it('craft_gen 拿到制作链的三个标记', () => {
    const k = keysFor('craft_gen');
    expect(k).toEqual(expect.arrayContaining(['CRAFT_REQUEST', 'ITEM_REQUEST', 'CRAFT_RESULT']));
    expect(k).not.toContain('CHAR_DETECT');
  });

  it('char_gen 拿到角色链的两个', () => {
    const k = keysFor('char_gen');
    expect(k).toEqual(expect.arrayContaining(['CHAR_DETECT', 'CHAR_GEN_RESULT']));
    expect(k).not.toContain('CRAFT_REQUEST');
  });

  it('combat_v3 拿到战斗链的 COMBAT_BRIEF 与 COMBAT_ROSTER', () => {
    const k = keysFor('combat_v3');
    expect(k).toContain('COMBAT_BRIEF');
    expect(k).toContain('COMBAT_ROSTER');
    expect(k).not.toContain('CRAFT_REQUEST');
  });

  it('🔴 story 拿不到任何侧链标记（那些是链内 Agent 才有的）', () => {
    const k = keysFor('story');
    for (const chain of [
      'CRAFT_REQUEST',
      'CHAR_DETECT',
      'ITEM_REQUEST',
      'CHAR_GEN_RESULT',
      'CRAFT_RESULT',
      'COMBAT_BRIEF',
      'COMBAT_ROSTER',
    ]) {
      expect(k, `story 不该看见 ${chain}`).not.toContain(chain);
    }
  });

  it('返回顺序沿用目录表的声明序（面板里徽章顺序稳定）', () => {
    const all = ALL_PLACEHOLDER_META.map((p) => p.key);
    const got = keysFor('craft_gen');
    const expectedOrder = all.filter((k) => got.includes(k));
    expect(got).toEqual(expectedOrder);
  });
});
