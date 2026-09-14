import { describe, expect, it } from 'vitest';
import {
  CombatAuthorizationError,
  authorizeCombatToolCall,
  resolveAuthorizedActorName,
  resolveAuthorizedTargetName,
  toolsForCombatDecision,
  type CombatDecisionContext,
} from './agent-permissions';
import { createCombatState, toView } from './state';
import { mkBundle } from './test-utils';

function context(overrides: Partial<CombatDecisionContext> = {}): CombatDecisionContext {
  return {
    logicalRole: 'combat_enemy',
    agentId: 'combat_enemy',
    battleId: 'combat-test',
    sessionId: 'combat-test:enemy',
    decisionWindowId: 'combat-test:enemy:0:乙',
    phase: 'enemy_decision',
    sourceRevision: 0,
    authorizedActorId: '乙',
    allowedCommandKinds: [
      'DeclareAttack',
      'DeclareAction',
      'PassAttack',
      'PassAction',
      'Flee',
      'EndTurn',
    ],
    ...overrides,
  };
}

describe('combat agent permissions', () => {
  const view = toView(createCombatState(mkBundle()));

  it('敌方决策工具面没有摘要和有界裁决写入口', () => {
    const tools = toolsForCombatDecision(context());
    expect(tools).toContain('declare_attack');
    expect(tools).toContain('get_combat_state');
    expect(tools).not.toContain('write_summary');
    expect(tools).not.toContain('submit_adjudication');
  });

  it('actorName 缺席绑定当前 actor，提供时只接受精确展示名', () => {
    expect(resolveAuthorizedActorName(context(), view, undefined)).toBe('乙');
    expect(resolveAuthorizedActorName(context(), view, '乙')).toBe('乙');
    expect(() => resolveAuthorizedActorName(context(), view, '甲')).toThrowError(
      CombatAuthorizationError,
    );
    expect(() => resolveAuthorizedActorName(context(), view, ' 乙 ')).not.toThrow();
    expect(() => resolveAuthorizedActorName(context(), view, '乙队长')).toThrowError(
      CombatAuthorizationError,
    );
  });

  it('攻击目标必须是当前 actor 的存活对方单位', () => {
    expect(resolveAuthorizedTargetName(context(), view, '甲')).toBe('甲');
    expect(() => resolveAuthorizedTargetName(context(), view, '乙')).toThrowError(
      CombatAuthorizationError,
    );
    expect(() => resolveAuthorizedTargetName(context(), view, '不存在')).toThrowError(
      CombatAuthorizationError,
    );
  });

  it('逐调用拒绝越权工具和伪造 actor', () => {
    expect(() =>
      authorizeCombatToolCall(
        context(),
        'declare_attack',
        { actorName: '乙', targetName: '甲' },
        view,
      ),
    ).not.toThrow();
    expect(() =>
      authorizeCombatToolCall(context(), 'write_summary', { text: '越权' }, view),
    ).toThrowError(CombatAuthorizationError);
    expect(() =>
      authorizeCombatToolCall(
        context(),
        'declare_attack',
        { actorName: '甲', targetName: '乙' },
        view,
      ),
    ).toThrowError(CombatAuthorizationError);
  });
});
