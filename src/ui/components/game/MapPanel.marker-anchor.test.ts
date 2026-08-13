/**
 * 标记地图 overlay 的锚定结构 —— 源码断言（照本目录既有做法读 SFC 源码，不 mount：
 * jsdom 里没有 OSD 的真渲染，而这里守的全是「谁负责对准锚点」这种结构决定）。
 *
 * 背景（2026-08-13 真机定量）：OSD 侧用 `Placement.CENTER` 加 overlay，wrapper 已把
 * **元素中心对准锚点**；`.osd-marker` 上曾再叠一层 `translate(-50%, -100%)`，把元素
 * 又挪出半宽 + 全高 —— 而元素高度里含着图标下方的名字标签，于是每个标记都带着一个
 * **恒定屏幕像素**的偏移（实测约 (−标签宽/2, −50)px，随标签文字长短各不相同）。
 * 缩放时地图点动、偏移不动，标记看起来就在地图上滑走。
 *
 * 裁定：居中只做一次，归 OSD。根元素尺寸恒等于图标（18×18）、零位移 transform，
 * 名字标签绝对定位挂在图标下方**不进布局流** —— 「图标中心 = 锚点」是结构保证。
 */
import { describe, it, expect } from 'vitest';
import source from '@ui/components/game/MapPanel.vue?raw';
import markersSource from '@ui/composables/useMapMarkers.ts?raw';

describe('标记地图：overlay 锚定只做一次（OSD Placement.CENTER）', () => {
  it('`.osd-marker` 根元素上没有位移 transform', () => {
    // 加回来不报错，只是标记又开始随缩放在地图上漂 —— 所以钉死这个规则块。
    // （`.map-marker-card` 的 translate(-50%, -100%) 是合法的：浮卡走自己的
    //   left/top 定位，不在 OSD 的 CENTER placement 之上叠加）
    const rule = source.match(/\.osd-marker\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).not.toBe('');
    expect(rule).not.toContain('transform:');
  });

  it('`.osd-marker` 尺寸恒等于图标，标签不进布局流', () => {
    const rule = source.match(/\.osd-marker\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('width: 18px');
    expect(rule).toContain('height: 18px');
    const labelRule = source.match(/\.osd-marker-label\s*\{[^}]*\}/)?.[0] ?? '';
    expect(labelRule).toContain('position: absolute');
    expect(labelRule).toContain('top: 100%');
  });

  it('OSD 侧新增与更新 overlay 都用 Placement.CENTER', () => {
    // 居中归 OSD 这一侧；两处（addOverlay / updateOverlay）都要是 CENTER，
    // 少一处就会出现「新加的标记准、拖动过的标记漂」这类只在部分标记上复现的错位
    expect(markersSource.match(/Placement\.CENTER/g) ?? []).toHaveLength(2);
  });
});
