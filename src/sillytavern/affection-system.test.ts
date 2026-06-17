/**
 * affection-system.ts 测试
 * 覆盖: 钳制 / 读写 / 批量 / 标签 / $affection API
 */
import { describe, it, expect } from 'vitest';
import {
  AFFECTION_MIN,
  AFFECTION_MAX,
  clampAffection,
  getAffection,
  setAffection,
  addAffection,
  batchSetAffection,
  batchAddAffection,
  getAffectionLabel,
  getSimpleAffectionLabel,
  $affection,
  AFFECTION_LABELS,
  type AffectionMap,
} from './affection-system';

// ========== 常量 ==========

describe('常量', () => {
  it('上下限为 -100 ~ +100', () => {
    expect(AFFECTION_MIN).toBe(-100);
    expect(AFFECTION_MAX).toBe(+100);
  });
});

// ========== 钳制 ==========

describe('clampAffection', () => {
  it('正常范围内不变', () => {
    expect(clampAffection(0)).toBe(0);
    expect(clampAffection(50)).toBe(50);
    expect(clampAffection(-50)).toBe(-50);
    expect(clampAffection(100)).toBe(100);
    expect(clampAffection(-100)).toBe(-100);
  });

  it('超过上限 → 100', () => {
    expect(clampAffection(150)).toBe(100);
    expect(clampAffection(999)).toBe(100);
  });

  it('低于下限 → -100', () => {
    expect(clampAffection(-150)).toBe(-100);
    expect(clampAffection(-999)).toBe(-100);
  });

  it('浮点数 → 四舍五入', () => {
    expect(clampAffection(3.7)).toBe(4);
    expect(clampAffection(3.2)).toBe(3);
    expect(clampAffection(-3.7)).toBe(-4);
    expect(clampAffection(-3.2)).toBe(-3);
  });
});

// ========== 基本读写 ==========

describe('getAffection', () => {
  it('存在 → 返回该值', () => {
    const map: AffectionMap = { alice: 30, bob: -10 };
    expect(getAffection(map, 'alice')).toBe(30);
    expect(getAffection(map, 'bob')).toBe(-10);
  });

  it('不存在 → 返回 0', () => {
    const map: AffectionMap = {};
    expect(getAffection(map, 'carol')).toBe(0);
  });
});

describe('setAffection', () => {
  it('设置新值并钳制', () => {
    const map: AffectionMap = {};
    const result = setAffection(map, 'alice', 50);
    expect(result.alice).toBe(50);
    expect(map.alice).toBeUndefined(); // 不修改原对象
  });

  it('超过上限自动钳制', () => {
    const result = setAffection({}, 'alice', 200);
    expect(result.alice).toBe(100);
  });

  it('低于下限自动钳制', () => {
    const result = setAffection({}, 'alice', -200);
    expect(result.alice).toBe(-100);
  });

  it('覆盖已有值', () => {
    const result = setAffection({ alice: 30, bob: -10 }, 'alice', 80);
    expect(result.alice).toBe(80);
    expect(result.bob).toBe(-10); // 其他角色不受影响
  });
});

describe('addAffection', () => {
  it('正增量', () => {
    const result = addAffection({ alice: 30 }, 'alice', 10);
    expect(result.alice).toBe(40);
  });

  it('负增量', () => {
    const result = addAffection({ alice: 30 }, 'alice', -15);
    expect(result.alice).toBe(15);
  });

  it('从 0 开始', () => {
    const result = addAffection({}, 'alice', 10);
    expect(result.alice).toBe(10);
  });

  it('增量后超过上限 → 钳制到 100', () => {
    const result = addAffection({ alice: 95 }, 'alice', 10);
    expect(result.alice).toBe(100);
  });

  it('减量后低于下限 → 钳制到 -100', () => {
    const result = addAffection({ alice: -95 }, 'alice', -10);
    expect(result.alice).toBe(-100);
  });
});

// ========== 批量操作 ==========

describe('batchSetAffection', () => {
  it('批量设置', () => {
    const result = batchSetAffection({}, { alice: 30, bob: -10, carol: 80 });
    expect(result.alice).toBe(30);
    expect(result.bob).toBe(-10);
    expect(result.carol).toBe(80);
  });

  it('自动钳制', () => {
    const result = batchSetAffection({}, { alice: 150, bob: -200 });
    expect(result.alice).toBe(100);
    expect(result.bob).toBe(-100);
  });

  it('合并已有值', () => {
    const result = batchSetAffection({ alice: 30 }, { bob: 50 });
    expect(result.alice).toBe(30);
    expect(result.bob).toBe(50);
  });
});

describe('batchAddAffection', () => {
  it('批量增减', () => {
    const result = batchAddAffection(
      { alice: 10, bob: -10 },
      { alice: 20, bob: -15, carol: 30 },
    );
    expect(result.alice).toBe(30);  // 10 + 20
    expect(result.bob).toBe(-25);   // -10 + -15
    expect(result.carol).toBe(30);  // 0 + 30
  });

  it('自动钳制', () => {
    const result = batchAddAffection(
      { alice: 95 },
      { alice: 20, bob: -10 },
    );
    expect(result.alice).toBe(100);
    expect(result.bob).toBe(-10);
  });
});

// ========== 标签 ==========

describe('AFFECTION_LABELS', () => {
  it('11 级标签完整', () => {
    expect(AFFECTION_LABELS).toHaveLength(11);
  });
});

describe('getAffectionLabel', () => {
  it('90~100 → 誓死追随', () => {
    expect(getAffectionLabel(100)).toBe('誓死追随');
    expect(getAffectionLabel(90)).toBe('誓死追随');
  });

  it('70~89 → 深厚羁绊', () => {
    expect(getAffectionLabel(80)).toBe('深厚羁绊');
  });

  it('50~69 → 友好信任', () => {
    expect(getAffectionLabel(60)).toBe('友好信任');
  });

  it('10~29 → 略有善意', () => {
    expect(getAffectionLabel(20)).toBe('略有善意');
  });

  it('-9~9 → 中立', () => {
    expect(getAffectionLabel(0)).toBe('中立');
    expect(getAffectionLabel(5)).toBe('中立');
    expect(getAffectionLabel(-5)).toBe('中立');
  });

  it('-29~-10 → 略有反感', () => {
    expect(getAffectionLabel(-20)).toBe('略有反感');
  });

  it('-100~-90 → 不共戴天', () => {
    expect(getAffectionLabel(-100)).toBe('不共戴天');
    expect(getAffectionLabel(-95)).toBe('不共戴天');
  });

  it('超出范围的值先钳制再查标签', () => {
    expect(getAffectionLabel(999)).toBe('誓死追随');
    expect(getAffectionLabel(-999)).toBe('不共戴天');
  });
});

describe('getSimpleAffectionLabel', () => {
  it('>9 → 友好', () => {
    expect(getSimpleAffectionLabel(10)).toBe('友好');
    expect(getSimpleAffectionLabel(50)).toBe('友好');
    expect(getSimpleAffectionLabel(100)).toBe('友好');
  });

  it('-9~9 → 中立', () => {
    expect(getSimpleAffectionLabel(0)).toBe('中立');
    expect(getSimpleAffectionLabel(9)).toBe('中立');
    expect(getSimpleAffectionLabel(-9)).toBe('中立');
  });

  it('<-9 → 敌对', () => {
    expect(getSimpleAffectionLabel(-10)).toBe('敌对');
    expect(getSimpleAffectionLabel(-50)).toBe('敌对');
    expect(getSimpleAffectionLabel(-100)).toBe('敌对');
  });
});

// ========== $affection API ==========

describe('$affection API', () => {
  it('$affection.get', () => {
    expect($affection.get({ alice: 30 }, 'alice')).toBe(30);
    expect($affection.get({}, 'alice')).toBe(0);
  });

  it('$affection.set', () => {
    const result = $affection.set({}, 'alice', 50);
    expect(result.alice).toBe(50);
  });

  it('$affection.add', () => {
    const result = $affection.add({ alice: 30 }, 'alice', -5);
    expect(result.alice).toBe(25);
  });

  it('$affection.batch', () => {
    const result = $affection.batch({}, { alice: 30, bob: -10 });
    expect(result.alice).toBe(30);
    expect(result.bob).toBe(-10);
  });

  it('$affection.label', () => {
    expect($affection.label(0)).toBe('中立');
    expect($affection.label(80)).toBe('深厚羁绊');
  });

  it('$affection.simpleLabel', () => {
    expect($affection.simpleLabel(30)).toBe('友好');
    expect($affection.simpleLabel(0)).toBe('中立');
    expect($affection.simpleLabel(-30)).toBe('敌对');
  });

  it('$affection.MIN / MAX', () => {
    expect($affection.MIN).toBe(-100);
    expect($affection.MAX).toBe(100);
  });
});

// ========== 实际游玩场景 ==========

describe('实际游玩场景', () => {
  it('AI 每回合微调好感度', () => {
    // 初始状态: 所有 NPC 好感度 0
    let affections: AffectionMap = {};

    // 第1回合: 主角帮助了酒馆老板和村姑
    affections = $affection.batch(affections, {
      innkeeper: 15,
      village_girl: 10,
    });
    expect(affections.innkeeper).toBe(15);
    expect(affections.village_girl).toBe(10);

    // 第2回合: 与酒馆老板深入交流 → +5
    affections = $affection.add(affections, 'innkeeper', 5);
    expect(affections.innkeeper).toBe(20);
    expect($affection.label(affections.innkeeper)).toBe('略有善意');

    // 第3回合: 冒犯了村姑 → -20
    affections = $affection.add(affections, 'village_girl', -20);
    expect(affections.village_girl).toBe(-10);
    expect($affection.simpleLabel(affections.village_girl)).toBe('敌对');

    // 第4回合: 与新 NPC 铁匠互动
    affections = $affection.set(affections, 'blacksmith', 5);
    expect(affections.blacksmith).toBe(5);
    expect($affection.label(affections.blacksmith)).toBe('中立');
  });

  it('边界不溢出', () => {
    let affections: AffectionMap = { nemesis: -98 };

    // 多次恶意行为也不会低于 -100
    affections = $affection.add(affections, 'nemesis', -10);
    expect(affections.nemesis).toBe(-100);

    affections = $affection.add(affections, 'nemesis', -10);
    expect(affections.nemesis).toBe(-100); // 仍然 -100

    // 标签仍然正确
    expect($affection.label(affections.nemesis)).toBe('不共戴天');
  });
});
