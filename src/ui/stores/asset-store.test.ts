/**
 * asset-store.test.ts — 素材库 store 的执行契约测试 (Asset System v1)
 *
 * 覆盖 (设计 §9 的 `asset-store` 行 + round-trip 行):
 * 1. **往返幂等（最重要的一条）**: 导出 → 再导入回同一个库，**两半边都一个字节不加** ——
 *    素材不重复、音频不被 ` (2)` 克隆。这是整份契约最好的一个测试（§5.4）。
 * 2. 导出范围: 排除 `builtin`（占位授权不可再分发）与 `'file'`（字节不属于本应用），
 *    且**摘要把两项排除都说出来**。
 * 3. 改名: 正常 / 不变式拒收（D16）/ 撞位自动编号（§5.3）。
 * 4. 设为主图: **`_2` 已被占用**时也对 —— 证明用的是 max+1 分配器而不是硬编码 `_2`；
 *    先降级后清空，基图位从不被两行同时占据。
 *    并直接断言**两写同事务**: 第二写抛错时第一写回滚，绝不出现双基图。
 * 5. 删基图**不自动提拔**变体，组留成「无主图」。
 * 6. 批量删除部分失败 → 如实的 `{ok, skipped, failed}` + **恰好一条**提示。
 * 7. 署名（D10）走完 清单 → 落库 → 导出清单 一整圈，且不破坏往返幂等。
 * 8. 取消: 写库中途取消 → 已写入的留着、报「已取消」而不是失败、可重新导入补齐。
 * 9. `persist()` 被拒 → 如实记录，不抛。
 *
 * 数据层是**真 Dexie + fake-indexeddb**（src/test-setup.ts 注入），只在 database
 * 模块外面包一层用来注入"单行写/删失败"。zip 也是真 fflate —— 往返测试断的就是
 * 真实字节经过真实压缩包之后仍然被识别成重复。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, watch } from 'vue';
import { zipSync, strToU8 } from 'fflate';
import type { AssetMetaRecord, AudioTrack } from '@engine/types';

// ── @engine/database: 用真实实现（fake-indexeddb），只包一层失败注入 ──
const failFlags = {
  /** 这些 id 的 deleteAsset 会抛（批量删除的单条失败） */
  deleteFailIds: new Set<string>(),
  /** 这些 name 的 saveAsset 会抛 */
  saveFailNames: new Set<string>(),
  /**
   * 这些 type 的 saveAsset 会抛。
   *
   * 单独一把闸是因为「一源两图」两行**共用同一个 name**，按名字注入失败没法只打中
   * 其中一半 —— 而"立绘落了、头像没落"正是要验的那个部分成功。
   */
  saveFailTypes: new Set<string>(),
  /** 每次 saveAsset 落库成功之后回调 —— 用来在"写库中途"按下取消 */
  afterSaveAsset: null as null | (() => void),
};

vi.mock('@engine/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/database')>();
  return {
    ...actual,
    saveAsset: vi.fn(async (meta: AssetMetaRecord, blob?: Blob) => {
      if (failFlags.saveFailNames.has(meta.name)) throw new Error('写不进去');
      if (failFlags.saveFailTypes.has(meta.type)) throw new Error('写不进去');
      const id = await actual.saveAsset(meta, blob);
      failFlags.afterSaveAsset?.();
      return id;
    }),
    deleteAsset: vi.fn(async (id: string) => {
      if (failFlags.deleteFailIds.has(id)) throw new Error('删不掉');
      return actual.deleteAsset(id);
    }),
  };
});

// ── audio-store: 只给素材 store 用到的那两个公开面，避开 AudioManager / 单例 ──
const audioRefreshTracks = vi.fn(async () => {});
const builtinTracks: AudioTrack[] = [];
vi.mock('./audio-store', () => ({
  useAudioStore: () => ({ refreshTracks: audioRefreshTracks, builtinTracks }),
}));

import {
  clearAllData,
  initializeDatabase,
  getDatabase,
  getAssets,
  saveAsset,
  getAudioTracks,
  saveAudioTrack,
} from '@engine/database';
import { readAssetZip } from '../lib/asset-zip';
import type { ImageCropSeams } from '../lib/image-crop';
import {
  AVATAR_CROP_MAX_EDGE,
  PORTRAIT_CROP_MAX_EDGE,
  isZipFile,
  useAssetStore,
} from './asset-store';
import { useUIStore } from './ui-store';

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

/** 可预测的伪媒体字节（每个 seed 一份不同内容 → 不同哈希） */
function fakeBytes(seed: number, size = 96): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (seed * 31 + i * 17) % 251;
  return out;
}

interface ZipSpec {
  [name: string]: Uint8Array;
}

function makeZip(files: ZipSpec, manifest?: unknown): Uint8Array {
  const payload: Record<string, Uint8Array> = { ...files };
  if (manifest !== undefined) payload['manifest.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(payload);
}

/** 一个"典型包": 两条素材（一条带变体）+ 一条音频 + 带署名的清单 */
function typicalZip(): Uint8Array {
  return makeZip(
    {
      '苏婉_头像.png': fakeBytes(1),
      '苏婉_立绘_微笑.png': fakeBytes(2),
      '战斗主题.mp3': fakeBytes(3),
    },
    {
      assets: { '苏婉_头像.png': { credit: '画师甲', license: 'CC-BY' } },
      audio: { '战斗主题.mp3': { tags: ['情境:战斗'], credit: 'Aoo' } },
    },
  );
}

function makeAssetRow(over: Partial<AssetMetaRecord> = {}): AssetMetaRecord {
  const now = Date.now();
  return {
    id: `a_${Math.random().toString(36).slice(2)}`,
    name: '苏婉',
    type: '头像',
    ext: 'png',
    mime: 'image/png',
    bytes: 96,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function makeTrack(over: Partial<AudioTrack> = {}): AudioTrack {
  const now = Date.now();
  return {
    id: `t_${Math.random().toString(36).slice(2)}`,
    name: '曲子',
    kind: 'music',
    source: 'blob',
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function toasts(): { message: string; type: string }[] {
  return useUIStore().toasts.map((t) => ({ message: t.message, type: t.type }));
}

/** 记下并在收尾时还原被替身掉的 navigator */
let navigatorPatched = false;
function stubNavigatorStorage(storage: unknown): void {
  navigatorPatched = true;
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage },
    configurable: true,
    writable: true,
  });
}

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* 首次运行时库还不存在 */
  }
  await initializeDatabase();
  setActivePinia(createPinia());
  failFlags.deleteFailIds.clear();
  failFlags.saveFailNames.clear();
  failFlags.saveFailTypes.clear();
  failFlags.afterSaveAsset = null;
  builtinTracks.length = 0;
  audioRefreshTracks.mockClear();
});

afterEach(() => {
  if (navigatorPatched) {
    Reflect.deleteProperty(globalThis as object, 'navigator');
    navigatorPatched = false;
  }
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════
// 1. 往返幂等 —— 设计 §5.4 的必测项
// ═══════════════════════════════════════════════════════════

describe('往返: 导出 → 再导入 一个字节都不加', () => {
  it('两半边都幂等：素材不重复、音频不被 (2) 克隆', async () => {
    const store = useAssetStore();

    const first = await store.importZip(typicalZip());
    expect(first.read).toBe(true);
    expect(first.assetsAdded).toBe(2);
    expect(first.audioAdded).toBe(1);
    expect(first.failed).toBe(0);
    // 清单只能**追加**元数据
    expect(store.assets.find((a) => a.variant === undefined)?.credit).toBe('画师甲');
    expect((await getAudioTracks())[0].tags).toEqual(['情境:战斗']);

    // ── 导出 ──
    const exported = await store.exportZip();
    expect(exported.blob).not.toBeNull();
    expect(exported.assets).toBe(2);
    expect(exported.audio).toBe(1);
    const bytes = new Uint8Array(await exported.blob!.arrayBuffer());

    // ── 再导入回同一个库 ──
    const second = await store.importZip(bytes);
    expect(second.read).toBe(true);
    expect(second.assetsAdded).toBe(0);
    expect(second.audioAdded).toBe(0);
    expect(second.failed).toBe(0);
    // 三条全部被认成重复（素材按 (name,type) 作用域，音频按规范名）
    expect(second.duplicatesSkipped).toBe(3);
    expect(second.renumbered).toBe(0);

    // ── 库确实没变 ──
    const rows = await getAssets();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.name === '苏婉')).toHaveLength(2);
    const tracks = await getAudioTracks();
    expect(tracks).toHaveLength(1);
    // ` (2)` 克隆是"半幂等"的典型症状，比两边都不幂等更糟
    expect(tracks[0].name).toBe('战斗主题');
  });

  it('往返保住素材的 name / type / variant（格式化→解析不改行）', async () => {
    const store = useAssetStore();
    await store.importZip(typicalZip());
    const before = (await getAssets()).map((r) => `${r.name}|${r.type}|${r.variant ?? ''}`).sort();

    const exported = await store.exportZip();
    await store.importZip(new Uint8Array(await exported.blob!.arrayBuffer()));

    const after = (await getAssets()).map((r) => `${r.name}|${r.type}|${r.variant ?? ''}`).sort();
    expect(after).toEqual(before);
    expect(after).toEqual(['苏婉|头像|', '苏婉|立绘|微笑']);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 导出范围 (D17)
// ═══════════════════════════════════════════════════════════

describe('导出范围', () => {
  it('排除 builtin 与 file 音频，且摘要把两项排除都说出来', async () => {
    const store = useAssetStore();
    await store.importZip(makeZip({ '苏婉_头像.png': fakeBytes(1), '战斗主题.mp3': fakeBytes(3) }));

    // 内置曲目不落 Dexie，由音频 store 的 builtinTracks 提供
    builtinTracks.push(
      makeTrack({ id: 'b1', name: '内置一', source: 'builtin', builtin: true }),
      makeTrack({ id: 'b2', name: '内置二', source: 'builtin', builtin: true }),
    );
    // 本机文件夹曲目：行在 Dexie 里，字节不在
    await saveAudioTrack(
      makeTrack({ id: 'f1', name: '本地一', source: 'file', relativePath: 'a.mp3' }),
    );

    const res = await store.exportZip();
    expect(res.assets).toBe(1);
    expect(res.audio).toBe(1);
    expect(res.skippedBuiltin).toBe(2);
    expect(res.skippedFile).toBe(1);
    expect(res.message).toContain('已导出 素材 1 · 音频 1');
    expect(res.message).toContain('内置 2');
    expect(res.message).toContain('本地文件 1');

    // 导出包里确实没有它们
    const store2 = useAssetStore();
    const reimported = await store2.importZip(new Uint8Array(await res.blob!.arrayBuffer()));
    expect(reimported.duplicatesSkipped).toBe(2); // 只有那两条自己的
  });

  it('库为空时不产出包，并说清什么都没有可导的', async () => {
    const store = useAssetStore();
    const res = await store.exportZip();
    expect(res.blob).toBeNull();
    expect(res.message).toContain('没有可导出的内容');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 改名 (D14 / D16 / §5.3)
// ═══════════════════════════════════════════════════════════

describe('renameAsset', () => {
  it('正常改名：name / type / variant 三个字段都能改', async () => {
    const row = makeAssetRow({ name: '苏婉', type: '头像' });
    await saveAsset(row);
    const store = useAssetStore();
    await store.init();

    const res = await store.renameAsset(row.id, { name: '林清', type: '立绘', variant: '微笑' });
    expect(res.outcome).toBe('ok');
    expect(res.renumberedFrom).toBeUndefined();
    const after = store.findAsset(row.id);
    expect(after?.name).toBe('林清');
    expect(after?.type).toBe('立绘');
    expect(after?.variant).toBe('微笑');
  });

  it('拒收违反命名不变式的改名（variant 里含类型 token）', async () => {
    const row = makeAssetRow();
    await saveAsset(row);
    const store = useAssetStore();
    await store.init();

    // (苏婉, 头像, 变体=立绘) 正是 §2.3 那个往返会静默改行的反例
    const res = await store.renameAsset(row.id, { variant: '立绘' });
    expect(res.outcome).toBe('naming-invariant');
    expect(store.findAsset(row.id)?.variant).toBeUndefined();

    // name 里含类型 token 同样拒
    expect((await store.renameAsset(row.id, { name: '苏婉_头像' })).outcome).toBe(
      'naming-invariant',
    );
  });

  it('目标位被占 → 自动编号（max+1，且换号不嵌套）', async () => {
    const base = makeAssetRow({ id: 'r-base' });
    const smile = makeAssetRow({ id: 'r-smile', variant: '微笑' });
    const smile2 = makeAssetRow({ id: 'r-smile2', variant: '微笑 2' });
    const other = makeAssetRow({ id: 'r-other', variant: '生气' });
    for (const r of [base, smile, smile2, other]) await saveAsset(r);
    const store = useAssetStore();
    await store.init();

    // 「生气」→「微笑」: 微笑 与 微笑 2 都占了 → 微笑 3（不是 微笑 2 2）
    const res = await store.renameAsset('r-other', { variant: '微笑' });
    expect(res.outcome).toBe('ok');
    expect(res.renumberedFrom).toBe('微笑');
    expect(store.findAsset('r-other')?.variant).toBe('微笑 3');

    // 撞基图位 → 号进变体位，原变体记作空串（"本来没有变体"）
    const loose = makeAssetRow({ id: 'r-loose', name: '苏婉', type: '头像' });
    await saveAsset(loose);
    await store.refreshAssets();
    const res2 = await store.renameAsset('r-loose', { variant: '' });
    expect(res2.outcome).toBe('ok');
    expect(res2.renumberedFrom).toBe('');
    expect(store.findAsset('r-loose')?.variant).toBe('2');
  });

  it('查无此行 / 空名字 分别给出可判别结论', async () => {
    const store = useAssetStore();
    await store.init();
    expect((await store.renameAsset('nope', { name: 'x' })).outcome).toBe('not-found');

    const row = makeAssetRow();
    await saveAsset(row);
    await store.refreshAssets();
    expect((await store.renameAsset(row.id, { name: '' })).outcome).toBe('naming-invariant');
  });

  it('前后空白**原样保留**，不 trim（D2: 名字保持原始，且空白在 zip 条目名里可表示）', async () => {
    const row = makeAssetRow();
    await saveAsset(row);
    const store = useAssetStore();
    await store.init();

    expect((await store.renameAsset(row.id, { name: ' 苏婉 ' })).outcome).toBe('ok');
    expect(store.findAsset(row.id)?.name).toBe(' 苏婉 ');
    // 它是与「苏婉」不同的另一个组 —— 严格 === 分组的自然结果
    expect(store.groups.map((g) => g.name)).toEqual([' 苏婉 ']);
  });

  it('D19: 名字/变体带分隔符、或名字以点开头 → 拒收（进不了 zip 条目名）', async () => {
    const row = makeAssetRow({ id: 'd19' });
    await saveAsset(row);
    const store = useAssetStore();
    await store.init();

    for (const name of ['圣殿/内庭', '圣殿\\内庭', '.隐藏', './x']) {
      expect((await store.renameAsset('d19', { name })).outcome).toBe('unrepresentable-name');
    }
    expect((await store.renameAsset('d19', { variant: 'a/b' })).outcome).toBe(
      'unrepresentable-name',
    );
    // 一次都没落库
    expect(store.findAsset('d19')?.name).toBe('苏婉');
    expect(store.findAsset('d19')?.variant).toBeUndefined();
  });

  it('D11 回归: 两行改成同一个带分隔符的名字，绝不产生两个基图', async () => {
    const a = makeAssetRow({ id: 'sep-1', name: 'A' });
    const b = makeAssetRow({ id: 'sep-2', name: 'B' });
    for (const r of [a, b]) await saveAsset(r);
    const store = useAssetStore();
    await store.init();

    // 旧实现把名字格式化成文件名再喂计划器，basenameOf 在最后一个 `/` 处拍平，
    // 于是两行都被算到「另一个组」上、都以为 base 位空着 —— 一个组两个基图。
    expect((await store.renameAsset('sep-1', { name: 'a/b' })).outcome).toBe(
      'unrepresentable-name',
    );
    expect((await store.renameAsset('sep-2', { name: 'a/b' })).outcome).toBe(
      'unrepresentable-name',
    );

    const bases = store.assets.filter((r) => r.variant === undefined || r.variant === '');
    expect(bases).toHaveLength(2);
    expect(new Set(bases.map((r) => r.name))).toEqual(new Set(['A', 'B'])); // 谁都没改成 a/b
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 设为主图 (§7.4)
// ═══════════════════════════════════════════════════════════

describe('setPrimary', () => {
  it('_2 已被占用时也对：现任基图按 max+1 降级，不是硬编码 _2', async () => {
    const base = makeAssetRow({ id: 'p-base' });
    const two = makeAssetRow({ id: 'p-2', variant: '2' });
    const three = makeAssetRow({ id: 'p-3', variant: '3' });
    for (const r of [base, two, three]) await saveAsset(r);
    const store = useAssetStore();
    await store.init();

    const res = await store.setPrimary('p-3');
    expect(res.outcome).toBe('ok');

    // 所选行成了基图；现任基图拿到 4（硬编码 _2 会撞上 p-2）
    expect(store.findAsset('p-3')?.variant).toBeUndefined();
    expect(store.findAsset('p-base')?.variant).toBe('4');
    expect(store.findAsset('p-2')?.variant).toBe('2');

    // 基图位有且只有一行 —— 顺序（先降级后清空）保证的正是这一点
    const bases = store
      .rowsInGroup('苏婉', '头像')
      .filter((r) => r.variant === undefined || r.variant === '');
    expect(bases).toHaveLength(1);
    expect(bases[0].id).toBe('p-3');
  });

  it('降级要占的号已经被占：继续 max+1 往上走，绝不覆盖', async () => {
    // base + _2 + _5 三行，提拔 _2 → 现任基图不能拿 2（它自己就是 2 挪走的位）也不能拿 5
    const base = makeAssetRow({ id: 'm-base' });
    const two = makeAssetRow({ id: 'm-2', variant: '2' });
    const five = makeAssetRow({ id: 'm-5', variant: '5' });
    for (const r of [base, two, five]) await saveAsset(r);
    const store = useAssetStore();
    await store.init();

    expect((await store.setPrimary('m-2')).outcome).toBe('ok');
    expect(store.findAsset('m-2')?.variant).toBeUndefined();
    expect(store.findAsset('m-base')?.variant).toBe('6'); // max(base=1, 2, 5) + 1
    expect(store.findAsset('m-5')?.variant).toBe('5'); // 没被动过
  });

  it('组里本来没有基图 → 一次写入即可提拔', async () => {
    const only = makeAssetRow({ id: 'q-1', variant: '微笑' });
    await saveAsset(only);
    const store = useAssetStore();
    await store.init();

    expect((await store.setPrimary('q-1')).outcome).toBe('ok');
    expect(store.findAsset('q-1')?.variant).toBeUndefined();
  });

  it('降级与清空在同一个事务里：第二写失败则第一写回滚（绝不出现双基图）', async () => {
    const base = makeAssetRow({ id: 'tx-base' });
    const two = makeAssetRow({ id: 'tx-2', variant: '2' });
    for (const r of [base, two]) await saveAsset(r);
    const store = useAssetStore();
    await store.init();

    // 事务里的第二个 put 抛错 → Dexie 应回滚第一个 put（降级）
    const table = getDatabase().assetMeta;
    const realPut = table.put.bind(table);
    let calls = 0;
    const spy = vi.spyOn(table, 'put').mockImplementation((...args: Parameters<typeof realPut>) => {
      calls += 1;
      if (calls === 2) throw new Error('第二写失败');
      return realPut(...args);
    });

    expect((await store.setPrimary('tx-2')).outcome).toBe('failed');
    spy.mockRestore();

    // 两行都没动：基图仍是 tx-base，tx-2 仍带着变体 —— 绝没有两行同占基图位
    await store.refreshAssets();
    const rows = store.rowsInGroup('苏婉', '头像');
    const bases = rows.filter((r) => r.variant === undefined || r.variant === '');
    expect(bases).toHaveLength(1);
    expect(bases[0].id).toBe('tx-base');
    expect(store.findAsset('tx-2')?.variant).toBe('2');
  });

  it('已经是基图 / 查无此行 → 可判别结论，不写库', async () => {
    const base = makeAssetRow({ id: 'z-base' });
    await saveAsset(base);
    const store = useAssetStore();
    await store.init();
    expect((await store.setPrimary('z-base')).outcome).toBe('already-base');
    expect((await store.setPrimary('missing')).outcome).toBe('not-found');
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 删除
// ═══════════════════════════════════════════════════════════

describe('删除', () => {
  it('删基图**不自动提拔**变体：组留成「无主图」', async () => {
    const base = makeAssetRow({ id: 'd-base' });
    const smile = makeAssetRow({ id: 'd-smile', variant: '微笑' });
    for (const r of [base, smile]) await saveAsset(r);
    const store = useAssetStore();
    await store.init();

    expect(await store.deleteAsset('d-base')).toBe(true);

    const group = store.groups.find((g) => g.name === '苏婉');
    expect(group).toBeDefined();
    expect(group!.total).toBe(1);
    expect(group!.variantCount).toBe(1);
    expect(group!.baseTypes).toEqual([]);
    expect(group!.baselessTypes).toEqual(['头像']); // §8 的「无主图」
    expect(store.findAsset('d-smile')?.variant).toBe('微笑'); // 文件名一个字没被改写
  });

  it('批量删除部分失败 → 如实的 {ok, skipped, failed} + 恰好一条提示', async () => {
    const a = makeAssetRow({ id: 'b-1' });
    const b = makeAssetRow({ id: 'b-2', variant: '微笑' });
    const c = makeAssetRow({ id: 'b-3', variant: '生气' });
    for (const r of [a, b, c]) await saveAsset(r);
    const store = useAssetStore();
    await store.init();

    failFlags.deleteFailIds.add('b-2');
    const res = await store.deleteAssets(['b-1', 'b-2', 'b-3', 'not-there']);

    expect(res).toEqual({ ok: 2, skipped: 1, failed: 1 });
    // 单条失败不中断：b-3 在 b-2 之后，照样删掉了
    expect(store.findAsset('b-3')).toBeUndefined();
    expect(store.findAsset('b-2')).toBeDefined(); // 如实留在库里

    const list = toasts();
    expect(list).toHaveLength(1); // 一条汇总，不是每条一个
    expect(list[0].type).toBe('error');
    expect(list[0].message).toContain('已删除 2');
    expect(list[0].message).toContain('1 条没能删除');
  });

  it('全部成功 → 一条 info 汇总', async () => {
    const a = makeAssetRow({ id: 'g-1' });
    await saveAsset(a);
    const store = useAssetStore();
    await store.init();

    const res = await store.deleteAssets(['g-1']);
    expect(res).toEqual({ ok: 1, skipped: 0, failed: 0 });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].type).toBe('info');
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 导入的错误与告警面
// ═══════════════════════════════════════════════════════════

describe('importZip 的错误与汇总', () => {
  it('截断的压缩包 → 包成人话，绝不让 AssetZipError 逃出去', async () => {
    const whole = typicalZip();
    // 砍掉后半截：fflate 在最后一块 push 时会发现压缩长度没喂满（err 13）
    const truncated = whole.slice(0, Math.floor(whole.length / 2));
    const store = useAssetStore();
    const res = await store.importZip(truncated);
    expect(res.read).toBe(false);
    expect(res.assetsAdded).toBe(0);
    expect(res.message).toContain('导入失败');
    const list = toasts();
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('error');
  });

  it('压根不是 zip 的字节 → 读成"零条目"，如实报全部跳过而不是假装失败', async () => {
    // asset-zip 的已知限制: 只丢中央目录/根本没有局部头的输入读不出条目，也报不出错。
    // 这种输入不该被谎称成"导入失败"，也不该抛 —— 库没变，就说库没变。
    const store = useAssetStore();
    const res = await store.importZip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(res.assetsAdded + res.audioAdded).toBe(0);
    expect(res.failed).toBe(0);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toContain('全部跳过');
  });

  it('单条写入失败不中断其余，且摘要如实说出部分成功', async () => {
    failFlags.saveFailNames.add('林清');
    const store = useAssetStore();
    const res = await store.importZip(
      makeZip({
        '苏婉_头像.png': fakeBytes(1),
        '林清_头像.png': fakeBytes(2),
        '战斗主题.mp3': fakeBytes(3),
      }),
    );
    expect(res.assetsAdded).toBe(1);
    expect(res.audioAdded).toBe(1); // 素材半边失败没连累音频半边
    expect(res.failed).toBe(1);
    const list = toasts();
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('error');
    expect(list[0].message).toContain('1 个文件没能写入');
  });

  it('噪音与不认的扩展名只计入「忽略无关文件」，不让导入失败', async () => {
    const store = useAssetStore();
    const res = await store.importZip(
      makeZip({
        'assets/苏婉_头像.png': fakeBytes(1), // 目录被拍平
        'readme.txt': strToU8('说明'),
        '__MACOSX/._苏婉_头像.png': fakeBytes(9),
        '.DS_Store': fakeBytes(8),
      }),
    );
    expect(res.assetsAdded).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.ignored).toBeGreaterThanOrEqual(3);
    expect(res.message).toContain('忽略无关文件');
  });

  it('一条都没动时说「全部跳过」，且只有一条提示', async () => {
    const store = useAssetStore();
    await store.importZip(typicalZip());
    useUIStore().toasts.length = 0;

    const again = await store.importZip(typicalZip());
    expect(again.assetsAdded + again.audioAdded).toBe(0);
    const list = toasts();
    expect(list).toHaveLength(1);
    expect(list[0].message).toContain('全部跳过');
  });

  it('音频半边写完会调音频 store 的公开刷库动作', async () => {
    const store = useAssetStore();
    await store.importZip(makeZip({ '战斗主题.mp3': fakeBytes(3) }));
    expect(audioRefreshTracks).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 6b. 署名（D10）: 清单带进来 → 落库 → 再随导出带出去
// ═══════════════════════════════════════════════════════════

describe('署名的完整链条', () => {
  it('音频的 credit / license 落库，并随导出清单带回去', async () => {
    const store = useAssetStore();
    await store.importZip(typicalZip());

    // 落库（AudioTrack 新增的两列）
    const track = (await getAudioTracks())[0];
    expect(track.credit).toBe('Aoo');
    expect(track.license).toBeUndefined(); // 清单里没写 license 就不该凭空补

    // 素材那半边同样
    expect(store.assets.find((a) => a.variant === undefined)?.license).toBe('CC-BY');

    // 导出清单里两边都在
    const res = await store.exportZip();
    const back = await readAssetZip(new Uint8Array(await res.blob!.arrayBuffer()));
    expect(back.manifest?.audio['战斗主题.mp3']).toEqual({ tags: ['情境:战斗'], credit: 'Aoo' });
    expect(back.manifest?.assets['苏婉_头像.png']).toEqual({ credit: '画师甲', license: 'CC-BY' });
  });

  it('署名走完一整圈往返仍然幂等（不因为多了两列而重复导入）', async () => {
    const store = useAssetStore();
    await store.importZip(typicalZip());
    const res = await store.exportZip();
    const again = await store.importZip(new Uint8Array(await res.blob!.arrayBuffer()));
    expect(again.assetsAdded + again.audioAdded).toBe(0);
    expect(again.duplicatesSkipped).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════
// 6c. 取消 (§7.6)
// ═══════════════════════════════════════════════════════════

describe('cancelImport', () => {
  it('写库中途取消：已写入的留着，报「已取消」而不是失败', async () => {
    const store = useAssetStore();
    // 第一条素材落库之后立刻取消 —— 写库是大包里耗时的那一半，取消必须在这里也生效
    failFlags.afterSaveAsset = () => {
      store.cancelImport();
    };

    const res = await store.importZip(
      makeZip({
        '苏婉_头像.png': fakeBytes(1),
        '林清_头像.png': fakeBytes(2),
        '战斗主题.mp3': fakeBytes(3),
      }),
    );

    expect(res.cancelled).toBe(true);
    expect(res.failed).toBe(0); // 取消不是失败
    expect(res.assetsAdded).toBe(1);
    expect(res.audioAdded).toBe(0); // 音频半边也不再往下写
    // 已写入的**如实留着**，不回滚
    expect(await getAssets()).toHaveLength(1);

    const list = toasts();
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('info'); // 用户自己按的取消不该是红字
    expect(list[0].message).toContain('已取消导入');
    expect(list[0].message).toContain('留在库里');
  });

  it('取消后重新导入同一个包即可补齐（已有的算重复）', async () => {
    const store = useAssetStore();
    failFlags.afterSaveAsset = () => {
      store.cancelImport();
    };
    const zip = makeZip({ '苏婉_头像.png': fakeBytes(1), '林清_头像.png': fakeBytes(2) });
    await store.importZip(zip);
    failFlags.afterSaveAsset = null;

    const res = await store.importZip(zip);
    expect(res.cancelled).toBe(false);
    expect(res.assetsAdded).toBe(1);
    expect(res.duplicatesSkipped).toBe(1);
    expect(await getAssets()).toHaveLength(2);
  });

  it('取消发生在解压段：readAssetZip 以 code aborted 拒绝，仍报「已取消」且库没变', async () => {
    const store = useAssetStore();
    // 解压是异步的，下一个宏任务就取消 —— 落在 readAssetZip 的检查点上
    const p = store.importZip(typicalZip());
    store.cancelImport();
    const res = await p;

    expect(res.cancelled).toBe(true);
    expect(res.failed).toBe(0);
    expect(res.assetsAdded + res.audioAdded).toBe(0);
    expect(await getAssets()).toHaveLength(0);
    const list = toasts();
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('info');
    expect(list[0].message).toContain('已取消导入');
  });

  it('cancelImport 在 store 返回对象里（不然调用方看不见它）', () => {
    const store = useAssetStore();
    expect(typeof store.cancelImport).toBe('function');
    expect('cancelImport' in store).toBe(true);
  });

  it('没有在飞导入时 cancelImport() 是无害空操作', () => {
    const store = useAssetStore();
    expect(() => store.cancelImport()).not.toThrow();
    expect(store.importing).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 6e. importFiles —— 单文件导入走同一条管线 (§7.3)
// ═══════════════════════════════════════════════════════════

describe('importFiles', () => {
  const asFile = (name: string, bytes: Uint8Array): File =>
    new File([bytes.slice().buffer as ArrayBuffer], name);

  it('图片 + 音频 + 杂项混选: 各归各位，杂项算「忽略」而不是失败', async () => {
    const store = useAssetStore();
    const res = await store.importFiles([
      asFile('苏婉_头像.png', fakeBytes(1)),
      asFile('苏婉_立绘_微笑.png', fakeBytes(2)),
      asFile('战斗主题.mp3', fakeBytes(3)), // 按扩展名路由 → 落音频库，不是素材
      asFile('设定稿.psd', fakeBytes(4)),
      asFile('readme.txt', strToU8('说明')),
    ]);

    expect(res.read).toBe(true);
    expect(res.assetsAdded).toBe(2);
    expect(res.audioAdded).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.ignored).toBe(2); // psd + txt：跳过，不是拒绝
    expect(res.message).toContain('忽略无关文件 2');

    expect(await getAssets()).toHaveLength(2);
    const tracks = await getAudioTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0].name).toBe('战斗主题');
    expect(tracks[0].source).toBe('blob');
    expect(audioRefreshTracks).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(1);
  });

  it('复用同一条管线: 去重 / 编号 / D16 拒收 全都白拿', async () => {
    const store = useAssetStore();
    await store.importFiles([asFile('苏婉_头像.png', fakeBytes(1))]);

    const again = await store.importFiles([
      asFile('苏婉_头像.png', fakeBytes(1)), // 同字节 → 哈希去重
      asFile('苏婉_头像.png', fakeBytes(9)), // 不同字节 → 编号进变体位
      asFile('苏婉_头像_立绘.png', fakeBytes(7)), // D16: name 里含类型 token
    ]);
    expect(again.duplicatesSkipped).toBe(1);
    expect(again.renumbered).toBe(1);
    expect(again.namingConflicts).toBe(1);
    // Array#sort 永远把 undefined 排到末尾 —— 基图那行没有变体
    expect(store.assets.map((a) => a.variant).sort()).toEqual(['2', undefined]);
  });

  it('单文件路径没有清单，所以没有署名（要带署名就打包成 zip）', async () => {
    const store = useAssetStore();
    await store.importFiles([asFile('苏婉_头像.png', fakeBytes(1))]);
    expect(store.assets[0].credit).toBeUndefined();
    expect(store.assets[0].license).toBeUndefined();
  });

  it('空选择 → 什么都不做，一条「全部跳过」提示', async () => {
    const store = useAssetStore();
    const res = await store.importFiles([]);
    expect(res.assetsAdded + res.audioAdded).toBe(0);
    expect(res.failed).toBe(0);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toContain('全部跳过');
  });
});

// ═══════════════════════════════════════════════════════════
// 6f. importAny —— 混合拖拽只产出**一条**提示 (§7.2)
// ═══════════════════════════════════════════════════════════

describe('importAny', () => {
  const asFile = (name: string, bytes: Uint8Array, type = ''): File =>
    new File([bytes.slice().buffer as ArrayBuffer], name, { type });

  it('一个 zip + 两个散文件 → 恰好一条提示，计数相加', async () => {
    const store = useAssetStore();
    const res = await store.importAny([
      asFile('pack.zip', typicalZip(), 'application/zip'),
      asFile('林清_头像.png', fakeBytes(11)),
      asFile('林清_立绘_微笑.png', fakeBytes(12)),
    ]);

    // zip: 2 素材 + 1 音频；散装: 2 素材
    expect(res.assetsAdded).toBe(4);
    expect(res.audioAdded).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.read).toBe(true);
    expect(await getAssets()).toHaveLength(4);
    expect(await getAudioTracks()).toHaveLength(1);

    // §7.2: 一次导入 = 一条摘要，无论它由几个半边组成
    const list = toasts();
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('info');
    expect(list[0].message).toContain('素材 4 新增');
    expect(list[0].message).toContain('音频 1 新增');
    expect(res.message).toBe(list[0].message);
  });

  it('坏 zip + 好散文件: 散文件照常导入，坏包如实点名，仍然只有一条提示', async () => {
    const whole = typicalZip();
    const store = useAssetStore();
    const res = await store.importAny([
      asFile('broken.zip', whole.slice(0, Math.floor(whole.length / 2)), 'application/zip'),
      asFile('林清_头像.png', fakeBytes(11)),
    ]);

    // 读取失败**不掩盖**另一半的成功
    expect(res.assetsAdded).toBe(1);
    expect(res.read).toBe(false);
    expect(res.readErrors).toHaveLength(1);
    expect(await getAssets()).toHaveLength(1);

    const list = toasts();
    expect(list).toHaveLength(1);
    expect(list[0].message).toContain('素材 1 新增'); // 成功的那半边照样报出来
    expect(list[0].message).toContain('读取失败'); // 坏包也没被藏起来
  });

  it('告警取并集，两个半边都缺哈希只说一次', async () => {
    // 让整个环境算不出哈希 → 两个半边各自都会报 hash-unavailable
    // 只抽掉 subtle（非安全上下文的真实样子），randomUUID 留着 —— 它是 id 与 toast 的来源
    const realCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => realCrypto.randomUUID() },
      configurable: true,
      writable: true,
    });
    try {
      const store = useAssetStore();
      const res = await store.importAny([
        asFile('pack.zip', makeZip({ '苏婉_头像.png': fakeBytes(1) })),
        asFile('林清_头像.png', fakeBytes(11)),
      ]);
      expect(res.assetsAdded).toBe(2);
      expect(res.warnings.filter((w) => w === 'hash-unavailable')).toHaveLength(1);
      expect(toasts()).toHaveLength(1);
      // 算不出哈希时不许承诺"再导一次会识别成重复"
      expect(toasts()[0].message).not.toContain('识别成重复而跳过');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
        writable: true,
      });
    }
  });

  it('isZipFile: 扩展名优先，MIME 兜底（Windows 会报 x-zip-compressed 甚至空 type）', () => {
    expect(isZipFile(asFile('pack.zip', fakeBytes(1), ''))).toBe(true);
    expect(isZipFile(asFile('PACK.ZIP', fakeBytes(1), ''))).toBe(true);
    expect(isZipFile(asFile('pack', fakeBytes(1), 'application/x-zip-compressed'))).toBe(true);
    expect(isZipFile(asFile('pack', fakeBytes(1), 'application/zip'))).toBe(true);
    expect(isZipFile(asFile('苏婉_头像.png', fakeBytes(1), 'image/png'))).toBe(false);
  });

  it('全是散文件 / 全是 zip 时行为与单入口一致', async () => {
    const store = useAssetStore();
    const onlyFiles = await store.importAny([asFile('苏婉_头像.png', fakeBytes(1))]);
    expect(onlyFiles.assetsAdded).toBe(1);
    useUIStore().toasts.length = 0;

    const onlyZip = await store.importAny([
      asFile('p.zip', makeZip({ '林清_头像.png': fakeBytes(2) })),
    ]);
    expect(onlyZip.assetsAdded).toBe(1);
    expect(toasts()).toHaveLength(1);
  });

  it('空数组 → 一条「全部跳过」，不炸', async () => {
    const store = useAssetStore();
    const res = await store.importAny([]);
    expect(res.read).toBe(true);
    expect(res.assetsAdded + res.audioAdded).toBe(0);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toContain('全部跳过');
  });
});

// ═══════════════════════════════════════════════════════════
// 6g. importForCharacter —— 定点导入（花名册驱动，§7.3）
//
// 这条路径与其它导入入口的唯一区别是**名字从哪来**: 文件名只贡献扩展名，
// name / type 由被聚焦的槽位给定。其余（D16 / D19 / D7 / D12 去重 / D11
// 永不覆盖）必须与整批导入逐位一致 —— 下面每条断言都在盯这一点。
// ═══════════════════════════════════════════════════════════

describe('importForCharacter', () => {
  const asFile = (name: string, bytes: Uint8Array): File =>
    new File([bytes.slice().buffer as ArrayBuffer], name);

  it('强制改名: 源文件名只贡献扩展名，绝不长出 IMG_1234 这个幽灵角色组', async () => {
    const store = useAssetStore();
    const res = await store.importForCharacter(
      asFile('IMG_1234.PNG', fakeBytes(1)),
      '苏婉',
      '立绘',
    );

    expect(res.outcome).toBe('ok');
    expect(res.id).toBeTruthy();

    const rows = await getAssets();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('苏婉');
    expect(rows[0].type).toBe('立绘');
    expect(rows[0].variant).toBeUndefined();
    // 扩展名归一化到路由表的键；MIME 由表说了算，不信 File.type
    expect(rows[0].ext).toBe('png');
    expect(rows[0].mime).toBe('image/png');
    // §2 的 phantom group 风险在这条路径上根本不存在
    expect(store.groups.map((g) => g.name)).toEqual(['苏婉']);
  });

  it('媒体规则 (D7): 立绘拒 mp4，头像收 mp4', async () => {
    const store = useAssetStore();

    const rejected = await store.importForCharacter(asFile('a.mp4', fakeBytes(5)), '苏婉', '立绘');
    expect(rejected.outcome).toBe('media-rule');
    expect(rejected.id).toBeUndefined();
    expect(await getAssets()).toHaveLength(0);

    const accepted = await store.importForCharacter(asFile('a.mp4', fakeBytes(5)), '苏婉', '头像');
    expect(accepted.outcome).toBe('ok');
    const rows = await getAssets();
    expect(rows).toHaveLength(1);
    expect(rows[0].mime).toBe('video/mp4');
  });

  it('撞基图位 → 编号进变体位（永不覆盖），然后被提成主图', async () => {
    const store = useAssetStore();
    const first = await store.importForCharacter(asFile('a.png', fakeBytes(1)), '苏婉', '头像');
    const second = await store.importForCharacter(asFile('b.png', fakeBytes(2)), '苏婉', '头像');

    expect(second.outcome).toBe('ok');
    const rows = await getAssets();
    expect(rows).toHaveLength(2); // 旧行**没有**被覆盖

    const added = rows.find((r) => r.id === second.id);
    const previous = rows.find((r) => r.id === first.id);
    expect(added?.variant).toBeUndefined(); // 新的这张就是槽位现在显示的那张
    // 旧主图拿到的是 `3` 而不是 `2` —— 这正是"新行先落在变体位 `2` 上、
    // 再由 setPrimary 用 max+1 把旧主图挪走"的证据（§5.3：max+1，不是首个空位）
    expect(previous?.variant).toBe('3');
  });

  it('同字节重导: 不长第二行，但那一行**照样**成为主图', async () => {
    const store = useAssetStore();
    const a = await store.importForCharacter(asFile('a.png', fakeBytes(1)), '苏婉', '头像');
    // 把 a 挤成变体（b 成为主图），这样"仍然提主图"才有可观测的后果
    const b = await store.importForCharacter(asFile('b.png', fakeBytes(2)), '苏婉', '头像');
    expect(store.findAsset(a.id!)?.variant).toBe('3');

    const again = await store.importForCharacter(
      asFile('完全不同的名字.png', fakeBytes(1)),
      '苏婉',
      '头像',
    );
    expect(again.outcome).toBe('ok');
    expect(again.id).toBe(a.id); // 认成了库里已有的那一行
    expect(await getAssets()).toHaveLength(2); // 没有第三行
    expect(store.findAsset(a.id!)?.variant).toBeUndefined(); // 它现在是主图
    expect(store.findAsset(b.id!)?.variant).toBeTruthy();
  });

  it('去重作用域仍是 (name, type): 同一张占位图能给第二个角色用', async () => {
    const store = useAssetStore();
    await store.importForCharacter(asFile('a.png', fakeBytes(1)), '苏婉', '头像');
    const other = await store.importForCharacter(asFile('a.png', fakeBytes(1)), '林清', '头像');
    expect(other.outcome).toBe('ok');
    expect(await getAssets()).toHaveLength(2);
  });

  it('名字过不了 D16 / D19 时**拒收**，绝不静默改名', async () => {
    const store = useAssetStore();

    // D16: name 的任何下划线段等于类型 token
    expect(
      (await store.importForCharacter(asFile('a.png', fakeBytes(1)), '苏婉_头像', '头像')).outcome,
    ).toBe('naming-invariant');
    expect(
      (await store.importForCharacter(asFile('a.png', fakeBytes(1)), '', '头像')).outcome,
    ).toBe('naming-invariant');

    // D19: 分隔符会在导出包里变成路径、前导点会被当 dotfile 丢掉
    for (const bad of ['圣殿/内庭', '圣殿\\内庭', '.苏婉']) {
      expect(
        (await store.importForCharacter(asFile('a.png', fakeBytes(1)), bad, '头像')).outcome,
      ).toBe('unrepresentable-name');
    }

    // 一条都没写进去
    expect(await getAssets()).toHaveLength(0);
    // 名字里的空白**不 trim**（D2）—— 那是名字的一部分，不是脏数据
    const spaced = await store.importForCharacter(asFile('a.png', fakeBytes(1)), ' 苏婉 ', '头像');
    expect(spaced.outcome).toBe('ok');
    expect((await getAssets())[0].name).toBe(' 苏婉 ');
  });

  /**
   * 🔴 类型判定与 `importPortraitPair` **同一条优先级**（`resolveSourceMime`:
   * 先 `blob.type`、再文件名扩展名）。此前这里只认扩展名，于是"没有扩展名但
   * `type: 'video/mp4'`"的文件被调用方（StatusOverview）判成视频送过来、
   * 到这里却算不出 MIME —— 一个决定两个解析器，用户拿到一句含糊的「格式不支持」。
   */
  it('MIME 优先信 blob.type: 没有扩展名的 mp4 照样收，ext 由路由表反查', async () => {
    const store = useAssetStore();
    const bytes = fakeBytes(3);
    const file = new File([bytes.slice().buffer as ArrayBuffer], '录屏', { type: 'video/mp4' });

    const res = await store.importForCharacter(file, '苏婉', '立绘bg');
    expect(res.outcome).toBe('ok');

    const rows = await getAssets();
    expect(rows).toHaveLength(1);
    expect(rows[0].mime).toBe('video/mp4');
    // ext 绝不能是空串 —— 它是导出文件名与再导入路由的依据
    expect(rows[0].ext).toBe('mp4');
  });

  it('blob.type 不认识时退到扩展名（顺序与 importPortraitPair 一致）', async () => {
    const store = useAssetStore();
    const bytes = fakeBytes(4);
    const file = new File([bytes.slice().buffer as ArrayBuffer], 'a.png', {
      type: 'application/octet-stream',
    });

    const res = await store.importForCharacter(file, '苏婉', '头像');
    expect(res.outcome).toBe('ok');
    expect((await getAssets())[0].mime).toBe('image/png');
  });

  it('不认识的扩展名 → failed，库无改动', async () => {
    const store = useAssetStore();
    expect(
      (await store.importForCharacter(asFile('稿子.psd', fakeBytes(1)), '苏婉', '头像')).outcome,
    ).toBe('failed');
    expect(
      (await store.importForCharacter(asFile('没有扩展名', fakeBytes(1)), '苏婉', '头像')).outcome,
    ).toBe('failed');
    // `.webm` 归音频（D8），素材这边不认
    expect(
      (await store.importForCharacter(asFile('a.webm', fakeBytes(1)), '苏婉', '头像')).outcome,
    ).toBe('failed');
    expect(await getAssets()).toHaveLength(0);
  });

  it('与整批导入共用互斥闸: 有导入在跑时拒收，不并发写库', async () => {
    const store = useAssetStore();
    const inFlight = store.importZip(typicalZip());
    const res = await store.importForCharacter(asFile('a.png', fakeBytes(9)), '苏婉', '头像');
    expect(res.outcome).toBe('busy');
    expect(res.id).toBeUndefined();

    await inFlight;
    // 闸门放开后照常可用
    expect(
      (await store.importForCharacter(asFile('a.png', fakeBytes(9)), '林清', '头像')).outcome,
    ).toBe('ok');
  });

  it('写库失败 → failed，且不留半行', async () => {
    const store = useAssetStore();
    failFlags.saveFailNames.add('苏婉');
    const res = await store.importForCharacter(asFile('a.png', fakeBytes(1)), '苏婉', '头像');
    expect(res.outcome).toBe('failed');
    expect(await getAssets()).toHaveLength(0);
    // 互斥闸已放开（finally 里收的）
    expect(store.importing).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 6d. 进度口径: 百分比绝不倒退
// ═══════════════════════════════════════════════════════════

describe('导入进度', () => {
  it('对外的百分比只在写库段存在，且**只增不减**（解压段无分母）', async () => {
    const store = useAssetStore();

    /**
     * UI 会显示的那个值 —— 解压段没有分母（asset-zip 的 total 会随发现新条目往上长，
     * 拿它做分母就会倒退），所以只有写库段给百分比。断言的是**这个派生值**而不是三个
     * ref 的裸快照: 三个 ref 分三次赋值，用 `flush: 'sync'` 去偷看必然能抓到中间态，
     * 而 Vue 的渲染（以及默认 flush 的 watcher）从不在两次赋值之间读值 —— 这里用默认
     * flush，看到的就是界面真正看到的。
     */
    const pctOf = (): number | null =>
      store.progressPhase === 'write' && store.progressTotal > 0
        ? (store.progressDone / store.progressTotal) * 100
        : null;

    const seen: (number | null)[] = [];
    const stop = watch(
      () => [store.progressPhase, store.progressDone, store.progressTotal] as const,
      () => {
        seen.push(pctOf());
      },
    );

    await store.importZip(
      makeZip({
        '苏婉_头像.png': fakeBytes(1),
        '林清_头像.png': fakeBytes(2),
        '战斗主题.mp3': fakeBytes(3),
      }),
    );
    await nextTick();
    stop();

    // 有分母的那些采样单调不减 —— 这就是"绝不给出会倒退的百分比"的可断言形式
    const pcts = seen.filter((v): v is number => v !== null);
    expect(pcts.length).toBeGreaterThan(0);
    for (let i = 1; i < pcts.length; i += 1) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    for (const v of pcts) expect(v).toBeLessThanOrEqual(100);

    // 收尾复位: phase 回 idle → 界面不再显示任何百分比
    expect(store.progressPhase).toBe('idle');
    expect(pctOf()).toBeNull();
    expect(store.progressDone).toBe(3);
    expect(store.progressTotal).toBe(3);
  });

  it('解压段确实经历过「无分母」态（读取中不显示百分比）', async () => {
    const store = useAssetStore();
    const phases: string[] = [];
    const stop = watch(
      () => store.progressPhase,
      (p) => {
        phases.push(p);
      },
    );
    await store.importZip(makeZip({ '苏婉_头像.png': fakeBytes(1) }));
    await nextTick();
    stop();
    // read → write → idle，顺序即两段口径的切换点
    expect(phases).toEqual(['read', 'write', 'idle']);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. 配额与持久化 (§4.5)
// ═══════════════════════════════════════════════════════════

describe('storage persist / estimate', () => {
  it('persist() 被拒 → 如实记录 false，不抛', async () => {
    const persist = vi.fn(async () => false);
    stubNavigatorStorage({ persist, persisted: async () => false, estimate: async () => ({}) });

    const store = useAssetStore();
    expect(store.storagePersisted).toBeNull();

    const res = await store.importZip(makeZip({ '苏婉_头像.png': fakeBytes(1) }));
    expect(res.assetsAdded).toBe(1); // 被拒绝不阻塞导入
    expect(persist).toHaveBeenCalledTimes(1);
    expect(store.storagePersisted).toBe(false);
  });

  it('只在首次导入成功后请求一次持久化，不在启动期', async () => {
    const persist = vi.fn(async () => true);
    stubNavigatorStorage({ persist, persisted: async () => false });

    const store = useAssetStore();
    await store.init();
    expect(persist).not.toHaveBeenCalled(); // 启动期不问

    await store.importZip(makeZip({ '苏婉_头像.png': fakeBytes(1) }));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(store.storagePersisted).toBe(true);

    await store.importZip(makeZip({ '林清_头像.png': fakeBytes(2) }));
    expect(persist).toHaveBeenCalledTimes(1); // 第二次不再问
  });

  it('浏览器不支持 → estimate 返回 null，persist 记成"不知道"', async () => {
    stubNavigatorStorage(undefined);
    const store = useAssetStore();
    expect(await store.getStorageEstimate()).toBeNull();
    expect(await store.requestPersistence()).toBeNull();
    expect(store.storagePersisted).toBeNull();
  });

  it('estimate 换算百分比', async () => {
    stubNavigatorStorage({ estimate: async () => ({ usage: 25, quota: 100 }) });
    const store = useAssetStore();
    expect(await store.getStorageEstimate()).toEqual({ used: 25, quota: 100, pct: 25 });
  });
});

// ═══════════════════════════════════════════════════════════
// 8. 分组视图 (§7.3)
// ═══════════════════════════════════════════════════════════

describe('分组视图', () => {
  it('按原始 name 严格分组，并给出每组变体数', async () => {
    for (const r of [
      makeAssetRow({ id: 'v1', name: '苏婉' }),
      makeAssetRow({ id: 'v2', name: '苏婉', variant: '微笑' }),
      makeAssetRow({ id: 'v3', name: '苏婉', type: '立绘', variant: '2' }),
      makeAssetRow({ id: 'v4', name: '苏婉 ' }), // 尾空格 —— 不归一化，就是另一个组
    ]) {
      await saveAsset(r);
    }
    const store = useAssetStore();
    await store.init();

    const names = store.groups.map((g) => g.name);
    expect(names).toContain('苏婉');
    expect(names).toContain('苏婉 ');
    const su = store.groups.find((g) => g.name === '苏婉')!;
    expect(su.total).toBe(3);
    expect(su.variantCount).toBe(2);
    expect(su.baseTypes).toEqual(['头像']);
    expect(su.baselessTypes).toEqual(['立绘']);
    expect(store.flat).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. object URL 缓存接线 (§7.5)
// ═══════════════════════════════════════════════════════════

describe('object URL', () => {
  it('assetUrl 走注入的 loadBlob；字节缺失返回 null 且不缓存', async () => {
    const row = makeAssetRow({ id: 'u-1' });
    await saveAsset(row); // 只有元数据，没有字节
    const store = useAssetStore();
    await store.init();

    expect(await store.assetUrl('u-1')).toBeNull();
    expect(store.peekAssetUrl('u-1')).toBeNull();
    store.revokeAllUrls(); // 拆除是无害的
  });
});

// ═══════════════════════════════════════════════════════════
// 9b. assetBlob —— store 是 UI 通往 Dexie 的唯一边界
// ═══════════════════════════════════════════════════════════

describe('assetBlob', () => {
  it('取得到原始字节（不是 object URL）', async () => {
    const bytes = fakeBytes(77, 64);
    await saveAsset(makeAssetRow({ id: 'b-1' }), blobOf(bytes, 'image/png'));
    const store = useAssetStore();
    await store.init();

    const blob = await store.assetBlob('b-1');
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
  });

  it('查无此 id → null；元数据在而字节丢了 → 同样 null', async () => {
    await saveAsset(makeAssetRow({ id: 'b-2' })); // 只有元数据
    const store = useAssetStore();
    await store.init();

    expect(await store.assetBlob('根本没有这条')).toBeNull();
    expect(await store.assetBlob('b-2')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 10. 取景 framing —— 写入侧夹逼 + 非索引字段真的能落 Dexie v13
// ═══════════════════════════════════════════════════════════

describe('setAssetFraming', () => {
  it('落库并回读 —— framing 是**非索引**字段，v13 的 stores() 没声明它也照存不误', async () => {
    await saveAsset(makeAssetRow({ id: 'f-1' }));
    const store = useAssetStore();
    await store.init();

    const res = await store.setAssetFraming('f-1', { x: 40, y: 12, scale: 1.5 });
    expect(res.outcome).toBe('ok');
    expect(res.row?.framing).toEqual({ x: 40, y: 12, scale: 1.5 });

    // 绕开 store 的内存副本，直接问数据库 —— 这才是"没升版也存得下"的证据
    const fromDb = (await getAssets()).find((r) => r.id === 'f-1');
    expect(fromDb?.framing).toEqual({ x: 40, y: 12, scale: 1.5 });
    expect(store.findAsset('f-1')?.framing).toEqual({ x: 40, y: 12, scale: 1.5 });
  });

  it('🔴 越界与 NaN 在**写入侧**就被夹住 —— 渲染层永远收不到 NaN', async () => {
    await saveAsset(makeAssetRow({ id: 'f-2' }));
    const store = useAssetStore();
    await store.init();

    const res = await store.setAssetFraming('f-2', {
      x: NaN,
      y: 999,
      scale: 0.2,
    });
    expect(res.outcome).toBe('ok');
    expect(res.row?.framing).toEqual({ x: 50, y: 100, scale: 1 });

    const fromDb = (await getAssets()).find((r) => r.id === 'f-2');
    expect(Number.isNaN(fromDb?.framing?.x)).toBe(false);
  });

  it('查无此行 → not-found，不写任何东西', async () => {
    const store = useAssetStore();
    await store.init();
    expect((await store.setAssetFraming('没有这条', { x: 1, y: 2, scale: 1 })).outcome).toBe(
      'not-found',
    );
    expect(await getAssets()).toHaveLength(0);
  });

  it('写库失败 → failed，行不变', async () => {
    await saveAsset(makeAssetRow({ id: 'f-3', name: '写不进的' }));
    const store = useAssetStore();
    await store.init();
    failFlags.saveFailNames.add('写不进的');

    expect((await store.setAssetFraming('f-3', { x: 10, y: 10, scale: 2 })).outcome).toBe('failed');
    expect((await getAssets())[0].framing).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 10b. 取景走 zip 往返 —— 清单补的是**显示元数据**，永不碰身份（D10 延伸）
// ═══════════════════════════════════════════════════════════

describe('取景的 zip 往返', () => {
  /** 一个"库里有一张调过构图的素材"的起手式 */
  async function libraryWithFraming(): Promise<ReturnType<typeof useAssetStore>> {
    const store = useAssetStore();
    await store.importZip(makeZip({ '苏婉_头像.png': fakeBytes(1) }));
    const row = store.assets[0];
    await store.setAssetFraming(row.id, { x: 20, y: 80, scale: 1.75 });
    return store;
  }

  it('🔴 导出 → 导入进一个空库，取景原样还在（文件名带不走它，清单能）', async () => {
    const source = await libraryWithFraming();
    const exported = await source.exportZip();
    const bytes = new Uint8Array(await exported.blob!.arrayBuffer());

    // 清一遍库，模拟"把包发给另一个人"
    await clearAllData();
    await initializeDatabase();
    setActivePinia(createPinia());
    const fresh = useAssetStore();
    const res = await fresh.importZip(bytes);

    expect(res.assetsAdded).toBe(1);
    expect((await getAssets())[0].framing).toEqual({ x: 20, y: 80, scale: 1.75 });
  });

  it('默认取景**不写进清单** —— 没调过构图的素材不该在清单里长出无操作条目', async () => {
    const store = useAssetStore();
    await store.importZip(
      makeZip({ '苏婉_头像.png': fakeBytes(1), '苏婉_立绘.png': fakeBytes(2) }),
    );
    // 一条显式设成默认值，一条根本没设过 —— 两条都不该出现在清单里
    await store.setAssetFraming(store.assets.find((a) => a.type === '头像')!.id, {
      x: 50,
      y: 0,
      scale: 1,
    });

    const exported = await store.exportZip();
    const back = await readAssetZip(new Uint8Array(await exported.blob!.arrayBuffer()));
    expect(back.manifest?.assets['苏婉_头像.png']).toBeUndefined();
    expect(back.manifest?.assets['苏婉_立绘.png']).toBeUndefined();
  });

  it('偏离默认才写，且只写这一条（不顺手把 credit/license 变成必填）', async () => {
    const store = await libraryWithFraming();
    const exported = await store.exportZip();
    const back = await readAssetZip(new Uint8Array(await exported.blob!.arrayBuffer()));
    expect(back.manifest?.assets['苏婉_头像.png']).toEqual({
      framing: { x: 20, y: 80, scale: 1.75 },
    });
  });

  it('带取景的包走一整圈往返仍然幂等', async () => {
    const store = await libraryWithFraming();
    const exported = await store.exportZip();
    const again = await store.importZip(new Uint8Array(await exported.blob!.arrayBuffer()));
    expect(again.assetsAdded).toBe(0);
    expect(again.duplicatesSkipped).toBe(1);
    expect(store.assets[0].framing).toEqual({ x: 20, y: 80, scale: 1.75 });
  });

  it('🔴 敌意/损坏的清单: NaN、越界、非对象都进不了库', async () => {
    const store = useAssetStore();
    const res = await store.importZip(
      makeZip(
        {
          'A_头像.png': fakeBytes(11),
          'B_头像.png': fakeBytes(12),
          'C_头像.png': fakeBytes(13),
          'D_头像.png': fakeBytes(14),
        },
        {
          assets: {
            'A_头像.png': { framing: { x: NaN, y: 0, scale: 1 } },
            'B_头像.png': { framing: { x: 999, y: -400, scale: 500 } },
            'C_头像.png': { framing: '居中一点' },
            'D_头像.png': { framing: [1, 2, 3] },
          },
        },
      ),
    );
    expect(res.assetsAdded).toBe(4);

    const byName = new Map((await getAssets()).map((r) => [r.name, r]));
    // JSON 里的 NaN 会被 JSON.stringify 写成 null → 非法 → 夹回默认
    expect(byName.get('A')!.framing).toEqual({ x: 50, y: 0, scale: 1 });
    // 越界被夹进合法区间，绝不原样落库
    const b = byName.get('B')!.framing!;
    expect(b.x).toBeLessThanOrEqual(100);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(b.scale)).toBe(true);
    expect(b.scale).toBeLessThan(500);
    // 非对象一律当"清单没写取景"丢掉，不留一个假的默认值
    expect(byName.get('C')!.framing).toBeUndefined();
    expect(byName.get('D')!.framing).toBeUndefined();
  });

  it('🔴 清单的取景碰不到被哈希跳过的重复行 —— 那张图的构图是用户自己调的', async () => {
    const store = useAssetStore();
    const bytes = fakeBytes(1);
    await store.importZip(makeZip({ '苏婉_头像.png': bytes }));
    const id = store.assets[0].id;
    await store.setAssetFraming(id, { x: 10, y: 90, scale: 2 });

    // 同一份字节再导一次，这回清单里带了完全不同的取景
    const res = await store.importZip(
      makeZip(
        { '苏婉_头像.png': bytes },
        { assets: { '苏婉_头像.png': { framing: { x: 99, y: 1, scale: 1.1 } } } },
      ),
    );
    expect(res.assetsAdded).toBe(0);
    expect(res.duplicatesSkipped).toBe(1);
    expect(store.findAsset(id)?.framing).toEqual({ x: 10, y: 90, scale: 2 });
  });

  it('🔴 清单仍然改不了名字与类型（D10 的红线，加了 framing 之后重验一遍）', async () => {
    const store = useAssetStore();
    const res = await store.importZip(
      makeZip(
        { '苏婉_头像.png': fakeBytes(1) },
        {
          assets: {
            '苏婉_头像.png': {
              name: '另一个人',
              type: '立绘',
              variant: '偷渡的变体',
              ext: 'mp4',
              framing: { x: 30, y: 30, scale: 1.3 },
            },
          },
        },
      ),
    );
    expect(res.assetsAdded).toBe(1);

    const row = (await getAssets())[0];
    expect(row.name).toBe('苏婉'); // 身份只来自文件名
    expect(row.type).toBe('头像');
    expect(row.variant).toBeUndefined();
    expect(row.ext).toBe('png');
    // 显示元数据照收 —— 这正是身份/显示两分的证据
    expect(row.framing).toEqual({ x: 30, y: 30, scale: 1.3 });
  });
});

// ═══════════════════════════════════════════════════════════
// 11. 一源两图 importPortraitPair
// ═══════════════════════════════════════════════════════════

interface DrawRecord {
  sw: number;
  sh: number;
  dw: number;
  dh: number;
}

/**
 * 裁剪注入缝: 假解码器 + 假画布（node 环境下没有 createImageBitmap / canvas）。
 * 产出的字节**随画布尺寸变**，于是两刀切出来的哈希不同 —— 否则去重会把第二刀吃掉，
 * 测试会误以为"只写了一行"。
 */
function cropRig(
  imageWidth = 400,
  imageHeight = 800,
): { draws: DrawRecord[]; seams: ImageCropSeams } {
  const draws: DrawRecord[] = [];
  return {
    draws,
    seams: {
      decode: async () => ({ width: imageWidth, height: imageHeight }),
      createCanvas: (width: number, height: number) => ({
        width,
        height,
        getContext: () => ({
          drawImage: (
            _s: unknown,
            _sx: number,
            _sy: number,
            sw: number,
            sh: number,
            _dx: number,
            _dy: number,
            dw: number,
            dh: number,
          ) => {
            draws.push({ sw, sh, dw, dh });
          },
        }),
        convertToBlob: async (o?: { type?: string }) =>
          blobOf(fakeBytes(width + height * 7, 64), o?.type ?? 'image/png'),
      }),
    },
  };
}

/** `Uint8Array` → `Blob`（同 store 的 makeBlob：复制一份独立缓冲区，顺带过 TS 的 BlobPart 关） */
function blobOf(bytes: Uint8Array, type?: string): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], type !== undefined ? { type } : undefined);
}

/** 源图：伪 png 字节 */
function pngSource(seed = 7): Blob {
  return blobOf(fakeBytes(seed, 32), 'image/png');
}

describe('importPortraitPair', () => {
  it('两个框 → 同一个名字下的两行，类型分别是 立绘 与 头像，都是基图', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = cropRig(400, 800);

    const res = await store.importPortraitPair(
      pngSource(),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 400, h: 800 }, avatar: { x: 100, y: 0, w: 200, h: 200 } },
      rig.seams,
    );

    expect(res.outcome).toBe('ok');
    expect(res.portraitId).toBeTruthy();
    expect(res.avatarId).toBeTruthy();
    expect(res.portraitId).not.toBe(res.avatarId);

    const rows = await getAssets();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.name))).toEqual(new Set(['苏婉']));
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['立绘', '头像']));
    // 都是基图（无变体）—— 新库里两个槽位都空着
    expect(rows.every((r) => r.variant === undefined)).toBe(true);
    // 两刀的源矩形确实不同，说明是**真裁**而不是把同一份字节存了两遍
    expect(rig.draws).toEqual([
      { sw: 400, sh: 800, dw: 400, dh: 800 },
      { sw: 200, sh: 200, dw: 200, dh: 200 },
    ]);
    expect(rows.find((r) => r.type === '立绘')!.hash).not.toBe(
      rows.find((r) => r.type === '头像')!.hash,
    );
  });

  it("'whole' = 那个类型用**整张源图的原始字节**，不过画布", async () => {
    const store = useAssetStore();
    await store.init();
    const rig = cropRig(400, 800);
    const source = pngSource(11);

    const res = await store.importPortraitPair(
      source,
      '苏婉',
      { portrait: { x: 0, y: 0, w: 400, h: 800 }, avatar: 'whole' },
      rig.seams,
    );

    expect(res.outcome).toBe('ok');
    const rows = await getAssets();
    expect(rows).toHaveLength(2);
    // 只裁了一刀 —— 整图那半边根本没上画布
    expect(rig.draws).toHaveLength(1);

    const avatar = rows.find((r) => r.type === '头像')!;
    expect(avatar.mime).toBe('image/png');
    expect(avatar.ext).toBe('png');
    expect(avatar.bytes).toBe(source.size);
  });

  it('两个都 skip → no-crops，一个字节都不写（这次调用什么也做不了）', async () => {
    const store = useAssetStore();
    await store.init();

    const res = await store.importPortraitPair(
      pngSource(),
      '苏婉',
      { portrait: 'skip', avatar: 'skip' },
      cropRig().seams,
    );
    expect(res.outcome).toBe('no-crops');
    expect(res.portraitId).toBeUndefined();
    expect(res.avatarId).toBeUndefined();
    expect(await getAssets()).toHaveLength(0);
  });

  // ── 🔴 三态里最要紧的一档: skip 真的一行都不写 ──
  // 旧契约（省略 = 整图）下**没有任何写法**能表达"这个类型不要"，于是素材库里
  // 重裁一次立绘就顺手多铸一张头像变体，库按点击次数膨胀。

  it('🔴 skip 只写另一个类型，被 skip 的那一类**一行都没有**', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = cropRig(400, 800);

    const res = await store.importPortraitPair(
      pngSource(),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 400, h: 800 }, avatar: 'skip' },
      rig.seams,
    );

    expect(res.outcome).toBe('ok');
    expect(res.portraitId).toBeTruthy();
    expect(res.avatarId).toBeUndefined();

    const rows = await getAssets();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('立绘');
    expect(rows.some((r) => r.type === '头像')).toBe(false);
    // 只烘了一刀 —— 被 skip 的那一半连解码都没走
    expect(rig.draws).toHaveLength(1);
  });

  it('🔴 重裁立绘 N 次不会累出 N 张头像变体（skip 的整个存在理由）', async () => {
    const store = useAssetStore();
    await store.init();

    for (let i = 0; i < 3; i += 1) {
      const res = await store.importPortraitPair(
        pngSource(20 + i),
        '苏婉',
        { portrait: { x: 0, y: 0, w: 100 + i * 10, h: 200 }, avatar: 'skip' },
        cropRig().seams,
      );
      expect(res.outcome).toBe('ok');
    }

    const rows = await getAssets();
    expect(rows.filter((r) => r.type === '头像')).toHaveLength(0);
    expect(rows.filter((r) => r.type === '立绘')).toHaveLength(3);
  });

  it('skip 掉立绘同样成立（两个方向对称，不是只给头像开的后门）', async () => {
    const store = useAssetStore();
    await store.init();

    const res = await store.importPortraitPair(
      pngSource(),
      '苏婉',
      { portrait: 'skip', avatar: { x: 0, y: 0, w: 200, h: 200 } },
      cropRig().seams,
    );
    expect(res.outcome).toBe('ok');
    expect(res.portraitId).toBeUndefined();
    expect(res.avatarId).toBeTruthy();
    expect((await getAssets()).map((r) => r.type)).toEqual(['头像']);
  });

  it("两个都 'whole' 是合法的（skip 之后它不再是错误）—— 两行都是整图原始字节", async () => {
    const store = useAssetStore();
    await store.init();
    const rig = cropRig(400, 800);
    const source = pngSource(31);

    const res = await store.importPortraitPair(
      source,
      '苏婉',
      { portrait: 'whole', avatar: 'whole' },
      rig.seams,
    );
    expect(res.outcome).toBe('ok');
    const rows = await getAssets();
    expect(rows).toHaveLength(2);
    expect(rig.draws).toHaveLength(0); // 一刀都没裁
    expect(rows.every((r) => r.bytes === source.size)).toBe(true);
  });

  it('🔴 D16 违规的名字在**烘任何字节之前**就被拒（解码器一次都没被调用）', async () => {
    const store = useAssetStore();
    await store.init();
    const decode = vi.fn(async () => ({ width: 400, height: 800 }));

    const res = await store.importPortraitPair(
      pngSource(),
      '苏婉_立绘', // 名字里含类型 token
      { portrait: { x: 0, y: 0, w: 10, h: 10 }, avatar: { x: 0, y: 0, w: 10, h: 10 } },
      { ...cropRig().seams, decode },
    );
    expect(res.outcome).toBe('naming-invariant');
    expect(decode).not.toHaveBeenCalled();
    expect(await getAssets()).toHaveLength(0);
  });

  it('🔴 D19 违规的名字同样在开裁之前被拒，且与 D16 可区分', async () => {
    const store = useAssetStore();
    await store.init();
    const decode = vi.fn(async () => ({ width: 400, height: 800 }));

    for (const bad of ['圣殿/内庭', '.苏婉', '苏婉\\影']) {
      const res = await store.importPortraitPair(
        pngSource(),
        bad,
        { portrait: { x: 0, y: 0, w: 10, h: 10 }, avatar: 'skip' },
        { ...cropRig().seams, decode },
      );
      expect(res.outcome).toBe('unrepresentable-name');
    }
    expect(decode).not.toHaveBeenCalled();
    expect(await getAssets()).toHaveLength(0);
  });

  it('空名字被拒；名字**不 trim**（D2：带空格的名字照原样进库）', async () => {
    const store = useAssetStore();
    await store.init();

    expect(
      (
        await store.importPortraitPair(
          pngSource(),
          '',
          { portrait: { x: 0, y: 0, w: 9, h: 9 }, avatar: 'skip' },
          cropRig().seams,
        )
      ).outcome,
    ).toBe('naming-invariant');

    const ok = await store.importPortraitPair(
      pngSource(),
      ' 苏婉 ',
      { portrait: { x: 0, y: 0, w: 9, h: 9 }, avatar: 'skip' },
      cropRig().seams,
    );
    expect(ok.outcome).toBe('ok');
    expect((await getAssets()).every((r) => r.name === ' 苏婉 ')).toBe(true);
  });

  it('🔴 撞位永不覆盖: 已有基图时新行进变体槽，随后被提成主图，旧基图降级', async () => {
    await saveAsset(makeAssetRow({ id: 'old', name: '苏婉', type: '立绘' }));
    const store = useAssetStore();
    await store.init();

    const res = await store.importPortraitPair(
      pngSource(3),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 100, h: 200 }, avatar: 'skip' },
      cropRig().seams,
    );
    expect(res.outcome).toBe('ok');

    const portraits = (await getAssets()).filter((r) => r.type === '立绘');
    expect(portraits).toHaveLength(2); // 旧的没被删、也没被覆盖
    const base = portraits.filter((r) => r.variant === undefined);
    expect(base).toHaveLength(1); // 基图位从不被两行同时占据
    expect(base[0].id).toBe(res.portraitId); // 新图就是显示出来的那张
    expect(portraits.find((r) => r.id === 'old')!.variant).toBeTruthy(); // 旧基图降级进变体槽
  });

  it('哈希去重: 同 (name,type) 下已有同字节的行 → 不写新行，但照样提成主图', async () => {
    const store = useAssetStore();
    await store.init();
    const crop = { portrait: { x: 0, y: 0, w: 100, h: 200 }, avatar: 'skip' } as const;

    const first = await store.importPortraitPair(pngSource(5), '苏婉', crop, cropRig().seams);
    expect(first.outcome).toBe('ok');
    const countAfterFirst = (await getAssets()).length;

    const second = await store.importPortraitPair(pngSource(5), '苏婉', crop, cropRig().seams);
    expect(second.outcome).toBe('ok');
    expect(second.portraitId).toBe(first.portraitId);
    expect((await getAssets()).length).toBe(countAfterFirst);
  });

  it('🔴 部分成功如实报: 立绘落了、头像写库失败 → outcome=failed，portraitId 照样带回来且不回滚', async () => {
    const store = useAssetStore();
    await store.init();
    failFlags.saveFailTypes.add('头像');

    const res = await store.importPortraitPair(
      pngSource(),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 100, h: 200 }, avatar: { x: 0, y: 0, w: 50, h: 50 } },
      cropRig().seams,
    );

    expect(res.outcome).toBe('failed'); // 绝不因为"至少成了一半"就报成功
    expect(res.portraitId).toBeTruthy(); // 落地的那一半照样交出 id
    expect(res.avatarId).toBeUndefined();

    const rows = await getAssets();
    expect(rows).toHaveLength(1); // 成功的那半**没有**被静默回滚
    expect(rows[0].type).toBe('立绘');
    expect(rows[0].id).toBe(res.portraitId);
  });

  it('裁剪本身失败也只毁掉那一半 —— 第二刀解码炸了，立绘照样落地', async () => {
    const store = useAssetStore();
    await store.init();
    let calls = 0;
    const seams = {
      ...cropRig().seams,
      decode: async () => {
        calls += 1;
        if (calls > 1) throw new Error('第二刀解码炸了');
        return { width: 400, height: 800 };
      },
    };

    const res = await store.importPortraitPair(
      pngSource(),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 100, h: 200 }, avatar: { x: 0, y: 0, w: 50, h: 50 } },
      seams,
    );
    expect(res.outcome).toBe('failed');
    expect(res.portraitId).toBeTruthy();
    expect(res.avatarId).toBeUndefined();
    expect(await getAssets()).toHaveLength(1);
  });

  it('零面积的框 → 那一半 failed，绝不静默存进一张空白图', async () => {
    const store = useAssetStore();
    await store.init();

    const res = await store.importPortraitPair(
      pngSource(),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 0, h: 0 }, avatar: { x: 0, y: 0, w: 50, h: 50 } },
      cropRig().seams,
    );
    expect(res.outcome).toBe('failed');
    expect(res.portraitId).toBeUndefined();
    expect(res.avatarId).toBeTruthy();
    expect((await getAssets()).map((r) => r.type)).toEqual(['头像']);
  });

  it('mp4 源 → media-rule（立绘不收视频，画布也取不到"哪一帧"）', async () => {
    const store = useAssetStore();
    await store.init();

    const res = await store.importPortraitPair(
      blobOf(fakeBytes(1, 32), 'video/mp4'),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 10, h: 10 }, avatar: 'skip' },
      cropRig().seams,
    );
    expect(res.outcome).toBe('media-rule');
    expect(await getAssets()).toHaveLength(0);
  });

  it('类型问不出来的源（空 type 且不是 File）→ failed，不给行编一个假 ext', async () => {
    const store = useAssetStore();
    await store.init();
    const res = await store.importPortraitPair(
      blobOf(fakeBytes(1, 32)),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 10, h: 10 }, avatar: 'skip' },
      cropRig().seams,
    );
    expect(res.outcome).toBe('failed');
    expect(await getAssets()).toHaveLength(0);
  });

  it('与整批导入共用同一道互斥闸 → 导入在跑时返回 busy', async () => {
    const store = useAssetStore();
    await store.init();

    const running = store.importZip(typicalZip());
    const res = await store.importPortraitPair(
      pngSource(),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 10, h: 10 }, avatar: 'skip' },
      cropRig().seams,
    );
    expect(res.outcome).toBe('busy');
    await running;
  });

  it('options.maxEdge 覆盖按类型的默认上限 —— 一张 8000px 的源图不该切出几十 MB', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = cropRig(8000, 8000);

    await store.importPortraitPair(
      pngSource(),
      '苏婉',
      { portrait: 'skip', avatar: { x: 0, y: 0, w: 8000, h: 4000 } },
      { ...rig.seams, maxEdge: 512 },
    );
    expect(rig.draws).toEqual([{ sw: 8000, sh: 4000, dw: 512, dh: 256 }]);
  });

  // ── 尺寸上限（不传 maxEdge 时的默认档）──
  // 旧版一个 maxEdge 都不传，于是一张 8000px 的源图就原样存成 8000px 的立绘 ——
  // 而立绘最高只渲染到 ~24rem，那些像素**没有任何显示面拿得出来**。

  it('🔴 默认上限按类型各一档: 立绘 2048 / 头像 768，且都**保持长宽比**', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = cropRig(8000, 8000);

    await store.importPortraitPair(
      pngSource(),
      '苏婉',
      {
        portrait: { x: 0, y: 0, w: 4000, h: 8000 }, // 高图: 长边是高
        avatar: { x: 0, y: 0, w: 3000, h: 3000 },
      },
      rig.seams,
    );

    expect(PORTRAIT_CROP_MAX_EDGE).toBe(2048);
    expect(AVATAR_CROP_MAX_EDGE).toBe(768);
    expect(rig.draws).toEqual([
      // 8000 → 2048 长边，短边等比 4000×(2048/8000) = 1024（比例 1:2 原样保住）
      { sw: 4000, sh: 8000, dw: 1024, dh: 2048 },
      { sw: 3000, sh: 3000, dw: 768, dh: 768 },
    ]);
  });

  it('🔴 上限**永不放大**: 比上限还小的源图原样切，不被撑成 2048 / 768', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = cropRig(600, 400);

    await store.importPortraitPair(
      pngSource(),
      '苏婉',
      {
        portrait: { x: 0, y: 0, w: 600, h: 400 },
        avatar: { x: 0, y: 0, w: 300, h: 300 },
      },
      rig.seams,
    );

    expect(rig.draws).toEqual([
      { sw: 600, sh: 400, dw: 600, dh: 400 },
      { sw: 300, sh: 300, dw: 300, dh: 300 },
    ]);
  });

  // ── 🔴 记账用**产出的**类型，不用开裁前的预测 ──────────────
  //
  // 画布**不保证**照点单的类型编码: webp 编码并非哪儿都有（Firefox 就没有），
  // `toBlob('image/webp')` 按 HTML 规范静默产出 **PNG 字节**。信预测的结果是库里
  // 出现一行 `mime: image/webp` / `ext: webp` 盖在 PNG 字节上 —— 界面上看不出来
  // （浏览器渲染时嗅探字节），但导出文件名、再导入路由、"ext 是权威"全在说谎。
  //
  // 三档一起钉住，缺一档这组就退化成"只验了顺手的那种情况":
  // 编码器认 webp → 记 webp；编码器退回 PNG → 记 png；产物干脆不报类型 → 记 png。

  /**
   * 画布替身，但**产出的 blob 自称什么由本例说了算**（`undefined` = 干脆不说），
   * 并把每次点单的类型记下来 —— 那条记录是"预测确实是 webp"的证据，
   * 没有它，退回档的断言可能只是因为压根没请求过 webp 而恒真。
   */
  function encoderRig(outType: string | undefined): {
    requested: (string | undefined)[];
    seams: ImageCropSeams;
  } {
    const requested: (string | undefined)[] = [];
    return {
      requested,
      seams: {
        decode: async () => ({ width: 400, height: 800 }),
        createCanvas: (width: number, height: number) => ({
          width,
          height,
          getContext: () => ({ drawImage: () => {} }),
          convertToBlob: async (o?: { type?: string }) => {
            requested.push(o?.type);
            return blobOf(fakeBytes(width + height * 7, 64), outType);
          },
        }),
      },
    };
  }

  /** webp 源图 —— 只有它才会让 `resolveOutputMime` 预测出 webp */
  function webpSource(seed = 9): Blob {
    return blobOf(fakeBytes(seed, 32), 'image/webp');
  }

  it('编码器认 webp → 行记 webp（预测与产出一致的那一档）', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = encoderRig('image/webp');

    const res = await store.importPortraitPair(
      webpSource(),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 400, h: 800 }, avatar: 'skip' },
      rig.seams,
    );

    expect(res.outcome).toBe('ok');
    expect(rig.requested).toEqual(['image/webp']); // 点的确实是 webp
    const row = (await getAssets())[0];
    expect(row.mime).toBe('image/webp');
    expect(row.ext).toBe('webp');
  });

  it('🔴 编码器不认 webp、悄悄退回 PNG 字节 → 行必须记 png，绝不记预测的 webp', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = encoderRig('image/png'); // Firefox 的行为

    const res = await store.importPortraitPair(
      webpSource(10),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 400, h: 800 }, avatar: 'skip' },
      rig.seams,
    );

    expect(res.outcome).toBe('ok');
    // 前提没跑掉: 点的是 webp（否则下面两条会因为"根本没预测过 webp"而恒真）
    expect(rig.requested).toEqual(['image/webp']);
    const row = (await getAssets())[0];
    expect(row.mime).toBe('image/png');
    expect(row.ext).toBe('png');
  });

  it('产出的 blob 不报类型 → 按规范给画布定的默认记 png，不留空 ext', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = encoderRig(undefined);

    const res = await store.importPortraitPair(
      webpSource(11),
      '苏婉',
      { portrait: { x: 0, y: 0, w: 400, h: 800 }, avatar: 'skip' },
      rig.seams,
    );

    expect(res.outcome).toBe('ok');
    expect(rig.requested).toEqual(['image/webp']);
    const row = (await getAssets())[0];
    expect(row.mime).toBe('image/png');
    expect(row.ext).toBe('png');
    expect(row.ext).not.toBe('');
  });

  it('整图那一半不跟着降级 —— 它不过画布，字节真的是 webp（同一次调用里两行各记各的）', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = encoderRig('image/png'); // 裁的那一半会退回 PNG

    const res = await store.importPortraitPair(
      webpSource(12),
      '苏婉',
      { portrait: 'whole', avatar: { x: 0, y: 0, w: 200, h: 200 } },
      rig.seams,
    );

    expect(res.outcome).toBe('ok');
    const rows = await getAssets();
    const portrait = rows.find((r) => r.type === '立绘')!;
    const avatar = rows.find((r) => r.type === '头像')!;
    // 整图: 源字节原样存，所以照实记 webp
    expect(portrait.mime).toBe('image/webp');
    expect(portrait.ext).toBe('webp');
    // 裁剪: 产出的是 PNG 字节，就记 png
    expect(avatar.mime).toBe('image/png');
    expect(avatar.ext).toBe('png');
  });

  it('整图那一半不受上限约束 —— 它根本不过画布（不重编码是更强的承诺）', async () => {
    const store = useAssetStore();
    await store.init();
    const rig = cropRig(8000, 8000);
    const source = pngSource(41);

    await store.importPortraitPair(
      source,
      '苏婉',
      { portrait: 'whole', avatar: 'skip' },
      rig.seams,
    );

    expect(rig.draws).toHaveLength(0);
    const rows = await getAssets();
    expect(rows).toHaveLength(1);
    expect(rows[0].bytes).toBe(source.size);
  });
});
