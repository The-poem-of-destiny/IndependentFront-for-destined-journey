/**
 * image-segments.test.ts — `splitSceneImageSegments` 分段器测试（图像生成 v1 §5.1）
 *
 * 覆盖: 无标记 / 空串 / 单标记切三段 / 多标记 occurrence 递增 / 相邻文本段合并 /
 *       空文本段不产出 / 空正文标记等价于剥掉 / 三种写法（成对·自闭合·漏写闭合）/
 *       与 scanSceneImages 单一解析器同源。
 */

import { describe, it, expect } from 'vitest';
import { splitSceneImageSegments } from './image-segments';
import { scanSceneImages, stripMarkers } from './marker-protocol';
import type { NarrativeSegment } from './types-image';

/** 只取文本段拼起来 —— 用来断言「剥掉标记后的正文」这一整体性质 */
function joinText(segments: NarrativeSegment[]): string {
  return segments
    .filter((s): s is Extract<NarrativeSegment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.text)
    .join('');
}

function images(segments: NarrativeSegment[]) {
  return segments.filter(
    (s): s is Extract<NarrativeSegment, { kind: 'image' }> => s.kind === 'image',
  );
}

describe('splitSceneImageSegments — 边界输入', () => {
  it('空串返回空数组（不是一个空文本段）', () => {
    expect(splitSceneImageSegments('')).toEqual([]);
  });

  it('无标记时返回单个文本段，调用方不必特判', () => {
    const text = '她推开酒馆的门，暖光扑面而来。';
    expect(splitSceneImageSegments(text)).toEqual([{ kind: 'text', text }]);
  });

  it('只有空白也照样产出文本段（只有空串才叫空文本段）', () => {
    expect(splitSceneImageSegments('\n\n')).toEqual([{ kind: 'text', text: '\n\n' }]);
  });

  it('其它标记不参与分段（只切 scene_image）', () => {
    const text = '前<combat_trigger combatType="遭遇">狼群</combat_trigger>后';
    expect(splitSceneImageSegments(text)).toEqual([{ kind: 'text', text }]);
  });
});

describe('splitSceneImageSegments — 基本切分', () => {
  it('单个成对标记切成 文本/图片/文本 三段', () => {
    const text = '前文。<scene_image title="酒馆">壁炉边的少女</scene_image>后文。';
    const segments = splitSceneImageSegments(text);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: 'text', text: '前文。' });
    expect(segments[2]).toEqual({ kind: 'text', text: '后文。' });

    const image = segments[1];
    expect(image.kind).toBe('image');
    if (image.kind !== 'image') throw new Error('unreachable');
    expect(image.occurrence).toBe(0);
    expect(image.marker.bodyText).toBe('壁炉边的少女');
    expect(image.marker.title).toBe('酒馆');
  });

  it('标记在开头/结尾时不产出空文本段', () => {
    const text = '<scene_image>甲</scene_image>中间<scene_image>乙</scene_image>';
    const segments = splitSceneImageSegments(text);

    expect(segments.map((s) => s.kind)).toEqual(['image', 'text', 'image']);
    expect(segments.every((s) => s.kind !== 'text' || s.text.length > 0)).toBe(true);
  });

  it('文本段与图片段拼回去 = 原文（图片段还原成 rawContent）', () => {
    const text = 'A<scene_image>甲</scene_image>B<scene_image>乙</scene_image>C';
    const rebuilt = splitSceneImageSegments(text)
      .map((s) => (s.kind === 'text' ? s.text : s.marker.rawContent))
      .join('');
    expect(rebuilt).toBe(text);
  });
});

describe('splitSceneImageSegments — occurrence', () => {
  it('在整条消息上从 0 递增', () => {
    const text =
      '一<scene_image>甲</scene_image>二<scene_image>乙</scene_image>三<scene_image>丙</scene_image>';
    expect(images(splitSceneImageSegments(text)).map((s) => s.occurrence)).toEqual([0, 1, 2]);
  });

  it('无效标记不占号 —— 中间不留洞，记录才挂得回正文（D2）', () => {
    const text = '一<scene_image>甲</scene_image>二<scene_image />三<scene_image>乙</scene_image>';
    const found = images(splitSceneImageSegments(text));
    expect(found.map((s) => s.occurrence)).toEqual([0, 1]);
    expect(found.map((s) => s.marker.bodyText)).toEqual(['甲', '乙']);
  });
});

describe('splitSceneImageSegments — 相邻文本段合并', () => {
  it('无效标记两侧的文本粘成一段（剥掉 = 从没写过）', () => {
    const segments = splitSceneImageSegments('左<scene_image title="空" />右');
    expect(segments).toEqual([{ kind: 'text', text: '左右' }]);
  });

  it('连续多个无效标记也只留一段文本', () => {
    const segments = splitSceneImageSegments('左<scene_image /><scene_image />中<scene_image />右');
    expect(segments).toEqual([{ kind: 'text', text: '左中右' }]);
  });

  it('正文只有一个无效标记时返回空数组（等价于整段被剥掉）', () => {
    expect(splitSceneImageSegments('<scene_image />')).toEqual([]);
  });
});

describe('splitSceneImageSegments — 三种写法（承 scanLenientTag §3.4）', () => {
  it('自闭合：不产图片段，正文照剥', () => {
    const segments = splitSceneImageSegments('前<scene_image title="夜色" rating="general"/>后');
    expect(segments).toEqual([{ kind: 'text', text: '前后' }]);
  });

  it('只有开标签（AI 漏写闭合）：正文吃到末尾，照样产出图片段', () => {
    const segments = splitSceneImageSegments('前文。<scene_image title="夕阳">她站在城墙上');
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ kind: 'text', text: '前文。' });

    const image = segments[1];
    if (image.kind !== 'image') throw new Error('expected image segment');
    expect(image.occurrence).toBe(0);
    expect(image.marker.bodyText).toBe('她站在城墙上');
  });

  it('漏写闭合的正文右界是下一个已知标记，不会吞掉它', () => {
    const text = '<scene_image>雨中的长街<play_audio situation="伤感"/>之后';
    const segments = splitSceneImageSegments(text);

    const image = segments.find((s) => s.kind === 'image');
    if (image?.kind !== 'image') throw new Error('expected image segment');
    expect(image.marker.bodyText).toBe('雨中的长街');
    // play_audio 与其后的正文仍留在文本段里，交给下游各自处理
    expect(joinText(segments)).toBe('<play_audio situation="伤感"/>之后');
  });
});

describe('splitSceneImageSegments — 字段与单一解析器', () => {
  it('marker 原样来自 scanSceneImages（不做第二次解析）', () => {
    const text =
      '前<scene_image title="重逢" characters="苏婉，艾莉" rating="sensitive">她们再次相遇</scene_image>后';
    const scanned = scanSceneImages(text);
    const found = images(splitSceneImageSegments(text));

    expect(found).toHaveLength(1);
    expect(found[0].marker).toEqual(scanned[0]);
    expect(found[0].marker.characters).toEqual(['苏婉', '艾莉']);
    expect(found[0].marker.rating).toBe('sensitive');
  });

  it('剥掉标记后的文本与 stripMarkers 一致（同一份 position/rawContent）', () => {
    const text = 'A<scene_image>甲</scene_image>B<scene_image />C';
    expect(joinText(splitSceneImageSegments(text))).toBe(stripMarkers(text));
  });

  it('多行正文与跨行标记照常工作', () => {
    const text = '第一行\n<scene_image title="山谷">\n  晨雾中的山谷\n</scene_image>\n第三行';
    const segments = splitSceneImageSegments(text);

    expect(segments.map((s) => s.kind)).toEqual(['text', 'image', 'text']);
    expect(segments[0]).toEqual({ kind: 'text', text: '第一行\n' });
    expect(segments[2]).toEqual({ kind: 'text', text: '\n第三行' });

    const image = segments[1];
    if (image.kind !== 'image') throw new Error('expected image segment');
    expect(image.marker.bodyText).toBe('晨雾中的山谷');
  });
});
