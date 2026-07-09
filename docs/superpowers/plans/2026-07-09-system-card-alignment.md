# 系统卡片对齐原版 + 文档规范 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将系统卡片（Craft/Combat/CharGen/ItemGen/SystemNotifBar）对齐原版 v4.2.1 角色卡的 UI 模式 + 补全设计规范文档

**Architecture:** 两步走——(1) 写规范文档定义所有卡片组件的输入/输出契约和样式标准，(2) 逐组件对齐：替换硬编码 hex 为全局 CSS 变量、加入虚线分隔、品质色边框、可折叠 panel header、StatBadge 统一组件

**Tech Stack:** Vue 3 + TypeScript + scoped CSS + CSS 自定义属性（10 主题已有 `--theme-quality-*` / `--theme-hp/mp/sp/exp`）

## Global Constraints

- 不引入新依赖。使用已有的 `--theme-quality-*` / `--theme-hp/mp/sp/exp` CSS 变量
- 所有品质色的显示必须用 `var(--theme-quality-xxx)`，禁止组件内硬编码 hex
- 战斗卡片只参考配色结构（不展示完整回合级伤害计算）
- 中文命名：组件用拼音/中文均可，CSS class 用 kebab-case 英文
- 每个卡片需支持 `type` 字段对应的数据形状（见 types.ts `SystemEvent` 联合类型）
- 必须写测试 — 每个修改后的卡片组件需要 Vitest 渲染测试
- 遵循 CLAUDE.md 中 ADR-11（确定性逻辑归 Code，创造性逻辑归 Prompt）和 ADR-20（声明式优先）

---

## Task 1: 系统卡片设计规范文档

**Files:**
- Create: `docs/reference/system_card_spec.md`

**Interfaces:**
- Consumes: 考察 `src/sillytavern/types.ts` 中的 `SystemEvent` 联合类型（7 个子类型：Craft / CharGen / ItemGen / Combat / CharacterUpdate / ItemUpdate / QuestUpdate）；`src/ui/lib/toSystemEvent.ts` 工厂函数；5 个卡片组件现有代码；原版 `reference/v4.2.1_chara_card.json` 中的 beautifyRow 规则和 char_info 样式
- Produces: 一份规范文档，定义每个卡片类型的输入 contract、输出 UI 结构、CSS class 命名、色彩变量引用

- [ ] **Step 1: 阅读所有相关源码**

确保理解每个 SystemEvent 子类型的字段结构和现有卡片实现：
```
CraftSystemEvent: { type, productName, quality, rating, narrative, details: CraftAgentOutput }
  - details.difficultyJudgment: { dcModifier, reasoning }
  - details.creativeEffects[]: { name, description, type, effects?, duration?, ... }
  - details.effectDeclarations[]
  - details.narrativeFlavor
  - details.craftToolCall: { industry, productName, targetQuality, quantity, materials[], expects? }

CharGenSystemEvent: { type, characterName, race, tier, narrative, details: CharGenOutput }
  - details.attributes: { str, dex, con, int, spi }
  - details.identity[], occupation[], background, appearance, clothing, personality, likes
  - details.skills[], equipment[], inventory[]
  - details.ascension: { enabled, path, elements[], authorities[], laws[], ... }

ItemGenSystemEvent: { type, itemName, quality, itemType, narrative, details: ItemGenOutput }
  - details.skills[], equipment[], inventory[]

CombatSystemEvent: { type, outcome, narrative, details: CombatSummaryResult }
  - details.narrativeSummary, rounds, totalExp, totalFp, loot[], outcome

CharacterUpdateEvent: { type, characterName, narrative }
ItemUpdateEvent: { type, itemName, operation, narrative }
QuestUpdateEvent: { type, questName, status, narrative }
```

- [ ] **Step 2: 分析原版 UI 模式**

从子 Agent 的调研结果中归纳原版的 UI 约定：
- 品质色边框：卡片左边框使用 `--theme-quality-*` 色值（原版 `border-left: 3px solid`）
- 虚线分隔：卡片内部的 section 之间用 `border-top: 1px dashed var(--theme-card-border)` 分隔
- Panel header：`font-size: 12px; font-weight: 700; padding: 12px 12px 8px`，可折叠
- 卡片 body：`padding: 0 12px 12px`，内部 gap: 8px
- 品质色徽章：用已存在的 `QualityBadge.vue` 组件，不再重复造
- 标签/词条：参考原版 `effect-name` 模式（`display: inline-flex; padding: 1px 6px; border-radius: 3px; border: 1px solid;`）
- 资源条：已有 `ResourceBar.vue` 组件，用 `--theme-hp/mp/sp/exp` 色值

- [ ] **Step 3: 起草规范文档**

```markdown
# 系统卡片设计规范

## 1. 概述
系统卡片是 ChatFlow 三源消息系统中 `role='system'` 消息的展开态 UI。
每个卡片对应一种 `SystemEvent.type`，接收 `SystemEvent` 数据作为 props。

## 2. 通用 CSS 变量引用
| 用途 | 变量 |
|------|------|
| 普通品质色 | `var(--theme-quality-common)` → #e2e8f0 |
| 优良品质色 | `var(--theme-quality-uncommon)` → #56bf7b |
| 稀有品质色 | `var(--theme-quality-rare)` → #5d97ff |
| 史诗品质色 | `var(--theme-quality-epic)` → #9a72f8 |
| 传说品质色 | `var(--theme-quality-legendary)` → #e5c166 |
| 神话品质色 | `var(--theme-quality-mythic)` → #e4587d |
| 唯-品质色 | `var(--theme-quality-unique)` → #f09f4d |
| HP 色 | `var(--theme-hp)` |
| MP 色 | `var(--theme-mp)` |
| SP 色 | `var(--theme-sp)` |
| EXP 色 | `var(--theme-exp)` |

## 3. 通用卡片结构
每个卡片统一使用以下 HTML 骨架：

```html
<div class="sys-card">
  <div class="sys-card-header" @click="toggle">
    <i :class="iconClass" />
    <span class="sys-card-title">{{ title }}</span>
    <!-- 可选: QualityBadge 组件 -->
    <i class="fa-solid fa-chevron-down sys-card-chevron" :class="{ rotated: open }" />
  </div>
  <div class="sys-card-body" v-show="open">
    <!-- 具体内容 -->
  </div>
</div>
```

## 4. CraftSystemCard
- 输入: `CraftSystemEvent`
- 标题: `{quality} · {productName}` (品质色背景)
- 折叠 header: 🛡️ 图标 + 标题 + 品质徽章 + chevron
- 展开 body:
  1. 检定摘要行 (rating 图标 + rating 文字 + dcModifier 说明)
     - "大失败" → fa-circle-xmark + #ef4444
     - "失败" → fa-triangle-exclamation + #f59e0b
     - "成功" → fa-circle-check + #22c55e
     - "精益求精" → fa-star + #eab308
  2. 虚线分隔
  3. 材料列表（灰色标签 "材料:" + 文字）
  4. 虚线分隔
  5. 词条列表（每条: 词条名 badge + 效果描述）
     - type='增益' → 绿色边框
     - type='减益' → 红色边框
     - type='特殊' → 主题色边框
  6. 虚线分隔
  7. 结算行: EXP badge + FP badge

## 5. CharGenSystemCard
- 输入: `CharGenSystemEvent`
- 标题: `{characterName} · T{tier} · {race}`
- 折叠 header: 角色图标 + 名字 + tier badge (主题色) + 种族
- 展开 body:
  1. 五维属性行（每项: 小icon + 数值，颜色用层级色映射）
  2. 身份标签行 (tag badges)
  3. 虚线分隔
  4. 背景故事 (max 200 字，截断)
  5. 如有技能/装备: 虚线分隔 + 技能名列表 + 装备名列表

## 6. CombatSystemCard
- 输入: `CombatSystemEvent`
- 标题: `{胜负} · {rounds}回合`
- 折叠 header: 结果图标（胜利=🏆替代 fa-trophy / 败北=fa-skull / 平局=fa-handshake / 逃跑=fa-person-running）+ outcome label + 回合数
- 展开 body:
  1. 战斗叙事摘要
  2. 虚线分隔（如有战利品）
  3. 战利品列表（loot item badges）
  4. 虚线分隔
  5. 结算: EXP badge + FP badge

## 7. ItemGenSystemCard
- 输入: `ItemGenSystemEvent`
- 标题: `{itemName} ({quality})`
- 折叠 header: 类型图标 + 名称 + quality badge
- 展开 body:
  1. 如有装备: "装备" label + 装备列表（每行: slot badge + description）
  2. 如有技能: "技能" label + 技能列表（每行: name + description）
  3. 如有物品: "物品" label + 物品列表（每行: name ×quantity + description）

## 8. SystemNotifBar
- 输入: `CharacterUpdateEvent | ItemUpdateEvent | QuestUpdateEvent`
- 始终展开（无折叠）
- 样式: 细条通知栏，左侧图标 + narrative 文字
- character_update → fa-arrow-trend-up
- item_update → fa-boxes-stacked
- quest_update → fa-list-check

## 9. 通用 StatBadge 子组件
```
props: { label: string, value: string|number, color?: string }
→ <span class="stat-badge"><span class="label">{label}</span> {value}</span>
```
所有 EXP/FP/HP/MP/SP 结算数字统一使用此组件。

## 10. 可用图标映射
| 内容 | Font Awesome class |
|------|-------------------|
| 制作/锻造 | fa-solid fa-hammer |
| 新角色 | fa-solid fa-user-plus |
| 获得物品 | fa-solid fa-gift |
| 战斗 | fa-solid fa-hand-fist |
| 角色更新 | fa-solid fa-arrow-trend-up |
| 物品更新 | fa-solid fa-boxes-stacked |
| 任务更新 | fa-solid fa-list-check |
| STR | fa-solid fa-dumbbell |
| DEX | fa-solid fa-bolt |
| CON | fa-solid fa-shield-heart |
| INT | fa-solid fa-brain |
| SPI | fa-solid fa-star |
| HP | fa-solid fa-heart |
| MP | fa-solid fa-wand-magic-sparkles |
| SP | fa-solid fa-bolt |
```

- [ ] **Step 4: 保存文档**

```bash
# 创建 docs/reference/system_card_spec.md
```

- [ ] **Step 5: Commit**

```bash
git add docs/reference/system_card_spec.md
git commit -m "docs: add system card design specification"
```

---

## Task 2: 将品质色映射统一提取为 shared composable

**Files:**
- Create: `src/ui/lib/quality-colors.ts`
- Modify: `src/ui/components/game/cards/CraftSystemCard.vue` — 移除本地 qualityColors，改用 composable
- Modify: `src/ui/components/game/cards/ItemSystemCard.vue` — 同上
- Modify: `src/ui/components/game/ItemsPanel.vue` — 同上
- Modify: `src/ui/components/game/CharacterListPanel.vue` — 同上

**Interfaces:**
- Consumes: 10 主题的 `--theme-quality-*` CSS 变量名约定
- Produces: `QUALITY_VAR(key: string): string` 函数 — 传入中文品质名返回 CSS 变量引用

- [ ] **Step 1: 创建 quality-colors.ts**

```typescript
// quality-colors.ts
// 通用的品质色 CSS 变量映射，所有组件通过此文件获取品质色，
// 而非硬编码 hex 值

/** 品质中文名 → CSS 自定义属性名 */
const QUALITY_TO_VAR: Record<string, string> = {
  '普通': '--theme-quality-common',
  '优良': '--theme-quality-uncommon',
  '稀有': '--theme-quality-rare',
  '史诗': '--theme-quality-epic',
  '传说': '--theme-quality-legendary',
  '神话': '--theme-quality-mythic',
  '唯一': '--theme-quality-unique',
}

/** 返回 CSS var() 引用，用于内联 style 绑定 */
export function qualityVar(quality: string): string {
  const varName = QUALITY_TO_VAR[quality]
  if (!varName) return '#9ca3af' // fallback 灰色
  return `var(${varName})`
}

/** 返回原始 CSS 变量名，用于动态 class 生成 */
export function qualityVarName(quality: string): string {
  return QUALITY_TO_VAR[quality] ?? '--theme-quality-common'
}
```

- [ ] **Step 2: 更新 CraftSystemCard**

替换本地 `qualityColors` 为 `qualityVar()` 调用：

```vue
<script setup lang="ts">
import type { CraftSystemEvent } from '@engine/types'
import { qualityVar } from '../../../lib/quality-colors'
defineProps<{ event: CraftSystemEvent }>()
// ... ratingIcons 保留
</script>

<template>
  <div class="craft-card">
    <!-- 替换 :style="{ background: qualityColors[...] }" -->
    <div class="card-top" :style="{ background: qualityVar(event.quality) }">
```

- [ ] **Step 3: 同步骤更新 ItemSystemCard、ItemsPanel、CharacterListPanel**

- [ ] **Step 4: 验证编译**

```bash
npm run typecheck
npm run test -- --run
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/lib/quality-colors.ts src/ui/components/game/cards/CraftSystemCard.vue \
        src/ui/components/game/cards/ItemSystemCard.vue src/ui/components/game/ItemsPanel.vue \
        src/ui/components/game/CharacterListPanel.vue
git commit -m "refactor(ui): extract quality color mapping to shared composable"
```

---

## Task 3: 重构 CraftSystemCard 对齐原版规范

**Files:**
- Modify: `src/ui/components/game/cards/CraftSystemCard.vue` — 全面重写
- Create: `tests/ui/components/CraftSystemCard.test.ts` — 渲染测试

**Interfaces:**
- Consumes: `CraftSystemEvent` 类型
- Produces: `<CraftSystemCard :event="..." />` 组件
- Props: `{ event: CraftSystemEvent }`

- [ ] **Step 1: 写测试**

```typescript
// tests/ui/components/CraftSystemCard.test.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CraftSystemCard from '../../../src/ui/components/game/cards/CraftSystemCard.vue'
import type { CraftSystemEvent } from '@engine/types'

describe('CraftSystemCard', () => {
  const mockEvent: CraftSystemEvent = {
    type: 'craft',
    productName: '霜月之刃',
    quality: '传说',
    rating: '成功',
    narrative: '[制作] 传说级 霜月之刃',
    details: {
      difficultyJudgment: { dcModifier: 3, reasoning: '使用稀有材料' },
      creativeEffects: [
        { name: '冰焰双刃', description: '冰霜与火焰', type: '增益', effects: { atk: 8 } },
        { name: '铸魂残留', description: '灵魂绑定', type: '特殊' },
      ],
      effectDeclarations: ['atk: +8'],
      narrativeFlavor: '锤落下...',
      craftToolCall: {
        industry: '锻造', productName: '霜月之刃',
        targetQuality: '传说', quantity: 1,
        materials: ['月光钢锭×3', '龙息余烬×1'],
      },
    },
  }

  it('renders product name and quality', () => {
    const wrapper = mount(CraftSystemCard, { props: { event: mockEvent } })
    expect(wrapper.text()).toContain('霜月之刃')
    expect(wrapper.text()).toContain('传说')
  })

  it('renders rating', () => {
    const wrapper = mount(CraftSystemCard, { props: { event: mockEvent } })
    expect(wrapper.text()).toContain('成功')
  })

  it('renders materials', () => {
    const wrapper = mount(CraftSystemCard, { props: { event: mockEvent } })
    expect(wrapper.text()).toContain('月光钢锭')
  })

  it('renders creative effects', () => {
    const wrapper = mount(CraftSystemCard, { props: { event: mockEvent } })
    expect(wrapper.text()).toContain('冰焰双刃')
    expect(wrapper.text()).toContain('铸魂残留')
  })

  it('has collapsible body', async () => {
    const wrapper = mount(CraftSystemCard, { props: { event: mockEvent } })
    expect(wrapper.find('.sys-card-body').isVisible()).toBe(false)
    await wrapper.find('.sys-card-header').trigger('click')
    expect(wrapper.find('.sys-card-body').isVisible()).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/ui/components/CraftSystemCard.test.ts
```

- [ ] **Step 3: 重写 CraftSystemCard.vue**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { CraftSystemEvent } from '@engine/types'
import { qualityVar } from '../../../lib/quality-colors'

const props = defineProps<{ event: CraftSystemEvent }>()

const open = ref(false)

function toggle() { open.value = !open.value }

const ratingMeta: Record<string, { icon: string; color: string }> = {
  '大失败': { icon: 'fa-regular fa-circle-xmark', color: '#ef4444' },
  '失败':   { icon: 'fa-solid fa-triangle-exclamation', color: '#f59e0b' },
  '成功':   { icon: 'fa-regular fa-circle-check', color: '#22c55e' },
  '精益求精': { icon: 'fa-solid fa-star', color: '#eab308' },
}

const effectTypeClass: Record<string, string> = {
  '增益': 'eff-buff',
  '减益': 'eff-debuff',
  '特殊': 'eff-special',
}
</script>

<template>
  <div class="sys-card" :style="{ borderColor: qualityVar(event.quality) }">
    <div class="sys-card-header" @click="toggle">
      <i class="fa-solid fa-hammer sys-card-icon" />
      <span class="sys-card-title">{{ event.quality }} · {{ event.productName }}</span>
      <i class="fa-solid sys-card-chevron" :class="open ? 'fa-chevron-up' : 'fa-chevron-down'" />
    </div>
    <div class="sys-card-body" v-show="open">
      <!-- 检定摘要 -->
      <div class="card-section">
        <div class="rating-row">
          <i :class="ratingMeta[event.rating]?.icon ?? 'fa-regular fa-circle'" class="rating-icon" :style="{ color: ratingMeta[event.rating]?.color }" />
          <span class="rating-text" :style="{ color: ratingMeta[event.rating]?.color }">{{ event.rating }}</span>
          <span v-if="event.details.difficultyJudgment" class="rating-detail">
            DC{{ event.details.craftToolCall?.targetQuality ? '+' : '' }}{{ event.details.difficultyJudgment.dcModifier }} · {{ event.details.difficultyJudgment.reasoning }}
          </span>
        </div>
      </div>

      <!-- 材料 -->
      <div v-if="event.details.craftToolCall?.materials?.length" class="card-section">
        <span class="section-label">材料</span>
        <div class="chip-list">
          <span v-for="m in event.details.craftToolCall.materials" :key="m" class="chip muted">{{ m }}</span>
        </div>
      </div>

      <!-- 词条效果 -->
      <div v-if="event.details.creativeEffects?.length" class="card-section">
        <span class="section-label">词条</span>
        <div class="effect-list">
          <div v-for="eff in event.details.creativeEffects" :key="eff.name" class="effect-item" :class="effectTypeClass[eff.type] ?? 'eff-special'">
            <span class="eff-name">{{ eff.name }}</span>
            <span class="eff-desc">{{ eff.description }}</span>
          </div>
        </div>
      </div>

      <!-- 叙事风味 -->
      <div v-if="event.details.narrativeFlavor" class="card-section">
        <span class="section-label">锻造记录</span>
        <p class="flavor-text">{{ event.details.narrativeFlavor }}</p>
      </div>

      <!-- 结算 -->
      <div class="card-section card-footer">
        <span v-if="event.details.craftToolCall?.quantity > 1" class="stat-badge">×{{ event.details.craftToolCall.quantity }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sys-card {
  border-radius: var(--theme-radius-sm, 4px);
  overflow: hidden;
  border: 1px solid var(--theme-card-border);
  border-left: 4px solid;
  background: var(--theme-card-bg);
}
.sys-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 0.8125rem;
  font-weight: 700;
}
.sys-card-header:hover { background: var(--theme-surface-hover, rgba(255,255,255,0.04)); }
.sys-card-icon { font-size: 0.8125rem; opacity: 0.7; }
.sys-card-title { flex: 1; }
.sys-card-chevron { font-size: 0.625rem; opacity: 0.5; }
.sys-card-body { padding: 0 12px 12px; display: flex; flex-direction: column; }
.card-section {
  padding: 8px 0;
  border-top: 1px dashed var(--theme-card-border);
}
.card-section:first-child { border-top: none; }
.rating-row { display: flex; align-items: center; gap: 6px; font-size: 0.8125rem; }
.rating-icon { font-size: 0.875rem; }
.rating-text { font-weight: 700; }
.rating-detail { font-size: 0.75rem; opacity: 0.6; }
.section-label {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--theme-text-muted);
  margin-bottom: 6px;
  display: block;
}
.chip-list { display: flex; gap: 4px; flex-wrap: wrap; }
.chip {
  display: inline-flex;
  padding: 2px 8px;
  border-radius: var(--theme-radius-sm, 4px);
  font-size: 0.75rem;
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
}
.chip.muted { background: var(--theme-surface-muted); border-color: transparent; }
.effect-list { display: flex; flex-direction: column; gap: 4px; }
.effect-item {
  padding: 6px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  border-left: 3px solid;
  background: var(--theme-surface-muted);
  font-size: 0.75rem;
}
.eff-buff { border-color: var(--theme-quality-uncommon); }
.eff-debuff { border-color: var(--theme-error); }
.eff-special { border-color: var(--theme-primary); }
.eff-name { font-weight: 600; margin-right: 6px; }
.eff-desc { opacity: 0.7; }
.flavor-text { font-size: 0.75rem; opacity: 0.7; line-height: 1.5; font-style: italic; }
.card-footer { display: flex; gap: 8px; }
.stat-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: var(--theme-radius-sm, 4px);
  font-size: 0.75rem;
  font-weight: 600;
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
}
</style>
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/ui/components/CraftSystemCard.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/game/cards/CraftSystemCard.vue tests/ui/components/CraftSystemCard.test.ts
git commit -m "feat(ui): refactor CraftSystemCard to align with original spec — collapsible, CSS vars, section dividers"
```

---

## Task 4: 重构 CombatSystemCard 对齐原版规范

**Files:**
- Modify: `src/ui/components/game/cards/CombatSystemCard.vue`
- Create: `tests/ui/components/CombatSystemCard.test.ts`

**Interfaces:**
- Consumes: `CombatSystemEvent`
- Produces: `<CombatSystemCard :event="..." />`
- Props: `{ event: CombatSystemEvent }`

- [ ] **Step 1: 写测试**

```typescript
// tests/ui/components/CombatSystemCard.test.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CombatSystemCard from '../../../src/ui/components/game/cards/CombatSystemCard.vue'
import type { CombatSystemEvent } from '@engine/types'

describe('CombatSystemCard', () => {
  const mockWin: CombatSystemEvent = {
    type: 'combat', outcome: 'ally_win',
    narrative: '[战斗] 胜利 · 5回合 · EXP +180',
    details: {
      narrativeSummary: '你们击败了三头冰原狼。',
      patches: [], totalExp: 180, totalFp: 25,
      loot: [
        { name: '冰原狼牙', description: '锋利冰属性材料', quantity: 3, quality: '稀有' },
        { name: '狼皮披肩', description: '保暖披肩', quantity: 1, quality: '优良' },
      ],
      rounds: 5, outcome: 'ally_win',
    },
  }

  const mockDraw: CombatSystemEvent = {
    type: 'combat', outcome: 'draw',
    narrative: '[战斗] 平局',
    details: {
      narrativeSummary: '双方疲惫撤退。',
      patches: [], totalExp: 80, totalFp: 10,
      loot: [], rounds: 8, outcome: 'draw',
    },
  }

  it('renders outcome label', () => {
    const w = mount(CombatSystemCard, { props: { event: mockWin } })
    expect(w.text()).toContain('胜利')
    expect(w.text()).toContain('5 回合')
  })

  it('renders loot items', () => {
    const w = mount(CombatSystemCard, { props: { event: mockWin } })
    expect(w.text()).toContain('冰原狼牙')
    expect(w.text()).toContain('×3')
  })

  it('renders EXP and FP', () => {
    const w = mount(CombatSystemCard, { props: { event: mockWin } })
    expect(w.text()).toContain('180')
    expect(w.text()).toContain('25')
  })

  it('hides loot section when empty', () => {
    const w = mount(CombatSystemCard, { props: { event: mockDraw } })
    expect(w.text()).not.toContain('战利品')
  })

  it('is collapsible', async () => {
    const w = mount(CombatSystemCard, { props: { event: mockWin } })
    expect(w.find('.sys-card-body').exists()).toBe(true)
    await w.find('.sys-card-header').trigger('click')
    // body should toggle visibility
  })
})
```

- [ ] **Step 2: 重写 CombatSystemCard.vue**

结构与 Craft 卡片一致：`sys-card` > `sys-card-header` (结果图标 + label + 回合数 + chevron) + `sys-card-body` (narrativeSummary / loot list / EXP+FP badges)，使用 `--theme-card-border` 虚线分隔 section。

- [ ] **Step 3: 测试通过 + commit**

```bash
npx vitest run tests/ui/components/CombatSystemCard.test.ts
```

---

## Task 5: 重构 CharGenSystemCard 对齐原版规范

**Files:**
- Modify: `src/ui/components/game/cards/CharGenSystemCard.vue`
- Create: `tests/ui/components/CharGenSystemCard.test.ts`

**Interfaces:**
- Consumes: `CharGenSystemEvent`
- Produces: `<CharGenSystemCard :event="..." />`

**核心改动：**
- 加入折叠/展开交互
- 五维属性用 tier color map 替代纯文字
- 身份标签用 chip badges
- 技能/装备若有则展示摘要

- [ ] **Step 1: 写测试** (覆盖: 渲染名字/种族/tier、渲染五维、渲染标签、渲染背景摘要、折叠交互)
- [ ] **Step 2: 重写组件**
- [ ] **Step 3: 测试通过 + commit**

---

## Task 6: 重构 ItemGenSystemCard + SystemNotifBar

**Files:**
- Modify: `src/ui/components/game/cards/ItemGenSystemCard.vue`
- Modify: `src/ui/components/game/cards/SystemNotifBar.vue`
- Create: `tests/ui/components/ItemGenSystemCard.test.ts`

**接口检查：**
- `ItemGenSystemEvent` 中的 `quality` 是 `QualityLevel`，应使用 `qualityVar(event.quality)`
- `SystemNotifBar` 接收联合类型 `CharacterUpdateEvent | ItemUpdateEvent | QuestUpdateEvent`
- 已有实现较为规范，主要替换 emoji → Font Awesome icons 和色值硬编码 → CSS var

- [ ] **Step 1: 更新 ItemGenSystemCard 使用 qualityVar**
- [ ] **Step 2: 给 SystemNotifBar 加入 operation label 映射**
- [ ] **Step 3: 写 ItemGenSystemCard 测试**
- [ ] **Step 4: 编译 + 测试 + commit**

---

## Task 7: 更新 ChatFlow.vue 适配新卡片组件

**Files:**
- Modify: `src/ui/components/game/ChatFlow.vue`

**改动内容：**
- 确保折叠卡片组件的新 API 兼容（props 仍是 `:event`，无变化）
- 系统通知条的宽度对齐其他气泡的 `max-width: 800px`
- 检查卡片 wrapper 的样式是否与新的 `sys-card` class 兼容

- [ ] **Step 1: 确认 ChatFlow 的 system-card-wrapper 样式与新的 sys-card 不冲突**
- [ ] **Step 2: 如有冲突修改**
- [ ] **Step 3: 编译验证 + typecheck + commit**

---

## Task 8: 全链路测试 — 更新测试夹具

**Files:**
- Modify: `src/ui/lib/test-fixtures.ts`

**改动内容：**
- 确保 mock 数据覆盖所有新卡片字段
- 确保 mock 数据的 quality 字段使用正确的 `QualityLevel` 值

- [ ] **Step 1: 审查 test-fixtures.ts 中所有 mock 数据**
- [ ] **Step 2: 修复不符合新规范的字段**
- [ ] **Step 3: 编译 + commit**

---

## Task 9: 验收 — 浏览器人工验证 + 全量测试

- [ ] **Step 1: 跑全量测试**

```bash
npm run test -- --run
```

- [ ] **Step 2: 跑 typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: 启动开发服务器**

```bash
npm run dev
```

- [ ] **Step 4: 打开浏览器 → 游戏页 → Ctrl+Shift+T 注入测试数据**
  - 验证所有 7 种卡片可折叠/展开
  - 验证品质色正确显示
  - 验证虚线分隔、badge、chip 样式一致
  - 验证与背景色有区分（左侧彩色边框线）

- [ ] **Step 5: 切换不同主题，确认品质色和卡片边框在不同主题下都正确**

- [ ] **Step 6: Commit**

```bash
git commit -m "chore: final verification — all system cards aligned, tests passing"
```

---

## Verification

全部 Task 完成后：
1. `npm run typecheck` 零错误
2. `npm run test -- --run` 全量通过（含新增的 4-5 个卡片测试文件）
3. 浏览器内 Ctrl+Shift+T 可见全 7 种卡片，样式统一，折叠展开正常
4. 切换任意主题不影响品质色渲染
