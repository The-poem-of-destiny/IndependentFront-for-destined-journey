<script setup lang="ts">
import { ref, computed } from 'vue';
import type { BeautifierRule } from '@engine/types';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import BeautifiedNarrative from '../game/BeautifiedNarrative.vue';

const props = defineProps<{ rule: BeautifierRule | null }>();
const emit = defineEmits<{
  save: [rule: BeautifierRule];
  cancel: [];
}>();

const isEditing = computed(() => props.rule !== null);

const form = ref({
  name: props.rule?.name ?? '',
  scope: (props.rule?.scope ?? 'maintext') as BeautifierRule['scope'],
  pattern: props.rule?.pattern ?? '',
  flags: props.rule?.flags ?? 'gm',
  replacement: props.rule?.replacement ?? '',
});

const testInput = ref('');
const testPlaceholder = computed(() => {
  if (form.value.scope === 'maintext') return '测试文本，如: [酒馆老板]("来一杯麦酒！")';
  return '输入测试文本...';
});

const previewRule = computed<BeautifierRule>(() => ({
  id: 'preview-rule',
  name: form.value.name || '预览规则',
  scope: form.value.scope,
  pattern: form.value.pattern,
  flags: form.value.flags,
  replacement: form.value.replacement,
  enabled: true,
  order: 0,
  isBuiltin: false,
}));

const previewState = computed<'empty' | 'invalid' | 'unmatched' | 'matched'>(() => {
  if (!testInput.value || !form.value.pattern) return 'empty';
  try {
    const re = new RegExp(form.value.pattern, form.value.flags);
    return re.test(testInput.value) ? 'matched' : 'unmatched';
  } catch {
    return 'invalid';
  }
});

function handleSave() {
  const rule: BeautifierRule = {
    ...(props.rule ?? {}),
    id: props.rule?.id ?? crypto.randomUUID(),
    name: form.value.name,
    scope: form.value.scope,
    pattern: form.value.pattern,
    flags: form.value.flags,
    replacement: form.value.replacement,
    enabled: props.rule?.enabled ?? true,
    order: props.rule?.order ?? 100,
    isBuiltin: false,
  };
  emit('save', rule);
}
</script>

<template>
  <AppModal
    :open="true"
    :title="isEditing ? '编辑规则' : '添加规则'"
    size="md"
    @update:open="$emit('cancel')"
  >
    <div class="api-form">
      <label class="form-label"
        >规则名称
        <input v-model="form.name" class="form-input" placeholder="如: 对话卡片" />
      </label>
      <label class="form-label"
        >作用域
        <select v-model="form.scope" class="form-input">
          <option value="maintext">正文 (maintext)</option>
          <option value="options">选项 (options)</option>
          <option value="summary">摘要 (summary)</option>
          <option value="thinking">思维链 (thinking)</option>
          <option value="global">全局 (global)</option>
        </select>
      </label>
      <label class="form-label"
        >正则表达式 (pattern)
        <textarea
          v-model="form.pattern"
          class="form-textarea"
          rows="3"
          placeholder='如: \[([^\]]+)\]\("([^"]*)"\)'
          style="font-family: monospace; font-size: 0.8rem"
        />
        <p class="form-hint">JavaScript 正则表达式，不需要前后的 /</p>
      </label>
      <label class="form-label"
        >标志位 (flags)
        <input v-model="form.flags" class="form-input" placeholder="如: gim" />
        <p class="form-hint">g=全局匹配, i=忽略大小写, m=多行, s=dotAll</p>
      </label>
      <label class="form-label"
        >替换为 (replacement) -- HTML
        <textarea
          v-model="form.replacement"
          class="form-textarea"
          rows="4"
          placeholder='如: &lt;span class="my-class"&gt;$1&lt;/span&gt;'
          style="font-family: monospace; font-size: 0.8rem"
        />
        <p class="form-hint">
          支持 $1, $2... 捕获组；HTML、CSS、脚本与远程资源在仅临时存储的隔离框中运行。联网内容可发送框内正文，但无法访问应用数据。
        </p>
      </label>

      <!-- Preview -->
      <label class="form-label"
        >预览
        <input v-model="testInput" class="form-input" :placeholder="testPlaceholder" />
        <p class="form-hint" style="margin-top: 2px">输入测试文本查看匹配效果</p>
      </label>
      <div v-if="previewState === 'matched'" class="preview-box">
        <BeautifiedNarrative :text="testInput" :rules="[previewRule]" force />
      </div>
      <div v-else-if="previewState === 'invalid'" class="preview-box preview-error">
        正则表达式有误
      </div>
      <div v-else-if="previewState === 'unmatched'" class="preview-box text-muted preview-empty">
        未匹配到任何内容
      </div>
    </div>
    <template #footer>
      <AppButton variant="ghost" size="sm" @click="$emit('cancel')">取消</AppButton>
      <AppButton variant="primary" size="sm" @click="handleSave">保存</AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.api-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--theme-text-secondary);
}
.form-input {
  padding: 8px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.9rem;
  transition:
    border-color var(--theme-transition-fast),
    box-shadow 0.15s;
  width: 100%;
}
.form-input:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 15%, transparent);
}
.form-textarea {
  resize: vertical;
  min-height: 50px;
}
.form-hint {
  font-size: 0.72rem;
  color: var(--theme-text-muted);
  margin: 0 0 4px;
  line-height: 1.4;
}
.preview-box {
  padding: 10px 14px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-content-bg);
  min-height: 36px;
  font-size: 0.85rem;
  line-height: 1.5;
  overflow-x: auto;
}
.preview-box code {
  font-size: 0.8rem;
}
.preview-error {
  color: var(--theme-error);
}
.preview-empty {
  font-style: italic;
}
.text-muted {
  color: var(--theme-text-muted);
}
</style>
