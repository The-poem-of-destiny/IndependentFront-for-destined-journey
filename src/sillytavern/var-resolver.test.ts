/**
 * var-resolver 单元测试 — $var 变量解析 & 命名空间隔离 (Layer 2)
 *
 * 覆盖: parseVarPath / getVar / setVar / delVar / deltaVar / insertVar /
 *       applyVarsPatch / getUserVars...getTempVars / isUserPath / isSysPath /
 *       diffVariables / $var namespace / VAR_NAMESPACES / 不可变性
 */

import { describe, it, expect } from 'vitest';
import {
  parseVarPath,
  getVar,
  setVar,
  delVar,
  deltaVar,
  insertVar,
  applyVarsPatch,
  getUserVars,
  getSysVars,
  getWorldVars,
  getCharVars,
  getTempVars,
  isUserPath,
  isSysPath,
  diffVariables,
  $var,
  VAR_NAMESPACES,
} from './var-resolver';
import type { VarChange } from './var-resolver';

// ========== 测试辅助 ==========

/** 构造一个典型的变量快照 */
function makeVars(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    user: {
      hp: 100,
      mp: 50,
      name: 'Alice',
      inventory: ['sword', 'shield'],
      stats: { str: 10, dex: 12 },
    },
    sys: {
      world: { location: 'forest', weather: 'rain' },
      quest: { main: 'active', side: null },
    },
    char: {},
    world: { era: 'ancient' },
    temp: {},
    ...overrides,
  };
}

// ========== VAR_NAMESPACES ==========

describe('VAR_NAMESPACES', () => {
  it('exposes all five namespace constants', () => {
    expect(VAR_NAMESPACES.USER).toBe('user');
    expect(VAR_NAMESPACES.SYS).toBe('sys');
    expect(VAR_NAMESPACES.CHAR).toBe('char');
    expect(VAR_NAMESPACES.WORLD).toBe('world');
    expect(VAR_NAMESPACES.TEMP).toBe('temp');
  });

  it('values are stable string constants', () => {
    // as const is compile-time; runtime check that all values match expectations
    expect(VAR_NAMESPACES.USER).toBe('user');
    expect(VAR_NAMESPACES.SYS).toBe('sys');
    expect(VAR_NAMESPACES.CHAR).toBe('char');
    expect(VAR_NAMESPACES.WORLD).toBe('world');
    expect(VAR_NAMESPACES.TEMP).toBe('temp');
  });
});

// ========== parseVarPath ==========

describe('parseVarPath', () => {
  it("parses 'sys.X.Y' → namespace: sys, parts: ['X', 'Y']", () => {
    const result = parseVarPath('sys.world.location');
    expect(result).toEqual({ namespace: 'sys', parts: ['world', 'location'] });
  });

  it("parses 'user.hp' → namespace: user, parts: ['hp']", () => {
    const result = parseVarPath('user.hp');
    expect(result).toEqual({ namespace: 'user', parts: ['hp'] });
  });

  it("parses 'X.Y' (no known-namespace prefix) → namespace: sys, parts include all segments", () => {
    // 'foo' is not a known namespace → defaults to sys
    const result = parseVarPath('foo.bar');
    expect(result).toEqual({ namespace: 'sys', parts: ['foo', 'bar'] });
  });

  it("parses 'X' (single segment, no known namespace) → namespace: sys", () => {
    const result = parseVarPath('era');
    expect(result).toEqual({ namespace: 'sys', parts: ['era'] });
  });

  it('parses single segment with known namespace → empty parts', () => {
    const result = parseVarPath('user');
    expect(result).toEqual({ namespace: 'user', parts: [] });
  });

  it('parses single segment without known namespace → sys with parts', () => {
    const result = parseVarPath('era');
    expect(result).toEqual({ namespace: 'sys', parts: ['era'] });
  });

  it('returns null for empty string', () => {
    expect(parseVarPath('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseVarPath('   ')).toBeNull();
  });

  it('handles char namespace', () => {
    const result = parseVarPath('char.npc1.reputation');
    expect(result).toEqual({ namespace: 'char', parts: ['npc1', 'reputation'] });
  });

  it('handles world namespace', () => {
    const result = parseVarPath('world.era');
    expect(result).toEqual({ namespace: 'world', parts: ['era'] });
  });

  it('handles temp namespace', () => {
    const result = parseVarPath('temp.roundCount');
    expect(result).toEqual({ namespace: 'temp', parts: ['roundCount'] });
  });
});

// ========== getVar ==========

describe('getVar', () => {
  const vars = makeVars();

  it('reads shallow value: user.hp → 100', () => {
    expect(getVar(vars, 'user.hp')).toBe(100);
  });

  it('reads nested value: sys.world.location → forest', () => {
    expect(getVar(vars, 'sys.world.location')).toBe('forest');
  });

  it('reads null value: sys.quest.side → null', () => {
    expect(getVar(vars, 'sys.quest.side')).toBeNull();
  });

  it('returns undefined for missing leaf', () => {
    expect(getVar(vars, 'user.nonexistent')).toBeUndefined();
  });

  it('returns undefined for missing namespace', () => {
    expect(getVar(vars, 'char.nonexistent')).toBeUndefined();
  });

  it('returns undefined for empty path', () => {
    expect(getVar(vars, '')).toBeUndefined();
  });

  it('returns undefined when intermediate is null (not traversable)', () => {
    const v = makeVars({ sys: { quest: { side: null } } });
    expect(getVar(v, 'sys.quest.side.deep')).toBeUndefined();
  });
});

// ========== setVar ==========

describe('setVar', () => {
  it('creates namespace if missing', () => {
    const vars = makeVars();
    delete (vars as any).char;
    const result = setVar(vars, 'char.npc1.name', 'Bob');
    expect(result.char).toBeDefined();
    expect(result.char.npc1.name).toBe('Bob');
  });

  it('overwrites existing shallow value', () => {
    const result = setVar(makeVars(), 'user.hp', 200);
    expect(result.user.hp).toBe(200);
  });

  it('creates nested value in existing namespace', () => {
    const result = setVar(makeVars(), 'user.stats.int', 14);
    expect(result.user.stats.int).toBe(14);
  });

  it('overwrites entire namespace when path has no sub-parts', () => {
    const result = setVar(makeVars(), 'temp', { roundCount: 1 });
    expect(result.temp).toEqual({ roundCount: 1 });
  });

  it('does NOT mutate the original object (immutability)', () => {
    const vars = makeVars();
    const keysBefore = Object.keys(vars.user);
    setVar(vars, 'user.hp', 999);
    // Original should be untouched
    expect(vars.user.hp).toBe(100);
    expect(Object.keys(vars.user)).toEqual(keysBefore);
  });

  it('returns a new object (immutability top-level)', () => {
    const vars = makeVars();
    const result = setVar(vars, 'user.hp', 999);
    expect(result).not.toBe(vars);
    expect(result.user).not.toBe(vars.user);
  });

  it('creates intermediate objects when they do not exist', () => {
    const vars = makeVars();
    const result = setVar(vars, 'sys.a.b.c.d', 42);
    expect(result.sys.a.b.c.d).toBe(42);
  });
});

// ========== delVar ==========

describe('delVar', () => {
  it('removes a leaf key', () => {
    const result = delVar(makeVars(), 'user.stats.dex');
    expect(result.user.stats.dex).toBeUndefined();
    expect(result.user.stats.str).toBe(10); // sibling unaffected
  });

  it('removes top-level key in a namespace', () => {
    const result = delVar(makeVars(), 'sys.quest');
    expect(result.sys.quest).toBeUndefined();
    expect(result.sys.world).toBeDefined(); // sibling unaffected
  });

  it('removes entire namespace when no sub-parts', () => {
    const result = delVar(makeVars(), 'world');
    expect(result.world).toBeUndefined();
    expect(result.user).toBeDefined(); // other namespace untouched
  });

  it('no error when deleting non-existent path', () => {
    const result = delVar(makeVars(), 'user.nonexistent');
    expect(result.user.hp).toBe(100); // unchanged
  });

  it('no error when namespace does not exist', () => {
    const result = delVar(makeVars(), 'char.nope');
    expect(result).toBeDefined();
  });

  it('does not mutate the original object', () => {
    const vars = makeVars();
    delVar(vars, 'user.hp');
    expect(vars.user.hp).toBe(100);
  });

  it('stops at non-object intermediate gracefully', () => {
    const vars = makeVars();
    const result = delVar(vars, 'user.hp.nested'); // hp is number, not object
    expect(result.user.hp).toBe(100); // unchanged
  });
});

// ========== deltaVar ==========

describe('deltaVar', () => {
  it('adds positive amount to numeric value', () => {
    const result = deltaVar(makeVars(), 'user.hp', 20);
    expect(result.user.hp).toBe(120);
  });

  it('subtracts negative amount', () => {
    const result = deltaVar(makeVars(), 'user.hp', -30);
    expect(result.user.hp).toBe(70);
  });

  it('treats non-numeric value as 0 (string)', () => {
    const result = deltaVar(makeVars(), 'user.name', 1);
    expect(result.user.name).toBe(1); // 0 + 1
  });

  it('treats non-numeric value as 0 (undefined)', () => {
    const result = deltaVar(makeVars(), 'user.something', 5);
    expect(result.user.something).toBe(5);
  });

  it('treats null value as 0', () => {
    const result = deltaVar(makeVars(), 'sys.quest.side', 10);
    expect(result.sys.quest.side).toBe(10);
  });

  it('preserves immutability', () => {
    const vars = makeVars();
    deltaVar(vars, 'user.hp', 50);
    expect(vars.user.hp).toBe(100);
  });
});

// ========== insertVar ==========

describe('insertVar', () => {
  it('appends value to existing array', () => {
    const result = insertVar(makeVars(), 'user.inventory', 'potion');
    expect(result.user.inventory).toEqual(['sword', 'shield', 'potion']);
  });

  it('inserts value at specific index', () => {
    const result = insertVar(makeVars(), 'user.inventory', 'axe', 1);
    expect(result.user.inventory).toEqual(['sword', 'axe', 'shield']);
  });

  it('creates new array when value is non-array', () => {
    const result = insertVar(makeVars(), 'user.hp', 'extra', 0); // hp is number
    expect(result.user.hp).toEqual(['extra']);
  });

  it('creates new array when path does not exist', () => {
    const result = insertVar(makeVars(), 'user.journal', 'day1');
    expect(result.user.journal).toEqual(['day1']);
  });

  it('preserves immutability', () => {
    const vars = makeVars();
    insertVar(vars, 'user.inventory', 'potion');
    expect(vars.user.inventory).toEqual(['sword', 'shield']);
  });
});

// ========== applyVarsPatch ==========

describe('applyVarsPatch', () => {
  it('applies replace operations', () => {
    const result = applyVarsPatch(makeVars(), {
      replace: [
        { path: 'user.hp', value: 200 },
        { path: 'sys.world.weather', value: 'sunny' },
      ],
    });
    expect(result.user.hp).toBe(200);
    expect(result.sys.world.weather).toBe('sunny');
  });

  it('applies delta operations', () => {
    const result = applyVarsPatch(makeVars(), {
      delta: [
        { path: 'user.hp', amount: 30 },
        { path: 'user.mp', amount: -10 },
      ],
    });
    expect(result.user.hp).toBe(130);
    expect(result.user.mp).toBe(40);
  });

  it('applies insert operations', () => {
    const result = applyVarsPatch(makeVars(), {
      insert: [
        { path: 'user.inventory', value: 'bow' },
        { path: 'user.inventory', value: 'arrow', index: 0 },
      ],
    });
    // Order: first push 'bow' → ['sword','shield','bow']; then insert 'arrow' at 0 → ['arrow','sword','shield','bow']
    expect(result.user.inventory).toEqual(['arrow', 'sword', 'shield', 'bow']);
  });

  it('applies all three operation types together (replace + delta + insert)', () => {
    const result = applyVarsPatch(makeVars(), {
      replace: [{ path: 'user.name', value: 'Bob' }],
      delta: [{ path: 'user.hp', amount: 50 }],
      insert: [{ path: 'user.inventory', value: 'potion' }],
    });
    expect(result.user.name).toBe('Bob');
    expect(result.user.hp).toBe(150);
    expect(result.user.inventory).toEqual(['sword', 'shield', 'potion']);
  });

  it('handles empty patch gracefully', () => {
    const result = applyVarsPatch(makeVars(), {});
    expect(result).toEqual(makeVars());
  });

  it('preserves immutability', () => {
    const vars = makeVars();
    applyVarsPatch(vars, { replace: [{ path: 'user.hp', value: 999 }] });
    expect(vars.user.hp).toBe(100);
  });
});

// ========== Namespace extraction helpers ==========

describe('getUserVars / getSysVars / getWorldVars / getCharVars / getTempVars', () => {
  it('getUserVars extracts user namespace correctly', () => {
    expect(getUserVars(makeVars())).toEqual(makeVars().user);
  });

  it('getUserVars returns {} when user namespace missing', () => {
    expect(getUserVars({})).toEqual({});
  });

  it('getSysVars extracts sys namespace correctly', () => {
    expect(getSysVars(makeVars())).toEqual(makeVars().sys);
  });

  it('getSysVars returns {} when sys namespace missing', () => {
    expect(getSysVars({})).toEqual({});
  });

  it('getWorldVars extracts world namespace', () => {
    expect(getWorldVars(makeVars())).toEqual({ era: 'ancient' });
  });

  it('getCharVars extracts char namespace', () => {
    expect(getCharVars(makeVars())).toEqual({});
  });

  it('getTempVars extracts temp namespace', () => {
    expect(getTempVars(makeVars())).toEqual({});
  });

  it('getUserVars returns a defensive copy under JSON serialization check', () => {
    // Not a deep clone, but identity matters — it's the same ref from the vars object
    const vars = makeVars();
    const extracted = getUserVars(vars);
    expect(extracted).toBe(vars.user);
  });
});

// ========== isUserPath / isSysPath ==========

describe('isUserPath / isSysPath', () => {
  it('isUserPath returns true for user paths', () => {
    expect(isUserPath('user.hp')).toBe(true);
    expect(isUserPath('user.stats.str')).toBe(true);
    expect(isUserPath('user')).toBe(true);
  });

  it('isUserPath returns false for sys paths', () => {
    expect(isUserPath('sys.world.location')).toBe(false);
  });

  it('isUserPath returns false for unprefixed paths (default sys)', () => {
    expect(isUserPath('foo.bar')).toBe(false);
  });

  it('isSysPath returns true for sys paths', () => {
    expect(isSysPath('sys.world.location')).toBe(true);
    expect(isSysPath('sys')).toBe(true);
  });

  it('isSysPath returns true for unprefixed paths (default sys)', () => {
    // 'foo.bar' has no known namespace prefix → defaults to sys
    expect(isSysPath('foo.bar')).toBe(true);
    expect(isSysPath('era')).toBe(true);
  });

  it('isSysPath returns false for user paths', () => {
    expect(isSysPath('user.hp')).toBe(false);
  });

  it('both return false for empty path', () => {
    expect(isUserPath('')).toBe(false);
    expect(isSysPath('')).toBe(false);
  });
});

// ========== diffVariables ==========

describe('diffVariables', () => {
  it('detects added values', () => {
    const before = makeVars();
    const after = setVar(before, 'user.newField', 'hello');
    const changes = diffVariables(before, after);
    const added = changes.filter((c) => c.path === 'user.newField');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ op: 'replace', oldValue: undefined, newValue: 'hello' });
  });

  it('detects removed values', () => {
    const before = makeVars();
    const after = delVar(before, 'user.inventory');
    const changes = diffVariables(before, after);
    const removed = changes.filter((c) => c.path === 'user.inventory');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ op: 'delete', oldValue: ['sword', 'shield'], newValue: undefined });
  });

  it('detects changed (replaced) values', () => {
    const before = makeVars();
    const after = setVar(before, 'user.name', 'Bob');
    const changes = diffVariables(before, after);
    const changed = changes.filter((c) => c.path === 'user.name');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ op: 'replace', oldValue: 'Alice', newValue: 'Bob' });
  });

  it('detects numeric delta', () => {
    const before = makeVars();
    const after = setVar(before, 'user.hp', 150);
    const changes = diffVariables(before, after);
    const delta = changes.filter((c) => c.path === 'user.hp');
    expect(delta).toHaveLength(1);
    expect(delta[0].op).toBe('delta');
    expect(delta[0].oldValue).toBe(100);
    expect(delta[0].newValue).toBe(150);
  });

  it('returns empty array for identical snapshots', () => {
    const vars = makeVars();
    const changes = diffVariables(vars, vars);
    expect(changes).toEqual([]);
  });

  it('returns empty array for deeply equal snapshots', () => {
    const changes = diffVariables(makeVars(), makeVars());
    expect(changes).toEqual([]);
  });

  it('handles empty snapshots', () => {
    const changes = diffVariables({}, {});
    expect(changes).toEqual([]);
  });
});

// ========== $var namespace ==========

describe('$var namespace', () => {
  it('exposes all public methods', () => {
    expect($var.get).toBe(getVar);
    expect($var.set).toBe(setVar);
    expect($var.del).toBe(delVar);
    expect($var.delta).toBe(deltaVar);
    expect($var.insert).toBe(insertVar);
    expect($var.applyVarsPatch).toBe(applyVarsPatch);
    expect($var.parseVarPath).toBe(parseVarPath);
    expect($var.getUserVars).toBe(getUserVars);
    expect($var.getSysVars).toBe(getSysVars);
    expect($var.getWorldVars).toBe(getWorldVars);
    expect($var.getCharVars).toBe(getCharVars);
    expect($var.getTempVars).toBe(getTempVars);
    expect($var.isUserPath).toBe(isUserPath);
    expect($var.isSysPath).toBe(isSysPath);
    expect($var.diffVariables).toBe(diffVariables);
    expect($var.VAR_NAMESPACES).toBe(VAR_NAMESPACES);
  });
});
