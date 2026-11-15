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
 *
 * 📌 2026-09-11 行为更正（**调用侧**）：`boundPoolId` 的**来源**决定 stale-binding 的处置 ——
 *    用户覆写层给的 = 用户显式选择 → fail-closed（本解析器语义不变，绝不 reroute）；
 *    内容包默认层（`agentDefaults`）给的 = 设备本地 pool id、换机必然悬空 →
 *    由 `game-pipeline.getEndpointForAgent` 回落默认端点 + 可见 warn，不再静默掐掉整条链。
 *    来源判定在调用侧（`hasExplicitAgentModel`），本解析器仍只认「有效绑定」这一个维度。
 *
 * 📌 2026-11-14（S-00）更正前移到读取咽喉：`getAgentSettings` 在合并时就把**只来自默认层**、
 *    且本机 API 池里不存在的池 id 当成「未设置」（空串）。于是主 DAG、创角准入、设置页角标
 *    全部同口径走默认端点，不必各自判来源；用户覆写层的失效 id 仍原样到达本解析器 → stale-binding。
 */
import type { ApiEndpoint } from '@engine/types/types';
import type { LlmDefaultParameters } from '@engine/types/types-api';
import { detach } from '../stores/db-write';

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

/**
 * 设置页角标 / 参数卡用的「这个 Agent 的 API 绑定处于什么状态」—— 四态判别联合（S-08）。
 *
 *   - `no-api`：池里没有任何对话 API（空池 + 未设置）
 *   - `follow-default`：没绑定，运行时自动用 `endpoint`（池首项）—— **不是错误**
 *   - `bound`：显式绑定且池里存在
 *   - `stale`：显式绑定但池里已没有这个 id（运行时 fail-closed）
 *
 * 🔴 只是 `resolveAgentEndpoint` 的展示层投影，**不另写解析规则**：角标与运行时必须给出
 *    同一个答案，否则又会回到「界面说配好了、运行时硬失败」那条老路（S-00 / S-08）。
 *    `boundPoolId` 应是 `getAgentSettings(...).model`（默认层里本机不存在的池 id 已被它清成空）。
 */
export type AgentBindingState =
  | { kind: 'no-api' }
  | { kind: 'follow-default'; endpoint: ApiEndpoint }
  | { kind: 'bound'; endpoint: ApiEndpoint }
  | { kind: 'stale'; requestedId: string };

export function describeAgentBinding(
  boundPoolId: string | undefined | null,
  apiPool: readonly ApiEndpoint[],
): AgentBindingState {
  const resolution = resolveAgentEndpoint({ boundPoolId, apiPool });
  if (resolution.status === 'missing-pool') return { kind: 'no-api' };
  if (resolution.status === 'stale-binding') {
    return { kind: 'stale', requestedId: resolution.requestedId };
  }
  const unset = boundPoolId === undefined || boundPoolId === null || boundPoolId === '';
  return unset
    ? { kind: 'follow-default', endpoint: resolution.endpoint }
    : { kind: 'bound', endpoint: resolution.endpoint };
}

/**
 * 一条 settings 投影里的 API 池条目是不是**对话（LLM）源** —— 与 `buildApiEndpoints` 的筛选同一口径。
 * 旧条目既无 `kind` 也无 `apiType` 时按 LLM 处理（历史默认）。
 */
export function isLlmPoolEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const row = entry as { kind?: unknown; apiType?: unknown };
  if (!row.kind && !row.apiType) return true;
  return (row.kind ?? (row.apiType === 'chat' ? 'llm' : row.apiType)) === 'llm';
}

const LLM_DEFAULT_PARAMETER_KEYS = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'maxTokens',
] as const;

/**
 * localStorage / settings 投影里的 `defaultParameters` 是用户可编辑的 —— 只接受有限数字的
 * 五个已知键，其余（坏类型 / 非有限数 / 未知键）一律丢弃，全空返回 `undefined`。
 */
function coerceDefaultParameters(value: unknown): LlmDefaultParameters | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const output: LlmDefaultParameters = {};
  for (const key of LLM_DEFAULT_PARAMETER_KEYS) {
    const raw = row[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) output[key] = raw;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function buildApiEndpoints(apiPool: readonly unknown[]): ApiEndpoint[] {
  // 前后端 model 结构不同:
  //   localStorage: ApiEntry    { model: string, models: string[], apiType: string }
  //   引擎:         ApiEndpoint { defaultModel: string, models: string[], provider: string }
  // 映射补齐，避免下游读错字段（defaultModel → 空串 → API 请求缺 model）
  //
  // 🔴 末尾必须 `detach`（JSON 往返切断 Vue Proxy）：`settings.apiPool` 是响应式的，
  //    这里原样按引用搬运的 `models` 数组 / `bodyOverrides` 对象都是 Proxy，而引擎
  //    `AgentClient` 构造时会 `structuredClone(endpoint)` —— 拿到 Proxy 直接抛
  //    `DataCloneError`，症状是**所有 LLM Agent 在发请求前全挂**（plot_pre_check 首当其冲）。
  //    这是 API 配置重构（1fd73e2）引入的回归，`detach` 是本仓唯一一份切断实现的入口。
  return (apiPool as any[])
    .filter((entry: any) => isLlmPoolEntry(entry))
    .map((entry: any) =>
      detach({
        id: entry.id || '',
        name: entry.name || '',
        provider: entry.provider || entry.apiType || 'custom',
        baseUrl: entry.baseUrl || '',
        apiKey: entry.apiKey || '',
        defaultModel: entry.defaultModel || entry.model || '', // ← 关键：ApiEntry.model → ApiEndpoint.defaultModel
        models: entry.models || [],
        timeout: entry.timeout ?? 60000,
        timeoutMs: entry.timeoutMs ?? entry.timeout ?? 60000,
        kind: 'llm',
        protocol: entry.protocol ?? 'openai-chat',
        bodyOverrides: entry.bodyOverrides ?? {},
        bodyOmitPaths: entry.bodyOmitPaths ?? [],
        headerOverrides: entry.headerOverrides ?? {},
        // 🆕 源级默认采样参数（「参数跟随模型」）：只认有限数字的五个已知键，
        //    坏形状一律 undefined（不猜），与 contextWindowTokens 同一口径。
        defaultParameters: coerceDefaultParameters(entry.defaultParameters),
        revision: entry.revision,
        anthropicVersion: entry.anthropicVersion,
        anthropicBeta: entry.anthropicBeta,
        // 🆕 T4（设计 §8.3 / §9）：contextWindowTokens 透传，但只认正整数 ——
        //    localStorage 是用户可编辑的，坏值（0/负数/浮点/字符串）一律 undefined
        //    （不做主动预算判断），与 api-key-migration 的 readEntries 同一口径。
        contextWindowTokens:
          typeof entry.contextWindowTokens === 'number' &&
          Number.isSafeInteger(entry.contextWindowTokens) &&
          entry.contextWindowTokens > 0
            ? entry.contextWindowTokens
            : undefined,
      }),
    ) as ApiEndpoint[];
}
