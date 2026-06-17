# Phase 7d 差距分析: 基础信息与属性 × 装备与技能

> 对比: 原版 `custom_start_index.html` vs 当前 `src/ui/components/create/`
> 目标: 找出 UI/UX/逻辑 层面的具体差距，按优先级列出待改进项

---

## 一、Step 1: 基础信息与属性

### 1.1 表单布局: 单列 → 两列 grid

**原版**:
```
┌─ form-row (grid: 1fr 1fr) ───────────────────────────────┐
│  左列: 角色名/性别/年龄/种族/身份/起始地点                   │
│  右列: 等级 + 层级标记 + 属性面板表格                        │
└──────────────────────────────────────────────────────────┘
```

**当前**:
```
┌─ form-grid (flex column) ────────────┐
│  角色名                                │
│  性别                                  │
│  年龄                                  │
│  种族                                  │
│  身份                                  │
│  起始地点                              │
│  等级                                  │
│  BP 区                                 │
│  AP 区                                 │
└──────────────────────────────────────┘
```

**差距**: 当前全单列 max-width:560px，信息密度低，右侧大量留白。原版用两列 grid 更紧凑，视觉组织更好。

**建议**: 768px+ 时启用两列 grid，左列放角色信息表单，右列放等级+属性面板。

---

### 1.2 属性面板: 列表 → 5 列表格 ⭐ 最重要

**原版** (属性面板表格):
```html
<div class="attributes-panel">
  <table>
    <thead>
      <tr>
        <th>属性</th>
        <th>基础</th>     <!-- BP stepper -->
        <th>层级</th>     <!-- 自动计算 tierBonus -->
        <th>额外</th>     <!-- AP stepper -->
        <th>结果</th>     <!-- 最终值 = BP + tier + AP -->
      </tr>
    </thead>
    <tbody>
      <tr v-for="attr in ['力量','敏捷','体质','智力','精神']">
        <td class="attr-name">{{ attr }}</td>
        <td><FormStepper :model-value="basePoints[attr]" :max="6" /></td>
        <td class="attr-tier">+{{ tierBonus }}</td>
        <td><FormStepper :model-value="attributePoints[attr]" /></td>
        <td class="attr-result"><strong>{{ finalAttributes[attr] }}</strong></td>
      </tr>
    </tbody>
  </table>
  <p class="points-status">
    基础点数剩余: {{ remainingBP }} / 25
    额外点数剩余: {{ remainingAP }} / {{ maxAP }}
  </p>
</div>
```

**当前** (两个分离的 BP/AP 列表 + 单独的预览区):
```html
<!-- BP 区 -->
<section class="attr-section">
  <h3>基础属性 (BP) — 已用 {{ usedBP }} / {{ MAX_BP }}</h3>
  <div class="attr-list">
    <AttributeEditor v-for="attr" ... />  <!-- 只有 +/- 和当前值 -->
  </div>
</section>

<!-- AP 区 -->
<section class="attr-section">
  <h3>额外属性 (AP) — 已用 {{ usedAP }} / {{ maxAP }}</h3>
  <div class="attr-list">
    <AttributeEditor v-for="attr" ... />
  </div>
</section>

<!-- 预览区 (单独) -->
<section class="preview-section">
  <div class="final-attrs">
    <span>力量: <strong>N</strong></span> ×5
  </div>
</section>
```

**差距**:

| 方面 | 原版 | 当前 |
|------|------|------|
| 信息组织 | 一张表同时展示 5 属性×4 维度 | BP 区/AP 区/预览区三块分离 |
| 空间 | 紧凑，一眼看完 | 分散，需要上下滚动 |
| BP/AP 关系 | 在同一行，直观看到每属性的贡献 | 分开，不直观 |
| 层级加成 | 表格中单独列 `+T` | 只在底部注脚提到 |
| 最终结果 | 表格最后一列 `= BP+T+AP` | 需要到预览区才能看到 |
| 点数状态 | 表格底部一行汇总 | 每个 section 独立 h3 |

**建议**: 
1. 合并为一个 5 列属性表格: `属性 | 基础(BP) | 层级 | 额外(AP) | 结果`
2. 层级加成列显示 `+{{ tierBonus }}`，灰色只读
3. 结果列用粗体金色突出
4. 底部显示 `剩余 BP: N/25 | 剩余 AP: N/maxAP`
5. 保留右侧 ResourceBar 预览 (HP/MP/SP)

---

### 1.3 "自定义"字段的内联展开

**原版**:
选择"自定义"选项时，在 select 下方直接展开 `FormTextarea`，视觉关联明确:
```html
<FormSelect v-model="race" :options="raceCosts" />
<FormTextarea v-if="isCustom(race)" v-model="customRace" />
```
当前也做了 (`v-if="store.race === '自定义'"`)，但用的是 `FormInput` 而非 `FormTextarea`，且位置可以更紧凑（缩小与上方 select 的间距）。

**建议**: 把"自定义"选项统一加标记（如 `「自定义种族」✦`），且自定义输入框与上方 select 间距缩小为 0（看起来像是 select 展开的一部分）。

---

### 1.4 层级指示器

**原版**:
```
Lv. [stepper] → 第一层级 (Lv.1-4)
```
层级名用金色/棕色字体，层级范围和名称在同一行，视觉在等级 stepper 旁边。

**当前**:
```html
<div class="level-row">
  <FormStepper v-model="store.level" label="等级" :min="1" :max="25" />
  <span class="tier-info">
    → <strong>T{{ store.tier }} {{ store.tierName }}</strong>
    <span class="tier-range">(Lv.1-4)</span>
  </span>
</div>
```
功能正确但样式偏弱。

**建议**: 层级指示器加 `QualityBadge` 风格的金色徽章 + 更大字号，让玩家对"层级提升"有直观感受。

---

### 1.5 资源预览

**原版**: 没有独立的资源预览区（HP/MP/SP 在最终确认页才显示）

**当前**: Step 1 就有 ResourceBar 预览

**评价**: 这是当前实现的 **优势**！原版没有实时预览，玩家要到最后一步才知道 HP/MP/SP。保留这个。

---

## 二、Step 3: 装备与技能选择

### 2.1 分类导航: 水平 Tabs → 垂直侧栏 ⭐ 最重要

**原版** (`CategorySelectionLayout`):
```
┌────────────┬─────────────────────────────────────┐
│  装备 (3)  │  [全部] [稀有] [史诗] ...            │  ← 过滤区
│            │  [全部] [武器] [防具] [饰品]          │  ← 子类型
│  道具 (1)  │                                      │
│            │  ┌─────────────────────────────────┐ │
│  技能 (2)  │  │  ItemCard × N                    │ │  ← 内容区
│            │  │  ItemCard × N                    │ │
│            │  │  ...                             │ │
│            │  └─────────────────────────────────┘ │
│            │                                      │
│  (160px)   │  (flex: 1)                           │
└────────────┴─────────────────────────────────────┘
         + 右侧 SelectedPanel (固定)
```

**当前** (水平 Tabs + 堆叠过滤):
```
┌──────────────────────────────────────────┐
│  [装备] [道具] [技能]         ← 等宽水平  │
│  [全部][普通][优良]...[唯一]   ← 水平过滤  │
│  [全部][武器][防具][饰品]      ← 水平子类型│
│                                           │
│  ┌─ pool-pane ───┬─ selected-pane ─┐     │
│  │  ItemCard × N  │  已选列表        │     │
│  │  ItemCard × N  │                 │     │
│  │  ...           │                 │     │
│  └───────────────┴─────────────────┘     │
└──────────────────────────────────────────┘
```

**差距**:

| 方面 | 原版 | 当前 |
|------|------|------|
| 分类导航 | 垂直侧栏，固定可见 | 水平 Tabs，会随滚动消失 |
| 分类切换 | 点击侧栏按钮，内容区即时切换 | 水平标签切换，OK 但占用垂直空间 |
| 空间利用 | 内容区全宽 (flex:1) | 左右分栏 1fr 260px |
| 选中计数 | 侧栏按钮上显示 badge (装备 (3)) | 无 |
| 视觉层次 | 侧栏 + 工具栏 + 内容三层清晰 | 全部堆叠，层次模糊 |

**建议**: 实现 `CategorySelectionLayout` 模式：
- 左侧 140-160px 垂直侧栏导航
- 每个分类按钮显示已选数量 badge
- 右侧: 过滤工具栏 (sticky) + 可滚动内容区
- 已选面板放在右侧固定或在内容区底部独立显示

---

### 2.2 物品卡片: SelectableCard 增强 ⭐

**原版 ItemCard**:
```html
<div class="item-card" :class="{ selected, disabled, ['rarity-' + rarity]: true }"
     @click="!disabled && (selected ? remove() : select())">
  <div class="card-body">
    <div class="card-header">
      <span class="item-name">{{ name }}</span>
      <span class="rarity-badge" :style="{ color: rarityColor }">{{ rarityLabel }}</span>
    </div>
    <span class="item-type">{{ type }}</span>
    <div class="card-tags">...</div>
    <div class="card-effects">
      <span v-for="(v,k) in effect" class="effect-line">
        <strong>{{ k }}:</strong> {{ v }}
      </span>
    </div>
    <div class="card-consume" v-if="consume">消耗: <strong>{{ consume }}</strong></div>
    <div class="card-desc">{{ truncate(desc, 100) }}</div>
    <div class="card-cost">消耗: <strong>{{ cost }}</strong> 点</div>
  </div>
  <div class="card-action" v-show="!disabled">
    <button v-if="!selected">选择</button>
    <button v-else>移除</button>
  </div>
</div>
```

**当前 SelectableCard**:
```html
<div class="selectable-card" :class="{ selected, disabled }">
  <div class="card-body">
    <div class="card-header">
      <span class="item-name">{{ name }}</span>
      <QualityBadge :quality size="sm" />
      <span class="item-type">{{ type }}</span>
    </div>
    <div class="card-tags">...</div>
    <div class="card-effects">...</div>
    <div class="card-cost">消耗: {{ cost }} 点</div>
    <div class="card-desc">{{ description }}</div>
  </div>
  <div class="card-action">
    <AppButton v-if="!selected" size="sm">选择</AppButton>
    <AppButton v-else size="sm" variant="danger">移除</AppButton>
  </div>
</div>
```

**差距**:

| 方面 | 原版 | 当前 |
|------|------|------|
| 整卡可点击 | `@click` 在整张卡片上 | 只能通过 AppButton 操作 |
| 稀有度色边框 | `rarity-epic` 类 → 左边框带稀有度色 | 无 |
| 稀有度标签 | 彩色文字标签 (如"史诗"紫色) | QualityBadge 组件 ✅ |
| `consume` 字段 | 独立显示 (如"攻击: 400MP") | **缺失** |
| disabled 态 | opacity + 不响应点击 | opacity: 0.45 ✅ |
| hover 态 | 边框变色 + 轻微上浮 | 无 hover 动画 |
| selected 态 | 金色边框 + 浅金背景 | 边框+背景变色 ✅ |
| 卡片间距 | 紧凑但清晰 | `gap: var(--theme-spacing-xs)` 偏紧 |

**建议**:
1. **整卡可点击**: 在 `.selectable-card` 上加 `@click`，disabled 时不响应。AppButton 保留作为明确操作区
2. **稀有度左边框**: 添加 `.rarity-epic { border-left: 3px solid #9c27b0 }` 等
3. **consume 字段**: 在 card-cost 上方添加 `card-consume` 行
4. **hover 态**: `transform: translateY(-1px); box-shadow: var(--shadow-md);`
5. **卡片间距**: 从 `xs` 改为 `sm` (8px)

---

### 2.3 SelectedPanel: 始终可见 + 消耗汇总 ⭐

**原版 SelectedPanel**:
- 固定在右侧，始终可见
- 标题显示 "已选装备 (3)"
- 每个 item: `名称 QualityBadge ×数量 消耗Btn  [✕]`
- 底部有消耗汇总: `装备: N点 | 道具: N点 | 技能: N点 = 合计: N点`
- 分类间有分隔线或在独立面板

**当前**:
- 只在选中某个分类时显示该分类的已选面板
- 无消耗汇总
- 无分类聚合视图

**差距**:

| 方面 | 原版 | 当前 |
|------|------|------|
| 可见性 | 始终显示所有已选 | 切换分类时只显示当前分类 |
| 消耗汇总 | 底部有总消耗 | 无 |
| 跨分类视图 | 装备+道具+技能在同一面板分三区 | 按分类独立显示 |

**建议**:
1. SelectedPanel 始终显示，内容分为三区: 装备 / 道具 / 技能
2. 每区: `标题 (N件) | 消耗: N点`
3. 底部: `合计消耗: N 转生点`
4. 已选物品用紧凑 Chip 样式

---

### 2.4 原版缺失但当前有的功能 (保留!)

| 功能 | 说明 |
|------|------|
| ResourceBar 预览 | Step 1 HP/MP/SP 实时预览 ✅ (原版无) |
| 难度选择 Step 0 | 6 档难度卡片 ✅ (原版用随机点数替代) |
| 命定核心 Step 2 | 24 核心选择 ✅ (原版无，直接嵌入 Step 3) |
| 剧情规划 Step 5 | AI 大纲生成 ✅ (原版无) |

---

## 三、逻辑层面差距

### 3.1 物品选中禁用逻辑

**原版** — 三层禁用检查:
```javascript
function isDisabled(item) {
  // 1. 点数不足
  if (availablePoints < item.cost) return true;
  // 2. 种族限制 (技能专属)
  if (item.requiredRace && item.requiredRace !== character.race) return true;
  // 3. 身份限制
  if (item.requiredIdentity && item.requiredIdentity !== character.identity) return true;
  // 4. 同类唯一 (某些唯一品质物品)
  if (item.rarity === 'only' && alreadyHasSameType(item)) return true;
  return false;
}
```

**当前** — 仅检查点数:
```typescript
// create-store.ts: isSelected(item) 仅检查名字是否在列表中
// 没有 requiredRace/requiredIdentity 的禁用检查
```

**建议**: 在 `create-store.ts` 的 `canSelect` computed 中加入种族/身份/唯一性检查。

---

### 3.2 种族切换时自动清理技能

**原版** — watcher:
```javascript
watch(() => character.race, (newRace) => {
  selectedSkills = selectedSkills.filter(s =>
    !s.requiredRace || s.requiredRace === newRace || UNIVERSAL_SKILLS.includes(s.id)
  );
});
```

**当前**: 无此逻辑。玩家切换种族后，之前选的种族专属技能仍然在已选列表中。

**建议**: 在 `create-store.ts` 中添加 race watcher，自动移除不兼容的已选技能。

---

### 3.3 Level 变化时重置 AP

**原版** — watcher `flush: 'sync'`:
```javascript
watch(() => character.level, () => {
  character.attributePoints = { 力量:0, 敏捷:0, 体质:0, 智力:0, 精神:0 };
}, { flush: 'sync' });
```

**当前**: `maxAP` 是 computed (`max(0, level-1)`)，但如果 level 降低导致 `usedAP > maxAP`，没有自动裁剪。

**建议**: 添加 level watcher，当 `usedAP > maxAP` 时裁剪 attributePoints。

---

### 3.4 物品搜索/筛选

**原版**: `ItemList` 组件内带搜索框 + 稀有度筛选 + 子类型筛选三层过滤。

**当前**: 只有 QualityFilter + type buttons，无文本搜索。

**建议**: 在 pool-pane 顶部添加搜索 input，支持按名称/tag 文本过滤。

---

## 四、视觉/UI 风格差距

### 4.1 卡片设计语言

**原版**: 暖羊皮纸风格，卡片有质感
- 卡片背景: `rgba(240, 230, 210, 0.95)` — 半透明暖色
- 稀有度左边框: 3px solid color
- 阴影层次: `shadow-sm/md/lg` 三级
- 圆角: `8px`
- 字体: Cinzel (标题) + Segoe UI (正文)

**当前**: 使用主题变量，但缺少「质感」
- 卡片过于扁平 (border: 1px solid + 纯色背景)
- 没有稀有度色边框
- 没有 hover 上浮动画

**建议**: 
1. 添加稀有度左边框色
2. hover 时 `translateY(-1px)` + `box-shadow`
3. 背景可以考虑半透明 + 轻微纹理 (可选)

---

### 4.2 属性面板视觉对比

**原版**:
```
┌─────────────────────────────────────────────┐
│  属性      基础      层级      额外      结果  │
│  ─────────────────────────────────────────  │
│  力量    [− 3 +]    +2     [− 1 +]    ▸ 6  │
│  敏捷    [− 2 +]    +2     [− 0 +]      4  │
│  体质    [− 4 +]    +2     [− 2 +]    ▸ 8  │
│  智力    [− 3 +]    +2     [− 0 +]      5  │
│  精神    [− 2 +]    +2     [− 1 +]      5  │
│  ─────────────────────────────────────────  │
│  基础点数剩余: 14 / 25                       │
│  额外点数剩余: 4 / 7                         │
└─────────────────────────────────────────────┘
```
(Markdown 模拟，实际用 HTML table + steppers)

**当前**:
```
基础属性 (BP) — 已用 14 / 25
  力量 [− 3 +] / 6
  敏捷 [− 2 +] / 6
  体质 [− 4 +] / 6
  智力 [− 3 +] / 6
  精神 [− 2 +] / 6

额外属性 (AP) — 已用 4 / 7
  力量 [− 1 +] / 99
  ...

属性预览
  力量: 6  敏捷: 4  体质: 8  智力: 5  精神: 5
  （基础 + 层级加成 T2=+2 + 额外）
```

**差距明显**: 原版一眼看到 5 属性×4 维度的完整画像。当前需要切换注意力三次。

---

### 4.3 响应式差距

**原版**:
- 768px: 两列变单列，表单元素 min-height:44px (触摸友好)
- 480px: 属性表格折叠，隐藏列头，改用标签行展示

**当前**:
- 仅 700px 时 selection-layout 变为单列
- Step 1 无响应式处理

---

## 五、优先级改进清单

### P0 — 属性面板表格化 ⭐⭐⭐
**内容**: 将 BP/AP/预览三个分离区域合并为一张 5×4 属性表格
**影响**: 信息密度提升 3×，UX 提升最明显
**工作量**: 中等 (重写 `CreateStepBasic.vue` 的属性部分)

### P1 — CategorySelectionLayout 侧栏导航 ⭐⭐⭐
**内容**: 将水平 CategoryTabs 改为左侧垂直侧栏
**影响**: 分类切换更方便，空间利用更好
**工作量**: 中等 (新建 `CategorySelectionLayout.vue`)

### P2 — SelectableCard 增强 ⭐⭐
**内容**: 整卡可点击、稀有度左边框、consume 字段显示、hover 动效
**影响**: 物品卡片交互体验大幅提升
**工作量**: 小 (增强 `SelectableCard.vue`)

### P3 — SelectedPanel 聚合 ⭐⭐
**内容**: 始终可见、三区聚合 (装备/道具/技能)、底部消耗汇总
**影响**: 玩家随时看到全局选择状态
**工作量**: 小 (重写 `SelectedPanel.vue`)

### P4 — 禁用逻辑补全 ⭐
**内容**: 种族限制、身份限制、唯一性检查、level→AP 裁剪
**影响**: 防止非法选择
**工作量**: 小 (修改 `create-store.ts`)

### P5 — 响应式适配 ⭐
**内容**: Step 1 两列→单列响应式、属性表格移动端标签行
**影响**: 移动端可用性
**工作量**: 中等

### P6 — 搜索框 ⭐
**内容**: pool-pane 顶部物品名称/tag 文本搜索
**影响**: 物品池大时必备
**工作量**: 小

---

## 六、当前实现的优势 (不要丢掉!)

| 优势 | 说明 |
|------|------|
| TypeScript | 类型安全，原版纯 JS |
| 主题系统 | 10 主题可切换，原版写死暖色 |
| ResourceBar 预览 | Step 1 就能看到 HP/MP/SP |
| 难度选择 + 命定核心 | 原版没有的 Step 0/2 |
| 剧情规划 | 原版没有的 AI 大纲 |
| 组件拆分 | 20 个独立 .vue，原版单文件 341KB |
| Vite 编译 | 本地构建，原版 CDN 依赖 |

---

*文档结束。建议优先解决 P0-P2，这三个改动对用户体验提升最大。*
