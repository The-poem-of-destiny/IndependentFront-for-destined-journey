import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from './game-store';

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
  });
});
