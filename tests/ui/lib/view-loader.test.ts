/**
 * view-loader.ts — 顶层页面「载完再切换」+ 空闲预取
 *
 * 守三件事：
 * 1. `ensure()` 永不 reject，失败只记进 `failed()`，再调一次即重试 ——
 *    App.vue 的加载态靠这两条决定显示「载入中」还是「重试」。
 * 2. 在途去重：预取与用户点击撞在同一个页面上时，加载器只被调一次。
 * 3. 预取一次只载一个、每个都等空闲；取消后不再发起新的加载。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Component } from 'vue';
import { createViewRegistry, type IdleScheduler } from '../../../src/ui/lib/view-loader';

type View = 'home' | 'game' | 'settings';

// 注册表只按身份存取组件、从不渲染它们 —— 普通对象桩件就够了
const Home: Component = { name: 'HomeStub' };
const Game: Component = { name: 'GameStub' };
const Settings: Component = { name: 'SettingsStub' };

function loadersFor(overrides: Partial<Record<View, () => Promise<{ default: unknown }>>> = {}) {
  return {
    home: vi.fn(overrides.home ?? (() => Promise.resolve({ default: Home }))),
    game: vi.fn(overrides.game ?? (() => Promise.resolve({ default: Game }))),
    settings: vi.fn(overrides.settings ?? (() => Promise.resolve({ default: Settings }))),
  };
}

/** 手动推进的空闲调度：测试决定「浏览器什么时候空闲」 */
function manualScheduler() {
  const tasks: (() => void)[] = [];
  const scheduler: IdleScheduler = (task) => {
    tasks.push(task);
    return () => {
      const i = tasks.indexOf(task);
      if (i >= 0) tasks.splice(i, 1);
    };
  };
  return {
    scheduler,
    pending: () => tasks.length,
    /** 跑掉当前排着的一个空闲任务 */
    runNext: () => tasks.shift()?.(),
  };
}

/**
 * 等加载器的 Promise 链走完。链上有返回 Promise 的 then（每次吸收都多两拍微任务）
 * 再接 finally 与预取的 then，几拍不够 —— 给足 20 拍，不依赖具体拍数。
 */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ensure', () => {
  it('载好后 resolved() 交出组件，返回 true', async () => {
    const loaders = loadersFor();
    const views = createViewRegistry<View>(loaders as never);

    expect(views.resolved('home')).toBeUndefined();
    await expect(views.ensure('home')).resolves.toBe(true);
    expect(views.resolved('home')).toBe(Home);
    expect(views.failed('home')).toBe(false);
  });

  it('在途时重复调用共用同一次加载；载好之后不再调加载器', async () => {
    const loaders = loadersFor();
    const views = createViewRegistry<View>(loaders as never);

    const a = views.ensure('game');
    const b = views.ensure('game');
    expect(a).toBe(b);
    await a;
    await views.ensure('game');
    expect(loaders.game).toHaveBeenCalledTimes(1);
  });

  it('加载失败不 reject：记为 failed、返回 false；再调一次即重试并清掉失败记录', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempt = 0;
    const loaders = loadersFor({
      settings: () =>
        ++attempt === 1
          ? Promise.reject(new Error('dev server restarted'))
          : Promise.resolve({ default: Settings }),
    });
    const views = createViewRegistry<View>(loaders as never);

    await expect(views.ensure('settings')).resolves.toBe(false);
    expect(views.failed('settings')).toBe(true);
    expect(views.resolved('settings')).toBeUndefined();

    const retry = views.ensure('settings');
    // 重试一发起，失败标记就该撤掉 —— 否则加载态会在重试期间继续显示「重试」按钮
    expect(views.failed('settings')).toBe(false);
    await expect(retry).resolves.toBe(true);
    expect(views.resolved('settings')).toBe(Settings);
  });

  it('加载器同步抛错同样只记失败，不抛穿', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaders = loadersFor({
      home: () => {
        throw new Error('boom');
      },
    });
    const views = createViewRegistry<View>(loaders as never);
    await expect(views.ensure('home')).resolves.toBe(false);
    expect(views.failed('home')).toBe(true);
  });
});

describe('prefetch', () => {
  it('等启动延时过后，一次只载一个、每个都等空闲', async () => {
    vi.useFakeTimers();
    const loaders = loadersFor();
    const views = createViewRegistry<View>(loaders as never);
    const idle = manualScheduler();

    views.prefetch(['game', 'settings'], { startDelayMs: 2500, scheduler: idle.scheduler });

    // 启动延时内什么都不排
    vi.advanceTimersByTime(2499);
    expect(idle.pending()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(idle.pending()).toBe(1);
    expect(loaders.game).not.toHaveBeenCalled();

    idle.runNext();
    // 上一个载完才排下一个：game 载入期间 settings 不动，也没有新的空闲任务
    await flush();
    expect(loaders.game).toHaveBeenCalledTimes(1);
    expect(loaders.settings).not.toHaveBeenCalled();
    expect(views.resolved('game')).toBe(Game);
    expect(idle.pending()).toBe(1);

    idle.runNext();
    await flush();
    expect(views.resolved('settings')).toBe(Settings);
    expect(loaders.home).not.toHaveBeenCalled();
  });

  it('已经载好的页面跳过，不重复调加载器', async () => {
    vi.useFakeTimers();
    const loaders = loadersFor();
    const views = createViewRegistry<View>(loaders as never);
    await views.ensure('game');
    const idle = manualScheduler();

    views.prefetch(['game', 'settings'], { scheduler: idle.scheduler });
    vi.advanceTimersByTime(0);
    idle.runNext();
    await flush();
    idle.runNext();
    await flush();

    expect(loaders.game).toHaveBeenCalledTimes(1);
    expect(loaders.settings).toHaveBeenCalledTimes(1);
  });

  it('一个页面预取失败不中断后面的队列', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaders = loadersFor({ game: () => Promise.reject(new Error('offline')) });
    const views = createViewRegistry<View>(loaders as never);
    const idle = manualScheduler();

    views.prefetch(['game', 'settings'], { scheduler: idle.scheduler });
    vi.advanceTimersByTime(0);
    idle.runNext();
    await flush();
    expect(views.failed('game')).toBe(true);

    idle.runNext();
    await flush();
    expect(views.resolved('settings')).toBe(Settings);
  });

  it('取消后：启动延时内取消则一个都不载；中途取消则不再排下一个', async () => {
    vi.useFakeTimers();
    const loaders = loadersFor();
    const views = createViewRegistry<View>(loaders as never);

    const idleA = manualScheduler();
    const stopA = views.prefetch(['game'], { startDelayMs: 1000, scheduler: idleA.scheduler });
    stopA();
    vi.advanceTimersByTime(5000);
    expect(idleA.pending()).toBe(0);
    expect(loaders.game).not.toHaveBeenCalled();

    const idleB = manualScheduler();
    const stopB = views.prefetch(['game', 'settings'], { scheduler: idleB.scheduler });
    vi.advanceTimersByTime(0);
    idleB.runNext();
    stopB();
    await flush();
    // 已发出的那一个照常完成入表，但队列不再前进
    expect(views.resolved('game')).toBe(Game);
    expect(idleB.pending()).toBe(0);
    expect(loaders.settings).not.toHaveBeenCalled();
  });
});
