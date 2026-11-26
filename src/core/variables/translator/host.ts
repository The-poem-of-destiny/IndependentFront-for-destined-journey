/**
 * 各职责 handler 看到的翻译器（`core.ts` 的 `TreeTranslator` 实现它）。
 * handler 只经这层接口读写工作状态、落补丁，不直接依赖翻译器本体 —— 子模块之间因此不成环。
 */

import type { ReducibleState } from '../../state/patch-reducer';
import type { CharacterState, StatePatch } from '../../types/types';
import type { ResolvedTreePath, TreePathStyle } from '../state-tree-patch';
import type { OpContext, WorkOp } from './common';
import type { TreeTranslateOptions } from './types';
import type { StateView } from './working-state';

export interface TranslatorHost {
  /** 当前工作状态（每次落补丁后换新版本，读时请当场取）。 */
  readonly state: ReducibleState;
  readonly options: TreeTranslateOptions;
  /** 折叠后的 op 队列（穿戴槽位向后找同批写入用）。 */
  readonly queue: readonly WorkOp[];
  /** 已被折叠 / 消费的 op 序号。 */
  readonly consumed: ReadonlySet<number>;
  /** 本批开始时各人物的类别（按名；改名时跟着搬）。 */
  readonly startTypes: Map<string, CharacterState['type']>;
  /** 本楼新建的人物。 */
  readonly newCharacters: CharacterState[];
  /** 当前工作状态的树视图。 */
  view(): StateView;
  /** 换上新一版工作状态（不经补丁，仅时间推进用）。 */
  setState(next: ReducibleState): void;
  /** 累加本楼推进的分钟数。 */
  addDeltaMinutes(minutes: number): void;
  resolve(segments: readonly string[], style: TreePathStyle, notes: string[]): ResolvedTreePath;
  character(name: string): CharacterState;
  /** 一组补丁整组落或整组丢（失败抛 Drop）。 */
  commit(group: readonly StatePatch[]): void;
  /** 把一个对象写入展开成逐键子 op。 */
  expand(ctx: OpContext, t: ResolvedTreePath, note?: string): void;
}
