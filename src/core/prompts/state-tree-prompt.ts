/**
 * 状态树协议的「状态写入段」（状态树协议 T7，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §4、§5.2、§5.3）
 *
 * `stateProtocol: 'tree'` 时替换 `buildDirectProtocol` 里「顶层键说明 → effects」那几行（接线在 T9a）；
 * 正文外壳、tile_ops 细则、combat、plot、diceUsed 各行与 character_updates 协议不在本段，沿用原文。
 *
 * 🔴 协议里会漂移的词表（顶层键、名字字典、可选槽位、枚举取值、五维）一律由 `variables/state-tree-spec.ts`
 *    插值生成，别手写；`tests/core/prompts/state-tree-prompt-gate.test.ts` 按行钉住每段插值，
 *    并把协议里出现的每条 `/…` 路径与示例 JSON 交给 spec 的查询函数校验。
 * 🔴 已裁定（§9）：不告知模型玩家手改过状态（#18）；槽位不加别名，只列可选值（#6）；
 *    主角等级只读、改累计经验值，NPC 等级可写（#2）；从装备 remove = 物品离开人物，卸下用 move（#11）。
 */

import {
  ATTRIBUTE_LABELS,
  STATE_TREE_ENUM_VALUES,
  STATE_TREE_PATCH_OPS,
  STATE_TREE_SLOT_VALUES,
  STATE_TREE_SPEC,
  listStateTreePaths,
  type StateTreeEnumKind,
  type StateTreePatchOp,
} from '../variables/state-tree-spec';

/** patch 的五个 op 的真源在 `variables/state-tree-spec.ts`，这里转出供协议闸门沿用。 */
export { STATE_TREE_PATCH_OPS };

/** 每个 op 在协议里的一句话语义（键集合由类型钉成恰好五个）。 */
const OP_MEANINGS: Readonly<Record<StateTreePatchOp, string>> = {
  replace: '设值',
  add: '往名字字典新增整条（已存在则叠数量、叠层或合并字段）',
  remove: '删除条目',
  delta: '数值叶子加 value，可为负',
  move: '从 from 移到 path',
};

/** 只读约定句（§3.3）。闸门按原句断言，改措辞要同步改闸门。 */
export const STATE_TREE_READONLY_RULE = '以 _ 开头的键只读，由代码维护，不要写';

/** 各枚举在协议「取值：」行里的称呼（键集合由类型钉成与 `StateTreeEnumKind` 一致）。 */
export const STATE_TREE_ENUM_LABELS: Readonly<Record<StateTreeEnumKind, string>> = {
  rarity: '品质',
  itemType: '物品类型',
  statusCategory: '状态类型',
  skillType: '技能类型',
  questStatus: '任务状态',
  questPriority: '关注度',
  attribute: '关联属性',
  damageType: '伤害类型',
};

const slash = (list: readonly string[]): string => list.join('/');

/** 顶层键（`stat_data` 的直接子键）。 */
export const STATE_TREE_ROOT_KEYS: readonly string[] = STATE_TREE_SPEC.children.map((c) => c.key);

/** 名字字典的键（`record` 节点，去重、按出现顺序；名字占位 `{…}` 本身不算）。 */
export const STATE_TREE_RECORD_KEYS: readonly string[] = [
  ...new Set(
    listStateTreePaths()
      .filter((row) => row.spec.type === 'record' && !row.spec.key.startsWith('{'))
      .map((row) => row.spec.key),
  ),
];

/** 五维中文键（新建人物的必需核心）。 */
const ATTRIBUTE_KEYS: readonly string[] = Object.values(ATTRIBUTE_LABELS);

/**
 * 协议里的示例（§4.2 节选）：一次完整的 direct_updates。
 * 闸门会 `JSON.parse` 协议「示例：」行，并逐条核 op 与路径。
 */
export const STATE_TREE_PROTOCOL_EXAMPLE = {
  version: 2,
  patch: [
    { op: 'delta', path: '/世界/时间', value: 45 },
    { op: 'delta', path: '/主角/生命值/当前', value: -30 },
    { op: 'delta', path: '/主角/背包/治疗药水/数量', value: -1 },
    {
      op: 'add',
      path: '/主角/状态效果/流血',
      value: { 类型: '减益', 描述: '伤口渗血', 剩余时间: '3回合' },
    },
    {
      op: 'move',
      from: '/主角/背包/铁剑',
      path: '/主角/装备/铁剑',
      value: STATE_TREE_SLOT_VALUES[0],
    },
    { op: 'delta', path: '/关系列表/艾拉/好感度', value: 5 },
  ],
  plot: {},
  diceUsed: [],
} as const;

const enumLine = (Object.keys(STATE_TREE_ENUM_LABELS) as StateTreeEnumKind[])
  .map((kind) => `${STATE_TREE_ENUM_LABELS[kind]} ${slash(STATE_TREE_ENUM_VALUES[kind])}`)
  .join('；');

/**
 * 状态写入段（多行，每行行首是唯一的定位词）。替换旧协议的顶层键 / 骨架 / world / time / entities /
 * 实体字段 / state / effects 各行。
 */
export const STATE_TREE_WRITE_PROTOCOL = [
  `状态写入：输入状态区块里的 stat_data 就是状态树（顶层 ${slash(STATE_TREE_ROOT_KEYS)}），读写同一棵树；${STATE_TREE_READONLY_RULE}。`,
  'direct_updates 形如 {"version":2,"patch":[],"plot":{},"diceUsed":[]}；patch 是操作数组，按书写顺序逐条生效，无变化写 []。tile_ops、combat 仍是顶层键，没有就省略。',
  `操作：${STATE_TREE_PATCH_OPS.map((op) => `${op} ${OP_MEANINGS[op]}`).join('；')}。每项形如 {"op":"delta","path":"/主角/生命值/当前","value":-30}。`,
  `路径：用 / 连接树上的中文键；名字字典（${slash(STATE_TREE_RECORD_KEYS)}）的下一段是条目名，如 /关系列表/艾拉/好感度。不在场角色只显示摘要，仍可写其任何字段。档案与经历仍写 character_updates。`,
  `新建：往名字字典写一个整对象就是新建，形状与树上同类条目相同，如 add /主角/背包/狼牙 值 {"类型":"材料","数量":2,"描述":"…"}。新人物写 /关系列表/新名，必须带 成长.等级、成长.属性{${ATTRIBUTE_KEYS.join(',')}}、地点、在场，缺一则整个人物不入库。remove /关系列表/名 只用于怪物和召唤物。`,
  `背包与装备：背包放未穿戴的物品，装备放已穿戴的物品。穿戴用 move 从背包到装备，value 写位置；卸下用 move 从装备回背包；remove 背包或装备里的条目表示物品离开人物（用掉、丢弃、被夺），不是卸下。可选位置：${slash(STATE_TREE_SLOT_VALUES)}，同一位置只穿一件，后穿的顶下先穿的。交给别人用 move 到对方的背包，value 可写数量。数量减到 0 即移除。`,
  '数值：剩余时间与技能消耗写文本（如 "3回合"、"永久"、"10MP"）。资源上限只写 上限/额外，_基础 由代码推导。主角的 成长/等级 只读，升级请改 成长/累计经验值；其他人物可写 等级。时间推进只用 delta /世界/时间，value 是本楼耗时分钟（非负）。',
  `取值：${enumLine}。`,
  `示例：${JSON.stringify(STATE_TREE_PROTOCOL_EXAMPLE)}`,
].join('\n');

/**
 * 缓存直出（direct_cached）的对应措辞：替换 `DIRECT_CACHE_PROTOCOL` 里讲 `character/角色名/…` 与
 * `resources` 分区的那几句（接线在 T9a）。分区键即树路径、整块替换、remove 删路径（§3.4）。
 */
export const STATE_TREE_CACHE_PROTOCOL =
  '状态分区的键就是 stat_data 的树路径（如 /世界、/主角/生命值、/关系列表/艾拉/背包、/任务列表/寻找戒指），值整块替换该路径下的全部内容；未出现的路径沿用最近值，remove 删除该路径。每个全量人物的每个直接子键各是一个分区，不在场角色的摘要整块一个分区。空对象表示已清空。';
