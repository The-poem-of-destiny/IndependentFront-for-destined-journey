<script setup lang="ts">
import { computed } from 'vue';
import type { CharGenSystemEvent } from '@engine/types';

const props = defineProps<{ event: CharGenSystemEvent }>();
const emit = defineEmits<{ collapse: [] }>();

// ═══ 色彩常量（原版精确值） ═══

const TIER_COLORS: Record<number, string> = {
  1: '#57595D',
  2: '#50C878',
  3: '#2196F3',
  4: '#9932CC',
  5: '#FFD700',
  6: '#DC143C',
  7: '#00FFFF',
};

const RACE_COLORS: Record<string, string> = {
  人类: '#FFDAB9',
  矮人: '#D2691E',
  精灵: '#00FF7F',
  极北精灵: '#00FF7F',
  暗夜精灵: '#9370DB',
  半精灵: '#90EE90',
  龙族: '#FFD700',
  龙姬: '#FFD700',
  龙裔: '#FFA500',
  巨龙: '#FFD700',
  古龙: '#FFD700',
  亚龙: '#FFAE42',
  半龙人: '#FFAE42',
  血姬: '#FF0000',
  血族: '#DC143C',
  兽族: '#FF4500',
  半兽人: '#FF8C00',
  半人马: '#FF8C00',
  翼民: '#00BFFF',
  翼族: '#00BFFF',
  堕羽民: '#9370DB',
  人鱼: '#00FFFF',
  蛇女: '#00FF7F',
  汐海妖精: '#00FFFF',
  宁芙: '#FF00FF',
  妖精: '#FF00FF',
  光翅妖精: '#FFFF00',
  地精: '#32CD32',
  半身人: '#FFD700',
  黑角民: '#00CED1',
  女妖: '#FF1493',
  亡灵种族: '#32CD32',
  不死生物: '#32CD32',
  深渊魔族: '#9400D3',
  魔物: '#8A2BE2',
  巨人: '#D2691E',
  半巨人: '#D2691E',
  小巨人: '#D2691E',
  霜巨人: '#00BFFF',
  山妖: '#DAA520',
  食人魔: '#7CFC00',
  巨魔: '#7CFC00',
  雪怪: '#E0FFFF',
  神祗: '#FFFFFF',
  英灵: '#00BFFF',
  从者: '#00BFFF',
  诗灵: '#EE82EE',
  构装体: '#00CED1',
  人造生物: '#00FF7F',
  元素生物: '#FF0000',
  植物生物: '#00FF00',
  不定形生物: '#7CFC00',
  异域生物: '#FF00FF',
  泰坦人族: '#FFD700',
};

function getRaceColor(race: string): string {
  for (const [key, color] of Object.entries(RACE_COLORS)) {
    if (race.includes(key)) return color;
  }
  return '#E0E0E0';
}

function getTierColor(tier: number): string {
  return TIER_COLORS[tier] ?? '#57595D';
}

function qualityGlowClass(quality?: string): string {
  if (!quality) return '';
  const q = quality.toLowerCase();
  if (q.includes('神话')) return 'ql-mythic';
  if (q.includes('传说')) return 'ql-legendary';
  if (q.includes('史诗')) return 'ql-epic';
  if (q.includes('稀有')) return 'ql-rare';
  if (q.includes('优良')) return 'ql-uncommon';
  if (q.includes('普通')) return 'ql-common';
  return '';
}

const ATTR_ICONS: Record<string, string> = {
  str: 'fa-solid fa-dumbbell',
  dex: 'fa-solid fa-bolt',
  con: 'fa-solid fa-shield-heart',
  int: 'fa-solid fa-brain',
  spi: 'fa-solid fa-star',
};

const ATTR_COLORS: Record<string, string> = {
  str: '#fc8181',
  dex: '#68d391',
  con: '#f6ad55',
  int: '#63b3ed',
  spi: '#b794f4',
};

const tierColor = computed(() => getTierColor(props.event.tier));
const raceColor = computed(() => getRaceColor(props.event.race));

const inventoryGroups = computed(() => {
  const items = props.event.details.inventory;
  if (!items?.length) return [];
  const groups: Record<string, typeof items> = {};
  for (const item of items) {
    const t = item.type || '其他';
    if (!groups[t]) groups[t] = [];
    groups[t].push(item);
  }
  return Object.entries(groups).map(([type, items]) => ({ type, items }));
});
</script>

<template>
  <div class="ci-card" :style="{ '--ci-tier': tierColor, '--ci-race': raceColor }">
    <!-- ═══ Header: 名字 + 等级 + 层级 ─ 参照原版 sheet-header ═══ -->
    <div class="ci-header" @click="emit('collapse')">
      <div class="ci-header-main">
        <span class="ci-tier-dot" />
        <span
          v-if="event.details.level"
          class="ci-level-badge"
          :style="{ borderColor: tierColor, color: tierColor }"
        >
          Lv.{{ event.details.level }}
        </span>
        <span class="ci-name">{{ event.characterName }}</span>
      </div>
      <div class="ci-header-meta">
        <span class="ci-race" :style="{ color: raceColor }">{{ event.race }}</span>
        <span class="ci-tier-badge" :style="{ background: tierColor }">T{{ event.tier }}</span>
        <i class="fa-solid fa-chevron-up ci-collapse-btn" title="收起" />
      </div>
    </div>

    <!-- ═══ Body: 始终显示 ═══ -->
    <div class="ci-body">
      <!-- A. 五维属性 — 参照原版 attributes-grid -->
      <div v-if="event.details.attributes" class="ci-attrs">
        <div
          v-for="(val, key) in event.details.attributes"
          :key="key"
          class="ci-attr"
          :style="{ color: ATTR_COLORS[key] ?? 'var(--theme-text-primary)' }"
        >
          <i :class="ATTR_ICONS[key] ?? 'fa-solid fa-circle'" class="ci-attr-icon" />
          <span class="ci-attr-name">{{ key.toUpperCase() }}</span>
          <span class="ci-attr-val">{{ val }}</span>
        </div>
      </div>

      <!-- B. 身份标签 — 参照原版 card-tags -->
      <div v-if="event.details.identity?.length" class="ci-section">
        <div class="ci-chips">
          <span
            v-for="tag in event.details.identity"
            :key="tag"
            class="ci-chip ci-chip-id"
            :style="{ borderColor: raceColor, color: raceColor }"
          >
            {{ tag }}
          </span>
        </div>
      </div>

      <!-- C. 档案 Profile — 参照原版 profile-grid (2×2) -->
      <div
        v-if="
          event.details.personality ||
          event.details.appearance ||
          event.details.likes ||
          event.details.clothing
        "
        class="ci-section ci-section-divider"
      >
        <div class="ci-profile-grid">
          <div class="ci-profile-row">
            <div v-if="event.details.personality" class="ci-profile-cell">
              <h5 class="ci-sub-title" :style="{ color: raceColor }">性格</h5>
              <p class="ci-story">{{ event.details.personality }}</p>
            </div>
            <div v-if="event.details.appearance" class="ci-profile-cell">
              <h5 class="ci-sub-title" :style="{ color: raceColor }">外貌特质</h5>
              <p class="ci-story">{{ event.details.appearance }}</p>
            </div>
          </div>
          <div class="ci-profile-row">
            <div v-if="event.details.likes" class="ci-profile-cell">
              <h5 class="ci-sub-title" :style="{ color: raceColor }">喜爱</h5>
              <p class="ci-story">{{ event.details.likes }}</p>
            </div>
            <div v-if="event.details.clothing" class="ci-profile-cell">
              <h5 class="ci-sub-title" :style="{ color: raceColor }">衣物装饰</h5>
              <p class="ci-story">{{ event.details.clothing }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- D. 势力（如果有） -->
      <div v-if="event.details.faction" class="ci-section ci-section-divider">
        <div class="ci-kv">
          <span class="ci-kv-label">势力</span>
          <span class="ci-kv-value">{{ event.details.faction }}</span>
        </div>
      </div>

      <!-- E. 职业标签 -->
      <div v-if="event.details.occupation?.length" class="ci-section ci-section-divider">
        <div class="ci-chips">
          <span v-for="occ in event.details.occupation" :key="occ" class="ci-chip ci-chip-occ">{{
            occ
          }}</span>
        </div>
      </div>

      <!-- F. 背景故事 — 参照原版 story panel -->
      <div v-if="event.details.background" class="ci-section ci-section-divider">
        <p class="ci-bg">
          {{ event.details.background.slice(0, 250)
          }}{{ event.details.background.length > 250 ? '…' : '' }}
        </p>
      </div>

      <!-- G. 背包 Inventory — 按类型分组 -->
      <div v-if="inventoryGroups.length" class="ci-section ci-section-divider">
        <h4 class="ci-sec-title">持有物</h4>
        <div v-for="group in inventoryGroups" :key="group.type">
          <h5 class="ci-sub-title" :style="{ color: raceColor }">{{ group.type }}</h5>
          <div v-for="inv in group.items" :key="inv.name" class="ci-item-card ci-accent-race">
            <div class="ci-item-header">
              <span class="ci-item-name" :class="qualityGlowClass(inv.rarity)">{{ inv.name }}</span>
              <span class="ci-item-count">x{{ inv.quantity }}</span>
              <span
                v-if="inv.rarity"
                class="ci-item-subtitle"
                :class="qualityGlowClass(inv.rarity)"
                >{{ inv.rarity }}</span
              >
            </div>
            <div class="ci-item-body">
              <p class="ci-item-desc">{{ inv.description?.slice(0, 120) }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- H. 技能列表 — 参照原版 card 结构 -->
      <div v-if="event.details.skills?.length" class="ci-section ci-section-divider">
        <h4 class="ci-sec-title">技能</h4>
        <div v-for="sk in event.details.skills" :key="sk.name" class="ci-item-card ci-accent-race">
          <div class="ci-item-header">
            <span class="ci-item-name">{{ sk.name }}</span>
            <span class="ci-item-type-badge">{{ sk.type === 'active' ? '主动' : '被动' }}</span>
          </div>
          <div class="ci-item-body">
            <span v-if="sk.cost" class="ci-cost">消耗 {{ sk.cost.type }} {{ sk.cost.amount }}</span>
            <span v-if="sk.cooldown" class="ci-cool">CD {{ sk.cooldown }}回合</span>
            <p class="ci-item-desc">{{ sk.description?.slice(0, 150) }}</p>
            <div v-if="sk.effects && Object.keys(sk.effects).length" class="ci-effects">
              <span v-for="(v, k) in sk.effects" :key="k" class="ci-effect-pill">
                <span class="ci-effect-key" :style="{ color: raceColor }">{{ k }}</span>
                <span>{{ v }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- I. 装备列表 -->
      <div v-if="event.details.equipment?.length" class="ci-section ci-section-divider">
        <h4 class="ci-sec-title">装备</h4>
        <div
          v-for="eq in event.details.equipment"
          :key="eq.name"
          class="ci-item-card ci-equip ci-accent-race"
        >
          <div class="ci-item-header">
            <span class="ci-equip-slot">{{ eq.slot }}</span>
            <span class="ci-item-name" :class="qualityGlowClass(eq.quality)">{{ eq.name }}</span>
            <span
              v-if="eq.quality"
              class="ci-item-subtitle"
              :class="qualityGlowClass(eq.quality)"
              >{{ eq.quality }}</span
            >
          </div>
          <div class="ci-item-body">
            <p class="ci-item-desc">{{ eq.description?.slice(0, 120) }}</p>
            <div v-if="eq.stats && Object.keys(eq.stats).length" class="ci-stats">
              <span v-for="(v, k) in eq.stats" :key="k" class="ci-stat">{{ k }}+{{ v }}</span>
            </div>
            <div v-if="eq.effects && Object.keys(eq.effects).length" class="ci-effects">
              <span v-for="(v, k) in eq.effects" :key="k" class="ci-effect-pill">
                <span class="ci-effect-key" :style="{ color: raceColor }">{{ k }}</span>
                <span>{{ v }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- J. 登神长阶 — 参照原版 divinity-card -->
      <div v-if="event.details.ascension?.enabled" class="ci-section ci-section-divider">
        <h4 class="ci-sec-title ci-sec-dao" :style="{ color: tierColor }">登神长阶</h4>

        <!-- 神位 deityPosition -->
        <p
          v-if="event.details.ascension.deityPosition"
          class="ci-dao-deity"
          :style="{ color: tierColor }"
        >
          {{ event.details.ascension.deityPosition }}
        </p>

        <!-- 登神路径 path -->
        <p v-if="event.details.ascension.path" class="ci-dao-path">
          {{ event.details.ascension.path }}
        </p>
        <p v-if="event.details.ascension.description" class="ci-item-desc">
          {{ event.details.ascension.description.slice(0, 150) }}
        </p>

        <!-- 神国 divineKingdom -->
        <div v-if="event.details.ascension.divineKingdom?.name" class="ci-item-card ci-accent-tier">
          <div class="ci-item-header">
            <span class="ci-item-name" :style="{ color: tierColor }">{{
              event.details.ascension.divineKingdom.name
            }}</span>
          </div>
          <div class="ci-item-body">
            <p v-if="event.details.ascension.divineKingdom.description" class="ci-item-desc">
              {{ event.details.ascension.divineKingdom.description.slice(0, 200) }}
            </p>
          </div>
        </div>

        <!-- 要素 elements -->
        <template v-if="event.details.ascension.elements?.length">
          <h5 class="ci-sub-title" :style="{ color: raceColor }">要素</h5>
          <div
            v-for="el in event.details.ascension.elements"
            :key="el.name"
            class="ci-item-card ci-accent-tier"
          >
            <div class="ci-item-header">
              <span class="ci-item-name">{{ el.name }}</span>
            </div>
            <div class="ci-item-body">
              <p class="ci-item-desc">{{ el.description }}</p>
              <!-- 要素 effects 是 string[]（char-gen-agent 按行切），不是 name→desc 表；
                   照 (v, k) 渲染会把数组下标当词条名画出来 -->
              <div v-if="el.effects?.length" class="ci-effects">
                <span v-for="eff in el.effects" :key="eff" class="ci-effect-pill">
                  <span>{{ eff }}</span>
                </span>
              </div>
            </div>
          </div>
        </template>

        <!-- 权能 authorities -->
        <template v-if="event.details.ascension.authorities?.length">
          <h5 class="ci-sub-title" :style="{ color: raceColor }">权能</h5>
          <div
            v-for="au in event.details.ascension.authorities"
            :key="au.name"
            class="ci-item-card ci-accent-tier"
          >
            <div class="ci-item-header">
              <span class="ci-item-name">{{ au.name }}</span>
            </div>
            <div class="ci-item-body">
              <p class="ci-item-desc">{{ au.description }}</p>
              <p v-if="au.costDescription" class="ci-cost">{{ au.costDescription }}</p>
              <!-- 同 elements：权能 effects 也是 string[] -->
              <div v-if="au.effects?.length" class="ci-effects">
                <span v-for="eff in au.effects" :key="eff" class="ci-effect-pill">
                  <span>{{ eff }}</span>
                </span>
              </div>
            </div>
          </div>
        </template>

        <!-- 法则 laws -->
        <template v-if="event.details.ascension.laws?.length">
          <h5 class="ci-sub-title" :style="{ color: raceColor }">法则</h5>
          <div
            v-for="law in event.details.ascension.laws"
            :key="law.name"
            class="ci-item-card ci-accent-tier"
          >
            <div class="ci-item-header">
              <span class="ci-item-name">{{ law.name }}</span>
            </div>
            <div class="ci-item-body">
              <p class="ci-item-desc">{{ law.description }}</p>
              <p v-if="law.costDescription" class="ci-cost">{{ law.costDescription }}</p>
              <div v-if="law.passiveEffects?.length" class="ci-effects">
                <span
                  v-for="pe in law.passiveEffects"
                  :key="pe"
                  class="ci-effect-pill ci-eff-passive"
                >
                  <span class="ci-effect-key">被动</span>
                  <span>{{ pe }}</span>
                </span>
              </div>
              <div v-if="law.activeEffects?.length" class="ci-effects">
                <span
                  v-for="ae in law.activeEffects"
                  :key="ae"
                  class="ci-effect-pill ci-eff-active"
                >
                  <span class="ci-effect-key">主动</span>
                  <span>{{ ae }}</span>
                </span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ═══ 卡片骨架（参照原版 card-wrapper 但更紧凑） ═══ */
.ci-card {
  border-radius: 6px;
  overflow: hidden;
  background: var(--theme-card-bg);
  border: 1px solid
    color-mix(in srgb, var(--ci-tier, var(--theme-card-border)) 50%, var(--theme-card-border));
  box-shadow: var(--paper-stack, 0 0 16px rgba(0, 0, 0, 0.3));
}

/* 层级色点 — 头部强调 */
.ci-tier-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ci-tier);
  box-shadow: 0 0 6px color-mix(in srgb, var(--ci-tier) 50%, transparent);
  flex-shrink: 0;
  align-self: center;
}

/* ═══ Header ─ 参照原版 sheet-header ═══ */
.ci-header {
  padding: 12px 14px 10px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.ci-header:hover {
  background: rgba(255, 255, 255, 0.03);
}

.ci-header-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.ci-header-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 等级徽章 ─ 参照原版 level-badge */
.ci-level-badge {
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid;
  font-size: 0.6875rem;
  font-weight: 700;
  text-shadow: 0 0 6px currentColor;
}

/* 名字 ─ 参照原版 char-name（缩小版） */
.ci-name {
  font-family: var(--theme-font-title);
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}

/* 种族 ─ 种族色文字 */
.ci-race {
  font-size: 0.75rem;
  opacity: 0.85;
  font-weight: 500;
}

/* 层级徽章 ─ 层级色背景 + 白字 */
.ci-tier-badge {
  padding: 2px 8px;
  border-radius: 3px;
  color: var(--theme-text-primary);
  font-size: 0.6875rem;
  font-weight: 700;
}

/* Collapse button */
.ci-collapse-btn {
  font-size: 0.625rem;
  opacity: 0.4;
  cursor: pointer;
  transition: opacity 0.15s;
}
.ci-collapse-btn:hover {
  opacity: 0.8;
}

/* ═══ Body ═══ */
.ci-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ═══ 五维属性 ─ 参照原版 attributes-grid（简化） ═══ */
.ci-attrs {
  display: flex;
  gap: 14px;
  justify-content: center;
  padding: 0 0 12px;
}
.ci-attr {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 0.8125rem;
  font-weight: 700;
}
.ci-attr-icon {
  font-size: 0.625rem;
  opacity: 0.6;
  width: 0.75rem;
  text-align: center;
}
.ci-attr-name {
  font-size: 0.5625rem;
  opacity: 0.5;
  text-transform: uppercase;
  font-weight: 500;
}
.ci-attr-val {
  min-width: 1.25rem;
  text-align: center;
}

/* ═══ Section ─ 参照原版分割 ═══ */
.ci-section {
  padding: 10px 0;
}
.ci-section-divider {
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}

/* Section 标题 ─ 色点前缀（种族色/层级色由 --ci-race / --ci-tier 驱动） */
.ci-sec-title {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--theme-text-secondary);
  margin: 0 0 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ci-sec-title::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ci-race, var(--theme-text-muted));
  box-shadow: 0 0 5px color-mix(in srgb, var(--ci-race, transparent) 50%, transparent);
  flex-shrink: 0;
}
.ci-sec-dao {
  color: inherit;
} /* 登神标题用层级色 */
.ci-sec-dao::before {
  background: var(--ci-tier, var(--theme-text-muted));
  box-shadow: 0 0 5px color-mix(in srgb, var(--ci-tier, transparent) 50%, transparent);
}

/* ═══ Chip ─ 参照原版 card-tag ═══ */
.ci-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ci-chip {
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 0.6875rem;
  font-weight: 500;
}
.ci-chip-id {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid;
  /* borderColor 和 color 由 raceColor 动态设置 */
}
.ci-chip-occ {
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  border: 1px solid var(--theme-card-border);
}

/* ═══ KV 行 ═══ */
.ci-kv {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8125rem;
}
.ci-kv-label {
  font-weight: 600;
  opacity: 0.5;
  font-size: 0.75rem;
}
.ci-kv-value {
  color: var(--theme-text-primary);
}

/* ═══ 背景故事 ─ 参照原版 story panel ═══ */
.ci-bg {
  font-size: 0.75rem;
  line-height: 1.6;
  opacity: 0.75;
  white-space: pre-line;
  margin: 0;
  color: var(--theme-text-secondary);
}

/* ═══ 技能/装备卡片 ─ 整圈边框色调（种族色/层级色） ═══ */
.ci-item-card {
  border: 1px solid var(--theme-card-border);
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 6px;
}
.ci-accent-race {
  border-color: color-mix(
    in srgb,
    var(--ci-race, var(--theme-card-border)) 40%,
    var(--theme-card-border)
  );
}
.ci-accent-tier {
  border-color: color-mix(
    in srgb,
    var(--ci-tier, var(--theme-card-border)) 40%,
    var(--theme-card-border)
  );
}
.ci-item-card:last-child {
  margin-bottom: 0;
}

/* item header ─ 参照原版 card-header */
.ci-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.ci-item-name {
  font-weight: 700;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
/* 品质色 ─ 统一走主题品质令牌 */
.ql-mythic {
  color: var(--theme-quality-mythic) !important;
}
.ql-legendary {
  color: var(--theme-quality-legendary) !important;
}
.ql-epic {
  color: var(--theme-quality-epic) !important;
}
.ql-rare {
  color: var(--theme-quality-rare) !important;
}
.ql-uncommon {
  color: var(--theme-quality-uncommon) !important;
}
.ql-common {
  color: var(--theme-quality-common) !important;
}

/* item type badge */
.ci-item-type-badge {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.625rem;
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
}

/* item body */
.ci-item-body {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.ci-cost,
.ci-cool {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.625rem;
  background: rgba(255, 255, 255, 0.06);
  color: var(--theme-text-muted);
  margin-right: 4px;
}
.ci-item-desc {
  opacity: 0.65;
  margin: 4px 0 0;
  line-height: 1.5;
}

/* 装备 slot ─ 参照原版 effect-name pill */
.ci-equip-slot {
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 0.625rem;
  font-weight: 600;
  background: var(--theme-primary);
  color: var(--theme-primary-text);
}

/* 数值 stat */
.ci-stats {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.ci-stat {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.625rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
  font-family: monospace;
}

/* ═══ 登神长阶 ─ 参照原版 divinity-card ═══ */
.ci-dao-deity {
  text-align: center;
  font-size: 0.9375rem;
  font-weight: 700;
  margin: 0 0 4px;
}
.ci-dao-path {
  font-weight: 600;
  font-size: 0.875rem;
  margin: 0 0 4px;
}

/* ═══ Profile grid ─ 参照原版 profile-grid ═══ */
.ci-profile-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ci-profile-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.ci-profile-cell {
  min-width: 0;
}
.ci-story {
  white-space: pre-line;
  line-height: 1.6;
  font-size: 0.75rem;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 4px;
  padding: 10px;
  color: var(--theme-text-secondary);
  height: 100%;
  box-sizing: border-box;
}

/* ═══ 通用子标题 ═══ */
.ci-sub-title {
  font-size: 0.75rem;
  font-weight: 600;
  margin: 4px 0 4px;
}
.ci-item-count {
  font-size: 0.6875rem;
  opacity: 0.6;
  font-weight: 400;
}
.ci-item-subtitle {
  font-size: 0.6875rem;
  font-weight: 600;
}

/* ═══ Effects pill ═══ */
.ci-effects {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.ci-effect-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 0.6875rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--theme-card-border);
}
.ci-effect-key {
  font-weight: 700;
  font-size: 0.625rem;
}
.ci-eff-passive {
  border-color: rgba(53, 201, 138, 0.3);
}
.ci-eff-active {
  border-color: rgba(245, 158, 11, 0.3);
}
</style>
