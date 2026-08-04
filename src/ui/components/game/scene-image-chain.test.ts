/**
 * scene-image-chain.test.ts — 设置 → 正文那一格插画的**整条 prop 链**
 *
 * 🔴 这个文件存在的唯一理由: `SceneImageSegment.test.ts` 那种单组件测试**发现不了
 * 没接线**。`blurByDefault` 曾经在组件里声明好、默认值也对、揭开逻辑还有测试，
 * 但全仓没有任何人传它 —— D46 打码于是是死的，设置页能调、值到不了图上，而所有
 * 单组件测试照样全绿。
 *
 * 所以这里**一个组件都不 stub**，从 `ChatFlow` 开始真的渲染到 `.si-shot`:
 *
 *     settings.imageBlurByDefault
 *       → ChatFlow      :image-blur-by-default
 *       → BeautifiedNarrative  :blur-by-default（**两处** SceneImageSegment）
 *       → SceneImageSegment    .si-shot.is-blurred
 *
 * 被替身的只有**数据源**（Dexie 那两个 store），不是链路本身。
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';
import type { ChatMessage } from '@engine/types';
import type { SceneImageRecord } from '@engine/types-image';
import ChatFlow from './ChatFlow.vue';
import { useSettingsStore } from '../../stores/settings-store';

enableAutoUnmount(afterEach);

const scene = reactive({
  activeSaveId: 'save_1' as string | null,
  queue: [] as string[],
  records: [] as SceneImageRecord[],
  generate: vi.fn(async () => ({ ok: true as const, id: 'simg_new' })),
  cancel: vi.fn(async () => 'cancelled' as const),
  update: vi.fn(async () => undefined),
  pin: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  blobOf: vi.fn(async (): Promise<Blob | undefined> => new Blob(['x'], { type: 'image/png' })),
  byMessage(messageId: string): SceneImageRecord[] {
    return scene.records.filter((r) => r.messageId === messageId);
  },
  takesAt(messageId: string, anchorKind: string, occurrence: number): SceneImageRecord[] {
    return scene.records.filter(
      (r) =>
        r.messageId === messageId && r.anchorKind === anchorKind && r.occurrence === occurrence,
    );
  },
  displayedAt(
    messageId: string,
    anchorKind: string,
    occurrence: number,
  ): SceneImageRecord | undefined {
    const takes = scene.takesAt(messageId, anchorKind, occurrence);
    return takes[takes.length - 1];
  },
});

const presets = reactive({
  loading: false,
  init: vi.fn(async () => undefined),
  find: vi.fn(() => ({ name: '苏婉' })),
});

vi.mock('../../stores/scene-image-store', () => ({ useSceneImageStore: () => scene }));
vi.mock('../../stores/image-preset-store', () => ({ useImagePresetStore: () => presets }));

function record(over: Partial<SceneImageRecord> = {}): SceneImageRecord {
  return {
    id: 'simg_1',
    saveId: 'save_1',
    messageId: 'msg_1',
    anchorKind: 'marker',
    occurrence: 0,
    take: 0,
    turn: 3,
    status: 'done',
    source: 'auto',
    title: '雨夜的酒馆',
    description: '苏婉第一次说起她的家乡',
    intent: '苏婉坐在壁炉旁',
    scenePrompt: 'tavern interior',
    sceneNegative: '',
    characters: ['苏婉'],
    rating: 'general',
    positive: '1girl, tavern interior',
    negative: '',
    model: 'nai-diffusion-4-5-full',
    params: {},
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

const MESSAGES: ChatMessage[] = [
  {
    id: 'msg_1',
    role: 'assistant',
    content: '雨停了。<scene_image title="雨夜的酒馆">苏婉坐在壁炉旁</scene_image>她推开门。',
    timestamp: 0,
    turn: 3,
  },
];

/** 挂 ChatFlow 并等字节装载那一轮微任务兑现 */
async function mountFlow() {
  const wrapper = mount(ChatFlow, { props: { messages: MESSAGES } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe('打码设置 → 正文插画的整条 prop 链（D46）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    scene.records = [record(), record({ id: 'simg_2', anchorKind: 'message-end', occurrence: 0 })];
    Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => 'blob:scene-image'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('🔴 设置为真时，正文里的图默认糊着 —— 两处锚点都要（marker + message-end）', async () => {
    useSettingsStore().settings.imageBlurByDefault = true;

    const wrapper = await mountFlow();
    const shots = wrapper.findAll('.si-shot');

    // 两处 SceneImageSegment 都渲染出来了（改一处漏一处的话这里是 1）
    expect(shots).toHaveLength(2);
    expect(shots.every((s) => s.classes().includes('is-blurred'))).toBe(true);
    expect(wrapper.text()).toContain('点击显示');
  });

  it('设置为假时一张都不糊 —— 证明糊不糊真的跟着那个值走', async () => {
    useSettingsStore().settings.imageBlurByDefault = false;

    const wrapper = await mountFlow();
    const shots = wrapper.findAll('.si-shot');

    expect(shots).toHaveLength(2);
    expect(shots.some((s) => s.classes().includes('is-blurred'))).toBe(false);
  });

  it('点一下就揭开这一张，另一张仍然糊着（每张各自决定，不记忆）', async () => {
    useSettingsStore().settings.imageBlurByDefault = true;

    const wrapper = await mountFlow();
    await wrapper.findAll('.si-shot')[0]?.trigger('click');

    const shots = wrapper.findAll('.si-shot');
    expect(shots[0]?.classes()).not.toContain('is-blurred');
    expect(shots[1]?.classes()).toContain('is-blurred');
  });
});
