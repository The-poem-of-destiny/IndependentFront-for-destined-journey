/**
 * scene-image-store 测试（图像生成 v1 / 设计 §7 · §8 · §14）
 *
 * 数据层是**真 Dexie + fake-indexeddb**，三条注入缝（限额 / 侧链 / 发请求）用替身。
 * 于是「队列、状态机、取消」这些**在网络客户端写好之前就该正确**的东西，
 * 在这里已经是可测的。
 *
 * 两条最要紧的断言（错了会直接花钱）:
 * - 限额拒绝时，侧链一次都没被调用（D32：闸门在最前面，两处花钱）
 * - 取消 `queued` 项**不产生任何网络调用**（D36：排队取消不花钱）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  clearAllData,
  deleteSaveSlot,
  getDatabase,
  getSceneImage,
  getSceneImagesByMessage,
  saveImagePreset,
  saveSaveSlot,
  saveSceneImage,
} from '@engine/database';
import type { ImagePreset, QuotaVerdict, SceneImageRecord } from '@engine/types-image';
import type { SaveSlot } from '@engine/types';
import {
  useSceneImageStore,
  type SceneImageGenerateInput,
  type SceneImageQuotaInput,
  type SceneImageSeams,
  type SceneImageSendInput,
  type SceneImageSendResult,
} from './scene-image-store';

// ═══ 夹具 ═══

const SAVE = 'save_img';

function baseInput(over: Partial<SceneImageGenerateInput> = {}): SceneImageGenerateInput {
  return {
    saveId: SAVE,
    messageId: 'msg_1',
    turn: 3,
    anchorKind: 'marker',
    occurrence: 0,
    source: 'auto',
    intent: '苏婉在壁炉边第一次说起她的家乡',
    title: '炉火边的故乡',
    characters: ['苏婉'],
    rating: 'general',
    narrative: '壁炉噼啪作响，她把杯子搁在膝上。',
    location: '风铃旅店',
    ...over,
  };
}

function okSend(over: Partial<SceneImageSendResult> = {}): SceneImageSendResult {
  return {
    ok: true,
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    mime: 'image/png',
    bytes: 3,
    hash: 'deadbeef',
    positive: 'tavern interior, warm candlelight',
    negative: 'modern clothing',
    model: 'nai-diffusion-4-5-full',
    seed: 12345,
    params: { steps: 23 },
    ...over,
  };
}

/**
 * 一个「什么都答得上来」的侧链替身。
 *
 * 大多数用例关心的是队列/状态机，不关心中文→标签那一步 —— 但它**不能省**：
 * 没有 `runPromptAgent` 且记录里也没有缓存的 `scenePrompt` 时，store 会明确落
 * `prompt-agent` 失败（而不是硬着头皮发一个空提示词去 NAI 烧钱）。
 */
function stubPromptAgent() {
  return async () => ({ scenePrompt: 'tavern interior', sceneNegative: '', desc: '' });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeRecord(over: Partial<SceneImageRecord> = {}): SceneImageRecord {
  return {
    id: 'simg_seed',
    saveId: SAVE,
    messageId: 'msg_1',
    anchorKind: 'marker',
    occurrence: 0,
    take: 0,
    turn: 1,
    status: 'done',
    source: 'auto',
    title: '标题',
    description: '说明',
    intent: '意图',
    scenePrompt: 'tavern interior',
    sceneNegative: '',
    characters: ['苏婉'],
    rating: 'general',
    positive: 'tavern interior',
    negative: '',
    model: 'nai-diffusion-4-5-full',
    params: {},
    mime: 'image/png',
    bytes: 3,
    createdAt: 1000,
    ...over,
  };
}

function makePreset(over: Partial<ImagePreset> = {}): ImagePreset {
  return {
    key: 'character:苏婉',
    kind: 'character',
    name: '苏婉',
    dialects: { danbooru: { positive: '1girl, silver hair', negative: '' } },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(async () => {
  await clearAllData();
});

// ═══ 落库与查询 ═══

describe('落库与索引查询', () => {
  it('按 [saveId+messageId] 取一条消息上的记录，不串到别的存档/消息', async () => {
    await saveSceneImage(makeRecord({ id: 'a', saveId: 'sA', messageId: 'm1' }));
    await saveSceneImage(makeRecord({ id: 'b', saveId: 'sA', messageId: 'm1', occurrence: 1 }));
    await saveSceneImage(makeRecord({ id: 'c', saveId: 'sA', messageId: 'm2' }));
    await saveSceneImage(makeRecord({ id: 'd', saveId: 'sB', messageId: 'm1' }));

    const rows = await getSceneImagesByMessage('sA', 'm1');
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('删存档连带删 sceneImages 与字节，imagePresets 不删', async () => {
    const db = getDatabase();
    await saveSaveSlot({
      id: SAVE,
      slot: 1,
      name: '存档',
      createdAt: 1,
      updatedAt: 1,
    } as SaveSlot);
    await saveSceneImage(makeRecord({ id: 'keep', saveId: 'other_save' }));
    await saveSceneImage(
      makeRecord({ id: 'gone' }),
      new Blob([new Uint8Array([9])], { type: 'image/png' }),
    );
    await saveImagePreset(makePreset());

    expect(await db.sceneImageBlobs.get('gone')).toBeDefined();

    await deleteSaveSlot(SAVE);

    expect(await getSceneImage('gone')).toBeUndefined();
    expect(await db.sceneImageBlobs.get('gone')).toBeUndefined();
    // 别的存档的记录不受影响
    expect(await getSceneImage('keep')).toBeDefined();
    // 🔴 预设是全局的，删存档不该带走它
    expect(await db.imagePresets.get('character:苏婉')).toBeDefined();
  });
});

// ═══ 限额闸门（D32）═══

describe('限额（D32：闸门在最前面）', () => {
  it('限额拒绝时，侧链与网络一次都没被调用，且不留记录', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    const runPromptAgent = vi.fn();
    const send = vi.fn();
    store.setSeams({
      checkQuota: () => ({ ok: false, reason: 'rolling-window', message: '已达本小时上限' }),
      runPromptAgent,
      send,
    });

    const res = await store.generate(baseInput());
    await store.whenIdle();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('rolling-window');
      expect(res.message).toBe('已达本小时上限');
    }
    expect(runPromptAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await getSceneImagesByMessage(SAVE, 'msg_1')).toHaveLength(0);
  });

  it('限额判定拿到的是本存档全部记录（含 queued/failed），否则连点能绕过', async () => {
    await saveSceneImage(makeRecord({ id: 'q', status: 'queued' }));
    await saveSceneImage(makeRecord({ id: 'f', status: 'failed', occurrence: 1 }));
    const store = useSceneImageStore();
    await store.load(SAVE);
    const checkQuota = vi.fn((_input: SceneImageQuotaInput): QuotaVerdict => ({ ok: true }));
    store.setSeams({ checkQuota, runPromptAgent: stubPromptAgent(), send: async () => okSend() });

    await store.generate(baseInput({ occurrence: 2 }));
    await store.whenIdle();

    const seen = checkQuota.mock.calls[0][0];
    expect(seen.records.map((r) => r.id).sort()).toEqual(['f', 'q']);
  });
});

// ═══ 队列与状态机 ═══

describe('串行队列与状态机', () => {
  it('记录先落库（queued）再发请求；排队期间没有 startedAt', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);

    const firstCalled = deferred<void>();
    const release = deferred<SceneImageSendResult>();
    const send = vi.fn(async (_input: SceneImageSendInput) => {
      firstCalled.resolve();
      return release.promise;
    });
    store.setSeams({ runPromptAgent: stubPromptAgent(), send });

    const a = await store.generate(baseInput({ occurrence: 0 }));
    const b = await store.generate(baseInput({ occurrence: 1 }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await firstCalled.promise;

    // 第一条：已经在飞，startedAt 已写
    const rowA = await getSceneImage(a.id);
    expect(rowA?.status).toBe('generating');
    expect(typeof rowA?.startedAt).toBe('number');
    expect(rowA!.startedAt!).toBeGreaterThanOrEqual(rowA!.createdAt);

    // 第二条：**已经落库**（刷新页面也还在，D5），但还没发请求
    const rowB = await getSceneImage(b.id);
    expect(rowB?.status).toBe('queued');
    // 🔴 排队中的记录不能有 startedAt —— 否则 UI 会显示「已用 180 秒」（D37）
    expect(rowB?.startedAt).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);

    release.resolve(okSend());
    await store.whenIdle();
    expect(send).toHaveBeenCalledTimes(2);
    expect((await getSceneImage(b.id))?.status).toBe('done');
  });

  it('成功后写字节与账务字段（mime/bytes/hash/seed/model/params）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams({ runPromptAgent: stubPromptAgent(), send: async () => okSend() });

    const res = await store.generate(baseInput());
    await store.whenIdle();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = await getSceneImage(res.id);
    expect(row?.status).toBe('done');
    expect(row?.mime).toBe('image/png');
    expect(row?.bytes).toBe(3);
    expect(row?.hash).toBe('deadbeef');
    expect(row?.seed).toBe(12345);
    expect(row?.model).toBe('nai-diffusion-4-5-full');
    expect(row?.params).toEqual({ steps: 23 });
    expect(await store.blobOf(res.id)).toBeDefined();
  });

  it('缺 send 缝时记录落 failed，而不是永远悬在 generating', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams({});

    const res = await store.generate(baseInput());
    await store.whenIdle();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = await getSceneImage(res.id);
    // 侧链也没接，所以先在 prompt-agent 那一关就失败了 —— 关键是**不悬着**
    expect(row?.status).toBe('failed');
    expect(row?.errorKind).toBe('prompt-agent');
  });

  it('侧链失败即到此为止，绝不发 NAI', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    const send = vi.fn(async () => okSend());
    store.setSeams({
      runPromptAgent: async () => ({
        ok: false as const,
        kind: 'prompt-agent' as const,
        message: '抽不到 <image_prompt>',
        retryable: true,
      }),
      send,
    });

    const res = await store.generate(baseInput());
    await store.whenIdle();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(send).not.toHaveBeenCalled();
    const row = await getSceneImage(res.id);
    expect(row?.status).toBe('failed');
    expect(row?.errorKind).toBe('prompt-agent');
    expect(row?.error).toBe('抽不到 <image_prompt>');
  });

  it('缝里抛异常不会让泵停摆，后一条照样跑', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    let call = 0;
    store.setSeams({
      runPromptAgent: stubPromptAgent(),
      send: async () => {
        call += 1;
        if (call === 1) throw new Error('boom');
        return okSend();
      },
    });

    const a = await store.generate(baseInput({ occurrence: 0 }));
    const b = await store.generate(baseInput({ occurrence: 1 }));
    await store.whenIdle();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect((await getSceneImage(a.id))?.status).toBe('failed');
    expect((await getSceneImage(b.id))?.status).toBe('done');
  });
});

// ═══ 侧链复用（D26 / D31）═══

describe('侧链复用', () => {
  it('有 editedScenePrompt 时跳过侧链，且用的是用户改过的那份', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    const runPromptAgent = vi.fn(async () => ({
      scenePrompt: 'agent 写的',
      sceneNegative: '',
      desc: '',
    }));
    let seenPrompt = '';
    store.setSeams({
      runPromptAgent,
      send: async (input) => {
        seenPrompt = input.scenePrompt;
        return okSend();
      },
    });

    const first = await store.generate(baseInput());
    await store.whenIdle();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(runPromptAgent).toHaveBeenCalledTimes(1);

    await store.update(first.id, { editedScenePrompt: '用户改过的' });
    const redraw = await store.generate(baseInput({ redrawFrom: first.id }));
    await store.whenIdle();
    expect(redraw.ok).toBe(true);

    // 🔴 改完提示词点重画，结果却按 agent 的原话生成，是这类界面最挫败的一种失败
    expect(runPromptAgent).toHaveBeenCalledTimes(1);
    expect(seenPrompt).toBe('用户改过的');
    // 原文一个字节不动，于是「改回去」永远可行
    expect((await getSceneImage(first.id))?.scenePrompt).toBe('agent 写的');
  });

  it('重画继承上一 take 的 scenePrompt，同样跳过侧链（省钱）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    const runPromptAgent = vi.fn(async () => ({
      scenePrompt: 'tavern interior',
      sceneNegative: 'blurry',
      desc: 'agent 写的说明',
    }));
    store.setSeams({ runPromptAgent, send: async () => okSend() });

    const first = await store.generate(baseInput());
    await store.whenIdle();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const redraw = await store.generate(baseInput({ redrawFrom: first.id }));
    await store.whenIdle();
    expect(redraw.ok).toBe(true);
    if (!redraw.ok) return;

    expect(runPromptAgent).toHaveBeenCalledTimes(1);
    const row = await getSceneImage(redraw.id);
    expect(row?.scenePrompt).toBe('tavern interior');
    expect(row?.sceneNegative).toBe('blurry');
  });
});

// ═══ 锚点编号（D17 / D34）═══

describe('锚点编号', () => {
  it('重画是**追加 take**，不覆盖上一张', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams({ runPromptAgent: stubPromptAgent(), send: async () => okSend() });

    const a = await store.generate(baseInput());
    await store.whenIdle();
    const b = await store.generate(baseInput());
    await store.whenIdle();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const takes = store.takesAt('msg_1', 'marker', 0);
    expect(takes.map((r) => r.take)).toEqual([0, 1]);
    expect(await getSceneImage(a.id)).toBeDefined();
    expect(await getSceneImage(b.id)).toBeDefined();
  });

  it("anchorKind 'marker' 与 'message-end' 的 occurrence 各自独立计数", async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams({ runPromptAgent: stubPromptAgent(), send: async () => okSend() });

    // 两个 marker，占 occurrence 0 / 1（由分段器给号）
    await store.generate(baseInput({ anchorKind: 'marker', occurrence: 0 }));
    await store.generate(baseInput({ anchorKind: 'marker', occurrence: 1 }));
    // 两个玩家主动要的图，不传 occurrence → 在**自己那一类里**顺延
    await store.generate(baseInput({ anchorKind: 'message-end', occurrence: undefined }));
    await store.generate(baseInput({ anchorKind: 'message-end', occurrence: undefined }));
    await store.whenIdle();

    const markers = store.byMessage('msg_1').filter((r) => r.anchorKind === 'marker');
    const ends = store.byMessage('msg_1').filter((r) => r.anchorKind === 'message-end');
    expect(markers.map((r) => r.occurrence).sort()).toEqual([0, 1]);
    // 🔴 从 0 开始，没有被 marker 那两条顶到 2 / 3
    expect(ends.map((r) => r.occurrence).sort()).toEqual([0, 1]);
    // 而且各自都是第 0 个 take（互不干扰）
    expect(store.takesAt('msg_1', 'message-end', 0).map((r) => r.take)).toEqual([0]);
    expect(store.takesAt('msg_1', 'marker', 0).map((r) => r.take)).toEqual([0]);
  });

  it('删掉中间某个 take 后，下一次重画不与仍活着的记录撞号', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams({ runPromptAgent: stubPromptAgent(), send: async () => okSend() });

    const a = await store.generate(baseInput());
    await store.whenIdle();
    const b = await store.generate(baseInput());
    await store.whenIdle();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await store.remove(a.id); // 删掉 take 0，只剩 take 1
    const c = await store.generate(baseInput());
    await store.whenIdle();
    expect(c.ok).toBe(true);

    const takes = store.takesAt('msg_1', 'marker', 0).map((r) => r.take);
    expect(takes).toEqual([1, 2]);
    expect(new Set(takes).size).toBe(takes.length);
  });
});

// ═══ 取消（D36）═══

describe('取消', () => {
  it('取消 queued 项**不产生任何网络调用**，记录也一并消失', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);

    const firstCalled = deferred<void>();
    const release = deferred<SceneImageSendResult>();
    const send = vi.fn(async () => {
      firstCalled.resolve();
      return release.promise;
    });
    store.setSeams({ runPromptAgent: stubPromptAgent(), send });

    const a = await store.generate(baseInput({ occurrence: 0 }));
    const b = await store.generate(baseInput({ occurrence: 1 }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await firstCalled.promise;
    expect((await getSceneImage(b.id))?.status).toBe('queued');

    const outcome = await store.cancel(b.id);
    expect(outcome).toBe('cancelled');

    release.resolve(okSend());
    await store.whenIdle();

    // 🔴 只有第一条发出去过
    expect(send).toHaveBeenCalledTimes(1);
    // 排队取消不花钱 → 记录整条撤销，正文那一格回到「无记录」，限额也退回来
    expect(await getSceneImage(b.id)).toBeUndefined();
    expect(store.find(b.id)).toBeUndefined();
  });

  it('中止在飞的那条：记录留着并落 failed/aborted（花过的钱不装作没花）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    const called = deferred<void>();
    const release = deferred<SceneImageSendResult>();
    store.setSeams({
      runPromptAgent: stubPromptAgent(),
      send: async (_input, signal) => {
        called.resolve();
        await release.promise;
        return signal.aborted
          ? { ok: false as const, kind: 'aborted' as const, message: '已中止', retryable: true }
          : okSend();
      },
    });

    const a = await store.generate(baseInput());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await called.promise;

    const outcome = await store.cancel(a.id);
    expect(outcome).toBe('aborted');
    release.resolve(okSend());
    await store.whenIdle();

    const row = await getSceneImage(a.id);
    expect(row).toBeDefined();
    expect(row?.status).toBe('failed');
    expect(row?.errorKind).toBe('aborted');
  });

  it('取消 done/failed 是 noop', async () => {
    await saveSceneImage(makeRecord({ id: 'done_one' }));
    const store = useSceneImageStore();
    await store.load(SAVE);
    expect(await store.cancel('done_one')).toBe('noop');
    expect(await store.cancel('不存在')).toBe('noop');
  });
});

// ═══ 钉住（D45）═══

describe('钉住', () => {
  it('同一锚点下 pinned 至多一条', async () => {
    await saveSceneImage(makeRecord({ id: 't0', take: 0 }));
    await saveSceneImage(makeRecord({ id: 't1', take: 1 }));
    await saveSceneImage(makeRecord({ id: 't2', take: 2 }));
    // 另一个锚点，不该被牵连
    await saveSceneImage(makeRecord({ id: 'other', occurrence: 1, pinned: true }));

    const store = useSceneImageStore();
    await store.load(SAVE);

    await store.pin('t0');
    await store.pin('t2');

    const pinned = store.takesAt('msg_1', 'marker', 0).filter((r) => r.pinned === true);
    expect(pinned.map((r) => r.id)).toEqual(['t2']);
    // 落库的也只有一条
    expect((await getSceneImage('t0'))?.pinned).toBe(false);
    expect((await getSceneImage('t2'))?.pinned).toBe(true);
    // 别的锚点原样
    expect((await getSceneImage('other'))?.pinned).toBe(true);
  });

  it('没有 pinned 时正文显示 take 最大者；有则显示钉住的那张', async () => {
    await saveSceneImage(makeRecord({ id: 't0', take: 0 }));
    await saveSceneImage(makeRecord({ id: 't1', take: 1 }));
    const store = useSceneImageStore();
    await store.load(SAVE);

    expect(store.displayedAt('msg_1', 'marker', 0)?.id).toBe('t1');
    await store.pin('t0');
    expect(store.displayedAt('msg_1', 'marker', 0)?.id).toBe('t0');
  });
});

// ═══ 清理（D47）═══

describe('清理', () => {
  it('只删字节并打 blobDropped —— sceneImages 行数一条都不变，status 也不动', async () => {
    const db = getDatabase();
    const png = () => new Blob([new Uint8Array([7, 7])], { type: 'image/png' });
    await saveSceneImage(makeRecord({ id: 'r1', bytes: 2 }), png());
    await saveSceneImage(makeRecord({ id: 'r2', occurrence: 1, bytes: 2 }), png());
    await saveSceneImage(makeRecord({ id: 'fav', occurrence: 2, bytes: 2, favorite: true }), png());

    const store = useSceneImageStore();
    await store.load(SAVE);
    const before = await db.sceneImages.count();

    const result = await store.cleanup(SAVE);

    expect(result.dropped).toBe(2);
    expect(result.keptFavorite).toBe(1);
    expect(result.bytes).toBe(4);
    // 🔴 行数不变
    expect(await db.sceneImages.count()).toBe(before);

    const r1 = await getSceneImage('r1');
    expect(r1?.blobDropped).toBe(true);
    // 这张图**画出来过**，那是历史事实，不因为腾空间而改写
    expect(r1?.status).toBe('done');
    expect(r1?.scenePrompt).toBe('tavern interior');
    expect(await db.sceneImageBlobs.get('r1')).toBeUndefined();

    // 收藏的豁免（D6）
    expect((await getSceneImage('fav'))?.blobDropped).toBeUndefined();
    expect(await db.sceneImageBlobs.get('fav')).toBeDefined();
  });

  it('includeFavorites 时连收藏一起清', async () => {
    const png = new Blob([new Uint8Array([7])], { type: 'image/png' });
    await saveSceneImage(makeRecord({ id: 'fav', favorite: true, bytes: 1 }), png);
    const store = useSceneImageStore();
    await store.load(SAVE);

    const result = await store.cleanup(SAVE, { includeFavorites: true });
    expect(result.dropped).toBe(1);
    expect(result.keptFavorite).toBe(0);
    expect((await getSceneImage('fav'))?.blobDropped).toBe(true);
  });
});

// ═══ 视图 ═══

describe('视图', () => {
  it('图鉴按 turn 升序（剧情顺序）', async () => {
    await saveSceneImage(makeRecord({ id: 'late', turn: 9, createdAt: 1 }));
    await saveSceneImage(makeRecord({ id: 'early', turn: 2, occurrence: 1, createdAt: 2 }));
    const store = useSceneImageStore();
    await store.load(SAVE);
    expect(store.gallery.map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('用量统计区分自动/手动，并把已清理的算进去', async () => {
    await saveSceneImage(makeRecord({ id: 'a', source: 'auto', bytes: 10 }));
    await saveSceneImage(makeRecord({ id: 'm', source: 'manual', occurrence: 1, bytes: 20 }));
    await saveSceneImage(
      makeRecord({ id: 'd', source: 'auto', occurrence: 2, bytes: 30, blobDropped: true }),
    );
    const store = useSceneImageStore();
    await store.load(SAVE);

    expect(store.usage).toEqual({
      total: 3,
      auto: 2,
      manual: 1,
      withBytes: 2,
      dropped: 1,
      bytes: 30,
    });
  });
});

// ═══ 缝的形状 ═══

describe('注入缝', () => {
  it('setSeams 可以整体换掉（传 {} 回到「都不接」的状态）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    const seams: SceneImageSeams = {
      runPromptAgent: stubPromptAgent(),
      send: async () => okSend(),
    };
    store.setSeams(seams);

    const a = await store.generate(baseInput());
    await store.whenIdle();
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect((await getSceneImage(a.id))?.status).toBe('done');

    store.setSeams({});
    const b = await store.generate(baseInput({ occurrence: 1 }));
    await store.whenIdle();
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect((await getSceneImage(b.id))?.status).toBe('failed');
  });
});
