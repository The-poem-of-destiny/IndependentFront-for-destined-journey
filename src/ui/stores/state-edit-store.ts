/**
 * 状态编辑 store（状态树协议 T11 / T13，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §11、§12）
 *
 * 变量修改器与每楼更新块修订的唯一 UI 写入编排：从库新读快照、整批提交、撤销凭据栈、
 * 跳转定位路径、更新块逐条补差的试算与提交。写入全走引擎 `StateManager.commitPlayerEdit` /
 * `undoPlayerEdit`；活跃存档、消息与锁定判据读 game-store（2026-11-25 审查 R6 从 game-store 拆出）。
 *
 * 🔴 「最新一楼」判定只认 `state-update-view.ts` 的 `latestUpdateFloorId`（与更新块界面同一份）。
 * 🔴 撤销栈只在内存：换回合、切存档 / 时间线恢复（game-store `sessionEpoch`）、离开游戏页即清空。
 */
import { defineStore } from 'pinia';
import { computed, markRaw, ref, watch } from 'vue';
import type { CharacterState, SaveProfile, StateUpdateRecord } from '@engine/types/types';
import { getCharacters, getSaveProfile } from '@engine/persistence/database';
import { createStateManager } from '@engine/state/state-manager';
import {
  planUpdateBlockRevision,
  type PlayerEditCommitResult,
  type PlayerEditOp,
  type PlayerEditRecordWriteback,
  type PlayerEditUndoResult,
  type PlayerEditUndoToken,
  type RevisionOptions,
  type RevisionPlan,
  type UpdateBlockRevision,
} from '@engine/variables/state-tree-edit';
import type { TreeTranslateSnapshot } from '@engine/variables/state-tree-translator';
import { latestUpdateFloorId } from '../components/game/state-update-view';
import { useGameStore } from './game-store';

export const useStateEditStore = defineStore('state-edit', () => {
  const game = useGameStore();

  // === 变量修改器（T11，设计 §11） ===

  /**
   * 撤销栈（§11.4）：只在内存里，换回合、切存档、离开游戏页即清空。更早的后悔药是快照。
   * 每项是引擎给的撤销凭据（提交前的内核快照 + 提交后的指纹，2026-11-25 审查 R4），
   * 撤销时由 `StateManager.undoPlayerEdit` 核对指纹后整体还原。
   */
  const stateEditUndoStack = ref<{ label: string; undo: PlayerEditUndoToken }[]>([]);

  function clearStateEditUndo() {
    stateEditUndoStack.value = [];
  }

  /** 最新一条玩家输入的回合号：变了 = 换回合（新回合开始、回退、恢复快照都算）。 */
  const latestUserTurn = computed(() => {
    for (let i = game.messages.length - 1; i >= 0; i--) {
      const m = game.messages[i];
      if (m.role === 'user') return m.turn ?? 0;
    }
    return 0;
  });
  watch(latestUserTurn, () => clearStateEditUndo());

  /**
   * 修改器的整面守卫：回合生成中、正文润色中、战斗中不写（与玩家人设编辑同一组判据，另加润色中）。
   * 措辞由面板经 state-editor-view 的 `stateEditorLockReason` 给出，这里只是写入前的第二道闸。
   */
  function stateEditBlocked(): string | null {
    if (game.isGenerating) return '当前回合生成中，结束后才能修改变量';
    if (game.isRewriting) return '正文润色中，结束后才能修改变量';
    if (game.isInCombat) return '战斗进行中，结束后才能修改变量';
    return null;
  }

  /**
   * 修改器每次打开 / 提交后从库里新读一份内核状态（§11.1：不用 store 里可能陈旧的副本）。
   * 没有活跃存档时返回 null。
   */
  async function readStateEditorSnapshot(): Promise<TreeTranslateSnapshot | null> {
    const saveId = game.activeSaveId;
    if (!saveId) return null;
    const [chars, profile] = await Promise.all([getCharacters(saveId), getSaveProfile(saveId)]);
    if (saveId !== game.activeSaveId || !profile) return null;
    return { characters: chars as CharacterState[], profile: profile as SaveProfile };
  }

  /** 提交成功后回读活表：角色整表以库为准（删 NPC 时合并语义的 refreshFromDb 留不住删除）。 */
  async function reloadAfterStateEdit(saveId: string) {
    await game.refreshFromDb(saveId);
    if (saveId !== game.activeSaveId) return;
    const dbIds = new Set(((await getCharacters(saveId)) as CharacterState[]).map((c) => c.id));
    if (saveId !== game.activeSaveId) return;
    if (game.characters.some((c) => !dbIds.has(c.id))) {
      game.characters = game.characters.filter((c) => dbIds.has(c.id));
    }
  }

  async function runPlayerEdit(
    ops: readonly PlayerEditOp[],
    record?: PlayerEditRecordWriteback,
  ): Promise<PlayerEditCommitResult> {
    const saveId = game.activeSaveId;
    if (!saveId) return { ok: false, reasons: ['无活跃存档'], records: [], dropped: [] };
    const blocked = stateEditBlocked();
    if (blocked) return { ok: false, reasons: [blocked], records: [], dropped: [] };
    try {
      const result = await createStateManager(saveId).commitPlayerEdit(ops, {
        isCurrent: () => game.activeSaveId === saveId,
        ...(record ? { record } : {}),
      });
      if (result.ok && game.activeSaveId === saveId) {
        if (record && result.stateUpdates)
          replaceMessageStateUpdates(record.messageId, result.stateUpdates);
        await reloadAfterStateEdit(saveId);
      }
      return result;
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      if (!aborted) console.error('[state-edit-store] 变量修改提交失败:', error);
      return {
        ok: false,
        reasons: [aborted ? '存档已切换，本次修改未提交' : '提交失败，请重试'],
        records: [],
        dropped: [],
      };
    }
  }

  /**
   * 提交一批玩家编辑（§11.2：整批原子）。成功后回读活表，面板与状态面板随之刷新；
   * 自动存档（useAutosave 监听角色 / 档案变化）会把结果覆写进本轮快照。
   */
  async function commitStateEdit(
    ops: readonly PlayerEditOp[],
    label: string,
    record?: PlayerEditRecordWriteback,
  ): Promise<PlayerEditCommitResult> {
    // 提交在途时若切档 / 时间线恢复（sessionEpoch 变了），撤销栈已清空，旧凭据不能再压进新会话
    const epoch = game.sessionEpoch;
    const result = await runPlayerEdit(ops, record);
    // 凭据里是整份内核快照，不需要响应式（markRaw 免得深代理一遍）
    if (result.ok && game.sessionEpoch === epoch)
      stateEditUndoStack.value.push({ label, undo: markRaw(result.undo) });
    return result;
  }

  /**
   * 撤销上一次修改（§11.4；2026-11-25 审查 R4）：引擎核对指纹后按快照整体还原，
   * 更新块修订的那楼记录一并还原。成功才出栈；指纹不符时原样返回拒绝原因。
   */
  async function undoLastStateEdit(): Promise<PlayerEditUndoResult> {
    const top = stateEditUndoStack.value[stateEditUndoStack.value.length - 1];
    if (!top) return { ok: false, reasons: ['没有可撤销的修改'] };
    const saveId = game.activeSaveId;
    if (!saveId) return { ok: false, reasons: ['无活跃存档'] };
    const blocked = stateEditBlocked();
    if (blocked) return { ok: false, reasons: [blocked] };
    let result: PlayerEditUndoResult;
    try {
      result = await createStateManager(saveId).undoPlayerEdit(top.undo, {
        isCurrent: () => game.activeSaveId === saveId,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      if (!aborted) console.error('[state-edit-store] 撤销变量修改失败:', error);
      return { ok: false, reasons: [aborted ? '存档已切换，本次撤销未执行' : '撤销失败，请重试'] };
    }
    if (!result.ok || game.activeSaveId !== saveId) return result;
    if (stateEditUndoStack.value[stateEditUndoStack.value.length - 1] === top)
      stateEditUndoStack.value.pop();
    if (result.message) replaceMessageStateUpdates(result.message.id, result.message.stateUpdates);
    await reloadAfterStateEdit(saveId);
    return result;
  }

  /** 同步内存里那条消息的 `stateUpdates` 展示副本（库已在引擎事务里写好）。 */
  function replaceMessageStateUpdates(messageId: string, stateUpdates: StateUpdateRecord) {
    const index = game.messages.findIndex((m) => m.id === messageId);
    if (index >= 0)
      game.messages.splice(index, 1, { ...game.messages[index], stateUpdates: stateUpdates });
  }

  // === 每楼变量更新块（T13，设计 §12） ===

  /**
   * 打开变量修改器时要定位到的路径（更新块「在变量修改器中打开此路径」）。
   * 面板读到后经 `consumeStateEditorFocus` 取走清空，只生效一次。
   */
  const stateEditorFocusPath = ref<string | null>(null);

  function openStateEditorAt(path: string) {
    stateEditorFocusPath.value = path;
    game.activeModal = 'variables';
  }

  function consumeStateEditorFocus(): string | null {
    const path = stateEditorFocusPath.value;
    stateEditorFocusPath.value = null;
    return path;
  }

  /**
   * 最新一楼的守卫：目标必须是最后一条已接纳正文且带记录（UI 也把守，这里是第二道闸）。
   * 判定与更新块界面同一份（`latestUpdateFloorId`）。
   */
  function latestUpdateFloor(messageId: string) {
    if (latestUpdateFloorId(game.messages) !== messageId) return null;
    return game.messages.find((m) => m.id === messageId) ?? null;
  }

  /**
   * 更新块逐条补差的试算（§12.3）：从库里新读当前状态，对本楼那一行算补偿 op 与预览。
   * `index` 为 null 表示「新增一条」。不落库。
   */
  async function planStateUpdateRevision(
    messageId: string,
    index: number | null,
    revision: UpdateBlockRevision,
    options: RevisionOptions = {},
  ): Promise<RevisionPlan> {
    const msg = latestUpdateFloor(messageId);
    if (!msg?.stateUpdates) return { kind: 'invalid', reasons: ['只有最新一楼的状态更新可以修订'] };
    const blocked = stateEditBlocked();
    if (blocked) return { kind: 'invalid', reasons: [blocked] };
    const record = index === null ? null : (msg.stateUpdates.ops[index] ?? null);
    if (index !== null && !record) return { kind: 'invalid', reasons: ['找不到这一行记录'] };
    const snapshot = await readStateEditorSnapshot();
    if (!snapshot) return { kind: 'invalid', reasons: ['读取存档状态失败'] };
    return planUpdateBlockRevision(record, revision, snapshot, options);
  }

  /**
   * 提交一次更新块修订：补偿 op 走 `commitStateEdit`（整批原子，与变量修改器同一个写入口），
   * 本楼记录的改写（`applyRevisionToRecord`，只换 `stateUpdates`，正文不变 §12.3）由引擎
   * 并入同一事务：记录写回失败则状态一并回滚（2026-11-25 审查 R4）。撤销栈的凭据也带上
   * 这楼记录，从修改器撤销时一并还原。
   */
  async function commitStateUpdateRevision(
    messageId: string,
    index: number | null,
    revision: UpdateBlockRevision,
    ops: readonly PlayerEditOp[],
    label: string,
  ): Promise<PlayerEditCommitResult> {
    const saveId = game.activeSaveId;
    if (!saveId || !latestUpdateFloor(messageId))
      return {
        ok: false,
        reasons: ['只有最新一楼的状态更新可以修订'],
        records: [],
        dropped: [],
      };
    return commitStateEdit(ops, label, { messageId, index, revision });
  }

  // 会话运行时被清空（切存档 / 离开存档上下文 / 时间线恢复）时同步清掉本店的内存态：
  // 与原先写在 game-store `clearSessionRuntime` 里同一拍生效，所以用 sync。
  watch(
    () => game.sessionEpoch,
    () => {
      clearStateEditUndo();
      stateEditorFocusPath.value = null;
    },
    { flush: 'sync' },
  );

  return {
    stateEditUndoStack,
    clearStateEditUndo,
    readStateEditorSnapshot,
    commitStateEdit,
    undoLastStateEdit,
    stateEditorFocusPath,
    openStateEditorAt,
    consumeStateEditorFocus,
    planStateUpdateRevision,
    commitStateUpdateRevision,
  };
});
