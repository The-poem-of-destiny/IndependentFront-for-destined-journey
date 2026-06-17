/**
 * death-system 单元测试 — 最小实现
 *
 * 覆盖: detectDeath / detectDeaths
 * 注: 复活机制（延迟/FP补偿/状态恢复）由 AI 叙事处理，不在此测试
 */

import { describe, it, expect } from 'vitest';
import { detectDeath, detectDeaths } from './death-system';
import { createDefaultCharacterState } from './types';
import type { CharacterState } from './types';

function makeChar(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({ id: 'test-1', name: 'Test', ...overrides });
}

describe('detectDeath', () => {
  it('HP=0 返回 true', () => {
    expect(detectDeath(makeChar({ hp: 0, maxHp: 100 }))).toBe(true);
  });

  it('HP<0 返回 true', () => {
    expect(detectDeath(makeChar({ hp: -5, maxHp: 100 }))).toBe(true);
  });

  it('HP>0 返回 false', () => {
    expect(detectDeath(makeChar({ hp: 1, maxHp: 100 }))).toBe(false);
  });

  it('满血 返回 false', () => {
    expect(detectDeath(makeChar({ hp: 100, maxHp: 100 }))).toBe(false);
  });
});

describe('detectDeaths', () => {
  it('只返回死亡角色', () => {
    const chars = [
      makeChar({ id: 'a', hp: 0, maxHp: 100 }),
      makeChar({ id: 'b', hp: 50, maxHp: 100 }),
      makeChar({ id: 'c', hp: 0, maxHp: 100 }),
    ];
    const dead = detectDeaths(chars);
    expect(dead).toHaveLength(2);
    expect(dead[0].id).toBe('a');
    expect(dead[1].id).toBe('c');
  });

  it('全部存活返回空数组', () => {
    const chars = [
      makeChar({ hp: 10 }),
      makeChar({ hp: 50 }),
    ];
    expect(detectDeaths(chars)).toHaveLength(0);
  });

  it('空数组返回空', () => {
    expect(detectDeaths([])).toHaveLength(0);
  });
});
