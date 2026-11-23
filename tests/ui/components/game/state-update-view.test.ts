/**
 * state-update-view — 每楼变量更新块的展示层判定（状态树协议 T13，设计 §12）
 *
 * 分组 / 计数、从属行、可改判定（最新楼、锁定、blocked）、编辑输入解析、查看原文、跳转路径。
 */
import { describe, expect, it } from 'vitest';
import type {
  ChatMessage,
  DebugAgentEntry,
  DebugTurnRecord,
  StateUpdateRecord,
} from '@engine/types/types';
import { buildStateTree } from '../../../../src/core/variables/state-tree-projection';
import { makeInput } from '../../../core/variables/state-tree-fixture';
import { buildEditorTree } from '../../../../src/ui/components/game/state-editor-view';
import {
  buildUpdateBlockView,
  editorJumpPath,
  findRawResponse,
  latestUpdateFloorId,
  parseAppendInput,
  parseLooseValue,
  parseRevisionInput,
  resolveEditorFocus,
  revisionInputText,
  shouldShowUpdateBlock,
  updateBlockBadges,
  updateBlockEditability,
} from '../../../../src/ui/components/game/state-update-view';

const RECORD: StateUpdateRecord = {
  deltaMinutes: 30,
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
      value: 9999,
      status: '已纠正',
      note: '超过上限，已钳到 777',
      before: 20,
      after: 777,
    },
    { path: '/主角/不存在', op: 'replace', value: 1, status: '已丢弃', note: '路径不存在' },
    // 0/3 折叠：背包删一边、装备加一边 → 一条 move（第 4 条代表落地，第 5 条从属）
    {
      path: '/主角/装备/长剑',
      from: '/主角/背包/长剑',
      op: 'move',
      status: '已应用',
      mergedFrom: [4],
      before: undefined,
      after: { 位置: '武器' },
    },
    {
      path: '/主角/背包/长剑',
      op: 'remove',
      status: '已应用',
      foldedInto: 3,
      foldKind: 'fold',
    },
    {
      path: '/世界/时间',
      op: 'replace',
      value: '19:35',
      status: '已应用',
      before: '19:05',
      after: '19:35',
    },
    {
      path: '/主角/成长/累计经验值',
      op: 'delta',
      value: 50,
      status: '已应用',
      before: 900,
      after: 950,
    },
    {
      path: '/主角/生命值/当前',
      op: 'replace',
      value: 100,
      status: '已手动修订',
      note: '玩家已修订',
      before: 300,
      after: 100,
    },
  ],
};

function msg(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: '正文', timestamp: 0, ...extra };
}

describe('buildUpdateBlockView — 分组与计数', () => {
  const view = buildUpdateBlockView(RECORD, true);

  it('N 不计从属行；纠正 / 丢弃 / 手改分别计数', () => {
    expect(view.count).toBe(7);
    expect(view.corrected).toBe(1);
    expect(view.dropped).toBe(1);
    expect(view.revised).toBe(1);
    expect(view.deltaMinutes).toBe(30);
    expect(updateBlockBadges(view).map((b) => b.text)).toEqual(['纠正 1', '丢弃 1', '手改 1']);
  });

  it('全是已应用时没有角标', () => {
    const plain = buildUpdateBlockView({ deltaMinutes: 0, ops: [RECORD.ops[0]] }, true);
    expect(updateBlockBadges(plain)).toEqual([]);
  });

  it('行不删不重排：下标与 ops 一一对应', () => {
    expect(view.rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(view.rows[1].path).toBe('/主角/法力值/当前');
  });

  it('前值 → 后值、写入值、状态标记与说明', () => {
    expect(view.rows[0].change).toEqual({ before: '300', after: '270' });
    expect(view.rows[0].valueText).toBe('-30');
    expect(view.rows[0].badge).toBeNull();
    expect(view.rows[1].badge).toBe('已纠正');
    expect(view.rows[1].note).toBe('超过上限，已钳到 777');
    expect(view.rows[2].tone).toBe('dropped');
    expect(view.rows[2].change).toBeNull();
    expect(view.rows[7].badge).toBe('已手动修订');
  });

  it('从属行注明「已并入第 N 条」（1 起），代表行列出吸收了谁', () => {
    expect(view.rows[4].foldedIntoNo).toBe(4);
    expect(view.rows[4].actions).toEqual({ edit: false, revert: false, reapply: false });
    expect(view.rows[3].mergedFromNos).toEqual([5]);
    expect(view.rows[3].from).toBe('/主角/背包/长剑');
  });
});

describe('buildUpdateBlockView — 每行能做什么', () => {
  const view = buildUpdateBlockView(RECORD, true);

  it('已生效的覆盖 / 增减：改值 + 撤销；move / remove 只能撤销', () => {
    expect(view.rows[0].actions).toEqual({ edit: true, revert: true, reapply: false });
    expect(view.rows[1].actions).toEqual({ edit: true, revert: true, reapply: false });
    expect(view.rows[3].actions).toEqual({ edit: false, revert: true, reapply: false });
    expect(view.rows[7].actions).toEqual({ edit: true, revert: true, reapply: false });
  });

  it('丢弃行只能改好后重新应用', () => {
    expect(view.rows[2].actions).toEqual({ edit: false, revert: false, reapply: true });
  });

  it('时间、累计经验值：置灰并给原因', () => {
    expect(view.rows[5].blockedReason).toContain('时间');
    expect(view.rows[5].actions.revert).toBe(false);
    expect(view.rows[6].blockedReason).toContain('累计经验值');
    expect(view.rows[6].actions.edit).toBe(false);
  });

  it('新建人物、登神长阶同样置灰', () => {
    const v = buildUpdateBlockView(
      {
        deltaMinutes: 0,
        ops: [
          { path: '/关系列表/莉亚', op: 'add', value: {}, status: '已应用', after: {} },
          {
            path: '/主角/登神长阶/要素',
            op: 'replace',
            value: [],
            status: '已应用',
            before: [],
            after: [],
          },
        ],
      },
      true,
    );
    expect(v.rows[0].blockedReason).toContain('新建人物');
    expect(v.rows[1].blockedReason).toContain('登神长阶');
  });

  it('不可改（更早楼层 / 锁定）时一律没有动作，也不逐行说 blocked', () => {
    const ro = buildUpdateBlockView(RECORD, false);
    for (const row of ro.rows) {
      expect(row.actions).toEqual({ edit: false, revert: false, reapply: false });
      expect(row.blockedReason).toBeNull();
    }
  });
});

describe('显示与最新一楼', () => {
  const withRec = { stateUpdates: RECORD, storyTurnStatus: 'accepted' as const };

  it('已接纳、带非空记录、演出放完才显示', () => {
    expect(shouldShowUpdateBlock(msg('a', withRec), true)).toBe(true);
    expect(shouldShowUpdateBlock(msg('a', withRec), false)).toBe(false);
    expect(shouldShowUpdateBlock(msg('a', { ...withRec, storyTurnStatus: 'pending' }), true)).toBe(
      false,
    );
    expect(shouldShowUpdateBlock(msg('a', { ...withRec, storyTurnStatus: 'failed' }), true)).toBe(
      false,
    );
    expect(shouldShowUpdateBlock(msg('a'), true)).toBe(false);
    expect(
      shouldShowUpdateBlock(msg('a', { stateUpdates: { ops: [], deltaMinutes: 0 } }), true),
    ).toBe(false);
    expect(shouldShowUpdateBlock({ ...msg('a', withRec), role: 'user' }, true)).toBe(false);
  });

  it('最新一楼 = 最后一条已接纳正文；它没有记录时没有可改楼层', () => {
    const list = [
      msg('a1', withRec),
      { id: 'u2', role: 'user', content: '', timestamp: 0 } as ChatMessage,
      msg('a2', withRec),
      msg('a3', { ...withRec, storyTurnStatus: 'failed' }),
      msg('d', { diagnostic: true }),
    ];
    expect(latestUpdateFloorId(list)).toBe('a2');
    expect(latestUpdateFloorId([...list, msg('a4', { storyTurnStatus: 'accepted' })])).toBeNull();
  });

  it('pending 的新正文不抢「最新一楼」', () => {
    const list = [msg('a1', withRec), msg('a2', { ...withRec, storyTurnStatus: 'pending' })];
    expect(latestUpdateFloorId(list)).toBe('a1');
  });

  it('可改判定：只有最新一楼；锁定时可见原因但不可改', () => {
    const list = [msg('a1', withRec), msg('a2', withRec)];
    expect(updateBlockEditability(list[0], list, '')).toEqual({
      latest: false,
      editable: false,
      lockReason: '',
    });
    expect(updateBlockEditability(list[1], list, '')).toEqual({
      latest: true,
      editable: true,
      lockReason: '',
    });
    expect(updateBlockEditability(list[1], list, '当前回合生成中，结束后才能修改变量')).toEqual({
      latest: true,
      editable: false,
      lockReason: '当前回合生成中，结束后才能修改变量',
    });
  });
});

describe('编辑输入解析', () => {
  it('按原值类型解析，与初始文字互逆', () => {
    expect(parseRevisionInput(-30, revisionInputText(-30))).toEqual({ ok: true, value: -30 });
    expect(parseRevisionInput(1, 'abc').ok).toBe(false);
    expect(parseRevisionInput(1, '').ok).toBe(false);
    expect(parseRevisionInput(true, '否')).toEqual({ ok: true, value: false });
    expect(parseRevisionInput(true, '也许').ok).toBe(false);
    expect(parseRevisionInput('旧', ' 新 ')).toEqual({ ok: true, value: ' 新 ' });
    expect(parseRevisionInput(['a'], '["b"]')).toEqual({ ok: true, value: ['b'] });
    expect(parseRevisionInput(['a'], '{"b":1}').ok).toBe(false);
    expect(parseRevisionInput({ a: 1 }, revisionInputText({ a: 2 }))).toEqual({
      ok: true,
      value: { a: 2 },
    });
  });

  it('宽松解析：数字、是否、JSON、文本', () => {
    expect(parseLooseValue('12')).toEqual({ ok: true, value: 12 });
    expect(parseLooseValue('是')).toEqual({ ok: true, value: true });
    expect(parseLooseValue('{"x":1}')).toEqual({ ok: true, value: { x: 1 } });
    expect(parseLooseValue('受伤')).toEqual({ ok: true, value: '受伤' });
    expect(parseLooseValue('  ').ok).toBe(false);
  });

  it('新增一条：路径以 / 开头，增减只收数字，删除不要值', () => {
    expect(parseAppendInput('delta', '/主角/生命值/当前', '20')).toEqual({
      ok: true,
      op: { op: 'delta', path: '/主角/生命值/当前', value: 20 },
    });
    expect(parseAppendInput('delta', '/主角/生命值/当前', '二十').ok).toBe(false);
    expect(parseAppendInput('replace', '主角/x', '1').ok).toBe(false);
    expect(parseAppendInput('remove', '/主角/背包/长剑', '')).toEqual({
      ok: true,
      op: { op: 'remove', path: '/主角/背包/长剑' },
    });
  });
});

describe('查看原文', () => {
  function entry(extra: Partial<DebugAgentEntry>): DebugAgentEntry {
    return {
      invocationId: 'i',
      turnId: 't',
      agentId: 'direct_main',
      label: '',
      endpointId: '',
      endpointName: '',
      baseUrl: '',
      model: '',
      messages: [],
      rawResponse: '',
      tokensUsed: 0,
      cacheHit: false,
      duration: 0,
      startedAt: 0,
      ...extra,
    };
  }
  function turn(extra: Partial<DebugTurnRecord>): DebugTurnRecord {
    return {
      id: 't',
      saveId: 's',
      turn: 1,
      status: 'completed',
      startedAt: 0,
      entries: [],
      ...extra,
    };
  }
  const list: ChatMessage[] = [{ id: 'u1', role: 'user', content: '走', timestamp: 0 }, msg('a1')];

  it('按本楼之前的玩家输入找最新一个完成的回合，取最后一次直出主生成原文', () => {
    const history = [
      turn({ id: 'old', sourceMessageId: 'u1', entries: [entry({ rawResponse: '旧的' })] }),
      turn({
        id: 'fail',
        sourceMessageId: 'u1',
        status: 'failed',
        entries: [entry({ rawResponse: '失败' })],
      }),
      turn({
        id: 'new',
        sourceMessageId: 'u1',
        entries: [
          entry({ rawResponse: '第一次', error: '空正文' }),
          entry({ rawResponse: '<maintext>原文</maintext>' }),
          entry({ agentId: 'memory_summary', rawResponse: '摘要' }),
        ],
      }),
    ];
    expect(findRawResponse(list[1], list, history)).toBe('<maintext>原文</maintext>');
  });

  it('调试记录里没有（已滚出最近若干回合）就返回 null', () => {
    expect(findRawResponse(list[1], list, [])).toBeNull();
    expect(
      findRawResponse(list[1], list, [
        turn({ sourceMessageId: 'u0', entries: [entry({ rawResponse: 'x' })] }),
      ]),
    ).toBeNull();
  });
});

describe('跳转到变量修改器', () => {
  const input = makeInput();
  const nodes = buildEditorTree(
    buildStateTree(
      { characters: input.characters, profile: input.profile, turn: 1 },
      { visibility: { mode: 'all' } },
    ),
  );

  it('叶子路径落到持有它的节点，并标出字段', () => {
    const focus = resolveEditorFocus(nodes, '/主角/生命值/当前');
    expect(focus?.nodePath).toBe('/主角/生命值');
    expect(focus?.fieldPath).toBe('/主角/生命值/当前');
    expect(focus?.expand).toEqual(['/主角', '/主角/生命值']);
  });

  it('已删掉的条目落到上级，祖先逐级展开', () => {
    const focus = resolveEditorFocus(nodes, '/主角/背包/早就没了的东西');
    expect(focus).not.toBeNull();
    expect('/主角/背包/早就没了的东西'.startsWith(focus!.nodePath)).toBe(true);
    expect(focus!.expand[0]).toBe('/主角');
    expect(focus!.fieldPath).toBeUndefined();
  });

  it('整棵树都没有的路径返回 null', () => {
    expect(resolveEditorFocus(nodes, '/不存在/的/根')).toBeNull();
  });

  it('move 跳到去处', () => {
    expect(editorJumpPath({ op: 'move', path: '/主角/装备/长剑' })).toBe('/主角/装备/长剑');
  });
});

describe('审查修复：叠加型 add 的可改判定（第 4 条）', () => {
  const view = buildUpdateBlockView(
    {
      deltaMinutes: 0,
      ops: [
        // 叠到已有背包物品上：按数量差额补，可改值
        {
          path: '/主角/背包/治疗药水',
          op: 'add',
          value: { 数量: 2 },
          status: '已应用',
          before: { 数量: 3 },
          after: { 数量: 5 },
        },
        // 叠到已有状态上：算不出安全差额，只能撤销
        {
          path: '/主角/状态效果/流血',
          op: 'add',
          value: { 层数: 1 },
          status: '已应用',
          before: { 层数: 2 },
          after: { 层数: 3 },
        },
      ],
    },
    true,
  );

  it('背包叠加 add 可改值', () => {
    expect(view.rows[0].actions).toEqual({ edit: true, revert: true, reapply: false });
  });

  it('状态叠加 add 不开放改值，撤销照常', () => {
    expect(view.rows[1].actions).toEqual({ edit: false, revert: true, reapply: false });
    expect(view.rows[1].blockedReason).toBeNull();
  });
});

describe('审查修复：新闻行的可改判定（b）', () => {
  const view = buildUpdateBlockView(
    {
      deltaMinutes: 0,
      ops: [
        {
          path: '/新闻/王都/号外',
          op: 'add',
          value: '国王出巡',
          status: '已应用',
          after: '国王出巡',
        },
        { path: '/新闻/王都/空', op: 'add', value: '', status: '已丢弃', note: '新闻正文不能为空' },
      ],
    },
    true,
  );

  it('已应用的新闻行不能撤销也不能改值，并给出原因', () => {
    expect(view.rows[0].actions).toEqual({ edit: false, revert: false, reapply: false });
    expect(view.rows[0].blockedReason).toBe('新闻只增不删，无法在此撤销');
  });

  it('被丢弃的新闻行仍可重新应用', () => {
    expect(view.rows[1].actions).toEqual({ edit: false, revert: false, reapply: true });
  });
});
