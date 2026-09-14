/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils';
import HomePage from './HomePage.vue';

const mocks = vi.hoisted(() => ({
  game: {
    saves: [] as Array<{
      id: string;
      updatedAt: number;
      name?: string;
      slot?: number;
      createdAt?: number;
      activeSnapshotId?: string | null;
      metadata?: {
        characterName: string;
        userName: string;
        gameStartTime: string;
        totalTurns: number;
      };
    }>,
    loadSaves: vi.fn<() => Promise<void>>(),
  },
  ui: {
    navigate: vi.fn(),
    openSettings: vi.fn(),
    openSaveManager: vi.fn(),
    toast: vi.fn(),
  },
  settings: {
    settings: { activePresetId: null },
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
vi.mock('@engine/index', () => ({ VERSION: 'test' }));
vi.mock('@engine/database', () => mocks.database);
vi.mock('../../branding-defaults', async () => {
  const { ref } = await import('vue');
  return {
    useBranding: () => ({
      branding: ref({
        titleLines: ['测试标题'],
        tagline: '',
        subtitles: [],
        credits: '',
        worldSummary: { title: '', lines: [] },
      }),
    }),
  };
});

let wrapper: VueWrapper | null = null;

async function mountHome() {
  wrapper = shallowMount(HomePage, {
    global: {
      stubs: {
        AppButton: {
          props: { block: Boolean },
          template: '<button v-bind="$attrs" :class="{ \'btn-block\': block }"><slot /></button>',
        },
        AppModal: true,
        AstralDriftBackdrop: true,
        ContentStatusBanner: true,
        Teleport: true,
        Transition: false,
      },
    },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  mocks.game.saves.length = 0;
  mocks.game.loadSaves.mockReset().mockResolvedValue();
  mocks.ui.navigate.mockReset();
  mocks.ui.openSettings.mockReset();
  mocks.ui.openSaveManager.mockReset();
  mocks.ui.toast.mockReset();
  mocks.database.getSave.mockReset().mockResolvedValue(undefined);
  mocks.database.getCharacters.mockReset().mockResolvedValue([]);
  mocks.database.getSaveProfile.mockReset().mockResolvedValue(undefined);
  mocks.database.saveSaveSlot.mockReset().mockResolvedValue('save-1');
  mocks.database.deleteSaveSlot.mockReset().mockResolvedValue(undefined);
  mocks.database.getPresets.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.classList.remove('home-entered');
});

describe('HomePage 主存档按钮', () => {
  it('无存档时显示“新建存档”并进入创角页', async () => {
    const home = await mountHome();
    const button = home.get('.btn-new-game');

    expect(button.text().replace(/\s/g, '')).toBe('✦新建存档');
    await button.trigger('click');

    expect(mocks.ui.navigate).toHaveBeenCalledWith('create');
  });

  it('存在存档时显示“继续”并读取 updatedAt 最新的存档', async () => {
    mocks.game.saves.push(
      { id: 'old-save', updatedAt: 100 },
      { id: 'latest-save', updatedAt: 300 },
      { id: 'middle-save', updatedAt: 200 },
    );
    const home = await mountHome();
    const button = home.get('.btn-new-game');

    expect(button.text().replace(/\s/g, '')).toBe('✦继续');
    await button.trigger('click');

    expect(mocks.ui.navigate).toHaveBeenCalledWith('game', 'latest-save');
  });
});

describe('HomePage 扩展管理入口', () => {
  it('使用“扩展管理”命名并进入扩展管理页', async () => {
    const home = await mountHome();
    const button = home.get('.btn-extensions');

    expect(button.text().replace(/\s/g, '')).toBe('扩展管理');
    await button.trigger('click');

    expect(mocks.ui.navigate).toHaveBeenCalledWith('extensions');
  });
});

describe('HomePage 次级入口布局', () => {
  it('设置是扩展管理下方的完整按钮，关于与退出占据原双按钮行', async () => {
    const home = await mountHome();
    const column = home.get('.btn-column');
    const buttons = column.findAll('button');

    expect(buttons.map((button) => button.text().replace(/\s/g, ''))).toEqual([
      '✦新建存档',
      '存档管理',
      '扩展管理',
      '设置',
      '关于',
      '退出',
    ]);
    expect(home.get('.btn-settings').classes()).toContain('btn-block');
    expect(home.get('.btn-row').findAll('button')).toHaveLength(2);
  });

  it('设置打开默认分区，关于直接打开设置页的关于分区', async () => {
    const home = await mountHome();

    await home.get('.btn-settings').trigger('click');
    expect(mocks.ui.openSettings).toHaveBeenCalledWith();

    await home.get('.btn-about').trigger('click');
    expect(mocks.ui.openSettings).toHaveBeenCalledWith('about');
  });

  it('存档管理按钮打开应用级窗口，不触发页面导航', async () => {
    const home = await mountHome();
    expect(home.find('.save-panel').exists()).toBe(false);

    await home.get('.btn-load').trigger('click');

    expect(mocks.ui.openSaveManager).toHaveBeenCalledOnce();
    expect(mocks.ui.navigate).not.toHaveBeenCalled();
    expect(home.find('.save-panel').exists()).toBe(false);
  });

  it('退出按钮请求关闭当前应用窗口', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const home = await mountHome();

    await home.get('.btn-exit').trigger('click');

    expect(close).toHaveBeenCalledOnce();
    close.mockRestore();
  });
});
