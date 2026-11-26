/**
 * 状态树翻译层（状态树协议 T6，设计 §5.2–5.3、§4.4、§11.3、§12.2）
 *
 * 纯函数用例：夹具快照 → op → StatePatch / 记录。往返到真实 StateManager 的闸门在
 * state-tree-roundtrip-gate.test.ts。
 */

import { describe, expect, it } from 'vitest';
import { readResourceCaps } from '../../../src/core/character/resource-caps';
import { advanceTime, formatGameTime } from '../../../src/core/time/time-system';
import type { CharacterState, StatePatch } from '../../../src/core/types/types';
import { parseTreePatchBlock } from '../../../src/core/variables/state-tree-patch';
import {
  translateTreeOps,
  type TreeTranslateActor,
  type TreeTranslateResult,
} from '../../../src/core/variables/state-tree-translator';
import { GAME_TIME, makeInput } from './state-tree-fixture';

type RawOp = { op: string; path: string; value?: unknown; from?: string };

function snapshot() {
  const input = makeInput();
  return { characters: input.characters, profile: input.profile };
}

function tr(
  ops: RawOp[],
  actor: TreeTranslateActor = 'ai',
  snap = snapshot(),
): TreeTranslateResult {
  const parsed = parseTreePatchBlock({ version: 2, patch: ops });
  if (parsed.kind !== 'patch') throw new Error(parsed.kind);
  return translateTreeOps(parsed.ops, snap, { actor, parseNormalized: parsed.normalized });
}

const ops = (r: TreeTranslateResult) => r.patches.map((p) => p.op);
const player = () => makeInput().characters[0];

describe('背包与装备（§5.3 整张表）', () => {
  it('add 背包：新物品 → add_item 不带槽位', () => {
    const r = tr([{ op: 'add', path: '/主角/背包/火把', value: { 类型: '消耗品', 数量: 2 } }]);
    expect(r.patches).toEqual([
      {
        op: 'add_item',
        target: 'characters.艾琳',
        value: { name: '火把', type: '消耗品', quantity: 2, equippedSlot: null },
      },
    ]);
    expect(r.records[0]).toMatchObject({ status: '已应用', path: '/主角/背包/火把' });
    expect(r.records[0].before).toBeUndefined();
    expect(r.records[0].after).toMatchObject({ 数量: 2, 类型: '消耗品' });
  });

  it('add 背包：已在背包 → 只叠数量，其余字段记说明', () => {
    const r = tr([{ op: 'add', path: '/主角/背包/治疗药水', value: { 数量: 2, 描述: '别的' } }]);
    expect(r.patches).toEqual([
      { op: 'add_item', target: 'characters.艾琳', value: { name: '治疗药水', quantity: 2 } },
    ]);
    expect(r.records[0].status).toBe('已纠正');
    expect(r.records[0].note).toContain('只叠数量');
    expect(r.records[0].before).toMatchObject({ 数量: 3 });
    expect(r.records[0].after).toMatchObject({ 数量: 5 });
  });

  it('add 背包：同名物品已穿戴 → 叠在装备上并说明', () => {
    const r = tr([{ op: 'add', path: '/主角/背包/长剑', value: {} }]);
    expect(ops(r)).toEqual(['add_item']);
    expect(r.records[0].note).toContain('同名物品已穿戴，数量叠在装备上');
  });

  it('数量：增 add_item、减 remove_item、到 0 全部移除、超扣钳到持有量', () => {
    expect(tr([{ op: 'replace', path: '/主角/背包/治疗药水/数量', value: 5 }]).patches).toEqual([
      { op: 'add_item', target: 'characters.艾琳', value: { name: '治疗药水', quantity: 2 } },
    ]);
    expect(tr([{ op: 'delta', path: '/主角/背包/治疗药水/数量', value: -1 }]).patches).toEqual([
      { op: 'remove_item', target: 'characters.艾琳', value: { name: '治疗药水', quantity: 1 } },
    ]);
    const zero = tr([{ op: 'replace', path: '/主角/背包/治疗药水/数量', value: 0 }]);
    expect(zero.patches[0].value).toEqual({ name: '治疗药水', quantity: 3 });
    expect(zero.records[0].note).toContain('视为移除');
    const over = tr([{ op: 'delta', path: '/主角/背包/治疗药水/数量', value: -9 }]);
    expect(over.patches[0].value).toEqual({ name: '治疗药水', quantity: 3 });
    expect(over.records[0].status).toBe('已纠正');
    expect(over.records[0].note).toContain('已钳到 3');
  });

  it('remove 背包 / remove 装备 → 物品离开人物（remove_item 全部），不是卸下', () => {
    expect(tr([{ op: 'remove', path: '/主角/背包/治疗药水' }]).patches).toEqual([
      { op: 'remove_item', target: 'characters.艾琳', value: { name: '治疗药水', quantity: 3 } },
    ]);
    const r = tr([{ op: 'remove', path: '/主角/装备/长剑' }]);
    expect(r.patches).toEqual([
      { op: 'remove_item', target: 'characters.艾琳', value: { name: '长剑', quantity: 1 } },
    ]);
    expect(r.records[0].before).toMatchObject({ 位置: '武器' });
    expect(r.records[0].after).toBeUndefined();
  });

  it('move 背包 → 装备：value 给位置 → equip_item', () => {
    const r = tr([{ op: 'move', from: '/主角/背包/绳子', path: '/主角/装备/绳子', value: '腰带' }]);
    expect(r.patches).toEqual([
      { op: 'equip_item', target: 'characters.艾琳', value: { name: '绳子', slot: '腰带' } },
    ]);
    expect(r.records[0]).toMatchObject({ from: '/主角/背包/绳子', path: '/主角/装备/绳子' });
    expect(r.records[0].before).toMatchObject({ 数量: 1 });
    expect(r.records[0].after).toMatchObject({ 位置: '腰带' });
  });

  it('穿戴槽位取值顺序：op 自带 → 同批后续写位置 → 丢「缺少位置」', () => {
    const later = tr([
      { op: 'move', from: '/主角/背包/绳子', path: '/主角/装备/绳子' },
      { op: 'replace', path: '/主角/装备/绳子/位置', value: '腰带' },
    ]);
    expect(later.patches).toEqual([
      { op: 'equip_item', target: 'characters.艾琳', value: { name: '绳子', slot: '腰带' } },
    ]);
    expect(later.records).toHaveLength(2);
    expect(later.records[1].status).toBe('已纠正');
    expect(later.records[1].note).toContain('并入第 1 条');
    expect(later.records[1]).toMatchObject({ foldedInto: 0, foldKind: 'slot' });
    expect(later.records[0].mergedFrom).toEqual([1]);
    expect(later.records[0].foldedInto).toBeUndefined();
    const none = tr([{ op: 'move', from: '/主角/背包/绳子', path: '/主角/装备/绳子' }]);
    expect(none.patches).toEqual([]);
    expect(none.dropped[0]).toContain('缺少位置');
    // 背包条目不记适配槽位：不会去猜
    expect(none.records[0].status).toBe('已丢弃');
  });

  it('槽位不加别名：原卡「手持」丢弃', () => {
    const r = tr([{ op: 'move', from: '/主角/背包/绳子', path: '/主角/装备/绳子', value: '手持' }]);
    expect(r.patches).toEqual([]);
    expect(r.dropped[0]).toContain('不是可选槽位');
  });

  it('move 装备 → 背包 → unequip_item', () => {
    expect(tr([{ op: 'move', from: '/主角/装备/长剑', path: '/主角/背包/长剑' }]).patches).toEqual([
      { op: 'unequip_item', target: 'characters.艾琳', value: { name: '长剑' } },
    ]);
  });

  it('add 装备：物品在背包 → equip_item，其余字段并入 update_item', () => {
    const r = tr([{ op: 'add', path: '/主角/装备/绳子', value: { 位置: '腰带', 描述: '结实' } }]);
    expect(r.patches).toEqual([
      {
        op: 'update_item',
        target: 'characters.艾琳',
        value: { name: '绳子', changes: { description: '结实' } },
      },
      { op: 'equip_item', target: 'characters.艾琳', value: { name: '绳子', slot: '腰带' } },
    ]);
  });

  it('add 装备：物品不存在 → add_item（不带槽位）+ equip_item 成一组', () => {
    const r = tr([{ op: 'add', path: '/主角/装备/木盾', value: { 位置: '副手' } }]);
    expect(r.patches).toEqual([
      {
        op: 'add_item',
        target: 'characters.艾琳',
        value: { name: '木盾', quantity: 1, equippedSlot: null },
      },
      { op: 'equip_item', target: 'characters.艾琳', value: { name: '木盾', slot: '副手' } },
    ]);
  });

  it('add 装备：已在装备、位置不同 → update_item + equip_item 换槽', () => {
    const r = tr([{ op: 'add', path: '/主角/装备/长剑', value: { 位置: '副手', 描述: '旧剑' } }]);
    expect(ops(r)).toEqual(['update_item', 'equip_item']);
    expect(r.patches[1].value).toEqual({ name: '长剑', slot: '副手' });
  });

  it('replace 装备/位置：换槽 equip_item；写空值视为卸下', () => {
    expect(ops(tr([{ op: 'replace', path: '/主角/装备/长剑/位置', value: '副手' }]))).toEqual([
      'equip_item',
    ]);
    expect(tr([{ op: 'replace', path: '/主角/装备/长剑/位置', value: '' }]).patches).toEqual([
      { op: 'unequip_item', target: 'characters.艾琳', value: { name: '长剑' } },
    ]);
  });

  it('replace 背包/位置 → 丢弃并说明「穿戴请 move 到装备并写位置」', () => {
    const r = tr([{ op: 'replace', path: '/主角/背包/绳子/位置', value: '腰带' }]);
    expect(r.patches).toEqual([]);
    expect(r.records[0].status).toBe('已丢弃');
    expect(r.records[0].note).toContain('穿戴请 move 到装备并写位置');
  });

  it('同批「删一边、加一边」先折叠成 move，物品字段不丢（两种顺序）', () => {
    for (const batch of [
      [
        { op: 'remove', path: '/主角/背包/绳子' },
        { op: 'add', path: '/主角/装备/绳子', value: { 位置: '腰带' } },
      ],
      [
        { op: 'add', path: '/主角/装备/绳子', value: { 位置: '腰带' } },
        { op: 'remove', path: '/主角/背包/绳子' },
      ],
    ]) {
      const r = tr(batch);
      expect(r.patches).toEqual([
        { op: 'equip_item', target: 'characters.艾琳', value: { name: '绳子', slot: '腰带' } },
      ]);
      expect(r.records).toHaveLength(2);
      expect(r.records.every((x) => x.status === '已纠正')).toBe(true);
      // 结构化折叠标记：后一条并入前一条（下标是 records 数组位置）
      expect(r.records[1]).toMatchObject({ foldedInto: 0, foldKind: 'fold' });
      expect(r.records[0].mergedFrom).toEqual([1]);
    }
    const back = tr([
      { op: 'remove', path: '/主角/装备/长剑' },
      { op: 'add', path: '/主角/背包/长剑', value: { 描述: '收起来了' } },
    ]);
    expect(ops(back)).toEqual(['unequip_item', 'update_item']);
  });

  it('同槽顶替：说明「〈旧物〉已自动卸回背包」', () => {
    const r = tr([{ op: 'move', from: '/主角/背包/绳子', path: '/主角/装备/绳子', value: '武器' }]);
    expect(r.records[0].note).toContain('「长剑」已自动卸回背包');
  });

  it('堆叠物品穿戴丢弃并说明', () => {
    const r = tr([
      { op: 'move', from: '/主角/背包/治疗药水', path: '/主角/装备/治疗药水', value: '饰品' },
    ]);
    expect(r.patches).toEqual([]);
    expect(r.dropped[0]).toContain('堆叠物品不能穿戴');
  });

  it('其余叶子 → update_item（含字典子键）', () => {
    expect(tr([{ op: 'replace', path: '/主角/装备/长剑/耐久/当前', value: 30 }]).patches).toEqual([
      {
        op: 'update_item',
        target: 'characters.艾琳',
        value: { name: '长剑', changes: { durability: 30 } },
      },
    ]);
    const r = tr([{ op: 'replace', path: '/主角/装备/长剑/效果/破甲', value: '无视护甲' }]);
    expect(r.patches[0].value).toEqual({
      name: '长剑',
      changes: { effects: { 锋利: '攻击附带流血', 破甲: '无视护甲' } },
    });
  });

  it('move 到另一人物：背包 → transfer_item；装备 → transfer_item + equip_item', () => {
    expect(
      tr([
        { op: 'move', from: '/主角/背包/治疗药水', path: '/关系列表/布兰/背包/治疗药水', value: 2 },
      ]).patches,
    ).toEqual([
      {
        op: 'transfer_item',
        target: 'characters.艾琳',
        value: { name: '治疗药水', to: '布兰', quantity: 2 },
      },
    ]);
    const r = tr([
      { op: 'move', from: '/主角/装备/长剑', path: '/关系列表/布兰/装备/长剑', value: '武器' },
    ]);
    expect(ops(r)).toEqual(['transfer_item', 'equip_item']);
    expect(r.patches[1]).toEqual({
      op: 'equip_item',
      target: 'characters.布兰',
      value: { name: '长剑', slot: '武器' },
    });
    expect(r.records[0].note).toContain('已从装备卸下');
  });

  it('同一字典内 move 改名 → remove_item + add_item 成一组，字段与槽位照搬', () => {
    const r = tr([{ op: 'move', from: '/主角/装备/长剑', path: '/主角/装备/名剑' }]);
    expect(ops(r)).toEqual(['remove_item', 'add_item']);
    expect(r.patches[1].value).toMatchObject({
      name: '名剑',
      equippedSlot: '武器',
      stats: { 攻击力: 15 },
      durability: 40,
    });
  });

  it('成组补丁整组丢：丢掉的组不影响影子状态，后面的 op 看到原状态', () => {
    const snap = snapshot();
    const bran = snap.characters.find((c) => c.name === '布兰')!;
    bran.inventory = [{ name: '长剑', quantity: 1 }];
    const r = tr(
      [
        { op: 'move', from: '/主角/装备/长剑', path: '/关系列表/布兰/装备/长剑', value: '武器' },
        { op: 'remove', path: '/主角/装备/长剑' },
      ],
      'ai',
      snap,
    );
    expect(r.records[0].status).toBe('已丢弃');
    expect(r.patches).toEqual([
      { op: 'remove_item', target: 'characters.艾琳', value: { name: '长剑', quantity: 1 } },
    ]);
  });
});

describe('纠正规则落在翻译层的几条（§5.2）', () => {
  it('资源当前值钳到 [0, 有效上限]', () => {
    const cap = readResourceCaps(player()).hp.effective;
    const r = tr([{ op: 'replace', path: '/主角/生命值/当前', value: 999999 }]);
    expect(r.patches).toEqual([{ op: 'set_hp', target: 'characters.艾琳', value: cap }]);
    expect(r.records[0].status).toBe('已纠正');
    const d = tr([{ op: 'delta', path: '/主角/生命值/当前', value: -1000 }]);
    expect(d.patches).toEqual([{ op: 'delta_hp', target: 'characters.艾琳', amount: -300 }]);
    expect(d.records[0]).toMatchObject({ before: 300, after: 0 });
  });

  it('上限额外钳到「基础 + 额外 ≥ 1」；写成单个数换算成额外', () => {
    const base = readResourceCaps(player()).sp.base;
    const r = tr([{ op: 'replace', path: '/主角/体力值/上限/额外', value: -99999 }]);
    expect(r.patches).toEqual([
      { op: 'update_character', target: 'characters.艾琳', value: { maxSpBonus: 1 - base } },
    ]);
    expect(r.records[0].note).toContain('已钳到');
    const total = tr([{ op: 'replace', path: '/主角/体力值/上限', value: base + 7 }]);
    expect(total.patches[0].value).toEqual({ maxSpBonus: 7 });
    expect(total.records[0].note).toContain('换算为额外');
    const delta = tr([{ op: 'delta', path: '/主角/体力值/上限/额外', value: 5 }]);
    expect(delta.patches[0]).toMatchObject({ value: { maxSpBonus: 5 }, metadata: { delta: true } });
  });

  it('金钱结果钳到不小于 0', () => {
    const r = tr([{ op: 'delta', path: '/主角/金钱', value: -1000 }]);
    expect(r.patches).toEqual([
      { op: 'update_character', target: 'characters.艾琳', value: { money: 0 } },
    ]);
    expect(r.records[0].note).toContain('已钳到 0');
    expect(tr([{ op: 'delta', path: '/主角/金钱', value: 5 }]).patches[0]).toMatchObject({
      value: { money: 5 },
      metadata: { delta: true },
    });
  });

  it('命运点数：结果钳到 ≥ 0 并换算成账本增量（不让 spendFP 抛错）', () => {
    const r = tr([{ op: 'delta', path: '/命运点数', value: -100 }]);
    expect(r.patches).toEqual([{ op: 'delta_variable', target: 'profile.fp', amount: -42 }]);
    expect(r.records[0]).toMatchObject({ status: '已纠正', before: 42, after: 0 });
    expect(tr([{ op: 'replace', path: '/命运点数', value: 10 }]).patches[0].amount).toBe(-32);
  });

  it('好感度钳到 [-100, 100]', () => {
    expect(tr([{ op: 'replace', path: '/关系列表/布兰/好感度', value: 150 }]).patches).toEqual([
      { op: 'set_affection', target: 'affections.布兰', value: 100 },
    ]);
    expect(tr([{ op: 'delta', path: '/关系列表/布兰/好感度', value: 90 }]).patches).toEqual([
      { op: 'delta_affection', target: 'affections.布兰', amount: 70 },
    ]);
  });

  it('层数 ≤ 0 视为移除状态，受层数上限封顶', () => {
    expect(ops(tr([{ op: 'replace', path: '/主角/状态效果/流血/层数', value: 0 }]))).toEqual([
      'remove_status_effect',
    ]);
    expect(tr([{ op: 'replace', path: '/主角/状态效果/流血/层数', value: 99 }]).patches).toEqual([
      { op: 'update_status_effect', target: 'characters.艾琳', value: { name: '流血', stacks: 5 } },
    ]);
  });
});

describe('技能、状态、登神、任务、新闻、变量', () => {
  it('状态整对象 → add_status_effect：词条进 effectDescriptions；数值时长与文本时长只给其一', () => {
    const timed = tr([
      {
        op: 'add',
        path: '/主角/状态效果/中毒',
        value: { 类型: '减益', 剩余时间: '2天', 效果: '每小时掉血' },
      },
    ]);
    const v = timed.patches[0].value;
    expect(v).toMatchObject({
      name: '中毒',
      category: '减益',
      remainingTime: 48,
      timeUnit: '小时',
      effectDescriptions: { 效果: '每小时掉血' },
    });
    expect(v).not.toHaveProperty('durationText');
    const text = tr([
      { op: 'add', path: '/主角/状态效果/诅咒', value: { 类型: '减益', 剩余时间: '直到天亮' } },
    ]);
    expect(text.patches[0].value).toMatchObject({ durationText: '直到天亮' });
    expect(text.patches[0].value).not.toHaveProperty('remainingTime');
  });

  it('状态剩余时间叶子 → update_status_effect；其余叶子删旧加新成组', () => {
    expect(
      tr([{ op: 'replace', path: '/主角/状态效果/流血/剩余时间', value: '1回合' }]).patches,
    ).toEqual([
      {
        op: 'update_status_effect',
        target: 'characters.艾琳',
        value: { name: '流血', remainingTime: 1 },
      },
    ]);
    const r = tr([{ op: 'replace', path: '/主角/状态效果/流血/描述', value: '血流如注' }]);
    expect(ops(r)).toEqual(['remove_status_effect', 'add_status_effect']);
    expect(r.patches[1].value).toMatchObject({
      name: '流血',
      description: '血流如注',
      stacks: 2,
      remainingTime: 3,
      timeUnit: '回合',
      effects: { hp: -5 },
    });
    // 文本时长的状态重建时不带数值时长
    const blessed = tr([{ op: 'replace', path: '/主角/状态效果/祝福/来源', value: '教堂' }]);
    expect(blessed.patches[1].value).toMatchObject({ durationText: '直到离开城镇' });
    expect(blessed.patches[1].value).not.toHaveProperty('remainingTime');
  });

  it('技能消耗：可解析落 cost，否则落 costText', () => {
    expect(
      tr([{ op: 'replace', path: '/主角/技能/斩击/消耗', value: '12MP' }]).patches[0].value,
    ).toEqual({
      name: '斩击',
      changes: { cost: { type: 'MP', amount: 12 } },
    });
    expect(
      tr([{ op: 'replace', path: '/主角/技能/斩击/消耗', value: '一滴血' }]).patches[0].value,
    ).toEqual({ name: '斩击', changes: { costText: '一滴血' } });
  });

  it('登神长阶任意写 → 影子现值 + 本条重建整份后 update_character', () => {
    const snap = snapshot();
    snap.characters[0].ascension.elements = [
      { name: '旧要素', description: '旧', effects: ['旧词条'] },
    ];
    const r = tr(
      [{ op: 'add', path: '/主角/登神长阶/要素/新要素', value: { 描述: '新' } }],
      'ai',
      snap,
    );
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].op).toBe('update_character');
    const asc = (r.patches[0].value as { ascension: CharacterState['ascension'] }).ascension;
    expect(asc.elements).toEqual([
      { name: '旧要素', description: '旧', effects: ['旧词条'] },
      { name: '新要素', description: '新', effects: [] },
    ]);
    expect(asc.divineKingdom).toEqual({ name: '', description: '' });
  });

  it('任务 → update_quest / remove_quest；新闻 add → add_news，remove 丢弃', () => {
    expect(tr([{ op: 'replace', path: '/任务列表/寻找钥匙/状态', value: '完成' }]).patches).toEqual(
      [{ op: 'update_quest', target: 'quests', value: { name: '寻找钥匙', status: '已完成' } }],
    );
    expect(ops(tr([{ op: 'remove', path: '/任务列表/护送商队' }]))).toEqual(['remove_quest']);
    expect(tr([{ op: 'add', path: '/新闻/未分类/号外', value: '大事' }]).patches).toEqual([
      { op: 'add_news', target: 'news', value: { title: '号外', content: '大事', category: '' } },
    ]);
    const rm = tr([{ op: 'remove', path: '/新闻/王都/旧闻' }]);
    expect(rm.patches).toEqual([]);
    expect(rm.dropped[0]).toContain('只增不删');
  });

  it('变量 → set / delta / remove / insert / move_variable；顶层不是命名空间丢弃', () => {
    const r = tr([
      { op: 'replace', path: '/变量/sys/计数', value: 5 },
      { op: 'delta', path: '/变量/sys/计数', value: 2 },
      { op: 'add', path: '/变量/user/线索/-', value: '地图' },
      { op: 'move', from: '/变量/sys/计数', path: '/变量/user/计数' },
      { op: 'remove', path: '/变量/user/计数' },
      { op: 'replace', path: '/变量/线索', value: 1 },
    ]);
    expect(r.patches).toEqual([
      { op: 'set_variable', target: 'variables.sys.计数', value: 5 },
      { op: 'delta_variable', target: 'variables.sys.计数', amount: 2 },
      { op: 'insert_variable', target: 'variables.user.线索', value: '地图' },
      { op: 'move_variable', target: 'variables.sys.计数', metadata: { toPath: 'user.计数' } },
      { op: 'remove_variable', target: 'variables.user.计数' },
    ]);
    expect(r.records[2].after).toEqual(['钥匙', '地图']);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toContain('命名空间');
  });
});

describe('人物、时间、地点、档案', () => {
  it('等级：NPC → update_character {level}；主角丢弃并提示改累计经验值', () => {
    expect(tr([{ op: 'replace', path: '/关系列表/布兰/成长/等级', value: 9 }]).patches).toEqual([
      { op: 'update_character', target: 'characters.布兰', value: { level: 9 } },
    ]);
    const p = tr([{ op: 'replace', path: '/主角/成长/等级', value: 9 }]);
    expect(p.patches).toEqual([]);
    expect(p.dropped[0]).toContain('累计经验值');
  });

  it('/世界/时间 汇总成 deltaMinutes，不产补丁；倒退丢弃', () => {
    const later = formatGameTime(advanceTime(GAME_TIME, 120));
    const r = tr([
      { op: 'delta', path: '/世界/时间', value: 30 },
      { op: 'replace', path: '/世界/时间', value: later },
      { op: 'delta', path: '/世界/时间', value: -5 },
    ]);
    expect(r.patches).toEqual([]);
    // 第二条按影子时间（已过 30 分钟）求差
    expect(r.deltaMinutes).toBe(120);
    expect(r.records[1].after).toBe(later);
    expect(r.records[2].status).toBe('已丢弃');
  });

  it('/世界/地点 → 主角 set_location；/主角/地点 改写到 /世界/地点', () => {
    expect(tr([{ op: 'replace', path: '/世界/地点', value: '王都/南门' }]).patches).toEqual([
      { op: 'set_location', target: 'characters.艾琳', value: '王都/南门' },
    ]);
    const r = tr([{ op: 'replace', path: '/主角/地点', value: '王都/南门' }]);
    expect(r.records[0]).toMatchObject({ path: '/世界/地点', status: '已纠正' });
  });

  it('档案文字字段产 update_character 补丁，不再带 profileChanges 旁路字段（审查 A8）', () => {
    const r = tr([
      { op: 'replace', path: '/关系列表/布兰/档案/外貌', value: '银发' },
      { op: 'replace', path: '/关系列表/布兰/档案/身份', value: '佣兵、向导' },
    ]);
    expect(r.patches).toEqual([
      { op: 'update_character', target: 'characters.布兰', value: { appearance: '银发' } },
      {
        op: 'update_character',
        target: 'characters.布兰',
        value: { identity: ['佣兵', '向导'] },
      },
    ]);
    expect(r).not.toHaveProperty('profileChanges');
    expect(r.records[0]).toMatchObject({ before: '高个子', after: '银发' });
  });

  it('_ 键与树外路径丢该条', () => {
    const r = tr([
      { op: 'replace', path: '/主角/成长/_属性点', value: 9 },
      { op: 'replace', path: '/主角/成长/属性点', value: 9 },
      { op: 'replace', path: '/主角/不存在', value: 1 },
      { op: 'replace', path: '/外面', value: 1 },
    ]);
    expect(r.patches).toEqual([]);
    expect(r.records.map((x) => x.status)).toEqual(['已丢弃', '已丢弃', '已丢弃', '已丢弃']);
    expect(r.records[0].note).toContain('由代码维护');
    expect(r.records[1].note).toContain('由代码维护');
  });
});

describe('actor 区别（§11.3）', () => {
  it('remove /关系列表/<名>：AI 只放行怪物 / 召唤物，玩家可删任意 NPC，主角谁都不可删', () => {
    const ai = tr([
      { op: 'remove', path: '/关系列表/卡拉' },
      { op: 'remove', path: '/关系列表/哥布林' },
    ]);
    expect(ai.patches).toEqual([{ op: 'remove_character', target: 'characters.哥布林' }]);
    expect(ai.dropped[0]).toContain('AI 只能删除怪物或召唤物');
    const pl = tr([{ op: 'remove', path: '/关系列表/卡拉' }], 'player');
    expect(pl.patches).toEqual([{ op: 'remove_character', target: 'characters.卡拉' }]);
    for (const actor of ['ai', 'player'] as const) {
      const r = tr([{ op: 'remove', path: '/主角' }], actor);
      expect(r.patches).toEqual([]);
      expect(r.dropped[0]).toContain('主角不可删除');
    }
  });

  it('move /关系列表/<名> → rename_character', () => {
    expect(tr([{ op: 'move', from: '/关系列表/卡拉', path: '/关系列表/卡拉丽' }]).patches).toEqual([
      { op: 'rename_character', target: 'characters.卡拉', value: '卡拉丽' },
    ]);
  });
});

describe('新建人物（§4.4）', () => {
  const core = {
    成长: { 等级: 6, 属性: { 力量: 8, 敏捷: 6, 体质: 7, 智力: 5, 精神: 5 } },
    地点: '王都/铁匠铺',
    在场: true,
  };

  it('整对象 → 组装管线产出 add_character，层级由等级推出，新人物先落', () => {
    const r = tr([
      { op: 'delta', path: '/关系列表/铁匠/好感度', value: 5 },
      { op: 'add', path: '/关系列表/铁匠', value: { ...core, 好感度: 10, 档案: { 种族: '矮人' } } },
    ]);
    expect(ops(r)).toEqual(['add_character', 'set_affection', 'delta_affection']);
    const c = r.newCharacters[0];
    expect(c).toMatchObject({ name: '铁匠', type: 'npc', level: 6, tier: 2, race: '矮人' });
    expect(c.hp).toBe(c.maxHp);
    expect(r.patches[0].value).toBe(c);
    expect(r.records.map((x) => x.status)).toEqual(['已应用', '已应用']);
  });

  it('缺核心（等级、五维、地点、在场）丢整个人物', () => {
    const r = tr([{ op: 'add', path: '/关系列表/铁匠', value: { 地点: '王都', 在场: true } }]);
    expect(r.patches).toEqual([]);
    expect(r.dropped[0]).toContain('缺少核心字段');
  });

  it('人物内部坏条目只丢那一条', () => {
    const r = tr([
      {
        op: 'add',
        path: '/关系列表/铁匠',
        value: {
          ...core,
          装备: { 铁锤: { 位置: '武器' }, 怪东西: { 位置: '手持' } },
          背包: { 矿石: { 数量: 3 } },
        },
      },
    ]);
    expect(r.newCharacters[0].inventory.map((i) => [i.name, i.equippedSlot])).toEqual([
      ['矿石', null],
      ['铁锤', '武器'],
    ]);
    expect(r.records[0].status).toBe('已纠正');
    expect(r.records[0].note).toContain('怪东西');
  });
});

describe('记录与入参', () => {
  it('每条记录都带前值与后值；丢弃的前后值相同', () => {
    const r = tr([
      { op: 'replace', path: '/主角/金钱', value: 50 },
      { op: 'replace', path: '/主角/成长/_属性点', value: 9 },
    ]);
    expect(r.records[0]).toMatchObject({ op: 'replace', value: 50, before: 120, after: 50 });
    expect(r.records[1].status).toBe('已丢弃');
    expect(r.records[1].before).toEqual(r.records[1].after);
  });

  it('不修改入参快照', () => {
    const snap = snapshot();
    const copy = structuredClone(snap);
    tr(
      [
        { op: 'remove', path: '/主角/背包/治疗药水' },
        { op: 'delta', path: '/命运点数', value: 5 },
        { op: 'add', path: '/变量/sys/新', value: 1 },
      ],
      'ai',
      snap,
    );
    expect(snap).toEqual(copy);
  });

  it('区块解析的纠正并入该条记录', () => {
    const r = tr([{ op: 'set', path: '主角.金钱', value: 1 }]);
    expect(r.records[0].status).toBe('已纠正');
    expect(r.records[0].note).toContain('按 replace 处理');
    const patch: StatePatch = r.patches[0];
    expect(patch).toEqual({
      op: 'update_character',
      target: 'characters.艾琳',
      value: { money: 1 },
    });
  });
});

describe('审查修复：AI 不能借改类别删 NPC（第 3 条）', () => {
  it('同批 replace 档案/类别="怪物" + remove：类别丢弃（由代码维护），NPC 不被删', () => {
    const r = tr([
      { op: 'replace', path: '/关系列表/布兰/档案/类别', value: '怪物' },
      { op: 'remove', path: '/关系列表/布兰' },
    ]);
    expect(r.patches).toEqual([]);
    expect(r.records[0]).toMatchObject({ status: '已丢弃' });
    expect(r.records[0].note).toContain('由代码维护');
    expect(r.records[1]).toMatchObject({ status: '已丢弃' });
    expect(r.dropped[1]).toContain('AI 只能删除怪物或召唤物');
  });

  it('已有人物整对象写入里的类别对 AI 同样只读，其余字段照写', () => {
    const r = tr([
      { op: 'replace', path: '/关系列表/布兰', value: { 档案: { 类别: '怪物' }, 金钱: 5 } },
    ]);
    expect(r.patches.some((p) => JSON.stringify(p.value ?? null).includes('monster'))).toBe(false);
    expect(r.patches.some((p) => JSON.stringify(p.value ?? null).includes('"money":5'))).toBe(true);
    expect(r.records[0].note).toContain('档案：对象里的每个键都写不进去');
  });

  it('改名后删除仍按本批开始时的类别判：怪物改名再删放行', () => {
    const r = tr([
      { op: 'move', from: '/关系列表/哥布林', path: '/关系列表/哥布林王' },
      { op: 'remove', path: '/关系列表/哥布林王' },
    ]);
    expect(ops(r)).toEqual(['rename_character', 'remove_character']);
  });

  it('玩家不受影响：可改类别', () => {
    const r = tr([{ op: 'replace', path: '/关系列表/布兰/档案/类别', value: '怪物' }], 'player');
    expect(r.patches).toEqual([
      { op: 'update_character', target: 'characters.布兰', value: { type: 'monster' } },
    ]);
  });
});

describe('审查修复：把条目减没的记录（第 5 条）', () => {
  it('delta 用掉最后的药水：记条目整对象前值，状态是已应用（消耗不是纠正）', () => {
    const r = tr([{ op: 'delta', path: '/主角/背包/治疗药水/数量', value: -3 }]);
    expect(ops(r)).toEqual(['remove_item']);
    const rec = r.records[0];
    expect(rec.status).toBe('已应用');
    expect(rec.note).toBeUndefined();
    expect(rec.before).toBe(3);
    expect(rec.after).toBeUndefined();
    expect(rec.entryBefore).toMatchObject({ 数量: 3, 类型: '消耗品', 描述: '恢复体力' });
  });

  it('层数 delta 减到 0：记条目整对象前值，已应用', () => {
    const r = tr([{ op: 'delta', path: '/主角/状态效果/流血/层数', value: -2 }]);
    expect(ops(r)).toEqual(['remove_status_effect']);
    expect(r.records[0].status).toBe('已应用');
    expect(r.records[0].entryBefore).toMatchObject({ 层数: 2, 描述: '持续失血' });
  });

  it('显式 replace 成 0、超扣：仍记纠正，也带整对象前值', () => {
    const zero = tr([{ op: 'replace', path: '/主角/背包/治疗药水/数量', value: 0 }]);
    expect(zero.records[0].status).toBe('已纠正');
    expect(zero.records[0].entryBefore).toMatchObject({ 数量: 3 });
    const over = tr([{ op: 'delta', path: '/主角/背包/治疗药水/数量', value: -5 }]);
    expect(over.records[0].status).toBe('已纠正');
    expect(over.records[0].entryBefore).toMatchObject({ 数量: 3 });
  });

  it('没减没的不记整对象前值', () => {
    const r = tr([{ op: 'delta', path: '/主角/背包/治疗药水/数量', value: -1 }]);
    expect(r.records[0].entryBefore).toBeUndefined();
  });
});

describe('审查修复：变量命名空间根不可整块写删（第 7 条）', () => {
  for (const actor of ['ai', 'player'] as const) {
    it(`${actor}：replace / remove / move 命名空间根丢弃并说明`, () => {
      const r = tr(
        [
          { op: 'replace', path: '/变量/world', value: 5 },
          { op: 'remove', path: '/变量/user' },
          { op: 'add', path: '/变量/sys', value: {} },
          { op: 'move', from: '/变量/sys', path: '/变量/user/备份' },
        ],
        actor,
      );
      expect(r.patches).toEqual([]);
      expect(r.records.map((x) => x.status)).toEqual(['已丢弃', '已丢弃', '已丢弃', '已丢弃']);
      for (const d of r.dropped) expect(d).toContain('命名空间');
    });
  }

  it('写到命名空间下的键照常', () => {
    const r = tr([{ op: 'replace', path: '/变量/world/天气', value: '晴' }]);
    expect(r.patches).toEqual([
      { op: 'set_variable', target: 'variables.world.天气', value: '晴' },
    ]);
  });
});

describe('复审修复：影子按 StateManager 同一判据重算上限（3）', () => {
  it('同批改等级 + 写法力当前值：原上限为 0 的法力保持 0，记录后值是 0', () => {
    const s = snapshot();
    s.characters = s.characters.map((c) =>
      c.name === '卡拉' ? { ...c, maxMp: 0, mp: 0, maxMpBonus: undefined } : c,
    );
    const r = tr(
      [
        { op: 'replace', path: '/关系列表/卡拉/成长/等级', value: 15 },
        { op: 'replace', path: '/关系列表/卡拉/法力值/当前', value: 1 },
      ],
      'ai',
      s,
    );
    expect(r.records[0].status).not.toBe('已丢弃');
    expect(r.records[1].after).toBe(0);
  });

  it('同批改等级：原上限非 0 的项照常按新层级重算', () => {
    const before = snapshot().characters.find((c) => c.name === '卡拉')!;
    const r = tr([
      { op: 'replace', path: '/关系列表/卡拉/成长/等级', value: 15 },
      { op: 'replace', path: '/关系列表/卡拉/生命值/当前', value: 99999 },
    ]);
    expect(r.records[1].after).toBeGreaterThan(before.maxHp);
  });
});
