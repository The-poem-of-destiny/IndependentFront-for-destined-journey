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
import { confirmDialog } from '../../lib/confirm-dialog';
import { confirmAndUninstallPack } from '../settings/pack-uninstall-flow';
import { describeDevContentNotices } from '../../lib/dev-content-source';
import { PACK_SAVES_IN_USE_MESSAGE } from '../../lib/save-tab-lock';

const content = useContentStore();
const ui = useUIStore();

/**
 * 开发期内容源提示行（仅 DEV）：内容源被切到本地目录、或解析出提示时，
 * 在横幅里多一行说明，免得开发者忘了已装包此刻没被启用。
 */
const devLine = computed<string | null>(() => {
  if (!import.meta.env.DEV) return null;
  const dev = content.devContentSource;
  if (!dev || (!dev.suppressPack && dev.notices.length === 0)) return null;
  const source = dev.preference === 'local' ? '本地目录' : '内容包';
  const pack = dev.suppressedPack
    ? `（已装包 ${dev.suppressedPack.packId} v${dev.suppressedPack.packVersion} 未启用）`
    : '';
  const notes = describeDevContentNotices(dev.notices);
  return `开发：内容源=${source}${pack}${notes.length ? ` · ${notes.join(' ')}` : ''}`;
});
/**
 * 包被开发开关压制时，横幅不再提供导入 / 卸载入口（store 会直接拒绝），正文也不再劝人导入。
 * `import.meta.env.DEV &&` 字面前置：生产构建里恒为 false。
 */
const packSuppressed = computed(
  () => import.meta.env.DEV && content.devContentSource?.suppressPack === true,
);

/** 占位世界书条目规模阈值（§5.8）：超过则判定为「本地有真实内容」 */
const PLACEHOLDER_ENTRY_THRESHOLD = 150;

/** 本地 Dexie 世界书条目总规模（§5.8 检测用）；-1 = 未检测 */
const localEntryScale = ref(-1);

async function detectLocalScale(): Promise<void> {
  try {
    // 惰性取 Dexie：避免在测试 / 未挂载时硬依赖。worldBooks 表是 v14 全局共享表。
    const { getDatabase } = await import('@engine/persistence/database');
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
    return content.activePackId !== null || devLine.value !== null;
  }
  return true; // placeholder / error 始终显示
});

/** 横幅正文（按四态 + §5.8 检测分支） */
const message = computed(() => {
  if (content.protectedPack) {
    const expiry = content.leaseExpiresAt
      ? ` · 有效期至 ${new Date(content.leaseExpiresAt).toLocaleString()}`
      : '';
    return `${content.leaseMessage}${expiry}`;
  }
  if (content.contentStatus === 'pack')
    return `本地内容包 ${content.activePackVersion ?? ''} 已安装`;
  const st = content.contentStatus;
  if (st === 'error') {
    return content.lastFetchError
      ? `内容加载失败：${content.lastFetchError}`
      : '内容加载失败，部分默认配置可能缺失';
  }
  // placeholder
  if (packSuppressed.value) {
    // 包其实装着，只是被开发开关暂停：别再让人去导入
    return '已安装的内容包已被开发内容源开关暂停启用，当前使用本地 /data 内容';
  }
  if (detectedLegacyContent.value) {
    return '检测到本地真实内容，导入内容包以恢复完整默认与后续更新';
  }
  return '未导入内容包，当前为演示级占位内容';
});

/** 横幅级别（决定配色） */
const level = computed<'info' | 'warn' | 'error'>(() => {
  if (content.protectedPack) return content.leaseState.startsWith('LOCKED_') ? 'warn' : 'info';
  const st = content.contentStatus;
  if (st === 'error') return 'error';
  if (packSuppressed.value) return 'info';
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
          // 横幅不内嵌复杂 Modal，引导去设置页「内容包」分区完成两阶段确认（S-01）
          const go = await confirmDialog({
            title: '内容包与本地内容有冲突',
            message:
              '检测到与本地既有内容冲突的项，覆盖将丢弃这些修改。请前往「设置 → 内容包」重新导入，在那里逐项确认。',
            confirmLabel: '前往内容包',
          });
          if (go) ui.openSettings('content-pack');
        } else if (outcome.status === 'invalid') {
          ui.toast('内容包校验未通过', 'error');
        } else if (outcome.status === 'saves_in_use') {
          ui.toast(PACK_SAVES_IN_USE_MESSAGE, 'error');
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

/** pack 态：卸载内容包 —— 与「内容包」分区共用同一套确认流程（S-36） */
async function uninstallPack() {
  busy.value = true;
  try {
    const result = await confirmAndUninstallPack({
      protectedPack: content.protectedPack,
      uninstallPack: (opts) => content.uninstallPack(opts),
    });
    if (result.status === 'cancelled') return;
    if (result.status === 'uninstalled') ui.toast('内容包已卸载，已回到演示级占位内容', 'success');
    else if (result.status === 'busy') ui.toast('另一次内容包操作正在进行，请稍后再试', 'error');
    else if (result.status === 'saves_in_use') ui.toast(PACK_SAVES_IN_USE_MESSAGE, 'error');
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
    <span class="content-banner-text"
      >{{ message
      }}<span v-if="devLine" class="content-banner-dev" data-testid="content-banner-dev">{{
        devLine
      }}</span></span
    >
    <span class="content-banner-actions">
      <AppButton
        v-if="content.protectedPack"
        variant="secondary"
        size="sm"
        @click="ui.openSettings('content-pack')"
        >管理 Discord 授权</AppButton
      >
      <AppButton
        v-else-if="content.contentStatus === 'placeholder' && !packSuppressed"
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
/* 开发期内容源提示：另起一行、小一号，警示色，与玩家可见文案区分开 */
.content-banner-dev {
  display: block;
  margin-top: 2px;
  font-size: 0.78rem;
  color: var(--theme-warning);
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
