/**
 * 设置页 Agent 子导航角标（S-08）与未保存提示词守卫（S-15）
 *
 * 角标此前只看 model 是否非空：没绑定的 Agent 挂红 ✕（其实会自动用第一个 API），
 * 绑到不存在的池的却挂绿 ✓（运行时才硬失败）。现在从 `resolveAgentEndpoint` 推导四态。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

function stub(name: string) {
  return { default: defineComponent({ name, render: () => h('div', { class: `stub-${name}` }) }) };
}

const state = vi.hoisted(() => ({
  store: null as unknown as {
    settings: Record<string, unknown>;
    projectAgentDefaults: { agents: Record<string, Record<string, unknown>> };
  },
}));
const confirmDialog = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => true));

vi.mock('@ui/lib/confirm-dialog', () => ({ confirmDialog }));
vi.mock('@ui/stores/game-store', () => ({
  useGameStore: () => ({ clearActive: vi.fn(), saves: [] }),
}));
vi.mock('@ui/stores/settings-store', () => ({ useSettingsStore: () => state.store }));
vi.mock('@ui/stores/worldbook-store', () => ({
  useWorldBookStore: () => ({ init: async () => undefined }),
}));
vi.mock('@ui/components/shared/ContentStatusBanner.vue', () => stub('ContentStatusBanner'));
vi.mock('@ui/components/settings/agent/AgentSection.vue', () => stub('AgentSection'));
vi.mock('@ui/components/settings/agent/AgentUpdateCenter.vue', () => stub('AgentUpdateCenter'));
vi.mock('@ui/components/settings/ApiSection.vue', () => stub('ApiSection'));
vi.mock('@ui/components/settings/WorldBookSection.vue', () => stub('WorldBookSection'));
vi.mock('@ui/components/settings/PlotSection.vue', () => stub('PlotSection'));
vi.mock('@ui/components/settings/MemorySection.vue', () => stub('MemorySection'));
vi.mock('@ui/components/settings/ThemeSection.vue', () => stub('ThemeSection'));
vi.mock('@ui/components/settings/MessagesSection.vue', () => stub('MessagesSection'));
vi.mock('@ui/components/settings/BeautifierSection.vue', () => stub('BeautifierSection'));
vi.mock('@ui/components/settings/AudioSection.vue', () => stub('AudioSection'));
vi.mock('@ui/components/settings/AssetSection.vue', () => stub('AssetSection'));
vi.mock('@ui/components/settings/image/ImageSection.vue', () => stub('ImageSection'));
vi.mock('@ui/components/settings/DataSection.vue', () => stub('DataSection'));
vi.mock('@ui/components/settings/ContentPackSection.vue', () => stub('ContentPackSection'));
vi.mock('@ui/components/settings/DeveloperSection.vue', () => stub('DeveloperSection'));
vi.mock('@ui/components/settings/AboutSection.vue', () => stub('AboutSection'));

import SettingsPage from '@ui/components/settings/SettingsPage.vue';
import { promptDraftDirty } from '@ui/components/settings/agent/prompt-dirty-guard';
import { useUIStore } from '@ui/stores/ui-store';

const pool = [
  { id: 'p1', name: '主力 API', baseUrl: 'https://a.test', model: 'm', kind: 'llm' },
  { id: 'p2', name: '备用 API', baseUrl: 'https://b.test', model: 'm', kind: 'llm' },
];

beforeEach(() => {
  setActivePinia(createPinia());
  confirmDialog.mockReset();
  confirmDialog.mockResolvedValue(true);
  promptDraftDirty.value = false;
  state.store = reactive({
    settings: { apiPool: [], activeAgent: null, agents: {} },
    projectAgentDefaults: { agents: {} },
  });
});

async function openAgentNav() {
  const ui = useUIStore();
  ui.openSettings('agent');
  const wrapper = mount(SettingsPage);
  await flushPromises();
  return wrapper;
}

function badgeOf(wrapper: ReturnType<typeof mount>, name: string) {
  const item = wrapper.findAll('.sub-nav-item').find((el) => el.text().startsWith(name));
  return item!.get('.sub-nav-badge');
}

describe('S-08 子导航角标', () => {
  it('没有任何 API → 全部「!」', async () => {
    const wrapper = await openAgentNav();
    expect(badgeOf(wrapper, '正文生成').text()).toBe('!');
  });

  it('没绑定 → 跟随默认（中性，不是红色），悬停说明会用哪个 API', async () => {
    state.store.settings.apiPool = pool;
    const wrapper = await openAgentNav();
    const badge = badgeOf(wrapper, '变量更新');
    expect(badge.classes()).toContain('sub-nav-default');
    expect(badge.classes()).not.toContain('sub-nav-bad');
    expect(badge.attributes('title')).toBe('跟随默认：主力 API');
    expect(badge.attributes('aria-label')).toBe('跟随默认：主力 API');
  });

  it('🔴 S-00：内容包默认层带着本机不存在的池 id → 跟随默认，不是绿勾也不是红叉', async () => {
    state.store.settings.apiPool = pool;
    state.store.projectAgentDefaults.agents.story = { model: 'author-machine-uuid' };
    const wrapper = await openAgentNav();
    expect(badgeOf(wrapper, '正文生成').attributes('data-binding')).toBe('follow-default');
  });

  it('用户指定且存在 → ✓；用户指定的 API 已删除 → 红色 ✕「绑定失效」', async () => {
    state.store.settings.apiPool = pool;
    state.store.settings.agents = { story: { model: 'p2' }, vars_update: { model: 'gone' } };
    const wrapper = await openAgentNav();
    const ok = badgeOf(wrapper, '正文生成');
    expect(ok.classes()).toContain('sub-nav-ok');
    expect(ok.attributes('title')).toBe('已指定：备用 API');
    const stale = badgeOf(wrapper, '变量更新');
    expect(stale.classes()).toContain('sub-nav-bad');
    expect(stale.attributes('title')).toContain('绑定失效');
  });
});

describe('S-15 未保存提示词的导航守卫', () => {
  it('没有未保存修改 → 切 Agent 不弹确认', async () => {
    const wrapper = await openAgentNav();
    await wrapper.findAll('.sub-nav-item')[1].trigger('click');
    await flushPromises();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(wrapper.find('.sub-nav-active').exists()).toBe(true);
  });

  it('有未保存修改 → 切 Agent 先问；选「继续编辑」就留在原处', async () => {
    const wrapper = await openAgentNav();
    await wrapper.findAll('.sub-nav-item')[0].trigger('click');
    await flushPromises();
    const first = wrapper.get('.sub-nav-active').text();

    promptDraftDirty.value = true;
    confirmDialog.mockResolvedValue(false);
    await wrapper.findAll('.sub-nav-item')[1].trigger('click');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: '放弃修改', cancelLabel: '继续编辑' }),
    );
    expect(wrapper.get('.sub-nav-active').text()).toBe(first);
    expect(promptDraftDirty.value).toBe(true);
  });

  it('有未保存修改 → 换分区选「放弃修改」才离开', async () => {
    const wrapper = await openAgentNav();
    promptDraftDirty.value = true;
    confirmDialog.mockResolvedValue(true);
    const apiNav = wrapper.findAll('.nav-item').find((el) => el.text().includes('API 配置'))!;
    await apiNav.trigger('click');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(wrapper.get('.nav-active').text()).toContain('API 配置');
    expect(promptDraftDirty.value).toBe(false);
  });

  it('有未保存修改 → 「← 返回」也先问，取消则不离开设置页', async () => {
    const ui = useUIStore();
    const back = vi.spyOn(ui, 'back');
    const wrapper = await openAgentNav();
    promptDraftDirty.value = true;
    confirmDialog.mockResolvedValue(false);
    await wrapper.get('.settings-header button').trigger('click');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
  });

  it('有未保存修改 → 「扩展管理」也先问：取消留在设置页，确认才跳转', async () => {
    const ui = useUIStore();
    const navigate = vi.spyOn(ui, 'navigate');
    const wrapper = await openAgentNav();
    const extNav = wrapper.get('.nav-external');

    promptDraftDirty.value = true;
    confirmDialog.mockResolvedValue(false);
    await extNav.trigger('click');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(promptDraftDirty.value).toBe(true);

    confirmDialog.mockResolvedValue(true);
    await extNav.trigger('click');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith('extensions');
    expect(promptDraftDirty.value).toBe(false);
  });
});
