# Phase 7d: 捏人页 `/create` — 架构设计（最终版）

> 数据对齐: `reference/custom_start_index.html` + CDN `baseInfo.json` / `skills.json`
> 前端: Vue 3 + Pinia + Vite
> 引擎数据: `src/sillytavern/start-catalog.ts`（已完成）

---

## 一、核心架构决策

### 1.1 数据结构: 对齐原版 CDN JSON

所有装备/技能/道具使用原版的 `tag[] + effect{} + consume + rarity` 结构:

```typescript
interface CatalogItem {
  id: string
  name: string
  category: 'equipment' | 'item' | 'skill'
  type: string                    // 装备:武器/防具/饰品  技能:主动/被动  道具:消耗品/材料/特殊
  rarity: Rarity                  // common / uncommon / rare / epic / legendary / mythic / only
  tag: string[]                   // [属性, 目标类型, 伤害类型, 学派, 功能...]
  effect: Record<string, string>  // { "范围伤害": "造成100%能量伤害", ... }
  consume?: string                // "攻击: 400MP" / "动作: 150MP"
  description: string
  cost: number                    // 转生点消耗
  quantity?: number               // 仅 item 类
}
```

### 1.2 数据分流: 变量 vs 开场提示词（JSON 结构化注入）

```
捏人数据
  ├── 变量路径 (→ CharacterState)          ── 结构化数值
  │   name / race / identity / level / tier / attributes / hp / mp / sp
  │   money / location / gender / age / destinyCoreId
  │
  └── 开场提示词路径 (→ JSON 注入 story AI)  ── 保留完整 tag/effect 结构
      【初始装备】[{name,type,rarity,tag,effect,description},...]
      【初始技能】[{name,type,rarity,tag,effect,consume,description},...]
      【背包物品】[{name,type,rarity,quantity,tag,effect,description},...]
      【角色背景】{name,text}
      【命定之灵】{name,author,theme}
```

### 1.3 命定核心 → 世界书激活（接口预留）

```typescript
// start-catalog.ts — 主人后续填充
DESTINY_CORE_WORLDBOOK_MAP: Record<string, string[]> = {}
```

---

## 二、7 步骤总览

```
Step 0         Step 1      Step 2       Step 3      Step 4      Step 5      Step 6
难度选择  →   基础信息  →  命定核心  →  装备选择  →  背景故事  →  剧情规划  →  确认创建
```

步骤切换: Pinia `currentStep` (0-6), `<component :is>` 切换, 非子路由。

PointsBar 置顶: `转生点数: 824 / 2000 (简单)    [角色预设]`

---

## 三、Step 0: 难度选择

| id | 名称 | 点数 |
|----|------|------|
| creative | 创造模式 | 10000 |
| easy | 轻松 | 5000 |
| simple | 简单 | 2000 |
| normal | 普通 | 1000 |
| hard | 困难 | 500 |
| hell | 地狱 | 100 |

六张卡片纵向排列, 点击即选, 默认不选中。

---

## 四、Step 1: 基础信息

| 字段 | 组件 | 写入路径 |
|------|------|---------|
| 角色名 | FormInput | 变量 |
| 性别 | FormSelect (8选项) | 变量 |
| 年龄 | FormStepper (1-999) | 变量 |
| 种族 | FormSelect (22种族+自定义) | 变量 |
| 身份 | FormSelect (30+身份) | 变量 |
| 起始地点 | FormCascader (5大区级联) | 变量 |
| 等级 | FormStepper (1-25) | 变量 |
| 基础属性 BP×5 | AttributeEditor (maxBP=25, per=6) | 变量 |
| 额外属性 AP×5 | AttributeEditor (maxAP=level-1) | 变量 |

联动: `tier = f(level)`, `finalAttr = BP + tierBonus + AP`, HP/MP/SP = `TIER_CONFIGS[tier] × 属性 × 10`

---

## 五、Step 2: 命定核心

24 个核心 (world_book_index §4.1), 3 列网格卡片。

每卡片显示: 核心名 / 作者 / 主题。选中后下方展示详情。

世界书激活接口预留 (`DESTINY_CORE_WORLDBOOK_MAP`), 捏人时只存 `destinyCoreId`。

---

## 六、Step 3: 装备选择

```
[装备] [道具] [技能]                           ← CategoryTabs
[全部] [普通] [优良] [稀有] [史诗] [传说] ...  ← QualityFilter (rarity)
[全部] [武器] [防具] [饰品]                    ← 类型筛选

┌─ 可选池 (左 60%) ──────┬─ 已选列表 (右 40%) ──┐
│  SelectableCard × N     │  SelectedPanel        │
│  [+ 自定义物品]         │                       │
└────────────────────────┴───────────────────────┘

┌─ 伙伴 — 世界书 (折叠, 占位) ──────────────────┐
```

数据来源: `start-catalog.ts` → `DEFAULT_EQUIPMENT_POOL`(28件) / `DEFAULT_ITEM_POOL`(16种) / `DEFAULT_SKILL_POOL`(20个)。

自定义物品: `CustomItemForm.vue` Modal → 创意工坊接口预留。

---

## 七、Step 4: 背景故事

6 个预设背景卡片 + 自定义 FormTextarea。数据来源: `DEFAULT_BACKGROUNDS`。

---

## 八、Step 5: 剧情规划

复用 SettingsPage 剧情分区 UI + 底部「生成剧情大纲」按钮。
- 调用 `createOutlineFromAgent()`, 显示等待警告
- 未生成/生成中/已生成(高斯模糊) 三态
- 可跳过, 存档创建后自动生成

---

## 九、Step 6: 确认创建

简洁角色摘要, 无消耗明细:

```
┌──────────┐  艾琳 | 人类 | 平民 | Lv.1 T1 普通
│  Avatar  │  索伦蒂斯王国 | 命定之灵: 泡泡核心(血色)
└──────────┘
  HP:180 MP:80 SP:80 | 力量7 敏捷5 体质6 智力5 精神5
  装备×2 技能×2 道具×1 | 背景: 命运的交响曲 | 大纲: ✅

  [✦ 开始命运之旅 ✦]    [保存预设]
```

**开始流程**: `buildCharacterState()` → `buildOpeningPrompt()` → 写 DB → `router.push(/game/:id)`

---

## 十、数据分流实现

### 10.1 `buildCharacterState()` → 变量路径

装备/技能/道具字段置空 (`equipment:[]`, `skills:[]`, `inventory:[]`)。只填 name/race/identity/level/tier/attributes/hp/mp/sp/money/location。

### 10.2 `buildOpeningPrompt()` → 开场提示词路径

```typescript
function buildOpeningPrompt(): string {
  const parts: string[] = []

  if (selectedEquipments.value.length > 0) {
    parts.push(`【初始装备】\n${JSON.stringify(selectedEquipments.value.map(e => ({
      name: e.name, type: e.type, rarity: e.rarity,
      tag: e.tag, effect: e.effect, description: e.description,
    })))}`)
  }
  if (selectedSkills.value.length > 0) {
    parts.push(`【初始技能】\n${JSON.stringify(selectedSkills.value.map(s => ({
      name: s.name, type: s.type, rarity: s.rarity,
      tag: s.tag, effect: s.effect, consume: s.consume, description: s.description,
    })))}`)
  }
  if (selectedItems.value.length > 0) {
    parts.push(`【背包物品】\n${JSON.stringify(selectedItems.value.map(i => ({
      name: i.name, type: i.type, rarity: i.rarity, quantity: i.quantity,
      tag: i.tag, effect: i.effect, description: i.description,
    })))}`)
  }
  if (selectedBackground.value) {
    parts.push(`【角色背景】\n${JSON.stringify({ name: selectedBackground.value.name, text: selectedBackground.value.fullText })}`)
  }
  if (destinyCore.value) {
    parts.push(`【命定之灵】\n${JSON.stringify({ name: destinyCore.value.name, author: destinyCore.value.author, theme: destinyCore.value.theme })}`)
  }

  return parts.join('\n\n')
}
```

**示例输出**:

```json
【初始装备】
[{"name":"龙牙剑","type":"武器","rarity":"epic","tag":["力量","单体","物理","龙"],"effect":{"物理伤害":"攻击力+30","流血":"命中后使目标每回合损失50HP，持续2回合"},"description":"以亚龙獠牙锻造的名剑，锋芒逼人"}]

【初始技能】
[{"name":"火球术","type":"主动","rarity":"rare","tag":["智力","范围:5","伤害","威力:400","塑能"],"effect":{"范围伤害":"造成100%能量伤害","法力燃烧":"使每个被命中的目标额外损失400点MP"},"consume":"攻击: 400MP","description":"一个明亮炽热的火球从你指尖飞驰而出..."}]
```

### 10.3 SaveSlot 存储

```typescript
interface SaveSlot {
  // 现有字段...
  openingPrompt?: string    // 开场提示词 (首回合消费后清空)
  destinyCoreId?: string
  difficulty?: string
  remainingPoints?: number
}
```

---

## 十一、Store 接口 (`create-store.ts`)

```typescript
export const useCreateStore = defineStore('create', () => {
  // 步骤
  const currentStep = ref(0)

  // 难度
  const difficulty = ref<DifficultyPreset | null>(null)

  // 角色 (→ 变量)
  const name, gender, customGender, age
  const race, customRace, identity, customIdentity
  const startLocation, customStartLocation
  const level, basePoints, attributePoints
  const reincarnationPoints, destinyPoints, money

  // computed: tier, tierBonus, finalAttributes, hp/mp/sp preview
  // computed: raceCost, identityCost, totalCost, remainingPoints

  // 命定核心
  const destinyCore = ref<DestinyCore | null>(null)

  // 装备/道具/技能 (→ 开场提示词)
  const selectedEquipments, selectedItems, selectedSkills
  const activeCategory, rarityFilter, typeFilter
  // 筛选池: equipmentPool / itemPool / skillPool

  // 背景
  const selectedBackground, customBackgroundText

  // 剧情
  const plotSettings, plotOutline, isPlotGenerating

  // 提交
  function buildCharacterState(): CharacterState
  function buildOpeningPrompt(): string
  async function startJourney(): Promise<string>

  // 预设
  const presets; loadPresets / saveCurrentPreset / loadPreset / deletePreset

  // 重置
  function resetAll()
})
```

---

## 十二、预设系统

- 存储: IndexedDB 新表 `createPresets` (database.ts v7)
- UI: `PresetModal.vue` — 保存(自定义名称+重名确认) / 加载 / 导出 / 删除 / 导入

---

## 十三、组件清单

### 已有复用
AppButton, AppCard, AppModal, AppTabs, QualityBadge, ResourceBar, AvatarPanel, FormInput, FormSelect, FormStepper, FormCascader

### 新建 (17 个)
| 组件 | 用途 |
|------|------|
| `CreatePage.vue` | 步骤容器 + 预设弹窗 |
| `CreateSteps.vue` | 7 步指示器 |
| `CreateFooter.vue` | 底部导航 (含「角色预设」按钮) |
| `PointsBar.vue` | 点数消耗条 |
| `CreateStepDifficulty.vue` | Step 0 |
| `CreateStepBasic.vue` | Step 1 |
| `AttributeEditor.vue` | 五维属性步进器 |
| `CreateStepDestinyCore.vue` | Step 2 |
| `DestinyCoreCard.vue` | 核心卡片 |
| `CreateStepSelections.vue` | Step 3 |
| `CategoryTabs.vue` | 装备/道具/技能 标签 |
| `QualityFilter.vue` | rarity 筛选按钮组 |
| `SelectableCard.vue` | 通用可选卡片 (tag+effect 展示) |
| `SelectedPanel.vue` | 已选列表 |
| `CreateStepBackground.vue` | Step 4 |
| `BackgroundList.vue` | 背景卡片列表 |
| `CreateStepPlot.vue` | Step 5 |
| `PlotOutlinePreview.vue` | 大纲预览 (模糊/揭示) |
| `CreateStepConfirm.vue` | Step 6 |
| `PresetModal.vue` | 预设管理弹窗 |
| `CustomItemForm.vue` | 自定义物品 Modal |
| `PartnerWorldBookPanel.vue` | 伙伴 (占位) |

---

## 十四、实现顺序

| # | 内容 | 状态 |
|---|------|------|
| 1 | `start-catalog.ts` | ✅ 完成 |
| 2 | `create-store.ts` 扩展 | ⬜ |
| 3 | `database.ts` v7 升级 | ⬜ |
| 4 | `CreatePage.vue` `CreateSteps.vue` `CreateFooter.vue` `PointsBar.vue` | ⬜ |
| 5 | Step 0 `CreateStepDifficulty.vue` | ⬜ |
| 6 | Step 1 `CreateStepBasic.vue` `AttributeEditor.vue` | ⬜ |
| 7 | Step 2 `CreateStepDestinyCore.vue` `DestinyCoreCard.vue` | ⬜ |
| 8 | Step 3 `CreateStepSelections.vue` + 子组件 | ⬜ |
| 9 | Step 4 `CreateStepBackground.vue` `BackgroundList.vue` | ⬜ |
| 10 | Step 5 `CreateStepPlot.vue` `PlotOutlinePreview.vue` | ⬜ |
| 11 | Step 6 `CreateStepConfirm.vue` | ⬜ |
| 12 | `PresetModal.vue` + DB | ⬜ |
| 13 | `CustomItemForm.vue` | ⬜ |
| 14 | 联调 | ⬜ |

---

*最后更新: 2026-06-16 | 准备开始写前端*
