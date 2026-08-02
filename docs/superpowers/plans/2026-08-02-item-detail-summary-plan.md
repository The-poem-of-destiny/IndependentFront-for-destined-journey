# 物品/技能/装备 详情弹窗 · 轻量摘要实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击物品/技能/装备弹独立小弹窗，展示 modifiers + automata 的中文轻量摘要（右上角叉叉关闭），点「查看原始数据」才暴露原始 JSON/代码。

**Architecture:** 引擎侧新增两个纯函数模块（`describe-modifier.ts` / `describe-automaton.ts`）把 Modifier/EffectAutomatonDecl 翻译成中文行，前端新增 `ItemDetailModal.vue` 弹窗（复用 `AppModal`）渲染摘要 + 原始数据折叠，`ItemsPanel.vue` 加弹出入口。

**Tech Stack:** TypeScript / Vitest / Vue 3 (script setup) / 项目 design tokens（CSS 变量）

**Spec:** `docs/superpowers/specs/2026-08-02-item-detail-summary-design.md`

## Global Constraints

- 引擎侧纯函数模块放 `src/sillytavern/`，**零 I/O、零 Vue、零 Dexie**（纯度约束同 `ejs-fmt.ts` / `workshop-diff.ts`）
- 前端只用 CSS 变量（`--theme-*` token），不硬编码颜色；品质色用 `qualityVar()`
- 弹窗复用 `AppModal.vue`（`size="md"`），不造新弹窗轮子
- 摘要翻译覆盖 `Modifier` 6 大类 + `EffectAutomatonDecl` 18 窗口 + `EffectIntent` 13 类（spec §3 已按代码修正，**backlog 说的「8 大类」是旧口径**）
- 每个新模块必须配 `*.test.ts`（Vitest），`npm test` 全绿
- 中文注释风格，遵守项目惯例（`/** ... */` 块注释 + `//` 行注释）

---

### Task 1: describe-modifier.ts —— Modifier 6 大类中文翻译

**Files:**
- Create: `src/sillytavern/describe-modifier.ts`
- Test: `src/sillytavern/describe-modifier.test.ts`

**Interfaces:**
- Consumes: `Modifier`（`src/sillytavern/effect-types.ts`，6 大类判别联合）
- Produces: `describeModifier(m: Modifier): string` — 单条 modifier → 中文行；`describeModifiers(list: Modifier[]): string[]` — 批量，过滤空

- [ ] **Step 1: 写失败测试**

```ts
// src/sillytavern/describe-modifier.test.ts
import { describe, it, expect } from 'vitest';
import { describeModifier, describeModifiers } from './describe-modifier';
import type { Modifier } from './effect-types';

describe('describeModifier 固伤', () => {
  it('造成 N 点X伤害', () => {
    const m: Modifier = { category: '固伤', source: '', amount: 5, damageType: '物理' };
    expect(describeModifier(m)).toBe('造成 5 点物理伤害');
  });
  it('无 damageType 时省略类型', () => {
    const m: Modifier = { category: '固伤', source: '', amount: 5 };
    expect(describeModifier(m)).toBe('造成 5 点伤害');
  });
});

describe('describeModifier 百分比', () => {
  it('正系数 = 增伤', () => {
    const m: Modifier = { category: '百分比', source: '', coefficient: 0.2, target: 'damage' };
    expect(describeModifier(m)).toBe('伤害 +20%');
  });
  it('负系数 = 减益', () => {
    const m: Modifier = { category: '百分比', source: '', coefficient: -0.15, target: 'damage' };
    expect(describeModifier(m)).toBe('伤害 -15%');
  });
  it('target=heal → 治疗', () => {
    const m: Modifier = { category: '百分比', source: '', coefficient: 0.1, target: 'heal' };
    expect(describeModifier(m)).toBe('治疗 +10%');
  });
});

describe('describeModifier 资源', () => {
  it('正 = 回复，负 = 消耗', () => {
    expect(describeModifier({ category: '资源', source: '', resource: 'hp', amount: 10 })).toBe(
      '回复 10 点HP',
    );
    expect(describeModifier({ category: '资源', source: '', resource: 'mp', amount: -5 })).toBe(
      '消耗 5 点MP',
    );
  });
});

describe('describeModifier 检定', () => {
  it('命中检定 +5', () => {
    expect(
      describeModifier({ category: '检定', source: '', checkType: '命中', bonus: 5 }),
    ).toBe('命中检定 +5');
  });
  it('属性检定带 attribute', () => {
    expect(
      describeModifier({ category: '检定', source: '', checkType: '属性', attribute: '力量', bonus: 3 }),
    ).toBe('力量检定 +3');
  });
});

describe('describeModifier 附加效果', () => {
  it('附加状态', () => {
    expect(
      describeModifier({ category: '附加效果', source: '', buffName: '流血', stacks: 2 }),
    ).toBe('附加 流血 2层');
  });
});

describe('describeModifier 特殊机制', () => {
  it('DR / 穿透', () => {
    expect(describeModifier({ category: '特殊机制', source: '', mechanism: 'DR', value: 20 })).toBe(
      '减伤 20%',
    );
    expect(
      describeModifier({ category: '特殊机制', source: '', mechanism: '穿透', value: 15 }),
    ).toBe('穿透 15%');
  });
});

describe('describeModifier 触发条件 + 来源', () => {
  it('condition 前缀', () => {
    const m: Modifier = {
      category: '检定',
      source: '',
      checkType: '命中',
      bonus: 5,
      condition: '{{target.hpPercent}} < 0.5',
    };
    expect(describeModifier(m)).toContain('目标HP<50%');
    expect(describeModifier(m)).toContain('命中检定 +5');
  });
  it('source 尾注', () => {
    const m: Modifier = { category: '固伤', source: '灼热之刃', amount: 3, damageType: '能量' };
    expect(describeModifier(m)).toBe('造成 3 点能量伤害（来源：灼热之刃）');
  });
});

describe('describeModifiers 批量', () => {
  it('空数组 → 空数组', () => {
    expect(describeModifiers([])).toEqual([]);
  });
  it('过滤空行', () => {
    expect(describeModifiers([{ category: '固伤', source: '', amount: 0 }])).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/sillytavern/describe-modifier.test.ts`
Expected: FAIL — `Cannot find module './describe-modifier'`

- [ ] **Step 3: 写最小实现**

```ts
// src/sillytavern/describe-modifier.ts
/**
 * describe-modifier.ts —— Modifier（战斗修正）→ 人类可读中文摘要
 *
 * 纯函数模块：零 I/O、零 Vue、零 Dexie。前端 ItemsPanel 详情弹窗用它渲染
 * 「战斗修正」区，玩家一眼看懂装备带什么战斗效果，无需理解数据结构。
 *
 * 设计：docs/superpowers/specs/2026-08-02-item-detail-summary-design.md §3.1
 */

import type { Modifier } from './effect-types';

/** 检定类型 → 中文措辞（attribute 存在时覆盖 checkType） */
function checkLabel(m: Extract<Modifier, { category: '检定' }>): string {
  return m.attribute ? `${m.attribute}检定` : `${m.checkType}检定`;
}

/** 单个 modifier → 中文行；无法描述（amount=0 等）返回 ''（调用方过滤） */
export function describeModifier(m: Modifier): string {
  let body: string;
  switch (m.category) {
    case '固伤':
      // amount<=0 无意义，返回 '' 由 describeModifiers 过滤
      if (m.amount <= 0) return '';
      body = m.damageType ? `造成 ${m.amount} 点${m.damageType}伤害` : `造成 ${m.amount} 点伤害`;
      break;
    case '百分比': {
      const sign = m.coefficient >= 0 ? '+' : '';
      const label = m.target === 'damage' ? '伤害' : m.target === 'heal' ? '治疗' : '资源';
      body = `${label} ${sign}${Math.round(m.coefficient * 100)}%`;
      break;
    }
    case '资源': {
      const verb = m.amount >= 0 ? '回复' : '消耗';
      body = `${verb} ${Math.abs(m.amount)} 点${m.resource.toUpperCase()}`;
      break;
    }
    case '检定':
      body = `${checkLabel(m)} ${m.bonus >= 0 ? '+' : ''}${m.bonus}`;
      break;
    case '附加效果':
      body = `附加 ${m.buffName}${m.stacks && m.stacks > 1 ? ` ${m.stacks}层` : ''}`;
      break;
    case '特殊机制':
      body = specialMechanismText(m.mechanism, m.value);
      break;
  }

  if (m.condition) {
    const cond = translateCondition(m.condition);
    if (cond) body = `[${cond}] ${body}`;
  }
  if (m.source) body += `（来源：${m.source}）`;
  return body;
}

/** 特殊机制 → 中文（value 按机制解释） */
function specialMechanismText(mechanism: string, value: number): string {
  switch (mechanism) {
    case 'DR':
      return `减伤 ${value}%`;
    case '穿透':
      return `穿透 ${value}%`;
    case '暴击倍率':
      return `暴击倍率 ×${value}`;
    case '召唤':
      return `可召唤（${value}）`;
    case '光环':
      return `光环效果（${value}）`;
    case '规则改写':
      return `规则改写（${value}）`;
    default:
      return `特殊机制（${value}）`;
  }
}

/** EJS 风格条件 → 可读中文（只做常见形态，识别不了原样保留） */
function translateCondition(cond: string): string {
  const hp = cond.match(/\{\{target\.hpPercent\}\}\s*<\s*([\d.]+)/);
  if (hp) return `目标HP<${Math.round(parseFloat(hp[1]) * 100)}%`;
  const hpGt = cond.match(/\{\{target\.hpPercent\}\}\s*>\s*([\d.]+)/);
  if (hpGt) return `目标HP>${Math.round(parseFloat(hpGt[1]) * 100)}%`;
  return cond;
}

/** 批量翻译，过滤空行 */
export function describeModifiers(list: Modifier[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.map(describeModifier).filter((s) => s.length > 0);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/sillytavern/describe-modifier.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/sillytavern/describe-modifier.ts src/sillytavern/describe-modifier.test.ts
git commit -m "feat(items): describe-modifier 纯函数 —— Modifier 6 大类中文摘要
   - 固伤/百分比/资源/检定/附加效果/特殊机制全量翻译
   - condition → 目标HP<xx% / source 尾注
   - 批量入口过滤空行；单测覆盖 6 大类 + 边界"
```

---

### Task 2: describe-automaton.ts —— EffectAutomatonDecl 中文翻译

**Files:**
- Create: `src/sillytavern/describe-automaton.ts`
- Test: `src/sillytavern/describe-automaton.test.ts`

**Interfaces:**
- Consumes: `EffectAutomatonDecl` / `EffectIntent` / `WindowKey` / `ModifierSlot`（`src/sillytavern/combat-v3/types.ts`）
- Produces: `describeAutomaton(a: EffectAutomatonDecl): string[]` — 一个 automaton → 中文行数组（按 intent 展开，每 intent 一行）；`describeAutomata(list: EffectAutomatonDecl[] | undefined): string[]` — 批量

- [ ] **Step 1: 写失败测试**

```ts
// src/sillytavern/describe-automaton.test.ts
import { describe, it, expect } from 'vitest';
import { describeAutomaton, describeAutomata } from './describe-automaton';
import type { EffectAutomatonDecl } from './combat-v3/types';

function makeA(over: Partial<EffectAutomatonDecl>): EffectAutomatonDecl {
  return {
    id: 'a1',
    subscribe: 'damage.after',
    trigger: 'true',
    intents: [{ kind: 'DealDamage', targetId: 'target', amount: 3, damageType: 'physical' }],
    ...over,
  };
}

describe('describeAutomaton 窗口中文', () => {
  it('damage.after → 受击时', () => {
    const a = makeA({});
    expect(describeAutomaton(a)[0]).toContain('受击时');
  });
  it('check.hit → 命中检定时', () => {
    const a = makeA({ subscribe: 'check.hit' });
    expect(describeAutomaton(a)[0]).toContain('命中检定时');
  });
  it('turn.open → 回合开始时', () => {
    const a = makeA({ subscribe: 'turn.open' });
    expect(describeAutomaton(a)[0]).toContain('回合开始时');
  });
});

describe('describeAutomaton trigger 条件', () => {
  it('target.hpPercent < 0.5 → 目标HP<50%', () => {
    const a = makeA({ trigger: 'target.hpPercent < 0.5' });
    expect(describeAutomaton(a)[0]).toContain('目标HP<50%');
  });
  it('trigger 恒真 → 无条件', () => {
    const a = makeA({ trigger: 'true' });
    expect(describeAutomaton(a)[0]).not.toContain('[');
  });
});

describe('describeAutomaton intents 13 类', () => {
  it('DealDamage', () => {
    expect(describeAutomaton(makeA({}))[0]).toBe('受击时：造成 3 点物理伤害');
  });
  it('AddModifier hitBonus', () => {
    const a = makeA({
      intents: [{ kind: 'AddModifier', slot: 'hitBonus', value: 5, scope: 'whole_action', targetId: 'self', divinity: 0 }],
    });
    expect(describeAutomaton(a)[0]).toContain('命中 +5');
  });
  it('Heal', () => {
    const a = makeA({ intents: [{ kind: 'Heal', targetId: 'self', amount: 20 }] });
    expect(describeAutomaton(a)[0]).toContain('回复 20 点HP');
  });
  it('ApplyStatus', () => {
    const a = makeA({ intents: [{ kind: 'ApplyStatus', targetId: 'target', statusId: 'bleed', duration: 3, layers: 2 }] });
    expect(describeAutomaton(a)[0]).toContain('附加 流血 2层');
  });
  it('ApplyStatus 无层数', () => {
    const a = makeA({ intents: [{ kind: 'ApplyStatus', targetId: 'target', statusId: 'poison', duration: 2 }] });
    expect(describeAutomaton(a)[0]).toContain('附加 中毒');
  });
});

describe('describeAutomata 批量', () => {
  it('空 → 空数组', () => {
    expect(describeAutomata(undefined)).toEqual([]);
  });
  it('多 automaton 拼接', () => {
    const list = [makeA({}), makeA({ subscribe: 'turn.open' })];
    const lines = describeAutomata(list);
    expect(lines.length).toBe(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/sillytavern/describe-automaton.test.ts`
Expected: FAIL — `Cannot find module './describe-automaton'`

- [ ] **Step 3: 写最小实现**

```ts
// src/sillytavern/describe-automaton.ts
/**
 * describe-automaton.ts —— EffectAutomatonDecl（DSL 自由效果）→ 人类可读中文摘要
 *
 * 纯函数模块：零 I/O、零 Vue、零 Dexie。automaton 是 DSL 内部表示，不适合裸展示；
 * 本模块把「订阅窗口 + 触发条件 + intents」翻译成玩家能懂的中文行。
 *
 * 设计：docs/superpowers/specs/2026-08-02-item-detail-summary-design.md §3.2
 */

import type {
  EffectAutomatonDecl,
  EffectIntent,
  ModifierSlot,
  WindowKey,
} from './combat-v3/types';

/** 18 窗口 → 中文（按 combat-v3/types.ts WindowKey 全量） */
const WINDOW_CN: Record<WindowKey, string> = {
  'round.open': '回合开始时',
  'round.close': '回合结束时',
  'initiative.before': '先攻判定前',
  'initiative.after': '先攻判定后',
  'turn.open': '回合开始时',
  'turn.close': '回合结束时',
  'action.declared': '声明行动时',
  'check.intent': '检定意图时',
  'check.hit': '命中检定时',
  collect_attacker_mods: '攻击修正收集中',
  collect_defender_mods: '防御修正收集中',
  'damage.preview': '伤害预览时',
  'damage.compute': '伤害计算时',
  'damage.after': '受击时',
  'unit.beforeDown': '单位倒地前',
  'morale.before': '士气判定前',
  'morale.after': '士气判定后',
  'settlement.before': '战斗结算前',
};

/** ModifierSlot → 中文 */
const SLOT_CN: Record<ModifierSlot, string> = {
  fixedDamage: '固伤',
  damageMult: '伤害倍率',
  damageTaken: '受伤',
  hitBonus: '命中',
  dodge: '闪避',
  initiative: '先攻',
  dr: '减伤',
  penetration: '穿透',
  critThreshold: '暴击阈值',
  critDmg: '暴击伤害',
  attribute: '属性',
};

/** DamageType → 中文（effect-types 里是中文枚举，直接透传） */
function damageTypeCN(t: string): string {
  const map: Record<string, string> = {
    physical: '物理',
    energy: '能量',
    mental: '精神',
    true: '真实',
  };
  return map[t] ?? t;
}

/** statusId → 中文（常见状态名的英文 id；未知原样透传） */
const STATUS_CN: Record<string, string> = {
  bleed: '流血',
  poison: '中毒',
  burn: '灼烧',
  stun: '眩晕',
  freeze: '冰冻',
  slow: '减速',
  weaken: '虚弱',
  shield: '护盾',
  regen: '再生',
};

/** 单个 intent → 中文 */
function describeIntent(intent: EffectIntent): string {
  switch (intent.kind) {
    case 'AddModifier': {
      const v = intent.value;
      const sign = typeof v === 'number' && v >= 0 ? '+' : '';
      return `${SLOT_CN[intent.slot] ?? intent.slot} ${sign}${v}`;
    }
    case 'DealDamage':
      return `造成 ${intent.amount} 点${damageTypeCN(intent.damageType)}伤害`;
    case 'Heal':
      return `回复 ${intent.amount} 点HP`;
    case 'ApplyStatus':
      return `附加 ${STATUS_CN[intent.statusId] ?? intent.statusId}${intent.layers && intent.layers > 1 ? ` ${intent.layers}层` : ''}`;
    case 'RemoveStatus':
      return `移除${STATUS_CN[intent.statusId] ?? intent.statusId}`;
    case 'SpendResource':
      return `消耗 ${intent.amount} 点${intent.resource.toUpperCase()}`;
    case 'PreventDeath':
      return '免死一次';
    case 'ConsumeCharge':
      return `消耗 ${intent.amount ?? 1} 次充能`;
    case 'EmitNarrativeCue':
      return `提示：${intent.text}`;
    case 'OverrideIntent':
      return `覆盖${intent.ruleKey}行动`;
    case 'ScheduleIntent':
      return `延后：${describeIntent(intent.intent)}`;
    case 'SpawnOrDespawnIntent':
      return `${intent.op === 'spawn' ? '召唤' : '移除'} ${intent.unitId}`;
    case 'RequestChoiceIntent':
      return `要求选择：${intent.prompt}`;
  }
}

/** trigger 表达式 → 条件中文（常见形态；识别不了原样保留） */
function translateTrigger(trigger: string): string {
  const t = trigger.trim();
  if (t === 'true' || t === '') return '';
  const hp = t.match(/target\.hpPercent\s*<\s*([\d.]+)/);
  if (hp) return `目标HP<${Math.round(parseFloat(hp[1]) * 100)}%`;
  const hpGt = t.match(/target\.hpPercent\s*>\s*([\d.]+)/);
  if (hpGt) return `目标HP>${Math.round(parseFloat(hpGt[1]) * 100)}%`;
  const status = t.match(/target\.hasStatus\(['"](\w+)['"]\)/);
  if (status) return `目标处于${status[1]}状态`;
  return t;
}

/** 一个 automaton → 中文行数组（每 intent 一行，行首带窗口+条件） */
export function describeAutomaton(a: EffectAutomatonDecl): string[] {
  const windowCN = WINDOW_CN[a.subscribe] ?? a.subscribe;
  const cond = translateTrigger(a.trigger);
  const prefix = cond ? `${windowCN}[${cond}]：` : `${windowCN}：`;
  const lines = a.intents.map(describeIntent).filter((s) => s.length > 0);
  return lines.map((line) => prefix + line);
}

/** 批量翻译，空数组返回空 */
export function describeAutomata(list: EffectAutomatonDecl[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap(describeAutomaton);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/sillytavern/describe-automaton.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/sillytavern/describe-automaton.ts src/sillytavern/describe-automaton.test.ts
git commit -m "feat(items): describe-automaton 纯函数 —— 18 窗口 + 13 类 EffectIntent 中文摘要
   - 窗口/槽位/伤害类型全量中文映射
   - trigger 表达式 → 目标HP<xx% 等可读条件
   - 每 intent 一行；批量入口；单测覆盖"
```

---

### Task 3: ItemDetailModal.vue + ItemsPanel 接线

**Files:**
- Create: `src/ui/components/game/ItemDetailModal.vue`
- Modify: `src/ui/components/game/ItemsPanel.vue`

**Interfaces:**
- Consumes: `describeModifiers`（Task 1）、`describeAutomata`（Task 2）、`AppModal`（`src/ui/components/shared/AppModal.vue`）、`qualityVar`（`src/ui/lib/quality-colors.ts`）
- Produces: `ItemDetailModal` 组件（props: `open` / `item: any` / `category`；emits: `update:open`）

- [ ] **Step 1: 创建 ItemDetailModal.vue**

```vue
<script setup lang="ts">
/**
 * ItemDetailModal.vue —— 物品/技能/装备详情弹窗（轻量摘要 + 原始数据折叠）
 *
 * 设计：docs/superpowers/specs/2026-08-02-item-detail-summary-design.md §3.3
 *
 * 分层：默认只展示人读的摘要（effects 词条 + 战斗修正 + 描述）；
 *      点「查看原始数据」才暴露 modifiers/automata/scripts 的原始 JSON/代码。
 */
import { computed, ref } from 'vue';
import AppModal from '../shared/AppModal.vue';
import { describeModifiers } from '@engine/describe-modifier';
import { describeAutomata } from '@engine/describe-automaton';
import { qualityVar } from '../../lib/quality-colors';

const props = defineProps<{
  open: boolean;
  item: any;
  category: string;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const showRaw = ref(false);

const selQuality = computed(() => {
  const item = props.item;
  if (!item) return '普通';
  if (item.rarity) return item.rarity;
  if (props.category === 'skills') return '史诗';
  return '普通';
});

const selTypeLabel = computed(() => {
  const item = props.item;
  if (!item) return '';
  if (props.category === 'equipment') return item.equippedSlot || '装备';
  if (props.category === 'skills') return item.type === 'active' ? '主动技能' : '被动技能';
  return item.type || '物品';
});

const selExtra = computed(() => {
  const item = props.item;
  if (!item) return '';
  if (props.category === 'inventory') return `×${item.quantity || 1}`;
  if (props.category === 'equipment')
    return `${item.durability || '?'}/${item.maxDurability || '?'} 耐久`;
  return `Lv.${item.level || 1}`;
});

const effects = computed(() => props.item?.effects as Record<string, string> | undefined);
const hasEffects = computed(() => !!effects.value && Object.keys(effects.value).length > 0);

const modifierLines = computed(() => describeModifiers(props.item?.modifiers));
const automatonLines = computed(() => describeAutomata(props.item?.automata));
const combatLines = computed(() => [...modifierLines.value, ...automatonLines.value]);
const hasCombat = computed(() => combatLines.value.length > 0);

const hasScripts = computed(
  () => !!props.item?.scripts && Object.keys(props.item.scripts).length > 0,
);

/** 原始数据 JSON（modifiers + automata） */
const rawCombatJson = computed(() => {
  const parts: string[] = [];
  if (props.item?.modifiers?.length) parts.push(JSON.stringify(props.item.modifiers, null, 2));
  if (props.item?.automata?.length) parts.push(JSON.stringify(props.item.automata, null, 2));
  return parts.join('\n\n');
});

watch(
  () => props.open,
  (val) => {
    if (val) showRaw.value = false;
  },
);
</script>

<template>
  <AppModal
    :open="open"
    :title="item?.name || '详情'"
    size="md"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="item" class="idm">
      <!-- 元信息行 -->
      <div class="idm-meta">
        <span>{{ selTypeLabel }}</span>
        <span class="idm-quality" :style="{ color: qualityVar(selQuality) }">{{
          selQuality
        }}</span>
        <span>{{ selExtra }}</span>
      </div>

      <!-- 效果词条 -->
      <div v-if="hasEffects" class="idm-section">
        <div class="idm-label">效果</div>
        <div v-for="(desc, name) in effects" :key="name" class="idm-row">
          <span class="idm-k">{{ name }}</span><span>{{ desc }}</span>
        </div>
      </div>

      <!-- 战斗修正（modifiers + automata 摘要） -->
      <div class="idm-section">
        <div class="idm-label">战斗修正</div>
        <div v-if="hasCombat" class="idm-combat">
          <div v-for="(line, i) in combatLines" :key="i" class="idm-combat-row">
            <span class="idm-combat-icon">⚔</span>{{ line }}
          </div>
        </div>
        <div v-else class="idm-empty">该物品无战斗效果</div>
      </div>

      <!-- 描述 -->
      <div v-if="item.description" class="idm-section">
        <div class="idm-label">描述</div>
        <p class="idm-desc">{{ item.description }}</p>
      </div>

      <!-- 原始数据折叠 -->
      <div class="idm-raw">
        <button class="idm-raw-toggle" @click="showRaw = !showRaw">
          {{ showRaw ? '收起原始数据' : '查看原始数据' }}
        </button>
        <div v-if="showRaw" class="idm-raw-body">
          <template v-if="rawCombatJson || hasScripts">
            <div v-if="rawCombatJson" class="idm-raw-block">
              <div class="idm-raw-label">modifiers / automata</div>
              <pre class="idm-raw-code">{{ rawCombatJson }}</pre>
            </div>
            <div v-if="hasScripts" class="idm-raw-block">
              <div class="idm-raw-label">scripts</div>
              <div v-for="(code, name) in item.scripts" :key="name" class="idm-raw-script">
                <div class="idm-raw-name">{{ name }}</div>
                <pre class="idm-raw-code">{{ code }}</pre>
              </div>
            </div>
          </template>
          <div v-else class="idm-empty">该物品无原始数据</div>
        </div>
      </div>
    </div>
  </AppModal>
</template>
```

- [ ] **Step 2: ItemsPanel.vue 加弹窗入口**

在 `<script setup>` 顶部 import 处加：

```ts
import ItemDetailModal from './ItemDetailModal.vue';
```

在 `selected` computed 之后加：

```ts
const detailOpen = ref(false);
function openDetail() {
  if (selected.value) detailOpen.value = true;
}
```

在模板最外层 `</div>` 前（`v-else class="empty"` 之后）加：

```html
<ItemDetailModal
  :open="detailOpen"
  :item="selected"
  :category="activeCategory"
  @update:open="detailOpen = $event"
/>
```

> 📌 沿用项目惯例（见 GamePage.vue:205 的 AppModal 用法）：`:open` + `@update:open`，
> 不写 `v-model`。AppModal 内部 `doClose()` 会同时 emit `update:open` 与 `close`，
> 只接 `update:open` 即可关闭。

- [ ] **Step 3: 加列表行点击触发**

在列表行 `@click="selectedIdx = i"` 处改为 `@click="selectedIdx = i; openDetail()"`：

```html
<div
  v-for="(item, i) in sortedItems"
  :key="(item as any).name || i"
  class="item-row"
  :class="{ selected: i === selectedIdx }"
  @click="selectedIdx = i; openDetail()"
>
```

- [ ] **Step 4: 样式**（追加到 ItemsPanel.vue 的 `<style scoped>` 末尾，或 ItemDetailModal 自己的 scoped style）

在 `ItemDetailModal.vue` 内追加 `<style scoped>`：

```vue
<style scoped>
.idm {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.idm-meta {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  padding-bottom: 10px;
  border-bottom: 1px solid var(--theme-card-border);
}
.idm-quality {
  font-weight: 600;
  font-size: 0.6875rem;
  padding: 1px 8px;
  border-radius: var(--theme-radius-sm);
  border: 1px solid currentColor;
}
.idm-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.idm-label {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.idm-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.idm-row {
  display: flex;
  gap: 10px;
  padding: 2px 0;
  font-size: 0.8125rem;
}
.idm-k {
  color: var(--theme-text-secondary);
  min-width: 4.375rem;
  font-weight: 500;
}
.idm-combat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.idm-combat-row {
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.idm-combat-icon {
  color: var(--theme-primary, #c9a24b);
  font-size: 0.75rem;
}
.idm-empty {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-style: italic;
}
.idm-desc {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.7;
  margin: 0;
  font-style: italic;
}
.idm-raw {
  margin-top: auto;
  border-top: 1px solid var(--theme-card-border);
  padding-top: 8px;
}
.idm-raw-toggle {
  padding: 5px 10px;
  border: 1px solid var(--theme-card-border);
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  cursor: pointer;
  font-family: inherit;
  border-radius: var(--theme-radius-sm, 4px);
  transition: color 0.15s;
}
.idm-raw-toggle:hover {
  color: var(--theme-text-primary);
}
.idm-raw-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.idm-raw-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.idm-raw-label {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-weight: 600;
}
.idm-raw-name {
  font-size: 0.6875rem;
  color: var(--theme-accent, #f59e0b);
  font-weight: 600;
}
.idm-raw-code {
  background: #0d1117;
  color: #c9d1d9;
  font-family: 'Cascadia Code', 'JetBrains Mono', monospace;
  font-size: 0.625rem;
  padding: 10px;
  border-radius: var(--theme-radius-sm, 4px);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 200px;
  overflow-y: auto;
}
.idm-raw-script {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
```

- [ ] **Step 5: typecheck 验证**

Run: `npm run typecheck && npm run typecheck:vue`
Expected: 0 错误（若 `@engine/describe-*` alias 不解析，改用相对路径 import）

- [ ] **Step 6: 相关测试跑通**

Run: `npx vitest run src/sillytavern/describe-modifier.test.ts src/sillytavern/describe-automaton.test.ts`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/components/game/ItemDetailModal.vue src/ui/components/game/ItemsPanel.vue
git commit -m "feat(items): 详情弹窗 ItemDetailModal + ItemsPanel 接线
   - 复用 AppModal，右上角叉叉/Escape/遮罩关闭
   - 轻量摘要: 效果词条 + 战斗修正(modifiers+automata 中文) + 描述
   - 查看原始数据折叠: modifiers/automata JSON + scripts 代码
   - 列表行点击弹出; typecheck + 单测通过"
```

---

### Task 4: 集成验证 + backlog 同步

**Files:**
- Modify: `docs/planning/combat-v3-fix-backlog.md`（标 ✅）
- Test: 全量测试

- [ ] **Step 1: 全量测试**

Run: `npm run test -- --run`
Expected: 全部 PASS（应新增 describe-modifier + describe-automaton 两组测试）

- [ ] **Step 2: 手动核对展示**（若主人允许开浏览器）

在 dev server 打开游戏页 → 打开 ItemsPanel → 点击有 modifiers/automata 的物品 → 确认弹窗摘要行正确、点「查看原始数据」暴露 JSON、右上角叉叉关闭。

- [ ] **Step 3: 更新 backlog**

在 `docs/planning/combat-v3-fix-backlog.md` 把最后一项 `🟡 前端 ItemsPanel 缺 modifiers 展示` 标 ✅，并注明实现落点。

- [ ] **Step 4: Commit**

```bash
git add docs/planning/combat-v3-fix-backlog.md
git commit -m "docs(backlog): ItemsPanel modifiers 展示 ✅ 完成（详情弹窗轻量摘要）
   - 见 spec 2026-08-02-item-detail-summary-design + 实现计划"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §2 交互（弹窗+叉叉）→ Task 3；§3.1 describe-modifier → Task 1；§3.2 describe-automaton → Task 2；§3.3 弹窗组件 → Task 3；§3.4 ItemsPanel 接线 → Task 3；§4 测试 → Task 1/2/4。全部覆盖 ✓
- **Placeholder 扫描**：无 TBD/TODO；每步含实际代码 ✓
- **类型一致性**：`describeModifier`/`describeModifiers`/`describeAutomaton`/`describeAutomata` 签名在 Task 1/2/3 间一致；`AppModal` props/emits 与现有组件一致；`Modifier`/`EffectAutomatonDecl` 字段与 spec 引用的代码一致 ✓
