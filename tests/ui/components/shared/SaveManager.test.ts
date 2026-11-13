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
    reloadApiEntries: vi.fn(),
  },
  admission: vi.fn(),
  database: {
    getSave: vi.fn(),
    getCharacters: vi.fn(),
    getSaveProfile: vi.fn(),
    saveSaveSlot: vi.fn(),
    deleteSaveSlot: vi.fn(),
    getPresets: vi.fn(),
  },
}));

vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => mocks.game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => mocks.ui }));
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => mocks.settings,
}));
vi.mock('@engine/persistence/database', () => mocks.database);
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
  mocks.admission.mockReset().mockReturnValue({ ok: true });
});

function findButton(text: string) {
  return [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

afterEach(() => {
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
