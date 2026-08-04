/**
 * image-preset-store 测试（图像生成 v1 / 设计 §4 · §7.1，D40）
 *
 * 真 Dexie + fake-indexeddb。三条不变式各有一组用例：
 * 1. 主键 = `${kind}:${name}` —— 人名与地名撞车时必须是两条
 * 2. `name` 原样保存，`===` 匹配（不 trim / 不折叠大小写 / 不 NFKC）
 * 3. 全局，不随存档隔离（删存档那一条断言在 scene-image-store.test.ts 里）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { clearAllData, getDatabase, getImagePreset } from '@engine/database';
import { imagePresetKey, useImagePresetStore } from './image-preset-store';

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(async () => {
  await clearAllData();
});

describe('主键（D40）', () => {
  it('人名与地名撞车时是两条独立记录，互不覆盖', async () => {
    const store = useImagePresetStore();
    await store.init();

    await store.upsert({
      kind: 'character',
      name: '瓦伦蒂亚',
      danbooru: { positive: '1girl, blonde', negative: '' },
    });
    await store.upsert({
      kind: 'location',
      name: '瓦伦蒂亚',
      danbooru: { positive: 'coastal city, harbor', negative: '' },
    });

    expect(store.presets).toHaveLength(2);
    expect(store.find('character', '瓦伦蒂亚')?.dialects.danbooru?.positive).toBe('1girl, blonde');
    expect(store.find('location', '瓦伦蒂亚')?.dialects.danbooru?.positive).toBe(
      'coastal city, harbor',
    );
    expect(imagePresetKey('character', '瓦伦蒂亚')).toBe('character:瓦伦蒂亚');
    expect(await getImagePreset('location:瓦伦蒂亚')).toBeDefined();
  });

  it('同 kind 同 name 是覆盖，且 createdAt 保留、updatedAt 前进', async () => {
    const store = useImagePresetStore();
    await store.init();

    const first = await store.upsert({
      kind: 'character',
      name: '苏婉',
      danbooru: { positive: 'v1', negative: '' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await store.upsert({
      kind: 'character',
      name: '苏婉',
      danbooru: { positive: 'v2', negative: '' },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(store.presets).toHaveLength(1);
    expect(second.value.dialects.danbooru?.positive).toBe('v2');
    expect(second.value.createdAt).toBe(first.value.createdAt);
    expect(second.value.updatedAt).toBeGreaterThanOrEqual(first.value.updatedAt);
  });
});

describe('名字原样（铁律 1）', () => {
  it('前后空格 / 大小写 / 全角都不归一化，各自是独立的一条', async () => {
    const store = useImagePresetStore();
    await store.init();

    await store.upsert({ kind: 'character', name: '苏婉' });
    await store.upsert({ kind: 'character', name: '苏婉 ' });
    await store.upsert({ kind: 'character', name: 'Alice' });
    await store.upsert({ kind: 'character', name: 'alice' });

    expect(store.presets).toHaveLength(4);
    // 严格 === ：查「苏婉」查不到「苏婉 」
    expect(store.find('character', '苏婉')?.name).toBe('苏婉');
    expect(store.find('character', '苏婉 ')?.name).toBe('苏婉 ');
    expect(store.find('character', 'ALICE')).toBeUndefined();
  });

  it('空名字拒收（否则主键退化成 `character:`，两条互相覆盖）', async () => {
    const store = useImagePresetStore();
    await store.init();
    const res = await store.upsert({ kind: 'character', name: '' });
    expect(res.ok).toBe(false);
    expect(store.presets).toHaveLength(0);
  });
});

describe('查询', () => {
  it('按 kind 分列并按名字排序', async () => {
    const store = useImagePresetStore();
    await store.init();
    await store.upsert({ kind: 'location', name: '风铃旅店' });
    await store.upsert({ kind: 'character', name: '苏婉' });
    await store.upsert({ kind: 'character', name: '莱恩' });

    expect(store.characters.map((p) => p.name)).toEqual(['莱恩', '苏婉']);
    expect(store.locations.map((p) => p.name)).toEqual(['风铃旅店']);
  });

  it('findMany 只回命中的，缺席的既不报错也不占位（D41 的告警归装配层）', async () => {
    const store = useImagePresetStore();
    await store.init();
    await store.upsert({ kind: 'character', name: '苏婉' });

    const hits = store.findMany('character', ['苏婉', '没写过预设的人']);
    expect(hits.map((p) => p.name)).toEqual(['苏婉']);
  });

  it('refresh 从 Dexie 重新投影（刷新页面后预设还在）', async () => {
    const first = useImagePresetStore();
    await first.init();
    await first.upsert({
      kind: 'character',
      name: '苏婉',
      danbooru: { positive: 'x', negative: '' },
    });

    setActivePinia(createPinia());
    const reloaded = useImagePresetStore();
    await reloaded.init();
    expect(reloaded.find('character', '苏婉')?.dialects.danbooru?.positive).toBe('x');
  });
});

describe('改名', () => {
  it('删旧建新，内容带过去', async () => {
    const store = useImagePresetStore();
    await store.init();
    await store.upsert({
      kind: 'character',
      name: '苏婉',
      danbooru: { positive: '1girl, silver hair', negative: 'hat' },
      pinnedSeed: 42,
    });

    const res = await store.rename('character', '苏婉', '苏婉·维尔');
    expect(res.ok).toBe(true);
    expect(store.presets).toHaveLength(1);
    expect(store.find('character', '苏婉')).toBeUndefined();
    const moved = store.find('character', '苏婉·维尔');
    expect(moved?.dialects.danbooru).toEqual({ positive: '1girl, silver hair', negative: 'hat' });
    expect(moved?.pinnedSeed).toBe(42);
    // 旧主键在库里也没了
    expect(await getImagePreset('character:苏婉')).toBeUndefined();
  });

  it('目标名已被占用时拒绝（不自动编号 —— 编号过的名字永远查不中）', async () => {
    const store = useImagePresetStore();
    await store.init();
    await store.upsert({ kind: 'character', name: 'A' });
    await store.upsert({ kind: 'character', name: 'B' });

    const res = await store.rename('character', 'A', 'B');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('name-taken');
    expect(store.presets).toHaveLength(2);
  });

  it('源不存在时是 not-found', async () => {
    const store = useImagePresetStore();
    await store.init();
    const res = await store.rename('character', '查无此人', '新名字');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not-found');
  });
});

describe('pinnedSeed（§10.3 唯一现实可用的设置路径）', () => {
  it('目标预设不存在时就地建一条', async () => {
    const store = useImagePresetStore();
    await store.init();

    const res = await store.setPinnedSeed('还没写过预设的人', 987654321);
    expect(res.ok).toBe(true);
    const row = store.find('character', '还没写过预设的人');
    expect(row?.pinnedSeed).toBe(987654321);
    expect(row?.kind).toBe('character');
  });

  it('钉 seed 不吃掉已有的方言内容', async () => {
    const store = useImagePresetStore();
    await store.init();
    await store.upsert({
      kind: 'character',
      name: '苏婉',
      danbooru: { positive: '1girl', negative: 'hat' },
      prose: { positive: 'a young woman', negative: '' },
    });

    await store.setPinnedSeed('苏婉', 7);
    const row = store.find('character', '苏婉');
    expect(row?.pinnedSeed).toBe(7);
    expect(row?.dialects.danbooru).toEqual({ positive: '1girl', negative: 'hat' });
    expect(row?.dialects.prose).toEqual({ positive: 'a young woman', negative: '' });
  });

  it('传 undefined 即取消钉住（回到每次随机）', async () => {
    const store = useImagePresetStore();
    await store.init();
    await store.setPinnedSeed('苏婉', 7);
    await store.setPinnedSeed('苏婉', undefined);
    expect(store.find('character', '苏婉')?.pinnedSeed).toBeUndefined();
    expect((await getImagePreset('character:苏婉'))?.pinnedSeed).toBeUndefined();
  });
});

describe('删除', () => {
  it('按主键删，投影与库同步', async () => {
    const store = useImagePresetStore();
    await store.init();
    await store.upsert({ kind: 'location', name: '风铃旅店' });

    const res = await store.remove('location:风铃旅店');
    expect(res.ok).toBe(true);
    expect(store.presets).toHaveLength(0);
    expect(await getDatabase().imagePresets.count()).toBe(0);
  });
});
