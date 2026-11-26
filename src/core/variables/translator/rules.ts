/**
 * 词表映射（审查报告 R6a：键 → 规则 / 内核字段只从 state-tree-spec 读；自 `state-tree-translator.ts` 拆出，行为不变）。
 */

import type { ResourceKey } from '../../character/resource-caps';
import {
  listStateTreePaths,
  stateTreeBranchAt,
  stateTreeKeyOfKernel,
  stateTreeRowAt,
  type StateTreeBranchSpec,
  type StateTreeNodeSpec,
  type StateTreeWriteRule,
} from '../state-tree-spec';
import { Drop, type Row } from './common';

/**
 * 路径模式（`listStateTreePaths` 的 `pattern`）的翻译规则，读自词表（`StateTreeWriteRule`，本模块不再另登记）；
 * 不在词表里返回 undefined。登神长阶下任意路径都按「整份重建」处理（规则由 `登神长阶` 节点向下继承）。
 */
export function stateTreeTranslationRuleOf(pattern: string): StateTreeWriteRule | undefined {
  return stateTreeRowAt(pattern)?.rule;
}

/** 路径模式对应的内核字段键（词表 `kernel`）；闸门测试据此核对「每个可写叶子都映射到内核字段」。 */
export function stateTreeKernelFieldOf(pattern: string): string | undefined {
  return stateTreeRowAt(pattern)?.spec.kernel;
}

// 各实体的形状（键、内核字段、规则）一律取自词表
export const PERSON_SPEC = stateTreeBranchAt('/关系列表/{人物名}');
export const PROFILE_SPEC = stateTreeBranchAt('/关系列表/{人物名}/档案');
export const GROWTH_SPEC = stateTreeBranchAt('/关系列表/{人物名}/成长');
export const EQUIP_ITEM_SPEC = stateTreeBranchAt('/主角/装备/{物品名}');
export const BAG_ITEM_SPEC = stateTreeBranchAt('/主角/背包/{物品名}');
export const SKILL_SPEC = stateTreeBranchAt('/主角/技能/{技能名}');
export const STATUS_SPEC = stateTreeBranchAt('/主角/状态效果/{状态名}');
export const ASCENSION_SPEC = stateTreeBranchAt('/主角/登神长阶');
export const QUEST_SPEC = stateTreeBranchAt('/任务列表/{任务名}');

/** 档案文字 / 列表叶子的内核字段（词表 `档案` 下 profileText / profileList 规则的 `kernel`）。 */
export type ProfileTextField =
  'race' | 'gender' | 'appearance' | 'outfit' | 'personality' | 'background';
export type ProfileListField = 'identity' | 'occupation';

/** 分支下按键（精确）取子节点。 */
export function childOf(parent: StateTreeBranchSpec, key: string): StateTreeNodeSpec | undefined {
  return parent.children.find((c) => c.key === key);
}

/** 分支下内核字段为 `kernel` 的子键；词表里没有即抛（编程错误）。 */
export function keyOf(parent: StateTreeBranchSpec, kernel: string): string {
  const key = stateTreeKeyOfKernel(parent, kernel);
  if (key === undefined) throw new Error(`词表「${parent.key}」下没有内核字段 ${kernel}`);
  return key;
}

/** 装备条目的位置键（字符串值直写成 `{位置: 值}` 时用）。 */
export const SLOT_KEY = keyOf(EQUIP_ITEM_SPEC, 'equippedSlot');

/** 人物节点下的资源分支（生命值 / 法力值 / 体力值）：键 → 资源与其子键。 */
interface ResourceNode {
  readonly label: string;
  readonly key: ResourceKey;
  readonly current: string;
  readonly cap: string;
  readonly bonus: string;
}

export const RESOURCE_NODES: readonly ResourceNode[] = PERSON_SPEC.children.flatMap((node) => {
  if (node.type !== 'branch') return [];
  const current = node.children.find((c) => c.rule === 'resourceCurrent');
  const cap = node.children.find((c) => c.rule === 'capTotal');
  if (!current || !cap || cap.type !== 'branch') return [];
  const bonus = cap.children.find((c) => c.rule === 'capBonus');
  if (!bonus) return [];
  return [
    {
      label: node.key,
      key: node.kernel as ResourceKey,
      current: current.key,
      cap: cap.key,
      bonus: bonus.key,
    },
  ];
});

export function resourceOf(label: string): ResourceKey {
  const r = RESOURCE_NODES.find((n) => n.label === label);
  if (!r) throw new Drop(`「${label}」不是资源`);
  return r.key;
}

/** 整对象展开时先写的键：上限类键决定「当前」的钳制范围，必须先落（见 `expand`） */
export const CAP_FIRST_KEYS: ReadonlySet<string> = new Set(
  listStateTreePaths()
    .filter((r) => r.rule === 'capTotal' || r.rule === 'capBonus')
    .map((r) => r.spec.key),
);

/** 登神长阶的空树（键与顺序取自词表）：布尔 false、文本空串、字典空对象、分支递归。 */
export function emptyTree(spec: StateTreeBranchSpec): Row {
  const out: Row = {};
  for (const c of spec.children) {
    if (c.type === 'branch') out[c.key] = emptyTree(c);
    else if (c.type === 'record') out[c.key] = {};
    else out[c.key] = c.leaf === 'boolean' ? false : '';
  }
  return out;
}
