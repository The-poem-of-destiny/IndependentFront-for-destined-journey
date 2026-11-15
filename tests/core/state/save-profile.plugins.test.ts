/**
 * save-profile.ts —— 插件存档数据的命名写入口（插件系统设计 §3.5 / §5.6 / §5.8）。
 *
 * 钉的契约：
 *   ① 每个写入口进 `withSaveWriteLock` 并在锁内重读 profile、只改插件那两格 ——
 *      提交期间落下的 fp / 别的 worldFlags / 别的插件的格子一格不丢；
 *   ② 运行态守卫（BUSY / IN_COMBAT）在**锁内**再问一次；
 *   ③ 配额：每插件 256KB、提示块 4000 字、告知 2000 字、队列 16 条；
 *   ④ 清除幂等、只清自己；提示词输入只收已启用插件。
 *
 * Uses fake-indexeddb (injected via tests/setup.ts)；写队列用真的 `state-write-queue`。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  getSaveProfile,
  initializeDatabase,
  saveSaveProfile,
} from '../../../src/core/persistence/database';
import {
  clearPluginNotesForTurn,
  clearPluginSaveData,
  enqueuePluginNote,
  getPluginSaveBag,
  getProfile,
  readPluginPromptInputs,
  setPluginContext,
  writePluginSaveKv,
} from '../../../src/core/state/save-profile';
import { withSaveWriteLock } from '../../../src/core/state/state-write-queue';
import { PLUGIN_LIMITS } from '../../../src/core/plugins/plugin-surface';
import type { PluginRunGuard } from '../../../src/core/types/types-plugin';

const SAVE = 'save_plugins';
const OK: PluginRunGuard = () => 'ok';

beforeEach(async () => {
  await clearAllData();
  await initializeDatabase();
  await getProfile(SAVE);
});

/** 占住写锁，返回放行函数与锁段 promise */
function holdLock(saveId: string): { release: () => void; section: Promise<void> } {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  return { release, section: withSaveWriteLock(saveId, () => held) };
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('writePluginSaveKv —— 锁内重读窄改', () => {
  it('写排在提交之后，提交期间落下的 fp 与别的 worldFlags 都留着', async () => {
    const { release, section } = holdLock(SAVE);
    const write = writePluginSaveKv(SAVE, 'shop', { set: ['coins', 5] }, OK);
    await settleMicrotasks();

    // 提交在锁里落一份整档（fp 涨了、地图状态写了）
    const stale = (await getSaveProfile(SAVE))!;
    stale.fp = 999;
    stale.worldFlags.map = { tile: '王都' };
    await saveSaveProfile(stale);

    release();
    await section;
    await expect(write).resolves.toEqual({ ok: true });

    const stored = (await getSaveProfile(SAVE))!;
    expect(stored.fp).toBe(999);
    expect(stored.worldFlags.map).toEqual({ tile: '王都' });
    expect(stored.worldFlags.plugins).toEqual({ shop: { kv: { coins: 5 } } });
  });

  it('守卫在锁内复检：排队时放行、等到锁时已在生成 → BUSY 且不写', async () => {
    let state: ReturnType<PluginRunGuard> = 'ok';
    const guard: PluginRunGuard = () => state;
    const { release, section } = holdLock(SAVE);
    const write = writePluginSaveKv(SAVE, 'shop', { set: ['coins', 5] }, guard);
    await settleMicrotasks();
    state = 'BUSY';
    release();
    await section;
    const result = await write;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('BUSY');
    expect(await getPluginSaveBag(SAVE, 'shop')).toEqual({});
  });

  it('战斗中返回 IN_COMBAT', async () => {
    const result = await writePluginSaveKv(SAVE, 'shop', { set: ['a', 1] }, () => 'IN_COMBAT');
    expect(!result.ok && result.code).toBe('IN_COMBAT');
  });

  it('值经 JSON 往返规整；不能序列化的值与非法键返回 INVALID', async () => {
    await writePluginSaveKv(SAVE, 'shop', { set: ['d', { at: new Date(0), skip: undefined }] }, OK);
    expect(await getPluginSaveBag(SAVE, 'shop')).toEqual({ d: { at: '1970-01-01T00:00:00.000Z' } });

    const bad1 = await writePluginSaveKv(SAVE, 'shop', { set: ['x', undefined] }, OK);
    expect(!bad1.ok && bad1.code).toBe('INVALID');
    const bad2 = await writePluginSaveKv(SAVE, 'shop', { set: ['x', 10n] }, OK);
    expect(!bad2.ok && bad2.code).toBe('INVALID');
    const bad3 = await writePluginSaveKv(SAVE, 'shop', { set: ['__proto__', 1] }, OK);
    expect(!bad3.ok && bad3.code).toBe('INVALID');
    const bad4 = await writePluginSaveKv(SAVE, 'shop', { remove: '' }, OK);
    expect(!bad4.ok && bad4.code).toBe('INVALID');
  });

  it('getPluginSaveBag 返回深拷贝，改它不影响库里那份', async () => {
    await writePluginSaveKv(SAVE, 'shop', { set: ['list', [1, 2]] }, OK);
    const bag = await getPluginSaveBag(SAVE, 'shop');
    (bag.list as number[]).push(3);
    expect(await getPluginSaveBag(SAVE, 'shop')).toEqual({ list: [1, 2] });
  });

  it('remove 删键；删到空格时整格删除；删不存在的键也算成功', async () => {
    await writePluginSaveKv(SAVE, 'shop', { set: ['a', 1] }, OK);
    await expect(writePluginSaveKv(SAVE, 'shop', { remove: 'zzz' }, OK)).resolves.toEqual({
      ok: true,
    });
    await writePluginSaveKv(SAVE, 'shop', { remove: 'a' }, OK);
    const stored = (await getSaveProfile(SAVE))!;
    expect(stored.worldFlags.plugins).toBeUndefined();
  });

  it('整格超过 256KB 返回 QUOTA，原有数据不动', async () => {
    await writePluginSaveKv(SAVE, 'shop', { set: ['small', 'x'] }, OK);
    const big = 'a'.repeat(PLUGIN_LIMITS.saveBagBytes);
    const result = await writePluginSaveKv(SAVE, 'shop', { set: ['big', big] }, OK);
    expect(!result.ok && result.code).toBe('QUOTA');
    expect(await getPluginSaveBag(SAVE, 'shop')).toEqual({ small: 'x' });

    // 恰好在上限内能写进去（中文按 UTF-8 三字节计）
    const fits = '字'.repeat(Math.floor((PLUGIN_LIMITS.saveBagBytes - 100) / 3));
    await expect(writePluginSaveKv(SAVE, 'other', { set: ['k', fits] }, OK)).resolves.toEqual({
      ok: true,
    });
  });

  it('只改自己那一格：别的插件的格子不受影响', async () => {
    await writePluginSaveKv(SAVE, 'shop', { set: ['a', 1] }, OK);
    await setPluginContext(SAVE, 'shop', '商店提示', OK);
    await writePluginSaveKv(SAVE, 'map', { set: ['b', 2] }, OK);
    await writePluginSaveKv(SAVE, 'map', { remove: 'b' }, OK);
    expect((await getSaveProfile(SAVE))!.worldFlags.plugins).toEqual({
      shop: { kv: { a: 1 }, context: '商店提示' },
    });
  });

  it('同一插件的并发写按 FIFO 落库，互不吞噬', async () => {
    await Promise.all([
      writePluginSaveKv(SAVE, 'shop', { set: ['a', 1] }, OK),
      writePluginSaveKv(SAVE, 'shop', { set: ['b', 2] }, OK),
      writePluginSaveKv(SAVE, 'map', { set: ['c', 3] }, OK),
    ]);
    expect(await getPluginSaveBag(SAVE, 'shop')).toEqual({ a: 1, b: 2 });
    expect(await getPluginSaveBag(SAVE, 'map')).toEqual({ c: 3 });
  });
});

describe('setPluginContext', () => {
  it('设置、覆盖、用 null 或空串清掉', async () => {
    await setPluginContext(SAVE, 'shop', '第一版', OK);
    await setPluginContext(SAVE, 'shop', '第二版', OK);
    expect((await getSaveProfile(SAVE))!.worldFlags.plugins.shop.context).toBe('第二版');
    await setPluginContext(SAVE, 'shop', null, OK);
    expect((await getSaveProfile(SAVE))!.worldFlags.plugins).toBeUndefined();
    await setPluginContext(SAVE, 'shop', '再来', OK);
    await setPluginContext(SAVE, 'shop', '', OK);
    expect((await getSaveProfile(SAVE))!.worldFlags.plugins).toBeUndefined();
  });

  it('超过 4000 字返回 QUOTA；非字符串返回 INVALID；守卫在锁内复检', async () => {
    const long = await setPluginContext(
      SAVE,
      'shop',
      'x'.repeat(PLUGIN_LIMITS.contextChars + 1),
      OK,
    );
    expect(!long.ok && long.code).toBe('QUOTA');
    await expect(
      setPluginContext(SAVE, 'shop', 'x'.repeat(PLUGIN_LIMITS.contextChars), OK),
    ).resolves.toEqual({ ok: true });
    const bad = await setPluginContext(SAVE, 'shop', 42 as unknown as string, OK);
    expect(!bad.ok && bad.code).toBe('INVALID');
    const busy = await setPluginContext(SAVE, 'shop', '新', () => 'BUSY');
    expect(!busy.ok && busy.code).toBe('BUSY');
  });
});

describe('enqueuePluginNote / clearPluginNotesForTurn', () => {
  it('入队记录插件名、回合号与 visible', async () => {
    await enqueuePluginNote(SAVE, 'shop', '商店', '买了一把剑', { turn: 3, visible: true }, OK);
    await enqueuePluginNote(SAVE, 'map', '地图', '标了一个点', { turn: 3 }, OK);
    expect((await getSaveProfile(SAVE))!.worldFlags.pluginNotes).toEqual([
      { pluginId: 'shop', pluginName: '商店', text: '买了一把剑', turn: 3, visible: true },
      { pluginId: 'map', pluginName: '地图', text: '标了一个点', turn: 3 },
    ]);
  });

  it('单条超过 2000 字或队列满 16 条返回 QUOTA；空串返回 INVALID', async () => {
    const long = await enqueuePluginNote(
      SAVE,
      'shop',
      '商店',
      'x'.repeat(PLUGIN_LIMITS.noteChars + 1),
      { turn: 1 },
      OK,
    );
    expect(!long.ok && long.code).toBe('QUOTA');
    const empty = await enqueuePluginNote(SAVE, 'shop', '商店', '  ', { turn: 1 }, OK);
    expect(!empty.ok && empty.code).toBe('INVALID');

    for (let i = 0; i < PLUGIN_LIMITS.noteQueue; i++) {
      const r = await enqueuePluginNote(
        SAVE,
        i % 2 ? 'shop' : 'map',
        '名',
        `第${i}条`,
        { turn: 1 },
        OK,
      );
      expect(r.ok).toBe(true);
    }
    const full = await enqueuePluginNote(SAVE, 'shop', '商店', '再来一条', { turn: 1 }, OK);
    expect(!full.ok && full.code).toBe('QUOTA');
    expect((await getSaveProfile(SAVE))!.worldFlags.pluginNotes).toHaveLength(
      PLUGIN_LIMITS.noteQueue,
    );
  });

  it('守卫在锁内复检：等锁期间进入战斗 → IN_COMBAT 且不入队', async () => {
    let state: ReturnType<PluginRunGuard> = 'ok';
    const { release, section } = holdLock(SAVE);
    const write = enqueuePluginNote(SAVE, 'shop', '商店', '告知', { turn: 1 }, () => state);
    await settleMicrotasks();
    state = 'IN_COMBAT';
    release();
    await section;
    const result = await write;
    expect(!result.ok && result.code).toBe('IN_COMBAT');
    expect((await getSaveProfile(SAVE))!.worldFlags.pluginNotes).toBeUndefined();
  });

  it('第 N 回合收口清掉 turn < N 的告知，重复调用幂等', async () => {
    await enqueuePluginNote(SAVE, 'shop', '商店', '旧告知', { turn: 2 }, OK);
    await enqueuePluginNote(SAVE, 'shop', '商店', '更旧', { turn: 1 }, OK);
    // 模拟一条在第 3 回合之后才入队的（turn=3），不属于第 3 回合的消费
    await enqueuePluginNote(SAVE, 'map', '地图', '新告知', { turn: 3 }, OK);

    await expect(clearPluginNotesForTurn(SAVE, 3)).resolves.toBe(2);
    expect((await getSaveProfile(SAVE))!.worldFlags.pluginNotes).toEqual([
      { pluginId: 'map', pluginName: '地图', text: '新告知', turn: 3 },
    ]);
    const before = await getSaveProfile(SAVE);
    await expect(clearPluginNotesForTurn(SAVE, 3)).resolves.toBe(0);
    expect(await getSaveProfile(SAVE)).toEqual(before);

    await clearPluginNotesForTurn(SAVE, 4);
    expect((await getSaveProfile(SAVE))!.worldFlags.pluginNotes).toBeUndefined();
  });

  it('清队列不吞提交期间落下的字段', async () => {
    await enqueuePluginNote(SAVE, 'shop', '商店', '告知', { turn: 1 }, OK);
    const { release, section } = holdLock(SAVE);
    const clear = clearPluginNotesForTurn(SAVE, 2);
    await settleMicrotasks();
    const stale = (await getSaveProfile(SAVE))!;
    stale.fp = 77;
    await saveSaveProfile(stale);
    release();
    await section;
    await clear;
    const stored = (await getSaveProfile(SAVE))!;
    expect(stored.fp).toBe(77);
    expect(stored.worldFlags.pluginNotes).toBeUndefined();
  });

  it('存档档案不存在时不建档', async () => {
    await expect(clearPluginNotesForTurn('save_missing', 1)).resolves.toBe(0);
    expect(await getSaveProfile('save_missing')).toBeUndefined();
  });
});

describe('clearPluginSaveData', () => {
  it('只清该插件的键值、提示块与告知，别的插件不动；重复调用幂等', async () => {
    await writePluginSaveKv(SAVE, 'shop', { set: ['a', 1] }, OK);
    await setPluginContext(SAVE, 'shop', '商店提示', OK);
    await enqueuePluginNote(SAVE, 'shop', '商店', '商店告知', { turn: 1 }, OK);
    await writePluginSaveKv(SAVE, 'map', { set: ['b', 2] }, OK);
    await enqueuePluginNote(SAVE, 'map', '地图', '地图告知', { turn: 1 }, OK);

    await clearPluginSaveData(SAVE, 'shop');
    const stored = (await getSaveProfile(SAVE))!;
    expect(stored.worldFlags.plugins).toEqual({ map: { kv: { b: 2 } } });
    expect(stored.worldFlags.pluginNotes).toEqual([
      { pluginId: 'map', pluginName: '地图', text: '地图告知', turn: 1 },
    ]);

    await expect(clearPluginSaveData(SAVE, 'shop')).resolves.toBeUndefined();
    expect(await getSaveProfile(SAVE)).toEqual(stored);
  });
});

describe('readPluginPromptInputs', () => {
  it('只收已启用插件的告知与提示块，名字取 nameOf', async () => {
    await setPluginContext(SAVE, 'shop', '商店提示', OK);
    await setPluginContext(SAVE, 'map', '地图提示', OK);
    await setPluginContext(SAVE, 'off', '未启用的提示', OK);
    await enqueuePluginNote(SAVE, 'shop', '商店', '商店告知', { turn: 1 }, OK);
    await enqueuePluginNote(SAVE, 'off', '停用', '不该出现', { turn: 1 }, OK);
    await writePluginSaveKv(SAVE, 'kvonly', { set: ['a', 1] }, OK);

    const names: Record<string, string> = { shop: '商店', map: '地图', kvonly: '纯数据' };
    const inputs = await readPluginPromptInputs(
      SAVE,
      ['map', 'shop', 'kvonly'],
      (id) => names[id] ?? id,
    );
    expect(inputs).toEqual({
      notes: [{ pluginName: '商店', text: '商店告知' }],
      contexts: [
        { pluginName: '地图', text: '地图提示' },
        { pluginName: '商店', text: '商店提示' },
      ],
    });
  });

  it('没有启用的插件或档案不存在时返回空', async () => {
    await setPluginContext(SAVE, 'shop', '商店提示', OK);
    await expect(readPluginPromptInputs(SAVE, [], (id) => id)).resolves.toEqual({
      notes: [],
      contexts: [],
    });
    await expect(readPluginPromptInputs('save_missing', ['shop'], (id) => id)).resolves.toEqual({
      notes: [],
      contexts: [],
    });
  });
});
