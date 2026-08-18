# 状态栏 (Status Bar) 页面架构分析

> 基于 [FrontEnd-for-destined-journey](https://github.com/The-poem-of-destiny/FrontEnd-for-destined-journey) 源码逆向分析
>
> 原始文件：`dist/status/index.html` (496KB, React 18 + Zustand + immer + GSAP + OpenSeadragon)
>
> 源码目录：`src/status/` (React + TypeScript + SCSS Modules + Zod)
>
> 分析日期：2026-06-17

---

## 一、总览

状态栏是《命定之诗》角色卡中的**核心信息面板**，以窗口式布局嵌入 SillyTavern 对话界面。它通过 SillyTavern 的 MVU（Message Variable Update）系统读取/写入角色数据，提供一个可切换 6 个 Tab 的完整游戏状态查看与编辑界面。

### 技术栈

| 层级     | 技术                  | 用途                               |
| -------- | --------------------- | ---------------------------------- |
| UI 框架  | React 18 + TypeScript | 组件渲染                           |
| 状态管理 | Zustand + immer       | 全局状态 + 不可变更新              |
| 样式     | SCSS Modules          | 组件级样式隔离                     |
| 动画     | GSAP (useGSAP)        | Tab 切换淡入动画                   |
| 数据校验 | Zod                   | stat_data 运行时校验               |
| 地图     | OpenSeadragon         | 深度缩放地图查看器                 |
| 图标     | Font Awesome 6        | 图标系统                           |
| 工具库   | Lodash                | `_.get`/`_.set`/`_.unset` 深度操作 |

### 外部依赖

```typescript
// CDN 导入（6 个运行时，Phase 7e 需本地实现）
import OpenSeadragon from 'openseadragon'; // 地图查看器
import { produce } from 'immer'; // 不可变更新
import gsap from 'gsap'; // 动画引擎
import _ from 'lodash'; // 工具函数
import { Schema } from '@/data_schema'; // Zod 数据模式
import { create } from 'zustand'; // 状态管理
```

---

## 二、页面架构 — 窗口式布局

### 2.1 整体布局结构

```
┌─────────────────────────────────────────────────────┐
│  Window (status-window)                             │
│  ┌─────────────────────────────────────────────────┐│
│  │  TitleBar                                       ││
│  │  [时间] [地点]        [全屏] [刷新] [设置]        ││
│  ├─────────────────────────────────────────────────┤│
│  │  TabBar                                          ││
│  │  [任务] [信息] [持有物] [命定] [新闻] [地图]       ││
│  ├─────────────────────────────────────────────────┤│
│  │  ContentArea (GSAP 淡入动画)                     ││
│  │  ┌─────────────────────────────────────────────┐││
│  │  │  {当前 Tab 内容}                             │││
│  │  │                                             │││
│  │  │  6 个 Tab 面板之一:                          │││
│  │  │  QuestsTab / StatusTab / ItemsTab            │││
│  │  │  DestinyTab / NewsTab / MapTab               │││
│  │  │                                             │││
│  │  │  或 SettingsTab (覆盖替换 Tab 内容)           │││
│  │  └─────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

### 2.2 布局组件职责

| 组件          | 文件                                 | 职责                                                              |
| ------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `Window`      | `layout/Window/Window.tsx`           | 根容器，初始化时触发数据加载+主题加载+CSS变量应用                 |
| `TitleBar`    | `layout/TitleBar/TitleBar.tsx`       | 顶部栏：显示世界时间/地点 + 全屏切换 + 刷新 + 设置按钮            |
| `TabBar`      | `layout/TabBar/TabBar.tsx`           | Tab 导航条：6 个 Tab + Badge(任务数)，可配置 disabled             |
| `ContentArea` | `layout/ContentArea/ContentArea.tsx` | 内容容器，使用 `useGSAP` 做 0.35s 淡入动画（children 切换时触发） |

### 2.3 路由机制

**无 URL 路由** — 纯状态驱动，与我们的 Phase 7 单 URL 架构一致：

```typescript
// App.tsx 核心路由逻辑
const [activeTab, setActiveTab] = useState(DefaultTabId); // 当前 Tab
const [showSettings, setShowSettings] = useState(false); // 设置页覆盖

// 渲染优先级：
// 1. showSettings → SettingsTab
// 2. activeTab → 对应 Tab 组件
// 3. default → "未知页面"
```

### 2.4 Tab 配置

```typescript
// config/tabs.config.ts
const TabsConfig = [
  { id: 'quests', label: '任务', icon: 'fa-scroll' },
  { id: 'status', label: '信息', icon: 'fa-user' }, // 默认
  { id: 'items', label: '持有物', icon: 'fa-briefcase' },
  { id: 'destiny', label: '命定', icon: 'fa-star' },
  { id: 'news', label: '新闻', icon: 'fa-newspaper' },
  { id: 'map', label: '地图', icon: 'fa-map' },
];
DefaultTabId = 'status';
```

**Badge 系统**：任务 Tab 自动计算未完成任务数（`任务.状态 !== '已完成'`），超过 99 显示 `99+`。

---

## 三、6 个 Tab 页面详细架构

### 3.1 QuestsTab（任务页）

```
QuestsTab
├── Card (overviewCard) — 任务态势总览
│   ├── IconTitle "任务态势" + 任务状态统计行
│   ├── 焦点任务选择器 (<select>)
│   └── 焦点任务线（目标 + 进展）
├── 状态筛选栏 (statusFilterBar)
│   └── [全部] [进行中] [已完成] ... （动态选项）
└── 任务列表 (questList)
    └── QuestSummaryCard × N
        ├── 任务名 + 状态Badge + 关注度Badge
        ├── 进展预览
        ├── 详情预览
        └── Meta: 目标 / 奖励
            ↓ 点击
        ItemInspectModal (详情浮层)
            └── QuestDetailContent
                └── 6 字段: 状态/关注度/进展/详情/目标/奖励
                    (可编辑模式下显示 EditableField)
```

**交互逻辑**：

- 默认按优先级（高→中→低）+ 名称排序
- 焦点任务通过 `<select>` 下拉选择
- 任务卡片点击弹出 `ItemInspectModal` 查看完整信息
- 编辑模式下支持字段编辑 + 删除任务
- 会话级状态（activeStatus/focusQuestName）通过 `sessionStorage` 持久化

### 3.2 StatusTab（信息页 / 角色状态）

```
StatusTab
├── Card (overviewCard) — 角色概览
│   ├── AvatarPanel (可点击编辑头像)
│   ├── 角色名 + 层级 + 等级 + 称号
│   ├── ResourceBar (HP/MP/SP/EXP)
│   └── 属性摘要 (力量/敏捷/体质/智力/精神)
├── 基础信息网格 (basicInfoGrid)
│   └── 种族/职业/身份/生命层级/等级/冒险者等级
│       (value 还是 editableField，取决于编辑模式)
├── 次要信息堆 (secondaryStack)
│   ├── 装备详情 (DetailEntryCard × 5 — 武器/防具/饰品/道具/技能)
│   ├── 状态效果 (StatusEffectDisplay — buff/debuff/special)
│   └── 登神长阶 (Ascension — 要素/权能/法则/神位/神国)
└── 点击 DetailEntryCard 展开
    └── DetailSheet (底部滑出面板)
        └── 装备/技能详细信息
```

**交互逻辑**：

- 头像编辑：点击 AvatarPanel → AvatarActionModal（上传/URL/删除三个操作）
- 属性编辑：编辑模式下的 `NumberEditor` 组件（+/- 按钮 + 直接输入）
- 装备槽点击：展开 `DetailSheet`（底部抽屉面板）
- 状态效果：`StatusEffectDisplay` 分 buff/debuff/special 三类展示药丸

### 3.3 ItemsTab（持有物页 / 背包系统）

```
ItemsTab
├── itemsTabHeader
│   ├── 类别切换: [背包] [装备] [技能] (每个显示数量 Badge)
│   └── 货币显示: 💰 xxxx G (可编辑)
├── itemsWorkspace
│   ├── 子分类筛选栏 (filterBar)
│   │   └── [全部] [武器] [防具] [饰品] [道具] ... （动态选项）
│   └── itemsTabContent (左右分栏)
│       ├── 左侧：物品索引列表 (itemsIndex)
│       │   └── itemRow × N
│       │       ├── 品质色标 + 物品名(品质色) + 类型标签
│       │       ├── 标签行 (Tags)
│       │       └── 后缀: 数量/位置/消耗
│       └── 右侧：物品详情面板 (itemsDetailPanel)
│           └── ItemDetail (名称/品质/类型/标签/效果/描述)
│               编辑模式下可编辑
├── ItemInspectModal (移动端替代右侧面板)
└── DeleteConfirmModal (删除确认)
```

**交互逻辑**：

- 物品按品质排序（高→低），品质相同按名称
- 品质决定文字颜色（7 级品质色映射）
- 三个类别（背包/装备/技能）独立维护筛选状态
- 编辑模式下可修改物品属性、删除物品
- 响应式：窄屏(<720px) → 点击物品弹出 Modal 替代右侧面板

### 3.4 DestinyTab（命定页 / 伙伴系统）

```
DestinyTab
├── 命运点数 (destinyPoints) — [点数图标] 可花费: XXX
├── 伙伴列表 (partnerList)
│   └── PartnerSummaryCard × N (Master-Detail 模式)
│       ├── 伙伴 Avatar + 名字 + 标签(在场/契约)
│       ├── 好感度条 (affectionBar)
│       ├── 简要属性
│       └── 状态摘要 (StatusToggles)
│           ↓ 点击
├── 伙伴详情面板 (partnerDetailPanel)
│   ├── PartnerDetailHeader (名称/外观/登神长阶/属性/背景/特征/思想)
│   ├── 装备槽 (partnerEquipment)
│   ├── 技能列表 (partnerSkills)
│   ├── 资产筛选 + 列表
│   └── 好感度编辑 (affectionBar → numberEditor)
└── FP Shop 按钮 (fpShopBtn)
```

**交互逻辑**：

- Master-Detail 双面板：左侧伙伴列表 → 点击展开右侧详情
- 8 个详情 Tab：外观/登神/属性/背景/特征/思想/装备/技能
- 伙伴资产（装备/技能/物品）有独立的分类 + 筛选系统
- 头像管理：通过 AvatarActionModal（上传/URL）
- 可编辑模式下支持修改伙伴属性 + 删除伙伴
- 好感度 `[-100, +100]` 范围，11 级标签
- 命运点数显示（FP 系统）

### 3.5 NewsTab（新闻页）

```
NewsTab
├── 新闻分类 Tab: [阿斯塔利亚快讯] [酒馆留言板] [午后茶会]
└── NewsFeed (新闻列表)
    └── newsFeedCard × N
        ├── 标题
        ├── 分类 Badge
        ├── 正文 (可编辑模式 → EditableField)
        └── Meta: 日期/来源
```

**交互逻辑**：

- 三分类新闻（Tea/Board/News），各有独立样式强调色
- 编辑模式下可直接双击编辑新闻内容
- 新闻内容通过 `stat_data.新闻` 字段加载

### 3.6 MapTab（地图页 / 最复杂的 Tab）

```
MapTab
├── MapToolbar (地图工具栏)
│   ├── 地图源切换: [小地图] [大地图]
│   ├── 绘图模式开关 (drawToggle)
│   │   └── 调色板: 8 色选择
│   └── 标记工作台开关 (markerWorkbench)
├── MapViewerStage (地图查看器)
│   ├── OpenSeadragon Viewer (深度缩放)
│   ├── DrawCanvas (自由绘制 Canvas 叠加层)
│   └── MarkerOverlay (标记叠加层)
├── MarkerWorkbench (标记工作台)
│   ├── 搜索输入框
│   ├── 标记列表 (markerList)
│   │   └── markerItem × N (名称/分组/颜色点)
│   │       选中 → 编辑面板
│   └── MarkerEditor (选中标记的编辑面板)
│       ├── 名称/分组/描述 (可编辑)
│       ├── 图片管理 (上传/删除)
│       ├── 图标选择 (10 种图标)
│       └── 颜色选择 + 删除按钮
├── MapMarkerCard (地图上的标记卡片弹窗)
│   ├── 图片轮播 (Carousel + 前翻/后翻按钮)
│   ├── 名称 + 分组
│   └── 描述
└── MarkerPanel (全屏标记编辑面板)
    └── 同 MarkerWorkbench 完整编辑器
```

**交互逻辑**：

- **地图源**：小地图 (Maplite-1.webp) 和大地图 (Map.webp)，通过 Service Worker 缓存
- **标记系统**（核心功能）：
  - `map_markers` 数组，每 marker 有 id/name/group/description/imageUrls/icon/color/position
  - 标记叠加在 OSD Viewer 上，可点击选中
  - 标记添加模式：点击地图空白处放置新标记
  - 标记支持 10 种图标、8 种颜色
  - 持久化到 SillyTavern 的 `map_markers` 变量（debounce 1s 保存）
- **绘图系统**：
  - HTML Canvas 叠加层，支持自由手绘
  - 8 色调色板
  - 绘图数据持久化到 `map_drawings` 变量
- **状态保持**：sessionStorage 记录选中的标记/工作台状态
- **图片轮播**：标记的 ImageUrls 支持多图轮播，Dots 导航

---

## 四、状态管理架构

### 4.1 三个全局 Store（Zustand + immer）

```
┌──────────────────────────────────────────────────┐
│                  SillyTavern 变量系统               │
│                                                    │
│  Character Variables:                              │
│    status_theme_id          → Theme Store          │
│    status_edit_enabled      → Editor Store         │
│    map_markers               → MapTab (local)      │
│    map_drawings              → MapTab (local)      │
│                                                    │
│  Message Variables (MVU):                         │
│    stat_data                → MVU Data Store       │
│      ├── 世界 (time/location)                     │
│      ├── 主角 (attributes/equipment/skills/...)   │
│      ├── 任务列表 (quests)                        │
│      ├── 关系列表 (partners)                      │
│      ├── 新闻 (news)                               │
│      └── 命运点数 (fp)                             │
└──────────────────────────────────────────────────┘
         │                  │                  │
         ▼                  ▼                  ▼
┌─────────────┐  ┌──────────────┐  ┌──────────────────┐
│ MVU Data    │  │ Theme Store  │  │ Editor Setting   │
│ Store       │  │              │  │ Store            │
│             │  │              │  │                  │
│ data:       │  │ currentTheme │  │ editEnabled:     │
│  StatData   │  │ Id: string   │  │  boolean         │
│ loading:    │  │ loaded: bool │  │                  │
│  boolean    │  │              │  │ loadSettings()    │
│ error:      │  │ loadTheme()  │  │ saveSettings()   │
│  string|null│  │ saveTheme()  │  │ setEditEnabled() │
│             │  │ setTheme()   │  │                  │
│ refresh()   │  │ reset()      │  │                  │
│ updateField │  │ applyCssVars │  │                  │
│ ()          │  │ ()           │  │                  │
│ deleteField │  │ getColors()  │  │                  │
│ ()          │  │              │  │                  │
└─────────────┘  └──────────────┘  └──────────────────┘
```

### 4.2 MVU Data Store（核心数据层）

```typescript
// 数据流向
refresh()
  → getVariables({ type: 'message', message_id })    // 从 ST 读取
  → Schema.safeParse(rawData.stat_data)                // Zod 校验
  → set({ data: result.data })                        // 更新 store
  → 所有组件通过 useMvuDataStore(state => state.data) 获取

updateField(path, value)
  → Mvu.getMvuData()                                   // 获取完整 MVU 对象
  → _.set(mvuData, `stat_data.${path}`, value)        // Lodash 路径写入
  → Mvu.replaceMvuData(mvuData)                        // 写回 ST
  → get().refresh()                                    // 重新加载本地状态

deleteField(path)
  → 同上逻辑，_.unset 替代 _.set
```

**关键设计**：

- 数据流是**单向的**：ST 变量 → Zod 校验 → Store → 组件
- 写入走 `Mvu.replaceMvuData` → `refresh()` 回环
- 所有路径操作使用 Lodash 的 `.get/.set/.unset` + 点分隔路径（如 `主角.装备.长剑.品质`）

### 4.3 Theme Store（主题系统）

```typescript
// 主题切换流程
setTheme(themeId)
  → set({ currentThemeId: themeId })
  → applyCssVariables()
      → root.style.setProperty(`--theme-${kebabKey}`, value)
      → 应用到 document.documentElement

// CSS 变量命名规则
ThemeColors.windowBg  →  --theme-window-bg
ThemeColors.tabActiveText → --theme-tab-active-text
ThemeColors.qualityMythic → --theme-quality-mythic
```

**8 个预设主题**：羊皮纸(parchment) / 暗酒红(crimson) / 深靛蓝(indigo) / 古铜金(bronze) / 樱花粉紫(sakura) / 墨黑(obsidian) / 米黄羊皮纸(ivory,默认) / 雾紫(misty-lilac)

每个主题定义 **~50 个颜色 Token**（窗口/标题栏/Tab栏/内容区/文本/资源条/品质/交互/命定/登神/货币等）

### 4.4 Editor Setting Store（编辑模式）

```typescript
// 编辑模式开关
editEnabled: boolean
  → 影响所有组件的渲染模式
  → true: 显示 EditableField/NumberEditor/TagEditor 等编辑器
  → false: 纯文本只读展示

// 持久化到 Character 变量
status_edit_enabled → getVariables({ type: 'character' })
```

---

## 五、共享组件体系

### 5.1 展示组件（15 个）

| 组件                  | 路径                                     | 用途                                       |
| --------------------- | ---------------------------------------- | ------------------------------------------ |
| `Ascension`           | `shared/components/Ascension/`           | 登神长阶面板（要素/权能/法则/神位/神国）   |
| `AvatarActionModal`   | `shared/components/AvatarActionModal/`   | 头像编辑弹窗（上传/URL/删除 3 操作）       |
| `AvatarPanel`         | `shared/components/AvatarPanel/`         | 圆形头像展示（3 尺寸：sm/md/lg）           |
| `Card`                | `shared/components/Card/`                | 通用卡片容器（品质色边框 + 标题 + body）   |
| `Collapse`            | `shared/components/Collapse/`            | 折叠面板（支持品质色标题条）               |
| `ConfirmModal`        | `shared/components/ConfirmModal/`        | 通用确认弹窗                               |
| `DeleteConfirmModal`  | `shared/components/DeleteConfirmModal/`  | 删除确认弹窗（含类型/名称/路径信息）       |
| `DetailSheet`         | `shared/components/DetailSheet/`         | 底部滑出详情面板（Handle + Header + Body） |
| `EditableField`       | `shared/components/EditableField/`       | 智能字段容器（根据类型渲染不同编辑器）     |
| `EmptyHint`           | `shared/components/EmptyHint/`           | 空状态提示（图标 + 文字）                  |
| `IconTitle`           | `shared/components/IconTitle/`           | 图标标题组合                               |
| `ItemDetail`          | `shared/components/ItemDetail/`          | 物品详情卡片（品质/类型/标签/效果/描述）   |
| `ItemInspectModal`    | `shared/components/ItemInspectModal/`    | 物品查看浮层（标题/副标题/内容 + 关闭）    |
| `ResourceBar`         | `shared/components/ResourceBar/`         | 资源条（HP红/MP蓝/SP绿/EXP金）             |
| `StatusEffectDisplay` | `shared/components/StatusEffectDisplay/` | 状态效果展示（Buff/Debuff/Special 药丸）   |

### 5.2 编辑器组件（7 个，`shared/components/editors/`）

| 组件             | 用途                                   |
| ---------------- | -------------------------------------- |
| `KeyValueEditor` | 键值对编辑（增/删/改 entries）         |
| `NumberEditor`   | 数字编辑器（+/- 步进按钮 + 直接输入）  |
| `SelectEditor`   | 下拉选择器（options 配置）             |
| `TagEditor`      | 标签编辑器（增/删 tags + 输入）        |
| `TextEditor`     | 文本编辑器（单击切换编辑/展示模式）    |
| `TextareaEditor` | 多行文本编辑器                         |
| `ToggleEditor`   | 开关编辑器（thumb 滑动 + ON/OFF 标签） |

### 5.3 HOC（高阶组件）

```typescript
// withMvuData — 为页面组件注入 { data, loading, error } 三态
// 处理加载中/错误/空数据三种状态
const QuestsTab = withMvuData({ baseClassName: styles.questsTab })(QuestsTabContent);
```

---

## 六、自定义 Hooks

| Hook               | 文件                               | 用途                                                          |
| ------------------ | ---------------------------------- | ------------------------------------------------------------- |
| `useTheme`         | `core/hooks/use-theme.ts`          | 主题相关，重导出 ThemePresets/ThemeList/DefaultTheme          |
| `useMapViewer`     | `core/hooks/use-map-viewer.ts`     | OpenSeadragon 生命周期管理（初始化/加载/错误/清理）           |
| `useMapMarkers`    | `core/hooks/use-map-markers.ts`    | 地图标记增删改查 + 坐标转换                                   |
| `useCanvasDraw`    | `core/hooks/use-canvas-draw.ts`    | HTML Canvas 自由绘制（pointer 事件 + 笔画管理）               |
| `useDeleteConfirm` | `core/hooks/use-delete-confirm.ts` | 删除确认逻辑（setDeleteTarget / handleDelete / cancelDelete） |

### useMapViewer 详细流程

```
1. 初始化 OpenSeadragon Viewer
   ├── 配置参数（navigator/gesture/crossOrigin 等）
   ├── 注册事件：animation/resize/open-failed
   ├── ResizeObserver 监听容器尺寸变化
   └── 返回 cleanup: destroy + revoke objectURLs

2. 加载地图源
   ├── 先查 Service Worker Cache (destined-journey-cache-v1)
   ├── Cache Miss → fetch(url, cors) → 放入 Cache
   ├── Blob → createObjectURL → viewer.open(tileSource)
   └── 30 秒超时 + AbortController 取消

3. 就绪检测
   ├── 'open' 事件 → tiledImage.whenFullyLoaded() 或 tile-drawn fallback
   ├── forceResize → applyConstraints
   └── onReady 回调
```

---

## 七、数据持久化策略

### 7.1 存储层级

| 层级                  | 存储                                   | 数据                                                  | 生命周期     |
| --------------------- | -------------------------------------- | ----------------------------------------------------- | ------------ |
| SillyTavern Character | `getVariables({type:'character'})`     | theme_id, edit_enabled, map_markers, map_drawings     | 角色级持久化 |
| SillyTavern Message   | `Mvu.getMvuData({type:'message'})`     | stat_data (所有角色/任务/物品/伙伴数据)               | 消息级持久化 |
| sessionStorage        | `status-sub-tab:{msgId}:{scope}:{key}` | Tab 子状态 (activeCategory/activeFilter/focusQuest等) | 浏览器会话   |
| IndexedDB             | `status-avatar-db`                     | 上传的头像图片缓存                                    | 本地持久化   |
| Service Worker        | `destined-journey-cache-v1`            | 地图瓦片图片 (Maplite/Map webp)                       | 持久化缓存   |

### 7.2 sessionStorage 使用模式

```typescript
// 每个 Tab 的"记住上次选择"模式
const key = buildSessionKey('items', 'active-category');
// → "status-sub-tab:{messageId}:items:active-category"
writeSessionState(key, activeCategory); // 写
readSessionState<CategoryId>(key, 'inventory'); // 读（带默认值）
```

---

## 八、交互模式总结

### 8.1 编辑/只读双模式

整个应用的核心交互模式是**编辑模式切换**：

```
EditorSettingStore.editEnabled
    │
    ├── false (默认)  →  只读展示
    │   └── 所有数据以纯文本/色标/徽章形式展示
    │
    └── true  →  可编辑模式
        ├── Text → TextEditor (单击切换)
        ├── Number → NumberEditor (+/-步进)
        ├── Select → SelectEditor (下拉)
        ├── Tags → TagEditor (增删标签)
        ├── Textarea → TextareaEditor (多行)
        ├── Toggle → ToggleEditor (开关)
        ├── KeyValue → KeyValueEditor (键值对)
        └── 出现删除按钮 (带 DeleteConfirmModal)
```

### 8.2 Master-Detail 模式

- **ItemsTab**：左侧列表 + 右侧详情面板（桌面端）/ 点击弹出 Modal（移动端）
- **DestinyTab**：左侧伙伴列表 + 右侧伙伴详情（8 个子 Tab）
- **QuestsTab**：任务卡片列表 + 点击弹出 InspectModal

### 8.3 地图交互模式

- **标记系统**：查看模式 / 添加模式 / 编辑模式
- **绘图系统**：开关控制 Canvas 叠加层 + 调色板
- **地图源切换**：小地图(快速) ↔ 大地图(完整)

### 8.4 响应式设计

- 通过 `matchMedia('(max-width: 720px)')` 检测移动端
- 移动端：Master-Detail 平面的详情面板 → Modal 浮层
- OpenSeadragon 自动适配容器尺寸

---

## 九、架构要点（Phase 7e 实现参考）

### 9.1 需要保留的核心设计

1. **单 URL + 状态驱动路由**：与我们现有架构一致，直接用 `ui.currentView` 模拟 Tab 切换
2. **Zustand Store 模式**：可用 Pinia 替代，`data/loading/error` 三态处理
3. **编辑/只读双模式**：通过 `editEnabled` 布尔值全局切换组件渲染
4. **路径式数据操作**：Lodash `.get/.set/.unset` + 点分隔路径
5. **sessionStorage "记住选择"**：Tab 子状态随消息 ID 隔离，刷新不丢失
6. **CSS 变量主题系统**：50 个 Token 覆盖全部 UI 颜色

### 9.2 需要简化的部分

1. **React + immer → Vue 3 + Pinia**：Pinia 自带响应式，不需要 immer
2. **GSAP → CSS transition / `<Transition>`**：淡入动画可用 Vue 内置组件
3. **OpenSeadragon**：地图功能复杂度高，可考虑简化或暂用静态图片
4. **SillyTavern 变量 API**：`getVariables/Mvu.getMvuData/insertOrAssignVariables` → 我们的 `$var` API
5. **Zod Schema**：需要在 `data_schema/` 基础上重建 zod 校验

### 9.3 组件映射（React → Vue）

| React 组件     | Vue 实现方式                             |
| -------------- | ---------------------------------------- |
| `Window`       | 已有的 `GamePage.vue` 根组件             |
| `TitleBar`     | 已有 `AppCard` + 自定义                  |
| `TabBar`       | 已有 `AppTabs.vue`（需扩展 Badge）       |
| `ContentArea`  | `<Transition name="fade">`               |
| `ResourceBar`  | 已有 `ResourceBar.vue`                   |
| `AvatarPanel`  | 已有 `AvatarPanel.vue`                   |
| `Card`         | 已有 `AppCard.vue`                       |
| `ConfirmModal` | 已有 `AppModal.vue`                      |
| `ItemsTab`     | 需新建（三类别 + 筛选 + 品质色）         |
| `QuestsTab`    | 需新建（焦点任务 + 状态筛选）            |
| `StatusTab`    | 需新建（属性 + 装备槽 + 效果 + 登神）    |
| `DestinyTab`   | 需新建（伙伴 Master-Detail）             |
| `NewsTab`      | 需新建（三分类新闻流）                   |
| `MapTab`       | 需新建（地图 + 标记 + 绘制，复杂度最高） |

---

## 十、文件树全览

```
src/status/
├── App.tsx                          # 根组件（Tab 路由 + 设置覆盖）
├── index.tsx                        # 入口（createRoot → render <App/>）
├── index.html                       # HTML 模板（<div id="app">）
├── tsconfig.json
│
├── config/
│   ├── tabs.config.ts               # 6 Tab 配置 + 默认 Tab
│   └── theme-presets.ts             # 8 主题 × 50 颜色 Token
│
├── layout/                          # 4 布局组件
│   ├── index.ts
│   ├── Window/Window.tsx + .module.scss
│   ├── TitleBar/TitleBar.tsx + .module.scss
│   ├── TabBar/TabBar.tsx + .module.scss
│   └── ContentArea/ContentArea.tsx + .module.scss
│
├── pages/                           # 6 Tab 页面 + 设置页
│   ├── index.ts
│   ├── quests/QuestsTab.tsx + .module.scss     # 任务页
│   ├── status/StatusTab.tsx + .module.scss     # 角色信息页
│   ├── items/ItemsTab.tsx + .module.scss       # 持有物/背包页
│   ├── destiny/DestinyTab.tsx + .module.scss   # 命定/伙伴页
│   ├── news/NewsTab.tsx + .module.scss         # 新闻页
│   ├── map/MapTab.tsx + .module.scss           # 地图页
│   │   └── components/map-tab-sections.tsx     # 地图子组件
│   └── settings/SettingsTab.tsx + .module.scss # 设置页
│
├── shared/
│   ├── components/                  # 15 展示组件 + 7 编辑器
│   │   ├── index.ts
│   │   ├── Ascension/              # 登神长阶
│   │   ├── AvatarActionModal/      # 头像编辑弹窗
│   │   ├── AvatarPanel/            # 圆形头像
│   │   ├── Card/                   # 卡片容器
│   │   ├── Collapse/               # 折叠面板
│   │   ├── ConfirmModal/           # 通用确认
│   │   ├── DeleteConfirmModal/     # 删除确认
│   │   ├── DetailSheet/            # 底部抽屉
│   │   ├── EditableField/          # 智能字段容器
│   │   ├── EmptyHint/              # 空状态
│   │   ├── IconTitle/              # 图标标题
│   │   ├── ItemDetail/             # 物品详情
│   │   ├── ItemInspectModal/       # 物品查看浮层
│   │   ├── ResourceBar/            # 资源条
│   │   ├── StatusEffectDisplay/    # Buff 展示
│   │   └── editors/
│   │       ├── KeyValueEditor/
│   │       ├── NumberEditor/
│   │       ├── SelectEditor/
│   │       ├── TagEditor/
│   │       ├── TextEditor/
│   │       ├── TextareaEditor/
│   │       └── ToggleEditor/
│   ├── hoc/
│   │   └── withMvuData.tsx         # 数据注入 HOC
│   └── styles/
│       ├── _variables.scss         # SCSS 变量
│       ├── _mixins.scss            # SCSS Mixin
│       └── index.scss              # 全局样式入口
│
└── core/
    ├── hooks/
    │   ├── index.ts
    │   ├── use-canvas-draw.ts      # Canvas 自由绘制
    │   ├── use-delete-confirm.ts   # 删除确认逻辑
    │   ├── use-map-markers.ts      # 地图标记管理
    │   ├── use-map-viewer.ts       # OpenSeadragon 管理
    │   └── use-theme.ts            # 主题 hooks
    ├── stores/
    │   ├── index.ts
    │   ├── mvu-data.store.ts       # 核心数据 Store (Zustand+immer)
    │   ├── theme.store.ts           # 主题 Store (Zustand+immer)
    │   └── editor-setting.store.ts  # 编辑设置 Store (Zustand+immer)
    ├── types/
    │   ├── index.ts
    │   ├── mvu-data.d.ts           # stat_data 类型（从 Zod Schema 推导）
    │   ├── theme.d.ts              # Theme/ThemeColors/ThemePresetId
    │   ├── map-markers.d.ts        # MapMarker/MapMarkerIcon
    │   ├── map-sources.ts          # 地图源 URL 配置
    │   └── map-source-list.ts      # 地图源列表
    └── utils/
        ├── index.ts
        ├── assets.ts               # 资产工具函数
        ├── avatar-storage.ts       # 头像 IndexedDB 缓存
        ├── format.ts               # 格式化工具
        ├── iconify.ts              # 图标处理
        ├── map-constants.ts        # 地图常量
        ├── quality.ts              # 品质颜色映射
        └── session-storage.ts      # sessionStorage 封装
```

---

## 附录：type vs reference 对比

| 项目   | status_index.html (原版 React) | Phase 7 (我们的 Vue)                 |
| ------ | ------------------------------ | ------------------------------------ |
| 框架   | React 18 + TypeScript          | Vue 3 + TypeScript                   |
| 状态   | Zustand + immer                | Pinia                                |
| 样式   | SCSS Modules                   | CSS Custom Properties + Scoped Style |
| 路由   | 无 URL（useState 切换）        | 单 URL（currentView store）          |
| 动画   | GSAP                           | CSS transition / `<Transition>`      |
| 组件数 | ~30 组件                       | ~15 已实现 + 待建                    |
| 主题   | 8 主题 × 50 Token              | 10 主题 × CSS Variables              |
| 测试   | 无测试代码                     | 已有 2092 tests                      |
| 构建   | Webpack                        | Vite                                 |
