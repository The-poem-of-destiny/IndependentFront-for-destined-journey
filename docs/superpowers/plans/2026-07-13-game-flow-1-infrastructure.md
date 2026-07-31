# Plan 1: 基础设施 — DB v8 + Messages 表 + SaveSlot 扩展

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 IndexedDB 中新增 `messages` 表（每存档隔离），扩展 `SaveSlot.metadata` 和 `Snapshot` 接口，为后续 GamePipeline 的消息持久化和创角改造提供数据层支撑。

**Architecture:** DB 升级到 v8，新增 messages 表保存 `ChatMessage`（只存原始文本，加载时按需 beautify）。SaveSlot.metadata 新增 `enabledWorldBookEntries`（创角选的世界书条目 ID）、`openingPrompt`（开场提示词）、`openingPromptConsumed`（是否已发送）。Snapshot 新增 `messageIds` 预留未来快照接口。

**Tech Stack:** Dexie.js (IndexedDB wrapper), Vitest + fake-indexeddb

## Global Constraints

- 测试优先：每个 CRUD 函数先写测试再实现
- 类型统一：`types.ts` 是唯一类型来源
- `npm test` 必须全部通过

---

### Task 1: 扩展 types.ts — ChatMessage + SaveSlot.metadata + Snapshot 预留

**Files:**

- Modify: `src/sillytavern/types.ts:471-487` (ChatMessage)
- Modify: `src/sillytavern/types.ts:976-994` (SaveSlot)
- Modify: `src/sillytavern/types.ts:955-973` (Snapshot)

**Interfaces:**

- Produces: `ChatMessage.saveId?: string` — 消息所属存档 ID（持久化时设置）
- Produces: `ChatMessage.turn?: number` — 消息轮次编号（持久化时设置）
- Produces: `SaveSlot.metadata.enabledWorldBookEntries?: string[]`
- Produces: `SaveSlot.metadata.openingPrompt?: string`
- Produces: `SaveSlot.metadata.openingPromptConsumed?: boolean`
- Produces: `Snapshot.messageIds?: string[]`

- [ ] **Step 1: ChatMessage 扩展 saveId 和 turn**

在 `src/sillytavern/types.ts` 找到 `ChatMessage` 接口（约 471 行），添加两个可选字段：

```typescript
export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** 🆕 Phase 10h: 消息所属存档 ID（持久化到 messages 表时设置） */
  saveId?: string;
  /** 🆕 Phase 10h: 消息轮次编号（持久化到 messages 表时设置） */
  turn?: number;
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

- [ ] **Step 2: 扩展 SaveSlot.metadata 类型**

在 `src/sillytavern/types.ts` 找到 `SaveSlot` 接口（约 976 行），修改 `metadata` 字段：

```typescript
export interface SaveSlot {
  id: string;
  name: string;
  slot: number; // 0-9
  createdAt: number;
  updatedAt: number;
  activeSnapshotId: string | null;
  snapshots: Snapshot[];
  metadata: {
    characterName: string;
    userName: string;
    gameStartTime: string;
    totalTurns: number;
    description?: string;
    /** Phase 10h: 存档级启用的世界书条目 ID (如 'system_core:408', 'character:313') */
    enabledWorldBookEntries?: string[];
    /** Phase 10h: 创角时的开场提示词文本 */
    openingPrompt?: string;
    /** Phase 10h: 开场 Prompt 是否已发送给 AI */
    openingPromptConsumed?: boolean;
  };
}
```

- [ ] **Step 2: 扩展 Snapshot 接口预留 messageIds**

```typescript
export interface Snapshot {
  id: string;
  saveId: string;
  index: number;
  timestamp: number;
  gameTime: string;
  variables: Record<string, any>;
  characters: CharacterState[];
  plotEvents: PlotEvent[];
  memoryIds: string[];
  turnNumber: number;
  label?: string;
  /** Phase 10h: 快照时关联的消息 ID 列表（预留，后继实现） */
  messageIds?: string[];
}
```

- [ ] **Step 3: 类型编译验证**

```bash
npx tsc --noEmit src/sillytavern/types.ts
```

Expected: 无新增编译错误。

- [ ] **Step 4: Commit**

```bash
git add src/sillytavern/types.ts
git commit -m "feat(types): 扩展 SaveSlot.metadata 和 Snapshot — openedWorldBookEntries + openingPrompt + messageIds 预留"
```

---

### Task 2: 类型测试 — SaveSlot metadata 扩展

**Files:**

- Modify: `src/sillytavern/types.test.ts`

**Interfaces:**

- Consumes: SaveSlot.metadata 新字段

- [ ] **Step 1: 添加 SaveSlot metadata 测试**

在 `types.test.ts` 中找到或创建一个描述块，添加测试：

```typescript
describe('SaveSlot metadata (Phase 10h)', () => {
  it('metadata.enabledWorldBookEntries 应为可选字符串数组', () => {
    const slot: SaveSlot = {
      id: 's1',
      name: 'test',
      slot: 0,
      createdAt: 0,
      updatedAt: 0,
      activeSnapshotId: null,
      snapshots: [],
      metadata: {
        characterName: 'test',
        userName: 'player',
        gameStartTime: '2026-01-01',
        totalTurns: 0,
        enabledWorldBookEntries: ['system_core:408', 'character:313'],
      },
    };
    expect(slot.metadata.enabledWorldBookEntries).toHaveLength(2);
    expect(slot.metadata.enabledWorldBookEntries![0]).toBe('system_core:408');
  });

  it('metadata.openingPrompt 和 openingPromptConsumed 应为可选项', () => {
    const slot: SaveSlot = {
      id: 's2',
      name: 'test',
      slot: 1,
      createdAt: 0,
      updatedAt: 0,
      activeSnapshotId: null,
      snapshots: [],
      metadata: {
        characterName: 'test',
        userName: 'player',
        gameStartTime: '2026-01-01',
        totalTurns: 0,
        openingPrompt: '你是冒险者...',
        openingPromptConsumed: false,
      },
    };
    expect(slot.metadata.openingPrompt).toBe('你是冒险者...');
    expect(slot.metadata.openingPromptConsumed).toBe(false);
  });
});

describe('Snapshot messageIds 预留 (Phase 10h)', () => {
  it('Snapshot 应有可选的 messageIds 字段', () => {
    const snap: Snapshot = {
      id: 'snap1',
      saveId: 's1',
      index: 0,
      timestamp: Date.now(),
      gameTime: '春-1日',
      variables: {},
      characters: [],
      plotEvents: [],
      memoryIds: [],
      turnNumber: 0,
      messageIds: ['msg1', 'msg2'],
    };
    expect(snap.messageIds).toHaveLength(2);
  });
});
```

**注意:** 测试文件顶部需已有 `import type { SaveSlot, Snapshot } from './types'`。如果没有，补上。

- [ ] **Step 2: 运行测试验证**

```bash
npx vitest run src/sillytavern/types.test.ts
```

Expected: 所有测试 PASS。

- [ ] **Step 3: Commit**

```bash
git add src/sillytavern/types.test.ts
git commit -m "test(types): SaveSlot metadata 扩展 + Snapshot messageIds 测试"
```

---

### Task 3: DB v8 升级 — 新增 messages 表

**Files:**

- Modify: `src/sillytavern/database.ts` (AppDatabase class + FullBackup + importAllData + clearAllData)
- Modify: `src/sillytavern/database.ts` (新增 CRUD 函数)

**Interfaces:**

- Produces: `messages` 表 (key: `id`, indexes: `saveId`, `[saveId+turn]`)
- Produces: `saveMessage(msg)`, `getMessages(saveId)`, `deleteMessagesBySaveId(saveId)`

- [ ] **Step 1: 升级 DB 到 v8，新增 messages 表**

在 `database.ts` 的 `AppDatabase` 类中添加表声明（在 `createPresets` 之后）：

```typescript
// v8 new table (Phase 10h)
messages!: Table<import('./types').ChatMessage>;
```

修改 `DB_VERSION` 为 8：

```typescript
const DB_VERSION = 8;
```

在构造函数末尾（v7 之后）添加 v8 升级逻辑：

```typescript
// v8: Phase 10h — 消息持久化表
this.version(8).stores({
  lorebooks: 'id, name, updatedAt',
  presets: 'id, name, updatedAt',
  settings: 'key',
  chats: 'id, name, updatedAt',
  memories: 'id, saveId, createdAt, realTimestamp',
  plotEvents: 'id, saveId, parentId, status, updatedAt',
  characters: 'id, type',
  snapshots: 'id, saveId, index, timestamp',
  saves: 'id, slot, updatedAt',
  apiEndpoints: 'id, name',
  plotOutlines: 'id, saveId, updatedAt',
  saveProfiles: 'saveId, updatedAt',
  createPresets: 'id, name, updatedAt',
  messages: 'id, saveId, [saveId+turn]',
});
```

类型声明加到 `AppDatabase` 类里：`messages` 用 `Table<ChatMessage>`。注意 `ChatMessage` 需从 `./types` 导入，检查顶部 import 是否已有。若没有，补充：

```typescript
import type {
  Lorebook,
  ChatPreset,
  AppSettings,
  ChatSession,
  MemoryRecord,
  PlotEvent,
  CharacterState,
  Snapshot,
  SaveSlot,
  ApiEndpoint,
  PlotOutline,
  SaveProfile,
  ChatMessage,
} from './types';
```

- [ ] **Step 2: 更新 FullBackup 接口**

在 `FullBackup` 接口末尾添加：

```typescript
// v8 Phase 10h
messages: ChatMessage[];
```

**注意:** `ChatMessage` 在 types.ts 中已 export，FullBackup 中直接引用。

- [ ] **Step 3: 更新 `exportAllData`**

在解构数组中添加 messages：

```typescript
const [
  lorebooks,
  presets,
  settings,
  chats,
  memories,
  plotEvents,
  characters,
  snapshots,
  saves,
  apiEndpoints,
  plotOutlines,
  saveProfiles,
  createPresets,
  messages,
] = await Promise.all([
  db.lorebooks.toArray(),
  db.presets.toArray(),
  db.settings.toArray(),
  db.chats.toArray(),
  db.memories.toArray(),
  db.plotEvents.toArray(),
  db.characters.toArray(),
  db.snapshots.toArray(),
  db.saves.toArray(),
  db.apiEndpoints.toArray(),
  db.plotOutlines.toArray(),
  db.saveProfiles.toArray(),
  db.createPresets.toArray(),
  db.messages.toArray(),
]);
```

在返回对象中添加：

```typescript
return {
  version: DB_VERSION,
  exportedAt: Date.now(),
  lorebooks,
  presets,
  settings,
  chats,
  memories,
  plotEvents,
  characters,
  snapshots,
  saves,
  apiEndpoints,
  plotOutlines,
  saveProfiles,
  createPresets,
  messages,
};
```

- [ ] **Step 4: 更新 `importAllData`**

在末尾（`createPresets` 的 transaction 之后）添加：

```typescript
await db.transaction('rw', db.messages, async () => {
  await db.messages.clear();
  if (Array.isArray(backup.messages)) await db.messages.bulkPut(backup.messages);
});
```

- [ ] **Step 5: 更新 `deleteSaveSlot` 级联删除**

在 `deleteSaveSlot` 函数中（约 532 行），末尾 `await db.saves.delete(id)` 之前添加 messages 清理：

```typescript
const messagesToDelete = await db.messages.where('saveId').equals(id).toArray();
await db.messages.bulkDelete(messagesToDelete.map((m) => m.id));
```

- [ ] **Step 6: 添加 Messages CRUD 函数**

在文件末尾（`createPresets` CRUD 之后）添加：

```typescript
// ═══════════════════════════════════════════════════════════
// Phase 10h — 消息持久化 CRUD
// ═══════════════════════════════════════════════════════════

/** 保存单条消息 */
export async function saveMessage(message: ChatMessage): Promise<string> {
  await getDatabase().messages.put(message);
  return message.id;
}

/** 批量保存消息 */
export async function saveMessages(messages: ChatMessage[]): Promise<void> {
  await getDatabase().messages.bulkPut(messages);
}

/** 按存档 ID 获取全部消息，按时间戳升序排列 */
export async function getMessages(saveId: string): Promise<ChatMessage[]> {
  return getDatabase().messages.where('saveId').equals(saveId).sortBy('timestamp');
}

/** 按存档 ID 删除所有消息 */
export async function deleteMessagesBySaveId(saveId: string): Promise<void> {
  await getDatabase().messages.where('saveId').equals(saveId).delete();
}
```

- [ ] **Step 7: 编译验证**

```bash
npm run typecheck
```

Expected: 无类型错误。

- [ ] **Step 8: Commit**

```bash
git add src/sillytavern/database.ts
git commit -m "feat(db): DB v8 — 新增 messages 表 + CRUD 函数 + 级联删除 + 备份
- 新增 messages 表 (id, saveId, [saveId+turn])
- saveMessage / saveMessages / getMessages / deleteMessagesBySaveId
- deleteSaveSlot 级联删除 messages
- FullBackup / exportAllData / importAllData 包含 messages"
```

---

### Task 4: Messages CRUD 测试

**Files:**

- Modify: `src/sillytavern/database.test.ts`

**Interfaces:**

- Consumes: `saveMessage`, `getMessages`, `deleteMessagesBySaveId`

- [ ] **Step 1: 添加 Messages CRUD 测试**

在 `database.test.ts` 中添加测试块。先检查测试文件结构，在合适位置插入：

```typescript
import type { ChatMessage } from './types';
import { saveMessage, saveMessages, getMessages, deleteMessagesBySaveId } from './database';

describe('Messages CRUD (Phase 10h)', () => {
  const SAVE_ID = 'msg-test-save';

  function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '测试消息',
      timestamp: Date.now(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    await deleteMessagesBySaveId(SAVE_ID);
  });

  it('saveMessage: 写入单条消息并可读取', async () => {
    const msg = makeMsg({ content: 'AI 回复正文' });
    await saveMessage(msg);

    const msgs = await getMessages(SAVE_ID);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('AI 回复正文');
    expect(msgs[0].role).toBe('assistant');
  });

  it('saveMessages: 批量写入多条消息', async () => {
    const msgs = [
      makeMsg({ role: 'user', content: '你好' }),
      makeMsg({ role: 'assistant', content: '你好啊冒险者' }),
    ];
    await saveMessages(msgs);

    const loaded = await getMessages(SAVE_ID);
    expect(loaded).toHaveLength(2);
  });

  it('getMessages: 按 saveId 隔离，不同存档消息不混淆', async () => {
    const msg1 = makeMsg({ content: '存档A的消息' });
    const msg2 = makeMsg({ id: crypto.randomUUID(), content: '存档B的消息', role: 'assistant' });

    await saveMessage(msg1); // SAVE_ID
    // 直接写入另一 saveId
    const { getDatabase } = await import('./database');
    await getDatabase().messages.put(msg2); // 这里需要特殊处理

    const loaded = await getMessages(SAVE_ID);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe('存档A的消息');
  });

  it('deleteMessagesBySaveId: 清空指定存档全部消息', async () => {
    await saveMessage(makeMsg());
    await saveMessage(makeMsg({ id: crypto.randomUUID() }));
    expect((await getMessages(SAVE_ID)).length).toBe(2);

    await deleteMessagesBySaveId(SAVE_ID);
    expect((await getMessages(SAVE_ID)).length).toBe(0);
  });
});
```

**注意:** 查看 `database.test.ts` 顶部 import 和 beforeEach 模式，确保新测试遵循一致的 fake-indexeddb 初始化方式。通常 database.test.ts 会调用 `initializeDatabase()` 或类似 setup。

- [ ] **Step 2: 运行测试验证**

```bash
npx vitest run src/sillytavern/database.test.ts
```

Expected: 新增 4 个测试全部 PASS。

- [ ] **Step 3: Commit**

```bash
git add src/sillytavern/database.test.ts
git commit -m "test(db): Messages 表 CRUD 测试 — 单条/批量写入 + saveId 隔离 + 批量删除"
```

---

### Task 5: 全局测试回归

- [ ] **Step 1: 跑全量测试确保无回归**

```bash
npm run test -- --run
```

Expected: 所有现有测试 PASS，新增测试 PASS。

- [ ] **Step 2: Commit（如有修改）**

```bash
git add -A
git commit -m "chore: Plan 1 全局测试回归 — 全量 PASS"
```
