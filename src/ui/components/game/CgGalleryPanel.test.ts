/**
 * CgGalleryPanel.test.ts — CG 图鉴的三条界面级性质（§10.3）
 *
 * 1. **只列已经画出来的** —— 排队中 / 失败的记录一格都不出现。
 * 2. **已清理的不渲染成破图** —— 出「字节已清理」占位，`<img>` 一个都没有。
 * 3. 🔴 **懒加载的兜底真的顶得住** —— jsdom 里没有 `IntersectionObserver`，
 *    这里跑的正是低带宽/弱设备上观察器不触发的那条路: 只靠 500ms 的
 *    `getBoundingClientRect()` 复查，图仍然要装出来。这条断言若红了，
 *    线上症状就是「一屏空白框，而且我这边好好的」。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reactive, ref, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import type { SceneImageRecord } from '@engine/types-image';

// ── 假 store（响应式，否则「落库后 UI 自己刷新」的断言是恒真的）──

const records = ref<SceneImageRecord[]>([]);
let mockScene: Record<string, unknown>;
let mockGame: Record<string, unknown>;
let mockUi: { toast: ReturnType<typeof vi.fn> };
let mockPresets: Record<string, unknown>;

vi.mock('../../stores/scene-image-store', () => ({ useSceneImageStore: () => mockScene }));
vi.mock('../../stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('../../stores/ui-store', () => ({ useUIStore: () => mockUi }));
vi.mock('../../stores/image-preset-store', () => ({ useImagePresetStore: () => mockPresets }));

import CgGalleryPanel from './CgGalleryPanel.vue';

function rec(over: Partial<SceneImageRecord> = {}): SceneImageRecord {
  return {
    id: 'r1',
    saveId: 's1',
    messageId: 'm1',
    anchorKind: 'marker',
    occurrence: 0,
    take: 0,
    turn: 1,
    status: 'done',
    source: 'auto',
    title: '客栈的灯',
    description: '',
    intent: '一句中文',
    scenePrompt: 'tavern interior',
    sceneNegative: '',
    characters: [],
    rating: 'general',
    positive: '',
    negative: '',
    model: 'nai-diffusion-4-5-full',
    params: {},
    createdAt: 100,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  records.value = [];
  // jsdom 没有 object URL 工厂 —— 补一个计数假件（asset-url.ts 是惰性取全局的）
  let n = 0;
  (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => `blob:mock-${(n += 1)}`,
  );
  (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();

  mockScene = reactive({
    records,
    activeSaveId: 's1',
    load: vi.fn(async () => {}),
    blobOf: vi.fn(async (id: string) => (id === 'nobytes' ? undefined : new Blob([id]))),
    update: vi.fn(async () => undefined),
    pin: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    generate: vi.fn(async () => ({ ok: true, id: 'new' })),
    find: vi.fn((id: string) => records.value.find((r) => r.id === id)),
  });
  mockGame = { activeSaveId: 's1', closeModal: vi.fn() };
  mockUi = { toast: vi.fn() };
  mockPresets = { init: vi.fn(async () => {}), setPinnedSeed: vi.fn(async () => ({ ok: true })) };
});

afterEach(() => {
  vi.useRealTimers();
});

/** 挂载 + 让 onMounted 的异步链与懒加载兑现跑完 */
async function mountPanel() {
  const wrapper = mount(CgGalleryPanel, { attachTo: document.body });
  await flushPromises();
  vi.advanceTimersByTime(500);
  await flushPromises();
  await nextTick();
  return wrapper;
}

describe('CgGalleryPanel', () => {
  it('只列已经画出来的 —— 排队中与失败的都不进图鉴', async () => {
    records.value = [
      rec({ id: 'done', messageId: 'm1', turn: 1 }),
      rec({ id: 'queued', messageId: 'm2', turn: 2, status: 'queued' }),
      rec({ id: 'failed', messageId: 'm3', turn: 3, status: 'failed', error: '429' }),
    ];
    const w = await mountPanel();
    expect(w.findAll('.cg-cell')).toHaveLength(1);
    expect(w.text()).toContain('CG 图鉴（1）');
    w.unmount();
  });

  it('🔴 观察器缺席时，500ms 兜底扫描照样把图装出来', async () => {
    records.value = [rec({ id: 'a', bytes: 100 })];
    expect(typeof IntersectionObserver).toBe('undefined'); // 正是要模拟的那种环境
    const w = await mountPanel();
    const img = w.find('.cg-thumb-img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toMatch(/^blob:mock-/);
    w.unmount();
  });

  it('已清理的格子出「字节已清理」，不渲染 <img>（不是破图）', async () => {
    records.value = [rec({ id: 'gone', blobDropped: true })];
    const w = await mountPanel();
    expect(w.find('.cg-thumb-dropped').text()).toBe('字节已清理');
    expect(w.find('.cg-thumb-img').exists()).toBe(false);
    // 已清理的连字节都不去要 —— 每次开图鉴都白读一次 Dexie 是没意义的
    expect(mockScene.blobOf).not.toHaveBeenCalled();
    w.unmount();
  });

  it('同一锚点的多 take 折成一格并显示张数角标', async () => {
    records.value = [rec({ id: 'a0', take: 0 }), rec({ id: 'a1', take: 1 })];
    const w = await mountPanel();
    expect(w.findAll('.cg-cell')).toHaveLength(1);
    expect(w.find('.cg-badge').text()).toBe('×2');
    w.unmount();
  });

  it('空态是「画卷尚空」，不是一堆待办灰格子', async () => {
    records.value = [rec({ status: 'failed' })];
    const w = await mountPanel();
    expect(w.findAll('.cg-cell')).toHaveLength(0);
    expect(w.find('.empty-tab').text()).toContain('画卷尚空');
    w.unmount();
  });

  it('点格子开详情；恰好一个角色 + 有 seed 时才给「钉 seed」', async () => {
    records.value = [rec({ id: 'a', characters: ['苏婉'], seed: 12345 })];
    const w = await mountPanel();
    await w.find('.cg-cell').trigger('click');
    await flushPromises();
    expect(w.find('.cg-detail').exists()).toBe(true);
    expect(w.text()).toContain('把这次的 seed 钉给苏婉');
    expect(w.text()).toContain('同一 seed 只让构图更接近，不保证同一张脸');
    w.unmount();
  });

  it('两个角色的图不给「钉 seed」（钉给谁都不对）', async () => {
    records.value = [rec({ id: 'a', characters: ['苏婉', '林越'], seed: 12345 })];
    const w = await mountPanel();
    await w.find('.cg-cell').trigger('click');
    await flushPromises();
    expect(w.text()).not.toContain('把这次的 seed 钉给');
    w.unmount();
  });

  it('新记录落库后自动补装 —— 不必重开面板', async () => {
    records.value = [rec({ id: 'a' })];
    const w = await mountPanel();
    expect(w.findAll('.cg-cell')).toHaveLength(1);

    records.value = [...records.value, rec({ id: 'b', messageId: 'm2', turn: 2 })];
    await nextTick();
    await flushPromises();
    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(w.findAll('.cg-cell')).toHaveLength(2);
    expect(w.findAll('.cg-thumb-img')).toHaveLength(2);
    w.unmount();
  });
});
