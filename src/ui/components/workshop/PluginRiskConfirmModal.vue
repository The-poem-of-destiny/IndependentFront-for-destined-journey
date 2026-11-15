<script setup lang="ts">
/**
 * 插件风险确认（设计 §3.4）—— 安装 / 更新与按存档启用两处共用。
 *
 * - 文案全部出自 `lib/plugin-risk-messages.ts`，模板里不写第二份句子。
 * - 危险样式；默认焦点在「取消」，回车不会误确认。
 * - 每个必需的确认项一个勾选框，**一个都不预勾**；全部勾上之前「确认」不可点。
 * - Esc / 点遮罩 / × 一律等同「取消」。
 * - 域名一律按文本插值渲染（不做链接、不进任何 URL 汇点）；更新新增的域名带「新增」字样
 *   高亮，不只靠颜色区分。
 *
 * 宿主用 `v-if` 控制显隐：挂载即打开。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';
import {
  buildPluginRiskContent,
  type PluginRiskManifest,
  type PluginRiskVariant,
} from '../../lib/plugin-risk-messages';

const props = withDefaults(
  defineProps<{
    variant: PluginRiskVariant;
    manifest: PluginRiskManifest;
    /** 更新时新增的联网域名；有值即视为更新 */
    networkAdded?: string[];
    /** 安装来源（§3.4）；只在完整版显示 */
    source?: 'local' | 'workshop';
    /** 包内文件数；只在完整版显示 */
    fileCount?: number;
    /** 包总体积（字节）；只在完整版显示 */
    totalBytes?: number;
  }>(),
  { networkAdded: undefined, source: undefined, fileCount: undefined, totalBytes: undefined },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const content = computed(() =>
  buildPluginRiskContent(props.variant, props.manifest, props.networkAdded, {
    source: props.source,
    fileCount: props.fileCount,
    totalBytes: props.totalBytes,
  }),
);

/** 勾选状态按确认项 id 记；内容变了（例如域名变化）就全部清空，重新确认 */
const checked = ref<Record<string, boolean>>({});
watch(
  () => content.value.checkboxes.map((c) => `${c.id}:${c.label}`).join('|'),
  () => {
    checked.value = {};
  },
);

const allChecked = computed(() => content.value.checkboxes.every((c) => checked.value[c.id]));

function setChecked(id: string, event: Event) {
  checked.value = { ...checked.value, [id]: (event.target as HTMLInputElement).checked };
}

function onConfirm() {
  if (!allChecked.value) return;
  emit('confirm');
}

const cancelBtn = ref<InstanceType<typeof AppButton> | null>(null);
// AppModal 挂载时会把焦点交给第一个控件（×），这里随后改交「取消」
onMounted(async () => {
  await nextTick();
  (cancelBtn.value?.$el as HTMLElement | undefined)?.focus();
});
</script>

<template>
  <AppModal :open="true" :title="content.title" size="md" @close="emit('cancel')">
    <div class="pr-body" data-danger="true">
      <dl class="pr-identity">
        <div v-for="row in content.identity" :key="row.label" class="pr-identity-row">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </div>
      </dl>

      <section class="pr-section">
        <h4 class="pr-heading">联网声明</h4>
        <p v-if="content.network.emptyText" class="pr-network-empty">
          {{ content.network.emptyText }}
        </p>
        <template v-else>
          <p v-if="content.network.addedNotice" class="pr-added-notice">
            {{ content.network.addedNotice }}
          </p>
          <ul class="pr-domains">
            <li
              v-for="d in content.network.domains"
              :key="d.host"
              class="pr-domain"
              :class="{ 'is-added': d.added }"
              :data-added="d.added ? 'true' : undefined"
            >
              <span class="pr-domain-host">{{ d.host }}</span>
              <span v-if="d.added" class="pr-domain-badge">新增</span>
            </li>
          </ul>
        </template>
      </section>

      <section class="pr-section">
        <h4 class="pr-heading">风险说明</h4>
        <ol class="pr-warnings">
          <li v-for="(w, i) in content.warnings" :key="i" class="pr-warning">{{ w }}</li>
        </ol>
      </section>

      <section v-if="content.capabilitySummary.length > 0" class="pr-section">
        <h4 class="pr-heading">声明的宿主能力</h4>
        <ul class="pr-caps">
          <li v-for="line in content.capabilitySummary" :key="line" class="pr-cap">{{ line }}</li>
        </ul>
      </section>

      <p v-if="content.disclaimer" class="pr-disclaimer">{{ content.disclaimer }}</p>

      <div class="pr-checks">
        <label v-for="c in content.checkboxes" :key="c.id" class="pr-check">
          <input
            type="checkbox"
            :data-check-id="c.id"
            :checked="!!checked[c.id]"
            @change="setChecked(c.id, $event)"
          />
          <span>{{ c.label }}</span>
        </label>
      </div>
    </div>

    <template #footer>
      <AppButton
        ref="cancelBtn"
        variant="secondary"
        data-risk-action="cancel"
        @click="emit('cancel')"
      >
        取消
      </AppButton>
      <AppButton
        variant="danger"
        data-risk-action="confirm"
        :disabled="!allChecked"
        @click="onConfirm"
      >
        {{ variant === 'save' ? '在本存档启用' : '确认' }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.pr-body {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}

.pr-identity {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs) var(--theme-spacing-lg);
  margin: 0;
}
.pr-identity-row {
  display: flex;
  gap: var(--theme-spacing-sm);
  font-size: 0.8125rem;
  line-height: 1.5;
}
.pr-identity-row dt {
  color: var(--theme-text-muted);
}
.pr-identity-row dd {
  margin: 0;
  font-family: var(--theme-font-title);
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow-wrap: anywhere;
}

.pr-section {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.pr-heading {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}

.pr-network-empty,
.pr-added-notice {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}
.pr-added-notice {
  color: var(--theme-warning);
}

.pr-domains,
.pr-caps {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}
.pr-domain {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  font-size: 0.8125rem;
  line-height: 1.5;
}
.pr-domain-host {
  font-family: 'Cascadia Code', monospace;
  color: var(--theme-text-primary);
  overflow-wrap: anywhere;
}
/* 新增域名：全边框 + 染底（禁止侧边条），并配「新增」字样，不只靠颜色 */
.pr-domain.is-added {
  background: color-mix(in srgb, var(--theme-warning) 10%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-warning) 45%, var(--theme-card-border));
}
.pr-domain-badge {
  flex-shrink: 0;
  padding: 0 var(--theme-spacing-xs);
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  border-radius: var(--theme-radius-sm);
}

.pr-warnings {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin: 0;
  padding: var(--theme-spacing-md) var(--theme-spacing-md) var(--theme-spacing-md)
    var(--theme-spacing-xl);
  background: color-mix(in srgb, var(--theme-error) 6%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
}
.pr-warning,
.pr-cap {
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-primary);
}
.pr-cap {
  color: var(--theme-text-secondary);
  overflow-wrap: anywhere;
}

.pr-disclaimer {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--theme-text-muted);
}

.pr-checks {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.pr-check {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  min-height: 36px;
  padding: 0 var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  cursor: pointer;
  transition: background-color var(--theme-transition-fast);
}
.pr-check:hover {
  background: var(--theme-tab-hover-bg);
}
.pr-check input {
  flex-shrink: 0;
  margin: 0;
  accent-color: var(--theme-error);
}

@media (prefers-reduced-motion: reduce) {
  .pr-check {
    transition: none;
  }
}
</style>
