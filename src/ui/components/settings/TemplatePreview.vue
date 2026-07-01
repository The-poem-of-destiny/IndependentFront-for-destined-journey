<script setup lang="ts">
import { computed } from 'vue'

// ============================================================
// Types
// ============================================================
interface TemplateSegment {
  type: 'text' | 'placeholder'
  raw: string        // The matched {{...}} text (e.g. "{{SYS_PROMPT}}") or plain text
  name: string       // Placeholder name without braces/params (e.g. "SYS_PROMPT")
  params?: string    // Optional params after colon (e.g. "AGENT.STORY:output" → "output")
  color: string      // CSS variable for the badge color
  label: string      // Human-readable description
  category: string   // Category for grouping/reference
}

// ============================================================
// Props
// ============================================================
const props = withDefaults(defineProps<{
  template: string
  agentId?: string
  showLabels?: boolean
}>(), {
  showLabels: true,
})

// ============================================================
// Placeholder metadata registry
// ============================================================
interface PlaceholderMeta {
  label: string
  color: string
  category: string
}

const PLACEHOLDER_META: Record<string, PlaceholderMeta> = {
  // 🔵 Blue — system / base
  SYS_PROMPT: {
    label: '核心指令 — 预设条目拼接或 agent-config.json systemPrompt',
    color: 'var(--color-primary, var(--theme-primary))',
    category: 'system',
  },

  // 🟢 Green — world / context
  LORE_BOOK: {
    label: '世界书 — 按 keyword 激活的条目',
    color: 'var(--color-success, var(--theme-success))',
    category: 'world',
  },
  GAME_TIME: {
    label: '世界状态 — 时间/位置/天气/纪元',
    color: 'var(--color-success, var(--theme-success))',
    category: 'world',
  },

  // 🟡 Amber/Gold — character / state
  CHARACTER_STATE: {
    label: '角色状态 — 主角+在场 NPC 属性/装备/技能',
    color: 'var(--color-warning, var(--theme-warning))',
    category: 'state',
  },
  INVENTORY: {
    label: '背包 — 所有角色的物品列表',
    color: 'var(--color-warning, var(--theme-warning))',
    category: 'state',
  },
  ACTIVE_EFFECTS: {
    label: '活跃效果 — 角色身上的 Buff/Debuff',
    color: 'var(--color-warning, var(--theme-warning))',
    category: 'state',
  },

  // 🟣 Purple — narrative / input
  NARRATIVE: {
    label: '对话历史 — 最近 N 轮 user/assistant 消息',
    color: '#b388ff',
    category: 'narrative',
  },
  USER_INPUT: {
    label: '用户输入 — 当前轮输入',
    color: '#b388ff',
    category: 'narrative',
  },

  // 🔴 Red/Pink — agent outputs
  'AGENT.MEMORY_RECALL': {
    label: 'memory_recall 的输出',
    color: 'var(--color-danger, var(--theme-error))',
    category: 'agent',
  },
  'AGENT.PLOT_PRE_CHECK': {
    label: 'plot_pre_check 的输出',
    color: 'var(--color-danger, var(--theme-error))',
    category: 'agent',
  },
  'AGENT.STORY': {
    label: 'story (正文 AI) 的输出',
    color: 'var(--color-danger, var(--theme-error))',
    category: 'agent',
  },
  'AGENT.VARS_UPDATE': {
    label: 'vars_update 的输出',
    color: 'var(--color-danger, var(--theme-error))',
    category: 'agent',
  },
  'AGENT.MEMORY_SUMMARY': {
    label: 'memory_summary 的输出',
    color: 'var(--color-danger, var(--theme-error))',
    category: 'agent',
  },
  'AGENT.CHAR_UPDATE': {
    label: 'char_update 的输出',
    color: 'var(--color-danger, var(--theme-error))',
    category: 'agent',
  },

  // 🟠 Orange — memory / plot data
  MEMORY_ENTRIES: {
    label: '记忆条目 — embedding 召回的相关记忆',
    color: '#ff944d',
    category: 'data',
  },
  PLOT_EVENTS: {
    label: '剧情事件 — 活跃+待处理的剧情节点',
    color: '#ff944d',
    category: 'data',
  },

  // ⚪ Gray — chain markers
  CRAFT_REQUEST: {
    label: '<craft_request> — Story 输出的制作标记',
    color: 'var(--theme-text-muted, #888)',
    category: 'chain',
  },
  CHAR_DETECT: {
    label: '<char_detect> — Story 输出的角色检测标记',
    color: 'var(--theme-text-muted, #888)',
    category: 'chain',
  },
  ITEM_REQUEST: {
    label: '<item_requests> — craft_gen/char_gen 输出的物品请求',
    color: 'var(--theme-text-muted, #888)',
    category: 'chain',
  },
  CHAR_GEN_RESULT: {
    label: 'char_gen 的输出 — 生成的 NPC 数据',
    color: 'var(--theme-text-muted, #888)',
    category: 'chain',
  },
  CRAFT_RESULT: {
    label: 'craft_gen 的输出 — 制作结果',
    color: 'var(--theme-text-muted, #888)',
    category: 'chain',
  },
}

// Default fallback for unknown placeholders
const FALLBACK_META: PlaceholderMeta = {
  label: '(未注册占位符)',
  color: '#666',
  category: 'unknown',
}

// ============================================================
// Parse template into segments
// ============================================================
const PLACEHOLDER_RE = /\{\{([A-Z_][A-Z0-9_.]*)(?::([^{}]*))?\}\}/g

const segments = computed<TemplateSegment[]>(() => {
  const result: TemplateSegment[] = []
  const tpl = props.template
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  PLACEHOLDER_RE.lastIndex = 0
  while ((match = PLACEHOLDER_RE.exec(tpl)) !== null) {
    // Push preceding plain text
    if (match.index > lastIndex) {
      const raw = tpl.slice(lastIndex, match.index)
      if (raw) {
        result.push({
          type: 'text',
          raw,
          name: '',
          color: '',
          label: '',
          category: '',
        })
      }
    }

    const name = match[1]!
    const params = match[2] || undefined
    const meta = PLACEHOLDER_META[name] ?? FALLBACK_META

    result.push({
      type: 'placeholder',
      raw: match[0],
      name,
      params,
      color: meta.color,
      label: meta.label,
      category: meta.category,
    })

    lastIndex = match.index + match[0].length
  }

  // Push trailing plain text
  if (lastIndex < tpl.length) {
    result.push({
      type: 'text',
      raw: tpl.slice(lastIndex),
      name: '',
      color: '',
      label: '',
      category: '',
    })
  }

  return result
})
</script>

<template>
  <div class="template-preview">
    <!-- Agent badge when agentId is provided -->
    <div v-if="agentId" class="template-agent-badge">
      <span class="text-xs text-muted">Agent:</span>
      <span class="template-agent-id">{{ agentId }}</span>
    </div>

    <!-- Template body -->
    <div class="template-body">
      <template v-for="(seg, idx) in segments" :key="idx">
        <!-- Plain text -->
        <span v-if="seg.type === 'text'" class="template-text">{{ seg.raw }}</span>

        <!-- Placeholder badge -->
        <span
          v-else
          class="template-badge"
          :style="{ '--badge-color': seg.color }"
        >
          <span class="badge-text">
            {{ '{' + '{' + seg.name + (seg.params ? ':' + seg.params : '') + '}' + '}' }}
          </span>
          <span v-if="showLabels" class="badge-label text-xs">{{ seg.label }}</span>
        </span>
      </template>
    </div>

    <!-- Empty state -->
    <div v-if="segments.length === 0" class="template-empty">
      <span class="text-muted text-sm">(空模板)</span>
    </div>
  </div>
</template>

<style scoped>
.template-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Agent badge */
.template-agent-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid var(--theme-card-border, #2c3340);
}

.template-agent-id {
  font-family: 'Monaco', 'Menlo', 'Cascadia Code', monospace;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--theme-primary, #8f9fff);
}

/* Body — preserves whitespace and newlines */
.template-body {
  font-family: 'Monaco', 'Menlo', 'Cascadia Code', monospace;
  font-size: 0.82rem;
  line-height: 1.9;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--theme-text-secondary, #c1c8d4);
  background: color-mix(in srgb, #000 6%, var(--theme-content-bg, #12151b));
  border: 1px solid var(--theme-card-border, #2c3340);
  border-radius: var(--theme-radius-md, 6px);
  padding: 14px 16px;
  max-height: 480px;
  overflow-y: auto;
}

/* Plain text between badges */
.template-text {
  /* inherits from .template-body */
}

/* Badge / pill for placeholders */
.template-badge {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 0 2px;
  vertical-align: middle;
}

.badge-text {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--theme-radius-full, 999px);
  font-family: 'Monaco', 'Menlo', 'Cascadia Code', monospace;
  font-size: 0.78rem;
  font-weight: 600;
  line-height: 1.5;
  color: var(--theme-text-primary, #f3f5f8);
  background: color-mix(in srgb, var(--badge-color) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--badge-color) 40%, transparent);
  white-space: nowrap;
}

/* Tooltip / description label below each badge */
.badge-label {
  display: block;
  font-family: 'Noto Sans SC', sans-serif;
  font-size: 0.68rem;
  line-height: 1.35;
  color: var(--theme-text-muted, #8f98a8);
  padding-left: 4px;
  max-width: 240px;
  white-space: normal;
}

/* Empty state */
.template-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 0;
  min-height: 80px;
}
</style>
