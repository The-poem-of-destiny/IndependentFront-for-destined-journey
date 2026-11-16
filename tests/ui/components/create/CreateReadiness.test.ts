// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import CreateReadiness from '../../../../src/ui/components/create/CreateReadiness.vue';
import type { ReadinessIssue } from '../../../../src/ui/lib/journey-readiness';

type Props = InstanceType<typeof CreateReadiness>['$props'];

function mountReadiness(overrides: Partial<Props> = {}) {
  return mount(CreateReadiness, {
    props: {
      generationMode: '',
      issues: [],
      checking: false,
      checkError: '',
      catalogStatus: 'ready',
      contentSource: 'pack',
      blocked: false,
      ...overrides,
    },
    global: { stubs: { ContentStatusBanner: true } },
  });
}

const modeIssue: ReadinessIssue = { message: '尚未选择生成模式。', blocking: true };
const apiIssue: ReadinessIssue = {
  message: '尚未配置 API，请添加服务地址并选择模型。',
  section: 'api',
  blocking: true,
};

function buttons(wrapper: ReturnType<typeof mountReadiness>, text: string) {
  return wrapper.findAll('button').filter((button) => button.text() === text);
}

describe('CreateReadiness 准入页', () => {
  it('三张模式卡不预选；点卡片发出 update:generationMode', async () => {
    const wrapper = mountReadiness();
    const cards = wrapper.findAll('.mode-card');
    expect(cards).toHaveLength(3);
    expect(wrapper.findAll('.card-selected')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('推荐');
    await cards[1].trigger('click');
    expect(wrapper.emitted('update:generationMode')).toEqual([['direct']]);
  });

  it('选中的模式卡带选中态', () => {
    const wrapper = mountReadiness({ generationMode: 'direct_cached' });
    const selected = wrapper.findAll('.card-selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].text()).toContain('直出（缓存优化）');
  });

  it('主按钮禁用时下方给出待处理项数，且原因行是 live region', () => {
    const wrapper = mountReadiness({ issues: [modeIssue, apiIssue], blocked: true });
    const start = buttons(wrapper, '开始创建角色')[0];
    expect(start.attributes('disabled')).toBeDefined();
    const reason = wrapper.find('.blocked-reason');
    expect(reason.attributes('aria-live')).toBe('polite');
    expect(reason.text()).toBe('还有 2 项需要处理');
    expect(wrapper.text()).not.toContain('对话配置已齐备');
  });

  it('未选模式时清单列出模式项，不显示「已齐备」；选定后才显示', async () => {
    const wrapper = mountReadiness({ issues: [modeIssue], blocked: true });
    expect(wrapper.find('.check-list').text()).toContain('尚未选择生成模式');
    expect(wrapper.text()).not.toContain('对话配置已齐备');
    await wrapper.setProps({ generationMode: 'agent', issues: [], blocked: false });
    expect(wrapper.text()).not.toContain('尚未选择生成模式');
    expect(wrapper.text()).toContain('对话配置已齐备');
    expect(wrapper.find('.blocked-reason').text()).toBe('');
  });

  it('无 section 的清单行不渲染按钮', () => {
    const wrapper = mountReadiness({ issues: [modeIssue], blocked: true });
    const row = wrapper.find('.check-row');
    expect(row.text()).toContain('尚未选择生成模式');
    expect(row.find('button').exists()).toBe(false);
  });

  it('清单已有 API 行时，屏上只有该行一个 API 设置入口', async () => {
    const wrapper = mountReadiness({ issues: [modeIssue, apiIssue], blocked: true });
    expect(buttons(wrapper, '打开 API 设置')).toHaveLength(0);
    const apiButtons = buttons(wrapper, '配置 API');
    expect(apiButtons).toHaveLength(1);
    await apiButtons[0].trigger('click');
    expect(wrapper.emitted('open-settings')).toEqual([['api']]);
  });

  it('清单没有 API 行时，操作行给出唯一的「打开 API 设置」', async () => {
    const wrapper = mountReadiness({
      generationMode: 'agent',
      checkError: '配置未能加载，请重新检查；若仍失败，请打开 API 设置。',
      blocked: true,
    });
    expect(buttons(wrapper, '配置 API')).toHaveLength(0);
    const shortcut = buttons(wrapper, '打开 API 设置');
    expect(shortcut).toHaveLength(1);
    await shortcut[0].trigger('click');
    expect(wrapper.emitted('open-settings')).toEqual([['api']]);
    // 加载失败本身就是一项待处理
    expect(wrapper.find('.blocked-reason').text()).toBe('还有 1 项需要处理');
  });

  it('计费说明收在默认收起的 details 里', () => {
    const wrapper = mountReadiness();
    const details = wrapper.find('details.mode-details');
    expect(details.exists()).toBe(true);
    expect((details.element as HTMLDetailsElement).open).toBe(false);
    expect(details.text()).toContain('按请求次数计费');
    expect(details.text()).toContain('整楼可能不止一次请求');
    // details 之外不出现计费字样
    const outside = wrapper.text().replace(details.text(), '');
    expect(outside).not.toContain('计费');
  });

  it('目录未就绪作为需要处理的一行出现；演示内容时主按钮换文案', () => {
    const wrapper = mountReadiness({
      generationMode: 'agent',
      catalogStatus: 'empty',
      contentSource: 'placeholder',
      blocked: true,
    });
    expect(wrapper.find('.check-list').text()).toContain('没有可用的角色内容目录');
    expect(buttons(wrapper, '使用演示内容创建角色')).toHaveLength(1);
  });

  it('检查中不渲染清单，也不报待处理项数', () => {
    const wrapper = mountReadiness({ checking: true, blocked: true, issues: [modeIssue] });
    expect(wrapper.find('[role="status"]').text()).toContain('正在检查本机配置');
    expect(wrapper.find('.check-list').exists()).toBe(false);
    expect(wrapper.find('.blocked-reason').text()).toBe('');
  });

  it('点开始与重新检查分别发出事件', async () => {
    const wrapper = mountReadiness({ generationMode: 'agent' });
    await buttons(wrapper, '开始创建角色')[0].trigger('click');
    await buttons(wrapper, '重新检查')[0].trigger('click');
    expect(wrapper.emitted('accept')).toHaveLength(1);
    expect(wrapper.emitted('recheck')).toHaveLength(1);
  });
});
