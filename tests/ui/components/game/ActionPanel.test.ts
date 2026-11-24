/**
 * ActionPanel — `<action_info>` 行动面板外壳
 *
 * 守的是：根 `.action-panel-card[data-style][data-kind]`（类名是 ChatFlow 让路清单的契约）；
 * 一个 `details.ai-details`，summary 画当前样式（五个 id 都能渲染，四个占位转交对决条），展开体是算式区；
 * 齿轮在 details 外，点它不开合面板，选中样式写回设置；入场类只在 `entrance` 时挂上、到时撤掉、换样式立即撤掉；
 * `defaultOpen` 初始展开但不播展开动画；空面板不渲染；全程文本插值。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ActionPanel from '../../../../src/ui/components/game/ActionPanel.vue';
import { parseActionPanel } from '../../../../src/ui/lib/action-panel';
import { ACTION_PANEL_STYLES } from '../../../../src/ui/lib/action-panel-styles';
import { useSettingsStore } from '../../../../src/ui/stores/settings-store';
import { ASSET_STUB, EXCHANGE, OUTCOME, ROSTER } from './action-panel/fixtures';

let wrapper: VueWrapper | null = null;

function mountPanel(props: Record<string, unknown>, attach = false) {
  wrapper = mount(ActionPanel, {
    props,
    global: { stubs: ASSET_STUB },
    ...(attach ? { attachTo: document.body } : {}),
  });
  return wrapper;
}

function details(w: VueWrapper) {
  return w.get('details.ai-details').element as HTMLDetailsElement;
}

beforeEach(() => {
  // 设置袋会落 localStorage，上一条用例选的样式不能漏进下一条
  localStorage.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('ActionPanel', () => {
  it('根节点带样式与 kind；一个 details，summary 画样式、展开体是算式区', () => {
    const w = mountPanel({ raw: EXCHANGE });
    const root = w.get('.action-panel-card');
    expect(root.attributes('data-style')).toBe('duel');
    expect(root.attributes('data-kind')).toBe('exchange');
    expect(w.findAll('details.ai-details')).toHaveLength(1);
    expect(w.find('summary.ai-summary .duel').exists()).toBe(true);
    expect(w.find('.ai-body .calc-title').text()).toBe('出手 · 裂风斩');
    expect(details(w).open).toBe(false);
  });

  it.each(ACTION_PANEL_STYLES.map((s) => s.id))('样式 %s 能渲染且摘要带出招式名', (id) => {
    useSettingsStore().settings.actionPanelStyle = id;
    const w = mountPanel({ raw: EXCHANGE });
    expect(w.get('.action-panel-card').attributes('data-style')).toBe(id);
    expect(w.get('summary').text()).toContain('裂风斩');
  });

  it('坏的设置值回落对决条', () => {
    (useSettingsStore().settings as Record<string, unknown>).actionPanelStyle = 'nope';
    expect(mountPanel({ raw: EXCHANGE }).get('.action-panel-card').attributes('data-style')).toBe(
      'duel',
    );
  });

  it('kind 跟着视图走：名册 / 结算', () => {
    expect(mountPanel({ raw: ROSTER }).get('.action-panel-card').attributes('data-kind')).toBe(
      'roster',
    );
    wrapper?.unmount();
    expect(mountPanel({ raw: OUTCOME }).get('.action-panel-card').attributes('data-kind')).toBe(
      'outcome',
    );
  });

  it('齿轮在 details 外：点它不开合面板；选中样式写回设置', async () => {
    const w = mountPanel({ raw: EXCHANGE }, true);
    const gear = w.get('button[aria-label="切换面板样式"]');
    expect(gear.element.closest('details')).toBeNull();
    expect(gear.element.closest('.action-panel-card')).toBe(w.get('.action-panel-card').element);
    await gear.trigger('click');
    await nextTick();
    await nextTick();
    expect(details(w).open).toBe(false);
    await w.get('[data-style-id="card"]').trigger('click');
    await nextTick();
    expect(useSettingsStore().settings.actionPanelStyle).toBe('card');
    expect(w.get('.action-panel-card').attributes('data-style')).toBe('card');
    expect(details(w).open).toBe(false);
  });

  it('键盘：打开菜单、选一项、Esc 关闭并把焦点还给齿轮', async () => {
    const w = mountPanel({ raw: EXCHANGE }, true);
    const gear = w.get('button[aria-label="切换面板样式"]');
    (gear.element as HTMLElement).focus();
    await gear.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    await nextTick();
    await w.get('[role="menu"]').trigger('keydown', { key: 'End' });
    (document.activeElement as HTMLElement).click();
    await nextTick();
    expect(useSettingsStore().settings.actionPanelStyle).toBe('card');
    expect(document.activeElement).toBe(gear.element);

    await gear.trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    await nextTick();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await nextTick();
    expect(w.find('[role="menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(gear.element);
  });

  it('没有 entrance 就没有入场类', () => {
    const w = mountPanel({ raw: EXCHANGE });
    expect(w.find('.is-entering').exists()).toBe(false);
  });

  it('entrance：挂上入场类，过了样式的 entranceMs 撤掉', async () => {
    vi.useFakeTimers();
    const w = mountPanel({ raw: EXCHANGE, entrance: true });
    expect(w.get('.action-panel-card').classes()).toContain('is-entering');
    expect(w.get('.duel').classes()).toContain('is-entering');
    const duelMs = ACTION_PANEL_STYLES.find((s) => s.id === 'duel')!.entranceMs;
    vi.advanceTimersByTime(duelMs - 1);
    await nextTick();
    expect(w.find('.is-entering').exists()).toBe(true);
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(w.find('.is-entering').exists()).toBe(false);
  });

  it('entrance：换样式立即撤掉入场类', async () => {
    vi.useFakeTimers();
    const w = mountPanel({ raw: EXCHANGE, entrance: true });
    useSettingsStore().settings.actionPanelStyle = 'battlelog';
    await nextTick();
    await nextTick();
    expect(w.find('.is-entering').exists()).toBe(false);
  });

  it('defaultOpen：初始展开，不带展开动画；点过 summary 之后才带', async () => {
    const w = mountPanel({ raw: ROSTER, defaultOpen: true });
    expect(details(w).open).toBe(true);
    expect(w.get('.action-panel-card').classes()).not.toContain('is-user-toggled');
    expect(w.find('.more').text()).toBe('收起');
    await w.get('summary').trigger('click');
    expect(w.get('.action-panel-card').classes()).toContain('is-user-toggled');
  });

  it('也接受已解析的 panel', () => {
    const w = mountPanel({ panel: parseActionPanel(EXCHANGE) });
    expect(w.get('.action-panel-card').attributes('data-kind')).toBe('exchange');
  });

  it('空面板不渲染', () => {
    const w = mountPanel({ raw: '  ' });
    expect(w.find('.action-panel-card').exists()).toBe(false);
  });

  it('不走 v-html：原文里的标签按字面显示', () => {
    const raw = '{<b>粗体</b>}\n| 结果: <script>alert(1)</script> |\n<img src=x onerror=alert(1)>';
    const w = mountPanel({ raw });
    expect(w.find('script').exists()).toBe(false);
    expect(w.find('img').exists()).toBe(false);
    expect(w.findAll('b').filter((b) => b.classes().length === 0)).toHaveLength(0);
    expect(w.find('.calc-title').text()).toBe('<b>粗体</b>');
    expect(w.text()).toContain('<script>alert(1)</script>');
    expect(w.text()).toContain('<img src=x onerror=alert(1)>');
  });
});
