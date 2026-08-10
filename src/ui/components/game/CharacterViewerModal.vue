<script setup lang="ts">
/**
 * CharacterViewerModal — 非玩家角色的**通栏档案**（左画像 + 右信息面，6 个页签）。
 *
 * 从哪来: 场景栏「在场」列表点一位角色。分工是**按角色归属**而不是按内容 ——
 * 右侧状态栏（StatusOverview）是**玩家自己的**面，本弹窗是**别人的**面。
 * 两者字段重叠很多，但一个是"我的资源/我的分配点"，另一个是"我对这个人知道什么"，
 * 变更理由不同，所以不共用一个组件。
 *
 * 🔴 **画像位只认 `立绘bg → 立绘`**（{@link VIEWER_PORTRAIT_CHAIN}）。这是刻意**不**
 * 复用 asset-resolve 那两条共享链的：那两条都以 `头像` 收尾（"构图不对总好过留一个
 * 洞"），而这一位是一整栏的高度 —— 一张 1:1 证件照拉满整栏看起来像 bug 而不像功能，
 * 首字母兜底反而更诚实。所以这一位宁可空着。
 *
 * 名字**严格 `===`**（D2）: 角色从 `game.characters` 里按名字取（M4 起名字唯一），
 * 素材也按同一个名字解析。传进来的名字带一个尾随空格就会静默什么都查不到 ——
 * 那是上游要修的缺陷，本层不做归一化。
 *
 * 判定一律在 `character-viewer.ts`（纯函数，不 mount 可测），本文件只负责呈现。
 */
import { computed, ref, watch } from 'vue';
import AppModal from '../shared/AppModal.vue';
import AppTabs from '../shared/AppTabs.vue';
import AssetMedia from '../shared/AssetMedia.vue';
import BuffChip from '../shared/BuffChip.vue';
import CharacterPortrait from '../shared/CharacterPortrait.vue';
import ResourceBar from '../shared/ResourceBar.vue';
import { useAssetImage } from '../../composables/useAssetImage';
import { useAssetStore } from '../../stores/asset-store';
import { useGameStore } from '../../stores/game-store';
import { qualityVar, tierVarByName } from '../../lib/quality-colors';
import { initialsOf } from '../../utils/name-color';
import type { AssetType, CharacterState, StatusEffect } from '@engine/types';
import {
  buildAffectionView,
  buildAlbumGroups,
  buildAscensionTracks,
  buildProfileFields,
  buildSubtitleSegments,
  hasAnyAscension,
  itemQuality,
  splitInventory,
  type AlbumTile,
} from './character-viewer';

/** 见文件头那条铁律 —— 这一位**没有**第三档兜底 */
const VIEWER_PORTRAIT_CHAIN: readonly AssetType[] = ['立绘bg', '立绘'];

const props = defineProps<{
  /** 要看谁；`null` = 弹窗关着（本组件不另存一份 open 状态，避免两处真源） */
  name: string | null;
}>();

const emit = defineEmits<{ close: [] }>();

const game = useGameStore();
const assetStore = useAssetStore();

const open = computed(() => props.name !== null);

/**
 * 每次都按名字回查，**不把角色对象存成 prop**: 存档提交会整份替换
 * `game.characters`，攥着旧对象的弹窗会停在提交前那一刻的数值
 * （血量打完架还是满的，那种缺陷没人会怀疑到弹窗上）。
 */
const char = computed<CharacterState | null>(
  () => (game.characters ?? []).find((c) => c.name === props.name) ?? null,
);

// ═══ 页签 ═══
type ViewerTab = 'profile' | 'status' | 'equipment' | 'skills' | 'bag' | 'album';
const TABS: { key: ViewerTab; label: string }[] = [
  { key: 'profile', label: '档案' },
  { key: 'status', label: '状态' },
  { key: 'equipment', label: '装备' },
  { key: 'skills', label: '技能' },
  { key: 'bag', label: '背包' },
  { key: 'album', label: '相册' },
];
const activeTab = ref<ViewerTab>('profile');

/** 展开态 —— 登神条目 / 状态效果 / 相册放大格，都按名字或 id 记单选 */
const openAscension = ref<string | null>(null);
const openStatus = ref<string | null>(null);
const focusedTile = ref<string | null>(null);

/**
 * 换人 = 一切归零。
 *
 * 不这么做的表现很具体: 上一位展开着「镇压与秩序」，切到下一位时那一格仍是展开的，
 * 而新角色没有同名条目 —— 于是展开区里空着一块，看着像渲染 bug。
 */
watch(
  () => props.name,
  () => {
    activeTab.value = 'profile';
    openAscension.value = null;
    openStatus.value = null;
    focusedTile.value = null;
  },
);

// ═══ 画像 ═══
// 解构而不是留着整个对象: 模板里只有**顶层** ref 会自动解包，
// `portrait.url` 那种写法会把 Ref 对象本身插进 `src`
const {
  url: portraitUrl,
  isVideo: portraitIsVideo,
  row: portraitRow,
} = useAssetImage(
  () => props.name,
  () => VIEWER_PORTRAIT_CHAIN,
);

const subtitle = computed(() => (char.value ? buildSubtitleSegments(char.value) : []));

// ═══ 档案页 ═══
const affection = computed(() =>
  buildAffectionView(props.name ? game.saveProfile?.affections?.[props.name] : 0),
);
const profileFields = computed(() => (char.value ? buildProfileFields(char.value) : []));
const ascensionTracks = computed(() => (char.value ? buildAscensionTracks(char.value) : []));
const ascensionUnlocked = computed(() => hasAnyAscension(ascensionTracks.value));
const thoughts = computed(() => (char.value ? game.getThoughts(char.value) : ''));

const ATTR_ROWS: { key: 'str' | 'dex' | 'con' | 'int' | 'spi'; label: string }[] = [
  { key: 'str', label: '力量' },
  { key: 'dex', label: '敏捷' },
  { key: 'con', label: '体质' },
  { key: 'int', label: '智力' },
  { key: 'spi', label: '精神' },
];

// ═══ 物品 / 技能 ═══
const inventory = computed(() => splitInventory(char.value?.inventory));
const skills = computed(() => char.value?.skills ?? []);
const statusEffects = computed(() => char.value?.statusEffects ?? []);

function chipType(fx: StatusEffect): 'buff' | 'debuff' | 'special' {
  if (fx.category === '增益') return 'buff';
  if (fx.category === '减益') return 'debuff';
  return 'special';
}
function durationText(fx: StatusEffect): string {
  if (fx.remainingTime === null) return '永久';
  // 999 是"实际上不会走完"的约定值（同 CharacterListPanel），照数字显示只会让人以为是 bug
  if (fx.remainingTime >= 999) return '长期';
  return `${fx.remainingTime}${fx.timeUnit}`;
}

// ═══ 相册 ═══
const albumGroups = computed(() =>
  props.name ? buildAlbumGroups(assetStore.assets ?? [], props.name) : [],
);
const albumCount = computed(() =>
  albumGroups.value.reduce((sum, group) => sum + group.tiles.length, 0),
);
function toggleTile(tile: AlbumTile) {
  focusedTile.value = focusedTile.value === tile.id ? null : tile.id;
}
</script>

<template>
  <AppModal :open="open" size="full" bare @update:open="emit('close')">
    <div v-if="char" class="viewer">
      <!-- ═══════ 左: 画像（立绘bg → 立绘，没有第三档） ═══════ -->
      <div class="viewer-portrait">
        <CharacterPortrait
          :name="char.name"
          :src="portraitUrl"
          :video="portraitIsVideo"
          :framing="portraitRow?.framing ?? null"
          fill
        >
          <!-- 兜底: 一个巨大的首字母。刻意不是「暂无立绘」四个字 ——
               这一栏是装饰位，一句报错文案会把它变成一条待办 -->
          <span class="portrait-initials" aria-hidden="true">{{ initialsOf(char.name) }}</span>
        </CharacterPortrait>
      </div>

      <!-- ═══════ 右: 信息面 ═══════ -->
      <div class="viewer-body">
        <div class="viewer-head">
          <div class="head-text">
            <h2 class="head-name">{{ char.name }}</h2>
            <div class="head-meta">
              <template v-for="(seg, i) in subtitle" :key="seg.text + i"
                ><span v-if="i" class="meta-sep" aria-hidden="true"> · </span
                ><span
                  class="meta-seg"
                  :style="seg.kind === 'tier' ? { color: tierVarByName(seg.text) } : undefined"
                  >{{ seg.text }}</span
                ></template
              >
            </div>
          </div>
          <button class="head-close" type="button" aria-label="关闭" @click="emit('close')">
            ×
          </button>
        </div>

        <AppTabs :tabs="TABS" :active="activeTab" @select="activeTab = $event" />

        <div class="viewer-scroll">
          <!-- ─────── 档案 ─────── -->
          <template v-if="activeTab === 'profile'">
            <!-- 好感度: 中线为 0，正向右生长、负向左生长（同场景栏那一条的口径） -->
            <div class="aff-block">
              <div class="aff-head">
                <span class="aff-title">好感度</span>
                <span class="aff-value" :class="{ neg: affection.negative }">
                  <span class="aff-label">{{ affection.label }}</span>
                  {{ affection.value }}
                </span>
              </div>
              <div class="aff-track">
                <span
                  class="aff-fill"
                  :class="affection.negative ? 'neg' : 'pos'"
                  :style="{ transform: `scaleX(${affection.ratio})` }"
                />
                <span class="aff-zero" aria-hidden="true" />
              </div>
              <div class="aff-scale" aria-hidden="true">
                <span>-100</span><span>0</span><span>+100</span>
              </div>
            </div>

            <!-- 档案四行 -->
            <section class="vw-sec">
              <h3 class="vw-sec-title">档案</h3>
              <div v-if="profileFields.length" class="prose-list">
                <div v-for="f in profileFields" :key="f.label" class="prose-row">
                  <div class="prose-label">{{ f.label }}</div>
                  <p class="prose-text">{{ f.text }}</p>
                </div>
              </div>
              <div v-else class="empty-tab">此人来历不详…</div>
            </section>

            <!-- 属性 -->
            <section class="vw-sec">
              <h3 class="vw-sec-title">属性</h3>
              <div class="attr-grid">
                <div v-for="a in ATTR_ROWS" :key="a.key" class="attr-cell">
                  <span class="attr-name">{{ a.label }}</span>
                  <span class="attr-num">{{ char.attributes?.[a.key] ?? '—' }}</span>
                </div>
              </div>
              <div v-if="char.freeAttrPoints" class="attr-free">
                未分配自由点 {{ char.freeAttrPoints }}
              </div>
            </section>

            <!-- 登神长阶 -->
            <section class="vw-sec">
              <h3 class="vw-sec-title">登神长阶</h3>
              <div class="asc-grid">
                <div
                  v-for="track in ascensionTracks"
                  :key="track.key"
                  class="asc-track"
                  :class="{ filled: track.entries.length > 0 }"
                >
                  <div class="asc-track-head">
                    <span class="asc-track-label">{{ track.label }}</span>
                    <span class="asc-track-count"
                      >{{ track.entries.length }}<span class="asc-cap">/{{ track.cap }}</span></span
                    >
                  </div>
                  <div v-if="!track.entries.length" class="asc-none">
                    <span aria-hidden="true">—</span>
                    <span class="asc-none-hint">{{ track.unlockLevel }} 起</span>
                  </div>
                  <div v-else class="asc-entries">
                    <div v-for="entry in track.entries" :key="entry.name" class="asc-entry">
                      <button
                        class="asc-entry-head"
                        type="button"
                        :aria-expanded="openAscension === entry.name"
                        @click="openAscension = openAscension === entry.name ? null : entry.name"
                      >
                        <span class="asc-entry-name">{{ entry.name }}</span>
                        <span class="asc-toggle" aria-hidden="true">{{
                          openAscension === entry.name ? '−' : '+'
                        }}</span>
                      </button>
                      <Transition name="collapse">
                        <div v-if="openAscension === entry.name" class="asc-entry-body">
                          <p v-if="entry.description" class="asc-desc">{{ entry.description }}</p>
                          <ul v-if="entry.effects.length" class="asc-effects">
                            <li v-for="(fx, i) in entry.effects" :key="i">{{ fx }}</li>
                          </ul>
                          <div v-if="entry.cost" class="asc-cost">消耗 · {{ entry.cost }}</div>
                        </div>
                      </Transition>
                    </div>
                  </div>
                </div>
              </div>
              <div class="asc-divine">
                <span class="dv-label">神位</span>
                <span class="dv-value">{{ char.ascension?.deityPosition || '—' }}</span>
                <span class="dv-label">神国</span>
                <span class="dv-value">{{ char.ascension?.divineKingdom?.name || '—' }}</span>
                <span v-if="!ascensionUnlocked" class="dv-hint">尚未踏上长阶</span>
              </div>
            </section>

            <!-- 心里话 —— 唯一真源 CharacterState.thoughts（经 store.getThoughts） -->
            <section v-if="thoughts" class="vw-sec">
              <h3 class="vw-sec-title">心里话</h3>
              <blockquote class="thoughts">{{ thoughts }}</blockquote>
            </section>

            <!-- 背景故事 -->
            <section v-if="char.background" class="vw-sec">
              <h3 class="vw-sec-title">背景故事</h3>
              <p class="story">{{ char.background }}</p>
            </section>
          </template>

          <!-- ─────── 状态 ─────── -->
          <template v-else-if="activeTab === 'status'">
            <section class="vw-sec">
              <h3 class="vw-sec-title">资源</h3>
              <div class="res-stack">
                <ResourceBar
                  label="HP"
                  :current="char.hp"
                  :max="char.maxHp"
                  color="color-mix(in srgb, var(--theme-hp) 65%, #000)"
                  :height="22"
                  :show-values="true"
                />
                <ResourceBar
                  label="MP"
                  :current="char.mp"
                  :max="char.maxMp"
                  color="color-mix(in srgb, var(--theme-mp) 65%, #000)"
                  :height="22"
                  :show-values="true"
                />
                <ResourceBar
                  label="SP"
                  :current="char.sp"
                  :max="char.maxSp"
                  color="color-mix(in srgb, var(--theme-sp) 65%, #000)"
                  :height="22"
                  :show-values="true"
                />
              </div>
            </section>

            <section class="vw-sec">
              <h3 class="vw-sec-title">状态效果</h3>
              <div v-if="!statusEffects.length" class="empty-tab">身上并无异状…</div>
              <template v-else>
                <div class="fx-chips">
                  <button
                    v-for="fx in statusEffects"
                    :key="fx.name"
                    class="fx-chip-btn"
                    type="button"
                    :aria-expanded="openStatus === fx.name"
                    @click="openStatus = openStatus === fx.name ? null : fx.name"
                  >
                    <BuffChip :name="fx.name" :type="chipType(fx)" :stacks="fx.stacks" />
                    <span class="fx-time">{{ durationText(fx) }}</span>
                  </button>
                </div>
                <template v-for="fx in statusEffects" :key="`d-${fx.name}`">
                  <div v-if="openStatus === fx.name" class="fx-detail">
                    <div class="fx-detail-name">{{ fx.name }}</div>
                    <p v-if="fx.description" class="fx-detail-desc">{{ fx.description }}</p>
                    <div class="fx-detail-meta">
                      <span
                        >层数 {{ fx.stacks
                        }}<template v-if="fx.maxStacks">/{{ fx.maxStacks }}</template></span
                      >
                      <span>剩余 {{ durationText(fx) }}</span>
                      <span v-if="fx.source">来源 {{ fx.source }}</span>
                    </div>
                  </div>
                </template>
              </template>
            </section>
          </template>

          <!-- ─────── 装备 ─────── -->
          <template v-else-if="activeTab === 'equipment'">
            <div v-if="!inventory.equipped.length" class="empty-tab">未着寸铁…</div>
            <div v-for="eq in inventory.equipped" :key="eq.name" class="thing-card">
              <div class="thing-head">
                <span class="q-dot" :style="{ background: qualityVar(itemQuality(eq)) }" />
                <span class="thing-name" :style="{ color: qualityVar(itemQuality(eq)) }">{{
                  eq.name
                }}</span>
                <span class="thing-tag">{{ eq.equippedSlot }}</span>
              </div>
              <p v-if="eq.description" class="thing-desc">{{ eq.description }}</p>
              <div v-if="eq.effects && Object.keys(eq.effects).length" class="kv-list">
                <div v-for="(desc, key) in eq.effects" :key="key" class="kv-row">
                  <span class="kv-k">{{ key }}</span
                  ><span class="kv-v">{{ desc }}</span>
                </div>
              </div>
              <div v-if="eq.durability !== undefined" class="thing-foot">
                耐久 {{ eq.durability
                }}<template v-if="eq.maxDurability">/{{ eq.maxDurability }}</template>
              </div>
            </div>
          </template>

          <!-- ─────── 技能 ─────── -->
          <template v-else-if="activeTab === 'skills'">
            <div v-if="!skills.length" class="empty-tab">未修得一技…</div>
            <div v-for="sk in skills" :key="sk.name" class="thing-card">
              <div class="thing-head">
                <span class="thing-name">{{ sk.name }}</span>
                <span class="thing-tag"
                  >{{ sk.type === 'active' ? '主动' : '被动'
                  }}<template v-if="sk.level"> · Lv.{{ sk.level }}</template></span
                >
              </div>
              <div v-if="sk.cost || sk.cooldown" class="thing-cost">
                <template v-if="sk.cost">{{ sk.cost.amount }} {{ sk.cost.type }}</template>
                <template v-if="sk.cooldown"> · 冷却 {{ sk.cooldown }} 回合</template>
              </div>
              <p v-if="sk.description" class="thing-desc">{{ sk.description }}</p>
              <div v-if="sk.effects && Object.keys(sk.effects).length" class="kv-list">
                <div v-for="(desc, key) in sk.effects" :key="key" class="kv-row">
                  <span class="kv-k">{{ key }}</span
                  ><span class="kv-v">{{ desc }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- ─────── 背包 ─────── -->
          <template v-else-if="activeTab === 'bag'">
            <div class="purse">
              <span class="purse-label">随身钱财</span>
              <span class="purse-value">{{ char.money ?? 0 }} G</span>
            </div>
            <div v-if="!inventory.carried.length" class="empty-tab">行囊空空…</div>
            <div v-for="item in inventory.carried" :key="item.name" class="thing-card">
              <div class="thing-head">
                <span class="q-dot" :style="{ background: qualityVar(itemQuality(item)) }" />
                <span class="thing-name" :style="{ color: qualityVar(itemQuality(item)) }">{{
                  item.name
                }}</span>
                <span v-if="item.quantity > 1" class="thing-tag">×{{ item.quantity }}</span>
              </div>
              <p v-if="item.description" class="thing-desc">{{ item.description }}</p>
              <div v-if="item.effects && Object.keys(item.effects).length" class="kv-list">
                <div v-for="(desc, key) in item.effects" :key="key" class="kv-row">
                  <span class="kv-k">{{ key }}</span
                  ><span class="kv-v">{{ desc }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- ─────── 相册 ─────── -->
          <template v-else>
            <div v-if="!albumCount" class="empty-tab">此人尚无留影…</div>
            <section v-for="group in albumGroups" :key="group.type" class="vw-sec">
              <h3 class="vw-sec-title">{{ group.type }}</h3>
              <div class="album-grid">
                <button
                  v-for="tile in group.tiles"
                  :key="tile.id"
                  class="album-tile"
                  :class="{ focused: focusedTile === tile.id }"
                  type="button"
                  :aria-pressed="focusedTile === tile.id"
                  :title="tile.caption"
                  @click="toggleTile(tile)"
                >
                  <span class="album-frame">
                    <AssetMedia :name="char.name" :type="tile.type" :variant="tile.variant">
                      <span class="album-missing" aria-hidden="true">—</span>
                    </AssetMedia>
                  </span>
                  <span class="album-caption">{{ tile.caption }}</span>
                </button>
              </div>
            </section>
          </template>
        </div>
      </div>
    </div>

    <!-- 名字给了却查不到人（被删 / 改名）—— 不静默关窗，说清楚发生了什么 -->
    <div v-else class="viewer viewer-missing">
      <div class="empty-tab">此人已不在记载之中…</div>
      <button
        class="head-close missing-close"
        type="button"
        aria-label="关闭"
        @click="emit('close')"
      >
        ×
      </button>
    </div>
  </AppModal>
</template>

<style scoped>
/* ═══ 根: 左画像 + 右信息 ═══ */
.viewer {
  display: flex;
  height: 100%;
  min-height: 0;
  --paper-stack:
    0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent),
    0 4px 12px rgba(0, 0, 0, 0.08);
}
.viewer-missing {
  align-items: center;
  justify-content: center;
  position: relative;
}
.missing-close {
  position: absolute;
  top: var(--theme-spacing-md);
  right: var(--theme-spacing-md);
}

/* 画像栏 —— 42% 是让 4:5 立绘在常见桌面下几乎不被裁；再宽信息面就要折行 */
.viewer-portrait {
  flex: 0 0 42%;
  min-width: 0;
  overflow: hidden;
  background: var(--theme-surface-muted);
  border-right: 1px solid var(--theme-card-border);
}
.portrait-initials {
  font-family: var(--theme-font-title);
  font-size: clamp(6rem, 22vh, 16rem);
  font-weight: 700;
  line-height: 1;
  color: color-mix(in srgb, var(--theme-text-primary) 22%, transparent);
  user-select: none;
}

/* ═══ 信息面 ═══ */
/**
 * 🔴 `min-width: 0` **和** `min-height: 0` 两个都要，缺一个就有一档版式坏掉。
 *
 * flex 子项的默认 `min-*` 是 `auto`（= 不小于内容），所以 `flex: 1` 只给"可以长"，
 * 不给"可以缩"。少了 `min-height: 0`，窄屏那一档（`flex-direction: column`）里本栏
 * 会撑到内容的自然高度、把 `.viewer-scroll` 的内部滚动整个作废 —— 表现是**弹窗底部
 * 的内容被切掉且滚不到**（真机 768 宽走查逮到: 320 + 848 撑出 942 高的弹窗外）。
 * `min-width: 0` 同理管的是宽屏那一档（长字符串把本栏顶宽）。
 */
.viewer-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--theme-card-bg);
}

.viewer-head {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl) var(--theme-spacing-md);
}
.head-text {
  flex: 1;
  min-width: 0;
}
.head-name {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  letter-spacing: 0.02em;
}
.head-meta {
  margin-top: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.meta-sep {
  color: var(--theme-text-muted);
}
.head-close {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.35rem;
  line-height: 1;
  color: var(--theme-text-muted);
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.head-close:hover {
  color: var(--theme-text-primary);
  background: var(--theme-tab-hover-bg);
}

.viewer-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl) var(--theme-spacing-xl);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-lg);
}

/* ═══ Section 外壳（design.md §5.1 装饰线） ═══ */
.vw-sec {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.vw-sec-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  letter-spacing: 0.06em;
}
.vw-sec-title::before {
  content: '❖';
  font-size: 0.6875rem;
  color: var(--theme-primary);
}
.vw-sec-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

/* ═══ 好感度 ═══ */
.aff-block {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.aff-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.aff-title {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  letter-spacing: 0.06em;
}
.aff-value {
  font-size: 1rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--theme-quality-epic);
}
.aff-value.neg {
  color: var(--theme-error);
}
.aff-label {
  margin-right: var(--theme-spacing-sm);
  font-size: 0.75rem;
  font-weight: 500;
}
.aff-track {
  position: relative;
  height: 6px;
  border-radius: var(--theme-radius-full);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  overflow: hidden;
}
/* 中线两侧各占一半：正向从中线往右长，负向往左长 */
.aff-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 50%;
  background: var(--theme-quality-epic);
  transition: transform var(--theme-transition-normal, 0.3s ease-out);
}
.aff-fill.pos {
  left: 50%;
  transform-origin: left;
}
.aff-fill.neg {
  right: 50%;
  transform-origin: right;
  background: var(--theme-error);
}
.aff-zero {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: color-mix(in srgb, var(--theme-text-muted) 55%, transparent);
}
.aff-scale {
  display: flex;
  justify-content: space-between;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}

/* ═══ 档案四行 ═══ */
.prose-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.prose-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.prose-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-primary);
  letter-spacing: 0.04em;
}
.prose-text {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.7;
  color: var(--theme-text-primary);
}

/* ═══ 属性 ═══ */
.attr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
  gap: var(--theme-spacing-xs);
}
.attr-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.attr-name {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  letter-spacing: 0.04em;
}
.attr-num {
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  font-variant-numeric: tabular-nums;
}
.attr-free {
  font-size: 0.75rem;
  color: var(--theme-warning);
}

/* ═══ 登神长阶 ═══ */
.asc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: var(--theme-spacing-sm);
  align-items: start;
}
.asc-track {
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
/* 拿到了东西的那一档：全边混合边框 + 染底（design.md 的激活态配方，不用侧边条） */
.asc-track.filled {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.asc-track-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}
.asc-track-label {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}
.asc-track.filled .asc-track-label {
  color: var(--theme-text-primary);
  font-weight: 600;
}
.asc-track-count {
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  font-variant-numeric: tabular-nums;
}
.asc-cap {
  font-size: 0.6875rem;
  font-weight: 400;
  color: var(--theme-text-muted);
}
.asc-none {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  margin-top: var(--theme-spacing-xs);
  color: var(--theme-text-muted);
}
.asc-none-hint {
  font-size: 0.6875rem;
  font-style: italic;
}
.asc-entries {
  margin-top: var(--theme-spacing-xs);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.asc-entry-head {
  width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--theme-text-primary);
  font-family: inherit;
  text-align: left;
  transition: color var(--theme-transition-fast);
}
.asc-entry-head:hover {
  color: var(--theme-primary);
}
.asc-entry-name {
  font-size: 0.8125rem;
  font-weight: 600;
}
.asc-toggle {
  flex-shrink: 0;
  font-size: 0.9375rem;
  line-height: 1;
  color: var(--theme-primary);
}
.asc-entry-body {
  padding-bottom: var(--theme-spacing-sm);
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  line-height: 1.6;
}
.asc-desc {
  margin: 0;
}
.asc-effects {
  margin: var(--theme-spacing-xs) 0 0;
  padding-left: 1.1em;
}
.asc-cost {
  margin-top: var(--theme-spacing-xs);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.asc-divine {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs) var(--theme-spacing-sm);
  font-size: 0.75rem;
}
.dv-label {
  color: var(--theme-text-muted);
  letter-spacing: 0.04em;
}
.dv-value {
  color: var(--theme-text-primary);
  margin-right: var(--theme-spacing-md);
}
.dv-hint {
  color: var(--theme-text-muted);
  font-style: italic;
}

/* ═══ 心里话 / 背景 ═══ */
.thoughts {
  margin: 0;
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-style: italic;
  line-height: 1.7;
  color: var(--theme-text-secondary);
}
.thoughts::before {
  content: '“';
}
.thoughts::after {
  content: '”';
}
.story {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.75;
  color: var(--theme-text-primary);
}

/* ═══ 资源 / 状态 ═══ */
.res-stack {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.fx-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}
.fx-chip-btn {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  min-height: 36px;
  padding: 0 var(--theme-spacing-xs);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  font-family: inherit;
  transition: border-color var(--theme-transition-fast);
}
.fx-chip-btn:hover,
.fx-chip-btn[aria-expanded='true'] {
  border-color: var(--theme-card-border);
}
.fx-time {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.fx-detail {
  padding: var(--theme-spacing-md);
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 25%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
}
.fx-detail-name {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.fx-detail-desc {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}
.fx-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-md);
  margin-top: var(--theme-spacing-xs);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

/* ═══ 装备 / 技能 / 背包 卡片（design.md §4.2 统一外壳 + 色点着色） ═══ */
.thing-card {
  padding: var(--theme-spacing-md);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.thing-card + .thing-card {
  margin-top: var(--theme-spacing-sm);
}
.thing-head {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.q-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.thing-name {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.thing-tag {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  letter-spacing: 0.04em;
}
.thing-cost {
  margin-top: var(--theme-spacing-xs);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.thing-desc {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}
.thing-foot {
  margin-top: var(--theme-spacing-xs);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.kv-list {
  margin-top: var(--theme-spacing-sm);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kv-row {
  display: flex;
  gap: var(--theme-spacing-sm);
  font-size: 0.75rem;
}
.kv-k {
  min-width: 4rem;
  flex-shrink: 0;
  color: var(--theme-text-secondary);
  font-weight: 500;
}
.kv-v {
  color: var(--theme-text-primary);
}

/* ═══ 背包钱袋 ═══ */
.purse {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.purse-label {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  letter-spacing: 0.04em;
}
.purse-value {
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--theme-primary);
  font-variant-numeric: tabular-nums;
}

/* ═══ 相册 ═══ */
.album-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
  gap: var(--theme-spacing-sm);
}
.album-tile {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
  text-align: center;
}
/* 放大的那一格铺满整行 —— 相册里点一张就是想看清它 */
.album-tile.focused {
  grid-column: 1 / -1;
}
.album-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 5;
  overflow: hidden;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  color: var(--theme-text-muted);
  transition: border-color var(--theme-transition-fast);
}
.album-tile:hover .album-frame {
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
}
.album-tile.focused .album-frame {
  aspect-ratio: auto;
  height: min(60vh, 34rem);
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
}
/* 放大态下不要裁切: 这一格的意义就是"整张看清" */
.album-tile.focused .album-frame :deep(.asset-media) {
  object-fit: contain;
}
.album-missing {
  font-size: 1.25rem;
  opacity: 0.4;
}
.album-caption {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ═══ 空态（design.md §5.2） ═══ */
.empty-tab {
  padding: var(--theme-spacing-2xl) 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  font-size: 1.25rem;
  opacity: 0.3;
}

/* ═══ 折叠动画 —— 与 StatusOverview 同一份（opacity + 位移，绝不过渡布局属性） ═══ */
.collapse-enter-active {
  transition:
    opacity 0.2s ease-out,
    transform 0.2s ease-out;
}
.collapse-leave-active {
  transition: opacity 0.12s ease-in;
}
.collapse-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
.collapse-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .collapse-enter-active,
  .collapse-leave-active {
    transition: none;
  }
}

/* ═══ 窄屏: 画像转到上方，两栏叠成一栏 ═══ */
@media (max-width: 900px) {
  .viewer {
    flex-direction: column;
  }
  .viewer-portrait {
    flex: 0 0 34%;
    border-right: none;
    border-bottom: 1px solid var(--theme-card-border);
  }
  .viewer-head,
  .viewer-scroll {
    padding-left: var(--theme-spacing-lg);
    padding-right: var(--theme-spacing-lg);
  }
}
</style>
