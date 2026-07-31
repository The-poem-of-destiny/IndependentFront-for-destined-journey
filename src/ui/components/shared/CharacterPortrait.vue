<script setup lang="ts">
/**
 * CharacterPortrait — 顶对齐的**大画像**位。**纯呈现，没有任何按钮。**
 *
 * 与 `AvatarPanel`（1:1 小方框 / 圆形脸位）的分工是**呈现形态**，不是数据来源:
 * 只有当命中的素材真是 `立绘` / `立绘bg` 时才用本组件。把一张 `头像`
 * 拉满整栏宽看起来像 bug 而不像功能，所以分叉判据在调用方（见 StatusOverview）。
 *
 * 📌 **画面上不放任何家具**（旋钮 / 徽章 / 浮层一概没有）。取景的调节面在
 * `PortraitSettingsDialog`，由调用方点画像打开 —— 一张画像上盖着两个小按钮、
 * 再弹出一层盖住画像本身的浮层，正是这次要拆掉的东西。本组件因此也不碰
 * asset-store: 它只拿到一份 `framing` 就画，谁给的、要不要落库都与它无关。
 * 这也让「拖滑块时的实时预览」白拿 —— 传一份**没落库的**取景进来即可。
 *
 * 🔴 **取景（{@link AssetFraming}）必须先过 `clampAssetFraming` 再落到 CSS。**
 * 这不是防御性洁癖: 一个 NaN 会让整条 `object-position` / `transform` 声明被
 * 浏览器丢弃，表现成「这张图偶尔没对齐」—— 是最难查的那类样式 bug。存量行没有
 * framing 字段、旧版本可能写过越界的 scale、滑块除以一个还没测出来的 0 宽度
 * 就够产出 NaN，这些路径全都汇到这里。
 *
 * 🔴 **缩放必须绕焦点发生**（`transform-origin` 与 `object-position` 用同一对
 * 百分比）。若 origin 固定在中心而焦点在别处，放大会把刚对准的地方推出框外 ——
 * 用户的感受是「这两个滑块在互相打架」。
 */
import { computed } from 'vue';
import { clampAssetFraming } from '@engine/asset-types';
import type { AssetFraming } from '@engine/types';

const props = withDefaults(
  defineProps<{
    /** 角色名 —— 只用于 alt / aria，**不参与解析**（解析在调用方） */
    name: string;
    /** object URL；null = 没图（本组件不做兜底，调用方该换成 AvatarPanel） */
    src?: string | null;
    /** `src` 是 mp4 吗（D7: `头像` / `立绘bg` 允许视频）。由**行**判定，别嗅 URL */
    video?: boolean;
    /**
     * 要用的取景，**可以是任意来路的垃圾**，本组件负责收敛。
     * 调节中的实时预览直接把草稿传进来即可（本组件不区分草稿与落库值）。
     */
    framing?: AssetFraming | null;
  }>(),
  { src: null, video: false, framing: null },
);

/** 真正交给 CSS 的那一份，**永远夹逼过** */
const framing = computed<AssetFraming>(() => clampAssetFraming(props.framing));

const mediaStyle = computed(() => {
  const f = framing.value;
  const focus = `${f.x}% ${f.y}%`;
  return {
    objectPosition: focus,
    transform: `scale(${f.scale})`,
    // 与焦点同一对百分比 —— 放大绕着看的那一点发生，两个滑块才不打架
    transformOrigin: focus,
  };
});
</script>

<template>
  <div class="character-portrait">
    <!-- 画框: overflow 归它，尺寸/比例归它；里面的媒体只管铺满 -->
    <div class="portrait-frame">
      <video
        v-if="src && video"
        class="portrait-media"
        :src="src"
        :style="mediaStyle"
        :aria-label="name"
        muted
        playsinline
        loop
        autoplay
      />
      <img v-else-if="src" class="portrait-media" :src="src" :alt="name" :style="mediaStyle" />
      <slot v-else />
    </div>
  </div>
</template>

<style scoped>
.character-portrait {
  position: relative;
  width: 100%;
}

/**
 * 4:5 竖幅 —— 与 ScenePanel 在场角色位（46×58）同一个立牌形状，
 * 全站「一张角色立牌该长什么样」只有一种答案。
 * 上限 24rem: 状态栏宽约 25% 屏宽，常见桌面下画框约 19rem 宽，4:5 正好落在
 * 上限附近；超宽屏才由上限接管，避免一张画像把下面的属性/持有物顶出视口。
 */
.portrait-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 5;
  max-height: 24rem;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  /* design.md §4.2 统一卡片外壳，与 AvatarPanel 的 square 形态一致 */
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
  color: var(--theme-text-secondary);
  font-weight: 600;
  font-size: 2.25rem;
}
.portrait-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
