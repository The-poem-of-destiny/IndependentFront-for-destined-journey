/**
 * image-world-tags.test.ts — D39 的守卫测试
 *
 * 本文件的重心只有一条：**映射不中的值一律不贡献标签**。天气是 AI 自由书写的短词，
 * 猜错等于在画面上画出没发生的事，所以「不猜」那组用例列得比「能猜中」那组还长。
 */

import { describe, it, expect } from 'vitest';

import { buildWorldTags, TIME_OF_DAY_TAGS, WEATHER_TAGS } from './image-world-tags';
import { getTimeOfDay, type GameTime } from './time-system';

/** 基准时刻；每条用例只改 hour。刻意写死——本函数不读时钟，测试也不该读。 */
const T: GameTime = {
  era: '复兴纪元',
  year: 1,
  month: 5,
  day: 24,
  weekday: 1,
  hour: 12,
  minute: 30,
};

const at = (hour: number): GameTime => ({ ...T, hour });

describe('时段 → 标签', () => {
  it('getTimeOfDay 的 7 个桶各有对应标签', () => {
    expect(buildWorldTags(at(3))).toBe('night'); // 凌晨
    expect(buildWorldTags(at(7))).toBe('morning'); // 早晨
    expect(buildWorldTags(at(10))).toBe('day'); // 上午
    expect(buildWorldTags(at(13))).toBe('noon'); // 中午
    expect(buildWorldTags(at(16))).toBe('afternoon'); // 下午
    expect(buildWorldTags(at(19))).toBe('evening'); // 傍晚
    expect(buildWorldTags(at(23))).toBe('night'); // 深夜
  });

  it('🔴 0-23 点每一小时都出得了标签 —— time-system 加新桶而本表没跟上时这条会红', () => {
    for (let h = 0; h < 24; h++) {
      const bucket = getTimeOfDay(at(h));
      expect(TIME_OF_DAY_TAGS[bucket], `${h} 点的时段「${bucket}」没有映射`).toBeTruthy();
      expect(buildWorldTags(at(h))).not.toBe('');
    }
  });

  it('夜里的戏不会带上任何白天词 —— D39 存在的理由', () => {
    for (const h of [0, 3, 5, 21, 22, 23]) {
      const tags = buildWorldTags(at(h), '晴');
      expect(tags.startsWith('night')).toBe(true);
      expect(tags).not.toMatch(/\b(day|noon|morning|afternoon|sun)\b/);
    }
  });
});

describe('天气 → 标签（命中）', () => {
  it('常见中文天气词映射到 danbooru 标签', () => {
    expect(buildWorldTags(undefined, '小雨')).toBe('rain');
    expect(buildWorldTags(undefined, '大雪')).toBe('snow');
    expect(buildWorldTags(undefined, '浓雾')).toBe('fog');
    expect(buildWorldTags(undefined, '晴')).toBe('clear sky');
    expect(buildWorldTags(undefined, '阴天')).toBe('overcast');
    expect(buildWorldTags(undefined, '雷雨')).toBe('rain, lightning');
  });

  it('匹配前只去首尾空白（含全角空格）', () => {
    expect(buildWorldTags(undefined, '  小雨 ')).toBe('rain');
    expect(buildWorldTags(undefined, '　晴天　')).toBe('clear sky');
    expect(buildWorldTags(undefined, '\n雾\t')).toBe('fog');
  });
});

describe('🔴 映射不中一律返回空串 —— 绝不猜（D39 的唯一硬约束）', () => {
  const 不猜 = [
    // 复合/转折：是两种天气，猜任何一个都是错的
    '小雨转晴',
    '晴转多云',
    '雨夹雪',
    '先晴后雨',
    // 修辞与超自然现象：根本不是天气
    '血雨腥风',
    '血月低垂',
    '灵潮涌动',
    '天穹裂开，异色的光垂落',
    '风雪将至的压抑感',
    // 带修饰或长句：含义要靠上下文，不该由本表拍板
    '雨后初霁',
    '晴朗但寒冷的午后',
    '暴雨如注，雷声在山谷间滚过',
    // 非中文与噪声
    'rain',
    'sunny',
    '???',
    '-',
  ];

  it.each(不猜)('「%s」不贡献任何标签', (weather) => {
    expect(buildWorldTags(undefined, weather)).toBe('');
  });

  it('不中的天气也不会连累时段标签', () => {
    expect(buildWorldTags(at(22), '血雨腥风')).toBe('night');
    expect(buildWorldTags(at(10), '晴转多云')).toBe('day');
  });

  it('🔴 不做包含匹配 —— 「雨」在串里出现不等于在下雨', () => {
    expect(buildWorldTags(undefined, '血雨腥风')).toBe('');
    expect(buildWorldTags(undefined, '雨过天晴')).toBe('');
    expect(buildWorldTags(undefined, '暴风雪与冰雹交加')).toBe('');
  });
});

describe('引擎没有这些信息时', () => {
  it('两项都缺 → 空串（合法情况，不是错误）', () => {
    expect(buildWorldTags()).toBe('');
    expect(buildWorldTags(undefined, undefined)).toBe('');
  });

  it('天气是空串/纯空白 → 只出时段', () => {
    expect(buildWorldTags(at(22), '')).toBe('night');
    expect(buildWorldTags(at(22), '   ')).toBe('night');
    expect(buildWorldTags(undefined, '')).toBe('');
  });

  it('只有时段 / 只有天气 各自成立', () => {
    expect(buildWorldTags(at(19))).toBe('evening');
    expect(buildWorldTags(undefined, '小雨')).toBe('rain');
  });
});

describe('产出形状', () => {
  it('两项都有时按「时段, 天气」顺序，用 ", " 连接', () => {
    expect(buildWorldTags(at(22), '小雨')).toBe('night, rain');
    expect(buildWorldTags(at(7), '大雪')).toBe('morning, snow');
  });

  it('永不产出空段（前后逗号 / 连续逗号）—— composePrompt 的不变式靠这个', () => {
    const 样本 = [
      buildWorldTags(),
      buildWorldTags(at(3)),
      buildWorldTags(undefined, '雾'),
      buildWorldTags(at(3), '雾'),
      buildWorldTags(at(3), '不存在的天气'),
    ];
    for (const s of 样本) {
      expect(s).not.toMatch(/^,|,\s*$|,\s*,/);
      expect(s).toBe(s.trim());
    }
  });
});

describe('纯函数', () => {
  it('同样的入参永远得到同样的结果，且不改入参', () => {
    const time = at(22);
    const snapshot = JSON.stringify(time);
    const first = buildWorldTags(time, '小雨');
    const second = buildWorldTags(time, '小雨');
    expect(second).toBe(first);
    expect(JSON.stringify(time)).toBe(snapshot);
  });

  it('结果只随入参变，不随真实时钟变', () => {
    // 真实系统时间随便是几点，深夜的入参就该出 night
    expect(buildWorldTags(at(23))).toBe('night');
  });
});

describe('两张表本身', () => {
  it('值都是非空、无首尾空白、无前后逗号的小写 ASCII 标签', () => {
    for (const [key, tag] of [
      ...Object.entries(TIME_OF_DAY_TAGS),
      ...Object.entries(WEATHER_TAGS),
    ]) {
      expect(tag, `「${key}」的值为空`).not.toBe('');
      expect(tag).toBe(tag.trim());
      expect(tag).not.toMatch(/^,|,\s*$|,\s*,/);
      expect(tag, `「${key}」的值含非 ASCII 或大写`).toMatch(/^[a-z0-9 ,:-]+$/);
    }
  });

  it('🔴 天气表刻意小 —— 大到需要「先想想」的时候，说明该改用别的手段而不是继续堆词', () => {
    expect(Object.keys(WEATHER_TAGS).length).toBeLessThanOrEqual(40);
  });

  it('天气表不含任何分级/画质词 —— 那两件事分别归 rating 与画质后缀管', () => {
    for (const tag of Object.values(WEATHER_TAGS)) {
      expect(tag).not.toMatch(/rating:|quality|masterpiece/);
    }
  });
});
