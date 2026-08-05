/**
 * scene-image-gameplay.test.ts —— 游玩链路的**后半段**，一个替身都不给中间层
 *
 * 🔴 这个文件存在的理由与 `scene-image-chain.test.ts` 同源，但方向相反：那边验的是
 * 「设置 → 正文那一格」的 **prop 链**（渲染面），这边验的是「story 吐出一段带标记的
 * 正文 → 真的有字节落进 Dexie → 那一格解析成 done」的**执行链**。
 *
 * 此前每一层都有单测、**层与层之间没有任何测试**，于是这类缺陷全部可以躲过全绿：
 *   - 分段编号与落库 occurrence 不同源 → 图挂到隔壁那一格（两边各自测都对）
 *   - 限额判定跑在侧链之后 → 被拦下的图照样烧掉一次 LLM 调用（D32）
 *   - 角色/地点预设在 seams 里没接上 → 出的图没有人物特征（composePrompt 单测照样绿）
 *
 * **被替身的只有两个真实世界的边界**：`image_prompt` 侧链（一次 LLM 调用）与
 * NAI 出图（一次网络 + 花钱）。中间的 `image-quota` / `composePrompt` /
 * `buildNaiRequest` / `scene-image-store` / Dexie / `resolveSceneImageView`
 * **全是真的**。真上游那一版在 `tmp/nai-live/`（会花钱，不进仓库）。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';

import { scanSceneImages, stripMarkers } from '@engine/marker-protocol';
import { splitSceneImageSegments } from '@engine/image-segments';
import { DEFAULT_IMAGE_BASE_NEGATIVE, DEFAULT_IMAGE_QUALITY_SUFFIX } from '@engine/image-defaults';
import type { ImagePreset, ImagePromptRequest } from '@engine/types-image';
import { buildSceneImageSeams, type ImageRuntimeSettings } from './scene-image-seams';
import { useSceneImageStore } from '../stores/scene-image-store';
import { resolveSceneImageView } from '../components/game/scene-image-view';

// ═══════════════════════════════════════════════════════════
// 一段 story 真会吐出来的正文（两个标记，中间夹叙述）
// ═══════════════════════════════════════════════════════════

const STORY_TEXT =
  '雨声敲在彩窗上。\n' +
  '<scene_image title="回廊尽头的等待" characters="艾莉丝">' +
  '白发少女独自站在彩窗前，烛火在她身后摇曳' +
  '</scene_image>\n' +
  '她没有回头。良久，脚步声从长廊另一端传来。\n' +
  '<scene_image title="不速之客">空无一人的石廊，唯有烛火与雨</scene_image>\n' +
  '那声音停住了。';

const SAVE_ID = 'save_gameplay';
const MESSAGE_ID = 'msg_42';
const TURN = 7;

/** 一张最小 PNG（魔数对即可 —— 本文件不验图像内容，只验字节有没有走通） */
function fakePng(seed = 1): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([...head, ...Array.from({ length: 64 }, (_, i) => (i * seed) % 251)]);
}

const PRESETS: ImagePreset[] = [
  {
    key: 'character:艾莉丝',
    kind: 'character',
    name: '艾莉丝',
    dialects: { danbooru: { positive: 'silver hair, golden eyes', negative: 'short hair' } },
    createdAt: 0,
    updatedAt: 0,
  },
  {
    key: 'location:黄昏回廊',
    kind: 'location',
    name: '黄昏回廊',
    dialects: { danbooru: { positive: 'stone corridor, stained glass', negative: 'modern' } },
    createdAt: 0,
    updatedAt: 0,
  },
];

function settingsSnapshot(over: Partial<ImageRuntimeSettings> = {}): ImageRuntimeSettings {
  return {
    apiPool: [
      {
        id: 'ep_nai',
        name: 'NAI',
        apiType: 'image',
        baseUrl: 'https://image.novelai.net',
        apiKey: 'tk',
      },
    ] as ImageRuntimeSettings['apiPool'],
    imageEndpointId: 'ep_nai',
    imageModel: 'nai-diffusion-4-5-full',
    imageQualitySuffix: DEFAULT_IMAGE_QUALITY_SUFFIX,
    imageBaseNegative: DEFAULT_IMAGE_BASE_NEGATIVE,
    imageExtraNegative: '',
    imageMaxRating: 'sensitive',
    imageWidth: 1216,
    imageHeight: 832,
    imageSteps: 23,
    imageScale: 4.5,
    imageSampler: 'k_euler_ancestral',
    imageNoiseSchedule: 'karras',
    imageUcPreset: 0,
    imageMaxPerMessage: 2,
    imageMaxPerHour: 20,
    ...over,
  };
}

/**
 * 把 store 接上真 seams。返回两个探针：
 * - `promptCalls` —— 侧链被调了几次、每次收到什么（D32 的判据）
 * - `sendCalls`   —— 真正发出去的请求体（角色槽/世界标签有没有进去）
 */
function wire(over: Partial<ImageRuntimeSettings> = {}) {
  const promptCalls: ImagePromptRequest[] = [];
  const sendCalls: Parameters<
    NonNullable<Parameters<typeof buildSceneImageSeams>[0]['sendImage']>
  >[0][] = [];

  const seams = buildSceneImageSeams({
    settings: () => settingsSnapshot(over),
    presets: () => PRESETS,
    world: () => ({
      gameTime: { era: '复兴纪元', year: 512, month: 4, day: 12, weekday: 3, hour: 22, minute: 0 },
      weather: '小雨',
      location: '黄昏回廊',
    }),
    runPromptAgent: async (req) => {
      promptCalls.push(req);
      // 侧链真实产物的形状：中文 intent → danbooru 串
      return {
        scenePrompt: '1girl, standing, looking away, window, candlelight',
        sceneNegative: '',
        // 🔴 侧链**不收 title**（标题必须来自 story，D30）—— 它只拿 intent/characters/
        //    narrative/location/rating。这里跟着契约走，别顺手编一个 req.title
        title: '',
        desc: '',
      } as Awaited<
        ReturnType<NonNullable<Parameters<typeof buildSceneImageSeams>[0]['runPromptAgent']>>
      >;
    },
    sendImage: async (input) => {
      sendCalls.push(input);
      return { ok: true, images: [fakePng(sendCalls.length)], contentType: 'binary/octet-stream' };
    },
    hashBytes: async () => 'deadbeef',
  });

  const store = useSceneImageStore();
  store.setSeams(seams);
  return { store, promptCalls, sendCalls };
}

/** 自动档那一轮做的事，逐字照抄 `GamePipeline.handleSceneImages` 的循环 */
async function playOneTurn(store: ReturnType<typeof wire>['store'], text = STORY_TEXT) {
  const segments = splitSceneImageSegments(text);
  const narrative = stripMarkers(text).trim();

  for (const segment of segments) {
    if (segment.kind !== 'image') continue;
    await store.generate({
      saveId: SAVE_ID,
      messageId: MESSAGE_ID,
      turn: TURN,
      anchorKind: 'marker',
      occurrence: segment.occurrence,
      source: 'auto',
      intent: segment.marker.bodyText,
      title: segment.marker.title,
      characters: segment.marker.characters,
      rating: segment.marker.rating ?? 'sensitive',
      narrative,
      location: '黄昏回廊',
    });
  }
  await store.whenIdle();
  return segments;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  const store = useSceneImageStore();
  await store.load(SAVE_ID);
  // 🔴 先快照再删：`store.records` 是活的，边遍历边删会隔一个漏一个 ——
  //    症状是下一个用例莫名其妙被限额拦住（上一轮的记录还在库里）
  for (const r of [...store.records]) await store.remove(r.id);
  expect(store.records).toHaveLength(0);
  vi.restoreAllMocks();
});

describe('story 正文 → 标记 → 分段编号（渲染与落库必须同源）', () => {
  it('两个标记都被认出来，标题/角色/正文按 story 写的原样带出', () => {
    const markers = scanSceneImages(STORY_TEXT);
    expect(markers).toHaveLength(2);
    expect(markers[0].title).toBe('回廊尽头的等待');
    expect(markers[0].characters).toEqual(['艾莉丝']);
    expect(markers[0].bodyText).toContain('白发少女');
    // 第二个标记没写 characters → 空数组（不是 undefined，下游要直接 map）
    expect(markers[1].characters).toEqual([]);
  });

  it('🔴 分段编号从 splitSceneImageSegments 来 —— 自己数 markers 会在有空标记时错位', () => {
    const segments = splitSceneImageSegments(STORY_TEXT);
    const images = segments.filter((s) => s.kind === 'image');
    expect(images.map((s) => s.occurrence)).toEqual([0, 1]);
    // 文本段没被吃掉：标记之间的叙述仍要照常渲染
    expect(segments.filter((s) => s.kind === 'text').length).toBeGreaterThan(0);
  });

  it('喂给侧链的 narrative 是**剥掉全部标记**的正文', () => {
    const narrative = stripMarkers(STORY_TEXT);
    expect(narrative).not.toContain('<scene_image');
    expect(narrative).toContain('她没有回头');
  });
});

describe('自动档一轮：**只**自动画第一张，其余留成按钮（D23 同回合去重）', () => {
  /**
   * 🔴 这条是本文件最该有的一个断言，也是最容易被想当然写反的一个。
   *
   * story 一回合可以插好几个标记，而**自动档一回合只自动出一张**（`image-quota` 的 L3，
   * 只对 `auto` 生效）。默认 `imageMaxPerMessage: 2` 描述的是**每条消息**的总额，
   * 管的主要是手动追加；它不会让自动档在同一回合连开两枪。
   *
   * 于是「两个标记 → 两张图」是**错的期待**：正确结果是一张图 + 一个按钮。
   * 把它写成 2 张，就等于把一条防超支的规则当 bug 修掉。
   */
  it('两个标记 → 第一格出图、第二格留按钮，且 occurrence 对得上分段编号', async () => {
    const { store, promptCalls, sendCalls } = wire();
    await playOneTurn(store);

    expect(promptCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(1);

    const first = store.displayedAt(MESSAGE_ID, 'marker', 0);
    const second = store.displayedAt(MESSAGE_ID, 'marker', 1);
    expect(first?.status).toBe('done');
    expect(first?.title).toBe('回廊尽头的等待');
    // 第二格没有记录 —— 渲染层据此画手动按钮（D21：拦下不等于丢弃）
    expect(second).toBeUndefined();
    expect(
      resolveSceneImageView({
        mode: 'auto',
        record: second,
        marker: { title: '不速之客', bodyText: '空无一人的石廊' },
        now: Date.now(),
      }).kind,
    ).toBe('offer');

    // 字节真的落进了 Dexie，不只是记录行
    // 🔴 只断言「取得回来」：fake-indexeddb 取回的是结构化克隆，在 jsdom 下既不保证
    //    `instanceof Blob`，`.size` 也可能读不到（`scene-image-store.test.ts` 同口径，
    //    那边也只 `toBeDefined`）。**体积与 mime 改从记录上验** —— 那两个字段本来就是
    //    写入时从 blob 上回读的，正是账本该记住的东西。
    expect(await store.blobOf(first!.id)).toBeDefined();
    expect(first!.bytes).toBeGreaterThan(0);
    expect(first!.mime).toBe('image/png');
    expect(first!.hash).toBe('deadbeef');

    // 渲染层拿到的就是 done 那一支
    const view = resolveSceneImageView({ mode: 'auto', record: first, now: Date.now() });
    expect(view.kind).toBe('done');
  });

  it('🔴 角色预设进的是**角色槽**，地点预设与世界标签进 base', async () => {
    const { store, sendCalls } = wire();
    await playOneTurn(store);

    // 第二格自动档不会开火（D23），玩家点按钮才画 —— 顺带把手动那条路也走一遍
    await store.generate({
      saveId: SAVE_ID,
      messageId: MESSAGE_ID,
      turn: TURN,
      anchorKind: 'marker',
      occurrence: 1,
      source: 'manual',
      intent: '空无一人的石廊，唯有烛火与雨',
      title: '不速之客',
      characters: [],
      rating: 'sensitive',
      location: '黄昏回廊',
    });
    await store.whenIdle();
    expect(sendCalls).toHaveLength(2);

    const withChar = sendCalls[0].body;
    expect(withChar.parameters.characterPrompts).toHaveLength(1);
    expect(withChar.parameters.characterPrompts[0].prompt).toContain('silver hair');
    // 角色负向留在自己的槽里，绝不并进全局负向（官方的抗串味手段）
    expect(withChar.parameters.characterPrompts[0].uc).toContain('short hair');
    expect(withChar.parameters.negative_prompt).not.toContain('short hair');

    // 地点预设 + 由 Code 推出的时段/天气（D39：不问 AI）
    expect(withChar.input).toContain('stone corridor');
    expect(withChar.input).toContain('night');
    expect(withChar.input).toContain('rain');
    // rating 被钳到设置上限
    expect(withChar.input).toContain('rating:sensitive');

    // 第二个标记没有出场角色 → 空数组，且 v4 信封照发
    const noChar = sendCalls[1].body;
    expect(noChar.parameters.characterPrompts).toEqual([]);
    expect(noChar.parameters.v4_prompt.caption.char_captions).toEqual([]);
  });

  it('账本记的是**真正发出去的**那份提示词，不是设置里再算一遍', async () => {
    const { store, sendCalls } = wire();
    await playOneTurn(store);

    const record = store.displayedAt(MESSAGE_ID, 'marker', 0)!;
    expect(record.positive).toBe(sendCalls[0].body.input);
    expect(record.negative).toBe(sendCalls[0].body.parameters.negative_prompt);
    expect(record.model).toBe('nai-diffusion-4-5-full');
  });
});

describe('🔴 D32：限额在 image_prompt 侧链之前 —— 被拦下的图不许烧掉一次 LLM 调用', () => {
  it('每条消息上限为 1 时，第二个标记既不发请求**也不调侧链**', async () => {
    const { store, promptCalls, sendCalls } = wire({ imageMaxPerMessage: 1 });
    await playOneTurn(store);

    expect(promptCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(1);
  });

  it('D21：被限额拦下不产生记录 → 那一格落到「无记录」，渲染成手动按钮而不是消失', async () => {
    const { store } = wire({ imageMaxPerMessage: 1 });
    await playOneTurn(store);

    const second = store.displayedAt(MESSAGE_ID, 'marker', 1);
    expect(second).toBeUndefined();

    const view = resolveSceneImageView({
      mode: 'auto',
      record: second,
      marker: { title: '不速之客', bodyText: '空无一人的石廊' },
      now: Date.now(),
    });
    // 🔴 auto 也出按钮，不是「没记录就补一张」—— 那条会追溯烧钱
    expect(view.kind).toBe('offer');
  });
});

describe('失败不悬挂', () => {
  it('上游失败 → 记录落 failed 并带上原因，不会永远停在 generating', async () => {
    const promptCalls: ImagePromptRequest[] = [];
    const seams = buildSceneImageSeams({
      settings: () => settingsSnapshot(),
      presets: () => PRESETS,
      world: () => ({}),
      runPromptAgent: async (req) => {
        promptCalls.push(req);
        return { scenePrompt: 'x', sceneNegative: '', title: '', desc: '' } as never;
      },
      sendImage: async () => ({
        ok: false,
        kind: 'rate-limit',
        message: 'NovelAI 限流了，过一会儿再试',
        retryable: true,
      }),
    });

    const store = useSceneImageStore();
    store.setSeams(seams);
    await playOneTurn(store, STORY_TEXT.split('</scene_image>')[0] + '</scene_image>');

    const record = store.displayedAt(MESSAGE_ID, 'marker', 0);
    expect(record?.status).toBe('failed');
    expect(record?.errorKind).toBe('rate-limit');

    const view = resolveSceneImageView({ mode: 'auto', record, now: Date.now() });
    expect(view.kind).toBe('failed');
  });
});
