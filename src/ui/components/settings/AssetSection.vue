<script setup lang="ts">
/**
 * 素材设置分区 —— 编排壳
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §7
 * 布局对齐 AudioSection，每段一个子组件（./assets/）：
 *   ① 导入导出 AssetImportStrip     —— 一键导入 / 导出 / 进度取消 / 回执 / 配额
 *   ② 素材库   AssetLibrary         —— 按角色 / 全部素材两个视图（内含角色抽屉）
 * 外加 AssetDialogs（确认 / 输入弹窗，provide 给各子组件用）。
 *
 * 本壳只做三件事：分区级生命周期（init）、唯一的 aria-live 播报区、以及把弹窗
 * 能力下发。跨段派生这里一份都没有 —— 两个视图都从 store 的 `flat` / `groups`
 * 现算，没有第二个消费者，硬要上提反而是凭空多一层。
 *
 * 边界: 本组件树只调 asset-store 的公开动作，不碰 Dexie、不自己铸 object URL。
 * ⚠️ v1 **不渲染任何素材到游戏内**（设计 §11）: 这个分区是唯一的使用面，
 * AvatarPanel / ScenePanel / CharacterListPanel / StatusOverview 一个都没动。
 */
import { computed, onMounted, provide, ref, watch } from 'vue'
import { useAssetStore } from '../../stores/asset-store'
import AppCard from '../shared/AppCard.vue'
import AssetImportStrip from './assets/AssetImportStrip.vue'
import AssetLibrary from './assets/AssetLibrary.vue'
import AssetDialogs from './assets/AssetDialogs.vue'
import { assetDialogsKey, type AssetConfirmOptions, type AssetPromptOptions } from './assets/dialogs'

const assets = useAssetStore()

// ===== 弹窗能力下发 =====
// 弹窗本体挂在本壳里（一次只有一个在场），子组件通过 inject 拿到这两个方法。
// 这里包一层闭包而不是直接 provide 实例：provide 发生在挂载之前，那时 ref 还是空的。

const dialogsRef = ref<InstanceType<typeof AssetDialogs> | null>(null)

provide(assetDialogsKey, {
  askConfirm: (opts: AssetConfirmOptions) => dialogsRef.value!.askConfirm(opts),
  askPrompt: (opts: AssetPromptOptions) => dialogsRef.value!.askPrompt(opts),
})

// ===== 生命周期 =====

/**
 * `init()` 是异步的（Dexie 读全表）且**幂等**，用户完全可能在它兑现之前就切走分区。
 *
 * 这里刻意**没有** AudioSection 那种 `unmounted` 守卫: 那个守卫防的是"await 之后
 * 再改本组件状态 / 抬引用计数"，而本壳 await 之后一个字都不写 —— 全部落点都在
 * store 里，store 不随分区卸载。真正需要守卫的两处（AssetImportStrip 的配额、
 * assets/thumbs.ts 的 URL 表）各自带着自己的 `disposed`。
 * 写一个守着空语句的标志位，只会让下一个人以为它在防着什么。
 */
onMounted(() => {
  void assets.init()
})

// ===== 状态播报（唯一 aria-live 区域） =====
// 只播报离散的、用户会关心的转变：库的忙碌态与导入/导出的忙碌态。
// 绝不播报进度这类连续值 —— 那会把屏幕阅读器淹掉（进度条自己带 aria-label）。
// 一次性事件（导入回执、批量删除结果、改名结果）由各段 emit('announce') 上来，
// 仍然只写这一处。

const liveMessage = ref('')

const assetCount = computed(() => assets.assets.length)

// 忙碌态结束必须改写这行字：留着「正在导入…」既是骗人，也会让下一次导入
// 因为字符串没变而彻底不播报。结束时报库的现状（回执文案由子组件 announce 覆盖）。
watch(() => assets.loading, (on) => {
  liveMessage.value = on ? '正在翻检素材库…' : `素材库共 ${assetCount.value} 条。`
})
watch(() => assets.importing, (on) => {
  if (on) liveMessage.value = '正在导入素材包…'
})
watch(() => assets.exporting, (on) => {
  if (on) liveMessage.value = '正在打包素材…'
})
</script>

<template>
  <section class="section centered asset-section">
    <h3>素材</h3>
    <p class="section-desc">
      管理角色头像与立绘。素材库为全局资源，所有存档共用；它不随存档导出/导入，
      有自己的一份素材包（见下方「导出素材包」）。v1 只做管理 —— 游戏内暂不渲染任何素材。
    </p>

    <!-- 唯一状态播报区：忙碌态与各段的一次性回执。视觉隐藏，只给辅助技术 -->
    <p class="sr-only" role="status" aria-live="polite">{{ liveMessage }}</p>

    <!-- ═══ ① 导入与导出 ═══ -->
    <AppCard padding="md" class="asset-card">
      <AssetImportStrip @announce="liveMessage = $event" />
    </AppCard>

    <!-- ═══ ② 素材库 ═══ -->
    <AppCard padding="md" class="asset-card">
      <AssetLibrary @announce="liveMessage = $event" />
    </AppCard>

    <!-- ═══ 确认 / 输入弹窗（取代 window.confirm / window.prompt） ═══ -->
    <AssetDialogs ref="dialogsRef" />
  </section>
</template>

<style scoped>
/*
 * 分区标题 / 描述：值与 SettingsPage 的 `.section>h3` / `.section-desc` 一致
 * （1.4rem 落在 design.md §排版「设置页 section h3 = 1.3-1.4rem」区间内）。
 * 不能删掉靠继承 —— SettingsPage 的样式是 scoped 的，只能命中本组件的根节点，
 * 命不到根节点里面的 h3/p，删了这里标题就退回浏览器默认样式了。
 */
.asset-section > h3 {
  font-family: var(--theme-font-title);
  font-size: 1.4rem;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-xs);
}
.section-desc {
  margin: 0 0 var(--theme-spacing-xl);
  padding-bottom: var(--theme-spacing-md);
  font-size: 0.85rem;
  color: var(--theme-text-muted);
  border-bottom: 1px solid var(--theme-card-border);
}
.asset-card {
  margin-top: var(--theme-spacing-lg);
  box-shadow: var(--paper-stack);
}
/* 两段之间比首段与分区描述之间收一档，让两张卡读起来是一组 */
.asset-card + .asset-card {
  margin-top: var(--theme-spacing-md);
}

/* ═══ 无障碍：视觉隐藏（保留在无障碍树里） ═══ */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
