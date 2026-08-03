/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
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
      stubs: {
        BeautifierFrame: {
          name: 'BeautifierFrame',
          props: ['markup', 'ruleName'],
          template: '<div class="frame-stub" :data-rule="ruleName">{{ markup }}</div>',
        },
      },
    },
  });
}

describe('BeautifiedNarrative', () => {
  beforeEach(() => {
    state.enabled = true;
    state.rules = [];
  });

  it('renders unmatched model HTML as text without a parent-DOM sanitizer', () => {
    const wrapper = mountNarrative('<img src=x onerror=alert(1)>');

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
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
