# Plan 3: GamePipeline + GamePage — 前端↔引擎桥接层

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `GamePipeline` 桥接层，将 GamePage 的 UI 和 AgentOrchestrator 引擎连接起来。GamePage 的 `handleSend()` 从 mock `setTimeout` 切换到真实的 AI 管线调用。首次加载存档时自动发送开场 Prompt。

**Architecture:** `GamePipeline` 是一个类，封装了：从 settings-store 组装 AgentConfig/ApiEndpoint、从 game-store 构建 AgentContext、创建 AgentOrchestrator、统一处理所有回调（消息渲染/状态变更/持久化/Marker 处理）。GamePage 只调用 `pipeline.run(userInput)` 和 `pipeline.sendOpeningPrompt()`，不直接触碰引擎层。

**Tech Stack:** TypeScript, Vue 3 + Pinia, AgentOrchestrator engine

## Global Constraints

- `types.ts` 是唯一类型来源
- 消息只存原始文本，前端按需 beautify
- 测试优先
- `npm test` 必须全部通过
- plot 三件套通过 `plotSettings.mode='off'` 在 orchestrator 构造函数内自动禁用
- combat_trigger 回调返回 null 跳过

---

### Task 1: game-store — 新增持久化 + 开场标记 + 选项管理

**Files:**
- Modify: `src/ui/stores/game-store.ts`

**Interfaces:**
- Consumes: `saveMessage`, `getMessages`, `deleteMessagesBySaveId` from `@engine/database`
- Consumes: `ChatMessage` from `@engine/types`
- Produces: `persistMessage(msg: ChatMessage): Promise<void>` — 单条消息写 DB
- Produces: `restoreMessages(): Promise<void>` — 从 DB 恢复消息到内存
- Produces: `hasOpeningPromptConsumed: ComputedRef<boolean>` — 开场是否已发送
- Produces: `markOpeningPromptConsumed(): void` — 标记开场已发送
- Produces: `pendingOptions: Ref<string[]>` — vars_update 提取的选项列表

- [ ] **Step 1: 导入 DB 函数并添加持久化**

在 import 区添加：

```typescript
import { saveMessage, getMessages } from '@engine/database'
```

在 store 内部添加持久化函数：

```typescript
/** 持久化单条消息到 IndexedDB */
async function persistMessage(msg: ChatMessage) {
  try {
    await saveMessage({ ...msg, saveId: activeSaveId.value! })
  } catch (err) {
    console.error('[game-store] 消息持久化失败:', err)
  }
}

/** 从 IndexedDB 恢复消息到内存 */
async function restoreMessages() {
  if (!activeSaveId.value) return
  try {
    const msgs = await getMessages(activeSaveId.value)
    if (msgs.length > 0) {
      messages.value = msgs
    }
  } catch (err) {
    console.error('[game-store] 恢复消息失败:', err)
  }
}
```

- [ ] **Step 2: 修改 addMessage — 持久化 + turn 编号**

找到 `addMessage` 函数（约 114 行），修改为：

```typescript
let turnCounter = 0

function addMessage(content: string, role: 'user' | 'assistant'): void {
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
    saveId: activeSaveId.value ?? undefined,
    turn: role === 'user' ? ++turnCounter : turnCounter,
  }
  messages.value.push(msg)
  // 异步持久化（不阻塞 UI）
  persistMessage(msg)
}
```

同样修改 `addSystemMessage`：

```typescript
function addSystemMessage(systemEvent: import('@engine/types').SystemEvent): void {
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'system',
    content: systemEvent.narrative,
    timestamp: Date.now(),
    saveId: activeSaveId.value ?? undefined,
    turn: turnCounter,
    systemEvent,
  }
  messages.value.push(msg)
  persistMessage(msg)
}
```

- [ ] **Step 3: 修改 loadSave — 恢复消息**

在 `loadSave` 函数末尾（约 162 行），在加载 characters 等数据之后，添加：

```typescript
// 从 messages 表恢复对话历史
await restoreMessages()

// 恢复 turnCounter（取最后一条 user/assistant 消息的 turn）
const lastMsg = messages.value.filter(m => m.role === 'user' || m.role === 'assistant').pop()
turnCounter = lastMsg?.turn ?? 0
```

- [ ] **Step 4: 添加开场 Prompt 管理**

```typescript
/** 是否已消费开场 Prompt（未消费 → 需要自动发送） */
const hasOpeningPromptConsumed = computed(() => {
  return activeSave.value?.metadata?.openingPromptConsumed === true || messages.value.length > 0
})

/** 获取开场 Prompt 文本 */
const openingPrompt = computed(() => {
  return activeSave.value?.metadata?.openingPrompt ?? null
})

/** 标记开场 Prompt 已消费 */
async function markOpeningPromptConsumed() {
  if (!activeSave.value) return
  activeSave.value.metadata.openingPromptConsumed = true
  try {
    const { saveSaveSlot } = await import('@engine/database')
    await saveSaveSlot(activeSave.value)
  } catch (err) {
    console.error('[game-store] 标记开场 Prompt 失败:', err)
  }
}
```

- [ ] **Step 5: 添加选项管理**

```typescript
/** vars_update 解析出的行动选项 */
const pendingOptions = ref<string[]>([])

/** 设置行动选项（供 GamePipeline 回调使用） */
function setPendingOptions(options: string[]) {
  pendingOptions.value = options
}
```

- [ ] **Step 6: 导出新增项**

在 return 对象中添加：

```typescript
persistMessage, restoreMessages,
hasOpeningPromptConsumed, openingPrompt, markOpeningPromptConsumed,
pendingOptions, setPendingOptions,
```

- [ ] **Step 7: 编译验证**

```bash
npm run typecheck
```

Expected: 无新增类型错误。

- [ ] **Step 8: Commit**

```bash
git add src/ui/stores/game-store.ts
git commit -m "feat(game): game-store — 消息持久化 + 开场 Prompt 管理 + 选项管理"
```

---

### Task 2: 新增 game-pipeline.ts — 前端↔引擎桥接层

**Files:**
- Create: `src/ui/lib/game-pipeline.ts`

**Interfaces:**
- Consumes: `AgentOrchestrator, OrchestratorOptions, OrchestratorEvents` from `@engine/agent-orchestrator`
- Consumes: `DEFAULT_AGENT_PIPELINE, AgentContext, AgentConfig, ApiEndpoint, ChatMessage` from `@engine/types`
- Consumes: `createStateManager, commitChatState` from `@engine/state-manager`
- Consumes: `useGameStore`, `useSettingsStore`
- Consumes (lazy): `runCraftGenChain` from `@engine/craft-gen-chain`, `runCharGenChain` from `@engine/char-gen-agent`
- Produces: `class GamePipeline` with `run(userInput)` and `sendOpeningPrompt()`

- [ ] **Step 1: 创建 GamePipeline 类骨架**

```typescript
/**
 * GamePipeline — 前端 ↔ AgentOrchestrator 桥接层
 *
 * Phase 10h: 连接 GamePage UI 和引擎 Agent 管线。
 * 封装: AgentConfig 组装 / AgentContext 构建 / 编排器创建 / 回调处理。
 */
import { AgentOrchestrator } from '@engine/agent-orchestrator'
import type {
  OrchestratorOptions,
  OrchestratorEvents,
} from '@engine/agent-orchestrator'
import {
  DEFAULT_AGENT_PIPELINE,
} from '@engine/types'
import type {
  AgentContext,
  AgentConfig,
  ApiEndpoint,
  ChatMessage,
  AgentResult,
  CraftGenRequestMarker,
  CharGenRequestMarker,
  ItemGenRequestMarker,
  CombatTriggerMarker,
} from '@engine/types'
import type { useGameStore } from '../stores/game-store'
import type { useSettingsStore } from '../stores/settings-store'

export interface GamePipelineDeps {
  gameStore: ReturnType<typeof useGameStore>
  settingsStore: ReturnType<typeof useSettingsStore>
  saveId: string
}

export class GamePipeline {
  private game: ReturnType<typeof useGameStore>
  private settings: ReturnType<typeof useSettingsStore>
  private saveId: string
  private orch: AgentOrchestrator | null = null

  constructor(deps: GamePipelineDeps) {
    this.game = deps.gameStore
    this.settings = deps.settingsStore
    this.saveId = deps.saveId
  }

  /** 发送开场 Prompt（首次加载存档时调用） */
  async sendOpeningPrompt(): Promise<void> {
    const prompt = this.game.openingPrompt
    if (!prompt) return
    await this.run(prompt)
    await this.game.markOpeningPromptConsumed()
  }

  /** 核心: 将用户输入送入 Agent 管线 */
  async run(userInput: string): Promise<void> {
    this.game.isGenerating = true

    try {
      // 1. 添加用户消息
      this.game.addMessage(userInput, 'user')

      // 2. 构建配置
      const agentConfigs = this.buildAgentConfigs()
      const endpoints = this.buildEndpoints()
      const context = this.buildContext(userInput)

      // 3. 创建编排器
      const options: OrchestratorOptions = {
        pipeline: DEFAULT_AGENT_PIPELINE,
        context,
        agentConfigs,
        endpoints,
        saveId: this.saveId,
      }
      const events = this.buildEventHandlers()
      this.orch = new AgentOrchestrator(options, events)

      // 4. 运行管线
      await this.orch.run()
    } catch (err) {
      console.error('[GamePipeline] 管线运行失败:', err)
      this.game.addMessage('[系统] AI 调用失败，请检查 API 配置后重试。', 'assistant')
    } finally {
      this.game.isGenerating = false
    }
  }
```

- [ ] **Step 2: 实现 buildAgentConfigs()**

从 settings-store 的分散 KV 记录组装为 AgentConfig[]：

```typescript
  private buildAgentConfigs(): AgentConfig[] {
    const s = this.settings.settings

    // 需要参与管线的所有 Agent
    const agentIds = [
      'memory_recall',
      'story',
      'request_dispatcher',
      'vars_update',
      'memory_summary',
    ]

    // 获取第一个 API endpoint（单 API 模式）
    const apiPool = (s.apiPool ?? []) as ApiEndpoint[]
    const defaultEndpointId = apiPool[0]?.id ?? ''

    return agentIds.map(agentId => ({
      agentId,
      enabled: true,
      apiEndpointId: (s.agentModels?.[agentId])
        ? defaultEndpointId  // 如果配置了 model 就用默认 endpoint
        : defaultEndpointId,
      model: s.agentModels?.[agentId] ?? '',
      temperature: s.agentTemperature?.[agentId] ?? 0.7,
      maxTokens: s.agentMaxTokens?.[agentId] ?? 16384,
      topP: s.agentTopP?.[agentId] ?? 1.0,
      frequencyPenalty: s.agentFreqPen?.[agentId] ?? 0,
      presencePenalty: s.agentPresPen?.[agentId] ?? 0,
      retryOnFail: true,
      timeout: 120000,
      userId: `fp|${this.saveId}|${agentId}`,
      promptTemplate: {
        fixedSystem: s.agentPrompts?.[agentId] ?? '',
        fixedExamples: '',
      },
      worldBookIds: (s.agentWorldbookEnabled?.[agentId])
        ? (s.agentWorldbookIds?.[agentId] ?? [])
        : [],
      systemPrompt: s.agentPrompts?.[agentId],
      template: s.agentTemplates?.[agentId],
      toolsEnabled: ['craft_gen', 'char_gen', 'item_gen'].includes(agentId),
    } as AgentConfig))
  }
```

- [ ] **Step 3: 实现 buildEndpoints()**

```typescript
  private buildEndpoints(): ApiEndpoint[] {
    const s = this.settings.settings
    return (s.apiPool ?? []) as ApiEndpoint[]
  }
```

- [ ] **Step 4: 实现 buildContext()**

```typescript
  private buildContext(userInput: string): AgentContext {
    // 构建历史消息（只取 user/assistant，不含 system）
    const history: ChatMessage[] = this.game.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ ...m }))

    return {
      userInput,
      history,
      lorebookMatches: [],
      worldBooks: [],
      characters: this.game.characters,
      variables: this.game.latestVariables ?? {},
      plotEvents: this.game.activePlotEvents,
      memories: this.game.recentMemories,
      quests: this.game.saveProfile?.quests,
      agentOutputs: new Map(),
      plotSettings: { mode: 'off' },  // 禁用所有剧情 Agent
    }
  }
```

- [ ] **Step 5: 实现 buildEventHandlers()**

```typescript
  private buildEventHandlers(): OrchestratorEvents {
    return {
      // === Stage 回调 ===
      onAgentStart: (agentId) => {
        console.log(`[GamePipeline] Agent 开始: ${agentId}`)
      },
      onAgentComplete: (result) => {
        this.handleAgentResult(result)
      },
      onAgentError: (agentId, error) => {
        console.error(`[GamePipeline] Agent 错误: ${agentId}`, error)
      },

      // === Marker 回调 ===
      onCombatTrigger: async () => null,  // 跳过战斗
      onCraftGenRequest: async (markers, varsOutput, ctx) => {
        await this.handleCraftGen(markers, ctx)
      },
      onCharGenRequest: async (markers, varsOutput, ctx) => {
        await this.handleCharGen(markers, ctx)
      },
      onItemGenRequest: async (markers, varsOutput, ctx) => {
        // item_gen 独立请求 — 目前先记录日志
        console.log('[GamePipeline] item_gen_request:', markers.length, '个')
      },
    }
  }

  /** 处理单个 Agent 完成 */
  private handleAgentResult(result: AgentResult) {
    switch (result.agentId) {
      case 'story': {
        if (result.output?.content && typeof result.output.content === 'string') {
          this.game.addMessage(result.output.content, 'assistant')
        } else if (result.rawResponse) {
          // 兜底: rawResponse 作为正文（可能包含系统标签，前端会美化过滤）
          this.game.addMessage(result.rawResponse, 'assistant')
        }
        break
      }
      case 'vars_update': {
        // 提取选项（从 output.options 或 <options> XML 标签）
        if (result.output?.options && Array.isArray(result.output.options)) {
          this.game.setPendingOptions(result.output.options)
        }
        break
      }
    }
  }

  /** 处理制作生成链 */
  private async handleCraftGen(
    markers: CraftGenRequestMarker[],
    ctx: AgentContext,
  ) {
    try {
      const { runCraftGenChain } = await import('@engine/craft-gen-chain')
      for (const marker of markers) {
        const result = await runCraftGenChain(
          { marker, agentContext: ctx },
          {
            clientFactory: null as any,  // 使用内置 AgentClient
            stateManager: null as any,   // 先不持久化，等 vars_update 统一处理
          },
        )
        if (result.narrativeSummary) {
          this.game.addSystemMessage({
            type: 'craft',
            narrative: result.narrativeSummary,
            patches: result.patches,
          })
        }
      }
    } catch (err) {
      console.error('[GamePipeline] craft_gen 链失败:', err)
    }
  }

  /** 处理角色生成链 */
  private async handleCharGen(
    markers: CharGenRequestMarker[],
    ctx: AgentContext,
  ) {
    try {
      const { runCharGenChain } = await import('@engine/char-gen-agent')
      const { createStateManager } = await import('@engine/state-manager')
      const sm = createStateManager(this.saveId)

      for (const marker of markers) {
        const charGenRequest = {
          marker,
          agentContext: ctx,
          userInput: ctx.userInput,
        } as any  // CharGenRequest 类型
        const result = await runCharGenChain(charGenRequest, {
          clientFactory: null as any,
          stateManager: sm,
        })
        if (result.character) {
          // 添加新角色到 store
          this.game.characters.push(result.character)
          // 添加系统消息
          this.game.addSystemMessage({
            type: 'char_gen',
            narrative: result.narrativeSummary,
            patches: result.patches,
          })
        }
      }
    } catch (err) {
      console.error('[GamePipeline] char_gen 链失败:', err)
    }
  }
}
```

- [ ] **Step 7: 编译验证**

```bash
npm run typecheck
```

Expected: 无类型错误。如有类型不匹配，修正后再编译。

- [ ] **Step 8: Commit**

```bash
git add src/ui/lib/game-pipeline.ts
git commit -m "feat(game): 新增 GamePipeline — 前端↔引擎桥接层"
```

---

### Task 3: GamePage.vue — 接入 GamePipeline

**Files:**
- Modify: `src/ui/components/game/GamePage.vue`

**Interfaces:**
- Consumes: `GamePipeline` from `../../lib/game-pipeline`
- Consumes: `game.hasOpeningPromptConsumed`, `game.openingPrompt`

- [ ] **Step 1: 重写 handleSend() 和开场 Prompt 逻辑**

修改 `GamePage.vue` 的 `<script setup>`：

```typescript
import { GamePipeline } from '../../lib/game-pipeline'

// ... 现有 import ...

let pipeline: GamePipeline | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  if (ui.activeSaveId) {
    await game.loadSave(ui.activeSaveId)
    // 创建 pipeline 实例
    pipeline = new GamePipeline({
      gameStore: game,
      settingsStore: settings,
      saveId: ui.activeSaveId,
    })
    // 首次加载 → 自动发送开场 Prompt
    if (!game.hasOpeningPromptConsumed && game.openingPrompt) {
      await pipeline.sendOpeningPrompt()
    }
  }
})

// 移除旧的 mock
// let mockTimer: ReturnType<typeof setTimeout> | null = null  ← 删除

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  // 删除 mockTimer 清理
  game.isGenerating = false
})

async function handleSend(content: string) {
  if (game.isGenerating || !pipeline) return
  await pipeline.run(content)
}

// ===== 测试注入保留 =====
// Ctrl+Shift+T 快捷键注入（保留原逻辑不变）
function injectChatFlowTest() { /* ... 不变 ... */ }
if (typeof window !== 'undefined') {
  ;(window as any).__injectChatFlowTest__ = injectChatFlowTest
}
```

- [ ] **Step 2: 添加调试面板逻辑**

```typescript
// ===== 调试面板 (Alt+Shift+D) =====
const showDebug = ref(false)

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.altKey && e.shiftKey && e.key === 'D') {
    e.preventDefault()
    showDebug.value = !showDebug.value
  }
})
```

在 `<template>` 末尾（`</div>` 之前）添加调试面板：

```html
<Teleport to="body">
  <div v-if="showDebug" class="debug-panel">
    <div class="debug-header">
      <span>🔧 Debug Panel</span>
      <button @click="showDebug = false">✕</button>
    </div>
    <div class="debug-section">
      <h4>Messages ({{ game.messages.length }})</h4>
      <pre>{{ JSON.stringify(game.messages.slice(-5), null, 2) }}</pre>
    </div>
    <div class="debug-section">
      <h4>Save Profile</h4>
      <pre>{{ JSON.stringify(game.saveProfile, null, 2) }}</pre>
    </div>
    <div class="debug-section">
      <h4>Characters ({{ game.characters.length }})</h4>
      <pre>{{ JSON.stringify(game.characters.map(c => ({ id: c.id, name: c.name, type: c.type })), null, 2) }}</pre>
    </div>
    <div class="debug-section">
      <h4>Pending Options</h4>
      <pre>{{ JSON.stringify(game.pendingOptions, null, 2) }}</pre>
    </div>
  </div>
</Teleport>
```

调试面板样式：

```css
.debug-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 420px;
  max-width: 90vw;
  height: 100vh;
  background: #1a1a2e;
  color: #e0e0e0;
  border-left: 2px solid #ffd700;
  z-index: 9999;
  overflow-y: auto;
  padding: 16px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.75rem;
}
.debug-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #333;
}
.debug-header span {
  font-size: 0.875rem;
  font-weight: 600;
  color: #ffd700;
}
.debug-header button {
  background: none;
  border: 1px solid #555;
  color: #aaa;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.debug-section {
  margin-bottom: 16px;
}
.debug-section h4 {
  font-size: 0.75rem;
  color: #8ab4f8;
  margin: 0 0 4px;
}
.debug-section pre {
  background: #0d0d1a;
  padding: 8px;
  border-radius: 4px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
```

- [ ] **Step 3: 编译验证**

```bash
npm run typecheck
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/game/GamePage.vue
git commit -m "feat(game): GamePage — 接入 GamePipeline + 开场 Prompt + 调试面板"
```

---

### Task 4: InputBar.vue — 动态选项替代硬编码

**Files:**
- Modify: `src/ui/components/game/InputBar.vue`

**Interfaces:**
- Consumes: `game.pendingOptions` (Ref<string[]>)

- [ ] **Step 1: 替换 mockOptions 为动态选项**

删除硬编码的 `mockOptions`（约 15 行），改为 computed：

```typescript
// 删除:
// const mockOptions = [
//   '向酒馆老板打听商队失踪的消息',
//   '前往近郊森林搜寻线索',
//   '先去冒险者公会了解情况',
// ]

// 改为:
const dynamicOptions = computed(() => game.pendingOptions)
```

在 template 中将 `mockOptions` 替换为 `dynamicOptions`：

```html
<button
  v-for="(opt, i) in dynamicOptions"
  :key="i"
  class="option-item"
  role="option"
  @click="selectOption(opt)"
>
  {{ opt }}
</button>
```

- [ ] **Step 2: 当无选项时隐藏选项按钮**

```html
<button
  v-if="dynamicOptions.length > 0"
  class="input-btn"
  @click="showOptions = !showOptions"
  title="可选行动"
  :aria-expanded="showOptions"
  aria-haspopup="listbox"
>
  <i class="fa-solid fa-list-ul" />
</button>
```

- [ ] **Step 3: 编译验证**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/game/InputBar.vue
git commit -m "feat(game): InputBar — 动态选项替代硬编码 mockOptions"
```

---

### Task 5: 全局测试回归

- [ ] **Step 1: 全量测试**

```bash
npm run test -- --run
```

Expected: 所有现有测试 PASS。

- [ ] **Step 2: Commit（如有修改）**

```bash
git add -A
git commit -m "chore: Plan 3 全局测试回归"
```
