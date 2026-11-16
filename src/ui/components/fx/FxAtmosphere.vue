<script setup lang="ts">
/**
 * FxAtmosphere — 时段 / 天气 / 战斗氛围层。挂在 FxGameLayer，只读 html 上的 data-fx-* 属性
 *
 * 本组件**没有任何脚本状态**：`useFxGameState` 写 `data-fx-daypart / weather / combat`，
 * 这里的每一层都常驻、默认透明，由属性选择器把对应那层的 opacity 推上去，再靠 transition
 * 交叉淡入 —— 时段切换是「慢慢染上」，不是「啪地换色」。
 *
 * 层级：
 * - 时段染色 / 雾 / 雨：本组件根是 `.game-page-layout` 的直接子元素。三栏的侧栏都有不透明底色
 *   （`--theme-content-bg`），垫在 z -1 会被整个盖住，所以根被拉到 z 2 —— 压在主题强制的
 *   `z-index: 1` 内容之上、仍在 `.game-page-layout` 自己的层叠上下文里（低于 AppModal 与战斗
 *   遮罩）。不吃指针、染色与雾全部遮掉中间 50% 的阅读栏（DESIGN.md：阅读井保持干净）。
 * - 战斗暗角：Teleport 到 body，z 1002 —— 战斗遮罩 1000、它的收起/返回按钮 1001，
 *   暗角在两者之上、Toast（2000）之下；中心完全透明，不挡战斗面板的阅读。
 *
 * 🔴 视口级图层一律不用 `mix-blend-mode` / `backdrop-filter`，也不动大图层的 background-position：
 *    只有 opacity / transform 两种合成器友好的变化。雨丝是静止的，不做常驻循环动画（design.md §6.0）。
 *
 * 特效层约定：叶子节点、`aria-hidden="true"`、`pointer-events: none`（见 styles/fx-core.css）。
 * 只在特效闸门打开时被挂载（父层 v-if），所以这里不再判闸门。
 */
</script>

<template>
  <div class="fx-overlay fx-atmosphere" aria-hidden="true">
    <div class="fx-atmosphere__tint fx-atmosphere__tint--dawn" />
    <div class="fx-atmosphere__tint fx-atmosphere__tint--dusk" />
    <div class="fx-atmosphere__tint fx-atmosphere__tint--night" />
    <div class="fx-atmosphere__fog" />
    <div class="fx-atmosphere__rain">
      <div class="fx-atmosphere__rain-strip fx-atmosphere__rain-strip--left" />
      <div class="fx-atmosphere__rain-strip fx-atmosphere__rain-strip--right" />
    </div>
  </div>
  <Teleport to="body">
    <div class="fx-overlay fx-combat-vignette" aria-hidden="true">
      <div class="fx-combat-vignette__shade" />
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * 根：从 fx-core.css 的「垫底」(z -1) 拉到内容之上。特异度 0,5,1 稳压 fx-core 的 0,4,1。
 * 原因见文件头：侧栏底色不透明，垫底的染色根本看不见。
 */
:root[data-fx='on'] body .game-page-layout > .fx-overlay.fx-atmosphere {
  z-index: 2;
}

.fx-atmosphere__tint,
.fx-atmosphere__fog,
.fx-atmosphere__rain {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 4s var(--motion-ease-standard);
}

/*
 * 时段染色：固定色，黎明 / 黄昏 alpha 0.08、夜晚 0.09（深色 obsidian 上 ≤ 0.05 几乎看不出），
 * 层叠后靠 opacity 交叉淡入。
 * 遮罩把中间阅读栏整列抠掉 —— 三分屏是 25% | 50% | 25%，边缘各留 6% 渐隐，
 * 不让一条硬边落在正文旁边。雾共用同一张遮罩：它上下两条边带横贯整宽，不抠就会压在正文上。
 */
.fx-atmosphere__tint,
.fx-atmosphere__fog {
  -webkit-mask-image: linear-gradient(
    to right,
    #000 0%,
    #000 19%,
    transparent 25%,
    transparent 75%,
    #000 81%,
    #000 100%
  );
  mask-image: linear-gradient(
    to right,
    #000 0%,
    #000 19%,
    transparent 25%,
    transparent 75%,
    #000 81%,
    #000 100%
  );
}
.fx-atmosphere__tint--dawn {
  background: rgba(236, 206, 140, 0.08);
}
.fx-atmosphere__tint--dusk {
  background: rgba(214, 132, 64, 0.08);
}
.fx-atmosphere__tint--night {
  background: rgba(72, 104, 172, 0.09);
}
:root[data-fx-daypart='dawn'] .fx-atmosphere__tint--dawn,
:root[data-fx-daypart='dusk'] .fx-atmosphere__tint--dusk,
:root[data-fx-daypart='night'] .fx-atmosphere__tint--night {
  opacity: 1;
}

/* 雾：只在视口边缘起一层极淡的纱，中间大片完全透明 —— 不起雾霾、不发灰；阅读栏由上面的遮罩抠掉 */
.fx-atmosphere__fog {
  background:
    radial-gradient(
      ellipse 80% 75% at 50% 50%,
      transparent 58%,
      color-mix(in srgb, var(--theme-text-secondary) 6%, transparent) 100%
    ),
    linear-gradient(
      to bottom,
      color-mix(in srgb, var(--theme-text-secondary) 4%, transparent) 0%,
      transparent 14%,
      transparent 86%,
      color-mix(in srgb, var(--theme-text-secondary) 4%, transparent) 100%
    );
}
:root[data-fx-weather='fog'] .fx-atmosphere__fog {
  opacity: 1;
}

/*
 * 雨：只落在两侧栏的静止斜丝。两组不同周期的 repeating-linear-gradient 叠出不均匀的间距，
 * 颜色取主题次级文字色（深浅主题都成立），整体再由 opacity 压到 0.135（原 0.09 的 1.5 倍：
 * 深色主题上 0.09 几乎看不出）。
 * 上下两端用遮罩渐隐，内侧（朝正文那一边）也渐隐。
 */
.fx-atmosphere__rain {
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    #000 18%,
    #000 82%,
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, transparent 0%, #000 18%, #000 82%, transparent 100%);
}
:root[data-fx-weather='rain'] .fx-atmosphere__rain {
  opacity: 0.135;
}
.fx-atmosphere__rain-strip {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 24%;
  background:
    repeating-linear-gradient(
      104deg,
      transparent 0 23px,
      color-mix(in srgb, var(--theme-text-secondary) 70%, transparent) 23px 24px
    ),
    repeating-linear-gradient(
      104deg,
      transparent 0 37px,
      color-mix(in srgb, var(--theme-text-secondary) 45%, transparent) 37px 38px
    );
}
.fx-atmosphere__rain-strip--left {
  left: 0;
  -webkit-mask-image: linear-gradient(to right, #000 70%, transparent 100%);
  mask-image: linear-gradient(to right, #000 70%, transparent 100%);
}
.fx-atmosphere__rain-strip--right {
  right: 0;
  -webkit-mask-image: linear-gradient(to left, #000 70%, transparent 100%);
  mask-image: linear-gradient(to left, #000 70%, transparent 100%);
}

/*
 * 战斗暗角：外层是 fx-overlay（fixed 铺满、contain: strict、overflow 裁切），
 * 内层从 scale(1.25) 收拢到 1、opacity 0 → 0.35，像四角慢慢合拢。中心完全透明。
 * 入场 2.4s 长尾；战斗结束时 1.2s 缓缓退去，不「啪」地消失。
 */
:root[data-fx='on'] .fx-combat-vignette {
  z-index: 1002;
}
.fx-combat-vignette__shade {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse 75% 70% at 50% 50%,
    transparent 52%,
    color-mix(in srgb, color-mix(in srgb, var(--theme-error) 22%, #000) 90%, transparent) 100%
  );
  opacity: 0;
  transform: scale(1.25);
  transition:
    opacity 1.2s var(--motion-ease-standard),
    transform 1.2s var(--motion-ease-standard);
}
:root[data-fx-combat='on'] .fx-combat-vignette__shade {
  opacity: 0.35;
  transform: scale(1);
  transition:
    opacity 2.4s var(--motion-ease-enter),
    transform 2.4s var(--motion-ease-enter);
}

/*
 * 载入存档时属性可能先于本层挂上：没有起点就没有过渡，图层会直接「蹦」到终态。
 * @starting-style 给首帧一个透明起点，让它照样被画出来（不支持的浏览器退化为直接出现）。
 */
@starting-style {
  :root[data-fx-daypart] .fx-atmosphere__tint,
  :root[data-fx-weather] .fx-atmosphere__fog,
  :root[data-fx-weather] .fx-atmosphere__rain {
    opacity: 0;
  }
  :root[data-fx-combat='on'] .fx-combat-vignette__shade {
    opacity: 0;
    transform: scale(1.25);
  }
}
</style>

<style>
/*
 * 全局块（非 scoped）：战斗中把战斗面板的嵌饰色与游戏页的分隔缝慢慢染向 --theme-error。
 *
 * 📌 设计规范的「只动 opacity / transform」有一个**登记在案的例外**：这里过渡的是 border-color ——
 *    颜色不是布局属性，不触发重排；且只在进出战斗时各跑一次，不是常驻动画。
 *
 * 选择器全部挂在 :root[data-fx='on'][data-fx-combat='on'] 下（特异度 ≥ 0,4,0），稳压
 * CombatPanel 的 scoped `.combat-panel[data-v]`（0,2,0）。只覆盖变量与每块面板「朝内的那一条缝」，
 * 不改主题的其它边。
 */
:root[data-fx='on'] .combat-panel {
  transition: border-color 2.4s var(--motion-ease-standard);
}
:root[data-fx='on'][data-fx-combat='on'] .combat-panel {
  --combat-inlay: color-mix(
    in srgb,
    var(--theme-error) 42%,
    color-mix(in srgb, var(--theme-primary) 38%, var(--theme-card-border))
  );
}

:root[data-fx='on'] body .game-page-layout .top-bar,
:root[data-fx='on'] body .game-page-layout .side-toolbar,
:root[data-fx='on'] body .game-page-layout .scene-panel,
:root[data-fx='on'] body .game-page-layout .status-hud {
  transition: border-color 2.4s var(--motion-ease-standard);
}
:root[data-fx='on'][data-fx-combat='on'] body .game-page-layout .top-bar {
  border-bottom-color: color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
}
:root[data-fx='on'][data-fx-combat='on'] body .game-page-layout .side-toolbar,
:root[data-fx='on'][data-fx-combat='on'] body .game-page-layout .scene-panel {
  border-right-color: color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
}
:root[data-fx='on'][data-fx-combat='on'] body .game-page-layout .status-hud {
  border-left-color: color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
}

/*
 * 雨天里，控件上的光泽高光（T2 的 .fx-sheen-puck）带一点极细的斜向条纹：
 * 遮罩在 100% / 78% 透明度之间交替，像玻璃上挂着水丝，而不是另画一层雨。
 */
:root[data-fx='on'][data-fx-weather='rain'] .fx-sheen-puck {
  -webkit-mask-image: repeating-linear-gradient(104deg, #000 0 5px, rgba(0, 0, 0, 0.78) 5px 6px);
  mask-image: repeating-linear-gradient(104deg, #000 0 5px, rgba(0, 0, 0, 0.78) 5px 6px);
}
</style>
