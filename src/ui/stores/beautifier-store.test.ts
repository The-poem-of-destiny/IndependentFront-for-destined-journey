/**
 * beautifier-store 测试（Phase 0b）
 *
 * 两条主线：
 * 1. **CRUD 往返** —— ref 是 Dexie 的投影，重新 hydrate 必须一字不差拿回来。
 * 2. **settings 永不再承载规则内容** —— 这是整次迁移的目的。每个操作后都断言：
 *    settings 对象里没有 `beautifierRules` / `beautifierPresetRules` 键，
 *    序列化出来的 localStorage 也搜不到规则正文。写回去等于迁移白做。
 *
 * 预设规则 fetch 在 Node 下不可用，故 mock `@engine/beautifier` 的 loadPresetRules；
 * `mergeRules` / `processRules` 用真实实现（它们一律不动，只是数据来源变了）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { BeautifierRule } from '@engine/types';
import { getDatabase } from '@engine/database';

const presetPayload = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('@engine/beautifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/beautifier')>();
  return { ...actual, loadPresetRules: vi.fn(async () => presetPayload.value) };
});

import { useBeautifierStore } from './beautifier-store';
import { useSettingsStore } from './settings-store';
import { LEGACY_RULES_KEY, LEGACY_PRESET_CACHE_KEY } from './beautifier-migration';

// ===== 夹具 =====

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

// Q-18: 已迁出的历史键（worldBooks / beautifierRules / *MigratedAt）**刻意不在
//        `UiSettings` 上** —— 声明它们等于把「设置袋子还是真相来源」这条错觉还回去
//        （理由见 settings-types.ts 文件头）。迁移测试要按运行时字符串键读它们，
//        所以在这里显式放宽一次，而不是给类型开一个所有笔误都能钻的口子。
const loose = (s: unknown): Record<string, unknown> => s as Record<string, unknown>;

/** 迁移的目的：规则正文一个字节都不许再落在 settings / localStorage 里 */
function expectSettingsFreeOfRules(needles: string[] = []) {
  const s = useSettingsStore().settings;
  expect(loose(s)[LEGACY_RULES_KEY]).toBeUndefined();
  expect(loose(s)[LEGACY_PRESET_CACHE_KEY]).toBeUndefined();
  const serialized = JSON.stringify(s) + (lsBacking.get(STORAGE_KEY) ?? '');
  for (const needle of needles) {
    expect(serialized).not.toContain(needle);
  }
  expect(serialized).not.toContain('"replacement"');
}

describe('beautifier-store', () => {
  beforeEach(async () => {
    lsBacking.clear();
    presetPayload.value = [];
    await getDatabase().beautifierRules.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── CRUD 往返 ─────────────────────────────────────────
  it('upsertRule / deleteRule 往返: 先落库再更新 ref', async () => {
    const store = useBeautifierStore();
    await store.init();

    await store.upsertRule(makeRule('r1'));
    expect(store.userRules).toHaveLength(1);
    expect(await getDatabase().beautifierRules.count()).toBe(1);

    // 覆盖同 id 不产生第二行
    await store.upsertRule(makeRule('r1', { pattern: '改过的' }));
    expect(store.userRules).toHaveLength(1);
    expect(store.userRules[0].pattern).toBe('改过的');

    // 重新 hydrate 拿回同样的东西
    store.userRules = [];
    await store.hydrate();
    expect(store.userRules).toHaveLength(1);
    expect(store.userRules[0].pattern).toBe('改过的');

    await store.deleteRule('r1');
    expect(store.userRules).toHaveLength(0);
    expect(await getDatabase().beautifierRules.count()).toBe(0);

    expectSettingsFreeOfRules(['改过的', '«r1»']);
  });

  it('upsertRules 批量: 同 id 覆盖、否则追加', async () => {
    const store = useBeautifierStore();
    await store.init();
    await store.upsertRules([makeRule('a'), makeRule('b')]);
    expect(store.userRules).toHaveLength(2);

    await store.upsertRules([makeRule('b', { pattern: '覆盖b' }), makeRule('c')]);
    expect(store.userRules).toHaveLength(3);
    expect(store.userRules.find((r) => r.id === 'b')!.pattern).toBe('覆盖b');
    expect(await getDatabase().beautifierRules.count()).toBe(3);
    expectSettingsFreeOfRules(['覆盖b']);
  });

  it('replaceAllRules 整表替换', async () => {
    const store = useBeautifierStore();
    await store.init();
    await store.upsertRules([makeRule('a'), makeRule('b')]);
    await store.replaceAllRules([makeRule('z')]);
    expect(store.userRules.map((r) => r.id)).toEqual(['z']);
    expect((await getDatabase().beautifierRules.toArray()).map((r) => r.id)).toEqual(['z']);
  });

  it('toggleRule 翻转启用位并落库', async () => {
    const store = useBeautifierStore();
    await store.init();
    await store.upsertRule(makeRule('r1', { enabled: true }));
    await store.toggleRule('r1');
    expect(store.userRules[0].enabled).toBe(false);
    expect((await getDatabase().beautifierRules.get('r1'))!.enabled).toBe(false);
    expectSettingsFreeOfRules();
  });

  it('locked 是运行时字段，落库时被剥掉', async () => {
    const store = useBeautifierStore();
    await store.init();
    await store.upsertRule(makeRule('r1', { locked: true }));
    expect((await getDatabase().beautifierRules.get('r1'))!.locked).toBeUndefined();
  });

  // ── 启动顺序 + 迁移 ───────────────────────────────────
  it('init 顺序: 先迁移后加载预设 —— 预设规则不会被写回 localStorage', async () => {
    presetPayload.value = [
      makeRule('builtin-a', { isBuiltin: true, replacement: 'y'.repeat(20_000) }),
      makeRule('builtin-b', { isBuiltin: true, replacement: 'z'.repeat(20_000) }),
    ];

    // 老用户：localStorage 里既有自定义规则，也有那份 ~378 KB 的预设缓存
    lsBacking.set(
      STORAGE_KEY,
      JSON.stringify({
        [LEGACY_RULES_KEY]: [makeRule('my-rule', { pattern: '我的正则' })],
        [LEGACY_PRESET_CACHE_KEY]: presetPayload.value,
        beautifierBuiltinDisabled: ['builtin-b'],
      }),
    );
    setActivePinia(createPinia());

    const store = useBeautifierStore();
    await store.init();

    expect(store.lastMigration).toMatchObject({
      status: 'migrated',
      ruleCount: 1,
      presetCacheDropped: true,
    });
    // 用户规则搬进了 Dexie
    expect(store.userRules.map((r) => r.id)).toEqual(['my-rule']);
    expect(await getDatabase().beautifierRules.count()).toBe(1);
    // 预设规则在内存里算出来了（禁用列表照常生效 —— 它还住在 settings）
    expect(store.presetRules.map((r) => r.id)).toEqual(['builtin-a', 'builtin-b']);
    expect(store.presetRules.find((r) => r.id === 'builtin-b')!.enabled).toBe(false);
    // 但一个字节都没回到 localStorage，也没进 Dexie
    useSettingsStore().saveNow();
    expectSettingsFreeOfRules(['我的正则', 'yyyyyyyyyy']);
    expect((await getDatabase().beautifierRules.toArray()).map((r) => r.id)).toEqual(['my-rule']);
  });

  it('init 幂等: 并发/重复调用只跑一次', async () => {
    presetPayload.value = [makeRule('builtin-a', { isBuiltin: true })];
    const store = useBeautifierStore();
    await Promise.all([store.init(), store.init()]);
    await store.init();
    expect(store.presetRules).toHaveLength(1);
    expect(store.ready).toBe(true);
  });

  it('refreshPresetRules 传入存档信号时解析 autoEnable', async () => {
    presetPayload.value = [
      makeRule('auto', {
        isBuiltin: true,
        enabled: false,
        autoEnable: { worldBookEntryUids: [413] },
      }),
    ];
    const store = useBeautifierStore();
    await store.init();
    expect(store.presetRules[0].enabled).toBe(false);

    await store.refreshPresetRules(new Set(), new Set([413]), new Set());
    expect(store.presetRules[0].enabled).toBe(true);
    expect(store.presetRules[0].locked).toBe(true);
    // locked 是算出来的，仍然不许落进任何存储
    expectSettingsFreeOfRules();
  });
});
