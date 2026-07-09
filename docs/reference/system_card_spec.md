# 系统卡片设计规格书

> 本文档定义 ChatFlow 三源消息系统中"系统事件卡片"的完整视觉规格。供前端开发者实现 `src/ui/components/game/cards/*.vue` 时参照。

---

## 1. 概述

### 1.1 三源消息系统

ChatFlow 对话流支持三种消息来源，从用户视角看全部出现在同一条时间线上：

| 角色 | 来源 | 渲染方式 |
|------|------|----------|
| `user` | 玩家输入 | 右对齐气泡，蓝色底 |
| `assistant` | AI 叙事 | 左对齐气泡，深色底 |
| `system` | 引擎事件 | 折叠通知条 / 展开式系统卡片 |

系统事件由后端引擎在 Agent 管线执行过程中产出，通过 `toSystemMessage()` 工厂函数转换为 `ChatMessage`（`role: 'system'`）。每条系统消息包含：

- `content` — 纯文本摘要（给 AI 看，也显示在折叠条上）
- `systemEvent` — 结构化数据（供前端卡片渲染）

### 1.2 交互流程

```
折叠状态: [🔨 传说级 · 霜月之刃 — 制作成功] ▶  ← 点击展开
展开状态: ┌─ 🔨 传说级 · 霜月之刃 ─────── ▼ ─┐
          │  [卡片正文: 评级 / 材料 / 属性]    │
          └────────────────────────────────────┘  ← 点击收起
```

用户点击折叠通知条或展开卡片标题栏均可切换折叠/展开。默认全部折叠，同一时间可展开多张卡片。

### 1.3 系统事件类型

| `type` | 含义 | 何时产生 | 卡片组件 |
|--------|------|----------|----------|
| `craft` | 制作事件 | Orc 管线 Stage2 craft_gen 完成 | `CraftSystemCard` |
| `char_gen` | 新角色登场 | Orc 管线 Stage2 char_gen 完成 | `CharGenSystemCard` |
| `combat` | 战斗结算 | Orc 管线战斗窗口关闭 | `CombatSystemCard` |
| `item_gen` | 获得物品/技能/装备 | item_gen Agent 完成（char_gen 或 craft 触发） | `ItemSystemCard` |
| `character_update` | 角色属性变动 | vars_update 写入角色状态 | `SystemNotifBar` |
| `item_update` | 物品变动（消耗/转移/装备） | vars_update 写入物品状态 | `SystemNotifBar` |
| `quest_update` | 任务状态更新 | vars_update 写入任务状态 | `SystemNotifBar` |

前四种为"富卡片"类型，有独立组件；后三种为"通知条"类型，共用 `SystemNotifBar`。

---

## 2. 通用 CSS 变量引用

### 2.1 品质色映射

| 品质 | CSS 变量 | 色值 (obsidian) | 用于 |
|------|----------|-----------------|------|
| 普通 | `--theme-quality-common` | `#e2e8f0` | 品质标签 / 边框色 / 顶部色条 |
| 优良 | `--theme-quality-uncommon` | `#56bf7b` | 同上 |
| 稀有 | `--theme-quality-rare` | `#5d97ff` | 同上 |
| 史诗 | `--theme-quality-epic` | `#9a72f8` | 同上 |
| 传说 | `--theme-quality-legendary` | `#e5c166` | 同上 |
| 神话 | `--theme-quality-mythic` | `#e4587d` | 同上 |
| 唯一 | `--theme-quality-unique` | `#f09f4d` | 同上 |

卡片顶栏（card-top）使用对应品质色变量作为 `background` 或 `border-color`，底层文字（`color: #1a1a2e` 或 `#fff`）保证对比度。

### 2.2 资源色映射

| 资源 | CSS 变量 | 用途 |
|------|----------|------|
| HP | `--theme-hp` | 生命值相关数值/图标 |
| MP | `--theme-mp` | 魔力值相关数值/图标 |
| SP | `--theme-sp` | 体力值相关数值/图标 |
| EXP | `--theme-exp` | 经验值徽章/图标 |
| 货币 | `--theme-currency-gold` | FP（命运点数）/金币徽章 |

### 2.3 语义色

| 语义 | CSS 变量 | 用途 |
|------|----------|------|
| 成功/正向 | `--theme-success` | 制作评级"成功"/"精益求精"、战斗"胜利" |
| 警告 | `--theme-warning` | 制作评级"失败"、战斗"平局" |
| 错误/负向 | `--theme-error` | 制作评级"大失败"、战斗"败北" |

### 2.4 卡片骨架变量

| 用途 | CSS 变量 | 说明 |
|------|----------|------|
| 卡片底色 | `--theme-card-bg` | 展开态卡片整体背景 |
| 顶栏/通知条底色 | `--theme-surface-muted` | header 和折叠通知条背景 |
| 文字主色 | `--theme-text-primary` | 标题/正文 |
| 文字辅色 | `--theme-text-secondary` | 次要信息 |
| 文字弱色 | `--theme-text-muted` | 标签/元数据 |
| 主色调 | `--theme-primary` | Tier 徽章底、槽位标签等强调元素 |

---

## 3. 通用卡片骨架

所有富卡片使用统一的三层 HTML 结构。卡片本身由 ChatFlow 渲染外层 wrapper + header，具体卡片组件只负责 `card-top` + `card-body` 的内容区。

### 3.1 外层骨架（ChatFlow 负责）

```html
<!-- 折叠通知条 -->
<div class="system-notif" @click="toggleExpand(msg.id)">
  <i class="system-notif-icon fa-solid {{icon}}" />
  <span class="system-notif-text">{{ msg.content }}</span>
  <span class="system-notif-chevron">▶</span>
</div>

<!-- 展开卡片 -->
<div class="system-card-wrapper">
  <div class="system-card-header" @click="toggleExpand(msg.id)">
    <i class="system-card-icon fa-solid {{icon}}" />
    <span class="system-card-title">{{ msg.content }}</span>
    <span class="system-card-chevron">▼</span>
  </div>
  <div class="system-card-body">
    <!-- 具体卡片组件 slot -->
  </div>
</div>
```

### 3.2 骨架 CSS（已存在于 ChatFlow.vue）

```css
.system-notif {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--theme-surface-muted);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  transition: background var(--theme-transition-fast);
  max-width: 800px;
  width: 100%;
}
.system-notif:hover {
  background: var(--theme-card-bg);
}

.system-card-wrapper {
  max-width: 800px;
  width: 100%;
  background: var(--theme-card-bg);
  border-radius: var(--theme-radius-md, 8px);
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.system-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--theme-surface-muted);
  border-bottom: 1px solid var(--theme-border, rgba(255,255,255,0.06));
  cursor: pointer;
  user-select: none;
}
.system-card-header:hover {
  background: var(--theme-surface-hover, var(--theme-card-bg));
}

.system-card-icon {
  font-size: 1rem;
}

.system-card-title {
  flex: 1;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-card-chevron {
  font-size: 0.625rem;
  opacity: 0.5;
}

.system-card-body {
  padding: 12px;
}
```

### 3.3 卡片内容区的通用约定

各具体卡片组件的内容区遵循以下约定：

- **card-top** — 顶栏色条。使用对应品质/语义色作为 `background` 或左侧 `border`，展示卡片类型图标 + 核心标识信息。
- **card-body 内容区** — `padding: 10px 12px`，`display: flex; flex-direction: column; gap: 8px; font-size: 0.8125rem`。
- **区段分隔** — 不同信息块之间不画可见分隔线，依靠 8px gap 自然分行。若单区段内容较长（多行），区段间用 `border-top: 1px dashed var(--theme-border, rgba(255,255,255,0.08))` + `padding-top: 8px` 分隔。
- **空值隐藏** — 所有区段如对应字段为空/不存在则整行不渲染。

### 3.4 通用子组件

以下子组件内联在各卡片中使用，不需要独立 `.vue` 文件。

#### StatBadge

```html
<span class="stat-badge">EXP +150</span>
```

```css
.stat-badge {
  background: var(--theme-surface-muted);
  padding: 2px 8px;
  border-radius: var(--theme-radius-sm);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
}
```

用于展示数值类增量信息（EXP/FP/HP 变动等）。

#### EffectChip（效果词条标签）

```html
<span class="effect-chip effect-buff">锋利: 攻击力+5</span>
<span class="effect-chip effect-debuff">脆弱: 防御力-3</span>
<span class="effect-chip effect-special">灵魂绑定: 不可交易</span>
```

```css
.effect-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--theme-radius-sm);
  font-size: 0.6875rem;
  font-weight: 500;
  line-height: 1.4;
}
.effect-buff {
  background: rgba(53, 201, 138, 0.12);
  color: var(--theme-success);
  border: 1px solid rgba(53, 201, 138, 0.25);
}
.effect-debuff {
  background: rgba(255, 109, 109, 0.12);
  color: var(--theme-error);
  border: 1px solid rgba(255, 109, 109, 0.25);
}
.effect-special {
  background: rgba(154, 114, 248, 0.12);
  color: var(--theme-quality-epic);
  border: 1px solid rgba(154, 114, 248, 0.25);
}
```

三种类型对应 `CraftAgentOutput.creativeEffects[].type` 的值：`'增益'` → `effect-buff`，`'减益'` → `effect-debuff`，`'特殊'` → `effect-special`。

#### 区段标签

```html
<span class="section-label">材料:</span>
```

```css
.section-label {
  font-weight: 600;
  opacity: 0.6;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  margin-right: 4px;
}
```

---

## 4. CraftSystemCard（制作卡片）

### 4.1 输入

`event: CraftSystemEvent`

```ts
interface CraftSystemEvent {
  type: 'craft';
  productName: string;      // 制品名称
  quality: QualityLevel;    // 制品品质
  rating: CraftRating;      // 制作评级: '大失败'|'失败'|'成功'|'精益求精'
  narrative: string;        // 摘要文本
  details: CraftAgentOutput; // 制作详情
  // 额外字段（来自 craft-gen-chain.ts 的 CraftGenOutput）:
  //   details.checkSummary?: string
  //   details.itemRequests?: ItemRequest[]
  //   details.craftParams?: { materials, expGained, fpGained, ... }
}
```

### 4.2 顶栏

| 内容 | 来源 | 样式 |
|------|------|------|
| 图标 | `fa-solid fa-hammer` | `font-size: 0.8125rem` |
| 品质+名称 | `{{ event.quality }} · {{ event.productName }}` | `font-weight: 600; font-size: 0.875rem` |

顶栏 `background` 用品质色变量（`var(--theme-quality-{{quality}})`），文字用深色（`color: #1a1a2e`）以确保可读性。

### 4.3 正文区段（从上到下）

#### A. 制作评级

```html
<div class="craft-summary">
  <i :class="ratingIcon" />
  {{ event.rating }}
  <span v-if="event.details.checkSummary" class="check-detail">
    — {{ event.details.checkSummary }}
  </span>
</div>
```

评级图标：`大失败` → `fa-regular fa-circle-xmark`（色 `--theme-error`）、`失败` → `fa-solid fa-triangle-exclamation`（色 `--theme-warning`）、`成功` → `fa-regular fa-circle-check`（色 `--theme-success`）、`精益求精` → `fa-solid fa-star`（色 `#eab308`）。

若 `checkSummary` 为空则隐藏该 span。

#### B. 创意效果词条（有则显示）

```html
<div v-if="event.details.creativeEffects?.length" class="craft-effects">
  <span class="section-label">词条效果:</span>
  <span
    v-for="eff in event.details.creativeEffects"
    :key="eff.name"
    :class="'effect-chip effect-' + (eff.type === '增益' ? 'buff' : eff.type === '减益' ? 'debuff' : 'special')"
  >
    {{ eff.name }}: {{ eff.description }}
  </span>
</div>
```

词条按 `creativeEffects` 数组顺序横向排列（`flex-wrap: wrap; gap: 6px`）。

#### C. 材料清单（有则显示）

```html
<div v-if="event.details.craftParams?.materials" class="craft-materials">
  <span class="section-label">材料:</span>
  {{ event.details.craftParams.materials }}
</div>
```

#### D. item_gen 生成的制品列表（有则显示）

```html
<div v-if="event.details.itemRequests?.length" class="craft-items">
  <div v-for="req in event.details.itemRequests" :key="req.quality + req.type" class="craft-req">
    <i :class="req.type === 'equipment' ? 'fa-solid fa-shield' : 'fa-solid fa-flask'" />
    <span>{{ req.quality }} {{ req.type === 'equipment' ? '装备' : '物品' }}</span>
    <span v-if="req.description" class="req-desc">: {{ req.description.slice(0, 80) }}</span>
  </div>
</div>
```

#### E. 底部数值徽章

```html
<div class="craft-footer">
  <span v-if="event.details.craftParams?.expGained" class="stat-badge">
    EXP +{{ event.details.craftParams.expGained }}
  </span>
  <span v-if="event.details.craftParams?.fpGained" class="stat-badge">
    FP +{{ event.details.craftParams.fpGained }}
  </span>
</div>
```

### 4.4 备注

- `CraftAgentOutput` 中的 `effectDeclarations` 和 `narrativeFlavor` 不在此卡片渲染，前者供引擎解析，后者已注入正文。
- `craftToolCall` 字段（industry, quantity, expects）暂不展示，保留给后续详情面板。

---

## 5. CharGenSystemCard（新角色卡片）

### 5.1 输入

`event: CharGenSystemEvent`

```ts
interface CharGenSystemEvent {
  type: 'char_gen';
  characterName: string;   // 角色名
  race: string;            // 种族
  tier: number;            // 层级
  narrative: string;       // 摘要文本
  details: CharGenOutput;  // 角色完整数据
}
```

### 5.2 顶栏

| 内容 | 来源 | 样式 |
|------|------|------|
| 角色名 | `event.characterName` | `font-weight: 700; font-size: 0.9375rem` |
| Tier | `T{{ event.tier }}` | `background: var(--theme-primary); color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 0.6875rem` |
| 种族 | `event.race` | `font-size: 0.75rem; opacity: 0.6` |

顶栏背景统一用 `--theme-surface-muted`（角色卡不依赖品质色）。

### 5.3 正文区段（从上到下）

#### A. 五维属性

```html
<div v-if="event.details.attributes" class="char-attrs">
  <span v-for="(val, key) in event.details.attributes" :key="key" class="attr">
    <i :class="attrIcon(key)" class="attr-icon" />
    {{ val }}
  </span>
</div>
```

属性图标映射：`str` → `fa-solid fa-dumbbell`、`dex` → `fa-solid fa-bolt`、`con` → `fa-solid fa-shield-heart`、`int` → `fa-solid fa-brain`、`spi` → `fa-solid fa-star`。

排列方式：`display: flex; gap: 12px`，横向展示。

#### B. 身份标签

```html
<div v-if="event.details.identity?.length" class="char-tags">
  <span v-for="tag in event.details.identity" :key="tag" class="tag">{{ tag }}</span>
</div>
```

标签样式：`background: var(--theme-surface-muted); padding: 2px 8px; border-radius: 4px; font-size: 0.6875rem`。

#### C. 势力/阵营（有则显示）

```html
<div v-if="event.details.faction" class="char-faction">
  <i class="fa-solid fa-flag" />
  <span>{{ event.details.faction }}</span>
</div>
```

#### D. 职业标签（有则显示）

```html
<div v-if="event.details.occupation?.length" class="char-tags">
  <span class="section-label">职业:</span>
  <span v-for="occ in event.details.occupation" :key="occ" class="tag">{{ occ }}</span>
</div>
```

#### E. 背景故事（截断 150 字 + 省略号）

```html
<div v-if="event.details.background" class="char-bg">
  {{ event.details.background.slice(0, 150) }}{{ event.details.background.length > 150 ? '...' : '' }}
</div>
```

背景文字：`font-size: 0.75rem; opacity: 0.7; line-height: 1.5`。

#### F. 已有技能预览（有则显示）

```html
<div v-if="event.details.skills?.length" class="char-skills">
  <span class="section-label">技能:</span>
  <span v-for="sk in event.details.skills" :key="sk.name" class="skill-tag">
    {{ sk.name }}
    <span v-if="sk.type" class="skill-type">{{ sk.type === 'active' ? '主动' : '被动' }}</span>
  </span>
</div>
```

#### G. 登神长阶（仅 Lv.13+ 且 enabled）

```html
<div v-if="event.details.ascension?.enabled && event.details.ascension?.path" class="char-ascension">
  <span class="section-label">
    <i class="fa-solid fa-stairs" /> 登神长阶:
  </span>
  <span>{{ event.details.ascension.path }}</span>
</div>
```

### 5.4 备注

- `appearance`、`clothing`、`personality`、`likes` 字段不在卡片正文展示，这些长文本字段保留给右侧角色详情面板（`StatusOverview`）。
- 角色首次登场时会同时收到 item_gen 事件（装备/技能生成），两者分开发送两条系统消息。

---

## 6. CombatSystemCard（战斗卡片）

### 6.1 输入

`event: CombatSystemEvent`

```ts
interface CombatSystemEvent {
  type: 'combat';
  outcome: 'ally_win' | 'enemy_win' | 'draw' | 'fled';
  narrative: string;            // 摘要文本
  details: CombatSummaryResult; // 战斗结算
}
```

### 6.2 顶栏

| 内容 | 来源 | 样式 |
|------|------|------|
| 图标 | 见下方映射 | `font-size: 0.875rem` |
| 结果 | 见下方映射 | `font-weight: 700; font-size: 0.9375rem` |
| 回合数 | `{{ event.details.rounds }} 回合` | `font-size: 0.75rem; opacity: 0.5; margin-left: auto` |

结果映射表：

| outcome | 标签 | 图标 | 图标色 |
|---------|------|------|--------|
| `ally_win` | 胜利 | `fa-solid fa-trophy` | `--theme-success` |
| `enemy_win` | 败北 | `fa-solid fa-skull` | `--theme-error` |
| `draw` | 平局 | `fa-solid fa-handshake` | `--theme-warning` |
| `fled` | 逃跑 | `fa-solid fa-person-running` | `--theme-text-muted` |

顶栏背景统一用 `--theme-surface-muted`。

### 6.3 正文区段（从上到下）

#### A. 战斗叙事摘要

```html
<div class="combat-summary">{{ event.details.narrativeSummary }}</div>
```

`line-height: 1.5; color: var(--theme-text-primary)`。

#### B. 战利品（有则显示）

```html
<div v-if="event.details.loot?.length" class="combat-loot">
  <span class="section-label">
    <i class="fa-solid fa-coins" /> 战利品:
  </span>
  <span v-for="l in event.details.loot" :key="l.name" class="loot-item">
    {{ l.name }}<span v-if="l.quantity > 1">×{{ l.quantity }}</span>
  </span>
</div>
```

战利品条目：`background: var(--theme-surface-muted); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem`。有品质字段时边框色使用对应品质色。

#### C. 底部数值徽章

```html
<div class="combat-footer">
  <span class="stat-badge">EXP +{{ event.details.totalExp }}</span>
  <span class="stat-badge">FP +{{ event.details.totalFp }}</span>
</div>
```

---

## 7. ItemSystemCard（获得物品卡片）

### 7.1 输入

`event: ItemGenSystemEvent`

```ts
interface ItemGenSystemEvent {
  type: 'item_gen';
  itemName: string;        // 物品名称（取第一个）
  quality: QualityLevel;   // 品质
  itemType: string;        // '装备' | '技能' | '物品'
  narrative: string;       // 摘要文本
  details: ItemGenOutput;  // 物品/技能/装备/要素/权能完整数据
}
```

### 7.2 顶栏

| 内容 | 来源 | 样式 |
|------|------|------|
| 类型图标 | 见下方映射 | `font-size: 0.75rem; opacity: 0.6` |
| 物品名称 | `event.itemName` | `font-weight: 700; font-size: 0.875rem` |
| 品质标签 | `event.quality` | 品质色文字，`font-size: 0.75rem; font-weight: 600` |

类型图标：`装备` → `fa-solid fa-shield-halved`、`技能` → `fa-solid fa-wand-magic-sparkles`、`物品` → `fa-solid fa-flask`。

顶栏用左侧品质色边框（`border-left: 4px solid var(--theme-quality-{{quality}})`），底用 `--theme-surface-muted`。

### 7.3 正文区段（按数据存在与否动态显示）

#### A. 装备列表（`event.details.equipment`，有则显示）

```html
<div v-if="event.details.equipment?.length" class="card-body">
  <div v-for="eq in event.details.equipment" :key="eq.name" class="equip-line">
    <span class="equip-slot">{{ eq.slot }}</span>
    <span class="equip-name">{{ eq.name }}</span>
    <span class="equip-desc">{{ eq.description?.slice(0, 120) }}</span>
    <span v-if="eq.stats" class="equip-stats">
      <span v-for="(v, k) in eq.stats" :key="k" class="stat-kv">{{ k }}+{{ v }}</span>
    </span>
  </div>
</div>
```

槽位标签：`background: var(--theme-primary); color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 0.625rem; font-weight: 600`。

#### B. 技能列表（`event.details.skills`，有则显示）

```html
<div v-if="event.details.skills?.length" class="card-body">
  <div v-for="sk in event.details.skills" :key="sk.name" class="skill-line">
    <span class="skill-name">{{ sk.name }}</span>
    <span v-if="sk.type" class="skill-type-badge">{{ sk.type === 'active' ? '主动' : '被动' }}</span>
    <span class="skill-desc">{{ sk.description?.slice(0, 120) }}</span>
    <span v-if="sk.cost" class="skill-cost">
      {{ sk.cost.type }} {{ sk.cost.amount }}
    </span>
    <span v-if="sk.cooldown" class="skill-cd">CD {{ sk.cooldown }}回合</span>
  </div>
</div>
```

技能名颜色：`color: #90cdf4; font-weight: 600`。

#### C. 背包物品（`event.details.inventory`，有则显示）

```html
<div v-if="event.details.inventory?.length" class="card-body">
  <div v-for="inv in event.details.inventory" :key="inv.name" class="inv-line">
    <span class="inv-name">{{ inv.name }} ×{{ inv.quantity }}</span>
    <span v-if="inv.description" class="inv-desc">: {{ inv.description.slice(0, 100) }}</span>
  </div>
</div>
```

#### D. 登神要素（`event.details.elements`，有则显示）

```html
<div v-if="event.details.elements?.length" class="card-body">
  <span class="section-label">
    <i class="fa-solid fa-fire" /> 登神要素:
  </span>
  <div v-for="el in event.details.elements" :key="el.name" class="element-line">
    <span class="element-name">{{ el.name }}</span>
    <span class="element-desc">{{ el.description?.slice(0, 100) }}</span>
  </div>
</div>
```

#### E. 权能（`event.details.authorities`，有则显示）

```html
<div v-if="event.details.authorities?.length" class="card-body">
  <span class="section-label">
    <i class="fa-solid fa-crown" /> 权能:
  </span>
  <div v-for="auth in event.details.authorities" :key="auth.name" class="authority-line">
    <span class="authority-name">{{ auth.name }}</span>
    <span class="authority-desc">{{ auth.description?.slice(0, 100) }}</span>
  </div>
</div>
```

### 7.4 备注

- 装备/技能/物品/要素/权能分属独立的 `card-body` 块，块之间由 ChatFlow 外层骨架自然分隔（块内只用 gap）。
- 同一个 ItemGenOutput 可能同时包含装备和技能（char_gen 触发时），应全部展示。
- `effects` 和 `scripts` 是结构化字段，不在此卡片渲染。

---

## 8. SystemNotifBar（通知条）

### 8.1 输入

`event: CharacterUpdateEvent | ItemUpdateEvent | QuestUpdateEvent`

```ts
// 三者共享基础结构
{ type: 'character_update' | 'item_update' | 'quest_update'; narrative: string; }
// 各有额外标识字段（characterName / itemName + operation / questName + status）
```

### 8.2 渲染

SystemNotifBar 是最简单的卡片类型，没有折叠/展开交互，直接以内联通知条形式展示。

```html
<div class="notif-bar">
  <i :class="notifIcon" />
  <span>{{ event.narrative }}</span>
</div>
```

### 8.3 类型图标

| type | 图标 |
|------|------|
| `character_update` | `fa-solid fa-arrow-trend-up` |
| `item_update` | `fa-solid fa-boxes-stacked` |
| `quest_update` | `fa-solid fa-list-check` |

### 8.4 样式

```css
.notif-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--theme-surface-muted);
  border-radius: 4px;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.notif-icon {
  font-size: 0.75rem;
  opacity: 0.6;
  width: 1rem;
  text-align: center;
}
```

与折叠通知条（`.system-notif`）的区别：无 chevron、不可点击展开、无 hover 效果。

---

## 9. 通用子组件汇总

### 9.1 StatBadge

```css
.stat-badge {
  background: var(--theme-surface-muted);
  padding: 2px 8px;
  border-radius: var(--theme-radius-sm);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
}
```

前置图标的变体：

| 含义 | 图标 |
|------|------|
| EXP | `fa-solid fa-bolt`（可选） |
| FP  | `fa-solid fa-coins`（可选） |
| 通用 | 无图标 |

### 9.2 EffectChip

| 类型 | CSS class | 配色 |
|------|-----------|------|
| `增益` | `effect-buff` | 绿底绿字 `--theme-success` |
| `减益` | `effect-debuff` | 红底红字 `--theme-error` |
| `特殊` | `effect-special` | 紫底紫字 `--theme-quality-epic` |

详细 CSS 见 3.4 节。

### 9.3 区段分隔线约定

区段间用虚线分隔：

```css
.section-divider {
  border-top: 1px dashed var(--theme-border, rgba(255,255,255,0.08));
  padding-top: 8px;
  margin-top: 0;  /* gap 已提供间距，仅加 padding-top */
}
```

仅在区段与上一个区段逻辑差异较大（如从属性切换到背景故事）时使用。同类条目（如多个技能）之间不用分隔线，仅靠 gap。

---

## 10. 图标映射表

### 10.1 系统事件类型图标（折叠/展开共用）

| `event.type` | Font Awesome 图标 | 备选降级 |
|--------------|-------------------|----------|
| `craft` | `fa-solid fa-hammer` | — |
| `char_gen` | `fa-solid fa-user-plus` | — |
| `item_gen` | `fa-solid fa-gift` | — |
| `combat` | `fa-solid fa-hand-fist` | `fa-swords`（Pro only） |
| `character_update` | `fa-solid fa-arrow-trend-up` | — |
| `item_update` | `fa-solid fa-boxes-stacked` | — |
| `quest_update` | `fa-solid fa-list-check` | — |

### 10.2 五维属性图标

| 属性 | 图标 |
|------|------|
| `str` | `fa-solid fa-dumbbell` |
| `dex` | `fa-solid fa-bolt` |
| `con` | `fa-solid fa-shield-heart` |
| `int` | `fa-solid fa-brain` |
| `spi` | `fa-solid fa-star` |

### 10.3 制作评级图标

| 评级 | 图标 | 颜色 |
|------|------|------|
| 大失败 | `fa-regular fa-circle-xmark` | `--theme-error` |
| 失败 | `fa-solid fa-triangle-exclamation` | `--theme-warning` |
| 成功 | `fa-regular fa-circle-check` | `--theme-success` |
| 精益求精 | `fa-solid fa-star` | `#eab308` |

### 10.4 战斗结果图标

| 结果 | 图标 | 颜色 |
|------|------|------|
| ally_win | `fa-solid fa-trophy` | `--theme-success` |
| enemy_win | `fa-solid fa-skull` | `--theme-error` |
| draw | `fa-solid fa-handshake` | `--theme-warning` |
| fled | `fa-solid fa-person-running` | `--theme-text-muted` |

### 10.5 物品类型图标

| 类型 | 图标 |
|------|------|
| 装备 | `fa-solid fa-shield-halved` |
| 技能 | `fa-solid fa-wand-magic-sparkles` |
| 物品/道具 | `fa-solid fa-flask` |

### 10.6 区段标签图标

| 区段 | 图标 |
|------|------|
| 材料 | `fa-solid fa-cubes` |
| 战利品 | `fa-solid fa-coins` |
| 词条效果 | `fa-solid fa-sparkles` |
| 势力 | `fa-solid fa-flag` |
| 职业 | `fa-solid fa-briefcase` |
| 登神长阶 | `fa-solid fa-stairs` |
| 登神要素 | `fa-solid fa-fire` |
| 权能 | `fa-solid fa-crown` |
| 技能 | `fa-solid fa-bolt-lightning` |
| 装备槽 | `fa-solid fa-shield` |
| 背包物品 | `fa-solid fa-flask` |

### 10.7 资源值图标

| 资源 | 图标 |
|------|------|
| EXP | `fa-solid fa-bolt` |
| FP | `fa-solid fa-star` |

---

## 附录 A: 文件结构

```
src/ui/components/game/cards/
├── CraftSystemCard.vue     # 制作卡片
├── CharGenSystemCard.vue   # 新角色卡片
├── CombatSystemCard.vue    # 战斗卡片
├── ItemSystemCard.vue      # 获得物品卡片
└── SystemNotifBar.vue      # 通知条（character/item/quest_update 共用）
```

ChatFlow.vue 中引入并条件渲染：

```vue
<script setup>
import CraftSystemCard from './cards/CraftSystemCard.vue'
import CharGenSystemCard from './cards/CharGenSystemCard.vue'
import CombatSystemCard from './cards/CombatSystemCard.vue'
import ItemSystemCard from './cards/ItemSystemCard.vue'
import SystemNotifBar from './cards/SystemNotifBar.vue'
</script>
```

## 附录 B: 数据流

```
Agent 管线执行
  │
  ├─ craft_gen 完成 → CraftGenOutput → craftToEvent() → CraftSystemEvent
  ├─ char_gen 完成 → CharGenOutput   → charGenToEvent() → CharGenSystemEvent
  ├─ combat 结算  → CombatSummaryResult → combatToEvent() → CombatSystemEvent
  ├─ item_gen 完成 → ItemGenOutput   → itemGenToEvent() → ItemGenSystemEvent
  ├─ vars_update  → charUpdateToEvent() / itemUpdateToEvent() / questUpdateToEvent()
  │
  ▼
toSystemMessage(event) → ChatMessage { role: 'system', systemEvent: event }
  │
  ▼
game-store.addSystemMessage() → messages[] 响应式更新
  │
  ▼
ChatFlow.vue 检查 msg.role === 'system' && msg.systemEvent
  ├─ 折叠: .system-notif（点击展开）
  └─ 展开: .system-card-wrapper → 对应卡片组件
```

## 附录 C: 组件设计原则

1. **纯展示** — 卡片组件只接收 `event` prop，不触发任何副作用、不修改 store、不发 API 请求。
2. **防御性渲染** — 所有嵌套字段用 `?.` 和 `v-if` 守卫，空数组/空字符串整块不渲染。
3. **品质色随主题切换** — 禁止硬编码色值（`#c4cad3` 等），统一使用 `var(--theme-quality-xxx)` CSS 变量。现有组件中的硬编码 `qualityColors` 记录应迁移为 CSS 变量引用。
4. **长文本截断** — 背景故事 (150字)、物品描述 (120字) 等长文本使用 `.slice(0, N)` + `'...'` 截断。
5. **Font Awesome 降级** — `fa-swords`（Pro）降级为 `fa-hand-fist`（Free），其余均使用 Free 图标。
6. **无动画** — 卡片展开/折叠依赖 `v-if` 的插入/移除，不需要过渡动画。内容区不需要 hover 效果。
