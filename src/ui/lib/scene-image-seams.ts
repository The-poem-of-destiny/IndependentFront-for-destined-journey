/**
 * scene-image-seams.ts — 把 `scene-image-store` 的三条注入缝接到真实实现上（阶段 H）
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md` §8（执行链路）。
 *
 * ---
 *
 * **为什么需要这个文件**
 *
 * `scene-image-store` 刻意不知道限额阈值住在哪、侧链怎么调、请求发去哪 —— 它只有
 * 队列、状态机和 Dexie。三条缝（`checkQuota` / `runPromptAgent` / `send`）**必须在
 * 存档加载时挂上**，否则每一次 `generate()` 都会以 `prompt-agent` 失败告终：症状是
 * 「按了没反应、记录直接变红」，看起来像 store 坏了。
 *
 * 本模块是那三条缝的**唯一**生产实现，且刻意做成一个**不碰 Pinia 的工厂** ——
 * 入参全是取值函数，于是「缝挂上了没有」「限额拒绝时侧链一次都没被调用」这类断言
 * 不必挂载任何组件就能写。
 *
 * ---
 *
 * **两条排序纪律**
 *
 * - 🔴 `checkQuota` 由 store 在 `runPromptAgent` **之前**调用（D32）。本模块只提供
 *   判定，不决定顺序；但阈值从设置里取这件事必须留在这里 —— store 读设置会把一个
 *   Dexie 层拽进 `settings-store` 的依赖里。
 * - 🔴 **账本记的是真正发出去的东西**（Q-21 的教训：预测值不能当记账依据）。
 *   `positive` / `negative` / `model` / `seed` 一律从**发出去的那份产物**回读
 *   （NAI 是 `buildNaiRequest` 的请求体，ComfyUI 是喂给 `substituteWorkflow` 的那袋值），
 *   不从设置里再算一遍；`mime` / `bytes` 从造出来的 blob 上读。
 *
 * ---
 *
 * **两条分叉线**（图像 v2 / C1·C2·C3）
 *
 * - **provider**（谁来画）：`novelai` / `comfyui`。差别是**能力位**（角色槽 / 谁付钱 /
 *   超时），住在下面那张 {@link PROVIDER_CAPABILITIES} 表里 —— **全仓只有这一张**。
 * - **方言**（怎么跟它说话）：与 provider **正交**（C2）。每次调用现取现解析，
 *   于是设置页换方言不必重挂缝。
 */

import { checkQuota } from '@engine/image-quota';
import { composePrompt } from '@engine/image-prompt';
import { buildWorldTags } from '@engine/image-world-tags';
import { buildNaiRequest } from '@engine/image-providers/novelai';
import { parseImageDialects, resolveImageDialect } from '@engine/image-dialect';
import type { GameTime } from '@engine/time-system';
import type { ParsedCharacterAppearance } from '@engine/character-appearance';
import type { ComfySubstitutionValues } from '@engine/image-providers/comfyui';
import type {
  ComposedPrompt,
  ImageDialect,
  ImageGenFailure,
  ImagePreset,
  ImageProviderCapabilities,
  ImageProviderId,
  ImagePromptOutput,
  ImagePromptRequest,
} from '@engine/types-image';
import type { UiSettings } from '../stores/settings-types';
import type {
  SceneImageSeams,
  SceneImageSendInput,
  SceneImageSendResult,
} from '../stores/scene-image-store';
import {
  COMFY_REQUEST_TIMEOUT_MS,
  IMAGE_REQUEST_TIMEOUT_MS,
  generateComfyImage,
  generateNaiImage,
  type ImageGenerateResult,
} from './image-client';
import { hashMediaBytes } from './media-hash';

/**
 * 本模块真正会读的设置字段。
 *
 * 用 `Pick` 而不是整份 `UiSettings`: 字段名与默认值仍只有一个真源（`settings-types.ts`
 * / `getDefaults()`），但测试不必伪造一份四十多项的设置袋子。
 */
export type ImageRuntimeSettings = Pick<
  UiSettings,
  | 'apiPool'
  | 'imageExtraNegative'
  | 'imageMaxRating'
  | 'imageWidth'
  | 'imageHeight'
  | 'imageSteps'
  | 'imageScale'
  | 'imageProvider'
  | 'imageDialectId'
  | 'imageDialectOverrides'
  | 'imageNovelai'
  | 'imageComfy'
>;

/**
 * 后端能力位表（C1）—— **全仓唯一一张**。
 *
 * 🔴 三格全是**后端属性**，不是方言属性、也不是设置项（C7/C9/C13）：
 * - `supportsCharacterSlots`: NAI V4 有 per-character 槽（官方抗串味手段），ComfyUI 没有 ——
 *   装配层据此压平（`flattenCharacters`）。让方言声明它，败法是**静默丢角色**。
 * - `costModel`: 只有 `'paid'` 启用 L1/L2 花钱防线（C9）。
 * - `defaultTimeoutMs`: NAI 的 120s 拿去卡本地 ComfyUI，会把一张仍在渲染的图记成失败，
 *   随后它又悄悄落进输出目录 —— 用户看到的是「失败了但硬盘上有图」。
 *
 * 加第三家后端时只改这里 + `sendOne` 的那个 switch，别在别处再抄一份能力判断。
 */
const PROVIDER_CAPABILITIES: Record<ImageProviderId, ImageProviderCapabilities> = {
  novelai: {
    id: 'novelai',
    supportsCharacterSlots: true,
    costModel: 'paid',
    defaultTimeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
  },
  comfyui: {
    id: 'comfyui',
    supportsCharacterSlots: false,
    costModel: 'local',
    defaultTimeoutMs: COMFY_REQUEST_TIMEOUT_MS,
  },
};

/** 设置里存着一个不认识的 provider（回退包 / 手改 localStorage）→ 退回 v1 那条路 */
function capabilitiesOf(s: ImageRuntimeSettings): ImageProviderCapabilities {
  return PROVIDER_CAPABILITIES[s.imageProvider] ?? PROVIDER_CAPABILITIES.novelai;
}

/** 世界状态（D39）—— 由 Code 查引擎得出，**不问 AI** */
export interface SceneImageWorld {
  gameTime?: GameTime;
  /** `世界['天气']` 那个自由文本；映射不中就不贡献标签（`buildWorldTags` 负责） */
  weather?: string;
  /** 当前地点名 —— 用来查地点视觉预设（D40） */
  location?: string;
}

export interface SceneImageSeamDeps {
  /** 读设置快照（每次调用现取 —— 用户改完设置不必重挂缝） */
  settings: () => ImageRuntimeSettings;
  /**
   * 内容注册表 `imageDialects` 面的**原始值**（生产是 `getContentRegistry().imageDialects`）。
   *
   * 🔴 交的是**原料不是成品**：解析（`parseImageDialects`）与取用（`resolveImageDialect`）
   *    留在本层，于是「用户覆盖有没有生效」「设置里存着一个已被 pack 删掉的 id 会怎样」
   *    这两件事只有一处实现。缺席（没接注册表 / fetch 404 / pack 把这一面清空）
   *    → 落到 `FALLBACK_IMAGE_DIALECT`，也就是**图像 v1 的行为**，不是崩。
   */
  rawDialects?: () => unknown;
  /** 视觉预设全表；键由 `ImagePreset.key` 自带 */
  presets: () => readonly ImagePreset[];
  world: () => SceneImageWorld;
  /**
   * 中文 → 场景串侧链。生产是 `GamePipeline.runImagePromptAgent`（签名逐字对齐）。
   *
   * 第三参是**当前方言的 systemPrompt**（C3/C5）：方言拥有整个装配契约，
   * 教模型怎么说话的那段话是其中一格。空串时本层不传 —— 让 agent 侧回落它自己的兜底。
   */
  runPromptAgent: (
    req: ImagePromptRequest,
    signal: AbortSignal,
    systemPrompt?: string,
  ) => Promise<ImagePromptOutput | ImageGenFailure>;
  /** 发 NAI 请求；缺省用 `image-client.generateNaiImage`（测试塞假件，**绝不发真实请求**） */
  sendImage?: typeof generateNaiImage;
  /** 发 ComfyUI 请求；缺省用 `image-client.generateComfyImage`（同上，测试塞假件） */
  sendComfy?: typeof generateComfyImage;
  /** 字节指纹；缺省用 `media-hash`（算不出来返回 undefined，不换算法） */
  hashBytes?: (bytes: Uint8Array) => Promise<string | undefined>;
  /**
   * AI 报了角色外貌变化时落库（D56/D57）。缺省 = 不落（外貌功能整个静默关闭）。
   *
   * 🔴 **在 `send` 之前调**，所以这一次出图就已经穿上新衣服 —— 由下面 `runPromptAgent`
   *    的包装保证：`send` 每次现取 `deps.presets()`，落库先发生，取值后发生。
   *    放到 `send` 之后的话，改变永远晚一张图生效，看起来像「AI 反应慢半拍」。
   * 🔴 **失败不阻断出图**：外貌落不了库最多是这张图的衣服旧了，
   *    而抛出去会让整张图变成 `prompt-agent` 失败。
   */
  applyAppearances?: (list: readonly ParsedCharacterAppearance[]) => Promise<void>;
  /** 这些出场角色里谁还没有基线（D57）。缺省 = 都当作有 */
  charactersNeedingBaseline?: (names: readonly string[]) => string[];
}

/** NAI 与 ComfyUI 回的都是 PNG（§6）。造 blob 时声明它，落库的 `mime` 仍从 blob 上回读 */
const NAI_IMAGE_MIME = 'image/png';

/**
 * 「现在这一次用哪条方言」—— **每次调用现算**（C6）。
 *
 * 🔴 不缓存：设置页换方言 / 改覆盖之后不必重挂缝，与 `deps.settings()` 同一条纪律。
 *    缓存过一次的话，症状是「切了方言，第一张图还是老吃法」。
 */
function resolveDialect(deps: SceneImageSeamDeps, s: ImageRuntimeSettings): ImageDialect {
  const dialects = parseImageDialects(deps.rawDialects?.());
  return resolveImageDialect(
    dialects,
    s.imageDialectId,
    s.imageDialectOverrides?.[s.imageDialectId],
  );
}

/**
 * 天气的读法 —— 与 `ScenePanel.vue` **同口径**（变量真源 `SaveProfile.variables.sys`，
 * `worldFlags` 兜旧存档）。
 *
 * 抽成纯函数是为了：①两处显示同一个字符串（面板上写着"小雨"、图里却是晴天会很扎眼）；
 * ②读法可测，不必挂载组件。查不到返回 `undefined`，`buildWorldTags` 会当作不贡献标签。
 */
export function resolveSceneWeather(
  profile:
    | {
        variables?: Record<string, unknown>;
        worldFlags?: Record<string, unknown>;
      }
    | null
    | undefined,
): string | undefined {
  if (!profile) return undefined;
  const sys = profile.variables?.['sys'] as Record<string, unknown> | undefined;
  const flags = profile.worldFlags;
  const candidates = [sys?.['天气'], flags?.['天气'], flags?.['weather']];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function localFailure(
  kind: ImageGenFailure['kind'],
  message: string,
  retryable: boolean,
  detail?: string,
): ImageGenFailure {
  return { ok: false, kind, message, retryable, ...(detail ? { detail } : {}) };
}

/**
 * 建一套接好线的注入缝。**存档加载时调一次**，产物交给 `sceneImageStore.setSeams()`。
 *
 * 取值函数每次调用现取，所以设置页改了限额/尺寸/端点之后**不需要重挂** ——
 * 缝是常量，值不是。
 */
export function buildSceneImageSeams(deps: SceneImageSeamDeps): SceneImageSeams {
  const send = deps.sendImage ?? generateNaiImage;
  const sendComfy = deps.sendComfy ?? generateComfyImage;
  const hash = deps.hashBytes ?? hashMediaBytes;

  return {
    // 🔴 store 在侧链之前调它（D32）。阈值取自设置，判定本身是 `image-quota` 的纯函数 ——
    //    自动档与手动档共用同一个判定，两处各写一份就是漂移的来路。
    checkQuota: (input) => {
      const s = deps.settings();
      return checkQuota({
        records: input.records,
        target: input.target,
        now: input.now,
        // 🔴 阈值恒取 NAI 那一袋（C8/C9）：限额是**花钱**防线，它跟着付费后端走。
        //    `costModel: 'local'` 时这两个数根本不会被读（L1/L2 整条跳过）。
        limits: {
          maxPerMessage: s.imageNovelai.maxPerMessage,
          maxPerHour: s.imageNovelai.maxPerHour,
        },
        // 🔴 **当前**后端的能力位，不是记录里那个：限额判的是「现在这一张要不要花钱」
        costModel: capabilitiesOf(s).costModel,
      });
    },

    // store 拿它给新记录盖章（C14）：这张图是谁画的、用哪条方言装配的。
    // 🔴 现取现算，与 checkQuota / send 同一个真源 —— 各读各的会让记录盖错章，
    //    而盖错章的后果是重画时缓存判据失效（方言换了却复用旧场景串）。
    runtimeInfo: () => {
      const s = deps.settings();
      return { provider: capabilitiesOf(s).id, dialectId: resolveDialect(deps, s).id };
    },

    // 侧链 + 外貌落库。包装在这里而不是改 store 的契约：store 只关心场景串，
    // 它不该知道「顺便还会更新角色外貌」这回事。
    runPromptAgent: async (req, signal) => {
      // 🔴 方言的 systemPrompt 在**这一层**解析（C3/C5）：方言解析全仓只有一处，
      //    store 不认识方言、pipeline 只负责把这段话合进 image_prompt 的 config。
      //    空串 = 本方言没话说 → 不传，agent 侧回落它自己的兜底（`FALLBACK_IMAGE_DIALECT`
      //    的 systemPrompt 正是空串，那条路必须与图像 v1 逐字一致）。
      const dialectPrompt = resolveDialect(deps, deps.settings()).systemPrompt;
      const out =
        dialectPrompt !== ''
          ? await deps.runPromptAgent(req, signal, dialectPrompt)
          : await deps.runPromptAgent(req, signal);
      // 判别联合：失败分支有 `ok: false`，成功分支（ImagePromptOutput）没有 `ok` 字段
      const failed = (out as ImageGenFailure).ok === false;
      const appearances = failed ? undefined : (out as ImagePromptOutput).appearances;
      if (appearances?.length && deps.applyAppearances) {
        try {
          await deps.applyAppearances(appearances);
        } catch (err) {
          // 落不了库 = 这张图的衣服是旧的；抛出去 = 根本没有这张图
          console.warn('[sceneImage] 角色外貌落库失败（不影响出图）:', err);
        }
      }
      return out;
    },

    ...(deps.charactersNeedingBaseline
      ? { charactersNeedingBaseline: deps.charactersNeedingBaseline }
      : {}),

    send: (input, signal) => sendOne(input, signal, deps, send, sendComfy, hash),
  };
}

/**
 * 装配这一次的提示词 —— **两条 provider 分支共用**（C1：装配产物 provider 无关）。
 *
 * 四个字符串旋钮（画质后缀 / 基础负向 / 构图词）全部来自**已解析的方言**（方言默认值 +
 * 用户按 id 键控的覆盖，C6）；行为旋钮整条方言传给 `composePrompt`；
 * `flattenCharacters` 来自 **provider 能力位**而不是方言（C7）。
 */
function composeFor(
  deps: SceneImageSeamDeps,
  s: ImageRuntimeSettings,
  dialect: ImageDialect,
  caps: ImageProviderCapabilities,
  input: SceneImageSendInput,
): ComposedPrompt {
  const world = deps.world();
  const { record } = input;

  // 预设按 `key`（`${kind}:${name}`）索引 —— 拼法归 image-preset-store，这里只建索引
  const presets = new Map<string, ImagePreset>();
  for (const preset of deps.presets()) presets.set(preset.key, preset);

  return composePrompt(
    input.scenePrompt,
    input.sceneNegative,
    { characters: record.characters, rating: record.rating },
    // 🔴 地点不再进这里（D59）—— 它由侧链写进 `scenePrompt`。`world.location` 仍然有用：
    //    它是**喂给侧链**的上下文（`ImagePromptRequest.location`），不是查表的键
    presets,
    {
      // 🔴 三个字符串旋钮取**已解析的方言**（C6）：方言 JSON 是默认值，用户覆盖按 id 键控。
      //    `composePrompt` 自己不去读 `dialect.qualitySuffix`（那会让覆盖被默认值顶掉），
      //    所以这三格必须由这一层交进去。
      qualitySuffix: dialect.qualitySuffix,
      compositionTags: dialect.composition,
      baseNegative: dialect.baseNegative,
      extraNegative: s.imageExtraNegative,
      // 🔴 上限而非默认（D38）—— 标记写的 rating 在这里被钳住
      maxRating: s.imageMaxRating,
      // 🔴 时段/天气由 Code 查引擎（D39），映射不中返空串
      worldTags: buildWorldTags(world.gameTime, world.weather),
      dialect,
      // 🔴 无槽后端把角色压平进 base（C7）。这一格读**能力位**不读方言：
      //    让内容包声明一件后端做不到的事，败法是画面里静默少一个人
      flattenCharacters: !caps.supportsCharacterSlots,
    },
  );
}

/** 装配告警只在**非空**时进结果（`composeWarnings` 缺席 = 一切正常，C15） */
function withWarnings(out: SceneImageSendResult, composed: ComposedPrompt): SceneImageSendResult {
  if (composed.warnings.length > 0) out.composeWarnings = composed.warnings;
  return out;
}

/** 把上游回来的字节做成 blob + 指纹；空字节是明确失败（不落一条 0 字节的「成功」） */
async function toBlob(
  result: Extract<ImageGenerateResult, { ok: true }>,
  hash: (bytes: Uint8Array) => Promise<string | undefined>,
  emptyDetail: string,
): Promise<{ ok: true; blob: Blob; digest: string | undefined } | ImageGenFailure> {
  const bytes = result.images[0];
  if (!bytes || bytes.length === 0) {
    return localFailure('bad-response', emptyDetail, true, '解出来的图是空的');
  }
  // Blob 构造走 `slice().buffer`: 直接喂 Uint8Array 变量在 vitest 下跑得过、tsc 过不了
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: NAI_IMAGE_MIME });
  return { ok: true, blob, digest: await hash(bytes) };
}

/**
 * 发一张图。**provider 在这里分叉，且只在这里**（C1）。
 *
 * 两条分支各自负责「怎么发」与「账本怎么记」，但装配（`composeFor`）与落库形状
 * （`SceneImageSendResult`）是共用的 —— store / 队列 / 七态真值表 / CG 图鉴一份不复制。
 */
async function sendOne(
  input: SceneImageSendInput,
  signal: AbortSignal,
  deps: SceneImageSeamDeps,
  send: typeof generateNaiImage,
  sendComfy: typeof generateComfyImage,
  hash: (bytes: Uint8Array) => Promise<string | undefined>,
): Promise<SceneImageSendResult | ImageGenFailure> {
  const s = deps.settings();
  const caps = capabilitiesOf(s);
  const dialect = resolveDialect(deps, s);
  const composed = composeFor(deps, s, dialect, caps, input);

  return caps.id === 'comfyui'
    ? sendViaComfy(s, dialect, composed, signal, sendComfy, hash)
    : sendViaNovelai(s, composed, signal, send, hash);
}

async function sendViaNovelai(
  s: ImageRuntimeSettings,
  composed: ComposedPrompt,
  signal: AbortSignal,
  send: typeof generateNaiImage,
  hash: (bytes: Uint8Array) => Promise<string | undefined>,
): Promise<SceneImageSendResult | ImageGenFailure> {
  // 端点没选 → 一句能自救的话，且**不发请求**。
  // 没选端点与令牌过期是两回事，混成同一句会让人去重填一个根本没选过的令牌。
  //
  // 🔴 这一段**只属于 NAI 分支**（C16）：ComfyUI 的地址住在 `imageComfy.baseUrl`，
  //    根本不进 API 池 —— 让它也来查一次端点，会让本地后端在一个它永远填不上的
  //    「还没选出图端点」上被拦死。
  const endpoint = (s.apiPool ?? []).find((entry) => entry.id === s.imageNovelai.endpointId);
  if (!endpoint) {
    return localFailure('auth', '还没有选择出图端点，去设置的「图像生成」里选一条', false);
  }

  // seed 刻意不传: 留给 `composed.seed`（角色预设的 pinnedSeed）；两处都没有就不发这个
  // 字段，由 NAI 自己随机。本层**不**兜一个 Math.random()（那会让"随机"变成我们的账）。
  const body = buildNaiRequest(composed, {
    model: s.imageNovelai.model,
    width: s.imageWidth,
    height: s.imageHeight,
    steps: s.imageSteps,
    scale: s.imageScale,
    sampler: s.imageNovelai.sampler,
    noiseSchedule: s.imageNovelai.noiseSchedule,
    ucPreset: s.imageNovelai.ucPreset,
  });

  // 🔴 **上游地址不从端点记录里取**（2026-08-05 真机连坑两轮后定的）。出图只有一个
  //    地址，用户在这一格唯一该提供的是**令牌**。而这格地址错了之后，上游报的错
  //    全都指着无辜的地方：填成 `api.novelai.net` 时被报成「模型枚举非法」，
  //    漏掉 `https://` 时被报成「header 非法」—— 两次都要人从一句无关的话倒推回
  //    一个根本没被提及的输入框。所以地址是常量，就用常量（`generateNaiImage`
  //    的 `baseUrl` 缺省即 `NAI_IMAGE_API_BASE`）。
  //
  //    `generateNaiImage` 仍收 `baseUrl`（自建镜像 / 测试替身要用），但**生产不传**；
  //    要开放自定义地址得先想清楚错误信息怎么指回那一格，见 image-client 的
  //    `resolveImageBaseUrl`。
  const result = await send({
    token: endpoint.apiKey ?? '',
    body,
    signal,
  });
  if (!result.ok) return result;

  const made = await toBlob(result, hash, 'NovelAI 返回了看不懂的内容');
  if (!made.ok) return made;
  const { blob, digest } = made;

  const out: SceneImageSendResult = {
    ok: true,
    blob,
    // 🔴 从**产物**回读，不从常量抄一遍（Q-21：预测值不能当记账依据）
    mime: blob.type,
    bytes: blob.size,
    positive: body.input,
    negative: body.parameters.negative_prompt,
    model: body.model,
    params: {
      width: body.parameters.width,
      height: body.parameters.height,
      steps: body.parameters.steps,
      scale: body.parameters.scale,
      sampler: body.parameters.sampler,
      noise_schedule: body.parameters.noise_schedule,
      ucPreset: body.parameters.ucPreset,
      n_samples: body.parameters.n_samples,
      params_version: body.parameters.params_version,
    },
  };
  if (digest !== undefined) out.hash = digest;
  // 上游没回 seed 时字段就不该存在 —— 存一个 0 会被读成"用 seed 0 画的"
  if (body.parameters.seed !== undefined) out.seed = body.parameters.seed;
  return withWarnings(out, composed);
}

/**
 * ComfyUI 分支（C1/C10/C11/C16）。
 *
 * 与 NAI 那条的三处刻意差别:
 * 1. **不查 API 池**（C16）—— 地址从 `imageComfy.baseUrl` 来，无 key。
 * 2. **角色槽是空的** —— `flattenCharacters` 已在装配层把各角色并进 base（C7）。
 *    `%character1%…%characterN%` 的替换机制仍然在（用户自己搭多槽图时能用），
 *    v1 不供值；接区域条件工作流是后话，届时改的是这里的 `characters`，不是替换器。
 * 3. **超时来自 provider 袋**（C13）—— 本地渲染慢，NAI 的 120s 会把仍在跑的图记成失败。
 */
async function sendViaComfy(
  s: ImageRuntimeSettings,
  dialect: ImageDialect,
  composed: ComposedPrompt,
  signal: AbortSignal,
  sendComfy: typeof generateComfyImage,
  hash: (bytes: Uint8Array) => Promise<string | undefined>,
): Promise<SceneImageSendResult | ImageGenFailure> {
  // 🔴 seed 在**这一层**定死（Q-21）：`generateComfyImage` 自己也有一个时钟兜底，但那个
  //    数字回不到账本里 —— 记录上会留一个空 seed，而「照原样再画一张」正是重画的全部意义。
  //    预设钉过 seed 就用它，否则现取一个并**如实记下**。
  const seed = composed.seed ?? Date.now() % 0x7fffffff;
  // 🔴 `supportsNegative:false`（flux / krea 那类 CFG 1.0 模型）时负向**发空串**，
  //    不是发一段没人读的文字：账本上留着负向、图里没有它，是最难查的一类不一致。
  const negative = dialect.supportsNegative ? composed.baseNegative : '';
  const values: ComfySubstitutionValues = {
    positive: composed.base,
    negative,
    width: s.imageWidth,
    height: s.imageHeight,
    steps: s.imageSteps,
    scale: s.imageScale,
    seed,
    // 见函数头注释第 2 条：机制在、v1 不供值
    characters: [],
  };

  const result = await sendComfy({
    baseUrl: s.imageComfy.baseUrl,
    // 空串 = 用内置最小 SDXL 图（C11）。传空串下去会被当成「用户粘了一份空工作流」
    ...(s.imageComfy.workflowJson ? { workflowJson: s.imageComfy.workflowJson } : {}),
    values,
    seedFallback: seed,
    timeoutMs: s.imageComfy.timeoutMs,
    pollIntervalMs: s.imageComfy.pollIntervalMs,
    signal,
  });
  if (!result.ok) return result;

  const made = await toBlob(result, hash, 'ComfyUI 返回了看不懂的内容');
  if (!made.ok) return made;

  const out: SceneImageSendResult = {
    ok: true,
    blob: made.blob,
    mime: made.blob.type,
    bytes: made.blob.size,
    // 🔴 账本回读的是**真正发出去的那袋值**（Q-21），不是设置里再算一遍
    positive: values.positive,
    negative: values.negative,
    // 🔴 检查点名写在用户自己的图里，本层不解析图（解析归 image-client 那一次，
    //    在这里再解一遍就是第二个解析器）。所以型号只记到后端这一级，
    //    「用的是哪份图」由下面的 `workflow` 一格如实交代。
    model: 'comfyui',
    seed,
    params: {
      width: values.width,
      height: values.height,
      steps: values.steps,
      scale: values.scale,
      workflow: s.imageComfy.workflowJson ? 'custom' : 'builtin',
    },
  };
  if (made.digest !== undefined) out.hash = made.digest;
  return withWarnings(out, composed);
}
