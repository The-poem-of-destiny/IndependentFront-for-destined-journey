/**
 * image-world-tags.ts — 时段 / 天气 的中文 → danbooru 标签映射（设计 D39，阶段 B6）
 *
 * 装什么: `buildWorldTags(time, weather)` 一个纯函数 + 它用的两张小表。
 * 不装什么: 拼接。产出的字符串由 `composePrompt` 当 `ComposeOptions.worldTags`
 *           原样拼进 `base`（设计 §5.2 顺序 [3]）——那一层不做任何推导，这一层不做任何拼接。
 *
 * 为什么存在: 「夜里的戏被画成白天」是最扎眼的不一致，而我们**根本不需要让模型记住** ——
 * 引擎知道现在几点、什么天气。所以这两个标签由 Code 注入，不问 AI（D39）。
 *
 * 🔴 **映射不中的值一律不贡献标签**（D39）。天气是 AI 自由书写的短词组合
 * （世界书要求「短词组合」，实际会出现「小雨转晴」「血月低垂」「灵潮涌动」这类），
 * 猜错比留空糟得多：留空只是少一个标签，猜错是**在画面上画出没发生的事**。
 * 因此天气走**精确匹配**，不做包含匹配、不做模糊匹配、不做前缀匹配。
 *
 * 🔴 纯函数：时间从参数进，**不读时钟、不做 I/O、不改入参**。
 */

import { getTimeOfDay, type GameTime } from './time-system';

/**
 * 时段桶 → danbooru 标签。键是 `getTimeOfDay()` 的**全部 7 个返回值**。
 *
 * 🔴 这张表与 `time-system.getTimeOfDay()` 是绑定的：那边加了新桶而这边没跟上时，
 * 新桶会**不贡献标签**（不是抛错、不是猜一个），`image-world-tags.test.ts` 里
 * 「0-23 点每一小时都能出标签」那条断言会变红把它逮住。
 *
 * 🔴 取的都是 danbooru 里描述**时间**而非**光照**的标签。刻意不写 `sunlight` /
 * `sunbeam` 这类——那是「在户外且没遮挡」才成立的推断，而插画多数发生在室内。
 */
export const TIME_OF_DAY_TAGS: Readonly<Record<string, string>> = {
  凌晨: 'night', // 0:00-5:59 —— 天没亮，与深夜同为暗场
  早晨: 'morning', // 6:00-8:59
  上午: 'day', // 9:00-11:59
  中午: 'noon', // 12:00-13:59
  下午: 'afternoon', // 14:00-17:59
  傍晚: 'evening', // 18:00-20:59
  深夜: 'night', // 21:00-23:59
};

/**
 * 天气原文 → danbooru 标签。**精确匹配**（匹配前只去首尾空白）。
 *
 * 🔴 **这张表刻意小**。收录标准是三条同时成立：①中文里指的是天气本身而不是氛围；
 * ②对应到 danbooru 有稳定标签；③单一含义、不需要上下文就能判定。
 * 「宁可漏不可错」——想让某个词生效，请**往表里加一行**，不要把匹配放宽成包含匹配：
 * 包含匹配一旦上线，「小雨转晴」「雨夹雪」「血雨腥风」全都会命中 `雨`，
 * 而前两个是**两种**天气、第三个根本不是天气。
 *
 * 🔴 复合/转折/超自然的写法（「晴转多云」「雷云汇聚的异象」）**故意不收**：
 * 它们要么含义冲突，要么是叙事修辞。落到本函数就是返回空串，交给场景提示词去描述。
 */
export const WEATHER_TAGS: Readonly<Record<string, string>> = {
  // 晴
  晴: 'clear sky',
  晴天: 'clear sky',
  晴朗: 'clear sky',
  // 云
  多云: 'cloudy sky',
  阴: 'overcast',
  阴天: 'overcast',
  // 雨（不分强弱——danbooru 没有稳定的「大雨」标签，强弱交给场景提示词写）
  雨: 'rain',
  下雨: 'rain',
  雨天: 'rain',
  小雨: 'rain',
  细雨: 'rain',
  中雨: 'rain',
  大雨: 'rain',
  暴雨: 'rain',
  雷雨: 'rain, lightning',
  雷暴: 'lightning',
  // 雪
  雪: 'snow',
  下雪: 'snow',
  雪天: 'snow',
  小雪: 'snow',
  大雪: 'snow',
  暴雪: 'snow',
  // 雾
  雾: 'fog',
  大雾: 'fog',
  浓雾: 'fog',
  薄雾: 'fog',
  // 风
  大风: 'wind',
  强风: 'wind',
};

/** 去首尾空白，含全角空格与不换行空格 —— AI 写的短词常带一个全角空格。 */
function trimWeather(raw: string): string {
  return raw.replace(/^[\s　 ]+|[\s　 ]+$/g, '');
}

/**
 * 由引擎已知的时段与天气产出 danbooru 标签串。
 *
 * @param time    游戏内时间。**从参数进**——本函数不读系统时钟。缺失即不贡献时段标签。
 * @param weather `stat-projection` 里 `世界['天气']` 的那个自由文本。缺失或映射不中即不贡献。
 * @returns `', '` 连接的标签串；两项都没有时是**空串**（合法情况，不是错误——
 *          `composePrompt` 遇到空段直接跳过，不会产出 `, ,`）。
 *
 * @example
 * buildWorldTags({ ...t, hour: 22 }, '小雨') // → 'night, rain'
 * buildWorldTags({ ...t, hour: 22 }, '血雨腥风') // → 'night'（天气不猜）
 * buildWorldTags(undefined, undefined) // → ''
 */
export function buildWorldTags(time?: GameTime, weather?: string): string {
  const parts: string[] = [];

  if (time) {
    const tag = TIME_OF_DAY_TAGS[getTimeOfDay(time)];
    if (tag) parts.push(tag);
  }

  if (typeof weather === 'string') {
    const tag = WEATHER_TAGS[trimWeather(weather)];
    if (tag) parts.push(tag);
  }

  return parts.join(', ');
}
