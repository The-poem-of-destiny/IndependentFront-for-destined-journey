/**
 * settlement.commit.test.ts —— 战斗终局结算真实落库（真实 StateManager + fake-indexeddb）
 *
 * 回归（第 1 波审查）：内核静态校验拒收非有限 remainingTime，而终局结算是一次原子
 * commitDomainCommand；任何一条带脏时长的 add_status_effect 都会让整场结算（资源 / 状态 /
 * 经验）一起丢掉。沙盒在出口与工具入口把非有限时长归 null（无时长）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  getCharacters,
  initializeDatabase,
  saveCharacter,
} from '../../../../src/core/persistence/database';
import { createStateManager } from '../../../../src/core/state/state-manager';
import { createDefaultCharacterState } from '../../../../src/core/types/types';
import type { StatusEffect } from '../../../../src/core/types/types';
import { buildCombatSettlementPatches } from '../../../../src/core/combat/sandbox/settlement';
import { applyOps, createCombatState } from '../../../../src/core/combat/sandbox/state';
import { executeCombatTool } from '../../../../src/core/combat/sandbox/tools';

const saveId = 'combat-settle';

function dirtyStatus(name: string, remainingTime: unknown): StatusEffect {
  return {
    name,
    description: name,
    category: '减益',
    stacks: 1,
    remainingTime: remainingTime as number,
    timeUnit: '回合',
    source: '旧档',
    effects: {},
  };
}

function makeChar() {
  return createDefaultCharacterState({
    id: 'p',
    saveId,
    name: '艾莉丝',
    type: 'player',
    hp: 100,
    maxHp: 200,
    mp: 30,
    maxMp: 60,
    sp: 10,
    maxSp: 40,
    statusEffects: [
      dirtyStatus('诅咒', Number.NaN),
      dirtyStatus('灼烧', '3回合'),
      dirtyStatus('中毒', 2),
    ],
  });
}

beforeEach(async () => {
  await initializeDatabase();
  await clearAllData();
  await saveCharacter(makeChar());
});

describe('战斗终局结算：带脏时长状态整批落库', () => {
  it('存档已有 NaN / 字符串时长的状态，结算整批成功且时长归 null', async () => {
    const saved = (await getCharacters(saveId))[0];
    const state = createCombatState({ combatants: [{ character: saved, side: 'ally' }] });
    const finalState = applyOps(state, '艾莉丝', [{ op: 'set', field: 'hp', value: 77 }]);
    // DM 传 "3回合" 这种文本时长：工具入口归 null，不让 NaN 进战斗状态
    await executeCombatTool(
      'combat_add_status',
      { name: '艾莉丝', status: { name: '眩晕', remainingTime: '3回合' } },
      finalState,
    );
    expect(
      finalState.units['艾莉丝'].statusEffects.find((f) => f.name === '眩晕')?.remainingTime,
    ).toBeNull();

    const patches = buildCombatSettlementPatches(finalState, [saved], {
      expByUnit: { 艾莉丝: 50 },
    });
    // 原子批：有一条被拒就整批回滚，这里必须整批成功
    await createStateManager(saveId).commitDomainCommand(patches);

    const after = (await getCharacters(saveId))[0];
    expect(after.hp).toBe(77);
    const byName = new Map(after.statusEffects.map((fx) => [fx.name, fx.remainingTime]));
    expect(byName.get('诅咒')).toBeNull();
    expect(byName.get('灼烧')).toBeNull();
    expect(byName.get('眩晕')).toBeNull();
    expect(byName.get('中毒')).toBe(2);
  });
});
