import { describe, expect, it, vi } from 'vitest';
import { createCombatAgentSessions, ensureCombatAgentClient } from './agent-session';
import type { ApiEndpoint } from '../types';

const hostEndpoint = { id: 'host', name: 'host' } as ApiEndpoint;
const enemyEndpoint = { id: 'enemy', name: 'enemy' } as ApiEndpoint;

describe('combat agent sessions', () => {
  it('host/enemy 使用独立消息、client 与会话 id，但共享同一 battle id', () => {
    const sessions = createCombatAgentSessions({
      battleId: 'battle-1',
      hostEndpoint,
      enemyEndpoint,
    });
    sessions.host.messages.push({ role: 'user', content: '玩家私有计划' });

    expect(sessions.enemy.messages).toEqual([]);
    expect(sessions.host.sessionId).not.toBe(sessions.enemy.sessionId);
    expect(sessions.host.endpoint.id).toBe('host');
    expect(sessions.enemy.endpoint.id).toBe('enemy');
  });

  it('敌方未被使用时不创建 client，首次使用后仅创建一次', () => {
    const sessions = createCombatAgentSessions({ battleId: 'battle-1', hostEndpoint });
    const factory = vi.fn(() => ({ chatWithTools: vi.fn() }) as never);
    expect(sessions.enemy.client).toBeNull();
    ensureCombatAgentClient(sessions.enemy, 'save', factory);
    ensureCombatAgentClient(sessions.enemy, 'save', factory);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith('combat_enemy', hostEndpoint, 'save');
  });

  it('dispose 后清空两份历史并拒绝在途旧代次结果', () => {
    const sessions = createCombatAgentSessions({ battleId: 'battle-1', hostEndpoint });
    const token = sessions.beginRequest('combat_enemy');
    sessions.host.messages.push({ role: 'user', content: 'host' });
    sessions.enemy.messages.push({ role: 'user', content: 'enemy' });
    sessions.dispose();

    expect(sessions.active).toBe(false);
    expect(sessions.accepts(token)).toBe(false);
    expect(sessions.host.messages).toEqual([]);
    expect(sessions.enemy.messages).toEqual([]);
  });
});
