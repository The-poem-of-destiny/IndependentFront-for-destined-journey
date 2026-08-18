# ChatFlow 三源消息系统 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ChatFlow 重构为三源消息系统（AI/用户/系统），前端渲染系统卡片，AI 看到纯文本摘要

**Architecture:** 类型层新增 `SystemEvent` 联合类型 + `ChatMessage.systemEvent` 字段 → 新模块 `src/ui/lib/toSystemEvent.ts` 提供工厂函数 → `ChatFlow.vue` 集成折叠/展开卡片组件 → `game-store.ts` 加可见性控制 → `GamePage.vue` 从 mock 切换为 store 驱动

**Tech Stack:** Vue 3 + Pinia + TypeScript，无新依赖

**Spec:** `docs/archive/superpowers/specs/2026-07-09-chat-flow-design.md`

## Global Constraints

- TypeScript 严格模式，类型定义仅能放在 `src/sillytavern/types.ts`
- 框架：Vue 3.5 + Pinia 2 + Vite 6
- 数据库：Dexie.js (IndexedDB)
- 测试框架：Vitest，每个新模块必须配 `*.test.ts`
- `ChatMessage` role 用 `'system' | 'user' | 'assistant'`（三值联合）
- 品质色（参考原版 v4.2.1 角色卡）：普通=#c4cad3 优良=#7be495 稀有=#62bbff 史诗=#cf95ff 传说=#ffc46b 神话=#ff78c5 唯一=#00ffff
- 系统事件分三类渲染层级：完整卡片（craft/char_gen/combat）、中等卡片（item_gen）、轻量通知条（character_update/item_update/quest_update）

---

## File Map

| File                                                 | Action | Responsibility                                                               |
| ---------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `src/sillytavern/types.ts`                           | Modify | 新增 `SystemEvent` type + 7 subtypes，扩展 `ChatMessage`                     |
| `src/ui/lib/toSystemEvent.ts`                        | Create | `toSystemMessage()` 工厂函数：CraftGenOutput/CharGenOutput/... → ChatMessage |
| `src/ui/components/game/ChatFlow.vue`                | Modify | 删 `FlowMessage`，切到 `ChatMessage`，三源渲染 + 折叠卡片                    |
| `src/ui/components/game/GamePage.vue`                | Modify | 删 mock `FlowMessage[]`，切到 `game.messages`                                |
| `src/ui/stores/game-store.ts`                        | Modify | 加 `addMessage()`、`systemEventFilters`、`systemEventsVisible`               |
| `src/ui/components/game/cards/CraftSystemCard.vue`   | Create | 制作结果卡                                                                   |
| `src/ui/components/game/cards/CharGenSystemCard.vue` | Create | 新角色卡                                                                     |
| `src/ui/components/game/cards/CombatSystemCard.vue`  | Create | 战斗结果卡                                                                   |
| `src/ui/components/game/cards/ItemSystemCard.vue`    | Create | 新物品卡                                                                     |
| `src/ui/components/game/cards/SystemNotifBar.vue`    | Create | 轻量通知条（character_update/item_update/quest_update 共用）                 |
| `src/sillytavern/agent-templates.ts`                 | Modify | `buildAgentMessages` → history 中 system→assistant 转换                      |
| `src/ui/stores/settings-store.ts`                    | Modify | 加 `systemEventFilters` 持久化字段                                           |
| `src/ui/components/settings/SettingsPage.vue`        | Modify | 加系统事件可见性开关 UI                                                      |

---

### Task 1: types.ts — 新增 SystemEvent 类型 + 扩展 ChatMessage

**Files:**

- Modify: `src/sillytavern/types.ts`

**Produces:**

- `SystemEvent` type（7 成员联合）
- `CraftSystemEvent`, `CharGenSystemEvent`, `ItemGenSystemEvent`, `CombatSystemEvent`, `CharacterUpdateEvent`, `ItemUpdateEvent`, `QuestUpdateEvent`
- `ChatMessage.systemEvent?: SystemEvent`

- [ ] **Step 1: 定位插入位置**

文件当前在 `types.ts:465-479` 定义 `ChatMessage`，在 `types.ts:2441+` 区域有 `CraftAgentOutput`、`CharGenOutput`、`ItemGenOutput`、`CombatSummaryResult`。新增类型插在 `CombatSummaryResult` 之后（约 line 2647）。

- [ ] **Step 2: 写入 SystemEvent 联合类型（插在 CombatSummaryResult 之后、Geography Types 之前）**

在 `export interface CombatSummaryResult { ... }` 之后、`// ========== Geography Types` 之前插入：

```typescript
// ========== ChatFlow 系统事件类型 (Phase 7e) ==========

/** 系统事件联合类型 — 前端根据 type 渲染不同卡片 */
export type SystemEvent =
  | CraftSystemEvent
  | CharGenSystemEvent
  | ItemGenSystemEvent
  | CombatSystemEvent
  | CharacterUpdateEvent
  | ItemUpdateEvent
  | QuestUpdateEvent;

export interface CraftSystemEvent {
  type: 'craft';
  productName: string;
  quality: QualityLevel;
  rating: CraftRating;
  narrative: string;
  details: CraftGenOutput;
}

export interface CharGenSystemEvent {
  type: 'char_gen';
  characterName: string;
  race: string;
  tier: number;
  narrative: string;
  details: CharGenOutput;
}

export interface ItemGenSystemEvent {
  type: 'item_gen';
  itemName: string;
  quality: QualityLevel;
  itemType: string;
  narrative: string;
  details: ItemGenOutput;
}

export interface CombatSystemEvent {
  type: 'combat';
  outcome: 'ally_win' | 'enemy_win' | 'draw' | 'fled';
  narrative: string;
  details: CombatSummaryResult;
}

export interface CharacterUpdateEvent {
  type: 'character_update';
  characterName: string;
  narrative: string;
}

export interface ItemUpdateEvent {
  type: 'item_update';
  itemName: string;
  operation: string;
  narrative: string;
}

export interface QuestUpdateEvent {
  type: 'quest_update';
  questName: string;
  status: string;
  narrative: string;
}
```

- [ ] **Step 3: 扩展 ChatMessage**

在 `ChatMessage` 接口中（约 line 465-479），`timestamp` 后、`parsed` 前插入：

```typescript
  /** 🆕 系统事件数据 — 仅 role='system' 时有值，供前端渲染卡片 */
  systemEvent?: SystemEvent;
```

完整修改后：

```typescript
export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** 🆕 系统事件数据 — 仅 role='system' 时有值，供前端渲染卡片 */
  systemEvent?: SystemEvent;
  variables?: Record<string, string | number>;
  metadata?: {
    tokenCount?: number;
    lorebookEntries?: string[];
    processingTime?: number;
  };
  parsed?: ParsedTags;
  variablesAfter?: Record<string, any>;
  apiUsed?: ApiTarget;
}
```

- [ ] **Step 4: 编译验证**

```bash
npm run typecheck
```

Expected: 0 errors（新增类型无消费者，不会引入编译错误）

- [ ] **Step 5: Commit**

```bash
git add src/sillytavern/types.ts
git commit -m "feat(types): add SystemEvent union type + extend ChatMessage.systemEvent"
```

---

### Task 2: toSystemEvent.ts — 工厂函数模块

**Files:**

- Create: `src/ui/lib/toSystemEvent.ts`

**Consumes:**

- `SystemEvent`, `CraftSystemEvent`, `CharGenSystemEvent`, `ItemGenSystemEvent`, `CombatSystemEvent`, `CharacterUpdateEvent`, `ItemUpdateEvent`, `QuestUpdateEvent`（from `@engine/types`）
- `ChatMessage`（from `@engine/types`）
- `CraftGenOutput`, `CharGenOutput`, `ItemGenOutput`, `CombatSummaryResult`（from `@engine/types`）

**Produces:**

- `toSystemMessage(event: SystemEvent): ChatMessage`

- [ ] **Step 1: 创建文件**

创建 `src/ui/lib/toSystemEvent.ts`：

```typescript
/**
 * 系统事件 → ChatMessage 工厂函数
 *
 * 产出 ChatMessage 的 role 为 'system'，前端根据此区分三种消息来源。
 * content 字段存纯文本摘要（给 AI 看），systemEvent 字段存结构化数据（给前端渲染卡片）。
 */

import type { ChatMessage, SystemEvent } from '@engine/types';

export function toSystemMessage(event: SystemEvent): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'system',
    content: event.narrative,
    timestamp: Date.now(),
    systemEvent: event,
  };
}

// ========== Convenience helpers — 各类型 event 构造 + 自动生成 narrative ==========

import type {
  CraftGenOutput,
  CharGenOutput,
  ItemGenOutput,
  CombatSummaryResult,
  QualityLevel,
  CraftRating,
} from '@engine/types';

export function craftToEvent(output: CraftGenOutput): SystemEvent {
  return {
    type: 'craft',
    productName: output.productName,
    quality: output.quality,
    rating: output.rating,
    narrative: `[制作] ${output.rating} — ${output.quality}级 ${output.productName}`,
    details: output,
  };
}

export function charGenToEvent(output: CharGenOutput): SystemEvent {
  return {
    type: 'char_gen',
    characterName: output.name,
    race: output.race,
    tier: output.tier,
    narrative: `[新角色] ${output.name} (${output.race}, T${output.tier})`,
    details: output,
  };
}

export function itemGenToEvent(output: ItemGenOutput): SystemEvent {
  // 提取第一个物品/技能/装备名作为摘要
  const firstName =
    output.equipment?.[0]?.name ??
    output.skills?.[0]?.name ??
    output.inventory?.[0]?.name ??
    '未知物品';
  let quality: QualityLevel = '普通';
  if (output.equipment?.[0]?.quality) quality = output.equipment[0].quality as QualityLevel;
  else if (output.inventory?.[0]?.rarity) quality = output.inventory[0].rarity as QualityLevel;
  return {
    type: 'item_gen',
    itemName: firstName,
    quality,
    itemType: output.equipment?.[0] ? '装备' : output.skills?.[0] ? '技能' : '物品',
    narrative: `[获得] ${firstName}`,
    details: output,
  };
}

export function combatToEvent(result: CombatSummaryResult): SystemEvent {
  const outcomeLabel: Record<string, string> = {
    ally_win: '胜利',
    enemy_win: '败北',
    draw: '平局',
    fled: '逃跑',
  };
  return {
    type: 'combat',
    outcome: result.outcome,
    narrative: `[战斗] ${outcomeLabel[result.outcome] ?? result.outcome} · ${result.rounds}回合 · EXP +${result.totalExp}`,
    details: result,
  };
}

export function charUpdateToEvent(characterName: string, summary: string): SystemEvent {
  return {
    type: 'character_update',
    characterName,
    narrative: `[角色变动] ${characterName}: ${summary}`,
  };
}

export function itemUpdateToEvent(
  itemName: string,
  operation: string,
  summary: string,
): SystemEvent {
  const opLabel: Record<string, string> = {
    consume: '消耗',
    transfer: '转移',
    modify: '变更',
    equip: '装备',
    unequip: '卸下',
  };
  return {
    type: 'item_update',
    itemName,
    operation,
    narrative: `[${opLabel[operation] ?? operation}] ${itemName}: ${summary}`,
  };
}

export function questUpdateToEvent(
  questName: string,
  status: string,
  summary: string,
): SystemEvent {
  return {
    type: 'quest_update',
    questName,
    status,
    narrative: `[任务] ${questName}: ${summary}`,
  };
}
```

- [ ] **Step 2: 编译验证**

```bash
npm run typecheck
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/ui/lib/toSystemEvent.ts
git commit -m "feat(ui): add toSystemMessage factory + per-type event constructors"
```

---

### Task 3: game-store.ts — 消息管理 + 可见性控制

**Files:**

- Modify: `src/ui/stores/game-store.ts`

**Consumes:**

- `ChatMessage`, `SystemEvent`（from `@engine/types`）

**Produces:**

- `game.messages` — store 驱动而非 local array
- `game.addMessage(content: string, role: 'user' | 'assistant'): void`
- `game.addSystemMessage(event: SystemEvent): void`
- `game.systemEventFilters: Record<string, boolean>`
- `game.systemEventsVisible: boolean`

- [ ] **Step 1: 写入新状态和方法**

在 `src/ui/stores/game-store.ts` 的 `isGenerating` 下方（约 line 19）插入对应 ref，在 store 末尾 return 前插入新方法。

```typescript
// === 系统事件可见性 === (加在 isGenerating ref 后)
const systemEventsVisible = ref(true);
const systemEventFilters = ref<Record<string, boolean>>({
  craft: true,
  char_gen: true,
  item_gen: true,
  combat: true,
  character_update: false,
  item_update: false,
  quest_update: false,
});
```

新方法（加在 `closeModal` 之后）：

```typescript
function addMessage(content: string, role: 'user' | 'assistant'): void {
  messages.value.push({
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
  });
}

function addSystemMessage(systemEvent: import('@engine/types').SystemEvent): void {
  messages.value.push({
    id: crypto.randomUUID(),
    role: 'system',
    content: systemEvent.narrative,
    timestamp: Date.now(),
    systemEvent,
  });
}
```

Return 要导出新增的：

```typescript
return {
  saves,
  activeSaveId,
  activeSave,
  characters,
  player,
  npcs,
  messages,
  isGenerating,
  recentMemories,
  activePlotEvents,
  plotOutline,
  activeCombat,
  isInCombat,
  saveProfile,
  fp,
  gameTime,
  sidebarCollapsed,
  activeModal,
  fullscreenStatus,
  toggleSidebar,
  showModal,
  closeModal,
  toggleFullscreen,
  loadSaves,
  loadSave,
  clearActive,
  // 🆕 系统事件
  systemEventsVisible,
  systemEventFilters,
  addMessage,
  addSystemMessage,
};
```

还需在顶部 import 加 `import type { ChatMessage } from '@engine/types'`（已存在，无需改动）。

- [ ] **Step 2: 编译验证**

```bash
npm run typecheck
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/ui/stores/game-store.ts
git commit -m "feat(store): add message management + system event visibility filters"
```

---

### Task 4: ChatFlow.vue — 重构为三源消息流

**Files:**

- Modify: `src/ui/components/game/ChatFlow.vue`

**Consumes:**

- `ChatMessage` from `@engine/types`（替换本地 `FlowMessage`）
- `systemEventFilters: Record<string, boolean>`（from game store）
- 5 个系统卡片组件（Task 5-6 创建）

**Produces:**

- 删 `FlowMessage` 接口
- Props 改为 `messages: ChatMessage[]`（from store）
- `role === 'system'` 分支：折叠通知条 → 点击展开卡片

> **注意：** 系统卡片组件在 Task 5 才创建，此 Task 先用占位 `<div>` 做类型检查，Task 5 完成后回来替换。

- [ ] **Step 1: 重写 script 部分**

替换 `src/ui/components/game/ChatFlow.vue` 的 `<script setup>` 块：

```vue
<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import InputBar from './InputBar.vue';
import type { ChatMessage, SystemEvent } from '@engine/types';

const props = defineProps<{
  messages?: ChatMessage[];
  isGenerating?: boolean;
  systemEventsVisible?: boolean;
  systemEventFilters?: Record<string, boolean>;
}>();

const emit = defineEmits<{
  send: [content: string];
}>();

const container = ref<HTMLDivElement>();
const expandedIds = ref<Set<string>>(new Set());

watch(
  () => props.messages?.length,
  () => {
    nextTick(() => {
      if (container.value) {
        container.value.scrollTop = container.value.scrollHeight;
      }
    });
  },
);

function formatTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function toggleExpand(id: string) {
  if (expandedIds.value.has(id)) {
    expandedIds.value.delete(id);
  } else {
    expandedIds.value.add(id);
  }
}

/** 该系统事件是否应该显示 */
function isEventVisible(ev: SystemEvent): boolean {
  if (!props.systemEventsVisible) return false;
  if (props.systemEventFilters && ev.type in props.systemEventFilters) {
    return props.systemEventFilters[ev.type];
  }
  return true; // 未知类型默认显示
}
</script>
```

- [ ] **Step 2: 重写 template**

替换整个 `<template>` 块：

```vue
<template>
  <div class="chat-flow">
    <div ref="container" class="chat-messages">
      <div v-if="!messages || messages.length === 0" class="chat-empty">
        <p>等待冒险开始...</p>
        <p class="chat-empty-hint">在下方输入你的行动来推进故事</p>
      </div>

      <template v-for="msg in messages" :key="msg.id">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" class="bubble-row bubble-row-player">
          <div class="bubble bubble-player">
            <span class="bubble-prefix">你:</span>
            <span class="bubble-text">{{ msg.content }}</span>
            <span class="bubble-time" v-if="msg.timestamp">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <!-- AI 叙事消息 -->
        <div v-else-if="msg.role === 'assistant'" class="bubble-row bubble-row-narrative">
          <div class="bubble bubble-narrative">
            <span class="bubble-text">{{ msg.content }}</span>
            <span class="bubble-time" v-if="msg.timestamp">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>

        <!-- 系统事件消息 -->
        <div
          v-else-if="msg.role === 'system' && msg.systemEvent && isEventVisible(msg.systemEvent)"
          class="bubble-row bubble-row-system"
        >
          <!-- 折叠通知条 -->
          <div
            v-if="!expandedIds.has(msg.id)"
            class="system-notif"
            :class="`system-notif-${msg.systemEvent.type}`"
            @click="toggleExpand(msg.id)"
          >
            <span class="system-notif-icon">{{ eventIcon(msg.systemEvent.type) }}</span>
            <span class="system-notif-text">{{ msg.content }}</span>
            <span class="system-notif-chevron">▶</span>
          </div>

          <!-- 展开的系统卡片 -->
          <div v-else class="system-card-wrapper">
            <div class="system-card-header" @click="toggleExpand(msg.id)">
              <span class="system-card-icon">{{ eventIcon(msg.systemEvent.type) }}</span>
              <span class="system-card-title">{{ msg.content }}</span>
              <span class="system-card-chevron">▼</span>
            </div>
            <div class="system-card-body">
              <!-- 根据 type 渲染对应卡片组件 -->
              <CraftSystemCard v-if="msg.systemEvent.type === 'craft'" :event="msg.systemEvent" />
              <CharGenSystemCard
                v-else-if="msg.systemEvent.type === 'char_gen'"
                :event="msg.systemEvent"
              />
              <CombatSystemCard
                v-else-if="msg.systemEvent.type === 'combat'"
                :event="msg.systemEvent"
              />
              <ItemSystemCard
                v-else-if="msg.systemEvent.type === 'item_gen'"
                :event="msg.systemEvent"
              />
              <SystemNotifBar v-else :event="msg.systemEvent" />
            </div>
          </div>
        </div>
      </template>

      <div v-if="isGenerating" class="chat-loading">
        <span class="loading-dot">●</span> AI 正在生成...
      </div>
    </div>

    <InputBar @send="(c) => emit('send', c)" />
  </div>
</template>
```

- [ ] **Step 3: 添加 eventIcon 辅助函数 + 更新 import**

在 `<script setup>` 中追加：

```typescript
// Placeholder imports for card components (Task 5 will provide these)
// import CraftSystemCard from './cards/CraftSystemCard.vue'
// import CharGenSystemCard from './cards/CharGenSystemCard.vue'
// import CombatSystemCard from './cards/CombatSystemCard.vue'
// import ItemSystemCard from './cards/ItemSystemCard.vue'
// import SystemNotifBar from './cards/SystemNotifBar.vue'

function eventIcon(type: string): string {
  const icons: Record<string, string> = {
    craft: '🛠️', // 🛠️
    char_gen: '👤', // 👤
    item_gen: '🎒', // 🎒
    combat: '⚔️', // ⚔️
    character_update: '📊', // 📊
    item_update: '📦', // 📦
    quest_update: '📝', // 📝
  };
  return icons[type] ?? 'ℹ️'; // ℹ️
}
```

> **注意**：卡片组件 import 先注释掉，Task 5 完成后取消注释。当前阶段 template 中的卡片引用也会 typecheck 报错，这没问题——Task 5 自然会解决。

- [ ] **Step 4: 更新样式**

替换 `<style scoped>` 块，保留原有 bubble 样式，新增系统消息样式：

```css
/* ===== 系统消息 ===== */
.bubble-row-system {
  justify-content: center;
}

/* 折叠通知条 */
.system-notif {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--theme-radius-md, 8px);
  background: var(--theme-surface-muted);
  border-left: 3px solid var(--theme-primary);
  cursor: pointer;
  max-width: 85%;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  transition: background 0.15s;
  user-select: none;
}
.system-notif:hover {
  background: var(--theme-surface-hover, var(--theme-card-bg));
}
.system-notif-icon {
  font-size: 1rem;
}
.system-notif-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.system-notif-chevron {
  font-size: 0.625rem;
  opacity: 0.5;
  transition: transform 0.2s;
}

/* 展开卡片 */
.system-card-wrapper {
  max-width: 90%;
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
  border-bottom: 1px solid var(--theme-border, rgba(255, 255, 255, 0.06));
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

- [ ] **Step 5: 编译验证（预期有 import 错误，可接受）**

```bash
npm run typecheck
```

Expected: 报找不到卡片组件的错误（正常，Task 5 解决）

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/game/ChatFlow.vue
git commit -m "refactor(ui): ChatFlow — three-source message flow with foldable system cards"
```

---

### Task 5: 系统卡片组件（5 个 Vue SFC）

**Files:**

- Create: `src/ui/components/game/cards/CraftSystemCard.vue`
- Create: `src/ui/components/game/cards/CharGenSystemCard.vue`
- Create: `src/ui/components/game/cards/CombatSystemCard.vue`
- Create: `src/ui/components/game/cards/ItemSystemCard.vue`
- Create: `src/ui/components/game/cards/SystemNotifBar.vue`

**Consumes:**

- Type-specific SystemEvent subtypes（`CraftSystemEvent`, `CharGenSystemEvent`, `CombatSystemEvent`, `ItemGenSystemEvent`, `CharacterUpdateEvent | ItemUpdateEvent | QuestUpdateEvent`）

**Produces:**

- 5 个组件，ChatFlow 直接使用

- [ ] **Step 1: CraftSystemCard.vue**

```vue
<script setup lang="ts">
import type { CraftSystemEvent } from '@engine/types';

defineProps<{ event: CraftSystemEvent }>();

const qualityColors: Record<string, string> = {
  普通: '#c4cad3',
  优良: '#7be495',
  稀有: '#62bbff',
  史诗: '#cf95ff',
  传说: '#ffc46b',
  神话: '#ff78c5',
  唯一: '#00ffff',
};

const ratingIcons: Record<string, string> = {
  大失败: '❌',
  失败: '⚠️',
  成功: '✅',
  精益求精: '⭐',
};
</script>

<template>
  <div class="craft-card">
    <div class="card-top" :style="{ background: qualityColors[event.quality] || '#c4cad3' }">
      <span class="card-icon">🛠️</span>
      <span class="card-label">{{ event.quality }} · {{ event.productName }}</span>
    </div>
    <div class="card-body">
      <div class="craft-summary">
        {{ ratingIcons[event.rating] }} {{ event.rating }}
        <span v-if="event.details.checkSummary" class="check-detail">
          — {{ event.details.checkSummary }}
        </span>
      </div>
      <div v-if="event.details.craftParams?.materials" class="craft-materials">
        <span class="label">材料:</span> {{ event.details.craftParams.materials }}
      </div>
      <div v-if="event.details.itemRequests?.length" class="craft-effects">
        <div
          v-for="req in event.details.itemRequests"
          :key="req.quality + req.type"
          class="craft-req"
        >
          <span class="req-type">{{ req.type === 'equipment' ? '🗡️' : '🎒' }}</span>
          <span>{{ req.quality }} {{ req.type === 'equipment' ? '装备' : '物品' }}</span>
          <span class="req-desc" v-if="req.description">: {{ req.description.slice(0, 80) }}</span>
        </div>
      </div>
      <div class="craft-footer">
        <span v-if="event.details.craftParams?.expGained" class="stat-badge"
          >EXP +{{ event.details.craftParams.expGained }}</span
        >
        <span v-if="event.details.craftParams?.fpGained" class="stat-badge"
          >FP +{{ event.details.craftParams.fpGained }}</span
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
.craft-card {
  border-radius: 6px;
  overflow: hidden;
}
.card-top {
  padding: 8px 12px;
  font-weight: 600;
  font-size: 0.875rem;
  color: #1a1a2e;
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
.craft-summary {
  font-weight: 600;
}
.check-detail {
  font-weight: 400;
  opacity: 0.7;
}
.craft-materials .label {
  font-weight: 600;
  opacity: 0.6;
  margin-right: 4px;
}
.craft-effects {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.craft-req {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8125rem;
}
.req-type {
  font-size: 0.75rem;
}
.req-desc {
  opacity: 0.65;
  font-size: 0.75rem;
}
.craft-footer {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.stat-badge {
  background: var(--theme-surface-muted);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}
</style>
```

- [ ] **Step 2: CharGenSystemCard.vue**

```vue
<script setup lang="ts">
import type { CharGenSystemEvent } from '@engine/types';
defineProps<{ event: CharGenSystemEvent }>();
</script>

<template>
  <div class="chargen-card">
    <div class="card-top">
      <span class="char-name">{{ event.characterName }}</span>
      <span class="char-tier">T{{ event.tier }}</span>
      <span class="char-race">{{ event.race }}</span>
    </div>
    <div class="card-body">
      <div class="char-attrs">
        <span v-if="event.details.attributes" class="attr"
          >💪{{ event.details.attributes.str }}</span
        >
        <span v-if="event.details.attributes" class="attr"
          >🏃{{ event.details.attributes.dex }}</span
        >
        <span v-if="event.details.attributes" class="attr"
          >🛡️{{ event.details.attributes.con }}</span
        >
        <span v-if="event.details.attributes" class="attr"
          >🧠{{ event.details.attributes.int }}</span
        >
        <span v-if="event.details.attributes" class="attr"
          >✨{{ event.details.attributes.spi }}</span
        >
      </div>
      <div v-if="event.details.identity?.length" class="char-tags">
        <span v-for="tag in event.details.identity" :key="tag" class="tag">{{ tag }}</span>
      </div>
      <div v-if="event.details.background" class="char-bg">
        {{ event.details.background.slice(0, 150)
        }}{{ event.details.background.length > 150 ? '...' : '' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.chargen-card {
  border-radius: 6px;
  overflow: hidden;
}
.card-top {
  padding: 8px 12px;
  background: var(--theme-surface-muted);
  display: flex;
  align-items: center;
  gap: 8px;
}
.char-name {
  font-weight: 700;
  font-size: 0.9375rem;
  color: var(--theme-text-primary);
}
.char-tier {
  background: var(--theme-primary);
  color: #fff;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.6875rem;
  font-weight: 600;
}
.char-race {
  font-size: 0.75rem;
  opacity: 0.6;
}
.card-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.char-attrs {
  display: flex;
  gap: 12px;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
.attr {
  font-weight: 600;
}
.char-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tag {
  background: var(--theme-surface-muted);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.6875rem;
}
.char-bg {
  font-size: 0.75rem;
  opacity: 0.7;
  line-height: 1.5;
}
</style>
```

- [ ] **Step 3: CombatSystemCard.vue**

```vue
<script setup lang="ts">
import type { CombatSystemEvent } from '@engine/types';
defineProps<{ event: CombatSystemEvent }>();

const labels: Record<string, string> = {
  ally_win: '胜利',
  enemy_win: '败北',
  draw: '平局',
  fled: '逃跑',
};
const icons: Record<string, string> = { ally_win: '🏆', enemy_win: '💀', draw: '🤝', fled: '🏃' };
</script>

<template>
  <div class="combat-card">
    <div class="card-top">
      <span class="combat-icon">{{ icons[event.outcome] ?? '⚔️' }}</span>
      <span class="combat-label">{{ labels[event.outcome] ?? event.outcome }}</span>
      <span class="combat-rounds">{{ event.details.rounds }} 回合</span>
    </div>
    <div class="card-body">
      <div class="combat-summary">{{ event.details.narrativeSummary }}</div>
      <div v-if="event.details.loot?.length" class="combat-loot">
        <span class="loot-label">战利品:</span>
        <span v-for="l in event.details.loot" :key="l.name" class="loot-item">
          {{ l.name }}<span v-if="l.quantity > 1">×{{ l.quantity }}</span>
        </span>
      </div>
      <div class="combat-footer">
        <span class="stat-badge">EXP +{{ event.details.totalExp }}</span>
        <span class="stat-badge">FP +{{ event.details.totalFp }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.combat-card {
  border-radius: 6px;
  overflow: hidden;
}
.card-top {
  padding: 8px 12px;
  background: var(--theme-surface-muted);
  display: flex;
  align-items: center;
  gap: 8px;
}
.combat-icon {
  font-size: 1.125rem;
}
.combat-label {
  font-weight: 700;
  font-size: 0.9375rem;
  color: var(--theme-text-primary);
}
.combat-rounds {
  font-size: 0.75rem;
  opacity: 0.5;
  margin-left: auto;
}
.card-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.8125rem;
}
.combat-summary {
  line-height: 1.5;
  color: var(--theme-text-primary);
}
.combat-loot {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.loot-label {
  font-weight: 600;
  opacity: 0.6;
  font-size: 0.75rem;
}
.loot-item {
  background: var(--theme-surface-muted);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
}
.combat-footer {
  display: flex;
  gap: 8px;
}
.stat-badge {
  background: var(--theme-surface-muted);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}
</style>
```

- [ ] **Step 4: ItemSystemCard.vue**

```vue
<script setup lang="ts">
import type { ItemGenSystemEvent } from '@engine/types';
defineProps<{ event: ItemGenSystemEvent }>();

const qualityColors: Record<string, string> = {
  普通: '#c4cad3',
  优良: '#7be495',
  稀有: '#62bbff',
  史诗: '#cf95ff',
  传说: '#ffc46b',
  神话: '#ff78c5',
  唯一: '#00ffff',
};
</script>

<template>
  <div class="item-card">
    <div class="card-top" :style="{ borderColor: qualityColors[event.quality] || '#c4cad3' }">
      <span class="item-type">{{
        event.itemType === '装备' ? '🗡️' : event.itemType === '技能' ? '✨' : '🎒'
      }}</span>
      <span class="item-name">{{ event.itemName }}</span>
      <span class="item-quality" :style="{ color: qualityColors[event.quality] || '#c4cad3' }">{{
        event.quality
      }}</span>
    </div>
    <div v-if="event.details.equipment?.length" class="card-body">
      <div v-for="eq in event.details.equipment" :key="eq.name" class="equip-line">
        <span class="equip-slot">{{ eq.slot }}</span>
        <span>{{ eq.description?.slice(0, 120) }}</span>
      </div>
    </div>
    <div v-if="event.details.skills?.length" class="card-body">
      <div v-for="sk in event.details.skills" :key="sk.name" class="skill-line">
        <span class="skill-name">{{ sk.name }}</span>
        <span>{{ sk.description?.slice(0, 120) }}</span>
      </div>
    </div>
    <div v-if="event.details.inventory?.length" class="card-body">
      <div v-for="inv in event.details.inventory" :key="inv.name" class="inv-line">
        <span>{{ inv.name }} ×{{ inv.quantity }}</span>
        <span class="inv-desc" v-if="inv.description">: {{ inv.description.slice(0, 100) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.item-card {
  border-radius: 6px;
  overflow: hidden;
}
.card-top {
  padding: 8px 12px;
  border-left: 4px solid;
  background: var(--theme-surface-muted);
  display: flex;
  align-items: center;
  gap: 8px;
}
.item-name {
  font-weight: 700;
  font-size: 0.875rem;
}
.item-quality {
  font-size: 0.75rem;
  font-weight: 600;
}
.item-type {
  font-size: 0.75rem;
}
.card-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.8125rem;
}
.equip-line,
.skill-line,
.inv-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.equip-slot {
  background: var(--theme-primary);
  color: #fff;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.625rem;
  font-weight: 600;
}
.skill-name {
  color: #90cdf4;
  font-weight: 600;
}
.inv-desc {
  opacity: 0.6;
  font-size: 0.75rem;
}
</style>
```

- [ ] **Step 5: SystemNotifBar.vue**

```vue
<script setup lang="ts">
import type { CharacterUpdateEvent, ItemUpdateEvent, QuestUpdateEvent } from '@engine/types';
defineProps<{ event: CharacterUpdateEvent | ItemUpdateEvent | QuestUpdateEvent }>();
</script>

<template>
  <div class="notif-bar">
    <span class="notif-icon">ℹ️</span>
    <span>{{ event.narrative }}</span>
  </div>
</template>

<style scoped>
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
  font-size: 0.875rem;
  opacity: 0.6;
}
</style>
```

- [ ] **Step 6: 回到 ChatFlow.vue 取消卡片组件 import 注释**

在 `ChatFlow.vue` 的 `<script setup>` 顶部，把 Task 4 里注释掉的 import 取消注释：

```typescript
import CraftSystemCard from './cards/CraftSystemCard.vue';
import CharGenSystemCard from './cards/CharGenSystemCard.vue';
import CombatSystemCard from './cards/CombatSystemCard.vue';
import ItemSystemCard from './cards/ItemSystemCard.vue';
import SystemNotifBar from './cards/SystemNotifBar.vue';
```

- [ ] **Step 7: 编译验证**

```bash
npm run typecheck
```

Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add src/ui/components/game/cards/ src/ui/components/game/ChatFlow.vue
git commit -m "feat(ui): add 5 system card components + wire into ChatFlow"
```

---

### Task 6: GamePage.vue — 从 mock 切换到 store 驱动

**Files:**

- Modify: `src/ui/components/game/GamePage.vue`

**Consumes:**

- `game.messages`（Task 3 产出）
- `game.addMessage()`（Task 3 产出）
- `game.systemEventsVisible`、`game.systemEventFilters`（Task 3 产出）
- `ChatFlow`（已重构，Task 4-5 产出）

**Produces:**

- 删 `FlowMessage[]` mock
- `handleSend` 写入 store
- `ChatFlow` props 绑定 store

- [ ] **Step 1: 修改 script**

替换 `GamePage.vue` 的 `<script setup>`：

```vue
<script setup lang="ts">
import { onMounted } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import TopBar from './TopBar.vue';
import SideToolbar from './SideToolbar.vue';
import ChatFlow from './ChatFlow.vue';
import StatusHUD from './StatusHUD.vue';
import AppModal from '../shared/AppModal.vue';
import ItemsPanel from './ItemsPanel.vue';
import CharacterListPanel from './CharacterListPanel.vue';
import QuestsPanel from './QuestsPanel.vue';
import PlotPanel from './PlotPanel.vue';
import MemoryPanel from './MemoryPanel.vue';
import MapPanel from './MapPanel.vue';

const game = useGameStore();
const ui = useUIStore();

onMounted(async () => {
  if (ui.activeSaveId) {
    await game.loadSave(ui.activeSaveId);
  }
});

function handleSend(content: string) {
  game.addMessage(content, 'user');
  // TODO: Phase 7e-3 — 接入 AgentOrchestrator，移除 mock
  game.isGenerating = true;
  setTimeout(() => {
    game.addMessage('[AI 回复将在 Phase 7e-3 接入引擎后生效]', 'assistant');
    game.isGenerating = false;
  }, 500);
}

function handleToolClick(id: string) {
  if (id === 'settings') {
    ui.navigate('settings');
    return;
  }
  game.showModal(id);
}
</script>
```

关键变更：

- 删 `import type { FlowMessage } from './ChatFlow.vue'`
- 删 `const flowMessages: FlowMessage[] = []`
- `handleSend` 改用 `game.addMessage()`
- 加 `game.isGenerating` 控制

- [ ] **Step 2: 修改 template 的 ChatFlow props**

把：

```vue
<ChatFlow :messages="flowMessages" :is-generating="game.isGenerating" @send="handleSend" />
```

改为：

```vue
<ChatFlow
  :messages="game.messages"
  :is-generating="game.isGenerating"
  :system-events-visible="game.systemEventsVisible"
  :system-event-filters="game.systemEventFilters"
  @send="handleSend"
/>
```

- [ ] **Step 3: 编译验证**

```bash
npm run typecheck
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/game/GamePage.vue
git commit -m "refactor(ui): GamePage — switch from FlowMessage mock to store-driven messages"
```

---

### Task 7: agent-templates.ts — buildAgentMessages 处理 system role

**Files:**

- Modify: `src/sillytavern/agent-templates.ts`

**Consumes:**

- `ChatMessage`（已有，约 line 74-83 的 `formatHistory` 函数）

**Produces:**

- `formatHistory` 输出时将 `role='system'` 的消息转为 `[assistant]` 显示

- [ ] **Step 1: 修改 formatHistory 函数**

`formatHistory`（约 line 74-83）当前：

```typescript
function formatHistory(ctx: AgentContext): string {
  const agentId = ctx.agentConfig?.agentId ?? (ctx as any)._proxyAgentId ?? '';
  const layers = ctx.agentConfig?.historyLayers ?? defaultHistoryLayers(agentId);
  const slice = ctx.agentConfig?.historySlice ?? defaultHistorySlice(agentId);
  if (layers <= 0) return '';
  const maxMessages = layers * 2;
  return ctx.history
    .slice(-maxMessages)
    .map((m) => `[${m.role}]: ${m.content.slice(0, slice)}`)
    .join('\n');
}
```

改为：

```typescript
function formatHistory(ctx: AgentContext): string {
  const agentId = ctx.agentConfig?.agentId ?? (ctx as any)._proxyAgentId ?? '';
  const layers = ctx.agentConfig?.historyLayers ?? defaultHistoryLayers(agentId);
  const slice = ctx.agentConfig?.historySlice ?? defaultHistorySlice(agentId);
  if (layers <= 0) return '';
  const maxMessages = layers * 2;
  return ctx.history
    .slice(-maxMessages)
    .map((m) => {
      // 系统消息在 API history 里转成 assistant role（避免 mid-conversation system role 语义歧义）
      const displayRole = m.role === 'system' ? 'assistant' : m.role;
      return `[${displayRole}]: ${m.content.slice(0, slice)}`;
    })
    .join('\n');
}
```

- [ ] **Step 2: 同时修改 `recentHistoryBlock` 相关的另一处引用**

检查 `agent-templates.ts:401`：

```typescript
tplCtx.userInput + '\n' + (tplCtx.history.slice(-5).map(m => m.content).join('\n')),
```

这行只是 `.content` 拼接，不涉及 role 输出，无需改动。

- [ ] **Step 3: 编译验证**

```bash
npm run typecheck
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/sillytavern/agent-templates.ts
git commit -m "fix(engine): formatHistory — system role messages displayed as assistant to API"
```

---

### Task 8: settings-store.ts + SettingsPage.vue — 系统事件可见性开关

**Files:**

- Modify: `src/ui/stores/settings-store.ts`
- Modify: `src/ui/components/settings/SettingsPage.vue`

**Consumes:**

- settings KV store（已有）
- 现有 SettingsPage 的 8 分区布局

**Produces:**

- 设置页新增「消息显示」分区，含全局开关 + 7 个分类 toggle
- 默认值写入 settings-store 的 defaults

- [ ] **Step 1: settings-store — 加默认字段**

在 `settings-store.ts` 的 `getDefaults()` 函数末尾 return 前（约 line 123），加：

```typescript
    // 消息 & 系统事件可见性
    systemEventsVisible: true,
    systemEventFilters: {
      craft: true,
      char_gen: true,
      item_gen: true,
      combat: true,
      character_update: false,
      item_update: false,
      quest_update: false,
    } as Record<string, boolean>,
```

- [ ] **Step 2: 编译验证**

```bash
npm run typecheck
```

Expected: 0 errors

- [ ] **Step 3: SettingsPage.vue — 加在「外观主题」和「存档数据」分区之间**

section nav 区域（约 line 27-37），在 theme 和 data 之间插入新 section：

```typescript
// 在 Section 类型的联合里加 'messages'
type Section =
  'api' | 'agent' | 'worldbook' | 'plot' | 'memory' | 'theme' | 'messages' | 'data' | 'about';

const navItems: { key: Section; label: string; icon: string }[] = [
  { key: 'api', label: 'API 配置', icon: 'fa-solid fa-plug' },
  { key: 'agent', label: 'Agent 配置', icon: 'fa-solid fa-robot' },
  { key: 'worldbook', label: '世界书', icon: 'fa-solid fa-book' },
  { key: 'plot', label: '剧情系统', icon: 'fa-solid fa-feather' },
  { key: 'memory', label: '记忆 & 缓存', icon: 'fa-solid fa-brain' },
  { key: 'theme', label: '外观主题', icon: 'fa-solid fa-palette' },
  { key: 'messages', label: '消息显示', icon: 'fa-solid fa-message' }, // 🆕
  { key: 'data', label: '存档数据', icon: 'fa-solid fa-floppy-disk' },
  { key: 'about', label: '关于', icon: 'fa-solid fa-circle-info' },
];
```

- [ ] **Step 4: 在 template 中加入新分区 UI（插在 theme 和 data 之间）**

```vue
<!-- ========== 消息显示 ========== -->
<section v-if="activeSection === 'messages'" class="section centered">
  <h3>消息显示</h3>
  <p class="section-desc">控制对话流中系统通知的可见性。关闭后对应类型的消息将不在正文中渲染。</p>

  <AppCard padding="md" style="margin-top: 16px">
    <h4>全局开关</h4>
    <div class="toggle-row">
      <span>显示系统通知</span>
      <label class="toggle-label">
        <input type="checkbox" v-model="s.systemEventsVisible" class="toggle-input" />
        <span class="toggle-slider"></span>
      </label>
    </div>
  </AppCard>

  <AppCard padding="md" style="margin-top: 12px">
    <h4>分类控制</h4>
    <p class="text-muted text-sm" style="margin-bottom: 12px">选择哪些类型的系统事件在对话流中展示</p>
    <div class="event-filter-grid">
      <div class="toggle-row" v-for="(enabled, key) in s.systemEventFilters" :key="key">
        <span>{{ eventFilterLabel(key) }}</span>
        <label class="toggle-label">
          <input type="checkbox" v-model="s.systemEventFilters[key]" class="toggle-input" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </AppCard>
</section>
```

- [ ] **Step 5: 添加 eventFilterLabel 辅助函数**

在 script 中追加：

```typescript
function eventFilterLabel(key: string): string {
  const labels: Record<string, string> = {
    craft: '🛠️ 制作完成',
    char_gen: '👤 新角色加入',
    item_gen: '🎒 新物品获得',
    combat: '⚔️ 战斗结果',
    character_update: '📊 角色微调',
    item_update: '📦 物品变动',
    quest_update: '📝 任务进度',
  };
  return labels[key] ?? key;
}
```

- [ ] **Step 6: 加少量 CSS**

在 SettingsPage 的 `<style scoped>` 中追加：

```css
.event-filter-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--theme-border, rgba(255, 255, 255, 0.04));
}
```

`toggle-label`、`toggle-input`、`toggle-slider` 样式已在 settings 页面其他地方定义（条目编辑器用），复用即可。

- [ ] **Step 7: 编译验证**

```bash
npm run typecheck
```

Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add src/ui/stores/settings-store.ts src/ui/components/settings/SettingsPage.vue
git commit -m "feat(settings): add system event visibility controls — global toggle + per-type filters"
```

---

### Task 9: 集成测试 — ChatFlow 消息渲染

**Files:**

- Modify: `src/ui/components/game/GamePage.test.ts`

写入一个简单的渲染验证测试，确保 ChatFlow 处理三种 role 不崩溃。

- [ ] **Step 1: 写入测试**

```typescript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatFlow from './ChatFlow.vue';
import type { ChatMessage } from '@engine/types';

describe('ChatFlow — 三源消息渲染', () => {
  it('应渲染用户消息（右对齐）', () => {
    const msgs: ChatMessage[] = [{ id: '1', role: 'user', content: '你好', timestamp: 0 }];
    const wrapper = mount(ChatFlow, { props: { messages: msgs } });
    expect(wrapper.find('.bubble-player').exists()).toBe(true);
    expect(wrapper.find('.bubble-player .bubble-text').text()).toBe('你好');
  });

  it('应渲染 AI 叙事消息（左对齐）', () => {
    const msgs: ChatMessage[] = [
      { id: '1', role: 'assistant', content: '冒险开始了', timestamp: 0 },
    ];
    const wrapper = mount(ChatFlow, { props: { messages: msgs } });
    expect(wrapper.find('.bubble-narrative').exists()).toBe(true);
  });

  it('应渲染系统消息为折叠通知条', () => {
    const msgs: ChatMessage[] = [
      {
        id: '1',
        role: 'system',
        content: '[制作] 成功 — 传说级 霜月之刃',
        timestamp: 0,
      },
    ];
    const wrapper = mount(ChatFlow, {
      props: { messages: msgs, systemEventsVisible: true, systemEventFilters: {} },
    });
    // 没有 systemEvent 字段，但 role=system 不崩溃
    expect(wrapper.find('.chat-messages').exists()).toBe(true);
  });

  it('空消息列表应显示占位文案', () => {
    const wrapper = mount(ChatFlow, { props: { messages: [] } });
    expect(wrapper.find('.chat-empty').exists()).toBe(true);
    expect(wrapper.text()).toContain('等待冒险开始');
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
npx vitest run src/ui/components/game/GamePage.test.ts
```

Expected: PASS

- [ ] **Step 3: Compile + all tests**

```bash
npm run typecheck && npm run test -- --run
```

Expected: typecheck 0 errors，all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/game/GamePage.test.ts
git commit -m "test(ui): add ChatFlow three-role rendering tests"
```

---

## Verification

完成后验证：

1. **类型检查**：`npm run typecheck` → 0 errors
2. **全部测试**：`npm test -- --run` → all pass
3. **视觉验证**（需启动 dev server）：
   - 在游戏页输入文字 → 用户气泡右对齐
   - mock AI 回复 → 叙事气泡左对齐
   - 进入设置页 → 「消息显示」分区可见，开关可操作
   - 关闭某个系统事件类型 → 对应消息不在 ChatFlow 中显示

---
