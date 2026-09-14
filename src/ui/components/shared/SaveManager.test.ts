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
import SaveManager from './SaveManager.vue';

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
  database: {
    getSave: vi.fn(),
    getCharacters: vi.fn(),
    getSaveProfile: vi.fn(),
    saveSaveSlot: vi.fn(),
    deleteSaveSlot: vi.fn(),
    getPresets: vi.fn(),
  },
}));

vi.mock('../../stores/game-store', () => ({ useGameStore: () => mocks.game }));
vi.mock('../../stores/ui-store', () => ({ useUIStore: () => mocks.ui }));
vi.mock('../../stores/settings-store', () => ({ useSettingsStore: () => mocks.settings }));
vi.mock('@engine/database', () => mocks.database);

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
});

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
});
