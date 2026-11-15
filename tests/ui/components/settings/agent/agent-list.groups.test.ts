/**
 * 设置页 Agent 子导航分组的漂移闸门
 *
 * 分组不是手写的：Agent 模式组 = 引擎两条管线摊平 + 仅 Story v2 的 lore_select，
 * 直出组 = 直出名册里的独立配置。这里钉住三件事：
 *   1. 管线与直出名册里的每个 id 都在 AGENT_LIST 里，且分到预期的组；
 *   2. AGENT_LIST 的每一项都有组，Agent 模式组按管线阶段顺序；
 *   3. agent-config.json 里的每个 agent（除 D53 刻意排除的 image_prompt）都在 AGENT_LIST 里。
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { DEFAULT_AGENT_PIPELINE, STORY_CONTEXT_V2_PIPELINE } from '@engine/types/types';
import {
  AGENT_GROUPS,
  AGENT_LIST,
  agentDisplayName,
} from '@ui/components/settings/agent/agent-list';
import {
  AGENT_MODE_AGENT_IDS,
  DIRECT_MODE_AGENT_IDS,
  agentIdsUsedBySave,
} from '@ui/lib/agent-roster';

const groupOf = (id: string) => AGENT_LIST.find((a) => a.id === id)?.group;
const pipelineIds = (p: typeof DEFAULT_AGENT_PIPELINE) => p.stages.flatMap((s) => s.agents);

describe('Agent 子导航分组', () => {
  it('三个分组按「Agent 模式 → 直出模式 → 辅助 Agent」排列，各带一句说明', () => {
    expect(AGENT_GROUPS.map((g) => g.label)).toEqual(['Agent 模式', '直出模式', '辅助 Agent']);
    for (const g of AGENT_GROUPS) expect(g.caption).toBeTruthy();
  });

  it('两条管线里的每个 Agent 都在清单里，且归入 Agent 模式组', () => {
    for (const id of [
      ...pipelineIds(DEFAULT_AGENT_PIPELINE),
      ...pipelineIds(STORY_CONTEXT_V2_PIPELINE),
    ]) {
      expect(groupOf(id), id).toBe('agent');
    }
  });

  it('Agent 模式组按管线阶段顺序，lore_select 排在 story 之前并标「仅 Story v2」', () => {
    const agentGroup = AGENT_GROUPS.find((g) => g.key === 'agent')!;
    expect(agentGroup.items.map((a) => a.id)).toEqual([
      'memory_recall',
      'plot_pre_check',
      'lore_select',
      'story',
      'request_dispatcher',
      'memory_summary',
      'daily_check',
      'vars_update',
      'plot_post_check',
    ]);
    expect(agentGroup.items.map((a) => a.id)).toEqual([...AGENT_MODE_AGENT_IDS]);
    expect(AGENT_LIST.find((a) => a.id === 'lore_select')?.tags).toContain('仅 Story v2');
  });

  it('直出名册：记忆两段留在 Agent 模式组并标「直出也使用」，主生成两份配置进直出组', () => {
    for (const id of DIRECT_MODE_AGENT_IDS) expect(groupOf(id), id).toBeDefined();
    expect(groupOf('memory_recall')).toBe('agent');
    expect(groupOf('memory_summary')).toBe('agent');
    expect(AGENT_LIST.find((a) => a.id === 'memory_recall')?.tags).toContain('直出也使用');
    expect(AGENT_LIST.find((a) => a.id === 'memory_summary')?.tags).toContain('直出也使用');
    expect(AGENT_GROUPS.find((g) => g.key === 'direct')!.items.map((a) => a.id)).toEqual([
      'direct_main',
      'direct_cached',
    ]);
  });

  it('其余按需触发的 Agent 归入辅助组', () => {
    expect(AGENT_GROUPS.find((g) => g.key === 'auxiliary')!.items.map((a) => a.id)).toEqual([
      'craft_gen',
      'entity_gen',
      'combat',
      'prose_rewrite',
      'plot_outline',
    ]);
  });

  it('清单每一项都有组、中文名与说明，扁平清单与分组同序', () => {
    for (const a of AGENT_LIST) {
      expect(['agent', 'direct', 'auxiliary']).toContain(a.group);
      expect(a.name).not.toBe(a.id);
      expect(a.desc).toBeTruthy();
    }
    expect(AGENT_LIST.map((a) => a.id)).toEqual(
      AGENT_GROUPS.flatMap((g) => g.items.map((a) => a.id)),
    );
  });

  it('agent-config.json 里除 image_prompt 外的每个 Agent 都在清单里', () => {
    const cfg = JSON.parse(readFileSync('public/data/defaults/agent-config.json', 'utf8')) as {
      agents: Record<string, unknown>;
    };
    for (const id of Object.keys(cfg.agents)) {
      if (id === 'image_prompt') continue;
      expect(groupOf(id), id).toBeDefined();
    }
    expect(AGENT_LIST.some((a) => a.id === 'image_prompt')).toBe(false);
  });

  it('agentDisplayName 给中文名，查不到原样返回 id', () => {
    expect(agentDisplayName('direct_cached')).toBe('直出主生成（缓存优化）');
    expect(agentDisplayName('未知_agent')).toBe('未知_agent');
    expect(agentDisplayName(null)).toBe('');
  });
});

describe('agentIdsUsedBySave（「本存档使用」标记）', () => {
  it('Agent 模式旧档：默认管线成员，不含 lore_select 与直出配置', () => {
    const used = agentIdsUsedBySave('agent', false);
    expect([...used]).toEqual(pipelineIds(DEFAULT_AGENT_PIPELINE));
    expect(used.has('lore_select')).toBe(false);
  });

  it('Agent 模式 Story v2 档：v2 管线成员加 lore_select', () => {
    const used = agentIdsUsedBySave('agent', true);
    expect(used.has('lore_select')).toBe(true);
    expect(used.has('daily_check')).toBe(false);
  });

  it('直出档读 direct_main，缓存直出档读 direct_cached 那份配置', () => {
    expect([...agentIdsUsedBySave('direct', false)]).toEqual([
      'memory_recall',
      'direct_main',
      'memory_summary',
    ]);
    const cached = agentIdsUsedBySave('direct_cached', false);
    expect(cached.has('direct_cached')).toBe(true);
    expect(cached.has('direct_main')).toBe(false);
  });
});
