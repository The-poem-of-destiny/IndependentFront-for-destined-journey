/**
 * asset-url.test.ts — object URL LRU 缓存
 *
 * 跑在默认 environment:'node' 下：本模块的浏览器全局全是注入 seam，所以这里
 * 从头到尾**没有真实的 URL.createObjectURL**，计数器假件说什么就是什么。
 *
 * 这层真正要钉住的是「每个 URL 恰好被撤销一次」这条会计恒等式 ——
 * 泄漏在浏览器里没有任何可见症状，只能靠计数断言拦住。
 */

import { describe, it, expect } from 'vitest';
import {
  createAssetUrlCache,
  ASSET_URL_DEFAULT_CAPACITY,
  type AssetUrlCacheOptions,
} from './asset-url';

// ═══════════════════════════════════════════════════════════
// 假件：可计数的 URL 铸造 / 撤销 + 可控 loader
// ═══════════════════════════════════════════════════════════

interface Harness {
  created: string[];
  revoked: string[];
  /** loader 被调用过的 id 顺序（用于验证「不缓存」时会真的重试） */
  loads: string[];
  options: AssetUrlCacheOptions;
}

function blobFor(id: string): Blob {
  return new Blob([`bytes:${id}`], { type: 'image/png' });
}

/** loader 立即返回；missing 集合里的 id 返回 undefined，throwing 集合里的抛错 */
function makeHarness(
  opts: {
    capacity?: number;
    missing?: Set<string>;
    throwing?: Set<string>;
  } = {},
): Harness {
  const created: string[] = [];
  const revoked: string[] = [];
  const loads: string[] = [];
  let seq = 0;

  return {
    created,
    revoked,
    loads,
    options: {
      capacity: opts.capacity,
      loadBlob: async (id) => {
        loads.push(id);
        if (opts.throwing?.has(id)) throw new Error(`boom:${id}`);
        if (opts.missing?.has(id)) return undefined;
        return blobFor(id);
      },
      createObjectURL: () => {
        seq += 1;
        const url = `blob:fake/${seq}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url) => {
        revoked.push(url);
      },
    },
  };
}

/** 手动可控的 deferred loader —— 专测在飞去重 */
function makeDeferredHarness(): Harness & { resolveOne: (id: string) => void } {
  const created: string[] = [];
  const revoked: string[] = [];
  const loads: string[] = [];
  const waiters = new Map<string, (b: Blob | undefined) => void>();
  let seq = 0;

  return {
    created,
    revoked,
    loads,
    resolveOne: (id) => {
      const w = waiters.get(id);
      if (!w) throw new Error(`没有在飞的加载: ${id}`);
      waiters.delete(id);
      w(blobFor(id));
    },
    options: {
      loadBlob: (id) => {
        loads.push(id);
        return new Promise<Blob | undefined>((resolve) => waiters.set(id, resolve));
      },
      createObjectURL: () => {
        seq += 1;
        const url = `blob:fake/${seq}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url) => {
        revoked.push(url);
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 1. 缓存命中：同一 id 只铸造一次
// ═══════════════════════════════════════════════════════════

describe('get — 缓存命中', () => {
  it('首次 get 加载并铸造一个 URL，二次 get 返回同一个且不再铸造', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    const first = await cache.get('a');
    const second = await cache.get('a');

    expect(first).toBe('blob:fake/1');
    expect(second).toBe(first);
    expect(h.created).toHaveLength(1);
    expect(h.loads).toEqual(['a']); // 命中不再回 loader
    expect(h.revoked).toHaveLength(0);
    expect(cache.size).toBe(1);
  });

  it('peek 只窥视已缓存的，不触发加载', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    expect(cache.peek('a')).toBeNull();
    expect(h.loads).toHaveLength(0);

    const url = await cache.get('a');
    expect(cache.peek('a')).toBe(url);
  });

  it('默认容量是 §7.5 的 64', () => {
    expect(ASSET_URL_DEFAULT_CAPACITY).toBe(64);
  });
});

// ═══════════════════════════════════════════════════════════
// 2 & 3. LRU 逐出 + 新鲜度刷新
// ═══════════════════════════════════════════════════════════

describe('容量与逐出', () => {
  /**
   * ⚠️ 引用计数落地后，「零引用条目」在公开 API 下不会存续（`get` 落地即 +1，
   * release 归零即撤销），所以**容量逐出实际上已经退化成一条安全网**。这一组
   * 于是主要钉两件事: 逐出绝不碰被持有的条目；以及归零之后容量确实回落。
   * 逐出顺序（LRU 新鲜度）本身现在从外部观察不到 —— 没有可构造的零引用条目
   * 让它去挑。刻意不为此开测试后门。
   */
  it('全员被持有时宁可超容，也绝不撤销正在用的 URL', async () => {
    const h = makeHarness({ capacity: 2 });
    const cache = createAssetUrlCache(h.options);

    const ua = await cache.get('a');
    await cache.get('b');
    await cache.get('c'); // 换作无计数的旧行为，这一下会挤掉 a

    expect(h.revoked).toHaveLength(0);
    expect(cache.size).toBe(3); // 超容 > 打死别人正在显示的图
    expect(cache.peek('a')).toBe(ua); // 且没有「丢失追踪」：a 还在表里
    expect(cache.peek('b')).not.toBeNull();
    expect(cache.peek('c')).not.toBeNull();
  });

  it('持有者还回引用后容量随之回落，且每条恰好撤销一次', async () => {
    const h = makeHarness({ capacity: 2 });
    const cache = createAssetUrlCache(h.options);

    const ua = await cache.get('a');
    const ub = await cache.get('b');
    await cache.get('c');
    expect(cache.size).toBe(3);

    cache.release('a');
    cache.release('b');

    expect(h.revoked).toEqual([ua, ub]);
    expect(cache.size).toBe(1);
    expect(cache.peek('a')).toBeNull();
  });

  it('容量非法值（0 / 负数）按 1 处理，不会退化成「立刻逐出自己」', async () => {
    const h = makeHarness({ capacity: 0 });
    const cache = createAssetUrlCache(h.options);

    const url = await cache.get('a');
    expect(url).not.toBeNull();
    expect(cache.size).toBe(1);
    expect(h.revoked).toHaveLength(0);
  });

  it('容量 1 时新铸的条目不会把自己当成逐出对象', async () => {
    // 回归钉子: 若 load() 在 retain 之前就 evict，新条目此刻是全场唯一的零引用
    // 条目，扫描会当场把它自己挑走 —— 调用方拿到的是一条刚被撤销的死链。
    const h = makeHarness({ capacity: 1 });
    const cache = createAssetUrlCache(h.options);

    const ua = await cache.get('a');
    expect(ua).not.toBeNull();
    expect(h.revoked).toHaveLength(0);
    expect(cache.peek('a')).toBe(ua);

    const ub = await cache.get('b'); // a 仍被持有 → 不逐出，超容
    expect(h.revoked).toHaveLength(0);
    expect(cache.peek('b')).toBe(ub);
    expect(cache.size).toBe(2);
  });

  it('撤销后重新 get 会重新加载并铸造新 URL', async () => {
    const h = makeHarness({ capacity: 1 });
    const cache = createAssetUrlCache(h.options);

    const first = await cache.get('a');
    cache.release('a');
    await cache.get('b');
    const again = await cache.get('a');

    expect(again).not.toBe(first);
    expect(h.loads).toEqual(['a', 'b', 'a']);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. revokeAll
// ═══════════════════════════════════════════════════════════

describe('revokeAll', () => {
  it('撤销每一个存活 URL 恰好一次并清空缓存', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    const ua = await cache.get('a');
    const ub = await cache.get('b');
    const uc = await cache.get('c');

    cache.revokeAll();

    expect(h.revoked).toHaveLength(3);
    expect(new Set(h.revoked)).toEqual(new Set([ua, ub, uc]));
    expect(cache.size).toBe(0);
    expect(cache.peek('a')).toBeNull();
  });

  it('重复 revokeAll 不会二次撤销（空缓存上是空操作）', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);
    await cache.get('a');

    cache.revokeAll();
    cache.revokeAll();

    expect(h.revoked).toHaveLength(1);
  });

  it('revokeAll 之后仍可继续使用（重新加载）', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);
    await cache.get('a');
    cache.revokeAll();

    const again = await cache.get('a');
    expect(again).toBe('blob:fake/2');
    expect(cache.size).toBe(1);
  });

  it('拆除时还在飞的加载回来后不进缓存、当场自撤 —— 否则那条 URL 永久无人撤销', async () => {
    const h = makeDeferredHarness();
    const cache = createAssetUrlCache(h.options);

    const pending = cache.get('a');
    cache.revokeAll(); // 分区 unmount，此时 a 还在飞

    h.resolveOne('a');
    await expect(pending).resolves.toBeNull();

    expect(h.created).toHaveLength(1);
    expect(h.revoked).toEqual(h.created); // 铸了就撤了
    expect(cache.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 4b. 活性闸：绝不端出一条已撤销的 URL
// ═══════════════════════════════════════════════════════════

describe('活性闸', () => {
  /**
   * 🔴 这个交错**真的摆得出来**，不是理论上的担心: `revokeAll()` 落进「load 已经
   * 把 URL 装进缓存」与「调用方的续体跑起来」之间那几个微任务里。现实形状是
   * 分区在一次异步卸载里调 revokeAll，而同一张头像正好有两个组件在等它。
   *
   * 修复前的行为: 两个调用方都拿到 `blob:fake/1` —— 一条**已经撤销**的 URL。
   * `<img>` 当场裂，而且按契约他们各欠一次 release，那两次会记到日后为同一个 id
   * 重新铸出来的那条身上，把别人正在显示的图撤掉。
   */
  it('铸好之后、兑现之前 revokeAll → 发起者与搭车者都拿到 null，而不是死链', async () => {
    let resolveBlob!: (b: Blob) => void;
    const blobReady = new Promise<Blob>((r) => {
      resolveBlob = r;
    });
    const created: string[] = [];
    const revoked: string[] = [];
    let seq = 0;
    const cache = createAssetUrlCache({
      loadBlob: () => blobReady,
      createObjectURL: () => {
        seq += 1;
        const u = `blob:fake/${seq}`;
        created.push(u);
        return u;
      },
      revokeObjectURL: (u) => {
        revoked.push(u);
      },
    });

    const initiator = cache.get('a');
    const piggy = cache.get('a'); // 搭同一个在飞 Promise

    // 这条链注册得比 load 的续体晚，于是它恰好夹在 urls.set 之后、
    // 两个调用方的续体之前 —— 正是那个窄窗口
    const wedge = blobReady.then(() => {
      cache.revokeAll();
    });

    resolveBlob(new Blob(['x']));
    const [u1, u2] = await Promise.all([initiator, piggy, wedge]);

    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created); // 这条 URL 确实已经被撤销了
    expect(u1).toBeNull();
    expect(u2).toBeNull();
    // 拿到 null 就不欠 release —— 迟到的 release 也不会误伤日后重铸的那条
    expect(cache.refCount('a')).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('正常路径不受影响：搭车者照样拿到活的 URL 并各领一份计数', async () => {
    const h = makeDeferredHarness();
    const cache = createAssetUrlCache(h.options);

    const p1 = cache.get('a');
    const p2 = cache.get('a');
    h.resolveOne('a');
    const [u1, u2] = await Promise.all([p1, p2]);

    expect(u1).toBe('blob:fake/1');
    expect(u2).toBe(u1);
    expect(cache.refCount('a')).toBe(2);
    expect(h.revoked).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 在飞去重（真实泄漏 bug）
// ═══════════════════════════════════════════════════════════

describe('并发 get 去重', () => {
  it('同一 id 的并发 get 只 loader 一次、只铸造一个 URL', async () => {
    const h = makeDeferredHarness();
    const cache = createAssetUrlCache(h.options);

    const p1 = cache.get('a');
    const p2 = cache.get('a');
    const p3 = cache.get('a');

    h.resolveOne('a');
    const [u1, u2, u3] = await Promise.all([p1, p2, p3]);

    expect(h.loads).toEqual(['a']);
    expect(h.created).toHaveLength(1); // 两个组件要同一张头像 → 不许铸两个
    expect(u1).toBe(u2);
    expect(u2).toBe(u3);
    expect(h.revoked).toHaveLength(0);
    expect(cache.size).toBe(1);
  });

  it('不同 id 的并发 get 各自独立铸造', async () => {
    const h = makeDeferredHarness();
    const cache = createAssetUrlCache(h.options);

    const pa = cache.get('a');
    const pb = cache.get('b');
    h.resolveOne('a');
    h.resolveOne('b');

    const [ua, ub] = await Promise.all([pa, pb]);
    expect(ua).not.toBe(ub);
    expect(h.created).toHaveLength(2);
    expect(cache.size).toBe(2);
  });

  it('在飞条目在解决后被清理 —— 下一轮 get 走缓存而不是复用旧 Promise', async () => {
    const h = makeDeferredHarness();
    const cache = createAssetUrlCache(h.options);

    const p = cache.get('a');
    h.resolveOne('a');
    const url = await p;

    expect(await cache.get('a')).toBe(url);
    expect(h.loads).toEqual(['a']);
  });
});

// ═══════════════════════════════════════════════════════════
// 6 & 7. 缺失 blob 与 loader 抛错
// ═══════════════════════════════════════════════════════════

describe('失败路径', () => {
  it('loader 返回 undefined：不铸 URL、不缓存，之后重试仍能成功', async () => {
    const missing = new Set(['a']);
    const h = makeHarness({ missing });
    const cache = createAssetUrlCache(h.options);

    expect(await cache.get('a')).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(cache.size).toBe(0);
    expect(cache.peek('a')).toBeNull();

    // 字节后来补上了（比如重新导入）→ 重试必须能成
    missing.delete('a');
    const url = await cache.get('a');
    expect(url).toBe('blob:fake/1');
    expect(h.loads).toEqual(['a', 'a']);
  });

  it('loader 抛错：错误上浮，且不留下中毒的在飞条目，重试仍能成功', async () => {
    const throwing = new Set(['a']);
    const h = makeHarness({ throwing });
    const cache = createAssetUrlCache(h.options);

    await expect(cache.get('a')).rejects.toThrow('boom:a');
    expect(cache.size).toBe(0);
    expect(h.created).toHaveLength(0);

    throwing.delete('a');
    await expect(cache.get('a')).resolves.toBe('blob:fake/1');
    expect(h.loads).toEqual(['a', 'a']);
  });

  it('createObjectURL 不可用（返回空串）时不缓存死链', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache({ ...h.options, createObjectURL: () => '' });

    expect(await cache.get('a')).toBeNull();
    expect(cache.size).toBe(0);
    expect(h.revoked).toHaveLength(0);
  });

  it('缺省 seam 在 node 环境下安全降级 —— 仅 import 与调用都不炸', async () => {
    // 不注入 createObjectURL / revokeObjectURL，走惰性全局引用路径。
    // node 有 URL 但（历史上）不保证 createObjectURL，两种结果都算通过，
    // 唯一不可接受的是抛错。
    const cache = createAssetUrlCache({ loadBlob: async (id) => blobFor(id) });
    const url = await cache.get('a');
    expect(url === null || typeof url === 'string').toBe(true);
    expect(() => cache.revokeAll()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// 8. release
// ═══════════════════════════════════════════════════════════

describe('release', () => {
  it('撤销并移除单条', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);
    const ua = await cache.get('a');
    await cache.get('b');

    cache.release('a');

    expect(h.revoked).toEqual([ua]);
    expect(cache.size).toBe(1);
    expect(cache.peek('a')).toBeNull();
  });

  it('未知 id 是无害空操作（重复 release 也不会二次撤销）', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);
    await cache.get('a');

    cache.release('不存在的 id');
    expect(h.revoked).toHaveLength(0);

    cache.release('a');
    cache.release('a');
    expect(h.revoked).toHaveLength(1);
  });

  it('release 后重新 get 会重新加载', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);
    const first = await cache.get('a');
    cache.release('a');

    const again = await cache.get('a');
    expect(again).not.toBe(first);
    expect(h.loads).toEqual(['a', 'a']);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. 引用计数
//
// 本组钉的是这条缓存存在的理由: 同一张素材会被**多个组件同时挂着**（一个 NPC
// 可以同时出现在 ScenePanel 与 CharacterListPanel）。没有计数时，第一个卸载的
// 组件就把 URL 撤了，其余还在显示它的组件当场死图 —— 而死图在界面上像是「偶尔
// 没加载出来」，几乎不会有人报成 bug。
// ═══════════════════════════════════════════════════════════

describe('引用计数', () => {
  it('两个持有者：release 一次 URL 依然活着，第二次才撤销', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    const first = await cache.get('a'); // ScenePanel 挂上
    const second = await cache.get('a'); // CharacterListPanel 也挂上
    expect(second).toBe(first);
    expect(cache.refCount('a')).toBe(2);
    expect(h.created).toHaveLength(1);

    cache.release('a'); // ScenePanel 卸载
    expect(h.revoked).toHaveLength(0); // 另一个组件还在显示它
    expect(cache.peek('a')).toBe(first);
    expect(cache.refCount('a')).toBe(1);

    cache.release('a'); // 最后一个持有者也走了
    expect(h.revoked).toEqual([first]);
    expect(cache.peek('a')).toBeNull();
    expect(cache.refCount('a')).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('并发在飞的两次 get：搭车者也各得一份计数（是 2 不是 1）', async () => {
    // 最微妙的一条: 第二个调用方搭的是同一个在飞 Promise。若直接 `return pending`
    // 而不补计数，两个组件只会记 1 份，先卸载的那个一 release 就归零撤销。
    const h = makeDeferredHarness();
    const cache = createAssetUrlCache(h.options);

    const p1 = cache.get('a');
    const p2 = cache.get('a');
    h.resolveOne('a');
    const [u1, u2] = await Promise.all([p1, p2]);

    expect(u1).toBe(u2);
    expect(h.created).toHaveLength(1);
    expect(cache.refCount('a')).toBe(2);

    cache.release('a');
    expect(h.revoked).toHaveLength(0); // 搭车的那个还挂着
    expect(cache.peek('a')).toBe(u1);

    cache.release('a');
    expect(h.revoked).toEqual([u1]);
  });

  it('三方并发（其中一个在解决之后才来）计数是 3', async () => {
    const h = makeDeferredHarness();
    const cache = createAssetUrlCache(h.options);

    const p1 = cache.get('a');
    const p2 = cache.get('a');
    h.resolveOne('a');
    await Promise.all([p1, p2]);
    await cache.get('a'); // 这次是缓存命中路径

    expect(cache.refCount('a')).toBe(3);
    cache.release('a');
    cache.release('a');
    expect(h.revoked).toHaveLength(0);
    cache.release('a');
    expect(h.revoked).toHaveLength(1);
  });

  it('拿到 null（字节缺失）不欠引用', async () => {
    const h = makeHarness({ missing: new Set(['gone']) });
    const cache = createAssetUrlCache(h.options);

    expect(await cache.get('gone')).toBeNull();
    expect(cache.refCount('gone')).toBe(0);
  });

  it('peek 不增加计数 —— 窥视者不拥有那条 URL', async () => {
    // thumbs.ts 的快路径靠这条: 它 peek 到的 URL 归别人所有，它自己不欠 release。
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);
    await cache.get('a');

    expect(cache.peek('a')).not.toBeNull();
    expect(cache.refCount('a')).toBe(1);

    cache.release('a');
    expect(h.revoked).toHaveLength(1);
  });

  it('未知 id / 已归零的 id 上 release 是空操作，计数不会变负', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    cache.release('从来没有过的 id');
    expect(cache.refCount('从来没有过的 id')).toBe(0);
    expect(h.revoked).toHaveLength(0);

    await cache.get('a');
    cache.release('a');
    cache.release('a');
    cache.release('a');
    expect(cache.refCount('a')).toBe(0); // 不是 -2
    expect(h.revoked).toHaveLength(1); // 也没有二次撤销

    // 计数没被压到负数 —— 重新 get 之后一次 release 就该撤销
    const again = await cache.get('a');
    expect(cache.refCount('a')).toBe(1);
    cache.release('a');
    expect(h.revoked).toEqual([...h.created.slice(0, 1), again]);
  });

  it('revokeAll 无视计数：仍被持有的也全部撤销，且计数一并清零', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    const ua = await cache.get('a');
    await cache.get('a'); // 计数 2
    const ub = await cache.get('b');

    cache.revokeAll();

    expect(new Set(h.revoked)).toEqual(new Set([ua, ub]));
    expect(h.revoked).toHaveLength(2); // 各一次，不因计数 2 而撤两次
    expect(cache.size).toBe(0);
    expect(cache.refCount('a')).toBe(0);

    // 拆除后迟到的 release 不该再撤销任何东西
    cache.release('a');
    cache.release('a');
    expect(h.revoked).toHaveLength(2);
  });

  it('逐出扫描跳过被持有的条目，只挑得动没人要的', async () => {
    // 「零引用条目」在公开 API 下不会存续，所以这条从可观察面反证:
    // 容量 1、两条都被持有 → 一条都逐不掉；还回一条 → 立刻撤销那一条。
    const h = makeHarness({ capacity: 1 });
    const cache = createAssetUrlCache(h.options);

    const ua = await cache.get('a');
    const ub = await cache.get('b');
    expect(h.revoked).toHaveLength(0);
    expect(cache.size).toBe(2);

    cache.release('a');
    expect(h.revoked).toEqual([ua]);
    expect(cache.peek('b')).toBe(ub); // 还在用的那条毫发无损
    expect(cache.size).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// evict：同一个 id 的字节换了（远程素材同步换址 / 删行）
//
// 这一组钉的全是**可观察行为**（下一次 get 拿到的是不是新 URL、旧 URL 什么时候被撤销），
// 不是「某个回调被叫过」——「叫过 release」正是修复前那个 bug 的样子：它照样被叫，
// 只是做的事情不对（两个持有者时旧图一直显示，一个持有者时打死正在显示的图）。
// ═══════════════════════════════════════════════════════════

describe('evict — 字节换了之后作废这一条', () => {
  it('🔴 evict 之后下一次 get 重新读字节、给一条**不同的** URL', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    const first = await cache.get('a');
    cache.evict('a');
    const second = await cache.get('a');

    expect(second).not.toBe(first);
    expect(h.loads).toEqual(['a', 'a']); // 真的回了 loader，不是拿缓存糊弄
    expect(h.created).toEqual([first, second]);
    // 发起者已经把自己那份还掉（下面那条用例专测「还没还」的情形）
  });

  it('🔴 还有人挂着时**先不撤**，等他还回来才撤（撤了就是打死正在显示的图）', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    const url = await cache.get('a'); // 组件 A 正显示着它
    cache.evict('a');

    expect(h.revoked).toEqual([]); // ← 修复前这里就把它撤了（refCount 1 → release 归零）
    // 期间新的取用照常拿到新 URL，两条并存
    const fresh = await cache.get('a');
    expect(fresh).not.toBe(url);
    expect(h.revoked).toEqual([]);

    cache.release('a'); // 组件 A 卸载，还掉旧的那一份
    expect(h.revoked).toEqual([url]);
    expect(cache.peek('a')).toBe(fresh); // 新的那条毫发无损

    cache.release('a');
    expect(h.revoked).toEqual([url, fresh]);
    expect(cache.size).toBe(0);
  });

  it('两个持有者时旧 URL 撑到最后一个还完（少还一笔 = 泄漏，多撤一笔 = 死图）', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    const url = await cache.get('a');
    await cache.get('a'); // 第二个组件也挂上了同一张图
    cache.evict('a');

    cache.release('a');
    expect(h.revoked).toEqual([]); // ← 修复前：这一下什么都不做，旧图永远显示下去
    cache.release('a');
    expect(h.revoked).toEqual([url]);
  });

  it('零引用的 id → 空转：不抛、不二次撤销，下一次 get 照常新铸', async () => {
    // ⚠️「零引用**且仍在缓存里**」的条目在公开 API 下不存续（归零即撤销，见文件头与
    //    「容量与逐出」那一组的说明），所以这里能构造的零引用形态就是「已经不在缓存里」。
    //    evict 里那条 `held <= 0` 的分支因此是**防御性的**，不是这条用例覆盖的路径。
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    const url = await cache.get('a');
    cache.release('a');
    expect(h.revoked).toEqual([url]);

    cache.evict('a'); // 已经没有这条了
    cache.evict('从没取过的 id');
    expect(h.revoked).toEqual([url]); // 没有二次撤销

    const again = await cache.get('a');
    expect(again).not.toBe(url);
  });

  it('🔴 作废在飞的那次加载：它读到的可能正是旧字节，不许悄悄进缓存', async () => {
    const h = makeDeferredHarness();
    const cache = createAssetUrlCache(h.options);

    const pending = cache.get('a'); // 加载开始（此刻字节还是旧的）
    cache.evict('a'); // 字节被换掉了
    h.resolveOne('a'); // 旧字节的加载这才回来

    expect(await pending).toBeNull(); // 拿到 null 的调用方**不欠** release（契约）
    expect(h.revoked).toEqual(h.created); // 那条多铸的 URL 当场撤掉，不泄漏
    expect(cache.size).toBe(0);

    // 之后的 get 是一次**全新的**加载，不搭那班注定作废的车
    const next = cache.get('a');
    h.resolveOne('a');
    expect(await next).toBe(h.created[1]);
    expect(h.loads).toEqual(['a', 'a']);
  });

  it('revokeAll 把「还没人还」的旧账一并收掉（分区都没了，不会再有人来还）', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    const url = await cache.get('a');
    cache.evict('a');
    const fresh = await cache.get('a');
    expect(h.revoked).toEqual([]);

    cache.revokeAll();
    expect(new Set(h.revoked)).toEqual(new Set([url, fresh]));

    // 拆除之后迟到的 release 不该再撤销任何东西
    cache.release('a');
    cache.release('a');
    expect(h.revoked).toHaveLength(2);
  });

  it('会计恒等式：evict 穿插 200 轮，每条 URL 恰好撤销一次、收尾一条不剩', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    for (let i = 0; i < 200; i++) {
      await cache.get('a'); // 挂上
      cache.evict('a'); // 字节换了
      await cache.get('a'); // 新的挂上
      cache.release('a'); // 旧的那份还回来（先还旧账）
      cache.release('a'); // 新的那份也还回来
    }

    expect(h.created).toHaveLength(400);
    expect(h.revoked).toHaveLength(400);
    expect(new Set(h.revoked).size).toBe(h.revoked.length);
    expect(new Set(h.revoked)).toEqual(new Set(h.created));
    expect(cache.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 会计恒等式：网格用量下每个 URL 恰好撤销一次
// ═══════════════════════════════════════════════════════════

describe('URL 会计', () => {
  it('用完即还（组件挂载/卸载）滚过 200 条：每条恰好撤销一次，收尾一条不剩', async () => {
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    for (let i = 0; i < 200; i++) {
      await cache.get(`asset-${i}`);
      cache.release(`asset-${i}`);
    }

    expect(h.created).toHaveLength(200);
    expect(h.revoked).toHaveLength(200);
    expect(new Set(h.revoked).size).toBe(h.revoked.length); // 没有二次撤销
    expect(new Set(h.revoked)).toEqual(new Set(h.created));
    expect(cache.size).toBe(0);
  });

  it('只取不还（thumbs.ts 那种用法）：一条都不撤销、超容留着，revokeAll 收尾全撤', async () => {
    // 这是引用计数带来的**刻意取舍**，写下来免得日后当成泄漏来"修":
    // 不还引用的使用面会让缓存涨到它见过的条目数，容量 64 拦不住它。
    // 换来的是它显示中的缩略图永远不会被别人逐掉。上界归 revokeAll()。
    const h = makeHarness();
    const cache = createAssetUrlCache(h.options);

    for (let i = 0; i < 200; i++) await cache.get(`asset-${i}`);

    expect(cache.size).toBe(200);
    expect(cache.size).toBeGreaterThan(ASSET_URL_DEFAULT_CAPACITY);
    expect(h.created).toHaveLength(200);
    expect(h.revoked).toHaveLength(0);

    cache.revokeAll();
    expect(h.revoked).toHaveLength(200);
    expect(new Set(h.revoked)).toEqual(new Set(h.created));
    expect(cache.size).toBe(0);
  });
});
