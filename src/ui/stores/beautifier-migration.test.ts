/**
 * beautifier-migration 专项测试（Phase 0b）
 *
 * 照 Phase 0 世界书迁移那套标准写：失败注入用 `vi.spyOn` 打真 Dexie 表，
 * 「事务中途抛错」走的是真实回滚而不是假 db 假装回滚过。
 *
 * 三个字段分别处置，各自都有断言：
 *   · beautifierRules        → 进 Dexie，六步保护
 *   · beautifierPresetRules  → 无条件丢弃（派生缓存，~378 KB 净收益）
 *   · beautifierBuiltinDisabled → 原地不动
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BeautifierRule } from '@engine/types';
import { getDatabase } from '@engine/database';
import {
  migrateBeautifierRulesToDexie,
  RULES_MIGRATED_FLAG_KEY,
  LEGACY_RULES_KEY,
  LEGACY_PRESET_CACHE_KEY,
} from './beautifier-migration';

// ===== 夹具 =====

function makeRule(id: string, overrides: Partial<BeautifierRule> = {}): BeautifierRule {
  return {
    id,
    name: `规则-${id}`,
    scope: 'maintext',
    pattern: `«${id}»`,
    flags: 'gm',
    replacement: `<span class="${id}">$&</span>`,
    enabled: true,
    order: 10,
    isBuiltin: false,
    ...overrides,
  };
}

/** 假装是内置预设规则里那种巨大的一条（真实单条 replacement 可达 340 KB） */
function makeFatPresetRule(id: string): BeautifierRule {
  return makeRule(id, { isBuiltin: true, replacement: 'x'.repeat(20_000) });
}

const STORAGE_KEY = 'fated-poem-settings';
const lsBacking = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsBacking.get(k) ?? null,
  setItem: (k: string, v: string) => void lsBacking.set(k, v),
  removeItem: (k: string) => void lsBacking.delete(k),
  clear: () => lsBacking.clear(),
  get length() {
    return lsBacking.size;
  },
  key: (i: number) => [...lsBacking.keys()][i] ?? null,
});

interface HarnessInit {
  rules?: BeautifierRule[];
  presetCache?: BeautifierRule[];
  builtinDisabled?: string[];
}

function makeSettingsHarness(init: HarnessInit = {}) {
  const settings: Record<string, unknown> = { beautifierEnabled: true };
  if (init.rules !== undefined) settings[LEGACY_RULES_KEY] = init.rules;
  if (init.presetCache !== undefined) settings[LEGACY_PRESET_CACHE_KEY] = init.presetCache;
  if (init.builtinDisabled !== undefined)
    settings.beautifierBuiltinDisabled = init.builtinDisabled;
  const persistSettings = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  };
  persistSettings(); // 起点：localStorage 里确实有一份副本
  return { settings, persistSettings };
}

function readLocalStorage(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
}

describe('beautifier-migration (Phase 0b)', () => {
  beforeEach(async () => {
    lsBacking.clear();
    await getDatabase().beautifierRules.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. 正常迁移 ────────────────────────────────────────
  it('正常迁移: 规则完整 · localStorage 的 beautifierRules 消失 · 标志位置位', async () => {
    const source = [makeRule('r1'), makeRule('r2', { scope: 'global', enabled: false })];
    const h = makeSettingsHarness({ rules: source });

    const out = await migrateBeautifierRulesToDexie(h);

    expect(out).toMatchObject({ status: 'migrated', ruleCount: 2, renames: [] });

    const rows = await getDatabase().beautifierRules.toArray();
    expect(rows).toHaveLength(2);
    // 逐字保真，不是只对上了数量
    expect(rows.find((r) => r.id === 'r1')!.pattern).toBe('«r1»');
    expect(rows.find((r) => r.id === 'r2')!.replacement).toBe('<span class="r2">$&</span>');
    expect(rows.find((r) => r.id === 'r2')!.enabled).toBe(false);

    expect(h.settings[LEGACY_RULES_KEY]).toBeUndefined();
    expect(typeof h.settings[RULES_MIGRATED_FLAG_KEY]).toBe('number');
    const persisted = readLocalStorage();
    expect(persisted[LEGACY_RULES_KEY]).toBeUndefined();
    expect(persisted.beautifierEnabled).toBe(true); // 其余设置不受影响
  });

  it('locked 是运行时字段，不落库', async () => {
    const h = makeSettingsHarness({ rules: [makeRule('r1', { locked: true })] });
    await migrateBeautifierRulesToDexie(h);
    const row = await getDatabase().beautifierRules.get('r1');
    expect(row!.locked).toBeUndefined();
  });

  // ── 2. 事务中途抛错 ────────────────────────────────────
  it('事务中途抛错: Dexie 无残留 · localStorage 完好 · 标志位未置 · 重跑能成功', async () => {
    const source = [makeRule('r1'), makeRule('r2')];
    const h = makeSettingsHarness({ rules: source });
    const db = getDatabase();

    // 真写进去了，然后在同一个事务里炸 —— 靠 Dexie 自己回滚
    const realBulkPut = db.beautifierRules.bulkPut.bind(db.beautifierRules);
    const spy = vi.spyOn(db.beautifierRules, 'bulkPut').mockImplementation((async (
      rows: readonly BeautifierRule[],
    ) => {
      await realBulkPut(rows);
      throw new Error('模拟写入中途失败');
    }) as never);

    const failed = await migrateBeautifierRulesToDexie(h);
    expect(failed).toMatchObject({ status: 'failed', stage: 'write' });

    expect(await db.beautifierRules.count()).toBe(0);
    expect(h.settings[LEGACY_RULES_KEY]).toBe(source);
    expect(h.settings[RULES_MIGRATED_FLAG_KEY]).toBeUndefined();
    expect(readLocalStorage()[LEGACY_RULES_KEY]).toHaveLength(2);

    // 重跑能成功
    spy.mockRestore();
    const retry = await migrateBeautifierRulesToDexie(h);
    expect(retry).toMatchObject({ status: 'migrated', ruleCount: 2 });
    expect(await db.beautifierRules.count()).toBe(2);
    expect(readLocalStorage()[LEGACY_RULES_KEY]).toBeUndefined();
  });

  // ── 3. 校验失败 ────────────────────────────────────────
  it('校验失败(回读数量不符): 不删 localStorage · 不置标志位', async () => {
    const source = [makeRule('r1'), makeRule('r2')];
    const h = makeSettingsHarness({ rules: source });
    const db = getDatabase();
    const realGet = db.beautifierRules.get.bind(db.beautifierRules);
    vi.spyOn(db.beautifierRules, 'bulkGet').mockImplementation((async () => [
      await realGet('r1'),
    ]) as never);

    const out = await migrateBeautifierRulesToDexie(h);
    expect(out).toMatchObject({ status: 'failed', stage: 'verify' });
    expect(h.settings[LEGACY_RULES_KEY]).toBe(source);
    expect(h.settings[RULES_MIGRATED_FLAG_KEY]).toBeUndefined();
    expect(readLocalStorage()[LEGACY_RULES_KEY]).toHaveLength(2);
  });

  it('校验失败(pattern 被改坏): 不删 localStorage · 不置标志位', async () => {
    const h = makeSettingsHarness({ rules: [makeRule('r1')] });
    const db = getDatabase();
    vi.spyOn(db.beautifierRules, 'bulkGet').mockImplementation((async () => [
      makeRule('r1', { pattern: '被改坏了' }),
    ]) as never);

    const out = await migrateBeautifierRulesToDexie(h);
    expect(out).toMatchObject({ status: 'failed', stage: 'verify' });
    expect(h.settings[RULES_MIGRATED_FLAG_KEY]).toBeUndefined();
    expect(readLocalStorage()[LEGACY_RULES_KEY]).toHaveLength(1);
  });

  // ── 4. 幂等 ────────────────────────────────────────────
  it('已迁移状态重复启动: 幂等，不重复写', async () => {
    const h = makeSettingsHarness({ rules: [makeRule('r1')] });
    await migrateBeautifierRulesToDexie(h);
    const db = getDatabase();
    const before = await db.beautifierRules.get('r1');

    h.settings[LEGACY_RULES_KEY] = [makeRule('r1', { pattern: '脏数据' })];
    const putSpy = vi.spyOn(db.beautifierRules, 'bulkPut');

    const out = await migrateBeautifierRulesToDexie(h);

    expect(out).toMatchObject({ status: 'already-migrated' });
    expect(putSpy).not.toHaveBeenCalled();
    expect(await db.beautifierRules.get('r1')).toEqual(before);
  });

  it('以显式标志位判定，而非「表里有没有行」', async () => {
    const db = getDatabase();
    await db.beautifierRules.put(makeRule('r1', { pattern: '上一轮的残留' }));
    const h = makeSettingsHarness({ rules: [makeRule('r1')] });

    const out = await migrateBeautifierRulesToDexie(h);

    expect(out).toMatchObject({ status: 'migrated', ruleCount: 1 });
    expect((await db.beautifierRules.get('r1'))!.pattern).toBe('«r1»'); // 源覆盖残留
  });

  // ── 5. 空 / 缺失源 ─────────────────────────────────────
  it('空规则(全新用户): 不炸，标志位置位', async () => {
    const h = makeSettingsHarness({ rules: [] });
    const out = await migrateBeautifierRulesToDexie(h);
    expect(out).toMatchObject({ status: 'migrated', ruleCount: 0, renames: [] });
    expect(typeof h.settings[RULES_MIGRATED_FLAG_KEY]).toBe('number');
  });

  it('压根没有 beautifierRules 键: 不炸', async () => {
    const h = makeSettingsHarness({});
    const out = await migrateBeautifierRulesToDexie(h);
    expect(out).toMatchObject({ status: 'migrated', ruleCount: 0 });
  });

  it('空源迁移不清空 Dexie 已有的行', async () => {
    const db = getDatabase();
    await db.beautifierRules.put(makeRule('keepme'));
    const h = makeSettingsHarness({ rules: [] });
    await migrateBeautifierRulesToDexie(h);
    expect(await db.beautifierRules.count()).toBe(1);
  });

  // ── 6. id 碰撞 ─────────────────────────────────────────
  describe('规则 id 碰撞: 保内容优先，不静默合并', () => {
    it('两条同 id: Dexie 落 2 行 · 内容都在 · 首条 id 不变', async () => {
      const a = makeRule('dup', { pattern: '第一条' });
      const b = makeRule('dup', { pattern: '第二条', name: '重名的第二条' });
      const h = makeSettingsHarness({ rules: [a, b] });

      const out = await migrateBeautifierRulesToDexie(h);

      expect(out).toMatchObject({
        status: 'migrated',
        ruleCount: 2,
        renames: [{ from: 'dup', to: 'dup__dup2', name: '重名的第二条', sourceIndex: 1 }],
      });
      const db = getDatabase();
      expect(await db.beautifierRules.count()).toBe(2);
      expect((await db.beautifierRules.get('dup'))!.pattern).toBe('第一条');
      expect((await db.beautifierRules.get('dup__dup2'))!.pattern).toBe('第二条');
    });

    it('两条同 id 且内容完全一致(重复导入同一文件): 仍然两行都在', async () => {
      // 最阴险的一档：pattern/replacement 都相同 → 逐条比对每项都对得上 → 老写法静默丢一条
      const h = makeSettingsHarness({ rules: [makeRule('dup'), makeRule('dup')] });
      const out = await migrateBeautifierRulesToDexie(h);
      expect(out).toMatchObject({ status: 'migrated', ruleCount: 2 });
      expect(await getDatabase().beautifierRules.count()).toBe(2);
    });

    it('三条同 id: 编号递增，互不再碰撞', async () => {
      const h = makeSettingsHarness({
        rules: [
          makeRule('dup', { pattern: 'p1' }),
          makeRule('dup', { pattern: 'p2' }),
          makeRule('dup', { pattern: 'p3' }),
        ],
      });
      const out = await migrateBeautifierRulesToDexie(h);
      expect(out).toMatchObject({ status: 'migrated', ruleCount: 3 });
      const db = getDatabase();
      expect((await db.beautifierRules.get('dup'))!.pattern).toBe('p1');
      expect((await db.beautifierRules.get('dup__dup2'))!.pattern).toBe('p2');
      expect((await db.beautifierRules.get('dup__dup3'))!.pattern).toBe('p3');
    });

    it('新 id 本身也可能被占用: 跳过已存在的 __dup2', async () => {
      const h = makeSettingsHarness({
        rules: [
          makeRule('dup', { pattern: 'p1' }),
          makeRule('dup__dup2', { pattern: '真的叫这个' }),
          makeRule('dup', { pattern: 'p3' }),
        ],
      });
      const out = await migrateBeautifierRulesToDexie(h);
      expect((out as { renames: { to: string }[] }).renames).toEqual([
        { from: 'dup', to: 'dup__dup3', name: '规则-dup', sourceIndex: 2 },
      ]);
      const db = getDatabase();
      expect((await db.beautifierRules.get('dup__dup2'))!.pattern).toBe('真的叫这个');
      expect((await db.beautifierRules.get('dup__dup3'))!.pattern).toBe('p3');
    });

    it('无碰撞的正常路径不产生任何重命名', async () => {
      const h = makeSettingsHarness({ rules: [makeRule('a'), makeRule('b')] });
      const out = await migrateBeautifierRulesToDexie(h);
      expect(out).toMatchObject({ status: 'migrated', ruleCount: 2, renames: [] });
      expect(await getDatabase().beautifierRules.get('a__dup2')).toBeUndefined();
    });
  });

  // ── 7. 预设缓存：彻底不再持久化 ────────────────────────
  describe('beautifierPresetRules: 派生缓存无条件丢弃', () => {
    it('迁移后 presetRules 不再进 localStorage', async () => {
      const fat = [makeFatPresetRule('p1'), makeFatPresetRule('p2')];
      const h = makeSettingsHarness({ rules: [makeRule('r1')], presetCache: fat });

      const before = (lsBacking.get(STORAGE_KEY) ?? '').length;
      const out = await migrateBeautifierRulesToDexie(h);

      expect(out).toMatchObject({ status: 'migrated', presetCacheDropped: true });
      expect(h.settings[LEGACY_PRESET_CACHE_KEY]).toBeUndefined();
      expect(readLocalStorage()[LEGACY_PRESET_CACHE_KEY]).toBeUndefined();
      // 真的瘦下来了，不是只把键名挪走
      expect((lsBacking.get(STORAGE_KEY) ?? '').length).toBeLessThan(before - 39_000);
      // 也没被顺手塞进 Dexie —— 它不该有任何持久化落点
      const rows = await getDatabase().beautifierRules.toArray();
      expect(rows.map((r) => r.id)).toEqual(['r1']);
    });

    it('已迁移状态下仍会丢弃后来又被写回的预设缓存', async () => {
      const h = makeSettingsHarness({ rules: [makeRule('r1')] });
      await migrateBeautifierRulesToDexie(h);
      // 模拟旧版本代码/老 localStorage 又把缓存塞了回来
      h.settings[LEGACY_PRESET_CACHE_KEY] = [makeFatPresetRule('p1')];

      const out = await migrateBeautifierRulesToDexie(h);

      expect(out).toEqual({ status: 'already-migrated', presetCacheDropped: true });
      expect(readLocalStorage()[LEGACY_PRESET_CACHE_KEY]).toBeUndefined();
    });

    it('用户规则迁移失败时，预设缓存仍然被丢弃(两件事互不牵连)', async () => {
      const h = makeSettingsHarness({
        rules: [makeRule('r1')],
        presetCache: [makeFatPresetRule('p1')],
      });
      const db = getDatabase();
      vi.spyOn(db.beautifierRules, 'bulkPut').mockImplementation((async () => {
        throw new Error('写不进去');
      }) as never);

      const out = await migrateBeautifierRulesToDexie(h);

      expect(out).toMatchObject({ status: 'failed', presetCacheDropped: true });
      // 派生缓存删了（零损失），但真源数据一根汗毛没动
      expect(readLocalStorage()[LEGACY_PRESET_CACHE_KEY]).toBeUndefined();
      expect(readLocalStorage()[LEGACY_RULES_KEY]).toHaveLength(1);
      expect(h.settings[RULES_MIGRATED_FLAG_KEY]).toBeUndefined();
    });

    it('没有预设缓存时 presetCacheDropped 为 false', async () => {
      const h = makeSettingsHarness({ rules: [] });
      const out = await migrateBeautifierRulesToDexie(h);
      expect(out).toMatchObject({ presetCacheDropped: false });
    });
  });

  // ── 8. 老用户端到端 ───────────────────────────────────
  it('老用户(自定义规则 + 禁用的内置规则): 迁移后行为完全不变', async () => {
    const userRules = [
      makeRule('my-dialogue', { order: 1 }),
      makeRule('my-emphasis', { order: 2, scope: 'global' }),
    ];
    const h = makeSettingsHarness({
      rules: userRules,
      presetCache: [makeFatPresetRule('builtin-dialogue-card')],
      builtinDisabled: ['builtin-kill-proliferation'],
    });

    const out = await migrateBeautifierRulesToDexie(h);
    expect(out).toMatchObject({ status: 'migrated', ruleCount: 2, renames: [] });

    // 用户规则一条不少、字段一个不改（除运行时的 locked）
    const rows = (await getDatabase().beautifierRules.toArray()).sort((a, b) => a.order - b.order);
    expect(rows.map((r) => r.id)).toEqual(['my-dialogue', 'my-emphasis']);
    expect(rows[1].scope).toBe('global');

    // 禁用列表原地不动 —— 它没被迁移，也不该被迁移动到
    expect(h.settings.beautifierBuiltinDisabled).toEqual(['builtin-kill-proliferation']);
    expect(readLocalStorage().beautifierBuiltinDisabled).toEqual(['builtin-kill-proliferation']);
    // 开关也没被误伤
    expect(readLocalStorage().beautifierEnabled).toBe(true);
  });
});
