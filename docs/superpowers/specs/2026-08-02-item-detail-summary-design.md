# 物品/技能/装备 详情弹窗 · 轻量摘要设计 v1.0

> 📅 2026-08-02 · 对应 `docs/archive/planning/combat-v3-fix-backlog.md` 最后一项
> 「前端 ItemsPanel 缺 modifiers 展示」
>
> **一句话**：点击物品/技能/装备后，在 ItemsPanel 右侧详情面板内展示**人读的轻量摘要**
> （modifiers + automata 中文翻译行）；点「查看原始数据」
> 才暴露 modifiers/automata/scripts 的原始 JSON 与代码。

---

> 🔄 **v1.1 修订（2026-08-02，实现后主人复核）**：交互形态从「独立小弹窗」改为
> **右侧详情面板内区块**。原因：ItemsPanel 本就是 Master-Detail 布局，右侧详情面板
> 空间足够承载战斗修正摘要，额外弹窗反而与面板内容重复、遮挡。**引擎侧两个纯函数
> （describe-modifier / describe-automaton）完全保留**，仅前端从弹窗组件改为面板内区块
> （`ItemDetailModal.vue` 删除，逻辑并入 `ItemsPanel.vue` 详情面板）。本文下方 §2/§3.3
> 保留 v1.0 弹窗方案的原始设计，作为决策历史；以本修订为准。

---

## 1. 背景与问题

战斗 v3 (M5) 完成后，item_gen 生成的装备携带两类战斗效果字段：

- **`modifiers`**（`effect-types.ts` `Modifier` 6 大类判别联合）—— 命中+5、附加流血等
- **`automata`**（`combat-v3/types.ts` `EffectAutomatonDecl[]`）—— DSL 自由效果（订阅窗口 + 触发表达式 + intents）

但前端 `ItemsPanel.vue` 详情面板只展示了**效果词条（`effects`）/ 描述 / 脚本**，玩家看不到装备到底带什么战斗效果。backlog 项明确建议：**v3 编译时产出人类可读效果描述，前端只渲染；automaton 是 DSL 内部表示不裸展示。**

**本设计的核心决策**（主人确认）：

1. modifiers **和** automata 都要翻译成中文摘要
2. automaton 摘要做**完整 DSL 翻译**（窗口→中文、trigger→条件、intent→效果），不是只给类型名
3. 描述生成逻辑放**引擎侧纯函数**（可单测、可复用、符合「Code 填账务字段」铁律）
4. 带条件的效果（`Modifier.condition` / `automaton.trigger`）在摘要行体现触发条件
5. 交互形态 = **独立小弹窗（浮层）**，复用 `AppModal.vue`（自带遮罩/右上角叉叉/Escape 关闭/transition）
6. 摘要区展示全部，原始代码字段收进「查看原始数据」按钮，点开才暴露

## 2. 交互形态

### 触发

- 用户点击 ItemsPanel 左列表的任意物品/装备/技能行 → 右侧详情面板照常显示（现状）
- 额外弹出一个居中浮层（`AppModal` `size="md"`），标题 = 物品名 + 品质色

### 弹窗布局

```
┌──────────────────────────────────┐
│  [武器名]            ×           │  ← AppModal header（title + 叉叉）
│  武器 · 25/25 耐久   ·  史诗      │  ← 元信息行
│──────────────────────────────────│
│  效果                            │  ← effects 词条（保留，AI 叙事描述）
│  词条名   描述                    │
│──────────────────────────────────│
│  战斗修正                        │  ← modifiers + automata 中文摘要
│  ⚔ 命中检定 +5                   │
│  ⚔ 附加状态：流血（目标HP<50%时） │
│  ⚔ [受击时] 附加2层流血          │
│──────────────────────────────────│
│  描述                            │  ← item.description（保留）
│  ...                             │
│──────────────────────────────────│
│  [查看原始数据]  ▾               │  ← 折叠按钮
│  （点开 → modifiers/automata/    │
│    scripts 的原始 JSON + 代码）   │
└──────────────────────────────────┘
```

### 关闭

- 右上角叉叉（AppModal 自带）
- 点击遮罩（AppModal 自带）
- Escape 键（AppModal 自带）
- 弹窗关闭不影响 ItemsPanel 的选中态（下次点击重新弹出）

## 3. 架构

```
src/sillytavern/                   ← 引擎侧纯函数（新增）
├── describe-modifier.ts           ← describeModifier(m): string[]
├── describe-automaton.ts          ← describeAutomaton(a): string[]

src/ui/components/game/            ← 前端（改造）
├── ItemsPanel.vue                 ← 弹出入口 + 传 selected 数据
└── ItemDetailModal.vue            ← 🆕 弹窗组件（摘要 + 原始数据折叠）
```

### 3.1 引擎侧：`describe-modifier.ts`

纯函数，输入 `Modifier`（6 大类判别联合），输出中文摘要行数组。

| Modifier 大类 | 摘要形态                                                              |
| ------------- | --------------------------------------------------------------------- |
| `固伤`        | `造成 {amount} 点{damageType}伤害`                                    |
| `百分比`      | `{target} {+coef%}`（target ∈ damage/heal/resource → 伤害/治疗/资源） |
| `资源`        | `回复/消耗 {amount} 点{HP/MP/SP}`                                     |
| `检定`        | `{checkType}检定 {+bonus}`                                            |
| `附加效果`    | `附加{effectName}`                                                    |
| `特殊机制`    | `{mechanismName}`                                                     |

- 带 `condition` → 行首加 `[目标HP<50%时]`（条件原文保留，EJS 风格已是可读的）
- 带 `source` → 行尾加 `（来源：{source}）`（仅当 source 非空且非「未知」）
- `divinity` 有值时行尾附 `· 登神{等级}`

### 3.2 引擎侧：`describe-automaton.ts`

纯函数，输入 `EffectAutomatonDecl`，输出中文摘要行数组（一个 automaton 可能产多行，按 intent 展开）。

**18 窗口 → 中文**（节选）：

| WindowKey                                            | 中文                 |
| ---------------------------------------------------- | -------------------- |
| `round.open/close`                                   | 回合开始/结束时      |
| `initiative.before/after`                            | 先攻判定前/后        |
| `turn.open/close`                                    | 回合开始时/结束时    |
| `action.declared`                                    | 声明行动时           |
| `check.intent`                                       | 检定意图时           |
| `check.hit`                                          | 命中检定时           |
| `collect_attacker_mods` / `collect_defender_mods`    | 攻击/防御修正收集中  |
| `damage.preview` / `damage.compute` / `damage.after` | 伤害预览/计算/结算后 |
| `unit.beforeDown`                                    | 单位倒地前           |
| `morale.before/after`                                | 士气判定前/后        |
| `settlement.before`                                  | 战斗结算前           |

**trigger 表达式 → 条件**：`target.hpPercent < 0.5` → `目标HP<50%`；`source` → `自身`；`target` → `目标`；`.` 分段中文化；数值百分比 `0.5`→`50%`。

**intents（13 类 `EffectIntent` 判别联合）→ 效果**（全量映射）：

| Intent kind            | 效果形态                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `AddModifier`          | `{slot} {+value}`（slot ∈ hit/atk/def/dr/... → 命中/攻击/防御/减伤） |
| `DealDamage`           | `造成 {amount} 点{type}伤害`（含 bypass）                            |
| `Heal`                 | `回复 {amount} 点HP`                                                 |
| `ApplyStatus`          | `附加 {statusName} {stacks}层`                                       |
| `RemoveStatus`         | `移除{statusName}`                                                   |
| `SpendResource`        | `消耗 {amount} 点{HP/MP/SP}`                                         |
| `PreventDeath`         | `免死一次`                                                           |
| `ConsumeCharge`        | `消耗 {amount} 次充能`                                               |
| `EmitNarrativeCue`     | `提示：{text}`                                                       |
| `OverrideIntent`       | `覆盖{slot}行动`                                                     |
| `ScheduleIntent`       | `延后：{intent 摘要}`                                                |
| `SpawnOrDespawnIntent` | `召唤/移除{unit}`                                                    |
| `RequestChoiceIntent`  | `要求选择`                                                           |

> 📌 注：`EffectIntent` 判别联合实测为 **13 类**（`combat-v3/types.ts:1607`），
> backlog 文案的「8 大类」是早期口径，实现以代码为准。其余 `kind`（如
> `RoundOpened`/`DamageApplied`）是 `DomainEvent` 战斗事件，非 automaton intent，不在翻译范围内。

### 3.3 前端：`ItemDetailModal.vue`（🆕）

- 复用 `AppModal`（`size="md"`），props：`open` / `item` / `category`
- computed：
  - `modifierLines` = `(item.modifiers ?? []).map(describeModifier).flat()`
  - `automatonLines` = `(item.automata ?? []).map(describeAutomaton).flat()`
  - `hasCombatSummary` = 两者任一非空
- 「战斗修正」区块只在 `hasCombatSummary` 时显示；全空显示空态「该物品无战斗效果」
- 「查看原始数据」折叠：点开渲染 `JSON.stringify(modifiers/automata, null, 2)`（pre 黑底）+ `scripts` 代码（复用现状 `.script-code` 样式）

### 3.4 前端：`ItemsPanel.vue`（改造）

- 新增 `detailOpen` ref + `selected` 传入 ItemDetailModal
- 点击列表行 → 设置 `selected` + `detailOpen = true`（**同时保留**右侧详情面板现状，不替换）
- 引入 `ItemDetailModal`，`v-model:open="detailOpen"`

> ⚠️ **为什么保留右侧详情面板又弹窗**：现状详情面板承载「效果/描述/脚本」，是浏览主轴；弹窗是「当前选中物的战斗效果速览」，两者互补。backlog 说「独立详情页属 Phase 7e UI 精化可后置」——本设计不重建详情页，只加弹窗。

## 4. 测试

### 引擎侧纯函数单测（Vitest）

**`describe-modifier.test.ts`**：

- 6 大类各测：固伤/百分比/资源/检定/附加效果/特殊机制
- 带/不带 condition 的前缀
- 带 source / divinity 的尾注
- 边界：空 modifiers → 空数组；未知 category → 兜底行

**`describe-automaton.test.ts`**：

- 18 窗口全部映射到中文（逐窗口断言）
- 8 大类 intent 各测
- trigger 表达式翻译（`target.hpPercent < 0.5` / `source` / 复合条件）
- 边界：空 automata → 空数组；非法 trigger → 原样保留

### 前端

- ItemsPanel 是 Vue 组件，摘要逻辑在引擎侧测透，组件只做渲染（不新增组件级单测，遵循项目现状）

## 5. 范围界定（YAGNI）

- **不做**：automaton 的 `charges`/`priority`/`divinity`/`id` 等战斗内部元数据展示
- **不做**：独立详情页（Phase 7e 后置项，本设计只加弹窗）
- **不做**：`effects` 词条改造（AI 填的叙事描述已够人读）
- **不做**：原始数据编辑/复制功能（只读展示）

## 6. 设计规范遵循

- 弹窗复用 `AppModal`（符合 `docs/design.md` 弹窗规范：遮罩 + 居中 + 圆角 `--theme-radius-xl` + `--theme-shadow-lg`）
- 品质色用 `qualityVar()` + 光晕（`--item-detail-glow`），遵循 4.2 品质色规范
- 间距用 `--theme-spacing-*` token；区块标题用 `.d-label` 样式（大写 + 下划线）
- 原始代码区用 `.script-code` 既有样式（黑底等宽）
- 主题无关，全 CSS 变量
