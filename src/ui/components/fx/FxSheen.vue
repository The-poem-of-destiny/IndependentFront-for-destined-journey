<script setup lang="ts">
/**
 * FxSheen — 指针光泽层。挂在 FxLayer，应用级覆盖层
 *
 * 一个 `.fx-sheen-puck` 盖在悬停的控件上，里面一团跟随指针的径向高光（峰值 alpha ≤ 0.15）；
 * 一个 `.fx-sheen-ring` 盖在包住该控件的面板框上，遮罩成 2px 描边环，同样随指针亮一小段。
 * 叙事流与回合账本里的东西一律不加（判定在 lib/fx-sheen.ts）。
 *
 * 性能：矩形只在进入控件时量；高光位置只写到 puck / ring 自己身上，经 fx-ticker 合帧；
 * 指针不动零 rAF，从不写 html / body。卸载时摘掉全部监听。
 *
 * 色调来自 `--fx-sheen-color`，按主题在下方样式里设在本层根元素上（不写到 :root）。
 * 🔴 `.fx-sheen-puck` 类名是契约：T6 会在 `[data-fx-weather='rain']` 下给它叠雨痕遮罩。
 *
 * 特效层约定：叶子节点、`aria-hidden="true"`、`pointer-events: none`（见 styles/fx-core.css）。
 * 只在特效闸门打开时被挂载（父层 v-if），所以这里不再判闸门。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { createSheenController, type SheenController } from '../../lib/fx-sheen';

const puckEl = ref<HTMLElement | null>(null);
const ringEl = ref<HTMLElement | null>(null);
let controller: SheenController | null = null;

onMounted(() => {
  if (!puckEl.value || !ringEl.value) return;
  controller = createSheenController(puckEl.value, ringEl.value);
});

onBeforeUnmount(() => {
  controller?.dispose();
  controller = null;
});
</script>

<template>
  <div class="fx-overlay fx-overlay--front fx-sheen" aria-hidden="true">
    <div ref="ringEl" class="fx-sheen-ring" />
    <div ref="puckEl" class="fx-sheen-puck" />
  </div>
</template>

<style scoped>
/*
 * 层级：压在 AppModal（1000）之上、Toast（2000）之下 —— 弹窗里的控件也要得到光泽。
 * 本层只在悬停控件的矩形内绘制、不吃指针，所以盖在弹窗上不会挡任何东西。
 */
:root[data-fx='on'] .fx-overlay.fx-sheen {
  z-index: 1500;
  --fx-sheen-color: #f4ead2;
}

.fx-sheen-puck,
.fx-sheen-ring {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-duration-fast, 150ms) var(--motion-ease-standard, ease);
}

.fx-sheen-puck.is-active,
.fx-sheen-ring.is-active {
  opacity: 1;
  transition-duration: var(--motion-duration-base, 240ms);
}

/* 控件内的跟随高光：峰值 15%，边缘完全透明，不铺满整颗按钮
   （2026-11-16 由 10% 上调：深色主题下原值看不出来） */
.fx-sheen-puck {
  overflow: hidden;
  background: radial-gradient(
    circle 72px at var(--fx-sheen-x, 50%) var(--fx-sheen-y, 50%),
    color-mix(in srgb, var(--fx-sheen-color) 15%, transparent) 0%,
    color-mix(in srgb, var(--fx-sheen-color) 6%, transparent) 45%,
    transparent 100%
  );
}

/* 面板框的 2px 描边环：只在指针附近一段被点亮（峰值 30%，2026-11-16 由 22% 上调） */
.fx-sheen-ring {
  box-sizing: border-box;
  padding: 2px;
  background: radial-gradient(
    circle 140px at var(--fx-sheen-x, 50%) var(--fx-sheen-y, 50%),
    color-mix(in srgb, var(--fx-sheen-color) 30%, transparent) 0%,
    transparent 100%
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box exclude,
    linear-gradient(#000 0 0);
}

/* 各主题的光泽色：取各自的金属 / 釉色，暗主题偏暖亮，亮主题取近白的冷暖 */
:root[data-theme='obsidian'] .fx-sheen {
  --fx-sheen-color: #e8cf92;
}

:root[data-theme='bronze'] .fx-sheen {
  --fx-sheen-color: #e2ad6c;
}

:root[data-theme='ocean'] .fx-sheen {
  --fx-sheen-color: #9fdde6;
}

:root[data-theme='misty-lilac'] .fx-sheen {
  --fx-sheen-color: #f7faff;
}

:root[data-theme='forest'] .fx-sheen {
  --fx-sheen-color: #f2fbef;
}

:root[data-theme='ivory'] .fx-sheen {
  --fx-sheen-color: #fff8e4;
}

:root[data-theme='crimson'] .fx-sheen {
  --fx-sheen-color: #f1dccf;
}

:root[data-theme='sakura'] .fx-sheen {
  --fx-sheen-color: #f4dce8;
}

:root[data-theme='parchment'] .fx-sheen {
  --fx-sheen-color: #fff6df;
}

:root[data-theme='indigo'] .fx-sheen {
  --fx-sheen-color: #f4f8ff;
}
</style>
