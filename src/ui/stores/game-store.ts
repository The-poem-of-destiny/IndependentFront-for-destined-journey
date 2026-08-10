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
  SaveProfile,
} from '@engine/types';
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
} from '@engine/database';
import { saveMessage, getMessages, saveSaveSlot } from '@engine/database';
import { createStateManager } from '@engine/state-manager';
import { detach } from './db-write';
import type { CombatEvent } from '@engine/combat-v2-types';

/** 单条 Agent 调试日志（含完整请求/响应上下文） */
export interface DebugAgentEntry {
  agentId: string;
  label: string;
  endpointId: string;
  endpointName: string;
  baseUrl: string;
  model: string;
  messages: Array<{ role: string; content: string | null }>;
  rawResponse: string;
  /** 🆕 DeepSeek 思维链（reasoning_content），可能为空 */
  reasoning?: string;
  error?: string;
  tokensUsed: number;
  cacheHit: boolean;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  completionTokens?: number;
  duration: number;
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
  const isInCombat = computed(
    () =>
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
   *  +restart（重开战斗回调 —— pipeline 持有 combat marker，重触发归它）。 */
  const combatCoordinator = ref<{
    submit?: (cmd: CombatCommand) => Promise<void>;
    abandon?: () => void;
    waitForCommand?: () => Promise<CombatCommand>;
    preSnapshotId?: string | null;
    restart?: () => Promise<void>;
  } | null>(null);

  /** 战斗开始：清空面板状态（activeCombat 由 combat_started 事件填；v3 清 v3 ref） */
  function enterCombat() {
    combatLog.value = [];
    combatAwaitingInput.value = null;
    combatCurrentUnitId.value = null;
    v3ActiveCombat.value = null;
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

  /** v3：放弃战斗（C4）——句柄 abandon → 丢弃 session → exitCombat */
  function abandonCombat() {
    v3ActiveCombat.value = null;
    combatLog.value = [];
    combatAwaitingInput.value = null;
    combatCurrentUnitId.value = null;
    const c = combatCoordinator.value;
    if (c?.abandon) c.abandon();
  }

  /** v3：跳过战斗（设计 2026-08-09 §3.5）——abandonCombat 的包装。
   *  战斗被放弃后：session 丢弃、FP 不落库（coordinator abandon 路径）、面板关闭
   *  （v3ActiveCombat=null → isInCombat=false）。确认弹窗文案由组件负责。 */
  function skipCombat() {
    abandonCombat();
  }

  /** v3：重开战斗（设计 2026-08-09 §3.5）——abandonCombat() → restoreSnapshot(pre-combat
   *  快照) → 重新触发 combat_trigger。
   *
   *  流程：① 放弃当前战斗（面板关闭、不落库）② 恢复开战前快照（角色/对话/状态/变量
   *  整表覆写回开战前，HP 等天然一致）③ 调 coordinator 句柄的 restart 回调重触发 ——
   *  pipeline 持有 combat marker（本 store 接触不到 pipeline），经它重新走
   *  handleCombatTriggerV3 重建战斗。确认弹窗文案由组件负责。 */
  async function restartCombat(): Promise<{ ok: boolean; error?: string }> {
    if (!activeSaveId.value) return { ok: false, error: '无活跃存档' };
    const coordinator = combatCoordinator.value;
    const preSnapshotId = coordinator?.preSnapshotId ?? null;
    const restartFn = coordinator?.restart;
    abandonCombat(); // ① 丢弃 session → 面板关闭 → 不落库
    if (!preSnapshotId) return { ok: false, error: '没有 pre-combat 快照，无法重开' };

    // ② 恢复开战前快照（照 rollbackOneTurn 的恢复姿势：整表替换角色内存态 + 同步 + 对齐）
    const sm = createStateManager(activeSaveId.value);
    const result = await sm.restoreSnapshot(preSnapshotId);
    if (!result.success) return { ok: false, error: result.errors.join('; ') || '恢复快照失败' };
    characters.value = (await getCharacters(activeSaveId.value)) as CharacterState[];
    await refreshFromDb();
    await restoreMessages();
    const lastMsg = messages.value.filter((m) => m.role === 'user' || m.role === 'assistant').pop();
    turnCounter = lastMsg?.turn ?? 0;

    // ③ 重触发 combat_trigger（pipeline 持 marker；异常不阻断恢复本身）
    if (restartFn) {
      try {
        await restartFn();
      } catch (err) {
        console.warn('[GameStore] 重开战斗重触发失败:', err);
      }
    }
    return { ok: true };
  }

  /** 战斗结束：清空面板（activeCombat=null → isInCombat=false） */
  function exitCombat() {
    activeCombat.value = null;
    combatLog.value = [];
    combatAwaitingInput.value = null;
    combatCurrentUnitId.value = null;
    combatCoordinator.value = null;
    v3ActiveCombat.value = null;
  }

  // === 元数据 ===
  const saveProfile = ref<SaveProfile | null>(null);
  const fp = computed(() => saveProfile.value?.fp || 0);
  const gameTime = computed(() => saveProfile.value?.gameTime ?? null);

  // === 新闻（存档级，守护非可选字段的运行时缺失与坏数据） ===
  const news = computed(() =>
    (saveProfile.value?.news ?? []).filter((n: any) => n && n.id != null),
  );

  // === 心里话 ===
  // 唯一真源: CharacterState.thoughts 正式字段（规范 §7，M6 T1 切读收口）
  function getThoughts(char?: CharacterState): string {
    return char?.thoughts ?? '';
  }

  const agentStatus = ref<{ agentId: string; label: string; startedAt: number } | null>(null);
  const agentDurations = ref<{ agentId: string; label: string; elapsed: number }[]>([]);

  const AGENT_LABELS: Record<string, string> = {
    memory_recall: '检索记忆',
    plot_pre_check: '剧情检查',
    story: '生成正文',
    request_dispatcher: '请求调度',
    vars_update: '更新状态',
    memory_summary: '压缩记忆',
    plot_post_check: '剧情修正',
    craft_gen: '制作中',
    char_gen: '角色生成',
    item_gen: '物品生成',
  };

  function updateAgentStatus(agentId: string) {
    agentStatus.value = {
      agentId,
      label: AGENT_LABELS[agentId] ?? agentId,
      startedAt: Date.now(),
    };
  }

  function clearAgentStatus(agentId: string, _error?: string) {
    if (agentStatus.value && agentStatus.value.agentId === agentId) {
      const elapsed = Date.now() - agentStatus.value.startedAt;
      agentDurations.value = [
        ...agentDurations.value.slice(-9), // keep last 9 to avoid overflow
        { agentId, label: agentStatus.value.label, elapsed },
      ];
      agentStatus.value = null;
    }
  }

  function clearAllAgentStatus() {
    agentStatus.value = null;
    agentDurations.value = [];
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

  /** Agent 调用日志 — 每轮管线追加 */
  const agentLog = ref<DebugAgentEntry[]>([]);

  /** 追加一条 Agent 调试日志 (idempotent: 同名 agent 替换) */
  function addAgentLogEntry(entry: DebugAgentEntry) {
    const existing = agentLog.value.findIndex((e) => e.agentId === entry.agentId);
    if (existing >= 0) {
      agentLog.value[existing] = entry;
    } else {
      agentLog.value.push(entry);
    }
  }

  /** 清除本轮所有调试日志 (新一轮开始时调用) */
  function clearAgentLog() {
    agentLog.value = [];
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
  async function patchSaveMetadata(
    patch: Record<string, unknown>,
    opts: { optimistic: boolean; failMessage: string },
  ): Promise<boolean> {
    const current = activeSave.value;
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

  /** 改写本存档的世界书条目启用轴（`metadata.enabledWorldBookEntries`） */
  async function setEnabledWorldBookEntries(entries: string[]): Promise<boolean> {
    // 非乐观：这条路径没有重入风险，乐观写只会让面板短暂显示一个尚未落库的启用轴
    return patchSaveMetadata(
      { enabledWorldBookEntries: [...entries] },
      { optimistic: false, failMessage: '写入世界书启用轴失败' },
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
    const [chars, mems, events, profile, outline] = await Promise.all([
      getCharacters(saveId),
      getMemories(saveId),
      getPlotEvents(saveId),
      getSaveProfile(saveId),
      getLatestPlotOutline(saveId),
    ]);

    characters.value = (chars as CharacterState[]) ?? [];
    recentMemories.value = (mems as MemoryRecord[]) ?? [];
    activePlotEvents.value = (events as PlotEvent[]) ?? [];
    plotOutline.value = (outline as PlotOutline) ?? null;
    activeCombat.value = null;
    saveProfile.value = (profile as SaveProfile) ?? null;

    // 快照恢复走 snapshots 表（规范 §11.2），机制在 M5 重建 (#2)

    // 从 messages 表恢复对话历史（始终覆写，无消息时为空数组）
    await restoreMessages();

    // 恢复 turnCounter（取最后一条 user/assistant 消息的 turn）
    const lastMsg = messages.value.filter((m) => m.role === 'user' || m.role === 'assistant').pop();
    turnCounter = lastMsg?.turn ?? 0;
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

  function clearActive() {
    clearAllAgentStatus();
    activeSaveId.value = null;
    isGenerating.value = false;
    characters.value = [];
    messages.value = [];
    recentMemories.value = [];
    activePlotEvents.value = [];
    plotOutline.value = null;
    activeCombat.value = null;
    saveProfile.value = null;
  }

  // === 快照回退 (快照面板 + 右键回退重发) ===

  /** 右键「回退」：撤回当前回合 → 恢复上一轮快照 + 把这轮玩家输入回填输入框。
   *  回退后原样发送 = 重新生成；编辑后发送 = 编辑重发。
   *  不可回退（最早回合/战斗中/无存档/无快照）时返回 {ok:false,error}。 */
  async function rollbackOneTurn(): Promise<{ ok: boolean; error?: string }> {
    if (!activeSaveId.value) return { ok: false, error: '无活跃存档' };
    if (isInCombat.value) return { ok: false, error: '战斗进行中，无法回退' };

    // 当前回合 = 最新一条 user 消息（删除前先捕获其输入）
    const userMsgs = messages.value.filter((m) => m.role === 'user');
    const currentUserMsg = userMsgs[userMsgs.length - 1];
    if (!currentUserMsg) return { ok: false, error: '已是最早回合，无可回退' };
    const currentTurn = currentUserMsg.turn ?? 0;
    const capturedInput = currentUserMsg.content;

    // 找上一轮快照（turn <= currentTurn-1 中最新者；快照 turn = 已完成回合数）
    const prevTargetTurn = currentTurn - 1;
    if (prevTargetTurn < 1) return { ok: false, error: '已是最早回合，无可回退' };
    const snapshots = await getSnapshots(activeSaveId.value);
    const prevSnapshot = snapshots
      .filter((s) => s.turn <= prevTargetTurn)
      .sort((a, b) => b.turn - a.turn)[0];
    if (!prevSnapshot) return { ok: false, error: '找不到上一轮快照' };

    // 恢复快照（characters/saveProfile/plotEvents/memories/messages 全回滚 + totalTurns 对齐）
    const sm = createStateManager(activeSaveId.value);
    const result = await sm.restoreSnapshot(prevSnapshot.id);
    if (!result.success) return { ok: false, error: result.errors.join('; ') || '恢复快照失败' };

    // 🔴 恢复后**整表替换**角色内存态：refreshFromDb 的角色同步是合并语义
    //（内存独有角色保留）——快照回退删掉的角色（如回退点之后才生成的 NPC）
    // 会永远留在内存/UI/导出里。先替换再 refreshFromDb（此时合并是幂等）。
    characters.value = (await getCharacters(activeSaveId.value)) as CharacterState[];

    // 回填这轮玩家输入 + 同步内存 + turnCounter 对齐（防重发后 turn 编号错位）
    fillInput(capturedInput);
    await refreshFromDb();
    await restoreMessages();
    const lastMsg = messages.value.filter((m) => m.role === 'user' || m.role === 'assistant').pop();
    turnCounter = lastMsg?.turn ?? 0;
    return { ok: true };
  }

  /** 快照面板「恢复」：恢复到指定历史快照（不回填输入，从该点继续游戏）。 */
  async function restoreToSnapshot(snapshotId: string): Promise<{ ok: boolean; error?: string }> {
    if (!activeSaveId.value) return { ok: false, error: '无活跃存档' };
    if (isInCombat.value) return { ok: false, error: '战斗进行中，无法恢复' };
    const sm = createStateManager(activeSaveId.value);
    const result = await sm.restoreSnapshot(snapshotId);
    if (!result.success) return { ok: false, error: result.errors.join('; ') || '恢复快照失败' };
    // 🔴 同 rollbackOneTurn：整表替换角色内存态，别让回退删掉的角色留在 UI 里
    characters.value = (await getCharacters(activeSaveId.value)) as CharacterState[];
    await refreshFromDb();
    await restoreMessages();
    const lastMsg = messages.value.filter((m) => m.role === 'user' || m.role === 'assistant').pop();
    turnCounter = lastMsg?.turn ?? 0;
    return { ok: true };
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
    combatCoordinator,
    enterCombat,
    applyCombatEvent,
    setCombatCoordinator,
    submitCombatCommand,
    abandonCombat,
    skipCombat,
    restartCombat,
    exitCombat,
    saveProfile,
    fp,
    gameTime,
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
    pendingOptions,
    setPendingOptions,
    pendingItemFocus,
    focusItem,
    clearItemFocus,
    agentStatus,
    agentDurations,
    updateAgentStatus,
    clearAgentStatus,
    clearAllAgentStatus,
    agentLog,
    addAgentLogEntry,
    clearAgentLog,
    ejsVarsRejections,
    recordEjsVarsRejection,
    ejsFallbacks,
    recordEjsFallback,
    ejsUiLog,
    recordEjsUiLog,
    persistMessage,
    restoreMessages,
    rollbackOneTurn,
    restoreToSnapshot,
    removeItem,
    removeSkill,
    removeCharacter,
  };
});
