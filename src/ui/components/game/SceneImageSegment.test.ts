/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import type { ImagePreset, SceneImageMarker, SceneImageRecord } from '@engine/types-image';
import type { CharacterAppearancePatch } from '@engine/character-appearance';
import { EMPTY_APPEARANCE } from '@engine/character-appearance';
import type { SceneImageGenerateResult } from '../../stores/scene-image-store';
import SceneImageSegment from './SceneImageSegment.vue';

/**
 * 🔴 用例之间必须卸干净。这个文件的假 store 是**模块级 `reactive`**，下一个用例的
 * `beforeEach` 一改 `scene.records`，上一个用例遗留的 wrapper 会跟着重渲染 ——
 * 一旦有谁清过 `document.body`（Teleport 的弹窗测试很想这么做），那些 wrapper 就会以
 * `insertBefore(null)` 炸成 Unhandled Rejection，而且**测试全绿**、报错还指向别的用例名。
 */
enableAutoUnmount(afterEach);

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
  generate: vi.fn(async (_input: Record<string, unknown>): Promise<SceneImageGenerateResult> => ({
    ok: true,
    id: 'simg_new',
  })),
  cancel: vi.fn(async (_id: string) => 'cancelled' as const),
  update: vi.fn(async (_id: string, _changes: Record<string, unknown>) => undefined),
  pin: vi.fn(async (_id: string) => undefined),
  remove: vi.fn(async (_id: string) => undefined),
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
  find: vi.fn((): ImagePreset | undefined => undefined),
});

/**
 * 会话外貌副本（D56 / v1.3）。组件只读它一处 —— 判断某个出场角色是不是**真的**
 * 没有一致外貌: AI 即兴出来的外貌住在会话层、一行预设都没有，按预设行判会对着
 * 这种角色说「形象是随机的」，而那是假的。
 */
const sessionAppearance = reactive({
  patchOf: vi.fn((): CharacterAppearancePatch | undefined => undefined),
});

const ui = { toast: vi.fn(), navigate: vi.fn() };

vi.mock('../../stores/scene-image-store', () => ({ useSceneImageStore: () => scene }));
vi.mock('../../stores/image-preset-store', () => ({ useImagePresetStore: () => presets }));
vi.mock('../../stores/character-appearance-store', () => ({
  useCharacterAppearanceStore: () => sessionAppearance,
}));
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
    // 🔴 `clearAllMocks` 只清调用记录，**不清 `mockReturnValue`** —— 不显式设回默认值的话，
    //    某个用例里「这个角色有预设 / 有本档外貌」会泄漏给它后面的所有用例。
    presets.find.mockReturnValue(undefined);
    sessionAppearance.patchOf.mockReturnValue(undefined);
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

  /**
   * 🔴 v1.3：AI 即兴出来的外貌住在**会话副本**里，那种角色一行预设都没有 ——
   * 但他**是**有一致外貌的。按「有没有预设行」判会对着他说「形象是随机的」，
   * 而那句话是假的，还会把用户推去写一份他其实不需要的预设。
   */
  it('🔴 只有本档外貌（没有预设行）的角色不算「形象随机」', async () => {
    scene.records = [record()];
    scene.blobOf.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    sessionAppearance.patchOf.mockReturnValue({ hairColor: 'silver hair' });

    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wrapper.text()).not.toContain('还没有外观预设');
  });

  /** 反过来：槽全空的预设**等于没有**外貌，那一行照旧要出（否则用户永远不知道为什么不像） */
  it('槽全空的预设仍算「形象随机」', async () => {
    scene.records = [record()];
    scene.blobOf.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    presets.find.mockReturnValue({
      key: 'character:苏婉',
      kind: 'character',
      name: '苏婉',
      appearance: { ...EMPTY_APPEARANCE },
      dialects: {},
      createdAt: 0,
      updatedAt: 0,
    });

    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('还没有外观预设');
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

  it('🔴 被限额拦下不是终点：弹一次确认，点了就带 quotaConfirmed 重发（D24）', async () => {
    scene.generate.mockResolvedValueOnce({
      ok: false,
      reason: 'per-message',
      message: '这条消息已经有 2/2 张插画，继续生成会额外消耗额度 —— 确认后仍可生成',
    });
    const wrapper = mountSegment({ marker: MARKER, mode: 'manual', turn: 7 });

    await wrapper.get('.si-offer').trigger('click');
    await wrapper.vm.$nextTick();

    // checkQuota 那句中文**原样**出现（不是一条转瞬即逝的 toast）
    expect(wrapper.text()).toContain('确认后仍可生成');
    expect(ui.toast).not.toHaveBeenCalled();

    const confirm = wrapper.findAll('button').find((b) => b.text().includes('仍然生成'));
    await confirm?.trigger('click');
    await wrapper.vm.$nextTick();

    expect(scene.generate).toHaveBeenCalledTimes(2);
    expect(scene.generate.mock.calls[1]?.[0]).toMatchObject({
      source: 'manual',
      quotaConfirmed: true,
      turn: 7,
    });
  });

  it('rating 被 maxRating 上限钳住（D38）—— 标记写什么都穿不过去', async () => {
    const wrapper = mountSegment({
      marker: { ...MARKER, rating: 'explicit' },
      mode: 'manual',
      maxRating: 'sensitive',
    });
    await wrapper.get('.si-offer').trigger('click');

    expect(scene.generate.mock.calls[0]?.[0]).toMatchObject({ rating: 'sensitive' });
  });

  it('renders the take badge as a browse control, never as a pin (D17/D45)', async () => {
    scene.records = [record({ id: 'simg_1', take: 0 }), record({ id: 'simg_2', take: 1 })];
    scene.blobOf.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // displayedAt 给最后一张 → 2/2
    expect(wrapper.get('.si-take').text()).toBe('2/2');

    await wrapper.get('.si-take').trigger('click');
    // 环形前进回到第一张
    expect(wrapper.get('.si-take').text()).toBe('1/2');
    // 🔴 浏览一次都不该写库
    expect(scene.pin).not.toHaveBeenCalled();
    expect(scene.update).not.toHaveBeenCalled();
  });

  it('falls back to the displayed take when the browsed one disappears', async () => {
    scene.records = [record({ id: 'simg_1', take: 0 }), record({ id: 'simg_2', take: 1 })];
    scene.blobOf.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const wrapper = mountSegment({ marker: MARKER, mode: 'off' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await wrapper.get('.si-take').trigger('click'); // 看第 1 张
    scene.records = [record({ id: 'simg_2', take: 1 })]; // 第 1 张被删掉
    await wrapper.vm.$nextTick();

    // 不留空白格，静默退回 displayedAt（此时只剩一张，角标也没了）
    expect(wrapper.find('.si-take').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(true);
  });

  describe('打码显示（D46）', () => {
    async function mountBlurred() {
      scene.records = [record()];
      scene.blobOf.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
      const wrapper = mountSegment({ marker: MARKER, mode: 'off', blurByDefault: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return wrapper;
    }

    it('blurs a done image when the setting is on, and reveals it on click', async () => {
      const wrapper = await mountBlurred();

      expect(wrapper.get('.si-shot').classes()).toContain('is-blurred');
      expect(wrapper.text()).toContain('点击显示');

      await wrapper.get('.si-shot').trigger('click');
      expect(wrapper.get('.si-shot').classes()).not.toContain('is-blurred');
      // 🔴 第一次点击只揭开，不放大 —— 否则打码等于被一次点击直接跳过
      expect(document.body.querySelector('.si-lightbox')).toBeNull();
    });

    it('🔴 never re-blurs an image the player already revealed', async () => {
      const wrapper = await mountBlurred();
      await wrapper.get('.si-shot').trigger('click');

      // 记录被刷新（改标题 / 收藏都会走到这里）
      scene.records = [record({ title: '雨夜的酒馆（改）' })];
      await wrapper.vm.$nextTick();

      expect(wrapper.get('.si-shot').classes()).not.toContain('is-blurred');
    });

    it('leaves the image alone when the setting is off', async () => {
      scene.records = [record()];
      scene.blobOf.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
      const wrapper = mountSegment({ marker: MARKER, mode: 'off' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(wrapper.get('.si-shot').classes()).not.toContain('is-blurred');
    });
  });

  describe('done 态的放大与悬停菜单', () => {
    async function mountDone(over: Partial<SceneImageRecord> = {}) {
      scene.records = [record(over)];
      scene.blobOf.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
      const wrapper = mountSegment({ marker: MARKER, mode: 'off' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return wrapper;
    }

    function menuItem(wrapper: ReturnType<typeof mountSegment>, label: string) {
      return wrapper.findAll('.si-menu-item').find((b) => b.text().includes(label));
    }

    it('opens the shared AppModal on click instead of a hand-rolled lightbox', async () => {
      const wrapper = await mountDone();
      await wrapper.get('.si-shot').trigger('click');
      await wrapper.vm.$nextTick();

      // 🔴 别 `document.body.innerHTML = ''` 收尾 —— autoUnmount 会把 Teleport 的内容
      //    一起带走，而清空 body 会抽掉别的 wrapper 的宿主节点（见文件头）
      expect(document.body.querySelector('.modal-overlay')).not.toBeNull();
      expect(document.body.querySelector('.si-lightbox-img')).not.toBeNull();
    });

    it('🔴 keeps a non-hover way into the menu for touch devices', async () => {
      const wrapper = await mountDone();

      // 常驻的 `⋯`：只绑 :hover 的话这四个动作在手机上根本不存在
      expect(wrapper.find('.si-more').exists()).toBe(true);
      expect(wrapper.get('.si-menu').classes()).not.toContain('is-open');

      await wrapper.get('.si-more').trigger('click');
      expect(wrapper.get('.si-menu').classes()).toContain('is-open');
    });

    it('pins this take through the store (a write, unlike the badge)', async () => {
      const wrapper = await mountDone();
      await menuItem(wrapper, '钉住这张')?.trigger('click');

      expect(scene.pin).toHaveBeenCalledWith('simg_1');
    });

    it('toggles favorite through the store', async () => {
      const wrapper = await mountDone();
      await menuItem(wrapper, '收藏')?.trigger('click');

      expect(scene.update).toHaveBeenCalledWith('simg_1', { favorite: true });
    });

    it('copies the prompt this image actually used', async () => {
      const writeText = vi.fn(async () => undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      const wrapper = await mountDone({
        positive: '1girl, tavern interior, best quality',
        scenePrompt: 'tavern interior',
      });

      await menuItem(wrapper, '复制提示词')?.trigger('click');
      await Promise.resolve();

      // 🔴 复制的是真正发出去的 `positive`，不是场景那一段
      expect(writeText).toHaveBeenCalledWith('1girl, tavern interior, best quality');
    });

    it('🔴 asks before deleting, and does nothing when the player says no', async () => {
      const wrapper = await mountDone();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      try {
        await menuItem(wrapper, '删除')?.trigger('click');
        expect(confirmSpy).toHaveBeenCalled();
        expect(scene.remove).not.toHaveBeenCalled();

        confirmSpy.mockReturnValue(true);
        await menuItem(wrapper, '删除')?.trigger('click');
        expect(scene.remove).toHaveBeenCalledWith('simg_1');
      } finally {
        confirmSpy.mockRestore();
      }
    });
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
