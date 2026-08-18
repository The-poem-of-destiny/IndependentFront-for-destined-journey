/**
 * remote-asset-sync.test.ts — 远程素材镜像同步的契约测试（远程素材 v1 / 波 2）
 *
 * 覆盖三层，各自的失败形态都在模块头写着：
 * 1. **计划（纯函数）** —— 五条分支各一条用例，尤其是「用户的行赢」与「镜像删除」：
 *    这两条错了都不会报错，只会**悄悄改掉用户的素材库**。
 * 2. **下载** —— 类型判定（Content-Type 优先、URL 后缀兜底）、体积上限、代理回落、
 *    非 http 拒收。**全程 mock fetch，一个字节都不出网**。
 * 3. **执行** —— 逐条隔离（一条下载失败既不删也不降级既有行、更不中断其余）、
 *    换址时原地换字节并叫 `onBytesReplaced`、镜像删除与下载成败无关。
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssetMetaRecord } from '@engine/types';
import type { RemoteAssetDecl } from '@engine/remote-asset-catalogue';
import {
  collectDesiredRemoteAssets,
  downloadRemoteAsset,
  formatRemoteSyncCounts,
  planRemoteAssetSync,
  runRemoteAssetSync,
  type RemoteAssetFetch,
  type RemoteAssetSyncDeps,
} from './remote-asset-sync';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

function row(patch: Partial<AssetMetaRecord> & { name: string }): AssetMetaRecord {
  return {
    id: `id_${patch.name}_${patch.type ?? '头像'}_${patch.variant ?? ''}`,
    type: '头像',
    ext: 'png',
    mime: 'image/png',
    bytes: 10,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  } as AssetMetaRecord;
}

/** 带远程戳的行（= 上一次同步下下来的） */
function remoteRow(
  name: string,
  url: string,
  patch: Partial<AssetMetaRecord> = {},
): AssetMetaRecord {
  return row({ name, ...patch, remote: { url, syncedAt: 100 } });
}

function decl(name: string, url: string, patch: Partial<RemoteAssetDecl> = {}): RemoteAssetDecl {
  return { name, type: '头像', url, ...patch };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** 逐 URL 应答的 fetch 替身 —— 值是 Response 工厂或 `'network'`（fetch 自身 reject） */
function fetchMock(table: Record<string, (() => Response) | 'network'>): {
  impl: RemoteAssetFetch;
  urls: string[];
} {
  const urls: string[] = [];
  const impl: RemoteAssetFetch = async (url) => {
    urls.push(url);
    const entry = table[url];
    if (entry === undefined) return new Response('not found', { status: 404 });
    if (entry === 'network') throw new TypeError('Failed to fetch');
    return entry();
  };
  return { impl, urls };
}

function pngResponse(bytes: Uint8Array = PNG_BYTES, contentType = 'image/png'): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

/** 一份最小 deps —— 落库/删除都记在数组里，不碰 Dexie、不碰 Pinia */
function makeDeps(over: Partial<RemoteAssetSyncDeps> = {}): RemoteAssetSyncDeps & {
  saved: AssetMetaRecord[];
  removed: string[];
  invalidated: string[];
} {
  const saved: AssetMetaRecord[] = [];
  const removed: string[] = [];
  const invalidated: string[] = [];
  const deps = {
    decls: [] as readonly RemoteAssetDecl[],
    existing: [] as readonly AssetMetaRecord[],
    saveAsset: async (meta: AssetMetaRecord) => {
      saved.push(meta);
    },
    deleteAsset: async (id: string) => {
      removed.push(id);
    },
    onBytesReplaced: (id: string) => {
      invalidated.push(id);
    },
    // 哈希与 Blob 都替身化：这一层测的是「同步做对了没有」，不是 crypto 有没有
    hashBlob: async () => 'hash-fixed',
    makeBlob: (bytes: Uint8Array, mime: string) =>
      ({ size: bytes.length, type: mime }) as unknown as Blob,
    newId: () => 'new-id',
    now: () => 12_345,
    ...over,
    saved,
    removed,
    invalidated,
  };
  return deps as RemoteAssetSyncDeps & {
    saved: AssetMetaRecord[];
    removed: string[];
    invalidated: string[];
  };
}

// ═══════════════════════════════════════════════════════════
// 1. 清单
// ═══════════════════════════════════════════════════════════

describe('collectDesiredRemoteAssets —— 两个来源合流后去重', () => {
  it('世界书排在内容包前面，撞位时世界书赢（先来先得）', () => {
    const book = {
      id: 'b1',
      name: '测试书',
      entries: [
        {
          uid: 1,
          enabled: true,
          content: [
            '<%# char-info-ejs-builder:start %>',
            `const profile = ${JSON.stringify({
              characterName: '苏婉',
              avatarUrl: 'https://book.invalid/su.png',
            })}`,
            '<%# char-info-ejs-builder:end %>',
          ].join('\n'),
        },
      ],
    } as unknown as Parameters<typeof collectDesiredRemoteAssets>[0][number];

    const out = collectDesiredRemoteAssets(
      [book],
      [
        { name: '苏婉', url: 'https://pack.invalid/su.png' },
        { name: '林岚', url: 'https://pack.invalid/lin.png' },
      ],
    );
    expect(out).toEqual([
      { name: '苏婉', type: '头像', url: 'https://book.invalid/su.png' },
      { name: '林岚', type: '头像', url: 'https://pack.invalid/lin.png' },
    ]);
  });

  it('两个来源都缺席 → 空清单（缺席不是错误）', () => {
    expect(collectDesiredRemoteAssets([], undefined)).toEqual([]);
  });
});

describe('planRemoteAssetSync —— 五条分支', () => {
  it('位上没有行 → 下载并新建', () => {
    const plan = planRemoteAssetSync([decl('苏婉', 'https://a.invalid/1.png')], []);
    expect(plan.toDownload).toHaveLength(1);
    expect(plan.toDownload[0].replaces).toBeUndefined();
    expect(plan.toDelete).toEqual([]);
  });

  it('🔴 位上是用户自己的行（无 remote 戳）→ 让路，既不下也不覆盖', () => {
    const mine = row({ name: '苏婉' });
    const plan = planRemoteAssetSync([decl('苏婉', 'https://a.invalid/1.png')], [mine]);
    expect(plan.toDownload).toEqual([]);
    expect(plan.skippedUserOwned).toHaveLength(1);
    expect(plan.toDelete).toEqual([]);
    expect(plan.kept).toEqual([]);
  });

  it('远程行且地址相同 → kept（零网络）', () => {
    const old = remoteRow('苏婉', 'https://a.invalid/1.png');
    const plan = planRemoteAssetSync([decl('苏婉', 'https://a.invalid/1.png')], [old]);
    expect(plan.toDownload).toEqual([]);
    expect(plan.kept).toEqual([old]);
  });

  it('远程行但地址变了 → 下载并原地换（同一个 id）', () => {
    const old = remoteRow('苏婉', 'https://a.invalid/1.png');
    const plan = planRemoteAssetSync([decl('苏婉', 'https://a.invalid/2.png')], [old]);
    expect(plan.toDownload).toHaveLength(1);
    expect(plan.toDownload[0].replaces).toBe(old);
    expect(plan.toDelete).toEqual([]);
  });

  it('🔴 远程行的位不在声明里 → 镜像删除；用户的行同样情形下不删', () => {
    const orphanRemote = remoteRow('旧角色', 'https://a.invalid/old.png');
    const orphanMine = row({ name: '我自己导的' });
    const plan = planRemoteAssetSync([], [orphanRemote, orphanMine]);
    expect(plan.toDelete).toEqual([orphanRemote]);
  });

  it('变体位与基图位是两个不同的槽（不会互相顶掉）', () => {
    const base = remoteRow('苏婉', 'https://a.invalid/base.png');
    const variant = remoteRow('苏婉', 'https://a.invalid/smile.png', { variant: '微笑' });
    const plan = planRemoteAssetSync(
      [
        decl('苏婉', 'https://a.invalid/base.png'),
        decl('苏婉', 'https://a.invalid/smile.png', { variant: '微笑' }),
      ],
      [base, variant],
    );
    expect(plan.kept).toHaveLength(2);
    expect(plan.toDelete).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 下载
// ═══════════════════════════════════════════════════════════

describe('downloadRemoteAsset', () => {
  it('直连成功 → 不去碰代理', async () => {
    const { impl, urls } = fetchMock({ 'https://a.invalid/1.png': () => pngResponse() });
    const res = await downloadRemoteAsset('https://a.invalid/1.png', { fetchImpl: impl });
    expect(res.ok).toBe(true);
    expect(urls).toEqual(['https://a.invalid/1.png']);
  });

  it('🔴 直连被 CORS/网络挡下 → 回落 wsrv 代理（工坊封面链的同一跳）', async () => {
    const proxied = `https://wsrv.nl/?url=${encodeURIComponent('https://a.invalid/1.png')}`;
    const { impl, urls } = fetchMock({
      'https://a.invalid/1.png': 'network',
      [proxied]: () => pngResponse(),
    });
    const res = await downloadRemoteAsset('https://a.invalid/1.png', { fetchImpl: impl });
    expect(res.ok).toBe(true);
    expect(urls).toEqual(['https://a.invalid/1.png', proxied]);
  });

  it('两跳都挂 → ok:false，且 reason 说的是最后一跳', async () => {
    const { impl } = fetchMock({});
    const res = await downloadRemoteAsset('https://a.invalid/1.png', { fetchImpl: impl });
    expect(res).toEqual({ ok: false, reason: 'HTTP 404' });
  });

  it('🔴 Content-Type 赢过 URL 后缀（代理转码时地址会说谎）', async () => {
    const { impl } = fetchMock({
      'https://a.invalid/pic.png': () => pngResponse(PNG_BYTES, 'image/webp'),
    });
    const res = await downloadRemoteAsset('https://a.invalid/pic.png', { fetchImpl: impl });
    expect(res.ok && res.payload.ext).toBe('webp');
    expect(res.ok && res.payload.mime).toBe('image/webp');
  });

  it('Content-Type 不可信（octet-stream）→ 回落 URL 后缀', async () => {
    const { impl } = fetchMock({
      'https://a.invalid/pic.jpg?v=2': () => pngResponse(PNG_BYTES, 'application/octet-stream'),
    });
    const res = await downloadRemoteAsset('https://a.invalid/pic.jpg?v=2', { fetchImpl: impl });
    expect(res.ok && res.payload.ext).toBe('jpg');
    expect(res.ok && res.payload.mime).toBe('image/jpeg');
  });

  it('两边都问不出类型 → 拒收，**绝不猜一个**', async () => {
    const { impl } = fetchMock({
      'https://a.invalid/mystery': () => pngResponse(PNG_BYTES, 'application/octet-stream'),
    });
    const res = await downloadRemoteAsset('https://a.invalid/mystery', { fetchImpl: impl });
    expect(res).toEqual({ ok: false, reason: '不是认得出来的图片/视频格式' });
  });

  it('🔴 超过体积上限 → 拒收（配额是全库共享的）', async () => {
    const big = new Uint8Array(64);
    const { impl } = fetchMock({ 'https://a.invalid/big.png': () => pngResponse(big) });
    const res = await downloadRemoteAsset('https://a.invalid/big.png', {
      fetchImpl: impl,
      maxBytes: 16,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('超过单张上限');
  });

  it('声明了 content-length 就不必把字节读进来才发现超限', async () => {
    const readBody = vi.fn();
    const impl: RemoteAssetFetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (k: string) =>
            k === 'content-length' ? '999999' : k === 'content-type' ? 'image/png' : null,
        },
        arrayBuffer: async () => {
          readBody();
          return new ArrayBuffer(0);
        },
      }) as unknown as Response;
    const res = await downloadRemoteAsset('https://a.invalid/big.png', {
      fetchImpl: impl,
      maxBytes: 16,
    });
    expect(res.ok).toBe(false);
    expect(readBody).not.toHaveBeenCalled();
  });

  it('非 http(s)（data: / 相对路径）→ 当场拒，一次请求都不发', async () => {
    const impl = vi.fn();
    const res = await downloadRemoteAsset('data:image/png;base64,AAAA', {
      fetchImpl: impl as unknown as RemoteAssetFetch,
    });
    expect(res).toEqual({ ok: false, reason: '不是 http(s) 地址' });
    expect(impl).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 执行
// ═══════════════════════════════════════════════════════════

describe('runRemoteAssetSync', () => {
  it('新建：落一行带 remote 戳的素材，计数进 downloaded', async () => {
    const { impl } = fetchMock({ 'https://a.invalid/1.png': () => pngResponse() });
    const deps = makeDeps({
      decls: [decl('苏婉', 'https://a.invalid/1.png')],
      fetchImpl: impl,
    });
    const res = await runRemoteAssetSync(deps);
    expect(res.downloaded).toBe(1);
    expect(deps.saved).toHaveLength(1);
    expect(deps.saved[0]).toMatchObject({
      id: 'new-id',
      name: '苏婉',
      type: '头像',
      ext: 'png',
      mime: 'image/png',
      bytes: PNG_BYTES.length,
      hash: 'hash-fixed',
      remote: { url: 'https://a.invalid/1.png', syncedAt: 12_345 },
    });
  });

  it('🔴 换址：id 不变、字节换掉，并叫一次 onBytesReplaced（否则界面永远显示旧图）', async () => {
    const old = remoteRow('苏婉', 'https://a.invalid/1.png', { hash: '老哈希' });
    const { impl } = fetchMock({ 'https://a.invalid/2.png': () => pngResponse() });
    const deps = makeDeps({
      decls: [decl('苏婉', 'https://a.invalid/2.png')],
      existing: [old],
      fetchImpl: impl,
    });
    const res = await runRemoteAssetSync(deps);
    expect(res).toMatchObject({ downloaded: 0, replaced: 1, deleted: 0 });
    expect(deps.saved[0].id).toBe(old.id);
    expect(deps.saved[0].hash).toBe('hash-fixed');
    expect(deps.saved[0].remote).toEqual({ url: 'https://a.invalid/2.png', syncedAt: 12_345 });
    expect(deps.invalidated).toEqual([old.id]);
  });

  it('哈希算不出时**不留旧哈希**（那是另一份字节的指纹）', async () => {
    const old = remoteRow('苏婉', 'https://a.invalid/1.png', { hash: '老哈希' });
    const { impl } = fetchMock({ 'https://a.invalid/2.png': () => pngResponse() });
    const deps = makeDeps({
      decls: [decl('苏婉', 'https://a.invalid/2.png')],
      existing: [old],
      fetchImpl: impl,
      hashBlob: async () => undefined,
    });
    await runRemoteAssetSync(deps);
    expect('hash' in deps.saved[0]).toBe(false);
  });

  it('🔴 一条下载失败：既有行原样留着、不进删除、其余条目照跑', async () => {
    const keptRow = remoteRow('苏婉', 'https://a.invalid/1.png');
    const { impl } = fetchMock({
      // 苏婉的地址换了但下不下来（两跳都挂）；林岚是新的且下得到
      'https://a.invalid/2.png': 'network',
      'https://a.invalid/lin.png': () => pngResponse(),
    });
    const deps = makeDeps({
      decls: [decl('苏婉', 'https://a.invalid/2.png'), decl('林岚', 'https://a.invalid/lin.png')],
      existing: [keptRow],
      fetchImpl: impl,
    });
    const res = await runRemoteAssetSync(deps);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].url).toBe('https://a.invalid/2.png');
    // 失败的那一半：既有行既没被删也没被改写
    expect(deps.removed).toEqual([]);
    expect(deps.saved.map((m) => m.name)).toEqual(['林岚']);
    expect(res.downloaded).toBe(1);
  });

  it('🔴 镜像删除与下载成败无关（清单是本地算出来的，离线也安全）', async () => {
    const orphan = remoteRow('旧角色', 'https://a.invalid/old.png');
    const { impl } = fetchMock({ 'https://a.invalid/new.png': 'network' });
    const deps = makeDeps({
      decls: [decl('新角色', 'https://a.invalid/new.png')],
      existing: [orphan],
      fetchImpl: impl,
    });
    const res = await runRemoteAssetSync(deps);
    expect(res.deleted).toBe(1);
    expect(deps.removed).toEqual([orphan.id]);
    expect(res.failed).toHaveLength(1);
  });

  it('用户的行占着位 → 计入 skippedUserOwned，一次请求都不发', async () => {
    const impl = vi.fn();
    const deps = makeDeps({
      decls: [decl('苏婉', 'https://a.invalid/1.png')],
      existing: [row({ name: '苏婉' })],
      fetchImpl: impl as unknown as RemoteAssetFetch,
    });
    const res = await runRemoteAssetSync(deps);
    expect(res.skippedUserOwned).toBe(1);
    expect(impl).not.toHaveBeenCalled();
    expect(deps.saved).toEqual([]);
    expect(deps.removed).toEqual([]);
  });

  it('D7 媒体规则：立绘 + mp4 直接拒，**连下都不下**', async () => {
    const impl = vi.fn();
    const deps = makeDeps({
      decls: [decl('苏婉', 'https://a.invalid/dance.mp4', { type: '立绘' })],
      fetchImpl: impl as unknown as RemoteAssetFetch,
    });
    const res = await runRemoteAssetSync(deps);
    expect(res.failed).toEqual([{ url: 'https://a.invalid/dance.mp4', reason: '立绘 不支持 mp4' }]);
    expect(impl).not.toHaveBeenCalled();
  });

  it('落库抛错只毁掉这一条（部分成功如实报）', async () => {
    const { impl } = fetchMock({
      'https://a.invalid/1.png': () => pngResponse(),
      'https://a.invalid/2.png': () => pngResponse(),
    });
    const deps = makeDeps({
      decls: [decl('苏婉', 'https://a.invalid/1.png'), decl('林岚', 'https://a.invalid/2.png')],
      fetchImpl: impl,
      saveAsset: async (meta: AssetMetaRecord) => {
        if (meta.name === '苏婉') throw new Error('写不进去');
      },
    });
    const res = await runRemoteAssetSync(deps);
    expect(res.downloaded).toBe(1);
    expect(res.failed).toEqual([{ url: 'https://a.invalid/1.png', reason: '写不进去' }]);
  });

  it('并发有上限：同时在飞的请求数不超过 concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const impl: RemoteAssetFetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return pngResponse();
    };
    const decls = Array.from({ length: 9 }, (_, i) =>
      decl(`角色${i}`, `https://a.invalid/${i}.png`),
    );
    const deps = makeDeps({ decls, fetchImpl: impl, concurrency: 2, newId: () => 'x' });
    const res = await runRemoteAssetSync(deps);
    expect(res.downloaded).toBe(9);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('什么都不用做时是一份全 kept 的回执（调用方据此决定不弹提示）', async () => {
    const impl = vi.fn();
    const old = remoteRow('苏婉', 'https://a.invalid/1.png');
    const deps = makeDeps({
      decls: [decl('苏婉', 'https://a.invalid/1.png')],
      existing: [old],
      fetchImpl: impl as unknown as RemoteAssetFetch,
    });
    const res = await runRemoteAssetSync(deps);
    expect(res).toEqual({
      downloaded: 0,
      replaced: 0,
      deleted: 0,
      kept: 1,
      skippedUserOwned: 0,
      failed: [],
    });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('formatRemoteSyncCounts', () => {
  it('五个计数一个不少（toast 与设置页共用这一份措辞）', () => {
    expect(
      formatRemoteSyncCounts({
        downloaded: 1,
        replaced: 2,
        deleted: 3,
        kept: 4,
        skippedUserOwned: 5,
        failed: [{ url: 'u', reason: 'r' }],
      }),
    ).toBe('新增 1 · 更新 2 · 删除 3 · 跳过 5 · 失败 1');
  });
});
