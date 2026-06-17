# Phase 7d 原版捏人页参考分析 — 页面架构与逻辑

> 分析对象: `reference/custom_start_index.html` (341KB, Vue 3 SPA, 单文件编译产物)
> 用途: 重构 CreatePage.vue 时的架构与逻辑参考。重点：页面架构 / 组件结构 / 数据流 / 关键逻辑。

---

## 一、运行时环境

原版作为 SillyTavern 插件运行，环境由外部注入：

| 依赖 | 来源 | 说明 |
|------|------|------|
| Vue 3 | ST 全局 `window.Vue` | `createApp`, `ref`, `computed`, `watch`, `onMounted`... |
| Pinia | CDN jsDelivr | `createPinia`, `defineStore`, `storeToRefs` |
| Vue Router | ST 全局 | `createMemoryHistory` (非 browser history，因为是弹窗内嵌) |
| Lodash (`_`) | ST 全局 | `mergeWith`, `isArray`, `isEqual` |
| jQuery (`$`) | ST 全局 | `$(fn)` DOM ready 回调 |
| `toastr` | ST 全局 | 通知弹窗 |
| `SillyTavern` API | ST 全局 | `getVariables`, `insertOrAssignVariables`, `substituteParams` |
| `Mvu` | ST 全局 | MVU 变量引擎，`getMvuData` / `replaceMvuData` |
| `createChatMessages` | ST 全局 | 发送消息到 AI |
| `triggerSlash` | ST 全局 | 触发斜杠命令 |
| `JSON5` | CDN | 解析含注释的 JSON |
| `klona` | CDN | 深克隆 |

**路由**: 使用 `createMemoryHistory`，因为页面在 ST 弹窗内运行，没有独立 URL。

---

## 二、路由与页面壳

### 2.1 路由结构

```
RouterView (App shell: <div class="creator-app">)
└── Layout (路由容器, name='Layout', path='/', redirect: '/basic')
    ├── /basic        → BasicInfo      (Step 1, meta: { title:'基础信息与属性', step:1 })
    ├── /selections   → Selections     (Step 2, meta: { title:'装备与技能', step:2 })
    ├── /background   → Background     (Step 3, meta: { title:'伙伴与初始背景', step:3 })
    └── /confirm      → Confirm        (Step 4, meta: { title:'确认提交', step:4 })
```

### 2.2 步骤名称映射

```javascript
const Je = { 1: 'BasicInfo', 2: 'Selections', 3: 'Background', 4: 'Confirm' };
const Qe = { 'BasicInfo': 1, 'Selections': 2, 'Background': 3, 'Confirm': 4 };

// 步骤定义
const Ue = [
  { title: '基础信息与属性', shortTitle: '信息/属性', step: 1 },
  { title: '装备与技能',     shortTitle: '装备/技能', step: 2 },
  { title: '伙伴与初始背景', shortTitle: '伙伴/背景', step: 3 },
  { title: '确认提交',       shortTitle: '确认',     step: 4 }
];
```

### 2.3 Layout 页面壳结构

```html
<div class="layout" data-v-xxx>
  <!-- 标题 -->
  <div class="title-section">
    <h1 class="main-title">命定之诗</h1>
    <p class="subtitle">角色创建</p>
  </div>

  <!-- 顶部控制栏 -->
  <HeaderControls>
    转生点: {{ availablePoints }}
    [随机点数] [预设管理]
  </HeaderControls>

  <!-- 步骤指示器 -->
  <Steps :current="currentStep" :steps="4" />

  <!-- 内容区 (带方向感知过渡动画) -->
  <ContentArea>
    <Transition :name="transitionName" mode="out-in">
      <router-view />
    </Transition>
  </ContentArea>

  <!-- 底部导航 -->
  <NavigationButtons
    :can-prev="canGoPrevious"
    :next-label="isLastStep ? '踏上旅程' : '下一步'"
    :next-disabled="availablePoints < 0"
    @prev @next />
</div>
```

**关键逻辑**:
- `transitionName` = 前进 `slide-left` / 后退 `slide-right` (比较新旧 route 的 step)
- `isLastStep` = `currentStep === 4`，按钮文字从"下一步"变为"踏上旅程"
- `isNextDisabled` = `availablePoints < 0` (点数不能为负)

---

## 三、组件树 (原版 40 个组件)

### 3.1 Shell/Layout 组件 (5 个)

| 组件 | Scope ID | 用途 |
|------|----------|------|
| `Layout` (index) | `data-v-3ba0e588` | 主布局: 标题 + 步骤条 + 内容区 + 导航 + 预设弹窗 |
| `ContentArea` | `data-v-422e4092` | 包裹 `<router-view>` + `<Transition>` 滑入滑出动画 |
| `HeaderControls` | `data-v-25795810` | 点数显示 + Roll 随机点数按钮 + 预设管理按钮 |
| `Steps` | `data-v-4595f292` | 水平步骤指示器 (`.step` + `.pass` 完成态) |
| `NavigationButtons` | `data-v-de8f52dc` | [上一步] [下一步/踏上旅程] 按钮组 |

### 3.2 Step 1 组件 (1 个)

| 组件 | Scope ID | 用途 |
|------|----------|------|
| `BasicInfo` | (无独立) | 基础信息表单 + 属性面板 |

### 3.3 Step 2 组件 (8 个)

| 组件 | Scope ID | 用途 |
|------|----------|------|
| `CategorySelectionLayout` | `data-v-0b4afefe` | 左侧分类导航 + 右侧内容区通用布局 |
| `CategoryTabs` | `data-v-53e67b8a` | 分类标签按钮 (装备/道具/技能) |
| `RarityFilter` | `data-v-0cb1e7b4` | 稀有度筛选按钮组 (7 级) |
| `ItemCard` | `data-v-59c411bc` | 物品卡片 (名称/标签/效果/描述/消耗) |
| `ItemList` | `data-v-6ed91820` | 物品列表容器 (搜索+筛选+分页) |
| `SelectedPanel` | `data-v-68795e6a` | 已选物品侧栏 (展示+移除+消耗汇总) |
| `CustomItemForm` | `data-v-4102fea8` | 自定义物品表单 Modal |
| `EquipmentEditor` / `SkillEditor` | `data-v-1821fd54` / `data-v-01050429` | 编辑现有物品 Modal |

### 3.4 Step 3 组件 (5 个)

| 组件 | Scope ID | 用途 |
|------|----------|------|
| `BackgroundList` | `data-v-20e63764` | 背景故事卡片列表 |
| `RequirementBadge` | `data-v-18788000` | 需求徽章 (种族/身份/地点，绿色满足/红色不满足) |
| `PartnerList` | `data-v-2e7bfa8a` | 伙伴卡片列表 |
| `CustomPartnerForm` | `data-v-253614da` | 自定义伙伴表单 (20+ 字段) |
| `AttributeEditor` | `data-v-e089f256` | 伙伴属性编辑器 |

### 3.5 Step 4 组件 (2 个)

| 组件 | Scope ID | 用途 |
|------|----------|------|
| `DestinyPointsExchange` | `data-v-c35365ee` | 命运点数兑换 (金主题卡片) |
| `MoneyExchangeCard` | `data-v-5acd2d02` | 金钱兑换控件 |

### 3.6 通用表单组件 (10 个)

| 组件 | Scope ID | 用途 |
|------|----------|------|
| `FormInput` | `data-v-68bda4ea` | 文本输入 |
| `FormTextarea` | `data-v-517d0cac` | 多行文本（自动高度） |
| `FormSelect` | `data-v-4a660eb2` | 下拉选择（可搜索） |
| `FormNumber` | `data-v-588d959c` | 数字输入 |
| `FormRadio` | `data-v-48d2dd58` | 单选按钮组 |
| `FormStepper` | `data-v-bf006b3c` | +/- 步进器 |
| `FormLabel` | `data-v-11a19624` | 标签 + required 标记 |
| `FormCascader` | `data-v-8dd65b4a` | 级联选择器（带搜索 + 树形展开） |
| `FormKeyValueInput` | `data-v-a1444030` | 键值对编辑器 |
| `FormArrayInput` | `data-v-62de9d7e` | 数组输入（可排序/增减） |

### 3.7 弹窗组件 (3 个)

| 组件 | Scope ID | 用途 |
|------|----------|------|
| `PresetModal` | `data-v-7f65fba9` | 预设管理弹窗 (保存/加载/导入/导出/删除/冲突处理) |
| `SavePresetConfirm` | `data-v-45c171a6` | "保存当前配置?" 确认弹窗 |
| `ConfirmModal` | `data-v-0a519f5e` | 通用确认对话框 |

---

## 四、关键 HTML 结构

### 4.1 Step 1: BasicInfo (基础信息与属性)

```html
<div class="basic-info-page">
  <!-- 两列 grid 布局 (form-row: 1fr 1fr) -->
  <div class="form-row">

    <!-- === 左列: 角色信息 === -->
    <div class="form-col">
      <FormInput v-model="name" label="角色名称" />
      <FormSelect v-model="gender" label="性别" :options="genders" />
      <!-- 选择"自定义"时展开 FormTextarea -->
      <FormTextarea v-if="isCustom(gender)" v-model="customGender" />

      <FormNumber v-model="age" label="年龄" :min="1" :max="9999" />
      <FormSelect v-model="race" label="种族" :options="raceCosts" />
      <FormTextarea v-if="isCustom(race)" v-model="customRace" />

      <FormSelect v-model="identity" label="身份" :options="identityCosts" />
      <FormTextarea v-if="isCustom(identity)" v-model="customIdentity" />

      <FormCascader v-model="startLocation" label="起始地点"
                    :options="startLocations" />
      <FormTextarea v-if="isCustom(startLocation)" v-model="customStartLocation" />
    </div>

    <!-- === 右列: 等级 + 属性 === -->
    <div class="form-col">
      <FormNumber v-model="level" label="等级" />
      <span class="level-indicator">{{ tierName }}</span>

      <!-- 属性面板表格 -->
      <div class="attributes-panel">
        <table>
          <thead>
            <tr>
              <th>属性</th>
              <th>基础</th>
              <th>层级</th>
              <th>额外</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="attr in ['力量','敏捷','体质','智力','精神']" :key="attr">
              <td class="attr-name">{{ attr }}</td>
              <td>
                <FormStepper v-model="basePoints[attr]" :max="6"
                  :disabled="remainingBP <= 0 && basePoints[attr] <= 0" />
              </td>
              <td class="attr-tier">{{ tierBonus }}</td>
              <td>
                <FormStepper v-model="attributePoints[attr]"
                  :disabled="remainingAP <= 0 && attributePoints[attr] <= 0" />
              </td>
              <td class="attr-result">
                <strong>{{ finalAttributes[attr] }}</strong>
              </td>
            </tr>
          </tbody>
        </table>

        <p class="points-status" :class="{ 'points-over': remainingBP < 0 }">
          基础点数剩余: {{ remainingBP }} / 25
          <br />
          额外点数剩余: {{ remainingAP }} / {{ maxAP }}
        </p>
      </div>
    </div>
  </div>
</div>
```

### 4.2 Step 2: Selections (装备选择)

```html
<div class="selections-page">
  <CategorySelectionLayout
    v-model="activeCategory"
    :categories="[
      { key: 'equipments', label: '装备', count: selectedEquipments.length },
      { key: 'items',      label: '道具', count: selectedItems.length },
      { key: 'skills',     label: '技能', count: selectedSkills.length }
    ]">

    <!-- 左侧分类导航栏 -->
    <template #sidebar="{ categories }">
      <CategoryTabs :categories="categories" />
    </template>

    <!-- 右侧内容区 -->
    <template #content>
      <!-- 子类型筛选 (装备: 武器/防具/饰品; 技能: 主动/被动) -->
      <div class="type-filter" v-if="activeCategory !== 'items'">
        <button v-for="t in subTypes" class="type-btn"
          :class="{ active: typeFilter === t }"
          @click="typeFilter = t">{{ t }}</button>
      </div>

      <!-- 稀有度筛选 -->
      <RarityFilter v-model="rarityFilter" />

      <!-- 物品列表 -->
      <ItemList :items="filteredPool" :search="searchText">
        <ItemCard v-for="item in visibleItems" :key="item.name"
          :item="item"
          :selected="isSelected(item)"
          :disabled="!canSelect(item)"
          @select="handleSelect(item)"
          @remove="handleRemove(item)" />
      </ItemList>
    </template>
  </CategorySelectionLayout>

  <!-- 右侧已选面板 (固定在布局右侧) -->
  <SelectedPanel
    :equipments="selectedEquipments"
    :items="selectedItems"
    :skills="selectedSkills"
    :total-cost="selectionsCost"
    @remove-equipment @remove-item @remove-skill />

  <!-- 自定义物品 -->
  <AppButton @click="showCustomForm = true">+ 自定义物品</AppButton>
  <CustomItemForm v-if="showCustomForm"
    :initial-category="activeCategory"
    @save="addCustomItem"
    @close="showCustomForm = false" />
</div>
```

**CategorySelectionLayout 结构** (可复用模式):

```html
<div class="category-selection-layout">
  <!-- 左侧分类导航 (固定宽度, 如 160px) -->
  <aside class="category-sidebar">
    <slot name="sidebar" :categories="categories" />
  </aside>

  <!-- 右侧: 过滤区 + 内容区 -->
  <div class="category-main">
    <div class="category-toolbar">
      <slot name="toolbar" />  <!-- 子类型过滤 + 稀有度过滤 -->
    </div>
    <div class="category-content" :style="{ maxHeight: contentMaxHeight }">
      <slot name="content" />
    </div>
  </div>
</div>
```

### 4.3 ItemCard (物品卡片)

```html
<div class="item-card"
  :class="{
    selected: selected,
    disabled: disabled,
    ['rarity-' + item.rarity]: true
  }"
  @click="!disabled && (selected ? $emit('remove') : $emit('select'))">

  <div class="card-body">
    <!-- 头部: 名称 + 稀有度徽章 -->
    <div class="card-header">
      <span class="item-name">{{ item.name }}</span>
      <span class="rarity-badge" :style="{ color: rarityColor(item.rarity) }">
        {{ rarityLabel(item.rarity) }}
      </span>
    </div>

    <!-- 类型标签 -->
    <span class="item-type">{{ item.type }}</span>

    <!-- Tag 标签数组 (最多显示 5 个) -->
    <div class="card-tags">
      <span v-for="t in item.tag.slice(0, 5)" class="tag">{{ t }}</span>
    </div>

    <!-- Effect 效果键值对 -->
    <div class="card-effects" v-if="item.effect && Object.keys(item.effect).length">
      <span v-for="(v, k) in item.effect" class="effect-line">
        <strong>{{ k }}:</strong> {{ v }}
      </span>
    </div>

    <!-- 消耗 (MP/SP) -->
    <div class="card-consume" v-if="item.consume">
      消耗: <strong>{{ item.consume }}</strong>
    </div>

    <!-- 描述 (截断) -->
    <div class="card-desc">{{ truncate(item.description, 100) }}</div>

    <!-- 转生点数消耗 -->
    <div class="card-cost">消耗: <strong>{{ item.cost }}</strong> 点</div>
  </div>

  <!-- 操作按钮 (悬停显示) -->
  <div class="card-action" v-show="!disabled">
    <button v-if="!selected" class="btn-select">选择</button>
    <button v-else class="btn-remove">移除</button>
  </div>
</div>
```

### 4.4 Step 3: Background (伙伴与初始背景)

```html
<div class="background-page">
  <!-- 左区: 初始背景 -->
  <section class="background-section">
    <h2>初始剧情</h2>
    <BackgroundList :items="backgrounds" :selected="selectedBackground"
                    @select="setBackground">
      <template #card="{ item, isSelected, isDisabled }">
        <div class="background-card"
          :class="{ selected: isSelected, disabled: isDisabled }"
          @click="!isDisabled && setBackground(item)">

          <h3>{{ item.name }}</h3>

          <!-- 需求徽章 (种族/身份/地点) -->
          <div class="requirements">
            <RequirementBadge v-if="item.requiredRace"
              :required="item.requiredRace"
              :current="character.race"
              mode="race" />
            <RequirementBadge v-if="item.requiredIdentity"
              :required="item.requiredIdentity"
              :current="character.identity"
              mode="identity" />
            <RequirementBadge v-if="item.requiredLocation"
              :required="item.requiredLocation"
              :current="character.startLocation"
              mode="location" />
          </div>

          <!-- 描述 (截断 100 字) -->
          <p class="desc" v-html="truncatedDescription(item)"></p>

          <span class="cost">{{ item.cost || 0 }} 点</span>
        </div>
      </template>
    </BackgroundList>

    <!-- 自定义开局 (始终可选) -->
    <div class="background-card custom"
      :class="{ selected: isCustomSelected }"
      @click="selectCustom">
      <h3>✎ 自定义开局</h3>
      <FormTextarea v-if="isCustomSelected"
        v-model="customBackgroundDescription"
        placeholder="描述你想要的初始剧情..." />
    </div>
  </section>

  <!-- 右区: 命定之人 (伙伴) -->
  <section class="partner-section">
    <h2>命定之人</h2>
    <PartnerList :items="partners"
      :selected="selectedPartners"
      @select @remove />
    <AppButton @click="showCustomPartner = true">+ 自定义伙伴</AppButton>
    <CustomPartnerForm v-if="showCustomPartner"
      @save="addCustomPartner"
      @close="showCustomPartner = false" />
  </section>

  <!-- 底部粘性汇总条 -->
  <div class="summary-sticky">
    <span>已选背景: <strong>{{ selectedBackground?.name || '无' }}</strong></span>
    <span>伙伴: <strong>{{ selectedPartners.length }} 人</strong></span>
    <span>总消耗: <strong>{{ totalCost }}</strong> 点</span>
  </div>
</div>
```

### 4.5 Step 4: Confirm (确认提交)

```html
<div class="confirm-page" style="max-width: 900px">
  <!-- 头部 -->
  <div class="confirm-header">
    <h1>角色确认</h1>
    <p>请确认以下信息无误后踏上旅程</p>
  </div>

  <!-- 点数汇总 4 列卡片 -->
  <div class="points-section">
    <div class="point-card">
      <span class="label">总转生点</span>
      <span class="value">{{ reincarnationPoints }}</span>
    </div>
    <div class="point-card">
      <span class="label">已消耗</span>
      <span class="value">{{ consumedPoints }}</span>
    </div>
    <div class="point-card">
      <span class="label">可用</span>
      <span class="value" :class="{ negative: availablePoints < 0 }">
        {{ availablePoints }}
      </span>
    </div>
    <div class="point-card">
      <span class="label">等级经验</span>
      <span class="value">Lv.{{ level }}</span>
    </div>
  </div>

  <!-- 角色摘要 Card -->
  <div class="confirm-card">
    <!-- 角色头部 -->
    <div class="hero-row">
      <div class="avatar" :style="avatarStyle"> <!-- 圆形头像占位 --> </div>
      <div class="hero-info">
        <span class="hero-name">{{ name }}</span>
        <span class="hero-meta">{{ race }} | {{ identity }}</span>
        <span class="hero-tier">Lv.{{ level }} {{ tierName }}</span>
        <span class="hero-location">起始地点: {{ startLocation }}</span>
      </div>
    </div>

    <!-- 资源条 -->
    <div class="resource-row">
      <ResourceBar label="HP" :current="hpPreview" :max="hpPreview" />
      <ResourceBar label="MP" :current="mpPreview" :max="mpPreview" />
      <ResourceBar label="SP" :current="spPreview" :max="spPreview" />
    </div>

    <!-- 五维属性 -->
    <div class="attr-row">
      <span v-for="attr in ATTRIBUTES">
        {{ attr.cn }}: {{ attr.base }} + {{ attr.tier }} + {{ attr.extra }}
        = <strong>{{ attr.final }}</strong>
      </span>
    </div>

    <!-- 物品摘要 -->
    <div class="stats-row">
      装备 ×{{ selectedEquipments.length }}
      技能 ×{{ selectedSkills.length }}
      道具 ×{{ selectedItems.length }}
      伙伴 ×{{ selectedPartners.length }}
      背景: {{ selectedBackground?.name || '无' }}
    </div>

    <!-- 物品 Chip 列表 -->
    <div class="items-summary" v-if="hasItems">
      <h4>装备 / 技能 / 道具</h4>
      <span v-for="item in allItems" class="item-chip">
        {{ item.name }}
        <span class="rarity-dot" :style="{ background: rarityColor(item.rarity) }"></span>
      </span>
    </div>

    <!-- 命运点数兑换 -->
    <DestinyPointsExchange v-if="destinyPoints > 0"
      v-model="destinyPoints"
      @exchange="handleExchange" />
  </div>

  <p class="points-hint">
    💡 剩余转生点数: {{ availablePoints }}
  </p>
</div>
```

### 4.6 PresetModal (预设管理弹窗)

```html
<Teleport to="body">
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal-container preset-modal">
      <!-- 头部 -->
      <div class="modal-header">
        <h3>{{ mode === 'manage' ? '角色预设管理' : '加载预设' }}</h3>
        <button class="close-btn" @click="$emit('close')">✕</button>
      </div>

      <!-- 保存区 -->
      <div class="save-row" v-if="mode === 'manage'">
        <input v-model="presetName" placeholder="输入预设名称…"
               @keyup.enter="handleSave" />
        <button @click="handleSave" :disabled="!presetName.trim()">
          {{ isOverwrite ? '确认覆盖' : '保存当前配置' }}
        </button>
        <!-- 重名警告 -->
        <p v-if="nameExists && !isOverwrite" class="warning-text">
          预设名已存在，再次点击确认覆盖
        </p>
      </div>

      <!-- 预设列表 -->
      <div class="preset-list">
        <div v-for="p in presets" :key="p.name" class="preset-item">
          <div class="preset-main">
            <span class="preset-name">{{ p.name }}</span>
            <span class="preset-meta">
              {{ p.character?.name || '未命名' }}
              · Lv.{{ p.character?.level || 1 }}
              · 装{{ p.equipments?.length || 0 }}
              技{{ p.skills?.length || 0 }}
            </span>
            <span class="preset-time">{{ formatTime(p.updatedAt) }}</span>
          </div>
          <div class="preset-actions">
            <button @click="handleLoad(p)">加载</button>
            <button @click="handleExport(p)">导出</button>
            <button @click="deleteConfirmId = p.name">
              {{ deleteConfirmId === p.name ? '确认删除' : '删除' }}
            </button>
          </div>
        </div>

        <!-- 空状态 -->
        <p v-if="!presets.length" class="empty-text">暂无存档预设</p>
      </div>

      <!-- 底部操作 -->
      <div class="modal-footer">
        <button @click="handleImport" class="btn-import">📥 导入预设文件</button>
        <button @click="handleExportAll" class="btn-export-all"
                :disabled="!presets.length">📤 全部导出</button>
        <button @click="$emit('close')" class="btn-cancel">关闭</button>
      </div>

      <!-- 导入冲突弹窗 (子 Modal) -->
      <ConfirmModal v-if="conflictData"
        :title="'导入冲突'"
        :message="`预设 '${conflictData.name}' 已存在，是否覆盖？`"
        @confirm="resolveConflict('overwrite')"
        @cancel="resolveConflict('skip')" />
    </div>
  </div>
</Teleport>
```

---

## 五、Pinia Store 架构

### 5.1 `character` Store (核心状态)

```javascript
defineStore('character', () => {
  // ===== 状态 =====
  const character = ref({
    name: '', gender: '', customGender: '',
    age: 18, race: '', customRace: '',
    identity: '', customIdentity: '',
    startLocation: '', customStartLocation: '',
    level: 1,
    basePoints:      { 力量:0, 敏捷:0, 体质:0, 智力:0, 精神:0 },
    attributePoints: { 力量:0, 敏捷:0, 体质:0, 智力:0, 精神:0 },
    reincarnationPoints: 1000,
    destinyPoints: 0,
    money: 0,
  })

  const selectedEquipments = ref([])
  const selectedItems      = ref([])
  const selectedSkills     = ref([])
  const selectedPartners   = ref([])
  const selectedBackground = ref(null)

  // ===== 核心 Computed =====
  // 点数计算
  const consumedPoints = computed(() =>
    raceCost(character.value.race) +
    identityCost(character.value.identity) +
    sumCost(selectedEquipments.value) +
    sumCost(selectedItems.value) +
    sumCost(selectedSkills.value) +
    sumCost(selectedPartners.value) +
    (selectedBackground.value?.cost || 0) +
    Math.floor(character.value.money / 100) +
    Math.floor(character.value.destinyPoints / 2)
  )

  // BP (基础点数) — 固定 25，每属性上限 6
  const maxBP = 25
  const usedBP = computed(() => sum(character.value.basePoints))
  const remainingBP = computed(() => maxBP - usedBP.value)

  // AP (额外点数) — 随等级变化 = max(0, level-1)
  const maxAP = computed(() => Math.max(0, character.value.level - 1))
  const usedAP = computed(() => sum(character.value.attributePoints))
  const remainingAP = computed(() => maxAP.value - usedAP.value)

  // 最终属性 = 基础 + 层级加成 + 额外
  const tier = computed(() => w(character.value.level))
  const tierBonus = computed(() => tier.value)  // 0-6
  const finalAttributes = computed(() => {
    const attrs = {}
    for (const key of ['力量','敏捷','体质','智力','精神']) {
      attrs[key] = character.value.basePoints[key] + tierBonus.value + character.value.attributePoints[key]
    }
    return attrs
  })

  // ===== 核心 Watchers =====
  // Level 变化 → 重置 attributePoints (flush: 'sync')
  watch(() => character.value.level, () => {
    character.value.attributePoints = { 力量:0, 敏捷:0, 体质:0, 智力:0, 精神:0 }
  })

  // Race 变化 → 移除不属于该种族的技能
  watch(() => character.value.race, (newRace) => {
    selectedSkills.value = selectedSkills.value.filter(s =>
      !s.requiredRace || s.requiredRace === newRace ||
      DEFAULT_UNIVERSAL_SKILLS.includes(s.id)
    )
  })

  // ===== Actions =====
  function updateCharacterField(key, value) { /* ... */ }
  function addBasePoint(attr)     { /* 上限 6, 受 remainingBP 约束 */ }
  function removeBasePoint(attr)  { /* 下限 0 */ }
  function addAttributePoint(attr)  { /* 受 remainingAP 约束 */ }
  function removeAttributePoint(attr) { /* 下限 0 */ }
  function rollInitialPoints() {
    // 三次方随机: floor(random()^3 * 9000 + 1000)
    // 测试名直接给 888888
  }
  function resetCharacter() { /* 重置所有状态 */ }
  // ... 装备/道具/技能/伙伴 CRUD
})
```

### 5.2 `customContent` Store (自定义内容)

```javascript
defineStore('customContent', () => {
  const customBackgroundDescription = ref('')
  const editingCustomItemName = ref('')
  const editingCustomPartnerName = ref('')

  const customItemForm = ref({
    categoryType: 'equipment',  // 'equipment' | 'item' | 'skill'
    customItemType: '',         // 子类型
    itemName: '', itemRarity: 'common',
    itemTag: [], itemEffect: {},
    itemDescription: '', itemConsume: '', itemQuantity: 1,
  })

  const customPartnerForm = ref({
    name: '', level: 1, race: '', identity: [],
    career: [], personality: '',
    attributes: { 力量:0, 敏捷:0, 体质:0, 智力:0, 精神:0 },
    skills: [], equipment: [],
    stairway: '', contract: '', affinity: 0,
    // ... 20+ 字段
  })
})
```

---

## 六、关键 JavaScript 逻辑

### 6.1 层级计算

```javascript
// 等级 → 层级索引 (0-6)
function w(level) {
  if (level <= 4)  return 0;   // T1 第一层级
  if (level <= 8)  return 1;   // T2
  if (level <= 12) return 2;   // T3
  if (level <= 16) return 3;   // T4
  if (level <= 20) return 4;   // T5
  if (level <= 24) return 5;   // T6
  return 6;                    // T7 第七层级
}

// 层级 → 中文名
function S(level) {
  const tiers = ['第一层级','第二层级','第三层级','第四层级','第五层级','第六层级','第七层级'];
  return tiers[w(level)];
}
```

### 6.2 稀有度系统

```javascript
const RARITY_LEVELS = [
  { key: 'common',    label: '普通', color: '#9e9e9e' },
  { key: 'uncommon',  label: '优良', color: '#4caf50' },
  { key: 'rare',      label: '稀有', color: '#2196f3' },
  { key: 'epic',      label: '史诗', color: '#9c27b0' },
  { key: 'legendary', label: '传说', color: '#ff9800' },
  { key: 'mythic',    label: '神话', color: '#f44336' },
  { key: 'only',      label: '唯一', color: '#00bcd4' },
];

function rarityLabel(key) { return RARITY_LEVELS.find(r => r.key === key)?.label || key; }
function rarityColor(key) { return RARITY_LEVELS.find(r => r.key === key)?.color || '#999'; }
function rarityIndex(key) { return RARITY_LEVELS.findIndex(r => r.key === key); }
```

### 6.3 转生点数随机

```javascript
function rollInitialPoints() {
  // 三次方分布 (偏右偏): Math.random()^3 * 9000 + 1000 → [1000, 10000]
  const roll = Math.floor(Math.pow(Math.random(), 3) * 9000 + 1000);
  character.value.reincarnationPoints = roll;

  // 测试/开发名 → 直接给满
  if (['测试','test','debug'].some(k => character.value.name.toLowerCase().includes(k))) {
    character.value.reincarnationPoints = 888888;
  }
}
```

### 6.4 物品选中验证器 (Composable 工厂)

```javascript
function createSelectionValidator(sourceRef, costFn) {
  const { availablePoints } = useCharacterStore(); // 或传入

  return {
    isSelected(item) {
      return sourceRef.value.some(s => s.name === item.name || s.id === item.id);
    },
    canSelect(item) {
      return availablePoints.value >= costFn(item) && !this.isSelected(item);
    },
    isDisabled(item) {
      if (item.requiredRace && item.requiredRace !== character.value.race) return true;
      if (item.requiredIdentity && item.requiredIdentity !== character.value.identity) return true;
      return !this.canSelect(item);
    },
  };
}
```

### 6.5 背景需求匹配

```javascript
function meetsRequirements(background) {
  // 地点使用前缀匹配 (层级匹配: "索伦蒂斯王国-王都" startsWith "索伦蒂斯王国")
  const raceMatch     = !background.requiredRace ||
    character.value.race === background.requiredRace;
  const identityMatch = !background.requiredIdentity ||
    character.value.identity === background.requiredIdentity;
  const locationMatch = !background.requiredLocation ||
    character.value.startLocation === background.requiredLocation ||
    character.value.startLocation.startsWith(background.requiredLocation + '-');

  return raceMatch && identityMatch && locationMatch;
}
```

### 6.6 RequirementBadge 匹配模式

| mode | 匹配方式 | 示例 |
|------|---------|------|
| `race` | 精确匹配 | `requiredRace: '人族'` → `current: '人族'` ✅ |
| `identity` | 精确匹配 | `requiredIdentity: '冒险者'` → `current: '冒险者'` ✅ |
| `location` | 前缀匹配 | `requiredLocation: '索伦蒂斯王国'` → `current: '索伦蒂斯王国-王都'` ✅ |

### 6.7 深度模板替换 (用于背景描述)

```javascript
function deepSubstituteParams(data) {
  // 递归遍历对象/数组，对所有字符串调用 SillyTavern.substituteParams()
  // 把 {{user}} {{char}} 等模板变量替换为实际值
  if (typeof data === 'string') return SillyTavern.substituteParams(data);
  if (Array.isArray(data)) return data.map(deepSubstituteParams);
  if (typeof data === 'object' && data !== null) {
    const result = {};
    for (const [k, v] of Object.entries(data)) {
      result[k] = deepSubstituteParams(v);
    }
    return result;
  }
  return data;
}
```

---

## 七、数据加载

### 7.1 CDN 数据源

原版从 GitHub jsDelivr CDN 加载 5 个 JSON 文件 (JSON5 格式，含注释):

| 文件 | 内容 | 加载时机 |
|------|------|----------|
| `baseInfo.json` | 性别/种族费/身份费/起始地点 | 模块初始化 (立即) |
| `equipments.json` | ~28 件装备 | Step 2 挂载时 (懒加载单例) |
| `items.json` | ~16 种道具 | Step 2 挂载时 (懒加载单例) |
| `skills.json` | ~20 个技能 | Step 2 挂载时 (懒加载单例) |
| `backgrounds.json` | ~6 个背景 | Step 3 挂载时 |
| `partners.json` | 伙伴数据 | Step 3 挂载时 |

### 7.2 加载模式

```javascript
// IIFE 异步加载 + 懒加载单例
const defaultData = { /* 内联默认值 */ };
let cachedData = null;

function getData() { return cachedData || defaultData; }

!(async function() {
  const response = await fetch(CDN_URL);
  const text = await response.text();
  const remote = JSON5.parse(text);  // 支持注释的 JSON
  cachedData = deepMerge(defaultData, remote);
})();
```

### 7.3 合并策略

```javascript
function deepMerge(defaults, remote) {
  return _.mergeWith({}, defaults, remote, (objVal, srcVal) => {
    // 数组: 拼接 (default 在前, remote 在后)
    if (_.isArray(objVal)) return [...objVal, ...srcVal];
    // 标量: remote 覆盖 default
    // (不返回, 走默认 mergeWith 行为)
  });
}
```

---

## 八、预设系统

### 8.1 存储机制

```javascript
// 读取: SillyTavern character variables → start_presets
function getPresets() {
  const vars = getVariables({ type: 'character' });
  return vars['start_presets'] || { presets: [], lastUsedPreset: null };
}

// 写入
function savePresets(data) {
  insertOrAssignVariables({ start_presets: data }, { type: 'character' });
}
```

### 8.2 预设数据结构

```json
{
  "presets": [
    {
      "name": "我的预设名",
      "createdAt": 1718000000000,
      "updatedAt": 1718100000000,
      "character": { /* character store 完整状态 (klona 深克隆) */ },
      "equipments": [ /* 装备数组 */ ],
      "items": [ /* 道具数组 */ ],
      "skills": [ /* 技能数组 */ ],
      "partners": [ /* 伙伴数组 */ ],
      "background": { /* 背景对象或 null */ }
    }
  ],
  "lastUsedPreset": "上次使用的预设名"
}
```

### 8.3 操作一览

| 操作 | 关键逻辑 |
|------|---------|
| 保存 | 同名检查 → 二次点击确认覆盖 → `klona` 深克隆所有状态 → 写入变量 |
| 加载 | 读取预设 → 恢复 character / equipments / items / skills / partners / background |
| 导出单个 | `JSON.stringify(preset)` → Blob → `URL.createObjectURL` → `<a download>` |
| 全部导出 | 同上，导出整个 `{ presets }` 对象 |
| 导入 | FileReader → JSON5.parse → 验证结构 → 冲突检查 (同名: 跳过/覆盖) → 合并 |
| 删除 | 二次确认 → `splice(index, 1)` → 写入 |

### 8.4 预设自动匹配 (踏上旅程前)

```javascript
function findMatchingPreset(character, selections, background) {
  // 遍历所有 presets，用 _.isEqual 深度比对
  // character + equipments + items + skills + partners + background
  return presets.find(p =>
    _.isEqual(p.character, character) &&
    _.isEqual(p.equipments, selections.equipments) &&
    _.isEqual(p.items, selections.items) &&
    _.isEqual(p.skills, selections.skills) &&
    _.isEqual(p.partners, selections.partners) &&
    _.isEqual(p.background, background)
  );
}
```

---

## 九、提交流水线 (Journey Start)

### 9.1 完整流程

```
"踏上旅程" 按钮点击 (Step 4)
  │
  ├─→ findMatchingPreset()
  │     ├─ 找到匹配 → 跳过保存询问，直接执行
  │     └─ 未找到 → 弹出 SavePresetConfirm
  │           ├─ 保存 → 打开 PresetModal (manage 模式) → 保存后执行
  │           ├─ 跳过 → 直接执行
  │           └─ 取消 → 留在 Step 4
  │
  └─→ executeJourney()
        │
        ├─→ await waitGlobalInitialized('Mvu')
        │
        ├─→ MVU 变量写入 (Mvu.replaceMvuData):
        │     - stat_data.命运点数  ← character.destinyPoints
        │     - stat_data.主角.技能  ← skills[] (非自定义)
        │     - stat_data.主角.背包  ← items[] (非自定义)
        │     - stat_data.主角.金钱  ← character.money
        │     - stat_data.主角.等级  ← character.level
        │     - stat_data.关系列表   ← partners[] (完整属性+装备+技能)
        │
        ├─→ 构建 AI Prompt 文本:
        │     ┌──────────────────────────────────────┐
        │     │ 角色信息:                              │
        │     │   名称: xxx                             │
        │     │   性别: xxx / 年龄: xxx / 种族: xxx      │
        │     │   身份: xxx / 起始地点: xxx               │
        │     │   等级: Lv.N (TN)                      │
        │     │                                        │
        │     │ 五维属性:                               │
        │     │   力量: N  敏捷: N  体质: N              │
        │     │   智力: N  精神: N                      │
        │     │                                        │
        │     │ 初始装备 (N件):                          │
        │     │   - [稀有度] 名称 (类型)                  │
        │     │     tag: [...]                         │
        │     │     effect: { ... }                    │
        │     │                                        │
        │     │ 初始技能 (N个):                          │
        │     │   - [稀有度] 名称 (主动/被动)             │
        │     │     消耗: xxx                           │
        │     │     effect: { ... }                    │
        │     │                                        │
        │     │ 初始道具 (N种):                          │
        │     │   - [稀有度] 名称 ×数量                   │
        │     │                                        │
        │     │ 自定义装备/技能/道具: ...                 │
        │     │                                        │
        │     │ 命定之人 (N人):                          │
        │     │   - 名称 (种族/身份/职业)                  │
        │     │     个性: xxx                           │
        │     │                                        │
        │     │ 初始背景:                                │
        │     │   (背景描述文本)                         │
        │     │                                        │
        │     │ 根据<status_current_variables>          │
        │     │ 和以上内容，生成一个符合描述和            │
        │     │ 情景的初始剧情！                          │
        │     └──────────────────────────────────────┘
        │
        ├─→ createChatMessages([{ role: 'user', message: prompt }])
        │
        └─→ triggerSlash('/trigger')   // 触发 AI 生成
```

### 9.2 关键集成点 (Phase 7d 需替换)

| 原版 | Phase 7d 替代方案 |
|------|------------------|
| `Mvu.getMvuData` / `Mvu.replaceMvuData` | `StateManager.commitChatState()` |
| `getVariables` / `insertOrAssignVariables` | `database.ts` → `createPresets` 表 (Dexie/IndexedDB) |
| `createChatMessages` + `triggerSlash` | `AgentOrchestrator.run()` |
| `SillyTavern.substituteParams` | 本地实现的模板引擎 |
| `toastr.*` | `ToastContainer` (已有) |

---

## 十、CSS / 视觉设计

### 10.1 设计风格

- **暖色羊皮纸风格** (Warm Parchment): 米色底 `#f5efe6`，金色强调 `#d4af37`，棕色文字 `#5c4033`
- 卡片式 UI: `background: rgba(240,230,210,0.95)` + `border-radius: 8px` + 阴影
- 表单两列 grid 布局 (`form-row: 1fr 1fr`)
- 属性面板 table 布局 (5 列: 属性名 | 基础 | 层级 | 额外 | 结果)

### 10.2 CSS 变量

```css
:root {
  --primary-bg: #f5efe6;
  --card-bg: rgba(240, 230, 210, 0.95);
  --input-bg: #fff9f0;
  --border-color: #d4c4b0;
  --border-color-strong: #8b7355;
  --text-color: #3a3a3a;
  --text-light: #666666;
  --title-color: #5c4033;
  --accent-color: #d4af37;
  --error-color: #d32f2f;
  --success-color: #388e3c;
  --button-bg: #c6b8a5;
  --button-hover: #b0a295;
  --points-color: #5c4033;

  --font-title: 'Cinzel', serif;
  --font-body: 'Segoe UI', 'Microsoft YaHei', sans-serif;
  --font-mono: 'Monaco', 'Menlo', monospace;

  --spacing-xs: 4px;   --spacing-sm: 8px;   --spacing-md: 12px;
  --spacing-lg: 16px;  --spacing-xl: 24px;

  --radius-sm: 2px;  --radius-md: 4px;  --radius-lg: 8px;

  --shadow-sm: 0 1px 3px rgba(0,0,0,0.1);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.12);
  --shadow-lg: 0 4px 16px rgba(0,0,0,0.15);

  --transition-fast: 0.15s ease-in-out;
  --transition-normal: 0.3s ease-in-out;
}
```

### 10.3 响应式断点

| 断点 | 行为 |
|------|------|
| 768px | 单列布局，更大触摸目标 (min-height: 44px) |
| 480px | 全宽按钮，属性表格折叠为标签行 |

---

## 十一、原版 vs 当前实现 关键差异

| 维度 | 原版 (custom_start_index.html) | 当前 Phase 7d 实现 |
|------|-------------------------------|---------------------|
| 步骤数 | **4 步** (信息/选择/背景/确认) | **7 步** (难度/基础/核心/选择/背景/剧情/确认) |
| 框架 | Vue 3 + Pinia + Router (CDN 注入) | Vue 3 + Pinia + Router (Vite 本地编译) |
| CSS | 单 `<style>` 块, scoped, 暖色羊皮纸 | 主题 CSS 变量系统 (10 主题) |
| 表单组件 | 10 个自定义 Form* 组件 | 已有 FormInput/FormSelect/FormStepper/FormCascader |
| Step 2 布局 | `CategorySelectionLayout` (左侧分类+右侧内容) | `CategoryTabs` + `QualityFilter` + `1fr 260px` grid |
| 伙伴系统 | Step 3 完整伙伴系统 (PartnerList + CustomPartnerForm) | `PartnerWorldBookPanel` (占位 `<details>`) |
| 预设存储 | ST character variables | IndexedDB `createPresets` 表 (database.ts v7) |
| 提交方式 | MVU 变量 + `/trigger` 斜杠命令 | `AgentOrchestrator.run()` + 独立的开场提示词 |
| 数据来源 | CDN JSON + JSON5 解析 | `start-catalog.ts` 内联常量 |
| 类型检查 | 无 (纯 JS) | TypeScript |
| 测试 | 无 | Vitest (待写) |

---

## 十二、值得采用的架构模式

1. **步骤间方向感知 Transition 动画** — `slide-left`(前进) / `slide-right`(后退)，提升 UX
2. **属性面板表格布局** — 5 列表格 (属性/基础/层级/额外/结果) 直观明了
3. **CategorySelectionLayout 通用布局** — 左侧分类导航 + 右侧过滤+内容的模式可复用
4. **RequirementBadge 需求徽章** — 绿色满足/红色不满足，直观展示背景选择限制
5. **预设保存前询问** — "踏上旅程"时自动检查是否有匹配预设，无匹配则提示保存
6. **属性计算公式** — `w(level)` 和 `S(level)` 必须与后端 `tier-constants.ts` 一致
7. **转生点数随机算法** — `Math.random()^3 * 9000 + 1000`，偏右分布，保留到 `create-store.ts`
8. **物品验证器工厂** — `createSelectionValidator(source, costFn)` 可复用模式
9. **背景需求前缀匹配** — 地点用 `startsWith(req.location + '-')` 支持层级匹配
10. **Confirm 页面 4 列点数卡片** — 总转生点/已消耗/可用/等级，信息一目了然

---

## 十三、原版已知缺陷

1. **无 TypeScript** — 纯 JS，无类型检查，维护困难
2. **单文件编译产物** — 341KB 全打入一个文件，组件不可独立复用
3. **全局依赖注入** — 依赖 ST 全局变量 (`$`, `_`, `toastr`, `Mvu`...)，无法独立运行
4. **无测试** — 没有任何测试文件
5. **无表单验证库** — 全用 computed + 内联逻辑，边界情况易遗漏
6. **CDN 硬编码** — 数据文件 URL 写死不支持离线
7. **无统一加载状态** — 异步加载没有统一的 loading/error/skeleton 处理
8. **CSS 无设计系统** — 有变量但无组件级主题切换
9. **Step 2 物品子分类不完善** — 装备按"剑类/斧类/..."子分类在原数据中未完善
10. **@click.self 关闭 Modal 易误触** — 滚动选择时可能意外关闭

---

*文档结束。新 session 重构时请参考此文档了解原版页面架构，结合 `phase7d_current_state.md` 了解当前实现状态。*
