import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  SaveSlot,
  CharacterState,
  ChatMessage,
  MemoryRecord,
  PlotEvent,
  PlotOutline,
  CombatState,
  CombatSummaryResult,
  SaveProfile,
  AgentActivityRun,
  AgentActivityStep,
  DebugAgentEntry,
  DebugTurnRecord,
} from '@engine/types';
export type { DebugAgentEntry, DebugTurnRecord } from '@engine/types';
import type { CombatView, CombatCommand } from '@engine/combat-v3';
import {
  getSave,
  getSaves,
  getCharacters,
  getMemories,
  getPlotEvents,
  getSaveProfile,
  getLatestPlotOutline,
  getSnapshots,
  getDebugTurns,
  saveDebugTurn,
} from '@engine/database';
import { saveMessage, getMessages, saveSaveSlot } from '@engine/database';
// 旧档经验保底归一化（方案 A，2026-08-24）：加载时对主角自愈「等级与累计经验矛盾」
//（旧档 totalExp 是层级内语义，新系统是全程累计）。幂等，正常存档零影响。
import { normalizePlayerProgression } from '@engine/database';
import { createStateManager } from '@engine/state-manager';
import { wireEffectSystem, unwireEffectSystem } from '@engine/effect-wiring';
import { getExperienceMode } from '@engine/save-profile';
import { invalidatePromptSession } from '@engine/prompt-session-assembler';
import { allocateAttributePoint } from '@engine/attribute-allocation';
import type { AllocatableAttr } from '@engine/attribute-allocation';
import { detach } from './db-write';
import type { CombatEvent } from '@engine/combat-v2-types';
import { agentActivityLabel, presentToolActivity } from '../lib/agent-activity';
// 🆕 重铸（2026-08-24）：单条目重铸的类型 + 注入缝（实现由 GamePage 挂 GamePipeline.rewriteLoadoutItem）
import type { RewriteTarget } from '@engine/item-gen-chain';

/** 重铸实现注入缝 —— GamePipeline 装配好 endpoint/chainData/stateManager 后由 GamePage 挂进来 */
export type RewriteLoadoutImpl = (
  characterId: string,
  target: RewriteTarget,
  userDescription: string,
) => Promise<{ ok: boolean; reason?: string }>;

export type TimelineRestoreResult =
  | { status: 'rejected'; error: string }
  | { status: 'restored'; warning?: string }
  | { status: 'projection-failed'; error: string };

let rewriteLoadoutImpl: RewriteLoadoutImpl | null = null;

/** 由 GamePage 在创建 GamePipeline 后调用，把引擎实现挂进 store（照 scene-image-seams 的缝模式） */
export function setRewriteLoadoutImpl(impl: RewriteLoadoutImpl): void {
  rewriteLoadoutImpl = impl;
}

/** 战斗消息流条目（CombatMessageFlow 渲染） */
export interface CombatLogEntry {
  id: string;
  kind: 'round_divider' | 'narrative' | 'action';
  round?: number;
  /** narrative 文本 */
  text?: string;
  /** action: 工具返回结果（CombatActionResult 或其他动作工具） */
  result?: Record<string, any>;
  toolName?: string;
}

export const useGameStore = defineStore('game', () => {
  // === 存档 ===
  const saves = ref<SaveSlot[]>([]);
  const activeSaveId = ref<string | null>(null);
  const activeSave = computed(
    () => saves.value.find((s: SaveSlot) => s.id === activeSaveId.value) || null,
  );

  // === 角色 ===
  const characters = ref<CharacterState[]>([]);
  const player = computed(
    () => characters.value.find((c: CharacterState) => c.type === 'player') || null,
  );
  const npcs = computed(() => characters.value.filter((c: CharacterState) => c.type === 'npc'));

  // === 对话 ===
  const messages = ref<ChatMessage[]>([]);
  const isGenerating = ref(false);

  const recentMemories = ref<MemoryRecord[]>([]);
  const activePlotEvents = ref<PlotEvent[]>([]);
  const plotOutline = ref<PlotOutline | null>(null);

  // === 战斗 & 制作 ===
  const activeCombat = ref<CombatState | null>(null);

  // 🆕 v3：独立 v3ActiveCombat ref（CombatView 形状，与 v2 activeCombat 并存）。
  //   v2 事件写 activeCombat，v3 事件写 v3ActiveCombat；isInCombat 同时看两者。
  const v3ActiveCombat = ref<CombatView | null>(null);

  // 🆕 F2（2026-08-10）：就绪态 —— combat_trigger 检出后、玩家点「开始战斗」前的
  //   面板数据（marker 快照）。非 null = 就绪面板显示中（覆盖层锁 UI，战斗还没开）。
  //   isInCombat 认它；startCombat() 清它并调 coordinator.start() 真开打。
  const combatReady = ref<{
    combatType?: string;
    environment?: string;
    allies?: string[];
    enemies?: string[];
    bodyText?: string;
    brief?: string;
  } | null>(null);

  // 🆕 结算确认态（2026-08-13 需求 D）：战斗终局落库后、摘要注入正文前的确认面板。
  //   非 null = 结算确认面板显示中（数值卡 + 可编辑摘要 textarea）。isInCombat 认它
  //   —— v3_settlement 已把 phase 置 SettlementCommitted（isInCombat 第三判据本会翻
  //   false 关面板），确认面板需要面板继续开着，所以它必须进 isInCombat。
  const combatSummaryReview = ref<{
    outcome: 'ally_win' | 'enemy_win' | 'draw' | 'fled';
    totalExp: number;
    totalFp: number;
    loot: CombatSummaryResult['loot'];
    rounds: number;
    summaryText: string;
  } | null>(null);
  /** awaitCombatSummaryReview 挂起的 resolver（confirm/discard/exitCombat 消费） */
  let summaryReviewResolve: ((text: string | null) => void) | null = null;

  const isInCombat = computed(
    () =>
      combatReady.value !== null ||
      combatSummaryReview.value !== null ||
      (activeCombat.value !== null && activeCombat.value.status !== 'ended') ||
      (v3ActiveCombat.value !== null && v3ActiveCombat.value.phase !== 'SettlementCommitted'),
  );

  // === M5 战斗面板状态 ===
  /** 战斗消息流条目（叙事 + 动作结果卡片 + 回合分隔） */
  const combatLog = ref<CombatLogEntry[]>([]);
  /** 当前等玩家输入的我方单位（null = 不在等输入）；v3 扩展 requiredInputKind 供四态 UI 分流 */
  const combatAwaitingInput = ref<{
    unit: string;
    unitId: string;
    round: number;
    requiredInputKind?: string;
  } | null>(null);
  /** 当前行动者 characterId（turn_started 事件更新，单位卡片高亮用） */
  const combatCurrentUnitId = ref<string | null>(null);
  /** 🆕 v3：Coordinator 句柄（submitCommand / abandon / 重开），供前端 Command 路由与放弃（C4）
   *  T16 §3.5：+preSnapshotId（pre-combat 快照，重开战斗 restoreSnapshot 用）与
   *  +restart（重开战斗回调 —— pipeline 持有 combat marker，重触发归它）。
   *  F2：+start（就绪期占位句柄只带它 —— 玩家点「开始战斗」→ store.startCombat 调它）。 */
  const combatCoordinator = ref<{
    submit?: (cmd: CombatCommand) => Promise<void>;
    /** 🎭 主持人/DM 模式（2026-08-12）：提交玩家意图文本 → 主持人解析 → Command */
    submitPlayerIntent?: (text: string) => Promise<void>;
    abandon?: () => void;
    waitForCommand?: () => Promise<CombatCommand>;
    preSnapshotId?: string | null;
    restart?: () => Promise<void>;
    start?: () => Promise<void>;
  } | null>(null);

  /** 战斗开始：清空面板状态（activeCombat 由 combat_started 事件填；v3 清 v3 ref；F2 清就绪态） */
  function enterCombat() {
    combatLog.value = [];
    combatAwaitingInput.value = null;
    combatCurrentUnitId.value = null;
    v3ActiveCombat.value = null;
    combatReady.value = null;
  }

  /** 应用 runner 事件流 → 更新面板状态（combat_started / action_resolved / 回合事件 / awaiting） */
  function applyCombatEvent(evt: CombatEvent) {
    const id = crypto.randomUUID();
    switch (evt.type) {
      case 'combat_started':
        activeCombat.value = evt.state;
        break;
      case 'action_resolved':
        combatLog.value.push({ id, kind: 'action', result: evt.result, toolName: evt.toolName });
        break;
      case 'round_narrative':
        if (evt.text)
          combatLog.value.push({ id, kind: 'narrative', text: evt.text, round: evt.round });
        break;
      case 'round_started':
        combatLog.value.push({ id, kind: 'round_divider', round: evt.round });
        break;
      case 'awaiting_player_input':
        combatAwaitingInput.value = { unit: evt.unit, unitId: evt.unitId, round: evt.round };
        break;
      case 'turn_started':
        combatCurrentUnitId.value = evt.unitId;
        break;
      // ── v3 扩展变体（投影 A 输出，M2）──
      // 🆕 F2：就绪面板事件（combat_trigger 检出后 pipeline 直接构造，先于
      //   v3_combat_started 到达）——置 combatReady（isInCombat 据此弹就绪面板）。
      //   战斗还没开，不动 v3ActiveCombat / combatLog。
      case 'v3_combat_ready':
        combatReady.value = {
          combatType: evt.combatType,
          environment: evt.environment,
          allies: evt.allies ? [...evt.allies] : undefined,
          enemies: evt.enemies ? [...evt.enemies] : undefined,
          bodyText: evt.bodyText,
          brief: evt.brief,
        };
        break;
      case 'v3_combat_started':
        v3ActiveCombat.value = {
          revision: 0,
          phase: 'CombatOpen',
          round: evt.round,
          combatId: evt.combatId,
          initiativeOrder: evt.unitNames,
          currentTurnIndex: 0,
          // T13：载荷里带 units（其他 emit 源的兼容路径）就一并填，不再留空字典
          units: evt.units ? { ...evt.units } : {},
          resourceSnapshots: { FP: 0 },
        };
        combatLog.value.push({ id, kind: 'round_divider', round: evt.round });
        break;
      // 🆕 T13（设计 2026-08-09 §3.1）：开局单位字典整体快照 → 填充 v3ActiveCombat.units
      case 'v3_units_snapshot':
        if (v3ActiveCombat.value) {
          v3ActiveCombat.value = { ...v3ActiveCombat.value, units: { ...evt.units } };
        }
        break;
      case 'v3_round_started':
        combatLog.value.push({ id, kind: 'round_divider', round: evt.round });
        if (v3ActiveCombat.value) {
          v3ActiveCombat.value = { ...v3ActiveCombat.value, phase: 'RoundOpen', round: evt.round };
        }
        break;
      case 'v3_turn_started':
        combatCurrentUnitId.value = evt.unitId;
        break;
      case 'v3_turn_ended':
        if (combatCurrentUnitId.value === evt.unitId) combatCurrentUnitId.value = null;
        break;
      case 'v3_initiative':
        if (v3ActiveCombat.value) {
          v3ActiveCombat.value = { ...v3ActiveCombat.value, initiativeOrder: evt.order };
        }
        break;
      case 'v3_action':
        combatLog.value.push({ id, kind: 'action', result: evt.result, toolName: evt.toolName });
        break;
      case 'v3_narrative':
        if (evt.text)
          combatLog.value.push({ id, kind: 'narrative', text: evt.text, round: evt.round });
        break;
      // 🆕 2026-08-12（Bug 2 修复）：玩家侧命令被内核 rejection 的友好提示。
      // 典型：攻击槽/动作槽已耗尽仍再点 → SLOT_EXHAUSTED。此前 coordinator 熔断
      // abandon 整场（页面闪退根因）；现在只推一条提示行，随后 coordinator 重新 emit
      // v3_awaiting_player_input 亮「等待输入」，玩家可换动作或点「结束回合」。
      case 'v3_rejection_notice':
        combatLog.value.push({
          id,
          kind: 'narrative',
          text: `⚠️ ${evt.message}`,
          round: undefined,
        });
        break;
      case 'v3_awaiting_player_input':
        combatAwaitingInput.value = {
          unit: evt.unit,
          unitId: evt.unitId,
          round: evt.round,
          requiredInputKind: 'PlayerCommand',
        };
        break;
      case 'v3_combat_ended':
        if (v3ActiveCombat.value) {
          v3ActiveCombat.value = { ...v3ActiveCombat.value, phase: 'Terminal' };
        }
        break;
      case 'v3_settlement':
        if (v3ActiveCombat.value) {
          v3ActiveCombat.value = { ...v3ActiveCombat.value, phase: 'SettlementCommitted' };
        }
        break;
    }
  }

  /** v3：controller 挂 Coordinator 句柄（game-pipeline 在 coordinator 启动时挂） */
  function setCombatCoordinator(handle: unknown) {
    combatCoordinator.value = handle as never;
  }

  /** v3：玩家提交一条 CombatCommand（自动补 commandId + expectedRevision）→ 转 Coordinator */
  async function submitCombatCommand(partial: Partial<CombatCommand>): Promise<void> {
    const coordinator = combatCoordinator.value;
    if (!coordinator?.submit) return;
    const rev = v3ActiveCombat.value?.revision ?? 0;
    const cmd = {
      commandId: partial.commandId ?? `ui-${crypto.randomUUID()}`,
      expectedRevision: partial.expectedRevision ?? rev,
      actorId: partial.actorId ?? '',
      cost: partial.cost ?? 'none',
      kind: partial.kind ?? 'PassAttack',
      payload: partial.payload ?? ({} as Record<string, unknown>),
    } as CombatCommand;
    await coordinator.submit(cmd);
  }

  /** 🎭 主持人/DM 模式（2026-08-12）：玩家提交**意图文本**（拼装格式化文本 / 自由对话）
   *  → 转 Coordinator → 主持人会话解析 → Command。生产路径替代 submitCombatCommand：
   *  UI 不再直接产 Command 喂内核，玩家输入一律过主持人理解意图（ADM 模式）。
   *  老 Command 直连路径保留（submitCombatCommand），供测试/快速直捣兜底。
   */
  async function submitCombatIntent(text: string): Promise<void> {
    const coordinator = combatCoordinator.value;
    if (!coordinator?.submitPlayerIntent) {
      // 无意图桥（旧 coordinator / 测试）→ 静默忽略（与 submitCombatCommand 无 Coordinator 同口径）
      return;
    }
    await coordinator.submitPlayerIntent(text);
  }

  /** v3：放弃战斗（C4）——句柄 abandon → 丢弃 session → exitCombat */
  function abandonCombat() {
    v3ActiveCombat.value = null;
    combatLog.value = [];
    combatAwaitingInput.value = null;
    combatCurrentUnitId.value = null;
    combatReady.value = null;
    const c = combatCoordinator.value;
    if (c?.abandon) c.abandon();
  }

  /** v3：跳过战斗（设计 2026-08-09 §3.5）——abandonCombat 的包装。
   *  战斗被放弃后：session 丢弃、FP 不落库（coordinator abandon 路径）、面板关闭
   *  （v3ActiveCombat=null → isInCombat=false）。确认弹窗文案由组件负责。 */
  function skipCombat() {
    abandonCombat();
  }

  /** 🆕 F2：玩家点「开始战斗」——立即清就绪态（面板从「就绪」切到「开打中」），
   *  再调 coordinator.start()（pipeline 的 startCombatV3 真开打：enterCombat →
   *  participants → pre-combat 快照 → runCombatV3，会重新 setCombatCoordinator
   *  成完整句柄）。start 抛错也不回填就绪态（开打失败走 exitCombat 收面板）。 */
  async function startCombat(): Promise<void> {
    const c = combatCoordinator.value;
    combatReady.value = null;
    if (c?.start) {
      await c.start();
    }
  }

  /** v3：重开战斗（设计 2026-08-09 §3.5）——abandonCombat() → restoreSnapshot(pre-combat
   *  快照) → 重新触发 combat_trigger。
   *
   *  流程：① 放弃当前战斗（面板关闭、不落库）② 恢复开战前快照（角色/对话/状态/变量
   *  整表覆写回开战前，HP 等天然一致）③ 调 coordinator 句柄的 restart 回调重触发 ——
   *  pipeline 持有 combat marker（本 store 接触不到 pipeline），经它重新走
   *  handleCombatTriggerV3 重建战斗。确认弹窗文案由组件负责。 */
  async function restartCombat(): Promise<TimelineRestoreResult> {
    if (!activeSaveId.value) return { status: 'rejected', error: '无活跃存档' };
    const coordinator = combatCoordinator.value;
    const preSnapshotId = coordinator?.preSnapshotId ?? null;
    const restartFn = coordinator?.restart;
    if (!preSnapshotId) {
      return { status: 'rejected', error: '没有 pre-combat 快照，无法重开' };
    }
    if (!restartFn) return { status: 'rejected', error: '战斗重开流程未就绪' };

    abandonCombat(); // ① 丢弃 session → 面板关闭 → 不落库
    // 战斗属于当前 GamePipeline.run，正常情况下 isGenerating 仍为 true；abandon 已明确
    // 终止这一条战斗分支，所以在进入只接受静止状态的公共恢复 module 前解除该占用。
    isGenerating.value = false;

    // ② 恢复开战前时间线；失败分类、投影与效果接线统一由公共 module 负责。
    const result = await restoreTimeline(preSnapshotId);
    if (result.status !== 'restored') return result;

    // ③ 重触发 combat_trigger（pipeline 持 marker；异常不阻断恢复本身）
    try {
      await restartFn();
    } catch (err) {
      console.warn('[GameStore] 重开战斗重触发失败:', err);
      return { status: 'restored', warning: '已回到战斗前，但战斗未能重新开始' };
    }
    return result;
  }

  /** 🆕 结算确认（2026-08-13 需求 D）：pipeline 战斗终局调用 —— 投结算确认面板并
   *  挂起等玩家裁决。返回 Promise：resolve(编辑后的摘要文本) = 注入正文；
   *  resolve(null) = 放弃注入（结算数值已落库不可逆，只是叙事不进正文）。
   *  面板期间 isInCombat 保持 true（combatSummaryReview 进了 isInCombat 判据）。 */
  function awaitCombatSummaryReview(payload: {
    outcome: CombatSummaryResult['outcome'];
    totalExp: number;
    totalFp: number;
    loot: CombatSummaryResult['loot'];
    rounds: number;
    summaryText: string;
  }): Promise<string | null> {
    combatSummaryReview.value = { ...payload, loot: [...payload.loot] };
    return new Promise((resolve) => {
      summaryReviewResolve = resolve;
    });
  }

  /** 玩家点「注入正文」—— text 为（可能编辑过的）摘要文本 */
  function confirmCombatSummary(text: string) {
    combatSummaryReview.value = null;
    const r = summaryReviewResolve;
    summaryReviewResolve = null;
    r?.(text);
  }

  /** 玩家点「放弃注入」—— resolve(null)，pipeline 只收面板不写正文 */
  function discardCombatSummary() {
    combatSummaryReview.value = null;
    const r = summaryReviewResolve;
    summaryReviewResolve = null;
    r?.(null);
  }

  /** 战斗结束：清空面板（activeCombat=null → isInCombat=false） */
  function exitCombat() {
    activeCombat.value = null;
    combatLog.value = [];
    combatAwaitingInput.value = null;
    combatCurrentUnitId.value = null;
    combatCoordinator.value = null;
    v3ActiveCombat.value = null;
    combatReady.value = null;
    // 结算确认挂起时被 exitCombat（离开页面 / 停止生成 / 战斗失败路径）——
    // 必须 resolve(null)，否则 pipeline 的 await 永久悬挂。
    if (summaryReviewResolve) {
      const r = summaryReviewResolve;
      summaryReviewResolve = null;
      combatSummaryReview.value = null;
      r(null);
    }
  }

  // === 元数据 ===
  const saveProfile = ref<SaveProfile | null>(null);
  const fp = computed(() => saveProfile.value?.fp || 0);
  const gameTime = computed(() => saveProfile.value?.gameTime ?? null);
  /** 🆕 经验档位（简单/普通模式，2026-08-24）：读 SaveProfile.experienceMode，旧档缺字段兜底 normal */
  const experienceMode = computed(() =>
    getExperienceMode(saveProfile.value ?? ({} as SaveProfile)),
  );

  // === 新闻（存档级，守护非可选字段的运行时缺失与坏数据） ===
  const news = computed(() =>
    (saveProfile.value?.news ?? []).filter((n: any) => n && n.id != null),
  );

  // === 心里话 ===
  // 唯一真源: CharacterState.thoughts 正式字段（规范 §7，M6 T1 切读收口）
  function getThoughts(char?: CharacterState): string {
    return char?.thoughts ?? '';
  }

  // === 玩家可见的回合活动 ===
  const agentActivityRuns = ref<AgentActivityRun[]>([]);
  let activitySequence = 0;

  const currentAgentActivityRun = computed(
    () =>
      [...agentActivityRuns.value]
        .reverse()
        .find((run) => run.status === 'running' || run.status === 'stopping') ?? null,
  );

  function activityRun(runId?: string): AgentActivityRun | undefined {
    if (runId) return agentActivityRuns.value.find((run) => run.id === runId);
    return currentAgentActivityRun.value ?? undefined;
  }

  function startAgentActivityRun(sourceMessageId?: string, standalone = false): string {
    const id = `activity-${Date.now()}-${++activitySequence}`;
    agentActivityRuns.value.push({
      id,
      sourceMessageId:
        sourceMessageId ??
        [...messages.value].reverse().find((msg) => msg.role === 'user')?.id ??
        null,
      status: 'running',
      startedAt: Date.now(),
      standalone,
      steps: [],
    });
    return id;
  }

  function ensureActivityRun(runId?: string): AgentActivityRun {
    const existing = activityRun(runId);
    if (existing) return existing;
    const createdId = startAgentActivityRun(undefined, true);
    return activityRun(createdId)!;
  }

  function updateAgentStatus(agentId: string, runId?: string): string | undefined {
    const run = ensureActivityRun(runId);
    if (run.status === 'stopping') return undefined;
    const existing = [...run.steps]
      .reverse()
      .find((step) => step.agentId === agentId && step.status === 'running');
    if (existing) return existing.id;

    const occurrence = run.steps.filter((step) => step.agentId === agentId).length + 1;
    const step: AgentActivityStep = {
      id: `${run.id}:${agentId}:${occurrence}`,
      agentId,
      label: agentActivityLabel(agentId),
      status: 'running',
      startedAt: Date.now(),
      tools: [],
    };
    run.steps.push(step);
    return step.id;
  }

  function clearAgentStatus(agentId: string, error?: string, runId?: string) {
    const run = activityRun(runId);
    if (!run) return;
    const step = [...run.steps]
      .reverse()
      .find((entry) => entry.agentId === agentId && entry.status === 'running');
    if (!step) return;
    step.status = error ? 'failed' : 'completed';
    step.completedAt = Date.now();

    if (run.standalone && !run.steps.some((entry) => entry.status === 'running')) {
      finishAgentActivityRun(run.id, error ? 'failed' : 'completed');
    }
  }

  function recordAgentToolActivity(
    agentId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    runId?: string,
  ) {
    const run = ensureActivityRun(runId);
    let step = [...run.steps]
      .reverse()
      .find((entry) => entry.agentId === agentId && entry.status === 'running');
    if (!step) {
      updateAgentStatus(agentId, run.id);
      step = [...run.steps]
        .reverse()
        .find((entry) => entry.agentId === agentId && entry.status === 'running');
    }
    if (!step) return;
    const sequence = step.tools.length + 1;
    step.tools.push(
      presentToolActivity(toolName, args, result, `${step.id}:tool:${sequence}`, Date.now()),
    );
  }

  function markAgentActivityStopping(runId: string) {
    const run = activityRun(runId);
    if (run?.status === 'running') run.status = 'stopping';
  }

  function finishAgentActivityRun(
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    message?: string,
  ) {
    const run = activityRun(runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    const completedAt = Date.now();
    run.status = status;
    run.completedAt = completedAt;
    run.message = message;
    for (const step of run.steps) {
      if (step.status !== 'running') continue;
      step.status = status === 'completed' ? 'completed' : status;
      step.completedAt = completedAt;
    }
  }

  function clearAllAgentStatus() {
    agentActivityRuns.value = [];
  }

  // === UI 布局状态 (Phase 7e) ===
  const sidebarCollapsed = ref(false);
  const activeModal = ref<string | null>(null);
  const fullscreenStatus = ref(false);

  // 选项填充 — ChatFlow 点击选项 → InputBar 填入
  const pendingInput = ref('');

  function fillInput(text: string) {
    pendingInput.value = text;
  }
  function clearPendingInput() {
    pendingInput.value = '';
  }

  /** 是否已消费开场 Prompt（未消费 → 需要自动发送）
   *  注意：仅以 openingPromptConsumed 元数据为准，messages 长度不作为消费判定。
   *  因为创角流程可能会预先插入一条消息，但开场 prompt 仍应自动发送。 */
  const hasOpeningPromptConsumed = computed(() => {
    return activeSave.value?.metadata?.openingPromptConsumed === true;
  });

  /** 获取开场 Prompt 文本 */
  const openingPrompt = computed(() => {
    return activeSave.value?.metadata?.openingPrompt ?? null;
  });

  /** 最近 10 回合的 Agent 调试历史；当前回合永远是最后一条。 */
  const agentLogHistory = ref<DebugTurnRecord[]>([]);
  const agentLog = computed(
    () => agentLogHistory.value[agentLogHistory.value.length - 1]?.entries ?? [],
  );
  let debugLogWriteQueue: Promise<void> = Promise.resolve();

  function queueDebugTurnWrite(turn: DebugTurnRecord): void {
    let snapshot: DebugTurnRecord;
    try {
      // Pinia 把嵌套对象包成 Proxy，structuredClone 会直接抛 DataCloneError。
      // 调试导出本来就是 JSON 契约，按同一口径取不可变快照最稳妥。
      snapshot = JSON.parse(JSON.stringify(turn)) as DebugTurnRecord;
    } catch (error) {
      console.error('[game-store] 调试历史序列化失败:', error);
      return;
    }
    debugLogWriteQueue = debugLogWriteQueue
      .then(() => saveDebugTurn(snapshot))
      .catch((error) => console.error('[game-store] 调试历史持久化失败:', error));
  }

  async function flushAgentLogWrites(): Promise<void> {
    await debugLogWriteQueue;
  }

  function startAgentLogTurn(input: {
    id: string;
    saveId: string;
    turn: number;
    sourceMessageId?: string;
    startedAt?: number;
  }): void {
    if (!activeSaveId.value || activeSaveId.value !== input.saveId) return;
    const record: DebugTurnRecord = {
      id: input.id,
      saveId: input.saveId,
      turn: input.turn,
      sourceMessageId: input.sourceMessageId,
      status: 'running',
      startedAt: input.startedAt ?? Date.now(),
      entries: [],
    };
    agentLogHistory.value.push(record);
    if (agentLogHistory.value.length > 10) agentLogHistory.value.splice(0, 1);
    queueDebugTurnWrite(record);
  }

  /** 追加或补全一次 Agent 调用；只按 invocationId 更新，不再覆盖同名 Agent 的其他调用。 */
  function addAgentLogEntry(entry: DebugAgentEntry) {
    const turn = agentLogHistory.value.find((candidate) => candidate.id === entry.turnId);
    if (!turn) return;
    const existing = turn.entries.findIndex(
      (e: DebugAgentEntry) => e.invocationId === entry.invocationId,
    );
    if (existing >= 0) {
      turn.entries[existing] = entry;
    } else {
      turn.entries.push(entry);
    }
    queueDebugTurnWrite(turn);
  }

  function finishAgentLogTurn(id: string, status: DebugTurnRecord['status']): void {
    const turn = agentLogHistory.value.find((candidate) => candidate.id === id);
    if (!turn || turn.status !== 'running') return;
    turn.status = status;
    turn.completedAt = Date.now();
    queueDebugTurnWrite(turn);
  }

  /** 兼容手动清空当前回合；不会删除此前回合。 */
  function clearAgentLog() {
    const turn = agentLogHistory.value[agentLogHistory.value.length - 1];
    if (!turn) return;
    turn.entries = [];
    queueDebugTurnWrite(turn);
  }

  /**
   * 工坊 P2 (ADR-30 D5) — EJS 变量差量被体积护栏**整份拒绝**的诊断行。
   *
   * 存在的理由: 拒绝是静默的簿记失灵，只 toast 一次事后就查不到了；杜绝
   * 「状态机不动了，只能从剧情怪异反推」的最坏调试体验。**内存级、随会话丢弃**
   * （不落库、不进备份），随 DebugPanel 的 JSON 导出一起被带走。
   * 与 agentLog 不同，**不随每轮清空** —— 它是整局的累计计数。
   */
  const ejsVarsRejections = ref<
    Array<{ agentId: string; label: string; count: number; lastAt: number; lastSize: number }>
  >([]);

  /** 记一次 EJS 差量拒绝（同来源累加计数、刷新时间戳与体积） */
  function recordEjsVarsRejection(agentId: string, label: string, size: number) {
    const hit = ejsVarsRejections.value.find((r) => r.agentId === agentId);
    if (hit) {
      hit.count += 1;
      hit.lastAt = Date.now();
      hit.lastSize = size;
      return;
    }
    ejsVarsRejections.value.push({ agentId, label, count: 1, lastAt: Date.now(), lastSize: size });
  }

  /**
   * 世界书条目 EJS 求值失败、已回退原文注入的诊断行（工坊 P2 / 能力面 D8）。
   *
   * 存在的理由与 `ejsVarsRejections` 同源：**回退是静默的** —— 条目照常进提示词，
   * 只是没被求值，玩家看到的现象往往是「那段状态面板变成了一堆源码」或者干脆没反应，
   * 而 `console.warn` 没人会去翻。内存级、随会话丢弃、**整局累计不随轮清空**，
   * 随 DebugPanel 的 JSON 导出一起被带走。
   */
  const ejsFallbacks = ref<
    Array<{
      agentId: string;
      uid: number;
      bookName?: string;
      error: string;
      count: number;
      lastAt: number;
    }>
  >([]);

  /** 记一次 EJS 条目回退（同 agent+uid 累加计数） */
  function recordEjsFallback(
    agentId: string,
    entries: Array<{ uid: number; bookName?: string; error: string }>,
  ) {
    for (const e of entries) {
      const hit = ejsFallbacks.value.find((r) => r.agentId === agentId && r.uid === e.uid);
      if (hit) {
        hit.count += 1;
        hit.lastAt = Date.now();
        hit.error = e.error; // 留最近一次的错因（同条目换个错更值得看）
        continue;
      }
      ejsFallbacks.value.push({
        agentId,
        uid: e.uid,
        bookName: e.bookName,
        error: e.error,
        count: 1,
        lastAt: Date.now(),
      });
    }
  }

  /**
   * EJS `ui.log` 的环形缓冲（能力面 §3.11）—— **内容作者自己打的调试输出**。
   *
   * 之前它只活在 `GamePipeline` 的私有字段里，`getEjsDebugLog()` 全仓零调用点：
   * 收集了、没人读。store 这一份是唯一的家，DebugPanel 直接读。
   */
  const ejsUiLog = ref<string[]>([]);
  /** 会话级天花板（在能力面 §3.11 的每 pass 限频之外再加一道） */
  const EJS_UI_LOG_MAX = 512;

  /** 记一行 EJS `ui.log` 输出（超出上限丢最旧的） */
  function recordEjsUiLog(line: string) {
    ejsUiLog.value.push(line);
    if (ejsUiLog.value.length > EJS_UI_LOG_MAX) ejsUiLog.value.shift();
  }

  /**
   * 改写当前存档的 `metadata` 若干键并落库 —— **三个 UI 辅助字段写入口共用这一份**（Q-16）。
   *
   * ADR-21 的受控例外（P1-09）：`metadata` 里这几个是**纯 UI 辅助字段**，允许 UI 层
   * 直写，但必须走统一写入函数 + try/catch，不裸 `db.put`。AI 产生的存档变更仍必须走
   * `vars_update` 语义 op，不在此例外内。此前三个公开函数各写一份同形骨架，
   * 其中两个有并发保护、一个没有 —— 下一个 UI 辅助字段抄到哪份全看运气。
   *
   * 写完同步回内存 `saves`，否则 `activeSave` 仍是旧值，面板会显示成没改动。
   *
   * 🔴 `optimistic` **每个调用点显式给值，刻意没有默认值**：给一条本来没有重入风险的
   * 路径加上乐观写是行为变更而非等价重构（面板会短暂显示一个尚未落库的值）。
   * - `true`：在第一个 await **之前**写内存，用于要挡住「共享 Store 的第二条管线」
   *   重复启动的原子认领；失败时按 `updatedAt` 守卫回滚（期间被别人改过就不回滚，
   *   免得把新值也一起抹掉）。
   * - `false`：落库成功后才写内存，失败什么也不动。
   */
  async function patchSaveMetadataFor(
    saveId: string,
    patch: Record<string, unknown>,
    opts: { optimistic: boolean; failMessage: string },
  ): Promise<boolean> {
    const current = saves.value.find((save: SaveSlot) => save.id === saveId);
    if (!current) return false;

    const idx = saves.value.findIndex((save: SaveSlot) => save.id === current.id);
    if (opts.optimistic && idx < 0) return false;

    const previous = idx >= 0 ? saves.value[idx] : undefined;
    const clean = detach(current);
    clean.metadata = { ...(clean.metadata ?? {}), ...patch };
    clean.updatedAt = Date.now();

    if (opts.optimistic) saves.value[idx] = clean;
    try {
      await saveSaveSlot(clean);
      if (!opts.optimistic && idx >= 0) saves.value[idx] = clean;
      return true;
    } catch (err) {
      if (opts.optimistic && previous && saves.value[idx]?.updatedAt === clean.updatedAt) {
        saves.value[idx] = previous;
      }
      console.error(`[game-store] ${opts.failMessage}:`, err);
      return false;
    }
  }

  async function patchSaveMetadata(
    patch: Record<string, unknown>,
    opts: { optimistic: boolean; failMessage: string },
  ): Promise<boolean> {
    if (!activeSaveId.value) return false;
    return patchSaveMetadataFor(activeSaveId.value, patch, opts);
  }

  /** 改写本存档的世界书条目启用轴（`metadata.enabledWorldBookEntries`） */
  async function setEnabledWorldBookEntries(entries: string[]): Promise<boolean> {
    // 非乐观：这条路径没有重入风险，乐观写只会让面板短暂显示一个尚未落库的启用轴
    return patchSaveMetadata(
      { enabledWorldBookEntries: [...entries] },
      { optimistic: false, failMessage: '写入世界书启用轴失败' },
    );
  }

  /** 从扩展管理页改写指定存档的工坊启用轴，不要求该存档已进入游戏。 */
  async function setSaveEnabledWorldBookEntries(
    saveId: string,
    entries: string[],
  ): Promise<boolean> {
    return patchSaveMetadataFor(
      saveId,
      { enabledWorldBookEntries: [...entries] },
      { optimistic: false, failMessage: '写入指定存档的世界书启用轴失败' },
    );
  }

  /** 在生成开始前原子认领开场 Prompt。 */
  async function markOpeningPromptConsumed(): Promise<boolean> {
    const current = activeSave.value;
    if (!current || current.metadata?.openingPromptConsumed) return false;
    // 乐观：内存要在第一个 await 之前就位，否则共享 Store 的第二条管线会重复启动
    return patchSaveMetadata(
      { openingPromptConsumed: true },
      { optimistic: true, failMessage: '标记开场 Prompt 失败' },
    );
  }

  /**
   * 归还开场 Prompt 认领。
   *
   * 只在「这一轮什么正文都没产出」时用：认领发生在长管线之前，API 一次抽风就会把
   * 开场永久烧掉 —— 玩家拿到一个只有自己那句话、没有任何叙事、也没法重来的存档。
   * 归还之后重挂载会重跑开场；调用方负责保证不会重复插同一条用户消息。
   */
  async function releaseOpeningPromptClaim(): Promise<boolean> {
    if (!activeSave.value?.metadata?.openingPromptConsumed) return false;
    return patchSaveMetadata(
      { openingPromptConsumed: false },
      { optimistic: true, failMessage: '归还开场 Prompt 认领失败' },
    );
  }

  // === 选项管理 ===
  /** vars_update 解析出的行动选项 */
  const pendingOptions = ref<string[]>([]);

  /** 设置行动选项（供 GamePipeline 回调使用） */
  function setPendingOptions(options: string[]) {
    pendingOptions.value = options;
  }

  // === 背包聚焦 — 持有物点击 → 打开背包并选中该物品 ===
  const pendingItemFocus = ref<{
    category: 'inventory' | 'equipment' | 'skills';
    itemName: string;
  } | null>(null);

  function focusItem(category: 'inventory' | 'equipment' | 'skills', itemName: string) {
    pendingItemFocus.value = { category, itemName };
    activeModal.value = 'items';
  }
  function clearItemFocus() {
    pendingItemFocus.value = null;
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }
  function showModal(id: string) {
    activeModal.value = id;
  }
  function closeModal() {
    activeModal.value = null;
  }
  function toggleFullscreen() {
    fullscreenStatus.value = !fullscreenStatus.value;
  }

  /** 预览/测试注入：供 Ctrl+Shift+T 直接灌入 characters 与 saveProfile，不绕 IndexedDB。
   *  采用合并语义而非替换，避免覆盖从 IndexedDB 加载的真实存档数据。 */
  function hydratePreview(payload: { characters?: any[]; saveProfile?: any }) {
    if (payload.characters) {
      const existingMap = new Map(characters.value.map((c) => [c.id, c]));
      for (const c of payload.characters) {
        const existing = existingMap.get(c.id);
        if (existing) {
          // 已有角色 → 合并覆盖字段（mock 只带 id/name/race/tier/location/customFields，不会破坏属性/装备/背包）
          Object.assign(existing, c);
        } else if (c.type === 'player') {
          // Mock 玩家：只更新真实玩家的 location，不添加假玩家
          const realPlayer = characters.value.find((rp) => rp.type === 'player');
          if (realPlayer) {
            if (c.location) realPlayer.location = c.location;
            if (c.customFields) {
              realPlayer.customFields = { ...realPlayer.customFields, ...c.customFields };
            }
          }
        } else {
          // 新 NPC → 追加
          characters.value.push(c as CharacterState);
        }
      }
    }
    if (payload.saveProfile) {
      // 浅合并：保留真实 fp/quests 等字段，只覆盖 mock 提供的 gameTime/news/worldFlags
      saveProfile.value = { ...saveProfile.value, ...payload.saveProfile } as SaveProfile;
    }
  }

  // === 消息管理 ===
  let turnCounter = 0;

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

  /** 从 IndexedDB 恢复消息到内存（始终覆写，无消息时清空） */
  async function restoreMessages() {
    if (!activeSaveId.value) return;
    try {
      messages.value = await getMessages(activeSaveId.value);
    } catch (err) {
      console.error('[game-store] 恢复消息失败:', err);
      messages.value = [];
    }
  }

  /**
   * 追加一条消息，**并把它交回调用方**。
   *
   * 返回值不是装饰：情景插画按 `(saveId, messageId, occurrence)` 反查挂回正文（图像
   * 生成 D2），所以刚产出这条 assistant 消息的那一方必须拿得到它的 `id` 与 `turn`。
   * 从 `messages` 末尾去捞是个会随时被别的写入者破坏的假设。
   */
  function addMessage(content: string, role: 'user' | 'assistant'): ChatMessage {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: Date.now(),
      saveId: activeSaveId.value ?? undefined,
      turn: role === 'user' ? ++turnCounter : turnCounter,
    };
    messages.value.push(msg);
    // 异步持久化（不阻塞 UI）。`void` 是显式的「发射后不管」——
    // persistMessage 自己 try/catch 到底，不会拒绝。
    void persistMessage(msg);
    return msg;
  }

  function addSystemMessage(systemEvent: import('@engine/types').SystemEvent): void {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'system',
      content: systemEvent.narrative,
      timestamp: Date.now(),
      saveId: activeSaveId.value ?? undefined,
      turn: turnCounter,
      systemEvent,
    };
    messages.value.push(msg);
    void persistMessage(msg);
  }

  // === 动作 ===
  async function loadSaves() {
    saves.value = await getSaves();
  }

  async function loadSave(saveId: string) {
    const save = await getSave(saveId);
    if (!save) throw new Error(`Save ${saveId} not found`);

    // 🔴 关键：先清空旧存档的所有内存状态，避免 DB 无数据时旧值残留
    clearActive();
    activeSaveId.value = saveId;
    saves.value = [save];

    // 关键：先设置 activeSaveId，让 activeSave computed 能正确引用到 save
    console.log(
      '[game-store] activeSave after set:',
      JSON.stringify({
        id: activeSave.value?.id,
        hasMetadata: !!activeSave.value?.metadata,
        hasOpeningPrompt: !!activeSave.value?.metadata?.openingPrompt,
        openingPromptConsumed: activeSave.value?.metadata?.openingPromptConsumed,
      }),
    );

    // 加载关联数据（始终覆写，DB 返回 undefined 时写默认空值）
    const [chars, mems, events, profile, outline, debugTurns] = await Promise.all([
      getCharacters(saveId),
      getMemories(saveId),
      getPlotEvents(saveId),
      getSaveProfile(saveId),
      getLatestPlotOutline(saveId),
      getDebugTurns(saveId),
    ]);

    characters.value = (await normalizePlayerProgression(chars as CharacterState[])) ?? [];
    recentMemories.value = (mems as MemoryRecord[]) ?? [];
    activePlotEvents.value = (events as PlotEvent[]) ?? [];
    plotOutline.value = (outline as PlotOutline) ?? null;
    activeCombat.value = null;
    saveProfile.value = (profile as SaveProfile) ?? null;
    agentLogHistory.value = debugTurns;

    // 快照恢复走 snapshots 表（规范 §11.2），机制在 M5 重建 (#2)

    // 从 messages 表恢复对话历史（始终覆写，无消息时为空数组）
    await restoreMessages();

    // 恢复 turnCounter（取最后一条 user/assistant 消息的 turn）
    const lastMsg = messages.value.filter((m) => m.role === 'user' || m.role === 'assistant').pop();
    turnCounter = lastMsg?.turn ?? 0;
  }

  async function readTimelineProjection(saveId: string) {
    const [save, chars, mems, events, profile, outline, restoredMessages] = await Promise.all([
      getSave(saveId),
      getCharacters(saveId),
      getMemories(saveId),
      getPlotEvents(saveId),
      getSaveProfile(saveId),
      getLatestPlotOutline(saveId),
      getMessages(saveId),
    ]);
    if (!save) throw new Error(`Save ${saveId} not found after timeline restore`);

    const restoredCharacters = (await normalizePlayerProgression(chars as CharacterState[])) ?? [];
    const lastMessage = restoredMessages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .pop();

    return {
      save,
      characters: restoredCharacters,
      memories: (mems as MemoryRecord[]) ?? [],
      plotEvents: (events as PlotEvent[]) ?? [],
      profile: (profile as SaveProfile) ?? null,
      outline: (outline as PlotOutline) ?? null,
      messages: restoredMessages,
      turn: lastMessage?.turn ?? 0,
    };
  }

  /** 🆕 轻量回读：管线跑完后 StateManager / 侧链直接写了 Dexie，
   *  把 DB 里更新后的 save.metadata / characters / saveProfile 同步回内存。
   *  不动 messages / agentLog / combat 等 UI 态（与 loadSave 的全量重载区分开）。 */
  async function refreshFromDb() {
    if (!activeSaveId.value) return;
    try {
      const [save, dbChars, profile, outline, dbPlotEvents] = await Promise.all([
        getSave(activeSaveId.value),
        getCharacters(activeSaveId.value), // M6: saveId 索引查询（M1 建索引；侧链 NPC 由 applyAddCharacter 注入 saveId）
        getSaveProfile(activeSaveId.value),
        getLatestPlotOutline(activeSaveId.value),
        getPlotEvents(activeSaveId.value),
      ]);

      // 1. save.metadata（totalTurns / openingPromptConsumed 等）
      if (save) {
        const idx = saves.value.findIndex((s: SaveSlot) => s.id === save.id);
        if (idx >= 0) saves.value[idx] = save;
        else saves.value.push(save);
      }

      // 2. characters：合并语义 —— DB 版本覆盖同 id 内存版本（拿到最新背包/装备/资源），
      //    DB 里属于本存档但内存没有的角色追加（查询已按 saveId 索引预过滤）；内存独有的（预览注入等）保留。
      //    先做旧档经验保底归一化（就地改 + 有变化落库），这样合并进内存的也是归一化后的数。
      await normalizePlayerProgression(dbChars as CharacterState[]);
      const dbById = new Map((dbChars as CharacterState[]).map((c) => [c.id, c]));
      characters.value = characters.value.map((c) => dbById.get(c.id) ?? c);
      const memIds = new Set(characters.value.map((c) => c.id));
      for (const c of dbChars as CharacterState[]) {
        if (!memIds.has(c.id)) {
          characters.value.push(c);
        }
      }

      // 3. saveProfile（gameTime / fp / quests / news）
      if (profile) saveProfile.value = profile as SaveProfile;

      // 4. 剧情大纲 + 事件回读（post_check 落库后 PlotPanel 需要最新态）
      if (outline) plotOutline.value = outline as PlotOutline;
      if (dbPlotEvents) activePlotEvents.value = dbPlotEvents as PlotEvent[];
    } catch (err) {
      console.error('[game-store] refreshFromDb 失败:', err);
    }
  }

  function clearSessionRuntime() {
    clearAllAgentStatus();
    isGenerating.value = false;
    characters.value = [];
    messages.value = [];
    recentMemories.value = [];
    activePlotEvents.value = [];
    plotOutline.value = null;
    saveProfile.value = null;
    pendingInput.value = '';
    pendingOptions.value = [];
    pendingItemFocus.value = null;
    activeModal.value = null;
    ejsVarsRejections.value = [];
    ejsFallbacks.value = [];
    ejsUiLog.value = [];
    exitCombat();
    combatSummaryReview.value = null;
    turnCounter = 0;
  }

  function clearActive() {
    clearSessionRuntime();
    agentLogHistory.value = [];
    activeSaveId.value = null;
  }

  async function restoreTimeline(snapshotId: string): Promise<TimelineRestoreResult> {
    const saveId = activeSaveId.value;
    if (!saveId) return { status: 'rejected', error: '无活跃存档' };
    if (isGenerating.value) return { status: 'rejected', error: '生成进行中，无法恢复' };
    if (isInCombat.value) return { status: 'rejected', error: '战斗进行中，无法恢复' };

    isGenerating.value = true;
    let authorityRestored = false;
    try {
      const result = await createStateManager(saveId).restoreSnapshot(snapshotId);
      if (!result.success) {
        return { status: 'rejected', error: result.errors.join('; ') || '恢复快照失败' };
      }
      authorityRestored = true;

      invalidatePromptSession(saveId);
      unwireEffectSystem(saveId);

      if (activeSaveId.value !== saveId) {
        return { status: 'restored', warning: '时间线已恢复；当前已切换到其他存档' };
      }

      const projection = await readTimelineProjection(saveId);
      if (activeSaveId.value !== saveId) {
        return { status: 'restored', warning: '时间线已恢复；当前已切换到其他存档' };
      }

      clearSessionRuntime();
      activeSaveId.value = saveId;
      saves.value = [projection.save];
      characters.value = projection.characters;
      recentMemories.value = projection.memories;
      activePlotEvents.value = projection.plotEvents;
      saveProfile.value = projection.profile;
      plotOutline.value = projection.outline;
      messages.value = projection.messages;
      turnCounter = projection.turn;
      wireEffectSystem(saveId, projection.characters);

      return { status: 'restored' };
    } catch (err) {
      if (!authorityRestored) {
        console.error('[game-store] 时间线恢复失败:', err);
        return {
          status: 'rejected',
          error: err instanceof Error ? err.message : '恢复快照失败',
        };
      }

      console.error('[game-store] 时间线恢复后的投影重载失败:', err);
      try {
        unwireEffectSystem(saveId);
      } catch (cleanupError) {
        console.error('[game-store] 清理失败的效果接线时出错:', cleanupError);
      }
      if (activeSaveId.value === saveId) clearActive();
      return {
        status: 'projection-failed',
        error: '时间线已恢复，但界面重载失败，请重新进入存档',
      };
    } finally {
      if (activeSaveId.value === saveId) isGenerating.value = false;
    }
  }

  /**
   * 花掉 1 点自由属性点（玩家在状态总览里点「+」）。
   *
   * 本层只做「谁」的解析与回读：校验（有没有点 / 到没到层级上限）与落库全在引擎的
   * `allocateAttributePoint` 里（ADR-11 数值规则归 Code、ADR-21 写入走 StateManager）。
   * 成功后走 `refreshFromDb()` —— 引擎直写 Dexie，不回读的话面板上的属性与剩余点数
   * 都还是旧值，玩家会以为点了没反应。
   *
   * 失败原因原样交回调用方（组件转 toast），本层不自己弹提示。
   */
  async function allocateAttrPoint(
    attr: AllocatableAttr,
  ): Promise<{ ok: boolean; error?: string }> {
    const saveId = activeSaveId.value;
    if (!saveId) return { ok: false, error: '无活跃存档' };
    const p = player.value;
    if (!p) return { ok: false, error: '找不到主角' };

    try {
      const result = await allocateAttributePoint(saveId, p.name, attr);
      if (result.ok) await refreshFromDb();
      return result;
    } catch (err) {
      console.error('[game-store] 分配自由属性点失败:', err);
      return { ok: false, error: '属性点分配失败' };
    }
  }

  // === 快照回退 (快照面板 + 右键回退重发) ===

  /** 右键「回退」：撤回当前回合 → 恢复上一轮快照 + 把这轮玩家输入回填输入框。
   *  回退后原样发送 = 重新生成；编辑后发送 = 编辑重发。
   *  不可回退（最早回合/生成中/战斗中/无存档/无快照）时返回 rejected。 */
  async function rollbackOneTurn(): Promise<TimelineRestoreResult> {
    if (!activeSaveId.value) return { status: 'rejected', error: '无活跃存档' };
    if (isGenerating.value) return { status: 'rejected', error: '生成进行中，无法回退' };
    if (isInCombat.value) return { status: 'rejected', error: '战斗进行中，无法回退' };

    // 当前回合 = 最新一条 user 消息（删除前先捕获其输入）
    const userMsgs = messages.value.filter((m) => m.role === 'user');
    const currentUserMsg = userMsgs[userMsgs.length - 1];
    if (!currentUserMsg) return { status: 'rejected', error: '已是最早回合，无可回退' };
    const currentTurn = currentUserMsg.turn ?? 0;
    const capturedInput = currentUserMsg.content;

    // 找上一轮快照（turn <= currentTurn-1 中最新者；快照 turn = 已完成回合数）
    const prevTargetTurn = currentTurn - 1;
    if (prevTargetTurn < 1) return { status: 'rejected', error: '已是最早回合，无可回退' };
    const snapshots = await getSnapshots(activeSaveId.value);
    const prevSnapshot = snapshots
      .filter((s) => s.turn <= prevTargetTurn)
      .sort((a, b) => b.turn - a.turn)[0];
    if (!prevSnapshot) return { status: 'rejected', error: '找不到上一轮快照' };

    const result = await restoreTimeline(prevSnapshot.id);
    if (result.status === 'restored') fillInput(capturedInput);
    return result;
  }

  /** 快照面板「恢复」：恢复到指定历史快照（不回填输入，从该点继续游戏）。 */
  async function restoreToSnapshot(snapshotId: string): Promise<TimelineRestoreResult> {
    return restoreTimeline(snapshotId);
  }

  // === 玩家主动删除（物品/装备/技能/角色）—— 用户可自由清理持有物 ===

  /**
   * 丢弃/删除一件物品（含装备）。经 commitChatState 走 remove_item op，
   * 数量扣到 0 自动移除条目。改名/装备进背包等关联由引擎处理。
   */
  async function removeItem(
    itemName: string,
    quantity = 1,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!activeSaveId.value) return { ok: false, error: '无活跃存档' };
    const sm = createStateManager(activeSaveId.value);
    const result = await sm.commitChatState([
      {
        op: 'remove_item',
        target: `characters.${player.value?.name ?? ''}`,
        value: { name: itemName, quantity },
      },
    ]);
    if (result.success) await refreshFromDb();
    return result.success ? { ok: true } : { ok: false, error: result.errors.join('; ') };
  }

  /** 删除一个技能（按名）。 */
  async function removeSkill(skillName: string): Promise<{ ok: boolean; error?: string }> {
    if (!activeSaveId.value) return { ok: false, error: '无活跃存档' };
    const sm = createStateManager(activeSaveId.value);
    const result = await sm.commitChatState([
      {
        op: 'remove_skill',
        target: `characters.${player.value?.name ?? ''}`,
        value: { name: skillName },
      },
    ]);
    if (result.success) await refreshFromDb();
    return result.success ? { ok: true } : { ok: false, error: result.errors.join('; ') };
  }

  /**
   * 单条目重铸（2026-08-24）：把某角色的一条技能/装备/物品交给 item_gen 重写。
   *
   * 🔴 实现走注入缝（GamePipeline.rewriteLoadoutItem），store 不直接碰引擎装配；
   *    成功即 refreshFromDb 回读最新 characters（含替换后的条目），面板随之刷新。
   *    存档安全：remove 旧 + add 新同一次 commitChatState（原子），玩家可用快照回退。
   */
  async function rewriteLoadoutItem(
    characterId: string,
    target: RewriteTarget,
    userDescription = '',
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!activeSaveId.value) return { ok: false, reason: '无活跃存档' };
    if (!rewriteLoadoutImpl) return { ok: false, reason: '游戏管线未就绪' };
    const result = await rewriteLoadoutImpl(characterId, target, userDescription);
    if (result.ok) await refreshFromDb();
    return result;
  }

  /**
   * 手动落位：把玩家的位置路径改成某个地块名（势力地图「设为当前位置」唯一写入口）。
   *
   * 🔴 **只提交一条 `set_location`，绝不自己写 `worldFlags.map`**：地块是位置路径的
   *    **投影**（ADR-31 / 裁定 §12-1），而那次投影由 `applySetLocation` 里的
   *    `syncMapLocation` 钩子在**位置路径落库之后**做（含 packStamp 自愈与「只跟玩家」
   *    那两条）。在这里顺手补一份 `lastTileId` 是很诱人的 —— 那等于开第二条写路径，
   *    写的还是一个没有 patch 背书的派生态：换包自愈、快照回退都会与它打架，且不报错。
   * 🔴 值是**地块名**不是 id：AI 与存档里的位置一律按名字说话（§8.3），
   *    落位再经 `placeBindings` 解回地块 —— 这也是一次地图点击**诚实的粒度**。
   */
  async function setPlayerLocation(tileName: string): Promise<{ ok: boolean; error?: string }> {
    if (!activeSaveId.value) return { ok: false, error: '无活跃存档' };
    const name = typeof tileName === 'string' ? tileName.trim() : '';
    if (name.length === 0) return { ok: false, error: '地块名为空' };
    const playerName = player.value?.name ?? '';
    if (playerName.length === 0) return { ok: false, error: '没有玩家角色' };

    const sm = createStateManager(activeSaveId.value);
    const result = await sm.commitChatState([
      { op: 'set_location', target: `characters.${playerName}`, value: name },
    ]);
    // 回读是必须的：`saveProfile` 里的落位投影由引擎钩子写，不刷新则地图上的棋子不动
    if (result.success) await refreshFromDb();
    return result.success ? { ok: true } : { ok: false, error: result.errors.join('; ') };
  }

  /**
   * 删除一个角色（按名）。用于清理龙套/NPC。
   * 🔴 只删角色行本身，不清理记忆/剧情关联（用户意图是删龙套，非清除叙事痕迹）。
   * 🔴 成功后**整表替换**内存角色：refreshFromDb 是合并语义，删掉的角色不会从内存消失。
   */
  async function removeCharacter(characterName: string): Promise<{ ok: boolean; error?: string }> {
    if (!activeSaveId.value) return { ok: false, error: '无活跃存档' };
    if (player.value?.name === characterName) return { ok: false, error: '不能删除玩家角色' };
    const sm = createStateManager(activeSaveId.value);
    const result = await sm.commitChatState([
      { op: 'remove_character', target: `characters.${characterName}` },
    ]);
    if (result.success) {
      characters.value = (await getCharacters(activeSaveId.value)) as CharacterState[];
    }
    return result.success ? { ok: true } : { ok: false, error: result.errors.join('; ') };
  }

  /**
   * 调试面板「下回合触发」：把一条随机事件按 forced 塞进候选池（开发者模式专用）。
   *
   * 校验与落库全在引擎的 `devForceArmRandomEvent`（ADR-21 唯一写入口）；本层只解析「谁」
   * 并回读 —— 不回读的话调试面板上那条「在池」标记要等下一次时间推进才亮，
   * 而这个按钮的全部价值就是**立刻**看到它进池了。
   */
  async function devArmRandomEvent(name: string): Promise<{ ok: boolean; error?: string }> {
    if (!activeSaveId.value) return { ok: false, error: '无活跃存档' };
    try {
      const sm = createStateManager(activeSaveId.value);
      const result = await sm.devForceArmRandomEvent(name);
      if (result.ok) await refreshFromDb();
      return result;
    } catch (err) {
      console.error('[game-store] 随机事件调试入池失败:', err);
      return { ok: false, error: '调试入池失败' };
    }
  }

  return {
    saves,
    activeSaveId,
    activeSave,
    characters,
    player,
    npcs,
    messages,
    isGenerating,
    recentMemories,
    activePlotEvents,
    plotOutline,
    activeCombat,
    isInCombat,
    combatLog,
    combatAwaitingInput,
    combatCurrentUnitId,
    v3ActiveCombat,
    combatReady,
    combatSummaryReview,
    combatCoordinator,
    enterCombat,
    applyCombatEvent,
    setCombatCoordinator,
    submitCombatCommand,
    submitCombatIntent,
    abandonCombat,
    skipCombat,
    startCombat,
    restartCombat,
    awaitCombatSummaryReview,
    confirmCombatSummary,
    discardCombatSummary,
    exitCombat,
    saveProfile,
    fp,
    gameTime,
    experienceMode,
    news,
    getThoughts,
    sidebarCollapsed,
    activeModal,
    fullscreenStatus,
    toggleSidebar,
    showModal,
    closeModal,
    toggleFullscreen,
    hydratePreview,
    addMessage,
    addSystemMessage,
    loadSaves,
    loadSave,
    refreshFromDb,
    clearActive,
    pendingInput,
    fillInput,
    clearPendingInput,
    hasOpeningPromptConsumed,
    openingPrompt,
    markOpeningPromptConsumed,
    releaseOpeningPromptClaim,
    setEnabledWorldBookEntries,
    setSaveEnabledWorldBookEntries,
    pendingOptions,
    setPendingOptions,
    pendingItemFocus,
    focusItem,
    clearItemFocus,
    agentActivityRuns,
    currentAgentActivityRun,
    startAgentActivityRun,
    finishAgentActivityRun,
    markAgentActivityStopping,
    recordAgentToolActivity,
    updateAgentStatus,
    clearAgentStatus,
    clearAllAgentStatus,
    agentLog,
    agentLogHistory,
    startAgentLogTurn,
    addAgentLogEntry,
    finishAgentLogTurn,
    flushAgentLogWrites,
    clearAgentLog,
    ejsVarsRejections,
    recordEjsVarsRejection,
    ejsFallbacks,
    recordEjsFallback,
    ejsUiLog,
    recordEjsUiLog,
    persistMessage,
    restoreMessages,
    allocateAttrPoint,
    rollbackOneTurn,
    restoreToSnapshot,
    removeItem,
    removeSkill,
    removeCharacter,
    setPlayerLocation,
    rewriteLoadoutItem,
    devArmRandomEvent,
  };
});
