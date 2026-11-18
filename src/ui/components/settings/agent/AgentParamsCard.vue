<script setup lang="ts">
import { isDirectSettingsProfile } from '../../../lib/direct-settings';

/**
 * Agent 的设置卡：API 池选择 / 采样参数 / 上下文 / 缓存会话（仅缓存直出）/
 * 世界书读取范围（只读）（Q-25 第 9 步）。
 *
 * 几张卡合成一个组件而不是各自一个，是因为它们**共用同一对读写口** ——
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
import {
  DIRECT_CACHE_REBUILD_DEFAULTS,
  DIRECT_CACHE_REBUILD_RANGE,
  normalizeDirectCacheRebuild,
} from '@engine/prompts/direct-context-session';
import AppButton from '../../shared/AppButton.vue';
import AppCard from '../../shared/AppCard.vue';
import { useSettingsStore } from '../../../stores/settings-store';
import { useWorldBookStore } from '../../../stores/worldbook-store';
import {
  getAgentSettings,
  patchAgentSettings,
  resolveAgentLlmParamSources,
  type AgentDefaultsLayer,
  type AgentLlmParamField,
  type AgentLlmParamSource,
  type AgentSettingsEntry,
} from '../../../stores/agent-settings';
import { buildApiEndpoints, describeAgentBinding } from '../../../lib/endpoint-resolver';
import { isLoreEntryVisibleTo } from '@engine/content/lore-routing';

const props = defineProps<{ agentId: string }>();

const cfg = useSettingsStore();
const s = cfg.settings;
const wb = useWorldBookStore();
const cacheProvider = computed({
  get: () => s.directCacheProvider ?? 'prefix',
  set: (value) => {
    s.directCacheProvider = value;
  },
});

/**
 * 缓存直出的重建时机（只在 `direct_cached` 页出现）。范围、步长、默认值一律取自引擎，
 * 组件里不另写数字。键缺席 = 引擎默认；拖回默认值或点「恢复默认」都是**删键**，
 * 不写入默认数字 —— 否则日后引擎调默认时，这台机器会停在旧值上。
 */
const REBUILD_DEFAULTS = DIRECT_CACHE_REBUILD_DEFAULTS;
const REBUILD_RANGE = DIRECT_CACHE_REBUILD_RANGE;
const rebuild = computed(() =>
  normalizeDirectCacheRebuild({
    maxTurns: s.directCacheRebuildTurns,
    growthLimit: s.directCacheGrowthLimit,
  }),
);
const rebuildTurnsCustom = computed(() => rebuild.value.maxTurns !== REBUILD_DEFAULTS.maxTurns);
const growthLimitCustom = computed(
  () => rebuild.value.growthLimit !== REBUILD_DEFAULTS.growthLimit,
);
function formatGrowth(value: number): string {
  return value.toFixed(1);
}
function onRebuildTurnsInput(ev: Event) {
  const { maxTurns } = normalizeDirectCacheRebuild({
    maxTurns: Number((ev.target as HTMLInputElement).value),
  });
  if (maxTurns === REBUILD_DEFAULTS.maxTurns) delete s.directCacheRebuildTurns;
  else s.directCacheRebuildTurns = maxTurns;
}
function onGrowthLimitInput(ev: Event) {
  const { growthLimit } = normalizeDirectCacheRebuild({
    growthLimit: Number((ev.target as HTMLInputElement).value),
  });
  if (growthLimit === REBUILD_DEFAULTS.growthLimit) delete s.directCacheGrowthLimit;
  else s.directCacheGrowthLimit = growthLimit;
}
function resetRebuildTurns() {
  delete s.directCacheRebuildTurns;
}
function resetGrowthLimit() {
  delete s.directCacheGrowthLimit;
}

/** 下拉里可选的对话 API —— 一行派生，与子导航那处各算各的（不穿成 prop） */
const llmEndpoints = computed(() =>
  s.apiPool.filter((entry) => !entry.kind || entry.kind === 'llm'),
);

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
 * S-08：API 绑定四态 —— 与运行时同一个解析器（`resolveAgentEndpoint`）。
 * 没绑定 = 跟随默认（自动用第一个 API），不是错误；只有绑定失效才标红。
 */
const binding = computed(() =>
  describeAgentBinding(agentCfg.value.model, buildApiEndpoints(s.apiPool)),
);

/**
 * S-10：五个采样/长度参数**实际会发出去的值**与来源。优先级照搬运行时
 * （`resolveAgentLlmParamSources` = `resolveAgentLlmParams` 的同一份实现）：
 * Agent 覆写 > 当前所用 API 池的默认参数 > 内容包默认。
 */
const llmParams = computed(() => {
  const state = binding.value;
  const poolDefaults =
    state.kind === 'bound' || state.kind === 'follow-default'
      ? state.endpoint.defaultParameters
      : undefined;
  return resolveAgentLlmParamSources(s, props.agentId, defaultsLayer.value, poolDefaults);
});

const SOURCE_LABEL: Record<AgentLlmParamSource['source'], string> = {
  override: '已覆写',
  pool: '来自 API 池',
  default: '默认',
};
function paramSourceLabel(field: AgentLlmParamField): string {
  return SOURCE_LABEL[llmParams.value[field].source];
}

/**
 * `tailPrompt` 对**正文润色侧链**是另一层含义：它不是 Delta 会话的末尾指令，
 * 而是 assistant 前缀的 `reasoning_content`（思维链种子）—— 存储字段复用、语义不同，
 * 故这里的文案按 agent 分叉，免得主人以为要填「每轮末尾指令」。
 */
const isProseRewrite = computed(() => props.agentId === 'prose_rewrite');
const tailFieldLabel = computed(() =>
  isProseRewrite.value ? '思维链前缀种子 (tailPrompt)' : '末尾指令 (tailPrompt)',
);
const tailFieldHint = computed(() =>
  isProseRewrite.value
    ? '作为 assistant 前缀的 reasoning_content：模型从这里接着往下想。仅「正文润色」侧链使用；留空 = 用引擎默认种子。'
    : isDirectSettingsProfile(props.agentId)
      ? '每次直出请求末尾追加的风格指令；不覆盖必需输出协议。'
      : 'Delta 会话：每轮最新的 user 消息末尾都会追加这段指令。留空 = 不注入（缺省）。',
);
const tailFieldPlaceholder = computed(() =>
  isProseRewrite.value
    ? '例如：思考过程：\n\n1. 分析系统要求以及用户输入：'
    : '例如：请用简体中文作答，并保持第二人称叙事。',
);

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

const isStoryV2 = computed(
  () =>
    (props.agentId === 'story' || isDirectSettingsProfile(props.agentId)) &&
    s.storyContextV2Enabled === true,
);
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
      count: book.entries.filter(
        (e) =>
          e.enabled &&
          isLoreEntryVisibleTo(
            props.agentId === 'direct_cached' ? 'direct_main' : props.agentId,
            book,
            e,
          ),
      ).length,
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
    <p class="form-hint">
      不选时自动使用第一个 API，一般无需设置；想让这个 Agent 用别的 API 时再单独指定。
    </p>
    <div class="key-row">
      <select
        class="form-input"
        :value="agentCfg.model"
        @change="setAgentField({ model: ($event.target as HTMLSelectElement).value })"
      >
        <option value="">— 跟随默认（第一个 API）—</option>
        <!-- 绑定失效时补一个占位项，否则下拉框是空白的，看不出发生了什么 -->
        <option v-if="binding.kind === 'stale'" :value="binding.requestedId" disabled>
          （已删除的 API）
        </option>
        <option v-for="ep in llmEndpoints" :key="ep.id" :value="ep.id">
          {{ ep.name }} — {{ ep.model || '未选择模型' }}
        </option>
      </select>
      <span v-if="binding.kind === 'no-api'" class="api-warn">请先配置 API</span>
      <span v-else-if="binding.kind === 'stale'" class="api-warn">绑定失效</span>
      <span v-else-if="binding.kind === 'follow-default'" class="api-follow"
        >跟随默认：{{ binding.endpoint.name }}</span
      >
      <span v-else class="api-ok">✓</span>
    </div>
    <p v-if="binding.kind === 'stale'" class="api-warn binding-stale-msg" role="alert">
      这个 Agent 指定的 API 已被删除，运行时会直接失败（不会悄悄换成别的 API）。请重新选择一个
      API，或选「跟随默认」。
    </p>
  </AppCard>

  <!-- 采样参数（所有 Agent 通用）。每格三段：名称 + 来源角标 / 输入框 / 说明，
       说明放在输入框下方，同一行的输入框经 subgrid 对齐。 -->
  <AppCard padding="md" class="detail-card">
    <h4>采样参数</h4>
    <p class="form-hint">
      控制此 Agent 的采样行为和生成长度。框里是实际会发送的值，旁边的标记说明它来自哪里：
      「已覆写」是你在这里改过的；「来自 API 池」是当前所用 API
      设置的默认参数；「默认」是内容包为这个 Agent 调好的值。
    </p>
    <div class="param-grid">
      <label class="form-label param-field">
        <span class="param-head"
          >Temperature
          <span
            class="source-badge"
            :class="`source-${llmParams.temperature.source}`"
            data-param="temperature"
            >{{ paramSourceLabel('temperature') }}</span
          ></span
        >
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          :value="llmParams.temperature.value"
          class="form-input"
          @input="
            setAgentField({
              temperature: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
        <span class="form-hint param-hint">越高越随机 (0-2)</span>
      </label>
      <label class="form-label param-field">
        <span class="param-head"
          >Top P
          <span class="source-badge" :class="`source-${llmParams.topP.source}`" data-param="topP">{{
            paramSourceLabel('topP')
          }}</span></span
        >
        <input
          type="number"
          step="0.05"
          min="0"
          max="1"
          :value="llmParams.topP.value"
          class="form-input"
          @input="setAgentField({ topP: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="form-hint param-hint">核采样阈值 (0-1)</span>
      </label>
      <label class="form-label param-field">
        <span class="param-head"
          >Frequency Penalty
          <span
            class="source-badge"
            :class="`source-${llmParams.freqPen.source}`"
            data-param="freqPen"
            >{{ paramSourceLabel('freqPen') }}</span
          ></span
        >
        <input
          type="number"
          step="0.1"
          min="-2"
          max="2"
          :value="llmParams.freqPen.value"
          class="form-input"
          @input="
            setAgentField({
              freqPen: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
        <span class="form-hint param-hint">抑制重复 (-2 ~ 2)</span>
      </label>
      <label class="form-label param-field">
        <span class="param-head"
          >Presence Penalty
          <span
            class="source-badge"
            :class="`source-${llmParams.presPen.source}`"
            data-param="presPen"
            >{{ paramSourceLabel('presPen') }}</span
          ></span
        >
        <input
          type="number"
          step="0.1"
          min="-2"
          max="2"
          :value="llmParams.presPen.value"
          class="form-input"
          @input="
            setAgentField({
              presPen: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
        <span class="form-hint param-hint">鼓励新话题 (-2 ~ 2)</span>
      </label>
      <label class="form-label param-field">
        <span class="param-head"
          >Max Tokens
          <span
            class="source-badge"
            :class="`source-${llmParams.maxTokens.source}`"
            data-param="maxTokens"
            >{{ paramSourceLabel('maxTokens') }}</span
          ></span
        >
        <input
          type="number"
          min="100"
          max="384000"
          step="100"
          :value="llmParams.maxTokens.value"
          class="form-input"
          @input="
            setAgentField({
              maxTokens: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
        <span class="form-hint param-hint">单次回复最大长度</span>
      </label>
      <label v-if="!isDirectSettingsProfile(agentId)" class="form-label param-field">
        <span class="param-head"
          >失败重试次数
          <span class="source-badge" :class="{ overridden: isOverridden('maxRetries') }">{{
            isOverridden('maxRetries') ? '已覆写' : '默认'
          }}</span></span
        >
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
        <span class="form-hint param-hint"
          >请求失败后自动重试几遍（0=不重试；指数退避）。手动停止永不重试。</span
        >
      </label>
    </div>
    <p v-if="isDirectSettingsProfile(agentId)" class="form-hint param-note">
      直出主生成不自动重试；失败后可手动重试一次新的生成。
    </p>
  </AppCard>

  <!-- 上下文：历史注入 + 末尾指令（文本指令，不是采样参数） -->
  <AppCard padding="md" class="detail-card">
    <h4>上下文</h4>
    <div class="param-grid param-grid-wide">
      <label class="form-label param-field">
        <span class="param-head"
          >历史注入层数
          <span class="source-badge" :class="{ overridden: isOverridden('historyLayers') }">{{
            isOverridden('historyLayers') ? '已覆写' : '默认'
          }}</span></span
        >
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
        <span class="param-foot">
          <span v-if="isStoryV2 && historyLayersError" class="api-warn param-error" role="alert">
            {{ historyLayersError }}
          </span>
          <span class="form-hint param-hint">
            {{
              isStoryV2
                ? 'Story v2 正文窗口 N：保留最近 N 个完整回合原文。只接受正整数；留空恢复默认 6 回合。窗口外由摘要承接，不截断原文。'
                : '注入最近 N 轮「玩家+AI」对话历史（0=不注入；留空=按 Agent 类别默认）。后置型 Agent 默认 1 轮辅助上文，长正文型默认 6 轮'
            }}
          </span>
        </span>
      </label>
      <label class="form-label param-field">
        <span class="param-head"
          >历史截断字数
          <span class="source-badge" :class="{ overridden: isOverridden('historySlice') }">{{
            isOverridden('historySlice') ? '已覆写' : '默认'
          }}</span></span
        >
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
        <span class="form-hint param-hint">
          {{
            isStoryV2
              ? 'Story v2 保留完整回合原文，此旧模式截断设置不生效；已保存的旧值保留，关闭 v2 后恢复使用。'
              : '每条历史正文保留前多少字（留空=按 Agent 类别默认，长正文型默认 1500，后置型默认 800）'
          }}
        </span>
      </label>
    </div>

    <!-- 🆕 2026-08-22 Delta 会话（T4）：单一 tailPrompt —— 每轮最新 user 消息末尾的指令。
         留空 = 删键 = 不注入。 -->
    <label class="form-label tail-prompt-field">
      <span class="param-head"
        >{{ tailFieldLabel }}
        <span class="source-badge" :class="{ overridden: isOverridden('tailPrompt') }">{{
          isOverridden('tailPrompt') ? '已覆写' : '默认'
        }}</span></span
      >
      <textarea
        class="form-input form-textarea"
        :value="agentCfg.tailPrompt ?? ''"
        :placeholder="tailFieldPlaceholder"
        rows="3"
        @input="onTailPromptInput($event)"
      />
      <span class="form-hint param-hint">{{ tailFieldHint }}</span>
    </label>
  </AppCard>

  <!-- 缓存会话（仅缓存直出）：渠道策略 + 重建时机。这些是全局设置，不在 Agent 覆写层里 -->
  <AppCard v-if="agentId === 'direct_cached'" padding="md" class="detail-card">
    <h4>缓存会话</h4>
    <label class="form-label cache-provider-field">
      <span class="param-head">渠道缓存支持</span>
      <select v-model="cacheProvider" class="form-input">
        <option value="prefix">通用稳定前缀（不附加渠道参数）</option>
        <option value="anthropic">Claude Messages 原生缓存</option>
        <option value="openai">OpenAI 显式缓存断点（需渠道支持）</option>
      </select>
      <span class="form-hint param-hint" data-testid="cache-provider-hint"
        >只选择渠道明确支持的方式。旧原文最多暂留一个
        {{ rebuild.maxTurns }}
        楼会话，重建时折叠；缓存命中和费用以渠道返回为准。此处不会切换存档模式。</span
      >
    </label>

    <div class="rebuild-field" data-testid="rebuild-turns">
      <label class="rebuild-row">
        <span class="param-head"
          >会话楼数上限
          <span class="source-badge" :class="{ overridden: rebuildTurnsCustom }">{{
            rebuildTurnsCustom ? '已覆写' : '默认'
          }}</span></span
        >
        <input
          class="rebuild-range"
          type="range"
          :min="REBUILD_RANGE.maxTurns.min"
          :max="REBUILD_RANGE.maxTurns.max"
          :step="REBUILD_RANGE.maxTurns.step"
          :value="rebuild.maxTurns"
          aria-label="会话楼数上限"
          :aria-valuetext="`${rebuild.maxTurns} 楼`"
          @input="onRebuildTurnsInput($event)"
        />
        <span class="rebuild-value">{{ rebuild.maxTurns }} 楼</span>
      </label>
      <div class="rebuild-foot">
        <span class="form-hint param-hint"
          >一段会话接纳多少楼后重建。调大：会话保持更久，重复利用的缓存前缀更多，但旧正文更晚被折叠，单次请求更长；调小则相反。</span
        >
        <AppButton
          v-if="rebuildTurnsCustom"
          variant="ghost"
          size="sm"
          class="rebuild-reset"
          @click="resetRebuildTurns"
          >恢复默认（{{ REBUILD_DEFAULTS.maxTurns }} 楼）</AppButton
        >
      </div>
    </div>

    <div class="rebuild-field" data-testid="rebuild-growth">
      <label class="rebuild-row">
        <span class="param-head"
          >增长倍数上限
          <span class="source-badge" :class="{ overridden: growthLimitCustom }">{{
            growthLimitCustom ? '已覆写' : '默认'
          }}</span></span
        >
        <input
          class="rebuild-range"
          type="range"
          :min="REBUILD_RANGE.growthLimit.min"
          :max="REBUILD_RANGE.growthLimit.max"
          :step="REBUILD_RANGE.growthLimit.step"
          :value="rebuild.growthLimit"
          aria-label="增长倍数上限"
          :aria-valuetext="`${formatGrowth(rebuild.growthLimit)} 倍`"
          @input="onGrowthLimitInput($event)"
        />
        <span class="rebuild-value">{{ formatGrowth(rebuild.growthLimit) }} 倍</span>
      </label>
      <div class="rebuild-foot">
        <span class="form-hint param-hint"
          >请求长度超过重建基线的多少倍就重建。调大：会话保持更久，重复利用的缓存前缀更多，但旧正文更晚被折叠，单次请求更长；调小则相反。</span
        >
        <AppButton
          v-if="growthLimitCustom"
          variant="ghost"
          size="sm"
          class="rebuild-reset"
          @click="resetGrowthLimit"
          >恢复默认（{{ formatGrowth(REBUILD_DEFAULTS.growthLimit) }} 倍）</AppButton
        >
      </div>
    </div>
  </AppCard>

  <!-- 战斗（仅直出两页）：全局设置 directStructuredCombat，暂未开放，锁定为关 -->
  <AppCard v-if="isDirectSettingsProfile(agentId)" padding="md" class="detail-card">
    <h4>战斗</h4>
    <div class="toggle-row" data-testid="direct-structured-combat">
      <label class="toggle-label"
        ><input
          type="checkbox"
          class="toggle-input"
          :checked="s.directStructuredCombat"
          disabled
        /><span class="toggle-slider" /><span>结构化战斗</span></label
      >
    </div>
    <p class="form-hint combat-hint">
      暂未开放：直出模式下战斗由正文直接叙述，生命、法力、体力与状态变化随普通状态更新写入。
    </p>
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
/*
 * 参数网格：每格是「名称 + 角标 / 输入框 / 说明」三行，用 subgrid 把三行交给父网格，
 * 同一行里各格的输入框因此上下对齐（说明长短不一也不错位）。
 * 不支持 subgrid 的引擎会忽略那一行，退回普通纵向堆叠。
 */
.param-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  column-gap: var(--theme-spacing-md);
  row-gap: var(--theme-spacing-lg);
}
.param-grid-wide {
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}
.form-label.param-field {
  display: grid;
  grid-row: span 3;
  grid-template-rows: subgrid;
  row-gap: var(--theme-spacing-xs);
  align-content: start;
  min-width: 0;
}
/* 名称与来源角标同一行；角标是行内小标记，不再被 flex 列拉成整行宽 */
.param-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-xs);
}
.param-head .source-badge {
  margin-left: 0;
}
.param-hint {
  display: block;
  margin: 0;
}
.param-foot {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.param-error {
  white-space: normal;
}
/* 「直出不自动重试」：属于采样参数组的一行说明，不占网格格子 */
.param-note {
  margin: var(--theme-spacing-md) 0 0;
}
.cache-provider-field {
  min-width: 0;
  gap: var(--theme-spacing-xs);
}
/* 重建时机滑块：交互与样式照 PortraitSettingsDialog 的取景滑块（原生 range + accent-color） */
.rebuild-field {
  margin-top: var(--theme-spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.rebuild-row {
  display: grid;
  grid-template-columns: minmax(150px, auto) minmax(0, 1fr) 4.5em;
  align-items: center;
  gap: var(--theme-spacing-md);
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--theme-text-secondary);
}
.rebuild-range {
  min-width: 0;
  accent-color: var(--theme-primary);
  cursor: pointer;
}
.rebuild-range:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.rebuild-value {
  text-align: right;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  font-variant-numeric: tabular-nums;
}
.rebuild-foot {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}
.rebuild-reset {
  flex-shrink: 0;
}
@media (max-width: 520px) {
  .rebuild-row {
    grid-template-columns: minmax(0, 1fr) 4.5em;
  }
  .rebuild-row .param-head {
    grid-column: 1 / -1;
  }
}
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
/* 🆕 tailPrompt 文本域：与上面的数值网格之间留一跳呼吸 */
.tail-prompt-field {
  margin-top: var(--theme-spacing-lg);
  gap: var(--theme-spacing-xs);
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
.source-badge.overridden,
.source-badge.source-override {
  background: color-mix(in srgb, var(--theme-primary) 16%, transparent);
  color: var(--theme-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 30%, transparent);
}
/* S-10：值来自 API 池的默认参数（盖过了内容包默认） */
.source-badge.source-pool {
  background: color-mix(in srgb, var(--theme-warning) 14%, transparent);
  color: var(--theme-warning);
  border-color: color-mix(in srgb, var(--theme-warning) 30%, transparent);
}
/* S-08：跟随默认是中性状态，不是警告 */
.api-follow {
  font-size: 0.8rem;
  color: var(--theme-text-muted);
  white-space: nowrap;
}
.combat-hint {
  margin: var(--theme-spacing-sm) 0 0;
}
.binding-stale-msg {
  margin: var(--theme-spacing-sm) 0 0;
}
@media (prefers-reduced-motion: reduce) {
  .source-badge {
    transition: none;
  }
}
</style>
