/**
 * CombatActionCard.test.ts — v3 攻击卡片渲染（2026-08-12）
 *
 * 背景（真机 bug）：v3 的 v3_action(attack) 卡片是**扁平字段**
 * （{ attackerId, targetId, skill?, checkValue?, rating?, hit?, final?, ... }），
 * 而 CombatActionCard 此前只认 v2 的 CombatActionResult（request/attackRoll/damage 嵌套）
 * → hasDamageBreakdown=false → 落兜底「attack」空卡，点开没内容。
 * 本测试钉住 v3 分支：折叠态渲染完整摘要（攻方→守方 · 技能 · 检定 · 伤害 · HP），
 * 展开态渲染详情行。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CombatActionCard from './CombatActionCard.vue';

const V3_RESULT = {
  attackerId: '奥利雅思',
  targetId: '洞壑魔物',
  skill: '灼热射线',
  checkValue: 15,
  rating: '有效',
  hit: true,
  final: 161,
  damageType: '能量',
  targetHpBefore: 625,
  targetHpAfter: 464,
};

describe('CombatActionCard — v3 攻击卡片', () => {
  it('v3 扁平字段 → 折叠态渲染完整摘要（攻方→守方 · 技能 · 检定 · 伤害 · HP）', () => {
    const w = mount(CombatActionCard, {
      props: { toolName: 'attack', result: V3_RESULT },
    });
    const text = w.text();
    expect(text).toContain('攻击');
    expect(text).toContain('奥利雅思');
    expect(text).toContain('洞壑魔物');
    expect(text).toContain('灼热射线');
    expect(text).toContain('检定 15');
    expect(text).toContain('有效');
    expect(text).toContain('161 点能量伤害');
    expect(text).toContain('HP 625 → 464');
  });

  it('v3 未命中（hit:false）→ 显示「未命中」而非伤害', () => {
    const w = mount(CombatActionCard, {
      props: {
        toolName: 'attack',
        result: {
          attackerId: '奥利雅思',
          targetId: '洞壑魔物',
          checkValue: 3,
          rating: '失手',
          hit: false,
          final: 0,
          targetHpBefore: 625,
          targetHpAfter: 625,
        },
      },
    });
    const text = w.text();
    expect(text).toContain('未命中');
    expect(text).not.toContain('点伤害');
  });

  it('v3 展开 → 渲染详情行（技能/检定/伤害/目标HP）', async () => {
    const w = mount(CombatActionCard, {
      props: { toolName: 'attack', result: V3_RESULT },
    });
    await w.find('.cac-header').trigger('click');
    const text = w.text();
    expect(text).toContain('技能');
    expect(text).toContain('灼热射线');
    expect(text).toContain('检定');
    expect(text).toContain('15');
    expect(text).toContain('伤害');
    expect(text).toContain('161 点能量');
    expect(text).toContain('目标 HP');
    expect(text).toContain('625 → 464');
  });

  it('v3 展开含骰值/意图/伤害分解（dice + preReduction→postStep6→final）', async () => {
    const w = mount(CombatActionCard, {
      props: {
        toolName: 'attack',
        result: {
          attackerId: '奥利雅思',
          targetId: '魔物',
          skill: '火球术',
          intentionLevel: '战术',
          checkValue: 22,
          rating: '暴击',
          hit: true,
          dice: [18, 4],
          preReduction: 500,
          postStep6: 850,
          final: 680,
          damageType: '能量',
          targetHpBefore: 1000,
          targetHpAfter: 320,
        },
      },
    });
    await w.find('.cac-header').trigger('click');
    const text = w.text();
    // 意图
    expect(text).toContain('意图');
    expect(text).toContain('战术');
    // 骰值（检定行 note 里显示原始骰面）
    expect(text).toContain('骰 18 + 4');
    // 伤害分解链：初始 → 修正 → 减免
    expect(text).toContain('初始 500');
    expect(text).toContain('修正 850');
    expect(text).toContain('减免');
  });

  it('v3 单骰只显示一个骰值（无 + 号）', async () => {
    const w = mount(CombatActionCard, {
      props: {
        toolName: 'attack',
        result: {
          attackerId: '甲',
          targetId: '乙',
          checkValue: 12,
          rating: '有效',
          hit: true,
          dice: [12],
          final: 100,
          damageType: '物理',
          targetHpBefore: 200,
          targetHpAfter: 100,
        },
      },
    });
    await w.find('.cac-header').trigger('click');
    expect(w.text()).toContain('骰 12');
    expect(w.text()).not.toContain('骰 12 +');
  });

  it('非攻击 tool（如 cost）→ 不落入 v3 攻击分支，正常渲染', () => {
    const w = mount(CombatActionCard, {
      props: { toolName: 'cost', result: { unitId: '甲', resource: 'mp', amount: 100 } },
    });
    expect(w.text()).toContain('消耗');
  });
});

describe('CombatActionCard — v3 攻击卡片名字解析（真机 bug：UUID 而非角色名）', () => {
  // 生产形状：attackerId/targetId 是角色 UUID（= characterId），不是名字
  const UUID_RESULT = {
    attackerId: '2011502d-0fb3-4d0e-97d9-cd1e300edd86',
    targetId: '7f3c9b21-5a4e-4d8f-9b1a-2c6d8e0f4a53',
    skill: '灼热射线',
    checkValue: 15,
    rating: '有效',
    hit: true,
    final: 161,
    damageType: '能量',
    targetHpBefore: 625,
    targetHpAfter: 464,
  };
  const UNITS: Record<string, string> = {
    [UUID_RESULT.attackerId]: '奥利雅思',
    [UUID_RESULT.targetId]: '灰皮巨鼠',
  };

  it('attackerId/targetId 是 UUID：传入 units 字典时标题渲染中文名，不渲染 UUID', () => {
    const w = mount(CombatActionCard, {
      props: { toolName: 'attack', result: UUID_RESULT, units: UNITS },
    });
    const text = w.text();
    // 折叠态标题的攻方/守方两个 .cac-name（中间是 CSS 伪元素箭头，text() 不含 →）
    const names = w.findAll('.cac-name').map((n) => n.text());
    expect(names).toEqual(['奥利雅思', '灰皮巨鼠']);
    expect(text).toContain('奥利雅思');
    expect(text).toContain('灰皮巨鼠');
    expect(text).not.toContain('2011502d');
    expect(text).not.toContain('7f3c9b21');
  });

  it('不传 units 字典 → 回退显示原始 id（不崩、不显示未知）', () => {
    const w = mount(CombatActionCard, {
      props: { toolName: 'attack', result: UUID_RESULT },
    });
    const text = w.text();
    expect(text).toContain(UUID_RESULT.attackerId);
    expect(text).toContain(UUID_RESULT.targetId);
    expect(text).not.toContain('未知');
  });

  it('units 字典查不到某侧 id → 该侧单独回退显示原始 id', () => {
    const w = mount(CombatActionCard, {
      props: {
        toolName: 'attack',
        result: UUID_RESULT,
        units: { [UUID_RESULT.attackerId]: '奥利雅思' }, // 只有攻方，守方缺失
      },
    });
    const text = w.text();
    expect(text).toContain('奥利雅思');
    expect(text).toContain(UUID_RESULT.targetId); // 守方回退 id
    expect(text).not.toContain(UUID_RESULT.attackerId); // 攻方已反查成功
  });
});
