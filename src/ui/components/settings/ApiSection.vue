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
import { sourceForStorage, useApiSourceStore } from '../../stores/api-source-store';
import { useUIStore } from '../../stores/ui-store';
import { fetchModels } from '@engine/api/api-tools';
import { credentialIdFor } from '@engine/api/api-rpm-limiter';
import { AgentClient } from '@engine/agents/agent-client';
import { requestEmbedding } from '@engine/api/embedding';
import { requestRerank } from '@engine/api/reranker';
import { fetchLlmModels } from '@engine/api/transport';
import { parseApiSource } from '@engine/api/source-config';
import { normalizeHeaderOverrides } from '@engine/api/header-overrides';
import type { ApiEndpoint } from '@engine/types/types';
import type { ApiSource, ApiSourceKind, LlmProtocol } from '@engine/types/types-api';

const cfg = useSettingsStore();
const sourceStore = useApiSourceStore();
const s = cfg.settings;
const ui = useUIStore();

onMounted(async () => {
  await sourceStore.initialize();
  await refreshRpmRows();
});

const showAddApi = ref(false);
/** API Key 是否明文显示（默认遮蔽；编辑已有连接时字段里装的是掩码，不会泄真 key）。 */
const showKey = ref(false);
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
  /** 🆕 源级默认采样参数（「参数跟随模型」，仅 LLM）；空串 = 不设该键。
   *  默认值：temperature 1 / topP 1 / 频率·存在惩罚 0（留空即表示不设置，回落内容包默认层）。 */
  defaultTemperature: '1',
  defaultTopP: '1',
  defaultFrequencyPenalty: '0',
  defaultPresencePenalty: '0',
  defaultMaxTokens: '',
  /** 🆕 源级自定义请求头（JSON 对象） */
  headerOverrides: '{}',
  anthropicVersion: '2023-06-01',
  anthropicBeta: '',
  /** 🆕 2026-08-22 Delta 会话（T4）：上下文窗口 token 上限（表单用 string，保存时归一化） */
  contextWindowTokens: '' as string,
  _realKey: '' as string,
  _masked: false,
});

/** 清理无法识别的旧配置行（显式按钮，不自动删数据） */
const purgingInvalid = ref(false);
async function purgeInvalidApis() {
  if (!sourceStore.invalidSourceIds.length) return;
  purgingInvalid.value = true;
  try {
    const removed = await sourceStore.purgeInvalidSources();
    ui.toast(`已清理 ${removed} 条无效配置`, 'success');
  } catch (e) {
    ui.toast('清理失败：' + (e instanceof Error ? e.message : String(e)), 'error');
  } finally {
    purgingInvalid.value = false;
  }
}
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
    headerOverrides: parseHeaderOverridesOrThrow(),
    defaultParameters: buildDefaultParameters(),
    contextWindowTokens: normalizeContextWindowTokens(apiForm.contextWindowTokens),
    anthropicVersion: apiForm.anthropicVersion,
    anthropicBeta: apiForm.anthropicBeta
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
}

/**
 * 空串 / 非有限数 → `undefined`（不设该键）；其余原样。
 * 与 `normalizeContextWindowTokens` 同口径：坏输入不写库、不报错，回退「未配置」。
 */
function normalizeOptionalNumber(raw: string | number): number | undefined {
  // 🔴 `v-model` 绑在 `<input type="number">` 上时 Vue 会把值隐式转成 number（等价 `.number`），
  //    所以这里必须同时吃 string 与 number —— 只按 string 处理会在用户一改那格时抛
  //    `raw.trim is not a function`（初始值是字符串，所以不改不报）。
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 源级默认采样参数（仅 LLM 有意义）：五个键全部空 = `undefined`。 */
function buildDefaultParameters(): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  const t = normalizeOptionalNumber(apiForm.defaultTemperature);
  if (t !== undefined) out.temperature = t;
  const p = normalizeOptionalNumber(apiForm.defaultTopP);
  if (p !== undefined) out.topP = p;
  const f = normalizeOptionalNumber(apiForm.defaultFrequencyPenalty);
  if (f !== undefined) out.frequencyPenalty = f;
  const pr = normalizeOptionalNumber(apiForm.defaultPresencePenalty);
  if (pr !== undefined) out.presencePenalty = pr;
  const m = normalizeOptionalNumber(apiForm.defaultMaxTokens);
  if (m !== undefined) out.maxTokens = m;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 自定义请求头 JSON → 校验后的对象（非法 JSON / 受保护头名 / CRLF 一律抛，由保存/测试的 catch 转 toast）。 */
function parseHeaderOverridesOrThrow(): Record<string, string> {
  const raw = apiForm.headerOverrides.trim();
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('自定义请求头不是合法 JSON');
  }
  return normalizeHeaderOverrides(parsed);
}

/** 拉取模型列表用的宽松版：JSON 坏了也照拉（列表本就不依赖它），不阻断。 */
function parseHeaderOverridesLenient(): Record<string, string> {
  try {
    return parseHeaderOverridesOrThrow();
  } catch {
    return {};
  }
}

/**
 * 「获取模型」专用的临时端点（🔴 不经过 `parseApiSource`，故允许 `defaultModel` 为空）。
 *
 * 拉取模型列表本就不需要已选模型 —— BFF 的 `GET /api/llm/:protocol/models` 连
 * `X-Model-ID` 都不读。而 `parseApiSource` 把「模型必填」当硬校验，若拉列表也走它，
 * 新建连接就会陷入「要先选模型才能拉列表、可拉列表才能选模型」的死循环。
 * 保存与「测试连接」仍走严格的 `draftSource()`，本函数只服务列表拉取。
 */
function draftEndpointForModelList(): ApiEndpoint {
  return {
    id: editingApiId.value || 'connection-test',
    name: apiForm.name || '未命名连接',
    provider: 'llm',
    baseUrl: apiForm.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: (apiForm._realKey || apiForm.apiKey).trim(),
    defaultModel: apiForm.model.trim(),
    models: [],
    timeout: Number(apiForm.timeoutMs) || 60_000,
    kind: 'llm',
    protocol: apiForm.protocol as LlmProtocol,
    headerOverrides: parseHeaderOverridesLenient(),
    anthropicVersion: apiForm.anthropicVersion || undefined,
    anthropicBeta: apiForm.anthropicBeta
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };
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
      models = await fetchLlmModels(draftEndpointForModelList());
    } else {
      const result = await fetchModels({
        baseUrl: apiForm.baseUrl,
        apiKey: rk,
        label: apiForm.name || apiForm.baseUrl,
        headerOverrides: parseHeaderOverridesLenient(),
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
/**
 * 一键预填「DeepSeek beta 前缀续写」源 —— 「正文润色」agent 专用。
 *
 * 🔴 只填 baseUrl / 模型 / 名称三样（都是非密钥），**API Key 仍由用户填写**：
 *    `https://api.deepseek.com/beta` 是前缀续写的必要端点。
 * 🔴 思考模式与推理强度**不在这里配**（那会把 DeepSeek 专属旋钮塞回通用 API 表单）——
 *    「正文润色」侧链在调用时自行附加 thinking 与推理强度（见 prose-rewrite-agent）。
 */
function applyDeepSeekPrefixPreset() {
  apiForm.kind = 'llm';
  apiForm.protocol = 'openai-chat';
  if (!apiForm.name.trim()) apiForm.name = 'DeepSeek 前缀续写 (beta)';
  apiForm.baseUrl = 'https://api.deepseek.com/beta';
  if (!apiForm.model.trim()) apiForm.model = 'deepseek-flash';
  ui.toast('已填入 DeepSeek beta 模板，请填写 API Key', 'success');
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
  apiForm.defaultTemperature = '1';
  apiForm.defaultTopP = '1';
  apiForm.defaultFrequencyPenalty = '0';
  apiForm.defaultPresencePenalty = '0';
  apiForm.defaultMaxTokens = '';
  apiForm.headerOverrides = '{}';
  apiForm.anthropicVersion = '2023-06-01';
  apiForm.anthropicBeta = '';
  apiForm.contextWindowTokens = '';
  apiForm._realKey = '';
  apiForm._masked = false;
  showKey.value = false;
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
  // 🔴 编辑态字段里装的是**掩码**（如 `sk-***abcd`），真 key 只在 `_realKey` 里。
  //    此前这里直接塞真 key + `:type` 判成 text —— 弹窗一开就明文暴露，截屏/录屏/旁人一眼可见。
  apiForm.apiKey = key ? maskKey(key) : '';
  apiForm._realKey = key;
  apiForm._masked = key ? true : false;
  showKey.value = false;
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
  // 🆕 源级默认采样参数：只在 LLM 源上有意义；缺失 = 空串（不设该键）。
  const defaultParams = source?.kind === 'llm' ? source.defaultParameters : undefined;
  apiForm.defaultTemperature =
    defaultParams?.temperature != null ? String(defaultParams.temperature) : '1';
  apiForm.defaultTopP = defaultParams?.topP != null ? String(defaultParams.topP) : '1';
  apiForm.defaultFrequencyPenalty =
    defaultParams?.frequencyPenalty != null ? String(defaultParams.frequencyPenalty) : '0';
  apiForm.defaultPresencePenalty =
    defaultParams?.presencePenalty != null ? String(defaultParams.presencePenalty) : '0';
  apiForm.defaultMaxTokens =
    defaultParams?.maxTokens != null ? String(defaultParams.maxTokens) : '';
  apiForm.headerOverrides = JSON.stringify(
    source?.headerOverrides ?? hydrated.headerOverrides ?? {},
    null,
    2,
  );
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
function normalizeContextWindowTokens(raw: string | number): number | undefined {
  // 🔴 同 `normalizeOptionalNumber`：`<input type="number">` 的 v-model 会给到 number。
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
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
      <AppCard v-if="sourceStore.invalidSourceIds.length" padding="md" class="invalid-api-card">
        <p class="text-sm" style="margin: 0 0 6px">
          检测到 <strong>{{ sourceStore.invalidSourceIds.length }}</strong> 条旧版本的 API
          配置无法识别（缺少「用途」等字段），已跳过、不影响使用。这些旧配置需要重新添加；也可以直接清理掉。
        </p>
        <AppButton variant="ghost" size="sm" :loading="purgingInvalid" @click="purgeInvalidApis"
          >清理 {{ sourceStore.invalidSourceIds.length }} 条无效配置</AppButton
        >
      </AppCard>
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
      size="lg"
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
        >
        <div class="form-label">
          <AppButton variant="secondary" size="sm" @click="applyDeepSeekPrefixPreset"
            >填入 DeepSeek 前缀续写模板</AppButton
          >
          <p class="form-hint">
            用于「正文润色」：填入 DeepSeek 的 /beta 端点。API Key 请自行填写（思考模式由该 Agent
            自行开启，无需在此配置）。
          </p>
        </div>
        <label class="form-label"
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
              :type="showKey ? 'text' : 'password'"
              autocomplete="off"
              placeholder="API Key（按服务商提供，不一定是 sk- 开头）"
              @input="onApiKeyInput"
            /><button
              type="button"
              class="key-toggle"
              :aria-label="showKey ? '隐藏密钥' : '显示密钥'"
              :title="showKey ? '隐藏密钥' : '显示密钥'"
              @click="showKey = !showKey"
            >
              <i
                class="fa-solid"
                :class="showKey ? 'fa-eye-slash' : 'fa-eye'"
                aria-hidden="true"
              /></button
            ><AppButton
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
        <!-- 🆕 源级默认采样参数（「参数跟随模型」）：配一次，所有绑定此池的 Agent 皆生效；
             Agent 设置里**显式改过**的字段仍优先。留空 = 不设置该键（回落到内容包默认）。 -->
        <div v-if="isLlmEntry" class="default-params">
          <p class="default-params-title">默认采样参数（跟随此 API 池）</p>
          <div
            class="form-grid"
            style="grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px"
          >
            <label class="form-label"
              >Temperature
              <input
                v-model="apiForm.defaultTemperature"
                class="form-input"
                type="number"
                step="0.1"
                min="0"
                max="2"
                placeholder="(不设置)"
              />
            </label>
            <label class="form-label"
              >Top P
              <input
                v-model="apiForm.defaultTopP"
                class="form-input"
                type="number"
                step="0.05"
                min="0"
                max="1"
                placeholder="(不设置)"
              />
            </label>
            <label class="form-label"
              >Frequency Penalty
              <input
                v-model="apiForm.defaultFrequencyPenalty"
                class="form-input"
                type="number"
                step="0.1"
                min="-2"
                max="2"
                placeholder="(不设置)"
              />
            </label>
            <label class="form-label"
              >Presence Penalty
              <input
                v-model="apiForm.defaultPresencePenalty"
                class="form-input"
                type="number"
                step="0.1"
                min="-2"
                max="2"
                placeholder="(不设置)"
              />
            </label>
            <label class="form-label"
              >Max Tokens
              <input
                v-model="apiForm.defaultMaxTokens"
                class="form-input"
                type="number"
                min="100"
                max="384000"
                step="100"
                placeholder="(不设置)"
              />
            </label>
          </div>
          <p class="form-hint">
            换模型（= 换 API 池）不必再逐个 Agent 重设采样参数。默认为 temperature 1 / Top P 1 /
            惩罚 0；清空某一格 = 不设置该键（回落内容包默认层）。Agent
            设置里显式覆写过的字段优先于这里。
          </p>
        </div>
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
            <label class="form-label form-label-stacked">
              自定义请求头（JSON）
              <textarea
                v-model="apiForm.headerOverrides"
                class="form-input api-json"
                rows="4"
                spellcheck="false"
                placeholder='{"x-opencode-session": "790766510"}'
              ></textarea>
              <span class="form-hint">
                转发给上游网关的自定义请求头（非标准 OpenAI 兼容端点常需要，如会话头 / 租户头）。
                鉴权、Content-Type 与代理控制头受保护，填了会被拒绝。
              </span>
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
/* API Key 显示 / 隐藏按钮（与输入框同高，不抢焦点） */
.key-toggle {
  flex: 0 0 auto;
  width: 36px;
  min-height: 36px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  cursor: pointer;
  transition: color var(--theme-transition-fast);
}
.key-toggle:hover {
  color: var(--theme-text-primary);
}
/* 源级默认采样参数分组（「参数跟随模型」） */
.default-params {
  margin-top: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-primary) 4%, transparent);
}
.default-params-title {
  margin: 0 0 var(--theme-spacing-xs);
  color: var(--theme-text-secondary);
  font-size: 0.82rem;
  font-weight: 600;
}
</style>
