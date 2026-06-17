# Phase 7d 捏人页 — 当前状态文档

> 供新 session 重构参考。重点：HTML 结构 / 数据来源 / 已知问题。

---

## 一、页面路由 & 入口

```
/create  →  CreatePage.vue (单页, 7步骤状态机, Pinia step 切换, 不用子路由)
```

`CreatePage.vue` 结构：
```
CreatePage
├── CreateSteps       (顶部 7 步指示器: 0难度/1基础/2核心/3选择/4背景/5剧情/6确认)
├── PointsBar         (转生点数消耗条, 显示 剩余/总量 + 难度标签)
├── <component :is>   (步骤内容区, Suspense + defineAsyncComponent 懒加载)
├── CreateFooter      (底部: [角色预设] [←上一步] [下一步→])
└── PresetModal       (预设管理弹窗, v-model 控制显隐)
```

---

## 二、组件树 (20 个 .vue)

```
src/ui/components/create/
├── CreatePage.vue               ← 步骤容器 + preset 弹窗开关
├── CreateSteps.vue              ← 7 步指示器 (dot 样式)
├── CreateFooter.vue             ← 底部导航栏
├── PointsBar.vue                ← 点数进度条
│
├── CreateStepDifficulty.vue     ← Step 0: 6 张难度卡片
├── CreateStepBasic.vue          ← Step 1: 表单 + BP/AP + ResourceBar
│   └── AttributeEditor.vue      ← 五维属性 +/- 步进器
├── CreateStepDestinyCore.vue    ← Step 2: 24 核心 3 列网格
│   └── DestinyCoreCard.vue      ← 单张核心卡片
├── CreateStepSelections.vue     ← Step 3: 装备/道具/技能 选择
│   ├── CategoryTabs.vue         ← [装备] [道具] [技能] 标签
│   ├── QualityFilter.vue        ← rarity 筛选按钮组
│   ├── SelectableCard.vue       ← 物品卡片 (tag/effect/desc/cost)
│   ├── SelectedPanel.vue        ← 已选列表
│   ├── PartnerWorldBookPanel.vue← 伙伴折叠面板 (占位)
│   └── CustomItemForm.vue       ← 自定义物品 Modal
├── CreateStepBackground.vue     ← Step 4: 背景故事
│   └── BackgroundList.vue       ← 预设背景卡片
├── CreateStepPlot.vue           ← Step 5: 剧情规划
│   └── PlotOutlinePreview.vue   ← 大纲预览 (空/加载中/模糊/揭示)
├── CreateStepConfirm.vue        ← Step 6: 确认创建 (摘要卡片)
│
├── PresetModal.vue              ← 预设管理弹窗 (保存/加载/导入导出)
└── CustomItemForm.vue           ← 自定义物品表单 Modal
```

---

## 三、关键 HTML 结构

### 3.1 CreatePage (容器)
```html
<div class="create-page">
  <CreateSteps :current="n" :total="7" />
  <PointsBar :total :used :difficulty-label />
  <main class="create-content">
    <Suspense>
      <component :is="stepComponents[n]" />
      <div class="step-loading">加载中…</div>
    </Suspense>
  </main>
  <CreateFooter :can-prev :can-next :next-label @prev @next @open-preset />
  <PresetModal :visible @close />
</div>
```

### 3.2 Step 1 (基础信息)
```html
<section class="step-basic">
  <h2>基本信息</h2>
  <div class="form-grid">
    <FormInput v-model="name" label="角色名" />
    <FormSelect v-model="gender" label="性别" />
    <FormStepper v-model="age" label="年龄" />
    <FormSelect v-model="race" label="种族" />
    <FormSelect v-model="identity" label="身份" />
    <FormSelect v-model="startLocation" label="起始地点" />
  </div>
  <div class="level-row">
    <FormStepper v-model="level" label="等级" />
    <span>T{{ tier }} {{ tierName }}</span>
  </div>
  <!-- BP 区 -->
  <section class="attr-section">
    <h3>基础属性 (BP) — 已用{{ usedBP }}/25</h3>
    <div class="attr-list">
      <AttributeEditor v-for attr :key label model-value max remaining @inc @dec />
    </div>
  </section>
  <!-- AP 区 -->
  <section class="attr-section">
    <h3>额外属性 (AP) — 已用{{ usedAP }}/{{ maxAP }}</h3>
    ...同上...
  </section>
  <!-- 资源预览 -->
  <section class="preview-section">
    <h3>属性预览</h3>
    <div class="preview-bars">
      <ResourceBar label="HP" />
      <ResourceBar label="MP" />
      <ResourceBar label="SP" />
    </div>
    <div class="final-attrs">
      <span>力量: <strong>N</strong></span> ×5
    </div>
  </section>
  <!-- 初始资源 -->
  <section class="money-section">
    <h3>初始资源</h3>
    <FormStepper label="金钱 (G)" />
    <FormStepper label="命运点数 (FP)" />
  </section>
  <!-- 消耗摘要 -->
  <div class="cost-summary">种族/身份/装备/道具/技能 消耗</div>
</section>
```

### 3.3 Step 3 (装备选择)
```html
<section class="step-selections">
  <CategoryTabs :categories="[{装备},{道具},{技能}]" v-model="activeCategory" />
  <QualityFilter v-model="rarityFilter" />    <!-- [全部][普通][优良]...[唯一] -->
  <div class="type-filter" v-if>              <!-- [全部][武器][防具][饰品] -->
    <button v-for class="type-btn" />
  </div>
  <div class="selection-layout">              <!-- grid: 1fr 260px -->
    <div class="pool-pane">
      <SelectableCard v-for="item in filteredPool" :item :selected @select @remove />
    </div>
    <div class="selected-pane">
      <SelectedPanel :items :title @remove />
    </div>
  </div>
  <AppButton @click="showCustomForm=true">+ 自定义物品</AppButton>
  <PartnerWorldBookPanel />                  <!-- <details> 折叠面板, 占位 -->
  <CustomItemForm :visible @save @close />
</section>
```

### 3.4 SelectableCard (物品卡片)
```html
<div class="selectable-card" :class="{selected, disabled}">
  <div class="card-body">
    <div class="card-header">
      <span class="item-name">{{ name }}</span>
      <QualityBadge :quality size="sm" />
      <span class="item-type">{{ type }}</span>
    </div>
    <div class="card-tags">                  <!-- tag[] chips -->
      <span v-for="t in item.tag.slice(0,5)" class="tag">{{ t }}</span>
    </div>
    <div class="card-effects">               <!-- effect{} lines -->
      <span v-for="(v,k) in item.effect" class="effect-line">{{ k }}: {{ v }}</span>
    </div>
    <div class="card-cost">消耗: <strong>{{ cost }}</strong> 点</div>
    <div class="card-desc">{{ description }}</div>
  </div>
  <div class="card-action">
    <AppButton v-if="!selected" size="sm">选择</AppButton>
    <AppButton v-else size="sm" variant="danger">移除</AppButton>
  </div>
</div>
```

### 3.5 PresetModal (预设管理)
```html
<AppModal :open="visible" @close>
  <template #header>角色预设</template>
  <div class="save-row">
    <input v-model="presetName" placeholder="输入预设名称…" />
    <AppButton @click="handleSave">保存当前配置 / 确认覆盖</AppButton>
  </div>
  <div class="preset-list">
    <div v-for="p in presets" class="preset-item">
      <div class="preset-main">
        <span class="preset-name">{{ p.name }}</span>
        <span class="preset-meta">{{ characterName }} · Lv.N · 装N 技N</span>
        <span class="preset-time">{{ formatTime(p.updatedAt) }}</span>
      </div>
      <div class="preset-actions">
        <AppButton @click="handleLoad">加载</AppButton>
        <AppButton @click="handleExport">导出</AppButton>
        <AppButton @click="deleteConfirmId=p.id">删除</AppButton>
        <!-- 二次确认: [确认删除] [取消] -->
      </div>
    </div>
  </div>
  <div class="modal-footer">
    <AppButton @click="handleImport">导入预设文件</AppButton>
    <AppButton @click="handleExportAll">全部导出</AppButton>
    <AppButton @click="emit('close')">关闭</AppButton>
  </div>
</AppModal>
```

### 3.6 Step 6 (确认创建)
```html
<section class="step-confirm">
  <h2>确认角色</h2>
  <div class="confirm-card">
    <div class="hero-row">
      <AvatarPanel :name size="lg" />
      <div class="hero-info">
        <span class="hero-name">{{ name }}</span>
        <span class="hero-meta">{{ race }} | {{ identity }}</span>
        <span class="hero-tier">Lv.N TN tierName</span>
        <span class="hero-location">起始: {{ location }}</span>
        <span class="hero-core">命定之灵: {{ core.name }} ({{ core.author }})</span>
      </div>
    </div>
    <div class="resource-row">
      <ResourceBar HP / MP / SP
    </div>
    <div class="attr-row">力量:N 敏捷:N ...</div>
    <div class="stats-row">装备×N 技能×N 道具×N 背景: name 大纲: ✅/⚠</div>
    <div class="items-summary" v-if>
      <h4>装备/技能/道具</h4>
      <span v-for class="item-chip">{{ name }} <QualityBadge /></span>
    </div>
  </div>
  <p class="points-remaining">💡 剩余转生点数: N</p>
</section>
```

---

## 四、数据来源 (全部真实 CDN 数据, 不乱编)

| 数据 | 文件 | 数量 |
|------|------|------|
| 装备 | `start-catalog.ts` → `DEFAULT_EQUIPMENT_POOL` | 417 件 (来自 CDN `equipments.json`) |
| 道具 | `start-catalog.ts` → `DEFAULT_ITEM_POOL` | 171 种 (来自 CDN `items.json`) |
| 技能 | `create-store.ts` 异步加载 CDN `skills.json` | 470 个 |
| 背景 | `start-catalog.ts` → `DEFAULT_BACKGROUNDS` | 51 个 (来自 CDN `backgrounds.json`) |
| 命定核心 | `start-catalog.ts` → `DEFAULT_DESTINY_CORES` | 24 个 (来自 `world_book_index.md` §4.1) |
| 种族费用 | `start-catalog.ts` → `DEFAULT_RACE_COSTS` | 22 条 (来自 CDN `baseInfo.json`) |
| 身份费用 | `start-catalog.ts` → `DEFAULT_IDENTITY_COSTS` | 30+ 条 (来自 CDN `baseInfo.json`) |
| 起始地点 | `start-catalog.ts` → `START_LOCATIONS` | 5 大区 (来自 CDN `baseInfo.json`) |
| 性别选项 | `start-catalog.ts` → `GENDER_OPTIONS` | 8 个 (来自 CDN `baseInfo.json`) |
| 难度预设 | `start-catalog.ts` → `DIFFICULTY_PRESETS` | 6 档 (主人定制) |

**原版源码参考**: `_frontend_ref/src/custom_start/core/` (已 clone 到本地)

---

## 五、Store (`create-store.ts`)

- **步骤控制**: `currentStep` (0-6), `stepValid`, `nextStep/prevStep`
- **难度**: `difficulty`, `selectDifficulty(id)`, 6 档
- **角色 (→ 变量)**: name/gender/age/race/identity/startLocation/level/basePoints/attributePoints
- **属性联动**: tier/tierName/tierBonus/finalAttributes/hpPreview/mpPreview/spPreview
- **BP**: maxBP=25, perAttr=6, addBasePoint/removeBasePoint
- **AP**: maxAP=max(0,level-1), addAttributePoint/removeAttributePoint
- **经济**: reincarnationPoints/destinyPoints/money, totalCost/remainingPoints
- **命定核心**: destinyCore, selectDestinyCore
- **选择 (→ 开场提示词)**: selectedEquipments/selectedItems/selectedSkills, activeCategory/rarityFilter/typeFilter, filteredPool, add/remove
- **背景**: selectedBackground, customBackgroundText
- **剧情**: plotMode/plotSettings/plotOutline/isPlotGenerating
- **提交**: `buildCharacterState()` (变量路径, equipment/skills/inventory 置空), `buildOpeningPrompt()` (JSON 结构化), `startJourney()` (写 DB + 跳转)
- **预设**: showPresetModal, presets, getCurrentPresetData/applyPresetData
- **重置**: resetAll

---

## 六、已完成的引擎层文件

| 文件 | 内容 |
|------|------|
| `src/sillytavern/start-catalog.ts` | 所有捏人数据池 (~500行) |
| `src/sillytavern/database.ts` | v7 升级 + `createPresets` 表 + CRUD |

---

## 七、已知问题 (待重构修复)

1. **UI 太丑** — 没有参考原版的暗色主题 / 卡片样式 / 间距系统
2. **Step 3 装备选择** — 子分类 (sub-category) 缺失, 原版按"剑类武器/斧类武器"等分组
3. **Step 1 表单** — 原版用 `form-row` 两列布局, 我们现在是全单列
4. **Step 3 左右分栏** — 原版 `40%/60%` 分割, 我们现在 `1fr 260px` 
5. **整体色调** — 原版暗金主题, 我们的 CSS 变量没有正确继承
6. **CustomItemForm** — 标签/效果的 UI 输入体验不好 (小 input 挤在一起)
7. **Step 5 剧情规划** — 占位, 没有真正调用 AI
8. **Step 6 跳转** — `/game/:id` 页面还没做, 跳转会 404
9. **伙伴系统** — PartnerWorldBookPanel 只是占位 `<details>`
10. **测试** — 新建的组件没有对应的 `.test.ts` 文件
11. **createPresets 表的 deleteSaveSlot 级联删除** — 未处理

---

## 八、原版参考文件路径

```
_frontend_ref/src/custom_start/core/
├── layout/index.vue                    ← 整体布局 (暗金标题 + Steps + NavigationButtons)
├── views/BasicInfo/index.vue           ← 基础信息页 (form-row 两列布局)
├── views/Selections/index.vue          ← 装备选择页 (CategorySelectionLayout 模式)
│   └── components/
│       ├── CategoryTabs.vue
│       ├── CustomItemForm.vue
│       ├── ItemList.vue
│       ├── RarityFilter.vue
│       └── SelectedPanel.vue
├── views/Background/index.vue          ← 背景故事页
│   └── components/
│       ├── BackgroundList.vue
│       ├── AttributeEditor.vue
│       ├── EquipmentEditor.vue
│       ├── SkillEditor.vue
│       ├── PartnerList.vue
│       └── DestinyPointsExchange.vue
├── views/Confirm/index.vue             ← 确认创建页
├── store/character.ts                  ← 角色 Store
├── store/customContent.ts              ← 自定义内容 Store
├── data/equipments.ts                  ← 装备数据加载
├── data/Items.ts                       ← 道具数据加载
├── data/skills.ts                      ← 技能数据加载
├── data/backgrounds.ts                 ← 背景数据加载
├── data/constants.ts                   ← 常量
├── data/base-info.ts                   ← 基础信息 (种族/身份/地点/属性公式)
├── types/index.ts                      ← 类型定义
└── utils/loader.ts                     ← CDN 数据加载器
```

---

*文档结束。新 session 请从原版 `_frontend_ref` 参考 UI 样式, 数据层 (`start-catalog.ts` / `create-store.ts`) 可保留。*
