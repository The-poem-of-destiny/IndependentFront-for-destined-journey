/**
 * TopBar — 游戏页顶栏（2026-09-13 重塑）
 *
 * 顶栏从「三颗常驻按钮 + 存档名 + 轮数」收敛成「存档名 + 轮数 + 一颗统一入口」。
 * 这里钉的就是这次收缩本身:
 * - 只剩一颗按钮，点它 emit `openMenu`（菜单内容在 GameMenu，不在这）
 * - **退出 / 设置 / 全屏 三样不再出现在顶栏 DOM 上** —— 这条是回归闸门：它们曾经
 *   常驻在这里，重加回去不会有任何测试变红，只会让顶栏又长出三颗按钮
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import TopBar from './TopBar.vue';
// 源码断言：DOM 上没出现 ≠ 组件里没接线，`?raw` 直接看有没有重新引回 ui-store
import topBarSource from './TopBar.vue?raw';

let mockGame: any;
vi.mock('../../stores/game-store', () => ({ useGameStore: () => mockGame }));

beforeEach(() => {
  mockGame = reactive({
    activeSave: { name: '灰烬之誓' },
    messages: [
      { role: 'user', turn: 1 },
      { role: 'assistant', turn: 3 },
    ],
  });
});

function bar() {
  return mount(TopBar);
}

describe('TopBar — 统一入口', () => {
  it('只有一颗按钮，点击 emit openMenu', async () => {
    const wrapper = bar();
    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(1);
    await buttons[0].trigger('click');
    expect(wrapper.emitted('openMenu')).toHaveLength(1);
  });

  it('显示存档名与当前轮数', () => {
    const wrapper = bar();
    expect(wrapper.find('.top-save-name').text()).toBe('灰烬之誓');
    expect(wrapper.find('.top-title-text').text()).toContain('3');
  });

  it('退出 / 设置 / 全屏 不再常驻顶栏', () => {
    const wrapper = bar();
    const text = wrapper.text();
    expect(text).not.toContain('首页');
    expect(text).not.toContain('设置');
    expect(text).not.toContain('退出');
    expect(text).not.toContain('全屏');
  });

  it('没有把 ui-store 引回来', () => {
    expect(topBarSource).not.toContain('ui-store');
    expect(topBarSource).not.toContain('navigate');
  });
});
