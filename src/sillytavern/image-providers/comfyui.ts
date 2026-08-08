/**
 * image-providers/comfyui.ts — 工作流 JSON 占位符替换 / ComfyUI 响应解析
 *
 * 设计: `docs/planning/2026-08-08-comfyui-image-provider-design.md`
 *       C10（三条 BFF 透传路由）/ C11（工作流 = 用户粘贴的 API-format JSON + 占位符）/
 *       C12（新增 `workflow` 与 `execution` 两类失败）/ C13（轮询 /history，不做 WebSocket）。
 *
 * 本文件是**纯函数层**（照 `novelai.ts` 的规矩）: 没有 fetch、没有 Dexie、没有随机、没有时钟。
 * 网络那一半在 `src/ui/lib/image-client.ts` 的 `generateComfyImage`。
 *
 * 🔴 **占位符替换发生在解析后的对象上，不做原文字符串替换**（C11）。
 *    提示词里第一个引号（`"a girl, "smiling""`）或第一个反斜杠就会打断 JSON ——
 *    先 `JSON.parse` 再按**值**替换，替换进去的内容天然不参与语法。
 *
 * 🔴 **本层不产随机**（与 `novelai.ts` 同一条纪律）。`values.seed` 缺省时用调用方交进来的
 *    `seedFallback`；在这里塞 `Math.random()` 会让快照复现失效。
 *
 * 🔴 **`POST /prompt` 会带着 `node_errors` 返回 HTTP 200**（C12）。只看状态码的分类器
 *    会把「图在跑起来之前就被拒了」当成排队成功，然后去轮询一个永远不会出现的 prompt_id，
 *    最终报成超时 —— 与 v1 那次「content-type 撒谎、把已付费的图扔掉」同形状的坑。
 *    所以 {@link parseComfyQueueResponse} **先看响应体、后看状态码**。
 */

import type { ImageGenFailure, ImageGenFailureKind } from '../types-image';
import { IMAGE_FAILURE_RETRYABLE } from '../image-defaults';

// ═══════════════════════════════════════════════════════════
// 线格式类型
// ═══════════════════════════════════════════════════════════
//
// 🔴 这些**不是**本项目的领域类型，是 ComfyUI 的线格式（节点 id 是字符串键、
//    `class_type` / `node_errors` / `status_str` 都是人家定的名字）。领域类型集中在
//    `types-image.ts`；线格式随 provider 走，与 `novelai.ts` 同口径。

/**
 * ComfyUI「Save (API Format)」导出的图: 节点 id（字符串）→ 节点。
 *
 * 刻意是 `Record<string, unknown>` 而不是逐字段建模: 图是**用户的**，LoRA 栈 / 上采样 /
 * 自定义采样器 / 社区节点都合法，我们只认那几个 `%占位符%`，其余原样搬运（C11）。
 * 建模得越细，能装的图越少。
 */
export type ComfyGraph = Record<string, unknown>;

/** `/history` 里 `outputs[nodeId].images[i]` 的三元组，`/view` 的查询参数就是它 */
export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  /** 'output' | 'temp' | 'input'（SaveImage 出 output，PreviewImage 出 temp） */
  type: string;
}

/**
 * 替换进图里的那几个值。
 *
 * `seed` 之外全是必填 —— 缺一个就意味着图上那一格会留着 `%width%` 字面量，
 * 而 ComfyUI 对一个字符串宽度只会回 `node_errors`，症状离原因很远。
 */
export interface ComfySubstitutionValues {
  positive: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  /** 缺省时用 `substituteWorkflow` 的 `seedFallback` 参数 —— 本层不产随机 */
  seed?: number;
  /**
   * 角色分槽提示词，喂 `%character1%` … `%characterN%`。
   *
   * 图里没引用到的角色**不是错误**: 无槽后端的压平在装配层（C7）已经做过了，
   * 这里只是给「作者自己搭了多槽图」的用户留的口子。
   */
  characters?: string[];
}

// ═══════════════════════════════════════════════════════════
// 失败构造（ComfyUI 口吻）
// ═══════════════════════════════════════════════════════════

/**
 * §12.2 那张表的 ComfyUI 版文案。
 *
 * 🔴 **不复用 NovelAI 那套**: `auth` / `payment` 在本地后端天然不出现（C12），
 * 而「连不上 NovelAI」这句话对一个连的是 `127.0.0.1:8188` 的用户是彻底的误导 ——
 * 他会去查网络代理，而真因是 ComfyUI 没启动。
 *
 * `bad-response` 那句同理: `image-defaults.IMAGE_BAD_RESPONSE_MESSAGE` 里点名了 NovelAI。
 */
export const COMFY_FAILURE_MESSAGES = {
  'bad-request': 'ComfyUI 拒绝了这次请求',
  'rate-limit': 'ComfyUI 那头忙不过来，过一会儿再试',
  upstream: 'ComfyUI 服务端出错了',
  network: '连不上 ComfyUI，确认它已启动、地址填对了',
  aborted: '已取消',
  'bad-response': 'ComfyUI 返回了看不懂的内容',
  workflow: '工作流被 ComfyUI 拒绝了',
  execution: 'ComfyUI 跑到一半失败了',
} as const satisfies Partial<Record<ImageGenFailureKind, string>>;

/** 本 provider 会产出的失败类别（`auth` / `payment` / `prompt-agent` 不在其中） */
export type ComfyFailureKind = keyof typeof COMFY_FAILURE_MESSAGES;

/**
 * ComfyUI 链路的失败构造器。**导出给 `image-client.ts` 用** ——
 * 网络那一半也必须说同一种话，各写一份就会漂成「同一件事两种措辞」。
 *
 * `retryable` 一律取 `IMAGE_FAILURE_RETRYABLE`（渲染层画不画「重试」按钮读的是同一张表）。
 * 🔴 `workflow: false` / `execution: true` 是这张表里最要紧的一对（C12）：
 *    图本身有问题时按一百次重试都是同样的拒绝，而 OOM 换个时机常常就过了。
 */
export function comfyFail(
  kind: ComfyFailureKind,
  detail?: string,
  messageOverride?: string,
): ImageGenFailure {
  return {
    ok: false,
    kind,
    message: messageOverride ?? COMFY_FAILURE_MESSAGES[kind],
    ...(detail ? { detail } : {}),
    retryable: IMAGE_FAILURE_RETRYABLE[kind],
  };
}

/** 上游正文进 detail 时的长度闸（与 `image-client.DETAIL_SUMMARY_MAX` 同口径） */
const DETAIL_MAX = 240;

/**
 * 任意值 → 一段能进 detail 的短文本。
 *
 * 收 `unknown` 而不是 `string`: 调用点常常是 `clip(JSON.stringify(body))`，而
 * **`JSON.stringify(undefined)` 返回的是 `undefined` 不是 `'undefined'`** ——
 * 收窄成 string 只会让「响应体是空的」这条本就在报错的路径**自己**再抛一次 TypeError。
 */
function clip(text: unknown): string {
  const compact = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > DETAIL_MAX ? `${compact.slice(0, DETAIL_MAX)}…` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ═══════════════════════════════════════════════════════════
// 工作流解析
// ═══════════════════════════════════════════════════════════

/**
 * 用户粘贴的那段文本 → 可替换的图。
 *
 * 解不开 / 不是对象 / 空对象都归 `workflow`（**不可重试**）: 这三种都不会因为再发一次
 * 就变好，而 `bad-request` 的文案（「拒绝了这次请求」）会让人以为问题在上游。
 */
export function parseComfyWorkflow(
  json: string,
): { ok: true; graph: ComfyGraph } | ImageGenFailure {
  const text = (json ?? '').trim();
  if (!text) {
    return comfyFail('workflow', '工作流是空的', '还没有粘贴 ComfyUI 工作流（API 格式）');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return comfyFail(
      'workflow',
      `工作流 JSON 解析失败: ${reason}`,
      `工作流不是合法的 JSON：${reason}`,
    );
  }

  if (!isRecord(parsed)) {
    return comfyFail(
      'workflow',
      `工作流的顶层是 ${Array.isArray(parsed) ? 'array' : typeof parsed}，应为对象`,
      '工作流格式不对：顶层应该是「节点 id → 节点」的对象（ComfyUI 的 Save (API Format)）',
    );
  }

  if (Object.keys(parsed).length === 0) {
    return comfyFail('workflow', '工作流里一个节点都没有', '工作流里一个节点都没有');
  }

  return { ok: true, graph: parsed };
}

// ═══════════════════════════════════════════════════════════
// 占位符替换
// ═══════════════════════════════════════════════════════════

/** `%token%`。token 只许字母/数字/下划线，且不以数字开头 —— 与 ST 的写法一致 */
const PLACEHOLDER_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/g;
/** 整个值就是一个占位符（于是可以替换成**类型化**的值，而不是数字的字符串形态） */
const WHOLE_VALUE_RE = /^%([A-Za-z_][A-Za-z0-9_]*)%$/;
/** `%character1%` … `%characterN%` */
const CHARACTER_TOKEN_RE = /^character([1-9][0-9]*)$/;

/**
 * token → 值。认不出来返回 `undefined`（调用点会把原文**原样留着**，不报错 —— C11）。
 *
 * 🔴 未知 token 不报错是刻意的: 社区工作流里满是我们没听说过的自定义变量约定，
 *    为一个我们不认识的 `%foo%` 否掉整张图，等于把「支持任意工作流」这条卖点作废。
 *
 * 🔴 `%characterN%` 越界（图里有 3 个槽、这一幕只有 1 个角色）解析成**空串**，
 *    不是「原样留着」: 留着的话 `%character3%` 这七个字符会**原封不动进提示词**，
 *    画面上多出一段谁也不想要的噪声。空槽就是空槽。
 */
function resolveToken(
  token: string,
  values: ComfySubstitutionValues,
  seedFallback: number,
): string | number | undefined {
  switch (token.toLowerCase()) {
    // ST 习惯别名: `%prompt%` / `%negative_prompt%`（C11）
    case 'positive':
    case 'prompt':
      return values.positive;
    case 'negative':
    case 'negative_prompt':
      return values.negative;
    case 'seed':
      // 🔴 本层不产随机 —— 缺省时用调用方交进来的那个数
      return values.seed ?? seedFallback;
    case 'width':
      return values.width;
    case 'height':
      return values.height;
    case 'steps':
      return values.steps;
    case 'scale':
      return values.scale;
    default:
      break;
  }

  const charMatch = CHARACTER_TOKEN_RE.exec(token.toLowerCase());
  if (charMatch) {
    const index = Number.parseInt(charMatch[1], 10) - 1;
    return values.characters?.[index] ?? '';
  }

  return undefined;
}

/** 字符串里内嵌的占位符 → 字符串拼接（数字在这里退化成它的字符串形态，理所应当） */
function spliceString(
  raw: string,
  values: ComfySubstitutionValues,
  seedFallback: number,
): string | number {
  const whole = WHOLE_VALUE_RE.exec(raw);
  if (whole) {
    const resolved = resolveToken(whole[1], values, seedFallback);
    // 整值命中 → 保**类型**（seed/steps/width/height 必须是数字，字符串会被 ComfyUI
    // 判成节点输入类型不匹配，回一个 node_errors）
    return resolved === undefined ? raw : resolved;
  }

  return raw.replace(PLACEHOLDER_RE, (match, token: string) => {
    const resolved = resolveToken(token, values, seedFallback);
    return resolved === undefined ? match : String(resolved);
  });
}

/**
 * 图 + 值 → 可以发出去的图。**不修改入参**（返回全新的结构）。
 *
 * 深走对象与数组，只在**字符串叶子**上动手:
 * - 整个值就是占位符（`"%seed%"`）→ 替换成**类型化**的值（数字保持数字）
 * - 字符串内嵌（`"masterpiece, %positive%"`）→ 字符串拼接
 * - 认不出的 `%foo%` → 原样留着，不报错
 *
 * 🔴 不做原文字符串替换（C11）: 提示词里的引号与反斜杠会打断 JSON。这也是
 *    「替换在解析之后」这个顺序**不能**为了省一次 parse 而调换的全部理由。
 *
 * 🔴 不产随机: `seedFallback` 由调用方给（`image-client` 那层）。
 */
export function substituteWorkflow(
  graph: ComfyGraph,
  values: ComfySubstitutionValues,
  seedFallback: number,
): ComfyGraph {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return spliceString(node, values, seedFallback);
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) out[key] = walk(value);
      return out;
    }
    return node;
  };

  return walk(graph) as ComfyGraph;
}

// ═══════════════════════════════════════════════════════════
// POST /prompt 的响应
// ═══════════════════════════════════════════════════════════

export interface ComfyQueueSuccess {
  ok: true;
  promptId: string;
}

export type ComfyQueueResult = ComfyQueueSuccess | ImageGenFailure;

/** `node_errors[nodeId].errors[0].message` —— 摘第一条，够定位就行 */
function firstNodeErrorMessage(nodeErrors: Record<string, unknown>): string | undefined {
  for (const entry of Object.values(nodeErrors)) {
    if (!isRecord(entry)) continue;
    const errors = entry.errors;
    if (!Array.isArray(errors)) continue;
    for (const e of errors) {
      if (!isRecord(e)) continue;
      const msg = e.message ?? e.type;
      if (typeof msg === 'string' && msg.trim()) {
        const details = typeof e.details === 'string' && e.details.trim() ? `（${e.details}）` : '';
        return `${msg.trim()}${details}`;
      }
    }
  }
  return undefined;
}

/**
 * `POST /prompt` 的状态码 + 响应体 → 「排上队了」或一条失败。
 *
 * 🔴 **`node_errors` 优先于状态码，任何状态码上都查**（C12）。ComfyUI 在图被拒时
 *    会回 **HTTP 200 + 非空 `node_errors`**（缺 checkpoint、未知节点、输入类型不匹配都走这条），
 *    只看状态码的分类器会把它当成排队成功，接着去轮询一个永远不会出现的 prompt_id，
 *    600 秒后报成超时 —— 真因（「你的 ComfyUI 上没有这个模型文件」）一个字都不会出现。
 *
 * 文案点名违规节点 id: 那是用户在 ComfyUI 界面里唯一能对上号的东西。
 */
export function parseComfyQueueResponse(status: number, body: unknown): ComfyQueueResult {
  const record = isRecord(body) ? body : undefined;

  // ── 1. node_errors 先于一切 ──
  const nodeErrors = record?.node_errors;
  if (isRecord(nodeErrors) && Object.keys(nodeErrors).length > 0) {
    const ids = Object.keys(nodeErrors);
    const first = firstNodeErrorMessage(nodeErrors);
    const idList = ids.join('、');
    return comfyFail(
      'workflow',
      `HTTP ${status} node_errors: ${clip(JSON.stringify(nodeErrors))}`,
      first
        ? `工作流被 ComfyUI 拒绝：节点 ${idList} —— ${first}`
        : `工作流被 ComfyUI 拒绝：节点 ${idList}`,
    );
  }

  // ── 2. 非 2xx ──
  if (status < 200 || status >= 300) {
    // 400 常见于「图结构对不上」，但没有 node_errors 时说不清是哪一节 ——
    // 归 workflow（不可重试）而不是 bad-request：重发同一份图不会变好
    const upstream = typeof record?.error === 'string' ? record.error : undefined;
    const detail = `HTTP ${status}${upstream ? `: ${clip(upstream)}` : ''}`;

    if (status >= 500) return comfyFail('upstream', detail);
    if (status === 429) return comfyFail('rate-limit', detail);
    if (status === 404) {
      return comfyFail(
        'bad-request',
        detail,
        'ComfyUI 上没有 /prompt 这个接口，确认地址填的是 ComfyUI 而不是别的服务',
      );
    }
    if (status === 400) {
      return comfyFail(
        'workflow',
        detail,
        upstream ? `工作流被 ComfyUI 拒绝：${clip(upstream)}` : COMFY_FAILURE_MESSAGES.workflow,
      );
    }
    return comfyFail(
      'bad-request',
      detail,
      upstream
        ? `${COMFY_FAILURE_MESSAGES['bad-request']}：${clip(upstream)}`
        : COMFY_FAILURE_MESSAGES['bad-request'],
    );
  }

  // ── 3. 2xx 但没有 prompt_id ──
  const promptId = record?.prompt_id;
  if (typeof promptId !== 'string' || !promptId.trim()) {
    return comfyFail('bad-response', `2xx 响应里没有 prompt_id: ${clip(JSON.stringify(body))}`);
  }

  return { ok: true, promptId: promptId.trim() };
}

// ═══════════════════════════════════════════════════════════
// GET /history/{id} 的响应
// ═══════════════════════════════════════════════════════════

export type ComfyHistoryState =
  /** 还在排队 / 还在跑 —— `/history/{id}` 此时回的是 `{}` */
  | { state: 'pending' }
  | { state: 'done'; images: ComfyImageRef[] }
  | { state: 'failed'; failure: ImageGenFailure };

/** `messages: [["execution_error", {...}], …]` 里摘一句能用的 */
function firstExecutionErrorDetail(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const entry of messages) {
    // 形状是 [type, data]
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const type = entry[0];
    if (typeof type !== 'string' || !type.toLowerCase().includes('error')) continue;
    const data = entry[1];
    if (!isRecord(data)) return type;

    const exception = data.exception_message ?? data.exception_type;
    const nodeId = data.node_id;
    const nodeType = data.node_type;
    const where =
      nodeId === undefined
        ? ''
        : `节点 ${String(nodeId)}${typeof nodeType === 'string' ? `（${nodeType}）` : ''} `;
    if (typeof exception === 'string' && exception.trim()) return `${where}${exception.trim()}`;
    return `${where}${type}`.trim();
  }
  return undefined;
}

/** `outputs: {nodeId: {images: [{filename, subfolder, type}]}}` → 扁平的图片清单 */
function collectImages(outputs: unknown): ComfyImageRef[] {
  if (!isRecord(outputs)) return [];
  const out: ComfyImageRef[] = [];
  for (const nodeOutput of Object.values(outputs)) {
    if (!isRecord(nodeOutput)) continue;
    const images = nodeOutput.images;
    if (!Array.isArray(images)) continue;
    for (const image of images) {
      if (!isRecord(image)) continue;
      const filename = image.filename;
      if (typeof filename !== 'string' || !filename) continue;
      out.push({
        filename,
        subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
        type: typeof image.type === 'string' && image.type ? image.type : 'output',
      });
    }
  }
  return out;
}

/**
 * `GET /history/{id}` 的响应体 → 三态。
 *
 * - 空对象 / 查不到这个 id → `pending`（ComfyUI 在跑完之前就是这么答的，**不是错误**）
 * - `status.status_str === 'error'` → `failed` + `execution`（**可重试**: OOM / 节点崩溃
 *   换个时机常常就过了，C12）
 * - 跑完了但一张图都没有 → `failed` + `bad-response`（图里没有 SaveImage / PreviewImage
 *   时会这样；报成「成功但没有图」比静默返回空数组好定位）
 */
export function parseComfyHistory(body: unknown, promptId: string): ComfyHistoryState {
  if (!isRecord(body)) {
    return {
      state: 'failed',
      failure: comfyFail('bad-response', `/history 返回的不是对象: ${clip(String(body))}`),
    };
  }

  const entry = body[promptId];
  if (!isRecord(entry)) return { state: 'pending' };

  const status = isRecord(entry.status) ? entry.status : undefined;
  const statusStr = typeof status?.status_str === 'string' ? status.status_str : undefined;

  if (statusStr === 'error') {
    const detail = firstExecutionErrorDetail(status?.messages);
    return {
      state: 'failed',
      failure: comfyFail(
        'execution',
        detail ? `execution error: ${clip(detail)}` : 'execution error（上游没给细节）',
        detail ? `ComfyUI 跑到一半失败了：${clip(detail)}` : COMFY_FAILURE_MESSAGES.execution,
      ),
    };
  }

  // `completed` 是权威，`status_str` 只在它**缺席**时兜底: 老版本 / 部分自定义后端不发
  // `completed`，只认它会让那些图轮询到超时为止；反过来，显式的 `completed: false`
  // 必须压过一句乐观的 `status_str`，否则会在一次尚未结束的执行上去取还不存在的字节。
  const completed =
    status?.completed === true || (statusStr === 'success' && !('completed' in (status ?? {})));
  const images = collectImages(entry.outputs);

  // 还没跑完 → 继续等。（有的自定义节点会先写一部分 outputs 再继续跑，
  //  所以「有图了」不等于「跑完了」—— 以 completed 为准）
  if (!completed) return { state: 'pending' };

  if (images.length === 0) {
    return {
      state: 'failed',
      failure: comfyFail(
        'bad-response',
        `prompt ${promptId} 执行完成但 outputs 里没有图片条目`,
        'ComfyUI 跑完了但没有产出图片，确认工作流里有 SaveImage 或 PreviewImage 节点',
      ),
    };
  }

  return { state: 'done', images };
}

// ═══════════════════════════════════════════════════════════
// 内置工作流
// ═══════════════════════════════════════════════════════════

/**
 * 最小 SDXL txt2img（API 格式）—— 用户没粘贴工作流时就用它。
 *
 * 🔴 `ckpt_name` 写死 `sd_xl_base_1.0.safetensors`。用户的 ComfyUI 上**没有**这个文件时，
 *    `POST /prompt` 会回 **200 + node_errors**，经 {@link parseComfyQueueResponse} 变成一条
 *    点名节点 `4` 的 `workflow` 失败 —— 「节点 4 —— Value not in list: ckpt_name」。
 *    这是**设计好的**败法而不是疏漏: 我们无从知道用户装了哪些模型（`/object_info` 能问，
 *    但那是又一条要维护的链路），而一条点名了节点的错误，用户在 ComfyUI 界面里一眼能对上号，
 *    换成自己的图就好了。静默换一个「可能存在」的名字才是真的坑。
 *
 * 🔴 **不要在这里加任何东西**（LoRA / 上采样 / 面部修复）。图是用户的（C11），
 *    内置这一份只负责证明「地址填对了、链路是通的」。
 */
export const BUILTIN_COMFY_WORKFLOW: ComfyGraph = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: '%seed%',
      steps: '%steps%',
      cfg: '%scale%',
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
  },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: '%width%', height: '%height%', batch_size: 1 },
  },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '%positive%', clip: ['4', 1] },
  },
  '7': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '%negative%', clip: ['4', 1] },
  },
  '8': {
    class_type: 'VAEDecode',
    inputs: { samples: ['3', 0], vae: ['4', 2] },
  },
  '9': {
    class_type: 'SaveImage',
    inputs: { filename_prefix: 'fated_poem', images: ['8', 0] },
  },
};
