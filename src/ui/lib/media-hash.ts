/**
 * media-hash.ts — 媒体字节的 SHA-256，全项目唯一一份实现 (Asset System v1)
 *
 * 为什么单独成模块: 去重靠哈希，而**产生 hash 的写入路径不止一条** —— zip 一键
 * 导入（asset-zip.ts）与音频上传（audio-store.ts）都得算。哈希曾只住在
 * asset-zip.ts 里，于是上传进来的音轨**没有 hash**；那些轨是 `source:'blob'`，
 * 会被打进导出包，重新导入时计划器找不到 hash 可比，回落到 `uniqueAudioName`，
 * 于是克隆出一条 ` (2)`。素材那半边靠 hash 幂等、音频那半边却在克隆 ——
 * 这正是 D12/§4.4 点名的"半套幂等，比两个极端都糟"。一份实现，一处特性检测，
 * 一条降级规则，才不会再长出第二种行为。
 *
 * 降级规则（唯一一条，别加第二条）: `crypto.subtle` 在**非安全上下文**里是
 * `undefined` —— localhost 算安全，明文 `http://` 的局域网地址不算。拿不到就
 * 返回 `undefined`，让调用方回落到编号路径并如实告知用户。**绝不换用第二种
 * 哈希算法**: 静默换算法等于凭空多出一个哈希空间，同一份字节在两台机器上算出
 * 两个值，去重从此不可解释。
 *
 * 惰性引用: `crypto` 只在函数体内取，仅 import 本模块不触碰任何浏览器全局 ——
 * vitest `environment:'node'` 下可直接导入。
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §4.4 / D12 / D18
 */

/** `crypto.subtle` 的窄接口 —— 只用 digest，不引 DOM 全量类型 */
interface SubtleLike {
  digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>;
}

/** 本项目唯一使用的摘要算法。改它等于换哈希空间，会让存量 hash 全部失配 */
const HASH_ALGORITHM = 'SHA-256';

/**
 * 取 `crypto.subtle`，惰性 + 特性检测。拿不到返回 `undefined`。
 *
 * 导出是为了让调用方能**先问一句"这台机器能算吗"**，而不是等到逐条哈希都返回
 * `undefined` 才发现 —— 读包路径要据此报一次 `hash-unavailable` 告警。
 */
export function isMediaHashAvailable(): boolean {
  return resolveSubtle() !== undefined;
}

function resolveSubtle(): SubtleLike | undefined {
  const scope = globalThis as { crypto?: { subtle?: unknown } };
  const subtle = scope.crypto?.subtle;
  if (subtle && typeof (subtle as SubtleLike).digest === 'function') {
    return subtle as SubtleLike;
  }
  return undefined;
}

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i += 1) out += view[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * 算 SHA-256（小写 hex）。**不可用或算不出时返回 `undefined`，永不抛**。
 *
 * 为什么不抛: 每一个调用点都在"顺手补个 hash"的位置上（上传、导入），哈希算不出
 * 从来不是让整个操作失败的理由。调用方拿到 `undefined` 就当这条没 hash，
 * 后续照旧走编号路径。
 */
export async function hashMediaBytes(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = resolveSubtle();
  if (!subtle) return undefined;
  try {
    return toHex(await subtle.digest(HASH_ALGORITHM, bytes));
  } catch {
    return undefined;
  }
}

/**
 * 算 Blob / File 的 SHA-256。同样**永不抛**，读字节失败也只是返回 `undefined`。
 *
 * 上传路径手里是 `File`，为它单独开一个口子，免得每个调用点自己写一遍
 * `new Uint8Array(await file.arrayBuffer())` —— 那行代码写第二遍就是下一处漂移。
 */
export async function hashMediaBlob(blob: Blob): Promise<string | undefined> {
  if (!isMediaHashAvailable()) return undefined;
  try {
    return await hashMediaBytes(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return undefined;
  }
}
