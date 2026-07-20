<script setup lang="ts">
import { useGameStore, type DebugAgentEntry } from '../../stores/game-store'
import { useSettingsStore } from '../../stores/settings-store'
import AppModal from '../shared/AppModal.vue'

const game = useGameStore()
const settings = useSettingsStore()

/** 组装完整导出数据 */
async function buildExportData() {
  // 🆕 导出前先把 Dexie 最新的 characters / save.metadata / saveProfile 回读进内存，
  // 避免导出开局快照（inventory=[] / totalTurns=0 假象）
  await game.refreshFromDb()
  const sysSettings = settings.settings
  return {
    exportedAt: new Date().toISOString(),
    save: {
      id: game.activeSaveId,
      name: game.activeSave?.name,
      slot: game.activeSave?.slot,
      metadata: game.activeSave?.metadata,
    },
    characters: game.characters.map(c => ({
      ...c,
    })),
    messages: game.messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
    saveProfile: game.saveProfile,
    agentLog: game.agentLog.map(e => ({
      agentId: e.agentId,
      label: e.label,
      model: e.model,
      endpointName: e.endpointName,
      baseUrl: e.baseUrl,
      duration: e.duration,
      tokensUsed: e.tokensUsed,
      cacheHit: e.cacheHit,
      error: e.error,
      rawResponse: e.rawResponse,
      reasoning: e.reasoning,
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
    agentModels: sysSettings.agentModels,
  }
}

async function downloadJson() {
  const data = await buildExportData()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `fated-poem-debug-${game.activeSaveId?.slice(0, 8)}-${Date.now()}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function copyJson() {
  const data = await buildExportData()
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2))
  } catch {
    // fallback
    const ta = document.createElement('textarea')
    ta.value = JSON.stringify(data, null, 2)
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

function truncate(str: string, max: number): string {
  if (!str) return ''
  return str.length > max ? str.slice(0, max) + '…' : str
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
      <pre>{{ game.activeSave?.name ?? '—' }} | slot={{ game.activeSave?.slot }} | id={{ game.activeSaveId }}</pre>
    </div>

    <!-- Agent 调用日志 -->
    <div class="debug-section">
      <h4>本轮 Agent 调用 ({{ game.agentLog.length }})</h4>
      <div v-if="game.agentLog.length === 0" class="debug-empty">暂无日志（等待下一轮管线触发）</div>
      <div v-for="entry in game.agentLog" :key="entry.agentId" class="debug-agent-entry" :class="{ 'has-error': entry.error }">
        <div class="debug-agent-head">
          <span class="debug-agent-label">{{ entry.label }}</span>
          <span class="debug-agent-model">{{ entry.model || '无模型' }}</span>
          <span v-if="entry.error" class="debug-agent-err">{{ entry.error }}</span>
          <span v-else class="debug-agent-ok">{{ entry.tokensUsed }}t / {{ entry.duration }}ms</span>
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
              <div v-if="entry.messages.length === 0" class="debug-empty-sub">消息未捕获（流式模式下请求由编排器内部构造）</div>
            </div>
            <div class="debug-half">
              <h5>响应 @ {{ entry.baseUrl || '—' }}</h5>
              <pre>{{ truncate(entry.rawResponse, 1000) || '（空响应）' }}</pre>
              <template v-if="entry.reasoning">
                <h6 class="debug-reasoning-h">思维链</h6>
                <pre class="debug-reasoning-pre">{{ truncate(entry.reasoning, 2000) }}</pre>
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
.debug-section {
  border-bottom: 1px solid var(--theme-card-border);
  padding-bottom: 12px;
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
</style>
