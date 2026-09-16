<script setup lang="ts">
/**
 * API 池分区 —— 端点 CRUD / 连接测试 / 模型列表 / 高级设置（Q-25 从 SettingsPage.vue 抽出）
 *
 * 📌 添加/编辑弹窗跟着一起搬进来了: 它是本分区**唯一**的写入口，留在壳层就等于
 *    apiForm 这团状态横跨两个文件。
 *
 * 🔴 `initApiSecrets()` 改成本分区挂载时调（原先在整页 onMounted）。它是幂等的，
 *    且 `api` 是默认分区，所以进设置页仍然会立刻跑一次；切走再回来会多调一次，
 *    那次直接命中已解密的缓存。
 */
import { ref, reactive, computed, onMounted, watch } from 'vue';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import { useSettingsStore, type ApiEntry } from '../../stores/settings-store';
import { useApiSourceStore } from '../../stores/api-source-store';
import { sourceForStorage } from '../../stores/api-config-migration';
import { useUIStore } from '../../stores/ui-store';
import { fetchModels } from '@engine/api-tools';
import { credentialIdFor } from '@engine/api-rpm-limiter';
import { AgentClient } from '@engine/agent-client';
import { requestEmbedding } from '@engine/api/embedding';
import { requestRerank } from '@engine/api/reranker';
import { fetchLlmModels } from '@engine/api/transport';
import { parseApiSource } from '@engine/api/source-config';
import type { ApiSource, ApiSourceKind, LlmProtocol } from '@engine/types-api';

const cfg = useSettingsStore();
const sourceStore = useApiSourceStore();
const s = cfg.settings;
const ui = useUIStore();

onMounted(async () => {
  await sourceStore.initialize();
  await refreshRpmRows();
});

const showAddApi = ref(false);
const apiForm = reactive({
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  kind: 'llm' as ApiSourceKind,
  protocol: 'openai-chat' as LlmProtocol | 'openai-embeddings' | 'openai-rerank',
  timeoutMs: '60000',
  bodyOverrides: '{}',
  bodyOmitPaths: '',
  anthropicVersion: '2023-06-01',
  anthropicBeta: '',
  /** 🆕 2026-08-22 Delta 会话（T4）：上下文窗口 token 上限（表单用 string，保存时归一化） */
  contextWindowTokens: '' as string,
  _realKey: '' as string,
  _masked: false,
});
/**
 * 出图端点：**地址与模型都不由这张表管**（2026-08-05）。
 *
 * 上游地址只有一个，代码里就是常量（`scene-image-seams` 不再读 `endpoint.baseUrl`）；
 * NAI 的出图模型 id 在「图像生成 → 出图」那张卡上。留着这两格只会让人以为它们生效 ——
 * 而它们填错的后果全都是**上游报一句指向别处的错**（真机连坑两轮：一次被报成
 * 「模型枚举非法」，一次被报成「header 非法」）。所以这里只剩名称 + API Key。
 */
const isLlmEntry = computed(() => apiForm.kind === 'llm');

watch(
  () => apiForm.kind,
  (kind) => {
    if (kind === 'embedding') apiForm.protocol = 'openai-embeddings';
    else if (kind === 'reranker') apiForm.protocol = 'openai-rerank';
    else if (apiForm.protocol === 'openai-embeddings' || apiForm.protocol === 'openai-rerank') {
      apiForm.protocol = 'openai-chat';
    }
  },
);

const apiModels = ref<string[]>([]);
const showModelList = ref(false);
// 浮层始终显示全部已获取模型——不按 input 当前值过滤（否则聚焦时旧值会滤掉其他模型，重蹈 datalist 覆辙）。
// 当前已选模型高亮，用户可从全部列表点选，或继续手动输入。
function selectModel(m: string) {
  apiForm.model = m;
  showModelList.value = false;
}
function onModelBlur() {
  setTimeout(() => {
    showModelList.value = false;
  }, 150);
}
const showAdvancedApi = ref(false);
const apiFormTesting = ref(false);
const apiFormFetchingModels = ref(false);
const editingApiId = ref<string | null>(null);

type RpmRow = {
  credentialId: string;
  names: string[];
  baseUrl: string;
  maskedKey: string;
};

const rpmRows = ref<RpmRow[]>([]);
const rpmDraft = reactive<Record<string, string>>({});
const rpmSaving = ref(false);
let rpmRefreshSeq = 0;

async function refreshRpmRows() {
  const seq = ++rpmRefreshSeq;
  const grouped = new Map<string, RpmRow>();
  for (const entry of [...s.apiPool, ...sourceStore.imageConnections]) {
    const credentialId = await credentialIdFor({
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      label: entry.name,
    });
    const current = grouped.get(credentialId);
    if (current) {
      if (!current.names.includes(entry.name)) current.names.push(entry.name);
    } else {
      grouped.set(credentialId, {
        credentialId,
        names: [entry.name],
        baseUrl: entry.baseUrl.replace(/\/+$/, ''),
        maskedKey: ('maskedKey' in entry ? entry.maskedKey : '') || maskKey(entry.apiKey),
      });
    }
  }
  if (seq !== rpmRefreshSeq) return;
  rpmRows.value = [...grouped.values()];
  const activeIds = new Set(rpmRows.value.map((row) => row.credentialId));
  for (const key of Object.keys(rpmDraft)) {
    if (!activeIds.has(key)) delete rpmDraft[key];
  }
  for (const row of rpmRows.value) {
    const policy = cfg.apiRpmPolicies.find((item) => item.credentialId === row.credentialId);
    rpmDraft[row.credentialId] = policy ? String(policy.rpmLimit) : '';
  }
}

watch(
  () => [
    ...s.apiPool.map((entry) => [entry.id, entry.baseUrl, entry.apiKey, entry.name]),
    ...sourceStore.imageConnections.map((entry) => [
      entry.id,
      entry.baseUrl,
      entry.apiKey,
      entry.name,
    ]),
  ],
  () => void refreshRpmRows(),
  { deep: true },
);

async function saveRpmLimits() {
  const changes: Array<{ credentialId: string; rpmLimit?: number }> = [];
  for (const row of rpmRows.value) {
    const raw = (rpmDraft[row.credentialId] ?? '').trim();
    if (!raw) {
      changes.push({ credentialId: row.credentialId });
      continue;
    }
    const rpmLimit = Number(raw);
    if (!Number.isSafeInteger(rpmLimit) || rpmLimit <= 0) {
      ui.toast(`${row.names.join(' / ')} 的 RPM 必须是正整数`, 'warning');
      return;
    }
    changes.push({ credentialId: row.credentialId, rpmLimit });
  }
  rpmSaving.value = true;
  try {
    for (const change of changes) {
      await cfg.updateRpmPolicy(change.credentialId, change.rpmLimit);
    }
    ui.toast('RPM 限制已保存', 'success');
  } catch (error) {
    ui.toast(`RPM 限制保存失败：${String(error)}`, 'error');
  } finally {
    rpmSaving.value = false;
  }
}

function maskKey(key: string): string {
  if (!key || key.length < 8) return key ? key.slice(0, 3) + '***' : '';
  return key.slice(0, 3) + '***' + key.slice(-4);
}
function onApiKeyInput() {
  // 用户手动改了 key 输入框：新输入即权威。必须丢弃 _realKey，
  // 否则测试/获取模型/保存全走 `_realKey || apiKey` 的旧 key，新 key 永远不生效。
  apiForm._realKey = '';
  apiForm._masked = false;
}

function draftSource(): ApiSource {
  const bodyOverrides = JSON.parse(apiForm.bodyOverrides || '{}') as unknown;
  return parseApiSource({
    id: editingApiId.value || 'connection-test',
    name: apiForm.name || '未命名连接',
    kind: apiForm.kind,
    protocol: apiForm.protocol,
    baseUrl: apiForm.baseUrl,
    apiKey: (apiForm._realKey || apiForm.apiKey).trim(),
    defaultModel: apiForm.model,
    models: apiModels.value.length ? apiModels.value : [apiForm.model].filter(Boolean),
    timeoutMs: Number(apiForm.timeoutMs),
    bodyOverrides,
    bodyOmitPaths: apiForm.bodyOmitPaths
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean),
    contextWindowTokens: normalizeContextWindowTokens(apiForm.contextWindowTokens),
    anthropicVersion: apiForm.anthropicVersion,
    anthropicBeta: apiForm.anthropicBeta
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
}

async function testApiAndFetch() {
  apiFormTesting.value = true;
  try {
    const source = draftSource();
    if (source.kind === 'llm') {
      const result = await new AgentClient({
        endpoint: sourceForStorage(source),
        agentId: 'connection_test',
        saveId: 'settings-test',
        maxRetries: 0,
      }).chat({ messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 8 });
      if (result.error) throw new Error(result.error);
    } else if (source.kind === 'embedding') {
      await requestEmbedding(source, 'connection test');
    } else {
      await requestRerank(source, 'connection test', ['relevant document', 'other document'], 1);
    }
    apiForm._realKey = source.apiKey;
    apiForm.apiKey = maskKey(source.apiKey);
    apiForm._masked = true;
    ui.toast('连接测试通过', 'success');
  } catch (e: any) {
    const msg = (e?.message || '').slice(0, 80);
    const hint =
      msg.indexOf('401') >= 0
        ? '（API Key 无效或与该服务不匹配，请按服务商文档核对 key 的来源与格式）'
        : msg.indexOf('404') >= 0
          ? '（模型名或接口路径不对，检查 baseUrl/模型）'
          : '';
    ui.toast('连接测试失败：' + msg + hint, 'error');
  }
  apiFormTesting.value = false;
}
async function fetchModelList(opts: { fromConnectionTest?: boolean; silentFail?: boolean } = {}) {
  if (!apiForm.baseUrl) {
    return;
  }
  apiFormFetchingModels.value = true;
  const rk = (apiForm._realKey || apiForm.apiKey).trim();
  try {
    let models: string[] = [];
    let error = '';
    if (apiForm.kind === 'llm') {
      models = await fetchLlmModels(sourceForStorage(draftSource()));
    } else {
      const result = await fetchModels({
        baseUrl: apiForm.baseUrl,
        apiKey: rk,
        label: apiForm.name || apiForm.baseUrl,
      });
      models = result.models;
      error = result.error ?? '';
    }
    if (models.length > 0) {
      apiModels.value = [...new Set(models)];
      console.log('[fetchModelList] remote → unique models:', JSON.stringify(apiModels.value));
      ui.toast(
        '已获取 ' + apiModels.value.length + ' 个模型，点击输入框下拉选择或手动填写',
        'success',
      );
    } else if (!opts.silentFail) {
      const msg = (error || 'unknown').slice(0, 100);
      if (msg.indexOf('404') >= 0) {
        // 404 独立分支：不是 key 问题——要么端点根本没实现 /models（Cline 等属常态），
        // 要么主链接填错。从「测试连接」进来时降级为 info（列表只是顺手拉，
        // 连接测试的权威结果是后面那条 chat 请求），单独点「获取模型」时用 warning。
        ui.toast(
          opts.fromConnectionTest
            ? '该端点没有 /models 模型列表接口（或主链接不正确），已用手填模型继续测试连接'
            : '该端点没有 /models 模型列表接口（或主链接不正确），请手动填写模型 id',
          opts.fromConnectionTest ? 'info' : 'warning',
        );
      } else {
        const hint =
          msg.indexOf('401') >= 0
            ? '（Key 无效或与端点不匹配，请按服务商文档核对 key 与主链接是否配套）'
            : msg.indexOf('network') >= 0
              ? '（代理或网络问题）'
              : '';
        ui.toast('获取失败: ' + msg + hint, 'error');
      }
    }
  } catch (e: any) {
    if (!opts.silentFail) ui.toast('获取失败: ' + (e.message || '').slice(0, 100), 'error');
  }
  apiFormFetchingModels.value = false;
}
function openAddApi() {
  editingApiId.value = null;
  apiForm.name = '';
  apiForm.baseUrl = '';
  apiForm.apiKey = '';
  apiForm.model = '';
  apiForm.kind = 'llm';
  apiForm.protocol = 'openai-chat';
  apiForm.timeoutMs = '60000';
  apiForm.bodyOverrides = '{}';
  apiForm.bodyOmitPaths = '';
  apiForm.anthropicVersion = '2023-06-01';
  apiForm.anthropicBeta = '';
  apiForm.contextWindowTokens = '';
  apiForm._realKey = '';
  apiForm._masked = false;
  apiModels.value = [];
  showAddApi.value = true;
}
async function openEditApi(ep: ApiEntry) {
  await sourceStore.initialize();
  const source = sourceStore.sources.find((entry) => entry.id === ep.id);
  const hydrated = s.apiPool.find((entry) => entry.id === ep.id) ?? ep;
  editingApiId.value = ep.id;
  apiForm.name = hydrated.name;
  apiForm.baseUrl = hydrated.baseUrl;
  const key = hydrated.apiKey || '';
  apiForm.apiKey = key;
  apiForm._realKey = key;
  apiForm._masked = key ? true : false;
  apiForm.model = hydrated.model;
  apiForm.kind = source?.kind ?? hydrated.kind ?? 'llm';
  apiForm.protocol = source?.protocol ?? hydrated.protocol ?? 'openai-chat';
  apiForm.timeoutMs = String(source?.timeoutMs ?? hydrated.timeoutMs ?? 60_000);
  apiForm.bodyOverrides = JSON.stringify(
    source?.bodyOverrides ?? hydrated.bodyOverrides ?? {},
    null,
    2,
  );
  apiForm.bodyOmitPaths = (source?.bodyOmitPaths ?? hydrated.bodyOmitPaths ?? []).join('\n');
  apiForm.anthropicVersion =
    source?.kind === 'llm' ? (source.anthropicVersion ?? '2023-06-01') : '';
  apiForm.anthropicBeta = source?.kind === 'llm' ? (source.anthropicBeta ?? []).join(', ') : '';
  apiForm.contextWindowTokens =
    hydrated.contextWindowTokens != null ? String(hydrated.contextWindowTokens) : '';
  apiModels.value = hydrated.models?.length
    ? [...hydrated.models]
    : [hydrated.model].filter(Boolean);
  showAddApi.value = true;
}

/**
 * 🆕 2026-08-22 Delta 会话（T4）：contextWindowTokens 只接受正整数；空值 = 不判断。
 * 非正整数 / 非数字一律归一化为 undefined（不做主动预算判断，不写坏值进库）。
 */
function normalizeContextWindowTokens(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

async function saveApi() {
  const wasEditing = Boolean(editingApiId.value);
  try {
    const source = draftSource();
    const previous = sourceStore.sources.find((entry) => entry.id === editingApiId.value);
    if (previous && previous.kind !== source.kind) {
      const agentBindings = Object.entries(s.agents ?? {})
        .filter(([, value]) => value?.model === previous.id)
        .map(([agentId]) => agentId);
      const retrievalBindings = [
        s.embeddingSourceId === previous.id ? 'Embedding 召回' : '',
        s.rerankerSourceId === previous.id ? 'Reranker' : '',
      ].filter(Boolean);
      const bindings = [...agentBindings, ...retrievalBindings];
      if (bindings.length) {
        throw new Error(`请先解除这些绑定再修改用途：${bindings.join('、')}`);
      }
    }
    await sourceStore.saveSource({
      ...source,
      id: editingApiId.value || crypto.randomUUID(),
      revision: previous?.revision,
    });
    showAddApi.value = false;
    editingApiId.value = null;
    ui.toast(wasEditing ? 'API 已更新' : 'API 已添加', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.toast(`API 配置无效：${message}`, 'error');
  }
}
async function deleteApi(id: string) {
  try {
    await sourceStore.removeSource(id);
    ui.toast('API 已删除', 'info');
  } catch (error) {
    ui.toast(`API 删除失败：${String(error)}`, 'error');
  }
}
</script>

<template>
  <section class="section centered">
    <div class="section-head">
      <div>
        <h3>API 池管理</h3>
        <p class="section-desc">按用途与协议管理 LLM、Embedding 和 Reranker 来源。</p>
      </div>
      <AppButton variant="primary" size="sm" @click="openAddApi">+ 添加 API</AppButton>
    </div>
    <AppCard v-if="cfg.apiSecretsError" padding="md" class="api-storage-error">
      <p class="api-warn" style="margin: 0">
        API 密钥安全存储不可用。旧密钥仍保留且本次会话不会覆盖原设置；请检查浏览器存储后重新加载。
      </p>
    </AppCard>
    <AppCard padding="md" class="rpm-card">
      <div class="rpm-card-head">
        <div>
          <h4>全局 RPM 限制</h4>
          <p class="form-hint">相同端点与 API Key 共用一个请求额度。留空表示无限制。</p>
        </div>
        <AppButton
          variant="secondary"
          size="sm"
          :disabled="rpmSaving || rpmRows.length === 0"
          @click="saveRpmLimits"
        >
          {{ rpmSaving ? '保存中…' : '保存限制' }}
        </AppButton>
      </div>
      <p v-if="cfg.apiRpmPoliciesError" class="api-warn">
        RPM 设置暂时不可用，本次会话按无限制运行：{{ cfg.apiRpmPoliciesError }}
      </p>
      <div v-if="rpmRows.length === 0" class="empty-tab rpm-empty">
        添加 API 后，可在这里按端点与 API Key 组合设置每分钟请求上限。
      </div>
      <div class="rpm-list">
        <div v-for="row in rpmRows" :key="row.credentialId" class="rpm-row">
          <div class="rpm-identity">
            <strong>{{ row.names.join(' / ') }}</strong>
            <span>{{ row.baseUrl }}</span>
            <span>{{ row.maskedKey }}</span>
          </div>
          <label class="rpm-input-label">
            每分钟请求数
            <input
              v-model="rpmDraft[row.credentialId]"
              class="form-input rpm-input"
              type="number"
              min="1"
              step="1"
              inputmode="numeric"
              placeholder="无限制"
            />
          </label>
        </div>
      </div>
    </AppCard>
    <div class="api-pool">
      <AppCard v-for="ep in s.apiPool" :key="ep.id" padding="md"
        ><div class="api-card-body">
          <div class="api-card-info">
            <span class="api-card-name">{{ ep.name }}</span
            ><span class="api-card-model text-secondary text-sm">{{
              ep.model || '未选择模型'
            }}</span
            ><span class="text-muted text-xs"
              >{{ ep.kind || 'llm' }} · {{ ep.protocol || 'openai-chat' }}</span
            ><span class="api-card-url text-muted text-xs">{{ ep.baseUrl }}</span>
          </div>
          <div class="api-card-actions">
            <AppButton variant="ghost" size="sm" @click="openEditApi(ep)">编辑</AppButton
            ><AppButton variant="ghost" size="sm" @click="deleteApi(ep.id)">删除</AppButton>
          </div>
        </div></AppCard
      >
      <div v-if="s.apiPool.length === 0" class="empty-tab">
        还没有配置任何 API 端点
        <span class="empty-tab-hint">
          点击右上角「＋ 添加 API」填入端点地址与密钥，Agent 才能选到模型
        </span>
      </div>
    </div>
    <!-- 模型推荐 -->
    <AppCard padding="md" class="embedding-hint">
      <p class="text-sm text-muted" style="margin: 0 0 6px"><strong>模型推荐</strong></p>
      <p class="text-sm text-muted" style="margin: 0 0 4px">
        对话模型：推荐 <strong>DeepSeek V4 Flash</strong>（快速便宜）或
        <strong>DeepSeek V4 Pro</strong>（质量优先）。
      </p>
      <p class="text-sm text-muted" style="margin: 0">
        Embedding 模型：推荐 <strong>硅基流动 (SiliconFlow)</strong> 的
        <strong>Qwen3-Embedding-8B</strong>，充个五块钱能玩到天荒地老。
      </p>
    </AppCard>

    <!-- 添加/编辑弹窗留在 <section> 内层：本组件必须是**单根**，否则 Vue 不会把
         父组件的 scope id 盖到根节点上，SettingsPage 的 `.centered`（780px 居中）
         就会失效，本分区在宽屏下摊满整行。AppModal 自己 Teleport 到 body，
         所以挪进来不改变它实际渲染的位置。 -->
    <AppModal
      :open="showAddApi"
      :title="editingApiId ? '编辑 API' : '添加 API'"
      size="md"
      @update:open="showAddApi = $event"
    >
      <div class="api-form">
        <label class="form-label"
          >名称<input
            v-model="apiForm.name"
            class="form-input"
            placeholder="如: DeepSeek 生产" /></label
        ><label class="form-label"
          >用途<select v-model="apiForm.kind" class="form-input">
            <option value="llm">文字 LLM</option>
            <option value="embedding">向量嵌入 (Embedding)</option>
            <option value="reranker">候选重排 (Reranker)</option>
          </select>
          <p class="form-hint">
            用途决定哪些消费者可以绑定；图像生成连接请到「图像生成」分区设置。
          </p></label
        ><label class="form-label"
          >协议<select v-model="apiForm.protocol" class="form-input" :disabled="!isLlmEntry">
            <option v-if="isLlmEntry" value="openai-chat">OpenAI Chat Completions</option>
            <option v-if="isLlmEntry" value="gemini">Gemini 原生 GenerateContent</option>
            <option v-if="isLlmEntry" value="anthropic-messages">Claude 原生 Messages</option>
            <option v-if="apiForm.kind === 'embedding'" value="openai-embeddings">
              OpenAI 兼容 Embeddings
            </option>
            <option v-if="apiForm.kind === 'reranker'" value="openai-rerank">
              OpenAI 兼容 Rerank
            </option>
          </select>
          <p class="form-hint">协议必须与上游真实接口一致，不会按模型名或域名自动猜测。</p></label
        ><label class="form-label"
          >主链接<input
            v-model="apiForm.baseUrl"
            class="form-input"
            placeholder="https://api.deepseek.com/v1"
        /></label>
        <label class="form-label"
          >API Key
          <div class="key-row">
            <input
              v-model="apiForm.apiKey"
              class="form-input"
              :type="
                editingApiId &&
                apiForm._masked &&
                (!apiForm._realKey ||
                  (apiForm.apiKey.length > 10 && apiForm.apiKey.includes('***')))
                  ? 'password'
                  : apiForm.apiKey.length > 10 && !apiForm.apiKey.includes('***')
                    ? 'text'
                    : 'password'
              "
              placeholder="API Key（按服务商提供，不一定是 sk- 开头）"
              @input="onApiKeyInput"
            /><AppButton
              variant="secondary"
              size="sm"
              :disabled="apiFormFetchingModels"
              @click="fetchModelList"
              >{{ apiFormFetchingModels ? '获取中...' : '获取模型' }}</AppButton
            >
          </div>
          <p class="form-hint">
            可手动填写模型 id，或点「获取模型」拉取列表后选择。获取失败时按服务商文档手动填（如 z.ai
            填 glm-4.6）。
          </p></label
        ><label class="form-label"
          >模型
          <div class="key-row">
            <div class="model-combo">
              <input
                v-model="apiForm.model"
                class="form-input"
                placeholder="如 glm-4.6 / deepseek-chat"
                autocomplete="off"
                @focus="showModelList = true"
                @blur="onModelBlur"
              />
              <div v-if="showModelList && apiModels.length" class="model-dropdown">
                <div
                  v-for="m in apiModels"
                  :key="m"
                  class="model-option"
                  :class="{ 'model-option-current': m === apiForm.model }"
                  @mousedown.prevent="selectModel(m)"
                >
                  {{ m }}
                </div>
              </div>
            </div>
            <AppButton
              variant="secondary"
              size="sm"
              :disabled="apiFormTesting"
              @click="testApiAndFetch"
              >{{ apiFormTesting ? '测试中...' : '测试连接' }}</AppButton
            >
          </div>
          <p class="form-hint">
            编辑已有 API 时密钥默认隐藏。点击测试连接验证密钥并获取模型列表。
          </p></label
        >
        <!-- 高级设置（可折叠） -->
        <div class="advanced-section">
          <button class="advanced-toggle" type="button" @click="showAdvancedApi = !showAdvancedApi">
            <i class="fa-solid" :class="showAdvancedApi ? 'fa-chevron-up' : 'fa-chevron-down'" />
            高级设置
          </button>
          <div v-if="showAdvancedApi" class="advanced-body">
            <!-- 🆕 2026-08-22 Delta 会话（T4）：可选上下文窗口 token 上限。出图端点没有聊天
                 prompt，这一格对它们无意义，隐藏掉。 -->
            <label v-if="isLlmEntry" class="form-label form-label-stacked">
              上下文窗口 token 上限
              <input
                v-model="apiForm.contextWindowTokens"
                class="form-input"
                type="number"
                min="1"
                step="1"
                inputmode="numeric"
                placeholder="留空 = 不判断"
              />
            </label>
            <p v-if="isLlmEntry" class="form-hint">
              按实际 provider 配置填写（如 128000）。Delta 会话在请求接近此上限时自动重基线； 留空 =
              不做主动预算判断。
            </p>
            <label class="form-label form-label-stacked">
              请求超时（毫秒）
              <input
                v-model="apiForm.timeoutMs"
                class="form-input"
                type="number"
                min="1"
                step="1"
              />
            </label>
            <label class="form-label form-label-stacked">
              自定义请求体参数（JSON）
              <textarea
                v-model="apiForm.bodyOverrides"
                class="form-input api-json"
                rows="6"
                spellcheck="false"
              ></textarea>
              <span class="form-hint">源参数优先；输入、模型、工具和鉴权等结构字段受保护。</span>
            </label>
            <label class="form-label form-label-stacked">
              省略字段（JSON Pointer，每行一条）
              <textarea
                v-model="apiForm.bodyOmitPaths"
                class="form-input api-json"
                rows="3"
                spellcheck="false"
                placeholder="/frequency_penalty"
              ></textarea>
            </label>
            <template v-if="apiForm.protocol === 'anthropic-messages'">
              <label class="form-label form-label-stacked"
                >Anthropic 版本<input v-model="apiForm.anthropicVersion" class="form-input"
              /></label>
              <label class="form-label form-label-stacked"
                >Anthropic Beta（逗号分隔）<input
                  v-model="apiForm.anthropicBeta"
                  class="form-input"
              /></label>
            </template>
          </div>
        </div>
      </div>
      <template #footer
        ><AppButton variant="ghost" size="sm" @click="showAddApi = false">取消</AppButton
        ><AppButton variant="primary" size="sm" @click="saveApi">{{
          editingApiId ? '保存修改' : '添加'
        }}</AppButton></template
      >
    </AppModal>
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
.rpm-card {
  display: grid;
  gap: var(--theme-spacing-md);
  margin-bottom: var(--theme-spacing-lg);
}

.rpm-card-head,
.rpm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-lg);
}

.rpm-card-head h4 {
  margin: 0 0 var(--theme-spacing-xs);
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.95rem;
}

.rpm-card-head .form-hint {
  margin: 0;
}

.rpm-list {
  display: grid;
  gap: var(--theme-spacing-sm);
}

.rpm-row {
  min-width: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-primary) 5%, var(--theme-card-bg));
}

.rpm-identity {
  display: grid;
  min-width: 0;
  gap: var(--theme-spacing-xs);
}

.rpm-empty {
  padding-block: var(--theme-spacing-lg);
}

.rpm-identity strong,
.rpm-identity span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rpm-identity strong {
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
}

.rpm-identity span {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.rpm-input-label {
  display: grid;
  flex: 0 0 9rem;
  gap: var(--theme-spacing-xs);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.rpm-input {
  min-height: 36px;
}

@media (max-width: 620px) {
  .section-head,
  .rpm-card-head,
  .rpm-row {
    align-items: stretch;
    flex-direction: column;
  }

  .section-head > button,
  .rpm-card-head > button,
  .rpm-input-label {
    width: 100%;
  }

  .rpm-input-label {
    flex-basis: auto;
  }
}
</style>

<style scoped>
/* 出图端点没有「主链接」输入框，这一行提示顶替它的位置。`.form-hint` 的 margin 是
   `0 0 4px`（设计成贴在输入框下面的），单独成段时上方需要一点呼吸 */
.fixed-endpoint-hint {
  margin-top: 6px;
}
.model-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.model-combo .form-input {
  width: 100%;
}
.model-dropdown {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 50;
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  max-height: 220px;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}
.model-option {
  padding: 7px 12px;
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--theme-text-primary);
  transition: background var(--theme-transition-fast);
}
.model-option:hover {
  background: var(--theme-tab-hover-bg);
}
.model-option-current {
  background: color-mix(in srgb, var(--theme-primary) 12%, var(--theme-content-bg));
  color: var(--theme-primary);
  font-weight: 600;
}
/* API */
.api-pool {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.api-card-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.api-card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.api-card-name {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--theme-text-primary);
}
.api-card-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.embedding-hint {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
}
/* 高级设置折叠 */
.advanced-section {
  margin-top: 2px;
}
.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border: none;
  background: transparent;
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.82rem;
  cursor: pointer;
  transition: color var(--theme-transition-fast);
}
.advanced-toggle:hover {
  color: var(--theme-text-primary);
}
.advanced-toggle i {
  font-size: 0.7rem;
  width: 14px;
  text-align: center;
}
.advanced-body {
  padding-left: 4px;
}
.advanced-body .form-hint code {
  background: var(--theme-surface-muted);
  color: var(--theme-primary);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.68rem;
}
.api-json {
  min-height: 5rem;
  font-family: 'Cascadia Code', monospace;
  font-size: 0.78rem;
  line-height: 1.5;
  resize: vertical;
}
.form-check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--theme-text-secondary);
  font-size: 0.85rem;
}
.form-check-row input[type='checkbox'] {
  accent-color: var(--theme-primary);
}
/* 同一张表单里紧接着上一格的 form-label */
.form-label-stacked {
  margin-top: var(--theme-spacing-sm);
}
</style>
