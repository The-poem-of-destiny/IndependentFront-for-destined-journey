/**
 * plugin-save-lock.ts — 按存档命名的跨标签页 Web Lock（设计 §6.5）
 *
 * 写队列是每个页面一份的内存结构，两个标签页开同一存档时互不知情。插件侧自带一道:
 *
 * - 进入启用了插件的存档时，用 `navigator.locks` 申请一把按存档命名的锁。
 * - 拿到 → `held`，插件写入可用。
 * - 拿不到 → `waiting`：本标签页的插件写入全部禁用，界面显示横幅；同时挂一个排队申请
 *   （`ifAvailable: false`），持有方关闭或离开存档后自动拿到锁，状态回到 `held`。
 *   横幅上的「重试」调 {@link PluginSaveLockHandle.retry}，立即再试一次。
 * - 没有 `navigator.locks`（非安全上下文，例如经局域网 IP 用 HTTP 访问）→ `unsupported`，
 *   插件写入一律禁用。
 * - 调用方离开存档时 `release()` → `released`，同时撤掉排队申请。
 *
 * 状态变化经 `onChange` 回调通知，调用方把它接到 Vue ref 上即可。
 * `locks` 可注入，测试用假的 LockManager；永不抛。
 */

/** 锁句柄状态；只有 `held` 时插件写入可用 */
export type PluginSaveLockState = 'held' | 'waiting' | 'unsupported' | 'released';

/** `navigator.locks` 的窄接口 —— 只用 `request(name, options, callback)` 这一种重载 */
export interface PluginLockManager {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

export interface PluginSaveLockOptions {
  /** 注入的 LockManager；不传时取 `navigator.locks`，传 `null` 视为不支持 */
  locks?: PluginLockManager | null;
  /** 状态每次变化时调用（不含首次确定状态之前） */
  onChange?: (state: PluginSaveLockState) => void;
}

export interface PluginSaveLockHandle {
  /** 当前状态 */
  readonly state: PluginSaveLockState;
  /** 立即再试一次；返回再试之后的状态 */
  retry(): Promise<PluginSaveLockState>;
  /** 释放锁并撤掉排队申请；之后状态恒为 `released` */
  release(): void;
}

/** 锁名前缀；与 discord-auth-client 的 `poem-` 前缀同一口径 */
const LOCK_PREFIX = 'poem-plugin-save:';

/** 由存档 id 派生锁名 */
export function pluginSaveLockName(saveId: string): string {
  return `${LOCK_PREFIX}${saveId}`;
}

function resolveLocks(injected: PluginLockManager | null | undefined): PluginLockManager | null {
  if (injected !== undefined) return injected;
  const scope = globalThis as {
    isSecureContext?: boolean;
    navigator?: { locks?: PluginLockManager };
  };
  if (scope.isSecureContext === false) return null;
  const locks = scope.navigator?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * 申请某个存档的插件写入锁。立即尝试一次（`ifAvailable`），拿不到就排队等待。
 */
export async function acquirePluginSaveLock(
  saveId: string,
  options: PluginSaveLockOptions = {},
): Promise<PluginSaveLockHandle> {
  const locks = resolveLocks(options.locks);
  const name = pluginSaveLockName(saveId);
  let state: PluginSaveLockState = 'unsupported';
  let settled = false;
  let released = false;
  let releaseHeld: (() => void) | null = null;
  let waiter: AbortController | null = null;

  const setState = (next: PluginSaveLockState): void => {
    if (state === next) return;
    state = next;
    if (settled) options.onChange?.(next);
  };

  /** 拿到锁：返回一个直到 release 才兑现的 Promise，让浏览器一直持有锁 */
  const hold = (): Promise<void> =>
    new Promise<void>((resolve) => {
      releaseHeld = resolve;
      setState('held');
      // 已经拿到锁，排队申请没用了
      waiter?.abort();
      waiter = null;
    });

  /** 立即尝试一次；返回是否拿到了锁。请求本身失败时抛给调用方判 unsupported */
  const tryNow = (manager: PluginLockManager): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      let answered = false;
      manager
        .request(name, { ifAvailable: true }, (lock) => {
          answered = true;
          if (!lock || released) {
            resolve(false);
            return undefined;
          }
          resolve(true);
          return hold();
        })
        .catch((e: unknown) => {
          if (!answered) reject(e);
        });
    });

  /** 挂排队申请：持有方释放后自动拿到 */
  const queueWaiter = (manager: PluginLockManager): void => {
    if (waiter || released || state === 'held') return;
    const controller = new AbortController();
    waiter = controller;
    manager
      .request(name, { signal: controller.signal }, (lock) => {
        if (!lock || released || controller.signal.aborted) return undefined;
        waiter = null;
        return hold();
      })
      .catch(() => {
        // 被撤掉（AbortError）或浏览器拒绝：保持当前状态，横幅上的「重试」仍可用
        if (waiter === controller) waiter = null;
      });
  };

  if (locks) {
    try {
      const got = await tryNow(locks);
      if (!got && !released) {
        state = 'waiting';
        queueWaiter(locks);
      }
    } catch {
      state = 'unsupported';
    }
  }
  settled = true;

  return {
    get state() {
      return state;
    },
    async retry() {
      if (!locks || released || state === 'held' || state === 'unsupported') return state;
      try {
        const got = await tryNow(locks);
        if (!got) queueWaiter(locks);
      } catch {
        // 再试失败不改变状态，排队申请（若还在）继续等
      }
      return state;
    },
    release() {
      if (released) return;
      released = true;
      waiter?.abort();
      waiter = null;
      const done = releaseHeld;
      releaseHeld = null;
      done?.();
      setState('released');
    },
  };
}
