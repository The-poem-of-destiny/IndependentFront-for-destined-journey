/**
 * audio-tags.ts — 音频标签的类型化 (Phase Audio)
 *
 * 为什么存在: `AudioTrack.tags` 是一个扁平的 `string[]`，「龙脊山脉」「傲雪」
 * 「紧张」「战斗」混在一起，选曲时无从知道哪个是地点、哪个是人物。加权累计
 * 打分需要按维度分开算，所以标签必须能分类。
 *
 * 为什么用前缀而不是新字段: `类型:值` 写在既有 `tags` 里，`AudioTrack` 的
 * 形状、Dexie 三张表、设置页的标签 UI、`playByTag` 全都不用动。加一个
 * `taxonomy` 字段要改 schema + 迁移 + UI，代价大得多，收益一样。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无 AudioContext。
 *
 * 🔴 已知限制（刻意不做）:
 * - 不做值的同义词归并（`情绪:紧张` 与 `情绪:不安` 是两个值，靠相似度撮合）
 * - 一个标签只能有一个类型（`地点:人物:X` 的第二个冒号属于值）
 */

import { normalizeAudioName } from './audio-names';

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 标签维度。与选曲的打分维度一一对应 */
export type AudioTagType = 'location' | 'character' | 'mood' | 'situation';

export const AUDIO_TAG_TYPES: readonly AudioTagType[] = [
  'location',
  'character',
  'mood',
  'situation',
];

/** 写入时使用的规范前缀（中文，与曲库 UI 的展示口径一致） */
export const AUDIO_TAG_PREFIX: Readonly<Record<AudioTagType, string>> = {
  location: '地点',
  character: '人物',
  mood: '情绪',
  situation: '情境',
};

/**
 * 读取时认的前缀别名。写入只产规范前缀，读取尽量宽容 ——
 * 用户手打标签时不该因为写了 `角色:` 而不是 `人物:` 就失效。
 */
const PREFIX_LOOKUP: Readonly<Record<string, AudioTagType>> = {
  地点: 'location', 位置: 'location', location: 'location', loc: 'location',
  人物: 'character', 角色: 'character', character: 'character', char: 'character',
  情绪: 'mood', 心情: 'mood', 氛围: 'mood', mood: 'mood',
  情境: 'situation', 场景: 'situation', situation: 'situation', scene: 'situation',
};

/** 半角/全角冒号都认；只在**第一个**冒号处切分，值里的冒号原样保留 */
const SEPARATOR = /[:：]/;

// ═══════════════════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════════════════

export interface ParsedAudioTag {
  /** 无法识别前缀时为 null —— 无类型标签参与**所有**维度的比对 */
  type: AudioTagType | null;
  /** 去掉前缀后的值；无类型标签的值就是原文 */
  value: string;
  /** 原始标签文本 */
  raw: string;
}

/**
 * 解析单条标签。
 *
 * 无类型标签（没写前缀、或前缀不认识）的 `type` 为 `null`。这类标签在选曲时
 * **参与所有维度**的比对：既然不知道用户想表达哪一维，就都试一遍，宁可多算
 * 也不要把用户自己打的标签变成死标签。
 */
export function parseAudioTag(raw: string): ParsedAudioTag {
  const text = (raw ?? '').trim();
  const m = SEPARATOR.exec(text);
  if (!m || m.index === 0) return { type: null, value: text, raw: text };

  const head = text.slice(0, m.index).trim();
  const tail = text.slice(m.index + 1).trim();
  const type = PREFIX_LOOKUP[normalizeAudioName(head)];
  if (!type || !tail) return { type: null, value: text, raw: text };
  return { type, value: tail, raw: text };
}

/** 拼一条规范标签。值里的首尾空白会被清掉 */
export function formatAudioTag(type: AudioTagType, value: string): string {
  return `${AUDIO_TAG_PREFIX[type]}:${(value ?? '').trim()}`;
}

// ═══════════════════════════════════════════════════════════
// 分组
// ═══════════════════════════════════════════════════════════

export interface GroupedTags {
  location: string[];
  character: string[];
  mood: string[];
  situation: string[];
  /** 无类型标签。**不会**被复制进上面四组，取用时需自行并入 */
  untyped: string[];
}

/** 按维度分组。空标签直接丢弃，值保留原始大小写与写法 */
export function groupTrackTags(tags: readonly string[]): GroupedTags {
  const out: GroupedTags = { location: [], character: [], mood: [], situation: [], untyped: [] };
  for (const raw of tags ?? []) {
    const parsed = parseAudioTag(raw);
    if (!parsed.value) continue;
    if (parsed.type) out[parsed.type].push(parsed.value);
    else out.untyped.push(parsed.value);
  }
  return out;
}

/**
 * 取某一维度可用于比对的值：该维度的标签 **+ 全部无类型标签**。
 *
 * 无类型标签在每个维度都出现是有意的——见 `parseAudioTag` 的说明。
 */
export function tagValuesFor(grouped: GroupedTags, type: AudioTagType): string[] {
  return grouped[type].length === 0 && grouped.untyped.length === 0
    ? []
    : [...grouped[type], ...grouped.untyped];
}
