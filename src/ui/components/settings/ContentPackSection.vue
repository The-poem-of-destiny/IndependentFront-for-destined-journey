<script setup lang="ts">
/**
 * 内容包分区 —— 导入 / 升级 / 检查更新 / 卸载 + Discord 在线授权（S-01）
 *
 * 🔴 为什么单独成区、排在「API 配置」之后：内容包是新玩家**必须**装的东西
 *    （真实世界书、Agent 提示词、预设、目录都从这里来），此前它是「数据与备份」
 *    最后一张卡，和「清除所有数据」挤在同一个网格里，左栏里找不到它的名字。
 *    逻辑整体从 DataSection 搬来，行为不变；卸载改为永远先确认（S-36）。
 */
import { ref, shallowRef, computed, onMounted, watch, defineAsyncComponent } from 'vue';
import { discordAuthRevision } from '../../lib/discord-auth-client';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import PackInstallConfirmModal from './PackInstallConfirmModal.vue';
import DiscordPackAccess from './DiscordPackAccess.vue';
import { useContentStore } from '../../stores/content-store';
import type { ProtectedPackDownload } from '@engine/types/types-pack-auth';
import { useSettingsStore } from '../../stores/settings-store';
import { useUIStore } from '../../stores/ui-store';
import type { PackInstallPlan } from '@engine/types/types-content';
import type { PackUpgradeDiff } from '@engine/content/content-pack-plan';
import {
  checkPackUpdate,
  downloadLatestPack,
  isPackUpdateAvailable,
  type PackUpdateInfo,
} from '../../lib/content-pack-updater';
import { confirmAndUninstallPack } from './pack-uninstall-flow';

const cfg = useSettingsStore();
const ui = useUIStore();

/** 内容态（内容包是否已装） */
const content = useContentStore();
const hasActivePack = computed(() => content.activePackId !== null);
const activePackVersion = computed(() => content.activePackVersion);

/**
 * 开发期内容源开关（仅 DEV）：生产构建里 `import.meta.env.DEV` 为字面量 false，
 * 整个异步组件连同偏好键名被摇掉。
 */
const DevCard = import.meta.env.DEV
  ? defineAsyncComponent(() => import('./DevContentSourceCard.vue'))
  : null;
/**
 * 开发期选了「本地内容目录」且有已装包时，包未激活 —— 装/升/卸都会作用到一个没在用的包上，先禁用。
 * `import.meta.env.DEV &&` 字面前置：生产构建里恒为 false，相关模板分支随之失效。
 */
const packSuppressed = computed(
  () => import.meta.env.DEV && content.devContentSource?.suppressPack === true,
);
/** 被开发开关暂停的已装包身份（标题里点名，免得误以为「没装包」） */
const suppressedPack = computed(() =>
  import.meta.env.DEV && packSuppressed.value
    ? (content.devContentSource?.suppressedPack ?? null)
    : null,
);

/** 挂载时读一次内容态（content-store 的 store 状态） */
onMounted(async () => {
  await content.hydratePackState();
});

// ═══════════ 内容包导入（波 1 T7 / D19 / §5.2）═══════════

/**
 * 内容包导入入口：文件 picker（.json）→ installPack → 有 conflicted 弹两阶段确认；
 * 无冲突直接装。
 *
 * 🔴 两阶段提交（D19）：installPack 在无 `confirmConflicts` 时遇 conflicted 返回
 * `needs_confirmation`（带完整 plan），这里把 plan 塞给
 * `PackInstallConfirmModal`，用户确认后以 `{ confirmConflicts: true }` 重入。
 */
const packPlan = ref<PackInstallPlan | null>(null);
// 🔴 shallowRef：pack 是纯数据，绝不能进响应式系统——ref 深代理会让确认重入时
//    取回 Proxy，savePreset 落库 IDB 结构化克隆拒绝 Proxy → DataCloneError
//    （2026-08-07 真机根因；savePreset 侧已加 detach 双保险）。
const packPending = shallowRef<unknown | null>(null); // 待确认的原始 pack JSON
const onlinePending = shallowRef<ProtectedPackDownload | null>(null);
watch(
  discordAuthRevision,
  () => {
    if (onlinePending.value) {
      onlinePending.value = null;
      packPlan.value = null;
    }
  },
  { flush: 'sync' },
);
const packDiff = ref<PackUpgradeDiff | null>(null);
const packError = ref<string | null>(null);
const packInstalling = ref(false);

/** 在线更新仅下载密文；授权校验和运行时解密由 content-store 处理。 */
const checkedPackUpdate = ref<PackUpdateInfo | null>(null);
const packUpdate = computed(() => {
  const info = checkedPackUpdate.value;
  return info
    ? {
        ...info,
        updateAvailable:
          info.available && isPackUpdateAvailable(info.packVersion, activePackVersion.value),
      }
    : null;
});
const packCheckingUpdate = ref(false);

async function checkForPackUpdate() {
  packCheckingUpdate.value = true;
  try {
    const result = await checkPackUpdate(activePackVersion.value);
    if (result.status === 'error') {
      ui.toast(result.message, 'error');
      return;
    }
    checkedPackUpdate.value = result.info;
    if (!result.info.available) ui.toast('发布源暂无内容包', 'info');
    else if (result.info.updateAvailable)
      ui.toast(`发现新版本 ${result.info.packVersion}`, 'success');
    else ui.toast('已是最新版本', 'info');
  } finally {
    packCheckingUpdate.value = false;
  }
}

/** 下载最新包并复用 `runInstall`（同 packId 自动走升级 diff 两阶段） */
async function applyPackUpdate() {
  if (packInstalling.value) return;
  packInstalling.value = true;
  try {
    const result = await downloadLatestPack();
    if (result.status === 'error') {
      ui.toast(result.message, 'error');
      return;
    }
    const outcome = await content.installProtectedPack(result.download);
    if (outcome.status === 'needs_confirmation') {
      packPlan.value = outcome.plan ?? null;
      onlinePending.value = result.download;
      packPending.value = null;
    } else if (outcome.ok) {
      await afterPackApplied(outcome.notes ?? []);
      ui.toast('授权内容包已安装，自动续期已启用', 'success');
    } else ui.toast('内容包操作正在进行，请稍后重试', 'error');
  } catch (error) {
    ui.toast(error instanceof Error ? error.message : '获取内容包失败', 'error');
  } finally {
    packInstalling.value = false;
  }
}

async function pickPackFile() {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = '.json';
  i.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await f.text());
    } catch {
      ui.toast('内容包格式无效：JSON 解析失败', 'error');
      return;
    }
    await runInstall(raw);
  };
  i.click();
}

/** 执行安装（第一段：无冲突直接装；有冲突弹确认）。已装同 packId → 走升级路径（显示 diff） */
async function runInstall(raw: unknown) {
  packError.value = null;
  onlinePending.value = null;
  packDiff.value = null;
  packInstalling.value = true;
  try {
    const packId = (raw as { packId?: string } | null)?.packId ?? '';
    // 已是同 packId → 升级路径（diff 展示）；否则首次安装
    if (content.activePackId === packId) {
      await runUpgradeRaw(raw);
      return;
    }
    const outcome = await content.installPack(raw);
    if (!outcome.ok) {
      if (outcome.status === 'needs_confirmation') {
        packPlan.value = outcome.plan ?? null;
        packPending.value = raw;
        packDiff.value = outcome.upgradeDiff ?? null;
      } else if (outcome.status === 'invalid') {
        packError.value = formatValidationErrors(outcome.validationErrors);
        ui.toast('内容包校验未通过', 'error');
      }
      return;
    }
    await afterPackApplied(outcome.notes ?? []);
    ui.toast('内容包已安装', 'success');
  } catch (err) {
    // 🔴 安装异常必须留痕：此前空 catch 吞掉全部错误，只弹 toast、控制台零输出，
    //    失败原因无从排查（2026-08-07 真机：导入 pack 报「安装失败」但无任何日志）。
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[content-pack] 内容包安装失败:', err);
    packError.value = msg || '内容包安装失败（无错误信息）';
    ui.toast('内容包安装失败', 'error');
  } finally {
    packInstalling.value = false;
  }
}

function formatValidationErrors(errors: unknown[] | undefined): string {
  return (
    (errors ?? []).map((e) => (e as { text?: string })?.text ?? String(e)).join('\n') ||
    '内容包校验未通过'
  );
}

/** 升级路径：查 diff → 展示 → 有冲突/变化则弹确认；无冲突直接装 */
async function runUpgradeRaw(raw: unknown): Promise<void> {
  const outcome = await content.upgradePack(raw);
  if (!outcome.ok && outcome.status === 'needs_confirmation') {
    packPlan.value = outcome.plan ?? null;
    packPending.value = raw;
    packDiff.value = outcome.upgradeDiff ?? null;
    return;
  }
  if (outcome.ok) {
    await afterPackApplied(outcome.notes ?? []);
    ui.toast('内容包已升级', 'success');
  } else if (outcome.status === 'invalid') {
    packError.value = formatValidationErrors(outcome.validationErrors);
    ui.toast('内容包校验未通过', 'error');
  }
}

/** 用户在确认 Modal 点「确认」→ 以 confirmConflicts 重入 */
async function confirmPackInstall() {
  if (!packPending.value && !onlinePending.value) return;
  const online = onlinePending.value;
  const raw = packPending.value;
  onlinePending.value = null;
  const wasUpgrade = content.activePackId === ((raw as { packId?: string })?.packId ?? '');
  packPending.value = null;
  packPlan.value = null;
  packDiff.value = null;
  packInstalling.value = true;
  try {
    const outcome = online
      ? await content.installProtectedPack(online, { confirmConflicts: true })
      : await (wasUpgrade
          ? content.upgradePack(raw, { confirmConflicts: true })
          : content.installPack(raw, { confirmConflicts: true }));
    if (!outcome.ok) {
      ui.toast('内容包安装失败', 'error');
      return;
    }
    await afterPackApplied(outcome.notes ?? []);
    ui.toast(wasUpgrade ? '内容包已升级' : '内容包已安装', 'success');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[content-pack] 内容包安装失败（确认重入）:', err);
    packError.value = msg || '内容包安装失败（无错误信息）';
    ui.toast('内容包安装失败', 'error');
  } finally {
    packInstalling.value = false;
  }
}

/** 装/卸/升后统一收尾：重载 Agent 默认 + 刷新内容态 */
async function afterPackApplied(notes: unknown[]): Promise<void> {
  showSuccessNotes(notes);
  await cfg.loadAgentProjectDefaults();
  await content.hydratePackState();
}

/** 卸载（S-36）：永远先确认；编辑过的包内世界书再确认一次 */
async function requestUninstall() {
  if (packInstalling.value) return;
  packInstalling.value = true;
  try {
    const result = await confirmAndUninstallPack({
      protectedPack: content.protectedPack,
      uninstallPack: (opts) => content.uninstallPack(opts),
    });
    if (result.status === 'cancelled') return;
    if (result.status === 'uninstalled') {
      ui.toast('内容包已卸载，已回到演示级占位内容', 'success');
      await cfg.loadAgentProjectDefaults();
    } else if (result.status === 'busy') {
      ui.toast('另一次内容包操作正在进行，请稍后再试', 'error');
    } else ui.toast('卸载失败', 'error');
  } catch (err) {
    console.error('[content-pack] 内容包卸载失败:', err);
    ui.toast('卸载失败', 'error');
  } finally {
    packInstalling.value = false;
  }
}

/** 安装结果的三类处置记录 toast（dropped/degraded/sideEffect） */
function showSuccessNotes(notes: unknown[]): void {
  const kindOf = (n: unknown) => (n as { kind?: string } | null)?.kind;
  const dropped = notes.filter((n) => kindOf(n) === 'dropped');
  const degraded = notes.filter((n) => kindOf(n) === 'degraded');
  const side = notes.filter((n) => kindOf(n) === 'sideEffect');
  if (dropped.length || degraded.length || side.length) {
    const parts: string[] = [];
    if (dropped.length) parts.push(`${dropped.length} 项丢弃`);
    if (degraded.length) parts.push(`${degraded.length} 项降级`);
    if (side.length) parts.push(`${side.length} 项附带影响`);
    ui.toast(`内容包已处理，注意：${parts.join('、')}`, 'warning');
  }
}
</script>

<template>
  <section class="section centered">
    <h3>内容包</h3>
    <p class="section-desc">
      游戏的完整内容（世界书、Agent
      提示词、预设与目录数据）来自内容包。未装包时运行在演示级占位内容上。
    </p>
    <AppCard padding="md" class="pack-card" data-settings-anchor="content-pack">
      <h4>
        当前状态：<template v-if="hasActivePack"
          >已安装<template v-if="activePackVersion">（{{ activePackVersion }}）</template></template
        ><template v-else-if="suppressedPack"
          >已安装（{{ suppressedPack.packId }} v{{
            suppressedPack.packVersion
          }}），已被开发内容源开关暂停启用</template
        ><template v-else>未安装，正在使用演示级占位内容</template>
      </h4>
      <DiscordPackAccess />
      <p class="text-muted text-sm">
        导入内容包以加载完整的世界书、Agent 提示词、预设与目录数据。<template
          v-if="activePackVersion"
          >当前：{{ activePackVersion }}。</template
        >
      </p>
      <div class="pack-actions">
        <AppButton
          variant="secondary"
          size="sm"
          class="card-action"
          :loading="packInstalling"
          :disabled="packSuppressed"
          @click="pickPackFile"
          >导入 / 升级内容包</AppButton
        >
        <AppButton
          variant="ghost"
          size="sm"
          class="card-action"
          :loading="packCheckingUpdate"
          :disabled="packInstalling || packSuppressed"
          @click="checkForPackUpdate"
          >检查更新</AppButton
        >
        <AppButton
          v-if="packUpdate?.updateAvailable"
          variant="primary"
          size="sm"
          class="card-action"
          :loading="packInstalling"
          :disabled="packSuppressed"
          @click="applyPackUpdate"
          >更新到 {{ packUpdate.packVersion }}</AppButton
        >
        <AppButton
          v-if="hasActivePack"
          variant="ghost"
          size="sm"
          class="card-action pack-uninstall"
          :disabled="packInstalling || packSuppressed"
          @click="requestUninstall"
          >卸载内容包</AppButton
        >
      </div>
      <p v-if="packSuppressed" class="pack-suppressed-reason text-sm" role="note">
        开发内容源当前为「本地内容目录」，已安装的内容包未启用，导入 / 更新 / 卸载暂不可用。
      </p>
      <p v-if="packUpdate && !packUpdate.updateAvailable" class="text-muted text-sm">
        已是最新版本<template v-if="packUpdate.packVersion"
          >（{{ packUpdate.packVersion }}）</template
        >。
      </p>
    </AppCard>
    <component :is="DevCard" v-if="DevCard" />
    <!--
      内容包安装/升级的两阶段确认（波 1 T7 / D19 / §5.2）：
      plan 非空时展示，确认后 confirmPackInstall 以 confirmConflicts:true 重入 installPack。
    -->
    <AppCard v-if="cfg.settings" padding="md" class="pack-card" data-settings-anchor="nsfw-content">
      <h4>露骨内容</h4>
      <p class="card-desc">
        内容包可以把露骨段落标记出来（<code>&lt;nsfw&gt;</code>），或给整条世界书条目 / 预设提示词 /
        角色打上露骨标记。本项为<strong>全局设置</strong>，立即对所有存档生效。
      </p>
      <div class="toggle-row">
        <label class="toggle-label"
          ><input
            v-model="cfg.settings.nsfwContent"
            type="checkbox"
            class="toggle-input"
            data-testid="nsfw-content-toggle"
          /><span class="toggle-slider" /><span>允许露骨内容</span></label
        >
      </div>
      <p class="form-hint">
        关闭后，标记的内容不会发送给模型，也不会在游戏界面显示（世界书编辑器与提示词编辑器仍显示原文），
        插画分级上限同时限制在「敏感」以内。<strong>已经生成的聊天内容不受影响。</strong>
      </p>
    </AppCard>
    <PackInstallConfirmModal
      :open="!!(packPlan || packError)"
      :plan="packPlan"
      :upgrade-diff="packDiff"
      :error-message="packError"
      @update:open="
        (v: boolean) => {
          if (!v) {
            packPlan = null;
            packError = null;
            packPending = null;
            onlinePending = null;
          }
        }
      "
      @confirm="confirmPackInstall"
      @cancel="
        packPlan = null;
        packError = null;
        packPending = null;
        onlinePending = null;
      "
    />
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
.pack-card {
  border-color: color-mix(in srgb, var(--theme-quality-rare) 25%, transparent) !important;
}
.pack-card h4 {
  margin: 0 0 var(--theme-spacing-sm);
  font-size: 0.95rem;
}
/* 内容包按钮行：导入 / 检查更新 / 更新 / 卸载 */
.pack-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.pack-suppressed-reason {
  margin: var(--theme-spacing-sm) 0 0;
  color: var(--theme-warning);
}
/* 卸载推到行尾，与「导入」拉开距离，免得顺手误点 */
.pack-uninstall {
  margin-left: auto;
}
</style>
