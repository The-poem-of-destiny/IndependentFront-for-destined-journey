/**
 * 翻译层的对外类型（由 `state-tree-translator.ts` 原名转出，调用方的导入路径不变）。
 */

import type { CharacterState, StatePatch, StateUpdateOpRecord } from '../../types/types';
import type { CharacterDefinition, CharacterNarrativeUpdate } from '../../types/types-character';
import type { TreeOpIssue } from '../state-tree-patch';
import type { StateTreeProfile } from '../state-tree-projection';

/** 谁在写：AI（直出 / Agent 模式）或玩家（变量修改器、更新块修订，§11.3 的放宽项）。 */
export type TreeTranslateActor = 'ai' | 'player';

/** 翻译所需的内核状态（不会被修改）。 */
export interface TreeTranslateSnapshot {
  readonly characters: readonly CharacterState[];
  readonly profile: StateTreeProfile;
}

export interface TreeTranslateOptions {
  readonly actor: TreeTranslateActor;
  /** 新人物的 `introducedBy`（本楼来源回合键）。 */
  readonly sourceTurnKey?: string;
  /** 作者定义（新人物按名字或别名绑定，同直出现有口径）。 */
  readonly definitions?: readonly CharacterDefinition[];
  /** 本楼的叙事更新（新人物绑定档案用）。 */
  readonly characterUpdates?: readonly CharacterNarrativeUpdate[];
  /** 区块解析阶段的纠正说明（按 op 序号并入该条记录）。 */
  readonly parseNormalized?: readonly TreeOpIssue[];
}

export interface TreeTranslateResult {
  /** 按落下顺序排好的补丁（新人物在前）。 */
  readonly patches: StatePatch[];
  /** 本楼推进的游戏分钟数（交给 applyTimeAdvance，不产补丁）。 */
  readonly deltaMinutes: number;
  /** 本楼新建的人物（已组装，与 add_character 补丁里的是同一份）。 */
  readonly newCharacters: CharacterState[];
  /** 每条 op 一条记录，按 op 原序号排序。 */
  readonly records: StateUpdateOpRecord[];
  /** 「模型原文路径：原因，已忽略」。 */
  readonly dropped: string[];
  /** 「路径：纠正说明」。 */
  readonly normalized: string[];
}
