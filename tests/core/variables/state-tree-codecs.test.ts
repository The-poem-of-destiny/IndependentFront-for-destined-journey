/**
 * state-tree-codecs.ts — 状态树叶子值纠正（状态树协议 §5.2）。每行规则各有正例与反例。
 */
import { describe, expect, it } from 'vitest';
import {
  clampNumber,
  clampQuantityDecrease,
  coerceAffection,
  coerceAttribute,
  coerceBoolean,
  coerceCapBonus,
  coerceCapTotal,
  coerceDamageType,
  coerceEffectDict,
  coerceEnum,
  coerceFatePointsDelta,
  coerceItemType,
  coerceMoneyResult,
  coerceNumber,
  coerceNumberDict,
  coerceQuantity,
  coerceQuestPriority,
  coerceQuestStatus,
  coerceRarity,
  coerceResourceCurrent,
  coerceSkillType,
  coerceSlot,
  coerceStacks,
  coerceStatusCategory,
  coerceText,
  coerceTextArray,
  coerceTimeAdvance,
  formatDuration,
  formatSkillCost,
  parseDuration,
  parseSkillCost,
  pickKnownKeys,
  type CodecResult,
} from '../../../src/core/variables/state-tree-codecs';
import type { GameTime } from '../../../src/core/time/time-system';

/** 断言成功并取值。 */
function ok<T>(r: CodecResult<T>): { value: T; corrected: boolean; note?: string } {
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.reason}`);
  return r;
}

function failed<T>(r: CodecResult<T>): string {
  if (r.ok) throw new Error(`期望失败，实际成功：${JSON.stringify(r.value)}`);
  return r.reason;
}

describe('数值', () => {
  it('正例：数字原样；数字字符串转数字；「80/120」取首个数；整数四舍五入', () => {
    expect(ok(coerceNumber(42))).toEqual({ ok: true, value: 42, corrected: false });
    const s = ok(coerceNumber(' 15 '));
    expect(s.value).toBe(15);
    expect(s.corrected).toBe(true);
    expect(ok(coerceNumber('80/120')).value).toBe(80);
    const r = ok(coerceNumber(2.6, { integer: true }));
    expect(r.value).toBe(3);
    expect(r.note).toContain('四舍五入');
    expect(ok(coerceNumber('-5')).value).toBe(-5);
  });

  it('反例：NaN、Infinity、对象、布尔、无数字文本失败', () => {
    failed(coerceNumber(Number.NaN));
    failed(coerceNumber(Number.POSITIVE_INFINITY));
    failed(coerceNumber({ v: 1 }));
    failed(coerceNumber(true));
    failed(coerceNumber('很多'));
    failed(coerceNumber(null));
  });

  it('clampNumber 越界时记录，界内不记', () => {
    expect(ok(clampNumber(5, 0, 10))).toMatchObject({ value: 5, corrected: false });
    expect(ok(clampNumber(12, 0, 10))).toMatchObject({ value: 10, corrected: true });
    expect(ok(clampNumber(-1, 0, 10))).toMatchObject({ value: 0, corrected: true });
  });
});

describe('资源当前值', () => {
  it('正例：界内原样', () => {
    expect(ok(coerceResourceCurrent(80, 120))).toMatchObject({ value: 80, corrected: false });
  });
  it('反例：超上限钳到上限、负数钳到 0，并记录', () => {
    const hi = ok(coerceResourceCurrent(200, 120));
    expect(hi.value).toBe(120);
    expect(hi.note).toContain('超过上限');
    expect(ok(coerceResourceCurrent(-3, 120)).value).toBe(0);
    failed(coerceResourceCurrent('满血', 120));
  });
});

describe('上限的额外', () => {
  it('正例：整数，可为负', () => {
    expect(ok(coerceCapBonus(30, 100))).toMatchObject({ value: 30, corrected: false });
    expect(ok(coerceCapBonus(-20, 100))).toMatchObject({ value: -20, corrected: false });
  });
  it('反例：使基础 + 额外 < 1 时钳到 1 − 基础；非数失败', () => {
    const r = ok(coerceCapBonus(-150, 100));
    expect(r.value).toBe(-99);
    expect(r.corrected).toBe(true);
    failed(coerceCapBonus({}, 100));
  });
});

describe('上限写成单个数', () => {
  it('正例：换算成额外 = 该数 − 基础并记录', () => {
    const r = ok(coerceCapTotal(150, 120));
    expect(r.value).toBe(30);
    expect(r.corrected).toBe(true);
    expect(r.note).toContain('换算为额外');
  });
  it('反例：总数小于 1 时额外钳到 1 − 基础；非数失败', () => {
    expect(ok(coerceCapTotal(0, 120)).value).toBe(-119);
    failed(coerceCapTotal('很高', 120));
  });
});

describe('金钱', () => {
  it('正例：非负结果原样', () => {
    expect(ok(coerceMoneyResult(30))).toMatchObject({ value: 30, corrected: false });
  });
  it('反例：负结果钳到 0（不允许负债）', () => {
    const r = ok(coerceMoneyResult(-20));
    expect(r.value).toBe(0);
    expect(r.note).toContain('金钱');
    failed(coerceMoneyResult(Number.NaN));
  });
});

describe('命运点数', () => {
  it('正例：replace 换算成账本增量；delta 原样', () => {
    expect(ok(coerceFatePointsDelta(100, 'replace', 130)).value).toBe(30);
    expect(ok(coerceFatePointsDelta(100, 'delta', -40))).toMatchObject({
      value: -40,
      corrected: false,
    });
  });
  it('反例：结果为负时钳到 0（增量 = −现值）', () => {
    const r = ok(coerceFatePointsDelta(100, 'delta', -150));
    expect(r.value).toBe(-100);
    expect(r.corrected).toBe(true);
    expect(ok(coerceFatePointsDelta(10, 'replace', -5)).value).toBe(-10);
    failed(coerceFatePointsDelta(10, 'delta', 'x'));
  });
});

describe('好感度', () => {
  it('正例：界内整数', () => {
    expect(ok(coerceAffection(-30))).toMatchObject({ value: -30, corrected: false });
  });
  it('反例：钳到 [-100, 100]', () => {
    expect(ok(coerceAffection(150)).value).toBe(100);
    expect(ok(coerceAffection(-101)).value).toBe(-100);
    failed(coerceAffection('喜欢'));
  });
});

describe('数量', () => {
  it('正例：正整数', () => {
    expect(ok(coerceQuantity(3)).value).toEqual({ count: 3, remove: false });
    expect(ok(coerceQuantity('2')).value).toEqual({ count: 2, remove: false });
  });
  it('反例：≤0 视为移除；扣减超过持有量钳到持有量', () => {
    const r = ok(coerceQuantity(0));
    expect(r.value).toEqual({ count: 0, remove: true });
    expect(r.note).toContain('移除');
    expect(ok(clampQuantityDecrease(2, 1))).toMatchObject({ value: 1, corrected: false });
    const c = ok(clampQuantityDecrease(2, 5));
    expect(c.value).toBe(2);
    expect(c.corrected).toBe(true);
    failed(coerceQuantity('若干'));
  });
});

describe('层数', () => {
  it('正例：界内整数', () => {
    expect(ok(coerceStacks(2, 5)).value).toEqual({ count: 2, remove: false });
    expect(ok(coerceStacks(9)).value).toEqual({ count: 9, remove: false });
  });
  it('反例：≤0 视为移除状态；超过层数上限封顶', () => {
    expect(ok(coerceStacks(-1)).value).toEqual({ count: 0, remove: true });
    const r = ok(coerceStacks(8, 5));
    expect(r.value).toEqual({ count: 5, remove: false });
    expect(r.note).toContain('封顶');
    failed(coerceStacks([]));
  });
});

describe('枚举', () => {
  it('正例：品质 / 物品类型走 field-enums 词表与别名', () => {
    expect(ok(coerceRarity('史诗'))).toMatchObject({ value: '史诗', corrected: false });
    expect(ok(coerceRarity('legendary'))).toMatchObject({ value: '传说', corrected: true });
    expect(ok(coerceItemType('consumable')).value).toBe('消耗品');
  });
  it('反例：品质 / 物品类型认不出则省略，不模糊匹配', () => {
    expect(ok(coerceRarity('超稀有'))).toMatchObject({ value: undefined, corrected: true });
    expect(ok(coerceRarity('史')).value).toBeUndefined();
    expect(ok(coerceItemType('武器装备')).value).toBeUndefined();
    expect(ok(coerceRarity(3)).value).toBeUndefined();
  });
  it('状态分类兜底「特殊」、任务状态兜底「进行中」、关注度兜底「中」、技能类型兜底「主动」', () => {
    expect(ok(coerceStatusCategory('减益'))).toMatchObject({ value: '减益', corrected: false });
    expect(ok(coerceStatusCategory('诅咒'))).toMatchObject({ value: '特殊', corrected: true });
    expect(ok(coerceQuestStatus('完成'))).toMatchObject({ value: '已完成', corrected: true });
    expect(ok(coerceQuestStatus('???'))).toMatchObject({ value: '进行中', corrected: true });
    expect(ok(coerceQuestPriority('高'))).toMatchObject({ value: '高', corrected: false });
    expect(ok(coerceQuestPriority('紧急'))).toMatchObject({ value: '中', corrected: true });
    expect(ok(coerceSkillType('被动'))).toMatchObject({ value: 'passive', corrected: false });
    expect(ok(coerceSkillType('passive'))).toMatchObject({ value: 'passive', corrected: true });
    expect(ok(coerceSkillType('光环'))).toMatchObject({ value: 'active', corrected: true });
  });
  it('关联属性 / 伤害类型：精确词才认，认不出省略', () => {
    expect(ok(coerceAttribute('智力')).value).toBe('int');
    expect(ok(coerceAttribute('智')).value).toBeUndefined();
    expect(ok(coerceDamageType('能量')).value).toBe('能量');
    expect(ok(coerceDamageType('火焰')).value).toBeUndefined();
  });
  it('coerceEnum 按种类分派', () => {
    expect(ok(coerceEnum('rarity', 'rare')).value).toBe('稀有');
    expect(ok(coerceEnum('questPriority', '低')).value).toBe('低');
  });
});

describe('位置（装备槽）', () => {
  it('正例：内核槽位与 field-enums 别名', () => {
    expect(ok(coerceSlot('武器')).value).toEqual({ kind: 'equip', slot: '武器' });
    expect(ok(coerceSlot('头盔'))).toMatchObject({
      value: { kind: 'equip', slot: '头部' },
      corrected: true,
    });
  });
  it('空串、null、「无」、「背包」视为卸下', () => {
    for (const v of ['', null, '无', '背包', undefined]) {
      expect(ok(coerceSlot(v)).value).toEqual({ kind: 'unequip' });
    }
  });
  it('反例：认不出的槽位失败（原卡「手持」不加别名，不猜）', () => {
    expect(failed(coerceSlot('手持'))).toContain('不是可选槽位');
    failed(coerceSlot(3));
  });
});

describe('文本', () => {
  it('正例：去首尾空白；数字和布尔转字符串', () => {
    expect(ok(coerceText('  你好 '))).toMatchObject({ value: '你好', corrected: false });
    expect(ok(coerceText(12))).toMatchObject({ value: '12', corrected: true });
    expect(ok(coerceText(false)).value).toBe('false');
  });
  it('反例：对象、数组、null 失败', () => {
    failed(coerceText({ a: 1 }));
    failed(coerceText(['a']));
    failed(coerceText(null));
  });
});

describe('文本数组', () => {
  it('正例：数组原样；字符串按顿号、逗号、斜杠拆开', () => {
    expect(ok(coerceTextArray(['冒险者', '商人']))).toMatchObject({
      value: ['冒险者', '商人'],
      corrected: false,
    });
    expect(ok(coerceTextArray('冒险者、商人,佣兵/学徒，旅人')).value).toEqual([
      '冒险者',
      '商人',
      '佣兵',
      '学徒',
      '旅人',
    ]);
  });
  it('反例：非字符串元素剔除并记录（不丢整条）', () => {
    const r = ok(coerceTextArray(['冒险者', 3, null, { a: 1 }, ' ']));
    expect(r.value).toEqual(['冒险者']);
    expect(r.note).toContain('剔除 3 个');
    expect(ok(coerceTextArray({ a: 1 })).value).toEqual([]);
  });
});

describe('词条字典', () => {
  it('正例：对象原样', () => {
    expect(ok(coerceEffectDict({ 灼烧: '每回合受火焰伤害' }))).toMatchObject({
      value: { 灼烧: '每回合受火焰伤害' },
      corrected: false,
    });
  });
  it('字符串转 {效果: 文本}；数组合并成一条', () => {
    expect(ok(coerceEffectDict('攻击附带火焰')).value).toEqual({ 效果: '攻击附带火焰' });
    expect(ok(coerceEffectDict(['增加敏捷', '夜视'])).value).toEqual({ 效果: '增加敏捷；夜视' });
  });
  it('反例：非文本的词条值剔除并记录', () => {
    const r = ok(coerceEffectDict({ 甲: '好', 乙: { x: 1 }, 丙: 5 }));
    expect(r.value).toEqual({ 甲: '好', 丙: '5' });
    expect(r.note).toContain('乙');
  });
  it('数值字典逐项纠正、认不出剔除', () => {
    expect(ok(coerceNumberDict({ 攻击力: '15', 防御: '高' })).value).toEqual({ 攻击力: 15 });
    failed(coerceNumberDict('攻击 15'));
  });
});

describe('布尔', () => {
  it('正例：是 / 否 / 在场 / 离场 / true / false / 1 / 0', () => {
    expect(ok(coerceBoolean(true))).toMatchObject({ value: true, corrected: false });
    for (const v of ['是', '在场', 'true', 'TRUE', '1', 1])
      expect(ok(coerceBoolean(v)).value).toBe(true);
    for (const v of ['否', '离场', 'false', '0', 0]) expect(ok(coerceBoolean(v)).value).toBe(false);
  });
  it('反例：其他一律失败', () => {
    failed(coerceBoolean('也许'));
    failed(coerceBoolean(2));
    failed(coerceBoolean(null));
  });
});

describe('剩余时间', () => {
  it('正例：数字 + 回合 / 分钟 / 小时', () => {
    expect(ok(parseDuration('3回合'))).toMatchObject({
      value: { kind: 'timed', remainingTime: 3, timeUnit: '回合' },
      corrected: false,
    });
    expect(ok(parseDuration('30 分钟')).value).toEqual({
      kind: 'timed',
      remainingTime: 30,
      timeUnit: '分钟',
    });
    expect(ok(parseDuration('2小时')).value).toEqual({
      kind: 'timed',
      remainingTime: 2,
      timeUnit: '小时',
    });
  });
  it('天和周折成小时；小数小时换算成分钟', () => {
    const d = ok(parseDuration('2天'));
    expect(d.value).toEqual({ kind: 'timed', remainingTime: 48, timeUnit: '小时' });
    expect(d.corrected).toBe(true);
    expect(ok(parseDuration('1周')).value).toEqual({
      kind: 'timed',
      remainingTime: 168,
      timeUnit: '小时',
    });
    expect(ok(parseDuration('1.5小时')).value).toEqual({
      kind: 'timed',
      remainingTime: 90,
      timeUnit: '分钟',
    });
  });
  it('「永久 / 直至解除」视为永久', () => {
    expect(ok(parseDuration('永久')).value).toEqual({ kind: 'permanent' });
    expect(ok(parseDuration('直至解除')).value).toEqual({ kind: 'permanent' });
  });
  it('反例：其余文本原样进 durationText（不丢）；对象失败', () => {
    expect(ok(parseDuration('直到离开城镇'))).toMatchObject({
      value: { kind: 'text', durationText: '直到离开城镇' },
      corrected: false,
    });
    expect(ok(parseDuration('3个月')).value).toEqual({ kind: 'text', durationText: '3个月' });
    expect(ok(parseDuration(5)).value).toEqual({ kind: 'text', durationText: '5' });
    failed(parseDuration({ 回合: 3 }));
  });
  it('格式化：durationText 优先，null 为永久', () => {
    expect(formatDuration({ remainingTime: 3, timeUnit: '回合' })).toBe('3回合');
    expect(formatDuration({ remainingTime: null, timeUnit: '小时' })).toBe('永久');
    expect(
      formatDuration({ remainingTime: null, timeUnit: '小时', durationText: '月圆之夜前' }),
    ).toBe('月圆之夜前');
  });
  it('往返：可解析的格式化结果再解析得回原值', () => {
    const v = ok(parseDuration(formatDuration({ remainingTime: 48, timeUnit: '小时' }))).value;
    expect(v).toEqual({ kind: 'timed', remainingTime: 48, timeUnit: '小时' });
  });
});

describe('技能消耗', () => {
  it('正例：数字 + HP / MP / SP 或 生命 / 法力 / 体力（单位在前亦可）', () => {
    expect(ok(parseSkillCost('15MP')).value).toEqual({
      kind: 'cost',
      cost: { type: 'MP', amount: 15 },
    });
    expect(ok(parseSkillCost('20 体力')).value).toEqual({
      kind: 'cost',
      cost: { type: 'SP', amount: 20 },
    });
    expect(ok(parseSkillCost('生命值 5')).value).toEqual({
      kind: 'cost',
      cost: { type: 'HP', amount: 5 },
    });
    expect(ok(parseSkillCost('10 hp')).value).toEqual({
      kind: 'cost',
      cost: { type: 'HP', amount: 10 },
    });
    expect(ok(parseSkillCost('无')).value).toEqual({ kind: 'none' });
  });
  it('反例：其余文本原样进 costText（不丢）；坏对象失败', () => {
    expect(ok(parseSkillCost('25% 最大MP'))).toMatchObject({
      value: { kind: 'text', costText: '25% 最大MP' },
      corrected: false,
    });
    expect(ok(parseSkillCost('一滴血')).value).toEqual({ kind: 'text', costText: '一滴血' });
    expect(ok(parseSkillCost({ type: 'MP', amount: 8 })).value).toEqual({
      kind: 'cost',
      cost: { type: 'MP', amount: 8 },
    });
    failed(parseSkillCost({ type: '金币', amount: 8 }));
  });
  it('格式化：costText 优先', () => {
    expect(formatSkillCost({ cost: { type: 'MP', amount: 15 } })).toBe('15MP');
    expect(formatSkillCost({ costText: '25% 最大MP' })).toBe('25% 最大MP');
    expect(formatSkillCost({})).toBe('');
    expect(ok(parseSkillCost(formatSkillCost({ cost: { type: 'SP', amount: 3 } }))).value).toEqual({
      kind: 'cost',
      cost: { type: 'SP', amount: 3 },
    });
  });
});

describe('时间', () => {
  const now: GameTime = {
    era: '复兴纪元',
    year: 488,
    month: 5,
    day: 24,
    weekday: 1,
    hour: 15,
    minute: 30,
  };

  it('正例：delta 分钟；replace 时间串与当前求差', () => {
    expect(ok(coerceTimeAdvance('delta', 90, now))).toMatchObject({ value: 90, corrected: false });
    expect(ok(coerceTimeAdvance('replace', '复兴纪元0488年-05月-24日-周日-17:00', now)).value).toBe(
      90,
    );
  });
  it('反例：时间倒退、解析不了失败', () => {
    expect(failed(coerceTimeAdvance('delta', -10, now))).toContain('倒退');
    expect(
      failed(coerceTimeAdvance('replace', '复兴纪元0488年-05月-24日-周日-08:00', now)),
    ).toContain('倒退');
    expect(failed(coerceTimeAdvance('replace', '明天早上', now))).toContain('解析不了');
    failed(coerceTimeAdvance('replace', 90, now));
  });
});

describe('整实体', () => {
  const keys = ['品质', '类型', '数量', '描述', '_基础'];

  it('正例：只含已知键时原样', () => {
    expect(ok(pickKnownKeys({ 品质: '稀有', 数量: 2 }, keys))).toMatchObject({
      value: { 品质: '稀有', 数量: 2 },
      corrected: false,
    });
  });
  it('反例：未知键与只读键剥除并记录；非对象失败', () => {
    const r = ok(pickKnownKeys({ 品质: '稀有', 价格: 100, 基础: 5 }, keys));
    expect(r.value).toEqual({ 品质: '稀有' });
    expect(r.note).toContain('价格');
    expect(r.note).toContain('由代码维护');
    failed(pickKnownKeys('一把剑', keys));
    failed(pickKnownKeys([1], keys));
  });
});
