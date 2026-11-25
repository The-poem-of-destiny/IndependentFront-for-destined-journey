/**
 * 存档单标签页锁（2026-11-20）。
 *
 * 写锁（`state-write-queue.ts`）只在**本标签页**内存里排队；便携版重复启动会再开一个标签页
 * （`server/standalone.ts`），两个标签页同时写同一存档时互不知情 —— 记忆 id 按 max+1 分配
 * 会撞号，快照与消息交错覆盖。这里用 Web Locks API 给每个存档挂一把跨标签页的独占锁：
 * 游戏页进入存档时以 `ifAvailable` 申请，拿不到就不进；持有到离开游戏页（卸载）为止，
 * 关闭 / 刷新标签页时浏览器自动释放。
 *
 * - 同一标签页内对同一存档的重复申请**共用**一把锁（引用计数）：游戏页因换 key 重挂时，
 *   新实例可能在旧实例释放前申请，不能被自己挡在门外。
 * - `navigator.locks` 不存在（旧浏览器 / jsdom 单测）或申请本身出错时**放行**：
 *   这道锁是防误操作的护栏，不是数据正确性的唯一保证，不能因为环境缺能力把玩家关在门外。
 *
 * 2026-11-25（审查报告 R8）：删档与整库导入也要看这把锁 —— 否则另一个标签页正在玩时，
 * 这边仍能把那个档删掉或整库覆盖。它们只**试探**（`navigator.locks.query()` 读快照，
 * 不申请、不持锁），并把本标签页自己持有的锁排除在外：本标签页在玩 A 档时删 A 档 /
 * 整库导入，沿用原来的行为（删完回首页），不被自己挡住。
 */

/** 锁名前缀；与其他 Web Lock（如 `poem-discord-auth-request`）区分开 */
const LOCK_PREFIX = 'poem-save:';

/** 拿不到锁时给玩家看的提示 */
export const SAVE_TAB_LOCKED_MESSAGE =
  '此存档已在另一个标签页中打开。请先关闭那个标签页，或在那边返回首页后再试。';

/** 删档时该档被别的标签页占着 */
export const SAVE_DELETE_LOCKED_MESSAGE =
  '此存档正在另一个标签页中游玩，不能删除。请先关闭那个标签页，或在那边返回首页后再试。';

/** 整库导入时有存档被别的标签页占着 */
export const FULL_IMPORT_LOCKED_MESSAGE =
  '有存档正在另一个标签页中游玩，整库导入会覆盖它。请先关闭那个标签页，或在那边返回首页后再试。';

/** 已取得的锁；`release()` 幂等 */
export interface SaveTabLockHandle {
  release(): void;
}

type LockRequester = Pick<LockManager, 'request'>;
type LockInspector = Partial<Pick<LockManager, 'query'>>;

interface HeldEntry {
  refs: number;
  /** true = 本标签页持有（或环境不支持而放行）；false = 被别的标签页占着 */
  ready: Promise<boolean>;
  releaseLock: (() => void) | null;
}

const held = new Map<string, HeldEntry>();

function defaultLocks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

function openEntry(saveId: string, locks: LockRequester): HeldEntry {
  const entry: HeldEntry = { refs: 0, ready: Promise.resolve(true), releaseLock: null };
  entry.ready = new Promise<boolean>((resolve) => {
    locks
      .request(LOCK_PREFIX + saveId, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        // 回调返回的 Promise 不落定，锁就一直持有
        return new Promise<void>((done) => {
          entry.releaseLock = done;
        });
      })
      .catch(() => resolve(true));
  });
  return entry;
}

/**
 * 申请某存档的单标签页锁。
 * @returns 取得（或环境不支持）时返回句柄；已被别的标签页占用时返回 null。
 */
export async function acquireSaveTabLock(
  saveId: string,
  locks: LockRequester | undefined = defaultLocks(),
): Promise<SaveTabLockHandle | null> {
  if (!locks) return { release() {} };

  let entry = held.get(saveId);
  if (!entry) {
    entry = openEntry(saveId, locks);
    held.set(saveId, entry);
  }
  entry.refs += 1;

  const settled = entry;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    settled.refs -= 1;
    if (settled.refs > 0) return;
    if (held.get(saveId) === settled) held.delete(saveId);
    settled.releaseLock?.();
    settled.releaseLock = null;
  };

  if (!(await settled.ready)) {
    release();
    return null;
  }
  return { release };
}

/** 该存档的锁是否由本标签页持有（含同标签页引用计数中的那把） */
async function heldByThisTab(saveId: string): Promise<boolean> {
  const entry = held.get(saveId);
  if (!entry) return false;
  return await entry.ready;
}

/**
 * 列出被**别的标签页**占着的存档 id（只读快照，不申请、不持锁）。
 * 环境不支持 / 查询出错时返回空表 —— 与申请锁一样放行。
 */
export async function findSavesLockedElsewhere(
  locks: LockInspector | undefined = defaultLocks(),
): Promise<string[]> {
  if (!locks || typeof locks.query !== 'function') return [];
  let snapshot: LockManagerSnapshot;
  try {
    snapshot = await locks.query();
  } catch {
    return [];
  }
  const saveIds = new Set<string>();
  for (const info of snapshot.held ?? []) {
    if (info.name?.startsWith(LOCK_PREFIX)) saveIds.add(info.name.slice(LOCK_PREFIX.length));
  }
  const elsewhere: string[] = [];
  for (const saveId of saveIds) {
    if (!(await heldByThisTab(saveId))) elsewhere.push(saveId);
  }
  return elsewhere;
}

/** 某存档是否被别的标签页占着；本标签页自己持有的不算 */
export async function isSaveLockedElsewhere(
  saveId: string,
  locks: LockInspector | undefined = defaultLocks(),
): Promise<boolean> {
  return (await findSavesLockedElsewhere(locks)).includes(saveId);
}
