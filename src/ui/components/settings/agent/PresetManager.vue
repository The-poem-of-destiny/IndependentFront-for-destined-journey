<script setup lang="ts">
/**
 * 预设管理（正文 Agent 专用，Q-25 第 9 步）。
 *
 * 仿 SillyTavern 的预设面板：选择器 / 采样器参数 / 子提示词条目列表，
 * 外加两个弹窗（条目编辑、预设编辑）。整块只在 `agentId === 'story'` 时渲染 ——
 * 其它 Agent 没有预设这回事，它们走 AgentPromptCard 的 systemPrompt + 模板。
 *
 * 🔴 **单根**：两个 AppModal 放在根 AppCard **内层**。多根 fragment 会让 Vue
 *    既不做属性透传、也不把父组件的 scope id 盖上来。AppModal 自己
 *    `<Teleport to="body">`，所以嵌进来不改变它实际渲染的位置。
 *
 * 🔴 `loadPresets()` 改在**本组件挂载时**跑（原先是 `watch(activeSection)`，
 *    进 Agent 分区就跑，与选中哪个 Agent 无关）。它的副作用「没选预设就自动选上
 *    项目默认的那个」不会因此丢失 —— settings-store 的 `loadAgentProjectDefaults`
 *    在 store 构造期已经做过同一件事（`if (!settings.value.activePresetId) ...`）。
 *
 * 🔴 **preset 级编辑今天点不到**：`openEditPreset` 没有任何按钮调它，于是
 *    `editingPresetId` 恒为 null，连带 `savePreset` 的整条编辑分支、createdAt
 *    保留三元、以及「预设已更新」那条 toast 都是**跟着它一起死的一组**。
 *    这几处要么一起留、要么一起删；单独删掉其中一个会把另一半变成看不懂的残骸。
 *    （可点的是**条目**级编辑 —— ✎ 按钮走的是 `openEntryEditor`，那条是活的。）
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import AppModal from '../../shared/AppModal.vue';
import TemplatePreview from '../TemplatePreview.vue';
import { useSettingsStore, type PresetItem } from '../../../stores/settings-store';
import { useUIStore } from '../../../stores/ui-store';
import { preprocessPresetForPreview } from '@engine/preset-loader';

const props = defineProps<{ agentId: string }>();

const cfg = useSettingsStore();
const s = cfg.settings;
const ui = useUIStore();

const showStoryPreview = ref(false);
const showStoryResolvedPreview = ref(false);

// Phase 10h: 预设解析预览 — setvar/getvar 展开，系统占位符/random/char/user 保留
const resolvedPresetTemplate = computed(() => {
  const preset = activePreset.value;
  if (!preset) return '';
  return preprocessPresetForPreview(preset as any);
});

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
/**
 * 当前选中的预设。
 *
 * 🔴 AgentConfigPanel 的 `saveAsDefault` 也要它，那边**各算一次**而不是穿成 prop ——
 *    它是对 store 的一行派生（与 `hasApi` 同类），穿 prop 只是为了少一次 store 读取，
 *    却换来一条真正的组件间契约。
 */
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
    if (!s.activePresetId && s.presets.length > 0) {
      const pd = cfg.projectAgentDefaults?.agents?.story;
      if (pd?.presetId && s.presets.find((p) => p.id === pd.presetId)) {
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
    // 🔴 这里原本还有两行：`agentPromptDraft.value = ...` 与 `s.agentPromptEdited = true`。
    //    经查是**惰性**的：草稿绑的两个 textarea 只在非 story 分支渲染，而本组件只在
    //    story 分支存在；`saveAgentSettings` 与 `saveAsDefault` 对 story 都跳过草稿。
    //    它同时是本区域唯一一处跨组件写（草稿归 AgentConfigPanel），删掉之后这条边界干净。
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

onMounted(() => {
  void loadPresets();
});

// props 在模板里通过 agentId 使用；这里显式引一次避免 lint 误判
void props;
void watch;
void reactive;
</script>

<template>
  <!-- 预设系统（正文 Agent 专用）— 仿酒馆 ST 左侧面板布局 -->
  <AppCard v-if="agentId === 'story'" padding="md" class="detail-card">
    <h4>预设管理（酒馆 ST 兼容）</h4>
    <p class="form-hint">
      仿 SillyTavern AI Response Configuration 面板布局。支持导入 SillyTavern 预设 JSON。
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
          <AppButton variant="ghost" size="sm" @click="exportPresetDynamic(activePreset!)"
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
          <div class="subprompt-header" @click="toggleEntry(s.activePresetId, Number(idx))">
            <div class="subprompt-info">
              <label
                class="subprompt-toggle"
                @click.stop.prevent="togglePresetEntryEnabled(s.activePresetId, Number(idx))"
              >
                <input type="checkbox" :checked="sp.enabled !== false" class="toggle-input" />
                <span class="toggle-slider toggle-sm"></span>
              </label>
              <span class="subprompt-name">{{ sp.name || `条目 #${Number(idx) + 1}` }}</span>
              <span class="subprompt-role text-xs text-muted">{{ sp.role || 'system' }}</span>
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
          <div v-if="expandedEntries.has(`${s.activePresetId}:${idx}`)" class="subprompt-content">
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
      <AppButton variant="ghost" size="sm" @click="showStoryPreview = !showStoryPreview">
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
        以下为预设完整内容：<code>setvar/getvar</code> 已展开为实际值，<code>random/char/user</code>
        及系统占位符保留为彩色 badge。
      </p>
      <TemplatePreview :template="resolvedPresetTemplate" agent-id="story" />
    </div>

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
  </AppCard>
</template>

<!-- 🔴 顺序不可颠倒：共用外壳必须在自有块**之前**。`.toggle-sm` 与 chrome 里的
     `.toggle-slider` 特异性相同（0,1,0），全靠这个顺序才赢 —— 反过来写，
     预设条目的小开关会悄悄变回 40x22。 -->
<style scoped src="../settings-chrome.css"></style>
<style scoped src="./agent-chrome.css"></style>

<style scoped>
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
</style>
