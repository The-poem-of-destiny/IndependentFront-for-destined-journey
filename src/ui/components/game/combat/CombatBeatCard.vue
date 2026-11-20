<script setup lang="ts">
/**
 * CombatBeatCard — 直出正文战斗的「一拍」：一名角色的一次行为。
 *
 * 数据来自 `parseCombatBeat`（`<action_info>` 固定行），全是模型自述的文字，
 * 这里只排版不解释数值。头像走脸位链（头像 → 立绘 → 立绘bg）；没有素材的
 * 名字（临时敌人、未建档角色）交还插槽，显示名字首字题签。
 */
import { computed } from 'vue';
import { ASSET_TYPE_AVATAR_CHAIN } from '@engine/assets/asset-resolve';
import AssetMedia from '../../shared/AssetMedia.vue';
import type { CombatBeat } from './combat-view';

const props = defineProps<{ beat: CombatBeat }>();

/** 目标头像最多排三枚，再多只在名字里写全 */
const MAX_TARGET_FACES = 3;

const targetFaces = computed(() => props.beat.targets.slice(0, MAX_TARGET_FACES));

/** 卡片正文的键值行（按协议顺序：判定 → 伤害/恢复 → 消耗 → 状态 → 其余） */
const rows = computed(() => {
  const b = props.beat;
  const out: Array<{ label: string; value: string; tone?: 'harm' | 'heal' }> = [];
  if (b.roll) out.push({ label: '判定', value: b.roll });
  if (b.damage) out.push({ label: '伤害', value: b.damage, tone: 'harm' });
  if (b.heal) out.push({ label: '恢复', value: b.heal, tone: 'heal' });
  if (b.cost) out.push({ label: '消耗', value: b.cost });
  for (const s of b.status) out.push({ label: '状态', value: s });
  for (const r of b.rest) out.push({ label: r.label, value: r.value });
  return out;
});

function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? '?';
}
</script>

<template>
  <section class="combat-beat" :aria-label="`${beat.actor}的行动`">
    <header class="beat-head">
      <span class="beat-party">
        <span class="beat-face" aria-hidden="true">
          <AssetMedia :name="beat.actor" :type="ASSET_TYPE_AVATAR_CHAIN">
            <span class="beat-initial">{{ initialOf(beat.actor) }}</span>
          </AssetMedia>
        </span>
        <span class="beat-name">{{ beat.actor }}</span>
      </span>

      <span class="beat-action">
        <span class="beat-action-name">{{ beat.action || '行动' }}</span>
        <span v-if="beat.target" class="beat-arrow" aria-hidden="true" />
      </span>

      <span v-if="beat.target" class="beat-party beat-party--target">
        <span class="beat-faces" aria-hidden="true">
          <span v-for="name in targetFaces" :key="name" class="beat-face">
            <AssetMedia :name="name" :type="ASSET_TYPE_AVATAR_CHAIN">
              <span class="beat-initial">{{ initialOf(name) }}</span>
            </AssetMedia>
          </span>
        </span>
        <span class="beat-name">{{ beat.target }}</span>
      </span>
    </header>

    <dl v-if="rows.length" class="beat-rows">
      <div v-for="(row, index) in rows" :key="index" class="beat-row" :data-tone="row.tone">
        <dt>{{ row.label }}</dt>
        <dd>{{ row.value }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.combat-beat {
  margin: 0.9em 0;
  padding: 10px 14px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow:
    0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent),
    0 4px 12px rgba(0, 0, 0, 0.08);
  text-indent: 0;
}

/* ── 头部：行动者 · 行动 → 目标 ── */
.beat-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.beat-party {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.beat-faces {
  display: inline-flex;
}

.beat-faces .beat-face + .beat-face {
  margin-left: -8px;
}

.beat-face {
  width: 1.75rem;
  height: 1.75rem;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}

/* 无素材时的首字题签：古金单字，不着品质色 */
.beat-initial {
  font-family: var(--theme-font-title, serif);
  font-size: 0.85rem;
  font-weight: 600;
  line-height: 1;
  color: var(--theme-primary);
}

.beat-name {
  font-family: var(--theme-font-title, serif);
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow-wrap: anywhere;
}

.beat-action {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.beat-action-name {
  font-family: var(--theme-font-title, serif);
  font-size: 0.9em;
  letter-spacing: 0.06em;
  color: var(--theme-primary);
  overflow-wrap: anywhere;
}

/* 细线箭头：一条 1px 线 + 末端小三角，纯描边，不发光 */
.beat-arrow {
  position: relative;
  width: 22px;
  height: 1px;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--theme-primary) 55%, transparent);
}

.beat-arrow::after {
  content: '';
  position: absolute;
  right: -1px;
  top: -3px;
  width: 5px;
  height: 7px;
  background: inherit;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

/* ── 正文：键值行 ── */
.beat-rows {
  margin: 8px 0 0;
  padding-top: 7px;
  border-top: 1px solid color-mix(in srgb, var(--theme-card-border) 70%, transparent);
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 12px;
  font-size: 0.9em;
}

.beat-row {
  display: contents;
}

.beat-row dt {
  color: var(--theme-text-muted);
  white-space: nowrap;
}

.beat-row dd {
  margin: 0;
  color: var(--theme-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.beat-row[data-tone='harm'] dd {
  color: var(--theme-error);
}

.beat-row[data-tone='heal'] dd {
  color: var(--theme-success);
}
</style>
