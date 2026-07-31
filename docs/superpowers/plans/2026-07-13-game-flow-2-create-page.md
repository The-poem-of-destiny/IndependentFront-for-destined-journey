# Plan 2: 创角页改造 — 世界书驱动的命运核心 + 角色启用步骤

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将创角页的「命运核心」从硬编码列表改为读取 `system_core` 世界书条目展示；新增「角色启用」步骤从 `character` 世界书多选勾选；`startJourney()` 将选中的世界书条目 ID 写入存档 metadata。

**Architecture:** create-store 直接从 `@engine/builtin-worldbooks` 异步加载世界书条目，不依赖 settings-store 的异步初始化。命运核心是 `system_core` 分区的 worldbook entries 单选，角色启用是 `character` 分区的 entries 多选。选中结果以 `partition:uid` 格式存入 `SaveSlot.metadata.enabledWorldBookEntries`。

**Tech Stack:** Vue 3 + Pinia, TypeScript

## Global Constraints

- 所有 UI 组件遵循 `docs/design.md` 设计规范
- `types.ts` 是唯一类型来源
- 测试优先：Pinia store + 组件测试
- `npm test` 必须全部通过

---

### Task 1: create-store — 新增世界书条目加载 + 命运核心/角色选择状态

**Files:**

- Modify: `src/ui/stores/create-store.ts`

**Interfaces:**

- Consumes: `loadBuiltInWorldBooks` from `@engine/builtin-worldbooks`
- Consumes: `WorldBook, WorldBookEntry` from `@engine/types`
- Produces: `systemCoreEntries: Ref<WorldBookEntry[]>` — system_core 分区条目列表
- Produces: `characterEntries: Ref<WorldBookEntry[]>` — character 分区条目列表
- Produces: `selectedSystemCoreEntryUid: Ref<number | null>` — 选中的命定核心 entry uid
- Produces: `selectedSystemCoreEntry: ComputedRef<WorldBookEntry | null>` — 选中的命定核心条目
- Produces: `enabledCharacterEntryUids: Ref<Set<number>>` — 勾选的 character entry uid 集合
- Produces: `loadWorldBookEntries(): Promise<void>` — 异步加载世界书条目
- Produces: `selectSystemCoreEntry(uid: number): void` — 单选
- Produces: `toggleCharacterEntry(uid: number): void` — 多选 toggle
- Produces: `buildEnabledWorldBookEntries(): string[]` — 生成存档用的条目 ID 列表

- [ ] **Step 1: 导入依赖并添加状态变量**

在 `create-store.ts` 顶部 import 区添加：

```typescript
import { loadBuiltInWorldBooks } from '@engine/builtin-worldbooks';
import type { WorldBook, WorldBookEntry } from '@engine/types';
```

在 store 内部（`defineStore('create', () => {` 之后），现有 `destinyCore` ref 附近添加新状态：

```typescript
// ═══════════════════════════════════════════════════════
// Phase 10h: 世界书驱动的命定核心 + 角色启用
// ═══════════════════════════════════════════════════════

/** system_core 世界书条目列表（命定核心候选） */
const systemCoreEntries = ref<WorldBookEntry[]>([]);

/** character 世界书条目列表（可启用角色） */
const characterEntries = ref<WorldBookEntry[]>([]);

/** 选中的命定核心 entry uid */
const selectedSystemCoreEntryUid = ref<number | null>(null);

/** 选中的命定核心条目 */
const selectedSystemCoreEntry = computed<WorldBookEntry | null>(() => {
  if (selectedSystemCoreEntryUid.value === null) return null;
  return systemCoreEntries.value.find((e) => e.uid === selectedSystemCoreEntryUid.value) ?? null;
});

/** 勾选的 character entry uids */
const enabledCharacterEntryUids = ref<Set<number>>(new Set());
```

- [ ] **Step 2: 添加加载函数**

在状态变量之后添加：

```typescript
/** 从内置世界书加载 system_core 和 character 条目 */
async function loadWorldBookEntries() {
  try {
    const books = await loadBuiltInWorldBooks();
    systemCoreEntries.value = books
      .filter((b) => b.partition === 'system_core')
      .flatMap((b) => b.entries);
    characterEntries.value = books
      .filter((b) => b.partition === 'character')
      .flatMap((b) => b.entries);
  } catch {
    // fetch 不可用时静默跳过，保持空数组
    systemCoreEntries.value = [];
    characterEntries.value = [];
  }
}

/** 单选命定核心 */
function selectSystemCoreEntry(uid: number) {
  selectedSystemCoreEntryUid.value = uid;
}

/** toggle 勾选角色 */
function toggleCharacterEntry(uid: number) {
  const next = new Set(enabledCharacterEntryUids.value);
  if (next.has(uid)) {
    next.delete(uid);
  } else {
    next.add(uid);
  }
  enabledCharacterEntryUids.value = next;
}

/** 构建存档用的世界书条目 ID 列表（partition:uid 格式） */
function buildEnabledWorldBookEntries(): string[] {
  const ids: string[] = [];

  // 命定核心 → system_core:uid
  if (selectedSystemCoreEntryUid.value !== null) {
    ids.push(`system_core:${selectedSystemCoreEntryUid.value}`);
  }

  // 启用角色 → character:uid
  for (const uid of enabledCharacterEntryUids.value) {
    ids.push(`character:${uid}`);
  }

  return ids;
}
```

- [ ] **Step 3: 修改 stepValid — 适应新步骤顺序**

找到现有 `stepValid` computed（约 85 行），修改为新的 8 步骤（0-7）：

```typescript
const stepValid = computed<Record<number, boolean>>(() => ({
  0: difficulty.value !== null,
  1:
    name.value.trim().length > 0 &&
    race.value !== '' &&
    remainingBP.value >= 0 &&
    remainingAP.value >= 0,
  2: selectedSystemCoreEntryUid.value !== null, // 命定核心
  3: true, // 角色启用（可选）
  4: true, // 装备选择
  5: true, // 背景故事
  6: true, // 剧情规划
  7: true, // 确认提交
}));
```

同时修改 `nextStep()` 中的最大步数：`currentStep.value < 7`。

- [ ] **Step 4: 修改 startJourney() — 写入 enabledWorldBookEntries**

找到 `startJourney()` 函数（约 646 行），在 `saveSaveSlot` 调用中，`metadata` 对象里加入：

```typescript
await saveSaveSlot({
  id: saveId,
  name: charState.name,
  slot: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  activeSnapshotId: null,
  snapshots: [],
  metadata: {
    characterName: charState.name,
    userName: '玩家',
    gameStartTime: new Date().toISOString(),
    totalTurns: 0,
    description: JSON.stringify({
      openingPrompt,
      destinyCoreId: destinyCore.value?.id ?? null,
      difficulty: difficulty.value?.id ?? 'normal',
      remainingPoints: remainingPoints.value,
    }),
    enabledWorldBookEntries: buildEnabledWorldBookEntries(), // 🆕
    openingPrompt: openingPrompt, // 🆕
    openingPromptConsumed: false, // 🆕
  },
});
```

- [ ] **Step 5: 保留旧 destinyCore 相关代码兼容性**

旧的 `destinyCore` / `destinyCorePool` / `selectDestinyCore` 仍然保留（捏人预设的保存/加载还会用到），但不再作为 UI 展示的主要数据源。在 preset 保存/恢复逻辑中，`destinyCoreId` 改为存储 `selectedSystemCoreEntryUid` 对应的 entry name（用于向后兼容）。

找到 `getCurrentPresetData()` 和 `applyPresetData()`，保持现有逻辑不变（它们使用的是旧的 destinyCore 字段）；新增的字段（selectedSystemCoreEntryUid / enabledCharacterEntryUids）在 preset 保存时也一并序列化。

在 `getCurrentPresetData()` 返回对象中添加：

```typescript
systemCoreEntryUid: selectedSystemCoreEntryUid.value,
enabledCharacterEntryUids: [...enabledCharacterEntryUids.value],
```

在 `applyPresetData()` 中恢复：

```typescript
if (data.systemCoreEntryUid) selectSystemCoreEntry(data.systemCoreEntryUid);
if (data.enabledCharacterEntryUids) {
  enabledCharacterEntryUids.value = new Set(data.enabledCharacterEntryUids);
}
```

- [ ] **Step 6: 导出新增的 state 和方法**

在 store 的 return 对象中添加：

```typescript
systemCoreEntries, characterEntries,
selectedSystemCoreEntryUid, selectedSystemCoreEntry,
enabledCharacterEntryUids,
loadWorldBookEntries, selectSystemCoreEntry, toggleCharacterEntry,
buildEnabledWorldBookEntries,
```

- [ ] **Step 7: 编译验证**

```bash
npm run typecheck
```

Expected: 无新增类型错误。

- [ ] **Step 8: Commit**

```bash
git add src/ui/stores/create-store.ts
git commit -m "feat(create): create-store — 世界书驱动的命运核心 + 角色启用 + startJourney 写入 enabledWorldBookEntries"
```

---

### Task 2: CreateStepDestinyCore.vue — 改为世界书条目渲染

**Files:**

- Modify: `src/ui/components/create/CreateStepDestinyCore.vue`

**Interfaces:**

- Consumes: `store.systemCoreEntries`, `store.selectedSystemCoreEntryUid`, `store.selectedSystemCoreEntry`, `store.selectSystemCoreEntry`

- [ ] **Step 1: 重写模板 — 用世界书条目代替硬编码卡片**

原模板遍历 `store.destinyCorePool`，改为遍历 `store.systemCoreEntries`。每个条目显示 `entry.name` 作为标题，`entry.content` 的前 200 字符作为摘要。

```vue
<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store';

const store = useCreateStore();

/** 提取条目内容的纯文本摘要（去掉 HTML/EJS 标签） */
function summary(content: string, maxLen = 200): string {
  const cleaned = content
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}
</script>

<template>
  <section class="step-core">
    <h2 class="step-title">命定核心 — 选择你的命定之灵</h2>
    <p class="step-desc">
      命定之灵是寄宿于你灵魂中的存在，它将伴随整个命运之旅，影响叙事风格和特殊机制。请慎重选择。
    </p>

    <div v-if="store.systemCoreEntries.length === 0" class="core-loading">
      正在加载命定核心列表…
    </div>

    <div v-else class="core-grid">
      <div
        v-for="entry in store.systemCoreEntries"
        :key="entry.uid"
        class="core-card"
        :class="{ selected: store.selectedSystemCoreEntryUid === entry.uid }"
        role="radio"
        :aria-checked="store.selectedSystemCoreEntryUid === entry.uid"
        tabindex="0"
        @click="store.selectSystemCoreEntry(entry.uid)"
        @keydown.enter="store.selectSystemCoreEntry(entry.uid)"
        @keydown.space.prevent="store.selectSystemCoreEntry(entry.uid)"
      >
        <div class="core-name">{{ entry.name }}</div>
        <div class="core-summary">{{ summary(entry.content) }}</div>
      </div>
    </div>

    <div v-if="store.selectedSystemCoreEntry" class="selected-detail">
      <div class="sd-header">
        <span class="sd-dot" />
        <h3>{{ store.selectedSystemCoreEntry.name }}</h3>
      </div>
      <div class="sd-desc">{{ summary(store.selectedSystemCoreEntry.content, 500) }}</div>
    </div>
  </section>
</template>
```

样式保留原有的 `.step-core` / `.core-grid` / `.core-card` / `.selected-detail` 等 CSS（已有，无需改动）。新增 `.core-loading`：

```css
.core-loading {
  text-align: center;
  padding: 2rem;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
}
```

- [ ] **Step 2: 编译验证 + UI 目视检查**

```bash
npm run typecheck
npm run build
```

启动 dev server，访问 `/create`，到第 2 步确认命运核心列表从世界书加载并正常展示。

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/create/CreateStepDestinyCore.vue
git commit -m "feat(create): CreateStepDestinyCore — 改为从 system_core 世界书读取条目"
```

---

### Task 3: 新增 CreateStepCharacters.vue — 角色启用步骤

**Files:**

- Create: `src/ui/components/create/CreateStepCharacters.vue`

**Interfaces:**

- Consumes: `store.characterEntries`, `store.enabledCharacterEntryUids`, `store.toggleCharacterEntry`
- Produces: 多选勾选角色卡片的 UI 组件

- [ ] **Step 1: 创建组件**

```vue
<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store';

const store = useCreateStore();

/** 提取条目内容的纯文本摘要 */
function summary(content: string, maxLen = 160): string {
  const cleaned = content
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}
</script>

<template>
  <section class="step-characters">
    <h2 class="step-title">启用角色</h2>
    <p class="step-desc">勾选你希望在此存档中出现的角色。未勾选的角色不会在叙事中被激活。</p>

    <div v-if="store.characterEntries.length === 0" class="chars-loading">正在加载角色列表…</div>

    <div v-else class="chars-grid">
      <label
        v-for="entry in store.characterEntries"
        :key="entry.uid"
        class="char-card"
        :class="{ checked: store.enabledCharacterEntryUids.has(entry.uid) }"
      >
        <input
          type="checkbox"
          class="char-checkbox"
          :checked="store.enabledCharacterEntryUids.has(entry.uid)"
          @change="store.toggleCharacterEntry(entry.uid)"
        />
        <div class="char-info">
          <div class="char-name">{{ entry.name }}</div>
          <div class="char-summary">{{ summary(entry.content) }}</div>
        </div>
      </label>
    </div>

    <div class="chars-count">
      已选择 {{ store.enabledCharacterEntryUids.size }} / {{ store.characterEntries.length }} 个角色
    </div>
  </section>
</template>

<style scoped>
.step-characters {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.step-title {
  font-size: 1.125rem;
  font-weight: 600;
  margin: 0 0 0.25rem;
}

.step-desc {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  margin: 0 0 1rem;
}

.chars-loading {
  text-align: center;
  padding: 2rem;
  color: var(--theme-text-muted);
}

.chars-grid {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
  align-content: start;
}

.char-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 6px);
  background: var(--theme-card-bg);
  cursor: pointer;
  transition: border-color 150ms;
}

.char-card:hover {
  border-color: var(--theme-primary);
}

.char-card.checked {
  border-color: var(--theme-primary);
  background: var(--theme-primary-muted, rgba(var(--theme-primary-rgb), 0.08));
}

.char-checkbox {
  margin-top: 2px;
  flex-shrink: 0;
  accent-color: var(--theme-primary);
}

.char-info {
  min-width: 0;
}

.char-name {
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 2px;
}

.char-summary {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.chars-count {
  padding-top: 8px;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  text-align: right;
  border-top: 1px solid var(--theme-card-border);
  margin-top: 8px;
}
</style>
```

- [ ] **Step 2: 编译验证**

```bash
npm run typecheck
```

Expected: 无类型错误。

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/create/CreateStepCharacters.vue
git commit -m "feat(create): 新增 CreateStepCharacters — character 世界书多选角色启用"
```

---

### Task 4: CreatePage.vue + CreateSteps.vue — 插入新步骤

**Files:**

- Modify: `src/ui/components/create/CreatePage.vue`
- Modify: `src/ui/components/create/CreateSteps.vue`

**Interfaces:**

- Consumes: CreateStepCharacters (lazy import)
- Consumes: `store.loadWorldBookEntries()`

- [ ] **Step 1: CreateSteps.vue — 更新步骤标签**

找到 `STEP_LABELS` 数组（约 7 行），改为：

```typescript
const STEP_LABELS = [
  '难度选择',
  '基础信息',
  '命定核心',
  '角色启用', // 🆕
  '装备选择',
  '背景故事',
  '剧情规划',
  '确认提交',
];
```

- [ ] **Step 2: CreatePage.vue — 添加世界书加载 + 新步骤组件**

在 `CreatePage.vue` 的 `<script setup>` 中找到 `onMounted`（或类似的初始化逻辑，如果没有就加一个）：

```typescript
import { onMounted } from 'vue';
import { useCreateStore } from '../../stores/create-store';

const store = useCreateStore();

onMounted(() => {
  store.loadWorldBookEntries();
});
```

在 template 的步骤切换区域，找到 `v-if="store.currentStep === 2"`（原命运核心），确认它是第 2 步。然后在原来第 3 步（装备选择）之前插入新步骤。找到现有的步骤条件渲染，调整序号：

原有的步骤映射：

- step 0: CreateStepDifficulty
- step 1: CreateStepBasic
- step 2: CreateStepDestinyCore
- step 3: CreateStepSelections
- step 4: CreateStepBackground
- step 5: CreateStepPlot
- step 6: CreateStepConfirm

改为（插入新步骤后）：

- step 0: CreateStepDifficulty
- step 1: CreateStepBasic
- step 2: CreateStepDestinyCore
- step 3: CreateStepCharacters ← 新增
- step 4: CreateStepSelections
- step 5: CreateStepBackground
- step 6: CreateStepPlot
- step 7: CreateStepConfirm

添加 lazy import（找到其他 `defineAsyncComponent` 导入的位置）：

```typescript
const CreateStepCharacters = defineAsyncComponent(() => import('./CreateStepCharacters.vue'));
```

在 template 中插入（在 CreateStepDestinyCore 和 CreateStepSelections 之间）：

```html
<CreateStepCharacters v-if="store.currentStep === 3" />
```

然后将原来 step 3-6 的条件改为 step 4-7。

**注意:** CreateFooter 中的 `nextStep()` / `prevStep()` 不需要改动（它们已经通过 `currentStep < 7` 和 `stepValid` 控制边界）。

- [ ] **Step 3: 编译 + 运行验证**

```bash
npm run typecheck
npm run build
```

启动 dev server，走一遍完整创角流程（7 步），确认：

- 步骤指示器显示 8 个标签
- 第 2 步命运核心从世界书加载
- 第 3 步角色列表从世界书加载，可多选
- 开始旅程后 IndexedDB 中 saveSlot.metadata.enabledWorldBookEntries 有数据

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/create/CreatePage.vue src/ui/components/create/CreateSteps.vue
git commit -m "feat(create): CreatePage — 插入角色启用步骤 + 预加载世界书条目"
```

---

### Task 5: 运行 create-store 测试 + 全局回归

- [ ] **Step 1: 运行 create-store 测试**

```bash
npx vitest run src/ui/stores/create-store.test.ts
```

Expected: 现有测试 PASS。如有失败，检查 Task 1 的修改是否影响了测试 mock。

- [ ] **Step 2: 更新 create-store 测试**

在 `create-store.test.ts` 中为新增的函数添加测试（如果测试使用 fake indexedDB 且世界书需要 mock）：

```typescript
describe('create-store — 世界书条目管理 (Phase 10h)', () => {
  it('loadWorldBookEntries 应正确加载 system_core 和 character 条目', async () => {
    const store = useCreateStore();
    await store.loadWorldBookEntries();

    // systemCoreEntries 和 characterEntries 在 fake-indexeddb 中可能为空
    // 验证初始状态为数组
    expect(Array.isArray(store.systemCoreEntries)).toBe(true);
    expect(Array.isArray(store.characterEntries)).toBe(true);
  });

  it('selectSystemCoreEntry + toggleCharacterEntry + buildEnabledWorldBookEntries', async () => {
    const store = useCreateStore();
    // 模拟手动设置条目
    store.systemCoreEntries = [
      {
        uid: 408,
        name: '白祷',
        content: '...',
        enabled: false,
        constant: true,
        key: [],
        keysecondary: [],
        selectiveLogic: 0,
        order: 100,
        position: 0,
      },
    ];
    store.characterEntries = [
      {
        uid: 313,
        name: '丝特拉',
        content: '...',
        enabled: false,
        constant: true,
        key: [],
        keysecondary: [],
        selectiveLogic: 0,
        order: 100,
        position: 0,
      },
    ];

    store.selectSystemCoreEntry(408);
    expect(store.selectedSystemCoreEntryUid).toBe(408);

    store.toggleCharacterEntry(313);
    expect(store.enabledCharacterEntryUids.has(313)).toBe(true);

    store.toggleCharacterEntry(313);
    expect(store.enabledCharacterEntryUids.has(313)).toBe(false);

    store.toggleCharacterEntry(313);
    const ids = store.buildEnabledWorldBookEntries();
    expect(ids).toContain('system_core:408');
    expect(ids).toContain('character:313');
  });
});
```

**注意:** 测试需要 store 的属性是可写的。如果 `systemCoreEntries` 是 `ref`，需要确认测试可以直接赋值。如果 Pinia store 不允许直接赋值（因为是 computed 或 readonly），需要调整：改为 `(store as any).systemCoreEntries = [...]` 或者通过 store 的内部方法设置。

- [ ] **Step 3: 全量测试**

```bash
npm run test -- --run
```

Expected: 所有测试 PASS。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(create): 世界书条目管理测试 + 全局回归"
```
