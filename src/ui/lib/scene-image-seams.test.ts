/**
 * scene-image-seams 测试（图像生成 v1 / 阶段 H）
 *
 * 这条测试的存在理由是**一个真实的阻塞项**：`scene-image-store` 的三条注入缝不挂上，
 * 每一次 `generate()` 都会以 `prompt-agent` 失败告终 —— 症状是「按了没反应、记录直接
 * 变红」，看起来像 store 坏了。所以这里既测装配（缝在不在），也测**接好线之后整条链
 * 真的能跑通**（限额 → 侧链 → 装配 → 发请求 → 落库）。
 *
 * 两条错了会直接花钱的断言:
 * - 🔴 限额拒绝时，侧链与网络**一次都没被调用**（D32：两处花钱，闸门在最前面）
 * - 🔴 端点没选时**不发请求**，而不是拿空令牌去撞一次 401
 *
 * 网络全程替身（`sendImage` 缝），**绝不发真实请求**。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { clearAllData, getSceneImage, getSceneImagesByMessage } from '@engine/database';
import type { ImagePreset, ImagePromptRequest } from '@engine/types-image';
import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_COMPOSITION_TAGS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_PROMPT_SYSTEM,
  DEFAULT_IMAGE_QUALITY_SUFFIX,
} from '@engine/image-defaults';
import type { ComfyGenerateOptions, NaiGenerateOptions, NaiGenerateResult } from './image-client';
import {
  buildSceneImageSeams,
  resolveSceneWeather,
  type ImageRuntimeSettings,
  type SceneImageSeamDeps,
  type SceneImageWorld,
} from './scene-image-seams';
import { useSceneImageStore, type SceneImageGenerateInput } from '../stores/scene-image-store';

const SAVE = 'save_seams';

/**
 * NAI 那一袋（图像 v2 / C8）。整袋替换很啰嗦，所以给个只改一两项的口子 ——
 * 画质后缀与基础负向**不在这里**：它们自 C6 起是方言覆盖，缺席即回落常量。
 */
function makeNovelai(over: Partial<ImageRuntimeSettings['imageNovelai']> = {}) {
  return {
    endpointId: 'nai' as string | null,
    model: DEFAULT_IMAGE_MODEL,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    ucPreset: 0,
    tier: 'unset' as const,
    maxPerMessage: 2,
    maxPerHour: 20,
    ...over,
  };
}

function makeSettings(over: Partial<ImageRuntimeSettings> = {}): ImageRuntimeSettings {
  return {
    apiPool: [
      {
        id: 'nai',
        name: 'NovelAI',
        baseUrl: 'https://image.novelai.net',
        apiKey: 'pst-token',
        maskedKey: 'pst-…',
        model: '',
        models: [],
        apiType: 'image',
      },
    ],
    imageExtraNegative: '',
    imageMaxRating: 'general',
    imageWidth: 1216,
    imageHeight: 832,
    imageSteps: 23,
    imageScale: 4.5,
    imageProvider: 'novelai',
    imageDialectId: 'danbooru-anime',
    imageDialectOverrides: {},
    imageNovelai: makeNovelai(),
    imageComfy: makeComfy(),
    ...over,
  };
}

/** ComfyUI 那一袋（C8）。默认值与 `getDefaults()` 同口径 */
function makeComfy(over: Partial<ImageRuntimeSettings['imageComfy']> = {}) {
  return {
    baseUrl: 'http://127.0.0.1:8188',
    workflowJson: '',
    timeoutMs: 600_000,
    pollIntervalMs: 1_500,
    ...over,
  };
}

function makePreset(over: Partial<ImagePreset> = {}): ImagePreset {
  return {
    key: 'character:苏婉',
    kind: 'character',
    name: '苏婉',
    dialects: { danbooru: { positive: '1girl, silver hair', negative: 'blonde hair' } },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** 一张最小的假图；`parseNaiZip` 已在上游测过，这里只关心字节怎么落库 */
function fakeImage(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
}

function okSend(): NaiGenerateResult {
  return { ok: true, images: [fakeImage()], contentType: 'application/x-zip-compressed' };
}

/**
 * 两个手动闸门 —— 「第一张还在飞的时候，用户去设置页改了东西」那一幕只能这么摆出来。
 * 队列是串行的，所以卡住在飞的那一条，后面的就一定还排着。
 */
function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

function deferredResult(): {
  promise: Promise<NaiGenerateResult>;
  resolve: (v: NaiGenerateResult) => void;
} {
  let resolve!: (v: NaiGenerateResult) => void;
  const promise = new Promise<NaiGenerateResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * 两条方言的最小注册表面（图像 v2）。形状与 `data/content/image-dialects.json` 一致，
 * 但**刻意不 import 那份文件** —— 这些用例要验的是「解析 + 覆盖 + 分叉」，
 * 不是内容包里今天写了什么（那由 `tests/placeholder-content.test.ts` 钉）。
 */
const RAW_DIALECTS = {
  dialects: [
    {
      id: 'danbooru-anime',
      label: '动漫标签',
      separator: ', ',
      normalize: 'danbooru',
      appearance: 'danbooru',
      world: 'tags',
      rating: 'tag',
      count: 'tag',
      supportsNegative: true,
      qualitySuffix: DEFAULT_IMAGE_QUALITY_SUFFIX,
      baseNegative: DEFAULT_IMAGE_BASE_NEGATIVE,
      composition: DEFAULT_IMAGE_COMPOSITION_TAGS,
      systemPrompt: '把中文转成 danbooru 标签。<image_prompt></image_prompt>',
    },
    {
      id: 'natural-prose',
      label: '自然语',
      separator: '. ',
      normalize: 'none',
      appearance: 'prose',
      world: 'tags',
      rating: 'none',
      count: 'none',
      supportsNegative: false,
      qualitySuffix: '',
      baseNegative: '',
      composition: 'wide shot, cinematic composition',
      systemPrompt: '写成英文句子。<image_prompt></image_prompt>',
    },
  ],
};

function makeDeps(over: Partial<SceneImageSeamDeps> = {}): SceneImageSeamDeps {
  return {
    settings: () => makeSettings(),
    presets: () => [makePreset()],
    world: (): SceneImageWorld => ({ location: '风铃旅店' }),
    runPromptAgent: async () => ({
      scenePrompt: 'tavern interior, warm candlelight',
      sceneNegative: 'modern clothing',
      desc: '炉火边的故乡',
    }),
    sendImage: async () => okSend(),
    hashBytes: async () => 'deadbeef',
    ...over,
  };
}

function baseInput(over: Partial<SceneImageGenerateInput> = {}): SceneImageGenerateInput {
  return {
    saveId: SAVE,
    messageId: 'msg_1',
    turn: 3,
    anchorKind: 'marker',
    occurrence: 0,
    source: 'auto',
    intent: '苏婉在壁炉边第一次说起她的家乡',
    title: '炉火边的故乡',
    characters: ['苏婉'],
    rating: 'general',
    narrative: '壁炉噼啪作响。',
    location: '风铃旅店',
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(async () => {
  await clearAllData();
});

// ═══ 缝有没有挂上 ═══

describe('注入缝装配（阻塞项：不挂缝 = 每一次生成都以 prompt-agent 失败告终）', () => {
  it('三条缝一条不少', () => {
    const seams = buildSceneImageSeams(makeDeps());
    expect(typeof seams.checkQuota).toBe('function');
    expect(typeof seams.runPromptAgent).toBe('function');
    expect(typeof seams.send).toBe('function');
  });

  it('挂上之后整条链跑通：queued → done，且账务字段来自真正发出去的请求体', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(buildSceneImageSeams(makeDeps()));

    const res = await store.generate(baseInput());
    expect(res.ok).toBe(true);
    await store.whenIdle();

    const rows = await getSceneImagesByMessage(SAVE, 'msg_1');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.status).toBe('done');
    // 侧链产出进了记录（下次重画不再跑侧链，D31）
    expect(row.scenePrompt).toBe('tavern interior, warm candlelight');
    // 装配确实经过 composePrompt：场景在最前、画质后缀压在末尾、rating 与角色预设都在
    expect(row.positive.startsWith('tavern interior, warm candlelight')).toBe(true);
    expect(row.positive).toContain('rating:general');
    expect(row.positive).toContain(DEFAULT_IMAGE_COMPOSITION_TAGS);
    expect(row.positive.endsWith(DEFAULT_IMAGE_QUALITY_SUFFIX)).toBe(true);
    expect(row.negative).toContain(DEFAULT_IMAGE_BASE_NEGATIVE);
    // 场景专属负向由 composePrompt 并进 baseNegative
    expect(row.negative).toContain('modern clothing');
    expect(row.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(row.mime).toBe('image/png');
    expect(row.bytes).toBe(4);
    expect(row.hash).toBe('deadbeef');
    expect(row.params).toMatchObject({ width: 1216, height: 832, steps: 23 });
  });

  it('世界状态标签（D39）由 Code 注入，不问 AI；地点已随 D59 出列', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          presets: () => [makePreset()],
          world: () => ({
            location: '风铃旅店',
            gameTime: {
              era: '复兴纪元',
              year: 1,
              month: 1,
              day: 1,
              weekday: 1,
              hour: 22,
              minute: 0,
            },
            weather: '小雨',
          }),
        }),
      ),
    );

    await store.generate(baseInput());
    await store.whenIdle();

    const row = (await getSceneImagesByMessage(SAVE, 'msg_1'))[0];
    // 🔴 地点预设废除（D59）：地点长什么样由侧链写进场景串，这里只验世界状态标签
    expect(row.positive).toContain('night');
    expect(row.positive).toContain('rain');
  });

  it('rating 上限会把标记要求的分级钳住（D38），且静默不报警', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({ settings: () => makeSettings({ imageMaxRating: 'sensitive' }) }),
      ),
    );

    await store.generate(baseInput({ rating: 'explicit' }));
    await store.whenIdle();

    const row = (await getSceneImagesByMessage(SAVE, 'msg_1'))[0];
    expect(row.positive).toContain('rating:sensitive');
    expect(row.positive).not.toContain('rating:explicit');
  });

  it('🔴 用户改过的画质后缀/基础负向经**方言覆盖**照旧到得了请求体（C6 改址不丢值）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          settings: () =>
            makeSettings({
              imageDialectOverrides: {
                'danbooru-anime': { qualitySuffix: 'my tail', baseNegative: 'no hands' },
              },
            }),
        }),
      ),
    );

    await store.generate(baseInput());
    await store.whenIdle();

    const row = (await getSceneImagesByMessage(SAVE, 'msg_1'))[0];
    expect(row.positive.endsWith('my tail')).toBe(true);
    expect(row.positive).not.toContain(DEFAULT_IMAGE_QUALITY_SUFFIX);
    expect(row.negative).toContain('no hands');
    expect(row.negative).not.toContain(DEFAULT_IMAGE_BASE_NEGATIVE);
  });
});

// ═══ 限额（D32：闸门在最前面）═══

describe('限额闸门（错了会白烧 LLM token）', () => {
  it('限额拒绝时，侧链与网络一次都没被调用，且不留记录', async () => {
    const runPromptAgent = vi.fn(async () => ({
      scenePrompt: 'x',
      sceneNegative: '',
      desc: '',
    }));
    const sendImage = vi.fn(async () => okSend());
    const store = useSceneImageStore();
    await store.load(SAVE);
    // 每小时 0 张 = 恒拒。用真 checkQuota，不塞假裁决 —— 要测的正是"阈值取自设置"
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          settings: () => makeSettings({ imageNovelai: makeNovelai({ maxPerHour: 0 }) }),
          runPromptAgent,
          sendImage,
        }),
      ),
    );

    const res = await store.generate(baseInput());
    await store.whenIdle();

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('rolling-window');
    expect(runPromptAgent).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
    // D21: 拒绝 = 不建记录（那一格落到「无记录」，渲染成手动按钮），**不是丢弃标记**
    expect(await getSceneImagesByMessage(SAVE, 'msg_1')).toHaveLength(0);
  });

  it('每条消息上限用的是设置里的值（L1），同回合去重只拦 auto（L3）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          settings: () => makeSettings({ imageNovelai: makeNovelai({ maxPerMessage: 1 }) }),
        }),
      ),
    );

    expect((await store.generate(baseInput())).ok).toBe(true);
    await store.whenIdle();

    // 同一条消息的第二张：L1 拦下
    const second = await store.generate(baseInput({ occurrence: 1 }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('per-message');

    // 手动档同样被 L1 拦（差别在调用方怎么处置，不在判定），且照样不建记录
    const manual = await store.generate(baseInput({ occurrence: 1, source: 'manual' }));
    expect(manual.ok).toBe(false);
    expect(await getSceneImagesByMessage(SAVE, 'msg_1')).toHaveLength(1);
  });
});

// ═══ 端点与失败 ═══

describe('端点缺失与上游失败', () => {
  it('没选出图端点时不发请求，记录落 failed 并说清楚要去哪儿选', async () => {
    const sendImage = vi.fn(async () => okSend());
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          settings: () => makeSettings({ imageNovelai: makeNovelai({ endpointId: null }) }),
          sendImage,
        }),
      ),
    );

    const res = await store.generate(baseInput());
    await store.whenIdle();

    expect(res.ok).toBe(true);
    expect(sendImage).not.toHaveBeenCalled();
    const row = (await getSceneImagesByMessage(SAVE, 'msg_1'))[0];
    expect(row.status).toBe('failed');
    expect(row.errorKind).toBe('auth');
    expect(row.error).toContain('出图端点');
  });

  it('上游失败原样落进记录（不猜、不重试）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          sendImage: async () => ({
            ok: false as const,
            kind: 'payment' as const,
            message: 'Anlas 不足，或这次的尺寸/步数超出了免费额度',
            retryable: false,
          }),
        }),
      ),
    );

    const res = await store.generate(baseInput());
    await store.whenIdle();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = await getSceneImage(res.id);
    expect(row?.status).toBe('failed');
    expect(row?.errorKind).toBe('payment');
  });

  it('令牌取自选中的那条 API 池记录，**地址一概不传**', async () => {
    const sendImage = vi.fn(async (_opts: NaiGenerateOptions) => okSend());
    const store = useSceneImageStore();
    await store.load(SAVE);
    // 记录里带一个**填错的**地址：出图端点填 `api.novelai.net` 是真机踩过的坑，
    // 上游会把它报成「模型枚举非法」。这一条钉住它连传都不会被传下去。
    const settings = makeSettings();
    settings.apiPool[0]!.baseUrl = 'https://api.novelai.net';
    store.setSeams(buildSceneImageSeams(makeDeps({ sendImage, settings: () => settings })));

    await store.generate(baseInput());
    await store.whenIdle();

    expect(sendImage).toHaveBeenCalledTimes(1);
    const opts = sendImage.mock.calls[0][0];
    expect(opts.token).toBe('pst-token');
    // 🔴 不是「等于官方地址」而是**根本没有这个字段** —— 地址是 image-client 的常量，
    //    生产不给调用方留改它的口子（2026-08-05）
    expect(opts.baseUrl).toBeUndefined();
    // 三重冗余在 buildNaiRequest 里保证；这里只钉「发出去的正是装配好的那份」
    expect(opts.body.input).toBe(opts.body.parameters.v4_prompt.caption.base_caption);
  });
});

// ═══ provider 分叉（图像 v2 / C1·C9·C16）═══

describe('provider 分叉', () => {
  it('comfyui 档走 ComfyUI 客户端，**一次端点池都不查**（C16），值来自 imageComfy 那一袋', async () => {
    const sendImage = vi.fn(async () => okSend());
    const sendComfy = vi.fn(async (_opts: ComfyGenerateOptions) => okSend());
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          sendImage,
          sendComfy,
          // 🔴 池里一条都没有、端点也没选：NAI 那条路会在这里落 auth 失败，
          //    而 ComfyUI 的地址根本不住在池里（C16）—— 它必须照发不误
          settings: () =>
            makeSettings({
              imageProvider: 'comfyui',
              apiPool: [],
              imageNovelai: makeNovelai({ endpointId: null }),
              imageComfy: makeComfy({
                baseUrl: 'http://127.0.0.1:9999',
                workflowJson: '{"1":{}}',
                timeoutMs: 42_000,
                pollIntervalMs: 7,
              }),
            }),
        }),
      ),
    );

    const res = await store.generate(baseInput());
    expect(res.ok).toBe(true);
    await store.whenIdle();

    expect(sendImage).not.toHaveBeenCalled();
    expect(sendComfy).toHaveBeenCalledTimes(1);
    const opts = sendComfy.mock.calls[0][0];
    expect(opts.baseUrl).toBe('http://127.0.0.1:9999');
    expect(opts.workflowJson).toBe('{"1":{}}');
    expect(opts.timeoutMs).toBe(42_000);
    expect(opts.pollIntervalMs).toBe(7);
    expect(opts.values.width).toBe(1216);
    expect(opts.values.height).toBe(832);
    expect(opts.values.steps).toBe(23);
    expect(opts.values.scale).toBe(4.5);
    // 🔴 seed 由本层定死并**如实落库**：客户端那个时钟兜底回不到账本里，
    //    而「照原样再画一张」正是重画的全部意义
    expect(typeof opts.values.seed).toBe('number');
    expect(opts.seedFallback).toBe(opts.values.seed);

    const row = (await getSceneImagesByMessage(SAVE, 'msg_1'))[0];
    expect(row.status).toBe('done');
    expect(row.model).toBe('comfyui');
    expect(row.seed).toBe(opts.values.seed);
    expect(row.positive).toBe(opts.values.positive);
    expect(row.negative).toBe(opts.values.negative);
    expect(row.params).toMatchObject({ width: 1216, steps: 23, workflow: 'custom' });
  });

  it('🔴 ComfyUI 的格式照上游声明落库（webp 工作流不能被记成 png）', async () => {
    const sendComfy = vi.fn(async (_opts: ComfyGenerateOptions) => ({
      ok: true as const,
      images: [fakeImage()],
      // 用户的图以 SaveAnimatedWEBP 收尾时 `/view` 就是这么报的
      contentType: 'image/webp',
    }));
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({ sendComfy, settings: () => makeSettings({ imageProvider: 'comfyui' }) }),
      ),
    );

    await store.generate(baseInput());
    await store.whenIdle();

    // 记成 image/png 的话，CG 图鉴按 mime 派生的下载扩展名会给出一个打不开的 .png
    expect((await getSceneImagesByMessage(SAVE, 'msg_1'))[0].mime).toBe('image/webp');
  });

  it('上游没说清楚（空 / octet-stream / 带参数）时的类型口径', async () => {
    const store = useSceneImageStore();

    async function mimeFor(contentType: string, messageId: string): Promise<string | undefined> {
      const sendComfy = vi.fn(async (_opts: ComfyGenerateOptions) => ({
        ok: true as const,
        images: [fakeImage()],
        contentType,
      }));
      store.setSeams(
        buildSceneImageSeams(
          makeDeps({ sendComfy, settings: () => makeSettings({ imageProvider: 'comfyui' }) }),
        ),
      );
      // turn 每次换一个：同回合已有 auto 记录会被 L3 拦下（那一层与格式无关）
      await store.generate(baseInput({ messageId, turn: Number(messageId.slice(-1)) + 10 }));
      await store.whenIdle();
      return (await getSceneImagesByMessage(SAVE, messageId))[0].mime;
    }

    await store.load(SAVE);
    // 空 = 没线索 → PNG（v1 的形态）
    expect(await mimeFor('', 'msg_1')).toBe('image/png');
    // 认不出的形态照样回落：存一个派生不出扩展名的类型比偶尔猜错更糟
    expect(await mimeFor('application/octet-stream', 'msg_2')).toBe('image/png');
    // 参数与大小写剃掉，落库的是能直接比对的那种写法
    expect(await mimeFor('Image/JPEG; charset=binary', 'msg_3')).toBe('image/jpeg');
  });

  it('NAI 那条恒记 image/png —— content-type 说什么都不算数（它回的是 zip）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        // okSend() 报的是 `application/x-zip-compressed`，照抄就把整条 NAI 记错
        makeDeps({ sendImage: async () => okSend() }),
      ),
    );

    await store.generate(baseInput());
    await store.whenIdle();

    expect((await getSceneImagesByMessage(SAVE, 'msg_1'))[0].mime).toBe('image/png');
  });

  it('工作流粘贴框为空 = 用内置图（C11）：**不传** workflowJson，而不是传一个空串', async () => {
    const sendComfy = vi.fn(async (_opts: ComfyGenerateOptions) => okSend());
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({ sendComfy, settings: () => makeSettings({ imageProvider: 'comfyui' }) }),
      ),
    );

    await store.generate(baseInput());
    await store.whenIdle();

    expect(sendComfy.mock.calls[0][0].workflowJson).toBeUndefined();
    const row = (await getSceneImagesByMessage(SAVE, 'msg_1'))[0];
    expect(row.params).toMatchObject({ workflow: 'builtin' });
  });

  it('🔴 comfyui（local）不受 L1/L2 限额约束，但 L3 同回合去重照样开火（C9）', async () => {
    const sendComfy = vi.fn(async (_opts: ComfyGenerateOptions) => okSend());
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          sendComfy,
          settings: () =>
            makeSettings({
              imageProvider: 'comfyui',
              // 这两个数放在 NAI 袋里，且恒拒 —— local 下它们一格都不该被读
              imageNovelai: makeNovelai({ maxPerMessage: 0, maxPerHour: 0 }),
            }),
        }),
      ),
    );

    // 手动档：L1/L2 不启用 → 连开三张都放行
    for (const occurrence of [0, 1, 2]) {
      const res = await store.generate(baseInput({ occurrence, source: 'manual' }));
      expect(res.ok, `第 ${occurrence + 1} 张`).toBe(true);
    }
    await store.whenIdle();
    expect(sendComfy).toHaveBeenCalledTimes(3);

    // 自动档：同一回合已经有 auto 记录时被 L3 拦下（正确性规则，与谁付钱无关）
    await store.generate(baseInput({ occurrence: 3, source: 'auto' }));
    await store.whenIdle();
    const again = await store.generate(baseInput({ occurrence: 4, source: 'auto' }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('same-turn');
  });

  it('🔴 本地画过的图不占付费预算：切回 NAI 的第一张不该被自己的免费图拦下（C9）', async () => {
    // 评审复现的那一幕：ComfyUI 免费连画 3 张（每小时上限 2），切回 NovelAI 想画第一张
    // 付费图 —— 修之前这里会报「已达本小时上限（3/2）」，而账单上一分钱都没花过。
    const box = { provider: 'comfyui' as 'comfyui' | 'novelai' };
    const sendImage = vi.fn(async (_opts: NaiGenerateOptions) => okSend());
    const sendComfy = vi.fn(async (_opts: ComfyGenerateOptions) => okSend());
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          sendImage,
          sendComfy,
          settings: () =>
            makeSettings({
              imageProvider: box.provider,
              imageNovelai: makeNovelai({ maxPerMessage: 2, maxPerHour: 2 }),
            }),
        }),
      ),
    );

    for (const occurrence of [0, 1, 2]) {
      const res = await store.generate(
        baseInput({ messageId: `local_${occurrence}`, occurrence, source: 'manual' }),
      );
      expect(res.ok, `本地第 ${occurrence + 1} 张`).toBe(true);
    }
    await store.whenIdle();
    expect(sendComfy).toHaveBeenCalledTimes(3);

    // 用户切回 NovelAI
    box.provider = 'novelai';
    const paid = await store.generate(baseInput({ messageId: 'paid_1', source: 'manual' }));
    expect(paid.ok).toBe(true);
    await store.whenIdle();
    expect(sendImage).toHaveBeenCalledTimes(1);

    // 反向：付费那张之后再来一张，L2 照样按付费记录算（这一层没有被整条关掉）
    const again = await store.generate(baseInput({ messageId: 'paid_2', source: 'auto', turn: 9 }));
    expect(again.ok).toBe(true);
    await store.whenIdle();
    const third = await store.generate(
      baseInput({ messageId: 'paid_3', source: 'auto', turn: 10 }),
    );
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe('rolling-window');
  });

  it('🔴 排队途中换后端，已入队的那些仍走它准入时那条（否则等于没过闸）', async () => {
    // 本地渲染一张 600 秒是常态，队列排得很长。这中间把后端切成 NovelAI 的话，
    // 读当下设置的实现会把队列里每一条都改道发去 NAI —— 而它们准入时走的是 local 那条，
    // L1/L2 一次都没判过。准入时的状态管这条记录的一辈子。
    const box = { provider: 'comfyui' as 'comfyui' | 'novelai' };
    const started = deferredVoid();
    const release = deferredResult();
    let comfyCalls = 0;
    const sendImage = vi.fn(async (_opts: NaiGenerateOptions) => okSend());
    const sendComfy = vi.fn(async (_opts: ComfyGenerateOptions) => {
      comfyCalls += 1;
      if (comfyCalls === 1) {
        started.resolve();
        return release.promise;
      }
      return okSend();
    });
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          sendImage,
          sendComfy,
          settings: () => makeSettings({ imageProvider: box.provider }),
        }),
      ),
    );

    expect((await store.generate(baseInput({ occurrence: 0, source: 'manual' }))).ok).toBe(true);
    expect((await store.generate(baseInput({ occurrence: 1, source: 'manual' }))).ok).toBe(true);

    // 第一张已经在飞，第二张还排着 —— 这时用户去设置页把后端切成 NovelAI
    await started.promise;
    box.provider = 'novelai';
    release.resolve(okSend());
    await store.whenIdle();

    expect(sendComfy).toHaveBeenCalledTimes(2);
    // 🔴 一次都不许流到付费后端去
    expect(sendImage).not.toHaveBeenCalled();
    const rows = await getSceneImagesByMessage(SAVE, 'msg_1');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('done');
      // 账本记的是真正发出去的那一份（Q-21）：两条都该说 comfyui
      expect(row.model).toBe('comfyui');
      expect(row.provider).toBe('comfyui');
    }
  });

  it('🔴 排队途中换方言，手改过提示词的那条仍按它盖的章装配（提示词与契约同源）', async () => {
    // 侧链不重跑的两条路（用户手改 / 缓存命中）里，装配契约必须跟着记录走：
    // 读当下设置的话，手里攥着一串 danbooru 标签，尾巴上却接了散文档那套构图词。
    const box = { dialectId: 'danbooru-anime' };
    const started = deferredVoid();
    const release = deferredResult();
    let calls = 0;
    const sendImage = vi.fn(async (_opts: NaiGenerateOptions) => {
      calls += 1;
      if (calls === 2) {
        started.resolve();
        return release.promise;
      }
      return okSend();
    });
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          sendImage,
          rawDialects: () => RAW_DIALECTS,
          settings: () =>
            makeSettings({
              imageDialectId: box.dialectId,
              // 同一条消息上要放下 3 个 take，别被 L1 拦住（这条测的不是限额）
              imageNovelai: makeNovelai({ maxPerMessage: 10 }),
            }),
        }),
      ),
    );

    const first = await store.generate(baseInput({ source: 'manual' }));
    await store.whenIdle();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 用户在图鉴里亲手改了提示词 → 后续重画都走「不跑侧链」那条路（D26）
    await store.update(first.id, { editedScenePrompt: '手写的 danbooru 串' });

    const second = await store.generate(baseInput({ source: 'manual', redrawFrom: first.id }));
    const third = await store.generate(baseInput({ source: 'manual', redrawFrom: first.id }));
    expect(second.ok && third.ok).toBe(true);
    if (!third.ok) return;

    // 第二张在飞、第三张排队时，用户把方言换成散文档
    await started.promise;
    box.dialectId = 'natural-prose';
    release.resolve(okSend());
    await store.whenIdle();

    const row = await getSceneImage(third.id);
    expect(row?.status).toBe('done');
    expect(row?.dialectId).toBe('danbooru-anime');
    // 仍按 danbooru 装配：画质后缀在、分级段在、散文档的构图词不在
    expect(row?.positive.endsWith(DEFAULT_IMAGE_QUALITY_SUFFIX)).toBe(true);
    expect(row?.positive).toContain('rating:general');
    expect(row?.positive).not.toContain('cinematic composition');
  });

  it('novelai 档（默认）分毫未变：仍查端点池、仍走 NAI 客户端', async () => {
    const sendComfy = vi.fn(async (_opts: ComfyGenerateOptions) => okSend());
    const sendImage = vi.fn(async (_opts: NaiGenerateOptions) => okSend());
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(buildSceneImageSeams(makeDeps({ sendImage, sendComfy })));

    await store.generate(baseInput());
    await store.whenIdle();

    expect(sendComfy).not.toHaveBeenCalled();
    expect(sendImage).toHaveBeenCalledTimes(1);
    expect(sendImage.mock.calls[0][0].token).toBe('pst-token');
  });
});

// ═══ 方言（图像 v2 / C3·C6·C14）═══

describe('方言解析与取用', () => {
  it('注册表这一面缺席时退化成图像 v1 的行为（不崩、不空）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    // makeDeps 刻意不给 rawDialects —— 这正是「没接注册表」那条路
    store.setSeams(buildSceneImageSeams(makeDeps()));

    await store.generate(baseInput());
    await store.whenIdle();

    const row = (await getSceneImagesByMessage(SAVE, 'msg_1'))[0];
    expect(row.positive.endsWith(DEFAULT_IMAGE_QUALITY_SUFFIX)).toBe(true);
    expect(row.negative).toContain(DEFAULT_IMAGE_BASE_NEGATIVE);
  });

  it('换方言 = 换整套装配契约（不只是换一句 systemPrompt，C3）', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          rawDialects: () => RAW_DIALECTS,
          settings: () => makeSettings({ imageDialectId: 'natural-prose' }),
        }),
      ),
    );

    await store.generate(baseInput());
    await store.whenIdle();

    const row = (await getSceneImagesByMessage(SAVE, 'msg_1'))[0];
    // 画质后缀是空串、分级段不出、构图词换成散文档那份
    expect(row.positive).not.toContain(DEFAULT_IMAGE_QUALITY_SUFFIX);
    expect(row.positive).not.toContain('rating:');
    expect(row.positive).toContain('cinematic composition');
    // supportsNegative:false → 负向发空串，不是发一段没人读的文字
    expect(row.negative).toBe('');
  });

  it('用户覆盖按方言 id 键控：改了 danbooru 那条，散文档一个字都不受影响（C6）', async () => {
    const overrides = { 'danbooru-anime': { qualitySuffix: '我的尾巴' } };
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          rawDialects: () => RAW_DIALECTS,
          settings: () =>
            makeSettings({ imageDialectId: 'natural-prose', imageDialectOverrides: overrides }),
        }),
      ),
    );

    await store.generate(baseInput());
    await store.whenIdle();
    expect((await getSceneImagesByMessage(SAVE, 'msg_1'))[0].positive).not.toContain('我的尾巴');
  });

  it('runtimeInfo 报的是当下的后端与方言（store 拿它给记录盖章，C14）', () => {
    const seams = buildSceneImageSeams(
      makeDeps({
        rawDialects: () => RAW_DIALECTS,
        settings: () => makeSettings({ imageProvider: 'comfyui', imageDialectId: 'natural-prose' }),
      }),
    );
    expect(seams.runtimeInfo?.()).toEqual({ provider: 'comfyui', dialectId: 'natural-prose' });

    // 设置里存着一个内容包里已经不存在的 id → 落到清单里的 danbooru（不是崩、不是空）
    const stale = buildSceneImageSeams(
      makeDeps({
        rawDialects: () => RAW_DIALECTS,
        settings: () => makeSettings({ imageDialectId: '早就没有这条了' }),
      }),
    );
    expect(stale.runtimeInfo?.()).toEqual({ provider: 'novelai', dialectId: 'danbooru-anime' });
  });

  it('侧链收到的是**当前方言**的 systemPrompt；注册表缺席时收到的是兜底那段 v1 原文', async () => {
    const calls: (string | undefined)[] = [];
    const runPromptAgent = async (
      _req: ImagePromptRequest,
      _signal: AbortSignal,
      systemPrompt?: string,
    ) => {
      calls.push(systemPrompt);
      return { scenePrompt: 'x', sceneNegative: '', desc: '' };
    };
    const store = useSceneImageStore();
    await store.load(SAVE);

    store.setSeams(
      buildSceneImageSeams(
        makeDeps({
          runPromptAgent,
          rawDialects: () => RAW_DIALECTS,
          settings: () => makeSettings({ imageDialectId: 'natural-prose' }),
        }),
      ),
    );
    await store.generate(baseInput());
    await store.whenIdle();

    // 注册表缺席 → 兜底方言，它**自带 v1 那段完整提示词**（2026-08-08 修：此前是空串，
    // 于是这条路上的侧链跑在 agent-templates 的一行 stub 上，五条 v1 规则一条不剩）
    // turn 换一个：同一回合已经有 auto 记录时会被 L3 拦下（那一层与方言无关）
    store.setSeams(buildSceneImageSeams(makeDeps({ runPromptAgent })));
    await store.generate(baseInput({ messageId: 'msg_2', turn: 4 }));
    await store.whenIdle();

    expect(calls).toEqual([
      '写成英文句子。<image_prompt></image_prompt>',
      DEFAULT_IMAGE_PROMPT_SYSTEM,
    ]);
  });
});

// ═══ 装配告警（C15）═══

describe('composeWarnings 落库（告警得有人消费）', () => {
  it('没有预设的角色被跳过时，告警一路落进记录', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(buildSceneImageSeams(makeDeps({ presets: () => [] })));

    await store.generate(baseInput());
    await store.whenIdle();

    const row = (await getSceneImagesByMessage(SAVE, 'msg_1'))[0];
    expect(row.status).toBe('done');
    expect(row.composeWarnings).toEqual([{ kind: 'missing-preset', name: '苏婉' }]);
  });

  it('一切正常时这一格**缺席**，不是一个空数组', async () => {
    const store = useSceneImageStore();
    await store.load(SAVE);
    store.setSeams(buildSceneImageSeams(makeDeps()));

    await store.generate(baseInput());
    await store.whenIdle();

    expect((await getSceneImagesByMessage(SAVE, 'msg_1'))[0].composeWarnings).toBeUndefined();
  });
});

// ═══ 天气读法 ═══

describe('resolveSceneWeather（与 ScenePanel 同口径）', () => {
  it('变量真源优先，worldFlags 兜旧存档', () => {
    expect(resolveSceneWeather({ variables: { sys: { 天气: '小雨' } } })).toBe('小雨');
    expect(resolveSceneWeather({ worldFlags: { 天气: '大雪' } })).toBe('大雪');
    expect(resolveSceneWeather({ worldFlags: { weather: '晴' } })).toBe('晴');
    expect(
      resolveSceneWeather({ variables: { sys: { 天气: '小雨' } }, worldFlags: { 天气: '大雪' } }),
    ).toBe('小雨');
  });

  it('查不到 / 空串一律 undefined（不贡献标签，绝不猜）', () => {
    expect(resolveSceneWeather(null)).toBeUndefined();
    expect(resolveSceneWeather(undefined)).toBeUndefined();
    expect(resolveSceneWeather({})).toBeUndefined();
    expect(resolveSceneWeather({ variables: { sys: { 天气: '   ' } } })).toBeUndefined();
  });
});
