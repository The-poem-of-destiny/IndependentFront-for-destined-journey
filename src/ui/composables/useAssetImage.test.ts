/**
 * useAssetImage.test.ts — 素材 URL 的解析、生命周期与竞态
 *
 * 主力断言不是「渲染出了图」，而是**会计恒等式**与**落笔时机**:
 * 泄漏（少撤一次）、死图（多撤一次）、串脸（过期的一轮落了笔）在界面上都看不出来。
 *
 * 手法照 assets/thumbs.test.ts 与 lib/asset-url.test.ts 的先例: 全程没有真的
 * object URL，`assetUrl` / `releaseAssetUrl` 是可控的假件 —— `assetUrl` 返回的
 * Promise 由用例自己决定何时兑现，于是「B 先回、A 后回」这种真实但难复现的顺序
 * 可以被确定性地摆出来。
 *
 * 🔴 **世代号守卫的变异测试**: `useAssetImage.ts` 里 `load()` 的
 * `gen !== generation` 判断被删掉后，`过期的一轮不落笔` 这条用例必须变红。
 * 本次已实测（删守卫 → 该用例 fail: 期望 B 的 URL、实得 A 的），随后恢复。
 */

import { describe, it, expect } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue';
import { ASSET_TYPE_AVATAR_CHAIN, ASSET_TYPE_FALLBACK_CHAIN } from '@engine/asset-resolve';
import type { AssetMetaRecord, AssetType } from '@engine/types';
import { createAssetUrlCache } from '../lib/asset-url';
import { useAssetImage, type AssetImageSource, type UseAssetImage } from './useAssetImage';

// ═══════════════════════════════════════════════════════════
// 假件
// ═══════════════════════════════════════════════════════════

function row(over: Partial<AssetMetaRecord> & { id: string; name: string }): AssetMetaRecord {
  return {
    type: '头像',
    ext: 'png',
    mime: 'image/png',
    bytes: 16,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

interface Harness {
  source: AssetImageSource;
  rows: Ref<AssetMetaRecord[]>;
  released: string[];
  /** 每次 `assetUrl` 调用的 id 顺序 */
  requested: string[];
  /**
   * **成功取到 URL** 的 id 顺序（拿到 null 的不算）。
   *
   * 会计恒等式的左边: 每一条 = 一份引用计数 = 欠一次 release
   * （lib/asset-url.ts 的 `get` 契约）。`released` 是右边，两边必须是同一个多重集。
   */
  granted: string[];
  /** 手动兑现某个在飞的 `assetUrl(id)`；`null` 表示字节缺失 */
  settle(id: string, url?: string | null): void;
  /** 兑现所有在飞请求（按发起顺序），URL 为 `blob:<id>` */
  settleAll(): void;
}

/** 多重集比较 —— 顺序无关，但**次数必须一样**（少还一次就是泄漏） */
function tally(ids: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  return out;
}

/**
 * @param auto true = `assetUrl` 立即兑现（大多数用例要的）；
 *             false = 挂起，由用例调 `settle` 决定兑现顺序（竞态用例要的）
 */
function makeHarness(rowsInit: AssetMetaRecord[], auto = true): Harness {
  const rows = ref<AssetMetaRecord[]>(rowsInit);
  const released: string[] = [];
  const requested: string[] = [];
  const granted: string[] = [];
  // 🔴 **队列**而不是 `Map<id, resolver>`: 同一个 id 完全可能有两轮同时在飞
  // （切走再切回）。用 id 做键会让后一轮把前一轮的 resolver 顶掉，前一轮的
  // Promise 永远不兑现 —— 于是「过期那一轮回来时会做什么」这件事根本没被测到。
  const pending: { id: string; resolve: (v: string | null) => void }[] = [];

  const source: AssetImageSource = {
    get assets() {
      return rows.value;
    },
    assetUrl(id: string): Promise<string | null> {
      requested.push(id);
      if (auto) {
        granted.push(id);
        return Promise.resolve(`blob:${id}`);
      }
      return new Promise<string | null>((resolve) => pending.push({ id, resolve }));
    },
    releaseAssetUrl(id: string): void {
      released.push(id);
    },
  };

  return {
    source,
    rows,
    released,
    requested,
    granted,
    /** 兑现该 id **最早**的那一轮（先进先出，与真实兑现顺序无关，由用例摆布） */
    settle(id, url = `blob:${id}`) {
      const at = pending.findIndex((p) => p.id === id);
      if (at < 0) throw new Error(`没有在飞的 assetUrl(${id})`);
      const [entry] = pending.splice(at, 1);
      if (url !== null) granted.push(id);
      entry.resolve(url);
    },
    settleAll() {
      const all = pending.splice(0, pending.length);
      for (const p of all) {
        granted.push(p.id);
        p.resolve(`blob:${p.id}`);
      }
    },
  };
}

/** 在一个可停止的作用域里跑 composable（`onScopeDispose` 需要活的作用域） */
function run(fn: () => UseAssetImage): { scope: EffectScope; api: UseAssetImage } {
  const scope = effectScope();
  const api = scope.run(fn);
  if (!api) throw new Error('scope.run 未返回');
  return { scope, api };
}

/** 冲掉 watch 的 pre-flush 队列 + 微任务 */
async function flush(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

/** 接真缓存时用：那条链多绕好几跳（load → finally → 采纳 → 活性闸 → 组件的 await） */
async function deepFlush(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

// ═══════════════════════════════════════════════════════════
// 名字匹配（D2：严格 ===，不归一化）
// ═══════════════════════════════════════════════════════════

describe('useAssetImage · 名字匹配', () => {
  it('名字完全相同才命中', async () => {
    const h = makeHarness([row({ id: 'a1', name: '苏婉' })]);
    const { api } = run(() => useAssetImage('苏婉', undefined, { source: h.source }));
    await flush();
    expect(api.url.value).toBe('blob:a1');
  });

  it('大小写不同 → 不命中（不折叠大小写）', async () => {
    const h = makeHarness([row({ id: 'a1', name: 'Suwan' })]);
    const { api } = run(() => useAssetImage('suwan', undefined, { source: h.source }));
    await flush();
    expect(api.url.value).toBeNull();
    expect(h.requested).toEqual([]);
  });

  it('尾随/前导空格 → 不命中（不 trim）', async () => {
    const h = makeHarness([row({ id: 'a1', name: '苏婉' })]);
    const trailing = run(() => useAssetImage('苏婉 ', undefined, { source: h.source }));
    const leading = run(() => useAssetImage(' 苏婉', undefined, { source: h.source }));
    await flush();
    expect(trailing.api.url.value).toBeNull();
    expect(leading.api.url.value).toBeNull();
    expect(h.requested).toEqual([]);
  });

  it('查无此素材 / 空名字 → 静默 null，不发请求也不抛', async () => {
    const h = makeHarness([row({ id: 'a1', name: '苏婉' })]);
    const missing = run(() => useAssetImage('无此人', undefined, { source: h.source }));
    const empty = run(() => useAssetImage('', undefined, { source: h.source }));
    const nullish = run(() => useAssetImage(null, undefined, { source: h.source }));
    await flush();
    expect(missing.api.url.value).toBeNull();
    expect(empty.api.url.value).toBeNull();
    expect(nullish.api.url.value).toBeNull();
    expect(h.requested).toEqual([]);
    expect(h.released).toEqual([]);
  });

  it('缺省首选 头像；显式**单个**类型只查该类型（不降级）', async () => {
    const h = makeHarness([
      row({ id: 'av', name: '苏婉', type: '头像' }),
      row({ id: 'bg', name: '苏婉', type: '立绘bg' }),
    ]);
    const def = run(() => useAssetImage('苏婉', undefined, { source: h.source }));
    const bg = run(() => useAssetImage('苏婉', '立绘bg', { source: h.source }));
    // 只有 头像 与 立绘bg 在库里，单个类型请求 立绘 必须空手而归
    const none = run(() => useAssetImage('苏婉', '立绘', { source: h.source }));
    await flush();
    expect(def.api.url.value).toBe('blob:av');
    expect(bg.api.url.value).toBe('blob:bg');
    expect(none.api.url.value).toBeNull();
  });

  /**
   * ★ 这一组钉的是曾经坏掉的那件事: 缺省兜的是**链**而不是单个 `'头像'`。
   * 兜成单个类型时，asset-resolve 的回退链从这一层根本走不到 —— 只有立绘的
   * 角色在圆框里显示首字母，只有头像的角色在立牌位也显示首字母。
   */
  it('★ 缺省链: 只有 立绘 时头像位照样命中（不再是首字母）', async () => {
    const h = makeHarness([row({ id: 'p', name: '苏婉', type: '立绘' })]);
    const { api } = run(() => useAssetImage('苏婉', undefined, { source: h.source }));
    await flush();
    expect(api.url.value).toBe('blob:p');
  });

  it('★ 缺省链: 头像与立绘都有 → 取 头像（脸位要脸）', async () => {
    const h = makeHarness([
      row({ id: 'p', name: '苏婉', type: '立绘' }),
      row({ id: 'av', name: '苏婉', type: '头像' }),
    ]);
    const { api } = run(() => useAssetImage('苏婉', undefined, { source: h.source }));
    await flush();
    expect(api.url.value).toBe('blob:av');
  });

  it('★ 显式传立牌链 → 同一份库上给出相反答案（只有头像时也命中）', async () => {
    const both = makeHarness([
      row({ id: 'p', name: '苏婉', type: '立绘' }),
      row({ id: 'av', name: '苏婉', type: '头像' }),
    ]);
    const standee = run(() =>
      useAssetImage('苏婉', ASSET_TYPE_FALLBACK_CHAIN, { source: both.source }),
    );

    const onlyAvatar = makeHarness([row({ id: 'av2', name: '林霜', type: '头像' })]);
    const degraded = run(() =>
      useAssetImage('林霜', ASSET_TYPE_FALLBACK_CHAIN, { source: onlyAvatar.source }),
    );

    await flush();
    expect(standee.api.url.value).toBe('blob:p');
    expect(degraded.api.url.value).toBe('blob:av2');
  });

  it('链是响应式的: 换链就换命中档', async () => {
    const h = makeHarness([
      row({ id: 'p', name: '苏婉', type: '立绘' }),
      row({ id: 'av', name: '苏婉', type: '头像' }),
    ]);
    const chain = ref<readonly AssetType[]>(ASSET_TYPE_AVATAR_CHAIN);
    const { api } = run(() => useAssetImage('苏婉', chain, { source: h.source }));
    await flush();
    expect(api.url.value).toBe('blob:av');

    chain.value = ASSET_TYPE_FALLBACK_CHAIN;
    await flush();
    expect(api.url.value).toBe('blob:p');
    expect(h.released).toEqual(['av']);
  });

  // ── 变体（D11）──
  // 相册那类「一格一行」的使用面靠它；此前 `resolveAsset` 早就收第四个参数，
  // 只是这一层没有入口，于是 UI 侧永远只取得到每个类型的主图。

  it('指定变体 → 命中该变体那一行', async () => {
    const h = makeHarness([
      row({ id: 'base', name: '苏婉', type: '立绘' }),
      row({ id: 'smile', name: '苏婉', type: '立绘', variant: '微笑' }),
    ]);
    const { api } = run(() => useAssetImage('苏婉', '立绘', { source: h.source, variant: '微笑' }));
    await flush();
    expect(api.url.value).toBe('blob:smile');
    expect(api.row.value?.id).toBe('smile');
  });

  it('不指定变体 → 主图（变体存在也不会被抓来顶替）', async () => {
    const h = makeHarness([
      row({ id: 'base', name: '苏婉', type: '立绘' }),
      row({ id: 'smile', name: '苏婉', type: '立绘', variant: '微笑' }),
    ]);
    const { api } = run(() => useAssetImage('苏婉', '立绘', { source: h.source }));
    await flush();
    expect(api.url.value).toBe('blob:base');
  });

  /**
   * ⚠️ 变体寻址**不是精确寻址**（`pickFromSlot` 的既有行为，本层只是把参数接上）：
   * 该类型没有这个变体时退回主图。要「必须正是那一行」的调用方得自己核对 `row`。
   */
  it('变体缺席 → 退回该类型主图，不空手', async () => {
    const h = makeHarness([row({ id: 'base', name: '苏婉', type: '立绘' })]);
    const { api } = run(() =>
      useAssetImage('苏婉', '立绘', { source: h.source, variant: '没有这个表情' }),
    );
    await flush();
    expect(api.url.value).toBe('blob:base');
  });

  it('空串变体等同未指定（与 asset-index 的归一口径一致）', async () => {
    const h = makeHarness([row({ id: 'base', name: '苏婉', type: '立绘' })]);
    const { api } = run(() => useAssetImage('苏婉', '立绘', { source: h.source, variant: '' }));
    await flush();
    expect(api.url.value).toBe('blob:base');
  });

  it('变体是响应式的: 换变体就换图，且恰好撤旧的一次', async () => {
    const h = makeHarness([
      row({ id: 'smile', name: '苏婉', type: '立绘', variant: '微笑' }),
      row({ id: 'cry', name: '苏婉', type: '立绘', variant: '哭' }),
    ]);
    const variant = ref('微笑');
    const { api } = run(() => useAssetImage('苏婉', '立绘', { source: h.source, variant }));
    await flush();
    expect(api.url.value).toBe('blob:smile');

    variant.value = '哭';
    await flush();
    expect(api.url.value).toBe('blob:cry');
    expect(h.released).toEqual(['smile']);
  });

  it('字节缺失（assetUrl 给 null）→ url 为 null，且不欠任何 release', async () => {
    const h = makeHarness([row({ id: 'a1', name: '苏婉' })], false);
    const { scope, api } = run(() => useAssetImage('苏婉', undefined, { source: h.source }));
    await flush();
    h.settle('a1', null);
    await flush();
    expect(api.url.value).toBeNull();
    scope.stop();
    expect(h.released).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// URL 生命周期
// ═══════════════════════════════════════════════════════════

describe('useAssetImage · URL 生命周期', () => {
  it('换名字：铸新的、且**恰好**撤旧的一次', async () => {
    const h = makeHarness([row({ id: 'a1', name: '苏婉' }), row({ id: 'b1', name: '林霜' })]);
    const name = ref<string>('苏婉');
    const { api } = run(() => useAssetImage(name, undefined, { source: h.source }));
    await flush();
    expect(api.url.value).toBe('blob:a1');
    expect(h.released).toEqual([]);

    name.value = '林霜';
    await flush();
    expect(api.url.value).toBe('blob:b1');
    expect(h.requested).toEqual(['a1', 'b1']);
    // 恰好一次，且撤的是旧的那条
    expect(h.released).toEqual(['a1']);
  });

  it('名字变成空 → 撤掉持有的那条并回到 null', async () => {
    const h = makeHarness([row({ id: 'a1', name: '苏婉' })]);
    const name = ref<string | null>('苏婉');
    const { api } = run(() => useAssetImage(name, undefined, { source: h.source }));
    await flush();
    expect(api.url.value).toBe('blob:a1');

    name.value = null;
    await flush();
    expect(api.url.value).toBeNull();
    expect(h.released).toEqual(['a1']);
  });

  it('作用域拆除 → 撤掉持有的那条（不泄漏）', async () => {
    const h = makeHarness([row({ id: 'a1', name: '苏婉' })]);
    const { scope, api } = run(() => useAssetImage('苏婉', undefined, { source: h.source }));
    await flush();
    expect(api.url.value).toBe('blob:a1');

    scope.stop();
    expect(h.released).toEqual(['a1']);
  });

  it('拆除后兑现的请求不落笔，且当场撤销自己铸的那条', async () => {
    const h = makeHarness([row({ id: 'a1', name: '苏婉' })], false);
    const { scope, api } = run(() => useAssetImage('苏婉', undefined, { source: h.source }));
    await flush();
    scope.stop();
    // 拆除时还没持有任何 URL，所以此刻不该有 release
    expect(h.released).toEqual([]);

    h.settle('a1');
    await flush();
    expect(api.url.value).toBeNull();
    expect(h.released).toEqual(['a1']);
  });
});

// ═══════════════════════════════════════════════════════════
// 竞态（世代号守卫）
// ═══════════════════════════════════════════════════════════

describe('useAssetImage · 乱序兑现', () => {
  /**
   * 🔴 **变异测试锚点**: 删掉 `load()` 里的 `gen !== generation` 之后，
   * 后回来的 A 会覆盖已落笔的 B，本用例的第一条断言当场变红。
   */
  it('后发先至：B 先兑现、A 后兑现 → 显示 B，绝不被 A 覆盖', async () => {
    const h = makeHarness(
      [row({ id: 'a1', name: '苏婉' }), row({ id: 'b1', name: '林霜' })],
      false,
    );
    const name = ref<string>('苏婉');
    const { api } = run(() => useAssetImage(name, undefined, { source: h.source }));
    await flush();

    // A 还在飞时就切到 B
    name.value = '林霜';
    await flush();
    expect(h.requested).toEqual(['a1', 'b1']);

    // B 先回
    h.settle('b1');
    await flush();
    expect(api.url.value).toBe('blob:b1');

    // A 后回 —— 过期，必须被丢弃
    h.settle('a1');
    await flush();
    expect(api.url.value).toBe('blob:b1');
    // 过期那条 URL 没人要，当场撤销；B 的那条一个字都不许动
    expect(h.released).toEqual(['a1']);
  });

  /**
   * ★ 本用例修正过一次断言。它原先钉的是 `released === ['b1']` ——
   * 也就是把一个**泄漏**当成正确行为钉住了。
   *
   * 真相是: A→B→A 抖一下，`assetUrl('a1')` 被**成功调用了两次**，按
   * lib/asset-url.ts 的契约那就是两份引用计数、欠两次 release。第一轮的续体走
   * 过期分支时刻意不还（对的 —— 新一轮马上要接手这条 URL，先还会把计数踩到零），
   * 但第三轮领的是**它自己那一份**，从没认领过第一轮那一份。于是三次成功 get、
   * 两次 release，多出来的那一份把这条 URL 永久钉住（容量逐出跳过被持有的条目，
   * 只有 revokeAll 收得回）。
   *
   * 正确的会计: a1 一共还两次 —— 一次在第三轮落笔后**当场**收拢多余份额
   * （此时我们仍攥着 1 份，那条 URL 撤不掉，界面不会闪），另一次在拆除时。
   */
  it('★ 过期的一轮与新一轮同 id：那一份欠账由新一轮收拢，不是一笔勾销', async () => {
    const h = makeHarness(
      [row({ id: 'a1', name: '苏婉' }), row({ id: 'b1', name: '林霜' })],
      false,
    );
    const name = ref<string>('苏婉');
    const { scope, api } = run(() => useAssetImage(name, undefined, { source: h.source }));
    await flush();

    // 切走再切回：a1 有两轮在飞，第一轮过期
    name.value = '林霜';
    await flush();
    name.value = '苏婉';
    await flush();
    expect(h.requested).toEqual(['a1', 'b1', 'a1']);

    h.settleAll();
    await flush();
    expect(api.url.value).toBe('blob:a1');
    // b1 铸出来了却没人要（切回去了）→ 必须撤，否则就是泄漏
    // a1 撤一次: 两份计数里多出来的那一份。**留下的那一份压住正在显示的这条 URL**
    expect(h.released).toEqual(['b1', 'a1']);

    scope.stop();
    // 走人时把最后那一份也还掉 —— 至此 3 次成功 get 对 3 次 release
    expect(h.released).toEqual(['b1', 'a1', 'a1']);
    expect(tally(h.released)).toEqual(tally(h.granted));
  });
});

// ═══════════════════════════════════════════════════════════
// 会计恒等式
//
// 🔴 本组是这个 composable 唯一的**总账**: 一生的 release 总次数必须等于成功取到
// URL 的总次数。少还一次 = 那条 object URL 被永久钉住（容量逐出跳过被持有的条目）；
// 多还一次 = 别人正在显示的图当场变死链。两种失败在界面上都几乎看不出来。
// ═══════════════════════════════════════════════════════════

describe('useAssetImage · 会计恒等式', () => {
  it('★ A→B→A 快速抖动（一次 Dexie 读之内）：三次成功 get 对三次 release', async () => {
    const h = makeHarness(
      [row({ id: 'a1', name: '苏婉' }), row({ id: 'b1', name: '林霜' })],
      false,
    );
    const name = ref<string>('苏婉');
    const { scope } = run(() => useAssetImage(name, undefined, { source: h.source }));
    await flush();
    name.value = '林霜';
    await flush();
    name.value = '苏婉';
    await flush();

    h.settleAll();
    await flush();
    scope.stop();
    await flush();

    expect(h.granted).toEqual(['a1', 'b1', 'a1']);
    expect(tally(h.released)).toEqual({ a1: 2, b1: 1 });
  });

  it('乱序兑现 + 多次抖动 + 中途查无此人：总账仍然平', async () => {
    const h = makeHarness(
      [
        row({ id: 'a1', name: '苏婉' }),
        row({ id: 'b1', name: '林霜' }),
        row({ id: 'c1', name: '沈砚' }),
      ],
      false,
    );
    const name = ref<string | null>('苏婉');
    const { scope } = run(() => useAssetImage(name, undefined, { source: h.source }));
    await flush();
    for (const next of ['林霜', '沈砚', '苏婉', '无此人', '林霜', '苏婉'] as const) {
      name.value = next;
      await flush();
    }
    // 乱序兑现: 后发的先回
    h.settle('a1');
    h.settle('c1');
    h.settle('b1');
    h.settle('b1');
    h.settle('a1');
    h.settle('a1', null); // 这一轮字节缺失 —— 不欠 release
    await flush();

    scope.stop();
    await flush();

    expect(h.granted.length).toBeGreaterThan(0);
    expect(tally(h.released)).toEqual(tally(h.granted));
  });

  it('拆除时还在飞的那些兑现之后也各自还清（不靠 GC）', async () => {
    const h = makeHarness(
      [row({ id: 'a1', name: '苏婉' }), row({ id: 'b1', name: '林霜' })],
      false,
    );
    const name = ref<string>('苏婉');
    const { scope } = run(() => useAssetImage(name, undefined, { source: h.source }));
    await flush();
    name.value = '林霜';
    await flush();

    scope.stop();
    h.settleAll(); // 两轮都在拆除**之后**才回来
    await flush();

    expect(tally(h.released)).toEqual(tally(h.granted));
    expect(tally(h.released)).toEqual({ a1: 1, b1: 1 });
  });

  /**
   * ★ 接上**真的** LRU 缓存跑一遍 —— 假件只能证明"还的次数对得上"，
   * 证不了"正在显示的那条没被撤销"。这条把两件事一起钉死:
   * 抖动之后 `url.value` 指的必须是一条**活着**的 URL，而收尾时缓存必须一条不剩。
   *
   * 泄漏在这里的现形方式是 `cache.size`: 少还一份，a1 的条目就永远留在表里。
   */
  it('★ 真缓存：抖动中正在显示的 URL 绝不被撤销，拆除后缓存一条不剩', async () => {
    const revoked: string[] = [];
    const waiters: (() => void)[] = [];
    let seq = 0;
    const cache = createAssetUrlCache({
      loadBlob: (id) => new Promise<Blob>((resolve) => waiters.push(() => resolve(new Blob([id])))),
      createObjectURL: () => {
        seq += 1;
        return `blob:fake/${seq}`;
      },
      revokeObjectURL: (u) => {
        revoked.push(u);
      },
    });
    const rows = ref<AssetMetaRecord[]>([
      row({ id: 'a1', name: '苏婉' }),
      row({ id: 'b1', name: '林霜' }),
    ]);
    const source: AssetImageSource = {
      get assets() {
        return rows.value;
      },
      assetUrl: (id) => cache.get(id),
      releaseAssetUrl: (id) => cache.release(id),
    };

    const name = ref<string>('苏婉');
    const { scope, api } = run(() => useAssetImage(name, undefined, { source }));
    await nextTick();
    // 三轮都还在飞时就抖完（a1 的第二轮会搭第一轮的车 → 计数 2，只铸一个 URL）
    name.value = '林霜';
    await nextTick();
    name.value = '苏婉';
    await nextTick();

    for (const w of waiters.splice(0, waiters.length)) w();
    // 真缓存那条链比假件长（load → finally → 采纳 → 活性闸 → composable 的 await），
    // 多冲几轮微任务
    await deepFlush();

    const shown = api.url.value;
    expect(shown).not.toBeNull();
    expect(cache.peek('a1')).toBe(shown); // 还在表里
    expect(revoked).not.toContain(shown); // **且没被撤销** —— 正在显示它
    expect(cache.refCount('a1')).toBe(1); // 多出来的那一份已经收拢掉了

    scope.stop();
    await deepFlush();
    expect(cache.size).toBe(0); // 一条不剩：泄漏在这里现形
    expect(revoked).toContain(shown);
    expect(new Set(revoked).size).toBe(revoked.length); // 也没有二次撤销
  });
});

// ═══════════════════════════════════════════════════════════
// 媒体类型（D7）
// ═══════════════════════════════════════════════════════════

describe('useAssetImage · isVideo', () => {
  it('mp4 行 → isVideo 为 true，png 行为 false', async () => {
    const h = makeHarness([
      row({ id: 'v1', name: '苏婉', ext: 'mp4', mime: 'video/mp4' }),
      row({ id: 'p1', name: '林霜' }),
    ]);
    const video = run(() => useAssetImage('苏婉', undefined, { source: h.source }));
    const still = run(() => useAssetImage('林霜', undefined, { source: h.source }));
    await flush();
    expect(video.api.isVideo.value).toBe(true);
    expect(video.api.url.value).toBe('blob:v1');
    expect(still.api.isVideo.value).toBe(false);
  });

  it('★ 走链降级时，isVideo 说的是**命中的那一档**，不是首选档', async () => {
    // 头像位: 头像 是静图 → false；同一个库里另一个角色只有 mp4 的 立绘bg，
    // 链退到第三档命中它 → true。若 isVideo 认的是链的首选档，这条会翻。
    const h = makeHarness([
      row({ id: 'av', name: '苏婉', type: '头像' }),
      row({ id: 'bgv', name: '林霜', type: '立绘bg', ext: 'mp4', mime: 'video/mp4' }),
    ]);
    const still = run(() => useAssetImage('苏婉', ASSET_TYPE_AVATAR_CHAIN, { source: h.source }));
    const degraded = run(() =>
      useAssetImage('林霜', ASSET_TYPE_AVATAR_CHAIN, { source: h.source }),
    );
    await flush();
    expect(still.api.isVideo.value).toBe(false);
    expect(degraded.api.url.value).toBe('blob:bgv');
    expect(degraded.api.isVideo.value).toBe(true);
  });

  it('查无此素材 → isVideo 为 false', async () => {
    const h = makeHarness([row({ id: 'v1', name: '苏婉', ext: 'mp4', mime: 'video/mp4' })]);
    const { api } = run(() => useAssetImage('无此人', undefined, { source: h.source }));
    await flush();
    expect(api.isVideo.value).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 索引共享
// ═══════════════════════════════════════════════════════════

describe('useAssetImage · 共享索引', () => {
  it('一个组件卸载后，另一个组件仍能看见新导入的行（索引没被 stop 掉）', async () => {
    const h = makeHarness([row({ id: 'a1', name: '苏婉' })]);
    const first = run(() => useAssetImage('苏婉', undefined, { source: h.source }));
    await flush();
    first.scope.stop();

    const second = run(() => useAssetImage('林霜', undefined, { source: h.source }));
    await flush();
    expect(second.api.url.value).toBeNull();

    // 新导入一行 —— 共享索引必须跟着重算
    h.rows.value = [...h.rows.value, row({ id: 'b1', name: '林霜' })];
    await flush();
    expect(second.api.url.value).toBe('blob:b1');
  });
});
