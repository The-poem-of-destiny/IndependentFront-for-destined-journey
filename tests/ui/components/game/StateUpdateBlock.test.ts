/**
 * StateUpdateBlock — 每楼变量更新块界面（状态树协议 T13，设计 §12）
 *
 * 默认收起；标题计数与角标；从属行；最新一楼的改值 → 预览 → 确认、冲突 → 仍然覆盖；
 * 锁定时不给动作；更早楼层只读、给跳转；查看原文只在调试记录里有时出现；全程文本插值。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import type { ChatMessage, StateUpdateRecord } from '@engine/types/types';
import StateUpdateBlock from '../../../../src/ui/components/game/StateUpdateBlock.vue';

const toast = vi.fn();

const LATEST: StateUpdateRecord = {
  deltaMinutes: 90,
  ops: [
    {
      path: '/主角/生命值/当前',
      op: 'delta',
      value: -30,
      status: '已应用',
      before: 300,
      after: 270,
    },
    {
      path: '/主角/法力值/当前',
      op: 'replace',
      value: 999,
      status: '已纠正',
      note: '超过上限，已钳到 777',
      before: 20,
      after: 777,
    },
    {
      path: '/主角/<b>坏</b>',
      op: 'replace',
      value: '<img src=x>',
      status: '已丢弃',
      note: '路径不存在',
    },
    {
      path: '/主角/装备/长剑',
      from: '/主角/背包/长剑',
      op: 'move',
      status: '已应用',
      mergedFrom: [4],
      after: {},
    },
    { path: '/主角/背包/长剑', op: 'remove', status: '已应用', foldedInto: 3, foldKind: 'fold' },
    {
      path: '/世界/时间',
      op: 'replace',
      value: '20:35',
      status: '已应用',
      before: '19:05',
      after: '20:35',
    },
  ],
};

function msg(id: string, record: StateUpdateRecord): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '正文',
    timestamp: 0,
    storyTurnStatus: 'accepted',
    stateUpdates: record,
  };
}

function makeGame() {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: '走', timestamp: 0 },
    msg('a1', {
      deltaMinutes: 0,
      ops: [{ path: '/主角/金钱', op: 'delta', value: 5, status: '已应用' }],
    }),
    { id: 'u2', role: 'user', content: '再走', timestamp: 0 },
    msg('a2', LATEST),
  ];
  return reactive({
    messages,
    isGenerating: false,
    isRewriting: false,
    isInCombat: false,
    agentLogHistory: [] as unknown[],
    planStateUpdateRevision: vi.fn(async (): Promise<unknown> => ({
      kind: 'ok',
      ops: [{ op: 'delta', path: '/主角/生命值/当前', value: 20 }],
      preview: {
        ok: true,
        reasons: [],
        records: [
          {
            path: '/主角/生命值/当前',
            op: 'delta',
            value: 20,
            status: '已应用',
            before: 270,
            after: 290,
          },
        ],
        dropped: [],
        normalized: [],
        translation: null,
      },
    })),
    commitStateUpdateRevision: vi.fn(async () => ({
      ok: true,
      records: [],
      normalized: [],
      undo: [],
    })),
    openStateEditorAt: vi.fn(),
  });
}

let game: ReturnType<typeof makeGame>;

vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ({ toast }) }));

function mountBlock(id = 'a2') {
  const message = game.messages.find((m) => m.id === id)!;
  return mount(StateUpdateBlock, { props: { message } });
}

beforeEach(() => {
  game = makeGame();
  toast.mockReset();
});

describe('StateUpdateBlock', () => {
  it('原生 details 默认收起；标题「本楼状态更新 N 项」不计从属行，带纠正 / 丢弃角标', () => {
    const wrapper = mountBlock();
    const details = wrapper.get('details');
    expect(details.attributes('open')).toBeUndefined();
    expect(wrapper.get('.su-title').text()).toBe('本楼状态更新 5 项');
    expect(wrapper.findAll('[data-testid="state-update-badge"]').map((b) => b.text())).toEqual([
      '纠正 1',
      '丢弃 1',
    ]);
    expect(wrapper.get('.su-time').text()).toContain('1 小时 30 分钟');
  });

  it('行：路径、动作、前值 → 后值、状态说明；丢弃行弱化；从属行注明并入', () => {
    const wrapper = mountBlock();
    const rows = wrapper.findAll('[data-testid="state-update-row"]');
    expect(rows).toHaveLength(6);
    expect(rows[0].text()).toContain('/主角/生命值/当前');
    expect(rows[0].get('.su-before').text()).toBe('300');
    expect(rows[0].get('.su-after').text()).toBe('270');
    expect(rows[1].text()).toContain('超过上限，已钳到 777');
    expect(rows[2].classes()).toContain('tone-dropped');
    expect(rows[2].text()).toContain('路径不存在');
    expect(rows[4].classes()).toContain('is-folded');
    expect(rows[4].text()).toContain('已并入第 4 条');
    expect(rows[4].findAll('.su-action')).toHaveLength(0);
    // 时间行置灰给原因
    expect(rows[5].classes()).toContain('is-blocked');
    expect(rows[5].text()).toContain('时间');
  });

  it('全程文本插值：模型写的尖括号原样显示，不生成元素', () => {
    const wrapper = mountBlock();
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.su-path b').exists()).toBe(false);
    expect(wrapper.text()).toContain('/主角/<b>坏</b>');
    expect(wrapper.text()).toContain('<img src=x>');
  });

  it('最新一楼：改值 → 预览 → 确认，提交走 store 并带回本行下标与修订', async () => {
    const wrapper = mountBlock();
    const row = wrapper.findAll('[data-testid="state-update-row"]')[0];
    const editBtn = row.findAll('.su-action').find((b) => b.text() === '改值')!;
    await editBtn.trigger('click');
    const input = wrapper.get('[data-testid="state-update-input"]');
    expect((input.element as HTMLInputElement).value).toBe('-30');
    await input.setValue('-10');
    await wrapper.get('[data-testid="state-update-plan"]').trigger('click');
    await flushPromises();
    expect(game.planStateUpdateRevision).toHaveBeenCalledWith(
      'a2',
      0,
      { kind: 'edit', value: -10 },
      { force: false },
    );
    const preview = wrapper.get('[data-testid="state-update-preview"]');
    expect(preview.text()).toContain('270');
    expect(preview.text()).toContain('290');

    await wrapper.get('[data-testid="state-update-confirm"]').trigger('click');
    await flushPromises();
    expect(game.commitStateUpdateRevision).toHaveBeenCalledWith(
      'a2',
      0,
      { kind: 'edit', value: -10 },
      [{ op: 'delta', path: '/主角/生命值/当前', value: 20 }],
      expect.stringContaining('更新块'),
    );
    expect(toast).toHaveBeenCalledWith('已修订本楼状态', 'success');
    expect(wrapper.find('[data-testid="state-update-editor"]').exists()).toBe(false);
  });

  it('输入不合法时不试算', async () => {
    const wrapper = mountBlock();
    const row = wrapper.findAll('[data-testid="state-update-row"]')[0];
    await row
      .findAll('.su-action')
      .find((b) => b.text() === '改值')!
      .trigger('click');
    await wrapper.get('[data-testid="state-update-input"]').setValue('很多');
    await wrapper.get('[data-testid="state-update-plan"]').trigger('click');
    await flushPromises();
    expect(game.planStateUpdateRevision).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('请输入数字');
  });

  it('冲突：提示现值与记录不符，「仍然覆盖」以 force 重新试算', async () => {
    game.planStateUpdateRevision.mockResolvedValueOnce({
      kind: 'conflict',
      path: '/主角/生命值/当前',
      expected: 270,
      current: 150,
    });
    const wrapper = mountBlock();
    const row = wrapper.findAll('[data-testid="state-update-row"]')[0];
    await row
      .findAll('.su-action')
      .find((b) => b.text() === '撤销')!
      .trigger('click');
    await flushPromises();
    const conflict = wrapper.get('[data-testid="state-update-conflict"]');
    expect(conflict.text()).toContain('记录 270');
    expect(conflict.text()).toContain('现值 150');
    await wrapper.get('[data-testid="state-update-force"]').trigger('click');
    await flushPromises();
    expect(game.planStateUpdateRevision).toHaveBeenLastCalledWith(
      'a2',
      0,
      { kind: 'revert' },
      { force: true },
    );
    expect(wrapper.find('[data-testid="state-update-preview"]').exists()).toBe(true);
  });

  it('丢弃行给「改好后重新应用」，新增一条在末尾', async () => {
    const wrapper = mountBlock();
    const rows = wrapper.findAll('[data-testid="state-update-row"]');
    expect(rows[2].findAll('.su-action').map((b) => b.text())).toEqual(['改好后重新应用']);
    await wrapper.get('[data-testid="state-update-append"]').trigger('click');
    await wrapper.get('[data-testid="state-update-append-path"]').setValue('/主角/金钱');
    await wrapper.get('[data-testid="state-update-input"]').setValue('50');
    await wrapper.get('[data-testid="state-update-plan"]').trigger('click');
    await flushPromises();
    expect(game.planStateUpdateRevision).toHaveBeenCalledWith(
      'a2',
      null,
      { kind: 'append', op: { op: 'replace', path: '/主角/金钱', value: 50 } },
      { force: false },
    );
  });

  it('锁定（生成中）：说明原因，没有任何修订动作', () => {
    game.isGenerating = true;
    const wrapper = mountBlock();
    expect(wrapper.text()).toContain('当前回合生成中');
    expect(wrapper.findAll('.su-action')).toHaveLength(0);
    expect(wrapper.find('[data-testid="state-update-append"]').exists()).toBe(false);
  });

  it('更早楼层只读：每行给「在变量修改器中打开此路径」', async () => {
    const wrapper = mountBlock('a1');
    expect(wrapper.text()).toContain('更早楼层只读');
    expect(wrapper.find('[data-testid="state-update-append"]').exists()).toBe(false);
    const jump = wrapper.get('[data-testid="state-update-open-editor"]');
    await jump.trigger('click');
    expect(game.openStateEditorAt).toHaveBeenCalledWith('/主角/金钱');
  });

  it('查看原文：调试记录里没有就不显示；有就按需展开', async () => {
    expect(mountBlock().find('[data-testid="state-update-raw-toggle"]').exists()).toBe(false);
    game.agentLogHistory = [
      {
        id: 't',
        saveId: 's',
        turn: 2,
        sourceMessageId: 'u2',
        status: 'completed',
        startedAt: 0,
        entries: [{ agentId: 'direct_main', rawResponse: '<direct_updates>[]</direct_updates>' }],
      },
    ];
    const wrapper = mountBlock();
    await wrapper.get('[data-testid="state-update-raw-toggle"]').trigger('click');
    expect(wrapper.get('[data-testid="state-update-raw"]').text()).toBe(
      '<direct_updates>[]</direct_updates>',
    );
  });
});
