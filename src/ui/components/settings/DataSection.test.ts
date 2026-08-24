/**
 * DataSection.vue —— 本存档插画用量与清理（图像生成设计 §7.5 / D47）
 *
 * 这张卡上有两处「说错了不会报错、只会让用户吃亏」的地方：
 *
 * 1. **清理的语义**。清掉的只是图片文件，插画条目与提示词都留着、随时能重画；同时
 *    它又是**不可撤销**的（重画要重新花额度）。少说前半句，用户以为在删回忆而不敢
 *    点；少说后半句，用户以为随手可恢复而乱点。所以确认弹窗的这两句话有各自的用例。
 * 2. **收藏豁免**（D6 / §7.5）。收藏的那些不在清理范围内，于是「可清理张数」不等于
 *    「张数」—— 按前者算错会让确认框承诺一个清不掉的数字。
 *
 * 另外钉住：一张图都没有时显示「0 张 / 0 B」而不是把整行藏起来，也不是报错。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { SceneImageUsage } from '@engine/types-image';

// settings-store：本组件只用到用量查询与 resetAll，绕开启动期的 IndexedDB / fetch
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: () => ({
    getStorageUsage: async () => ({ used: 1024, quota: 10240, pct: 10 }),
    resetAll: () => {},
    reloadApiEntries: async () => {},
  }),
}));

// game-store：DataSection 的经验档位切换只用到 refreshFromDb（切完回读让战斗分档即时生效）。
// 真实 game-store 构造会拉起整条前端链（IndexedDB / state-manager），本测试不碰它。
vi.mock('../../stores/game-store', () => ({
  useGameStore: () => ({
    refreshFromDb: async () => {},
  }),
}));

const getSceneImageUsage = vi.fn<(saveId: string) => Promise<SceneImageUsage>>();
const listCleanableSceneImageIds = vi.fn<(saveId: string) => Promise<string[]>>();
const dropSceneImageBlobs = vi.fn<(ids: readonly string[]) => Promise<number>>();
vi.mock('@engine/database', () => ({
  getSceneImageUsage: (saveId: string) => getSceneImageUsage(saveId),
  listCleanableSceneImageIds: (saveId: string) => listCleanableSceneImageIds(saveId),
  dropSceneImageBlobs: (ids: readonly string[]) => dropSceneImageBlobs(ids),
  exportAllData: async () => ({}),
  importAllData: async () => {},
  clearAllData: async () => {},
  // 经验档位读取（loadExperienceMode）—— 返回一个含 experienceMode 的假 profile
  getSaveProfile: async () => ({ saveId: 'x', experienceMode: 'normal' }),
}));

import DataSection from './DataSection.vue';
import { useUIStore } from '../../stores/ui-store';

function usage(over: Partial<SceneImageUsage> = {}): SceneImageUsage {
  return {
    records: 0,
    storedCount: 0,
    storedBytes: 0,
    favoriteCount: 0,
    favoriteBytes: 0,
    ...over,
  };
}

/** 挂载并等两轮微任务 —— onMounted 里的动态 import + 查询都要落地 */
async function mountWithSave(saveId: string | null) {
  setActivePinia(createPinia());
  useUIStore().activeSaveId = saveId;
  // AppModal 走 Teleport to body —— 就地渲染，弹窗内容才 find 得到
  const w = mount(DataSection, { global: { stubs: { teleport: true } } });
  await flushPromises();
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSceneImageUsage.mockResolvedValue(usage());
  listCleanableSceneImageIds.mockResolvedValue([]);
  dropSceneImageBlobs.mockResolvedValue(0);
});

describe('DataSection —— 本存档插画用量', () => {
  it('一张图都没有 → 照常显示「0 张 / 0 B」，按钮禁用', async () => {
    const w = await mountWithSave('save_1');

    expect(getSceneImageUsage).toHaveBeenCalledWith('save_1');
    expect(w.text()).toContain('0 张 / 0 B');
    const btn = w.findAll('button').find((b) => b.text() === '清理图片文件')!;
    expect(btn).toBeTruthy();
    expect(btn.attributes('disabled')).toBeDefined();
  });

  it('有插画 → 张数与字节走本分区既有的 fmtBytes（与存储用量同一套换算）', async () => {
    getSceneImageUsage.mockResolvedValue(
      usage({ records: 4, storedCount: 3, storedBytes: 3 * 1048576 }),
    );
    const w = await mountWithSave('save_1');

    expect(w.text()).toContain('3 张 / 3.0 MB');
    // 记录数与「已清理」条数照实说 —— 那一格在图鉴里是可重画的，不是消失了
    expect(w.text()).toContain('共 4 条插画记录');
    expect(w.text()).toContain('1 条的图片文件已清理');
  });

  it('未载入存档 → 不查询，照实说「按存档统计」', async () => {
    const w = await mountWithSave(null);

    expect(getSceneImageUsage).not.toHaveBeenCalled();
    expect(w.text()).toContain('未载入存档');
    expect(w.findAll('button').some((b) => b.text() === '清理图片文件')).toBe(false);
  });

  it('收藏的不算进可清理张数（D6 豁免位）', async () => {
    getSceneImageUsage.mockResolvedValue(
      usage({
        records: 3,
        storedCount: 3,
        storedBytes: 3000,
        favoriteCount: 3,
        favoriteBytes: 3000,
      }),
    );
    const w = await mountWithSave('save_1');

    // 三张全是收藏 → 一张都清不掉，按钮必须是灰的
    const btn = w.findAll('button').find((b) => b.text() === '清理图片文件')!;
    expect(btn.attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('收藏的 3 张不会被清理');
  });
});

describe('DataSection —— 清理确认（D47）', () => {
  async function openConfirm() {
    getSceneImageUsage.mockResolvedValue(
      usage({
        records: 5,
        storedCount: 5,
        storedBytes: 5000,
        favoriteCount: 1,
        favoriteBytes: 1000,
      }),
    );
    const w = await mountWithSave('save_1');
    await w
      .findAll('button')
      .find((b) => b.text() === '清理图片文件')!
      .trigger('click');
    await flushPromises();
    return w;
  }

  it('确认框同时说清：只删图片文件 / 条目与提示词保留 / 可重画 / 不可撤销 / 收藏豁免', async () => {
    const w = await openConfirm();
    const text = w.text();

    expect(text).toContain('图片文件本身');
    expect(text).toContain('提示词');
    expect(text).toContain('重画');
    expect(text).toContain('不可撤销');
    expect(text).toContain('收藏的 1 张不在清理范围内');
    // 数字按可清理口径（5 - 1 张收藏），不是总张数
    expect(text).toContain('4');
    expect(text).toContain('3.9 KB');
  });

  it('确认 → 名单在点下这一刻重新取，删完刷新用量', async () => {
    listCleanableSceneImageIds.mockResolvedValue(['img_a', 'img_b']);
    dropSceneImageBlobs.mockResolvedValue(2);
    const w = await openConfirm();

    getSceneImageUsage.mockResolvedValue(usage({ records: 5, storedCount: 1, storedBytes: 1000 }));
    await w
      .findAll('button')
      .find((b) => b.text() === '确认清理')!
      .trigger('click');
    await flushPromises();
    await flushPromises();

    expect(listCleanableSceneImageIds).toHaveBeenCalledWith('save_1');
    expect(dropSceneImageBlobs).toHaveBeenCalledWith(['img_a', 'img_b']);
    // 清完之后这一行必须是新数（否则用户点了看不出变化，会再点一次）
    expect(getSceneImageUsage).toHaveBeenCalledTimes(2);
    expect(w.text()).toContain('1 张 / 1000 B');
  });

  it('清理抛错 → 出错误提示且不留在忙碌态', async () => {
    listCleanableSceneImageIds.mockRejectedValue(new Error('boom'));
    const w = await openConfirm();

    await w
      .findAll('button')
      .find((b) => b.text() === '确认清理')!
      .trigger('click');
    await flushPromises();
    await flushPromises();

    const toasts = useUIStore().toasts;
    expect(toasts.some((t) => t.type === 'error')).toBe(true);
    expect(dropSceneImageBlobs).not.toHaveBeenCalled();
  });
});
