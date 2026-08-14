/**
 * 标记地图 overlay 的锚定结构 —— 源码断言（照本目录既有做法读 SFC 源码，不 mount：
 * jsdom 里没有 OSD 的真渲染，而这里守的全是「谁负责对准锚点」这种结构决定）。
 *
 * 背景与量化记录见 MapPanel.vue `.osd-marker` 规则上的红字注释（2026-08-13 真机定量）。
 * 裁定一句话：**居中只做一次，归 OSD 的 `Placement.CENTER`**。根元素尺寸恒等于图标、
 * 零位移样式；名字标签绝对定位挂在图标下方**不进布局流**，但必须**可命中**
 * （名牌在根盒子外面，`pointer-events: none` 会让点名牌穿透到画布 —— 浏览模式点名牌
 * 变成取消选中，加标记模式点名牌会误落新标记）。
 */
import { describe, it, expect } from 'vitest';
import source from '@ui/components/game/MapPanel.vue?raw';
import markersSource from '@ui/composables/useMapMarkers.ts?raw';

/** 取选择器**恰好**为 `selector` 的规则块声明部分（剥掉块内注释 —— 注释里提到属性名不算数） */
function cssRule(selector: string): string {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`);
  const body = source.match(re)?.[2] ?? '';
  expect(body, `找不到 ${selector} 规则块（选择器改名要连本测试一起改）`).not.toBe('');
  return body.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('标记地图：overlay 锚定只做一次（OSD Placement.CENTER）', () => {
  it('`.osd-marker` 根元素上没有任何位移样式', () => {
    // transform / translate / margin 任意一个都能把标记挪出一个恒定屏幕偏移 ——
    // 缩放时地图点动、偏移不动，标记就又开始在地图上漂
    const rule = cssRule('.osd-marker');
    expect(rule).not.toContain('transform');
    expect(rule).not.toContain('translate');
    expect(rule).not.toContain('margin');
  });

  it('`.osd-marker` 尺寸恒等于图标（图标跟根走，单一来源）', () => {
    const rule = cssRule('.osd-marker');
    expect(rule).toContain('width: 18px');
    expect(rule).toContain('height: 18px');
    const icon = cssRule('.osd-marker-icon');
    expect(icon).toContain('width: 100%');
    expect(icon).toContain('height: 100%');
  });

  it('名字标签不进布局流，但保持可命中', () => {
    const label = cssRule('.osd-marker-label');
    expect(label).toContain('position: absolute');
    expect(label).toContain('top: 100%');
    // 🔴 名牌在 18×18 根盒子外面：none 会让点击穿透到 OSD 画布（加标记模式误落新标记）
    expect(label).toContain('pointer-events: auto');
    expect(label).not.toContain('pointer-events: none');
  });

  it('OSD 侧新增与更新 overlay 两个调用点都用 Placement.CENTER', () => {
    // 点名**调用点**而不是数出现次数：注释里写到 CENTER、或加第三个合法调用点，
    // 都不该让本测试变红；两处任何一处换成别的 placement 才该红
    expect(markersSource).toMatch(
      /addOverlay\(\{[\s\S]*?placement:\s*OpenSeadragon\.Placement\.CENTER/,
    );
    expect(markersSource).toMatch(/updateOverlay\([^)]*OpenSeadragon\.Placement\.CENTER\s*\)/);
  });
});
