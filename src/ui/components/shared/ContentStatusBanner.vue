<!--
  ContentStatusBanner.vue — 内容态横幅（波 1 T2 / D16 / §5.5 / §5.8）

  消费 content-store 的 contentStatus，在首页与设置页顶部显示内容态提示。

  四态文案（§5.8 / 验收 #15）:
  - placeholder（未检测到本地真实内容）: 「未导入内容包，当前为演示级占位内容」
  - placeholder + 本地世界书规模远超占位阈值（§5.8 检测横幅）:
      「检测到本地真实内容，导入内容包以恢复完整默认与后续更新」
  - error: 「内容加载失败，部分默认配置可能缺失」+ lastFetchError
  - pack / needs_attention: 由 T7 装包流程驱动，本波占位不出现（activePackId 为空时不渲染）

  🔴 横幅文案含产品名引用（「导入《命定之诗》内容包…」），入 D32 白名单——
     本波文案刻意先不带产品名，留待 D26 品牌面落地后由 branding 注入。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useContentStore } from '../../stores/content-store';

const content = useContentStore();

/** 占位世界书条目规模阈值（§5.8）：超过则判定为「本地有真实内容」 */
const PLACEHOLDER_ENTRY_THRESHOLD = 150;

/** 本地 Dexie 世界书条目总规模（§5.8 检测用）；-1 = 未检测 */
const localEntryScale = ref(-1);

async function detectLocalScale(): Promise<void> {
  try {
    // 惰性取 Dexie：避免在测试 / 未挂载时硬依赖。worldBooks 表是 v14 全局共享表。
    const { getDatabase } = await import('@engine/database');
    const db = getDatabase();
    const books = await db.worldBooks.toArray();
    let total = 0;
    for (const b of books) total += b.entries?.length ?? 0;
    localEntryScale.value = total;
  } catch {
    localEntryScale.value = -1;
  }
}

onMounted(() => {
  void detectLocalScale();
});

/** §5.8 检测：占位态 + 本地规模远超占位阈值 → 横幅切「检测到本地真实内容」措辞 */
const detectedLegacyContent = computed(() => localEntryScale.value > PLACEHOLDER_ENTRY_THRESHOLD);

/** 是否渲染横幅（pack 态 + 无 activePackId 时不渲染：T7 落地前的占位） */
const visible = computed(() => {
  const st = content.contentStatus;
  if (st === 'pack' || st === 'needs_attention') {
    // T7 装包落地前 activePackId 恒为 null → 不渲染（避免空横幅）
    return content.activePackId !== null;
  }
  return true; // placeholder / error 始终显示
});

/** 横幅正文（按四态 + §5.8 检测分支） */
const message = computed(() => {
  const st = content.contentStatus;
  if (st === 'error') {
    return content.lastFetchError
      ? `内容加载失败：${content.lastFetchError}`
      : '内容加载失败，部分默认配置可能缺失';
  }
  // placeholder
  if (detectedLegacyContent.value) {
    return '检测到本地真实内容，导入内容包以恢复完整默认与后续更新';
  }
  return '未导入内容包，当前为演示级占位内容';
});

/** 横幅级别（决定配色） */
const level = computed<'info' | 'warn' | 'error'>(() => {
  const st = content.contentStatus;
  if (st === 'error') return 'error';
  if (detectedLegacyContent.value) return 'warn';
  return 'info';
});
</script>

<template>
  <div v-if="visible" class="content-banner" :class="`content-banner-${level}`" role="status">
    <i
      class="fa-solid content-banner-icon"
      :class="
        level === 'error'
          ? 'fa-circle-exclamation'
          : level === 'warn'
            ? 'fa-circle-info'
            : 'fa-circle-info'
      "
      aria-hidden="true"
    />
    <span class="content-banner-text">{{ message }}</span>
  </div>
</template>

<style scoped>
.content-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.9rem;
  border-radius: 6px;
  font-size: 0.85rem;
  line-height: 1.4;
  border: 1px solid transparent;
}
.content-banner-icon {
  flex-shrink: 0;
}
.content-banner-text {
  flex: 1;
}
.content-banner-info {
  background: var(--theme-bg-elevated, rgba(100, 149, 237, 0.08));
  border-color: var(--theme-border, rgba(100, 149, 237, 0.25));
  color: var(--theme-text-muted, inherit);
}
.content-banner-warn {
  background: rgba(230, 170, 40, 0.1);
  border-color: rgba(230, 170, 40, 0.35);
  color: var(--theme-text, inherit);
}
.content-banner-error {
  background: rgba(220, 60, 60, 0.1);
  border-color: rgba(220, 60, 60, 0.35);
  color: var(--theme-text, inherit);
}
</style>
