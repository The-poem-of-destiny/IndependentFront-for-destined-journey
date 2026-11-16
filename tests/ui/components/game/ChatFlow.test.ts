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
import { reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { AgentActivityRun, ChatMessage } from '@engine/types/types';
import ChatFlow from '../../../../src/ui/components/game/ChatFlow.vue';
import BeautifiedNarrative from '../../../../src/ui/components/game/BeautifiedNarrative.vue';
import { useSettingsStore } from '../../../../src/ui/stores/settings-store';
import { useFxEnabled } from '../../../../src/ui/lib/fx-gate';
import type { TimelineRestoreResult } from '../../../../src/ui/stores/game-store';

enableAutoUnmount(afterEach);

const game = vi.hoisted(() => ({
  isInCombat: false,
  isAgentCombat: false,
  isRewriting: false,
  generationMode: 'agent',
  characters: [] as Array<{ type: string; name: string; location: string; inventory: [] }>,
  pendingOptions: [] as string[],
  pendingInput: null as string | null,
  agentActivityRuns: [] as AgentActivityRun[],
  currentAgentActivityRun: null as AgentActivityRun | null,
  clearPendingInput: vi.fn(),
  rewriteProse: vi.fn<
    (messageId: string) => Promise<{ ok: boolean; reason?: string; warning?: string }>
  >(async () => ({ ok: true })),
  restorePreRewrite: vi.fn(async (_messageId: string) => true),
  rollbackOneTurn: vi.fn<(options?: { refillInput?: boolean }) => Promise<TimelineRestoreResult>>(
    async () => ({
      status: 'restored',
      continuation: 'same-save',
    }),
  ),
}));
const ui = vi.hoisted(() => ({ toast: vi.fn(), navigate: vi.fn() }));
// 确认弹窗（GAME-06）：默认点「确认」，个别用例改成取消
const confirmDialog = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => true));

vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog }));
vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ui }));
vi.mock('../../../../src/ui/stores/scene-image-store', () => ({
  useSceneImageStore: () => ({
    activeSaveId: 'save_1',
    byMessage: () => [],
    generate: vi.fn(async () => ({ ok: true as const, id: 'simg_new' })),
  }),
}));
vi.mock('../../../../src/ui/stores/image-preset-store', () => ({
  useImagePresetStore: () => ({ loading: false, init: vi.fn(), find: vi.fn(() => undefined) }),
}));

/** 默认按 u1→第 1 回合、u2→第 2 回合编号（开场回合不能回退，GAME-15） */
function userMsg(
  id: string,
  content: string,
  turn = Number(id.replace(/\D/g, '')) || 1,
): ChatMessage {
  return { id, role: 'user', content, timestamp: 0, turn };
}

function assistantMsg(
  id: string,
  content: string,
  turn = Number(id.replace(/\D/g, '')) || 1,
): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 0, turn };
}

describe('ChatFlow 右键菜单 — user 消息', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    game.agentActivityRuns = [];
    game.rollbackOneTurn.mockResolvedValue({ status: 'restored', continuation: 'same-save' });
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

    // GAME-22：不再挂原生悬停提示（会反复弹在正文上），菜单本身有 menu / menuitem 语义
    expect(rows[1].attributes('title')).toBeUndefined();
    expect(menu.attributes('role')).toBe('menu');
    expect(menu.findAll('button').every((b) => b.attributes('role') === 'menuitem')).toBe(true);
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
    // GAME-06：先确认（危险样式），再回退
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(confirmDialog.mock.calls[0][0]).toMatchObject({ danger: true });
    expect(game.rollbackOneTurn).toHaveBeenCalledTimes(1);
    // 点完菜单关闭
    expect(wrapper.find('.ctx-menu').exists()).toBe(false);
  });

  it('确认框里点取消 → 不回退（GAME-06）', async () => {
    confirmDialog.mockResolvedValueOnce(false);
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '第一条'), userMsg('u2', '第二条')] },
    });
    await wrapper.findAll('.bubble-row-player')[1].trigger('contextmenu');
    await wrapper
      .findAll('.ctx-menu .ctx-item')
      .find((b) => b.text().includes('回退'))!
      .trigger('click');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(game.rollbackOneTurn).not.toHaveBeenCalled();
  });

  it('开场回合的输入不提供回退（GAME-15）：右键不拦默认菜单', async () => {
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '开场')] },
    });
    await wrapper.get('.bubble-row-player').trigger('contextmenu');
    expect(wrapper.find('.ctx-menu').exists()).toBe(false);
    // 没有回应的输入由「上一回合未完成」横幅接管：横幅里写明原因，而不是给一个点了才拒绝的按钮；
    // 输入下那行操作条并进横幅，不再单独出现
    const banner = wrapper.get('.turn-unfinished');
    expect(banner.text()).toContain('开场回合不能回退或重新生成');
    const labels = banner.findAll('button').map((b) => b.text());
    expect(labels).not.toContain('回退并重试');
    expect(labels).not.toContain('回退并修改输入');
    expect(wrapper.find('.turn-actions-player').exists()).toBe(false);
  });

  it('打开菜单后焦点移进第一项，方向键在项间移动', async () => {
    const wrapper = mount(ChatFlow, {
      attachTo: document.body,
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '第一条'), userMsg('u2', '第二条')] },
    });
    await wrapper.findAll('.bubble-row-player')[1].trigger('contextmenu');
    await flushPromises();
    const items = wrapper.findAll('.ctx-menu [role="menuitem"]');
    expect(document.activeElement).toBe(items[0].element);
    await wrapper.get('.ctx-menu').trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1].element);
    await wrapper.get('.ctx-menu').trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0].element);
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

  it('回退期间切换存档会提示 warning，不返回首页', async () => {
    game.rollbackOneTurn.mockResolvedValueOnce({
      status: 'restored',
      continuation: 'save-switched',
      warning: '时间线已恢复；当前已切换到其他存档',
    });
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '第一条'), userMsg('u2', '第二条')] },
    });

    await wrapper.findAll('.bubble-row-player')[1].trigger('contextmenu');
    await wrapper
      .findAll('.ctx-menu .ctx-item')
      .find((button) => button.text().includes('回退'))!
      .trigger('click');
    await flushPromises();

    expect(ui.toast).toHaveBeenCalledWith('时间线已恢复；当前已切换到其他存档', 'warning');
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

describe('ChatFlow 最新一回合的可见操作条（GAME-04）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    game.agentActivityRuns = [];
    game.isRewriting = false;
    game.isAgentCombat = false;
    game.rollbackOneTurn.mockResolvedValue({ status: 'restored', continuation: 'same-save' });
    confirmDialog.mockResolvedValue(true);
    useSettingsStore().settings.imageGenMode = 'manual';
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  });

  const twoTurns = () => [
    userMsg('u1', '第一轮'),
    assistantMsg('a1', '第一轮正文'),
    userMsg('u2', '推开那扇门'),
    assistantMsg('a2', '门后是一条长廊。'),
  ];

  function mountFlow(messages: ChatMessage[], props: Record<string, unknown> = {}) {
    return mount(ChatFlow, {
      global: { stubs: { teleport: true, BeautifiedNarrative: true } },
      props: { messages, ...props },
    });
  }

  const actionLabels = (wrapper: ReturnType<typeof mountFlow>) =>
    wrapper.findAll('.turn-actions button').map((b) => b.text());

  it('只挂在最新一条正文下面：重新生成 / 回退 / 润色 / 配图 / 复制，都是真按钮', () => {
    const wrapper = mountFlow(twoTurns());
    const rows = wrapper.findAll('.turn-actions');
    expect(rows).toHaveLength(1);
    expect(wrapper.findAll('.bubble-row-narrative')[1].find('.turn-actions').exists()).toBe(true);
    expect(actionLabels(wrapper)).toEqual(['重新生成', '回退', '润色', '配图', '复制']);
    expect(rows[0].findAll('button').every((b) => b.attributes('type') === 'button')).toBe(true);
  });

  it('配图档关掉时不出现「配图」（与右键菜单同一条件）', () => {
    useSettingsStore().settings.imageGenMode = 'off';
    expect(actionLabels(mountFlow(twoTurns()))).not.toContain('配图');
  });

  it('生成中整条收起', () => {
    expect(mountFlow(twoTurns(), { isGenerating: true }).find('.turn-actions').exists()).toBe(
      false,
    );
  });

  it('开场回合：不给回退 / 重新生成，写明原因', () => {
    const wrapper = mountFlow([userMsg('u1', '开场'), assistantMsg('a1', '故事开始了。')]);
    expect(actionLabels(wrapper)).toEqual(['润色', '配图', '复制']);
    expect(wrapper.get('.turn-actions').text()).toContain('开场回合不能回退或重新生成');
  });

  it('「重新生成」：确认 → 回退（不回填输入框）→ 用同一句输入走 send', async () => {
    const wrapper = mountFlow(twoTurns());
    const button = wrapper.findAll('.turn-actions button').find((b) => b.text() === '重新生成')!;
    await button.trigger('click');
    await flushPromises();

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const options = confirmDialog.mock.calls[0][0];
    expect(options.danger).toBe(true);
    expect(String(options.message)).toContain('重新调用模型');
    expect(game.rollbackOneTurn).toHaveBeenCalledWith({ refillInput: false });
    expect(wrapper.emitted('send')).toEqual([['推开那扇门']]);
  });

  it('「重新生成」取消确认 → 不回退也不发送', async () => {
    confirmDialog.mockResolvedValueOnce(false);
    const wrapper = mountFlow(twoTurns());
    await wrapper
      .findAll('.turn-actions button')
      .find((b) => b.text() === '重新生成')!
      .trigger('click');
    await flushPromises();
    expect(game.rollbackOneTurn).not.toHaveBeenCalled();
    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('「重新生成」回退被拒 → 只提示原因，不发送', async () => {
    game.rollbackOneTurn.mockResolvedValueOnce({ status: 'rejected', error: '找不到上一轮快照' });
    const wrapper = mountFlow(twoTurns());
    await wrapper
      .findAll('.turn-actions button')
      .find((b) => b.text() === '重新生成')!
      .trigger('click');
    await flushPromises();
    expect(ui.toast).toHaveBeenCalledWith('找不到上一轮快照', 'warning');
    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('「回退」：确认文案点明丢弃正文与手动改动，确认后回退并回填输入', async () => {
    const wrapper = mountFlow(twoTurns());
    await wrapper
      .findAll('.turn-actions button')
      .find((b) => b.text() === '回退')!
      .trigger('click');
    await flushPromises();
    const details = (confirmDialog.mock.calls[0][0].details as string[]).join('\n');
    expect(details).toContain('正文');
    expect(details).toContain('手动改动');
    expect(game.rollbackOneTurn).toHaveBeenCalledWith();
    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('最新输入没有正文（失败回合）→ 横幅第三条出路「回退并修改输入」，不再另起一行「回退到这条输入」', async () => {
    const wrapper = mountFlow([
      userMsg('u1', '第一轮'),
      assistantMsg('a1', '第一轮正文'),
      userMsg('u2', '失败的那句'),
    ]);
    expect(wrapper.find('.turn-actions-player').exists()).toBe(false);
    expect(wrapper.findAll('.turn-actions')).toHaveLength(0);
    const banner = wrapper.get('.turn-unfinished');
    await banner
      .findAll('button')
      .find((b) => b.text() === '回退并修改输入')!
      .trigger('click');
    await flushPromises();
    // 与原来那行同一条路：确认「回退到这条输入？」→ 回退并把输入填回（不自动重发）
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(confirmDialog.mock.calls[0][0]).toMatchObject({ title: '回退到这条输入？' });
    expect(game.rollbackOneTurn).toHaveBeenCalledWith();
    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('「复制」写剪贴板', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const wrapper = mountFlow(twoTurns());
    await wrapper
      .findAll('.turn-actions button')
      .find((b) => b.text() === '复制')!
      .trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('门后是一条长廊。');
  });

  it('润色进行中（GAME-07）：润色键变「润色中…」并禁用，有进度提示，发送被锁', () => {
    game.isRewriting = true;
    const wrapper = mountFlow(twoTurns());
    const rewrite = wrapper.findAll('.turn-actions button').find((b) => b.text() === '润色中…')!;
    expect(rewrite.attributes('disabled')).toBeDefined();
    expect(
      wrapper
        .findAll('.turn-actions button')
        .find((b) => b.text() === '重新生成')!
        .attributes('disabled'),
    ).toBeDefined();
    expect(wrapper.get('.turn-actions [role="status"]').text()).toContain('正在润色正文');
    const textarea = wrapper.get('textarea');
    expect(textarea.attributes('disabled')).toBeDefined();
    expect(textarea.attributes('placeholder')).toContain('正在润色正文');
  });

  it('润色过的正文出现「还原润色前」，点了调 store.restorePreRewrite', async () => {
    const messages = twoTurns();
    messages[3] = { ...messages[3], preRewriteContent: '原来的长廊。' };
    const wrapper = mountFlow(messages);
    const restore = wrapper.findAll('.turn-actions button').find((b) => b.text() === '还原润色前');
    expect(restore).toBeTruthy();
    await restore!.trigger('click');
    await flushPromises();
    expect(game.restorePreRewrite).toHaveBeenCalledWith('a2');
    expect(ui.toast).toHaveBeenCalledWith('已还原润色前的正文', 'success');

    // 右键菜单里同样有这一项
    await wrapper.findAll('.bubble-row-narrative')[1].trigger('contextmenu');
    expect(wrapper.findAll('.ctx-menu .ctx-item').map((b) => b.text())).toContain('还原润色前');
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

  it('润色侧链失败不给「重试」，也不挡住真正失败回合的重试（GAME-17）', () => {
    const failedTurn = {
      id: 'turn-attempt',
      sourceMessageId: 'u1',
      status: 'failed' as const,
      startedAt: 0,
      completedAt: 1,
      standalone: false,
      steps: [],
    };
    const failedRewrite = {
      id: 'rewrite-attempt',
      sourceMessageId: 'u1',
      status: 'failed' as const,
      startedAt: 2,
      completedAt: 3,
      standalone: true,
      steps: [
        {
          id: 'p',
          agentId: 'prose_rewrite',
          label: '润色这一段正文',
          status: 'failed' as const,
          startedAt: 2,
          tools: [],
        },
      ],
    };
    game.agentActivityRuns = [failedTurn, failedRewrite];
    const wrapper = mount(ChatFlow, {
      global: {
        stubs: {
          teleport: true,
          TurnActivityLedger: {
            props: ['run', 'canRetry'],
            template: '<button v-if="canRetry" class="retry-probe">{{ run.id }}</button>',
          },
        },
      },
      props: { messages: [userMsg('u1', '再试一次')], isGenerating: false },
    });
    expect(wrapper.findAll('.retry-probe').map((b) => b.text())).toEqual(['turn-attempt']);
  });
});

// 🆕 思考中指示（2026-08-12）：生成态、正文未出时显示当前 Agent 活动
describe('ChatFlow 未完成回合与已废弃的尝试（GAME-09 / GAME-10）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    game.agentActivityRuns = [];
    game.isRewriting = false;
    game.isAgentCombat = false;
    game.rollbackOneTurn.mockResolvedValue({ status: 'restored', continuation: 'same-save' });
    confirmDialog.mockResolvedValue(true);
    useSettingsStore().settings.imageGenMode = 'manual';
  });

  const withStatus = (m: ChatMessage, storyTurnStatus: ChatMessage['storyTurnStatus']) => ({
    ...m,
    storyTurnStatus,
  });

  function mountFlow(messages: ChatMessage[]) {
    return mount(ChatFlow, {
      global: { stubs: { teleport: true, BeautifiedNarrative: true } },
      props: { messages },
    });
  }

  it('重载后最新输入记着 failed、内存里没有回合记录 → 「上一回合未完成」横幅，原因未保留', async () => {
    const wrapper = mountFlow([
      withStatus(userMsg('u1', '第一轮'), 'accepted'),
      withStatus(assistantMsg('a1', '第一轮正文'), 'accepted'),
      withStatus(userMsg('u2', '推开门'), 'failed'),
    ]);
    const banner = wrapper.get('.turn-unfinished');
    expect(banner.text()).toContain('上一回合没有完成');
    expect(banner.text()).toContain('原因未保留');

    // 「再次尝试」走原来的重试缝
    await banner
      .findAll('button')
      .find((b) => b.text() === '再次尝试')!
      .trigger('click');
    expect(wrapper.emitted('retry-turn')).toEqual([['u2']]);

    // 「回退并重试」：确认 → 回退（不回填）→ 用同一句输入发送
    await banner
      .findAll('button')
      .find((b) => b.text() === '回退并重试')!
      .trigger('click');
    await flushPromises();
    expect(confirmDialog.mock.calls[0][0]).toMatchObject({ title: '回退并重试？', danger: true });
    expect(game.rollbackOneTurn).toHaveBeenCalledWith({ refillInput: false });
    expect(wrapper.emitted('send')).toEqual([['推开门']]);
  });

  it('内存里还有这条输入的回合记录时不重复显示横幅', () => {
    game.agentActivityRuns = [
      {
        id: 'r1',
        sourceMessageId: 'u2',
        status: 'failed',
        startedAt: 0,
        completedAt: 1,
        message: '中断',
        standalone: false,
        steps: [],
      },
    ];
    const wrapper = mount(ChatFlow, {
      global: {
        stubs: {
          teleport: true,
          BeautifiedNarrative: true,
          TurnActivityLedger: { template: '<div class="ledger-probe" />' },
        },
      },
      props: {
        messages: [
          withStatus(userMsg('u1', '第一轮'), 'accepted'),
          withStatus(userMsg('u2', '推开门'), 'failed'),
        ],
      },
    });
    expect(wrapper.find('.ledger-probe').exists()).toBe(true);
    expect(wrapper.find('.turn-unfinished').exists()).toBe(false);
  });

  it('pending 且没有回合在跑 = 生成途中被中断；生成中不显示', async () => {
    const messages = [
      withStatus(userMsg('u1', '第一轮'), 'accepted'),
      withStatus(userMsg('u2', '推开门'), 'pending'),
    ];
    const wrapper = mountFlow(messages);
    expect(wrapper.get('.turn-unfinished').text()).toContain('被中断');
    await wrapper.setProps({ isGenerating: true });
    expect(wrapper.find('.turn-unfinished').exists()).toBe(false);
  });

  it('已废弃的尝试折成一行（默认收起），不算「最新正文」、不挂操作条、右键不开菜单', async () => {
    const wrapper = mountFlow([
      withStatus(userMsg('u1', '第一轮'), 'accepted'),
      withStatus(assistantMsg('a1', '第一轮正文'), 'accepted'),
      withStatus(userMsg('u2', '推开门'), 'accepted'),
      withStatus(assistantMsg('a2', '第一次尝试'), 'failed'),
      withStatus(assistantMsg('a3', '第二次尝试'), 'failed'),
      withStatus(assistantMsg('a4', '采纳的正文', 2), 'accepted'),
    ]);
    const toggle = wrapper.get('.discarded-toggle');
    expect(toggle.text()).toContain('已废弃的尝试（2）');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.discarded-body').exists()).toBe(false);
    // 正文行只剩两条真正的正文；操作条挂在采纳的那条下面
    const narratives = wrapper.findAll('.bubble-row-narrative');
    expect(narratives.map((n) => n.attributes('data-message-id'))).toEqual(['a1', 'a4']);
    expect(narratives[1].find('.turn-actions').exists()).toBe(true);
    expect(wrapper.findAll('.turn-actions')).toHaveLength(1);

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.findAll('.discarded-body .discarded-narrative')).toHaveLength(2);

    await wrapper.get('.bubble-row-discarded').trigger('contextmenu');
    expect(wrapper.find('.ctx-menu').exists()).toBe(false);
  });

  it('回合失败后只剩废弃尝试：出路集中在那条输入下的横幅里（含「回退并修改输入」），不重复渲染操作条', () => {
    const wrapper = mountFlow([
      withStatus(userMsg('u1', '第一轮'), 'accepted'),
      withStatus(assistantMsg('a1', '第一轮正文'), 'accepted'),
      withStatus(userMsg('u2', '推开门'), 'failed'),
      withStatus(assistantMsg('a2', '写到一半'), 'failed'),
    ]);
    const banner = wrapper.get('.turn-unfinished');
    expect(banner.findAll('button').map((b) => b.text())).toEqual([
      '再次尝试',
      '回退并重试',
      '回退并修改输入',
    ]);
    expect(wrapper.find('.turn-actions-player').exists()).toBe(false);
    // 正文操作条也不挂在废弃尝试上
    expect(wrapper.findAll('.turn-actions')).toHaveLength(0);
  });
});

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

describe('ChatFlow 右键「润色正文」', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    game.agentActivityRuns = [];
    game.rewriteProse.mockResolvedValue({ ok: true });
    useSettingsStore().settings.imageGenMode = 'off';
  });

  /** 最新一条正文右键 → 点「润色正文」（走完整 UI 路径，不直接调 store） */
  async function rewriteFromLatestNarrative(): Promise<void> {
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true, BeautifiedNarrative: true } },
      props: { messages: [assistantMsg('a1', '原始正文。')] },
    });
    await wrapper.get('.bubble-row-narrative').trigger('contextmenu');
    const button = wrapper
      .findAll('.ctx-menu .ctx-item')
      .find((b) => b.text().includes('润色正文'));
    expect(button).toBeTruthy();
    await button!.trigger('click');
    await flushPromises();
  }

  it('成功但端点只回了 warning（base_url 不含 /beta）→ 成功提示之外再补一条警告', async () => {
    game.rewriteProse.mockResolvedValueOnce({
      ok: true,
      warning:
        '当前 API 源的 base_url 不含 /beta：DeepSeek 可能不接受前缀续写，本次仍按常规请求发送。',
    });

    await rewriteFromLatestNarrative();

    expect(game.rewriteProse).toHaveBeenCalledWith('a1');
    expect(ui.toast).toHaveBeenCalledWith('正文已润色', 'success');
    expect(ui.toast).toHaveBeenCalledWith(
      '当前 API 源的 base_url 不含 /beta：DeepSeek 可能不接受前缀续写，本次仍按常规请求发送。',
      'warning',
    );
  });

  it('协议不是 openai-chat 被硬拦 → 只显示原因，不提示成功', async () => {
    game.rewriteProse.mockResolvedValueOnce({
      ok: false,
      reason: '「正文润色」需要 openai-chat 协议的 DeepSeek /beta 端点（当前 API 源协议为 gemini）',
    });

    await rewriteFromLatestNarrative();

    expect(ui.toast).toHaveBeenCalledWith(
      '「正文润色」需要 openai-chat 协议的 DeepSeek /beta 端点（当前 API 源协议为 gemini）',
      'warning',
    );
    expect(ui.toast).not.toHaveBeenCalledWith('正文已润色', 'success');
  });
});

describe('ChatFlow 特效层（新消息浮现 / 流式交接 / 名字下划线 / 回合印记）', () => {
  function setFx(on: boolean) {
    if (on) document.documentElement.setAttribute('data-fx', 'on');
    else document.documentElement.removeAttribute('data-fx');
    useFxEnabled();
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    game.agentActivityRuns = [];
    game.characters = [];
    useSettingsStore().settings.imageGenMode = 'off';
  });

  afterEach(() => setFx(false));

  function narrativeRow(wrapper: ReturnType<typeof mount>, id: string) {
    return wrapper.find(`.bubble-row-narrative[data-message-id="${id}"]`);
  }

  it('闸门关：没有印记、没有浮现类、没有 settled 类', async () => {
    setFx(false);
    const messages = reactive<ChatMessage[]>([
      userMsg('u1', '走'),
      assistantMsg('a1', '洛恩走了。'),
    ]);
    const wrapper = mount(ChatFlow, { global: { stubs: { teleport: true } }, props: { messages } });
    messages.push(assistantMsg('a2', '新的一段。'));
    await flushPromises();
    expect(wrapper.find('.turn-seal').exists()).toBe(false);
    expect(wrapper.find('.fx-ink-para').exists()).toBe(false);
    expect(wrapper.find('.bubble-row-settled').exists()).toBe(false);
  });

  it('闸门开 + 载入的历史：零额外 span，只有静止的行末印记（pending / 已废弃不盖）', () => {
    setFx(true);
    const failed: ChatMessage = { ...assistantMsg('a0', '作废的尝试'), storyTurnStatus: 'failed' };
    const pending: ChatMessage = { ...assistantMsg('a2', '生成中'), storyTurnStatus: 'pending' };
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: {
        messages: [userMsg('u1', '走'), failed, assistantMsg('a1', '洛恩走了。'), pending],
      },
    });
    expect(wrapper.findAll('.fx-ink-chunk')).toHaveLength(0);
    expect(wrapper.findAll('.fx-first-name')).toHaveLength(0);
    expect(wrapper.find('.fx-ink-para').exists()).toBe(false);
    expect(narrativeRow(wrapper, 'a1').find('p .turn-seal').exists()).toBe(true);
    expect(narrativeRow(wrapper, 'a1').find('.turn-seal').classes()).not.toContain('is-pressed');
    expect(narrativeRow(wrapper, 'a2').find('.turn-seal').exists()).toBe(false);
    expect(wrapper.findAll('.turn-seal')).toHaveLength(1);
  });

  it('流式 → 提交：草稿逐词洇开；正式消息静默换上（不浮现、不重播入场），生成结束时盖印', async () => {
    setFx(true);
    const messages = reactive<ChatMessage[]>([userMsg('u1', '走')]);
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages, isGenerating: true, streamingText: '' },
    });
    await wrapper.setProps({ streamingText: '洛恩 推开 门' });
    expect(wrapper.find('.streaming-content .fx-ink-chunk').exists()).toBe(true);

    // 草稿先被清空，正式消息随后以 pending push 进同一个数组，接纳后原地翻成 accepted
    await wrapper.setProps({ streamingText: '' });
    messages.push({ ...assistantMsg('a1', '洛恩推开门。'), storyTurnStatus: 'pending' });
    await flushPromises();
    const row = narrativeRow(wrapper, 'a1');
    expect(row.classes()).toContain('bubble-row-settled');
    expect(row.find('.fx-ink-para').exists()).toBe(false);
    expect(row.findAll('.fx-ink-chunk')).toHaveLength(0);
    expect(row.find('.turn-seal').exists()).toBe(false);

    messages[1].storyTurnStatus = 'accepted';
    await flushPromises();
    expect(narrativeRow(wrapper, 'a1').find('p .turn-seal').exists()).toBe(true);
    expect(narrativeRow(wrapper, 'a1').find('.turn-seal').classes()).not.toContain('is-pressed');

    await wrapper.setProps({ isGenerating: false });
    expect(narrativeRow(wrapper, 'a1').find('.turn-seal').classes()).toContain('is-pressed');
  });

  it('真实流程（非流式）：pending → accepted → 生成结束，印记出现并且只盖一次', async () => {
    vi.useFakeTimers();
    try {
      setFx(true);
      const messages = reactive<ChatMessage[]>([userMsg('u1', '走')]);
      const wrapper = mount(ChatFlow, {
        global: { stubs: { teleport: true } },
        props: { messages, isGenerating: true, streamingText: '' },
      });
      messages.push({ ...assistantMsg('a1', '洛恩推开门。'), storyTurnStatus: 'pending' });
      await flushPromises();
      expect(narrativeRow(wrapper, 'a1').find('.turn-seal').exists()).toBe(false);
      messages[1].storyTurnStatus = 'accepted';
      await flushPromises();

      await wrapper.setProps({ isGenerating: false });
      const seal = () => narrativeRow(wrapper, 'a1').find('.turn-seal');
      expect(seal().exists()).toBe(true);
      expect(seal().classes()).toContain('is-pressed');
      vi.advanceTimersByTime(2000);
      await flushPromises();
      expect(seal().classes()).not.toContain('is-pressed');

      // 同一回合不会因为别的 prop 变化再盖一次
      await wrapper.setProps({ streamingText: '' });
      expect(seal().classes()).not.toContain('is-pressed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('失败 / 中止的生成不把上一回合的印再盖一遍', async () => {
    vi.useFakeTimers();
    try {
      setFx(true);
      const messages = reactive<ChatMessage[]>([userMsg('u1', '走')]);
      const wrapper = mount(ChatFlow, {
        global: { stubs: { teleport: true } },
        props: { messages, isGenerating: true, streamingText: '' },
      });
      messages.push({ ...assistantMsg('a1', '洛恩推开门。'), storyTurnStatus: 'pending' });
      await flushPromises();
      messages[1].storyTurnStatus = 'accepted';
      await wrapper.setProps({ isGenerating: false });
      const seal = () => narrativeRow(wrapper, 'a1').find('.turn-seal');
      expect(seal().classes()).toContain('is-pressed');
      vi.advanceTimersByTime(2000);
      await flushPromises();
      expect(seal().classes()).not.toContain('is-pressed');

      // 第二回合：失败（正文以 pending 推入后被标 failed）
      messages.push(userMsg('u2', '再走'));
      await wrapper.setProps({ isGenerating: true });
      messages.push({ ...assistantMsg('a2', '半截正文'), storyTurnStatus: 'pending' });
      await flushPromises();
      messages[3].storyTurnStatus = 'failed';
      await wrapper.setProps({ isGenerating: false });
      expect(seal().classes()).not.toContain('is-pressed');
      expect(wrapper.findAll('.turn-seal.is-pressed')).toHaveLength(0);

      // 第三回合：直接被中止，没有任何正文
      messages.push(userMsg('u3', '又走'));
      await wrapper.setProps({ isGenerating: true });
      await wrapper.setProps({ isGenerating: false });
      expect(wrapper.findAll('.turn-seal.is-pressed')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('通知行不盖印：状态写入失败通知（diagnostic）与战斗摘要', async () => {
    setFx(true);
    const messages = reactive<ChatMessage[]>([userMsg('u1', '走')]);
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages, isGenerating: true, streamingText: '' },
    });
    messages.push(
      { ...assistantMsg('a1', '洛恩推开门。'), storyTurnStatus: 'accepted' },
      { ...assistantMsg('n1', '[系统] story 部分状态未能写入: x'), diagnostic: true },
      assistantMsg('n2', '【战斗摘要】洛恩击退了狼群。'),
    );
    await flushPromises();
    await wrapper.setProps({ isGenerating: false });
    expect(narrativeRow(wrapper, 'n1').find('.turn-seal').exists()).toBe(false);
    expect(narrativeRow(wrapper, 'n2').find('.turn-seal').exists()).toBe(false);
    // 印盖在本回合的故事正文上，而不是盖在最后推进来的通知行上
    expect(narrativeRow(wrapper, 'a1').find('.turn-seal').classes()).toContain('is-pressed');
    expect(wrapper.findAll('.turn-seal')).toHaveLength(1);
  });

  /**
   * 回归：印记曾是条件插槽 `<template v-if #end>`，带动态插槽标记的子组件在父组件每次渲染时
   * 都被强制重渲染 —— 流式时 ChatFlow 每帧渲染一次，于是每条历史正文每帧重渲染一遍（闸门关也一样）。
   */
  it.each([false, true])('流式逐帧时历史正文零重渲染（闸门 %s，印记无变化）', async (fx) => {
    setFx(fx);
    const messages: ChatMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      messages.push(userMsg(`u${i}`, '走'));
      messages.push({
        ...assistantMsg(`a${i}`, '第一段。\n\n第二段。'),
        storyTurnStatus: 'accepted',
      });
    }
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages, isGenerating: true, streamingText: '' },
    });
    await flushPromises();
    const history = wrapper.findAllComponents(BeautifiedNarrative);
    expect(history).toHaveLength(10);
    if (fx) expect(wrapper.findAll('.turn-seal')).toHaveLength(10);
    let renders = 0;
    for (const narrative of history) {
      const instance = (narrative.vm as unknown as { $: { render: (...a: unknown[]) => unknown } })
        .$;
      const original = instance.render;
      instance.render = function (this: unknown, ...args: unknown[]) {
        renders++;
        return original.apply(this, args);
      };
    }
    for (let frame = 1; frame <= 5; frame++) {
      await wrapper.setProps({ streamingText: '草稿 '.repeat(frame) });
      await flushPromises();
    }
    expect(wrapper.find('.streaming-content').exists()).toBe(true);
    expect(renders).toBe(0);
  });

  it('流式提交之后推进来的非故事行照常播放入场（不挂 settled、整段浮现）', async () => {
    setFx(true);
    const messages = reactive<ChatMessage[]>([userMsg('u1', '走')]);
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages, isGenerating: true, streamingText: '' },
    });
    await wrapper.setProps({ streamingText: '洛恩 推开 门' });
    await wrapper.setProps({ streamingText: '' });
    messages.push({ ...assistantMsg('a1', '洛恩推开门。'), storyTurnStatus: 'pending' });
    await flushPromises();
    messages.push({ ...assistantMsg('n1', '[系统] story 部分状态未能写入: x'), diagnostic: true });
    await flushPromises();
    expect(narrativeRow(wrapper, 'a1').classes()).toContain('bubble-row-settled');
    const notice = narrativeRow(wrapper, 'n1');
    expect(notice.classes()).not.toContain('bubble-row-settled');
    expect(notice.find('p.fx-ink-para').exists()).toBe(true);

    // 生成之外推进来的（战斗摘要）同样照常入场
    await wrapper.setProps({ isGenerating: false });
    messages.push(assistantMsg('n2', '【战斗摘要】洛恩击退了狼群。'));
    await flushPromises();
    const summary = narrativeRow(wrapper, 'n2');
    expect(summary.classes()).not.toContain('bubble-row-settled');
    expect(summary.find('p.fx-ink-para').exists()).toBe(true);
  });

  it('整条一次到达的新消息：段落整块浮现一次，保留入场动画', async () => {
    setFx(true);
    const messages = reactive<ChatMessage[]>([userMsg('u1', '走')]);
    const wrapper = mount(ChatFlow, { global: { stubs: { teleport: true } }, props: { messages } });
    messages.push(assistantMsg('a1', '第一段。\n\n第二段。'));
    await flushPromises();
    const row = narrativeRow(wrapper, 'a1');
    expect(row.classes()).not.toContain('bubble-row-settled');
    expect(row.findAll('p.fx-ink-para')).toHaveLength(2);
    expect(row.findAll('.fx-ink-chunk')).toHaveLength(0);
  });

  it('名字初次登场只标新消息，且跳过早先出现过的名字', async () => {
    setFx(true);
    game.characters = [
      { type: 'npc', name: '艾琳娜', location: '', inventory: [] },
      { type: 'npc', name: '洛恩', location: '', inventory: [] },
    ];
    const messages = reactive<ChatMessage[]>([
      userMsg('u1', '走'),
      assistantMsg('a1', '洛恩醒来。'),
    ]);
    const wrapper = mount(ChatFlow, { global: { stubs: { teleport: true } }, props: { messages } });
    expect(wrapper.findAll('.fx-first-name')).toHaveLength(0);

    messages.push(userMsg('u2', '找人'), assistantMsg('a2', '洛恩遇见了艾琳娜。'));
    await flushPromises();
    const marks = narrativeRow(wrapper, 'a2').findAll('.fx-first-name');
    expect(marks.map((m) => m.text())).toEqual(['艾琳娜']);
    expect(narrativeRow(wrapper, 'a1').findAll('.fx-first-name')).toHaveLength(0);
  });
});
