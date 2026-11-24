/**
 * 状态树中文键词表（状态树协议 T1，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §3.1–3.3）
 *
 * 描述 AI 读到、写入的那棵中文键状态树的**形状**：每个节点的键、叶子类型、是否只读、对应内核字段。
 * 投影（T4）、路径解析（T5）、翻译层（T6）、协议文字（T7）共用这一份，别各写一张。
 *
 * 约定：
 * - 以 `_` 开头的键只读（§3.3），`isReadonlyKey` 是唯一判据；路径解析时忽略 `_` 前缀（`findChildSpec`）。
 * - `等级` 例外：键名不带 `_`，NPC 可写、主角只读（§9 #2），由 `playerReadonly` 标出。
 * - `field` 是给人看的内核字段说明（`CharacterState.hp` 之类），不是可执行路径；映射规则在翻译层。
 *
 * 🔴 只许依赖 `content/field-enums.ts`（与 `agents/direct-contract.ts` 同一规矩）：本文件要被协议文字生成器读，
 *    一旦拉进 state-manager / types 运行时值就会成环。
 */

import {
  EQUIP_SLOTS,
  ITEM_TYPES,
  QUEST_STATUSES,
  RARITY_LEVELS,
  STATUS_CATEGORIES,
} from '../content/field-enums';

// ========== 类型 ==========

/** 叶子类型（对应 §5.2 纠正规则的各行）。 */
export type StateTreeLeafKind =
  /** 普通数值（经验、冷却、威力、层数上限、耐久等） */
  | 'number'
  /** 资源当前值（钳到 [0, 有效上限]） */
  | 'resourceCurrent'
  /** 上限的 `_基础`（只读，代码按公式推导） */
  | 'capBase'
  /** 上限的 `额外`（整数，可为负；基础 + 额外 ≥ 1） */
  | 'capBonus'
  /** 金钱（结果不小于 0） */
  | 'money'
  /** 命运点数（结果不小于 0，换算成账本增量） */
  | 'fatePoints'
  /** 好感度（[-100, 100]） */
  | 'affection'
  /** 物品 / 集群数量（≤0 视为移除） */
  | 'quantity'
  /** 状态层数（≤0 视为移除状态，受层数上限封顶） */
  | 'stacks'
  /** 文本 */
  | 'text'
  /** 文本数组 */
  | 'textArray'
  /** 词条字典 {词条: 文本} */
  | 'effectDict'
  /** 数值字典（物品 `属性`） */
  | 'numberDict'
  /** 布尔 */
  | 'boolean'
  /** 枚举（见 `enumKind`） */
  | 'enum'
  /** 装备位置（槽位） */
  | 'slot'
  /** 剩余时间（文本 ⇄ remainingTime + timeUnit 或 durationText） */
  | 'duration'
  /** 技能消耗（文本 ⇄ cost 或 costText） */
  | 'skillCost'
  /** 游戏时间（只能前进，汇总成本楼分钟数） */
  | 'gameTime'
  /** 位置路径（走 set_location） */
  | 'location'
  /** ADR-30 叙事变量空间，键不翻译、原样透传 */
  | 'variables';

/** 枚举种类。前五种只查 field-enums 的词表与别名表；后几种是内核固定的小集合。 */
export type StateTreeEnumKind =
  | 'rarity'
  | 'itemType'
  | 'statusCategory'
  | 'questStatus'
  | 'questPriority'
  | 'skillType'
  | 'attribute'
  | 'damageType';

/** 整实体种类：`record` 的条目被整对象写入时按此组装（§5.2「整实体值」）。 */
type StateTreeEntityKind =
  | 'character'
  | 'item'
  | 'skill'
  | 'statusEffect'
  | 'quest'
  | 'newsColumn'
  | 'newsArticle'
  | 'ascensionElement'
  | 'ascensionAuthority'
  | 'ascensionLaw';

interface NodeBase {
  /** 中文键；只读键带 `_` 前缀。`record` 条目的键是名字占位（形如 `{物品名}`）。 */
  readonly key: string;
  /** 对应内核字段说明（给人与协议生成器看）。 */
  readonly field?: string;
  /** 键名不带 `_` 但对主角只读（`成长.等级`，§3.3）。 */
  readonly playerReadonly?: boolean;
  /** 只在 `关系列表` 的人物上出现（在场 / 地点 / 好感度 / 数量）。 */
  readonly relationOnly?: boolean;
  /** 只在值存在时投影（§1.3「有值才投影」）。 */
  readonly optional?: boolean;
  /** 补充说明。 */
  readonly note?: string;
}

/** 叶子节点。 */
export interface StateTreeLeafSpec extends NodeBase {
  readonly type: 'leaf';
  readonly leaf: StateTreeLeafKind;
  readonly enumKind?: StateTreeEnumKind;
}

/** 固定键的分支节点。 */
export interface StateTreeBranchSpec extends NodeBase {
  readonly type: 'branch';
  readonly children: readonly StateTreeNodeSpec[];
  /** 整个分支可被写成单个标量时，该标量按此叶子类型纠正（`上限` 写成一个数，§3.3）。 */
  readonly scalarLeaf?: StateTreeLeafKind;
  /** 整对象写入时按此实体组装。 */
  readonly entity?: StateTreeEntityKind;
}

/** 按名字作键的字典节点（背包 / 装备 / 技能 / 状态效果 / 关系列表 / 任务列表 …）。 */
export interface StateTreeRecordSpec extends NodeBase {
  readonly type: 'record';
  /** 每个条目的形状；其 `key` 是名字占位。 */
  readonly entry: StateTreeNodeSpec;
}

export type StateTreeNodeSpec = StateTreeLeafSpec | StateTreeBranchSpec | StateTreeRecordSpec;

// ========== 词表常量 ==========

/** patch 的五个 op（§4.3），按协议讲解顺序。补丁解析、翻译层与协议文字共用这一份。 */
export const STATE_TREE_PATCH_OPS = ['replace', 'add', 'remove', 'delta', 'move'] as const;
export type StateTreePatchOp = (typeof STATE_TREE_PATCH_OPS)[number];

/**
 * 原型污染键：出现在任何层级（含路径段）即整楼拒收（§5.4）。
 * 取值与 `agents/direct-contract.ts` 的 `DIRECT_FORBIDDEN_KEYS` 相同；本文件只许依赖 field-enums，故单列一份。
 */
export const STATE_TREE_FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor'] as const;

/** 关注度（Quest.priority）。field-enums 未收录，内核类型固定为这三值。 */
export const QUEST_PRIORITIES = ['低', '中', '高'] as const;

/** 技能类型的中文显示 ⇄ 内核值。 */
export const SKILL_TYPE_LABELS = { active: '主动', passive: '被动' } as const;

/** 五维属性中文键 ⇄ 内核键（`_属性` 子树与技能 `关联属性` 共用）。 */
export const ATTRIBUTE_LABELS = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  spi: '精神',
} as const;

/** 伤害类型（内核 `DamageType` 的取值，本身就是中文）。 */
export const DAMAGE_TYPES = ['物理', '能量', '精神', '真实'] as const;

/** 各枚举的合法取值（协议文字列可选值用）。 */
export const STATE_TREE_ENUM_VALUES: Readonly<Record<StateTreeEnumKind, readonly string[]>> = {
  rarity: RARITY_LEVELS,
  itemType: ITEM_TYPES,
  statusCategory: STATUS_CATEGORIES,
  questStatus: QUEST_STATUSES,
  questPriority: QUEST_PRIORITIES,
  skillType: Object.values(SKILL_TYPE_LABELS),
  attribute: Object.values(ATTRIBUTE_LABELS),
  damageType: DAMAGE_TYPES,
};

/** 装备位置的可选值（只认内核槽位词，原卡「手持」等不加别名，§9 #6）。 */
export const STATE_TREE_SLOT_VALUES: readonly string[] = EQUIP_SLOTS;

// ========== 构造辅助 ==========

type LeafExtra = Omit<StateTreeLeafSpec, 'type' | 'key' | 'leaf'>;

function leaf(key: string, kind: StateTreeLeafKind, extra: LeafExtra = {}): StateTreeLeafSpec {
  return { type: 'leaf', key, leaf: kind, ...extra };
}

function enumLeaf(
  key: string,
  enumKind: StateTreeEnumKind,
  extra: LeafExtra = {},
): StateTreeLeafSpec {
  return { type: 'leaf', key, leaf: 'enum', enumKind, ...extra };
}

function branch(
  key: string,
  children: readonly StateTreeNodeSpec[],
  extra: Omit<StateTreeBranchSpec, 'type' | 'key' | 'children'> = {},
): StateTreeBranchSpec {
  return { type: 'branch', key, children, ...extra };
}

function record(
  key: string,
  entry: StateTreeNodeSpec,
  extra: Omit<StateTreeRecordSpec, 'type' | 'key' | 'entry'> = {},
): StateTreeRecordSpec {
  return { type: 'record', key, entry, ...extra };
}

/** 资源节点：`{当前, 上限: {_基础, 额外}}`（§3.1、§5.6）。 */
function resource(key: string, cur: 'hp' | 'mp' | 'sp'): StateTreeBranchSpec {
  const cap = `max${cur.charAt(0).toUpperCase()}${cur.slice(1)}`;
  return branch(key, [
    leaf('当前', 'resourceCurrent', { field: `CharacterState.${cur}` }),
    branch(
      '上限',
      [
        leaf('_基础', 'capBase', { field: `calcResources(tier, attributes).${cap}（不落库）` }),
        leaf('额外', 'capBonus', { field: `CharacterState.${cap}Bonus` }),
      ],
      {
        field: `CharacterState.${cap}（有效总值 = max(1, 基础 + 额外)）`,
        scalarLeaf: 'capBonus',
        note: '写成单个数时按「额外 = 该数 − 基础」纠正',
      },
    ),
  ]);
}

/** 物品条目的公共叶子；`withSlot` 为装备字典（带 `位置`）。 */
function itemEntry(withSlot: boolean): StateTreeBranchSpec {
  return branch(
    '{物品名}',
    [
      enumLeaf('品质', 'rarity', { field: 'InventoryItem.rarity' }),
      enumLeaf('类型', 'itemType', { field: 'InventoryItem.type' }),
      leaf('数量', 'quantity', {
        field: 'InventoryItem.quantity',
        ...(withSlot ? { optional: true, note: '只在大于 1 时投影' } : {}),
      }),
      ...(withSlot ? [leaf('位置', 'slot', { field: 'InventoryItem.equippedSlot' })] : []),
      leaf('标签', 'textArray', { field: 'InventoryItem.tags' }),
      leaf('效果', 'effectDict', { field: 'InventoryItem.effects' }),
      leaf('描述', 'text', { field: 'InventoryItem.description' }),
      leaf('属性', 'numberDict', { field: 'InventoryItem.stats', optional: true }),
      branch(
        '耐久',
        [
          leaf('当前', 'number', { field: 'InventoryItem.durability' }),
          leaf('上限', 'number', { field: 'InventoryItem.maxDurability' }),
        ],
        { optional: true },
      ),
      leaf('规则文本', 'text', { field: 'InventoryItem.protocolText', optional: true }),
    ],
    { entity: 'item', field: 'InventoryItem' },
  );
}

const SKILL_ENTRY = branch(
  '{技能名}',
  [
    enumLeaf('品质', 'rarity', { field: 'Skill.rarity' }),
    enumLeaf('类型', 'skillType', { field: 'Skill.type' }),
    leaf('消耗', 'skillCost', { field: 'Skill.cost / Skill.costText' }),
    leaf('冷却', 'number', { field: 'Skill.cooldown', optional: true }),
    leaf('标签', 'textArray', { field: 'Skill.tags' }),
    leaf('效果', 'effectDict', { field: 'Skill.effects' }),
    leaf('描述', 'text', { field: 'Skill.description' }),
    leaf('威力', 'number', { field: 'Skill.skillPower', optional: true }),
    enumLeaf('关联属性', 'attribute', { field: 'Skill.relevantAttribute', optional: true }),
    enumLeaf('伤害类型', 'damageType', { field: 'Skill.damageType', optional: true }),
    leaf('规则文本', 'text', { field: 'Skill.protocolText', optional: true }),
  ],
  { entity: 'skill', field: 'Skill' },
);

const STATUS_ENTRY = branch(
  '{状态名}',
  [
    enumLeaf('类型', 'statusCategory', { field: 'StatusEffect.category' }),
    leaf('描述', 'text', { field: 'StatusEffect.description' }),
    leaf('效果', 'effectDict', { field: 'StatusEffect.effectDescriptions' }),
    leaf('层数', 'stacks', { field: 'StatusEffect.stacks' }),
    leaf('层数上限', 'number', { field: 'StatusEffect.maxStacks', optional: true }),
    leaf('剩余时间', 'duration', {
      field: 'StatusEffect.remainingTime + timeUnit / StatusEffect.durationText',
    }),
    leaf('来源', 'text', { field: 'StatusEffect.source' }),
  ],
  { entity: 'statusEffect', field: 'StatusEffect' },
);

const ASCENSION_SPEC = branch(
  '登神长阶',
  [
    leaf('是否开启', 'boolean', { field: 'ascension.enabled' }),
    record(
      '要素',
      branch(
        '{要素名}',
        [
          leaf('描述', 'text', { field: 'ElementDetail.description' }),
          leaf('效果', 'effectDict', { field: 'ElementDetail.effectDescriptions' }),
        ],
        { entity: 'ascensionElement' },
      ),
      { field: 'ascension.elements' },
    ),
    record(
      '权能',
      branch(
        '{权能名}',
        [
          leaf('描述', 'text', { field: 'AuthorityDetail.description' }),
          leaf('效果', 'effectDict', { field: 'AuthorityDetail.effectDescriptions' }),
          leaf('消耗', 'text', { field: 'AuthorityDetail.costDescription' }),
        ],
        { entity: 'ascensionAuthority' },
      ),
      { field: 'ascension.authority' },
    ),
    record(
      '法则',
      branch(
        '{法则名}',
        [
          leaf('描述', 'text', { field: 'LawDetail.description' }),
          leaf('效果', 'effectDict', { field: 'LawDetail.effectDescriptions' }),
          leaf('消耗', 'text', { field: 'LawDetail.costDescription' }),
        ],
        { entity: 'ascensionLaw' },
      ),
      { field: 'ascension.law' },
    ),
    leaf('神位', 'text', { field: 'ascension.deityPosition' }),
    branch(
      '神国',
      [
        leaf('名称', 'text', { field: 'ascension.divineKingdom.name' }),
        leaf('描述', 'text', { field: 'ascension.divineKingdom.description' }),
      ],
      { field: 'ascension.divineKingdom' },
    ),
  ],
  { field: 'CharacterState.ascension', note: '任意写都按「影子现值 + 本条」重建整份' },
);

// ========== 人物节点 ==========

/**
 * 人物节点的子键（主角与关系列表共用；每个直接子键是一个缓存分区，§3.4）。
 * 带 `relationOnly` 的只出现在关系列表的人物上。
 */
export const PERSON_NODE_CHILDREN: readonly StateTreeNodeSpec[] = [
  branch(
    '档案',
    [
      leaf('种族', 'text', { field: 'CharacterState.race' }),
      leaf('性别', 'text', { field: 'CharacterState.gender' }),
      leaf('身份', 'textArray', { field: 'CharacterState.identity' }),
      leaf('职业', 'textArray', { field: 'CharacterState.occupation' }),
      leaf('_年龄', 'number', { field: 'ageAt(ageAnchor, gameTime)（现算）' }),
      leaf('_生日', 'text', { field: 'CharacterState.ageAnchor 的生日' }),
      leaf('外貌', 'text', { field: 'CharacterState.appearance' }),
      leaf('着装', 'text', { field: 'CharacterState.outfit' }),
      leaf('性格', 'text', { field: 'CharacterState.personality' }),
      leaf('背景故事', 'text', { field: 'CharacterState.background' }),
      leaf('类别', 'text', {
        field: 'CharacterState.type（怪物 / 召唤物）',
        optional: true,
        relationOnly: true,
      }),
    ],
    { note: '文字字段的路径写入转成 character_updates 的 profile_changes（§5.5）' },
  ),
  branch('成长', [
    leaf('_生命层级', 'number', { field: 'CharacterState.tier' }),
    leaf('等级', 'number', {
      field: 'CharacterState.level',
      playerReadonly: true,
      note: 'NPC 可写（代码随之推出层级、重算基础上限）；主角只读，请改累计经验值',
    }),
    leaf('累计经验值', 'number', { field: 'CharacterState.totalExp' }),
    leaf('_升级所需经验', 'number', { field: 'CharacterState.expToNext' }),
    leaf('_属性点', 'number', { field: 'CharacterState.freeAttrPoints' }),
    branch(
      '_属性',
      (Object.keys(ATTRIBUTE_LABELS) as Array<keyof typeof ATTRIBUTE_LABELS>).map((k) =>
        leaf(ATTRIBUTE_LABELS[k], 'number', { field: `CharacterState.attributes.${k}` }),
      ),
      { field: 'CharacterState.attributes' },
    ),
  ]),
  resource('生命值', 'hp'),
  resource('法力值', 'mp'),
  resource('体力值', 'sp'),
  leaf('金钱', 'money', { field: 'CharacterState.money' }),
  leaf('当前行动', 'text', { field: 'CharacterState.currentAction' }),
  leaf('心里话', 'text', { field: 'CharacterState.thoughts' }),
  record('背包', itemEntry(false), {
    field: 'CharacterState.inventory（equippedSlot 为空）',
  }),
  record('装备', itemEntry(true), {
    field: 'CharacterState.inventory（equippedSlot 非空）',
  }),
  record('技能', SKILL_ENTRY, { field: 'CharacterState.skills' }),
  record('状态效果', STATUS_ENTRY, { field: 'CharacterState.statusEffects' }),
  ASCENSION_SPEC,
  leaf('在场', 'boolean', { field: 'CharacterState.present', relationOnly: true }),
  leaf('地点', 'location', {
    field: 'CharacterState.location',
    relationOnly: true,
    note: '主角的地点投影在 /世界/地点',
  }),
  leaf('好感度', 'affection', { field: 'SaveProfile.affections[名]', relationOnly: true }),
  leaf('数量', 'quantity', {
    field: 'CharacterState.quantity（怪物 / 召唤物集群）',
    relationOnly: true,
    optional: true,
  }),
];

function personNode(key: string, relation: boolean): StateTreeBranchSpec {
  return branch(
    key,
    PERSON_NODE_CHILDREN.filter((c) => relation || !c.relationOnly),
    { entity: 'character', field: 'CharacterState' },
  );
}

// ========== 整棵树 ==========

/** `stat_data` 的根（§3.1 骨架）。 */
export const STATE_TREE_SPEC: StateTreeBranchSpec = branch('stat_data', [
  branch('世界', [
    leaf('时间', 'gameTime', {
      field: 'SaveProfile.gameTime（formatGameTime 规范串）',
      note: '只能前进，汇总成本楼分钟数交给 applyTimeAdvance',
    }),
    leaf('地点', 'location', { field: '主角 CharacterState.location' }),
    leaf('_时段', 'text', { field: '由游戏时间推导' }),
    leaf('_天气', 'text', { field: 'worldFlags.map 天气' }),
    leaf('_回合', 'number', { field: '当前回合号' }),
  ]),
  leaf('命运点数', 'fatePoints', { field: 'SaveProfile.fp（走账本）' }),
  personNode('主角', false),
  record('关系列表', personNode('{人物名}', true), {
    field: 'CharacterState[]（type ≠ player）',
    note: '不在场角色只投 {在场, 地点, 好感度} 摘要',
  }),
  record(
    '任务列表',
    branch(
      '{任务名}',
      [
        enumLeaf('状态', 'questStatus', { field: 'Quest.status' }),
        enumLeaf('关注度', 'questPriority', { field: 'Quest.priority' }),
        leaf('进展', 'text', { field: 'Quest.progress' }),
        leaf('详情', 'text', { field: 'Quest.detail' }),
        leaf('目标', 'text', { field: 'Quest.objective' }),
        leaf('奖励', 'text', { field: 'Quest.reward' }),
      ],
      { entity: 'quest', field: 'Quest' },
    ),
    { field: 'SaveProfile.quests' },
  ),
  record(
    '新闻',
    record('{栏目}', leaf('{标题}', 'text', { field: 'NewsItem.content' }), {
      field: 'NewsItem.category',
    }),
    { field: 'SaveProfile.news', note: '只投最近若干条，只增不删' },
  ),
  leaf('变量', 'variables', { field: 'SaveProfile.variables（ADR-30 vars 空间，键不翻译）' }),
]);

// ========== 查询 ==========

/** 键是否只读（`_` 前缀，§3.3）。 */
export function isReadonlyKey(key: string): boolean {
  return key.startsWith('_');
}

/** 去掉只读前缀后的键名（路径解析忽略 `_` 前缀用）。 */
export function stripReadonlyPrefix(key: string): string {
  return key.replace(/^_+/, '');
}

/** 节点是否只读；`isPlayer` 决定 `等级` 这类 playerReadonly 键的结果。 */
export function isReadonlyNode(spec: StateTreeNodeSpec, isPlayer: boolean): boolean {
  return isReadonlyKey(spec.key) || (isPlayer && spec.playerReadonly === true);
}

/** 在分支下按段找子节点：先精确匹配，再忽略 `_` 前缀匹配（§5.1 第 1 步）。不做模糊匹配。 */
export function findChildSpec(
  parent: StateTreeBranchSpec,
  segment: string,
): StateTreeNodeSpec | undefined {
  const exact = parent.children.find((c) => c.key === segment);
  if (exact) return exact;
  const bare = stripReadonlyPrefix(segment);
  return parent.children.find((c) => stripReadonlyPrefix(c.key) === bare);
}

/** 展平后的一行：路径模式（名字段写作 `{…}` 占位）+ 节点。 */
export interface StateTreePathRow {
  /** 形如 `/关系列表/{人物名}/背包/{物品名}/数量`。 */
  readonly pattern: string;
  readonly spec: StateTreeNodeSpec;
  /** 路径上任一键只读（`_` 前缀）即只读；不含 playerReadonly（那要看是不是主角）。 */
  readonly readonly: boolean;
}

/** 把整棵树展平成路径模式清单（深度优先，根自身不列）。协议文字与闸门测试用。 */
export function listStateTreePaths(
  root: StateTreeBranchSpec = STATE_TREE_SPEC,
): StateTreePathRow[] {
  const rows: StateTreePathRow[] = [];
  const walk = (node: StateTreeNodeSpec, prefix: string, inheritedReadonly: boolean): void => {
    const pattern = `${prefix}/${node.key}`;
    const readonly = inheritedReadonly || isReadonlyKey(node.key);
    rows.push({ pattern, spec: node, readonly });
    if (node.type === 'branch') {
      for (const c of node.children) walk(c, pattern, readonly);
    } else if (node.type === 'record') {
      walk(node.entry, pattern, readonly);
    }
  };
  for (const c of root.children) walk(c, '', false);
  return rows;
}
