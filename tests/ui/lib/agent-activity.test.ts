import { describe, expect, it } from 'vitest';
import {
  activityRunSideTaskLabel,
  agentActivityLabel,
  presentToolActivity,
} from '../../../src/ui/lib/agent-activity';

describe('agent activity presentation', () => {
  it('uses in-world labels and never falls back to an unknown technical id', () => {
    expect(agentActivityLabel('memory_recall')).toBe('追忆相关经历');
    expect(agentActivityLabel('internal_future_agent')).toBe('处理世界变化');

    const tool = presentToolActivity(
      'internal_future_tool',
      { secretArgument: true },
      { secretResult: true },
      'tool-1',
      10,
    );
    expect(tool).toMatchObject({ label: '处理世界规则', status: 'completed' });
    expect(JSON.stringify(tool)).not.toContain('internal_future_tool');
    expect(JSON.stringify(tool)).not.toContain('secretArgument');
    expect(JSON.stringify(tool)).not.toContain('secretResult');
  });

  it('summarizes useful tool outcomes without retaining raw payloads', () => {
    const inventory = presentToolActivity(
      'get_inventory',
      { characterId: 'private-id' },
      { characterName: '莱恩', itemCount: 3, items: [{ internal: 'raw' }] },
      'tool-2',
      20,
    );
    expect(inventory).toMatchObject({
      label: '查看随身物品',
      detail: '莱恩 · 3 件',
      status: 'completed',
    });
    expect(JSON.stringify(inventory)).not.toContain('private-id');
    expect(JSON.stringify(inventory)).not.toContain('raw');
  });

  it('turns tool errors into a safe failed state', () => {
    const failed = presentToolActivity(
      'craft_check',
      {},
      { error: 'provider stack trace and API details' },
      'tool-3',
      30,
    );
    expect(failed).toMatchObject({ label: '进行制作检定', status: 'failed' });
    expect(JSON.stringify(failed)).not.toContain('provider stack trace');
  });
});

describe('activityRunSideTaskLabel（GAME-17）', () => {
  const step = (agentId: string) => ({
    id: agentId,
    agentId,
    label: agentId,
    status: 'running' as const,
    startedAt: 0,
    tools: [],
  });

  it('只由润色组成的独立 run → 「润色」', () => {
    expect(activityRunSideTaskLabel({ standalone: true, steps: [step('prose_rewrite')] })).toBe(
      '润色',
    );
  });

  it('正式回合、空 run、混合步骤 → null（仍按回合显示）', () => {
    expect(activityRunSideTaskLabel({ standalone: false, steps: [step('prose_rewrite')] })).toBe(
      null,
    );
    expect(activityRunSideTaskLabel({ standalone: true, steps: [] })).toBe(null);
    expect(
      activityRunSideTaskLabel({ standalone: true, steps: [step('prose_rewrite'), step('story')] }),
    ).toBe(null);
  });
});
