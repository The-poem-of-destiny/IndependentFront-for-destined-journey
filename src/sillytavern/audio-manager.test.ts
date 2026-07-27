/**
 * audio-manager.test.ts — AudioManager 单元测试
 *
 * 覆盖设计 §9 的 Mixing / AI hook / Unlock / Observation / Library sync 五行。
 * 所有浏览器 seam 走 audio-fakes.ts 注入 —— vitest environment 是 node。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioManager, type ManagerAudioContextLike } from './audio-manager';
import {
  FakeAudioContext,
  FakeGainNode,
  createFakeAudioElement,
  createFakeLibrary,
  createFakeObjectUrls,
  makeTrack,
  type FakeAudioElement,
  type FakeLibrary,
  type FakeObjectUrls,
} from './audio-fakes';
import type { AudioPlaybackState, AudioPlaylist } from './types';

/**
 * FakeAudioContext 缺 Manager 需要的 resume/close —— 只补这两个，其余全部继承。
 */
class FakeManagerContext extends FakeAudioContext implements ManagerAudioContextLike {
  resumeCount = 0;
  closeCount = 0;
  resumeRejection: unknown = null;

  resume(): Promise<void> {
    this.resumeCount += 1;
    if (this.resumeRejection !== null) return Promise.reject(this.resumeRejection);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

interface Harness {
  ctx: FakeManagerContext;
  el: FakeAudioElement;
  lib: FakeLibrary;
  urls: FakeObjectUrls;
  mgr: AudioManager;
  /** 构造序: [0]=master, [1]=music, [2]=sfx */
  master: FakeGainNode;
  musicGain: FakeGainNode;
  sfxGain: FakeGainNode;
}

function setup(opts: { random?: () => number } = {}): Harness {
  const ctx = new FakeManagerContext();
  const el = createFakeAudioElement();
  const lib = createFakeLibrary();
  const urls = createFakeObjectUrls();
  const mgr = new AudioManager({
    createContext: () => ctx,
    createElement: () => el,
    createObjectURL: urls.createObjectURL,
    revokeObjectURL: urls.revokeObjectURL,
    loadBlob: lib.loadBlob,
    random: opts.random ?? (() => 0),
    fadeMs: 0,
  });
  return {
    ctx,
    el,
    lib,
    urls,
    mgr,
    master: ctx.gains[0] as FakeGainNode,
    musicGain: ctx.gains[1] as FakeGainNode,
    sfxGain: ctx.gains[2] as FakeGainNode,
  };
}

/** 往 harness 里灌曲目并同步给 Manager */
function seed(h: Harness, tracks: ReturnType<typeof makeTrack>[]): void {
  for (const t of tracks) h.lib.add(t);
  h.mgr.setTracks(Array.from(h.lib.tracks.values()));
}

function playlist(id: string, trackIds: string[]): AudioPlaylist {
  return { id, name: `列表 ${id}`, trackIds, createdAt: 1, updatedAt: 1 };
}

describe('AudioManager — 增益图 (§4.1)', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });

  it('master gain 接到 context.destination', () => {
    expect(h.master.connectedTo).toContain(h.ctx.destination);
  });

  it('两个声道的 gain 都接到 master 而非 destination', () => {
    expect(h.musicGain.connectedTo).toContain(h.master);
    expect(h.sfxGain.connectedTo).toContain(h.master);
    expect(h.musicGain.connectedTo).not.toContain(h.ctx.destination);
    expect(h.sfxGain.connectedTo).not.toContain(h.ctx.destination);
  });
});

describe('AudioManager — 混音 (§9 Mixing)', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });

  it('setMasterVolume 写入 master gain 并反映在 state', () => {
    h.mgr.setMasterVolume(0.5);
    expect(h.master.gain.value).toBe(0.5);
    expect(h.mgr.state.masterVolume).toBe(0.5);
  });

  it('master 音量钳制到 0..1', () => {
    h.mgr.setMasterVolume(5);
    expect(h.mgr.state.masterVolume).toBe(1);
    h.mgr.setMasterVolume(-3);
    expect(h.mgr.state.masterVolume).toBe(0);
  });

  it('master × channel 在图上相乘合成', () => {
    h.mgr.setMasterVolume(0.5);
    h.mgr.setChannelVolume('music', 0.4);
    h.mgr.setChannelVolume('sfx', 0.25);
    expect(h.master.gain.value * h.musicGain.gain.value).toBeCloseTo(0.2);
    expect(h.master.gain.value * h.sfxGain.gain.value).toBeCloseTo(0.125);
  });

  it('master 静音把增益压到 0 但不破坏 volume 数值', () => {
    h.mgr.setMasterVolume(0.7);
    h.mgr.setMasterMuted(true);
    expect(h.master.gain.value).toBe(0);
    expect(h.mgr.state.masterVolume).toBe(0.7);
    expect(h.mgr.state.masterMuted).toBe(true);
  });

  it('取消 master 静音恢复原音量', () => {
    h.mgr.setMasterVolume(0.7);
    h.mgr.setMasterMuted(true);
    h.mgr.setMasterMuted(false);
    expect(h.master.gain.value).toBeCloseTo(0.7);
    expect(h.mgr.state.masterMuted).toBe(false);
  });

  it('master 与 channel 音量彼此独立', () => {
    h.mgr.setMasterVolume(0.2);
    h.mgr.setChannelVolume('music', 0.9);
    expect(h.mgr.state.masterVolume).toBe(0.2);
    expect(h.mgr.state.music.volume).toBe(0.9);
    h.mgr.setMasterMuted(true);
    expect(h.mgr.state.music.volume).toBe(0.9);
    expect(h.musicGain.gain.value).toBeCloseTo(0.9);
  });

  it('setChannelVolume(music) 只动音乐声道', () => {
    h.mgr.setChannelVolume('music', 0.3);
    expect(h.musicGain.gain.value).toBeCloseTo(0.3);
    expect(h.sfxGain.gain.value).toBe(1);
  });

  it('setChannelVolume(sfx) 只动音效声道', () => {
    h.mgr.setChannelVolume('sfx', 0.3);
    expect(h.sfxGain.gain.value).toBeCloseTo(0.3);
    expect(h.musicGain.gain.value).toBe(1);
  });

  it('声道静音不破坏该声道 volume 数值', () => {
    h.mgr.setChannelVolume('music', 0.6);
    h.mgr.setChannelMuted('music', true);
    expect(h.musicGain.gain.value).toBe(0);
    expect(h.mgr.state.music.volume).toBe(0.6);
    h.mgr.setChannelMuted('sfx', true);
    expect(h.mgr.state.sfx.muted).toBe(true);
    expect(h.mgr.state.sfx.volume).toBe(1);
  });

  it('声道音量钳制到 0..1', () => {
    h.mgr.setChannelVolume('music', 9);
    h.mgr.setChannelVolume('sfx', -1);
    expect(h.mgr.state.music.volume).toBe(1);
    expect(h.mgr.state.sfx.volume).toBe(0);
  });
});

describe('AudioManager — 曲库同步 (§9 Library sync)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    seed(h, [makeTrack('a'), makeTrack('b'), makeTrack('c')]);
    await h.mgr.unlock();
  });

  it('setTracks 后 getTrack 可取回，未知 id 得 undefined', () => {
    expect(h.mgr.getTrack('a')?.id).toBe('a');
    expect(h.mgr.getTrack('nope')).toBeUndefined();
  });

  it('setTracks 删掉当前曲 → 音乐停止', async () => {
    await h.mgr.playTrack('a');
    expect(h.mgr.state.music.trackId).toBe('a');
    h.lib.remove('a');
    h.mgr.setTracks(Array.from(h.lib.tracks.values()));
    expect(h.mgr.state.music.trackId).toBeNull();
    expect(h.mgr.state.music.status).toBe('idle');
  });

  it('setTracks 删掉队列里的非当前曲 → 队列收缩，当前曲存活', async () => {
    h.mgr.setPlaylists([playlist('p1', ['a', 'b', 'c'])]);
    await h.mgr.playPlaylist('p1');
    expect(h.mgr.state.music.trackId).toBe('a');
    h.lib.remove('c');
    h.mgr.setTracks(Array.from(h.lib.tracks.values()));
    expect(h.mgr.state.music.trackId).toBe('a');
    expect(h.mgr.state.music.status).toBe('playing');
  });

  it('playPlaylist 按列表顺序从首曲开始', async () => {
    h.mgr.setPlaylists([playlist('p1', ['b', 'c'])]);
    await h.mgr.playPlaylist('p1');
    expect(h.mgr.state.music.trackId).toBe('b');
    expect(h.mgr.state.music.playlistId).toBe('p1');
  });

  it('playPlaylist 支持 startIndex', async () => {
    h.mgr.setPlaylists([playlist('p1', ['a', 'b', 'c'])]);
    await h.mgr.playPlaylist('p1', 2);
    expect(h.mgr.state.music.trackId).toBe('c');
  });

  it('playPlaylist 未知列表不抛出且保持 idle', async () => {
    await expect(h.mgr.playPlaylist('missing')).resolves.toBeUndefined();
    expect(h.mgr.state.music.status).toBe('idle');
    expect(h.mgr.state.music.trackId).toBeNull();
  });

  it('播放列表里的悬挂 id 在播放前被滤掉', async () => {
    h.mgr.setPlaylists([playlist('p1', ['ghost', 'b'])]);
    await h.mgr.playPlaylist('p1');
    expect(h.mgr.state.music.trackId).toBe('b');
  });

  it('setTracks 删掉待兑现曲目 → 清空 pending', async () => {
    const h2 = setup();
    seed(h2, [makeTrack('a')]);
    await h2.mgr.playTrack('a');
    expect(h2.mgr.pendingTrackId).toBe('a');
    h2.lib.remove('a');
    h2.mgr.setTracks(Array.from(h2.lib.tracks.values()));
    expect(h2.mgr.pendingTrackId).toBeNull();
  });
});

describe('AudioManager — 加载竞态', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    seed(h, [makeTrack('a'), makeTrack('b')]);
    await h.mgr.unlock();
  });

  it('stop() 作废在飞的加载 —— 字节晚到也不会补出声', async () => {
    h.lib.deferLoads = true;
    const loading = h.mgr.playTrack('a');
    h.mgr.stop();
    h.lib.resolveLoad(0);
    await loading;

    expect(h.el.playCount).toBe(0);
    expect(h.mgr.state.music.status).toBe('idle');
    expect(h.mgr.state.music.trackId).toBeNull();
    expect(h.urls.live).toEqual([]);
  });

  it('pause() 作废在飞的加载 —— 不补出声，但曲目保留且 play() 可恢复', async () => {
    h.lib.deferLoads = true;
    const loading = h.mgr.playTrack('a');
    h.mgr.pause();
    h.lib.resolveLoad(0);
    await loading;

    expect(h.el.playCount).toBe(0);
    expect(h.mgr.state.music.status).toBe('paused');
    expect(h.mgr.state.music.trackId).toBe('a');

    h.lib.deferLoads = false;
    await h.mgr.play();
    expect(h.mgr.state.music.status).toBe('playing');
    expect(h.mgr.state.music.trackId).toBe('a');
    expect(h.urls.live).toHaveLength(1);
  });

  it('切歌期间旧请求晚到 —— 最终播放后发的曲目', async () => {
    h.lib.deferLoads = true;
    const first = h.mgr.playTrack('a');
    const second = h.mgr.playTrack('b');
    h.lib.resolveLoad(1);
    await second;
    h.lib.resolveLoad(0);
    await first;

    expect(h.mgr.state.music.trackId).toBe('b');
    expect(h.urls.live).toHaveLength(1);
  });
});

describe('AudioManager — AI 钩子 playByTag (§8 / §9 AI hook)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    seed(h, [
      makeTrack('calm', { tags: ['peace'] }),
      makeTrack('fight1', { tags: ['combat'] }),
      makeTrack('fight2', { tags: ['combat'] }),
      makeTrack('clang', { kind: 'sfx', tags: ['combat'] }),
    ]);
    await h.mgr.unlock();
  });

  it('命中唯一曲目 → 播放并返回 true', async () => {
    const ok = await h.mgr.playByTag('peace');
    expect(ok).toBe(true);
    expect(h.mgr.state.music.trackId).toBe('calm');
  });

  it('多命中用注入的 random 选择 (0 → 第一首)', async () => {
    const hh = setup({ random: () => 0 });
    seed(hh, [makeTrack('f1', { tags: ['combat'] }), makeTrack('f2', { tags: ['combat'] })]);
    await hh.mgr.unlock();
    await hh.mgr.playByTag('combat');
    expect(hh.mgr.state.music.trackId).toBe('f1');
  });

  it('多命中用注入的 random 选择 (0.99 → 最后一首)', async () => {
    const hh = setup({ random: () => 0.99 });
    seed(hh, [makeTrack('f1', { tags: ['combat'] }), makeTrack('f2', { tags: ['combat'] })]);
    await hh.mgr.unlock();
    await hh.mgr.playByTag('combat');
    expect(hh.mgr.state.music.trackId).toBe('f2');
  });

  it('只匹配 kind==="music"，音效曲目不入选', async () => {
    const hh = setup({ random: () => 0 });
    seed(hh, [makeTrack('boom', { kind: 'sfx', tags: ['combat'] }), makeTrack('f1', { tags: ['combat'] })]);
    await hh.mgr.unlock();
    const ok = await hh.mgr.playByTag('combat');
    expect(ok).toBe(true);
    expect(hh.mgr.state.music.trackId).toBe('f1');
  });

  it('未命中 + fallback 默认 keep → 当前曲继续播放，返回 false', async () => {
    await h.mgr.playTrack('calm');
    const ok = await h.mgr.playByTag('nowhere');
    expect(ok).toBe(false);
    expect(h.mgr.state.music.trackId).toBe('calm');
    expect(h.mgr.state.music.status).toBe('playing');
  });

  it('未命中 + fallback:"keep" 显式传入同样保持播放', async () => {
    await h.mgr.playTrack('calm');
    const ok = await h.mgr.playByTag('nowhere', { fallback: 'keep' });
    expect(ok).toBe(false);
    expect(h.mgr.state.music.status).toBe('playing');
  });

  it('未命中 + fallback:"stop" → 停止播放', async () => {
    await h.mgr.playTrack('calm');
    const ok = await h.mgr.playByTag('nowhere', { fallback: 'stop' });
    expect(ok).toBe(false);
    expect(h.mgr.state.music.status).toBe('idle');
  });

  it('曲库为空时不抛出', async () => {
    const hh = setup();
    await hh.mgr.unlock();
    await expect(hh.mgr.playByTag('combat')).resolves.toBe(false);
  });
});

describe('AudioManager — 解锁 (§7 / §9 Unlock)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
    seed(h, [makeTrack('a'), makeTrack('b')]);
  });

  it('初始处于锁定状态', () => {
    expect(h.mgr.unlocked).toBe(false);
    expect(h.mgr.state.unlocked).toBe(false);
  });

  it('锁定期 playTrack 不抛出且不真的播放，只记 pending', async () => {
    await expect(h.mgr.playTrack('a')).resolves.toBeUndefined();
    expect(h.mgr.pendingTrackId).toBe('a');
    expect(h.el.playCount).toBe(0);
    expect(h.mgr.state.music.trackId).toBeNull();
  });

  it('unlock() 调用 context.resume() 并置位', async () => {
    await h.mgr.unlock();
    expect(h.ctx.resumeCount).toBe(1);
    expect(h.mgr.unlocked).toBe(true);
    expect(h.mgr.state.unlocked).toBe(true);
  });

  it('unlock() 兑现暂存的曲目并清空 pending', async () => {
    await h.mgr.playTrack('a');
    await h.mgr.unlock();
    expect(h.mgr.state.music.trackId).toBe('a');
    expect(h.mgr.state.music.status).toBe('playing');
    expect(h.mgr.pendingTrackId).toBeNull();
  });

  it('unlock() 兑现暂存的播放列表', async () => {
    h.mgr.setPlaylists([playlist('p1', ['b', 'a'])]);
    await h.mgr.playPlaylist('p1');
    expect(h.el.playCount).toBe(0);
    await h.mgr.unlock();
    expect(h.mgr.state.music.trackId).toBe('b');
    expect(h.mgr.state.music.playlistId).toBe('p1');
  });

  it('无 pending 时 unlock() 不播放任何东西', async () => {
    await h.mgr.unlock();
    expect(h.el.playCount).toBe(0);
    expect(h.mgr.state.music.status).toBe('idle');
  });

  it('重复 unlock() 是空操作', async () => {
    await h.mgr.unlock();
    await h.mgr.unlock();
    expect(h.ctx.resumeCount).toBe(1);
  });

  it('resume() 失败时保持锁定且不抛出，下次手势可再试', async () => {
    h.ctx.resumeRejection = new Error('blocked');
    await h.mgr.playTrack('a');
    await expect(h.mgr.unlock()).resolves.toBeUndefined();
    expect(h.mgr.unlocked).toBe(false);
    expect(h.mgr.pendingTrackId).toBe('a');
    h.ctx.resumeRejection = null;
    await h.mgr.unlock();
    expect(h.mgr.unlocked).toBe(true);
    expect(h.mgr.state.music.trackId).toBe('a');
  });

  it('锁定期 playSfx 返回 false，不读取字节', async () => {
    seed(h, [makeTrack('sfx1', { kind: 'sfx' })]);
    expect(await h.mgr.playSfx('sfx1')).toBe(false);
    expect(h.lib.loadCalls).toHaveLength(0);
  });

  it('解锁后 playSfx 正常发声', async () => {
    seed(h, [makeTrack('sfx1', { kind: 'sfx' })]);
    await h.mgr.unlock();
    expect(await h.mgr.playSfx('sfx1')).toBe(true);
    expect(h.mgr.state.sfx.liveVoices).toBe(1);
  });

  it('stop() 清空未兑现的 pending', async () => {
    await h.mgr.playTrack('a');
    h.mgr.stop();
    expect(h.mgr.pendingTrackId).toBeNull();
  });
});

describe('AudioManager — 观察 (§6.3 / §9 Observation)', () => {
  let h: Harness;
  let seen: AudioPlaybackState[];

  beforeEach(async () => {
    h = setup();
    seed(h, [makeTrack('a'), makeTrack('b')]);
    seen = [];
    await h.mgr.unlock();
  });

  it('subscribe 在音量变更时触发', () => {
    h.mgr.subscribe((s) => seen.push(s));
    h.mgr.setMasterVolume(0.5);
    h.mgr.setChannelVolume('music', 0.4);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1].music.volume).toBe(0.4);
  });

  it('subscribe 在静音变更时触发', () => {
    h.mgr.subscribe((s) => seen.push(s));
    h.mgr.setMasterMuted(true);
    h.mgr.setChannelMuted('sfx', true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1].sfx.muted).toBe(true);
  });

  it('subscribe 在播放/换曲/暂停时触发', async () => {
    h.mgr.subscribe((s) => seen.push(s));
    await h.mgr.playTrack('a');
    const afterPlay = seen.length;
    expect(afterPlay).toBeGreaterThan(0);
    expect(seen[seen.length - 1].music.trackId).toBe('a');
    h.mgr.pause();
    expect(seen.length).toBeGreaterThan(afterPlay);
    expect(seen[seen.length - 1].music.status).toBe('paused');
  });

  it('subscribe 在解锁时触发', async () => {
    const hh = setup();
    const got: AudioPlaybackState[] = [];
    hh.mgr.subscribe((s) => got.push(s));
    await hh.mgr.unlock();
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got[got.length - 1].unlocked).toBe(true);
  });

  it('state 里**没有** position 字段', () => {
    const s = h.mgr.state;
    expect(Object.keys(s)).not.toContain('positionSec');
    expect(Object.keys(s)).not.toContain('position');
    expect(Object.keys(s.music)).not.toContain('positionSec');
    expect(Object.keys(s.music)).not.toContain('position');
  });

  it('positionSec 是按需采样的 getter —— 读它绝不触发广播', async () => {
    await h.mgr.playTrack('a');
    h.mgr.subscribe((s) => seen.push(s));
    for (let i = 1; i <= 20; i++) {
      h.el.currentTime = i;
      expect(h.mgr.positionSec).toBe(i);
    }
    expect(seen).toHaveLength(0);
  });

  it('seek 改变 positionSec 但不广播位置', () => {
    h.mgr.subscribe((s) => seen.push(s));
    h.mgr.seek(42);
    expect(h.mgr.positionSec).toBe(42);
    expect(seen).toHaveLength(0);
  });

  it('取消订阅后不再收到通知', () => {
    const off = h.mgr.subscribe((s) => seen.push(s));
    h.mgr.setMasterVolume(0.5);
    const n = seen.length;
    expect(n).toBeGreaterThan(0);
    off();
    h.mgr.setMasterVolume(0.2);
    expect(seen).toHaveLength(n);
  });

  it('多个订阅者各自独立收到同一快照', () => {
    const a: AudioPlaybackState[] = [];
    const b: AudioPlaybackState[] = [];
    h.mgr.subscribe((s) => a.push(s));
    const offB = h.mgr.subscribe((s) => b.push(s));
    h.mgr.setMasterVolume(0.5);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toBe(b[0]);
    offB();
    h.mgr.setMasterVolume(0.6);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });

  it('dispose 停止声道、回收 object URL、关闭 context', async () => {
    await h.mgr.playTrack('a');
    expect(h.urls.live.length).toBe(1);
    h.mgr.subscribe((s) => seen.push(s));
    h.mgr.dispose();
    expect(h.urls.live).toHaveLength(0);
    expect(h.ctx.closeCount).toBe(1);
    expect(h.master.disconnectCount).toBe(1);
    expect(h.el.listenerCount).toBe(0);
  });

  it('dispose 后不再广播，且传输操作变为空操作', async () => {
    h.mgr.subscribe((s) => seen.push(s));
    h.mgr.dispose();
    h.mgr.setMasterVolume(0.3);
    await h.mgr.playTrack('a');
    expect(seen).toHaveLength(0);
    expect(h.mgr.state.music.trackId).toBeNull();
  });

  it('重复 dispose 是空操作', () => {
    h.mgr.dispose();
    h.mgr.dispose();
    expect(h.ctx.closeCount).toBe(1);
  });
});
