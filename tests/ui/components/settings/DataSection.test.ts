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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { SceneImageUsage } from '@engine/types/types-image';

// settings-store：本组件只用到用量查询与 resetAll，绕开启动期的 IndexedDB / fetch
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({
    getStorageUsage: async () => ({ used: 1024, quota: 10240, pct: 10 }),
    resetAll: () => {},
    reloadApiEntries: async () => {},
  }),
}));

// game-store：DataSection 的经验档位切换只用到 refreshFromDb（切完回读让战斗分档即时生效）。
// 真实 game-store 构造会拉起整条前端链（IndexedDB / state-manager），本测试不碰它。
// ui-store 用 saves 取存档显示名、回到首页时调 clearActive。
vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => ({
    refreshFromDb: async () => {},
    clearActive: () => {},
    saves: [{ id: 'save_1', name: '雪原之旅' }],
  }),
}));

const getSceneImageUsage = vi.fn<(saveId: string) => Promise<SceneImageUsage>>();
const listCleanableSceneImageIds = vi.fn<(saveId: string) => Promise<string[]>>();
const dropSceneImageBlobs = vi.fn<(ids: readonly string[]) => Promise<number>>();
const importAllData = vi.fn<(data: unknown) => Promise<void>>();
const clearAllData = vi.fn<() => Promise<void>>();
vi.mock('@engine/persistence/database', () => ({
  getSceneImageUsage: (saveId: string) => getSceneImageUsage(saveId),
  listCleanableSceneImageIds: (saveId: string) => listCleanableSceneImageIds(saveId),
  dropSceneImageBlobs: (ids: readonly string[]) => dropSceneImageBlobs(ids),
  exportAllData: async () => ({}),
  importAllData: (data: unknown) => importAllData(data),
  clearAllData: () => clearAllData(),
  // 经验档位读取（loadExperienceMode）—— 返回一个含 experienceMode 的假 profile
  getSaveProfile: async () => ({ saveId: 'x', experienceMode: 'normal' }),
}));

import DataSection from '../../../../src/ui/components/settings/DataSection.vue';
import { useUIStore } from '../../../../src/ui/stores/ui-store';
import {
  acquireSaveTabLock,
  CLEAR_ALL_LOCKED_MESSAGE,
  FULL_IMPORT_LOCKED_MESSAGE,
} from '../../../../src/ui/lib/save-tab-lock';

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
  importAllData.mockResolvedValue(undefined);
  clearAllData.mockResolvedValue(undefined);
});

describe('DataSection —— 内容包搬走后的指路与危险区（S-01）', () => {
  it('不再渲染内容包卡，只留一行指路，点按钮去「内容包」分区', async () => {
    const w = await mountWithSave(null);
    expect(w.find('[data-settings-anchor="content-pack"]').exists()).toBe(false);
    expect(w.text()).toContain('内容包已移至「内容包」分区');
    expect(w.findAll('button').some((b) => b.text() === '导入 / 升级内容包')).toBe(false);

    const ui = useUIStore();
    const spy = vi.spyOn(ui, 'openSettings').mockImplementation(() => {});
    await w
      .findAll('button')
      .find((b) => b.text() === '前往内容包')!
      .trigger('click');
    expect(spy).toHaveBeenCalledWith('content-pack');
  });

  it('「清除所有数据」在网格之外的危险区里，排在分区最底部', async () => {
    const w = await mountWithSave(null);
    expect(w.find('.data-actions .data-danger').exists()).toBe(false);
    const zone = w.get('.danger-zone');
    expect(zone.find('.data-danger').text()).toContain('清除所有数据');
    // 危险区在日常卡片网格之后
    const grid = w.get('.data-actions').element;
    expect(
      grid.compareDocumentPosition(zone.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('DataSection —— 整库备份的 API 凭据边界', () => {
  it('导出与导入说明应明确排除 API 凭据、保留本机凭据并提示新设备重配', async () => {
    const w = await mountWithSave('save_1');
    const text = w.text();

    expect(text).toContain('API 端点与 API 密钥不包含在备份中');
    expect(text).toContain('导入不会覆盖本机已保存的 API 凭据');
    expect(text).toContain('换到新设备后需要重新配置 API');
    expect(text).toContain('备份中的数据会替换现有内容');
    expect(text).not.toContain('合并到现有数据库');
  });

  it('整库导入确认框应重申凭据保留范围，且按钮不再声称替换全部数据', async () => {
    const w = await mountWithSave('save_1');
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });

    try {
      await w
        .findAll('button')
        .find((button) => button.text() === '导入数据')!
        .trigger('click');
      await flushPromises();
    } finally {
      clickSpy.mockRestore();
    }

    const text = w.text();
    expect(text).toContain('API 端点与 API 密钥不会从备份恢复');
    expect(text).toContain('本机已保存的 API 凭据不会被覆盖');
    expect(text).toContain('换到新设备后需要重新配置');
    expect(text).toContain('替换备份数据并导入');
    expect(text).not.toContain('替换全部数据并导入');
  });
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

describe('DataSection —— 按存档生效的卡片标明作用对象（UIL-20）', () => {
  it('有活跃存档时，经验档位与插画两张卡都写出存档名，清理确认框也点名', async () => {
    getSceneImageUsage.mockResolvedValue(usage({ records: 2, storedCount: 2, storedBytes: 2048 }));
    const w = await mountWithSave('save_1');

    expect(w.findAll('.save-scope').map((n) => n.text())).toEqual([
      '作用于存档「雪原之旅」',
      '作用于存档「雪原之旅」',
    ]);

    await w
      .findAll('button')
      .find((b) => b.text() === '清理图片文件')!
      .trigger('click');
    await flushPromises();
    expect(w.text()).toContain('将清理存档「雪原之旅」中');
  });

  it('没有活跃存档（从首页进设置）时不标存档名，单存档操作禁用', async () => {
    const w = await mountWithSave(null);
    expect(w.find('.save-scope').exists()).toBe(false);
    expect(w.text()).toContain('未载入存档');
  });
});

describe('DataSection —— 整库导入尊重存档标签页锁（R8）', () => {
  /** 假 navigator.locks：`external` 为别的标签页占着的锁名，本标签页申请的锁也记在同一集合 */
  function installFakeLocks(external: string[] = []) {
    const held = new Set<string>(external);
    const locks = {
      request: vi.fn(
        async (name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => {
          if (held.has(name)) return await callback(null);
          held.add(name);
          try {
            return await callback({ name, mode: 'exclusive' } as Lock);
          } finally {
            held.delete(name);
          }
        },
      ),
      query: vi.fn(async () => ({
        held: [...held].map((name) => ({ name, mode: 'exclusive', clientId: 'x' })),
        pending: [],
      })),
    };
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  }

  afterEach(() => {
    delete (navigator as { locks?: unknown }).locks;
  });

  /** 选文件 → 确认导入；返回 toast 间谍 */
  async function runImport() {
    const w = await mountWithSave('save_1');
    const toast = vi.spyOn(useUIStore(), 'toast');
    const file = new File(['{"version":1,"saves":[]}'], 'backup.json', {
      type: 'application/json',
    });
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    try {
      await w
        .findAll('button')
        .find((button) => button.text() === '导入数据')!
        .trigger('click');
      await flushPromises();
    } finally {
      clickSpy.mockRestore();
    }
    await w
      .findAll('button')
      .find((button) => button.text() === '替换备份数据并导入')!
      .trigger('click');
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    return toast;
  }

  it('别的标签页在玩任一存档时拒绝导入并提示，不碰数据库', async () => {
    installFakeLocks(['poem-save:save_other']);
    const toast = await runImport();
    expect(toast).toHaveBeenCalledWith(FULL_IMPORT_LOCKED_MESSAGE, 'warning', 6000);
    expect(importAllData).not.toHaveBeenCalled();
  });

  it('只有本标签页自己持锁时照常导入', async () => {
    installFakeLocks();
    const own = await acquireSaveTabLock('save_1');
    try {
      const toast = await runImport();
      expect(importAllData).toHaveBeenCalledOnce();
      expect(toast).toHaveBeenCalledWith('导入成功', 'success');
    } finally {
      own!.release();
    }
  });

  it('环境没有 navigator.locks 时放行', async () => {
    const toast = await runImport();
    expect(importAllData).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith('导入成功', 'success');
  });
});

describe('DataSection —— 清除所有数据尊重存档标签页锁（R8）', () => {
  function installFakeLocks(external: string[] = []) {
    const held = new Set<string>(external);
    const locks = {
      request: vi.fn(
        async (name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => {
          if (held.has(name)) return await callback(null);
          held.add(name);
          try {
            return await callback({ name, mode: 'exclusive' } as Lock);
          } finally {
            held.delete(name);
          }
        },
      ),
      query: vi.fn(async () => ({
        held: [...held].map((name) => ({ name, mode: 'exclusive', clientId: 'x' })),
        pending: [],
      })),
    };
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  }

  afterEach(() => {
    delete (navigator as { locks?: unknown }).locks;
    vi.useRealTimers();
  });

  /** 打开危险区确认框并点「确认清除」；返回 toast 间谍。假定时器挡住刷新页面那一拍 */
  async function runClearAll() {
    const w = await mountWithSave('save_1');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const toast = vi.spyOn(useUIStore(), 'toast');
    await w.get('.danger-zone .data-danger').find('button').trigger('click');
    await w
      .findAll('button')
      .find((button) => button.text() === '确认清除')!
      .trigger('click');
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    return { w, toast };
  }

  it('别的标签页在玩任一存档时拒绝清除并提示，不碰数据库', async () => {
    installFakeLocks(['poem-save:save_other']);
    const { w, toast } = await runClearAll();
    expect(toast).toHaveBeenCalledWith(CLEAR_ALL_LOCKED_MESSAGE, 'warning', 6000);
    expect(clearAllData).not.toHaveBeenCalled();
    // 确认框随之关闭
    expect(w.findAll('button').some((button) => button.text() === '确认清除')).toBe(false);
  });

  it('只有本标签页自己持锁时照常清除', async () => {
    installFakeLocks();
    const own = await acquireSaveTabLock('save_1');
    try {
      const { toast } = await runClearAll();
      expect(clearAllData).toHaveBeenCalledOnce();
      expect(toast).toHaveBeenCalledWith('数据已清除，页面即将刷新', 'warning');
    } finally {
      own!.release();
    }
  });

  it('环境没有 navigator.locks 时放行', async () => {
    const { toast } = await runClearAll();
    expect(clearAllData).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith('数据已清除，页面即将刷新', 'warning');
  });
});
