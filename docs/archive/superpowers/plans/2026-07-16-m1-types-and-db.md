# M1 类型与库层 实施计划（数据字段规范批次 1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地数据字段规范的类型与数据库层：枚举集中定义、CharacterState.saveId 一等化、Dexie v9（characters 索引 + chats 删表 + 级联删除）、char-query 隔离修复、死字段清理。

**Architecture:** 只做加法字段与库层改造 + 死代码删除，保持每个 task 后编译绿灯、测试全过。破坏性删除（物品/技能/状态效果 id 退役、EquipmentSlot 删除）**延后到 M2/M3**（与其消费者 StateManager/翻译层同批重写）；Snapshot 类型重定义**延后到 M5**（与快照打/恢复机制同批）——本计划 Task 10 会把此范围调整回写进规范附录 A。新升级的正式字段（appearance 等）采用**双写策略**（正式字段 + customFields 同时写），读方在 M6 才切换，保证行为零变化。

**Tech Stack:** TypeScript (tsc --noEmit) · Dexie/IndexedDB · Vitest + fake-indexeddb · Vue3/Pinia（仅少量 UI 死代码清理）

## Global Constraints

- 每个 task 完成后 `npm run typecheck` 必须 0 错误（项目规矩）。
- 每个 task 完成后 `npm run test -- --run` 不得新增失败。**已知既有失败 1 个**：`create-store.test.ts > 选中 system_core 世界书条目时应输出该条目内容（命定之灵）`，与本计划无关，忽略但不得增多。
- `src/sillytavern/types.ts` 是唯一类型来源；新枚举文件 `field-enums.ts` 只放枚举常量与归一化函数，不放接口。
- 开发期无真实玩家存档，Dexie v9 允许 breaking 迁移（upgrade 回填 saveId 即可，不需要兼容旧字段读路径）。
- 注释用中文，风格与所在文件一致。commit message 用中文，`feat:`/`refactor:`/`chore:` 前缀。
- 规范文档（唯一真源）: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`；52 项问题编号见 `docs/superpowers/specs/2026-07-16-entity-field-audit.md`。

---

### Task 1: field-enums.ts 枚举集中定义

**Files:**

- Create: `src/sillytavern/field-enums.ts`
- Test: `src/sillytavern/field-enums.test.ts`

**Interfaces:**

- Produces: `EQUIP_SLOTS/ITEM_TYPES/RARITY_LEVELS/QUEST_STATUSES/STATUS_CATEGORIES` 常量数组；`EquipSlot/ItemType/Rarity/QuestStatus/StatusCategory` 类型；`normalizeSlot(raw: string): EquipSlot | null`、`normalizeItemType(raw: string): ItemType | undefined`、`normalizeRarity(raw: string): Rarity | undefined`、`normalizeQuestStatus(raw: string): QuestStatus`、`normalizeStatusCategory(raw: string): StatusCategory`。M2 的 StateManager 归一化、M3 翻译层、M4 prompt 生成全部消费本模块。

- [ ] **Step 1: 写失败测试**

```ts
// src/sillytavern/field-enums.test.ts
/**
 * field-enums.ts — 中文枚举集中定义 + 归一化测试（数据字段规范 铁律5）
 */
import { describe, it, expect } from 'vitest';
import {
  EQUIP_SLOTS,
  ITEM_TYPES,
  RARITY_LEVELS,
  QUEST_STATUSES,
  STATUS_CATEGORIES,
  normalizeSlot,
  normalizeItemType,
  normalizeRarity,
  normalizeQuestStatus,
  normalizeStatusCategory,
} from './field-enums';

describe('枚举常量', () => {
  it('slot 枚举为规范定义的 8 个中文槽位', () => {
    expect(EQUIP_SLOTS).toEqual(['武器', '副手', '头部', '身体', '手部', '脚部', '腰带', '饰品']);
  });
  it('rarity 为 7 级品质', () => {
    expect(RARITY_LEVELS).toEqual(['普通', '优良', '稀有', '史诗', '传说', '神话', '唯一']);
  });
  it('quest status 为 4 态', () => {
    expect(QUEST_STATUSES).toEqual(['进行中', '已完成', '失败', '搁置']);
  });
  it('item type 为 5 类', () => {
    expect(ITEM_TYPES).toEqual(['装备', '消耗品', '材料', '任务物品', '特殊']);
  });
  it('status category 为 3 类', () => {
    expect(STATUS_CATEGORIES).toEqual(['增益', '减益', '特殊']);
  });
});

describe('normalizeSlot', () => {
  it('标准值直通', () => {
    expect(normalizeSlot('武器')).toBe('武器');
  });
  it('中文别名归一: 主手/惯用手→武器, 护甲/胸甲→身体, 鞋子/靴子→脚部', () => {
    expect(normalizeSlot('主手')).toBe('武器');
    expect(normalizeSlot('惯用手')).toBe('武器');
    expect(normalizeSlot('护甲')).toBe('身体');
    expect(normalizeSlot('鞋子')).toBe('脚部');
  });
  it('英文遗留归一: weapon→武器, armor→身体, accessory→饰品', () => {
    expect(normalizeSlot('weapon')).toBe('武器');
    expect(normalizeSlot('armor')).toBe('身体');
    expect(normalizeSlot('accessory')).toBe('饰品');
  });
  it('无法识别返回 null（调用方决定报错或兜底）', () => {
    expect(normalizeSlot('不存在的槽位')).toBeNull();
    expect(normalizeSlot('')).toBeNull();
  });
  it('两侧空白容忍', () => {
    expect(normalizeSlot(' 武器 ')).toBe('武器');
  });
});

describe('normalizeItemType', () => {
  it('标准值直通', () => {
    expect(normalizeItemType('消耗品')).toBe('消耗品');
  });
  it('英文遗留归一: equipment→装备, consumable→消耗品, material→材料, quest→任务物品', () => {
    expect(normalizeItemType('equipment')).toBe('装备');
    expect(normalizeItemType('consumable')).toBe('消耗品');
    expect(normalizeItemType('material')).toBe('材料');
    expect(normalizeItemType('quest')).toBe('任务物品');
  });
  it('weapon/armor 视为装备', () => {
    expect(normalizeItemType('weapon')).toBe('装备');
    expect(normalizeItemType('armor')).toBe('装备');
  });
  it('无法识别返回 undefined（type 可选字段）', () => {
    expect(normalizeItemType('奇怪类型')).toBeUndefined();
  });
});

describe('normalizeRarity', () => {
  it('标准值直通', () => {
    expect(normalizeRarity('史诗')).toBe('史诗');
  });
  it('英文归一: common→普通, rare→稀有, legendary→传说, unique→唯一', () => {
    expect(normalizeRarity('common')).toBe('普通');
    expect(normalizeRarity('rare')).toBe('稀有');
    expect(normalizeRarity('legendary')).toBe('传说');
    expect(normalizeRarity('unique')).toBe('唯一');
  });
  it('uncommon→优良, epic→史诗, mythic→神话', () => {
    expect(normalizeRarity('uncommon')).toBe('优良');
    expect(normalizeRarity('epic')).toBe('史诗');
    expect(normalizeRarity('mythic')).toBe('神话');
  });
  it('无法识别返回 undefined', () => {
    expect(normalizeRarity('五彩斑斓')).toBeUndefined();
  });
});

describe('normalizeQuestStatus', () => {
  it('标准值直通', () => {
    expect(normalizeQuestStatus('已完成')).toBe('已完成');
  });
  it('变体归一: 完成→已完成, 进行→进行中, 失败了→失败, 暂停/挂起→搁置', () => {
    expect(normalizeQuestStatus('完成')).toBe('已完成');
    expect(normalizeQuestStatus('进行')).toBe('进行中');
    expect(normalizeQuestStatus('失败了')).toBe('失败');
    expect(normalizeQuestStatus('暂停')).toBe('搁置');
    expect(normalizeQuestStatus('挂起')).toBe('搁置');
  });
  it('无法识别兜底为进行中（修 #32: 自由字符串导致误判活跃）', () => {
    expect(normalizeQuestStatus('莫名其妙')).toBe('进行中');
    expect(normalizeQuestStatus('')).toBe('进行中');
  });
});

describe('normalizeStatusCategory', () => {
  it('标准值直通', () => {
    expect(normalizeStatusCategory('减益')).toBe('减益');
  });
  it('英文归一: buff→增益, debuff→减益, special→特殊', () => {
    expect(normalizeStatusCategory('buff')).toBe('增益');
    expect(normalizeStatusCategory('debuff')).toBe('减益');
    expect(normalizeStatusCategory('special')).toBe('特殊');
  });
  it('无法识别兜底为特殊', () => {
    expect(normalizeStatusCategory('未知')).toBe('特殊');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run src/sillytavern/field-enums.test.ts`
Expected: FAIL — `Cannot find module './field-enums'`

- [ ] **Step 3: 实现 field-enums.ts**

```ts
// src/sillytavern/field-enums.ts
/**
 * 游戏数据枚举集中定义 + 归一化（数据字段规范 铁律5）
 *
 * 所有游戏实体的枚举取值一律中文、只在此处定义。
 * AI 提名的枚举值在写入前必须经过对应 normalize* 归一化。
 * 规范: docs/superpowers/specs/2026-07-16-data-field-conventions-design.md 第 3.2 节
 */

// ========== 枚举常量 ==========

/** 装备槽位（对齐世界书装备条目，一槽一件） */
export const EQUIP_SLOTS = [
  '武器',
  '副手',
  '头部',
  '身体',
  '手部',
  '脚部',
  '腰带',
  '饰品',
] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

/** 物品类型 */
export const ITEM_TYPES = ['装备', '消耗品', '材料', '任务物品', '特殊'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** 7 级品质（世界书 #417617 品质体系） */
export const RARITY_LEVELS = ['普通', '优良', '稀有', '史诗', '传说', '神话', '唯一'] as const;
export type Rarity = (typeof RARITY_LEVELS)[number];

/** 任务状态（修 #32: 自由字符串 → 4 态枚举） */
export const QUEST_STATUSES = ['进行中', '已完成', '失败', '搁置'] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];

/** 状态效果分类 */
export const STATUS_CATEGORIES = ['增益', '减益', '特殊'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

// ========== 归一化 ==========

/** slot 别名表（中文变体 + 英文遗留，修 #37 slot 中英双轨） */
const SLOT_ALIASES: Record<string, EquipSlot> = {
  主手: '武器',
  惯用手: '武器',
  副武器: '副手',
  护甲: '身体',
  胸甲: '身体',
  衣服: '身体',
  鞋子: '脚部',
  靴子: '脚部',
  手套: '手部',
  头盔: '头部',
  weapon: '武器',
  offhand: '副手',
  head: '头部',
  armor: '身体',
  hands: '手部',
  feet: '脚部',
  belt: '腰带',
  accessory: '饰品',
};

/** 归一化装备槽位。无法识别返回 null，调用方决定报错或兜底 */
export function normalizeSlot(raw: string): EquipSlot | null {
  const s = (raw ?? '').trim();
  if ((EQUIP_SLOTS as readonly string[]).includes(s)) return s as EquipSlot;
  return SLOT_ALIASES[s] ?? SLOT_ALIASES[s.toLowerCase()] ?? null;
}

/** item type 别名表（英文枚举遗留，修 #38 三套取值） */
const ITEM_TYPE_ALIASES: Record<string, ItemType> = {
  equipment: '装备',
  weapon: '装备',
  armor: '装备',
  consumable: '消耗品',
  material: '材料',
  quest: '任务物品',
  special: '特殊',
  道具: '特殊',
};

/** 归一化物品类型。无法识别返回 undefined（type 为可选字段） */
export function normalizeItemType(raw: string): ItemType | undefined {
  const s = (raw ?? '').trim();
  if ((ITEM_TYPES as readonly string[]).includes(s)) return s as ItemType;
  return ITEM_TYPE_ALIASES[s] ?? ITEM_TYPE_ALIASES[s.toLowerCase()];
}

/** rarity 别名表（英文遗留 + quality 字段废除后统一入口，修 #39） */
const RARITY_ALIASES: Record<string, Rarity> = {
  common: '普通',
  uncommon: '优良',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
  mythic: '神话',
  unique: '唯一',
};

/** 归一化品质。无法识别返回 undefined */
export function normalizeRarity(raw: string): Rarity | undefined {
  const s = (raw ?? '').trim();
  if ((RARITY_LEVELS as readonly string[]).includes(s)) return s as Rarity;
  return RARITY_ALIASES[s.toLowerCase()];
}

/** quest status 别名表 */
const QUEST_STATUS_ALIASES: Record<string, QuestStatus> = {
  完成: '已完成',
  已结束: '已完成',
  完毕: '已完成',
  进行: '进行中',
  正在进行: '进行中',
  接受: '进行中',
  失败了: '失败',
  已失败: '失败',
  暂停: '搁置',
  挂起: '搁置',
  搁置中: '搁置',
};

/** 归一化任务状态。无法识别兜底 '进行中'（宁可误留活跃也不误杀） */
export function normalizeQuestStatus(raw: string): QuestStatus {
  const s = (raw ?? '').trim();
  if ((QUEST_STATUSES as readonly string[]).includes(s)) return s as QuestStatus;
  return QUEST_STATUS_ALIASES[s] ?? '进行中';
}

/** status category 别名表 */
const STATUS_CATEGORY_ALIASES: Record<string, StatusCategory> = {
  buff: '增益',
  debuff: '减益',
  special: '特殊',
};

/** 归一化状态效果分类。无法识别兜底 '特殊' */
export function normalizeStatusCategory(raw: string): StatusCategory {
  const s = (raw ?? '').trim();
  if ((STATUS_CATEGORIES as readonly string[]).includes(s)) return s as StatusCategory;
  return STATUS_CATEGORY_ALIASES[s.toLowerCase()] ?? '特殊';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest --run src/sillytavern/field-enums.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: typecheck + 提交**

```bash
npm run typecheck
git add src/sillytavern/field-enums.ts src/sillytavern/field-enums.test.ts
git commit -m "feat(M1): field-enums.ts 中文枚举集中定义 + 归一化 (铁律5)"
```

---

### Task 2: types.ts 加法字段 + 双写迁移

**Files:**

- Modify: `src/sillytavern/types.ts`（CharacterState ~:725-790、createDefaultCharacterState ~:793、InventoryItem ~:644-656、SaveProfile ~:2089-2105）
- Modify: `src/sillytavern/database.ts`（createDefaultSaveProfile ~:646-661）
- Modify: `src/ui/stores/create-store.ts`（buildCharacterState ~:631-687）
- Modify: `src/ui/utils/test-save.ts`（4 处角色构造 :76 :192 :211 :245 附近）

**Interfaces:**

- Produces: `CharacterState.saveId: string`（一等字段）、`CharacterState.quantity?: number`、`CharacterState.appearance?/background?/personality?/gender?/outfit?/thoughts?: string`、`InventoryItem.equippedSlot?: string | null`、`SaveProfile.variables: Record<string, any>`。Task 3 的索引、Task 4 的注入、M2-M6 全部依赖这些字段存在。
- 双写策略: 写入方同时写正式字段与 customFields 旧 key（M6 才切读方），本 task 内行为零变化。

- [ ] **Step 1: types.ts — CharacterState 加字段**

在 `id: string;` 之后加：

```ts
/** 🆕 归属存档（一等字段，数据字段规范 铁律1/第1.2节；替代 customFields.saveId） */
saveId: string;
```

在 `bloodlineIds?: string[];` 之后、`customFields` 之前加：

```ts
  /** 🆕 怪物/召唤物集群数量（哥布林 ×3 = 一条记录）。仅 type='monster'|'summon' 使用，缺省 1（规范 §2.2） */
  quantity?: number;
  /** 🆕 外貌描述（从 customFields.physics/appearance 升正式字段，规范 §2.1） */
  appearance?: string;
  /** 🆕 背景故事（从 customFields.backstory/background 升正式字段） */
  background?: string;
  /** 🆕 性格（从 customFields.personality 升正式字段） */
  personality?: string;
  /** 🆕 性别（从 customFields.gender 升正式字段） */
  gender?: string;
  /** 🆕 服装（从 customFields.clothing/outfit 升正式字段） */
  outfit?: string;
  /** 🆕 心里话（从 customFields.thoughts 升正式字段，好感度系统的叙事侧数据） */
  thoughts?: string;
```

- [ ] **Step 2: types.ts — createDefaultCharacterState 补默认值**

在返回对象 `id: crypto.randomUUID(),` 之后加一行：

```ts
    saveId: '',
```

- [ ] **Step 3: types.ts — InventoryItem 加 equippedSlot**

在 `quantity: number;` 之后加：

```ts
  /** 🆕 穿戴槽位（EQUIP_SLOTS 枚举值）；null/undefined = 躺背包。装备不是独立实体，是物品的状态（规范 §3） */
  equippedSlot?: string | null;
```

- [ ] **Step 4: types.ts — SaveProfile 加 variables**

在 `worldFlags: Record<string, any>;` 之前加：

```ts
/** 🆕 叙事变量唯一真源（user./sys. 命名空间；从快照寄生迁出，规范 §12。M5 接管读写） */
variables: Record<string, any>;
```

- [ ] **Step 5: database.ts — createDefaultSaveProfile 补默认值**

在返回对象的 `worldFlags: {},` 之前加一行：

```ts
    variables: {},
```

- [ ] **Step 6: create-store.ts — buildCharacterState 一等字段 + 双写**

返回对象顶部 `id: charId,` 后加 `saveId,`；`customFields` 之前加正式字段（customFields 原内容**保持不动**，双写）：

```ts
      // 🆕 正式字段（规范 §2.1；customFields 同步保留旧 key 双写，M6 切换读方后再删）
      gender: gender.value === '自定义' ? customGender.value : gender.value,
      personality: personality.value.trim(),
      appearance: physics.value.trim(),
      background: backstory.value.trim(),
```

- [ ] **Step 7: test-save.ts — 4 处角色构造加一等 saveId（customFields 保持）**

每处角色对象字面量 `id: ...,` 之后加 `saveId,`（该文件作用域内已有 saveId 变量）。同时把 NPC 处 customFields 里已有的 gender/appearance/outfit/thoughts/background 复制一份为正式字段（双写），例如 :192 处 NPC：

```ts
      saveId,
      gender: '女',
      appearance: customFields 中 appearance 的原值,
      outfit: customFields 中 outfit 的原值,
      thoughts: customFields 中 thoughts 的原值,
      background: customFields 中 background 的原值,
```

（实施时以文件实际字面量为准复制值，不改 customFields 原内容。）

- [ ] **Step 8: typecheck + 全量测试**

Run: `npm run typecheck && npm run test -- --run`
Expected: typecheck 0 错误；测试仅既有 1 失败（命定之灵）。
注意: `CharacterState.saveId` 为必填新字段，若有测试文件手写角色字面量而未走 `createDefaultCharacterState` 会编译报错——逐个补 `saveId: 'test'`（用报错清单定位，预计涉及 char-gen-agent.test.ts / state-manager.test.ts / validate.test.ts 等少数构造点）。

- [ ] **Step 9: 提交**

```bash
git add -A src/
git commit -m "feat(M1): CharacterState.saveId 一等化 + quantity/正式字段 + equippedSlot + SaveProfile.variables (双写迁移)"
```

---

### Task 3: Dexie v9 — characters 索引 + chats 删表 + vanilla 清理

**Files:**

- Modify: `src/sillytavern/database.ts`（version 块 ~:59-201、getCharacters :472-479、getChats/saveChat/deleteChat 函数 ~:390-410）
- Delete: `src/vanilla/sillytavern-store.ts`（零消费方，已核实）
- Modify: `src/ui/stores/game-store.ts`（refreshFromDb :341-361 改读一等 saveId）
- Test: `src/sillytavern/database.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `CharacterState.saveId`
- Produces: `characters` 表 schema `'id, saveId, type'`；`getCharacters(saveId?)` 走索引查询；chats 表及其 API（getChats/saveChat/deleteChat）删除。

- [ ] **Step 1: 写失败测试（database.test.ts 追加）**

```ts
describe('v9: characters saveId 一等索引', () => {
  it('getCharacters(saveId) 按一等字段过滤（不再读 customFields）', async () => {
    const a = createDefaultCharacterState({ id: 'ca', name: '甲', saveId: 'save_A' });
    const b = createDefaultCharacterState({ id: 'cb', name: '乙', saveId: 'save_B' });
    await saveCharacters([a, b]);
    const got = await getCharacters('save_A');
    expect(got.map((c) => c.id)).toEqual(['ca']);
  });
  it('customFields.saveId 不再参与过滤', async () => {
    const c = createDefaultCharacterState({
      id: 'cc',
      name: '丙',
      saveId: '',
      customFields: { saveId: 'save_A' },
    });
    await saveCharacter(c);
    const got = await getCharacters('save_A');
    expect(got.find((x) => x.id === 'cc')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run src/sillytavern/database.test.ts -t "v9"`
Expected: FAIL（customFields 过滤路径仍生效 / 一等字段不被识别）

- [ ] **Step 3: database.ts 加 v9 版本块（v8 块之后）**

```ts
// v9: 数据字段规范 M1 — characters saveId 一等索引 (#43)；chats v3 遗留表删除 (#46)
this.version(9)
  .stores({
    lorebooks: 'id, name, updatedAt',
    presets: 'id, name, updatedAt',
    settings: 'key',
    chats: null, // 删表
    memories: 'id, saveId, createdAt, realTimestamp',
    plotEvents: 'id, saveId, parentId, status, updatedAt',
    characters: 'id, saveId, type',
    snapshots: 'id, saveId, index, timestamp',
    saves: 'id, slot, updatedAt',
    apiEndpoints: 'id, name',
    plotOutlines: 'id, saveId, updatedAt',
    saveProfiles: 'saveId, updatedAt',
    createPresets: 'id, name, updatedAt',
    messages: 'id, saveId, [saveId+turn]',
  })
  .upgrade(async (tx) => {
    // 开发期迁移: 把 customFields.saveId 回填为一等字段（老数据仅开发自用）
    const chars = await tx.table('characters').toCollection().toArray();
    for (const c of chars) {
      if (!c.saveId) {
        c.saveId = c.customFields?.saveId ?? '';
        await tx.table('characters').put(c);
      }
    }
  });
```

同时: DexieDB 类的 `chats!: Table<...>` 属性声明删除。

- [ ] **Step 4: getCharacters 改索引查询**

```ts
export async function getCharacters(saveId?: string): Promise<CharacterState[]> {
  if (saveId) {
    // v9: saveId 一等索引查询（规范 §1.2；替代 customFields 全表扫描）
    return getDatabase().characters.where('saveId').equals(saveId).toArray();
  }
  return getDatabase().characters.toArray();
}
```

- [ ] **Step 5: 删除 chats API 与 vanilla store**

- database.ts: 删除 getChats/saveChat/deleteChat（及 exportAllData/importAllData/clearAllData 中的 chats 引用行）。
- 删除文件 `src/vanilla/sillytavern-store.ts`。
- 跑 `grep -rn "ChatSession" src/ --include="*.ts" --include="*.vue" | grep -v "\.test\.ts"`：若仅剩 types.ts 定义处，把 `ChatSession` 接口标注 `/** @deprecated v3 遗留，chats 表已删（M1 #46），类型仅为历史 import 兼容保留，M6 删除 */`；若测试仍引用则测试同步删除对应用例。

- [ ] **Step 6: game-store.ts refreshFromDb 改读一等字段**

`refreshFromDb` 中追加判断行 `(c as any).customFields?.saveId === activeSaveId.value` 改为：

```ts
        if (!memIds.has(c.id) && c.saveId === activeSaveId.value) {
```

注释 `// 不带 saveId：侧链新 NPC 可能没写 customFields.saveId，带过滤会漏` 改为 `// 全量取后按一等 saveId 过滤追加（Task 4 起侧链 NPC 由 applyAddCharacter 注入 saveId）`。

- [ ] **Step 7: 跑测试 + typecheck + 提交**

Run: `npx vitest --run src/sillytavern/database.test.ts && npm run typecheck && npm run test -- --run`
Expected: 新用例 PASS；全量仅既有 1 失败。

```bash
git add -A src/
git commit -m "feat(M1): Dexie v9 — characters saveId 一等索引 + chats 删表 + vanilla store 清理 (#43 #46)"
```

---

### Task 4: applyAddCharacter 注入 saveId（修 #8 孤儿 NPC）

**Files:**

- Modify: `src/sillytavern/state-manager.ts`（applyAddCharacter ~:586-591）
- Test: `src/sillytavern/state-manager.test.ts`

**Interfaces:**

- Produces: `add_character` patch 落库前 Code 强制注入 `saveId = this.saveId`（铁律3: Code 补账务字段）。char_gen 链新 NPC 从此不再是孤儿。

- [ ] **Step 1: 写失败测试（state-manager.test.ts 追加，仿现有用例风格）**

```ts
it('add_character 落库时自动注入 saveId（修 #8 孤儿 NPC）', async () => {
  const sm = createStateManager('save_inject');
  const npc = createDefaultCharacterState({ id: 'npc_x', name: '妲丽安' });
  npc.saveId = ''; // 模拟 char_gen 链未填
  await sm!.commitChatState([{ op: 'add_character', target: 'characters.妲丽安', value: npc }]);
  const got = await getCharacters('save_inject');
  expect(got.map((c) => c.name)).toContain('妲丽安');
  expect(got.find((c) => c.name === '妲丽安')!.saveId).toBe('save_inject');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run src/sillytavern/state-manager.test.ts -t "注入 saveId"`
Expected: FAIL（saveId 仍为 ''，getCharacters 按索引查不到）

- [ ] **Step 3: applyAddCharacter 注入**

在 `if (!char?.id) throw new Error('缺少角色数据');`（或等价校验）之后、`saveCharacter` 之前加：

```ts
// 铁律3: saveId 是账务字段，由 Code 注入，不信任上游 patch 构造方 (#8)
if (!char.saveId) char.saveId = this.saveId;
if (char.customFields && !char.customFields.saveId) char.customFields.saveId = this.saveId; // 双写，M6 删
```

- [ ] **Step 4: 跑测试确认通过 + 全量 + 提交**

Run: `npx vitest --run src/sillytavern/state-manager.test.ts && npm run typecheck && npm run test -- --run`

```bash
git add src/sillytavern/state-manager.ts src/sillytavern/state-manager.test.ts
git commit -m "fix(M1): applyAddCharacter 强制注入 saveId — char_gen NPC 不再落库成孤儿 (#8)"
```

---

### Task 5: deleteSaveSlot 级联删除 characters（修 #9）

**Files:**

- Modify: `src/sillytavern/database.ts`（deleteSaveSlot ~:563-578）
- Test: `src/sillytavern/database.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('deleteSaveSlot 级联删除该存档的 characters（修 #9 删档残留）', async () => {
  await saveSaveSlot(makeSaveSlot({ id: 'save_del' }));
  await saveCharacter(createDefaultCharacterState({ id: 'cd1', name: '将删', saveId: 'save_del' }));
  await saveCharacter(
    createDefaultCharacterState({ id: 'cd2', name: '留下', saveId: 'save_other' }),
  );
  await deleteSaveSlot('save_del');
  const all = await getCharacters();
  expect(all.map((c) => c.id)).not.toContain('cd1');
  expect(all.map((c) => c.id)).toContain('cd2');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run src/sillytavern/database.test.ts -t "级联删除该存档的 characters"`
Expected: FAIL（cd1 仍在）

- [ ] **Step 3: deleteSaveSlot 补级联（在既有 6 类删除旁追加）**

```ts
    getDatabase().characters.where('saveId').equals(saveId).delete(),
```

（放入既有的并行删除 Promise 列表/事务中，风格与相邻行一致。）

- [ ] **Step 4: 跑测试 + typecheck + 提交**

```bash
npx vitest --run src/sillytavern/database.test.ts && npm run typecheck
git add src/sillytavern/database.ts src/sillytavern/database.test.ts
git commit -m "fix(M1): deleteSaveSlot 级联删除 characters (#9)"
```

---

### Task 6: char-query saveId 参数真正生效（修 #30）

**Files:**

- Modify: `src/sillytavern/char-query.ts`（getNpcs/getMonsters :40-47）
- Modify: `src/sillytavern/database.ts`（getCharactersByType :485-487）
- Test: `src/sillytavern/char-query.test.ts`（存在则追加，不存在则新建）

**Interfaces:**

- Produces: `getCharactersByType(type, saveId?)` 新签名；`getNpcs(saveId?)/getMonsters(saveId?)` 传参生效。

- [ ] **Step 1: 写失败测试**

```ts
it('getNpcs(saveId) 只返回该存档的 NPC（修 #30 假隔离）', async () => {
  await saveCharacter(
    createDefaultCharacterState({ id: 'n1', name: '本档NPC', type: 'npc', saveId: 'save_Q' }),
  );
  await saveCharacter(
    createDefaultCharacterState({ id: 'n2', name: '外档NPC', type: 'npc', saveId: 'save_Z' }),
  );
  const got = await getNpcs('save_Q');
  expect(got.map((c) => c.id)).toEqual(['n1']);
});
it('getNpcs() 不传 saveId 保持全量（兼容既有语义）', async () => {
  const got = await getNpcs();
  expect(got.length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL（返回两档 NPC）

- [ ] **Step 3: 实现**

database.ts:

```ts
export async function getCharactersByType(
  type: CharacterState['type'],
  saveId?: string,
): Promise<CharacterState[]> {
  if (saveId) {
    return getDatabase()
      .characters.where('saveId')
      .equals(saveId)
      .and((c) => c.type === type)
      .toArray();
  }
  return getDatabase().characters.where('type').equals(type).toArray();
}
```

char-query.ts:

```ts
/** 获取所有 NPC */
export async function getNpcs(saveId?: string): Promise<CharacterState[]> {
  return getCharactersByType('npc', saveId);
}

/** 获取所有怪物 */
export async function getMonsters(saveId?: string): Promise<CharacterState[]> {
  return getCharactersByType('monster', saveId);
}
```

- [ ] **Step 4: 跑测试 + typecheck + 全量 + 提交**

```bash
npx vitest --run src/sillytavern/char-query.test.ts && npm run typecheck && npm run test -- --run
git add -A src/sillytavern/
git commit -m "fix(M1): getNpcs/getMonsters/getCharactersByType 的 saveId 参数真正生效 (#30)"
```

---

### Task 7: persistMessage 前置校验（修 #13 孤儿消息）

**Files:**

- Modify: `src/ui/stores/game-store.ts`（persistMessage :233-239）
- Test: `src/ui/stores/game-store.test.ts`

- [ ] **Step 1: 写失败测试（game-store.test.ts 追加）**

```ts
describe('persistMessage 前置校验', () => {
  it('activeSaveId 为 null 时拒绝持久化（不产生孤儿消息）', async () => {
    const store = makeStore();
    // activeSaveId 默认 null
    store.addMessage('测试内容', 'user');
    await new Promise((r) => setTimeout(r, 20)); // addMessage 内部异步持久化
    const { getMessages } = await import('@engine/database');
    const orphans = await getMessages(undefined as any).catch(() => []);
    // 库里不应出现 saveId 为 null/undefined 的孤儿（getMessages 无参路径若不存在则以下断言改查全表）
    expect((orphans as any[]).filter((m) => m.content === '测试内容')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run src/ui/stores/game-store.test.ts -t "前置校验"`
Expected: FAIL（非空断言写入了 saveId=null 的消息）——若 getMessages 无参会 throw，按 Step 1 注释改为直接查 `getDatabase().messages` 全表计数。

- [ ] **Step 3: 实现**

```ts
/** 持久化单条消息到 IndexedDB */
async function persistMessage(msg: ChatMessage) {
  if (!activeSaveId.value) {
    // 规范 §10: 消息 saveId 必填；无活跃存档时拒绝写入，避免产生永不召回的孤儿消息 (#13)
    console.error(
      '[game-store] persistMessage 拒绝: activeSaveId 为空，消息未持久化:',
      msg.content.slice(0, 50),
    );
    return;
  }
  try {
    await saveMessage({ ...msg, saveId: activeSaveId.value });
  } catch (err) {
    console.error('[game-store] 消息持久化失败:', err);
  }
}
```

- [ ] **Step 4: 跑测试 + typecheck + 提交**

```bash
npx vitest --run src/ui/stores/game-store.test.ts && npm run typecheck
git add src/ui/stores/game-store.ts src/ui/stores/game-store.test.ts
git commit -m "fix(M1): persistMessage 前置校验替代非空断言 (#13)"
```

---

### Task 8: SaveSlot 清理 — 删 metadata.description 与内嵌 snapshots 数组（修 #47 + #2 准备）

**Files:**

- Modify: `src/sillytavern/types.ts`（SaveSlot :988-1012）
- Modify: `src/ui/stores/create-store.ts`（startJourney :823-846）
- Modify: `src/ui/stores/game-store.ts`（loadSave 快照恢复死块 :318-323 附近）
- Modify: `src/ui/utils/test-save.ts` + `src/sillytavern/database.test.ts` + `src/ui/stores/game-store.test.ts`（makeSaveSlot 等构造点删两字段）

**Interfaces:**

- Produces: `SaveSlot` 不再有 `snapshots` 与 `metadata.description`。快照唯一真源 = snapshots 表（`activeSnapshotId` 保留，指表记录；恢复机制 M5 重建）。

- [ ] **Step 1: types.ts 删两字段**

SaveSlot 中删除：

```ts
  /** 快照列表（按 index 排序） */
  snapshots: Snapshot[];
```

和 metadata 中的 `description?: string;`。在 `activeSnapshotId` 注释后追加 `（指向 snapshots 表记录；恢复机制 M5 重建）`。

- [ ] **Step 2: create-store.ts startJourney 删两处写入**

删除 `snapshots: [],` 行和整个 `description: JSON.stringify({...}),` 块（openingPrompt 已有 metadata.openingPrompt 正式位、destinyCoreId/难度已在玩家角色 customFields，#47 确认无读取方）。

- [ ] **Step 3: game-store.ts loadSave 删快照恢复死块**

删除：

```ts
// 从 Snapshot 恢复角色状态
if (save.activeSnapshotId && save.snapshots) {
  const snap = save.snapshots.find((s: any) => s.id === save.activeSnapshotId);
  if (snap) {
    if (snap.characters) characters.value = snap.characters as CharacterState[];
  }
}
```

原位留注释：`// 快照恢复走 snapshots 表（规范 §11.2），机制在 M5 重建 (#2)`。

- [ ] **Step 4: 修编译报错的构造点**

`npm run typecheck` 列出所有 `snapshots`/`description` 构造点（预计: test-save.ts、database.test.ts makeSaveSlot、game-store.test.ts makeSaveSlot），逐个删除这两个属性行。

- [ ] **Step 5: typecheck + 全量 + 提交**

```bash
npm run typecheck && npm run test -- --run
git add -A src/
git commit -m "refactor(M1): SaveSlot 删除内嵌 snapshots 数组与 metadata.description (#47, #2 准备)"
```

---

### Task 9: ChatMessage 死字段删除（修 #48 + #33 前半）

**Files:**

- Modify: `src/sillytavern/types.ts`（ChatMessage :477-497）
- Modify: `src/ui/stores/game-store.ts`（latestVariables :53-62、getThoughts :69-83、return :390 附近）
- Modify: `src/ui/components/game/ScenePanel.vue`（weather :56-66）
- Modify: `src/ui/components/game/ChatFlow.vue`（beautifyText :105）
- Modify: `src/ui/lib/game-pipeline.ts`（buildContext :277）
- Modify: `src/ui/lib/test-fixtures.ts`（variablesAfter 注入 :565-575、parsed 写点 :319/:344）
- Modify: `src/ui/components/game/GamePage.vue`（注释 :73-76）
- Modify: `src/sillytavern/variables.ts`（:77 parsed 写点，v3 遗留）

**Interfaces:**

- Produces: `ChatMessage` 仅保留 id/role/content/timestamp/saveId/turn/systemEvent（+v3 必需的既有字段中未列废的）。`game-store.latestVariables` 移除；`getThoughts(charName, char?)` 签名不变，仅走 customFields/正式字段路径。

- [ ] **Step 1: types.ts 删字段**

ChatMessage 中删除 `variables?`、`parsed?`、`metadata?`、`apiUsed?`、`variablesAfter?` 五个字段及其注释（生产零写入，#48/#33；v3 vanilla store 已在 Task 3 删除）。

- [ ] **Step 2: game-store.ts 删 latestVariables、简化 getThoughts**

删除 `latestVariables` computed（:53-62）及 return 中的 `latestVariables,`。getThoughts 改为：

```ts
// === 心里话 ===
// 唯一真源: CharacterState.thoughts 正式字段（规范 §7），customFields.thoughts 兜底（M6 删）
function getThoughts(charName: string, char?: CharacterState): string {
  if (char?.thoughts) return char.thoughts;
  const cf = (char as any)?.customFields;
  if (cf && typeof cf.thoughts === 'string' && cf.thoughts) return cf.thoughts;
  return '';
}
```

- [ ] **Step 3: ScenePanel.vue weather 去 latestVariables 路径**

```ts
// ═══ 天气 —— worldFlags 单源（variablesAfter 路径已死，变量真源 M5 迁入 saveProfile.variables 后再接） ═══
const weather = computed(() => {
  const wf = game.saveProfile?.worldFlags;
  return (wf?.['天气'] as string) ?? (wf?.['weather'] as string) ?? '';
});
```

- [ ] **Step 4: ChatFlow.vue / game-pipeline.ts / test-fixtures.ts / variables.ts / GamePage.vue**

- ChatFlow.vue:105 → `const raw = msg.content`
- game-pipeline.ts:277 → `variables: {},   // M5: 改读 saveProfile.variables（规范 §12）`
- test-fixtures.ts: 删 variablesAfter 注入块（:565-575）与 parsed 写点（:319/:344 改为仅写 content）
- variables.ts:77: 删 parsed 写入行（v3 遗留；若该函数仅为写 parsed 而存在则整函数删除并处理其调用方）
- GamePage.vue:73-76 注释同步改写（去掉 variablesAfter 描述）

- [ ] **Step 5: typecheck 扫尾 + 全量 + 提交**

Run: `npm run typecheck`（用报错清单扫掉残余引用，含 *.test.ts）`&& npm run test -- --run`
Expected: 0 错误；仅既有 1 失败。

```bash
git add -A src/
git commit -m "refactor(M1): ChatMessage 死字段删除 variablesAfter/parsed/metadata/apiUsed/variables (#48 #33)"
```

---

### Task 10: 收尾 — 规范附录 A 范围调整回写 + 文档同步 + 全量验证

**Files:**

- Modify: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`（附录 A）
- Modify: `CLAUDE.md`（架构清单登记 field-enums.ts）

- [ ] **Step 1: 规范附录 A 加 M1 执行注记**

在附录 A 表格后追加：

```markdown
> **M1 执行注记（2026-07-16）**: M1 已按"每批次编译绿灯"原则重校准——物品/技能/状态效果 id 退役与
> EquipmentSlot 删除移至 M2/M3（随消费者 StateManager/翻译层重写同批）；Snapshot 类型重定义移至 M5
> （随快照机制重建同批）；新正式字段采用双写策略，读方 M6 切换。M1 实际完成: field-enums.ts、
> CharacterState.saveId 一等化(#8 #43)、Dexie v9(#46)、级联删除(#9)、char-query 隔离(#30)、
> persistMessage 校验(#13)、SaveSlot 清理(#47)、ChatMessage 死字段(#48 #33 前半)。
```

- [ ] **Step 2: CLAUDE.md 架构段登记**

在 `├── tier-constants.ts` 行之前加一行：

```
  ├── field-enums.ts                ← [M1] 中文枚举集中定义 + 归一化 (铁律5)
```

- [ ] **Step 3: 最终全量验证**

Run: `npm run typecheck && npm run test -- --run`
Expected: 0 编译错误；仅既有 1 失败（命定之灵）；确认无新增失败后手动清一次浏览器 IndexedDB（DevTools → Application → 删库）验证 dev 启动 + 创角 + 存档正常（v9 升级路径）。

- [ ] **Step 4: 提交 + 通知**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(M1): 规范附录 A 执行注记 + CLAUDE.md 登记 field-enums"
bash scripts/notify.sh "M1 类型与库层 完成!" "field-enums + saveId 一等化 + Dexie v9 | typecheck 0 错误"
```
