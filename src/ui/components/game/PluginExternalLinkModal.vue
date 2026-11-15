<script setup lang="ts">
/**
 * 插件外链弹窗（设计 §5.7、Q12）—— `host.ui.openExternal(url)` 的唯一落点。
 *
 * - 本应用**从不**替插件打开链接：没有链接元素、没有 `href`、没有 `window.open`。
 *   宿主打开的页面在沙盒和 CSP 之外，能访问本机与局域网服务，等于插件经宿主破红线 D。
 * - 完整地址按纯文本插值、可选中，玩家自己复制、自己决定要不要去浏览器里打开。
 * - 地址在到这里之前已过 `validateExternalUrl`（https、公网多段主机名、无端口无用户信息）。
 *
 * 宿主用 `v-if` 控制显隐：挂载即打开；Esc / 点遮罩 / × / 「关闭」都发 `close`。
 */
import { ref } from 'vue';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';

const props = defineProps<{
  pluginName: string;
  url: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

/** 复制结果：成功提示，或剪贴板不可用时请玩家手动选中复制 */
const copyStatus = ref<'idle' | 'copied' | 'failed'>('idle');

async function copyLink() {
  try {
    if (!navigator.clipboard) throw new Error('剪贴板不可用');
    await navigator.clipboard.writeText(props.url);
    copyStatus.value = 'copied';
  } catch {
    copyStatus.value = 'failed';
  }
}
</script>

<template>
  <AppModal :open="true" title="插件给出的链接" size="md" @close="emit('close')">
    <div class="pel-body">
      <p class="pel-source">
        来自插件 <span class="pel-plugin-name">{{ pluginName }}</span>
      </p>
      <p class="pel-url" data-external-url>{{ url }}</p>
      <p class="pel-notice">
        本应用不会替插件打开链接。如果你信任这个地址，请复制后自己粘贴到浏览器里打开。
        你自己打开的页面不受插件沙盒约束，能访问你的电脑和局域网上的服务。
      </p>
      <p v-if="copyStatus === 'copied'" class="pel-status" role="status">已复制到剪贴板</p>
      <p v-else-if="copyStatus === 'failed'" class="pel-status is-failed" role="status">
        无法写入剪贴板，请手动选中上面的地址复制
      </p>
    </div>

    <template #footer>
      <AppButton variant="secondary" data-link-action="close" @click="emit('close')">
        关闭
      </AppButton>
      <AppButton variant="primary" data-link-action="copy" @click="copyLink">复制链接</AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.pel-body {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}

.pel-source {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
}
.pel-plugin-name {
  font-family: var(--theme-font-title);
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow-wrap: anywhere;
}

.pel-url {
  margin: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  font-family: 'Cascadia Code', monospace;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-primary);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  overflow-wrap: anywhere;
  user-select: all;
}

.pel-notice {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}

.pel-status {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--theme-success);
}
.pel-status.is-failed {
  color: var(--theme-warning);
}
</style>
