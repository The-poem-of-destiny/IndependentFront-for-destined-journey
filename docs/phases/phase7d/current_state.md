# Phase 7d 捏人页 — 当前状态文档

> 供新 session 重构参考。重点：页面结构 / 数据来源 / 已知问题。
>
> 🔴 **本文 2026-08-18 整体重写**。此前的版本快照的是 2026-06 的实现（7 步 / 20 组件 /
> `start-catalog.ts` 内联数据池 / 无测试），与现行代码差得很远，读了会照着不存在的形状改代码。
> 历史版本走 git 历史（本文件 2026-08-18 之前的任一提交）。设计意图与建成顺序的**历史计划记录**
> 仍在同目录 `architecture.md`，差距分析 `gap_analysis.md` 的基线停在 2026-06（见该文件头横幅）。

---

## 一、页面入口 & 步骤模型

**全应用没有 vue-router**（`src/ui/App.vue` 是对 `ui.currentView` 的 computed switch）。
捏人页由 `ui.navigate('create')` 进入，页内步骤同样是「computed 选组件」，不是子路由：

```
currentView === 'create'  →  CreatePage.vue（单页, 8 步骤状态机, Pinia store.currentStep 切换）
```

`CreatePage.vue` 结构（`src/ui/components/create/CreatePage.vue`）：

```
CreatePage
├── back-btn          (← 首页, ui.navigate('home'))
├── CreateSteps       (顶部 8 步指示器, :total="8")
├── PointsBar         (转生点数消耗条: 剩余/总量 + 难度标签)
├── 内容加载门         (contentStatus 三态: 加载中 / 没有可用内容目录 / 正常)
├── <Transition>      (步骤内容区, 8 个 defineAsyncComponent 懒加载)
├── CreateFooter      (底部: [角色预设] [←上一步] [下一步→ / ✦ 开始命运之旅 ✦])
└── PresetModal       (预设管理弹窗, v-model 控制显隐)
```

**8 个步骤名的唯一出处是 `CreateSteps.vue` 的 `STEP_LABELS`**（组件内常量，不是 store）：

| # (currentStep) | 标签         | 步骤组件                    |
| --------------- | ------------ | --------------------------- |
| 0               | 难度选择     | `CreateStepDifficulty.vue`  |
| 1               | 基础信息     | `CreateStepBasic.vue`       |
| 2               | 命定核心     | `CreateStepDestinyCore.vue` |
| 3               | **角色启用** | `CreateStepCharacters.vue`  |
| 4               | 装备选择     | `CreateStepSelections.vue`  |
| 5               | 背景故事     | `CreateStepBackground.vue`  |
| 6               | 剧情规划     | `CreateStepPlot.vue`        |
| 7               | 确认提交     | `CreateStepConfirm.vue`     |

> 🔴 「角色启用」（Step 3，按**世界书条目 uid** 勾选 `store.enabledCharacterEntryUids`）与
> 「命定核心」（Step 2，里面复用 `shared/WorkshopEnableList.vue` 做**工坊项目粒度**的启用）
> 是两回事，别混。2026-06 版文档里的 7 步模型没有 Step 3，其后每一步的编号都比现在小 1。

`currentStep` 上界钉在 `create-store.ts` 的 `nextStep()`（`< 7`）与 `CreatePage.vue` 的
`store.currentStep === 7 → startJourney()`。

---

## 二、组件树（22 个 .vue + 6 个 .test.ts）

```
src/ui/components/create/
├── CreatePage.vue               ← 步骤容器 + 内容加载门 + preset 弹窗开关
├── CreateSteps.vue              ← 8 步指示器（STEP_LABELS 唯一出处）
├── CreateFooter.vue             ← 底部导航栏
├── PointsBar.vue                ← 点数进度条
│
├── CreateStepDifficulty.vue     ← Step 0: 难度卡片
├── CreateStepBasic.vue          ← Step 1: 表单 + 5 列属性表格 + ResourceBar 预览
│   └── AttributeEditor.vue      ← 五维属性 +/- 步进器
├── CreateStepDestinyCore.vue    ← Step 2: 命定核心（世界书条目）+ WorkshopEnableList
├── CreateStepCharacters.vue     ← Step 3: 角色启用（按世界书条目 uid 勾选）
├── CreateStepSelections.vue     ← Step 4: 装备/道具/技能 选择
│   ├── CategorySelectionLayout.vue ← 左类目 / 右列表 通用版式
│   ├── CategoryTabs.vue         ← [装备] [道具] [技能] 标签
│   ├── QualityFilter.vue        ← rarity 筛选按钮组
│   ├── SelectableCard.vue       ← 物品卡片 (tag/effect/desc/cost)
│   ├── SelectedPanel.vue        ← 已选列表
│   └── CustomItemForm.vue       ← 自定义物品 Modal
├── CreateStepBackground.vue     ← Step 5: 背景故事
│   └── BackgroundList.vue       ← 预设背景卡片
├── CreateStepPlot.vue           ← Step 6: 剧情规划
│   └── PlotOutlinePreview.vue   ← 大纲预览 (空/加载中/模糊/揭示)
├── CreateStepConfirm.vue        ← Step 7: 确认提交（摘要卡片 + 头像链）
│
├── PresetModal.vue              ← 预设管理弹窗 (保存/加载/导入导出)
│
└── 测试 6 个：
    AttributeEditor.test.ts / PointsBar.test.ts / SelectableCard.test.ts /
    CreateSteps.test.ts / CreateStepDestinyCore.test.ts / CreateStepConfirm.assets.test.ts
```

> 🪦 `DestinyCoreCard.vue` 与 `PartnerWorldBookPanel.vue` 已于 2026-08-17 因全仓零引用随审查小修波
> 删除，恢复走 git 历史 `8e6565c^`；7d 复工如需重建按 `architecture.md` 的设计。
> 同批删掉的还有 `shared/form/FormCascader.vue` / `FormKeyValue.vue`——**`shared/form/` 现在只有
> `FormInput` / `FormSelect` / `FormStepper` 三个**，别照旧文档去 import 别的。

---

## 三、关键 HTML 结构

> 以下片段 2026-08-18 按现行代码校订过步骤编号与结构性差异，但仍是**示意**不是逐字抄录；
> 精确形状以组件源码为准。

### 3.1 CreatePage (容器)

```html
<div class="create-page">
  <button class="back-btn" @click="ui.navigate('home')">← 首页</button>
  <CreateSteps :current="store.currentStep" :total="8" />
  <PointsBar :total :used :difficulty-label />
  <main class="create-content">
    <!-- 内容加载门（D24）：loading/idle → 「正在加载内容目录…」；empty → 空态；否则渲染步骤 -->
    <Transition name="step-fade" mode="out-in">
      <component :is="currentComponent" :key="store.currentStep" />
    </Transition>
  </main>
  <CreateFooter :can-prev :can-next :next-label @prev @next @open-preset />
  <PresetModal :visible @close />
</div>
```

### 3.2 Step 1 (基础信息)

```html
<section class="step-basic">
  <!-- 角色信息表单 -->
  <FormInput 角色名 /> <FormSelect 性别 /> <FormStepper 年龄 />
  <FormSelect 种族 /> <FormSelect 身份 /> <FormSelect 起始地点 />
  <!-- 「自定义」选项时内联展开对应的自定义输入框 -->

  <!-- 等级 + 层级徽章 -->
  <div class="level-row">
    <FormStepper v-model="store.level" label="等级" />
    <span>T{{ store.tier }} {{ store.tierName }}</span>
  </div>

  <!-- ★ 5 列属性表格（属性 | 基础 BP | 层级 | 额外 AP | 结果）—— gap_analysis 的 P0 已建成 -->
  <div class="attr-table-wrapper">
    <table class="attr-table">
      <thead><tr><th>属性</th><th>基础</th><th class="col-tier">层级</th><th>额外</th><th>结果</th></tr></thead>
      <tbody><!-- 五行，BP/AP 各一个 AttributeEditor，结果列 = BP + tierBonus + AP --></tbody>
    </table>
  </div>

  <!-- 资源预览 + 初始资源 + 消耗摘要 -->
  <ResourceBar HP / MP / SP />
  <FormStepper 金钱 (G) /> <FormStepper 命运点数 (FP) />
</section>
```

### 3.3 Step 3 (角色启用)

```html
<section class="step-characters">
  <div v-if="store.characterEntries.length === 0" class="chars-loading">正在加载角色列表…</div>
  <label v-for="entry in store.characterEntries" :key="entry.uid">
    <input
      type="checkbox"
      :checked="store.enabledCharacterEntryUids.has(entry.uid)"
      @change="store.toggleCharacterEntry(entry.uid)"
    />
    {{ entry.comment }}
  </label>
  <p>
    已选择 {{ store.enabledCharacterEntryUids.size }} / {{ store.characterEntries.length }} 个角色
  </p>
</section>
```

### 3.4 Step 4 (装备选择)

```html
<section class="step-selections">
  <CategoryTabs :categories="[{装备},{道具},{技能}]" v-model="activeCategory" />
  <QualityFilter v-model="rarityFilter" />
  <CategorySelectionLayout sidebar-width="13em">
    <!-- 左侧：分组侧栏（分组 key 即子分类：剑类武器/头部防具/戒指…） -->
    <!-- 右侧：搜索框 + SelectableCard 列表（空态分「无搜索结果」/「该分类暂无物品」） -->
  </CategorySelectionLayout>
  <SelectedPanel :items :title @remove />
  <AppButton @click="showCustomForm = true">+ 自定义物品</AppButton>
  <CustomItemForm :visible @save @close />
</section>
```

> ✅ gap_analysis 的 P1（CategorySelectionLayout 侧栏）与 P6（搜索框）均已建成。

### 3.5 SelectableCard (物品卡片)

```html
<div
  class="selectable-card"
  :class="{selected, disabled}"
  @click="!disabled && !selected ? $emit('select', item) : undefined"
>
  <div class="card-body">
    <div class="card-header">名称 + <QualityBadge /> + 类型</div>
    <div class="card-tags">tag[] chips</div>
    <div class="card-effects">effect{} lines</div>
    <div class="card-cost">消耗: N 点</div>
    <div class="card-desc">描述</div>
  </div>
  <div class="card-action">
    <!-- 🔴 内层按钮无条件 $emit('select')，见下文「已知问题 UI-01」 -->
    <AppButton v-if="!selected" size="sm">选择</AppButton>
    <AppButton v-else size="sm" variant="danger">移除</AppButton>
  </div>
</div>
```

### 3.6 PresetModal (预设管理)

```html
<AppModal :open="visible" @close>
  <template #header>角色预设</template>
  <div class="save-row">
    <input v-model="presetName" /><AppButton>保存当前配置 / 确认覆盖</AppButton>
  </div>
  <div class="preset-list">
    <!-- 每行: 名称 · 角色名 Lv.N 装N 技N · 时间 | [加载] [导出] [删除→二次确认] -->
  </div>
  <div class="modal-footer">[导入预设文件] [全部导出] [关闭]</div>
</AppModal>
```

### 3.7 Step 7 (确认提交)

```html
<section class="step-confirm">
  <div class="confirm-card">
    <div class="hero-row">
      <!-- 头像位走 useAssetImage + ASSET_TYPE_AVATAR_CHAIN，无素材退 AvatarPanel 首字 -->
      <div class="hero-info">名称 / 种族·身份 / Lv.N TN / 起始地点 / 命定之灵</div>
    </div>
    <div class="resource-row">ResourceBar HP / MP / SP</div>
    <div class="attr-row">力量:N 敏捷:N …</div>
    <div class="stats-row">装备×N 技能×N 道具×N | 背景 | 大纲 ✅/⚠</div>
    <div class="items-summary">item-chip + QualityBadge</div>
  </div>
  <p class="points-remaining">💡 剩余转生点数: N</p>
</section>
```

---

## 四、数据来源

🔴 **`start-catalog.ts` 里已经没有数据了**（内容-引擎分离 D24）。旧文档说的
`DEFAULT_EQUIPMENT_POOL` / `DEFAULT_BACKGROUNDS` 等常量**全部不存在**，照着找会扑空。
现行是**两条互不相同的路**：

| 数据                | 现行来源                                                                                                                                                                | 说明                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 装备 / 道具 / 技能  | `create-store.ts` 构造期 `fetch` **上游仓库 CDN**（`REPO_DATA_BASE`，jsDelivr `FrontEnd-for-destined-journey@1.8.2/public/assets/data/{equipments,items,skills}.json`） | 保留 `{分组: [物品]}` 结构，外层分组 key 即子分类；失败静默保持空目录 |
| 背景                | 内容注册表 `catalog` 面 → `catalog.backgrounds`                                                                                                                         | 公开仓占位集 3 条                                                     |
| 命定核心            | 内容注册表 `catalog` 面 → `catalog.destinyCores`（+ Step 2 的世界书条目）                                                                                               | 公开仓占位集 3 条                                                     |
| 种族 / 身份费用     | `catalog.raceCosts`（24 键）/ `catalog.identityCosts`（15 键）                                                                                                          | 经 `lookupCost` 查表                                                  |
| 起始地点            | `catalog.startLocations`（树）→ `flattenLocationTree`                                                                                                                   | 公开仓占位集 1 棵                                                     |
| 难度预设 / 性别     | `start-catalog-mechanics.ts` 的机制常量                                                                                                                                 | 机制半边，随代码走                                                    |
| 角色 / 命定核心条目 | Dexie 世界书（`loadWorldBookEntries()` → `systemCoreEntries` / `characterEntries`）                                                                                     | 按条目 uid 勾选，落进开场提示词                                       |

> 🔴 上表第一行与其余行**口径不同**：只有装备/道具/技能仍走硬编码的上游 CDN，其余走内容注册表
> （`public/data/content/catalog.json`，内容包可整份替换）。公开仓那份是**零 IP 占位集**，
> 数量（装备 10 / 道具 5 / 技能 0 / 背景 3 / 命定核心 3）不代表真实内容仓。

---

## 五、Store (`create-store.ts`，约 2234 行)

- **内容门**: `contentStatus`（idle/loading/ready/empty）, `initContent()`（幂等、永不抛）,
  `catalog` / `bloodlineSet` / `era` 从内容注册表解析
- **步骤控制**: `currentStep` (0-7), `stepValid`, `nextStep/prevStep`
- **难度**: `difficulty`, `selectDifficulty(id)`, `reincarnationPoints`
- **角色 (→ 变量)**: name/gender/age/race/identity/startLocation/level + personality/physics/backstory/extra
- **属性联动**: `tier`/`tierName`/`tierBonus`/`finalAttributes`/`hpPreview`/`mpPreview`/`spPreview`
- **BP / AP**: `MAX_BP`, `usedBP/remainingBP`, `maxAP = max(0, level-1)`, `usedAP/remainingAP`
- **经济**: `raceCost/identityCost/equipmentCost/itemCost/skillCost/moneyCost/destinyCost/levelCost`
  → `totalCost` / `remainingPoints`
- **命定核心 & 世界书启用**: `destinyCore`, `systemCoreEntries` / `selectedSystemCoreEntryUid`,
  `characterEntries` / `enabledCharacterEntryUids` / `toggleCharacterEntry`,
  工坊项目 `workshopOptions` / `enabledWorkshopProjectIds` / `toggleWorkshopProject`,
  `buildEnabledWorldBookEntries()`
- **选择**: `selectedEquipments/selectedItems/selectedSkills`, `activeCategory/rarityFilter/typeFilter`,
  `activeGroups` / `filteredPool` / `subCategories`, `isSelected` / `canSelect`, add/remove/update
- **背景**: `selectedBackground`, `customBackgroundText`, `activeBackgroundCategory` / `filteredBackgrounds`
- **剧情**（本店最大的一块）: 偏好/章节数/禁忌等设置 + `generatePlotOutline` / `reviseOutline` /
  `rollbackOutline` / 流式 `streamOutlineChat` + `plotStreamStats` + `abortPlotGeneration` +
  `outlineHistory` / `chaptersHistory` + 草稿 `DRAFT_KEY = 'plotOutlineDraft_v1'`
- **提交**: `buildCharacterState(saveId)` / `buildOpeningPrompt()` / `startJourney()` /
  `startJourneyAndClearDraft()` / `autoSaveDraft` / `tryRestoreDraft` / `clearDraft`
- **预设**: `showPresetModal`, `presets`, `getCurrentPresetData` / `applyPresetData`
- **重置**: `resetAll`

---

## 六、引擎层支撑文件

| 文件                                         | 内容                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sillytavern/start-catalog.ts`           | 75 行入口：整份 re-export 机制半边 + 属性名 / 品质码表 / 品质色 / 品质基础 DC / `DESTINY_CORE_WORLDBOOK_MAP`                                  |
| `src/sillytavern/start-catalog-mechanics.ts` | 324 行机制半边：schema/类型 + 难度档位/性别枚举/限定覆盖表 + `parseCatalogData` / `lookupCost` / `flattenLocationTree` / `classifyBackground` |
| `public/data/content/catalog.json`           | 七个池的**内容**（内容注册表 `catalog` 面，内容包可整份替换）                                                                                 |
| `src/sillytavern/database.ts`                | Dexie（现行 `DB_VERSION = 22`）；`createPresets` 表自 v7 起存在，随 FullBackup 进出                                                           |
| `src/sillytavern/types.ts`                   | `CreatePreset`（捏人预设**落库形状**，2026-08-17 分层收口时从 create-store 迁来，create-store 侧 re-export 同名）                             |

> 🪦 `start-catalog-data.ts`（8704 行）**已删**，内容搬进上表第三行那份 JSON。
> `start-catalog-mechanics.test.ts` 有一条结构闸门（导出名黑名单）盯着「别往机制文件里加具体条目」。

---

## 七、已知问题

1. **UI-01（P0，未修）** — 视觉禁用的装备仍可被选中：卡片级 click 守卫守不住内层「选择」按钮
   （`SelectableCard.vue` 内层按钮无条件 `$emit('select')` 且 `@click.stop`），store 侧
   `addEquipment/addItem/addSkill` 也从不复核 `canSelect`。可提交出负点数/不满足资格的存档。
   详见 `docs/known-issue.md` §UI-01 与 `docs/reviews/2026-08-12-ui-review.md` §UI-01。
2. **种族切换不清理技能** — 切种族后已选的种族专属技能仍留在列表里（无 race watcher）。
3. **等级下调不裁剪 AP** — `maxAP` 是 computed，`usedAP > maxAP` 时没有自动裁剪。
4. **装备/道具/技能仍依赖上游 CDN** — 与其余六面走内容注册表的口径不一致；离线/CDN 故障时
   静默变成空目录（只在界面上表现为「该分类暂无物品」）。
5. **剧情规划步骤体量过大** — 大纲生成/修订/流式/草稿全挤在 `create-store.ts` 一个 store 里
   （本店约 2234 行，剧情占了近一半）。
6. **测试覆盖偏薄** — 22 个组件只有 6 个测试文件，且 store 侧的选择约束（第 1 条）无回归测试。

> 已修复、旧文档仍列为问题的几条（2026-08-18 复核）：属性面板已表格化、CategorySelectionLayout
> 已建成、物品搜索已有、`/game/:id` 跳转已经不存在（改 `ui.navigate('game', saveId)`）、
> `伙伴系统` 占位组件已随零引用删除。

---

## 八、原版参考页面

原版捏人页 `custom_start_index.html`（341KB）**已随内容分离移入私有内容仓**
`fated_poem_independent_assets`，公开仓侧不可见（根 `reference/` 已被 `.gitignore` 整树排除）。
本机路径与用法见根 `AGENTS.md`「前端 UI 参考（Phase 7 必读）」一节；架构与逻辑的等效摘录在同目录
`reference_analysis.md`。

---

_最后更新: 2026-08-18（全文重写，基线 = 现行代码）_
