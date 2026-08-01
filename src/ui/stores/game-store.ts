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
import type { CombatEvent } from '@engine/combat-runner';

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
  const isInCombat = computed(
    () => activeCombat.value !== null && activeCombat.value.status !== 'ended',
  );

  // === M5 战斗面板状态 ===
  /** 战斗消息流条目（叙事 + 动作结果卡片 + 回合分隔） */
  const combatLog = ref<CombatLogEntry[]>([]);
  /** 当前等玩家输入的我方单位（null = 不在等输入） */
  const combatAwaitingInput = ref<{ unit: string; unitId: string; round: number } | null>(null);
  /** 当前行动者 characterId（turn_started 事件更新，单位卡片高亮用） */
  const combatCurrentUnitId = ref<string | null>(null);
  /** runner 注册的玩家文本提交器（pipeline 通过 registerSubmitter 挂入；runner emit 时持有 pendingResolver） */
  const combatSubmitter = ref<((text: string) => void) | null>(null);

  /** 战斗开始：清空面板状态（activeCombat 由 combat_started 事件填） */
  function enterCombat() {
    combatLog.value = [];
    combatAwaitingInput.value = null;
    combatCurrentUnitId.value = null;
    combatSubmitter.value = null;
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
      // combat_ended（exitCombat 收尾）
    }
  }

  /** pipeline 收到 runner registerSubmitter → 挂入 store */
  function setCombatSubmitter(submit: (text: string) => void) {
    combatSubmitter.value = submit;
  }

  /** 玩家发送战斗指令（CombatActionBar 调用）→ 转发 runner → resolve pendingResolver */
  function submitCombatInput(text: string) {
    const s = combatSubmitter.value;
    if (s) {
      s(text);
      combatAwaitingInput.value = null;
    }
  }

  /** 战斗结束：清空面板（activeCombat=null → isInCombat=false） */
  function exitCombat() {
    activeCombat.value = null;
    combatLog.value = [];
    combatAwaitingInput.value = null;
    combatCurrentUnitId.value = null;
    combatSubmitter.value = null;
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

  // === Agent 管线状态（供 AgentStatusPanel 读取） ===
  interface AgentStatusEntry {
    agentId: string;
    label: string;
    startedAt: number;
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
   * 改写本存档的世界书条目启用轴（`metadata.enabledWorldBookEntries`）。
   *
   * ADR-21 的受控例外（P1-09）：这是**纯 UI 辅助字段**，与 `markOpeningPromptConsumed`
   * 同一条路径 —— 经本统一写入函数 + try/catch，不裸 `db.put`。AI 产生的存档变更
   * 仍必须走 `vars_update` 语义 op，不在此例外内。
   *
   * 写完同步回内存 `saves`，否则 `activeSave` 仍是旧值，面板会显示成没改动。
   */
  async function setEnabledWorldBookEntries(entries: string[]): Promise<boolean> {
    const current = activeSave.value;
    if (!current) return false;
    const clean = JSON.parse(JSON.stringify(current));
    clean.metadata = { ...(clean.metadata ?? {}), enabledWorldBookEntries: [...entries] };
    clean.updatedAt = Date.now();
    try {
      await saveSaveSlot(clean);
      const idx = saves.value.findIndex((s: SaveSlot) => s.id === clean.id);
      if (idx >= 0) saves.value[idx] = clean;
      return true;
    } catch (err) {
      console.error('[game-store] 写入世界书启用轴失败:', err);
      return false;
    }
  }

  /** 标记开场 Prompt 已消费 */
  async function markOpeningPromptConsumed() {
    if (!activeSave.value) return;
    const clean = JSON.parse(JSON.stringify(activeSave.value));
    clean.metadata.openingPromptConsumed = true;
    try {
      await saveSaveSlot(clean);
    } catch (err) {
      console.error('[game-store] 标记开场 Prompt 失败:', err);
    }
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

  function addMessage(content: string, role: 'user' | 'assistant'): void {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: Date.now(),
      saveId: activeSaveId.value ?? undefined,
      turn: role === 'user' ? ++turnCounter : turnCounter,
    };
    messages.value.push(msg);
    // 异步持久化（不阻塞 UI）
    persistMessage(msg);
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
    persistMessage(msg);
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
    await refreshFromDb();
    await restoreMessages();
    const lastMsg = messages.value.filter((m) => m.role === 'user' || m.role === 'assistant').pop();
    turnCounter = lastMsg?.turn ?? 0;
    return { ok: true };
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
    enterCombat,
    applyCombatEvent,
    setCombatSubmitter,
    submitCombatInput,
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
    persistMessage,
    restoreMessages,
    rollbackOneTurn,
    restoreToSnapshot,
  };
});
