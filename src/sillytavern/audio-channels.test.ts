/**
 * audio-channels.test.ts — MusicChannel (序列器) + SfxChannel (声部池)
 *
 * 覆盖设计 §9 的 Sequencer queue / Advance / Fade / Voice pool / Guard 五组，
 * 外加 Sources / Mixing / Library sync / Observation。
 *
 * 全部 seam 注入 —— environment:'node' 下没有 AudioContext / Audio / URL.createObjectURL。
 */

import { describe, it, expect } from 'vitest';
import {
  MusicChannel,
  SfxChannel,
  type MusicChannelState,
  type SfxChannelState,
} from './audio-channels';
import {
  FakeAudioContext,
  FakeBufferSource,
  FakeGainNode,
  createFakeAudioElement,
  createFakeLibrary,
  createFakeObjectUrls,
  createFakeTimers,
  makeFakeBlob,
  makeTrack,
  asBlob,
} from './audio-fakes';

/** 让所有已 resolve 的 promise 链跑完 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

// ═══════════════════════════════════════════════════════════
// MusicChannel harness
// ═══════════════════════════════════════════════════════════

function musicSetup(opts: { fadeMs?: number; random?: () => number } = {}) {
  const ctx = new FakeAudioContext();
  const element = createFakeAudioElement();
  const lib = createFakeLibrary();
  const urls = createFakeObjectUrls();
  const timers = createFakeTimers();
  const changes: MusicChannelState[] = [];

  lib.add(makeTrack('a', { name: 'A' }));
  lib.add(makeTrack('b', { name: 'B' }));
  lib.add(makeTrack('c', { name: 'C' }));

  const channel = new MusicChannel({
    context: ctx,
    destination: ctx.destination,
    element,
    resolveTrack: lib.resolveTrack,
    loadBlob: lib.loadBlob,
    createObjectURL: urls.createObjectURL,
    revokeObjectURL: urls.revokeObjectURL,
    random: opts.random ?? (() => 0),
    fadeMs: opts.fadeMs ?? 0,
    scheduleTimeout: timers.schedule,
    onChange: (s) => { changes.push(s); },
  });

  const gain = ctx.gains[0] as FakeGainNode;
  return { ctx, element, lib, urls, timers, changes, channel, gain };
}

describe('MusicChannel — 音频图', () => {
  it('声道 gain 接入构造时传入的 destination', () => {
    const { ctx, gain } = musicSetup();
    expect(gain.connectedTo).toContain(ctx.destination);
  });

  it('元素经 MediaElementSource 接入声道 gain（音乐流式，不 decode）', () => {
    const { ctx, gain } = musicSetup();
    expect(ctx.mediaSources).toHaveLength(1);
    expect(ctx.mediaSources[0].connectedTo).toContain(gain);
    expect(ctx.decodeCalls).toHaveLength(0);
  });
});

describe('MusicChannel — Sequencer queue', () => {
  it('playTrack 建立长度为 1 的队列且 playlistId 置空', async () => {
    const { channel } = musicSetup();
    await channel.playTrack('a');
    expect(channel.currentQueue).toEqual(['a']);
    expect(channel.state.trackId).toBe('a');
    expect(channel.state.playlistId).toBeNull();
    expect(channel.state.status).toBe('playing');
  });

  it('playPlaylist 保持传入顺序', async () => {
    const { channel } = musicSetup();
    await channel.playPlaylist('pl-1', ['a', 'b', 'c']);
    expect(channel.currentQueue).toEqual(['a', 'b', 'c']);
    expect(channel.state.index).toBe(0);
    expect(channel.state.playlistId).toBe('pl-1');
  });

  it('playPlaylist 支持 startIndex', async () => {
    const { channel } = musicSetup();
    await channel.playPlaylist('pl-1', ['a', 'b', 'c'], 2);
    expect(channel.state.index).toBe(2);
    expect(channel.state.trackId).toBe('c');
  });

  it('空播放列表不抛异常，落到 idle', async () => {
    const { channel } = musicSetup();
    await expect(channel.playPlaylist('pl-empty', [])).resolves.toBeUndefined();
    expect(channel.state.status).toBe('idle');
    expect(channel.state.trackId).toBeNull();
  });

  it('shuffle 作用在副本上 —— 调用方的数组不被改动', async () => {
    const { channel } = musicSetup();
    channel.setShuffle(true);
    const caller = ['a', 'b', 'c'];
    await channel.playPlaylist('pl-1', caller);
    expect(caller).toEqual(['a', 'b', 'c']);
    expect(channel.currentQueue).not.toEqual(['a', 'b', 'c']);
  });

  it('currentQueue 返回副本，外部改动不影响内部', async () => {
    const { channel } = musicSetup();
    await channel.playPlaylist('pl-1', ['a', 'b', 'c']);
    channel.currentQueue.push('zzz');
    expect(channel.currentQueue).toHaveLength(3);
  });
});

describe('MusicChannel — Advance (ended 矩阵)', () => {
  it('repeat=off 队列中段 → 推进到下一曲', async () => {
    const { channel, element } = musicSetup();
    await channel.playPlaylist('pl', ['a', 'b', 'c']);
    element.fireEnded();
    await flush();
    expect(channel.state.index).toBe(1);
    expect(channel.state.trackId).toBe('b');
    expect(channel.state.status).toBe('playing');
  });

  it('repeat=off 队尾 → idle', async () => {
    const { channel, element } = musicSetup();
    await channel.playPlaylist('pl', ['a', 'b'], 1);
    element.fireEnded();
    await flush();
    expect(channel.state.status).toBe('idle');
    expect(channel.state.trackId).toBe('b');
  });

  it('repeat=one → 重放当前曲，不换 src', async () => {
    const { channel, element } = musicSetup();
    await channel.playPlaylist('pl', ['a', 'b']);
    channel.setRepeat('one');
    const srcCount = element.srcHistory.length;
    element.currentTime = 42;
    element.fireEnded();
    await flush();
    expect(channel.state.trackId).toBe('a');
    expect(channel.state.index).toBe(0);
    expect(element.currentTime).toBe(0);
    expect(element.srcHistory).toHaveLength(srcCount);
  });

  it('repeat=all + shuffle=off → 回绕到 index 0', async () => {
    const { channel, element } = musicSetup();
    await channel.playPlaylist('pl', ['a', 'b'], 1);
    channel.setRepeat('all');
    element.fireEnded();
    await flush();
    expect(channel.state.index).toBe(0);
    expect(channel.state.trackId).toBe('a');
    expect(channel.currentQueue).toEqual(['a', 'b']);
  });

  it('repeat=all + shuffle=on → 队尾重排后从头开始', async () => {
    const { channel, element } = musicSetup({ random: () => 0 });
    await channel.playPlaylist('pl', ['a', 'b', 'c'], 2);
    channel.setRepeat('all');
    channel.setShuffle(true);
    const before = channel.currentQueue;
    element.fireEnded();
    await flush();
    expect(channel.state.index).toBe(0);
    expect(channel.currentQueue).not.toEqual(before);
    expect(channel.currentQueue.slice().sort()).toEqual(['a', 'b', 'c']);
  });

  it('空队列上触发 ended 不抛异常', async () => {
    const { channel, element } = musicSetup();
    element.fireEnded();
    await flush();
    expect(channel.state.status).toBe('idle');
  });

  it('next() 在队尾回绕到 0', async () => {
    const { channel } = musicSetup();
    await channel.playPlaylist('pl', ['a', 'b', 'c'], 2);
    await channel.next();
    expect(channel.state.index).toBe(0);
    expect(channel.state.trackId).toBe('a');
  });

  it('prev() 在队首停留并重放当前曲', async () => {
    const { channel } = musicSetup();
    await channel.playPlaylist('pl', ['a', 'b', 'c']);
    await channel.prev();
    expect(channel.state.index).toBe(0);
    expect(channel.state.trackId).toBe('a');
  });

  it('pause / toggle / stop 的状态流转', async () => {
    const { channel, element } = musicSetup();
    await channel.playTrack('a');
    channel.pause();
    expect(channel.state.status).toBe('paused');
    await channel.toggle();
    expect(channel.state.status).toBe('playing');
    channel.stop();
    expect(channel.state.status).toBe('idle');
    expect(element.currentTime).toBe(0);
  });

  it('seek 写入元素时间并钳制负值', async () => {
    const { channel, element } = musicSetup();
    await channel.playTrack('a');
    channel.seek(12.5);
    expect(element.currentTime).toBe(12.5);
    channel.seek(-3);
    expect(element.currentTime).toBe(0);
  });
});

describe('MusicChannel — Fade', () => {
  it('fadeMs=0 完全同步 —— 不排任何定时器，也不排 ramp', async () => {
    const { channel, timers, gain } = musicSetup({ fadeMs: 0 });
    await channel.playTrack('a');
    expect(timers.delays).toHaveLength(0);
    expect(gain.gain.ops.filter((o) => o.type === 'ramp')).toHaveLength(0);
    expect(gain.gain.value).toBe(1);
  });

  it('fadeMs>0 先把 gain ramp 到 0，src 交换发生在延迟之后，再 ramp 回来', async () => {
    const { channel, timers, gain, element } = musicSetup({ fadeMs: 300 });
    const p = channel.playTrack('a');
    // 淡出已排定，src 尚未交换
    expect(timers.delays).toEqual([300]);
    expect(gain.gain.valueOps.map((o) => o.value)).toEqual([1, 0]);
    expect(element.srcHistory).toHaveLength(0);

    timers.flush();
    await p;

    expect(element.srcHistory).toHaveLength(1);
    const ramps = gain.gain.ops.filter((o) => o.type === 'ramp');
    expect(ramps.map((r) => r.value)).toEqual([0, 1]);
    expect(gain.gain.value).toBe(1);
  });

  it('fade 结束后恢复到当前音量而非固定 1', async () => {
    const { channel, timers, gain } = musicSetup({ fadeMs: 300 });
    channel.setVolume(0.4);
    const p = channel.playTrack('a');
    timers.flush();
    await p;
    expect(gain.gain.value).toBeCloseTo(0.4);
  });
});

describe('MusicChannel — Sources', () => {
  it('blob 曲目通过注入的 createObjectURL 生成 src', async () => {
    const { channel, urls, element } = musicSetup();
    await channel.playTrack('a');
    expect(urls.created).toHaveLength(1);
    expect(element.src).toBe(urls.created[0]);
  });

  it('换曲时回收上一个 objectURL（泄漏防线）', async () => {
    const { channel, urls } = musicSetup();
    await channel.playTrack('a');
    const first = urls.created[0];
    await channel.playTrack('b');
    expect(urls.revoked).toContain(first);
    expect(urls.live).toHaveLength(1);
  });

  it('builtin 曲目直接用 track.url，不创建 objectURL', async () => {
    const { channel, lib, urls, element } = musicSetup();
    lib.add(makeTrack('bi', { source: 'builtin', url: '/audio/theme.mp3' }));
    await channel.playTrack('bi');
    expect(element.src).toBe('/audio/theme.mp3');
    expect(urls.created).toHaveLength(0);
  });

  it('曲目元数据缺失 → idle，不抛异常', async () => {
    const { channel } = musicSetup();
    await channel.playTrack('missing');
    expect(channel.state.status).toBe('idle');
    expect(channel.state.trackId).toBeNull();
  });

  it('字节读不到 → idle，不抛异常', async () => {
    const { channel, lib } = musicSetup();
    lib.breakBlob('a');
    await channel.playTrack('a');
    expect(channel.state.status).toBe('idle');
  });

  it('element.play() 被拦截 → 落到 paused 而非抛出', async () => {
    const { channel, element } = musicSetup();
    element.playRejection = new Error('NotAllowedError');
    await expect(channel.playTrack('a')).resolves.toBeUndefined();
    expect(channel.state.status).toBe('paused');
  });

  it('dispose 回收 objectURL 并摘掉 ended 监听', async () => {
    const { channel, urls, element } = musicSetup();
    await channel.playTrack('a');
    expect(element.listenerCount).toBe(1);
    channel.dispose();
    expect(urls.live).toHaveLength(0);
    expect(element.listenerCount).toBe(0);
  });
});

describe('MusicChannel — Mixing & Observation', () => {
  it('setVolume 钳制到 0..1', () => {
    const { channel } = musicSetup();
    channel.setVolume(5);
    expect(channel.volume).toBe(1);
    channel.setVolume(-2);
    expect(channel.volume).toBe(0);
    channel.setVolume(0.35);
    expect(channel.volume).toBeCloseTo(0.35);
  });

  it('静音不破坏 volume 数值', () => {
    const { channel, gain } = musicSetup();
    channel.setVolume(0.6);
    channel.setMuted(true);
    expect(channel.volume).toBeCloseTo(0.6);
    expect(gain.gain.value).toBe(0);
    channel.setMuted(false);
    expect(gain.gain.value).toBeCloseTo(0.6);
  });

  it('onChange 只广播离散状态，永不包含 position', async () => {
    const { channel, changes } = musicSetup();
    await channel.playTrack('a');
    expect(changes.length).toBeGreaterThan(0);
    for (const s of changes) {
      expect(Object.keys(s)).not.toContain('positionSec');
      expect(Object.keys(s)).not.toContain('position');
    }
  });

  it('读取 positionSec 不触发 onChange', async () => {
    const { channel, changes, element } = musicSetup();
    await channel.playTrack('a');
    const n = changes.length;
    element.currentTime = 7.5;
    expect(channel.positionSec).toBe(7.5);
    expect(changes).toHaveLength(n);
  });

  it('durationSec 在元素 duration 为 NaN 时回落到曲目元数据', async () => {
    const { channel, lib } = musicSetup();
    lib.add(makeTrack('d', { duration: 123 }));
    await channel.playTrack('d');
    expect(channel.durationSec).toBe(123);
  });
});

describe('MusicChannel — Library sync', () => {
  it('pruneTracks 剔除当前曲 → 停止', async () => {
    const { channel } = musicSetup();
    await channel.playPlaylist('pl', ['a', 'b', 'c']);
    channel.pruneTracks(new Set(['b', 'c']));
    expect(channel.state.status).toBe('idle');
    expect(channel.state.trackId).toBeNull();
    expect(channel.currentQueue).toEqual(['b', 'c']);
  });

  it('pruneTracks 剔除非当前曲 → 队列收缩，当前曲保持', async () => {
    const { channel } = musicSetup();
    await channel.playPlaylist('pl', ['a', 'b', 'c']);
    channel.pruneTracks(new Set(['a', 'c']));
    expect(channel.currentQueue).toEqual(['a', 'c']);
    expect(channel.state.trackId).toBe('a');
    expect(channel.state.status).toBe('playing');
  });

  it('pruneTracks 无变化时不广播', async () => {
    const { channel, changes } = musicSetup();
    await channel.playPlaylist('pl', ['a', 'b']);
    const n = changes.length;
    channel.pruneTracks(new Set(['a', 'b', 'c']));
    expect(changes).toHaveLength(n);
  });
});

// ═══════════════════════════════════════════════════════════
// SfxChannel harness
// ═══════════════════════════════════════════════════════════

function sfxSetup(opts: {
  maxVoices?: number;
  maxConcurrentDecodes?: number;
  maxDurationSec?: number;
  maxBytes?: number;
  deferDecodes?: boolean;
  decodedDuration?: number;
} = {}) {
  const ctx = new FakeAudioContext({
    deferDecodes: opts.deferDecodes,
    decodedDuration: opts.decodedDuration,
  });
  const lib = createFakeLibrary();
  const changes: SfxChannelState[] = [];
  lib.add(makeTrack('hit', { kind: 'sfx' }), 2048);
  lib.add(makeTrack('slash', { kind: 'sfx' }), 2048);

  const channel = new SfxChannel({
    context: ctx,
    destination: ctx.destination,
    resolveTrack: lib.resolveTrack,
    loadBlob: lib.loadBlob,
    maxVoices: opts.maxVoices,
    maxConcurrentDecodes: opts.maxConcurrentDecodes,
    maxDurationSec: opts.maxDurationSec,
    maxBytes: opts.maxBytes,
    onChange: (s) => { changes.push(s); },
  });

  const gain = ctx.gains[0] as FakeGainNode;
  return { ctx, lib, changes, channel, gain };
}

describe('SfxChannel — Voice pool', () => {
  it('一发音效: 读字节 → decode → buffer source → start', async () => {
    const { channel, ctx, gain } = sfxSetup();
    await expect(channel.play('hit')).resolves.toBe(true);
    expect(ctx.decodeCalls).toHaveLength(1);
    expect(ctx.bufferSources).toHaveLength(1);
    expect(ctx.bufferSources[0].started).toBe(true);
    expect(ctx.bufferSources[0].connectedTo).toContain(gain);
    expect(channel.liveVoices).toBe(1);
  });

  it('每一发都重新读一次 ArrayBuffer（decodeAudioData 会 detach 入参）', async () => {
    const { channel, lib } = sfxSetup();
    await channel.play('hit');
    await channel.play('hit');
    expect(lib.blobs.get('hit')!.arrayBufferCalls).toBe(2);
  });

  it('不做 decode 缓存 —— 同一曲目两发触发两次 decode', async () => {
    const { channel, ctx } = sfxSetup();
    await channel.play('hit');
    await channel.play('hit');
    expect(ctx.decodeCalls).toHaveLength(2);
  });

  it('8 发并存正常', async () => {
    const { channel } = sfxSetup();
    for (let i = 0; i < 8; i++) await channel.play('hit');
    expect(channel.liveVoices).toBe(8);
  });

  it('第 9 发掐掉运行最久的那一发', async () => {
    const { channel, ctx } = sfxSetup();
    for (let i = 0; i < 8; i++) {
      await channel.play('hit');
      ctx.advance(1);
    }
    const oldest = ctx.bufferSources[0] as FakeBufferSource;
    await channel.play('slash');
    expect(oldest.stopped).toBe(true);
    expect(channel.liveVoices).toBe(8);
    expect(ctx.bufferSources).toHaveLength(9);
  });

  it('声部自然播完后从池中退役', async () => {
    const { channel, ctx } = sfxSetup();
    await channel.play('hit');
    expect(channel.liveVoices).toBe(1);
    (ctx.bufferSources[0] as FakeBufferSource).fireEnded();
    expect(channel.liveVoices).toBe(0);
  });

  it('stopAll 停掉全部声部', async () => {
    const { channel, ctx } = sfxSetup();
    for (let i = 0; i < 3; i++) await channel.play('hit');
    channel.stopAll();
    expect(channel.liveVoices).toBe(0);
    for (const s of ctx.bufferSources) expect((s as FakeBufferSource).stopped).toBe(true);
  });

  it('decode 乱序完成时两发都能起声', async () => {
    const { channel, ctx } = sfxSetup({ deferDecodes: true });
    const p1 = channel.play('hit');
    const p2 = channel.play('slash');
    await flush();
    expect(ctx.pendingDecodes).toHaveLength(2);
    // 后发先至
    ctx.resolveDecode(1);
    await flush();
    ctx.resolveDecode(0);
    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(true);
    expect(channel.liveVoices).toBe(2);
  });

  it('掐最久看的是实际 start 时刻，而非调用顺序', async () => {
    const { channel, ctx } = sfxSetup({ deferDecodes: true, maxVoices: 1 });
    const p1 = channel.play('hit');
    const p2 = channel.play('slash');
    await flush();
    // 第二次调用先完成 decode → 它才是"先起声"的那个
    ctx.resolveDecode(1);
    await p2;
    const firstStarted = ctx.bufferSources[0] as FakeBufferSource;
    ctx.advance(5);
    ctx.resolveDecode(0);
    await p1;
    expect(firstStarted.stopped).toBe(true);
    expect(channel.liveVoices).toBe(1);
  });

  it('在途 decode 达上限时直接拒绝（不排队）', async () => {
    const { channel, ctx } = sfxSetup({ deferDecodes: true, maxConcurrentDecodes: 2 });
    const p1 = channel.play('hit');
    const p2 = channel.play('hit');
    await expect(channel.play('hit')).resolves.toBe(false);
    expect(channel.pendingDecodes).toBe(2);
    await flush();
    expect(ctx.decodeCalls).toHaveLength(2);
    ctx.resolveDecode(0);
    ctx.resolveDecode(1);
    await Promise.all([p1, p2]);
    // 拥塞解除后可再发
    ctx.deferDecodes = false;
    await expect(channel.play('hit')).resolves.toBe(true);
  });

  it('decode 失败返回 false 且释放在途名额', async () => {
    const { channel, ctx } = sfxSetup({ deferDecodes: true });
    const p = channel.play('hit');
    await flush();
    ctx.rejectDecode(0);
    await expect(p).resolves.toBe(false);
    expect(channel.pendingDecodes).toBe(0);
    expect(channel.liveVoices).toBe(0);
  });
});

describe('SfxChannel — Guard', () => {
  it('元数据体积超限 → 拒绝，连字节都不读', async () => {
    const { channel, ctx, lib } = sfxSetup({ maxBytes: 1024 });
    lib.add(makeTrack('huge', { kind: 'sfx', size: 9_000_000 }));
    await expect(channel.play('huge')).resolves.toBe(false);
    expect(lib.loadCalls).toHaveLength(0);
    expect(ctx.decodeCalls).toHaveLength(0);
  });

  it('元数据时长超限 → 拒绝，不 decode', async () => {
    const { channel, ctx, lib } = sfxSetup({ maxDurationSec: 30 });
    lib.add(makeTrack('long', { kind: 'sfx', duration: 240 }));
    await expect(channel.play('long')).resolves.toBe(false);
    expect(ctx.decodeCalls).toHaveLength(0);
  });

  it('kind 写错也被体积护栏拦下（护栏独立于 kind）', async () => {
    const { channel, ctx, lib } = sfxSetup({ maxBytes: 5 * 1024 * 1024 });
    // kind 标成 music，元数据 size 缺失 —— 只有真实字节体积能救
    lib.add(makeTrack('mislabeled', { kind: 'music' }), 8 * 1024 * 1024);
    await expect(channel.play('mislabeled')).resolves.toBe(false);
    expect(lib.loadCalls).toEqual(['mislabeled']);
    expect(ctx.decodeCalls).toHaveLength(0);
    expect(channel.liveVoices).toBe(0);
  });

  it('decode 后才暴露的超长音频被拦下，不起声', async () => {
    const { channel, ctx } = sfxSetup({ maxDurationSec: 5, decodedDuration: 90 });
    await expect(channel.play('hit')).resolves.toBe(false);
    expect(ctx.decodeCalls).toHaveLength(1);
    expect(channel.liveVoices).toBe(0);
  });

  it('曲目不存在 → false', async () => {
    const { channel, lib } = sfxSetup();
    await expect(channel.play('nope')).resolves.toBe(false);
    expect(lib.loadCalls).toHaveLength(0);
  });

  it('字节缺失 → false', async () => {
    const { channel, lib, ctx } = sfxSetup();
    lib.breakBlob('hit');
    await expect(channel.play('hit')).resolves.toBe(false);
    expect(ctx.decodeCalls).toHaveLength(0);
  });
});

describe('SfxChannel — Mixing', () => {
  it('声道 gain 接入构造时传入的 destination', () => {
    const { ctx, gain } = sfxSetup();
    expect(gain.connectedTo).toContain(ctx.destination);
  });

  it('setVolume 钳制到 0..1', () => {
    const { channel } = sfxSetup();
    channel.setVolume(3);
    expect(channel.volume).toBe(1);
    channel.setVolume(-1);
    expect(channel.volume).toBe(0);
  });

  it('静音不破坏 volume 数值', () => {
    const { channel, gain } = sfxSetup();
    channel.setVolume(0.7);
    channel.setMuted(true);
    expect(channel.volume).toBeCloseTo(0.7);
    expect(gain.gain.value).toBe(0);
    channel.setMuted(false);
    expect(gain.gain.value).toBeCloseTo(0.7);
  });

  it('声部数变化会广播 onChange', async () => {
    const { channel, changes, ctx } = sfxSetup();
    await channel.play('hit');
    expect(changes[changes.length - 1].liveVoices).toBe(1);
    (ctx.bufferSources[0] as FakeBufferSource).fireEnded();
    expect(changes[changes.length - 1].liveVoices).toBe(0);
  });

  it('dispose 后拒绝新的播放请求', async () => {
    const { channel } = sfxSetup();
    channel.dispose();
    await expect(channel.play('hit')).resolves.toBe(false);
  });
});

describe('测试替身自检', () => {
  it('FakeBlob 每次返回全新 ArrayBuffer（模拟 detach 语义）', async () => {
    const b = makeFakeBlob(64);
    const first = await b.arrayBuffer();
    const second = await b.arrayBuffer();
    expect(first).not.toBe(second);
    expect(b.arrayBufferCalls).toBe(2);
    expect(asBlob(b).size).toBe(64);
  });

  it('createFakeObjectUrls 的 live 反映未回收的 URL', () => {
    const urls = createFakeObjectUrls();
    const u1 = urls.createObjectURL(asBlob(makeFakeBlob()));
    urls.createObjectURL(asBlob(makeFakeBlob()));
    urls.revokeObjectURL(u1);
    expect(urls.live).toHaveLength(1);
  });

  it('createFakeTimers 记录延迟并可手动 flush', () => {
    const t = createFakeTimers();
    let fired = false;
    t.schedule(() => { fired = true; }, 300);
    expect(t.delays).toEqual([300]);
    expect(fired).toBe(false);
    t.flush();
    expect(fired).toBe(true);
  });
});
