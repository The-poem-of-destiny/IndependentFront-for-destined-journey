<script setup lang="ts">
/**
 * 行动面板样式 · 战报行：老式 RPG 的战斗消息窗，双线框里一行一件事 ——
 * 「艾琳 使出了 裂风斩！」「灰狼 受到 34 点伤害。」，数字着色，HP 起止靠右对齐。
 *
 *   - exchange：使出了（首行）· 逐目标 受到伤害 / 恢复生命 / 闪开 / 受到影响 · 其余资源 · 状态 ·
 *     自身变化（负的写「消耗」，正的写「恢复了」）
 *   - roster：标题 + 环境（首行）· 每个单位一行三格读数
 *   - outcome：尝试（首行）· 掷骰 · 结论 + 产物 / 结果句 · 经验 · 状态 · 消耗
 *   - generic：标题（首行）· 前三个关键格
 *
 * 所有行收成一张 `lines` 表，模板按 `t` 分派；全程文本插值。
 * 入场（仅 `entering`）：各行依次淡入并右移 4px 落定，间隔 140ms，只排前 8 行（之后的与第 8 行同时出现）。
 * 不做打字机。只动 opacity / transform，`backwards` 填充，缓动取 `--motion-*`；减动效下不播。
 * 🔴 @keyframes 必须留在本组件（scoped 会按组件改名）；共用静态类在 action-panel-base.css。
 */
import { computed } from 'vue';
import type { ActionView } from '../../../lib/action-panel-view';
import type { ResourceDelta, RosterUnit } from '../../../lib/action-digest';

const props = defineProps<{ view: ActionView; open: boolean; entering: boolean }>();

/** 入场只交错排前几行 */
const STAGGER_MAX = 8;
const ROSTER_RESOURCES = ['hp', 'mp', 'sp'] as const;

type Tone = '' | 't-ok' | 't-bad';

type Line =
  | { t: 'use'; actor?: string; action: string; meta: string; tone: Tone }
  | { t: 'hit' | 'heal'; name: string; amount: string; cry: string; tone: Tone; meta: string }
  | { t: 'miss'; name: string }
  | { t: 'touched'; name: string }
  | { t: 'delta'; name: string; resource: string; amount: string; meta: string; dir: string }
  | { t: 'status'; text: string }
  | { t: 'cost' | 'gain'; name: string; resource: string; amount: string; meta: string }
  | { t: 'title'; text: string; meta: string }
  | { t: 'unit'; unit: RosterUnit }
  | { t: 'try'; actor?: string; action: string }
  | { t: 'roll'; raw: string }
  | {
      t: 'result';
      cry: string;
      tone: Tone;
      product?: string;
      quality?: string;
      qv?: string;
      text?: string;
    }
  | { t: 'exp'; amount: string }
  | { t: 'fact'; label: string; value: string };

function sgn(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '±?';
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
}

function abs(n: number | null): string {
  return n === null || !Number.isFinite(n) ? '?' : String(Math.abs(n));
}

/** 行尾小字：有起止写 `HP 60→26`，否则写变化量 */
function rangeMeta(d: ResourceDelta): string {
  return d.from !== undefined && d.to !== undefined
    ? `${d.resource} ${d.from}→${d.to}`
    : `${d.resource} ${sgn(d.delta)}`;
}

function rc(resource: string): string {
  return `r-${resource.toLowerCase()}`;
}

const tone = computed<Tone>(() => {
  const t = props.view.verdict?.tone;
  return t === 'success' ? 't-ok' : t === 'error' ? 't-bad' : '';
});

const actionLabel = computed(() => props.view.action || props.view.title || '行动');

/** 出手方自己的变化：负的是消耗，正的（自我治疗、回蓝）是恢复 */
function costLines(v: ActionView): Line[] {
  return v.ownDeltas.map((x) => ({
    t: (x.delta ?? 0) > 0 ? 'gain' : 'cost',
    name: x.who || v.actor || '',
    resource: x.resource,
    amount: abs(x.delta),
    meta: rangeMeta(x),
  }));
}

function exchangeLines(v: ActionView): Line[] {
  const out: Line[] = [];
  const single = v.targets.length === 1;
  const verdictText = v.verdict?.text ?? '';
  // 单目标：结论喊在伤害行开头；多目标 / 无目标：结论挂在首行行尾
  out.push({
    t: 'use',
    actor: v.actor,
    action: actionLabel.value,
    meta: single ? '' : verdictText,
    tone: tone.value,
  });
  for (const tg of v.targets) {
    if (tg.hp) {
      const heal = (tg.hp.delta ?? 0) > 0;
      out.push({
        t: heal ? 'heal' : 'hit',
        name: tg.name,
        amount: abs(tg.hp.delta),
        cry: single ? verdictText : '',
        tone: tone.value,
        meta: rangeMeta(tg.hp),
      });
    } else if (tg.hit === 'miss') {
      out.push({ t: 'miss', name: tg.name });
    } else if (tg.deltas.length === 0 && tg.statuses.length === 0) {
      // 没有数字也没有状态（威吓、标记之类）：至少说一句它被波及，不让目标在战报里消失
      out.push({ t: 'touched', name: tg.name });
    }
    for (const x of tg.deltas) {
      if (x.resource === 'HP') continue;
      out.push({
        t: 'delta',
        name: tg.name,
        resource: x.resource,
        amount: abs(x.delta),
        meta: rangeMeta(x),
        dir: (x.delta ?? 0) > 0 ? 'up' : 'down',
      });
    }
  }
  for (const tg of v.targets) {
    for (const s of tg.statuses) out.push({ t: 'status', text: `${tg.name} ${s}` });
  }
  for (const s of v.looseStatuses) out.push({ t: 'status', text: s });
  out.push(...costLines(v));
  return out;
}

/** 名册标题旁的小字：摘要的关键格优先；没给时取算式区里不属于任何单位的短行，至多两条 */
function rosterNote(v: ActionView): string {
  const fromFacts = v.facts.map((c) => c.value).filter(Boolean);
  if (fromFacts.length > 0) return fromFacts.join(' · ');
  const names = v.roster.map((u) => u.name);
  return v.calc
    .flatMap((s) => s.rows)
    .filter((r) => r.label && !r.wide && !names.some((n) => r.label.startsWith(n)))
    .slice(0, 2)
    .map((r) => r.tokens.map((t) => t.text).join(''))
    .join(' · ');
}

function outcomeLines(v: ActionView): Line[] {
  const o = v.outcome;
  const out: Line[] = [{ t: 'try', actor: v.actor, action: actionLabel.value }];
  if (o?.roll) out.push({ t: 'roll', raw: o.roll.raw });
  const verdictText = v.verdict?.text ?? '';
  if (o?.product) {
    out.push({
      t: 'result',
      cry: verdictText,
      tone: tone.value,
      product: o.product,
      quality: o.quality,
      qv: o.qualityVar,
    });
  } else if (verdictText || o?.resultText) {
    out.push({ t: 'result', cry: verdictText, tone: tone.value, text: o?.resultText });
  }
  if (o?.exp) out.push({ t: 'exp', amount: o.exp.replace(/^\+/, '') });
  for (const tg of v.targets) {
    for (const s of tg.statuses) out.push({ t: 'status', text: `${tg.name} ${s}` });
  }
  for (const s of v.looseStatuses) out.push({ t: 'status', text: s });
  out.push(...costLines(v));
  return out;
}

const lines = computed<Line[]>(() => {
  const v = props.view;
  if (v.kind === 'exchange') return exchangeLines(v);
  if (v.kind === 'outcome') return outcomeLines(v);
  if (v.kind === 'roster') {
    return [
      { t: 'title', text: v.title || '战况', meta: rosterNote(v) },
      ...v.roster.map((unit): Line => ({ t: 'unit', unit })),
    ];
  }
  return [
    { t: 'title', text: v.title || '行动详情', meta: '' },
    ...v.facts.slice(0, 3).map((c): Line => ({ t: 'fact', label: c.label, value: c.value })),
  ];
});

/** 首行（使出了 / 尝试 / 标题）带 ▸；旁白类压暗 */
const LEAD = new Set<Line['t']>(['use', 'try', 'title']);
const DIM = new Set<Line['t']>([
  'miss',
  'touched',
  'delta',
  'status',
  'cost',
  'gain',
  'roll',
  'exp',
  'fact',
]);

function lineClass(l: Line): string[] {
  return [`l-${l.t}`, LEAD.has(l.t) ? 'lead' : '', DIM.has(l.t) ? 'dim' : ''];
}

function stagger(i: number): Record<string, number> {
  return { '--i': Math.min(i, STAGGER_MAX - 1) };
}
</script>

<template>
  <div class="blog" :class="[`k-${view.kind}`, { 'is-entering': entering }]">
    <div
      v-for="(l, i) in lines"
      :key="`l-${i}`"
      class="bl-l"
      :class="lineClass(l)"
      :style="stagger(i)"
    >
      <!-- 交锋 -->
      <template v-if="l.t === 'use'">
        <span class="bl-tx"
          ><template v-if="l.actor"
            ><b class="nm">{{ l.actor }}</b> 使出了 </template
          ><em class="bl-act">{{ l.action }}</em
          >！</span
        >
        <span class="m"
          ><span v-if="l.meta" class="bl-cry" :class="l.tone">{{ l.meta }}</span></span
        >
      </template>
      <template v-else-if="l.t === 'hit' || l.t === 'heal'">
        <span class="bl-tx"
          ><span v-if="l.cry" class="bl-cry" :class="l.tone">{{ l.cry }}！</span
          ><span class="nm">{{ l.name }}</span
          ><template v-if="l.t === 'hit'">
            受到 <span class="n down">{{ l.amount }}</span> 点伤害。</template
          ><template v-else>
            恢复了 <span class="n up">{{ l.amount }}</span> 点生命。</template
          ></span
        >
        <span class="m">{{ l.meta }}</span>
      </template>
      <template v-else-if="l.t === 'miss'">
        <span class="bl-tx"
          ><span class="nm">{{ l.name }}</span> 闪开了攻击。</span
        >
        <span class="m miss">失手</span>
      </template>
      <template v-else-if="l.t === 'touched'">
        <span class="bl-tx"
          ><span class="nm">{{ l.name }}</span> 受到影响。</span
        >
        <span class="m" />
      </template>
      <template v-else-if="l.t === 'delta'">
        <span class="bl-tx"
          ><span class="nm">{{ l.name }}</span> 的 {{ l.resource }}
          {{ l.dir === 'up' ? '回复' : '减少' }}
          <span class="n" :class="l.dir">{{ l.amount }}</span> 点。</span
        >
        <span class="m">{{ l.meta }}</span>
      </template>
      <template v-else-if="l.t === 'status'">
        <span class="bl-tx">{{ l.text }}。</span>
        <span class="m" />
      </template>
      <template v-else-if="l.t === 'cost'">
        <span class="bl-tx"
          ><span v-if="l.name" class="nm">{{ l.name }}</span> 消耗
          <span class="cost" :class="rc(l.resource)"
            ><b class="ap-b">{{ l.amount }}</b> {{ l.resource }}</span
          >。</span
        >
        <span class="m">{{ l.meta }}</span>
      </template>
      <template v-else-if="l.t === 'gain'">
        <span class="bl-tx"
          ><span v-if="l.name" class="nm">{{ l.name }}</span> 恢复了
          <span class="n up">{{ l.amount }}</span> 点 {{ l.resource }}。</span
        >
        <span class="m">{{ l.meta }}</span>
      </template>

      <!-- 名册 / 通用的标题 -->
      <template v-else-if="l.t === 'title'">
        <span class="bl-tx"
          ><b class="bl-title">{{ l.text }}</b></span
        >
        <span class="m">{{ l.meta }}</span>
      </template>
      <template v-else-if="l.t === 'unit'">
        <span class="bl-unit">
          <span class="nm"
            >{{ l.unit.name
            }}<small v-if="l.unit.cluster" class="rng bl-cluster"
              >{{ l.unit.cluster.alive }}/{{ l.unit.cluster.total }}</small
            ></span
          >
          <span v-for="k in ROSTER_RESOURCES" :key="k" class="c"
            ><template v-if="l.unit[k]"
              ><span class="rl" :class="`r-${k}`">{{ k.toUpperCase() }}</span
              >{{ l.unit[k]!.cur }}<i>/{{ l.unit[k]!.max }}</i></template
            ></span
          >
        </span>
      </template>

      <!-- 结算 -->
      <template v-else-if="l.t === 'try'">
        <span class="bl-tx"
          ><b v-if="l.actor" class="nm">{{ l.actor }}</b> 尝试 <em class="bl-act">{{ l.action }}</em
          >……</span
        >
        <span class="m" />
      </template>
      <template v-else-if="l.t === 'roll'">
        <span class="bl-tx"
          >掷骰 <span class="bl-roll">{{ l.raw }}</span></span
        >
        <span class="m" />
      </template>
      <template v-else-if="l.t === 'result'">
        <span class="bl-tx"
          ><span v-if="l.cry" class="bl-cry" :class="l.tone">{{ l.cry }}！</span
          ><template v-if="l.product"
            >获得
            <span class="q bl-prod" :style="l.qv ? { '--qc': l.qv } : undefined">{{
              l.product
            }}</span
            ><template v-if="l.quality">（{{ l.quality }}）</template>。</template
          ><template v-else-if="l.text">{{ l.text }}。</template></span
        >
        <span class="m" />
      </template>
      <template v-else-if="l.t === 'exp'">
        <span class="bl-tx"
          >获得
          <span class="up"
            ><b class="ap-b">{{ l.amount }}</b></span
          >
          点经验。</span
        >
        <span class="m" />
      </template>

      <!-- 通用 -->
      <template v-else-if="l.t === 'fact'">
        <span class="bl-tx">{{ l.label }}</span>
        <span class="m">{{ l.value }}</span>
      </template>
    </div>
    <div class="bl-more" :style="stagger(lines.length - 1)">
      <span class="more" :class="{ 'is-open': open }" aria-hidden="true"
        >{{ open ? '收起' : '算式' }}<i class="more-caret"
      /></span>
    </div>
  </div>
</template>

<style scoped src="./action-panel-base.css"></style>

<style scoped>
/* 消息窗：外细线 + 隔一道底色 + 内细线，像老式 RPG 的对话框（齿轮在框外，摘要右侧已留 38px） */
.blog {
  --mono: 'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace;
  --bl-bg: color-mix(in srgb, var(--theme-window-bg) 55%, var(--theme-card-bg));
  --bl-step: 140ms;
  padding: 9px 14px 7px;
  background: var(--bl-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow:
    inset 0 0 0 3px var(--bl-bg),
    inset 0 0 0 4px color-mix(in srgb, var(--theme-primary) 35%, var(--theme-card-border));
}

.bl-l {
  display: grid;
  grid-template-columns: 1em minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 0 6px;
  line-height: 1.75;
}

.bl-l::before {
  content: '';
}

.bl-l.lead::before {
  content: '▸';
  color: var(--theme-primary);
  font-size: 0.75rem;
}

.bl-l.dim {
  color: var(--theme-text-secondary);
}

.bl-tx {
  min-width: 0;
  overflow-wrap: anywhere;
}

.m {
  color: var(--theme-text-muted);
  font-family: var(--mono);
  font-size: 0.75rem;
  text-align: right;
  white-space: nowrap;
}

.bl-act {
  color: var(--theme-primary);
  font-family: var(--theme-font-title);
  font-style: normal;
}

.bl-title {
  font-family: var(--theme-font-title);
  font-weight: 600;
}

.n {
  font-size: 0.9375rem;
  font-weight: 700;
}

.bl-cry {
  margin-right: 4px;
  font-family: var(--theme-font-body);
  font-weight: 700;
  color: color-mix(in srgb, var(--vc, var(--theme-primary)) 80%, var(--theme-text-primary));
}

.m .bl-cry {
  margin-right: 0;
}

.bl-roll {
  font-family: var(--mono);
  font-size: 0.75rem;
}

/* 名册：名字 + 三格读数，各单位一行 */
.bl-unit {
  display: grid;
  grid-column: 2 / -1;
  grid-template-columns: minmax(0, 1fr) repeat(3, 5.5rem);
  align-items: baseline;
  gap: 0 14px;
}

.bl-cluster {
  margin-left: 4px;
  font-family: var(--theme-font-body);
  font-weight: 400;
}

.bl-unit .c {
  font-family: var(--mono);
  font-size: 0.75rem;
  white-space: nowrap;
}

.bl-unit .c .rl {
  margin-right: 4px;
}

.bl-unit .c i {
  color: var(--theme-text-muted);
  font-style: normal;
}

.bl-more {
  display: flex;
  justify-content: flex-end;
  margin-top: 2px;
}

@container (max-width: 480px) {
  .blog {
    padding: 8px 10px 6px;
  }

  .bl-l {
    grid-template-columns: 0.8em minmax(0, 1fr) auto;
    gap: 0 4px;
  }

  .bl-unit {
    grid-template-columns: repeat(3, max-content);
    gap: 0 12px;
  }

  .bl-unit .nm {
    grid-column: 1 / -1;
    margin-top: 2px;
  }
}

/* ── 入场：逐行淡入落定，间隔 140ms，前 8 行交错（--i 已在模板里封顶） ── */
@keyframes blog-line {
  from {
    opacity: 0;
    transform: translateX(-4px);
  }
}

.blog.is-entering .bl-l,
.blog.is-entering .bl-more {
  animation: blog-line var(--motion-duration-base) var(--motion-ease-enter)
    calc(var(--i, 0) * var(--bl-step)) backwards;
}

@media (prefers-reduced-motion: reduce) {
  .blog.is-entering .bl-l,
  .blog.is-entering .bl-more {
    animation: none;
  }
}

:root[data-reduced-motion='true'] .blog.is-entering .bl-l,
:root[data-reduced-motion='true'] .blog.is-entering .bl-more {
  animation: none;
}
</style>
