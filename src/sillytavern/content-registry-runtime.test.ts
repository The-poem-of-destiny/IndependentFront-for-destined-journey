/**
 * content-registry-runtime.test.ts — 内容注册表注入缝的行为测试
 *
 * 重点在**兜底与时序**而不是「存进去能取出来」：
 * 这条缝存在的全部理由是让引擎不再反向 import 前端 store，而它的四个消费方
 * （agent-tools 品牌面 / random-tables 名字池 / bloodlines 血脉集 / location-db 地点集）
 * 在**注册表还没灌注**的那一段时间里也会被调用。所以真正要钉住的是：
 *   · 没装过时是十面俱全的空骨架，不是 `undefined`、不是 `null`、不抛
 *   · 空骨架每次是**新对象**（被下游改一格不会污染此后所有兜底调用）
 *   · 读取按调用时刻现取（重装之后立刻可见），不是某次读数的快照
 *
 * 先例: `map-runtime.test.ts` / `random-event-runtime.test.ts`（同族的两条缝）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  createEmptyContentRegistry,
  getContentRegistry,
  installContentRegistry,
  resetContentRegistryRuntime,
  type ContentRegistry,
} from './content-registry-runtime';

/** 十面齐全的夹具（值本身无意义，只用来确认「装什么取到什么」） */
function fixture(overrides: Partial<ContentRegistry> = {}): ContentRegistry {
  return {
    ...createEmptyContentRegistry(),
    catalog: { pools: ['fixture'] },
    locations: [{ id: 'x' }],
    bloodlines: { b1: { name: 'n', description: 'd' } },
    namePools: { races: {} },
    markers: [],
    branding: { appTitle: 'fixture' },
    imageDialects: { dialects: [] },
    mapPack: { tiles: [] },
    randomEvents: { defs: [] },
    remoteAssets: [{ url: 'https://example.invalid/a.png' }],
    ...overrides,
  };
}

afterEach(() => {
  resetContentRegistryRuntime();
});

describe('兜底：没人装过时的空骨架', () => {
  it('十面俱全且全为 undefined（消费方走的是它们本来就有的空值路径）', () => {
    const reg = getContentRegistry();
    expect(Object.keys(reg).sort()).toEqual(
      [
        'bloodlines',
        'branding',
        'catalog',
        'imageDialects',
        'locations',
        'mapPack',
        'markers',
        'namePools',
        'randomEvents',
        'remoteAssets',
      ].sort(),
    );
    for (const [face, value] of Object.entries(reg)) {
      expect(value, `${face} 面应当是 undefined`).toBeUndefined();
    }
  });

  it('读取本身不抛，且返回的是对象而不是 null/undefined', () => {
    expect(() => getContentRegistry()).not.toThrow();
    expect(getContentRegistry()).toBeTypeOf('object');
    expect(getContentRegistry()).not.toBeNull();
  });

  it('空骨架每次是新对象 —— 被下游改一格不会污染此后的兜底', () => {
    const a = createEmptyContentRegistry();
    const b = createEmptyContentRegistry();
    expect(a).not.toBe(b);
    a.branding = { appTitle: '被下游改过' };
    expect(createEmptyContentRegistry().branding).toBeUndefined();
    // 缝自己的兜底同样不该被污染
    resetContentRegistryRuntime();
    expect(getContentRegistry().branding).toBeUndefined();
  });
});

describe('install / get', () => {
  it('装什么取到什么（同一个对象引用，整份替换不深拷贝）', () => {
    const reg = fixture();
    installContentRegistry(reg);
    expect(getContentRegistry()).toBe(reg);
    expect(getContentRegistry().branding).toEqual({ appTitle: 'fixture' });
  });

  it('重装整份盖掉前一份，**不深合并**（不留半状态）', () => {
    installContentRegistry(fixture());
    installContentRegistry({ ...createEmptyContentRegistry(), catalog: { pools: ['second'] } });
    const reg = getContentRegistry();
    expect(reg.catalog).toEqual({ pools: ['second'] });
    // 前一份的 branding 不该「残留」下来 —— 深合并会让它活着
    expect(reg.branding).toBeUndefined();
  });

  it('读取按调用时刻现取：重装后立刻可见（消费方不缓存读数的前提）', () => {
    installContentRegistry(fixture({ branding: { appTitle: '第一版' } }));
    expect(getContentRegistry().branding).toEqual({ appTitle: '第一版' });
    installContentRegistry(fixture({ branding: { appTitle: '第二版' } }));
    expect(getContentRegistry().branding).toEqual({ appTitle: '第二版' });
  });
});

describe('运行时闸：跨模块边界上 TS 拦不住的入参', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'oops'],
    ['数字', 42],
  ])('装进一个「不是对象」的 %s → 落成空骨架而不是抛', (_label, bad) => {
    installContentRegistry(fixture());
    expect(() => installContentRegistry(bad as unknown as ContentRegistry)).not.toThrow();
    expect(getContentRegistry().catalog).toBeUndefined();
    expect(getContentRegistry().branding).toBeUndefined();
  });

  it('数组是对象 —— 刻意不额外收窄（keep dumb），十面读出来都是 undefined', () => {
    installContentRegistry([] as unknown as ContentRegistry);
    expect(getContentRegistry().catalog).toBeUndefined();
  });
});

describe('reset（测试隔离用）', () => {
  it('装过真夹具后 reset 回到空骨架 —— 否则后面「未就绪应当兜底」的断言会悄悄测在真内容上', () => {
    installContentRegistry(fixture());
    expect(getContentRegistry().catalog).toBeDefined();
    resetContentRegistryRuntime();
    expect(getContentRegistry().catalog).toBeUndefined();
  });

  it('reset 幂等', () => {
    resetContentRegistryRuntime();
    resetContentRegistryRuntime();
    expect(getContentRegistry().branding).toBeUndefined();
  });
});
