<script setup lang="ts">
/**
 * 行动面板样式 · 血条残影：每个受影响的人一条资源条，失去的那截留成斜纹残影，
 * 回复的那截提亮；非战斗换成检定刻度与品质格。四种 kind 各一套收起视图：
 *
 *   - exchange：行动者 ▸ 招式 ▸ 目标 + 结论印；逐目标逐资源一条残影条（失手 / 无变化画虚线槽），
 *     末尾是出手方自己的消耗；脚注是状态
 *   - roster：标题 + 环境 · 每个单位一条 HP 主条，MP / SP 小条
 *   - outcome：行动者 ▸ 动作 + 结论印；d20 对抗检定画成刻度（DC 刻线 + 落点），
 *     制作类画产物与品质格；下方是残影条 —— 多人结算时逐人逐资源一条，再是自身消耗；
 *     交锋与结算共用同一套残影条行与状态脚注
 *   - generic：标题 + 前三个关键格
 *
 * 入场（仅 `entering`）：下降段先被一截同色实心「盖片」挡住 —— 停留 320ms 后 640ms 收拢到新值，
 * 露出斜纹残影（§6.1「资源条数值变化」的同一节拍）；回升段自左 scaleX 0 → 1 长出。
 * 只动 opacity / transform，`backwards` 填充，缓动取 `--motion-*`；减动效下不播。
 * 🔴 @keyframes 必须留在本组件（scoped 会按组件改名）；共用静态类在 action-panel-base.css。
 */
import { computed } from 'vue';
import { RARITY_LEVELS } from '@engine/content/field-enums';
import type { ActionView, ActionViewTarget } from '../../../lib/action-panel-view';
import type { DigestRoll, ResourceDelta } from '../../../lib/action-digest';
import {
  actionLabel,
  deltaClass,
  genericFacts,
  hasRange,
  ownClass,
  rc,
  rosterNote,
  settledDeltas,
  sgn,
  statusLines,
  verdictTone,
  type RangedDelta,
} from '../../../lib/action-style-helpers';
import ActionBadge from './ActionBadge.vue';
import ActionGauge from './ActionGauge.vue';
import ActionMoreHint from './ActionMoreHint.vue';

const props = defineProps<{ view: ActionView; open: boolean; entering: boolean }>();

const MINI_RESOURCES = ['mp', 'sp'] as const;
/** 检定刻度只画 d20 */
const TRACK_DIE = 20;

function pct(value: number, max: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return '0%';
  return `${Math.max(0, Math.min(100, (value / max) * 100)).toFixed(1)}%`;
}

/** 残影条的刻度上限：写了上限用上限，否则以起止里较大的那个为满条 */
function barMax(d: RangedDelta): number {
  return d.max !== undefined && d.max > 0 ? d.max : Math.max(d.from, d.to);
}

function barDir(d: ResourceDelta): 'up' | 'down' {
  return (d.delta ?? 0) > 0 ? 'up' : 'down';
}

/** 盖片：入场时挡住下降段的那截同色实心（起点 = 新值，宽 = 失去的量） */
function coverStyle(d: RangedDelta): Record<string, string> {
  const max = barMax(d);
  const lo = Math.min(d.from, d.to);
  return { left: pct(lo, max), width: pct(Math.abs(d.from - d.to), max) };
}

interface BarRow {
  name: string;
  /** 出手方自己的消耗 */
  own: boolean;
  delta?: ResourceDelta;
  /** 没有资源变化的目标：失手 / 看不出 */
  hit?: ActionViewTarget['hit'];
}

/** 变化量着色：出手方自己的按消耗口径，其余按目标口径 */
function rowClass(row: BarRow, d: ResourceDelta): string {
  return row.own ? ownClass(d) : deltaClass(d);
}

const ownRows = computed<BarRow[]>(() =>
  props.view.ownDeltas.map((delta) => ({
    name: delta.who || props.view.actor || '',
    own: true,
    delta,
  })),
);

/** 交锋：逐目标逐资源一行；没有变化的目标留一行虚线槽；最后是出手方的消耗 */
const exchangeRows = computed<BarRow[]>(() => [
  ...props.view.targets.flatMap((t): BarRow[] =>
    t.deltas.length > 0
      ? t.deltas.map((delta) => ({ name: t.name, own: false, delta }))
      : [{ name: t.name, own: false, hit: t.hit }],
  ),
  ...ownRows.value,
]);

/** 结算：多人结算时逐人逐资源一条（视图把各人放在 targets），最后是出手方自己的消耗 */
const outcomeRows = computed<BarRow[]>(() => [
  ...settledDeltas(props.view).map(({ who, delta }) => ({ name: who, own: false, delta })),
  ...ownRows.value,
]);

const barRows = computed(() =>
  props.view.kind === 'outcome' ? outcomeRows.value : exchangeRows.value,
);

/** 检定刻度：结算的检定骰（退到主掷骰），须是带对抗值的 d20 */
const track = computed(() => {
  const roll: DigestRoll | undefined = props.view.outcome?.roll ?? props.view.roll;
  if (!roll || roll.die !== TRACK_DIE || !roll.against) return null;
  const total = roll.total ?? roll.value;
  const label = `${roll.against.label} ${roll.against.value}`.trim();
  return {
    total,
    label,
    /** 刻度是图形，给读屏一句同义的话：`d20 9 对 难度 14` */
    text: `d${TRACK_DIE} ${total} 对 ${label}`,
    style: {
      '--dc': pct(roll.against.value - 0.5, TRACK_DIE),
      '--at': pct(total - 0.5, TRACK_DIE),
    },
  };
});

/** 品质格：7 级表，点亮到当前档位 */
const qualityPips = computed(() => {
  const rank = props.view.outcome?.qualityRank ?? -1;
  if (rank < 0) return [];
  return RARITY_LEVELS.map((_, i) => i <= rank);
});

const qualityStyle = computed(() =>
  props.view.outcome?.qualityVar ? { '--qc': props.view.outcome.qualityVar } : undefined,
);
</script>

<template>
  <div class="d2" :class="[`k-${view.kind}`, { 'is-entering': entering, 'is-heal': view.heal }]">
    <!-- ── 交锋 / 结算：头行 · （结算）刻度或产物行 · 残影条 · 状态 ── -->
    <template v-if="view.kind === 'exchange' || view.kind === 'outcome'">
      <div class="d2-h">
        <template v-if="view.actor">
          <ActionBadge :name="view.actor" size="sm" />
          <span class="nm">{{ view.actor }}</span>
          <span class="sep" aria-hidden="true">▸</span>
        </template>
        <span class="act">{{ actionLabel(view) }}</span>
        <template v-if="view.kind === 'exchange' && view.targets.length > 0">
          <span class="sep" aria-hidden="true">▸</span>
          <span class="nm d2-tg">{{ view.targets.map((t) => t.name).join('、') }}</span>
        </template>
        <span v-if="view.verdict" class="vd d2-seal" :class="verdictTone(view)">{{
          view.verdict.text
        }}</span>
        <ActionMoreHint :open="open" />
      </div>
      <template v-if="view.kind === 'outcome'">
        <template v-if="track">
          <div class="d2-track" :class="verdictTone(view)" :style="track.style">
            <span class="sr-only">{{ track.text }}</span>
            <span class="dc" aria-hidden="true"
              ><span class="dc-l">{{ track.label }}</span></span
            >
            <span class="pt" aria-hidden="true">{{ track.total }}</span>
          </div>
          <div v-if="view.outcome?.resultText" class="d2-line">
            <span class="txt">{{ view.outcome.resultText }}</span>
          </div>
        </template>
        <div v-else class="d2-line">
          <template v-if="view.outcome?.product">
            <span class="q d2-prod" :style="qualityStyle">{{ view.outcome.product }}</span>
            <span
              v-if="qualityPips.length > 0"
              class="d2-pips"
              :style="qualityStyle"
              role="img"
              :aria-label="`品质 ${view.outcome.quality ?? ''}`"
            >
              <i v-for="(on, i) in qualityPips" :key="`q-${i}`" :class="{ on }" />
            </span>
            <span v-if="view.outcome.quality" class="rng">{{ view.outcome.quality }}</span>
          </template>
          <span v-if="view.outcome?.exp" class="up d2-exp">经验 {{ view.outcome.exp }}</span>
          <span v-if="view.outcome?.roll" class="rng d2-roll">{{ view.outcome.roll.raw }}</span>
          <span v-if="!view.outcome?.product && view.outcome?.resultText" class="txt">{{
            view.outcome.resultText
          }}</span>
        </div>
      </template>
      <div v-if="barRows.length > 0" class="d2-rows" :class="{ 'd2-own': view.kind === 'outcome' }">
        <template v-for="(row, i) in barRows" :key="`r-${i}`">
          <span class="nm d2-who" :class="{ own: row.own }">{{ row.name }}</span>
          <template v-if="row.delta">
            <span class="rl" :class="rc(row.delta.resource)">{{ row.delta.resource }}</span>
            <span v-if="hasRange(row.delta)" class="d2-bar" :class="rc(row.delta.resource)">
              <ActionGauge
                :lo="row.delta.from"
                :hi="row.delta.to"
                :max="barMax(row.delta)"
                :resource="row.delta.resource"
                :dir="barDir(row.delta)"
              />
              <i
                v-if="entering && barDir(row.delta) === 'down'"
                class="d2-cover"
                :style="coverStyle(row.delta)"
                aria-hidden="true"
              />
            </span>
            <span v-else class="dashed" aria-hidden="true" />
            <span class="rng"
              ><template v-if="hasRange(row.delta)"
                >{{ row.delta.from }}<span class="rng-arrow">→</span>{{ row.delta.to }}</template
              ></span
            >
            <span class="dv" :class="[rowClass(row, row.delta), rc(row.delta.resource)]">{{
              sgn(row.delta.delta)
            }}</span>
          </template>
          <template v-else>
            <span class="rl r-hp">HP</span>
            <span class="dashed" aria-hidden="true" />
            <span class="rng">未变</span>
            <span v-if="row.hit === 'miss'" class="dv miss is-word">失手</span>
            <span v-else class="dv muted is-word">—</span>
          </template>
        </template>
      </div>
      <div v-if="statusLines(view).length > 0" class="d2-st">
        <span v-for="(s, i) in statusLines(view)" :key="`st-${i}`">{{ s }}</span>
      </div>
    </template>

    <!-- ── 名册 ── -->
    <template v-else-if="view.kind === 'roster'">
      <div class="d2-h">
        <span class="nm">{{ view.title || '战况' }}</span>
        <small v-if="rosterNote(view)" class="d2-note">{{ rosterNote(view) }}</small>
        <ActionMoreHint :open="open" />
      </div>
      <div class="d2-ros">
        <template v-for="(u, i) in view.roster" :key="`u-${i}`">
          <span class="nm d2-who"
            >{{ u.name
            }}<small v-if="u.cluster" class="rng d2-cluster"
              >{{ u.cluster.alive }}/{{ u.cluster.total }}</small
            ></span
          >
          <template v-if="u.hp">
            <ActionGauge
              :lo="u.hp.cur"
              :hi="u.hp.cur"
              :max="u.hp.max"
              resource="hp"
              :animate="entering"
            />
            <span class="n">{{ u.hp.cur }}/{{ u.hp.max }}</span>
          </template>
          <template v-else>
            <span class="dashed" aria-hidden="true" />
            <span class="n">—</span>
          </template>
          <span class="minis">
            <span v-for="k in MINI_RESOURCES" :key="k" class="mini">
              <template v-if="u[k]">
                <ActionGauge
                  :lo="u[k]!.cur"
                  :hi="u[k]!.cur"
                  :max="u[k]!.max"
                  :resource="k"
                  :animate="entering"
                />
                <span class="mini-n">{{ k.toUpperCase() }} {{ u[k]!.cur }}/{{ u[k]!.max }}</span>
              </template>
            </span>
          </span>
        </template>
      </div>
    </template>

    <!-- ── 通用 ── -->
    <template v-else>
      <div class="d2-h">
        <span class="nm">{{ view.title || '行动详情' }}</span>
        <ActionMoreHint :open="open" />
      </div>
      <div v-if="genericFacts(view).length > 0" class="d2-kv">
        <span v-for="(c, i) in genericFacts(view)" :key="`f-${i}`" class="d2-kv-item"
          ><small class="d2-kv-k">{{ c.label }}</small
          ><b class="d2-kv-v">{{ c.value }}</b></span
        >
      </div>
    </template>
  </div>
</template>

<style scoped src="./action-panel-base.css"></style>

<style scoped>
.d2 {
  --mono: 'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace;
  /* §6.1「资源条数值变化」：残影停留 320ms 后 640ms 追上（文档定值，无对应 token） */
  --d2-hold: 320ms;
  --d2-chase: 640ms;
}

/* 头行：行动者 ▸ 招式 ▸ 目标 + 结论印；展开提示靠右（齿轮的位置由外壳的右内边距让出） */
.d2-h {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin-bottom: 8px;
}

.d2-h .sep {
  color: var(--theme-text-muted);
  font-size: 0.625rem;
}

.d2-h .act {
  color: var(--theme-primary);
  font-family: var(--theme-font-title);
  letter-spacing: 0.06em;
  overflow-wrap: anywhere;
}

.d2-h .more {
  margin-left: auto;
}

.d2-note {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

/* 残影条行：名字 · 资源 · 条 · 起止 · 变化量 */
.d2-rows {
  display: grid;
  grid-template-columns: minmax(3.5em, max-content) 1.6em minmax(0, 1fr) max-content max-content;
  align-items: center;
  gap: 6px 8px;
}

.d2-own {
  margin-top: 8px;
}

.d2-who.own {
  color: var(--theme-text-secondary);
  font-weight: 500;
}

.d2-bar {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: 999px;
}

.d2-bar :deep(.gbar),
.d2-ros :deep(.gbar) {
  height: 8px;
}

/* 盖片：与实心段同色，入场后收拢到新值（静态即收拢完毕，只在入场时挂出） */
.d2-cover {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--rc);
  transform: scaleX(0);
  transform-origin: left center;
}

.dashed {
  display: block;
  height: 8px;
  border: 1px dashed var(--theme-card-border);
  border-radius: 999px;
}

.dv {
  min-width: 2.6em;
  font-size: 0.875rem;
  font-weight: 700;
  text-align: right;
}

.dv.is-word {
  font-size: 0.75rem;
  font-weight: 400;
}

.dv.muted {
  color: var(--theme-text-muted);
}

.d2-st {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  margin-top: 8px;
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.d2-st > span::before {
  content: '＋';
  margin-right: 3px;
  color: var(--theme-warning);
}

/* 名册 */
.d2-ros {
  display: grid;
  grid-template-columns:
    max-content minmax(0, 3fr) max-content minmax(0, 1.2fr)
    minmax(0, 1.2fr);
  align-items: center;
  gap: 6px 8px;
}

.d2-cluster {
  margin-left: 4px;
  font-family: var(--theme-font-body);
  font-weight: 400;
}

.d2-ros .n {
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  text-align: right;
}

.d2-ros .minis {
  display: contents;
}

.d2-ros .mini {
  display: grid;
  gap: 2px;
  color: var(--theme-text-muted);
  font-size: 0.625rem;
}

.d2-ros .mini :deep(.gbar) {
  height: 4px;
}

/* 检定刻度：失败区 | DC 刻线 | 成功区，落点是合计值 */
.d2-track {
  position: relative;
  height: 26px;
  margin: 4px 6px 16px;
}

.d2-track::before {
  content: '';
  position: absolute;
  top: 12px;
  right: 0;
  left: 0;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    color-mix(in srgb, var(--theme-error) 55%, transparent) var(--dc),
    color-mix(in srgb, var(--theme-success) 55%, transparent) var(--dc)
  );
}

.d2-track .dc {
  position: absolute;
  top: 5px;
  left: var(--dc);
  width: 1px;
  height: 16px;
  background: var(--theme-text-secondary);
}

.d2-track .dc-l {
  position: absolute;
  top: 18px;
  left: 0;
  color: var(--theme-text-muted);
  font-size: 0.625rem;
  white-space: nowrap;
  transform: translateX(-50%);
}

.d2-track .pt {
  position: absolute;
  top: 2px;
  left: var(--at);
  display: grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  padding: 0 4px;
  border: 1.5px solid var(--vc, var(--theme-text-secondary));
  border-radius: 999px;
  background: var(--theme-card-bg);
  color: color-mix(in srgb, var(--vc, var(--theme-text-secondary)) 75%, var(--theme-text-primary));
  font-size: 0.75rem;
  font-weight: 700;
  transform: translateX(-50%);
}

/* 制作：产物 + 品质格 */
.d2-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
}

.d2-line .txt {
  flex: 1 1 100%;
  color: var(--theme-text-secondary);
}

.d2-pips {
  display: flex;
  align-items: center;
  gap: 4px;
}

.d2-pips i {
  width: 14px;
  height: 6px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--theme-text-muted) 22%, transparent);
}

.d2-pips i.on {
  background: var(--qc, var(--theme-text-muted));
}

/* 通用 */
.d2-kv {
  display: flex;
  flex-wrap: wrap;
}

.d2-kv-item {
  padding: 0 12px;
  border-left: 1px solid var(--theme-card-border);
}

.d2-kv-item:first-child {
  padding-left: 0;
  border-left: 0;
}

.d2-kv-k {
  display: block;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}

.d2-kv-v {
  font-family: var(--mono);
  font-size: 0.75rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}

@container (max-width: 480px) {
  .d2-rows {
    grid-template-columns: minmax(3em, max-content) 1.6em minmax(0, 1fr) max-content;
  }

  .d2-rows .rng {
    display: none;
  }

  .d2-ros {
    grid-template-columns: max-content minmax(0, 1fr) max-content;
  }

  .d2-ros .minis {
    display: grid;
    grid-column: 2 / -1;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: -3px 0 4px;
  }
}

/*
 * ── 入场：盖片停留后收拢露出残影；回升段自左长出 ──
 * 最长一段 = --d2-hold + --d2-chase；样式表 entranceMs 盖住它再留余量
 * （算式见 tests/ui/lib/action-panel-styles.test.ts）。
 */
@keyframes d2-chase {
  from {
    transform: scaleX(1);
  }
}

@keyframes d2-grow {
  from {
    transform: scaleX(0);
  }
}

.d2.is-entering .d2-cover {
  animation: d2-chase var(--d2-chase) var(--motion-ease-standard) var(--d2-hold) backwards;
}

.d2.is-entering .d2-bar :deep(.gbar[data-dir='up'] .gbar-g) {
  transform-origin: left center;
  animation: d2-grow var(--d2-chase) var(--motion-ease-enter) var(--d2-hold) backwards;
}

@media (prefers-reduced-motion: reduce) {
  .d2.is-entering .d2-cover {
    display: none;
    animation: none;
  }

  .d2.is-entering .d2-bar :deep(.gbar[data-dir='up'] .gbar-g) {
    animation: none;
  }
}

:root[data-reduced-motion='true'] .d2.is-entering .d2-cover {
  display: none;
  animation: none;
}

:root[data-reduced-motion='true'] .d2.is-entering .d2-bar :deep(.gbar[data-dir='up'] .gbar-g) {
  animation: none;
}
</style>
