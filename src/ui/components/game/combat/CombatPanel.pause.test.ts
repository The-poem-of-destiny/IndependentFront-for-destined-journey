import { describe, expect, it } from 'vitest';
import source from './CombatPanel.vue?raw';

describe('CombatPanel agent pause surface', () => {
  it('显示双角色暂停身份，并提供重试当前窗口与退出入口', () => {
    expect(source).toContain("game.combatAgentPause?.role === 'combat_enemy'");
    expect(source).toContain('敌方决策');
    expect(source).toContain('战斗主持人');
    expect(source).toContain("game.resumeCombatAgent('retry')");
    expect(source).toContain("game.resumeCombatAgent('exit')");
    expect(source).toContain('重试当前决策');
  });
});
