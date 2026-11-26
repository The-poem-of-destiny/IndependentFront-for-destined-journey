/**
 * 状态树中文键词表（状态树协议 T1，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §3.1–3.3）
 *
 * 描述 AI 读到、写入的那棵中文键状态树的**形状**：每个节点的键、叶子类型、是否只读、对应内核字段。
 * 投影（T4）、路径解析（T5）、翻译层（T6）、协议文字（T7）共用这一份，别各写一张。
 *
 * 约定：
 * - 以 `_` 开头的键只读（§3.3），`isReadonlyKey` 是唯一判据；路径解析时忽略 `_` 前缀（`findChildSpec`）。
 * - `等级` 例外：键名不带 `_`，NPC 可写、主角只读（§9 #2），由 `playerReadonly` 标出。
 * - `field` 是给人看的内核字段说明（`CharacterState.hp` 之类），不是可执行路径。
 * - `kernel`（内核字段键）与 `rule`（写入规则）是可执行映射：翻译层与编辑层只从这里读键 → 字段 / 规则，
 *   不另写对照表（审查报告 R6a，`tests/core/variables/state-tree-spec-source-gate.test.ts` 钉住）。
 *   这两项不进协议文字，改它们不会让 `direct_cached` 冷建。
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

/**
 * 写入规则种类：翻译层按它分派（审查报告 R6a：键 → 规则 / 内核字段只从本词表读，翻译层与编辑层不另写映射）。
 * 只读键（含祖先只读）一律是 `readonly`；未声明规则的分支 / 字典是 `expand`（整对象按键展开）；
 * `ascension` 与 `news` 由声明它的节点向下继承。
 */
export type StateTreeWriteRule =
  | 'expand'
  | 'time'
  | 'worldLocation'
  | 'fatePoints'
  | 'profileText'
  | 'profileList'
  | 'category'
  | 'level'
  | 'totalExp'
  | 'resourceCurrent'
  | 'capTotal'
  | 'capBonus'
  | 'money'
  | 'personText'
  | 'present'
  | 'location'
  | 'affection'
  | 'groupQuantity'
  | 'itemEntity'
  | 'itemField'
  | 'itemQuantity'
  | 'itemSlot'
  | 'skillEntity'
  | 'skillField'
  | 'statusEntity'
  | 'statusField'
  | 'statusStacks'
  | 'statusDuration'
  | 'ascension'
  | 'characterEntity'
  | 'questEntity'
  | 'questField'
  | 'news'
  | 'variables'
  | 'readonly';

/** 向下继承的规则（子树整体按同一种方式处理）。 */
const INHERITED_RULES: ReadonlySet<StateTreeWriteRule> = new Set(['ascension', 'news']);

interface NodeBase {
  /** 中文键；只读键带 `_` 前缀。`record` 条目的键是名字占位（形如 `{物品名}`）。 */
  readonly key: string;
  /** 对应内核字段说明（给人与协议生成器看）。 */
  readonly field?: string;
  /**
   * 内核字段键（可执行映射，翻译层据此读写）：相对所在实体（`InventoryItem` / `Skill` / `StatusEffect` /
   * `Quest` / `CharacterState` / 登神条目 …）的属性名，如 `rarity`、`maxHpBonus`。
   */
  readonly kernel?: string;
  /** 写入规则（见 `StateTreeWriteRule`）。 */
  readonly rule?: StateTreeWriteRule;
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

/**
 * 人物 `档案/类别` 的中文 → 内核 `CharacterState.type`（写入时用；投影只出前两项）。
 * 空串 / `无` / `人物` / `NPC` 都读作普通人物。
 */
export const CHARACTER_CATEGORY_TYPES: Readonly<Record<string, 'monster' | 'summon' | 'npc'>> = {
  怪物: 'monster',
  召唤物: 'summon',
  人物: 'npc',
  NPC: 'npc',
  npc: 'npc',
  无: 'npc',
  '': 'npc',
};

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
  return branch(
    key,
    [
      leaf('当前', 'resourceCurrent', {
        field: `CharacterState.${cur}`,
        kernel: cur,
        rule: 'resourceCurrent',
      }),
      branch(
        '上限',
        [
          leaf('_基础', 'capBase', { field: `calcResources(tier, attributes).${cap}（不落库）` }),
          leaf('额外', 'capBonus', {
            field: `CharacterState.${cap}Bonus`,
            kernel: `${cap}Bonus`,
            rule: 'capBonus',
          }),
        ],
        {
          field: `CharacterState.${cap}（有效总值 = max(1, 基础 + 额外)）`,
          kernel: cap,
          rule: 'capTotal',
          scalarLeaf: 'capBonus',
          note: '写成单个数时按「额外 = 该数 − 基础」纠正',
        },
      ),
    ],
    { kernel: cur },
  );
}

/** 物品条目的公共叶子；`withSlot` 为装备字典（带 `位置`）。 */
function itemEntry(withSlot: boolean): StateTreeBranchSpec {
  const f = (kernel: string) => ({
    field: `InventoryItem.${kernel}`,
    kernel,
    rule: 'itemField' as const,
  });
  return branch(
    '{物品名}',
    [
      enumLeaf('品质', 'rarity', f('rarity')),
      enumLeaf('类型', 'itemType', f('type')),
      leaf('数量', 'quantity', {
        field: 'InventoryItem.quantity',
        kernel: 'quantity',
        rule: 'itemQuantity',
        ...(withSlot ? { optional: true, note: '只在大于 1 时投影' } : {}),
      }),
      ...(withSlot
        ? [
            leaf('位置', 'slot', {
              field: 'InventoryItem.equippedSlot',
              kernel: 'equippedSlot',
              rule: 'itemSlot',
            }),
          ]
        : []),
      leaf('标签', 'textArray', f('tags')),
      leaf('效果', 'effectDict', f('effects')),
      leaf('描述', 'text', f('description')),
      leaf('属性', 'numberDict', { ...f('stats'), optional: true }),
      branch(
        '耐久',
        [
          leaf('当前', 'number', { ...f('durability'), field: 'InventoryItem.durability' }),
          leaf('上限', 'number', { ...f('maxDurability'), field: 'InventoryItem.maxDurability' }),
        ],
        { optional: true, rule: 'itemField' },
      ),
      leaf('规则文本', 'text', { ...f('protocolText'), optional: true }),
    ],
    { entity: 'item', field: 'InventoryItem', rule: 'itemEntity' },
  );
}

/** 技能叶子的映射（字段说明 = `Skill.<内核键>`）。 */
const skillField = (kernel: string) => ({
  field: `Skill.${kernel}`,
  kernel,
  rule: 'skillField' as const,
});

const SKILL_ENTRY = branch(
  '{技能名}',
  [
    enumLeaf('品质', 'rarity', skillField('rarity')),
    enumLeaf('类型', 'skillType', skillField('type')),
    leaf('消耗', 'skillCost', { ...skillField('cost'), field: 'Skill.cost / Skill.costText' }),
    leaf('冷却', 'number', { ...skillField('cooldown'), optional: true }),
    leaf('标签', 'textArray', skillField('tags')),
    leaf('效果', 'effectDict', skillField('effects')),
    leaf('描述', 'text', skillField('description')),
    leaf('威力', 'number', { ...skillField('skillPower'), optional: true }),
    enumLeaf('关联属性', 'attribute', { ...skillField('relevantAttribute'), optional: true }),
    enumLeaf('伤害类型', 'damageType', { ...skillField('damageType'), optional: true }),
    leaf('规则文本', 'text', { ...skillField('protocolText'), optional: true }),
  ],
  { entity: 'skill', field: 'Skill', rule: 'skillEntity' },
);

/** 状态叶子的映射（字段说明 = `StatusEffect.<内核键>`）。 */
const statusField = (kernel: string) => ({
  field: `StatusEffect.${kernel}`,
  kernel,
  rule: 'statusField' as const,
});

const STATUS_ENTRY = branch(
  '{状态名}',
  [
    enumLeaf('类型', 'statusCategory', statusField('category')),
    leaf('描述', 'text', statusField('description')),
    leaf('效果', 'effectDict', statusField('effectDescriptions')),
    leaf('层数', 'stacks', { ...statusField('stacks'), rule: 'statusStacks' }),
    leaf('层数上限', 'number', { ...statusField('maxStacks'), optional: true }),
    leaf('剩余时间', 'duration', {
      field: 'StatusEffect.remainingTime + timeUnit / StatusEffect.durationText',
      kernel: 'remainingTime',
      rule: 'statusDuration',
    }),
    leaf('来源', 'text', statusField('source')),
  ],
  { entity: 'statusEffect', field: 'StatusEffect', rule: 'statusEntity' },
);

const ASCENSION_SPEC = branch(
  '登神长阶',
  [
    leaf('是否开启', 'boolean', { field: 'ascension.enabled', kernel: 'enabled' }),
    record(
      '要素',
      branch(
        '{要素名}',
        [
          leaf('描述', 'text', { field: 'ElementDetail.description', kernel: 'description' }),
          leaf('效果', 'effectDict', {
            field: 'ElementDetail.effectDescriptions',
            kernel: 'effectDescriptions',
          }),
        ],
        { entity: 'ascensionElement' },
      ),
      { field: 'ascension.elements', kernel: 'elements' },
    ),
    record(
      '权能',
      branch(
        '{权能名}',
        [
          leaf('描述', 'text', { field: 'AuthorityDetail.description', kernel: 'description' }),
          leaf('效果', 'effectDict', {
            field: 'AuthorityDetail.effectDescriptions',
            kernel: 'effectDescriptions',
          }),
          leaf('消耗', 'text', {
            field: 'AuthorityDetail.costDescription',
            kernel: 'costDescription',
          }),
        ],
        { entity: 'ascensionAuthority' },
      ),
      { field: 'ascension.authority', kernel: 'authority' },
    ),
    record(
      '法则',
      branch(
        '{法则名}',
        [
          leaf('描述', 'text', { field: 'LawDetail.description', kernel: 'description' }),
          leaf('效果', 'effectDict', {
            field: 'LawDetail.effectDescriptions',
            kernel: 'effectDescriptions',
          }),
          leaf('消耗', 'text', { field: 'LawDetail.costDescription', kernel: 'costDescription' }),
        ],
        { entity: 'ascensionLaw' },
      ),
      { field: 'ascension.law', kernel: 'law' },
    ),
    leaf('神位', 'text', { field: 'ascension.deityPosition', kernel: 'deityPosition' }),
    branch(
      '神国',
      [
        leaf('名称', 'text', { field: 'ascension.divineKingdom.name', kernel: 'name' }),
        leaf('描述', 'text', {
          field: 'ascension.divineKingdom.description',
          kernel: 'description',
        }),
      ],
      { field: 'ascension.divineKingdom', kernel: 'divineKingdom' },
    ),
  ],
  {
    field: 'CharacterState.ascension',
    kernel: 'ascension',
    rule: 'ascension',
    note: '任意写都按「影子现值 + 本条」重建整份',
  },
);

// ========== 人物节点 ==========

/** 档案文字叶子（`CharacterState.<内核键>`）。 */
const profileText = (kernel: string) => ({
  field: `CharacterState.${kernel}`,
  kernel,
  rule: 'profileText' as const,
});

/** 档案列表叶子。 */
const profileList = (kernel: string) => ({
  field: `CharacterState.${kernel}`,
  kernel,
  rule: 'profileList' as const,
});

/**
 * 人物节点的子键（主角与关系列表共用；每个直接子键是一个缓存分区，§3.4）。
 * 带 `relationOnly` 的只出现在关系列表的人物上。
 */
export const PERSON_NODE_CHILDREN: readonly StateTreeNodeSpec[] = [
  branch(
    '档案',
    [
      leaf('种族', 'text', profileText('race')),
      leaf('性别', 'text', profileText('gender')),
      leaf('身份', 'textArray', profileList('identity')),
      leaf('职业', 'textArray', profileList('occupation')),
      leaf('_年龄', 'number', { field: 'ageAt(ageAnchor, gameTime)（现算）' }),
      leaf('_生日', 'text', { field: 'CharacterState.ageAnchor 的生日' }),
      leaf('外貌', 'text', profileText('appearance')),
      leaf('着装', 'text', profileText('outfit')),
      leaf('性格', 'text', profileText('personality')),
      leaf('背景故事', 'text', profileText('background')),
      leaf('类别', 'text', {
        field: 'CharacterState.type（怪物 / 召唤物）',
        kernel: 'type',
        rule: 'category',
        optional: true,
        relationOnly: true,
      }),
    ],
    { note: '文字字段的路径写入转成 update_character 补丁（§5.5，2026-11-25 更正）' },
  ),
  branch('成长', [
    leaf('_生命层级', 'number', { field: 'CharacterState.tier' }),
    leaf('等级', 'number', {
      field: 'CharacterState.level',
      kernel: 'level',
      rule: 'level',
      playerReadonly: true,
      note: 'NPC 可写（代码随之推出层级、重算基础上限）；主角只读，请改累计经验值',
    }),
    leaf('累计经验值', 'number', {
      field: 'CharacterState.totalExp',
      kernel: 'totalExp',
      rule: 'totalExp',
    }),
    leaf('_升级所需经验', 'number', { field: 'CharacterState.expToNext' }),
    leaf('_属性点', 'number', { field: 'CharacterState.freeAttrPoints' }),
    branch(
      '_属性',
      (Object.keys(ATTRIBUTE_LABELS) as Array<keyof typeof ATTRIBUTE_LABELS>).map((k) =>
        leaf(ATTRIBUTE_LABELS[k], 'number', { field: `CharacterState.attributes.${k}`, kernel: k }),
      ),
      { field: 'CharacterState.attributes', kernel: 'attributes' },
    ),
  ]),
  resource('生命值', 'hp'),
  resource('法力值', 'mp'),
  resource('体力值', 'sp'),
  leaf('金钱', 'money', { field: 'CharacterState.money', kernel: 'money', rule: 'money' }),
  leaf('当前行动', 'text', {
    field: 'CharacterState.currentAction',
    kernel: 'currentAction',
    rule: 'personText',
  }),
  leaf('心里话', 'text', {
    field: 'CharacterState.thoughts',
    kernel: 'thoughts',
    rule: 'personText',
  }),
  record('背包', itemEntry(false), {
    field: 'CharacterState.inventory（equippedSlot 为空）',
  }),
  record('装备', itemEntry(true), {
    field: 'CharacterState.inventory（equippedSlot 非空）',
  }),
  record('技能', SKILL_ENTRY, { field: 'CharacterState.skills' }),
  record('状态效果', STATUS_ENTRY, { field: 'CharacterState.statusEffects' }),
  ASCENSION_SPEC,
  leaf('在场', 'boolean', {
    field: 'CharacterState.present',
    kernel: 'present',
    rule: 'present',
    relationOnly: true,
  }),
  leaf('地点', 'location', {
    field: 'CharacterState.location',
    kernel: 'location',
    rule: 'location',
    relationOnly: true,
    note: '主角的地点投影在 /世界/地点',
  }),
  leaf('好感度', 'affection', {
    field: 'SaveProfile.affections[名]',
    kernel: 'affections',
    rule: 'affection',
    relationOnly: true,
  }),
  leaf('数量', 'quantity', {
    field: 'CharacterState.quantity（怪物 / 召唤物集群）',
    kernel: 'quantity',
    rule: 'groupQuantity',
    relationOnly: true,
    optional: true,
  }),
];

function personNode(key: string, relation: boolean): StateTreeBranchSpec {
  return branch(
    key,
    PERSON_NODE_CHILDREN.filter((c) => relation || !c.relationOnly),
    { entity: 'character', field: 'CharacterState', rule: 'characterEntity' },
  );
}

// ========== 整棵树 ==========

/** 任务叶子（`Quest.<内核键>`）。 */
const questField = (kernel: string) => ({
  field: `Quest.${kernel}`,
  kernel,
  rule: 'questField' as const,
});

/** `stat_data` 的根（§3.1 骨架）。 */
export const STATE_TREE_SPEC: StateTreeBranchSpec = branch('stat_data', [
  branch('世界', [
    leaf('时间', 'gameTime', {
      field: 'SaveProfile.gameTime（formatGameTime 规范串）',
      kernel: 'gameTime',
      rule: 'time',
      note: '只能前进，汇总成本楼分钟数交给 applyTimeAdvance',
    }),
    leaf('地点', 'location', {
      field: '主角 CharacterState.location',
      kernel: 'location',
      rule: 'worldLocation',
    }),
    leaf('_时段', 'text', { field: '由游戏时间推导' }),
    leaf('_天气', 'text', { field: 'worldFlags.map 天气' }),
    leaf('_回合', 'number', { field: '当前回合号' }),
  ]),
  leaf('命运点数', 'fatePoints', {
    field: 'SaveProfile.fp（走账本）',
    kernel: 'fp',
    rule: 'fatePoints',
  }),
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
        enumLeaf('状态', 'questStatus', questField('status')),
        enumLeaf('关注度', 'questPriority', questField('priority')),
        leaf('进展', 'text', questField('progress')),
        leaf('详情', 'text', questField('detail')),
        leaf('目标', 'text', questField('objective')),
        leaf('奖励', 'text', questField('reward')),
      ],
      { entity: 'quest', field: 'Quest', rule: 'questEntity' },
    ),
    { field: 'SaveProfile.quests' },
  ),
  record(
    '新闻',
    record('{栏目}', leaf('{标题}', 'text', { field: 'NewsItem.content', kernel: 'content' }), {
      field: 'NewsItem.category',
      kernel: 'category',
    }),
    {
      field: 'SaveProfile.news',
      kernel: 'news',
      rule: 'news',
      note: '只投最近若干条，只增不删',
    },
  ),
  leaf('变量', 'variables', {
    field: 'SaveProfile.variables（ADR-30 vars 空间，键不翻译）',
    kernel: 'variables',
    rule: 'variables',
  }),
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
  /**
   * 写入规则：只读 → `readonly`；否则取节点声明的 `rule`，再取祖先向下继承的规则（`ascension` / `news`），
   * 分支 / 字典缺省 `expand`。可写叶子没声明规则时为 undefined（闸门测试拦下）。
   */
  readonly rule: StateTreeWriteRule | undefined;
}

/** 把整棵树展平成路径模式清单（深度优先，根自身不列）。协议文字、翻译层与闸门测试用。 */
export function listStateTreePaths(
  root: StateTreeBranchSpec = STATE_TREE_SPEC,
): StateTreePathRow[] {
  const rows: StateTreePathRow[] = [];
  const walk = (
    node: StateTreeNodeSpec,
    prefix: string,
    inheritedReadonly: boolean,
    inheritedRule: StateTreeWriteRule | undefined,
  ): void => {
    const pattern = `${prefix}/${node.key}`;
    const readonly = inheritedReadonly || isReadonlyKey(node.key);
    const own = node.rule ?? inheritedRule;
    const rule: StateTreeWriteRule | undefined = readonly
      ? 'readonly'
      : (own ?? (node.type === 'leaf' ? undefined : 'expand'));
    rows.push({ pattern, spec: node, readonly, rule });
    const pass = own !== undefined && INHERITED_RULES.has(own) ? own : undefined;
    if (node.type === 'branch') {
      for (const c of node.children) walk(c, pattern, readonly, pass);
    } else if (node.type === 'record') {
      walk(node.entry, pattern, readonly, pass);
    }
  };
  for (const c of root.children) walk(c, '', false, undefined);
  return rows;
}

let rowIndex: ReadonlyMap<string, StateTreePathRow> | null = null;

/** 按路径模式取词表行（模式即 `listStateTreePaths` 的 `pattern`）；不在词表里返回 undefined。 */
export function stateTreeRowAt(pattern: string): StateTreePathRow | undefined {
  rowIndex ??= new Map(listStateTreePaths().map((r) => [r.pattern, r]));
  return rowIndex.get(pattern);
}

/** 取一个分支节点（翻译层按路径模式拿实体形状用）；不是分支即抛 —— 词表与调用方脱节是编程错误。 */
export function stateTreeBranchAt(pattern: string): StateTreeBranchSpec {
  const spec = stateTreeRowAt(pattern)?.spec;
  if (spec?.type === 'branch') return spec;
  if (spec?.type === 'record' && spec.entry.type === 'branch') return spec.entry;
  throw new Error(`词表里没有分支 ${pattern}`);
}

/** 分支下的子键（按词表顺序）。 */
export function stateTreeChildKeys(parent: StateTreeBranchSpec): string[] {
  return parent.children.map((c) => c.key);
}

/** 分支下某个键（精确匹配）对应的内核字段键；不是该分支的键或没有内核映射时返回 undefined。 */
export function stateTreeKernelOf(parent: StateTreeBranchSpec, key: string): string | undefined {
  return parent.children.find((c) => c.key === key)?.kernel;
}

/** 分支下内核字段为 `kernel` 的子键（反查）。 */
export function stateTreeKeyOfKernel(
  parent: StateTreeBranchSpec,
  kernel: string,
): string | undefined {
  return parent.children.find((c) => c.kernel === kernel)?.key;
}

/**
 * 名字字典的键：路径倒数第二段是其中之一时，终点是条目根（背包 / 装备 / 技能 / 状态效果 / 关系列表 /
 * 任务列表 / 要素 / 权能 / 法则）。不含 `{…}` 占位的字典与 `新闻` 子树（新闻按栏目 / 标题两层另判）。
 */
export const STATE_TREE_NAMED_RECORD_KEYS: ReadonlySet<string> = new Set(
  listStateTreePaths()
    .filter((r) => r.spec.type === 'record' && !r.spec.key.startsWith('{') && r.rule !== 'news')
    .map((r) => r.spec.key),
);

/**
 * 会被 `数量` / `层数` 减没的名字字典（字典键 → 可减没的叶子键）：物品与状态条目下
 * 叶子类型为 `quantity` / `stacks` 的那一个。
 */
export const STATE_TREE_DEPLETABLE_LEAF: Readonly<Record<string, string>> = Object.fromEntries(
  listStateTreePaths().flatMap((r) => {
    if (r.spec.type !== 'record' || r.spec.entry.type !== 'branch') return [];
    const entity = r.spec.entry.entity;
    if (entity !== 'item' && entity !== 'statusEffect') return [];
    const leafNode = r.spec.entry.children.find(
      (c) => c.type === 'leaf' && (c.leaf === 'quantity' || c.leaf === 'stacks'),
    );
    return leafNode ? [[r.spec.key, leafNode.key] as const] : [];
  }),
);
