/**
 * patch-rehearsal.ts — 建补丁预演（纯内存，无 I/O）
 *
 * 给一份角色快照 + 一串 StatePatch，按顺序逐条判定能否在提交时落下。提交时注定抛错的补丁
 * 在这里先被判出来，由调用方丢掉。直出建补丁（agents/direct-output.ts）用它。
 *
 * 📌 2026-11-25（审查报告 R5c）：不再手写一份「物品数量 / 技能名」的镜像，而是把角色类补丁
 * 交给提交时那同一份纯变换（`patch-reducer.ts`）去跑 —— 作用在预演自己的角色工作副本上，
 * 所以能落 / 抛什么错与 StateManager 提交时逐字一致。档案域补丁（变量、任务、好感、新闻、
 * 人物增删改名）不在预演范围内：只做静态形状校验，照旧放行。
 */
import type { CharacterState, StatePatch } from '../types/types';
import {
  isCharacterPatchOp,
  readTransferItemRequest,
  reduceCharacterPatch,
  reduceTransferItem,
} from './patch-reducer';
import { characterKeyOfTarget, resolveCharacterByName, validateStatePatch } from './patch-rules';

/** 预演进度：原角色 → 它当前的工作副本（副本只整份替换、从不就地改，浅拷这张表即可回滚）。 */
type RehearsalSnapshot = Map<CharacterState, CharacterState>;

/**
 * 角色工作副本：JSON 往返而不是 structuredClone —— 调用方传进来的可能是前端响应式代理，
 * structuredClone 碰到 Proxy 直接抛 DataCloneError；预演只看补丁能不能落，丢掉 undefined 键无妨。
 */
function cloneCharacter(character: CharacterState): CharacterState {
  return JSON.parse(JSON.stringify(character)) as CharacterState;
}

/**
 * 按补丁顺序预演角色类补丁，提前找出提交时必抛的补丁（物品不存在、数量不足、自我转移、
 * 槽位无法识别、堆叠穿戴、技能不存在、update_character 白名单外的键……）。
 * 预演只读传进来的角色快照，不改它们。
 */
export class PatchRehearsal {
  private working: RehearsalSnapshot = new Map();

  constructor(private readonly characters: readonly CharacterState[]) {}

  /** 某个角色在预演里的当前样子（还没被补丁碰过的就是原对象本身，只读）。 */
  private current(character: CharacterState): CharacterState {
    return this.working.get(character) ?? character;
  }

  /** 记下当前预演进度，供一组补丁（替换的删旧 + 加新）失败时整组回滚 */
  snapshot(): RehearsalSnapshot {
    return new Map(this.working);
  }

  restore(snapshot: RehearsalSnapshot): void {
    this.working = new Map(snapshot);
  }

  private resolve(key: string): CharacterState {
    return resolveCharacterByName(this.characters, key);
  }

  /** 检查一条补丁；能落就返回「落下」的预演动作，不能落就抛错（文案即提交时的报错） */
  vet(patch: StatePatch): () => void {
    validateStatePatch(patch);
    const key = characterKeyOfTarget(patch.target);
    if (key === undefined) return () => undefined;
    const owner = this.resolve(key);
    if (patch.op === 'transfer_item') {
      const request = readTransferItemRequest(patch);
      const receiver = this.resolve(request.to);
      const from = cloneCharacter(this.current(owner));
      // 自我转移时两边是同一个角色：reducer 按 id 拦下（克隆保留 id）
      const to = receiver === owner ? from : cloneCharacter(this.current(receiver));
      reduceTransferItem(from, to, request);
      return () => {
        this.working.set(owner, from);
        this.working.set(receiver, to);
      };
    }
    if (!isCharacterPatchOp(patch.op)) return () => undefined;
    // 按槽位卸下（不带名字）也走 reducer：工作副本已按补丁顺序落下同批的 equip / 拆分，
    // 槽位真空着就在这里抛「该槽位无穿戴」，与提交时一致（2026-11-27 起不再放行）
    const next = cloneCharacter(this.current(owner));
    // 补丁也拷一份：reducer 会把补丁里的值并进角色，预演不与要提交的补丁共享引用
    reduceCharacterPatch(next, structuredClone(patch));
    return () => {
      this.working.set(owner, next);
    };
  }
}
