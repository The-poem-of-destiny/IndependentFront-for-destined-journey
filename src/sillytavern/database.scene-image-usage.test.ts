/**
 * 本存档插画用量与清理范围（图像生成设计 §7.5 / D47）
 *
 * 两条要钉死的事：
 *
 * 1. **清理 = 删字节、留记录**。`dropSceneImageBlobs` 已有它自己的实现，本文件测的是
 *    喂给它的那份 id 名单与显示给用户的那个数字 —— 二者必须来自同一个判据，否则会
 *    长出「显示 12 张可清理、点下去只清了 8 张」这种裂缝。
 * 2. **一张图都没有时返回全 0**，不是 undefined、不是抛错 —— 设置页那一行要照常渲染
 *    「0 张 / 0 B」。
 *
 * 用 fake-indexeddb（src/test-setup.ts 注入）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDatabase,
  initializeDatabase,
  clearAllData,
  saveSceneImage,
  getSceneImageUsage,
  listCleanableSceneImageIds,
  dropSceneImageBlobs,
} from './database';
import type { SceneImageRecord } from './types-image';

const SAVE = 'save_usage';
const OTHER = 'save_other';

function makeImage(overrides: Partial<SceneImageRecord> = {}): SceneImageRecord {
  return {
    id: `img_${Math.random().toString(36).slice(2, 10)}`,
    saveId: SAVE,
    messageId: 'msg_1',
    anchorKind: 'marker',
    occurrence: 0,
    take: 0,
    turn: 1,
    status: 'done',
    source: 'auto',
    title: '酒馆的第一夜',
    description: '',
    intent: '她在壁炉边坐下',
    scenePrompt: 'tavern interior, warm candlelight',
    sceneNegative: '',
    characters: ['苏婉'],
    rating: 'general',
    positive: 'tavern interior, warm candlelight, masterpiece',
    negative: 'lowres',
    model: 'nai-diffusion-4-5-full',
    params: {},
    mime: 'image/png',
    bytes: 1000,
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* 首次运行时库还不存在 */
  }
  await initializeDatabase();
});

describe('getSceneImageUsage', () => {
  it('一张图都没有 → 全 0（而不是抛错或返回 undefined）', async () => {
    expect(await getSceneImageUsage(SAVE)).toEqual({
      records: 0,
      storedCount: 0,
      storedBytes: 0,
      favoriteCount: 0,
      favoriteBytes: 0,
    });
  });

  it('累加张数与字节，且只算本存档的', async () => {
    await saveSceneImage(makeImage({ bytes: 1000 }), new Blob(['a']));
    await saveSceneImage(makeImage({ bytes: 2500 }), new Blob(['b']));
    await saveSceneImage(makeImage({ saveId: OTHER, bytes: 999999 }), new Blob(['c']));

    const usage = await getSceneImageUsage(SAVE);
    expect(usage.records).toBe(2);
    expect(usage.storedCount).toBe(2);
    expect(usage.storedBytes).toBe(3500);
    expect((await getSceneImageUsage(OTHER)).storedBytes).toBe(999999);
  });

  it('已清理（blobDropped）的记录仍计入 records，但不再占字节', async () => {
    const kept = makeImage({ bytes: 1000 });
    const dropped = makeImage({ bytes: 4000 });
    await saveSceneImage(kept, new Blob(['a']));
    await saveSceneImage(dropped, new Blob(['b']));

    await dropSceneImageBlobs([dropped.id]);

    const usage = await getSceneImageUsage(SAVE);
    // 🔴 D47：行数一条都不少，少的只是字节
    expect(usage.records).toBe(2);
    expect(usage.storedCount).toBe(1);
    expect(usage.storedBytes).toBe(1000);
  });

  it('failed / queued 的记录不算占字节（它们从来没有过字节）', async () => {
    await saveSceneImage(makeImage({ status: 'failed', bytes: undefined, error: '超时' }));
    await saveSceneImage(makeImage({ status: 'queued', bytes: undefined }));
    await saveSceneImage(makeImage({ bytes: 800 }), new Blob(['a']));

    const usage = await getSceneImageUsage(SAVE);
    expect(usage.records).toBe(3);
    expect(usage.storedCount).toBe(1);
    expect(usage.storedBytes).toBe(800);
  });

  it('bytes 缺失的 done 记录按 0 字节计，但仍算一张（不猜一个数）', async () => {
    await saveSceneImage(makeImage({ bytes: undefined }), new Blob(['a']));

    const usage = await getSceneImageUsage(SAVE);
    expect(usage.storedCount).toBe(1);
    expect(usage.storedBytes).toBe(0);
  });

  it('收藏的那部分单独计数，好让 UI 说清「这 N 张不会被清理」', async () => {
    await saveSceneImage(makeImage({ bytes: 1000 }), new Blob(['a']));
    await saveSceneImage(makeImage({ bytes: 3000, favorite: true }), new Blob(['b']));

    const usage = await getSceneImageUsage(SAVE);
    expect(usage.storedCount).toBe(2);
    expect(usage.storedBytes).toBe(4000);
    expect(usage.favoriteCount).toBe(1);
    expect(usage.favoriteBytes).toBe(3000);
  });
});

describe('listCleanableSceneImageIds', () => {
  it('空存档 → 空数组', async () => {
    expect(await listCleanableSceneImageIds(SAVE)).toEqual([]);
  });

  it('默认排除收藏（D6 的豁免位），也排除已清理与从没画出来的', async () => {
    const plain = makeImage({ bytes: 1000 });
    const fav = makeImage({ bytes: 3000, favorite: true });
    const already = makeImage({ bytes: 2000 });
    const failed = makeImage({ status: 'failed', bytes: undefined });
    await saveSceneImage(plain, new Blob(['a']));
    await saveSceneImage(fav, new Blob(['b']));
    await saveSceneImage(already, new Blob(['c']));
    await saveSceneImage(failed);
    await dropSceneImageBlobs([already.id]);

    expect(await listCleanableSceneImageIds(SAVE)).toEqual([plain.id]);
    expect((await listCleanableSceneImageIds(SAVE, { includeFavorite: true })).sort()).toEqual(
      [plain.id, fav.id].sort(),
    );
  });

  it('不跨存档', async () => {
    const mine = makeImage({ bytes: 1000 });
    await saveSceneImage(mine, new Blob(['a']));
    await saveSceneImage(makeImage({ saveId: OTHER, bytes: 1000 }), new Blob(['b']));

    expect(await listCleanableSceneImageIds(SAVE)).toEqual([mine.id]);
  });

  it('名单与用量同源：清完之后 storedCount 恰好只剩收藏的那些', async () => {
    await saveSceneImage(makeImage({ bytes: 1000 }), new Blob(['a']));
    await saveSceneImage(makeImage({ bytes: 2000 }), new Blob(['b']));
    await saveSceneImage(makeImage({ bytes: 3000, favorite: true }), new Blob(['c']));

    const before = await getSceneImageUsage(SAVE);
    const ids = await listCleanableSceneImageIds(SAVE);
    expect(ids).toHaveLength(before.storedCount - before.favoriteCount);

    const dropped = await dropSceneImageBlobs(ids);
    expect(dropped).toBe(ids.length);

    const after = await getSceneImageUsage(SAVE);
    expect(after.records).toBe(before.records); // 记录一条不少
    expect(after.storedCount).toBe(before.favoriteCount);
    expect(after.storedBytes).toBe(before.favoriteBytes);
    // 字节确实没了
    expect(await getDatabase().sceneImageBlobs.count()).toBe(1);
  });
});
