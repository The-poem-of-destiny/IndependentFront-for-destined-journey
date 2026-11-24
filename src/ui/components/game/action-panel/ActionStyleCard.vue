<script setup lang="ts">
/**
 * 行动面板样式 · 打出的牌：把一次行动当成打出的一张牌 ——
 * 左上费用宝石（行动者自身的第一笔**消耗**，回升不算费用；没有就「无费」），牌名与类型线，一句牌面效果，
 * 右侧是受影响单位的小牌，角上一条结论绶带。四种 kind：
 *
 *   - exchange：牌名 = 招式；类型线 = 攻击/治疗/行动 · 单体/群体/自身 · 行动者；
 *               牌面 = 逐目标逐资源的伤害/恢复/削减、闪开 + 宝石以外的自身变化 + 状态；
 *               小牌 = 每个目标的主变化（HP 优先）+ 其余资源小字（失手 / 无证据各有写法）
 *   - roster：标题 + 「场面 · 环境」类型线 + 一排单位小牌（HP 条 + 三项读数）
 *   - outcome：牌名 = 产物（品质色）或动作；牌面 = 结果句 + 经验；小牌 = 检定骰
 *   - generic：牌名 = 标题；牌面 = 前三个关键格
 *
 * 🔴 绶带绝对定位在牌框右上：标题行留出右内边距、目标小牌列下压一截，两者都不会被它压住；
 *    牌框本身在外壳 summary 的 38px 右内边距之内，绶带也就让开了外壳右上角的齿轮。
 *
 * 入场（仅 `entering`）：整张牌发下来（下移 12px + 逆时针 1.5° → 归位，不做 3D 翻面）→
 * 宝石 → 绶带 → 目标小牌依次出现。只动 opacity / transform，`backwards` 填充，
 * 时长缓动取 `--motion-*`；小牌的 `--i` 封顶 STAGGER_INDEX_MAX（entrance-timing.ts），
 * 样式表 entranceMs 盖住最长一段再留余量（算式见 tests/ui/lib/action-panel-styles.test.ts）；减动效下不播。
 * @keyframes 必须留在本组件（scoped 会按组件改名）；共用静态类在 action-panel-base.css。
 */
import { computed } from 'vue';
import type { ActionView, ActionViewTarget } from '../../../lib/action-panel-view';
import type { ResourceDelta } from '../../../lib/action-digest';
import ActionBadge from './ActionBadge.vue';
import ActionGauge from './ActionGauge.vue';
import { staggerStyle } from './entrance-timing';

const props = defineProps<{ view: ActionView; open: boolean; entering: boolean }>();

const ROSTER_RESOURCES = ['hp', 'mp', 'sp'] as const;

function sgn(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '±?';
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
}

function abs(n: number | null): string {
  return n === null || !Number.isFinite(n) ? '?' : String(Math.abs(n));
}

function hasRange(d: ResourceDelta): d is ResourceDelta & { from: number; to: number } {
  return d.from !== undefined && d.to !== undefined;
}

function deltaClass(d: ResourceDelta): string {
  return (d.delta ?? 0) > 0 ? 'up' : 'down';
}

function gaugeMax(d: ResourceDelta & { from: number; to: number }): number {
  return d.max ?? Math.max(d.from, d.to);
}

const verdictTone = computed(() => {
  const tone = props.view.verdict?.tone;
  return tone === 'success' ? 't-ok' : tone === 'error' ? 't-bad' : '';
});

/** 费用宝石：出手方自己的第一笔**消耗**（负的那种）；回升不是费用 */
const cost = computed(() => props.view.ownDeltas.find((d) => (d.delta ?? 0) < 0));

/** 宝石之外的自身变化（自我治疗、额外消耗），写进牌面效果 */
const ownRest = computed(() => props.view.ownDeltas.filter((d) => d !== cost.value));

const actionLabel = computed(() => props.view.action || props.view.title || '行动');

// ── 交锋 ──

const exchangeType = computed(() => {
  const v = props.view;
  const n = v.targets.length;
  const selfHeal = n === 0 && v.ownDeltas.some((d) => (d.delta ?? 0) > 0);
  return [
    v.heal || selfHeal ? '治疗' : n === 0 ? '行动' : '攻击',
    n === 0 ? '自身' : n > 1 ? '群体' : '单体',
    v.actor ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
});

interface Clause {
  name: string;
  /** delta：一笔资源变化；miss：失手；other：没有可写的数字 */
  kind: 'delta' | 'miss' | 'other';
  /** 名字前的介词带尾随空格（「为 」/「对 」），可空 */
  pre?: string;
  /** 名字后的动词（恢复 / 造成 / 削减 / 额外消耗） */
  verb?: string;
  n?: string;
  /** 「点」之后的单位（生命 / 伤害 / MP …） */
  unit?: string;
  cls?: string;
}

function unitOf(d: ResourceDelta, up: boolean): string {
  if (d.resource === 'HP') return up ? '生命' : '伤害';
  return ` ${d.resource}`;
}

function targetClause(name: string, d: ResourceDelta): Clause {
  const up = (d.delta ?? 0) > 0;
  return {
    name,
    kind: 'delta',
    pre: up ? '为 ' : '对 ',
    verb: up ? '恢复' : d.resource === 'HP' ? '造成' : '削减',
    n: abs(d.delta),
    unit: unitOf(d, up),
    cls: deltaClass(d),
  };
}

function ownClause(d: ResourceDelta): Clause {
  const up = (d.delta ?? 0) > 0;
  const name = d.who || props.view.actor || '自身';
  return up
    ? {
        name,
        kind: 'delta',
        pre: '为 ',
        verb: '恢复',
        n: abs(d.delta),
        unit: unitOf(d, true),
        cls: 'up',
      }
    : {
        name,
        kind: 'delta',
        verb: '额外消耗',
        n: abs(d.delta),
        unit: ` ${d.resource}`,
        cls: 'down',
      };
}

function clausesOf(t: ActionViewTarget): Clause[] {
  if (t.deltas.length > 0) return t.deltas.map((d) => targetClause(t.name, d));
  return [{ name: t.name, kind: t.hit === 'miss' ? 'miss' : 'other' }];
}

const clauses = computed(() => [
  ...props.view.targets.flatMap(clausesOf),
  ...ownRest.value.map(ownClause),
]);

/** 目标小牌：主变化 HP 优先，没有就取第一条别的资源；其余逐条写小字 */
function primaryOf(t: ActionViewTarget): ResourceDelta | undefined {
  return t.hp ?? t.deltas[0];
}

const targetCards = computed(() =>
  props.view.targets.map((t) => {
    const p = primaryOf(t);
    return { t, p, rest: t.deltas.filter((d) => d !== p) };
  }),
);

/** 牌面末尾的状态句：目标的带上名字与「获得」，认不出归属的原样 */
const statusSentences = computed(() => [
  ...props.view.targets.flatMap((t) => t.statuses.map((s) => `${t.name} 获得 ${s}`)),
  ...props.view.looseStatuses,
]);

// ── 名册 ──

const rosterNote = computed(() => {
  const fromFacts = props.view.facts.map((c) => c.value).filter(Boolean);
  if (fromFacts.length > 0) return fromFacts.join(' · ');
  const names = props.view.roster.map((u) => u.name);
  return props.view.calc
    .flatMap((s) => s.rows)
    .filter((r) => r.label && !r.wide && !names.some((n) => r.label.startsWith(n)))
    .slice(0, 2)
    .map((r) => r.tokens.map((t) => t.text).join(''))
    .join(' · ');
});

// ── 结算 ──

const outcomeType = computed(() => {
  const o = props.view.outcome;
  const actor = props.view.actor ?? '';
  const parts = o?.product
    ? [`${actionLabel.value === o.product ? '' : actionLabel.value}产物`, o.quality ?? '', actor]
    : ['检定', actor];
  return parts.filter(Boolean).join(' · ');
});

/** 检定骰小牌的说明：`22 对 闪避 14`；没有对抗值就只写合计 */
const rollCaption = computed(() => {
  const r = props.view.outcome?.roll;
  if (!r) return '';
  const total = r.total ?? r.value;
  if (!r.against) return `合计 ${total}`;
  return `${total} 对 ${r.against.label ? `${r.against.label} ` : ''}${r.against.value}`;
});

const genericFacts = computed(() => props.view.facts.slice(0, 3));
</script>

<template>
  <div
    class="cardx"
    :class="[`k-${view.kind}`, { 'is-entering': entering, 'has-rib': !!view.verdict }]"
  >
    <span v-if="view.verdict" class="c10-rib" :class="verdictTone">{{ view.verdict.text }}</span>

    <!-- ── 名册：一排单位小牌 ── -->
    <template v-if="view.kind === 'roster'">
      <div class="c10-tt">
        <strong class="c10-name">{{ view.title || '战况' }}</strong>
      </div>
      <div class="c10-ty">{{ rosterNote ? `场面 · ${rosterNote}` : '场面' }}</div>
      <div class="c10-board">
        <div v-for="(u, i) in view.roster" :key="`u-${i}`" class="c10-u" :style="staggerStyle(i)">
          <ActionBadge :name="u.name" target size="sm" />
          <span class="nm"
            >{{ u.name
            }}<small v-if="u.cluster" class="rng c10-cluster"
              >{{ u.cluster.alive }}/{{ u.cluster.total }}</small
            ></span
          >
          <ActionGauge
            v-if="u.hp"
            :lo="u.hp.cur"
            :hi="u.hp.cur"
            :max="u.hp.max"
            resource="hp"
            :animate="entering"
            class="c10-bar"
          />
          <div class="c10-stat">
            <template v-for="k in ROSTER_RESOURCES" :key="k">
              <template v-if="u[k]">
                <span class="rl" :class="`r-${k}`">{{ k.toUpperCase() }}</span>
                <span class="c10-sv">{{ u[k]!.cur }}/{{ u[k]!.max }}</span>
              </template>
            </template>
          </div>
        </div>
      </div>
    </template>

    <!-- ── 其余三种：宝石 · 牌面 · 小牌 ── -->
    <div v-else class="c10-g">
      <span class="c10-gem" :class="cost ? `r-${cost.resource.toLowerCase()}` : 'is-free'">
        <b class="c10-gem-d"
          ><span class="c10-gem-n">{{ cost ? abs(cost.delta) : '—' }}</span></b
        >
        <small class="c10-gem-l">{{ cost ? cost.resource : '无费' }}</small>
      </span>

      <div class="c10-main">
        <!-- 交锋 -->
        <template v-if="view.kind === 'exchange'">
          <div class="c10-tt">
            <strong class="c10-name">{{ actionLabel }}</strong>
          </div>
          <div class="c10-ty">{{ exchangeType }}</div>
          <div class="c10-tx">
            <template v-for="(c, i) in clauses" :key="`c-${i}`"
              ><template v-if="i > 0">；</template
              ><template v-if="c.kind === 'delta'"
                >{{ c.pre }}<b class="c10-who">{{ c.name }}</b> {{ c.verb }}
                <span class="c10-n" :class="c.cls">{{ c.n }}</span> 点{{ c.unit }}</template
              ><template v-else-if="c.kind === 'miss'"
                ><b class="c10-who">{{ c.name }}</b> <span class="miss">闪开</span></template
              ><template v-else
                >作用于 <b class="c10-who">{{ c.name }}</b></template
              ></template
            ><template v-if="clauses.length > 0">。</template
            ><span v-for="(s, i) in statusSentences" :key="`s-${i}`" class="c10-st">{{ s }}。</span>
          </div>
        </template>

        <!-- 结算 -->
        <template v-else-if="view.kind === 'outcome'">
          <div class="c10-tt">
            <strong
              v-if="view.outcome?.product"
              class="c10-name q c10-prod"
              :style="view.outcome.qualityVar ? { '--qc': view.outcome.qualityVar } : undefined"
              >{{ view.outcome.product }}</strong
            >
            <strong v-else class="c10-name">{{ actionLabel }}</strong>
          </div>
          <div class="c10-ty">{{ outcomeType }}</div>
          <div class="c10-tx">
            <template v-if="view.outcome?.resultText">{{ view.outcome.resultText }}。</template
            ><template v-if="view.outcome?.exp">
              经验 <b class="c10-exp up">{{ view.outcome.exp }}</b
              >。</template
            ><span v-for="(c, i) in ownRest.map(ownClause)" :key="`o-${i}`" class="c10-self"
              >{{ c.pre }}<b class="c10-who">{{ c.name }}</b> {{ c.verb }}
              <span class="c10-n" :class="c.cls">{{ c.n }}</span> 点{{ c.unit }}。</span
            ><span v-for="(s, i) in statusSentences" :key="`s-${i}`" class="c10-st">{{ s }}。</span>
          </div>
        </template>

        <!-- 通用 -->
        <template v-else>
          <div class="c10-tt">
            <strong class="c10-name">{{ view.title || '行动详情' }}</strong>
          </div>
          <div class="c10-ty">行动详情</div>
          <div v-if="genericFacts.length > 0" class="c10-tx">
            <template v-for="(c, i) in genericFacts" :key="`f-${i}`"
              ><template v-if="i > 0">；</template>{{ c.label }}
              <b class="c10-kv">{{ c.value }}</b></template
            >。
          </div>
        </template>
      </div>

      <!-- 小牌列 -->
      <div v-if="view.kind === 'exchange' && view.targets.length > 0" class="c10-tg">
        <div
          v-for="({ t, p, rest }, i) in targetCards"
          :key="`t-${i}`"
          class="c10-u"
          :class="{ 'is-miss': !p && t.hit === 'miss' }"
          :style="staggerStyle(i)"
        >
          <ActionBadge :name="t.name" target />
          <span class="nm">{{ t.name }}</span>
          <template v-if="p">
            <span class="c10-dv" :class="[deltaClass(p), `r-${p.resource.toLowerCase()}`]"
              ><template v-if="p !== t.hp"
                ><span class="rl">{{ p.resource }}</span
                >{{ ' ' }}</template
              >{{ sgn(p.delta) }}</span
            >
            <template v-if="hasRange(p)">
              <ActionGauge
                :lo="Math.min(p.from, p.to)"
                :hi="Math.max(p.from, p.to)"
                :max="gaugeMax(p)"
                :resource="p.resource"
                :dir="(p.delta ?? 0) < 0 ? 'down' : 'up'"
                :animate="entering"
                class="c10-bar"
              />
              <span class="c10-hp">{{ p.to }}/{{ gaugeMax(p) }}</span>
            </template>
          </template>
          <span v-else-if="t.hit === 'miss'" class="c10-dv is-word miss">失手</span>
          <span v-else class="c10-dv is-word c10-none">—</span>
          <span
            v-for="(x, j) in rest"
            :key="`x-${j}`"
            class="c10-mini"
            :class="[deltaClass(x), `r-${x.resource.toLowerCase()}`]"
            ><span class="rl">{{ x.resource }}</span
            >{{ ' ' + sgn(x.delta) }}</span
          >
        </div>
      </div>
      <div v-else-if="view.kind === 'outcome' && view.outcome?.roll" class="c10-tg">
        <div class="c10-u c10-check" :style="{ '--i': 0 }">
          <span class="c10-die" :class="verdictTone"
            ><b class="c10-die-v">{{ view.outcome.roll.value }}</b
            ><small class="c10-die-l">d{{ view.outcome.roll.die }}</small></span
          >
          <span class="c10-hp">{{ rollCaption }}</span>
        </div>
      </div>
    </div>

    <div class="c10-ft">
      <span class="more" :class="{ 'is-open': open }" aria-hidden="true"
        >{{ open ? '收起' : '算式' }}<i class="more-caret"
      /></span>
    </div>
  </div>
</template>

<style scoped src="./action-panel-base.css"></style>

<style scoped>
/* 牌框：主色混边 + 内圈细线（双线牌框），放在外壳 summary 之内 */
.cardx {
  position: relative;
  padding: 10px 12px 6px;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  border-radius: var(--theme-radius-lg);
  background: var(--theme-card-bg);
  box-shadow:
    inset 0 0 0 3px var(--theme-card-bg),
    inset 0 0 0 4px color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
}

/* 结论绶带：右缘贴牌框，左端燕尾 */
.c10-rib {
  --vc: var(--theme-text-secondary);
  position: absolute;
  top: 10px;
  right: -1px;
  max-width: 6rem;
  overflow: hidden;
  padding: 1px 12px 1px 14px;
  border: 1px solid color-mix(in srgb, var(--vc) 45%, var(--theme-card-border));
  border-right: 0;
  background: color-mix(in srgb, var(--vc) 16%, var(--theme-card-bg));
  color: color-mix(in srgb, var(--vc) 80%, var(--theme-text-primary));
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-overflow: ellipsis;
  white-space: nowrap;
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 7px 50%);
}

.c10-g {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 6px 14px;
}

/* 费用宝石 */
.c10-gem {
  --rc: var(--theme-text-muted);
  display: grid;
  justify-items: center;
  gap: 5px;
  width: 2.6rem;
  padding-top: 4px;
}

.c10-gem-d {
  display: grid;
  place-items: center;
  width: 1.9rem;
  height: 1.9rem;
  border: 1.5px solid color-mix(in srgb, var(--rc) 65%, var(--theme-card-border));
  border-radius: 4px;
  background: color-mix(in srgb, var(--rc) 14%, var(--theme-card-bg));
  color: color-mix(in srgb, var(--rc) 65%, var(--theme-text-primary));
  font-size: 0.875rem;
  font-weight: 700;
  transform: rotate(45deg);
}

.c10-gem-n {
  transform: rotate(-45deg);
}

.c10-gem-l {
  margin-top: 2px;
  color: var(--theme-text-muted);
  font-size: 0.625rem;
  letter-spacing: 0.12em;
}

.c10-main {
  min-width: 0;
}

/* 牌名行：有绶带时右侧让出它的宽度 */
.c10-tt {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}

.cardx.has-rib .c10-tt {
  padding-right: 5.5rem;
}

.c10-name {
  font-family: var(--theme-font-title);
  font-size: 1.0625rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  overflow-wrap: anywhere;
}

/* 类型线 */
.c10-ty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 1px 0 5px;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  letter-spacing: 0.14em;
}

.c10-ty::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(
    to right,
    color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border)),
    transparent
  );
}

/* 牌面效果 */
.c10-tx {
  margin: 0;
  color: var(--theme-text-secondary);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.c10-who,
.c10-kv,
.c10-exp {
  font-weight: 600;
}

.c10-who,
.c10-kv {
  color: var(--theme-text-primary);
}

.c10-n {
  font-size: 1rem;
  font-weight: 700;
}

.c10-st {
  margin-left: 2px;
}

/* 小牌列：下压一截，让开右上角的绶带 */
.c10-tg {
  display: flex;
  align-self: end;
  gap: 6px;
  margin-top: 1.75rem;
}

.c10-u {
  display: grid;
  justify-items: center;
  align-content: start;
  gap: 2px;
  width: 4.1rem;
  padding: 6px 4px 5px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-surface-muted);
  text-align: center;
}

.c10-u .nm {
  font-size: 0.75rem;
  line-height: 1.3;
}

.c10-dv {
  font-size: 0.9375rem;
  font-weight: 700;
  line-height: 1.2;
}

.c10-dv.is-word {
  font-size: 0.75rem;
  font-weight: 400;
}

.c10-none {
  color: var(--theme-text-muted);
}

/* 小牌里主变化以外的资源 */
.c10-mini {
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.3;
}

.c10-self {
  margin-left: 2px;
}

.c10-hp {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}

/* 选择器加一层，压过 ActionGauge 自己的 6px 高 */
.c10-u .c10-bar {
  width: 100%;
  height: 3px;
}

.c10-check {
  width: 4.6rem;
}

/* 检定骰 */
.c10-die {
  --vc: var(--theme-hue-check);
  display: grid;
  place-items: center;
  align-content: center;
  width: 1.9rem;
  height: 1.9rem;
  border: 1.5px solid color-mix(in srgb, var(--vc) 60%, var(--theme-card-border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--vc) 9%, var(--theme-card-bg));
  color: color-mix(in srgb, var(--vc) 70%, var(--theme-text-primary));
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--vc) 18%, transparent);
}

.c10-die-v {
  font-size: 0.8rem;
  font-weight: 700;
  line-height: 1;
}

.c10-die-l {
  font-size: 0.5625rem;
  line-height: 1.2;
  letter-spacing: 0.08em;
  opacity: 0.8;
}

/* 名册 */
.c10-board {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.c10-board .c10-u {
  width: 5.2rem;
}

.c10-cluster {
  margin-left: 4px;
  font-family: var(--theme-font-body);
  font-weight: 400;
}

.c10-stat {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 0 4px;
  width: 100%;
  font-size: 0.625rem;
}

.c10-sv {
  color: var(--theme-text-secondary);
  font-size: 0.6875rem;
  text-align: right;
}

.c10-ft {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

@container (max-width: 480px) {
  .c10-g {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .c10-tg {
    flex-wrap: wrap;
    grid-column: 1 / -1;
    margin-top: 0;
  }
}

/* ── 入场：发牌落定 → 宝石 → 绶带 → 小牌依次（最长一段是末张小牌，见文件头） ── */
@keyframes card-deal {
  from {
    opacity: 0;
    transform: translateY(12px) rotate(-1.5deg);
  }
}

@keyframes card-pop {
  from {
    opacity: 0;
    transform: scale(0.6);
  }
}

@keyframes card-slide {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
}

@keyframes card-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

.cardx.is-entering {
  animation: card-deal var(--motion-duration-slow) var(--motion-ease-enter) backwards;
}

.cardx.is-entering .c10-gem-d {
  animation: card-pop var(--motion-duration-base) var(--motion-ease-enter)
    var(--motion-duration-fast) backwards;
}

.cardx.is-entering .c10-rib {
  animation: card-slide var(--motion-duration-base) var(--motion-ease-enter)
    var(--motion-duration-base) backwards;
}

.cardx.is-entering .c10-u {
  animation: card-rise var(--motion-duration-base) var(--motion-ease-enter)
    calc(var(--motion-duration-slow) + var(--i, 0) * var(--motion-stagger-step)) backwards;
}

@media (prefers-reduced-motion: reduce) {
  .cardx.is-entering,
  .cardx.is-entering .c10-gem-d,
  .cardx.is-entering .c10-rib,
  .cardx.is-entering .c10-u {
    animation: none;
  }
}

:root[data-reduced-motion='true'] .cardx.is-entering,
:root[data-reduced-motion='true'] .cardx.is-entering .c10-gem-d,
:root[data-reduced-motion='true'] .cardx.is-entering .c10-rib,
:root[data-reduced-motion='true'] .cardx.is-entering .c10-u {
  animation: none;
}
</style>
