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
import type { ImagePreset } from '@engine/types-image';
import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_COMPOSITION_TAGS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY_SUFFIX,
} from '@engine/image-defaults';
import type { NaiGenerateOptions, NaiGenerateResult } from './image-client';
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
    imageDialectId: 'danbooru-anime',
    imageDialectOverrides: {},
    imageNovelai: makeNovelai(),
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
