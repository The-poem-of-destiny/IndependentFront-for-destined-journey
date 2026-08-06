/**
 * resolveMapSources — 地图图源从内容供给（D23）
 * @vitest-environment jsdom
 *
 * （jsdom 是给 `openseadragon` 用的：它在**模块加载时**就摸 `window`，node 环境下
 * 光是 import 本文件的被测模块就会炸。被测函数自己是纯的。）
 *
 * 图源以前是两条写死在源码里的 `i.ibb.co` 热链（第三方图床）。现在从注册表的 `branding`
 * 面来，而那一面是 `unknown`：可能没加载、可能是内容包给的任意 JSON。所以这里的重点全在
 * **坏形状不许把整份图源丢掉，也不许放一个半截对象出去**。
 */
import { describe, it, expect } from 'vitest';
import { resolveMapSources } from './useMapViewer';

describe('resolveMapSources', () => {
  it('注册表未加载（undefined）→ 空列表', () => {
    expect(resolveMapSources(undefined)).toEqual([]);
  });

  it('没有 mapSources 字段 → 空列表（公开仓默认态）', () => {
    expect(resolveMapSources({ appName: '演示' })).toEqual([]);
  });

  it('mapSources 不是数组 → 空列表，不抛', () => {
    expect(resolveMapSources({ mapSources: 'https://example.invalid/map.webp' })).toEqual([]);
  });

  it('逐项校验：坏项跳过，好项保留（不是一颗老鼠屎坏一锅）', () => {
    const out = resolveMapSources({
      mapSources: [
        { key: 'small', name: '高清地图', url: '/data/content/map-small.webp' },
        null,
        { key: '', name: '没有 key', url: '/x.webp' },
        { key: 'no-url', name: '没有地址' },
        { key: 'large', name: '超清地图', url: '/data/content/map-large.webp' },
      ],
    });
    expect(out).toEqual([
      { key: 'small', name: '高清地图', url: '/data/content/map-small.webp' },
      { key: 'large', name: '超清地图', url: '/data/content/map-large.webp' },
    ]);
  });

  it('缺 name 时回落成 key —— 按钮上不许出现空白文字', () => {
    expect(resolveMapSources({ mapSources: [{ key: 'small', url: '/m.webp' }] })).toEqual([
      { key: 'small', name: 'small', url: '/m.webp' },
    ]);
  });
});
