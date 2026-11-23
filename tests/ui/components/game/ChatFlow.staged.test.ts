/**
 * ChatFlow 逐节演出（交互式推进 T6）
 *
 * - 只演「开关开 × 直出模式 × 本次会话新到」的故事正文；开关关 / 非直出走原渲染
 * - 推进：左键点正文 / Space / Enter；End 全部显示；按住 Ctrl 快进
 * - 让路：选区、弹窗、输入框、按钮
 * - 草稿只放完整的节；流结束清预览后草稿仍在；交接给正式消息时进度不回退、不重放
 * - 行动选项等末节放完且回合已接纳才出现；发送新输入先全部显示
 * - 登场：本楼新建档的人物在其首现节前浮现；开楼名册里的人物即便模型标了也不演
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { AgentActivityRun, ChatMessage } from '@engine/types/types';
import ChatFlow from '../../../../src/ui/components/game/ChatFlow.vue';
import { useSettingsStore } from '../../../../src/ui/stores/settings-store';
import { useFxEnabled } from '../../../../src/ui/lib/fx-gate';

enableAutoUnmount(afterEach);

const game = vi.hoisted(() => ({
  isInCombat: false,
  isAgentCombat: false,
  isRewriting: false,
  activeModal: null as string | null,
  generationMode: 'direct',
  characters: [] as Array<{ name: string; aliases?: string[]; introducedBy?: string }>,
  pendingOptions: [] as string[],
  pendingInput: null as string | null,
  agentActivityRuns: [] as AgentActivityRun[],
  currentAgentActivityRun: null as AgentActivityRun | null,
  clearPendingInput: vi.fn(),
  rewriteProse: vi.fn(async () => ({ ok: true })),
  restorePreRewrite: vi.fn(async () => true),
  rollbackOneTurn: vi.fn(async () => ({ status: 'restored', continuation: 'same-save' })),
}));
const ui = vi.hoisted(() => ({ toast: vi.fn(), navigate: vi.fn() }));

vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: vi.fn(async () => true),
}));
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
// 登场卡的立牌链：测试里一律没有素材 → 只浮现名字题签
vi.mock('../../../../src/ui/composables/useAssetImage', async () => {
  const { ref } = await import('vue');
  return { useAssetImage: () => ({ url: ref(null), isVideo: ref(false), row: ref(null) }) };
});

const S1 = '雨落在旧城的石板上。';
const S2 = '一个披斗篷的陌生人推门而入。';
const S3 = '炉火噼啪作响。';
const CONTENT = `${S1}\n\n${S2}\n\n${S3}`;
const B1 = CONTENT.indexOf(S2);
const B2 = CONTENT.indexOf(S3);

function userMsg(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 0, turn: 2 };
}

function storyMsg(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: CONTENT,
    timestamp: 0,
    turn: 2,
    storyTurnStatus: 'pending',
    storyTurnKey: 'turn_k',
    stage: { breaks: [B1, B2], enters: [] },
    ...extra,
  };
}

function setFx(on: boolean) {
  if (on) document.documentElement.setAttribute('data-fx', 'on');
  else document.documentElement.removeAttribute('data-fx');
  useFxEnabled();
}

function sectionTexts(wrapper: VueWrapper) {
  return wrapper.findAll('.staged-narrative .stage-section').map((section) => section.text());
}

/** 挂载后 push 一条新正文（挂载时已在场的算历史，不演） */
async function mountWithFresh(message: ChatMessage, props: Record<string, unknown> = {}) {
  const messages = reactive<ChatMessage[]>([userMsg('u1', '进门')]);
  const wrapper = mount(ChatFlow, {
    attachTo: document.body,
    global: { stubs: { teleport: true } },
    props: { messages, isGenerating: true, streamingText: '', ...props },
  });
  messages.push(message);
  await flushPromises();
  return { wrapper, messages };
}

function pressKey(key: string, init: KeyboardEventInit = {}, type = 'keydown') {
  window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init }));
}

describe('ChatFlow 逐节演出', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    setFx(false);
    game.generationMode = 'direct';
    game.activeModal = null;
    game.isInCombat = false;
    game.characters = [];
    game.pendingOptions = [];
    useSettingsStore().settings.imageGenMode = 'off';
    useSettingsStore().settings.stagedNarrative = true;
    useSettingsStore().settings.stagedControlsCollapsed = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('开关关：整段原渲染，没有演出容器与小条', async () => {
    useSettingsStore().settings.stagedNarrative = false;
    const { wrapper } = await mountWithFresh(storyMsg('a1'));
    expect(wrapper.find('.staged-narrative').exists()).toBe(false);
    expect(wrapper.find('.stage-bar').exists()).toBe(false);
    const row = wrapper.find('.bubble-row-narrative[data-message-id="a1"]');
    expect(row.text()).toContain(S3);
  });

  it('非直出模式不演', async () => {
    game.generationMode = 'agent';
    const { wrapper } = await mountWithFresh(storyMsg('a1'));
    expect(wrapper.find('.staged-narrative').exists()).toBe(false);
  });

  it('挂载时已在场的历史消息不演', async () => {
    const wrapper = mount(ChatFlow, {
      global: { stubs: { teleport: true } },
      props: { messages: [userMsg('u1', '进门'), storyMsg('a1')] },
    });
    await flushPromises();
    expect(wrapper.find('.staged-narrative').exists()).toBe(false);
  });

  it('新正文先放首节；点正文、Space、Enter 依次推进，放完小条消失', async () => {
    const { wrapper } = await mountWithFresh(storyMsg('a1'), { isGenerating: false });
    expect(sectionTexts(wrapper)).toEqual([S1]);
    expect(wrapper.find('.stage-bar').exists()).toBe(true);

    await wrapper.find('.chat-messages').trigger('click');
    expect(sectionTexts(wrapper)).toEqual([S1, S2]);

    pressKey(' ');
    await flushPromises();
    expect(sectionTexts(wrapper)).toEqual([S1, S2, S3]);
    expect(wrapper.find('.stage-bar').exists()).toBe(false);

    // 放完后 Enter 不再被拦
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    window.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
  });

  it('End 全部显示；小条上的「全部显示」同效', async () => {
    const { wrapper } = await mountWithFresh(storyMsg('a1'), { isGenerating: false });
    pressKey('End');
    await flushPromises();
    expect(sectionTexts(wrapper)).toEqual([S1, S2, S3]);

    const second = await mountWithFresh(storyMsg('a2'), { isGenerating: false });
    const skip = second.wrapper
      .findAll('.stage-bar button')
      .find((button) => button.text().includes('全部显示'));
    await skip!.trigger('click');
    expect(sectionTexts(second.wrapper)).toEqual([S1, S2, S3]);
  });

  it('控制条挂在输入框正上方、不在正文里；收起后只剩标签且记进设置，推进照常', async () => {
    const { wrapper } = await mountWithFresh(storyMsg('a1'), { isGenerating: false });
    const settings = useSettingsStore().settings;
    expect(wrapper.find('.staged-narrative .stage-bar').exists()).toBe(false);
    const dock = wrapper.find('.stage-dock');
    expect(dock.exists()).toBe(true);
    // 在消息滚动区之外，紧排在输入框前面
    expect(dock.element.closest('.chat-messages')).toBeNull();
    const inputBar = wrapper.find('.input-bar').element;
    expect(
      dock.element.compareDocumentPosition(inputBar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await wrapper.find('button[aria-label="收起正文演出控制"]').trigger('click');
    expect(settings.stagedControlsCollapsed).toBe(true);
    expect(wrapper.find('.stage-bar').exists()).toBe(false);
    expect(wrapper.find('.stage-dock-tab').exists()).toBe(true);

    await wrapper.find('.chat-messages').trigger('click');
    expect(sectionTexts(wrapper)).toEqual([S1, S2]);

    await wrapper.find('.stage-dock-tab').trigger('click');
    expect(settings.stagedControlsCollapsed).toBe(false);
    expect(wrapper.find('.stage-bar').exists()).toBe(true);
  });

  it('让路：有选区、弹窗开着、焦点在输入框、点在按钮上都不推进', async () => {
    const { wrapper } = await mountWithFresh(storyMsg('a1'), { isGenerating: false });

    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => '雨落',
    } as unknown as Selection);
    await wrapper.find('.chat-messages').trigger('click');
    expect(sectionTexts(wrapper)).toEqual([S1]);
    selection.mockRestore();

    game.activeModal = 'items';
    pressKey(' ');
    await flushPromises();
    expect(sectionTexts(wrapper)).toEqual([S1]);
    game.activeModal = null;

    const textarea = wrapper.find('textarea').element;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushPromises();
    expect(sectionTexts(wrapper)).toEqual([S1]);

    // 输入法组合中的回车
    pressKey('Enter', { isComposing: true });
    await flushPromises();
    expect(sectionTexts(wrapper)).toEqual([S1]);

    // 点在按钮上（这颗「演出」是禁用的当前态）不推进
    const fullBtn = wrapper.findAll('.stage-bar button').find((b) => b.text() === '演出');
    await fullBtn!.trigger('click');
    expect(sectionTexts(wrapper)).toEqual([S1]);

    // 都撤掉之后正常推进
    await wrapper.find('.chat-messages').trigger('click');
    expect(sectionTexts(wrapper)).toEqual([S1, S2]);
  });

  it('单独按住 Ctrl 超过 300ms 才快进，松开即停；单按一下不推进', async () => {
    vi.useFakeTimers();
    try {
      const longer = `${CONTENT}\n\n尾声。`;
      const { wrapper } = await mountWithFresh(
        storyMsg('a1', {
          content: longer,
          stage: { breaks: [B1, B2, longer.indexOf('尾声')], enters: [] },
        }),
        { isGenerating: false },
      );
      // 单按一下：按下立刻松开，不推进
      pressKey('Control', { ctrlKey: true });
      pressKey('Control', {}, 'keyup');
      vi.advanceTimersByTime(1000);
      await flushPromises();
      expect(sectionTexts(wrapper)).toHaveLength(1);

      // 按住：300ms 内不动，过了阈值开始快进
      pressKey('Control', { ctrlKey: true });
      vi.advanceTimersByTime(250);
      await flushPromises();
      expect(sectionTexts(wrapper)).toHaveLength(1);
      vi.advanceTimersByTime(60);
      await flushPromises();
      expect(sectionTexts(wrapper)).toHaveLength(2);
      vi.advanceTimersByTime(230);
      await flushPromises();
      expect(sectionTexts(wrapper)).toHaveLength(3);
      pressKey('Control', {}, 'keyup');
      vi.advanceTimersByTime(1000);
      await flushPromises();
      expect(sectionTexts(wrapper)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Ctrl+其它键、Ctrl+滚轮不触发快进', async () => {
    vi.useFakeTimers();
    try {
      const { wrapper } = await mountWithFresh(storyMsg('a1'), { isGenerating: false });
      pressKey('Control', { ctrlKey: true });
      pressKey('f', { ctrlKey: true });
      vi.advanceTimersByTime(1000);
      await flushPromises();
      expect(sectionTexts(wrapper)).toHaveLength(1);
      pressKey('Control', {}, 'keyup');

      pressKey('Control', { ctrlKey: true });
      window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 100 }));
      vi.advanceTimersByTime(1000);
      await flushPromises();
      expect(sectionTexts(wrapper)).toHaveLength(1);
      pressKey('Control', {}, 'keyup');
    } finally {
      vi.useRealTimers();
    }
  });

  it('读完的消息润色变长后保持全部显示，不重新折起、不再暂扣选项', async () => {
    game.pendingOptions = ['跟上去'];
    const { wrapper, messages } = await mountWithFresh(
      storyMsg('a1', { storyTurnStatus: 'accepted' }),
      { isGenerating: false },
    );
    // 逐节推进读完（不用 End：showAll 会掩盖游标停在旧长度的问题）
    await wrapper.find('.chat-messages').trigger('click');
    await wrapper.find('.chat-messages').trigger('click');
    expect(sectionTexts(wrapper)).toEqual([S1, S2, S3]);
    expect(wrapper.find('.input-btn[title="可选行动"]').exists()).toBe(true);

    messages[1].content = `${S1}然后更长了。\n\n${S2}\n\n${S3}\n\n新补的一段。`;
    await flushPromises();
    expect(sectionTexts(wrapper)).toHaveLength(4);
    expect(sectionTexts(wrapper)[3]).toBe('新补的一段。');
    expect(wrapper.find('.stage-bar').exists()).toBe(false);
    expect(wrapper.find('.input-btn[title="可选行动"]').exists()).toBe(true);
  });

  it('演到一半被作废（failed）的尝试不再吞 Space / 点击', async () => {
    const { wrapper, messages } = await mountWithFresh(storyMsg('a1'), { isGenerating: false });
    expect(sectionTexts(wrapper)).toEqual([S1]);
    messages[1].storyTurnStatus = 'failed';
    await flushPromises();
    const space = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    window.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(wrapper.find('.stage-bar').exists()).toBe(false);
  });

  it('行动选项：末节放完且回合已接纳后才出现', async () => {
    game.pendingOptions = ['跟上去'];
    const { wrapper, messages } = await mountWithFresh(storyMsg('a1'), { isGenerating: false });
    const optionsBtn = () => wrapper.find('.input-btn[title="可选行动"]');
    expect(optionsBtn().exists()).toBe(false);

    pressKey('End');
    await flushPromises();
    expect(optionsBtn().exists()).toBe(false); // 还是 pending

    messages[1].storyTurnStatus = 'accepted';
    await flushPromises();
    expect(optionsBtn().exists()).toBe(true);
  });

  it('本楼状态更新块：与行动选项同一时机 —— 接纳且末节放完才出现，默认收起（T13）', async () => {
    const stateUpdates = {
      deltaMinutes: 0,
      ops: [{ path: '/主角/金钱', op: 'delta' as const, value: 5, status: '已应用' as const }],
    };
    const { wrapper, messages } = await mountWithFresh(storyMsg('a1', { stateUpdates }), {
      isGenerating: false,
    });
    Object.assign(game, { messages, isGenerating: false, agentLogHistory: [] });
    const block = () => wrapper.find('[data-testid="state-update-block"]');
    expect(block().exists()).toBe(false); // pending（流式 / 接纳前）

    messages[1].storyTurnStatus = 'accepted';
    await flushPromises();
    expect(block().exists()).toBe(false); // 演出还没放完

    pressKey('End');
    await flushPromises();
    expect(block().exists()).toBe(true);
    expect(block().attributes('open')).toBeUndefined();
    expect(block().text()).toContain('本楼状态更新 1 项');
  });

  it('发送新输入前先全部显示', async () => {
    const { wrapper } = await mountWithFresh(storyMsg('a1', { storyTurnStatus: 'accepted' }), {
      isGenerating: false,
    });
    await wrapper.find('textarea').setValue('跟上去');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('send')).toEqual([['跟上去']]);
    expect(sectionTexts(wrapper)).toEqual([S1, S2, S3]);
  });

  it('「全文」关掉演出设置，回到整段显示', async () => {
    const { wrapper } = await mountWithFresh(storyMsg('a1'), { isGenerating: false });
    const full = wrapper.findAll('.stage-bar button').find((b) => b.text() === '全文');
    await full!.trigger('click');
    expect(useSettingsStore().settings.stagedNarrative).toBe(false);
    expect(wrapper.find('.staged-narrative').exists()).toBe(false);
    expect(ui.toast).toHaveBeenCalled();
  });

  it('草稿：只放完整的节、追上时显示等待；清预览后仍在；交接给正式消息不回退不重放', async () => {
    setFx(true);
    const messages = reactive<ChatMessage[]>([userMsg('u1', '进门')]);
    const wrapper = mount(ChatFlow, {
      attachTo: document.body,
      global: { stubs: { teleport: true } },
      props: { messages, isGenerating: false, streamingText: '' },
    });
    await wrapper.setProps({ isGenerating: true });
    const partial = `${S1}\n\n${S2.slice(0, 4)}`;
    await wrapper.setProps({
      streamingText: partial,
      streamingStage: { breaks: [B1], enters: [], closed: false },
    });
    expect(sectionTexts(wrapper)).toEqual([S1]);
    expect(wrapper.find('.stage-waiting').exists()).toBe(true);
    expect(wrapper.find('.thinking-indicator').exists()).toBe(false);
    expect(wrapper.find('.streaming-content').exists()).toBe(false);

    // 第二节写完（第三节起头）→ 可推进
    await wrapper.setProps({
      streamingText: `${S1}\n\n${S2}\n\n炉火`,
      streamingStage: { breaks: [B1, B2], enters: [], closed: false },
    });
    await wrapper.find('.chat-messages').trigger('click');
    expect(sectionTexts(wrapper)).toEqual([S1, S2]);

    // 流结束清预览：草稿进度留着
    await wrapper.setProps({ streamingText: '', streamingStage: null });
    expect(sectionTexts(wrapper)).toEqual([S1, S2]);

    // 正式消息领走进度：仍是两节，且已读的节不再浮现
    messages.push(storyMsg('a1'));
    await flushPromises();
    const row = wrapper.find('.bubble-row-narrative[data-message-id="a1"]');
    expect(row.findAll('.stage-section').map((s) => s.text())).toEqual([S1, S2]);
    expect(row.find('.fx-ink-para').exists()).toBe(false);
    expect(wrapper.findAll('.staged-narrative')).toHaveLength(1);

    // 新放出的第三节才浮现
    await wrapper.find('.chat-messages').trigger('click');
    expect(row.findAll('.stage-section').map((s) => s.text())).toEqual([S1, S2, S3]);
    expect(row.findAll('.stage-section')[2].find('.fx-ink-para').exists()).toBe(true);
    expect(row.findAll('.stage-section')[0].find('.fx-ink-para').exists()).toBe(false);
  });

  it('登场：临时段落切换成模型断点后，新节的 enter 不被旧的按序号锁吞掉', async () => {
    const messages = reactive<ChatMessage[]>([userMsg('u1', '进门')]);
    const wrapper = mount(ChatFlow, {
      attachTo: document.body,
      global: { stubs: { teleport: true } },
      props: { messages, isGenerating: false, streamingText: '' },
    });
    await wrapper.setProps({ isGenerating: true });
    // 尚未见到任何 <beat/>：按段落临时切，玩家推进一次放出临时第 2 段
    await wrapper.setProps({
      streamingText: '第一段。\n\n第二段。\n\n第三',
      streamingStage: { breaks: [], enters: [], closed: false },
    });
    await wrapper.find('.chat-messages').trigger('click');
    expect(sectionTexts(wrapper)).toEqual(['第一段。', '第二段。']);

    // 模型断点到了：首节并成前三段，艾拉那一节是新的第 2 节
    const text = '第一段。\n\n第二段。\n\n第三段。\n\n艾拉推门而入。\n\n尾声';
    const at = text.indexOf('艾拉');
    await wrapper.setProps({
      streamingText: text,
      streamingStage: {
        breaks: [at, text.indexOf('尾声')],
        enters: [{ name: '艾拉', at }],
        closed: false,
      },
    });
    expect(wrapper.find('.stage-entrance').exists()).toBe(false);
    await wrapper.find('.chat-messages').trigger('click');
    const entrances = wrapper.findAll('.stage-entrance');
    expect(entrances).toHaveLength(1);
    expect(entrances[0].text()).toContain('艾拉');
  });

  it('登场：已置 accepted 但名册还没回读本楼建档的窗口里，合法新角色照常登场且之后不丢', async () => {
    game.characters = [{ name: '洛恩' }];
    const { wrapper } = await mountWithFresh(
      storyMsg('a1', {
        storyTurnStatus: 'accepted',
        stage: { breaks: [B1, B2], enters: [{ name: '陌生人', at: B1 }] },
      }),
      { isGenerating: true },
    );
    await wrapper.find('.chat-messages').trigger('click');
    expect(wrapper.findAll('.stage-entrance').map((e) => e.text())).toEqual([
      expect.stringContaining('陌生人'),
    ]);

    // 收尾回读：名册里出现本楼建档的角色，生成结束 —— 登场卡仍在
    game.characters = [{ name: '洛恩' }, { name: '陌生人', introducedBy: 'turn_k' }];
    await wrapper.setProps({ isGenerating: false });
    await flushPromises();
    expect(wrapper.findAll('.stage-entrance').map((e) => e.text())).toEqual([
      expect.stringContaining('陌生人'),
    ]);
  });

  it('登场：润色挪了节起点，已演过的登场卡不消失、还原后也只有一张', async () => {
    game.characters = [{ name: '陌生人', introducedBy: 'turn_k' }];
    const { wrapper, messages } = await mountWithFresh(
      storyMsg('a1', {
        storyTurnStatus: 'accepted',
        stage: { breaks: [B1, B2], enters: [{ name: '陌生人', at: B1 }] },
      }),
      { isGenerating: false },
    );
    await wrapper.find('.chat-messages').trigger('click');
    await wrapper.find('.chat-messages').trigger('click');
    expect(wrapper.findAll('.stage-entrance')).toHaveLength(1);

    // 润色：首节变长，旁路断点失效，按段落兜底 —— 节起点全变了
    messages[1].content = `${S1}润色加了一句。\n\n${S2}\n\n${S3}`;
    await flushPromises();
    expect(wrapper.findAll('.stage-entrance')).toHaveLength(1);
    expect(wrapper.find('.stage-entrance').text()).toContain('陌生人');

    // 还原润色前
    messages[1].content = CONTENT;
    await flushPromises();
    expect(wrapper.findAll('.stage-entrance')).toHaveLength(1);
  });

  it('演过就不再撤回：标了 enter 却未建档的人物，接纳、回读、生成结束后都不消失', async () => {
    const { wrapper, messages } = await mountWithFresh(
      storyMsg('a1', { stage: { breaks: [B1, B2], enters: [{ name: '路人', at: B1 }] } }),
      { isGenerating: true },
    );
    await wrapper.find('.chat-messages').trigger('click');
    const card = wrapper.find('.stage-entrance');
    expect(card.text()).toContain('路人');

    messages[1].storyTurnStatus = 'accepted';
    game.characters = [{ name: '别的新角色', introducedBy: 'turn_k' }];
    await wrapper.setProps({ isGenerating: false });
    await flushPromises();
    const after = wrapper.findAll('.stage-entrance');
    expect(after).toHaveLength(1);
    expect(after[0].text()).toContain('路人');
    expect(after[0].element).toBe(card.element);
  });

  it('演过就不再撤回：enter 写的是别名，回读出本名后仍是那一张、不重画', async () => {
    const { wrapper, messages } = await mountWithFresh(
      storyMsg('a1', { stage: { breaks: [B1, B2], enters: [{ name: '斗篷客', at: B1 }] } }),
      { isGenerating: true },
    );
    await wrapper.find('.chat-messages').trigger('click');
    const card = wrapper.find('.stage-entrance');
    expect(card.text()).toContain('斗篷客');

    messages[1].storyTurnStatus = 'accepted';
    game.characters = [{ name: '陌生人', aliases: ['斗篷客'], introducedBy: 'turn_k' }];
    await wrapper.setProps({ isGenerating: false });
    await flushPromises();
    const after = wrapper.findAll('.stage-entrance');
    expect(after).toHaveLength(1);
    expect(after[0].element).toBe(card.element);
  });

  it('之后的回合生成期间，旧消息的登场卡不重现、不闪烁', async () => {
    game.characters = [{ name: '陌生人', introducedBy: 'turn_k' }];
    const { wrapper, messages } = await mountWithFresh(
      storyMsg('a1', {
        storyTurnStatus: 'accepted',
        stage: { breaks: [B1, B2], enters: [{ name: '陌生人', at: B1 }] },
      }),
      { isGenerating: false },
    );
    await wrapper.find('.chat-messages').trigger('click');
    await wrapper.find('.chat-messages').trigger('click');
    const row = () => wrapper.find('.bubble-row-narrative[data-message-id="a1"]');
    const card = row().find('.stage-entrance');
    expect(card.exists()).toBe(true);

    // 下一回合：开始生成、流式草稿、名册变化（下一楼又建了新角色，正文里也提到他）
    messages.push(userMsg('u2', '跟上去'));
    await wrapper.setProps({ isGenerating: true });
    game.characters = [
      { name: '陌生人', introducedBy: 'turn_k' },
      { name: '炉火', introducedBy: 'turn_next' },
    ];
    await wrapper.setProps({
      streamingText: '他们出了门。\n\n街上很冷',
      streamingStage: { breaks: [], enters: [], closed: false },
    });
    await flushPromises();
    const cards = row().findAll('.stage-entrance');
    expect(cards).toHaveLength(1);
    expect(cards[0].element).toBe(card.element);

    await wrapper.setProps({ isGenerating: false, streamingText: '', streamingStage: null });
    await flushPromises();
    expect(row().findAll('.stage-entrance')).toHaveLength(1);
    expect(row().find('.stage-entrance').element).toBe(card.element);
  });

  it('登场：本楼新建档的人物在首现节前浮现名字；开楼名册里的人物标了也不演', async () => {
    game.characters = [{ name: '洛恩' }, { name: '陌生人', introducedBy: 'turn_k' }];
    const { wrapper } = await mountWithFresh(
      storyMsg('a1', {
        stage: {
          breaks: [B1, B2],
          enters: [
            { name: '洛恩', at: 0 },
            { name: '陌生人', at: B1 },
          ],
        },
      }),
      { isGenerating: false },
    );
    expect(wrapper.find('.stage-entrance').exists()).toBe(false);

    await wrapper.find('.chat-messages').trigger('click');
    const entrances = wrapper.findAll('.stage-entrance');
    expect(entrances).toHaveLength(1);
    expect(entrances[0].text()).toContain('陌生人');
    expect(entrances[0].find('.entrance-portrait').exists()).toBe(false);
  });
});
