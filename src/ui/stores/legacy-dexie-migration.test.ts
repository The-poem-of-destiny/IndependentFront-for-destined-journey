/**
 * legacy-dexie-migration 骨架专项测试（Q-08）
 *
 * 两个 adapter（worldbook / beautifier）各有 sibling 测试，覆盖各自的
 * `toRow` / `verifyRow` 语义与端到端六步。本文件只测**骨架自己**的分支，
 * 尤其是 adapter 那边够不到的两处：
 *   · `id 唯一化失效` 不变式守卫（正常路径下 dedupeById 保证撞不上）
 *   · `preStep` 改过 settings 后，每一条早退/失败分支都要补落盘
 */
import { describe, it, expect, vi } from 'vitest';
import { dedupeById, runLegacyMigration } from './legacy-dexie-migration';

interface Row {
  id: string;
  name: string;
  body: string;
}

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  name: `行-${id}`,
  body: `内容-${id}`,
  ...over,
});

/** 内存假表 —— 骨架只用到 bulkPut / bulkGet，事务由宿主给 */
function makeFakeTable(initial: Row[] = []) {
  const store = new Map<string, Row>(initial.map((r) => [r.id, r]));
  return {
    store,
    table: {
      bulkPut: vi.fn(async (rows: Row[]) => {
        for (const r of rows) store.set(r.id, r);
      }),
      bulkGet: vi.fn(async (ids: string[]) => ids.map((id) => store.get(id))),
    },
  };
}

function makeDb(opts: { throwOnTransaction?: boolean } = {}) {
  return {
    transaction: vi.fn(async (_mode: 'rw', _table: unknown, fn: () => Promise<unknown>) => {
      if (opts.throwOnTransaction) throw new Error('事务炸了');
      return fn();
    }),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function run(over: Record<string, any>) {
  const settings: Record<string, unknown> = over.settings ?? {};
  const persistSettings = over.persistSettings ?? vi.fn();
  const { table } = over.fake ?? makeFakeTable();
  return runLegacyMigration<Row>({
    flagKey: 'migratedAt',
    legacyKey: 'legacyRows',
    table: table as any,
    db: (over.db ?? makeDb()) as any,
    settings,
    persistSettings,
    unit: '行',
    nameOf: (r) => r.name,
    toRow: (r) => ({ ...r }),
    verifyRow: (expected, actual) => (actual.body === expected.body ? null : '正文不符'),
    ...over.opts,
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('dedupeById', () => {
  it('无碰撞时原样返回，不产生任何重命名', () => {
    const out = dedupeById([row('a'), row('b')], (r) => r.name);
    expect(out.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(out.renames).toEqual([]);
  });

  it('首个保留原 id（可能已被别处按 id 引用），后续递增编号', () => {
    const out = dedupeById([row('a'), row('a'), row('a')], (r) => r.name);
    expect(out.rows.map((r) => r.id)).toEqual(['a', 'a__dup2', 'a__dup3']);
    expect(out.renames).toEqual([
      { from: 'a', to: 'a__dup2', name: '行-a', sourceIndex: 1 },
      { from: 'a', to: 'a__dup3', name: '行-a', sourceIndex: 2 },
    ]);
  });

  it('新 id 本身被源里真实存在的行占着时，跳过它继续找', () => {
    const out = dedupeById([row('a'), row('a__dup2'), row('a')], (r) => r.name);
    expect(out.rows.map((r) => r.id)).toEqual(['a', 'a__dup2', 'a__dup3']);
  });

  it('一条内容都不丢 —— 撞 id 的两行内容完全一致时也是两行', () => {
    const out = dedupeById([row('a', { body: '同' }), row('a', { body: '同' })], (r) => r.name);
    expect(out.rows).toHaveLength(2);
    expect(out.rows.every((r) => r.body === '同')).toBe(true);
  });
});

describe('runLegacyMigration — 六步骨架', () => {
  it('正常路径：写库 → 回读通过 → 删源 + 置标志位（顺序不可颠倒）', async () => {
    const settings: Record<string, unknown> = { legacyRows: [row('a'), row('b')] };
    const persistSettings = vi.fn();
    const fake = makeFakeTable();

    const out = await run({ settings, persistSettings, fake });

    expect(out.status).toBe('migrated');
    expect(fake.store.size).toBe(2);
    expect(settings.legacyRows).toBeUndefined();
    expect(typeof settings.migratedAt).toBe('number');
    expect(persistSettings).toHaveBeenCalledTimes(1);
  });

  it('以显式标志位判定，不看表里有没有行', async () => {
    const settings: Record<string, unknown> = { migratedAt: 1, legacyRows: [row('a')] };
    const fake = makeFakeTable();

    const out = await run({ settings, fake });

    expect(out.status).toBe('already-migrated');
    expect(fake.table.bulkPut).not.toHaveBeenCalled();
    // 源原封不动 —— 幂等路径不许碰用户数据
    expect(settings.legacyRows).toHaveLength(1);
  });

  it('写库抛错：源完好、标志位不置，下次能重试', async () => {
    const settings: Record<string, unknown> = { legacyRows: [row('a')] };
    const persistSettings = vi.fn();

    const out = await run({
      settings,
      persistSettings,
      db: makeDb({ throwOnTransaction: true }),
    });

    expect(out).toMatchObject({ status: 'failed', stage: 'write' });
    expect(settings.legacyRows).toHaveLength(1);
    expect(settings.migratedAt).toBeUndefined();
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('回读缺行：判失败，源不删', async () => {
    const settings: Record<string, unknown> = { legacyRows: [row('a')] };
    const fake = makeFakeTable();
    fake.table.bulkGet = vi.fn(async () => [undefined]);

    const out = await run({ settings, fake });

    expect(out).toMatchObject({ status: 'failed', stage: 'verify' });
    expect(settings.legacyRows).toHaveLength(1);
  });

  it('verifyRow 说不符：判失败，源不删（校验强度是不留回滚副本的代价）', async () => {
    const settings: Record<string, unknown> = { legacyRows: [row('a')] };
    const fake = makeFakeTable();
    fake.table.bulkGet = vi.fn(async () => [row('a', { body: '被改坏了' })]);

    const out = await run({ settings, fake });

    expect(out).toMatchObject({ status: 'failed', stage: 'verify', message: '正文不符' });
    expect(settings.legacyRows).toHaveLength(1);
  });

  it('源里两行同 id：落两行、两份内容都在，且改名如实记账', async () => {
    // 这是整个骨架存在的理由。两行同 id 直接进 bulkPut 只会落一行，而回读按下标比对时
    // `bulkGet(['a','a'])` 会把同一行返回两次 —— 数量/ id /内容全对得上 → 校验通过
    // → 删 localStorage → 其中一行静默永久丢失。
    // 骨架里那道「id 唯一化失效」守卫是这条之后的第二层防线（dedupeById 正常时够不到，
    // 那正是守卫该有的样子），所以这里断的是外层这条真实可达的性质。
    const settings: Record<string, unknown> = {
      legacyRows: [row('a', { body: '第一份' }), row('a', { body: '第二份' })],
    };
    const fake = makeFakeTable();

    const out = await run({ settings, fake });

    expect(out.status).toBe('migrated');
    expect(fake.store.size).toBe(2);
    expect([...fake.store.values()].map((r) => r.body).sort()).toEqual(['第一份', '第二份']);
    expect((out as { renames: unknown[] }).renames).toEqual([
      { from: 'a', to: 'a__dup2', name: '行-a', sourceIndex: 1 },
    ]);
  });

  it('源不是数组（undefined / 被写坏）一律当空，不炸', async () => {
    for (const bad of [undefined, null, 'not-an-array', { a: 1 }]) {
      const settings: Record<string, unknown> = { legacyRows: bad };
      const out = await run({ settings });
      expect(out.status).toBe('migrated');
      expect(typeof settings.migratedAt).toBe('number');
    }
  });

  it('空源不清空表 —— 只搬源里有的行，绝不销毁 Dexie 里已有的内容', async () => {
    const settings: Record<string, unknown> = { legacyRows: [] };
    const fake = makeFakeTable([row('existing')]);

    const out = await run({ settings, fake });

    expect(out.status).toBe('migrated');
    expect(fake.store.has('existing')).toBe(true);
    expect(fake.table.bulkPut).not.toHaveBeenCalled();
  });
});

describe('runLegacyMigration — preStep 的旁路语义', () => {
  it('preStep 在标志位判定之前跑，且幂等路径也要落盘', async () => {
    const settings: Record<string, unknown> = { migratedAt: 1, cache: 'x' };
    const persistSettings = vi.fn();

    const out = await run({
      settings,
      persistSettings,
      opts: {
        preStep: () => {
          delete settings.cache;
          return true;
        },
      },
    });

    expect(out).toMatchObject({ status: 'already-migrated', preStepChanged: true });
    expect(settings.cache).toBeUndefined();
    expect(persistSettings).toHaveBeenCalledTimes(1);
  });

  it('迁移失败也不连累 preStep —— 两件事互不牵连', async () => {
    const settings: Record<string, unknown> = { legacyRows: [row('a')], cache: 'x' };
    const persistSettings = vi.fn();

    const out = await run({
      settings,
      persistSettings,
      db: makeDb({ throwOnTransaction: true }),
      opts: {
        preStep: () => {
          delete settings.cache;
          return true;
        },
      },
    });

    expect(out).toMatchObject({ status: 'failed', stage: 'write', preStepChanged: true });
    expect(settings.cache).toBeUndefined();
    expect(persistSettings).toHaveBeenCalledTimes(1); // 补上了这一次落盘
    expect(settings.legacyRows).toHaveLength(1); // 但用户数据仍原封不动
  });

  it('preStep 没改东西时不额外落盘', async () => {
    const settings: Record<string, unknown> = { migratedAt: 1 };
    const persistSettings = vi.fn();

    const out = await run({ settings, persistSettings, opts: { preStep: () => false } });

    expect(out).toMatchObject({ status: 'already-migrated', preStepChanged: false });
    expect(persistSettings).not.toHaveBeenCalled();
  });
});
