<script setup lang="ts">
/**
 * AssetMedia — 一个素材位: 命中就铺满外层容器，没命中就把插槽（首字母之类的兜底）交回去。
 *
 * 为什么是个组件而不是几个 computed: `useAssetImage` 只能在 setup 里调，而列表里
 * 每一项都要**一条自己的**解析链。让每项是一个组件，作用域由 Vue 建和拆，
 * object URL 的释放（composable 的 `onScopeDispose`）就是白拿的 —— 手写一套
 * 「名字集合变了就增删 effectScope」的对账器，只会多出一个会漏 URL 的地方。
 * 📌 这条「每项一个作用域」正是本组件的**要害**，AssetMedia.test.ts 钉着它。
 *
 * 尺寸 / 形状 / 裁切一律由**外层容器**给（容器自带 `overflow: hidden`），
 * 本组件只负责铺满 —— 于是同一个组件既能填 2.5rem 的圆，也能填 46×58 的立牌位。
 *
 * `type` 收单个类型或**类型链**（见 asset-resolve.ts 的两条链）: 脸位传
 * `ASSET_TYPE_AVATAR_CHAIN`，立牌位传 `ASSET_TYPE_FALLBACK_CHAIN`。
 *
 * 📌 之前 ScenePanel.vue 与 CharacterListPanel.vue 各有一份逐字相同的本地实现
 * （当时的范围栅栏不允许新建共享组件文件）—— 现在两处都用这一份。
 */
import { useAssetImage } from '../../composables/useAssetImage'
import type { AssetType } from '@engine/types'

const props = withDefaults(
  defineProps<{
    /** 角色名，**严格 `===`**（D2）；空 / null → 直接走插槽兜底 */
    name?: string | null
    /** 单个类型（精确匹配）或类型链（按序降级） */
    type: AssetType | readonly AssetType[]
  }>(),
  { name: '' },
)

const { url, isVideo } = useAssetImage(
  () => props.name,
  () => props.type,
)
</script>

<template>
  <!-- 查无此素材 / 字节缺失 → 原样交还兜底内容，绝不渲染空白框 -->
  <slot v-if="url === null" />
  <video
    v-else-if="isVideo"
    class="asset-media"
    :src="url"
    muted
    playsinline
    loop
    autoplay
    :aria-label="name ?? ''"
  />
  <img v-else class="asset-media" :src="url" :alt="name ?? ''" />
</template>

<style scoped>
.asset-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
