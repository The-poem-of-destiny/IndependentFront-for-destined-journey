<script setup lang="ts">
/**
 * 行动面板样式 · 跳字舞台：像动作游戏的跳字 —— 伤害数字斜着浮在目标头顶，
 * 暴击更大，失手是一个淡淡的「失手」；其余信息退到最小。四种 kind 各一套收起视图：
 *
 *   - exchange：行动者（头顶浮第一笔自身消耗，其余写在读数下）· 招式箭 · 逐目标大徽章 + 头顶跳字 + 资源条；
 *     跳字是 HP，没有 HP 时是第一条别的资源，其余资源变化写在读数下；跳字的方向另有读屏文字；
 *     单目标时结论写在数字下，多目标时结论进脚注；没打中写「失手」，拿不出证据时浮它身上的状态或「—」
 *   - roster：标题 · 单位徽章 + HP 条与读数
 *   - outcome：斜写的大结论字 · 行动者与动作 · 产物（品质色点）或结果句；脚注是经验 / 检定骰 / 消耗 /
 *     多人结算时逐人的资源变化（带人名）/ 状态
 *   - generic：标题 + 前三个关键格（值在上、标签在下）
 *
 * 入场（仅 `entering`）：数字自下升起放大落定，暴击自 1.25 倍压回，目标间依次错开；失手只淡入。
 * 只动 opacity / transform，`backwards` 填充，时长缓动取 `--motion-*`；减动效下不播。
 * 🔴 入场动画必须挂在 `.is-entering` 下，历史 / 重载的面板保持静止。
 * 🔴 @keyframes 必须留在本组件（scoped 会按组件改名）；共用静态类在 action-panel-base.css。
 */
import { computed } from 'vue';
import type { ActionView, ActionViewTarget } from '../../../lib/action-panel-view';
import type { ResourceDelta } from '../../../lib/action-digest';
import {
  actionLabel,
  deltaClass,
  ownClass,
  primaryOf,
  rc,
  settledDeltas,
  sgn,
  statusLines,
  verdictTone,
} from '../../../lib/action-style-helpers';
import ActionBadge from './ActionBadge.vue';
import ActionGauge from './ActionGauge.vue';
import ActionMoreHint from './ActionMoreHint.vue';
import ActionViewGeneric from './ActionViewGeneric.vue';
import ActionViewRoster from './ActionViewRoster.vue';
import { staggerStyle } from './entrance-timing';

const props = defineProps<{ view: ActionView; open: boolean; entering: boolean }>();

type Gauged = ResourceDelta & { from: number; to: number; max: number };

/** 跳字：伤害只写量（不带负号），回升带「+」 */
function floatNum(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '?';
  return n > 0 ? `+${n}` : String(Math.abs(n));
}

function isGauged(d: ResourceDelta | undefined): d is Gauged {
  return d !== undefined && d.from !== undefined && d.to !== undefined && d.max !== undefined;
}

/** 徽章下的资源条：起止与上限都知道时才画（下降为斜纹残影、回升提亮） */
function gaugeOf(d: ResourceDelta | undefined) {
  if (!isGauged(d)) return null;
  return {
    lo: Math.min(d.from, d.to),
    hi: Math.max(d.from, d.to),
    max: d.max,
    resource: d.resource,
    dir: (d.delta ?? 0) < 0 ? ('down' as const) : ('up' as const),
  };
}

/** 徽章下的读数：`HP 26/72`；不知道上限时只写现值 */
function readout(d: ResourceDelta | undefined): string {
  if (!d || d.to === undefined) return '';
  return d.max !== undefined ? `${d.resource} ${d.to}/${d.max}` : `${d.resource} ${d.to}`;
}

const singleTarget = computed(() => props.view.targets.length === 1);

/** 行动者头顶浮第一笔自身变化，其余逐条写在读数下面 */
const actorCost = computed(() => props.view.ownDeltas[0]);
const actorRest = computed(() => props.view.ownDeltas.slice(1));

/** 主变化以外的资源变化，逐条写在读数下面 */
function restOf(t: ActionViewTarget): ResourceDelta[] {
  const primary = primaryOf(t);
  return t.deltas.filter((d) => d !== primary);
}

/** 跳字只写量、方向靠颜色 —— 给读屏补一句「HP 减少 / 增加」 */
function srDir(d: ResourceDelta): string {
  return `${d.resource} ${(d.delta ?? 0) > 0 ? '增加' : '减少'}`;
}

/** 没有资源变化、也不是失手的目标：头顶浮它的第一条状态 */
function quietFloat(t: ActionViewTarget): string {
  return t.statuses[0] ?? '';
}
</script>

<template>
  <div class="floating" :class="[`k-${view.kind}`, { 'is-entering': entering }]">
    <!-- ── 交锋 ── -->
    <template v-if="view.kind === 'exchange'">
      <div class="f8-st">
        <div v-if="view.actor" class="f8-tk is-actor">
          <span
            v-if="actorCost"
            class="f8-fl sm"
            :class="[ownClass(actorCost), rc(actorCost.resource)]"
            >{{ sgn(actorCost.delta) }} {{ actorCost.resource }}</span
          >
          <ActionBadge :name="view.actor" size="lg" />
          <span class="nm">{{ view.actor }}</span>
          <ActionGauge v-if="gaugeOf(actorCost)" v-bind="gaugeOf(actorCost)!" :animate="entering" />
          <span class="hp">{{ readout(actorCost) || ' ' }}</span>
          <span
            v-for="(x, j) in actorRest"
            :key="`own-${j}`"
            class="f8-sub"
            :class="[ownClass(x), rc(x.resource)]"
            >{{ sgn(x.delta) }} {{ x.resource }}</span
          >
        </div>
        <div class="f8-via">
          <span class="f8-act">{{ actionLabel(view) }}</span>
          <span class="f8-arrow" aria-hidden="true" />
        </div>
        <div
          v-for="(t, i) in view.targets"
          :key="`t-${i}`"
          class="f8-tk is-target"
          :style="staggerStyle(i)"
        >
          <span
            v-if="t.hp"
            class="f8-fl"
            :class="[deltaClass(t.hp), { crit: view.crit && (t.hp.delta ?? 0) < 0 }]"
            ><span class="sr-only">{{ srDir(t.hp) }}</span
            ><span class="f8-num">{{ floatNum(t.hp.delta) }}</span
            ><small v-if="singleTarget && view.verdict" class="f8-vd">{{
              view.verdict.text
            }}</small></span
          >
          <span
            v-else-if="primaryOf(t)"
            class="f8-fl sm f8-res"
            :class="[deltaClass(primaryOf(t)!), rc(primaryOf(t)!.resource)]"
            ><span class="sr-only">{{ srDir(primaryOf(t)!) }}</span
            ><span class="f8-num">{{ floatNum(primaryOf(t)!.delta) }}</span>
            <span class="rl" aria-hidden="true">{{ primaryOf(t)!.resource }}</span></span
          >
          <span v-else-if="t.hit === 'miss'" class="f8-fl miss">失手</span>
          <span v-else-if="quietFloat(t)" class="f8-fl sm f8-quiet">{{ quietFloat(t) }}</span>
          <span v-else class="f8-fl sm f8-none">—</span>
          <ActionBadge :name="t.name" target size="lg" />
          <span class="nm">{{ t.name }}</span>
          <ActionGauge
            v-if="gaugeOf(primaryOf(t))"
            v-bind="gaugeOf(primaryOf(t))!"
            :animate="entering"
          />
          <span class="hp">{{ readout(primaryOf(t)) || ' ' }}</span>
          <span
            v-for="(x, j) in restOf(t)"
            :key="`x-${j}`"
            class="f8-sub"
            :class="[deltaClass(x), rc(x.resource)]"
            >{{ sgn(x.delta) }} {{ x.resource }}</span
          >
        </div>
      </div>
      <div class="f8-ft">
        <span v-if="!singleTarget && view.verdict" class="vd" :class="verdictTone(view)">{{
          view.verdict.text
        }}</span>
        <span v-for="(s, i) in statusLines(view)" :key="`st-${i}`" class="f8-status"
          >＋{{ s }}</span
        >
        <ActionMoreHint :open="open" />
      </div>
    </template>

    <!-- ── 名册 ── -->
    <template v-else-if="view.kind === 'roster'">
      <div class="f8-title">{{ view.title || '战况' }}</div>
      <ActionViewRoster
        :view="view"
        :classes="{ list: 'f8-st is-roster', unit: 'f8-tk', cluster: 'f8-cluster' }"
        badge-size="lg"
      >
        <template #unit="{ unit: u }">
          <template v-if="u.hp">
            <ActionGauge
              :lo="u.hp.cur"
              :hi="u.hp.cur"
              :max="u.hp.max"
              resource="hp"
              :animate="entering"
            />
            <span class="hp">{{ u.hp.cur }}/{{ u.hp.max }}</span>
          </template>
          <span v-else class="hp">{{ ' ' }}</span>
        </template>
      </ActionViewRoster>
      <div class="f8-ft">
        <ActionMoreHint :open="open" />
      </div>
    </template>

    <!-- ── 结算 ── -->
    <template v-else-if="view.kind === 'outcome'">
      <div class="f8-st is-outcome">
        <div v-if="view.verdict" class="f8-word" :class="verdictTone(view)">
          <strong class="f8-word-t">{{ view.verdict.text }}</strong>
        </div>
        <div class="f8-info">
          <span
            ><span v-if="view.actor" class="nm">{{ view.actor }}</span
            ><template v-if="view.actor"> · </template>{{ actionLabel(view) }}</span
          >
          <span v-if="view.outcome?.product"
            ><span
              class="q f8-prod"
              :style="view.outcome.qualityVar ? { '--qc': view.outcome.qualityVar } : undefined"
              >{{ view.outcome.product }}</span
            ><template v-if="view.outcome.quality">
              <span class="rng">{{ view.outcome.quality }}</span></template
            ></span
          >
          <span v-else-if="view.outcome?.resultText" class="txt">{{
            view.outcome.resultText
          }}</span>
        </div>
      </div>
      <div class="f8-ft">
        <span v-if="view.outcome?.exp" class="up f8-exp"
          ><b class="ap-b">{{ view.outcome.exp }}</b> 经验</span
        >
        <span v-if="view.outcome?.roll" class="f8-roll">{{ view.outcome.roll.raw }}</span>
        <span
          v-for="(x, i) in view.ownDeltas"
          :key="`own-${i}`"
          class="f8-cost"
          :class="[ownClass(x), rc(x.resource)]"
          >{{ x.resource }} {{ sgn(x.delta) }}</span
        >
        <span
          v-for="(s, i) in settledDeltas(view)"
          :key="`who-${i}`"
          class="f8-cost f8-who"
          :class="[deltaClass(s.delta), rc(s.delta.resource)]"
          ><span class="nm">{{ s.who }}</span> {{ s.delta.resource }} {{ sgn(s.delta.delta) }}</span
        >
        <span v-for="(s, i) in statusLines(view)" :key="`st-${i}`" class="f8-status"
          >＋{{ s }}</span
        >
        <ActionMoreHint :open="open" />
      </div>
    </template>

    <!-- ── 通用 ── -->
    <ActionViewGeneric
      v-else
      :view="view"
      :open="open"
      :classes="{
        head: 'f8-title',
        list: 'f8-tiles',
        item: 'f8-tile',
        itemTag: 'div',
        label: 'f8-tile-l',
        value: 'f8-tile-v',
        foot: 'f8-ft',
      }"
      value-first
    />
  </div>
</template>

<style scoped src="./action-panel-base.css"></style>

<style scoped>
.floating {
  --mono: 'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace;
  /* 右上角留给样式齿轮 */
  --gear-gap: 38px;
}

/* 舞台：一排大徽章，数字浮在头顶 */
.f8-st {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: center;
  gap: 4px 10px;
  padding-inline: var(--gear-gap);
}

:deep(.f8-tk) {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 2px;
  width: 5.25rem;
  padding-top: 2.5rem;
  text-align: center;
}

:deep(.f8-tk .nm) {
  font-size: 0.8125rem;
  line-height: 1.3;
}

.f8-tk .gbar {
  width: 100%;
  height: 4px;
}

.f8-tk .hp {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  white-space: pre;
}

/* 读数下的其余资源变化 */
.f8-tk .f8-sub {
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.3;
}

:deep(.f8-st.is-roster .f8-tk) {
  padding-top: 0.4rem;
}

:deep(.f8-cluster) {
  margin-left: 4px;
  font-family: var(--theme-font-body);
  font-weight: 400;
}

/* 跳字：位移与倾斜拆成变量，入场关键帧沿用同一组变换函数，免得落定时跳一下 */
.f8-fl {
  --fx: -12%;
  --rot: -4deg;
  position: absolute;
  top: 0.15rem;
  left: 50%;
  display: grid;
  justify-items: start;
  font-family: var(--theme-font-title);
  font-size: 1.5rem;
  font-weight: 900;
  line-height: 1;
  white-space: nowrap;
  transform: translateX(var(--fx)) translateY(0) rotate(var(--rot)) scale(1);
}

.f8-fl.down {
  color: var(--theme-error);
}

.f8-fl.up {
  color: var(--theme-success);
}

.f8-vd {
  margin-top: 1px;
  font-family: var(--theme-font-body);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.f8-fl.crit {
  top: -0.1rem;
  font-size: 1.95rem;
}

.f8-fl.sm {
  --fx: -10%;
  --rot: 0deg;
  top: 1.1rem;
  max-width: 6.5rem;
  overflow: hidden;
  font-size: 0.875rem;
  font-weight: 700;
  text-overflow: ellipsis;
}

/* 没有 HP 时的资源跳字：数字与资源名同一行 */
.f8-fl.f8-res {
  display: flex;
  align-items: baseline;
  gap: 3px;
}

.f8-fl.f8-quiet {
  color: var(--theme-warning);
  font-family: var(--theme-font-body);
  font-size: 0.75rem;
}

.f8-fl.f8-none {
  color: var(--theme-text-muted);
  font-weight: 400;
}

.f8-fl.miss {
  top: 1rem;
  color: var(--theme-text-muted);
  font-size: 0.9375rem;
  font-weight: 600;
  font-style: italic;
}

/* 招式箭 */
.f8-via {
  display: grid;
  align-self: center;
  justify-items: center;
  gap: 3px;
  min-width: 4.5rem;
  padding-top: 1.6rem;
}

.f8-act {
  color: var(--theme-primary);
  font-family: var(--theme-font-title);
  letter-spacing: 0.08em;
  overflow-wrap: anywhere;
}

.f8-arrow {
  position: relative;
  width: 100%;
  height: 1px;
  background: color-mix(in srgb, var(--theme-primary) 55%, transparent);
}

.f8-arrow::after {
  content: '';
  position: absolute;
  top: -3px;
  right: -1px;
  width: 5px;
  height: 7px;
  background: inherit;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

/* 脚注 */
:deep(.f8-ft) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 2px 12px;
  margin-top: 8px;
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

/* 标题（名册 / 通用） */
:deep(.f8-title) {
  margin: 4px 0 6px;
  padding-inline: var(--gear-gap);
  font-family: var(--theme-font-title);
  font-weight: 600;
  text-align: center;
  overflow-wrap: anywhere;
}

/* 结算 */
.f8-st.is-outcome {
  align-items: center;
  gap: 8px 20px;
  padding-top: 10px;
}

.f8-word {
  display: grid;
  justify-items: center;
  gap: 2px;
  min-width: 5rem;
}

.f8-word-t {
  --fx: 0%;
  --rot: -3deg;
  color: color-mix(in srgb, var(--vc, var(--theme-text-primary)) 85%, var(--theme-text-primary));
  font-family: var(--theme-font-title);
  font-size: 1.75rem;
  font-weight: 900;
  line-height: 1.1;
  letter-spacing: 0.1em;
  transform: translateX(var(--fx)) translateY(0) rotate(var(--rot)) scale(1);
}

.f8-info {
  display: grid;
  align-self: center;
  gap: 2px;
  max-width: 18rem;
  text-align: left;
}

.f8-info .txt {
  color: var(--theme-text-secondary);
}

/* 通用 */
:deep(.f8-tiles) {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 22px;
}

:deep(.f8-tile) {
  display: grid;
  justify-items: center;
}

:deep(.f8-tile-v) {
  color: var(--theme-text-primary);
  font-family: var(--mono);
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}

:deep(.f8-tile-l) {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}

@container (max-width: 480px) {
  .f8-st {
    gap: 4px 6px;
    padding-inline: 0;
  }

  /* 窄卡上只给第一排的右侧让出齿轮位 */
  .f8-st:first-child,
  :deep(.f8-title) {
    padding-inline: 0 var(--gear-gap);
  }

  :deep(.f8-tk) {
    width: 4.5rem;
  }

  .f8-via {
    min-width: 3.25rem;
  }

  .f8-fl {
    font-size: 1.3rem;
  }

  .f8-fl.crit {
    font-size: 1.65rem;
  }

  .f8-word-t {
    font-size: 1.5rem;
  }
}

/*
 * ── 入场：数字升起放大落定；暴击自 1.25 倍压回；失手只淡入；目标间依次错开 ──
 * 最长一段 = fast 延迟 + `--i` × 两倍 stagger + slow 时长；`--i` 封顶 STAGGER_INDEX_MAX
 * （entrance-timing.ts），样式表 entranceMs 盖住它再留余量（算式见 tests/ui/lib/action-panel-styles.test.ts）。
 */
@keyframes floating-rise {
  from {
    opacity: 0;
    transform: translateX(var(--fx)) translateY(10px) rotate(var(--rot)) scale(0.85);
  }
}

@keyframes floating-land {
  from {
    opacity: 0;
    transform: translateX(var(--fx)) translateY(0) rotate(var(--rot)) scale(1.25);
  }
}

@keyframes floating-fade {
  from {
    opacity: 0;
  }
}

.floating.is-entering .f8-fl,
.floating.is-entering .f8-word-t {
  animation: floating-rise var(--motion-duration-slow) var(--motion-ease-enter)
    calc(var(--motion-duration-fast) + var(--i, 0) * var(--motion-stagger-step) * 2) backwards;
}

.floating.is-entering .is-actor .f8-fl {
  animation-delay: 0s;
}

.floating.is-entering .f8-fl.crit {
  animation-name: floating-land;
}

.floating.is-entering .f8-fl.miss {
  animation-name: floating-fade;
  animation-timing-function: var(--motion-ease-standard);
}

@media (prefers-reduced-motion: reduce) {
  .floating.is-entering .f8-fl,
  .floating.is-entering .f8-word-t {
    animation: none;
  }
}

:root[data-reduced-motion='true'] .floating.is-entering .f8-fl,
:root[data-reduced-motion='true'] .floating.is-entering .f8-word-t {
  animation: none;
}
</style>
