/**
 * 工作状态：经 patch-reducer 推进的写时复制，以及按分区惰性投影的树视图
 * （审查报告 R5c / R6a；自 `state-tree-translator.ts` 拆出，行为不变）。
 */

import {
  isCharacterPatchOp,
  readTransferItemRequest,
  resolveCharacterTarget,
  type ReducibleState,
  type StateReduceContext,
} from '../../state/patch-reducer';
import { resolveCharacterByName } from '../../state/patch-rules';
import type { CharacterState, StatePatch } from '../../types/types';
import { buildStateTree, type StateTreeValue } from '../state-tree-projection';
import { STATE_TREE_DEPLETABLE_LEAF } from '../state-tree-spec';
import { readStateTreeValue } from './common';
import type { TreeTranslateActor } from './types';

// ========== 工作状态：经 patch-reducer 推进 ==========

/**
 * 翻译层推进工作状态的上下文（审查报告 R5c）：命运点按提交口径（V1：AI 来源扣超余额钳到 0，
 * 玩家编辑不足抛错 —— 抛错即这条 op 被丢）；新闻的账务字段只在工作状态里占位，真值由提交时补。
 */
export function workingReduceContext(
  actor: TreeTranslateActor,
  state: ReducibleState,
): StateReduceContext {
  return {
    fatePoints: { clampSpend: actor === 'ai' },
    newsStamp: () => ({ id: `pending-${state.profile.news.length}`, publishedAt: 0 }),
  };
}

/**
 * 写时复制：补丁作用前，把它要改的角色 / 档案分区在 `next` 里换成深拷副本（同一组里只拷一次）。
 * `next` 的角色数组与档案对象本身已是浅拷；增删角色只动数组，命运点只改档案上的数值，不必再拷。
 * 找不到目标角色时不拷（reducer 随后同样找不到、抛错，整组不落）。
 */
export function cowTouch(next: ReducibleState, patch: StatePatch, copied: Set<object>): void {
  const own = <T extends object>(v: T): T => {
    if (copied.has(v)) return v;
    const c = structuredClone(v);
    copied.add(c);
    return c;
  };
  const touchChar = (resolve: () => CharacterState): void => {
    let char: CharacterState;
    try {
      char = resolve();
    } catch {
      return;
    }
    const at = next.characters.indexOf(char);
    if (at >= 0) next.characters[at] = own(char);
  };
  const p = next.profile;
  if (isCharacterPatchOp(patch.op)) {
    touchChar(() => resolveCharacterTarget(next.characters, patch.target));
    return;
  }
  switch (patch.op) {
    case 'transfer_item':
      touchChar(() => resolveCharacterTarget(next.characters, patch.target));
      touchChar(() => resolveCharacterByName(next.characters, readTransferItemRequest(patch).to));
      return;
    case 'rename_character':
      touchChar(() => resolveCharacterTarget(next.characters, patch.target));
      if (!copied.has(p.affections)) {
        p.affections = { ...p.affections };
        copied.add(p.affections);
      }
      return;
    case 'set_affection':
    case 'delta_affection':
      if (!copied.has(p.affections)) {
        p.affections = { ...p.affections };
        copied.add(p.affections);
      }
      return;
    case 'update_quest':
    case 'remove_quest':
      if (!copied.has(p.quests)) {
        p.quests = { ...p.quests };
        copied.add(p.quests);
      }
      return;
    case 'add_news':
      if (!copied.has(p.news)) {
        p.news = [...p.news];
        copied.add(p.news);
      }
      return;
    case 'set_variable':
    case 'delta_variable':
    case 'remove_variable':
    case 'move_variable':
    case 'insert_variable':
      // 命运点（delta_variable profile.fp）只改档案上的 fp 数值，变量空间不动
      if (patch.op === 'delta_variable' && patch.target === 'profile.fp') return;
      p.variables = own(p.variables);
      return;
    default:
      return;
  }
}

// ========== 状态视图：只投影被读到的分区 ==========

/** 顶层分区（状态树根下的键）。 */
const WORLD_KEY = '世界';
const PLAYER_KEY = '主角';
const RELATION_KEY = '关系列表';
const QUESTS_KEY = '任务列表';
const NEWS_KEY = '新闻';
const VARIABLES_KEY = '变量';

/**
 * 某一版工作状态的树视图（审查报告 R6a 性能修复）：按读到的路径只投影那一个分区 ——
 * `关系列表/<名>` 只投那一个人物，`主角` / `世界` 只带主角，任务 / 新闻 / 变量只带那一份档案切片；
 * 结果按分区缓存。工作状态按写时复制推进（见 `commit`），旧版本的对象永不被改，
 * 视图读到的就是建视图那一刻的值。
 */
export class StateView {
  private readonly cache = new Map<string, StateTreeValue>();

  constructor(private readonly state: ReducibleState) {}

  read(segments: readonly string[]): StateTreeValue | undefined {
    return readStateTreeValue(this.section(segments), segments);
  }

  private section(segments: readonly string[]): StateTreeValue {
    const top: string | undefined = segments[0];
    const personName = top === RELATION_KEY && segments.length >= 2 ? segments[1] : undefined;
    const key = personName !== undefined ? `${RELATION_KEY}/${personName}` : (top ?? '');
    let tree = this.cache.get(key);
    if (tree === undefined) {
      tree = this.project(top, personName);
      this.cache.set(key, tree);
    }
    return tree;
  }

  private project(top: string | undefined, personName: string | undefined): StateTreeValue {
    const { characters, profile } = this.state;
    let chars: readonly CharacterState[];
    if (personName !== undefined) {
      chars = characters.filter((c) => c.type !== 'player' && c.name === personName);
    } else if (top === PLAYER_KEY || top === WORLD_KEY) {
      chars = characters.filter((c) => c.type === 'player');
    } else if (top === undefined || top === RELATION_KEY) {
      chars = characters;
    } else {
      chars = [];
    }
    const whole = top === undefined;
    return buildStateTree(
      {
        characters: chars,
        profile: {
          fp: profile.fp,
          gameTime: profile.gameTime,
          affections: profile.affections,
          quests: whole || top === QUESTS_KEY ? profile.quests : {},
          news: whole || top === NEWS_KEY ? profile.news : [],
          variables: whole || top === VARIABLES_KEY ? profile.variables : {},
        },
      },
      { visibility: { mode: 'all' }, newsLimit: Number.MAX_SAFE_INTEGER },
    );
  }
}

/**
 * 本条把条目减没了（`数量` / `层数` 叶子写入前条目在、写入后不在）时返回条目整对象前值（§12.3），否则 undefined。
 * 供撤销整对象重建、改值先重建再设置。
 */
export function depletedEntry(
  segs: readonly string[],
  beforeTree: StateView,
  afterTree: StateView,
): unknown {
  const n = segs.length;
  // 可减没的字典与叶子取自词表（`STATE_TREE_DEPLETABLE_LEAF`：背包 / 装备 → 数量，状态效果 → 层数）
  if (n < 4 || STATE_TREE_DEPLETABLE_LEAF[segs[n - 3]] !== segs[n - 1]) return undefined;
  const entrySegs = segs.slice(0, -1);
  const before = beforeTree.read(entrySegs);
  if (before === undefined) return undefined;
  return afterTree.read(entrySegs) === undefined ? before : undefined;
}
