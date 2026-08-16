/**
 * 状态写入串行队列 — 管线并行化改造的地基（docs/planning/2026-08-16-pipeline-parallelism.md）
 *
 * 两条铁律（违反任何一条都会静默丢数据或挂起）：
 *
 * ① LLM 调用无副作用可并行；一切 Dexie 写入必须经本队列串行。
 *    队列粒度 = **per-saveId**（不同存档互不阻塞）；另有 `withGlobalWriteLock`
 *    供跨存档全局互斥（记忆 id 分配 + 落库是全局资源）。
 *
 * ② 锁粒度 = **单个读-改-写区段**：`getProfile → 改 → updateProfile` 这类
 *    序列必须在**同一个**锁段内完成，锁段之间可以插入其他任务。
 *    🔴 **锁内禁止调用任何会再次进入本队列的函数**（如 commitChatState 内部
 *    自调 commitChatState）—— 同 saveId 自等即死锁。需要「方法 = 锁内 DB 段
 *    + 锁外后处理段」的结构拆分（reactToEvents / 自提交等嵌套调用一律放锁外）。
 *
 * 错误语义：fn 抛错 → 拒绝传播给调用方（与直接调用一致）；队尾吞错，
 * 后续排队任务照常执行 —— 一个写入失败不得卡死整条队列。
 */

/** 每存档的队尾 promise（吞错版，只用来续链，错误已传播给各自调用方） */
const saveTails = new Map<string, Promise<void>>();

/** 全局队尾（记忆 id 分配 + saveMemory 等跨存档原子段） */
let globalTail: Promise<void> = Promise.resolve();

/**
 * 按存档互斥执行 fn。同一 saveId 的所有调用按 FIFO 顺序串行；
 * 不同 saveId 互不阻塞。
 */
export function withSaveWriteLock<T>(saveId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = saveTails.get(saveId) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  saveTails.set(saveId, tail);
  void tail.finally(() => {
    if (saveTails.get(saveId) === tail) saveTails.delete(saveId);
  });
  return run;
}

/**
 * 全局互斥执行 fn（不分存档）。用于跨存档共享资源的原子段：
 * 记忆 id 是全库分配（`generateMemoryId` 扫全库最大号 +1），
 * 分配 + 落库必须同段，否则并发两侧都分到同一个号、后写静默覆盖。
 *
 * 竞争方是「另一次记忆写入」，低频；锁内不得包含 LLM 调用。
 */
export function withGlobalWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = globalTail;
  const run = prev.then(fn);
  globalTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
