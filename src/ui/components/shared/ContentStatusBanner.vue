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
import { useUIStore } from '../../stores/ui-store';
import AppButton from './AppButton.vue';

const content = useContentStore();
const ui = useUIStore();

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

// ── 波 1 T7：横幅动作（placeholder → 导入；pack → 卸载） ──
const busy = ref(false);

/** placeholder 态：导入内容包（文件 picker → installPack；冲突弹系统确认窗口） */
function importPack() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await f.text());
    } catch {
      ui.toast('内容包格式无效', 'error');
      return;
    }
    busy.value = true;
    try {
      const outcome = await content.installPack(raw);
      if (!outcome.ok) {
        if (outcome.status === 'needs_confirmation') {
          // 横幅不内嵌复杂 Modal，引导去设置页数据分区完成两阶段确认
          if (
            window.confirm(
              '检测到与本地既有内容冲突的项，覆盖将丢弃这些修改。前往「设置 → 存档数据 → 导入内容包」完成确认。',
            )
          ) {
            ui.navigate('settings');
          }
        } else if (outcome.status === 'invalid') {
          ui.toast('内容包校验未通过', 'error');
        }
        return;
      }
      ui.toast('内容包已安装', 'success');
    } catch {
      ui.toast('内容包安装失败', 'error');
    } finally {
      busy.value = false;
    }
  };
  input.click();
}

/** pack 态：卸载内容包（确认后执行） */
async function uninstallPack() {
  if (!window.confirm('确定卸载内容包吗？将恢复到演示级占位内容。')) return;
  busy.value = true;
  try {
    const outcome = await content.uninstallPack();
    if (!outcome.ok && outcome.status === 'needs_confirmation') {
      if (
        !window.confirm(
          `有 ${(outcome.plan?.confirmations?.length ?? 0) as number} 本内容包世界书被编辑过，卸载会丢弃这些修改。确定卸载吗？`,
        )
      ) {
        return;
      }
      const done = await content.uninstallPack({ confirmEdits: true });
      if (done.ok) ui.toast('内容包已卸载', 'success');
      else ui.toast('卸载失败', 'error');
      return;
    }
    if (outcome.ok) ui.toast('内容包已卸载', 'success');
    else ui.toast('卸载失败', 'error');
  } catch {
    ui.toast('卸载失败', 'error');
  } finally {
    busy.value = false;
  }
}
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
    <span class="content-banner-actions">
      <AppButton
        v-if="content.contentStatus === 'placeholder'"
        variant="secondary"
        size="sm"
        :loading="busy"
        @click="importPack"
        >导入内容包</AppButton
      >
      <AppButton
        v-else-if="content.contentStatus === 'pack'"
        variant="ghost"
        size="sm"
        :disabled="busy"
        @click="uninstallPack"
        >卸载内容包</AppButton
      >
    </span>
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
.content-banner-actions {
  flex-shrink: 0;
}
@media (max-width: 520px) {
  .content-banner-actions {
    margin-top: 6px;
  }
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
