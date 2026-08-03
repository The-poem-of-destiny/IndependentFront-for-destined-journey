/**
 * Store 层写操作的统一回执（Q-14）。
 *
 * 起因：同一层里并存四种回执形态 —— `Promise<void>` 无 try/catch（rejection 直接甩给调用方）、
 * `Promise<void>` 静默 return、`Promise<boolean>`、`Promise<AudioBatchResult>`。
 * 于是「删一首静默失败、删多首有明确解释」这种不一致用户能直接撞上；而 `boolean` 的多义性
 * 把判定逻辑漏到每个调用点 —— AudioLibrary 曾被迫在 `renameTrack` 返回 false 后
 * 反查 `audio.findTrack(id)`，才能分清「曲目没了」和「名字撞了」。store 明明早就知道，
 * 只是没法说出口；第二个调用点必然忘记反查。
 *
 * ---
 *
 * **这套东西管什么、不管什么** —— 两条边界都是有意的，别顺手统一掉：
 *
 * - ✅ 管：**单条**写操作，且失败原因会改变 UI 说什么。
 * - ❌ 不管：**批量**操作。批量走「尽力做完 + 分项计数」（`AudioBatchResult`）：
 *   单条失败不连累其余，结束后一条汇总。把批量塞进判别式等于逼调用方为第一条失败停下。
 *   尤其注意 `deleteTracks` 的 skipped 桶刻意把 builtin + 查无此曲归为**非错误**
 *   （它们不是失败，只是不适用），统一回执不许把它们翻成失败。
 * - ❌ 不管：**故意的静默无操作**。`setTrackTags` / `setTrackKind` 遇内置曲目直接 return
 *   是既定策略；改成判别式会凭空给 AudioLibrary 增加它本不需要处理的分支。
 * - ➖ 素材库的 `AssetMutationOutcome` 本身已是判别式，且它的失败原因（命名不变式、
 *   媒体规则、zip 名不可表示…）是这个域独有的，不并进下面这个通用 reason 集合。
 *   两者是**同一种设计**的两个实例，不是两套。
 */

/** 通用失败原因 —— 每个值都对应一句不同的用户文案，不然就该合并 */
export type MutationFailureReason =
  /** 目标不存在（可能刚在别处被删） */
  | 'not-found'
  /** 内置条目，不可改不可删 */
  | 'builtin'
  /** 重名被拒 —— 用户是有意在起名，替他自动编号反而是骗人 */
  | 'name-taken'
  /** 存储配额 / 空间不足 */
  | 'quota'
  /** 写库抛异常等兜底 */
  | 'failed';

export type MutationResult<T = void> =
  { ok: true; value: T } | { ok: false; reason: MutationFailureReason; message: string };

/** 成功回执。无返回值的写操作直接 `mutationOk()` */
export function mutationOk(): MutationResult<void>;
export function mutationOk<T>(value: T): MutationResult<T>;
export function mutationOk<T>(value?: T): MutationResult<T | void> {
  return { ok: true, value: value as T };
}

/** 失败回执。`message` 是给用户看的整句话，不是错误码 */
export function mutationFail<T = void>(
  reason: MutationFailureReason,
  message: string,
): MutationResult<T> {
  return { ok: false, reason, message };
}
