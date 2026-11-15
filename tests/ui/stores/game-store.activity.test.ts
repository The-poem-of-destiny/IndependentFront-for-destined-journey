import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../../src/ui/stores/game-store';

describe('game store agent activities', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('keeps parallel agents independently running and completes the owned run', () => {
    const game = useGameStore();
    const runId = game.startAgentActivityRun('message-1');

    game.updateAgentStatus('memory_recall', runId);
    game.updateAgentStatus('plot_pre_check', runId);

    const run = game.agentActivityRuns[0];
    expect(run.steps.map((step) => [step.agentId, step.status])).toEqual([
      ['memory_recall', 'running'],
      ['plot_pre_check', 'running'],
    ]);

    game.clearAgentStatus('memory_recall', undefined, runId);
    expect(run.steps[0].status).toBe('completed');
    expect(run.steps[1].status).toBe('running');

    game.clearAgentStatus('plot_pre_check', undefined, runId);
    game.finishAgentActivityRun(runId, 'completed');
    expect(run.status).toBe('completed');
    expect(run.steps.every((step) => step.status === 'completed')).toBe(true);
  });

  it('nests semantic tool events under the matching agent', () => {
    const game = useGameStore();
    const runId = game.startAgentActivityRun('message-2');
    game.updateAgentStatus('craft_gen', runId);

    game.recordAgentToolActivity(
      'craft_gen',
      'craft_check',
      { characterId: 'hidden' },
      { rating: '成功', diceRolls: [20] },
      runId,
    );

    expect(game.agentActivityRuns[0].steps[0].tools[0]).toMatchObject({
      label: '进行制作检定',
      detail: '结果：成功',
      status: 'completed',
    });
    expect(JSON.stringify(game.agentActivityRuns[0])).not.toContain('characterId');
    expect(JSON.stringify(game.agentActivityRuns[0])).not.toContain('diceRolls');
  });

  it('keeps a stopping run active until its owner finishes cleanup', () => {
    const game = useGameStore();
    const runId = game.startAgentActivityRun('message-3');
    game.updateAgentStatus('story', runId);

    game.markAgentActivityStopping(runId);
    expect(game.currentAgentActivityRun?.status).toBe('stopping');

    game.finishAgentActivityRun(runId, 'cancelled');
    expect(game.currentAgentActivityRun).toBeNull();
    expect(game.agentActivityRuns[0].steps[0].status).toBe('cancelled');
    expect(game.agentActivityRuns[0].failure).toBeUndefined();
  });

  // ===== GAME-05：失败原因留到界面上 =====

  it('步骤失败的原文脱敏后留在步骤上，回合收尾按它归类并带上中文步骤名', () => {
    const game = useGameStore();
    const runId = game.startAgentActivityRun('message-4');
    game.updateAgentStatus('story', runId);
    game.clearAgentStatus(
      'story',
      'HTTP 401: Incorrect API key provided: sk-live-abcdef123',
      runId,
    );

    const step = game.agentActivityRuns[0].steps[0];
    expect(step.status).toBe('failed');
    expect(step.error).toBe('HTTP 401: Incorrect API key provided: [已隐藏的密钥]');

    game.finishAgentActivityRun(runId, 'failed', '世界的回应在此中断。');
    expect(game.agentActivityRuns[0].failure).toEqual({
      category: 'auth',
      stepLabel: '书写此刻',
      detail: 'HTTP 401: Incorrect API key provided: [已隐藏的密钥]',
    });
  });

  it('回合级抛错优先归类，出错步骤取当时还在跑的那一步', () => {
    const game = useGameStore();
    const runId = game.startAgentActivityRun('message-5');
    game.updateAgentStatus('memory_recall', runId);
    game.clearAgentStatus('memory_recall', undefined, runId);
    game.updateAgentStatus('request_dispatcher', runId);

    game.finishAgentActivityRun(runId, 'failed', '中断', new Error('TypeError: Failed to fetch'));
    expect(game.agentActivityRuns[0].failure).toMatchObject({
      category: 'network',
      stepLabel: '辨认后续事件',
    });
  });

  it('既没有抛错也没有带原因的失败步骤 → 未知', () => {
    const game = useGameStore();
    const runId = game.startAgentActivityRun('message-6');
    game.finishAgentActivityRun(runId, 'failed', '中断');
    expect(game.agentActivityRuns[0].failure).toEqual({ category: 'unknown' });
  });
});
