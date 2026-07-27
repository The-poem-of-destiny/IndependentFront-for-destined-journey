/**
 * audio-tags.test.ts — 标签类型化
 *
 * 覆盖:
 * 1. parseAudioTag 的前缀识别、别名、全角冒号、无类型兜底
 * 2. 值里的冒号不被二次切分
 * 3. groupTrackTags 分组；tagValuesFor 把无类型标签并入每个维度
 */

import { describe, it, expect } from 'vitest';
import {
  parseAudioTag,
  formatAudioTag,
  groupTrackTags,
  tagValuesFor,
  AUDIO_TAG_PREFIX,
} from './audio-tags';

describe('parseAudioTag', () => {
  it('识别四个规范前缀', () => {
    expect(parseAudioTag('地点:龙脊山脉')).toEqual({ type: 'location', value: '龙脊山脉', raw: '地点:龙脊山脉' });
    expect(parseAudioTag('人物:傲雪').type).toBe('character');
    expect(parseAudioTag('情绪:紧张').type).toBe('mood');
    expect(parseAudioTag('情境:战斗').type).toBe('situation');
  });

  it('认前缀别名与英文（用户手打不该因为写法失效）', () => {
    expect(parseAudioTag('角色:幽露').type).toBe('character');
    expect(parseAudioTag('location:龙脊山脉').type).toBe('location');
    expect(parseAudioTag('Mood:紧张').type).toBe('mood');
    expect(parseAudioTag('场景:仪式').type).toBe('situation');
  });

  it('全角冒号与前后空白都认', () => {
    expect(parseAudioTag(' 地点 ： 龙脊山脉 ')).toEqual({
      type: 'location', value: '龙脊山脉', raw: '地点 ： 龙脊山脉',
    });
  });

  it('只在第一个冒号处切分，值里的冒号原样保留', () => {
    expect(parseAudioTag('情境:战斗:决战')).toEqual({
      type: 'situation', value: '战斗:决战', raw: '情境:战斗:决战',
    });
  });

  it('不认识的前缀退回无类型，且值保留完整原文', () => {
    expect(parseAudioTag('天气:雨')).toEqual({ type: null, value: '天气:雨', raw: '天气:雨' });
  });

  it('没有冒号 / 冒号在首位 / 值为空 → 无类型', () => {
    expect(parseAudioTag('龙脊山脉').type).toBeNull();
    expect(parseAudioTag(':龙脊山脉').type).toBeNull();
    expect(parseAudioTag('地点:').type).toBeNull();
  });
});

describe('formatAudioTag', () => {
  it('只产规范前缀，值去首尾空白', () => {
    expect(formatAudioTag('location', ' 龙脊山脉 ')).toBe('地点:龙脊山脉');
    expect(formatAudioTag('character', '傲雪')).toBe(`${AUDIO_TAG_PREFIX.character}:傲雪`);
  });

  it('产出的标签能被自己解析回去', () => {
    const tag = formatAudioTag('situation', '战斗');
    expect(parseAudioTag(tag)).toEqual({ type: 'situation', value: '战斗', raw: tag });
  });
});

describe('groupTrackTags / tagValuesFor', () => {
  const TAGS = ['地点:龙脊山脉', '地点:火山', '人物:傲雪', '情绪:紧张', '情境:战斗', '雨夜', '  '];

  it('按维度分组，空标签丢弃', () => {
    const g = groupTrackTags(TAGS);
    expect(g.location).toEqual(['龙脊山脉', '火山']);
    expect(g.character).toEqual(['傲雪']);
    expect(g.mood).toEqual(['紧张']);
    expect(g.situation).toEqual(['战斗']);
    expect(g.untyped).toEqual(['雨夜']);
  });

  it('无类型标签并入**每个**维度的可比对值', () => {
    const g = groupTrackTags(TAGS);
    expect(tagValuesFor(g, 'location')).toEqual(['龙脊山脉', '火山', '雨夜']);
    expect(tagValuesFor(g, 'mood')).toEqual(['紧张', '雨夜']);
    expect(tagValuesFor(g, 'character')).toEqual(['傲雪', '雨夜']);
  });

  it('某维度既无类型标签也无无类型标签时返回空数组', () => {
    const g = groupTrackTags(['地点:龙脊山脉']);
    expect(tagValuesFor(g, 'character')).toEqual([]);
    expect(tagValuesFor(g, 'location')).toEqual(['龙脊山脉']);
  });

  it('空输入不炸', () => {
    expect(groupTrackTags([])).toEqual({
      location: [], character: [], mood: [], situation: [], untyped: [],
    });
  });
});
