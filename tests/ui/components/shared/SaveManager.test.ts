/**
 * SaveManager — 应用级存档管理窗口。
 *
 * 关键回归：窗口不再属于 HomePage；从游戏页打开时 currentView 保持 game，
 * 并优先选中正在游玩的存档。存档操作本身沿用原首页实现。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import SaveManager from '../../../../src/ui/components/shared/SaveManager.vue';
import {
  acquireSaveTabLock,
  FULL_IMPORT_LOCKED_MESSAGE,
  SAVE_DELETE_LOCKED_MESSAGE,
} from '../../../../src/ui/lib/save-tab-lock';

const mocks = vi.hoisted(() => ({
  game: {
    saves: [] as Array<{
      id: string;
      name?: string;
      updatedAt: number;
      metadata?: { characterName: string; totalTurns: number };
    }>,
    loadSaves: vi.fn<() => Promise<void>>(),
  },
  ui: {
    saveManagerOpen: true,
    currentView: 'game',
    activeSaveId: 'save-1' as string | null,
    closeSaveManager: vi.fn(),
    navigate: vi.fn(),
    toast: vi.fn(),
  },
  settings: {
    settings: { activePresetId: null as string | null },
    projectAgentDefaults: undefined as
      { agents: Record<string, { presetId?: string; preset?: unknown }> } | undefined,
    reloadApiEntries: vi.fn(),
  },
  exportSessionSave: vi.fn(),
  admission: vi.fn(),
  database: {
    getSave: vi.fn(),
    getCharacters: vi.fn(),
    getSaveProfile: vi.fn(),
    saveSaveSlot: vi.fn(),
    deleteSaveSlot: vi.fn(),
    getPresets: vi.fn(),
    importAllData: vi.fn(),
  },
}));

vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => mocks.game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => mocks.ui }));
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => mocks.settings,
}));
vi.mock('@engine/persistence/database', () => mocks.database);
vi.mock('@engine/persistence/session-backup', () => ({
  exportSessionSave: mocks.exportSessionSave,
  isSessionBackup: () => false,
  isFullBackupFile: () => true,
}));
vi.mock('@engine/story/story-context-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/story/story-context-mode')>();
  return { ...actual, decideStoryContextAdmission: mocks.admission };
});

let wrapper: VueWrapper | null = null;

async function mountManager() {
  wrapper = mount(SaveManager, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  mocks.game.saves.splice(
    0,
    mocks.game.saves.length,
    {
      id: 'save-2',
      name: '较新的存档',
      updatedAt: 200,
      metadata: { characterName: '角色二', totalTurns: 2 },
    },
    {
      id: 'save-1',
      name: '正在游玩的存档',
      updatedAt: 100,
      metadata: { characterName: '角色一', totalTurns: 1 },
    },
  );
  mocks.ui.saveManagerOpen = true;
  mocks.ui.currentView = 'game';
  mocks.ui.activeSaveId = 'save-1';
  mocks.ui.closeSaveManager.mockReset();
  mocks.ui.navigate.mockReset();
  mocks.ui.toast.mockReset();
  mocks.game.loadSaves.mockReset().mockResolvedValue();
  mocks.database.getSave.mockReset().mockImplementation(async (id: string) => ({
    id,
    metadata: { characterName: id === 'save-1' ? '角色一' : '角色二' },
  }));
  mocks.database.getCharacters.mockReset().mockResolvedValue([]);
  mocks.database.getSaveProfile.mockReset().mockResolvedValue(undefined);
  mocks.database.saveSaveSlot.mockReset().mockResolvedValue('save-1');
  mocks.database.deleteSaveSlot.mockReset().mockResolvedValue(undefined);
  mocks.database.getPresets.mockReset().mockResolvedValue([]);
  mocks.database.importAllData.mockReset().mockResolvedValue(undefined);
  mocks.settings.settings.activePresetId = null;
  mocks.settings.projectAgentDefaults = undefined;
  mocks.exportSessionSave.mockReset().mockResolvedValue({ kind: 'session' });
  mocks.admission.mockReset().mockReturnValue({ ok: true });
});

function findButton(text: string) {
  return [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

afterEach(() => {
  uninstallFakeLocks();
  vi.restoreAllMocks();
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('SaveManager 应用级窗口', () => {
  it('在游戏页直接显示，并优先选中当前存档而非最新存档', async () => {
    await mountManager();

    expect(document.querySelector('.save-panel-title')?.textContent).toBe('存档管理');
    expect(
      document
        .querySelector('[aria-label="选择存档：正在游玩的存档"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(mocks.ui.currentView).toBe('game');
    expect(mocks.ui.navigate).not.toHaveBeenCalled();
  });

  it('关闭窗口只调用 closeSaveManager，不导航', async () => {
    await mountManager();

    (document.querySelector('.save-panel-close') as HTMLButtonElement).click();
    await flushPromises();

    expect(mocks.ui.closeSaveManager).toHaveBeenCalledOnce();
    expect(mocks.ui.navigate).not.toHaveBeenCalled();
  });

  it('保留重命名入口和保存行为', async () => {
    await mountManager();
    const rename = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('重命名存档'),
    );

    rename!.click();
    await flushPromises();
    const input = document.querySelector('#save-rename-input') as HTMLInputElement;
    input.value = '新名称';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('.save-rename-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flushPromises();

    expect(mocks.database.saveSaveSlot).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'save-1', name: '新名称' }),
    );
    expect(mocks.ui.toast).toHaveBeenCalledWith('存档已重命名', 'success');
  });

  it('游戏中打开时，正在游玩的存档挂「游玩中」徽章，其它存档不挂', async () => {
    await mountManager();

    const playingRow = document
      .querySelector('[aria-label="选择存档：正在游玩的存档"]')
      ?.closest('.save-item');
    const otherRow = document
      .querySelector('[aria-label="选择存档：较新的存档"]')
      ?.closest('.save-item');
    expect(playingRow?.querySelector('.save-badge-playing')?.textContent).toBe('游玩中');
    expect(otherRow?.querySelector('.save-badge-playing')).toBeNull();
  });

  it('从首页打开时，即使 activeSaveId 残留也不挂「游玩中」，主按钮仍是进入游戏', async () => {
    mocks.ui.currentView = 'home';
    await mountManager();

    expect(document.querySelector('.save-badge-playing')).toBeNull();
    expect(findButton('继续游戏')).toBeUndefined();
    expect(findButton('进入游戏')).toBeDefined();
  });

  it('选中正在游玩的存档时主按钮为「继续游戏」，只关窗口、不导航、不跑准入检查', async () => {
    // 准入检查若被调用会误报警告 —— 这里故意让它失败，证明「继续游戏」绕开了它
    mocks.admission.mockReturnValue({ ok: false, reason: 'v2-disabled' });
    await mountManager();

    expect(findButton('进入游戏')).toBeUndefined();
    findButton('继续游戏')!.click();
    await flushPromises();

    expect(mocks.ui.closeSaveManager).toHaveBeenCalledOnce();
    expect(mocks.ui.navigate).not.toHaveBeenCalled();
    expect(mocks.admission).not.toHaveBeenCalled();
    expect(mocks.ui.toast).not.toHaveBeenCalled();
  });

  it('选中其它存档时主按钮仍是「进入游戏」，经准入检查后导航', async () => {
    await mountManager();
    (document.querySelector('[aria-label="选择存档：较新的存档"]') as HTMLButtonElement).click();
    await flushPromises();

    expect(findButton('继续游戏')).toBeUndefined();
    findButton('进入游戏')!.click();
    await flushPromises();

    expect(mocks.admission).toHaveBeenCalledOnce();
    expect(mocks.ui.navigate).toHaveBeenCalledWith('game', 'save-2');
  });
});

describe('SaveManager 导出存档的 story 预设', () => {
  const contentPreset = {
    id: 'pack-story',
    name: '内容默认',
    settings: {},
    createdAt: 0,
    updatedAt: 0,
  };

  async function exportSelected() {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    await mountManager();
    findButton('导出存档')!.click();
    // 导出链里有几次动态 import，flushPromises 等不到它们落地
    await vi.waitFor(() => expect(mocks.ui.toast).toHaveBeenCalled());
    return mocks.exportSessionSave.mock.calls[0]?.[1];
  }

  it('选择为空时导出生效的内容默认预设', async () => {
    mocks.settings.projectAgentDefaults = { agents: { story: { presetId: 'pack-story' } } };
    mocks.database.getPresets.mockResolvedValue([contentPreset]);

    expect(await exportSelected()).toEqual({ storyPreset: { id: 'pack-story', name: '内容默认' } });
  });

  it('选择已失效时同样回落到内容默认，而不是什么都不带', async () => {
    mocks.settings.settings.activePresetId = 'deleted-preset';
    mocks.settings.projectAgentDefaults = {
      agents: { story: { presetId: 'pack-story', preset: contentPreset } },
    };

    expect(await exportSelected()).toEqual({ storyPreset: { id: 'pack-story', name: '内容默认' } });
  });
});

/**
 * 假 navigator.locks：`external` 是别的标签页占着的锁名；本标签页经 acquireSaveTabLock
 * 申请到的锁也记在同一个集合里，query() 一并报出（与真实快照一致，不分标签页）。
 */
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
  return locks;
}

function uninstallFakeLocks() {
  delete (navigator as { locks?: unknown }).locks;
}

describe('SaveManager 删档与整库导入尊重标签页锁（R8）', () => {
  it('别的标签页正在玩的存档：删档被拒并提示，不动数据库', async () => {
    installFakeLocks(['poem-save:save-2']);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mountManager();

    (document.querySelector('[aria-label="删除存档：较新的存档"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.ui.toast).toHaveBeenCalled());

    expect(mocks.ui.toast).toHaveBeenCalledWith(SAVE_DELETE_LOCKED_MESSAGE, 'warning', 6000);
    expect(mocks.database.deleteSaveSlot).not.toHaveBeenCalled();
  });

  it('本标签页正在玩 A 档时删 A 档：照原行为删掉并回首页，不被自己的锁挡住', async () => {
    installFakeLocks();
    const own = await acquireSaveTabLock('save-1');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      await mountManager();
      findButton('删除存档')!.click();
      await vi.waitFor(() => expect(mocks.ui.navigate).toHaveBeenCalledWith('home'));

      expect(mocks.database.deleteSaveSlot).toHaveBeenCalledWith('save-1');
      expect(mocks.ui.toast).toHaveBeenCalledWith('存档已删除', 'success');
      expect(mocks.ui.activeSaveId).toBeNull();
    } finally {
      own!.release();
    }
  });

  it('环境没有 navigator.locks 时删档放行', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mountManager();

    (document.querySelector('[aria-label="删除存档：较新的存档"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.database.deleteSaveSlot).toHaveBeenCalledWith('save-2'));
  });

  async function importFullBackup() {
    const file = new File(['{"version":1,"saves":[]}'], 'backup.json', {
      type: 'application/json',
    });
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    await mountManager();
    findButton('导入存档')!.click();
    await vi.waitFor(() => expect(findButton('替换备份数据并导入')).toBeDefined());
    clickSpy.mockRestore();
    findButton('替换备份数据并导入')!.click();
    await vi.waitFor(() => expect(mocks.ui.toast).toHaveBeenCalled());
  }

  it('别的标签页在玩任一存档时，整库导入被拒并提示', async () => {
    installFakeLocks(['poem-save:save-2']);
    await importFullBackup();

    expect(mocks.ui.toast).toHaveBeenCalledWith(FULL_IMPORT_LOCKED_MESSAGE, 'warning', 6000);
    expect(mocks.database.importAllData).not.toHaveBeenCalled();
  });

  it('只有本标签页自己持锁时，整库导入照常进行', async () => {
    installFakeLocks();
    const own = await acquireSaveTabLock('save-1');
    try {
      await importFullBackup();
      expect(mocks.database.importAllData).toHaveBeenCalledOnce();
      expect(mocks.ui.toast).toHaveBeenCalledWith('整库备份恢复成功', 'success');
    } finally {
      own!.release();
    }
  });
});
