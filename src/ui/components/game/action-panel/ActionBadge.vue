<script setup lang="ts">
/**
 * 行动面板的头像位：脸位链（头像 → 立绘 → 立绘bg）；没有素材的名字（临时敌人、未建档角色）
 * 交还插槽，显示名字首字题签。
 *
 * `target`：目标一侧换成中性底（行动者是古金底）。
 */
import { computed } from 'vue';
import { ASSET_TYPE_AVATAR_CHAIN } from '@engine/assets/asset-resolve';
import AssetMedia from '../../shared/AssetMedia.vue';

const props = defineProps<{
  name: string;
  target?: boolean;
  size?: 'sm' | 'md' | 'lg';
}>();

const initial = computed(() => Array.from(props.name.trim())[0] ?? '?');
</script>

<template>
  <span
    class="bdg"
    :class="[target ? 'is-target' : '', size && size !== 'md' ? `is-${size}` : '']"
    aria-hidden="true"
  >
    <AssetMedia :name="name" :type="ASSET_TYPE_AVATAR_CHAIN">
      <span class="bdg-ini">{{ initial }}</span>
    </AssetMedia>
  </span>
</template>

<style scoped>
.bdg {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  overflow: hidden;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--theme-card-bg));
  color: var(--theme-primary);
  font-family: var(--theme-font-title);
  font-size: 0.85rem;
  font-weight: 600;
  line-height: 1;
}

.bdg.is-target {
  border-color: var(--theme-card-border);
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
}

.bdg.is-sm {
  width: 1.2rem;
  height: 1.2rem;
  font-size: 0.65rem;
}

.bdg.is-lg {
  width: 2.4rem;
  height: 2.4rem;
  font-size: 1.1rem;
}
</style>
