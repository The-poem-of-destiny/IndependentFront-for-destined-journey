/**
 * view-audio.test.ts — 界面 → 场景配乐映射
 *
 * 这层是纯映射，值得测的是**边界语义**：哪些界面不该动音乐、
 * 以及映射出来的查询在真实内置曲库上到底命中了什么。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { queryForView } from './view-audio';
import { resolveSceneByTags } from '@engine/audio-scene';
import type { AudioTrack } from '@engine/types';

describe('queryForView', () => {
  it('首页 / 捏人页给出查询', () => {
    expect(queryForView('home')).not.toBeNull();
    expect(queryForView('create')).not.toBeNull();
  });

  it('游戏页返回 null —— 配乐归 GamePipeline 按地点打分，界面层不插手', () => {
    expect(queryForView('game')).toBeNull();
  });

  it('设置页 / 工坊返回 null —— 用户在这儿调东西，换歌只会碍事', () => {
    expect(queryForView('settings')).toBeNull();
    expect(queryForView('workshop')).toBeNull();
  });

  it('查询里不带地点 —— 界面不是地点，混进去会污染地点维打分', () => {
    for (const v of ['home', 'create'] as const) {
      expect(queryForView(v)?.location).toBeUndefined();
    }
  });
});

// ═══ 与真实内置曲库对账 ═══════════════════════════════════
//
// 映射写得再漂亮，选不出曲子也是白搭。这里直接拿 public/audio/manifest.json
// 跑一遍打分，确保这两个界面在**当前随应用分发的曲库**上真的有曲可选。

function builtinTracks(): AudioTrack[] {
  const raw = JSON.parse(
    readFileSync('public/audio/manifest.json', 'utf8'),
  ) as Array<{ id: string; name: string; kind?: string; file: string; tags?: string[] }>;
  return raw.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind === 'sfx' ? 'sfx' : 'music',
    source: 'builtin',
    url: `/audio/${e.file}`,
    tags: e.tags ?? [],
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  }));
}

describe('界面查询在真实内置曲库上的命中', () => {
  const LIB = builtinTracks();

  it('首页命中「系统·菜单」', () => {
    const hit = resolveSceneByTags(LIB, queryForView('home')!);
    expect(hit?.track.name).toBe('系统·菜单');
  });

  it('捏人页命中仪式曲', () => {
    const hit = resolveSceneByTags(LIB, queryForView('create')!);
    expect(hit?.track.name).toContain('仪式');
  });

  it('界面查询不会误中地点曲 —— 地点维没参与，命中的只能是情境/情绪', () => {
    for (const v of ['home', 'create'] as const) {
      const hit = resolveSceneByTags(LIB, queryForView(v)!);
      expect(hit?.fallbackDepth).toBeNull();
      expect(hit?.breakdown.location).toBe(0);
    }
  });
});
