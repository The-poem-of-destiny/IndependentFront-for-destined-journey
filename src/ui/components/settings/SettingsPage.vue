<script setup lang="ts">
/**
 * 设置页壳层 —— 导航 + Agent 分区（Q-25）
 *
 * 12 个分区里 11 个已经是一行子组件；只剩 **Agent 配置**还内联在这里，因为它
 * 要读写 13 张 per-Agent 并行 map（`agentModels` / `agentPrompts` / …），
 * 而那些 map 的形状正是 Q-18 要改的东西 —— 先拆再改等于拆两遍。
 * Q-18 落地后照 `settings/audio/` 的样子拆成 `settings/agent/` 目录。
 *
 * 分区共用的外壳样式在 `settings-chrome.css`：本页的 `<style scoped>` 只能命中
 * 自己的模板与子组件的**根节点**，够不到根节点里面，所以那份共用规则由各分区
 * （含本页）各自 `<style scoped src>` 引入 —— 一份源码，各自作用域。
 */
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue';
import { useUIStore } from '../../stores/ui-store';
import { useSettingsStore, type PresetItem } from '../../stores/settings-store';
import {
  AGENT_SETTINGS_DEFAULTS,
  getAgentSettings,
  patchAgentSettings,
  resetAgentSettings,
} from '../../stores/agent-settings';
import { useWorldBookStore } from '../../stores/worldbook-store';
import AppButton from '../shared/AppButton.vue';
import AppCard from '../shared/AppCard.vue';
import AppModal from '../shared/AppModal.vue';
import TemplatePreview from './TemplatePreview.vue';
import { getAgentTemplate } from '@engine/agent-templates';
import { getDefaultTemplate } from '@engine/placeholder-registry';
import { preprocessPresetForPreview } from '@engine/preset-loader';
import ApiSection from './ApiSection.vue';
import WorldBookSection from './WorldBookSection.vue';
import PlotSection from './PlotSection.vue';
import MemorySection from './MemorySection.vue';
import ThemeSection from './ThemeSection.vue';
import MessagesSection from './MessagesSection.vue';
import BeautifierSection from './BeautifierSection.vue';
import AudioSection from './AudioSection.vue';
import AssetSection from './AssetSection.vue';
import DataSection from './DataSection.vue';
import AboutSection from './AboutSection.vue';

const ui = useUIStore();
const cfg = useSettingsStore();
const s = cfg.settings; // 短别名，模板里用 s.xxx
// Phase 0：书本体在 Dexie，唯一入口是 worldbook-store（`s.worldBooks` 已不存在）
const wb = useWorldBookStore();

/**
 * 有没有配好 API —— **两个消费者都在壳层**，所以它没跟着 ApiSection 走：
 * 左侧 Agent 子导航的红色 `!` 角标，以及 Agent 分区里"没选模型且没配 API"那句提示。
 * 读的是 store，与 ApiSection 天然同源，不需要跨组件传。
 */
const hasApi = computed(() => s.apiPool.length > 0);

// ============================================================
// 主导航
// ============================================================
type Section =
  | 'api'
  | 'agent'
  | 'worldbook'
  | 'plot'
  | 'memory'
  | 'theme'
  | 'messages'
  | 'beautifier'
  | 'audio'
  | 'asset'
  | 'data'
  | 'about';
const activeSection = ref<Section>('api');

const navItems: { key: Section; label: string; icon: string }[] = [
  { key: 'api', label: 'API 配置', icon: 'fa-solid fa-plug' },
  { key: 'agent', label: 'Agent 配置', icon: 'fa-solid fa-robot' },
  { key: 'worldbook', label: '世界书', icon: 'fa-solid fa-book-open' },
  { key: 'plot', label: '剧情系统', icon: 'fa-solid fa-scroll' },
  { key: 'memory', label: '记忆 & 缓存', icon: 'fa-solid fa-brain' },
  { key: 'theme', label: '外观主题', icon: 'fa-solid fa-palette' },
  { key: 'messages', label: '消息显示', icon: 'fa-solid fa-message' },
  { key: 'beautifier', label: '输出美化', icon: 'fa-solid fa-wand-magic-sparkles' },
  { key: 'audio', label: '音频', icon: 'fa-solid fa-music' },
  // 媒体两分区相邻，数据操作排在它们之后（设计 §7.1）
  { key: 'asset', label: '素材', icon: 'fa-solid fa-image' },
  { key: 'data', label: '存档数据', icon: 'fa-solid fa-database' },
  { key: 'about', label: '关于', icon: 'fa-solid fa-circle-info' },
];

// ============================================================
// Agent 配置
// ============================================================
const agentList = [
  {
    id: 'memory_recall',
    name: '记忆召回',
    desc: '根据用户输入从记忆库中 Embedding 召回相关记忆',
    stage: 0,
  },
  { id: 'plot_pre_check', name: '剧情预检', desc: '正文前检查需要触发的剧情事件和背景', stage: 0 },
  { id: 'story', name: '正文生成', desc: '核心叙事 Agent，生成游戏正文内容', stage: 1 },
  {
    id: 'craft_gen',
    name: '制作生成',
    desc: '处理制作意图，调用 $craft 工具生成创意效果',
    stage: 1,
  },
  {
    id: 'request_dispatcher',
    name: '请求调度',
    desc: '分析正文，判断新-vs-已有角色/物品/制作，输出 XML 标签调度下游 Agent',
    stage: 2,
  },
  {
    id: 'vars_update',
    name: '变量更新',
    desc: '根据调度器标签更新角色状态、物品状态、环境效果，必要时编写状态效果脚本',
    stage: 3,
  },
  { id: 'char_gen', name: '角色生成', desc: '生成新 NPC 的五维属性、背景和登神长阶', stage: 3 },
  { id: 'item_gen', name: '物品生成', desc: '为 NPC 生成装备、技能和道具', stage: 3 },
  { id: 'memory_summary', name: '记忆总结', desc: '生成本轮记忆摘要并计算 Embedding', stage: 4 },
  { id: 'plot_post_check', name: '剧情修正', desc: '正文后检查世界线变动，修正剧情大纲', stage: 5 },
  { id: 'plot_outline', name: '大纲生成', desc: '主线/支线模式下生成剧情大纲和事件树', stage: 5 },
];
const activeAgent = ref<string | null>(s.activeAgent);

// Phase 0: 保证进设置页时世界书已就绪（init() 幂等，App.vue 已踢过一次）
// Agent 分区的"这个 Agent 能看哪几本"勾选列表要用它；API 密钥的解密改由
// ApiSection 自己在挂载时踢（Q-25）。
onMounted(() => {
  void wb.init().catch(() => {
    /* 世界书装不起来不该拦住设置页其它分区 */
  });
});

// Agent 配置全部从 settings-store 读写，自动持久化
const agentPromptDraft = ref('');
const agentTemplateDraft = ref('');
// 初始化时从 store 恢复 agent 提示词
if (activeAgent.value && s.agentPrompts[activeAgent.value]) {
  agentPromptDraft.value = s.agentPrompts[activeAgent.value];
}

// ============================================================
// Phase 10e: Template System
// ============================================================

interface PlaceholderBadge {
  key: string;
  color: string;
  desc: string;
  category: string;
}

// All registered placeholders with metadata
const ALL_PLACEHOLDER_META: PlaceholderBadge[] = [
  {
    key: 'SYS_PROMPT',
    color: '#4a9eff',
    desc: '核心指令 — 预设/agent-config systemPrompt',
    category: '自身',
  },
  { key: 'LORE_BOOK', color: '#4caf50', desc: '世界书 — keyword 激活条目', category: '世界' },
  {
    key: 'LORE_BOOK_STATIC',
    color: '#4caf50',
    desc: '世界书静态区 — 字节稳定条目',
    category: '世界',
  },
  {
    key: 'LORE_BOOK_DYNAMIC',
    color: '#4caf50',
    desc: '世界书动态区 — 含 EJS，装配时求值',
    category: '世界',
  },
  { key: 'NARRATIVE', color: '#ab47bc', desc: '对话历史 — 最近 N 轮消息', category: '叙事' },
  { key: 'USER_INPUT', color: '#ab47bc', desc: '用户输入 — 当前轮输入', category: '叙事' },
  { key: 'CHARACTER_STATE', color: '#ff9800', desc: '角色状态 — 属性/装备/技能', category: '角色' },
  { key: 'INVENTORY', color: '#ff9800', desc: '背包 — 角色物品列表', category: '角色' },
  { key: 'GAME_TIME', color: '#4caf50', desc: '世界状态 — 时间/位置/天气', category: '世界' },
  { key: 'ACTIVE_EFFECTS', color: '#ff9800', desc: '活跃效果 — Buff/Debuff', category: '角色' },
  { key: 'MEMORY_ENTRIES', color: '#ff7043', desc: '记忆条目 — embedding 召回', category: '记忆' },
  { key: 'PLOT_EVENTS', color: '#ff7043', desc: '剧情事件 — 活跃+待处理', category: '剧情' },
  {
    key: 'AGENT.MEMORY_RECALL',
    color: '#ef5350',
    desc: 'memory_recall 输出',
    category: 'Agent通信',
  },
  {
    key: 'AGENT.PLOT_PRE_CHECK',
    color: '#ef5350',
    desc: 'plot_pre_check 输出',
    category: 'Agent通信',
  },
  { key: 'AGENT.STORY', color: '#ef5350', desc: 'story 正文AI 输出', category: 'Agent通信' },
  {
    key: 'AGENT.REQUEST_DISPATCHER',
    color: '#ef5350',
    desc: 'request_dispatcher 调度器输出',
    category: 'Agent通信',
  },
  {
    key: 'AGENT.MEMORY_SUMMARY',
    color: '#ef5350',
    desc: 'memory_summary 输出',
    category: 'Agent通信',
  },
  {
    key: 'AGENT.VARS_UPDATE',
    color: '#ef5350',
    desc: 'vars_update 执行器输出',
    category: 'Agent通信',
  },
  { key: 'CRAFT_REQUEST', color: '#9e9e9e', desc: '<craft_request> 标记', category: '链调用' },
  { key: 'CHAR_DETECT', color: '#9e9e9e', desc: '<char_detect> 检测标记', category: '链调用' },
  { key: 'ITEM_REQUEST', color: '#9e9e9e', desc: '<item_requests> 物品请求', category: '链调用' },
  { key: 'CHAR_GEN_RESULT', color: '#9e9e9e', desc: 'char_gen NPC生成结果', category: '链调用' },
  { key: 'CRAFT_RESULT', color: '#9e9e9e', desc: 'craft_gen 制作结果', category: '链调用' },
];

// Filter available placeholders by agent type
function getPlaceholdersForAgent(agentId: string): PlaceholderBadge[] {
  // Chain-only placeholders — only shown for specific agents
  const chainOnly: Record<string, string[]> = {
    craft_gen: ['CRAFT_REQUEST', 'ITEM_REQUEST', 'CRAFT_RESULT'],
    char_gen: ['CHAR_DETECT', 'CHAR_GEN_RESULT'],
    item_gen: ['ITEM_REQUEST', 'CHAR_GEN_RESULT', 'CRAFT_RESULT'],
  };

  // Agent-to-agent: determine which upstream agents' outputs are available
  const agentOutputs: Record<string, string[]> = {
    story: ['AGENT.MEMORY_RECALL', 'AGENT.PLOT_PRE_CHECK'],
    plot_pre_check: ['AGENT.MEMORY_RECALL'],
    request_dispatcher: ['AGENT.STORY'],
    vars_update: ['AGENT.STORY', 'AGENT.REQUEST_DISPATCHER'],
    memory_summary: ['AGENT.STORY'],
    plot_post_check: ['AGENT.STORY', 'AGENT.MEMORY_SUMMARY'],
  };

  const allowedChain = chainOnly[agentId] || [];
  const allowedAgentOutputs = agentOutputs[agentId] || [];
  const allowed = new Set([...allowedChain, ...allowedAgentOutputs]);

  return ALL_PLACEHOLDER_META.filter((p) => {
    // Always show these common placeholders
    const commonKeys = [
      'SYS_PROMPT',
      'LORE_BOOK',
      'LORE_BOOK_STATIC',
      'LORE_BOOK_DYNAMIC',
      'NARRATIVE',
      'USER_INPUT',
      'CHARACTER_STATE',
      'INVENTORY',
      'GAME_TIME',
      'ACTIVE_EFFECTS',
      'MEMORY_ENTRIES',
      'PLOT_EVENTS',
    ];
    if (commonKeys.includes(p.key)) return true;
    // Show agent-specific placeholders
    if (allowed.has(p.key)) return true;
    return false;
  });
}

const showTemplatePreview = ref(false);
const showStoryPreview = ref(false);
const showStoryResolvedPreview = ref(false);

// Phase 10h: 预设解析预览 — setvar/getvar 展开，系统占位符/random/char/user 保留
const resolvedPresetTemplate = computed(() => {
  const preset = activePreset.value;
  if (!preset) return '';
  return preprocessPresetForPreview(preset as any);
});

// Available placeholders for the current agent (filtered by agent type)
const availablePlaceholders = computed(() => {
  const agentId = activeAgent.value;
  if (!agentId) return [];
  const allPlaceholders = getPlaceholdersForAgent(agentId);
  return allPlaceholders;
});

// Insert a placeholder at cursor position in the template textarea
function insertPlaceholder(key: string) {
  // Find the template textarea (second .prompt-editor in the non-story card)
  const textareas = document.querySelectorAll('.prompt-editor');
  const textarea = textareas[textareas.length - 1] as HTMLTextAreaElement; // last one = template
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = agentTemplateDraft.value;
  const before = text.substring(0, start);
  const after = text.substring(end);
  agentTemplateDraft.value = before + `{{${key}}}` + after;
  s.agentPromptEdited = true;
  nextTick(() => {
    textarea.selectionStart = textarea.selectionEnd = start + key.length + 4;
    textarea.focus();
  });
}

/** 渲染占位符标签文本 — 避免 Vue 模板中 {{ 转义问题 */
function phLabel(key: string): string {
  return '{' + '{ ' + key + ' }' + '}';
}

// Get the default template for non-story agents (from placeholder-registry)
function getDefaultTemplateForAgent(agentId: string | null): string {
  if (!agentId) return '';
  try {
    return getDefaultTemplate(agentId);
  } catch {
    return '';
  }
}

// Get the context template for Story agent (from injected entries or default block)
function getStoryContextTemplate(): string {
  const preset = activePreset.value;
  if (!preset?.settings?.prompts) return '';
  const dynamicEntry = preset.settings.prompts.find(
    (p: any) => p.name === '动态注入' && p.enabled !== false,
  );
  if (dynamicEntry?.content) return dynamicEntry.content;
  // Fallback: the default block
  return [
    '{{AGENT.MEMORY_RECALL}}',
    '{{AGENT.PLOT_PRE_CHECK}}',
    '{{LORE_BOOK_STATIC}}',
    '{{CHARACTER_STATE}}',
    '{{LORE_BOOK_DYNAMIC}}',
    '{{GAME_TIME}}',
    '{{NARRATIVE}}',
    '{{USER_INPUT}}',
  ].join('\n');
}

// ============================================================
// 预设系统（正文 Agent 专用）
// ============================================================
const activePreset = computed(
  () => s.presets.find((p: PresetItem) => p.id === s.activePresetId) || null,
);

// 条目展开/折叠
const expandedEntries = ref(new Set<string>());
function toggleEntry(presetId: string, idx: number) {
  const key = `${presetId}:${idx}`;
  if (expandedEntries.value.has(key)) expandedEntries.value.delete(key);
  else expandedEntries.value.add(key);
}

// 条目启用/禁用开关 — 自动保存
async function togglePresetEntryEnabled(presetId: string, idx: number) {
  const p = s.presets.find((x: PresetItem) => x.id === presetId);
  if (!p?.settings?.prompts) return;
  const prompts = [...p.settings.prompts];
  if (!prompts[idx]) return;
  prompts[idx] = { ...prompts[idx], enabled: !(prompts[idx].enabled !== false) };
  const raw = JSON.parse(
    JSON.stringify({ ...p, settings: { ...p.settings, prompts }, updatedAt: Date.now() }),
  );
  // 直接替换 s.presets 中对应的预设（避免闪动后再等 DB 回读）
  const pi = s.presets.findIndex((x: PresetItem) => x.id === presetId);
  if (pi >= 0) s.presets[pi] = raw;
  try {
    const { savePreset } = await import('@engine/database');
    await savePreset(raw);
  } catch {
    /* DB 写入失败时 UI 已经乐观更新 */
  }
}

// 条目编辑弹窗
const showEntryEditor = ref(false);
const editingEntryIdx = ref(-1);
const editingEntryPresetId = ref('');
const entryEditForm = reactive({ name: '', content: '', enabled: true, role: 'system' });

function openEntryEditor(presetId: string, idx: number) {
  const p = s.presets.find((x: PresetItem) => x.id === presetId);
  if (!p?.settings?.prompts?.[idx]) return;
  const sp = p.settings.prompts[idx];
  editingEntryPresetId.value = presetId;
  editingEntryIdx.value = idx;
  entryEditForm.name = sp.name || '';
  entryEditForm.content = sp.content || '';
  entryEditForm.enabled = sp.enabled !== false;
  entryEditForm.role = sp.role || 'system';
  showEntryEditor.value = true;
}

async function saveEntry() {
  const p = s.presets.find((x: PresetItem) => x.id === editingEntryPresetId.value);
  if (!p) return;
  const idx = editingEntryIdx.value;
  const prompts = [...(p.settings.prompts || [])];
  if (prompts[idx]) {
    prompts[idx] = {
      ...prompts[idx],
      name: entryEditForm.name,
      content: entryEditForm.content,
      enabled: entryEditForm.enabled,
      role: entryEditForm.role,
    };
    const raw = JSON.parse(
      JSON.stringify({ ...p, settings: { ...p.settings, prompts }, updatedAt: Date.now() }),
    );
    const { savePreset } = await import('@engine/database');
    await savePreset(raw);
    await loadPresets();
    s.activePresetId = raw.id;
    showEntryEditor.value = false;
    ui.toast('条目已保存', 'success');
  }
}
const showPresetEditor = ref(false);
const presetForm = reactive({
  name: '',
  description: '',
  mainPrompt: '',
  temperature: '0.8',
  maxTokens: '4096',
  topP: '1',
  freqPen: '0',
  presPen: '0',
});
const editingPresetId = ref<string | null>(null);

async function loadPresets() {
  try {
    const { getPresets } = await import('@engine/database');
    const p = await getPresets();
    if (p) {
      // IndexedDB 有数据 → 直接用；为空 → 保留内存已有的（来自 agent-config.json seed）
      if (p.length > 0) s.presets = p as PresetItem[];
    }
    // 确保自动选中：如果还没选中且有可用预设，优先项目默认
    if (!s.activePresetId && (s.presets as PresetItem[]).length > 0) {
      const pd = cfg.projectAgentDefaults?.agents?.story;
      if (pd?.presetId && (s.presets as PresetItem[]).find((p) => p.id === pd.presetId)) {
        s.activePresetId = pd.presetId;
      }
    }
  } catch {}
}
function selectPreset(id: string) {
  s.activePresetId = id;
  const p = s.presets.find((x: PresetItem) => x.id === id);
  if (p) {
    const ps = p.settings;
    agentPromptDraft.value = ps.prompts?.[0]?.content || ps.mainPrompt || ps.system_prompt || '';
    s.agentPromptEdited = true;
  }
}
function openNewPreset() {
  editingPresetId.value = null;
  presetForm.name = '';
  presetForm.description = '';
  presetForm.mainPrompt = '';
  presetForm.temperature = '0.8';
  presetForm.maxTokens = '4096';
  presetForm.topP = '1';
  presetForm.freqPen = '0';
  presetForm.presPen = '0';
  showPresetEditor.value = true;
}
function openEditPreset(p: PresetItem) {
  editingPresetId.value = p.id;
  const s = p.settings;
  presetForm.name = p.name;
  presetForm.description = p.description || '';
  presetForm.mainPrompt = s.prompts?.[0]?.content || s.mainPrompt || s.system_prompt || '';
  presetForm.temperature = s.temp_openai ?? s.temperature ?? '0.8';
  presetForm.maxTokens = s.openai_max_tokens ?? s.max_tokens ?? '4096';
  presetForm.topP = s.top_p_openai ?? s.top_p ?? '1';
  presetForm.freqPen = s.freq_pen_openai ?? s.frequency_penalty ?? '0';
  presetForm.presPen = s.pres_pen_openai ?? s.presence_penalty ?? '0';
  showPresetEditor.value = true;
}
async function savePreset() {
  const { savePreset: sp } = await import('@engine/database');
  const now = Date.now();

  let settings: Record<string, any>;
  if (editingPresetId.value) {
    // 编辑已有预设：基于原 settings 更新，不丢失原有数据
    const original = s.presets.find((p: PresetItem) => p.id === editingPresetId.value);
    settings = {
      ...(original?.settings || {}), // 保留所有原有 ST 配置
      temp_openai: presetForm.temperature,
      openai_max_tokens: presetForm.maxTokens,
      top_p_openai: presetForm.topP,
      freq_pen_openai: presetForm.freqPen,
      pres_pen_openai: presetForm.presPen,
    };
    // 更新 prompts[0] 的 Main Prompt 内容，保留其余所有条目
    const prompts = [...(settings.prompts || [])];
    if (prompts.length > 0) {
      prompts[0] = {
        ...prompts[0],
        content: presetForm.mainPrompt,
        name: prompts[0].name || 'Main Prompt',
        role: prompts[0].role || 'system',
      };
    } else {
      prompts.push({ name: 'Main Prompt', content: presetForm.mainPrompt, role: 'system' });
    }
    settings.prompts = prompts;
  } else {
    // 新建预设：从零构建
    settings = {
      temp_openai: presetForm.temperature,
      openai_max_tokens: presetForm.maxTokens,
      top_p_openai: presetForm.topP,
      freq_pen_openai: presetForm.freqPen,
      pres_pen_openai: presetForm.presPen,
      prompts: [{ name: 'Main Prompt', content: presetForm.mainPrompt, role: 'system' }],
    };
  }

  const item: PresetItem = {
    id: editingPresetId.value || crypto.randomUUID(),
    name: presetForm.name,
    description: presetForm.description,
    settings,
    createdAt: editingPresetId.value
      ? s.presets.find((p: PresetItem) => p.id === editingPresetId.value)?.createdAt || now
      : now,
    updatedAt: now,
  };
  await sp(item as any);
  await loadPresets();
  showPresetEditor.value = false;
  ui.toast(editingPresetId.value ? '预设已更新' : '预设已创建', 'success');
}
async function deletePreset(id: string) {
  const { deletePreset: dp } = await import('@engine/database');
  try {
    await dp(id);
    await loadPresets();
    if (s.activePresetId === id) s.activePresetId = '';
    ui.toast('预设已删除', 'info');
  } catch {}
}
async function importStPreset() {
  const { savePreset: sp } = await import('@engine/database');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      // 用导入的文件名作为预设名
      const presetName = f.name.replace(/\.json$/i, '');
      const now = Date.now();
      const preset: PresetItem = {
        id: crypto.randomUUID(),
        name: presetName,
        description: raw.description || '',
        settings: raw,
        createdAt: now,
        updatedAt: now,
      };
      await sp(preset as any);
      await loadPresets();
      ui.toast(`已导入预设「${presetName}」(${raw.prompts?.length || 0} 个子提示词)`, 'success');
    } catch {
      ui.toast('导入失败，请检查文件格式', 'error');
    }
  };
  input.click();
}
async function exportPresetDynamic(p: PresetItem) {
  const data = { ...p.settings, name: p.name, description: p.description };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${p.name}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 进入 Agent 配置时加载预设
watch(activeSection, (s) => {
  if (s === 'agent') loadPresets();
});

const availableApiModels = computed(() => {
  const m: { id: string; label: string }[] = [];
  for (const api of s.apiPool)
    for (const mdl of api.models) m.push({ id: `${api.id}:${mdl}`, label: `${api.name} — ${mdl}` });
  return m;
});

function selectAgent(agentId: string) {
  activeAgent.value = agentId;
  s.activeAgent = agentId;
  // 优先加载用户自定义的 system prompt，否则加载引擎内置模板
  const custom = s.agentPrompts[agentId];
  if (custom) {
    agentPromptDraft.value = custom;
  } else {
    // Phase 9: 优先从 agent-config.json 读 systemPrompt，否则回退到 agent-templates.ts 的 fixedSystem+fixedExamples
    const pd = cfg.projectAgentDefaults?.agents?.[agentId];
    if (pd?.systemPrompt) {
      agentPromptDraft.value = pd.systemPrompt;
    } else {
      const tpl = getAgentTemplate(agentId);
      agentPromptDraft.value = tpl
        ? (tpl.fixedSystem + '\n\n' + (tpl.fixedExamples || '')).trim()
        : '';
    }
  }
  s.agentPromptEdited = false;

  // Load template from user custom, agent-config, or default
  const customTemplate = s.agentTemplates[agentId];
  if (customTemplate) {
    agentTemplateDraft.value = customTemplate;
  } else {
    const pd2 = cfg.projectAgentDefaults?.agents?.[agentId];
    if (pd2?.template) {
      agentTemplateDraft.value = pd2.template;
    } else {
      agentTemplateDraft.value = getDefaultTemplateForAgent(agentId);
    }
  }
}

function confirmPrompt() {
  if (!activeAgent.value) return;
  s.agentPrompts[activeAgent.value] = agentPromptDraft.value;
  s.agentPromptEdited = false;
  s.agentDirty[activeAgent.value] = true;
  ui.toast('提示词已保存', 'success');
}
function resetPrompt() {
  if (!activeAgent.value) return;
  agentPromptDraft.value = '';
  s.agentPrompts[activeAgent.value] = '';
  s.agentPromptEdited = false;
  s.agentDirty[activeAgent.value] = false;
  ui.toast('已清除自定义提示词，将使用引擎内置模板', 'info');
}
async function saveAsDefault() {
  if (!activeAgent.value) return;
  const agentId = activeAgent.value;

  // 构建当前 Agent 的默认条目。
  // Q-18: 此前是 13 行手抄（含 5 处 `?? 0.7` 之类的字面默认），加个旋钮要记得来这补一行。
  // systemPrompt / template 先清空，由下面按 story / 非 story 分别填。
  const entry = {
    ...getAgentSettings(s, agentId),
    systemPrompt: '',
    template: '',
    presetId: '',
    preset: null as PresetItem | null,
  };

  if (agentId === 'story') {
    // Story Agent：嵌入完整预设数据
    entry.presetId = s.activePresetId || '';
    if (s.activePresetId && activePreset.value) {
      entry.preset = JSON.parse(JSON.stringify(activePreset.value));
    }
  } else {
    // 其他 Agent：提交 System Prompt + Template
    s.agentPrompts[agentId] = agentPromptDraft.value;
    entry.systemPrompt = agentPromptDraft.value || '';
    // Save template
    s.agentTemplates[agentId] = agentTemplateDraft.value;
    entry.template = agentTemplateDraft.value || '';
  }

  // 读取现有文件，更新当前 Agent，写回
  let current: { version: number; agents: Record<string, any> } = { version: 1, agents: {} };
  try {
    const res = await fetch('/data/defaults/agent-config.json');
    if (res.ok) current = await res.json();
  } catch {
    /* 首次保存 — 用空骨架 */
  }

  current.agents[agentId] = entry as any;

  const ok = await cfg.saveAgentProjectDefaults(current as any);
  if (ok) {
    ui.toast(
      `已将「${agentList.find((a) => a.id === agentId)?.name || agentId}」的配置保存为项目默认`,
      'success',
    );
  } else {
    ui.toast('保存项目默认失败，请确认开发服务器正在运行', 'error');
  }
}

function saveAgentSettings() {
  if (!activeAgent.value) return;
  // 非 story Agent：提交 System Prompt + Template 到持久化
  if (activeAgent.value !== 'story') {
    s.agentPrompts[activeAgent.value] = agentPromptDraft.value;
    s.agentTemplates[activeAgent.value] = agentTemplateDraft.value;
  }
  s.agentDirty[activeAgent.value] = true;
  ui.toast('Agent 设置已保存', 'success');
}

/** Phase 8.6: 历史注入层数输入 — 空值清除 (走引擎类别默认)，非空写入 */
function onHistoryLayersInput(ev: Event) {
  if (!activeAgent.value) return;
  const v = (ev.target as HTMLInputElement).value;
  if (v === '') delete s.agentHistoryLayers[activeAgent.value];
  else s.agentHistoryLayers[activeAgent.value] = Number(v);
  s.agentDirty[activeAgent.value] = true;
}
/** Phase 8.6: 历史截断字数输入 — 空值清除 (走引擎类别默认)，非空写入 */
function onHistorySliceInput(ev: Event) {
  if (!activeAgent.value) return;
  const v = (ev.target as HTMLInputElement).value;
  if (v === '') delete s.agentHistorySlice[activeAgent.value];
  else s.agentHistorySlice[activeAgent.value] = Number(v);
  s.agentDirty[activeAgent.value] = true;
}
async function restoreAgentDefaults() {
  if (!activeAgent.value) return;
  const agentId = activeAgent.value;

  // 优先查项目默认
  const pd = cfg.projectAgentDefaults?.agents?.[agentId];
  if (pd) {
    // 不恢复模型选择 — 用户自己选的 API 和模型不应该被默认值覆盖
    s.agentWorldbookEnabled[agentId] = pd.worldBookEnabled ?? false;
    s.agentWorldbookIds[agentId] = [...(pd.worldBookIds || [])];
    if (agentId === 'story') {
      s.activePresetId = pd.presetId || '';
      if (pd.preset) {
        const existing = (s.presets as PresetItem[]).find((p) => p.id === pd.preset!.id);
        if (!existing) {
          s.presets.push(pd.preset);
          // 🔒 P2-04: await 写 IndexedDB —— 此前 fire-and-forget + 空 catch，
          // 刷新或页面销毁时 Promise 可能未完成，预设丢失且错误被吞。
          try {
            const { savePreset } = await import('@engine/database');
            await savePreset(pd.preset as any);
          } catch (err) {
            console.error('[SettingsPage] 恢复默认预设写 IndexedDB 失败:', err);
          }
        }
      }
    } else {
      s.agentPrompts[agentId] = pd.systemPrompt || '';
      agentPromptDraft.value = pd.systemPrompt || '';
      // Restore template from project default
      if (pd.template) {
        s.agentTemplates[agentId] = pd.template;
        agentTemplateDraft.value = pd.template;
      } else {
        agentTemplateDraft.value = '';
        delete s.agentTemplates[agentId];
      }
    }
    // Q-18: 五个数值旋钮 + 两项历史注入配置一次写完，默认值只在
    // AGENT_SETTINGS_DEFAULTS 出现一次（此前这里各写一遍 `?? 0.7 / ?? 16384`，
    // 与下面的兜底分支、game-pipeline、create-store 共六份拷贝）。
    //
    // `historyLayers` / `historySlice` 传 undefined 即**删键** —— 项目默认没设时要把
    // 「走引擎按 agent 类别的默认」那条语义还回去，不是写个 0 进去。
    //
    // 🔴 这里刻意**只碰数值项**：model 不动（用户自己选的 API 与模型不该被默认值覆盖，
    // 这是本分支既有行为，与下面的出厂兜底分支不同）；worldBook / systemPrompt /
    // template 上面已按 story 分支各自处理过，重写一遍会把刚 delete 掉的 template 键
    // 又补成空串。
    patchAgentSettings(s, agentId, {
      temperature: pd.temperature ?? AGENT_SETTINGS_DEFAULTS.temperature,
      topP: pd.topP ?? AGENT_SETTINGS_DEFAULTS.topP,
      freqPen: pd.freqPen ?? AGENT_SETTINGS_DEFAULTS.freqPen,
      presPen: pd.presPen ?? AGENT_SETTINGS_DEFAULTS.presPen,
      maxTokens: pd.maxTokens ?? AGENT_SETTINGS_DEFAULTS.maxTokens,
      historyLayers: pd.historyLayers,
      historySlice: pd.historySlice,
    });
    s.agentPromptEdited = false;
    s.agentDirty[agentId] = false;
    ui.toast('已恢复项目默认设置', 'info');
    return;
  }

  // 无项目默认 → 恢复出厂（不传来源即全部落 AGENT_SETTINGS_DEFAULTS）。
  // 与上面的分支此前是两段只差取值来源的手抄，各写一遍 `?? 0.7 / ?? 16384`。
  resetAgentSettings(s, agentId);
  s.activePresetId = '';
  agentPromptDraft.value = '';
  agentTemplateDraft.value = '';
  s.agentPromptEdited = false;
  s.agentDirty[agentId] = false;
  ui.toast('已恢复默认设置', 'info');
}

function toggleAgentWorldBook(agentId: string | null, bookId: string) {
  if (!agentId) return;
  const ids = s.agentWorldbookIds[agentId] || [];
  const idx = ids.indexOf(bookId);
  if (idx >= 0) {
    ids.splice(idx, 1);
  } else {
    ids.push(bookId);
  }
  s.agentWorldbookIds[agentId] = [...ids];
  s.agentDirty[agentId] = true;
}
</script>

<template>
  <div class="settings-page">
    <!-- 顶部栏 -->
    <div class="settings-header">
      <AppButton variant="ghost" size="sm" @click="ui.navigate(ui.activeSaveId ? 'game' : 'home')"
        >← 返回</AppButton
      >
      <h2 class="settings-title">系统设置</h2>
      <div class="header-spacer" />
    </div>

    <div class="settings-body">
      <!-- ====== 左侧主导航 ====== -->
      <nav class="main-nav">
        <button
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ 'nav-active': activeSection === item.key }"
          @click="
            activeSection = item.key;
            activeAgent = null;
          "
        >
          <span class="nav-icon"><i :class="item.icon" aria-hidden="true"></i></span>
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>

      <!-- ====== Agent 子导航（仅当选中 Agent 配置时显示）====== -->
      <nav v-if="activeSection === 'agent'" class="sub-nav">
        <button
          v-for="ag in agentList"
          :key="ag.id"
          class="sub-nav-item"
          :class="{ 'sub-nav-active': activeAgent === ag.id }"
          @click="selectAgent(ag.id)"
        >
          <span class="sub-nav-name">{{ ag.name }}</span>
          <!-- 未配置 API 标红 -->
          <span v-if="!hasApi" class="sub-nav-badge sub-nav-bad">!</span>
          <span v-else-if="!s.agentModels[ag.id]" class="sub-nav-badge sub-nav-bad">&#10005;</span>
          <span v-else class="sub-nav-badge sub-nav-ok">&#10003;</span>
        </button>
      </nav>

      <!-- ====== 右侧内容（居中）====== -->
      <div class="settings-content" :class="{ 'content-with-subnav': activeSection === 'agent' }">
        <Transition name="section-fade" mode="out-in">
          <div :key="activeSection" class="section-wrapper">
            <!-- ========== API 池 ========== -->
            <ApiSection v-if="activeSection === 'api'" />

            <!-- ========== Agent 详情 ========== -->
            <section v-if="activeSection === 'agent' && activeAgent" class="section centered">
              <div class="agent-detail-head">
                <h3>{{ agentList.find((a) => a.id === activeAgent)?.name }}</h3>
                <span class="text-sm text-muted">{{
                  agentList.find((a) => a.id === activeAgent)?.desc
                }}</span>
              </div>

              <!-- 模型选择 — 从 API 池中选择 -->
              <AppCard padding="md" class="detail-card">
                <h4>API 池选择</h4>
                <p class="form-hint">
                  为此 Agent 指定一个已配置好的 API 池（含端点地址、密钥和默认模型）。
                </p>
                <div class="key-row">
                  <select
                    class="form-input"
                    :value="s.agentModels[activeAgent] || ''"
                    @change="
                      s.agentModels[activeAgent] = ($event.target as HTMLSelectElement).value;
                      s.agentDirty[activeAgent] = true;
                    "
                  >
                    <option value="">— 请选择 API 池 —</option>
                    <option v-for="ep in s.apiPool" :key="ep.id" :value="ep.id">
                      {{ ep.name }} — {{ ep.model || '未选择模型' }}
                    </option>
                  </select>
                  <span v-if="!s.agentModels[activeAgent] && !hasApi" class="api-warn"
                    >请先配置 API</span
                  >
                  <span v-else-if="!s.agentModels[activeAgent]" class="api-warn">未选择</span>
                  <span v-else class="api-ok">✓</span>
                </div>
              </AppCard>

              <!-- LLM 参数 (所有 Agent 通用) -->
              <AppCard padding="md" class="detail-card">
                <h4>LLM 参数</h4>
                <p class="form-hint">控制此 Agent 的采样行为和生成长度。所有参数均有合理默认值。</p>
                <div
                  class="form-grid"
                  style="grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px"
                >
                  <label class="form-label"
                    >Temperature
                    <p class="form-hint">越高越随机 (0-2)</p>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      :value="s.agentTemperature[activeAgent] ?? 0.7"
                      class="form-input"
                      @input="
                        s.agentTemperature[activeAgent] = Number(
                          ($event.target as HTMLInputElement).value,
                        );
                        s.agentDirty[activeAgent] = true;
                      "
                    />
                  </label>
                  <label class="form-label"
                    >Top P
                    <p class="form-hint">核采样阈值 (0-1)</p>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      :value="s.agentTopP[activeAgent] ?? 1.0"
                      class="form-input"
                      @input="
                        s.agentTopP[activeAgent] = Number(
                          ($event.target as HTMLInputElement).value,
                        );
                        s.agentDirty[activeAgent] = true;
                      "
                    />
                  </label>
                  <label class="form-label"
                    >Frequency Penalty
                    <p class="form-hint">抑制重复 (-2 ~ 2)</p>
                    <input
                      type="number"
                      step="0.1"
                      min="-2"
                      max="2"
                      :value="s.agentFreqPen[activeAgent] ?? 0"
                      class="form-input"
                      @input="
                        s.agentFreqPen[activeAgent] = Number(
                          ($event.target as HTMLInputElement).value,
                        );
                        s.agentDirty[activeAgent] = true;
                      "
                    />
                  </label>
                  <label class="form-label"
                    >Presence Penalty
                    <p class="form-hint">鼓励新话题 (-2 ~ 2)</p>
                    <input
                      type="number"
                      step="0.1"
                      min="-2"
                      max="2"
                      :value="s.agentPresPen[activeAgent] ?? 0"
                      class="form-input"
                      @input="
                        s.agentPresPen[activeAgent] = Number(
                          ($event.target as HTMLInputElement).value,
                        );
                        s.agentDirty[activeAgent] = true;
                      "
                    />
                  </label>
                  <label class="form-label"
                    >Max Tokens
                    <p class="form-hint">单次回复最大长度</p>
                    <input
                      type="number"
                      min="100"
                      max="32768"
                      step="100"
                      :value="s.agentMaxTokens[activeAgent] ?? 16384"
                      class="form-input"
                      @input="
                        s.agentMaxTokens[activeAgent] = Number(
                          ($event.target as HTMLInputElement).value,
                        );
                        s.agentDirty[activeAgent] = true;
                      "
                    />
                  </label>
                  <label class="form-label"
                    >历史注入层数
                    <p class="form-hint">
                      注入最近 N 轮「玩家+AI」对话历史（0=不注入；留空=按 Agent 类别默认）。后置型
                      Agent 默认 1 轮辅助上文，长正文型默认 6 轮
                    </p>
                    <input
                      type="number"
                      min="0"
                      max="20"
                      step="1"
                      :value="s.agentHistoryLayers[activeAgent] ?? ''"
                      placeholder="(默认)"
                      class="form-input"
                      @input="onHistoryLayersInput($event)"
                    />
                  </label>
                  <label class="form-label"
                    >历史截断字数
                    <p class="form-hint">
                      每条历史正文保留前多少字（留空=按 Agent 类别默认，长正文型默认
                      1500，后置型默认 800）
                    </p>
                    <input
                      type="number"
                      min="100"
                      max="8000"
                      step="100"
                      :value="s.agentHistorySlice[activeAgent] ?? ''"
                      placeholder="(默认)"
                      class="form-input"
                      @input="onHistorySliceInput($event)"
                    />
                  </label>
                </div>
              </AppCard>

              <!-- 世界书配置 (Phase 8) -->
              <AppCard padding="md" class="detail-card">
                <h4>世界书配置</h4>
                <p class="form-hint">启用该 Agent 的世界书上下文注入。选择要关联的世界书。</p>
                <div class="key-row" style="margin-bottom: 8px">
                  <label class="toggle-label">
                    <span class="text-sm text-secondary">启用世界书</span>
                    <input
                      type="checkbox"
                      class="toggle-input"
                      :checked="s.agentWorldbookEnabled[activeAgent] || false"
                      @change="
                        s.agentWorldbookEnabled[activeAgent] = (
                          $event.target as HTMLInputElement
                        ).checked;
                        s.agentDirty[activeAgent] = true;
                      "
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>
                <div class="worldbook-select-list">
                  <template v-if="wb.books.length === 0">
                    <p class="text-muted text-sm" style="padding: 20px; text-align: center">
                      暂未导入世界书。请先在「世界书」导航中导入。
                    </p>
                  </template>
                  <label v-for="book in wb.books" :key="book.id" class="worldbook-checkbox">
                    <input
                      type="checkbox"
                      :checked="(s.agentWorldbookIds[activeAgent] || []).includes(book.id)"
                      :aria-label="`关联世界书: ${book.name}`"
                      @change="toggleAgentWorldBook(activeAgent, book.id)"
                    />
                    <i
                      class="fa-solid fa-book"
                      aria-hidden="true"
                      style="font-size: 13px; opacity: 0.5"
                    ></i>
                    <span class="wb-check-label">{{ book.name }}</span>
                    <span class="text-xs text-muted">{{ book.entries?.length || 0 }} 条目</span>
                  </label>
                </div>
              </AppCard>

              <!-- 预设系统（正文 Agent 专用）— 仿酒馆 ST 左侧面板布局 -->
              <AppCard v-if="activeAgent === 'story'" padding="md" class="detail-card">
                <h4>预设管理（酒馆 ST 兼容）</h4>
                <p class="form-hint">
                  仿 SillyTavern AI Response Configuration 面板布局。支持导入 SillyTavern 预设
                  JSON。
                </p>

                <!-- 预设选择器栏 -->
                <div class="preset-selector-bar">
                  <select
                    class="form-input preset-select"
                    :value="s.activePresetId"
                    @change="selectPreset(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">— 选择预设 —</option>
                    <option v-for="p in s.presets" :key="p.id" :value="p.id">{{ p.name }}</option>
                  </select>
                  <AppButton variant="ghost" size="sm" @click="importStPreset">导入</AppButton>
                  <AppButton variant="primary" size="sm" @click="openNewPreset">+ 新建</AppButton>
                </div>

                <!-- 选中预设的完整预览卡片 — 仿 ST 面板布局 -->
                <div v-if="activePreset" class="preset-viewer">
                  <div class="preset-viewer-header">
                    <div class="preset-viewer-title">
                      <h5>{{ activePreset.name }}</h5>
                      <span v-if="activePreset.description" class="text-xs text-muted">{{
                        activePreset.description
                      }}</span>
                    </div>
                    <div class="preset-viewer-actions">
                      <AppButton
                        variant="ghost"
                        size="sm"
                        @click="exportPresetDynamic(activePreset!)"
                        >导出</AppButton
                      >
                      <AppButton variant="ghost" size="sm" @click="deletePreset(s.activePresetId)"
                        >删除</AppButton
                      >
                    </div>
                  </div>

                  <!-- 条目列表（子提示词） -->
                  <div class="preset-prompts-list">
                    <h4 class="text-sm text-muted" style="margin: 0 0 8px; padding: 0 16px">
                      条目列表（{{ activePreset.settings?.prompts?.length || 0 }} 个）
                    </h4>
                    <div
                      v-for="(sp, idx) in activePreset.settings?.prompts || []"
                      :key="sp.identifier || idx"
                      class="subprompt-item"
                      :class="{ 'subprompt-disabled': sp.enabled === false }"
                    >
                      <div
                        class="subprompt-header"
                        @click="toggleEntry(s.activePresetId, Number(idx))"
                      >
                        <div class="subprompt-info">
                          <label
                            class="subprompt-toggle"
                            @click.stop.prevent="
                              togglePresetEntryEnabled(s.activePresetId, Number(idx))
                            "
                          >
                            <input
                              type="checkbox"
                              :checked="sp.enabled !== false"
                              class="toggle-input"
                            />
                            <span class="toggle-slider toggle-sm"></span>
                          </label>
                          <span class="subprompt-name">{{
                            sp.name || `条目 #${Number(idx) + 1}`
                          }}</span>
                          <span class="subprompt-role text-xs text-muted">{{
                            sp.role || 'system'
                          }}</span>
                        </div>
                        <div class="subprompt-meta">
                          <button
                            class="subprompt-edit-btn"
                            title="编辑此条目"
                            @click.stop="openEntryEditor(s.activePresetId, Number(idx))"
                          >
                            ✎
                          </button>
                          <span class="subprompt-chars text-xs text-muted"
                            >{{ (sp.content || '').length }} 字</span
                          >
                          <span
                            class="subprompt-chevron"
                            :class="{
                              'chevron-open': expandedEntries.has(`${s.activePresetId}:${idx}`),
                            }"
                            >▸</span
                          >
                        </div>
                      </div>
                      <div
                        v-if="expandedEntries.has(`${s.activePresetId}:${idx}`)"
                        class="subprompt-content"
                      >
                        {{ (sp.content || '(空)').slice(0, 300)
                        }}{{ (sp.content || '').length > 300 ? '...' : '' }}
                      </div>
                    </div>
                    <p
                      v-if="!activePreset.settings?.prompts?.length"
                      class="text-muted text-sm"
                      style="padding: 12px 16px"
                    >
                      此预设没有条目
                    </p>
                  </div>
                </div>

                <!-- 未选择预设 -->
                <div v-else class="preset-empty">
                  <p class="text-muted">选择一个预设或新建/导入预设来配置正文 Agent</p>
                </div>

                <!-- Phase 10e: Story Agent template preview -->
                <div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap">
                  <AppButton
                    variant="ghost"
                    size="sm"
                    @click="showStoryPreview = !showStoryPreview"
                  >
                    {{ showStoryPreview ? '收起模板预览' : '模板预览' }}
                  </AppButton>
                  <AppButton
                    variant="ghost"
                    size="sm"
                    @click="showStoryResolvedPreview = !showStoryResolvedPreview"
                  >
                    {{ showStoryResolvedPreview ? '收起解析预览' : '解析预览' }}
                  </AppButton>
                </div>

                <div
                  v-if="showStoryPreview"
                  class="template-preview-panel"
                  style="
                    margin-top: 10px;
                    padding: 12px;
                    background: var(--color-surface);
                    border-radius: 8px;
                    border: 1px solid var(--color-border);
                  "
                >
                  <p class="form-hint">
                    以下为运行时
                    <code>动态注入</code> 条目或默认上下文块的内容。占位符最终会被替换。
                  </p>
                  <TemplatePreview :template="getStoryContextTemplate()" agent-id="story" />
                </div>

                <div
                  v-if="showStoryResolvedPreview"
                  class="template-preview-panel"
                  style="
                    margin-top: 10px;
                    padding: 12px;
                    background: var(--color-surface);
                    border-radius: 8px;
                    border: 1px solid var(--color-border);
                  "
                >
                  <p class="form-hint">
                    以下为预设完整内容：<code>setvar/getvar</code> 已展开为实际值，<code
                      >random/char/user</code
                    >
                    及系统占位符保留为彩色 badge。
                  </p>
                  <TemplatePreview :template="resolvedPresetTemplate" agent-id="story" />
                </div>
              </AppCard>

              <AppCard v-else padding="md" class="detail-card">
                <!-- Section 1: System Prompt -->
                <h4>System Prompt</h4>
                <p class="form-hint">
                  核心指令——正文 AI 的人格、叙事准则、输出格式等。"System Prompt" 里请不要写占位符。
                </p>
                <textarea
                  v-model="agentPromptDraft"
                  class="form-textarea prompt-editor"
                  rows="10"
                  placeholder="编写核心指令，如叙事准则、输出格式、示例等..."
                  @input="s.agentPromptEdited = true"
                />

                <hr style="margin: 18px 0; border-color: var(--theme-card-border)" />

                <!-- Section 2: Context Template -->
                <h4>上下文模板</h4>
                <p class="form-hint">
                  使用
                  <code v-pre>{{ PLACEHOLDER }}</code>
                  占位符管理上下文注入。占位符运行时会被替换为实际内容。
                </p>
                <textarea
                  v-model="agentTemplateDraft"
                  class="form-textarea prompt-editor"
                  rows="8"
                  placeholder="输入模板，使用 {{NARRATIVE}} 等占位符..."
                  @input="s.agentPromptEdited = true"
                />

                <!-- Placeholder badges -->
                <div class="placeholder-badges" style="margin-top: 10px">
                  <span class="text-xs text-muted">可用占位符 (点击插入):</span>
                  <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px">
                    <span
                      v-for="ph in availablePlaceholders"
                      :key="ph.key"
                      class="placeholder-badge"
                      :style="{
                        background: ph.color + '22',
                        color: ph.color,
                        border: '1px solid ' + ph.color + '44',
                      }"
                      :title="ph.desc"
                      @click="insertPlaceholder(ph.key)"
                      >{{ phLabel(ph.key) }}</span
                    >
                  </div>
                </div>

                <!-- Section 3: Template Preview -->
                <div style="margin-top: 12px">
                  <AppButton
                    variant="ghost"
                    size="sm"
                    @click="showTemplatePreview = !showTemplatePreview"
                  >
                    {{ showTemplatePreview ? '收起预览' : '模板预览' }}
                  </AppButton>
                </div>
                <div
                  v-if="showTemplatePreview"
                  class="template-preview-panel"
                  style="
                    margin-top: 10px;
                    padding: 12px;
                    background: var(--color-surface);
                    border-radius: 8px;
                    border: 1px solid var(--color-border);
                  "
                >
                  <TemplatePreview
                    :template="agentTemplateDraft || getDefaultTemplateForAgent(activeAgent)"
                    :agent-id="activeAgent || undefined"
                  />
                </div>
              </AppCard>

              <!-- 操作按钮 -->
              <div class="detail-actions">
                <AppButton variant="ghost" size="sm" @click="saveAsDefault">保存为默认</AppButton>
                <AppButton variant="ghost" size="sm" @click="restoreAgentDefaults"
                  >恢复默认</AppButton
                >
                <AppButton variant="primary" size="sm" @click="saveAgentSettings"
                  >保存设置</AppButton
                >
              </div>
            </section>

            <!-- Agent 未选择时的提示 -->
            <section v-if="activeSection === 'agent' && !activeAgent" class="section centered">
              <div style="text-align: center; padding: 60px 0">
                <p class="text-muted" style="font-size: 1.1rem">← 请从左侧选择一个 Agent</p>
                <p class="text-sm text-muted" style="margin-top: 8px">
                  每个 Agent 需要单独配置模型和世界书上下文
                </p>
              </div>
            </section>

            <!-- ========== 世界书 (Phase 8) ========== -->
            <WorldBookSection v-if="activeSection === 'worldbook'" />

            <!-- ========== 剧情系统 ========== -->
            <PlotSection v-if="activeSection === 'plot'" />

            <!-- ========== 记忆 & 缓存 ========== -->
            <MemorySection v-if="activeSection === 'memory'" />

            <!-- ========== 外观主题 ========== -->
            <ThemeSection v-if="activeSection === 'theme'" />

            <!-- ========== 消息显示 ========== -->
            <MessagesSection v-if="activeSection === 'messages'" />

            <!-- ========== 输出美化 ========== -->
            <BeautifierSection v-if="activeSection === 'beautifier'" />

            <!-- ========== 音频 ========== -->
            <AudioSection v-if="activeSection === 'audio'" />

            <!-- ========== 素材 ========== -->
            <AssetSection v-if="activeSection === 'asset'" />

            <!-- ========== 存档数据 ========== -->
            <DataSection v-if="activeSection === 'data'" />

            <!-- ========== 关于 ========== -->
            <AboutSection v-if="activeSection === 'about'" />
          </div>
          <!-- /section-wrapper -->
        </Transition>
      </div>
    </div>

    <!-- 条目编辑弹窗 -->
    <AppModal
      :open="showEntryEditor"
      title="编辑条目"
      size="md"
      @update:open="showEntryEditor = $event"
    >
      <div class="api-form">
        <label class="form-label"
          >条目名称<input
            v-model="entryEditForm.name"
            class="form-input"
            placeholder="如: ROLE主提示"
        /></label>
        <div class="key-row">
          <label class="form-label" style="flex: 1"
            >角色
            <select v-model="entryEditForm.role" class="form-input">
              <option value="system">system</option>
              <option value="user">user</option>
              <option value="assistant">assistant</option>
            </select>
          </label>
          <label
            class="form-label toggle-label"
            style="flex-direction: row; align-items: center; gap: 8px"
          >
            <span>启用</span>
            <input v-model="entryEditForm.enabled" type="checkbox" class="toggle-input" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <label class="form-label">
          内容
          <textarea
            v-model="entryEditForm.content"
            class="form-textarea prompt-editor"
            rows="14"
            placeholder="条目提示词内容..."
          />
        </label>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="showEntryEditor = false">取消</AppButton>
        <AppButton variant="primary" size="sm" @click="saveEntry">保存条目</AppButton>
      </template>
    </AppModal>

    <!-- 预设编辑弹窗 -->
    <AppModal
      :open="showPresetEditor"
      :title="editingPresetId ? '编辑预设' : '新建预设'"
      size="md"
      @update:open="showPresetEditor = $event"
    >
      <div class="api-form">
        <label class="form-label"
          >预设名称<input
            v-model="presetForm.name"
            class="form-input"
            placeholder="如: 默认叙事风格"
        /></label>
        <label class="form-label"
          >描述<input
            v-model="presetForm.description"
            class="form-input"
            placeholder="简短描述此预设的风格"
        /></label>
        <label class="form-label">
          System Prompt（主提示词）
          <p class="form-hint">这是正文 AI 的核心人格和叙事指导</p>
          <textarea
            v-model="presetForm.mainPrompt"
            class="form-textarea prompt-editor"
            rows="8"
            placeholder="Write {{char}}'s next reply in a fictional chat..."
          />
        </label>
        <div class="form-grid">
          <label class="form-label"
            >Temperature<input
              v-model="presetForm.temperature"
              type="number"
              step="0.1"
              min="0"
              max="2"
              class="form-input"
            />
            <p class="form-hint">越高越随机，越低越稳定</p></label
          >
          <label class="form-label"
            >Max Tokens<input
              v-model="presetForm.maxTokens"
              type="number"
              min="100"
              max="32768"
              class="form-input"
            />
            <p class="form-hint">单次回复最大长度</p></label
          >
          <label class="form-label"
            >Top P<input
              v-model="presetForm.topP"
              type="number"
              step="0.1"
              min="0"
              max="1"
              class="form-input"
          /></label>
          <label class="form-label"
            >Frequency Penalty<input
              v-model="presetForm.freqPen"
              type="number"
              step="0.1"
              min="-2"
              max="2"
              class="form-input"
          /></label>
          <label class="form-label"
            >Presence Penalty<input
              v-model="presetForm.presPen"
              type="number"
              step="0.1"
              min="-2"
              max="2"
              class="form-input"
          /></label>
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="showPresetEditor = false">取消</AppButton>
        <AppButton variant="primary" size="sm" @click="savePreset">{{
          editingPresetId ? '保存修改' : '创建预设'
        }}</AppButton>
      </template>
    </AppModal>

    <!-- 添加/编辑 API 弹窗 -->
  </div>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--theme-window-bg);
}
.settings-header {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
  gap: 16px;
  flex-shrink: 0;
}
.settings-title {
  font-family: var(--theme-font-title);
  font-size: 1.1rem;
  color: var(--theme-text-primary);
  margin: 0;
}
.header-spacer {
  flex: 1;
}
.settings-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
/* 主导航 */
.main-nav {
  width: 180px;
  flex-shrink: 0;
  background: var(--theme-title-bar-bg);
  border-right: 1px solid var(--theme-card-border);
  padding: 12px 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-md);
  background: transparent;
  color: var(--theme-tab-text);
  font-family: inherit;
  font-size: 0.88rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
  text-align: left;
}
.nav-item:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.nav-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  color: var(--theme-text-primary);
  font-weight: 600;
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.nav-icon {
  font-size: 1rem;
  line-height: 1;
  flex-shrink: 0;
  width: 24px;
  text-align: center;
  opacity: 0.7;
  display: flex;
  align-items: center;
  justify-content: center;
}
.nav-icon i {
  font-size: 1rem;
}
.nav-active .nav-icon {
  opacity: 1;
  color: var(--theme-primary);
}
.nav-label {
  flex: 1;
}
/* Agent 子导航 */
.sub-nav {
  width: 170px;
  flex-shrink: 0;
  background: var(--theme-content-bg);
  border-right: 1px solid var(--theme-card-border);
  padding: 10px 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sub-nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border: none;
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-tab-text);
  font-family: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all var(--theme-transition-fast);
  text-align: left;
}
.sub-nav-item:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.sub-nav-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  color: var(--theme-primary);
  font-weight: 600;
}
.sub-nav-name {
  flex: 1;
}
.sub-nav-badge {
  font-size: 0.65rem;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.sub-nav-bad {
  background: color-mix(in srgb, var(--theme-error) 15%, var(--theme-card-bg));
  color: var(--theme-error);
  border: 1px solid color-mix(in srgb, var(--theme-error) 40%, var(--theme-card-border));
}
.sub-nav-ok {
  background: color-mix(in srgb, var(--theme-success) 15%, var(--theme-card-bg));
  color: var(--theme-success);
  border: 1px solid color-mix(in srgb, var(--theme-success) 40%, var(--theme-card-border));
}
/* 内容区 */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 32px 40px;
}
.content-with-subnav {
  padding: 32px 32px;
}
.section-wrapper {
  width: 100%;
}
/* 分区切换动画 */
.section-fade-enter-active,
.section-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.section-fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.section-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
/* 居中 */
.centered {
  max-width: 780px;
  margin: 0 auto;
}
/* Agent */
.agent-detail-head {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--theme-card-border);
}
.agent-detail-head h3 {
  font-family: var(--theme-font-title);
  font-size: 1.3rem;
  margin: 0 0 6px;
}
.detail-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--theme-card-border);
}
.prompt-editor {
  font-family: 'Monaco', 'Menlo', 'Cascadia Code', monospace;
  font-size: 0.8rem;
  line-height: 1.6;
  min-height: 200px;
  width: 100%;
  padding: 14px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, #000 6%, var(--theme-content-bg));
  color: var(--theme-text-primary);
  resize: vertical;
  tab-size: 2;
}
.prompt-editor:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 12%, transparent);
}
/* Preset 预设系统 — 仿 ST 面板 */
.preset-selector-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}
.preset-select {
  flex: 1;
}
.preset-viewer {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  overflow: hidden;
}
.preset-viewer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--theme-surface-muted);
  gap: 12px;
}
.preset-viewer-title h5 {
  margin: 0 0 2px;
  font-size: 1rem;
}
.preset-viewer-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
/* 子 Prompt 列表 */
.preset-prompts-list {
  display: flex;
  flex-direction: column;
}
.subprompt-item {
  padding: 8px 16px;
  border-bottom: 1px solid var(--theme-card-border);
  transition: background var(--theme-transition-fast);
}
.subprompt-item:last-child {
  border-bottom: none;
}
.subprompt-disabled {
  opacity: 0.45;
}
.subprompt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.subprompt-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.subprompt-toggle {
  display: flex;
  align-items: center;
  cursor: default;
}
.subprompt-name {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subprompt-role {
  font-size: 0.65rem;
  opacity: 0.7;
  flex-shrink: 0;
  text-transform: uppercase;
}
.subprompt-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.subprompt-chars {
  flex-shrink: 0;
}
.subprompt-chevron {
  font-size: 0.7rem;
  color: var(--theme-text-muted);
  transition: transform var(--theme-transition-fast);
  user-select: none;
}
.chevron-open {
  transform: rotate(90deg);
}
.subprompt-edit-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  color: var(--theme-text-muted);
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.subprompt-edit-btn:hover {
  color: var(--theme-primary);
  background: var(--theme-tab-hover-bg);
}
.subprompt-content {
  padding: 6px 8px 6px 44px;
  font-family: monospace;
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
  white-space: pre-wrap;
  max-height: 80px;
  overflow-y: auto;
  line-height: 1.4;
  background: var(--theme-content-bg);
  border-radius: var(--theme-radius-sm);
  margin-top: 4px;
}
.toggle-sm {
  width: 28px;
  height: 16px;
  border-radius: 8px;
}
.toggle-sm::after {
  width: 12px;
  height: 12px;
}
.preset-empty {
  padding: 24px;
  text-align: center;
}
.worldbook-select-list {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  min-height: 60px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.worldbook-checkbox {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  min-height: 44px;
  transition: background 0.15s;
}
.worldbook-checkbox:hover {
  background: var(--theme-tab-hover-bg);
}
.worldbook-checkbox input[type='checkbox'] {
  width: 18px;
  height: 18px;
  cursor: pointer;
  margin: 0;
  accent-color: var(--theme-primary);
}
.wb-check-label {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
}
/* 减少动态效果（design.md 检查清单）。
   `.storage-bar-fill` 那条随 DataSection 走了 —— 分区抽走了，规则不跟着走就是死规则。 */
@media (prefers-reduced-motion: reduce) {
  .section-fade-enter-active,
  .section-fade-leave-active {
    transition: none;
  }
  .template-preview-panel {
    animation: none;
  }
}
/* Phase 10e: Placeholder badges */
.placeholder-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: var(--theme-radius-full, 999px);
  font-family: 'Monaco', 'Menlo', 'Cascadia Code', monospace;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  transition: all var(--theme-transition-fast);
  white-space: nowrap;
}
.placeholder-badge:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
}
/* Phase 10e: Template preview panel */
.template-preview-panel {
  animation: template-preview-in 0.2s ease;
}
@keyframes template-preview-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
