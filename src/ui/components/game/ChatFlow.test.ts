/**
 * ChatFlow 右键菜单测试 — user 消息「回退到这条输入 / 复制」
 *
 * 背景：右键菜单此前只在 assistant 消息（正文）上出现；正文没生成/报错时
 * 用户想撤回这一轮却点不到右键。本测试覆盖 user 消息的放行：
 *
 * - 最新一条 user 消息右键 → 菜单打开（回退到这条输入 + 复制，无配图项）
 * - 非最新 user 消息右键 → 不拦浏览器默认右键（菜单不开）
 * - 回退按钮 → 调 store.rollbackOneTurn()
 * - 复制按钮 → 调 navigator.clipboard.writeText(该条消息内容)
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatMessage } from '@engine/types';
import ChatFlow from './ChatFlow.vue';
import { useSettingsStore } from '../../stores/settings-store';

enableAutoUnmount(afterEach);

const game = vi.hoisted(() => ({
  isInCombat: false,
  pendingOptions: [] as string[],
  pendingInput: null as string | null,
  clearPendingInput: vi.fn(),
  rollbackOneTurn: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../stores/game-store', () => ({ useGameStore: () => game }));
vi.mock('../../stores/ui-store', () => ({ useUIStore: () => ({ toast: vi.fn() }) }));
vi.mock('../../stores/scene-image-store', () => ({
  useSceneImageStore: () => ({
    activeSaveId: 'save_1',
    generate: vi.fn(async () => ({ ok: true as const, id: 'simg_new' })),
  }),
}));
vi.mock('../../stores/image-preset-store', () => ({
  useImagePresetStore: () => ({ loading: false, init: vi.fn(), find: vi.fn(() => undefined) }),
}));

function userMsg(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 0 };
}

describe('ChatFlow 右键菜单 — user 消息', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    // 配图档关掉 → user 消息菜单只剩回退/复制两项（配图是给正文的）
    useSettingsStore().settings.imageGenMode = 'off';
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  });

  it('最新一条 user 消息右键打开菜单：回退到这条输入 + 复制，无配图项', async () => {
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '第一条'), userMsg('u2', '第二条')] },
    });

    const rows = wrapper.findAll('.bubble-row-player');
    expect(rows).toHaveLength(2);

    await rows[1].trigger('contextmenu');
    const menu = wrapper.find('.ctx-menu');
    expect(menu.exists()).toBe(true);

    const texts = menu.findAll('button').map((b) => b.text());
    expect(texts).toContain('回退到这条输入');
    expect(texts).toContain('复制');
    expect(texts.some((t) => t.includes('配图'))).toBe(false);
    expect(texts).toHaveLength(2);

    // 悬停提示照实际能做的事写
    expect(rows[1].attributes('title')).toContain('回退到这条输入');
  });

  it('非最新 user 消息右键不拦默认菜单', async () => {
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '第一条'), userMsg('u2', '第二条')] },
    });

    const rows = wrapper.findAll('.bubble-row-player');
    await rows[0].trigger('contextmenu');
    expect(wrapper.find('.ctx-menu').exists()).toBe(false);
  });

  it('user 消息上的「回退到这条输入」调 rollbackOneTurn', async () => {
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '第一条'), userMsg('u2', '第二条')] },
    });

    const rows = wrapper.findAll('.bubble-row-player');
    await rows[1].trigger('contextmenu');
    const rollbackBtn = wrapper
      .findAll('.ctx-menu .ctx-item')
      .find((b) => b.text().includes('回退'));
    expect(rollbackBtn).toBeTruthy();

    await rollbackBtn!.trigger('click');
    await flushPromises();
    expect(game.rollbackOneTurn).toHaveBeenCalledTimes(1);
    // 点完菜单关闭
    expect(wrapper.find('.ctx-menu').exists()).toBe(false);
  });

  it('复制 user 消息内容调 clipboard，内容是那一条的正文', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });

    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '第一条'), userMsg('u2', '我要复制的内容')] },
    });

    const rows = wrapper.findAll('.bubble-row-player');
    await rows[1].trigger('contextmenu');
    const copyBtn = wrapper.findAll('.ctx-menu .ctx-item').find((b) => b.text().includes('复制'));
    expect(copyBtn).toBeTruthy();

    await copyBtn!.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('我要复制的内容');
  });
});
