/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { BeautifierRule } from '@engine/types/types';
import BeautifiedNarrative from '../../../../src/ui/components/game/BeautifiedNarrative.vue';
import { useFxEnabled } from '../../../../src/ui/lib/fx-gate';
import { buildNameIndex } from '../../../../src/ui/lib/narrative-names';

const state = vi.hoisted(() => ({
  enabled: true,
  rules: [] as BeautifierRule[],
}));

vi.mock('../../../../src/ui/composables/useBeautify', () => ({
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

  it('原生对话卡片交给 DialogueCard：捕获组依次是名字 / 情绪 / 台词', () => {
    state.rules = [
      rule({
        id: 'builtin-dialogue-card',
        pattern: '\\[([^\\]]+)\\](?:\\{([^}]*)\\})?\\("([^"]*)"\\)',
        replacement: '<div class="dialogue-card"><b>$1</b><span>$3</span></div>',
      }),
    ];
    const wrapper = mountNarrative('[店主]{擦着杯子}("<b>欢迎</b>")');

    expect(wrapper.find('.dialogue-name').text()).toBe('店主');
    expect(wrapper.find('.dialogue-mood').text()).toBe('擦着杯子');
    // 台词是模型原文：文本插值，标签按字面显示
    expect(wrapper.find('.dialogue-body').text()).toBe('<b>欢迎</b>');
    expect(wrapper.find('.dialogue-body b').exists()).toBe(false);
  });
});

describe('BeautifiedNarrative <action_info> 行动面板', () => {
  beforeEach(() => {
    state.enabled = true;
    state.rules = [];
    setActivePinia(createPinia());
  });

  const text =
    '挥剑。\n<action_info>| 掷骰 | 12 |\n| 结果 | <script>bad()</script> |</action_info>\n敌人后退。';

  it('常开：不需要任何 prop 就把面板切出来交给 ActionPanel，原文标签只按字面显示', () => {
    const wrapper = mountNarrative(text);
    const panel = wrapper.find('.action-panel-card');
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('掷骰');
    expect(panel.text()).toContain('12');
    expect(wrapper.find('script').exists()).toBe(false);
    // 面板两侧的正文仍是段落，标签本身不漏成文字
    expect(wrapper.findAll('p').map((p) => p.text())).toEqual(['挥剑。', '敌人后退。']);
    expect(wrapper.text()).not.toContain('action_info');
  });

  it('美化关掉时照样拆面板（不依赖美化开关）', () => {
    state.enabled = false;
    const wrapper = mountNarrative(text);
    expect(wrapper.find('.action-panel-card').exists()).toBe(true);
  });

  it('流式：未闭合面板照样渲染，结尾半截残标签不漏出', () => {
    const streaming = mountNarrative('前文<action_info>{检定}\n| 掷骰: d20=15', {
      streaming: true,
    });
    expect(streaming.find('.action-panel-card').text()).toContain('d20=15');
    const half = mountNarrative('前文。<action_in', { streaming: true });
    expect(half.text()).toBe('前文。');
  });

  it('让位：启用的 maintext 规则 pattern 提到 action_info 时不拆面板，整段交给规则', () => {
    state.rules = [
      rule({
        id: 'panel-rule',
        pattern: '<action_info>([^]*?)</action_info>',
        replacement: '<div class="mine">$1</div>',
      }),
    ];
    const wrapper = mountNarrative(text);
    expect(wrapper.find('.action-panel-card').exists()).toBe(false);
    expect(wrapper.find('.frame-stub').exists()).toBe(true);
  });

  it('不让位：规则未启用 / 美化关掉时仍拆面板', () => {
    state.rules = [rule({ pattern: '<action_info>([^]*?)</action_info>', enabled: false })];
    expect(mountNarrative(text).find('.action-panel-card').exists()).toBe(true);
    state.rules = [rule({ pattern: '<action_info>([^]*?)</action_info>' })];
    state.enabled = false;
    expect(mountNarrative(text).find('.action-panel-card').exists()).toBe(true);
  });

  it('没有面板的正文与改造前一样只出段落', () => {
    const wrapper = mountNarrative('第一段\n\n第二段');
    expect(wrapper.find('.action-panel-card').exists()).toBe(false);
    expect(wrapper.findAll('p')).toHaveLength(2);
  });
});

describe('BeautifiedNarrative 特效层（墨迹浮现 / 名字下划线 / 行末印记）', () => {
  beforeEach(() => {
    state.enabled = true;
    state.rules = [];
    setActivePinia(createPinia());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    setFx(false);
  });

  function setFx(on: boolean) {
    if (on) document.documentElement.setAttribute('data-fx', 'on');
    else document.documentElement.removeAttribute('data-fx');
    useFxEnabled(); // 让共享镜像对齐 DOM
  }

  /** 闸门关时的基准 DOM（即改造前的输出） */
  function baselineHtml(text: string, extra: Record<string, unknown> = {}): string {
    setFx(false);
    const wrapper = mountNarrative(text, extra);
    const html = wrapper.html();
    wrapper.unmount();
    return html;
  }

  const mentions = (names: string[], known = names) => ({ names, index: buildNameIndex(known) });

  it('闸门关：reveal / mentions / 行末印记一概不改变输出', () => {
    const text = '洛恩推门。\n\n艾琳娜回头。';
    const baseline = baselineHtml(text);
    const wrapper = mount(BeautifiedNarrative, {
      props: { text, reveal: 'once', mentions: mentions(['洛恩', '艾琳娜']), seal: 'pressed' },
    });
    expect(wrapper.html()).toBe(baseline);
    expect(wrapper.find('.turn-seal').exists()).toBe(false);
  });

  it('闸门开 + 历史（reveal off）：零额外 span，DOM 与基准相同', () => {
    const text = '第一段。\n\n第二段，较长的一段。';
    const baseline = baselineHtml(text);
    setFx(true);
    const wrapper = mountNarrative(text);
    expect(wrapper.findAll('span')).toHaveLength(0);
    expect(wrapper.html()).toBe(baseline);
  });

  it('流式增长：已显示的字不重播，只有新尾巴成为动画片；落定后 DOM 等于基准', async () => {
    setFx(true);
    const wrapper = mountNarrative('alpha beta ', { streaming: true });
    const firstSpans = wrapper.findAll('.fx-ink-chunk').map((span) => span.element);
    expect(firstSpans.map((el) => el.textContent)).toEqual(['alpha ', 'beta ']);
    expect(firstSpans.every((el) => el.getAttribute('role') === 'presentation')).toBe(true);

    vi.advanceTimersByTime(100);
    await wrapper.setProps({ text: 'alpha beta gamma' });
    const spans = wrapper.findAll('.fx-ink-chunk').map((span) => span.element);
    // 旧 span 是同一批 DOM 节点（动画没有重启），只多出新尾巴
    expect(spans.slice(0, 2)).toEqual(firstSpans);
    expect(spans.map((el) => el.textContent)).toEqual(['alpha ', 'beta ', 'gamma']);
    expect(wrapper.find('p').element.textContent).toBe('alpha beta gamma');

    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(wrapper.findAll('span')).toHaveLength(0);
    const settled = wrapper.html();
    expect(settled).toBe(baselineHtml('alpha beta gamma', { streaming: true }));
  });

  it('流式新起一段时，上一段已显示的字不再动画', async () => {
    setFx(true);
    const wrapper = mountNarrative('第一段', { streaming: true });
    vi.advanceTimersByTime(1000);
    await nextTick();
    await wrapper.setProps({ text: '第一段\n\n第二段' });
    const paragraphs = wrapper.findAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].findAll('.fx-ink-chunk')).toHaveLength(0);
    expect(paragraphs[1].findAll('.fx-ink-chunk').length).toBeGreaterThan(0);
  });

  it('once：段落与卡片整块浮现，不逐词；动画放完后 DOM 等于基准', async () => {
    const text = '店门口。\n\n<dialogue>店主|说|欢迎</dialogue>';
    state.rules = [
      rule({
        id: 'builtin-dialogue-card',
        pattern: '<dialogue>([^|]*)\|([^|]*)\|([^<]*)</dialogue>',
        replacement: '<div>$1</div>',
      }),
    ];
    const baseline = baselineHtml(text);
    setFx(true);
    const wrapper = mountNarrative(text, { reveal: 'once' });
    expect(wrapper.find('p.fx-ink-para').exists()).toBe(true);
    expect(wrapper.findAll('.fx-ink-chunk')).toHaveLength(0);
    expect(wrapper.find('.beautifier-native-match').classes()).toContain('fx-ink-block');

    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(wrapper.html()).toBe(baseline);
  });

  it('名字下划线：每个名字只划第一次出现，不在更长的已知名字内部划，文本不变', () => {
    setFx(true);
    const text = '艾琳娜看向洛恩。\n\n洛恩点头，艾琳也笑了。';
    const wrapper = mountNarrative(text, {
      mentions: mentions(['洛恩', '艾琳'], ['洛恩', '艾琳', '艾琳娜']),
    });
    const marks = wrapper.findAll('.fx-first-name');
    expect(marks.map((m) => m.text())).toEqual(['洛恩', '艾琳']);
    // 第一段里的「洛恩」被划，第二段的「洛恩」不再划；「艾琳娜」里的「艾琳」不划
    expect(wrapper.findAll('p')[0].find('.fx-first-name').text()).toBe('洛恩');
    expect(wrapper.findAll('p').map((p) => p.element.textContent)).toEqual([
      '艾琳娜看向洛恩。',
      '洛恩点头，艾琳也笑了。',
    ]);
  });

  it('行末印记挂进最后一个段落末尾，段落文字不变；pressed 档带按下态', () => {
    setFx(true);
    const wrapper = mount(BeautifiedNarrative, {
      props: { text: '第一段\n\n最后一段', seal: 'pressed' },
    });
    const last = wrapper.findAll('p')[1];
    expect(last.find('.turn-seal').exists()).toBe(true);
    expect(last.find('.turn-seal').classes()).toContain('is-pressed');
    expect(last.element.textContent).toBe('最后一段');
    expect(wrapper.findAll('p')[0].find('.turn-seal').exists()).toBe(false);
  });

  it('印记在首次渲染之后才出现（pending → accepted 原地翻转）：经 prop 响应式挂上', async () => {
    setFx(true);
    const wrapper = mount(BeautifiedNarrative, { props: { text: '第一段\n\n最后一段' } });
    expect(wrapper.find('.turn-seal').exists()).toBe(false);
    await wrapper.setProps({ seal: 'still' });
    const last = wrapper.findAll('p')[1];
    expect(last.find('.turn-seal').exists()).toBe(true);
    expect(last.find('.turn-seal').classes()).not.toContain('is-pressed');
    expect(last.element.textContent).toBe('最后一段');
  });

  it('最后一块不是段落（美化框）时，行末印记另起一行', () => {
    setFx(true);
    state.rules = [rule()];
    const wrapper = mountNarrative('前文\n\n<card>收尾</card>', {});
    expect(wrapper.find('.narrative-end').exists()).toBe(false);
    const withSeal = mount(BeautifiedNarrative, {
      props: { text: '前文\n\n<card>收尾</card>', seal: 'still' },
      global: { stubs: { BeautifierFrame: { template: '<div class="frame-stub" />' } } },
    });
    expect(withSeal.find('.narrative-end .turn-seal').exists()).toBe(true);
    expect(withSeal.find('p .turn-seal').exists()).toBe(false);
  });
});
