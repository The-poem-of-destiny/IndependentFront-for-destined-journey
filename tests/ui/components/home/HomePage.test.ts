/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils';
import HomePage from '../../../../src/ui/components/home/HomePage.vue';
import HomeOnboarding from '../../../../src/ui/components/home/HomeOnboarding.vue';
import { useWorkshopStore } from '../../../../src/ui/stores/workshop-store';
import { useSettingsStore } from '../../../../src/ui/stores/settings-store';
import { useContentStore } from '../../../../src/ui/stores/content-store';
import { useApiSourceStore } from '../../../../src/ui/stores/api-source-store';

/** 取被替身的工坊 store（响应式），按替身形状读写 */
function workshopMock(): { ready: boolean; projects: Array<{ id: string }> } {
  return useWorkshopStore() as unknown as { ready: boolean; projects: Array<{ id: string }> };
}

/** 取被替身的设置 / 内容 / API 源 store（响应式） */
function settingsMock(): { apiPool: unknown[]; onboardingDismissed: boolean } {
  return useSettingsStore().settings as unknown as {
    apiPool: unknown[];
    onboardingDismissed: boolean;
  };
}
function contentMock(): { contentStatus: string; activePackId: string | null } {
  return useContentStore() as unknown as { contentStatus: string; activePackId: string | null };
}
function apiSourcesMock(): { initialized: boolean } {
  return useApiSourceStore() as unknown as { initialized: boolean };
}

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
    settings: {
      activePresetId: null,
      apiPool: [] as unknown[],
      onboardingDismissed: false,
    },
  },
  content: {
    contentStatus: 'placeholder' as string,
    activePackId: null as string | null,
    hydratePackState: vi.fn<() => Promise<void>>(),
  },
  apiSources: {
    initialized: true,
    initialize: vi.fn<() => Promise<void>>(),
  },
  workshop: {
    ready: true,
    projects: [{ id: 'p1' }] as Array<{ id: string }>,
    init: vi.fn<() => Promise<void>>(),
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

vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => mocks.game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => mocks.ui }));
vi.mock('../../../../src/ui/stores/workshop-store', async () => {
  const { reactive } = await import('vue');
  const store = reactive(mocks.workshop);
  return { useWorkshopStore: () => store };
});
vi.mock('../../../../src/ui/stores/settings-store', async () => {
  const { reactive } = await import('vue');
  const store = reactive(mocks.settings);
  return { useSettingsStore: () => store };
});
vi.mock('../../../../src/ui/stores/content-store', async () => {
  const { reactive } = await import('vue');
  const store = reactive(mocks.content);
  return { useContentStore: () => store };
});
vi.mock('../../../../src/ui/stores/api-source-store', async () => {
  const { reactive } = await import('vue');
  const store = reactive(mocks.apiSources);
  return { useApiSourceStore: () => store };
});
vi.mock('@engine/index', () => ({ VERSION: 'test' }));
vi.mock('@engine/persistence/database', () => mocks.database);
vi.mock('../../../../src/ui/branding-defaults', async () => {
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
        AppModal: {
          name: 'AppModal',
          props: { open: Boolean, title: String, size: String },
          emits: ['update:open', 'close'],
          template: '<div v-if="open" class="modal-stub"><slot /></div>',
        },
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
  const workshop = workshopMock();
  workshop.ready = true;
  workshop.projects = [{ id: 'p1' }];
  mocks.workshop.init.mockReset().mockResolvedValue();
  mocks.database.getSave.mockReset().mockResolvedValue(undefined);
  mocks.database.getCharacters.mockReset().mockResolvedValue([]);
  mocks.database.getSaveProfile.mockReset().mockResolvedValue(undefined);
  mocks.database.saveSaveSlot.mockReset().mockResolvedValue('save-1');
  mocks.database.deleteSaveSlot.mockReset().mockResolvedValue(undefined);
  mocks.database.getPresets.mockReset().mockResolvedValue([]);
  const settings = settingsMock();
  settings.apiPool = [];
  settings.onboardingDismissed = false;
  const content = contentMock();
  content.contentStatus = 'placeholder';
  content.activePackId = null;
  mocks.content.hydratePackState.mockReset().mockResolvedValue();
  apiSourcesMock().initialized = true;
  mocks.apiSources.initialize.mockReset().mockResolvedValue();
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

  it('无存档时不显示次级「新建存档」按钮（主按钮已是新建）', async () => {
    const home = await mountHome();

    expect(home.find('.btn-new-save').exists()).toBe(false);
  });

  it('存在存档时在「继续」下方显示次级「新建存档」，点击进入创角页', async () => {
    mocks.game.saves.push({ id: 'latest-save', updatedAt: 300 });
    const home = await mountHome();
    const labels = home
      .get('.btn-column')
      .findAll('button')
      .map((button) => button.text().replace(/\s/g, ''));

    expect(labels.slice(0, 3)).toEqual(['✦继续', '新建存档', '存档管理']);
    await home.get('.btn-new-save').trigger('click');

    expect(mocks.ui.navigate).toHaveBeenCalledWith('create');
    expect(mocks.ui.navigate).not.toHaveBeenCalledWith('game', expect.anything());
  });
});

describe('HomePage 背景联动', () => {
  it('悬停主按钮拉满能量、离开归零，点击触发共鸣脉冲', async () => {
    const setEnergy = vi.fn();
    const pulse = vi.fn();
    const BackdropStub = defineComponent({
      name: 'AstralDriftBackdrop',
      setup(_props, { expose }) {
        expose({ setEnergy, pulse });
        return () => h('div', { class: 'backdrop-stub' });
      },
    });
    wrapper = shallowMount(HomePage, {
      global: {
        stubs: {
          AppButton: {
            props: { block: Boolean },
            template: '<button v-bind="$attrs" :class="{ \'btn-block\': block }"><slot /></button>',
          },
          AppModal: true,
          AstralDriftBackdrop: BackdropStub,
          ContentStatusBanner: true,
          Teleport: true,
          Transition: false,
        },
      },
    });
    await flushPromises();
    const button = wrapper.get('.btn-new-game');

    await button.trigger('mouseover');
    expect(setEnergy).toHaveBeenLastCalledWith(1);

    await button.trigger('mouseout');
    expect(setEnergy).toHaveBeenLastCalledWith(0);

    await button.trigger('click');
    expect(pulse).toHaveBeenCalledOnce();
    expect(mocks.ui.navigate).toHaveBeenCalledWith('create');
  });
});

describe('HomePage 扩展管理入口', () => {
  it('装过社区扩展时显示“扩展管理”并进入扩展管理页', async () => {
    const home = await mountHome();
    const button = home.get('.btn-extensions');

    expect(mocks.workshop.init).toHaveBeenCalled();
    expect(button.text().replace(/\s/g, '')).toBe('扩展管理');
    await button.trigger('click');

    expect(mocks.ui.navigate).toHaveBeenCalledWith('extensions');
  });

  it('工坊锁定且没有安装任何社区扩展时隐藏入口，其余按钮依次紧接', async () => {
    workshopMock().projects = [];
    const home = await mountHome();

    expect(home.find('.btn-extensions').exists()).toBe(false);
    const labels = home
      .get('.btn-column')
      .findAll('button')
      .map((button) => button.text().replace(/\s/g, ''));
    expect(labels).toEqual(['✦新建存档', '存档管理', '设置', '关于', '退出']);
  });

  it('已安装项目还没读完时先不显示，读完且有项目后再出现（不闪烁）', async () => {
    const workshop = workshopMock();
    workshop.ready = false;
    workshop.projects = [];
    let resolveInit: () => void = () => {};
    mocks.workshop.init.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      }),
    );
    const home = await mountHome();
    expect(home.find('.btn-extensions').exists()).toBe(false);

    workshop.projects = [{ id: 'p1' }];
    workshop.ready = true;
    resolveInit();
    await flushPromises();
    expect(home.find('.btn-extensions').exists()).toBe(true);
  });

  it('读取已安装项目失败时保持隐藏，不影响首页其余部分', async () => {
    const workshop = workshopMock();
    workshop.ready = false;
    workshop.projects = [];
    mocks.workshop.init.mockRejectedValue(new Error('读库失败'));
    const home = await mountHome();

    expect(home.find('.btn-extensions').exists()).toBe(false);
    expect(home.find('.btn-settings').exists()).toBe(true);
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

  it('设置打开默认分区，关于在首页原位打开关于弹窗而不跳转到设置页', async () => {
    const home = await mountHome();
    expect(home.findComponent({ name: 'AppModal' }).props('open')).toBe(false);

    await home.get('.btn-settings').trigger('click');
    expect(mocks.ui.openSettings).toHaveBeenCalledOnce();
    expect(mocks.ui.openSettings).toHaveBeenCalledWith();

    await home.get('.btn-about').trigger('click');
    expect(mocks.ui.openSettings).toHaveBeenCalledOnce();
    expect(mocks.ui.navigate).not.toHaveBeenCalled();
    expect(home.findComponent({ name: 'AppModal' }).props('open')).toBe(true);
    expect(home.findComponent({ name: 'AboutSection' }).exists()).toBe(true);
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

const usableLlm = {
  id: 'chat',
  name: 'Local',
  baseUrl: 'http://localhost:1234/v1',
  model: 'local-model',
  apiType: 'chat',
};

function onboarding(home: VueWrapper) {
  return home.findComponent(HomeOnboarding);
}

describe('HomePage 开始前的三步', () => {
  it('新玩家（三份数据都读完、什么都没做）自动展开，且挂在按钮列之外', async () => {
    const home = await mountHome();
    const panel = onboarding(home);

    expect(panel.props('state')).toBe('expanded');
    expect(panel.props('model').doneCount).toBe(0);
    expect(home.get('.btn-column').findComponent(HomeOnboarding).exists()).toBe(false);
    expect(mocks.content.hydratePackState).toHaveBeenCalled();
    expect(mocks.apiSources.initialize).toHaveBeenCalled();
  });

  it('内容态、API 源或存档还在读取时不出现（不闪现）', async () => {
    let resolveContent: () => void = () => {};
    mocks.content.hydratePackState.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveContent = resolve;
      }),
    );
    apiSourcesMock().initialized = false;
    const home = await mountHome();
    expect(onboarding(home).props('state')).toBe('hidden');

    resolveContent();
    await flushPromises();
    expect(onboarding(home).props('state')).toBe('hidden');

    apiSourcesMock().initialized = true;
    await flushPromises();
    expect(onboarding(home).props('state')).toBe('expanded');
  });

  it('读内容态失败按已读完处理，面板照常出现', async () => {
    mocks.content.hydratePackState.mockRejectedValue(new Error('读库失败'));
    const home = await mountHome();

    expect(onboarding(home).props('state')).toBe('expanded');
  });

  it('三个直达按钮：内容包 / API 去对应设置分区，存档走新建存档', async () => {
    const home = await mountHome();
    const panel = onboarding(home);

    panel.vm.$emit('go', 'content');
    panel.vm.$emit('go', 'api');
    panel.vm.$emit('go', 'save');

    expect(mocks.ui.openSettings.mock.calls).toEqual([['content-pack'], ['api']]);
    expect(mocks.ui.navigate).toHaveBeenCalledWith('create');
  });

  it('关闭后收起、重新打开后展开；「不再显示」写偏好并清掉手动选择', async () => {
    const home = await mountHome();

    onboarding(home).vm.$emit('close');
    await flushPromises();
    expect(onboarding(home).props('state')).toBe('collapsed');

    onboarding(home).vm.$emit('open');
    await flushPromises();
    expect(onboarding(home).props('state')).toBe('expanded');

    onboarding(home).vm.$emit('dismiss');
    await flushPromises();
    expect(settingsMock().onboardingDismissed).toBe(true);
    expect(onboarding(home).props('state')).toBe('collapsed');

    onboarding(home).vm.$emit('open');
    await flushPromises();
    expect(onboarding(home).props('state')).toBe('expanded');
  });

  it('点过「不再显示」的玩家只看到收起入口', async () => {
    settingsMock().onboardingDismissed = true;
    const home = await mountHome();

    expect(onboarding(home).props('state')).toBe('collapsed');
  });

  it('必需步（API + 存档）都满足时自动收起，三步全完成时连入口一起隐藏', async () => {
    settingsMock().apiPool = [usableLlm];
    mocks.game.saves.push({ id: 'save-1', updatedAt: 1 });
    const home = await mountHome();
    expect(onboarding(home).props('state')).toBe('collapsed');
    expect(onboarding(home).props('model').doneCount).toBe(2);

    const content = contentMock();
    content.contentStatus = 'pack';
    content.activePackId = 'fated-poem';
    await flushPromises();
    expect(onboarding(home).props('state')).toBe('hidden');
  });
});
