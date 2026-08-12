/**
 * player-input.test.ts — 玩家自由文本 → Command 解析器测试（T14）
 *
 * 覆盖：六类规则（逃跑/防御/跳过/道具/技能/普攻）+ 拒绝路径 + 名字匹配细节
 * （长名优先、友方目标）+ 意图层级复用（打晕 → 非致死）。
 */
import { describe, it, expect } from 'vitest';
import {
  parsePlayerInput,
  type PlayerCommand,
  type PlayerCommandResult,
  type PlayerParseCtx,
} from './player-input';

function ctx(over: Partial<PlayerParseCtx> = {}): PlayerParseCtx {
  return {
    actorId: '艾萨',
    units: [
      { id: '艾萨', name: '艾萨', side: 'player' },
      { id: '艾达', name: '艾达', side: 'player' },
      { id: '骷髅兵', name: '骷髅兵', side: 'enemy' },
      { id: '骷髅兵队长', name: '骷髅兵队长', side: 'enemy' },
    ],
    skills: ['火焰术', '治愈术'],
    items: ['治疗药水', '铁剑'],
    ...over,
  };
}

/** 断言解析成功且是 DeclareAttack，返回收窄后的 command（局部变量 narrowing 最可靠） */
function expectAttack(r: PlayerCommandResult): Extract<PlayerCommand, { kind: 'DeclareAttack' }> {
  if (!r.ok) throw new Error('应解析成功');
  const cmd = r.command;
  if (cmd.kind !== 'DeclareAttack') throw new Error('应解析成 DeclareAttack Command');
  return cmd;
}

describe('parsePlayerInput — 六类规则', () => {
  it('逃跑 → Flee（cost none，不占攻击/动作槽，Bug A 2026-08-12）', () => {
    const r = parsePlayerInput('我们赶紧逃跑！', ctx());
    expect(r).toEqual({
      ok: true,
      command: { actorId: '艾萨', cost: 'none', kind: 'Flee', payload: {} },
    });
  });

  it('防御 → DeclareAction(defend)（cost action）', () => {
    const r = parsePlayerInput('举盾防御', ctx());
    expect(r).toEqual({
      ok: true,
      command: {
        actorId: '艾萨',
        cost: 'action',
        kind: 'DeclareAction',
        payload: { actionType: 'defend' },
      },
    });
  });

  it('跳过 → PassAttack（消费攻击槽）', () => {
    const r = parsePlayerInput('这回合我按兵不动', ctx());
    expect(r).toEqual({
      ok: true,
      command: { actorId: '艾萨', cost: 'attack', kind: 'PassAttack', payload: {} },
    });
  });

  it('结束回合 → EndTurn（cost none，放弃全部剩余槽位，优先于跳过/休息类规则）', () => {
    const r = parsePlayerInput('结束回合', ctx());
    expect(r).toEqual({
      ok: true,
      command: { actorId: '艾萨', cost: 'none', kind: 'EndTurn', payload: {} },
    });
  });

  it('本回合结束 → EndTurn（同族关键词）', () => {
    const r = parsePlayerInput('本回合结束，我不再行动', ctx());
    expect(r).toEqual({
      ok: true,
      command: { actorId: '艾萨', cost: 'none', kind: 'EndTurn', payload: {} },
    });
  });

  it('结束行动 → EndTurn 而非 PassAttack（END_TURN_RE 先于 PASS_RE 匹配）', () => {
    const r = parsePlayerInput('结束行动', ctx());
    expect(r).toEqual({
      ok: true,
      command: { actorId: '艾萨', cost: 'none', kind: 'EndTurn', payload: {} },
    });
  });

  it('道具名命中 → DeclareAction(item, description=道具名)', () => {
    const r = parsePlayerInput('使用治疗药水', ctx());
    expect(r).toEqual({
      ok: true,
      command: {
        actorId: '艾萨',
        cost: 'action',
        kind: 'DeclareAction',
        payload: { actionType: 'item', description: '治疗药水' },
      },
    });
  });

  it('技能名命中 + 敌方目标 → DeclareAttack(skill, targetId)', () => {
    const cmd = expectAttack(parsePlayerInput('对骷髅兵施展火焰术', ctx()));
    expect(cmd.cost).toBe('attack');
    expect(cmd.payload.skill).toBe('火焰术');
    expect(cmd.payload.targetId).toBe('骷髅兵');
  });

  it('技能名命中 + 友方目标（治疗）→ DeclareAttack 指向友方单位', () => {
    const cmd = expectAttack(parsePlayerInput('对艾达施展治愈术', ctx()));
    expect(cmd.payload.targetId).toBe('艾达');
    expect(cmd.payload.skill).toBe('治愈术');
  });

  it('技能名命中但没目标 → 默认敌方存活首位（不拒绝，避免发不出）', () => {
    const cmd = expectAttack(parsePlayerInput('施展火焰术', ctx()));
    expect(cmd.payload.skill).toBe('火焰术');
    expect(cmd.payload.targetId).toBe('骷髅兵');
  });

  it('敌方单位名命中（无技能）→ DeclareAttack 普攻', () => {
    const cmd = expectAttack(parsePlayerInput('挥舞铁剑攻击骷髅兵', ctx()));
    expect(cmd.payload.skill).toBeUndefined();
    expect(cmd.payload.targetId).toBe('骷髅兵');
    expect(cmd.payload.intentionLevel).toBe('常规');
  });

  it('整句都识别不出 → 明确拒绝，绝不产出 Command', () => {
    const r = parsePlayerInput('随便做点什么都行', ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('空文本 / 无 actorId → 拒绝', () => {
    expect(parsePlayerInput('   ', ctx()).ok).toBe(false);
    expect(parsePlayerInput('攻击骷髅兵', ctx({ actorId: '' })).ok).toBe(false);
  });
});

describe('parsePlayerInput — 匹配细节', () => {
  it('长名优先：文本只含「骷髅兵」时命中「骷髅兵队长」所在列表的前缀单位', () => {
    // 「骷髅兵队长」也包含「骷髅兵」子串 —— 但 units 里两者都存在时，
    // 只匹配最靠前的；这里验证「骷髅兵队长」文本不会误配成「骷髅兵」。
    const cmd = expectAttack(parsePlayerInput('攻击骷髅兵队长', ctx()));
    expect(cmd.payload.targetId).toBe('骷髅兵队长');
  });

  it('意图关键词复用 parseIntentionFromInput：「打晕」→ 非致死', () => {
    const cmd = expectAttack(parsePlayerInput('打晕骷髅兵', ctx()));
    expect(cmd.payload.intentionLevel).toBe('非致死');
  });

  it('目标只认存活单位：不在 units 里的名字不命中 → 攻击动词兜底默认敌方首位', () => {
    // 「攻击一个不存在的名字」：名字不命中，但「攻击」是攻击意图 → 默认敌方存活首位
    const cmd = expectAttack(parsePlayerInput('攻击一个不存在的名字', ctx()));
    expect(cmd.payload.targetId).toBe('骷髅兵');
  });

  it('普攻目标只限敌方：提到友方名字不会打队友，攻击意图兜底默认敌方首位', () => {
    // 「攻击艾达」：艾达是 player side，不是合法攻击目标；
    // 攻击意图存在 → 默认敌方存活首位，而不是打队友
    const cmd = expectAttack(parsePlayerInput('攻击艾达', ctx()));
    expect(cmd.payload.targetId).toBe('骷髅兵');
  });
});

describe('parsePlayerInput — 默认目标（无点名时打敌方存活首位）', () => {
  it('「攻击」→ DeclareAttack 目标=敌方首位', () => {
    const cmd = expectAttack(parsePlayerInput('攻击', ctx()));
    expect(cmd.payload.skill).toBeUndefined();
    expect(cmd.payload.targetId).toBe('骷髅兵');
  });

  it('「挥剑砍它」→ DeclareAttack 目标=敌方首位（代词不点名也发得出）', () => {
    const cmd = expectAttack(parsePlayerInput('挥剑砍它', ctx()));
    expect(cmd.payload.skill).toBeUndefined();
    expect(cmd.payload.targetId).toBe('骷髅兵');
  });

  it('「用火球术」→ skill=火球术 目标=敌方首位', () => {
    const cmd = expectAttack(parsePlayerInput('用火球术', ctx({ skills: ['火球术'] })));
    expect(cmd.payload.skill).toBe('火球术');
    expect(cmd.payload.targetId).toBe('骷髅兵');
  });

  it('「对妲丽安施展治疗术」→ 有名字命中时不默认，目标=妲丽安（友方治疗）', () => {
    const cmd = expectAttack(
      parsePlayerInput(
        '对妲丽安施展治疗术',
        ctx({
          skills: ['治疗术'],
          units: [
            { id: '艾萨', name: '艾萨', side: 'player' },
            { id: '妲丽安', name: '妲丽安', side: 'player' },
            { id: '骷髅兵', name: '骷髅兵', side: 'enemy' },
          ],
        }),
      ),
    );
    expect(cmd.payload.skill).toBe('治疗术');
    expect(cmd.payload.targetId).toBe('妲丽安');
  });

  it('攻击意图但场上没有敌方存活单位 → 拒绝（不产出指向自己的攻击）', () => {
    const r = parsePlayerInput(
      '攻击',
      ctx({
        units: [
          { id: '艾萨', name: '艾萨', side: 'player' },
          { id: '艾达', name: '艾达', side: 'player' },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('没有可攻击的敌方单位');
  });

  it('完全无意义文本 → 仍拒绝「没看懂」（只有完全无法识别意图才拒绝）', () => {
    const r = parsePlayerInput('今天天气真好啊', ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('没看懂');
  });
});
