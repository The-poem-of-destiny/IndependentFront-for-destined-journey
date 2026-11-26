<script setup lang="ts">
/**
 * 行动面板样式 · 对决条：左行动者、右目标，中间一道招式箭；
 * 谁打谁、掉了多少，一眼横读完。四种 kind 各一套收起视图：
 *
 *   - exchange：行动者（含全部自身消耗）· 招式箭 + 结论印 · 逐目标 HP 大字 + 其余资源小字 / 失手；
 *     脚注是状态
 *   - roster：标题 + 环境 · 单位格（三条资源条）
 *   - outcome：行动者 · 动作 → 产物（品质色点）+ 结论印 + 结果句；脚注是经验 / 消耗 /
 *     多人结算时逐人的资源变化（带人名）/ 检定骰 / 状态（带归属人名）
 *   - generic：标题 + 前三个关键格
 *
 * 入场（仅 `entering`）：招式箭 scaleX 画出 → 目标行依次升起 → 结论印落定。
 * 只动 opacity / transform，`backwards` 填充，时长缓动取 `--motion-*`；减动效下不播。
 * 🔴 @keyframes 必须留在本组件（scoped 会按组件改名）；共用静态类在 action-panel-base.css。
 */
import type { ActionView, ActionViewTarget } from '../../../lib/action-panel-view';
import type { ResourceDelta } from '../../../lib/action-digest';
import {
  actionLabel,
  deltaClass,
  hasRange,
  ownClass,
  rc,
  rosterNote,
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

defineProps<{ view: ActionView; open: boolean; entering: boolean }>();

const ROSTER_RESOURCES = ['hp', 'mp', 'sp'] as const;

/** 目标身上 HP 以外的变化（MP / SP …），在 HP 大字下面逐条写小字 */
function otherDeltas(t: ActionViewTarget): ResourceDelta[] {
  return t.deltas.filter((d) => d !== t.hp);
}
</script>

<template>
  <div class="duel" :class="[`k-${view.kind}`, { 'is-entering': entering }]">
    <!-- ── 交锋 ── -->
    <template v-if="view.kind === 'exchange'">
      <div class="d1-g">
        <div class="d1-a">
          <ActionBadge v-if="view.actor" :name="view.actor" />
          <span v-if="view.actor" class="nm">{{ view.actor }}</span>
          <span
            v-for="(x, i) in view.ownDeltas"
            :key="`own-${i}`"
            class="sub"
            :class="[ownClass(x), rc(x.resource)]"
            ><span class="rl">{{ x.resource }}</span> <b class="ap-b">{{ sgn(x.delta) }}</b
            ><span v-if="hasRange(x)" class="rng"
              >{{ ' ' + x.from }}<span class="rng-arrow">→</span>{{ x.to }}</span
            ></span
          >
        </div>
        <div class="d1-m">
          <span class="d1-act">{{ actionLabel(view) }}</span>
          <span class="d1-arrow" aria-hidden="true" />
          <span v-if="view.verdict" class="vd d1-seal" :class="verdictTone(view)">{{
            view.verdict.text
          }}</span>
        </div>
        <div class="d1-t">
          <div
            v-for="(t, i) in view.targets"
            :key="`t-${i}`"
            class="d1-row"
            :style="staggerStyle(i)"
          >
            <ActionBadge :name="t.name" target />
            <span class="nm">{{ t.name }}</span>
            <span class="d1-dv">
              <template v-if="t.hp">
                <span class="big" :class="deltaClass(t.hp)">{{ sgn(t.hp.delta) }}</span>
                <span v-if="hasRange(t.hp)" class="rng"
                  ><span class="rl r-hp">HP</span> {{ t.hp.from }}<span class="rng-arrow">→</span
                  >{{ t.hp.to }}</span
                >
              </template>
              <span
                v-for="(x, j) in otherDeltas(t)"
                :key="`x-${j}`"
                class="d1-mini"
                :class="[deltaClass(x), rc(x.resource)]"
                ><span class="rl">{{ x.resource }}</span> <b class="ap-b">{{ sgn(x.delta) }}</b
                ><span v-if="hasRange(x)" class="rng"
                  >{{ ' ' + x.from }}<span class="rng-arrow">→</span>{{ x.to }}</span
                ></span
              >
              <template v-if="t.deltas.length === 0">
                <span v-if="t.hit === 'miss'" class="big miss is-word">失手</span>
                <span v-else class="big muted is-word">—</span>
              </template>
            </span>
          </div>
        </div>
      </div>
      <div class="d1-f">
        <span v-for="(s, i) in statusLines(view)" :key="`st-${i}`" class="d1-st">{{ s }}</span>
        <ActionMoreHint :open="open" />
      </div>
    </template>

    <!-- ── 名册 ── -->
    <template v-else-if="view.kind === 'roster'">
      <div class="d1-head">
        <span class="d1-head-t">{{ view.title || '战况' }}</span>
        <small v-if="rosterNote(view)">{{ rosterNote(view) }}</small>
      </div>
      <ActionViewRoster
        :view="view"
        :classes="{ list: 'd1-units', unit: 'd1-u', cluster: 'd1-cluster' }"
        badge-size="sm"
      >
        <template #unit="{ unit: u }">
          <div class="bars">
            <template v-for="k in ROSTER_RESOURCES" :key="k">
              <template v-if="u[k]">
                <span class="rl" :class="`r-${k}`">{{ k.toUpperCase() }}</span>
                <ActionGauge
                  :lo="u[k]!.cur"
                  :hi="u[k]!.cur"
                  :max="u[k]!.max"
                  :resource="k"
                  :animate="entering"
                />
                <span class="n">{{ u[k]!.cur }}/{{ u[k]!.max }}</span>
              </template>
            </template>
          </div>
        </template>
      </ActionViewRoster>
      <div class="d1-f">
        <ActionMoreHint :open="open" />
      </div>
    </template>

    <!-- ── 结算 ── -->
    <template v-else-if="view.kind === 'outcome'">
      <div class="d1-out">
        <ActionBadge v-if="view.actor" :name="view.actor" />
        <span v-if="view.actor" class="nm">{{ view.actor }}</span>
        <span class="d1-act">{{ actionLabel(view) }}</span>
        <span class="d1-arrow is-short" aria-hidden="true" />
        <template v-if="view.outcome?.product">
          <span
            class="q d1-prod"
            :style="view.outcome.qualityVar ? { '--qc': view.outcome.qualityVar } : undefined"
            >{{ view.outcome.product }}</span
          >
          <span v-if="view.outcome.quality" class="rng">{{ view.outcome.quality }}</span>
        </template>
        <span v-if="view.verdict" class="vd d1-seal" :class="verdictTone(view)">{{
          view.verdict.text
        }}</span>
        <span v-if="view.outcome?.resultText" class="txt">{{ view.outcome.resultText }}</span>
      </div>
      <div class="d1-f">
        <span v-if="view.outcome?.exp" class="d1-st">经验 {{ view.outcome.exp }}</span>
        <span
          v-for="(x, i) in view.ownDeltas"
          :key="`own-${i}`"
          class="d1-cost"
          :class="[ownClass(x), rc(x.resource)]"
          >{{ x.resource }} {{ sgn(x.delta) }}</span
        >
        <span
          v-for="(s, i) in settledDeltas(view)"
          :key="`who-${i}`"
          class="d1-cost d1-who"
          :class="[deltaClass(s.delta), rc(s.delta.resource)]"
          ><span class="nm">{{ s.who }}</span> {{ s.delta.resource }} {{ sgn(s.delta.delta)
          }}<span v-if="hasRange(s.delta)" class="rng"
            >{{ ' ' + s.delta.from }}<span class="rng-arrow">→</span>{{ s.delta.to }}</span
          ></span
        >
        <span v-if="view.outcome?.roll" class="rng">{{ view.outcome.roll.raw }}</span>
        <span v-for="(s, i) in statusLines(view)" :key="`st-${i}`" class="d1-st">{{ s }}</span>
        <ActionMoreHint :open="open" />
      </div>
    </template>

    <!-- ── 通用 ── -->
    <ActionViewGeneric
      v-else
      :view="view"
      :open="open"
      :classes="{
        head: 'd1-head',
        title: 'd1-head-t',
        list: 'd1-kv',
        item: 'd1-kv-item',
        value: 'd1-kv-v',
        foot: 'd1-f',
      }"
    />
  </div>
</template>

<style scoped src="./action-panel-base.css"></style>

<style scoped>
.duel {
  --mono: 'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace;
}

.d1-g {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.25fr);
  align-items: center;
  gap: 6px 14px;
}

.d1-a {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 0 8px;
}

.d1-a .sub {
  grid-column: 2;
  font-size: 0.75rem;
}

.d1-m {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 5.5rem;
}

.d1-act {
  color: var(--theme-primary);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  letter-spacing: 0.08em;
  overflow-wrap: anywhere;
}

.d1-arrow {
  position: relative;
  width: 100%;
  height: 1px;
  background: color-mix(in srgb, var(--theme-primary) 55%, transparent);
  transform-origin: left center;
}

.d1-arrow::after {
  content: '';
  position: absolute;
  top: -3px;
  right: -1px;
  width: 5px;
  height: 7px;
  background: inherit;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

.d1-arrow.is-short {
  flex: none;
  width: 2rem;
}

.d1-t {
  display: grid;
  gap: 5px;
}

.d1-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0 8px;
}

/* 目标的变化列：HP 大字 + 起止，其余资源逐条小字 */
.d1-dv {
  display: grid;
  justify-items: end;
  gap: 1px;
}

.d1-mini {
  font-size: 0.75rem;
  white-space: nowrap;
}

.d1-row .big {
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.1;
  text-align: right;
}

.d1-row .big.is-word {
  font-size: 0.875rem;
  font-weight: 400;
}

.d1-row .big.muted {
  color: var(--theme-text-muted);
}

.d1-row .rng {
  text-align: right;
}

:deep(.d1-f) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--theme-card-border) 70%, transparent);
}

:deep(.d1-f .more) {
  margin-left: auto;
}

.d1-st {
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.d1-st::before {
  content: '◆';
  margin-right: 5px;
  color: var(--theme-warning);
  font-size: 0.5rem;
  vertical-align: 0.2em;
}

.d1-cost {
  font-size: 0.75rem;
}

/* 名册 */
:deep(.d1-head) {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  margin-bottom: 8px;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
}

.d1-head small {
  color: var(--theme-text-muted);
  font-family: var(--theme-font-body);
  font-size: 0.75rem;
  font-weight: 400;
}

.d1-units {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
  gap: 8px 14px;
}

:deep(.d1-u) {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 2px 8px;
}

:deep(.d1-cluster) {
  margin-left: 4px;
  font-family: var(--theme-font-body);
  font-weight: 400;
}

.d1-u .bars {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 2px 6px;
  font-size: 0.6875rem;
}

.d1-u .bars .n {
  color: var(--theme-text-secondary);
  text-align: right;
}

/* 结算 */
.d1-out {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}

.d1-out .txt {
  flex: 1 1 12rem;
  min-width: 0;
  color: var(--theme-text-secondary);
}

/* 通用 */
:deep(.d1-kv) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

:deep(.d1-kv-item) {
  color: var(--theme-text-muted);
}

:deep(.d1-kv-v) {
  margin-left: 6px;
  color: var(--theme-text-primary);
  font-family: var(--mono);
  font-size: 0.75rem;
  font-weight: 600;
}

@container (max-width: 480px) {
  .d1-g {
    grid-template-columns: 1fr;
  }

  .d1-m {
    flex-direction: row;
    justify-content: flex-start;
    gap: 8px;
  }

  .d1-arrow {
    flex: 1;
    width: auto;
  }
}

/*
 * ── 入场：箭画出 → 目标依次升起 → 结论印落定 ──
 * 最长一段 = 结论印 slow 延迟 + base 时长；`--i` 封顶 STAGGER_INDEX_MAX（entrance-timing.ts），
 * 样式表 entranceMs 盖住它再留余量（算式见 tests/ui/lib/action-panel-styles.test.ts）。
 */
@keyframes duel-draw {
  from {
    transform: scaleX(0);
  }
}

@keyframes duel-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

@keyframes duel-seal {
  from {
    opacity: 0;
    transform: scale(1.18);
  }
}

.duel.is-entering .d1-arrow {
  animation: duel-draw var(--motion-duration-base) var(--motion-ease-enter) backwards;
}

.duel.is-entering .d1-row,
.duel.is-entering :deep(.d1-u),
.duel.is-entering .d1-prod,
.duel.is-entering :deep(.d1-kv) {
  animation: duel-rise var(--motion-duration-base) var(--motion-ease-enter)
    calc(var(--motion-duration-fast) + var(--i, 0) * var(--motion-stagger-step)) backwards;
}

.duel.is-entering .d1-seal {
  animation: duel-seal var(--motion-duration-base) var(--motion-ease-enter)
    var(--motion-duration-slow) backwards;
}

@media (prefers-reduced-motion: reduce) {
  .duel.is-entering .d1-arrow,
  .duel.is-entering .d1-row,
  .duel.is-entering :deep(.d1-u),
  .duel.is-entering .d1-prod,
  .duel.is-entering :deep(.d1-kv),
  .duel.is-entering .d1-seal {
    animation: none;
  }
}

:root[data-reduced-motion='true'] .duel.is-entering .d1-arrow,
:root[data-reduced-motion='true'] .duel.is-entering .d1-row,
:root[data-reduced-motion='true'] .duel.is-entering :deep(.d1-u),
:root[data-reduced-motion='true'] .duel.is-entering .d1-prod,
:root[data-reduced-motion='true'] .duel.is-entering :deep(.d1-kv),
:root[data-reduced-motion='true'] .duel.is-entering .d1-seal {
  animation: none;
}
</style>
