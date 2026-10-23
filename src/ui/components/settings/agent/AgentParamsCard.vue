<script setup lang="ts">
/**
 * Agent 的三张设置卡：API 池选择 / LLM 参数 / 世界书读取范围（只读）（Q-25 第 9 步）。
 *
 * 三张卡合成一个组件而不是三个，是因为它们**共用同一对读写口** ——
 * `agentCfg`（合上默认层的当前设置）与 `setAgentField`（改一项并置脏位）。
 * 拆成三个各自重建这对助手的组件，只会得到三个没有实现的壳。
 *
 * 🔴 `wb.init()` **不在这里** —— 它留在 SettingsPage 的 onMounted。世界书分区
 *    （WorldBookSection）自己不调 init，同样靠壳层那一次；搬进来会让那个分区
 *    在没进过 Agent 分区时列表为空。
 *
 * 🔴 D44 修正 1/4：`getAgentSettings` 现在合**默认层**（pack > 占位），数值/提示词/
 *    model 的有效值走「覆写 ?? 默认」。每张卡上的「默认 / 已覆写」徽标告诉用户这个
 *    值是默认层给的还是用户改过——「已覆写」意味着覆写层有条目、清掉即回默认。
 */
import { computed, ref } from 'vue';
import { normalizeStoryWindowTurns } from '@engine/story/story-context-mode';
import AppCard from '../../shared/AppCard.vue';
import { useSettingsStore } from '../../../stores/settings-store';
import { useWorldBookStore } from '../../../stores/worldbook-store';
import {
  getAgentSettings,
  patchAgentSettings,
  type AgentDefaultsLayer,
  type AgentSettingsEntry,
} from '../../../stores/agent-settings';
import { isLoreEntryVisibleTo } from '@engine/content/lore-routing';

const props = defineProps<{ agentId: string }>();

const cfg = useSettingsStore();
const s = cfg.settings;
const wb = useWorldBookStore();

/** 配过 API 池没有 —— 一行派生，与子导航那处各算各的（不穿成 prop） */
const llmEndpoints = computed(() =>
  s.apiPool.filter((entry) => !entry.kind || entry.kind === 'llm'),
);
const hasApi = computed(() => llmEndpoints.value.length > 0);

/** 当前 Agent 的默认层（pack > 占位）—— 传给 getAgentSettings 合覆写 ?? 默认 */
const defaultsLayer = computed<AgentDefaultsLayer>(() => {
  const agents = cfg.projectAgentDefaults?.agents;
  if (!agents) return {};
  const layer: AgentDefaultsLayer = {};
  for (const [id, entry] of Object.entries(agents)) {
    layer[id] = entry as Partial<AgentSettingsEntry>;
  }
  return layer;
});

/** 当前 Agent 的完整设置（已合覆写 ?? 默认层） */
const agentCfg = computed(() => getAgentSettings(s, props.agentId, defaultsLayer.value));

/**
 * 某字段是不是「已被用户覆写」—— 用于「默认 / 已覆写」徽标。
 * 覆写层（s.agents[agentId]）里有该键 = 已覆写；否则走默认层。
 */
function isOverridden(field: keyof AgentSettingsEntry): boolean {
  const agents = (s as unknown as { agents?: Record<string, Record<string, unknown>> }).agents;
  if (!agents) return false;
  const entry = agents[props.agentId];
  return Boolean(entry && typeof entry === 'object' && field in entry);
}

/** 改若干项并置脏位 —— 每个旋钮共用这一条写入路径 */
function setAgentField(patch: Partial<AgentSettingsEntry>) {
  patchAgentSettings(s, props.agentId, patch);
  s.agentDirty[props.agentId] = true;
}

const isStoryV2 = computed(() => props.agentId === 'story' && s.storyContextV2Enabled === true);
const historyLayersError = ref('');

/** 留空恢复默认；只有 Story v2 要求正文窗口为正整数。 */
function onHistoryLayersInput(ev: Event) {
  const v = (ev.target as HTMLInputElement).value;
  if (isStoryV2.value && v !== '' && normalizeStoryWindowTurns(Number(v)) === null) {
    historyLayersError.value = 'Story v2 正文窗口 N 必须是正整数，不能为 0。';
    return;
  }
  historyLayersError.value = '';
  setAgentField({ historyLayers: v === '' ? undefined : Number(v) });
}
function onHistorySliceInput(ev: Event) {
  if (isStoryV2.value) return;
  const v = (ev.target as HTMLInputElement).value;
  setAgentField({ historySlice: v === '' ? undefined : Number(v) });
}

/**
 * 🆕 2026-08-22 Delta 会话（T4）：单一 tailPrompt。
 * 留空 = 写 `undefined` = 删键 —— 与 historyLayers/historySlice 同一条纪律：
 * 「键不存在」编码「未配置」，不会挡掉引擎对空值的处理（tail 区块整个省略）。
 */
function onTailPromptInput(ev: Event) {
  const v = (ev.target as HTMLTextAreaElement).value;
  setAgentField({ tailPrompt: v.trim() === '' ? undefined : v });
}

/**
 * 该 Agent 能读到的世界书（只读）—— 读取范围由**条目自己的** `extra.lore.audiences` 决定
 * （内容计划 §3.2 / §7.2），这里**不提供**逐 Agent 的书清单、开关或范围编辑。
 */
const readableBooks = computed(() =>
  wb.books
    .map((book) => ({
      book,
      count: book.entries.filter((e) => e.enabled && isLoreEntryVisibleTo(props.agentId, book, e))
        .length,
    }))
    .filter((row) => row.count > 0),
);
</script>

<template>
  <!-- 模型选择 — 从 API 池中选择 -->
  <AppCard padding="md" class="detail-card">
    <h4>
      API 池选择
      <span class="source-badge" :class="{ overridden: isOverridden('model') }">{{
        isOverridden('model') ? '已覆写' : '默认'
      }}</span>
    </h4>
    <p class="form-hint">为此 Agent 指定一个已配置好的 API 池（含端点地址、密钥和默认模型）。</p>
    <div class="key-row">
      <select
        class="form-input"
        :value="agentCfg.model"
        @change="setAgentField({ model: ($event.target as HTMLSelectElement).value })"
      >
        <option value="">— 请选择 API 池 —</option>
        <option v-for="ep in llmEndpoints" :key="ep.id" :value="ep.id">
          {{ ep.name }} — {{ ep.model || '未选择模型' }}
        </option>
      </select>
      <span v-if="!agentCfg.model && !hasApi" class="api-warn">请先配置 API</span>
      <span v-else-if="!agentCfg.model" class="api-warn">未选择</span>
      <span v-else class="api-ok">✓</span>
    </div>
  </AppCard>

  <!-- LLM 参数 (所有 Agent 通用) -->
  <AppCard padding="md" class="detail-card">
    <h4>LLM 参数</h4>
    <p class="form-hint">
      控制此 Agent 的采样行为和生成长度。带「已覆写」徽标的参数是你改过的；清掉覆写即回默认。
    </p>
    <div
      class="form-grid"
      style="grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px"
    >
      <label class="form-label"
        >Temperature
        <span class="source-badge" :class="{ overridden: isOverridden('temperature') }">{{
          isOverridden('temperature') ? '已覆写' : '默认'
        }}</span>
        <p class="form-hint">越高越随机 (0-2)</p>
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          :value="agentCfg.temperature"
          class="form-input"
          @input="
            setAgentField({
              temperature: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
      </label>
      <label class="form-label"
        >Top P
        <span class="source-badge" :class="{ overridden: isOverridden('topP') }">{{
          isOverridden('topP') ? '已覆写' : '默认'
        }}</span>
        <p class="form-hint">核采样阈值 (0-1)</p>
        <input
          type="number"
          step="0.05"
          min="0"
          max="1"
          :value="agentCfg.topP"
          class="form-input"
          @input="setAgentField({ topP: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>
      <label class="form-label"
        >Frequency Penalty
        <span class="source-badge" :class="{ overridden: isOverridden('freqPen') }">{{
          isOverridden('freqPen') ? '已覆写' : '默认'
        }}</span>
        <p class="form-hint">抑制重复 (-2 ~ 2)</p>
        <input
          type="number"
          step="0.1"
          min="-2"
          max="2"
          :value="agentCfg.freqPen"
          class="form-input"
          @input="
            setAgentField({
              freqPen: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
      </label>
      <label class="form-label"
        >Presence Penalty
        <span class="source-badge" :class="{ overridden: isOverridden('presPen') }">{{
          isOverridden('presPen') ? '已覆写' : '默认'
        }}</span>
        <p class="form-hint">鼓励新话题 (-2 ~ 2)</p>
        <input
          type="number"
          step="0.1"
          min="-2"
          max="2"
          :value="agentCfg.presPen"
          class="form-input"
          @input="
            setAgentField({
              presPen: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
      </label>
      <label class="form-label"
        >Max Tokens
        <span class="source-badge" :class="{ overridden: isOverridden('maxTokens') }">{{
          isOverridden('maxTokens') ? '已覆写' : '默认'
        }}</span>
        <p class="form-hint">单次回复最大长度</p>
        <input
          type="number"
          min="100"
          max="384000"
          step="100"
          :value="agentCfg.maxTokens"
          class="form-input"
          @input="
            setAgentField({
              maxTokens: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
      </label>
      <label class="form-label"
        >失败重试次数
        <span class="source-badge" :class="{ overridden: isOverridden('maxRetries') }">{{
          isOverridden('maxRetries') ? '已覆写' : '默认'
        }}</span>
        <p class="form-hint">请求失败后自动重试几遍（0=不重试；指数退避）。手动停止永不重试。</p>
        <input
          type="number"
          min="0"
          max="5"
          step="1"
          :value="agentCfg.maxRetries"
          class="form-input"
          @input="
            setAgentField({
              maxRetries: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
      </label>
      <label class="form-label"
        >历史注入层数
        <span class="source-badge" :class="{ overridden: isOverridden('historyLayers') }">{{
          isOverridden('historyLayers') ? '已覆写' : '默认'
        }}</span>
        <p class="form-hint">
          {{
            isStoryV2
              ? 'Story v2 正文窗口 N：保留最近 N 个完整回合原文。只接受正整数；留空恢复默认 6 回合。窗口外由摘要承接，不截断原文。'
              : '注入最近 N 轮「玩家+AI」对话历史（0=不注入；留空=按 Agent 类别默认）。后置型 Agent 默认 1 轮辅助上文，长正文型默认 6 轮'
          }}
        </p>
        <input
          type="number"
          max="20"
          step="1"
          :value="agentCfg.historyLayers ?? ''"
          :min="isStoryV2 ? 1 : 0"
          :aria-invalid="isStoryV2 && !!historyLayersError"
          aria-label="历史注入层数"
          placeholder="(默认)"
          class="form-input"
          @input="onHistoryLayersInput($event)"
        />
        <p v-if="isStoryV2 && historyLayersError" class="api-warn" role="alert">
          {{ historyLayersError }}
        </p>
      </label>
      <label class="form-label"
        >历史截断字数
        <span class="source-badge" :class="{ overridden: isOverridden('historySlice') }">{{
          isOverridden('historySlice') ? '已覆写' : '默认'
        }}</span>
        <p class="form-hint">
          {{
            isStoryV2
              ? 'Story v2 保留完整回合原文，此旧模式截断设置不生效；已保存的旧值保留，关闭 v2 后恢复使用。'
              : '每条历史正文保留前多少字（留空=按 Agent 类别默认，长正文型默认 1500，后置型默认 800）'
          }}
        </p>
        <input
          type="number"
          min="100"
          max="8000"
          step="100"
          :value="agentCfg.historySlice ?? ''"
          :disabled="isStoryV2"
          aria-label="历史截断字数"
          placeholder="(默认)"
          class="form-input"
          @input="onHistorySliceInput($event)"
        />
      </label>
    </div>

    <!-- 🆕 2026-08-22 Delta 会话（T4）：单一 tailPrompt —— 每轮最新 user 消息末尾的指令。
         与上面的数值旋钮分开成段（它是文本指令，不是采样参数）；留空 = 删键 = 不注入。 -->
    <label class="form-label tail-prompt-field">
      末尾指令 (tailPrompt)
      <span class="source-badge" :class="{ overridden: isOverridden('tailPrompt') }">{{
        isOverridden('tailPrompt') ? '已覆写' : '默认'
      }}</span>
      <p class="form-hint">
        Delta 会话：每轮最新的 user 消息末尾都会追加这段指令。留空 = 不注入（缺省）。
      </p>
      <textarea
        class="form-input form-textarea"
        :value="agentCfg.tailPrompt ?? ''"
        placeholder="例如：请用简体中文作答，并保持第二人称叙事。"
        rows="3"
        @input="onTailPromptInput($event)"
      />
    </label>
  </AppCard>

  <!-- 世界书读取范围（只读；由内容声明决定，内容计划 §7.2） -->
  <AppCard padding="md" class="detail-card">
    <h4>世界书读取范围</h4>
    <p class="form-hint">
      这个 Agent 能读哪些世界书条目由内容包与世界书自身的读取范围决定，不在这里设置。
      自建世界书的读取范围可在「世界书」分区的编辑器里调整。
    </p>
    <ul v-if="readableBooks.length > 0" class="worldbook-scope-list">
      <li v-for="row in readableBooks" :key="row.book.id">
        <i class="fa-solid fa-book" aria-hidden="true"></i>
        <span class="wb-scope-label">{{ row.book.name }}</span>
        <span class="text-xs text-muted">{{ row.count }} 条</span>
      </li>
    </ul>
    <p v-else class="text-muted text-sm">当前没有这个 Agent 可读的世界书条目。</p>
  </AppCard>
</template>

<!-- 🔴 顺序不可颠倒：共用外壳必须在自有块**之前**。`.toggle-sm` 与 chrome 里的
     `.toggle-slider` 特异性相同（0,1,0），全靠这个顺序才赢 —— 反过来写，
     预设条目的小开关会悄悄变回 40x22。 -->
<style scoped src="../settings-chrome.css"></style>

<style scoped>
.worldbook-scope-list {
  list-style: none;
  margin: var(--theme-spacing-sm) 0 0;
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.worldbook-scope-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.worldbook-scope-list i {
  font-size: 13px;
  opacity: 0.5;
}
.wb-scope-label {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
}
/* 🆕 tailPrompt 文本域：与数值网格之间留一跳呼吸（它跟在 form-grid 后面） */
.tail-prompt-field {
  margin-top: var(--theme-spacing-md);
}
.tail-prompt-field .form-textarea {
  width: 100%;
  line-height: 1.5;
}
/* 「默认 / 已覆写」徽标 —— D44 修正 4 来源标识 */
.source-badge {
  display: inline-block;
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: var(--theme-radius-sm);
  margin-left: 6px;
  vertical-align: middle;
  background: color-mix(in srgb, var(--theme-text-muted) 14%, transparent);
  color: var(--theme-text-muted);
  border: 1px solid transparent;
  letter-spacing: 0.02em;
}
.source-badge.overridden {
  background: color-mix(in srgb, var(--theme-primary) 16%, transparent);
  color: var(--theme-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 30%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .source-badge {
    transition: none;
  }
}
</style>
