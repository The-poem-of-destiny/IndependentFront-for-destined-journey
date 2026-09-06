/**
 * endpoint-resolver.ts — Agent 显式 API 池绑定的 fail-closed 解析器（F10）
 *
 * 背景：审查发现旧解析器把「显式绑定但 ID 已失效」折叠成「未设置走首项默认」——
 * `apiPool.find((ep) => ep.id === poolId) || apiPool[0]` 会在用户选中的端点被删除后，
 * 静默把请求路由到池里另一家 provider（改了模型行为、成本甚至隐私偏好）。
 *
 * 本模块是「pool id → ApiEndpoint」解析的**唯一纯实现**，输入/输出全部走判别联合，
 * 不携带任何 UI 通知或网络 I/O。三态：
 *
 *   - 未设置（独有 `''`/`null`/`undefined`，含宽松语义）→ 走默认端点
 *     （显式声明的默认优先，否则池首项；空池 = missing-pool）
 *   - 显式绑定 + 精确命中 → resolved
 *   - 显式绑定 + 未命中 → stale-binding（**fail-closed，绝不 reroute**）
 *
 * 🔴 命名坑（继承自上游，F10 刻意不改字段名）：Agent 设置层的键叫 `model`，
 *    但它存的是 **API 池 id**（每 Agent 一个池选择）；真正叫 model 的是
 *    `ApiEndpoint.defaultModel`（模型名）与 `ApiEntry.model`。调用方在传参处
 *    把那个键的值读出来当 `boundPoolId` 传进本解析器即可，字段名不在这里翻新。
 */
import type { ApiEndpoint } from '@engine/types';

/** 端点解析结果 —— 判别联合。「池空」与「绑定失效」是两种失败，调用方按需分档。 */
export type EndpointResolution =
  | { status: 'resolved'; endpoint: ApiEndpoint }
  | { status: 'missing-pool'; requestedId?: undefined }
  | { status: 'stale-binding'; requestedId: string };

export interface ResolveEndpointInput {
  /** Agent 显式绑定的 API 池 id。`''`/`null`/`undefined` = 未设置（可走默认）。 */
  boundPoolId: string | undefined | null;
  /** 可用端点池（调用方已把存储层 ApiEntry 映射成引擎 ApiEndpoint）。 */
  apiPool: readonly ApiEndpoint[];
  /**
   * 显式声明的默认端点 id（未设置时优先命中它）。缺省 = 池首项。
   * 声明了但池里没有 → 静默回落池首项（这是「未设置」前提下的默认策略，
   * 不涉及显式绑定，故不算 stale-binding）。
   */
  declaredDefaultId?: string | undefined | null;
}

/**
 * 把「有效绑定 + 可用池 + 可选默认声明」解析成端点或类型化错误。
 *
 * 语义硬边界（F10 核心不变量）：
 *   - 未设置 → 默认端点；池空 → `missing-pool`。
 *   - 显式绑定 → **精确匹配**；未命中 → `stale-binding`（带着被请求的 id），
 *     调用方必须处理这个错误，**不得**在解析器之上再叠一层 `|| apiPool[0]`
 *     把它重新变回静默 reroute。
 *   - 畸形值（纯空白串 / 非字符串类型）一律按显式绑定处理 —— 永不塌成
 *     「未设置」，这样脏数据走的是 fail-closed 而非默认端点。
 *   - 同 id 重复端点取 `find` 语义（首个命中）：id 本应唯一，防御性去重
 *     不在本层做（多做一次池遍历也只是把两个假"唯一"挑一个出来）。
 */
export function resolveAgentEndpoint(input: ResolveEndpointInput): EndpointResolution {
  const { boundPoolId, apiPool } = input;

  if (boundPoolId === undefined || boundPoolId === null || boundPoolId === '') {
    const fallback =
      (input.declaredDefaultId
        ? apiPool.find((ep) => ep.id === input.declaredDefaultId)
        : undefined) ?? apiPool[0];
    return fallback ? { status: 'resolved', endpoint: fallback } : { status: 'missing-pool' };
  }

  const match = apiPool.find((ep) => ep.id === boundPoolId);
  return match
    ? { status: 'resolved', endpoint: match }
    : { status: 'stale-binding', requestedId: boundPoolId };
}
