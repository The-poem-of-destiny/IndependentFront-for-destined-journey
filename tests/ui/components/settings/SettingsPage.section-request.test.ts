/**
 * 设置页分区跳转请求 —— 已在设置页时同样立即生效（UIL-06）
 *
 * 修的 bug：`requestedSettingsSection` 只在设置页挂载时消费一次。人已经在设置页里，
 * 限流弹窗「去 API 设置」、内容横幅「管理 Discord 授权」这类入口点了没反应，
 * 请求却一直滞留，下一次从游戏菜单进设置页时把人劫持到那个旧分区。
 *
 * 各分区子组件全部替身（它们各自的启动逻辑与本题无关），ui-store 用真身。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/** 分区替身；anchor 给定时在里面放一张带该锚点的卡，验证跳转后滚到它 */
function stub(name: string, anchor?: string) {
  const render = () =>
    h(
      'div',
      { class: `stub-${name}` },
      anchor ? [h('div', { class: 'stub-pack-card', 'data-settings-anchor': anchor })] : [],
    );
  return { default: defineComponent({ name, render }) };
}

vi.mock('@ui/stores/game-store', () => ({
  useGameStore: () => ({ clearActive: vi.fn(), saves: [] }),
}));
vi.mock('@ui/stores/settings-store', () => ({
  useSettingsStore: () => ({
    settings: { apiPool: [], activeAgent: null },
    projectAgentDefaults: null,
  }),
}));
vi.mock('@ui/stores/agent-settings', () => ({ getAgentSettings: () => ({ model: '' }) }));
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
vi.mock('@ui/components/settings/DataSection.vue', () => stub('DataSection', 'content-pack'));
vi.mock('@ui/components/settings/DeveloperSection.vue', () => stub('DeveloperSection'));
vi.mock('@ui/components/settings/AboutSection.vue', () => stub('AboutSection'));

import SettingsPage from '@ui/components/settings/SettingsPage.vue';
import { useUIStore } from '@ui/stores/ui-store';

function activeLabel(wrapper: ReturnType<typeof mount>): string {
  return wrapper.get('.nav-active').text();
}

const scrolled: { el: Element; opts: unknown }[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  scrolled.length = 0;
  // jsdom 没有 scrollIntoView；录下被滚到的元素与参数
  Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
    scrolled.push({ el: this, opts });
  } as Element['scrollIntoView'];
});

/** 等分区切换渲染完、逐帧找锚点的那次尝试落地 */
async function settle() {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('SettingsPage 分区跳转请求', () => {
  it('挂载时消费请求：从外面打开指定分区', async () => {
    const ui = useUIStore();
    ui.openSettings('data');

    const wrapper = mount(SettingsPage, { global: { stubs: { Transition: false } } });
    await flushPromises();

    expect(activeLabel(wrapper)).toBe('数据与备份');
    expect(ui.requestedSettingsSection).toBeNull();
  });

  it('已在设置页时发出的请求立即切换分区，且不滞留', async () => {
    const ui = useUIStore();
    ui.navigate('settings');
    const wrapper = mount(SettingsPage);
    await flushPromises();
    expect(activeLabel(wrapper)).toBe('API 配置');

    ui.openSettings('image');
    await nextTick();

    expect(activeLabel(wrapper)).toBe('图像生成');
    // 请求已被消费 —— 下一次进入设置页不会被它劫持到旧分区
    expect(ui.requestedSettingsSection).toBeNull();
  });

  it('请求 agent 分区时同样恢复上次选中的 Agent（走 selectSection）', async () => {
    const ui = useUIStore();
    ui.navigate('settings');
    const wrapper = mount(SettingsPage);
    await flushPromises();

    ui.openSettings('agent');
    await nextTick();

    expect(activeLabel(wrapper)).toBe('Agent 配置');
    expect(wrapper.find('.sub-nav').exists()).toBe(true);
  });
});

describe('SettingsPage 卡片锚点', () => {
  it('挂载时带锚点 → 切到数据分区并把内容包卡滚进视野', async () => {
    const ui = useUIStore();
    ui.openSettings('data', 'content-pack');

    const wrapper = mount(SettingsPage, { attachTo: document.body });
    await settle();

    expect(activeLabel(wrapper)).toBe('数据与备份');
    expect(scrolled.map((s) => s.el.className)).toEqual(['stub-pack-card']);
    expect(ui.requestedSettingsAnchor).toBeNull();
    wrapper.unmount();
  });

  it('已在设置页时带锚点的请求同样滚到目标卡；减动效时不平滑滚动', async () => {
    document.documentElement.setAttribute('data-reduced-motion', 'true');
    try {
      const ui = useUIStore();
      ui.navigate('settings');
      const wrapper = mount(SettingsPage, { attachTo: document.body });
      await settle();
      expect(scrolled).toHaveLength(0);

      ui.openSettings('data', 'content-pack');
      await settle();

      expect(activeLabel(wrapper)).toBe('数据与备份');
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]?.opts).toMatchObject({ behavior: 'auto' });
      expect(ui.requestedSettingsAnchor).toBeNull();
      wrapper.unmount();
    } finally {
      document.documentElement.removeAttribute('data-reduced-motion');
    }
  });
});
