<script setup lang="ts">
import { computed, ref } from 'vue';
import { useGameStore, type DebugAgentEntry } from '../../stores/game-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useUIStore } from '../../stores/ui-store';
import { getEjsBackend } from '@engine/ejs-backend';
import { getEngineSettings } from '@engine/engine-settings';
import { getRandomEventPack } from '@engine/random-event-runtime';
import { buildRandomEventRollContext } from '@engine/random-event-snapshot';
import { getRandomEventFlags } from '@engine/save-profile';
import { toEpochMinutes } from '@engine/time-system';
import {
  buildRandomEventDebugRows,
  formatDailyProbability,
  formatEventWeight,
  type RandomEventDebugRow,
} from './random-event-debug';

const game = useGameStore();
const settings = useSettingsStore();
const ui = useUIStore();

// ═══════════════════════════════════════════════════════════
// 随机事件（随机事件 v1 §4）
// ═══════════════════════════════════════════════════════════

/** 一个游戏日的分钟数（口径同 `state-manager` / `game-pipeline`，那份常量未导出） */
const MINUTES_PER_GAME_DAY = 1440;

/**
 * 候选表**用 `ref` 不用 `computed`**。
 *
 * 事件包（`getRandomEventPack()`）与引擎设置（`getEngineSettings()`）都是**模块级非响应式
 * 状态**：computed 会在第一次求值后把结果连同「当时装的是空包」一起缓存住，此后换存档、
 * 装内容包都不会让它重算 —— 症状是面板永远显示「没装事件包」。所以显式取快照：
 * setup 里同步取一次（面板整块由 AppModal 的 `v-if` 托管，每次打开都是新挂载 = 一次刷新），
 * 入池按钮按完再取一次。
 */
const eventRows = ref<RandomEventDebugRow[]>([]);
const eventPackEmpty = ref(true);
const eventFrequency = ref(1);
const eventsEnabled = ref(true);
const arming = ref('');

function refreshRandomEvents(): void {
  const engine = getEngineSettings();
  eventsEnabled.value = engine.randomEventsEnabled;
  eventFrequency.value = engine.randomEventsFrequency;

  const pack = getRandomEventPack();
  eventPackEmpty.value = pack.defs.length === 0;

  const profile = game.saveProfile;
  if (!profile) {
    eventRows.value = [];
    return;
  }
  try {
    const player = game.characters.find((c) => c.type === 'player');
    eventRows.value = buildRandomEventDebugRows(
      pack.defs,
      getRandomEventFlags(profile),
      // 上下文快照与入池侧、注入侧**共用同一份实现**（`random-event-snapshot`）——
      // 调试面板照抄一份判据的下场是：它会在真机上说谎，而说谎的正是用来查真相的那块面板
      buildRandomEventRollContext(profile, player),
      engine.randomEventsFrequency,
    );
  } catch (err) {
    console.warn('[DebugPanel] 随机事件候选表构建失败:', err);
    eventRows.value = [];
  }
}

// 挂载即取一次（**setup 里同步调，不用 onMounted**：refs 在 onMounted 里改是下一拍才渲染，
// 首帧会闪一下「未装载事件包」；这一层没有任何异步，没理由让用户先看见一个假答案）
refreshRandomEvents();

/** 当前游戏日（表头显示；与调度器的 gameDay 同口径） */
const currentGameDay = computed(() => {
  const profile = game.saveProfile;
  if (!profile) return null;
  return Math.floor(toEpochMinutes(profile.gameTime) / MINUTES_PER_GAME_DAY);
});

/** 「下回合触发」：按 forced 入池 → 下一轮 `{{RANDOM_EVENTS}}` 里带 `[!]` 出现 */
async function armEvent(name: string): Promise<void> {
  if (arming.value.length > 0) return;
  arming.value = name;
  try {
    const result = await game.devArmRandomEvent(name);
    if (result.ok) {
      ui.toast(`已强制入池：${name}（下回合注入给正文）`, 'success');
    } else {
      ui.toast(result.error ?? '入池失败', 'error');
    }
  } finally {
    arming.value = '';
    refreshRandomEvents();
  }
}

/** 本轮 token 汇总（排除 memory_recall 记忆召回，只看正文链路的缓存效率） */
const tokenSummary = computed(() => {
  const entries = game.agentLog.filter((e) => !e.agentId.startsWith('memory_recall'));
  const sum = (sel: (e: DebugAgentEntry) => number | undefined) =>
    entries.reduce((s, e) => s + (sel(e) ?? 0), 0);
  return {
    hit: sum((e) => e.cacheHitTokens),
    miss: sum((e) => e.cacheMissTokens),
    completion: sum((e) => e.completionTokens),
    count: entries.length,
  };
});

/**
 * 当前 EJS 求值后端。
 *
 * 为什么值得在调试面板里占一行：`quickjs` 之外的两种都是**降级态**且**静默** ——
 * `fail-closed` 是 wasm 没装上（世界书动态内容整体停用），`legacy` 是没有隔离边界。
 * 出问题时第一个该确认的就是这里，否则会拿着「世界书不生效」去查世界书本身。
 */
const ejsBackend = computed(() => {
  const b = getEjsBackend();
  const isolated = b.name.includes('quickjs');
  return {
    name: b.name,
    interruptible: b.interruptible,
    isolated,
    hint: isolated
      ? '隔离正常'
      : b.name.includes('fail-closed')
        ? '⚠ 隔离未装载 → 世界书 EJS 已整体停用（条目按原文注入）'
        : '⚠ 无隔离边界（仅测试环境应出现）',
  };
});

/** 组装完整导出数据 */
async function buildExportData() {
  // 🆕 导出前先把 Dexie 最新的 characters / save.metadata / saveProfile 回读进内存，
  // 避免导出开局快照（inventory=[] / totalTurns=0 假象）
  await game.refreshFromDb();
  const sysSettings = settings.settings;
  return {
    exportedAt: new Date().toISOString(),
    save: {
      id: game.activeSaveId,
      name: game.activeSave?.name,
      slot: game.activeSave?.slot,
      metadata: game.activeSave?.metadata,
    },
    characters: game.characters.map((c) => ({
      ...c,
    })),
    messages: game.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
    saveProfile: game.saveProfile,
    agentLog: game.agentLog.map((e) => ({
      agentId: e.agentId,
      label: e.label,
      model: e.model,
      endpointName: e.endpointName,
      baseUrl: e.baseUrl,
      duration: e.duration,
      tokensUsed: e.tokensUsed,
      cacheHit: e.cacheHit,
      cacheHitTokens: e.cacheHitTokens,
      cacheMissTokens: e.cacheMissTokens,
      completionTokens: e.completionTokens,
      error: e.error,
      rawResponse: e.rawResponse,
      reasoning: e.reasoning,
      toolCalls: e.toolCalls,
      messages: e.messages,
    })),
    apiPool: (sysSettings.apiPool as any[]).map((ep: any) => ({
      id: ep.id,
      name: ep.name,
      baseUrl: ep.baseUrl,
      model: ep.model,
      models: ep.models,
      defaultModel: ep.defaultModel,
      apiType: ep.apiType,
      provider: ep.provider,
      enableThinking: ep.enableThinking,
    })),
    // Q-18: per-Agent 设置已合并成一张 `agents` 表；导出整张，调试面要的是全貌
    agents: sysSettings.agents,
    // 工坊 P2 / 能力面：EJS 三类诊断（空 = 本局没发生过）
    ejs: {
      backend: ejsBackend.value,
      // D5: 变量差量被体积护栏整份拒绝
      varsRejections: game.ejsVarsRejections.map((r) => ({
        ...r,
        lastAtISO: new Date(r.lastAt).toISOString(),
      })),
      // D8: 条目求值失败、已回退原文注入
      fallbacks: game.ejsFallbacks.map((r) => ({
        ...r,
        lastAtISO: new Date(r.lastAt).toISOString(),
      })),
      // §3.11: 内容作者自己打的 ui.log
      uiLog: [...game.ejsUiLog],
    },
    // 保留顶层旧字段：调试循环手册里的分析脚本按它取（同一份数据，勿删）
    ejsVarsRejections: game.ejsVarsRejections.map((r) => ({
      ...r,
      lastAtISO: new Date(r.lastAt).toISOString(),
    })),
  };
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

async function downloadJson() {
  const data = await buildExportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fated-poem-debug-${game.activeSaveId?.slice(0, 8)}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function copyJson() {
  const data = await buildExportData();
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = JSON.stringify(data, null, 2);
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
</script>

<template>
  <div class="debug-panel">
    <!-- 操作区 -->
    <div class="debug-actions">
      <button class="debug-btn" @click="downloadJson">导出 JSON</button>
      <button class="debug-btn" @click="copyJson">复制到剪贴板</button>
    </div>

    <!-- 存档摘要 -->
    <div class="debug-section">
      <h4>存档</h4>
      <pre
        >{{ game.activeSave?.name ?? '—' }} | slot={{ game.activeSave?.slot }} | id={{
          game.activeSaveId
        }}</pre>
    </div>

    <!-- 世界书 EJS：后端身份 + 三类静默失效 -->
    <div class="debug-section">
      <h4>世界书 EJS</h4>
      <pre :class="{ 'debug-warn': !ejsBackend.isolated }">
求值后端: {{ ejsBackend.name }} | 可中断: {{ ejsBackend.interruptible ? '是' : '否' }}
{{ ejsBackend.hint }}</pre>

      <!-- 条目回退：静默失效之一 —— 条目照常进提示词，只是没被求值 -->
      <template v-if="game.ejsFallbacks.length > 0">
        <h5 class="debug-sub-h">条目求值失败、已回退原文 ({{ game.ejsFallbacks.length }})</h5>
        <pre v-for="f in game.ejsFallbacks" :key="`${f.agentId}#${f.uid}`" class="debug-warn"
          >{{ f.bookName ?? '?' }}#{{ f.uid }} ({{ f.agentId }}) | 累计 {{ f.count }} 次 | 最近 {{
            formatTime(f.lastAt)
          }}
  {{ f.error }}</pre>
      </template>

      <!-- 变量差量被体积护栏整份拒绝 -->
      <template v-if="game.ejsVarsRejections.length > 0">
        <h5 class="debug-sub-h">变量写入被丢弃 ({{ game.ejsVarsRejections.length }})</h5>
        <pre v-for="r in game.ejsVarsRejections" :key="r.agentId" class="debug-warn"
          >{{ r.label }} ({{ r.agentId }}) | 累计 {{ r.count }} 次 | 最近 {{
            formatTime(r.lastAt)
          }} | 体积 {{ r.lastSize }} 字节</pre>
      </template>

      <!-- 内容作者自己打的 ui.log -->
      <details v-if="game.ejsUiLog.length > 0" class="debug-agent-details">
        <summary>内容调试输出 ui.log ({{ game.ejsUiLog.length }})</summary>
        <pre class="debug-uilog">{{ game.ejsUiLog.join('\n') }}</pre>
      </details>

      <div
        v-if="
          game.ejsFallbacks.length === 0 &&
          game.ejsVarsRejections.length === 0 &&
          game.ejsUiLog.length === 0
        "
        class="debug-empty"
      >
        本局未出现回退 / 丢弃，内容也没打过调试输出
      </div>
    </div>

    <!-- 随机事件：当前「调度器会考虑」的定义 + 各自的 MTTH 因子 -->
    <div class="debug-section">
      <h4>
        随机事件 ({{ eventRows.length }})
        <span class="debug-re-meta">
          第 {{ currentGameDay ?? '—' }} 日 · 频率 ×{{ eventFrequency }}
          <template v-if="!eventsEnabled"> · <span class="debug-warn">系统已关闭</span></template>
        </span>
      </h4>
      <div v-if="eventPackEmpty" class="debug-empty">未装载事件包（本子系统整段 no-op）</div>
      <div v-else-if="!game.saveProfile" class="debug-empty">无活跃存档</div>
      <div v-else-if="eventRows.length === 0" class="debug-empty">
        当前上下文下没有事件通过 available 硬门槛（或已被 once 消耗）
      </div>
      <table v-else class="debug-re-table">
        <thead>
          <tr>
            <th>名字</th>
            <th>触发</th>
            <th>权重</th>
            <th>日概率</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in eventRows" :key="row.name">
            <td>
              {{ row.name }}
              <span v-if="row.inPool" class="debug-re-pill">在池</span>
              <span v-if="row.priority !== 0" class="debug-re-dim">P{{ row.priority }}</span>
            </td>
            <td>
              <template v-if="row.kind === 'mtth'">{{ row.mtthDays }} 天</template>
              <template v-else>
                首访
                <span class="debug-re-dim">{{
                  (row.places ?? []).join(' / ') || '（无地点）'
                }}</span>
              </template>
            </td>
            <td :class="{ 'debug-warn': row.weight === 0 }">
              ×{{ formatEventWeight(row.weight) }}
            </td>
            <td>{{ formatDailyProbability(row.dailyProbability) }}</td>
            <td>
              <button
                class="debug-btn debug-btn-sm"
                :disabled="arming.length > 0"
                title="按 forced 塞进候选池，下回合注入给正文（绕过掷骰/冷却/权重）"
                @click="armEvent(row.name)"
              >
                下回合触发
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Agent 调用日志 -->
    <div class="debug-section">
      <h4>本轮 Agent 调用 ({{ game.agentLog.length }})</h4>
      <div v-if="game.agentLog.length === 0" class="debug-empty">
        暂无日志（等待下一轮管线触发）
      </div>
      <div v-else class="debug-token-summary">
        本轮汇总（排除记忆召回 · {{ tokenSummary.count }} 个 Agent）: 命中
        <strong>{{ tokenSummary.hit }}</strong> / 未命中 <strong>{{ tokenSummary.miss }}</strong> /
        输出 <strong>{{ tokenSummary.completion }}</strong>
      </div>
      <div
        v-for="entry in game.agentLog"
        :key="entry.agentId"
        class="debug-agent-entry"
        :class="{ 'has-error': entry.error }"
      >
        <div class="debug-agent-head">
          <span class="debug-agent-label">{{ entry.label }}</span>
          <span class="debug-agent-model">{{ entry.model || '无模型' }}</span>
          <span v-if="entry.error" class="debug-agent-err">{{ entry.error }}</span>
          <span v-else class="debug-agent-ok"
            >命中 {{ entry.cacheHitTokens ?? 0 }} / 未命中 {{ entry.cacheMissTokens ?? 0 }} / 输出
            {{ entry.completionTokens ?? 0 }} · {{ entry.duration }}ms</span
          >
        </div>
        <details class="debug-agent-details">
          <summary>请求 ({{ entry.messages.length }} 条消息) / 响应</summary>
          <div class="debug-section-split">
            <div class="debug-half">
              <h5>请求</h5>
              <div v-for="(m, i) in entry.messages" :key="i" class="debug-msg">
                <span class="debug-role">{{ m.role }}</span>
                <pre>{{ truncate(m.content ?? '', 500) }}</pre>
              </div>
              <div v-if="entry.messages.length === 0" class="debug-empty-sub">
                消息未捕获（流式模式下请求由编排器内部构造）
              </div>
            </div>
            <div class="debug-half">
              <h5>响应 @ {{ entry.baseUrl || '—' }}</h5>
              <pre>{{ truncate(entry.rawResponse, 1000) || '（空响应）' }}</pre>
              <template v-if="entry.reasoning">
                <h6 class="debug-reasoning-h">思维链</h6>
                <pre class="debug-reasoning-pre">{{ truncate(entry.reasoning, 2000) }}</pre>
              </template>
              <template v-if="entry.toolCalls?.length">
                <h6 class="debug-reasoning-h">工具调用 ({{ entry.toolCalls.length }})</h6>
                <details
                  v-for="(tool, index) in entry.toolCalls"
                  :key="`${tool.name}-${index}`"
                  class="debug-tool-call"
                >
                  <summary>{{ tool.name }}</summary>
                  <pre>参数: {{ truncate(formatJson(tool.arguments), 1200) }}</pre>
                  <pre>结果: {{ truncate(formatJson(tool.result), 1200) }}</pre>
                </details>
              </template>
            </div>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debug-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 70vh;
  overflow-y: auto;
  min-height: 300px;
}
.debug-actions {
  display: flex;
  gap: 8px;
}
.debug-btn {
  padding: 6px 14px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
  cursor: pointer;
  font-family: inherit;
}
.debug-btn:hover {
  background: var(--theme-card-bg);
}
.debug-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.debug-btn-sm {
  padding: 2px 8px;
  font-size: 0.6875rem;
}
.debug-section {
  border-bottom: 1px solid var(--theme-card-border);
  padding-bottom: 12px;
}
/* 随机事件表：一屏能扫完的密度，宽了就自己横滚（不许把面板撑破） */
.debug-re-meta {
  font-weight: 400;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  margin-left: 6px;
}
.debug-re-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
}
.debug-re-table th {
  text-align: left;
  font-weight: 600;
  color: var(--theme-text-muted);
  padding: 2px 6px 4px 0;
  border-bottom: 1px solid var(--theme-card-border);
}
.debug-re-table td {
  padding: 3px 6px 3px 0;
  vertical-align: middle;
}
.debug-re-pill {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 0.5625rem;
  background: color-mix(in srgb, var(--theme-primary) 18%, transparent);
  color: var(--theme-primary);
}
.debug-re-dim {
  margin-left: 4px;
  color: var(--theme-text-muted);
}
.debug-section h4 {
  font-size: 0.8125rem;
  font-weight: 600;
  margin: 0 0 8px;
  color: var(--theme-text-secondary);
}
.debug-section pre {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  white-space: pre-wrap;
  margin: 0;
  font-family: 'Consolas', 'Courier New', monospace;
}
.debug-empty {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-style: italic;
}
/* 降级/失效态：跟正常诊断行拉开色差，扫一眼就能看见 */
.debug-warn {
  color: color-mix(in srgb, var(--theme-error) 80%, var(--theme-text-primary)) !important;
}
.debug-sub-h {
  font-size: 0.6875rem;
  font-weight: 600;
  margin: 8px 0 4px;
  color: var(--theme-text-muted);
}
.debug-uilog {
  font-size: 0.625rem;
  max-height: 220px;
  overflow: auto;
  background: var(--theme-card-bg);
  padding: 4px 6px;
  border-radius: 3px;
  margin-top: 4px;
}
.debug-token-summary {
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
  padding: 4px 8px;
  margin-bottom: 6px;
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
  border-radius: var(--theme-radius-sm, 4px);
}
.debug-token-summary strong {
  color: var(--theme-primary);
  font-weight: 700;
}
.debug-empty-sub {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-style: italic;
}

/* Agent entry */
.debug-agent-entry {
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm, 4px);
  padding: 8px 10px;
  margin-bottom: 6px;
}
.debug-agent-entry.has-error {
  border: 1px solid color-mix(in srgb, var(--theme-error) 55%, var(--theme-card-border));
}
.debug-agent-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.75rem;
}
.debug-agent-label {
  font-weight: 600;
  color: var(--theme-text-primary);
}
.debug-agent-model {
  color: var(--theme-text-muted);
  font-family: 'Consolas', monospace;
}
.debug-agent-err {
  color: #e74c3c;
  font-size: 0.6875rem;
}
.debug-agent-ok {
  color: #27ae60;
  font-size: 0.6875rem;
}
.debug-agent-details {
  margin-top: 6px;
}
.debug-agent-details summary {
  cursor: pointer;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.debug-section-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 6px;
}
.debug-half h5 {
  font-size: 0.6875rem;
  margin: 0 0 4px;
  color: var(--theme-text-muted);
}
.debug-half pre {
  font-size: 0.625rem;
  max-height: 200px;
  overflow: auto;
  background: var(--theme-card-bg);
  padding: 4px 6px;
  border-radius: 3px;
}
.debug-msg {
  margin-bottom: 4px;
}
.debug-role {
  display: inline-block;
  font-size: 0.5625rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--theme-primary);
  margin-bottom: 2px;
}
.debug-reasoning-h {
  font-size: 0.625rem;
  margin: 6px 0 2px;
  color: #b06ab3;
}
.debug-reasoning-pre {
  font-size: 0.625rem;
  max-height: 200px;
  overflow: auto;
  background: var(--theme-card-bg);
  padding: 4px 6px;
  border-radius: 3px;
  white-space: pre-wrap;
  color: var(--theme-text-muted);
}
.debug-tool-call {
  margin-top: var(--theme-spacing-xs);
  padding: var(--theme-spacing-xs) calc(var(--theme-spacing-md) / 2);
  border: 1px solid var(--theme-card-border);
  border-radius: 3px;
  background: var(--theme-card-bg);
}
.debug-tool-call summary {
  cursor: pointer;
  color: var(--theme-text-secondary);
  font-size: 0.625rem;
}
.debug-tool-call pre {
  margin: 4px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
