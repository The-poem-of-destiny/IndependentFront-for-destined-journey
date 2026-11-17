<script setup lang="ts">
/**
 * FxGlint — 偶发闪光层。挂在 FxLayer，应用级覆盖层
 *
 * 每 40–90 秒挑一个可见面板框，沿它的一条边划过一道细光（约 900ms，只动 transform / opacity），
 * 播完即藏，从不循环；没有可见框就跳过。排期、选框、选边、关键帧都在 lib/fx-glint.ts。
 * crimson 主题禁止环境动效：运行器跳过，样式再 `display: none` 兜底。
 *
 * 特效层约定：叶子节点、`aria-hidden="true"`、`pointer-events: none`（见 styles/fx-core.css）。
 * 只在特效闸门打开时被挂载（父层 v-if），所以这里不再判闸门。卸载即停排期、取消在播动画。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { createGlintRunner, type GlintRunner } from '../../lib/fx-glint';

const trackEl = ref<HTMLElement | null>(null);
const streakEl = ref<HTMLElement | null>(null);
let runner: GlintRunner | null = null;

onMounted(() => {
  if (!trackEl.value || !streakEl.value) return;
  runner = createGlintRunner({ track: trackEl.value, streak: streakEl.value });
});

onBeforeUnmount(() => {
  runner?.dispose();
  runner = null;
});
</script>

<template>
  <div class="fx-overlay fx-overlay--front fx-glint" aria-hidden="true">
    <div ref="trackEl" class="fx-glint-track" hidden>
      <div ref="streakEl" class="fx-glint-streak" />
    </div>
  </div>
</template>

<style scoped>
/* 与光泽层同层：弹窗开着时只在弹窗框上划（见 lib/fx-glint.ts 的选框规则） */
:root[data-fx='on'] .fx-overlay.fx-glint {
  z-index: 1500;
  --fx-glint-color: rgba(236, 214, 160, 0.5);
}

:root[data-theme='crimson'] .fx-overlay.fx-glint {
  display: none;
}

.fx-glint-track {
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  pointer-events: none;
}

.fx-glint-track[hidden] {
  display: none;
}

.fx-glint-streak {
  opacity: 0;
  will-change: transform, opacity;
  background: linear-gradient(90deg, transparent, var(--fx-glint-color), transparent);
}

.fx-glint-track[data-axis='y'] .fx-glint-streak {
  background: linear-gradient(180deg, transparent, var(--fx-glint-color), transparent);
}

/* 各主题的光色：暗主题用各自金属色，亮主题用压暗一些的强调色（白光在浅底上看不见） */
:root[data-theme='obsidian'] .fx-glint {
  --fx-glint-color: rgba(232, 207, 146, 0.55);
}

:root[data-theme='bronze'] .fx-glint {
  --fx-glint-color: rgba(226, 173, 108, 0.5);
}

:root[data-theme='ocean'] .fx-glint {
  --fx-glint-color: rgba(159, 221, 230, 0.5);
}

:root[data-theme='sakura'] .fx-glint {
  --fx-glint-color: rgba(236, 200, 218, 0.5);
}

:root[data-theme='misty-lilac'] .fx-glint {
  --fx-glint-color: rgba(255, 255, 255, 0.85);
}

:root[data-theme='forest'] .fx-glint {
  --fx-glint-color: rgba(76, 117, 95, 0.45);
}

:root[data-theme='ivory'] .fx-glint {
  --fx-glint-color: rgba(136, 113, 66, 0.45);
}

:root[data-theme='parchment'] .fx-glint {
  --fx-glint-color: rgba(117, 89, 36, 0.4);
}

:root[data-theme='indigo'] .fx-glint {
  --fx-glint-color: rgba(255, 255, 255, 0.85);
}
</style>
