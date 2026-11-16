/**
 * view-loader.ts — 顶层页面「载完再切换」+ 空闲预取（动效 v1，2026-11-16）
 *
 * 为什么不用 `defineAsyncComponent`：它的包装组件在模块到手之前渲染一个空注释节点，
 * 而 App.vue 的 `<transition mode="out-in">` 只认得包装组件这一层 —— 于是首次进入
 * 每个页面都是「旧页淡出 → 一段纯黑 → 新页没有入场动画地蹦出来」。开发服务器按需编译
 * （玩家也用 `npm run dev` 启动），这段纯黑在设置页 / 捏人页实测有 1–3 秒。
 *
 * 这里改成由调用方显式持有「哪个页面已经载好」：没载好时渲染加载态，载好后换成
 * 真组件 —— 两者的切换是 Transition 看得见的一次子节点变化，入场动画因此每次都在。
 * 再配一条空闲预取，让大多数导航在用户点下去之前就已经载完。
 *
 * 契约：
 * - `ensure()` **永不 reject**：失败只记进 `failure()`，返回 false；再次调用即重试
 *   （它清掉失败记录、重新发起加载）。
 * - 同一页面在途时重复 `ensure()` 共用同一个 Promise，加载器只被调一次。
 * - `prefetch()` 一次只载一个页面、每个都等浏览器空闲；返回的函数取消剩余队列
 *   （已经发出去的那一个照常完成，结果照常入表）。
 */
import { markRaw, shallowReactive, type Component } from 'vue';

interface ViewModule {
  default: Component;
}

export type ViewLoaderMap<V extends string> = Record<V, () => Promise<ViewModule>>;

/** 把一个任务排到「浏览器空闲时」；返回取消函数 */
export type IdleScheduler = (task: () => void) => () => void;

/**
 * 缺省空闲调度：有 `requestIdleCallback` 用它（带超时兜底，后台标签页也不会永远等下去），
 * 没有（Safari）就退化成短延时。
 */
const defaultIdleScheduler: IdleScheduler = (task) => {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(() => task(), { timeout: 4000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(task, 200);
  return () => clearTimeout(id);
};

interface PrefetchOptions {
  /** 第一个预取开始前的延时（毫秒）。首页开场动画期间不该跟它抢主线程 */
  startDelayMs?: number;
  scheduler?: IdleScheduler;
}

export interface ViewRegistry<V extends string> {
  /** 已载好的页面组件；还没载好（或载失败）返回 undefined */
  resolved(view: V): Component | undefined;
  /** 该页面最近一次加载是否失败（重新 `ensure()` 时清除） */
  failed(view: V): boolean;
  /** 确保页面已载入；成功 true、失败 false，永不 reject */
  ensure(view: V): Promise<boolean>;
  /** 空闲时按顺序预取；返回取消函数 */
  prefetch(order: readonly V[], options?: PrefetchOptions): () => void;
}

export function createViewRegistry<V extends string>(loaders: ViewLoaderMap<V>): ViewRegistry<V> {
  // 组件对象本身不需要响应式，只有「哪几个已经到手」需要被模板追踪
  const components = shallowReactive(new Map<V, Component>());
  const failures = shallowReactive(new Set<V>());
  const inflight = new Map<V, Promise<boolean>>();

  function ensure(view: V): Promise<boolean> {
    if (components.has(view)) return Promise.resolve(true);
    const pending = inflight.get(view);
    if (pending) return pending;

    failures.delete(view);
    const attempt = Promise.resolve()
      .then(() => loaders[view]())
      .then(
        (mod) => {
          components.set(view, markRaw(mod.default));
          return true;
        },
        (err: unknown) => {
          failures.add(view);
          console.warn(`[view-loader] 页面 ${view} 加载失败`, err);
          return false;
        },
      )
      .finally(() => {
        inflight.delete(view);
      });
    inflight.set(view, attempt);
    return attempt;
  }

  function prefetch(order: readonly V[], options: PrefetchOptions = {}): () => void {
    const schedule = options.scheduler ?? defaultIdleScheduler;
    const queue = [...order];
    let cancelled = false;
    let cancelPending: (() => void) | null = null;

    const step = () => {
      cancelPending = null;
      if (cancelled) return;
      const next = queue.shift();
      if (next === undefined) return;
      void ensure(next).then(() => {
        if (!cancelled) cancelPending = schedule(step);
      });
    };

    const startTimer = setTimeout(() => {
      if (!cancelled) cancelPending = schedule(step);
    }, options.startDelayMs ?? 0);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      cancelPending?.();
      cancelPending = null;
    };
  }

  return {
    resolved: (view) => components.get(view),
    failed: (view) => failures.has(view),
    ensure,
    prefetch,
  };
}
