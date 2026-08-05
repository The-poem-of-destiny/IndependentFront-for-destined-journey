/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { BeautifierRule } from '@engine/types';
import BeautifiedNarrative from './BeautifiedNarrative.vue';

const state = vi.hoisted(() => ({
  enabled: true,
  rules: [] as BeautifierRule[],
}));

vi.mock('../../composables/useBeautify', () => ({
  useBeautify: () => ({
    getBeautifierRules: () => state.rules,
    isBeautifierEnabled: () => state.enabled,
  }),
}));

function rule(over: Partial<BeautifierRule> = {}): BeautifierRule {
  return {
    id: 'rich',
    name: 'Rich',
    scope: 'maintext',
    pattern: '<card>([\\s\\S]*?)<\\/card>',
    flags: 'g',
    replacement: '<style>.card{color:red}</style><div class="card">$1</div><script>go()</script>',
    enabled: true,
    order: 1,
    isBuiltin: false,
    ...over,
  };
}

function mountNarrative(text: string, extra: Record<string, unknown> = {}) {
  return mount(BeautifiedNarrative, {
    props: { text, ...extra },
    global: {
      /**
       * 🔴 **stub 的 props 必须与真实组件逐一对齐**（漏一个不会报错）。
       *
       * 漏掉的那个 prop 会静默落进 stub 根节点的 attrs，于是「父组件根本没传」与
       * 「传了但 stub 不接」在测试里长得一模一样 —— D46 打码的 `blurByDefault`
       * 就是这么一路绿着躺了一整轮：组件声明了、设置页能调、全仓没人传。
       * 加 prop 时这里也要跟着加（整条链另有 scene-image-chain.test.ts 兜底）。
       */
      stubs: {
        BeautifierFrame: {
          name: 'BeautifierFrame',
          props: ['markup', 'ruleName', 'forwardContextMenu', 'scripts'],
          template:
            '<div class="frame-stub" :data-rule="ruleName" :data-scripts="scripts">{{ markup }}</div>',
        },
        // 插画格自己连 store（Pinia）；这里只关心「标记有没有被切走」，
        // 状态真值表由 scene-image-view.test.ts 逐格钉住。
        SceneImageSegment: {
          name: 'SceneImageSegment',
          props: [
            'messageId',
            'occurrence',
            'anchorKind',
            'mode',
            'turn',
            'marker',
            'narrative',
            'maxRating',
            'blurByDefault',
          ],
          template: '<div class="scene-image-stub" :data-occurrence="occurrence"></div>',
        },
      },
    },
  });
}

describe('BeautifiedNarrative', () => {
  beforeEach(() => {
    state.enabled = true;
    state.rules = [];
    // 带 messageId 的用法会去问 scene-image-store「这条消息有没有 message-end 的图」；
    // 空库即可（`byMessage` 只过滤内存投影，不碰 Dexie）。
    setActivePinia(createPinia());
  });

  it('renders unmatched model HTML as text without a parent-DOM sanitizer', () => {
    const wrapper = mountNarrative('<img src=x onerror=alert(1)>');

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('denies scripts to model-authored cards while rule matches keep the full surface', () => {
    state.rules = [rule()];
    const wrapper = mountNarrative(
      '<card>rule owned</card>\n\n<item_info><script>leak()</script></item_info>',
    );
    const frames = wrapper.findAllComponents({ name: 'BeautifierFrame' });

    expect(frames).toHaveLength(2);
    // 用户装过的规则 = 全开（工坊兼容面不动）；模型合成的卡片 = 关脚本面。
    expect(frames[0].props('scripts')).toBe('allow');
    expect(frames[1].props('scripts')).toBe('block');
    // 卡片 markup 不做消毒，拦截交给帧内 CSP。
    expect(frames[1].props('markup')).toContain('<script>leak()</script>');
  });

  it('keeps unmatched narrative native while isolating each rich match', () => {
    state.rules = [
      rule({
        replacement:
          '<style>*{background:#111;color:#eee}</style><div class="card">$1</div><script>go()</script>',
      }),
    ];
    const wrapper = mountNarrative('<card>A</card> between <card>B</card>');
    const frames = wrapper.findAllComponents({ name: 'BeautifierFrame' });

    expect(frames).toHaveLength(2);
    expect(frames[0].props('markup')).toContain('<div class="card">A</div>');
    expect(frames[1].props('markup')).toContain('<div class="card">B</div>');
    expect(frames[0].props('markup')).toContain('<style>*{background:#111;color:#eee}</style>');
    expect(frames[0].props('markup')).toContain('<script>go()</script>');
    expect(frames.every((frame) => !String(frame.props('markup')).includes('between'))).toBe(true);
    expect(
      frames.every(
        (frame) => !String(frame.props('markup')).includes('data-beautifier-source-text'),
      ),
    ).toBe(true);
    expect(wrapper.get('p').text()).toContain('between');
  });

  it('renders unmatched model markup natively beside an isolated rich replacement', () => {
    state.rules = [rule()];
    const wrapper = mountNarrative(
      '<img src=x onerror="parent.postMessage(1,\'*\')"><card>safe</card>',
    );
    const markup = wrapper.findComponent({ name: 'BeautifierFrame' }).props('markup') as string;

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src=x onerror="parent.postMessage(1,\'*\')">');
    expect(markup).not.toContain('img src=x');
    expect(markup).toContain('<div class="card">safe</div>');
  });

  it('passes a sole full-document replacement through without fragment wrappers', () => {
    state.rules = [
      rule({
        replacement:
          '```html\n<!doctype html><html><head><style>.app{color:red}</style></head>' +
          '<body><main class="app">$1</main></body></html>\n```',
      }),
    ];
    const wrapper = mountNarrative('<card>document</card>');
    const markup = wrapper.findComponent({ name: 'BeautifierFrame' }).props('markup') as string;

    expect(markup).toMatch(/^```html/);
    expect(markup).toContain('<head><style>.app{color:red}</style></head>');
    expect(markup).not.toContain('data-beautifier-source-text');
  });

  it('keeps incomplete streaming output native and does not start legacy scripts', () => {
    state.rules = [rule()];
    const wrapper = mountNarrative('<card>partial', { streaming: true });

    expect(wrapper.find('.frame-stub').exists()).toBe(false);
    expect(wrapper.text()).toContain('<card>partial');
  });

  it('honors message depth and defaults standalone previews to the newest message', () => {
    state.rules = [rule({ minDepth: 1, maxDepth: 2 })];

    expect(mountNarrative('<card>newest</card>').find('.frame-stub').exists()).toBe(false);
    expect(mountNarrative('<card>history</card>', { depth: 2 }).find('.frame-stub').exists()).toBe(
      true,
    );
    expect(mountNarrative('<card>old</card>', { depth: 3 }).find('.frame-stub').exists()).toBe(
      false,
    );
  });

  // ── D3 / §10.1：分段在美化之前，且 always-on ──

  it('strips scene_image markers even with beautification off', () => {
    state.enabled = false;
    const wrapper = mountNarrative(
      '雨停了。\n<scene_image title="雨后的街">石板路上还积着水</scene_image>\n她推开门。',
    );

    // 🔴 美化关掉 ≠ 标记漏成一行尖括号给玩家看见
    expect(wrapper.text()).not.toContain('<scene_image');
    expect(wrapper.text()).not.toContain('</scene_image>');
    expect(wrapper.text()).toContain('雨停了。');
    expect(wrapper.text()).toContain('她推开门。');
  });

  it('strips scene_image markers mid-stream as well', () => {
    const wrapper = mountNarrative('风起了。<scene_image title="风">旗帜猎猎</scene_image>', {
      streaming: true,
    });

    expect(wrapper.text()).not.toContain('<scene_image');
    expect(wrapper.text()).toContain('风起了。');
  });

  it('renders no image slot without a messageId anchor', () => {
    // 规则预览 / 流式草稿没有锚点：标记照剥，但一格都不挂（也就不碰 Pinia）
    const wrapper = mountNarrative('<scene_image title="街市">人来人往</scene_image>正文');

    expect(wrapper.find('.scene-image-stub').exists()).toBe(false);
    expect(wrapper.text()).toContain('正文');
  });

  it('anchors each marker to its own occurrence number', () => {
    const wrapper = mountNarrative(
      '<scene_image title="一">甲</scene_image>中间<scene_image title="二">乙</scene_image>',
      { messageId: 'msg_1', imageMode: 'manual' },
    );
    const slots = wrapper.findAll('.scene-image-stub');

    expect(slots).toHaveLength(2);
    expect(slots[0]?.attributes('data-occurrence')).toBe('0');
    expect(slots[1]?.attributes('data-occurrence')).toBe('1');
    expect(wrapper.text()).toContain('中间');
  });

  it('does not let a beautifier rule swallow an illustration', () => {
    state.rules = [rule()];
    const wrapper = mountNarrative('<card>A<scene_image title="插图">画面</scene_image>B</card>', {
      messageId: 'msg_1',
      imageMode: 'manual',
    });

    // 规则不该跨过一张插画去匹配：标记两侧成了两段正文，`<card>` 于是配不上对
    expect(wrapper.find('.frame-stub').exists()).toBe(false);
    expect(wrapper.find('.scene-image-stub').exists()).toBe(true);
  });

  it('keeps the app-owned dialogue card native for host theme styling', () => {
    state.rules = [
      rule({
        id: 'builtin-dialogue-card',
        pattern: '\\[([^\\]]+)\\](?:\\{([^}]*)\\})?\\("([^"]*)"\\)',
        replacement: '<div class="dialogue-card"><b>$1</b><span>$3</span></div>',
      }),
    ];
    const wrapper = mountNarrative('[店主]("欢迎")');

    expect(wrapper.find('.frame-stub').exists()).toBe(false);
    expect(wrapper.find('.dialogue-card').text()).toContain('店主');
    expect(wrapper.find('.dialogue-card').text()).toContain('欢迎');
  });
});
