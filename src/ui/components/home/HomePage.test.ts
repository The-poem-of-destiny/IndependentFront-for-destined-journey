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
        AppButton: { template: '<button v-bind="$attrs"><slot /></button>' },
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

describe('HomePage 存档管理子页面', () => {
  it('将入口命名为“存档管理”并点击打开子页面', async () => {
    const home = await mountHome();
    const management = home.get('.btn-load');

    expect(management.text().replace(/\s/g, '')).toBe('存档管理');
    expect(home.find('.save-panel').exists()).toBe(false);

    await management.trigger('click');
    await flushPromises();

    expect(home.get('.save-panel-title').text()).toBe('存档管理');
    expect(home.get('.save-panel').attributes('role')).toBe('dialog');
    expect(home.get('.save-panel-header-actions').text()).toContain('新建存档');
    expect(home.get('.save-panel-header-actions').text()).toContain('导入存档');
  });

  it('从子页面进入新建存档流程', async () => {
    const home = await mountHome();
    await home.get('.btn-load').trigger('click');
    await flushPromises();

    const newSave = home
      .get('.save-panel-header-actions')
      .findAll('button')
      .find((button) => button.text().includes('新建存档'));
    expect(newSave).toBeTruthy();

    await newSave!.trigger('click');
    expect(mocks.ui.navigate).toHaveBeenCalledWith('create');
  });

  it('在子页面集中提供导出、删除与重命名，并可保存新名称', async () => {
    const save = {
      id: 'save-1',
      name: '旧名称',
      slot: 0,
      createdAt: 100,
      updatedAt: 200,
      activeSnapshotId: null,
      metadata: {
        characterName: '测试角色',
        userName: '测试玩家',
        gameStartTime: '测试纪元',
        totalTurns: 3,
      },
    };
    mocks.game.saves.push(save);
    mocks.database.getSave.mockResolvedValue(save);
    const home = await mountHome();
    await home.get('.btn-load').trigger('click');
    await flushPromises();

    const actions = home.get('.save-preview-actions');
    expect(actions.text()).toContain('导出存档');
    expect(actions.text()).toContain('删除存档');
    const rename = actions.findAll('button').find((button) => button.text().includes('重命名存档'));
    await rename!.trigger('click');
    await flushPromises();

    await home.get('#save-rename-input').setValue('新名称');
    await home.get('.save-rename-form').trigger('submit');
    await flushPromises();

    expect(mocks.database.saveSaveSlot).toHaveBeenCalledWith({ ...save, name: '新名称' });
    expect(mocks.ui.toast).toHaveBeenCalledWith('存档已重命名', 'success');
  });
});
