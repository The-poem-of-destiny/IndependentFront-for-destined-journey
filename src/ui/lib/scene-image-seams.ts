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
 *   `positive` / `negative` / `model` / `seed` 一律从 `buildNaiRequest` 的**产物**回读，
 *   不从设置里再算一遍；`mime` / `bytes` 从造出来的 blob 上读。
 */

import { checkQuota } from '@engine/image-quota';
import { composePrompt } from '@engine/image-prompt';
import { buildWorldTags } from '@engine/image-world-tags';
import { buildNaiRequest } from '@engine/image-providers/novelai';
import { DEFAULT_IMAGE_COMPOSITION_TAGS } from '@engine/image-defaults';
import type { GameTime } from '@engine/time-system';
import type { ParsedCharacterAppearance } from '@engine/character-appearance';
import type {
  ImageGenFailure,
  ImagePreset,
  ImagePromptOutput,
  ImagePromptRequest,
} from '@engine/types-image';
import type { UiSettings } from '../stores/settings-types';
import type {
  SceneImageSeams,
  SceneImageSendInput,
  SceneImageSendResult,
} from '../stores/scene-image-store';
import { generateNaiImage, type NaiGenerateResult } from './image-client';
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
  | 'imageEndpointId'
  | 'imageModel'
  | 'imageQualitySuffix'
  | 'imageBaseNegative'
  | 'imageExtraNegative'
  | 'imageMaxRating'
  | 'imageWidth'
  | 'imageHeight'
  | 'imageSteps'
  | 'imageScale'
  | 'imageSampler'
  | 'imageNoiseSchedule'
  | 'imageUcPreset'
  | 'imageMaxPerMessage'
  | 'imageMaxPerHour'
>;

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
  /** 视觉预设全表；键由 `ImagePreset.key` 自带 */
  presets: () => readonly ImagePreset[];
  world: () => SceneImageWorld;
  /** 中文 → danbooru 侧链。生产是 `GamePipeline.runImagePromptAgent`（签名逐字对齐） */
  runPromptAgent: (
    req: ImagePromptRequest,
    signal: AbortSignal,
  ) => Promise<ImagePromptOutput | ImageGenFailure>;
  /** 发请求；缺省用 `image-client.generateNaiImage`（测试塞假件，**绝不发真实请求**） */
  sendImage?: typeof generateNaiImage;
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
}

/** NAI 回的是 PNG（§6）。造 blob 时声明它，落库的 `mime` 仍从 blob 上回读 */
const NAI_IMAGE_MIME = 'image/png';

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
        limits: { maxPerMessage: s.imageMaxPerMessage, maxPerHour: s.imageMaxPerHour },
      });
    },

    // 侧链 + 外貌落库。包装在这里而不是改 store 的契约：store 只关心场景串，
    // 它不该知道「顺便还会更新角色外貌」这回事。
    runPromptAgent: async (req, signal) => {
      const out = await deps.runPromptAgent(req, signal);
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

    send: (input, signal) => sendOne(input, signal, deps, send, hash),
  };
}

async function sendOne(
  input: SceneImageSendInput,
  signal: AbortSignal,
  deps: SceneImageSeamDeps,
  send: typeof generateNaiImage,
  hash: (bytes: Uint8Array) => Promise<string | undefined>,
): Promise<SceneImageSendResult | ImageGenFailure> {
  const s = deps.settings();
  const world = deps.world();
  const { record } = input;

  // 端点没选 → 一句能自救的话，且**不发请求**。
  // 没选端点与令牌过期是两回事，混成同一句会让人去重填一个根本没选过的令牌。
  const endpoint = (s.apiPool ?? []).find((entry) => entry.id === s.imageEndpointId);
  if (!endpoint) {
    return localFailure('auth', '还没有选择出图端点，去设置的「图像生成」里选一条', false);
  }

  // 预设按 `key`（`${kind}:${name}`）索引 —— 拼法归 image-preset-store，这里只建索引
  const presets = new Map<string, ImagePreset>();
  for (const preset of deps.presets()) presets.set(preset.key, preset);

  const composed = composePrompt(
    input.scenePrompt,
    input.sceneNegative,
    { characters: record.characters, rating: record.rating },
    // 🔴 地点不再进这里（D59）—— 它由侧链写进 `scenePrompt`。`world.location` 仍然有用：
    //    它是**喂给侧链**的上下文（`ImagePromptRequest.location`），不是查表的键
    presets,
    {
      qualitySuffix: s.imageQualitySuffix,
      compositionTags: DEFAULT_IMAGE_COMPOSITION_TAGS,
      baseNegative: s.imageBaseNegative,
      extraNegative: s.imageExtraNegative,
      // 🔴 上限而非默认（D38）—— 标记写的 rating 在这里被钳住
      maxRating: s.imageMaxRating,
      // 🔴 时段/天气由 Code 查引擎（D39），映射不中返空串
      worldTags: buildWorldTags(world.gameTime, world.weather),
    },
  );

  // seed 刻意不传: 留给 `composed.seed`（角色预设的 pinnedSeed）；两处都没有就不发这个
  // 字段，由 NAI 自己随机。本层**不**兜一个 Math.random()（那会让"随机"变成我们的账）。
  const body = buildNaiRequest(composed, {
    model: s.imageModel,
    width: s.imageWidth,
    height: s.imageHeight,
    steps: s.imageSteps,
    scale: s.imageScale,
    sampler: s.imageSampler,
    noiseSchedule: s.imageNoiseSchedule,
    ucPreset: s.imageUcPreset,
  });

  const result: NaiGenerateResult = await send({
    token: endpoint.apiKey ?? '',
    body,
    ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
    signal,
  });
  if (!result.ok) return result;

  const bytes = result.images[0];
  if (!bytes || bytes.length === 0) {
    return localFailure('bad-response', 'NovelAI 返回了看不懂的内容', true, '解出来的图是空的');
  }

  // Blob 构造走 `slice().buffer`: 直接喂 Uint8Array 变量在 vitest 下跑得过、tsc 过不了
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: NAI_IMAGE_MIME });
  const digest = await hash(bytes);

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
  return out;
}
