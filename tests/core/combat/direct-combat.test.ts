/**
 * 直出跨楼战斗：存档旧状态与战斗状态合并时的文本时长互斥（状态树协议 §5.2）
 *
 * 存档状态带 durationText、战斗里改成数值时长 → 写回 / 投影后只剩数值时长。
 * 不去掉旧文本的话，落库时「文本与数值同给以文本为准」会把战斗改出的数值吞掉。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildDirectCombat,
  projectDirectCombatCharacters,
} from '../../../src/core/combat/direct-combat';
import {
  clearAllData,
  getCharacters,
  initializeDatabase,
  saveCharacter,
} from '../../../src/core/persistence/database';
import { createStateManager } from '../../../src/core/state/state-manager';
import { createDefaultCharacterState, type CharacterState } from '../../../src/core/types/types';

const SAVE = 'direct-combat-duration';

function player(): CharacterState {
  return createDefaultCharacterState({
    id: 'p',
    saveId: SAVE,
    name: '主角',
    type: 'player',
    hp: 80,
    maxHp: 100,
    statusEffects: [
      {
        name: '庇护',
        description: '神殿的庇护',
        category: '增益',
        stacks: 1,
        remainingTime: null,
        durationText: '直到离开城镇',
        timeUnit: '分钟',
        source: '',
        effects: {},
      },
    ],
  });
}

function output(phase: 'active' | 'ended') {
  return {
    meta: {
      round: phase === 'active' ? 1 : 2,
      combatType: '标准',
      environment: '街道',
      phase,
      ...(phase === 'ended' ? { outcome: 'ally_win' } : {}),
    },
    units: [
      {
        name: '主角',
        origin: 'save',
        side: 'ally',
        hp: 70,
        mp: 50,
        sp: 50,
        statusEffects: [
          { name: '庇护', category: '增益', stacks: 1, remainingTime: 3, timeUnit: '回合' },
        ],
      },
    ],
  };
}

beforeEach(async () => {
  await initializeDatabase();
  await clearAllData();
});

describe('直出战斗写回：文本时长被战斗改成数值时长', () => {
  it('进行中投影：remainingTime=3 且无 durationText', () => {
    const p = player();
    const active = buildDirectCombat(output('active') as any, null, [p], [], 'u');
    const fx = projectDirectCombatCharacters([p], active.record)[0].statusEffects[0];
    expect(fx.remainingTime).toBe(3);
    expect(fx.durationText).toBeUndefined();
  });

  it('终局写回落库：remainingTime=3 且无 durationText', async () => {
    const p = player();
    await saveCharacter(p);
    const active = buildDirectCombat(output('active') as any, null, [p], [], 'u');
    const end = buildDirectCombat(output('ended') as any, active.record, [p], [], 'v');
    const result = await createStateManager(SAVE).commitChatState(end.patches);
    expect(result.errors).toEqual([]);
    const fx = (await getCharacters(SAVE))[0].statusEffects.find((e) => e.name === '庇护')!;
    expect(fx.remainingTime).toBe(3);
    expect(fx.durationText).toBeUndefined();
  });
});
