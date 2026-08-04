/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import type { SceneImageMarker, SceneImageRecord } from '@engine/types-image';
import SceneImageSegment from './SceneImageSegment.vue';

const NOW = 1_700_000_000_000;

/**
 * 🔴 假 store 必须是 `reactive` 的（记忆条目 reactive-store-mock-vacuous）——
 * 裸对象会切断响应式链，「记录变了界面跟着变」那类断言会变成恒真/恒假。
 *
 * 三个 `vi.mock` 工厂只是把这几个常量**延迟**取出来（箭头函数体内才解引用），
 * 所以不必走 `vi.hoisted` —— 那条路上 `reactive` 还没 import 进来。
 */
const scene = reactive({
  activeSaveId: 'save_1' as string | null,
  queue: [] as string[],
  records: [] as SceneImageRecord[],
  // 入参写成具名形参不是装饰: 没有它，`mock.calls[0]` 是空元组，
  // 「点一下按钮到底发了什么」根本断言不了
  generate: vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true as const,
    id: 'simg_new',
  })),
  cancel: vi.fn(async (_id: string) => 'cancelled' as const),
  update: vi.fn(async (_id: string, _changes: Record<string, unknown>) => undefined),
  blobOf: vi.fn(async (): Promise<Blob | undefined> => undefined),
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
  find: vi.fn((): undefined => undefined),
});

const ui = { toast: vi.fn(), navigate: vi.fn() };

vi.mock('../../stores/scene-image-store', () => ({ useSceneImageStore: () => scene }));
vi.mock('../../stores/image-preset-store', () => ({ useImagePresetStore: () => presets }));
vi.mock('../../stores/ui-store', () => ({ useUIStore: () => ui }));

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
    intent: '苏婉坐在壁炉旁，窗外下着雨',
    scenePrompt: 'tavern interior',
    sceneNegative: '',
    characters: ['苏婉'],
    rating: 'general',
    positive: '',
    negative: '',
    model: 'nai-diffusion-4-5-full',
    params: {},
    createdAt: NOW - 60_000,
    ...over,
  };
}

const MARKER: SceneImageMarker = {
  type: 'scene_image',
  rawContent: '<scene_image title="雨夜的酒馆">苏婉坐在壁炉旁</scene_image>',
  position: 0,
  bodyText: '苏婉坐在壁炉旁',
  title: '雨夜的酒馆',
  characters: ['苏婉'],
};

function mountSegment(props: Record<string, unknown> = {}) {
  return mount(SceneImageSegment, {
    props: { messageId: 'msg_1', occurrence: 0, ...props },
  });
}

describe('SceneImageSegment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scene.records = [];
    scene.queue = [];
    scene.activeSaveId = 'save_1';
    presets.loading = false;
    Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => 'blob:scene-image'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('renders nothing when the feature is off and no record exists', () => {
    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });

    expect(wrapper.text()).toBe('');
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('🔴 offers a button in auto mode and never fires generation on its own', async () => {
    // D15/D21：自动档只对编排器刚产出的那条消息开火。挂载一个历史段落不该花钱。
    const wrapper = mountSegment({ marker: MARKER, mode: 'auto' });
    await Promise.resolve();

    expect(scene.generate).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('生成插画');
    expect(wrapper.text()).toContain('雨夜的酒馆');
    expect(wrapper.text()).toContain('苏婉坐在壁炉旁');
  });

  it('fires a manual generation when the offer is clicked', async () => {
    const wrapper = mountSegment({ marker: MARKER, mode: 'manual', turn: 7 });
    await wrapper.get('button').trigger('click');

    expect(scene.generate).toHaveBeenCalledTimes(1);
    expect(scene.generate.mock.calls[0]?.[0]).toMatchObject({
      saveId: 'save_1',
      messageId: 'msg_1',
      occurrence: 0,
      anchorKind: 'marker',
      turn: 7,
      source: 'manual',
      title: '雨夜的酒馆',
      characters: ['苏婉'],
    });
  });

  it('shows the queue position with a free cancel', () => {
    scene.records = [record({ status: 'queued' })];
    scene.queue = ['other', 'simg_1'];
    const wrapper = mountSegment({ marker: MARKER, mode: 'manual' });

    expect(wrapper.text()).toContain('队列中 · 第 2 位');
    expect(wrapper.text()).toContain('取消（不消耗）');
    // 🔴 排队态的措辞不能出现「计费」——它一个字节都没花
    expect(wrapper.text()).not.toContain('计费');
  });

  it('says out loud that aborting an in-flight image still costs money', () => {
    scene.records = [record({ status: 'generating', startedAt: Date.now() - 5_000 })];
    const wrapper = mountSegment({ marker: MARKER, mode: 'manual' });

    expect(wrapper.text()).toContain('中止（本次仍会计费）');
    expect(wrapper.text()).toMatch(/已用 \d+ 秒/);
  });

  it('renders the image with alt=title and title=description', async () => {
    scene.records = [record()];
    scene.blobOf.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const img = wrapper.get('img');
    expect(img.attributes('alt')).toBe('雨夜的酒馆');
    expect(img.attributes('title')).toBe('苏婉第一次说起她的家乡');
    expect(img.attributes('src')).toBe('blob:scene-image');
  });

  it('shows the missing-preset line with a settings link (D41)', async () => {
    scene.records = [record()];
    scene.blobOf.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('还没有外观预设');
    await wrapper.get('.si-link').trigger('click');
    expect(ui.navigate).toHaveBeenCalledWith('settings');
  });

  it('never renders a cleared record as a broken image (D47)', () => {
    scene.records = [record({ blobDropped: true })];
    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('字节已清理');
    expect(wrapper.text()).toContain('重画');
  });

  it('gives a failed record a reason, a retry and a write-your-own-prompt way out', async () => {
    scene.records = [
      record({ status: 'failed', error: 'NovelAI 限流了，过一会儿再试', errorKind: 'rate-limit' }),
    ];
    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });

    expect(wrapper.text()).toContain('NovelAI 限流了，过一会儿再试');
    expect(wrapper.text()).toContain('重试');

    // D42：自己写提示词是**就地**的，不是「去图鉴里填」（失败的记录根本不进图鉴）
    const buttons = wrapper.findAll('button');
    const own = buttons.find((b) => b.text().includes('自己写提示词'));
    await own?.trigger('click');
    expect(wrapper.find('textarea').exists()).toBe(true);

    await wrapper.get('textarea').setValue('rainy street, night');
    const submit = wrapper.findAll('button').find((b) => b.text().includes('用这份提示词重画'));
    await submit?.trigger('click');
    await Promise.resolve();

    expect(scene.update).toHaveBeenCalledWith('simg_1', {
      editedScenePrompt: 'rainy street, night',
    });
    // 重画继承 editedScenePrompt 并跳过侧链（D26 + D31）
    expect(scene.generate.mock.calls[0]?.[0]).toMatchObject({ redrawFrom: 'simg_1' });
  });

  it('hides retry for failures that a second attempt cannot fix', () => {
    scene.records = [record({ status: 'failed', error: 'Anlas 不足', errorKind: 'payment' })];
    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });

    expect(wrapper.findAll('button').some((b) => b.text().includes('重试'))).toBe(false);
    expect(wrapper.text()).toContain('Anlas 不足');
  });

  it('keeps the button / queued / generating frames at one height', () => {
    // 三态共用 `.si-frame`：高度不一样的话，每张图落地时对话流会往下跳一截
    const offer = mountSegment({ marker: MARKER, mode: 'manual' });
    expect(offer.find('.si-frame').exists()).toBe(true);

    scene.records = [record({ status: 'queued' })];
    expect(mountSegment({ marker: MARKER, mode: 'manual' }).find('.si-frame').exists()).toBe(true);

    scene.records = [record({ status: 'generating', startedAt: Date.now() })];
    expect(mountSegment({ marker: MARKER, mode: 'manual' }).find('.si-frame').exists()).toBe(true);
  });
});
