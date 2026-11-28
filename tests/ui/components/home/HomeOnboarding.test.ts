/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import homeOnboardingSource from '../../../../src/ui/components/home/HomeOnboarding.vue?raw';
import homePageSource from '../../../../src/ui/components/home/HomePage.vue?raw';
import { mount, type VueWrapper } from '@vue/test-utils';
import HomeOnboarding from '../../../../src/ui/components/home/HomeOnboarding.vue';
import {
  deriveOnboardingSteps,
  type OnboardingInput,
  type OnboardingPanelState,
} from '../../../../src/ui/lib/onboarding';

const llm = {
  id: 'chat',
  name: 'Local',
  baseUrl: 'http://localhost:1234/v1',
  model: 'local-model',
  apiType: 'chat',
};

const fresh: OnboardingInput = {
  contentLoaded: true,
  contentStatus: 'placeholder',
  activePackId: null,
  apiLoaded: true,
  apiPool: [],
  savesLoaded: true,
  saveCount: 0,
};

let wrapper: VueWrapper | null = null;

function mountPanel(input: Partial<OnboardingInput>, state: OnboardingPanelState) {
  wrapper = mount(HomeOnboarding, {
    props: { model: deriveOnboardingSteps({ ...fresh, ...input }), state },
    attachTo: document.body,
  });
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('HomeOnboarding 展开态', () => {
  it('按顺序渲染三步，状态、角标与说明来自模型', () => {
    const panel = mountPanel(
      { contentStatus: 'needs_attention', apiPool: [llm], saveCount: 0 },
      'expanded',
    );
    const steps = panel.findAll('.ob-step');

    expect(steps.map((s) => [s.attributes('data-step'), s.attributes('data-status')])).toEqual([
      ['content', 'attention'],
      ['api', 'done'],
      ['save', 'todo'],
    ]);
    expect(steps.map((s) => s.get('.ob-badge').text())).toEqual(['建议', '必须', '必须']);
    expect(steps[0].text()).toContain('内容包状态需要处理');
    expect(steps[0].text()).toContain('需要处理');
    expect(steps[1].text()).toContain('已完成');
    expect(panel.get('.ob-progress').text()).toBe('1/3');
  });

  it('已完成的步骤只留标题行；未完成的说明收在可展开的一行摘要里', () => {
    const panel = mountPanel({ apiPool: [llm] }, 'expanded');
    const done = panel.get('[data-step="api"]');
    const todo = panel.get('[data-step="save"]');

    expect(done.find('.ob-hint').exists()).toBe(false);
    expect(done.find('.ob-sub').exists()).toBe(false);
    expect(done.find('.ob-go').exists()).toBe(false);
    expect(todo.get('details.ob-detail > summary.ob-hint').text()).toContain('点「新建存档」');
    expect(todo.get('details.ob-detail').attributes('open')).toBeUndefined();
  });

  it('API 步下附带 Embedding「可选」副项', () => {
    const panel = mountPanel({}, 'expanded');
    const sub = panel.get('[data-step="api"] .ob-sub');

    expect(sub.text()).toContain('Embedding 向量召回');
    expect(sub.text()).toContain('可选');
  });

  it('未完成的步骤各有一个直达按钮，点击 emit go(步骤)；已完成的步骤不再给按钮', async () => {
    const panel = mountPanel({ contentStatus: 'error' }, 'expanded');
    const buttons = panel.findAll('.ob-go');

    expect(buttons.map((b) => [b.attributes('data-go'), b.text()])).toEqual([
      ['content', '前往 设置 → 内容包'],
      ['api', '前往 设置 → API 配置'],
      ['save', '新建存档'],
    ]);
    for (const b of buttons) await b.trigger('click');
    expect(panel.emitted('go')).toEqual([['content'], ['api'], ['save']]);

    wrapper?.unmount();
    const partly = mountPanel({ apiPool: [llm] }, 'expanded');
    expect(partly.findAll('.ob-go').map((b) => b.attributes('data-go'))).toEqual([
      'content',
      'save',
    ]);
  });

  it('关闭按钮与 Esc emit close，「不再显示」emit dismiss', async () => {
    const panel = mountPanel({}, 'expanded');

    await panel.get('.ob-close').trigger('click');
    await panel.get('.home-onboarding').trigger('keydown', { key: 'Escape' });
    await panel.get('.ob-dismiss').trigger('click');

    expect(panel.emitted('close')).toHaveLength(2);
    expect(panel.emitted('dismiss')).toHaveLength(1);
    expect(panel.emitted('open')).toBeUndefined();
  });

  it('有 region 语义与标题关联，关闭按钮有读屏名', () => {
    const panel = mountPanel({}, 'expanded');
    const region = panel.get('[role="region"]');
    const heading = panel.get('.ob-title');

    expect(region.attributes('aria-labelledby')).toBe(heading.attributes('id'));
    expect(heading.text()).toBe('开始前的三步');
    expect(panel.get('.ob-close').attributes('aria-label')).toBe('收起引导');
    expect(panel.get('.ob-close').attributes('aria-expanded')).toBe('true');
  });
});

describe('HomeOnboarding 收起态与隐藏态', () => {
  it('收起态只有一行小入口「开始前的三步 · n/3」，点击 emit open', async () => {
    const panel = mountPanel({ apiPool: [llm], saveCount: 1 }, 'collapsed');
    const entry = panel.get('.home-onboarding-entry');

    expect(panel.find('.home-onboarding').exists()).toBe(false);
    expect(entry.text()).toBe('开始前的三步 · 2/3');
    expect(entry.attributes('aria-expanded')).toBe('false');
    await entry.trigger('click');
    expect(panel.emitted('open')).toEqual([[]]);
  });

  it('隐藏态什么都不渲染', () => {
    const panel = mountPanel({ contentLoaded: false }, 'hidden');

    expect(panel.find('.home-onboarding').exists()).toBe(false);
    expect(panel.find('.home-onboarding-entry').exists()).toBe(false);
  });

  it('手动重新打开后焦点移到关闭按钮，手动收起后焦点回到入口', async () => {
    const panel = mountPanel({}, 'collapsed');

    await panel.get('.home-onboarding-entry').trigger('click');
    await panel.setProps({ state: 'expanded' });
    await panel.vm.$nextTick();
    expect(document.activeElement).toBe(panel.get('.ob-close').element);

    await panel.get('.ob-close').trigger('click');
    await panel.setProps({ state: 'collapsed' });
    await panel.vm.$nextTick();
    expect(document.activeElement).toBe(panel.get('.home-onboarding-entry').element);
  });

  it('不是由本组件发起的状态变化（自动收起）不抢焦点', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const panel = mountPanel({}, 'expanded');

    await panel.setProps({ state: 'collapsed' });
    await panel.vm.$nextTick();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('HomeOnboarding 宽屏高度封顶', () => {
  function rect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      height: bottom - top,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  function stubLayout(narrow: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: narrow, media: query }) as unknown as MediaQueryList),
    );
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('innerHeight', 720);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function mountWithGuard(guard: Element | null) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    wrapper = mount(HomeOnboarding, {
      props: { model: deriveOnboardingSteps(fresh), state: 'expanded', topGuard: () => guard },
      attachTo: host,
    });
    const panel = wrapper.get<HTMLElement>('.home-onboarding').element;
    // 定位祖先（jsdom 没有 offsetParent，退到父元素）的底 = 按钮列底部
    panel.parentElement!.getBoundingClientRect = () => rect(300, 600);
    window.dispatchEvent(new Event('resize'));
    await wrapper.vm.$nextTick();
    return { host, panel };
  }

  it('宽屏：顶边不越过横幅下沿 + 安全边距（按钮列底 600 − 横幅底 80 − 16）', async () => {
    stubLayout(false);
    const banner = document.createElement('div');
    banner.getBoundingClientRect = () => rect(12, 80);
    const { host, panel } = await mountWithGuard(banner);
    expect(panel.style.maxHeight).toBe('504px');
    host.remove();
  });

  it('宽屏：没有横幅时按视口顶避让，且不超过视口高减两倍边距', async () => {
    stubLayout(false);
    const { host, panel } = await mountWithGuard(null);
    // min(600 − 16, 720 − 32) = 584
    expect(panel.style.maxHeight).toBe('584px');
    host.remove();
  });

  it('窄屏（并入文档流）不写内联 max-height', async () => {
    stubLayout(true);
    const { host, panel } = await mountWithGuard(null);
    expect(panel.style.maxHeight).toBe('');
    host.remove();
  });

  it('标题行 sticky，卡内滚动时关闭与不再显示常驻', () => {
    expect(homeOnboardingSource).toMatch(/\.ob-header \{[^}]*position: sticky;/);
  });
});

describe('首页布局源码闸门', () => {
  it('.home-stage-ui 不被定高的 .home-page 压缩（否则居中会把溢出分到顶部、滚不到）', () => {
    expect(homePageSource).toMatch(/\.home-stage-ui \{[^}]*flex-shrink: 0;/);
  });
});
