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
import type { AgentActivityRun, ChatMessage } from '@engine/types';
import ChatFlow from './ChatFlow.vue';
import { useSettingsStore } from '../../stores/settings-store';
import type { TimelineRestoreResult } from '../../stores/game-store';

enableAutoUnmount(afterEach);

const game = vi.hoisted(() => ({
  isInCombat: false,
  pendingOptions: [] as string[],
  pendingInput: null as string | null,
  agentActivityRuns: [] as AgentActivityRun[],
  currentAgentActivityRun: null as AgentActivityRun | null,
  clearPendingInput: vi.fn(),
  rollbackOneTurn: vi.fn<() => Promise<TimelineRestoreResult>>(async () => ({
    status: 'restored',
  })),
}));
const ui = vi.hoisted(() => ({ toast: vi.fn(), navigate: vi.fn() }));

vi.mock('../../stores/game-store', () => ({ useGameStore: () => game }));
vi.mock('../../stores/ui-store', () => ({ useUIStore: () => ui }));
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
    game.agentActivityRuns = [];
    game.rollbackOneTurn.mockResolvedValue({ status: 'restored' });
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

  it('回退的投影重载失败会提示并返回首页', async () => {
    game.rollbackOneTurn.mockResolvedValueOnce({
      status: 'projection-failed',
      error: '时间线已恢复，但界面重载失败，请重新进入存档',
    });
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '第一条'), userMsg('u2', '第二条')] },
    });

    await wrapper.findAll('.bubble-row-player')[1].trigger('contextmenu');
    const rollbackBtn = wrapper
      .findAll('.ctx-menu .ctx-item')
      .find((button) => button.text().includes('回退'))!;
    await rollbackBtn.trigger('click');
    await flushPromises();

    expect(ui.toast).toHaveBeenCalledWith('时间线已恢复，但界面重载失败，请重新进入存档', 'error');
    expect(ui.navigate).toHaveBeenCalledWith('home');
  });

  it('回退在写入前被拒绝只提示原因，不离开游戏页', async () => {
    game.rollbackOneTurn.mockResolvedValueOnce({
      status: 'rejected',
      error: '生成进行中，无法回退',
    });
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '第一条'), userMsg('u2', '第二条')] },
    });

    await wrapper.findAll('.bubble-row-player')[1].trigger('contextmenu');
    const rollbackBtn = wrapper
      .findAll('.ctx-menu .ctx-item')
      .find((button) => button.text().includes('回退'))!;
    await rollbackBtn.trigger('click');
    await flushPromises();

    expect(ui.toast).toHaveBeenCalledWith('生成进行中，无法回退', 'warning');
    expect(ui.navigate).not.toHaveBeenCalled();
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

describe('ChatFlow 回合活动重试', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    game.agentActivityRuns = [];
  });

  it('同一输入多次失败时只允许重试最后一次运行', async () => {
    game.agentActivityRuns = ['attempt-1', 'attempt-2'].map((id, index) => ({
      id,
      sourceMessageId: 'u1',
      status: 'failed' as const,
      startedAt: index,
      completedAt: index + 1,
      message: '世界的回应在此中断，可以再次尝试。',
      standalone: false,
      steps: [],
    }));

    const wrapper = mount(ChatFlow, {
      global: {
        stubs: {
          teleport: true,
          TurnActivityLedger: {
            props: ['run', 'canRetry'],
            emits: ['retry'],
            template:
              '<button v-if="canRetry" class="retry-probe" @click="$emit(\'retry\')">{{ run.id }}</button>',
          },
        },
      },
      props: { messages: [userMsg('u1', '再试一次')], isGenerating: false },
    });

    const retry = wrapper.findAll('.retry-probe');
    expect(retry).toHaveLength(1);
    expect(retry[0].text()).toBe('attempt-2');
    await retry[0].trigger('click');
    expect(wrapper.emitted('retry-turn')).toEqual([['u1']]);
  });
});

// 🆕 思考中指示（2026-08-12）：生成态、正文未出时显示当前 Agent 活动
describe('ChatFlow 思考中指示', () => {
  it('isGenerating 且无 streamingText → 显示思考中（含当前 Agent 活动文案）', async () => {
    game.currentAgentActivityRun = {
      id: 'activity-1',
      sourceMessageId: 'u1',
      status: 'running' as const,
      startedAt: 0,
      standalone: false,
      steps: [
        {
          id: 's1',
          agentId: 'story',
          label: '书写此刻',
          status: 'running' as const,
          startedAt: 0,
          tools: [
            { id: 't1', label: '掷出命运之骰', status: 'completed' as const, completedAt: 0 },
          ],
        },
      ],
    };
    const wrapper = mount(ChatFlow, {
      global: {
        stubs: { teleport: true, TurnActivityLedger: true },
      },
      props: { messages: [userMsg('u1', '继续')], isGenerating: true, streamingText: '' },
    });

    const indicator = wrapper.find('.thinking-indicator');
    expect(indicator.exists()).toBe(true);
    expect(indicator.text()).toContain('书写此刻');
    expect(indicator.text()).toContain('掷出命运之骰');
  });

  it('生成中但已有流式正文 → 不显示思考中（正文已在输出）', async () => {
    game.currentAgentActivityRun = null;
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true, TurnActivityLedger: true } },
      props: {
        messages: [userMsg('u1', '继续')],
        isGenerating: true,
        streamingText: '风从旷野那头灌过来…',
      },
    });
    expect(wrapper.find('.thinking-indicator').exists()).toBe(false);
  });

  it('非生成态 → 不显示思考中', async () => {
    game.currentAgentActivityRun = null;
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true, TurnActivityLedger: true } },
      props: { messages: [userMsg('u1', '继续')], isGenerating: false },
    });
    expect(wrapper.find('.thinking-indicator').exists()).toBe(false);
  });
});
