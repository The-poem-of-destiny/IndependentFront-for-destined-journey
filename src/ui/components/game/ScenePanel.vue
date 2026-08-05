<script setup lang="ts">
import { computed, ref } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { tierVarByName } from '../../lib/quality-colors';
import { useHoverPopup } from '../../composables/useHoverPopup';
import AssetMedia from '../shared/AssetMedia.vue';
import { ASSET_TYPE_FALLBACK_CHAIN } from '@engine/asset-resolve';
import { markNewsRead } from '@engine/save-profile';
import { getAffectionLabel } from '@engine/affection-system';
import { MONTH_NAMES, WEEKDAY_NAMES, getTimeOfDay } from '@engine/time-system';
import { nameColorVar, initialsOf } from '../../utils/name-color';
import AppTabs from '../shared/AppTabs.vue';

const game = useGameStore();

// ═══ 时间 ═══
const timeInfo = computed(() => {
  const t = game.gameTime;
  if (!t) return null;
  return {
    era: `${t.era}${t.year}年`,
    date: `${MONTH_NAMES[t.month - 1]}${t.day}日 ${WEEKDAY_NAMES[t.weekday - 1]}`,
    time: `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`,
    timeOfDay: getTimeOfDay(t),
  };
});

/**
 * 时段 → 图标 + 氛围色 token
 *
 * 7 档时段分到 4 个视觉氛围 (凌晨/深夜→夜 / 早晨/上午→昼前 / 中午/下午→昼 / 傍晚→夕)
 * 氛围色用主题语义 token，不引入硬编码 hex，双模式下都能呼吸。
 */
const TOD_META: Record<string, { icon: string; colorVar: string }> = {
  凌晨: { icon: 'fa-solid fa-moon', colorVar: '--theme-quality-rare' }, // 静谧蓝
  早晨: { icon: 'fa-solid fa-sun', colorVar: '--theme-quality-uncommon' }, // 晨光绿
  上午: { icon: 'fa-solid fa-sun', colorVar: '--theme-quality-uncommon' },
  中午: { icon: 'fa-solid fa-sun', colorVar: '--theme-warning' }, // 正午金
  下午: { icon: 'fa-solid fa-sun', colorVar: '--theme-warning' },
  傍晚: { icon: 'fa-solid fa-cloud-sun', colorVar: '--theme-quality-mythic' }, // 黄昏赤
  深夜: { icon: 'fa-solid fa-moon', colorVar: '--theme-quality-rare' },
};

const todMeta = computed(() => {
  const t = game.gameTime;
  if (!t) return null;
  const tod = getTimeOfDay(t);
  return TOD_META[tod] ?? { icon: 'fa-solid fa-clock', colorVar: '--theme-text-muted' };
});

// ═══ 位置 ═══
const locationDisplay = computed(() => {
  const loc = game.player?.location;
  if (!loc) return '未知';
  return loc.replace(/-/g, ' · ');
});

// ═══ 天气 —— 变量真源 SaveProfile.variables（M5 §12；dispatcher 的 天气 变量落 sys 命名空间），worldFlags 兜底旧数据 ═══
const weather = computed(() => {
  const sys = (game.saveProfile?.variables as any)?.sys;
  const wf = game.saveProfile?.worldFlags;
  return (sys?.['天气'] as string) ?? (wf?.['天气'] as string) ?? (wf?.['weather'] as string) ?? '';
});

// ═══ 在场角色 — present 字段判断 ═══
const presentChars = computed(() => {
  // 兜 undefined：心声气泡的 popChar 计算在 activeSaveId 分支之外，
  // 未加载存档时也会求值一次，characters 还没就位就会炸。
  const all = game.characters ?? [];
  return all.filter((c) => {
    if (c.type === 'player') return false;
    return c.present === true;
  });
});

// ═══ 页签 ═══
type SceneTab = 'chars' | 'quests' | 'world' | 'misc';
/** 默认落在「角色」—— 在场者是场景栏最即时的信息，不该藏在页签后面 */
const activeTab = ref<SceneTab>('chars');

/** 未读世界消息数 —— 只有它配得上 AppTabs 的红色 badge（真提醒，不是纯计数） */
const unreadNews = computed(() => game.news.filter((n) => !n.read).length);

const sceneTabs = computed(() => [
  { key: 'chars' as SceneTab, label: '角色' },
  { key: 'quests' as SceneTab, label: '任务' },
  { key: 'world' as SceneTab, label: '世界', badge: unreadNews.value || undefined },
  { key: 'misc' as SceneTab, label: '万象' },
]);

// ═══ 任务（原在右侧状态栏「任务追踪」，M6 起改挂左栏页签） ═══
const questEntries = computed(() => {
  const quests = game.saveProfile?.quests;
  if (!quests) return [];
  const order: Record<string, number> = { 高: 0, 中: 1, 低: 2 };
  return Object.entries(quests).sort(
    ([, a], [, b]) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2),
  );
});

function openQuests() {
  game.showModal('quests');
}

/** 任务就地展开详情（对齐右栏持有物条目的交互） */
const expandedQuest = ref<string | null>(null);
function toggleQuest(name: string) {
  expandedQuest.value = expandedQuest.value === name ? null : name;
}

// ═══ 角色页签：悬停弹出心声气泡（延迟走全局设置 settings.hoverDelayMs） ═══
// 挂在行的右侧 —— 场景栏在最左，气泡向右展开不会盖住角色列表本身
const thoughtPop = useHoverPopup({
  // 气泡同样 zoom:1.1（它 Teleport 到 body，不在面板内拿不到面板的 zoom），
  // 故传给夹紧计算的是**渲染后**尺寸：260×1.1=286 / 120×1.1=132
  width: 286,
  estHeight: 132,
  zoom: 1.1,
  placement: 'right-bottom',
  gap: 6,
  anchorSelector: '.npc-portrait', // 气泡左下角贴头像右上角
});
const popChar = computed(
  () => presentChars.value.find((c) => c.id === thoughtPop.key.value) ?? null,
);
const popThought = computed(() =>
  popChar.value ? game.getThoughts(popChar.value) || '此刻风平浪静，无声可闻…' : '',
);

/**
 * 层级名 → CSS 变量描边色。
 *
 * Q-11 修：这里此前是一张按**品质名**（普通/优良/稀有/…）建的六项表，却拿
 * `tierName`（普通/中坚/精英/史诗/传说/神话/神祗）去查 —— T2 中坚 / T3 精英 /
 * T7 神祗 三级永远查不着、落到静音灰，其余几级靠词形巧合碰对。
 * 现在走 `tierVarByName`，它经 `TIER_CONFIGS` 反查序号，不依赖词形。
 */
const tierColor = tierVarByName;

// ═══ 好感度 ═══
// 真源是 saveProfile.affections，按**角色名**索引（M2/M5 起，rename_character 随迁）
function affectionOf(name: string): number {
  return game.saveProfile?.affections?.[name] ?? 0;
}
/** [-100,100] → 单边填充比例 [0,1]；符号决定往左还是往右长 */
function affectionRatio(name: string): number {
  return Math.min(1, Math.abs(affectionOf(name)) / 100);
}
function affectionText(name: string): string {
  const v = affectionOf(name);
  return `${getAffectionLabel(v)} ${v > 0 ? '+' : ''}${v}`;
}

// ═══ 下段：新闻单选展开 ═══
const expandedNewsId = ref<string | null>(null);

/**
 * M6 #36: 展开新闻时标记已读并持久化。
 * 先改内存 reactive（红点即时消失、其他面板即时可见），再传 JSON 克隆给 markNewsRead 落库
 * （Dexie 结构化克隆吃不下 Vue Proxy，同 QuestsPanel focusQuest 回写的做法）。
 */
async function toggleNews(id: string) {
  const opening = expandedNewsId.value !== id;
  expandedNewsId.value = opening ? id : null;
  if (!opening) return;

  const profile = game.saveProfile;
  if (!profile) return;
  const item = profile.news?.find((n) => n.id === id);
  if (!item || item.read) return; // 只标未读项

  item.read = true;
  try {
    await markNewsRead(JSON.parse(JSON.stringify(profile)), id);
  } catch (err) {
    console.error('[ScenePanel] 新闻已读标记持久化失败:', err);
  }
}

function openCharList() {
  game.showModal('characters');
}
</script>

<template>
  <div v-if="game.activeSaveId" class="scene-panel">
    <!-- ═══════ 上段：场景 (时间 + 位置 + 天气) ═══════ -->
    <div class="scene-top">
      <!-- 时间 —— 无标题：纪元年 + 月日周合并一行，时段/时刻置于其下 -->
      <div class="scene-section scene-datetime">
        <template v-if="timeInfo">
          <div class="scene-date-line">{{ timeInfo.era }} {{ timeInfo.date }}</div>
          <div
            class="scene-tod-line"
            :style="{ '--tod-color': `var(${todMeta?.colorVar ?? '--theme-text-muted'})` }"
          >
            <i :class="'scene-tod-icon ' + (todMeta?.icon ?? 'fa-solid fa-clock')" />
            <span class="scene-tod-name">{{ timeInfo.timeOfDay }}</span>
            <span class="scene-tod-clock">{{ timeInfo.time }}</span>
          </div>
        </template>
        <div v-else class="scene-empty">时间未同步</div>
      </div>

      <!-- 位置 -->
      <div class="scene-section">
        <div class="scene-section-title">位置</div>
        <div class="scene-location">{{ locationDisplay }}</div>
      </div>

      <!-- 天气 -->
      <div v-if="weather" class="scene-section">
        <div class="scene-section-title">天气</div>
        <div class="scene-weather">{{ weather }}</div>
      </div>
    </div>

    <!-- ═══════ 页签：任务 / 角色 / 世界 / 万象 ═══════ -->
    <AppTabs :tabs="sceneTabs" :active="activeTab" @select="activeTab = $event" />

    <div class="scene-tab-body">
      <!-- ─── 任务 ─── -->
      <template v-if="activeTab === 'quests'">
        <div class="scene-section-title scene-pane-title">
          <span>任务 ({{ questEntries.length }})</span>
          <button
            class="scene-title-action"
            title="打开任务面板"
            aria-label="打开任务面板"
            @click="openQuests"
          >
            ›
          </button>
        </div>

        <div v-if="questEntries.length" class="quest-list">
          <div
            v-for="[name, q] in questEntries"
            :key="name"
            class="quest-item"
            :class="{ open: expandedQuest === name }"
            role="button"
            tabindex="0"
            :aria-expanded="expandedQuest === name"
            @click="toggleQuest(name)"
            @keydown.enter="toggleQuest(name)"
            @keydown.space.prevent="toggleQuest(name)"
          >
            <div class="quest-top">
              <span class="quest-name">{{ name }}</span>
              <span class="quest-prio" :class="'pri-' + q.priority">{{ q.priority }}</span>
              <i
                class="fa-solid quest-chevron"
                :class="expandedQuest === name ? 'fa-chevron-up' : 'fa-chevron-down'"
              />
            </div>
            <div v-if="q.objective" class="quest-obj">{{ q.objective }}</div>

            <div v-if="expandedQuest === name" class="quest-detail">
              <div v-if="q.progress" class="qd-row">
                <span class="qd-label">进展</span>
                <span class="qd-value qd-prog">{{ q.progress }}</span>
              </div>
              <div v-if="q.detail" class="qd-row">
                <span class="qd-label">详情</span>
                <span class="qd-value">{{ q.detail }}</span>
              </div>
              <div v-if="q.reward" class="qd-row">
                <span class="qd-label">奖励</span>
                <span class="qd-value qd-reward">{{ q.reward }}</span>
              </div>
              <div v-if="q.status" class="qd-row">
                <span class="qd-label">状态</span>
                <span class="qd-value">{{ q.status }}</span>
              </div>
              <div v-if="!q.progress && !q.detail && !q.reward && !q.status" class="qd-empty">
                暂无更多记载
              </div>
            </div>
          </div>
        </div>

        <div v-else class="empty-tab">尚无在办之事…</div>
      </template>

      <!-- ─── 角色 ─── -->
      <template v-else-if="activeTab === 'chars'">
        <div class="scene-section-title scene-pane-title">
          <span>在场 ({{ presentChars.length }})</span>
          <button
            class="scene-title-action"
            title="查看完整角色列表"
            aria-label="查看完整角色列表"
            @click="openCharList"
          >
            ›
          </button>
        </div>

        <div v-if="presentChars.length" class="scene-npc-list">
          <button
            v-for="char in presentChars"
            :key="char.id"
            class="scene-npc-item"
            :class="{ hovered: thoughtPop.key.value === char.id }"
            :aria-describedby="thoughtPop.key.value === char.id ? 'npc-thought-pop' : undefined"
            @mouseenter="thoughtPop.onEnter($event, char.id)"
            @mouseleave="thoughtPop.hide"
            @focus="thoughtPop.onFocus($event, char.id)"
            @blur="thoughtPop.hide"
          >
            <!-- ⚠️ `.npc-portrait` 同时是心声气泡的 anchorSelector（见上方 thoughtPop），
               类必须留在**外层**元素上；素材只能塞进它里面。
               46×58 的 4:5 竖幅 = 立牌形状，所以走**立牌链** `立绘 → 立绘bg → 头像`:
               只有头像的角色也能占住这一位（构图不完美，但好过一个首字母的洞）。 -->
            <span class="npc-portrait" :style="{ '--npc-avatar-color': nameColorVar(char.name) }">
              <AssetMedia :name="char.name" :type="ASSET_TYPE_FALLBACK_CHAIN">{{
                initialsOf(char.name)
              }}</AssetMedia>
            </span>

            <span class="npc-main">
              <span class="npc-line">
                <span class="npc-name">{{ char.name }}</span>
                <span
                  v-if="char.tier"
                  class="npc-tier"
                  :style="{
                    color: tierColor((char as any).tierName),
                    borderColor: tierColor((char as any).tierName),
                  }"
                >
                  T{{ char.tier }}
                </span>
              </span>

              <span class="npc-lv">Lv.{{ char.level ?? 1 }}</span>

              <!-- 好感度 [-100,100]：中线为 0，正向右生长、负向左生长 -->
              <span class="npc-aff">
                <span class="aff-track">
                  <span
                    class="aff-fill"
                    :class="affectionOf(char.name) < 0 ? 'neg' : 'pos'"
                    :style="{ transform: `scaleX(${affectionRatio(char.name)})` }"
                  />
                  <span class="aff-zero" aria-hidden="true" />
                </span>
                <span class="aff-text" :class="affectionOf(char.name) < 0 ? 'neg' : 'pos'">
                  {{ affectionText(char.name) }}
                </span>
              </span>
            </span>
          </button>
        </div>

        <div v-else class="empty-tab">此处别无他人…</div>
      </template>

      <!-- ─── 世界 ─── -->
      <template v-else-if="activeTab === 'world'">
        <div class="scene-section-title">
          世界消息 · {{ timeInfo?.date || '' }} {{ timeInfo?.time || '' }}
        </div>

        <div v-if="game.news.length" class="scene-news-list">
          <div
            v-for="item in game.news"
            :key="item.id"
            class="news-item"
            :class="{ expanded: expandedNewsId === item.id, read: item.read }"
            role="button"
            tabindex="0"
            :aria-expanded="expandedNewsId === item.id"
            @click="toggleNews(item.id)"
            @keydown.enter="toggleNews(item.id)"
            @keydown.space.prevent="toggleNews(item.id)"
          >
            <span v-if="!item.read" class="news-dot" />
            <i v-else class="news-icon fa-solid fa-newspaper" />
            <div class="news-main">
              <div class="news-title-row">
                <span class="news-title">{{ item.title }}</span>
              </div>
              <div v-if="expandedNewsId === item.id" class="news-content">
                <span v-if="item.category" class="news-category">{{ item.category }}</span>
                {{ item.content }}
              </div>
            </div>
          </div>
        </div>

        <div v-else class="empty-tab">四方无声，暂无新讯…</div>
      </template>

      <!-- ─── 万象 ───
           占位：日后收纳「资产」一类条目 —— 需要具体信息、但不隶属于世界本身的记载 -->
      <div v-else class="empty-tab misc-placeholder">
        <div>万象未启，此页尚空…</div>
        <div class="misc-note">
          此处日后收纳资产等条目 —— 需要具体信息、却独立于世界之外的记载。
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ 未加载 ═══ -->
  <div v-else class="scene-panel scene-panel-empty">
    <div class="scene-empty-msg">未选择存档</div>
  </div>

  <!-- ═══ 心声气泡（Teleport 出滚动容器，否则会被 overflow 裁掉） ═══ -->
  <Teleport to="body">
    <Transition name="thought-pop">
      <div
        v-if="popChar && thoughtPop.style.value"
        id="npc-thought-pop"
        class="thought-bubble"
        role="tooltip"
        :style="thoughtPop.style.value"
      >
        <div class="tb-who">{{ popChar.name }}·心声</div>
        <div class="tb-text">{{ popThought }}</div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ═══ 根容器 — 三段式 flex column，外层不滚 ═══ */
.scene-panel {
  /* 内容整体放大 10%。zoom 只放大内容，不改元素自身已解析的宽度
     （实测：面板仍占屏宽 25% − 工具栏），所以宽度无需补偿。 */
  zoom: 1.1;
  width: calc(25% - var(--rail-w, 4.2rem));
  min-width: 200px;
  flex-shrink: 0;
  overflow: hidden; /* 外层不滚， scrolls 委托给 mid/bot */
  background: var(--theme-content-bg);
  border-right: 1px solid var(--theme-card-border);
  display: flex;
  flex-direction: column;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}

.scene-panel-empty {
  height: 100%;
  align-items: center;
  justify-content: center;
}

/* ═══ 场景头 + 页签体 ═══ */
.scene-top {
  flex-shrink: 0;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--theme-card-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 页签内容区独占剩余高度并自行滚动，外层不滚 */
.scene-tab-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
}

/* ═══ 区块标题 ═══ */
.scene-section {
  padding-bottom: 4px;
}
.scene-section-title {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--theme-text-muted);
  margin-bottom: 5px;
  font-family: system-ui, sans-serif;
  display: flex;
  align-items: center;
}
.scene-pane-title {
  justify-content: space-between;
}
.scene-title-action {
  background: none;
  border: none;
  color: var(--theme-text-muted);
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  font-family: inherit;
  transition: color 150ms;
}
.scene-title-action:hover {
  color: var(--theme-text-secondary);
}

/* ═══ 时间 —— 日期一行在上，时段/时刻在下 ═══ */
.scene-datetime {
  padding-top: 2px;
  padding-bottom: 0;
}
.scene-date-line {
  font-family: var(--theme-font-title, serif);
  font-size: 0.95rem;
  color: var(--theme-text-primary);
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.3;
}
.scene-tod-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 0;
  color: var(--tod-color, var(--theme-text-secondary));
}
.scene-tod-icon {
  font-size: 0.85rem;
  filter: drop-shadow(
    0 0 4px color-mix(in srgb, var(--tod-color, var(--theme-text-muted)) 55%, transparent)
  );
}
.scene-tod-name {
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  font-family: system-ui, sans-serif;
}
.scene-tod-clock {
  margin-left: auto;
  font-family: var(--theme-font-body, system-ui, sans-serif);
  font-variant-numeric: tabular-nums;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--theme-text-primary);
  opacity: 0.85;
}
/* ═══ 任务页签 ═══ */
.quest-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.quest-item {
  padding: 6px 8px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm, 4px);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
  cursor: pointer;
  transition:
    background 120ms,
    border-color 120ms;
}
.quest-item:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
}
.quest-item.open {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-surface-muted));
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
}
.quest-chevron {
  flex-shrink: 0;
  font-size: 0.5rem;
  color: var(--theme-text-muted);
  opacity: 0.55;
}
.quest-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.quest-name {
  flex: 1;
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
.quest-prio {
  font-size: 0.625rem;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
  flex-shrink: 0;
}
.pri-高 {
  background: color-mix(in srgb, var(--theme-error) 18%, transparent);
  color: var(--theme-error);
}
.pri-中 {
  background: color-mix(in srgb, var(--theme-warning) 18%, transparent);
  color: var(--theme-warning);
}
.pri-低 {
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
}
.quest-obj {
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  margin-top: 3px;
  line-height: 1.5;
}
/* 任务展开详情 */
.quest-detail {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--theme-card-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.qd-row {
  display: flex;
  gap: 6px;
  font-size: 0.6875rem;
  line-height: 1.5;
}
.qd-label {
  flex-shrink: 0;
  width: 2.2em;
  color: var(--theme-text-muted);
}
.qd-value {
  flex: 1;
  min-width: 0;
  color: var(--theme-text-secondary);
  overflow-wrap: break-word;
}
.qd-prog {
  color: var(--theme-success);
}
.qd-reward {
  color: var(--theme-currency-gold);
}
.qd-empty {
  font-size: 0.6875rem;
  font-style: italic;
  color: var(--theme-text-muted);
}

/* ═══ 位置 / 天气 ═══ */
.scene-location {
  font-size: 0.78rem;
  color: var(--theme-text-secondary);
  line-height: 1.45;
  word-break: break-all;
  overflow-wrap: break-word;
}
.scene-weather {
  font-size: 0.78rem;
  color: var(--theme-text-secondary);
  font-style: italic;
}

/* ═══ 中段 NPC 行 ═══ */
.scene-npc-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 行本身不再可点（心声改悬停）—— cursor: help，别再用手型骗人说"可点" */
/* 整行右对齐：画像在右，文字靠右排 —— 画像右缘贴近面板右缘，
   心声气泡从那里向右上方冒出，正好朝着正文区 */
.scene-npc-item {
  display: flex;
  flex-direction: row-reverse;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border: none;
  background: none;
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  text-align: left;
  border-radius: var(--theme-radius-md, 6px);
  cursor: help;
  transition: background 120ms;
  user-select: none;
}
.scene-npc-item:hover,
.scene-npc-item.hovered {
  background: var(--theme-tab-hover-bg);
}

/* 矩形画像框 —— 4:5 竖构图，走 design.md §4.2 的卡片外壳 */
.npc-portrait {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 58px;
  flex-shrink: 0;
  border-radius: var(--theme-radius-sm, 4px);
  border: 1px solid var(--theme-card-border);
  background: var(--npc-avatar-color, var(--theme-quality-common));
  box-shadow: var(--paper-stack);
  color: var(--theme-primary-text);
  font-size: 0.95rem;
  font-weight: 700;
  font-family: var(--theme-font-title, serif);
  letter-spacing: -0.02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  white-space: nowrap;
}
.npc-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end; /* 文字块整体靠右 */
  gap: 3px;
}
/* 同样反向：品质徽章在左、名字紧挨画像 */
.npc-line {
  display: flex;
  flex-direction: row-reverse;
  align-items: center;
  gap: 6px;
  min-width: 0;
  align-self: stretch;
}
.npc-name {
  flex: 1;
  text-align: right;
  font-size: 0.78rem;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.npc-tier {
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--theme-text-muted);
  background: var(--theme-surface-muted);
  padding: 1px 5px;
  border-radius: var(--theme-radius-sm, 4px);
  border: 1px solid transparent;
  flex-shrink: 0;
}
.npc-lv {
  font-size: 0.65rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

/* ═══ 好感度条 —— 零点居中，双向生长 ═══ */
.npc-aff {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-self: stretch; /* 好感度条要占满，不能被 align-items:flex-end 收成内容宽 */
}
.aff-track {
  position: relative;
  height: 4px;
  border-radius: 2px;
  background: var(--theme-surface-muted);
  overflow: hidden;
}
/* 用 transform: scaleX 而非 width —— design.md §1 禁止布局属性过渡 */
.aff-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 50%;
  border-radius: 2px;
  transition: transform 0.3s ease-out;
}
.aff-fill.pos {
  left: 50%;
  transform-origin: left;
  background: var(--theme-affection);
}
.aff-fill.neg {
  left: 0;
  transform-origin: right;
  background: var(--theme-error);
}
.aff-zero {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--theme-text-muted) 55%, transparent);
}
.aff-text {
  font-size: 0.6rem;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.aff-text.pos {
  color: var(--theme-affection-text);
}
.aff-text.neg {
  color: var(--theme-error);
}

@media (prefers-reduced-motion: reduce) {
  .aff-fill {
    transition: none;
  }
}

/* ═══ 心声气泡 —— 云朵造型的 thought bubble ═══
   左下角锚定在角色行上（见 useHoverPopup 的 'right-bottom'），
   两颗递减的小圆点自左下角向下、向左延伸，指回发出心声的角色 */
.thought-bubble {
  position: fixed;
  z-index: var(--z-tooltip, 500);
  zoom: 1.1; /* 与场景栏同步放大 —— 它在面板外，继承不到 */
  width: 260px;
  padding: 11px 14px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--theme-primary) 7%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 28%, var(--theme-card-border));
  box-shadow: var(--theme-shadow-lg);
  pointer-events: none; /* 气泡不吃鼠标，避免盖住行造成进出闪烁 */
}
/* 思绪尾巴：两颗圆点，越靠近角色越小 */
.thought-bubble::before,
.thought-bubble::after {
  content: '';
  position: absolute;
  border-radius: 50%;
  background: color-mix(in srgb, var(--theme-primary) 7%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 28%, var(--theme-card-border));
}
.thought-bubble::before {
  width: 10px;
  height: 10px;
  left: -5px;
  bottom: -6px;
}
.thought-bubble::after {
  width: 6px;
  height: 6px;
  left: -15px;
  bottom: -15px;
}
.tb-who {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.tb-text {
  font-size: 0.75rem;
  font-style: italic;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}

.thought-pop-enter-active {
  transition: opacity 0.14s ease-out;
}
.thought-pop-leave-active {
  transition: opacity 0.1s ease-in;
}
.thought-pop-enter-from,
.thought-pop-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .thought-pop-enter-active,
  .thought-pop-leave-active {
    transition: none;
  }
}

/* ═══ 下段新闻 ═══ */
.scene-news-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.news-item {
  display: flex;
  gap: 8px;
  padding: 6px 7px;
  border-radius: var(--theme-radius-md, 6px);
  cursor: pointer;
  transition: background 120ms;
}
.news-item:hover {
  background: var(--theme-tab-hover-bg);
}
.news-item.expanded {
  background: var(--theme-primary-bg);
}

.news-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-top: 4px;
  flex-shrink: 0;
  background: var(--theme-quality-mythic);
  box-shadow: 0 0 5px color-mix(in srgb, var(--theme-quality-mythic) 60%, transparent);
}
.news-icon {
  font-size: 0.72rem;
  margin-top: 3px;
  color: var(--theme-text-muted);
  flex-shrink: 0;
}
.news-main {
  flex: 1;
  min-width: 0;
}
.news-title-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.news-title {
  flex: 1;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.news-item.read .news-title {
  color: var(--theme-text-secondary);
  font-weight: 500;
}
.news-time {
  flex-shrink: 0;
  font-size: 0.62rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}
.news-content {
  margin-top: 4px;
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
  line-height: 1.5;
}
.news-category {
  display: inline-block;
  font-size: 0.6rem;
  color: var(--theme-primary);
  background: var(--theme-primary-bg);
  padding: 0 5px;
  border-radius: 2px;
  margin-right: 5px;
  font-style: normal;
}

/* ═══ 空态 ═══ */
.scene-empty {
  font-size: 0.65rem;
  color: var(--theme-text-muted);
  font-style: italic;
}
/* 空态 —— design.md §5.2 统一配方：装饰符 + 斜体说明 */
.empty-tab {
  padding: 32px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: 8px;
  font-size: 1.25rem;
  opacity: 0.3;
}
.misc-placeholder {
  padding-left: 8px;
  padding-right: 8px;
}
.misc-note {
  margin-top: 10px;
  font-size: 0.6875rem;
  font-style: normal;
  line-height: 1.6;
  color: color-mix(in srgb, var(--theme-text-muted) 80%, transparent);
}
.scene-empty-msg {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
</style>
