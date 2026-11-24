/**
 * ActionPanelStyleMenu — 行动面板右上角的样式切换
 *
 * 守的是：齿轮的 ARIA（haspopup / expanded / label）；打开后是 role=menu + 五个 menuitemradio（名字取样式目录），
 * 当前样式打勾并拿到焦点；键盘（↓ 打开、↑↓ 移动、Esc 关闭并把焦点还给齿轮）；点外面关闭；
 * 选中发 `select` 并关闭；每一条关闭路径都释放对话框栈（`hasOpenDialog()` 回到 false、body overflow 复原）；
 * 点外面关闭时释放推迟到那次 click 之后（关菜单的那一下不推进逐节演出），等不到 pointerup 有兜底。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ActionPanelStyleMenu from '../../../../../src/ui/components/game/action-panel/ActionPanelStyleMenu.vue';
import { ACTION_PANEL_STYLES } from '../../../../../src/ui/lib/action-panel-styles';
import { hasOpenDialog } from '../../../../../src/ui/lib/modal-focus';

let wrapper: VueWrapper | null = null;

function mountMenu(current: (typeof ACTION_PANEL_STYLES)[number]['id'] = 'duel') {
  wrapper = mount(ActionPanelStyleMenu, { props: { current }, attachTo: document.body });
  return wrapper;
}

async function flush(): Promise<void> {
  await nextTick();
  await nextTick();
}

/** 一次完整的点外面：pointerdown → pointerup → click（同一任务内），再等释放的那个定时器 */
async function clickOutside(target: Element): Promise<void> {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await flush();
  target.dispatchEvent(new Event('pointerup', { bubbles: true }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
}

function escape(target: Element): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('ActionPanelStyleMenu', () => {
  it('齿轮的 ARIA；收着时没有菜单', () => {
    const w = mountMenu();
    const gear = w.get('button[aria-haspopup="menu"]');
    expect(gear.attributes('aria-label')).toBe('切换面板样式');
    expect(gear.attributes('aria-expanded')).toBe('false');
    expect(w.find('[role="menu"]').exists()).toBe(false);
  });

  it('点开：五个 menuitemradio，名字取样式目录，当前样式打勾并拿到焦点', async () => {
    const w = mountMenu('battlelog');
    await w.get('button[aria-haspopup="menu"]').trigger('click');
    await flush();
    expect(w.get('button[aria-haspopup="menu"]').attributes('aria-expanded')).toBe('true');
    const items = w.findAll('[role="menuitemradio"]');
    expect(items.map((i) => i.text())).toEqual(ACTION_PANEL_STYLES.map((s) => s.label));
    const checked = items.filter((i) => i.attributes('aria-checked') === 'true');
    expect(checked.map((i) => i.attributes('data-style-id'))).toEqual(['battlelog']);
    expect(document.activeElement).toBe(checked[0].element);
    expect(hasOpenDialog()).toBe(true);
  });

  it('键盘：↓ 打开、↓ 移到下一项、选中发 select 并关闭、焦点回齿轮', async () => {
    const w = mountMenu('duel');
    const gear = w.get('button[aria-haspopup="menu"]');
    (gear.element as HTMLElement).focus();
    await gear.trigger('keydown', { key: 'ArrowDown' });
    await flush();
    const menu = w.get('[role="menu"]');
    await menu.trigger('keydown', { key: 'ArrowDown' });
    const focused = document.activeElement as HTMLElement;
    expect(focused.dataset.styleId).toBe('afterimage');
    focused.click();
    await flush();
    expect(w.emitted('select')).toEqual([['afterimage']]);
    expect(w.find('[role="menu"]').exists()).toBe(false);
    expect(hasOpenDialog()).toBe(false);
    expect(document.activeElement).toBe(gear.element);
  });

  it('Esc 关闭并把焦点还给齿轮，释放对话框栈与 body overflow', async () => {
    document.body.style.overflow = 'auto';
    const w = mountMenu();
    const gear = w.get('button[aria-haspopup="menu"]');
    (gear.element as HTMLElement).focus();
    await gear.trigger('click');
    await flush();
    expect(document.body.style.overflow).toBe('hidden');
    escape(document.activeElement!);
    await flush();
    expect(w.find('[role="menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(gear.element);
    expect(hasOpenDialog()).toBe(false);
    expect(document.body.style.overflow).toBe('auto');
    expect(w.emitted('select')).toBeUndefined();
  });

  it('点外面关闭；选中当前样式不发 select', async () => {
    const w = mountMenu('duel');
    await w.get('button[aria-haspopup="menu"]').trigger('click');
    await flush();
    await clickOutside(document.body);
    expect(w.find('[role="menu"]').exists()).toBe(false);
    expect(hasOpenDialog()).toBe(false);

    await w.get('button[aria-haspopup="menu"]').trigger('click');
    await flush();
    await w.get('[data-style-id="duel"]').trigger('click');
    await flush();
    expect(w.emitted('select')).toBeUndefined();
    expect(w.find('[role="menu"]').exists()).toBe(false);
  });

  it('点正文关菜单的那一下不推进逐节演出：click 派发时对话框栈仍在，之后才释放', async () => {
    document.body.style.overflow = 'auto';
    const prose = document.createElement('p');
    prose.textContent = '雨声掩盖了脚步。';
    document.body.appendChild(prose);
    // 照 ChatFlow 的 onStageClick：有对话框开着就让路，否则推进
    const advances: boolean[] = [];
    const onStageClick = () => advances.push(!hasOpenDialog());
    const w = mountMenu('duel');
    await w.get('button[aria-haspopup="menu"]').trigger('click');
    await flush();
    document.body.addEventListener('click', onStageClick);
    try {
      await clickOutside(prose);
      expect(advances).toEqual([false]);
      expect(w.find('[role="menu"]').exists()).toBe(false);
      expect(hasOpenDialog()).toBe(false);
      expect(document.body.style.overflow).toBe('auto');
      // 释放后的下一次点击照常推进
      prose.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(advances).toEqual([false, true]);
    } finally {
      document.body.removeEventListener('click', onStageClick);
    }
  });

  it('点外面后等不到 pointerup 也会兜底释放', async () => {
    vi.useFakeTimers();
    try {
      const w = mountMenu();
      await w.get('button[aria-haspopup="menu"]').trigger('click');
      await flush();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await flush();
      expect(w.find('[role="menu"]').exists()).toBe(false);
      expect(hasOpenDialog()).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(hasOpenDialog()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('点外面后、释放之前卸载，也立刻释放', async () => {
    const w = mountMenu();
    await w.get('button[aria-haspopup="menu"]').trigger('click');
    await flush();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(hasOpenDialog()).toBe(true);
    w.unmount();
    wrapper = null;
    expect(hasOpenDialog()).toBe(false);
  });

  it('开着时卸载也释放对话框栈', async () => {
    const w = mountMenu();
    await w.get('button[aria-haspopup="menu"]').trigger('click');
    await flush();
    expect(hasOpenDialog()).toBe(true);
    w.unmount();
    wrapper = null;
    expect(hasOpenDialog()).toBe(false);
  });
});
