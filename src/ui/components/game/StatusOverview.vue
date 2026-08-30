<script setup lang="ts">
import { ref, computed } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { useHoverPopup } from '../../composables/useHoverPopup';
import { usePlayerPortrait } from '../../composables/usePlayerPortrait';
import { normalizeItemType } from '@engine/field-enums';
import { getTierConfig } from '@engine/tier-constants';
import { getRequiredXpForLevel } from '@engine/exp-table';
import type { AllocatableAttr } from '@engine/attribute-allocation';
import type { PlayerPersonaDraft } from '@engine/state-manager';
import ResourceBar from '../shared/ResourceBar.vue';
import AvatarPanel from '../shared/AvatarPanel.vue';
import CharacterPortrait from '../shared/CharacterPortrait.vue';
import PortraitSettingsDialog from '../shared/PortraitSettingsDialog.vue';
import AppTabs from '../shared/AppTabs.vue';
import AppButton from '../shared/AppButton.vue';
import BuffChip from '../shared/BuffChip.vue';
import PlayerPersonaEditorModal from './PlayerPersonaEditorModal.vue';
// 裁剪台是 shared/ 的东西（它只认「一份源字节 + 一个名字」，跟设置页零耦合；
// 正因为这里也在用它，它才不该住在 settings/assets/ 下）。这里**原样消费**
// 它的 props/events，不复制一份 —— 复制一份就等于把 D16 不变式、撞位分配、
// 部分成功口径再实现一遍。
import AssetCropEditor from '../shared/AssetCropEditor.vue';

const game = useGameStore();
const ui = useUIStore();

const player = computed(() => game.player);

// ═══ 玩家叙事人设编辑 ════════════════════════════════════════
const personaOpen = ref(false);
const personaSaving = ref(false);
const personaError = ref('');
const playerPersona = computed<PlayerPersonaDraft>(() => ({
  personality: player.value?.personality ?? '',
  appearance: player.value?.appearance ?? '',
  background: player.value?.background ?? '',
}));
const personaBlockedReason = computed(() => {
  if (game.isGenerating) return '当前回合生成中，结束后可编辑人设';
  if (game.isInCombat) return '战斗结束后可编辑人设';
  return '';
});

function openPersonaEditor() {
  if (personaBlockedReason.value) return;
  personaError.value = '';
  personaOpen.value = true;
}

function closePersonaEditor() {
  if (personaSaving.value) return;
  personaOpen.value = false;
  personaError.value = '';
}

async function savePersona(draft: PlayerPersonaDraft) {
  if (personaSaving.value) return;
  personaSaving.value = true;
  personaError.value = '';
  try {
    const result = await game.updatePlayerPersona(draft);
    if (!result.ok) {
      personaError.value = result.error;
      ui.toast(result.error, 'error');
      return;
    }
    personaOpen.value = false;
    ui.toast('人设已更新，将从下一次行动起生效', 'success');
  } finally {
    personaSaving.value = false;
  }
}

// ═══ 玩家画像 ═══════════════════════════════════════════════
//
// 整段（读哪条链 / 点了去哪 / mp4 落哪一格 / 裁剪台开关 / 每种结局说什么）已经
// 搬进 `composables/usePlayerPortrait.ts` 与 `game/portrait-messages.ts`（Q-25）。
// 那 260 行是与「状态总览显示什么」不相干的第二个变更理由: 改一个受理 MIME 与
// 改一行属性布局本不该动同一个文件，而同级那份 897 行测试全部只服务于它。
//
// 🔴 **按模板现有的名字解构** —— 模板一个字都没改，于是那 897 行挂载测试原样
//    成为这次搬迁"行为等价"的证据。等真机走查过了再谈把它们瘦成纯函数测试；
//    在证明搬对了之前就删回归网，等于把唯一的证据先烧掉。
const {
  url: portraitUrl,
  isVideo: portraitIsVideo,
  row: portraitRow,
  hasLargePortrait,
  actionLabel: portraitActionLabel,
  accept: PORTRAIT_ACCEPT,
  inputRef: portraitInput,
  activate: onPortraitActivate,
  pick: pickPortrait,
  onFile: onPortraitFile,
  dialogOpen: portraitDialogOpen,
  closeDialog: closePortraitDialog,
  cropOpen,
  cropSource,
  cropName,
  closeCrop,
  onCropSaved,
} = usePlayerPortrait(() => player.value?.name);

// ═══ 折叠状态 ═══
const daoOpen = ref(true);
const inventoryOpen = ref(true);

// ═══ 状态效果：悬停弹出详情（延迟走全局设置 settings.hoverDelayMs） ═══
// 气泡 Teleport 到 body，拿不到状态栏的 zoom:1.1，自己缩放；
// 传给夹紧计算的是**渲染后**尺寸：240×1.1=264 / 132×1.1=145
const buffPop = useHoverPopup({ width: 264, estHeight: 145, zoom: 1.1, placement: 'below' });
const popBuff = computed(
  () => player.value?.statusEffects?.find((f) => f.name === buffPop.key.value) ?? null,
);

// ═══ 身份元信息 —— 顶部一行（取代原「玩家概要」标题 + 整个「个人信息」区块） ═══
const identityFields = computed(() => {
  const p = player.value;
  if (!p) return [];
  return [
    { label: '种族', value: p.race || '—', cls: '' },
    { label: '身份', value: p.identity?.[0] || '—', cls: '' },
    { label: '职业', value: p.occupation?.[0] || '—', cls: '' },
    { label: '生命层级', value: p.tierName || '—', cls: 'tier-text' },
    { label: '冒险者等级', value: p.adventurerRank ? `${p.adventurerRank}级` : '—', cls: '' },
  ];
});
/** 一行放不下时会被省略号截断，完整带标签的版本挂在 title 上，信息不丢 */
const identityTitle = computed(() =>
  identityFields.value.map((f) => `${f.label}：${f.value}`).join('　'),
);

// ═══ 属性映射 ═══
const ATTR_LABELS: Record<string, string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  spi: '精神',
};

// ═══ 自由属性点：剩余点数 + 每维一个「+」 ═══
//
// 🔴 **上限判据只查一处**（ADR-11 数值规则归 Code）：`getTierConfig(tier).attributeCap`，
//    与引擎 `allocateAttributePoint` 用的是同一张表 —— 前端自己算一份，迟早会出现
//    「按钮亮着、点下去被引擎拒」或反过来「明明还能加却按不动」。
// 🔴 查不到层级配置（越界层级 / 脏数据）时**不禁用**：上限未知就拦死，等于把玩家
//    已经到手的点数扣在手里，且引擎那侧对同一情况也是放行的。
const freeAttrPoints = computed(() => player.value?.freeAttrPoints ?? 0);
const attributeCap = computed(() => getTierConfig(player.value?.tier ?? 0)?.attributeCap);

/**
 * 🆕 经验条上限 = 当前等级对应的累计门槛（经验系统改造 v1，2026-08-24）。
 * current = 累计经验 `totalExp`，max = `getRequiredXpForLevel(level)`（Lv1=120, Lv2=360, …）。
 * 满级（Lv25 返回 'MAX'）→ null，模板整条隐藏并显示「已满级」。
 */
const expMax = computed<number | null>(() => {
  const lv = player.value?.level ?? 1;
  const required = getRequiredXpForLevel(lv);
  return typeof required === 'number' ? required : null;
});

/** 一次只放一个请求过去 —— 最后 1 点被连点两下会拿到一次「没有可用的自由属性点」 */
const allocating = ref(false);

const attrEntries = computed(() =>
  Object.entries(player.value?.attributes ?? {}).map(([key, value]) => {
    const cap = attributeCap.value;
    const atCap = typeof cap === 'number' && typeof value === 'number' && value >= cap;
    return {
      key,
      label: ATTR_LABELS[key] || key,
      value,
      atCap,
      /** 禁用时说清为什么；能点时说清点了会发生什么 */
      plusTitle: atCap ? `已达当前层级上限（${cap}）` : `分配 1 点到${ATTR_LABELS[key] || key}`,
    };
  }),
);

/** 点「+」→ 花 1 点。失败原因由引擎给（点数不足 / 到顶 / 落库失败），本层只负责播报 */
async function addAttrPoint(attr: string) {
  if (allocating.value) return;
  allocating.value = true;
  try {
    const result = await game.allocateAttrPoint(attr as AllocatableAttr);
    if (!result.ok) ui.toast(result.error ?? '属性点分配失败', 'error');
  } finally {
    allocating.value = false;
  }
}

// ═══ 装备列表 ═══
// M6 完整重构: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3），槽位为中文枚举
const EQUIP_ICONS: Record<string, string> = {
  武器: 'fa-solid fa-sword',
  副手: 'fa-solid fa-shield-halved',
  头部: 'fa-solid fa-helmet-safety',
  身体: 'fa-solid fa-shirt',
  手部: 'fa-solid fa-mitten',
  脚部: 'fa-solid fa-shoe-prints',
  腰带: 'fa-solid fa-ring',
  饰品: 'fa-regular fa-gem',
};
const equipmentList = computed(() =>
  (player.value?.inventory ?? [])
    .filter((i) => i.equippedSlot)
    .map((e) => ({
      ...e,
      icon: EQUIP_ICONS[e.equippedSlot!] || 'fa-solid fa-circle',
    })),
);

// ═══ 持有物页签：装备 / 背包 / 消耗品 / 技能 ═══
type HoldTab = 'equipment' | 'bag' | 'consumable' | 'skills';
const holdTab = ref<HoldTab>('equipment');
const holdTabs: { key: HoldTab; label: string }[] = [
  { key: 'equipment', label: '装备' },
  { key: 'bag', label: '背包' },
  { key: 'consumable', label: '消耗品' },
  { key: 'skills', label: '技能' },
];

/** 未穿戴的物品（穿戴中的归「装备」页签，规范 §3：装备是物品的状态而非独立实体） */
const unequipped = computed(() => (player.value?.inventory ?? []).filter((i) => !i.equippedSlot));
const consumableList = computed(() =>
  unequipped.value.filter((i) => normalizeItemType(i.type ?? '') === '消耗品'),
);
/** 背包 = 未穿戴且非消耗品（材料/任务物品/特殊/未穿戴的装备都在这） */
const bagList = computed(() =>
  unequipped.value.filter((i) => normalizeItemType(i.type ?? '') !== '消耗品'),
);
const skillList = computed(() => player.value?.skills ?? []);

/** 统一行模型 —— 四个页签共用一套渲染，避免四份几乎一样的模板 */
interface HoldRow {
  name: string;
  icon: string;
  tag?: string;
  trail?: string;
  description?: string;
  meta: { label: string; value: string }[];
  effects?: Record<string, string>;
}

/** 装备加成 Record<词条, 数值> → meta 行，正数补 + 号 */
function statsMeta(stats?: Record<string, number>): { label: string; value: string }[] {
  if (!stats) return [];
  return Object.entries(stats).map(([label, v]) => ({
    label,
    value: v > 0 ? `+${v}` : String(v),
  }));
}

const holdRows = computed<HoldRow[]>(() => {
  switch (holdTab.value) {
    case 'equipment':
      return equipmentList.value.map((e) => ({
        name: e.name,
        icon: e.icon,
        tag: e.equippedSlot ?? undefined,
        description: e.description,
        meta: [
          ...(e.rarity ? [{ label: '品质', value: e.rarity }] : []),
          ...statsMeta(e.stats),
          ...(e.maxDurability
            ? [{ label: '耐久', value: `${e.durability ?? e.maxDurability}/${e.maxDurability}` }]
            : []),
        ],
        effects: e.effects,
      }));
    case 'bag':
    case 'consumable': {
      const list = holdTab.value === 'bag' ? bagList.value : consumableList.value;
      const icon = holdTab.value === 'bag' ? 'fa-solid fa-cube' : 'fa-solid fa-flask';
      return list.map((i) => ({
        name: i.name,
        icon,
        tag: holdTab.value === 'bag' ? i.type : undefined,
        trail: `×${i.quantity}`,
        description: i.description,
        meta: [
          ...(i.rarity ? [{ label: '品质', value: i.rarity }] : []),
          ...(i.type ? [{ label: '类型', value: i.type }] : []),
          { label: '数量', value: String(i.quantity) },
          ...statsMeta(i.stats),
        ],
        effects: i.effects,
      }));
    }
    case 'skills':
      return skillList.value.map((s) => ({
        name: s.name,
        icon: s.type === 'active' ? 'fa-solid fa-wand-sparkles' : 'fa-solid fa-shield-heart',
        tag: s.type === 'active' ? '主动' : '被动',
        trail: s.level ? `Lv.${s.level}` : undefined,
        description: s.description,
        meta: [
          ...(s.cost ? [{ label: '消耗', value: `${s.cost.amount} ${s.cost.type}` }] : []),
          ...(s.maxCooldown
            ? [{ label: '冷却', value: `${s.cooldown ?? 0}/${s.maxCooldown}` }]
            : []),
        ],
        effects: s.effects,
      }));
    default:
      return [];
  }
});

/** 每个页签最多预览 6 条，超出走「查看全部」进背包面板 */
const HOLD_PREVIEW = 6;
const holdOverflow = computed(() => Math.max(0, holdRows.value.length - HOLD_PREVIEW));

/** 就地展开详情（原先点条目会弹全屏 Modal —— 触发已摘掉，store.focusItem 保留未删） */
const expandedHold = ref<string | null>(null);
function toggleHold(name: string) {
  const key = `${holdTab.value}:${name}`;
  expandedHold.value = expandedHold.value === key ? null : key;
}
function isHoldOpen(name: string): boolean {
  return expandedHold.value === `${holdTab.value}:${name}`;
}

function buffType(cat: string): 'buff' | 'debuff' | 'special' {
  if (cat === '增益') return 'buff';
  if (cat === '减益') return 'debuff';
  return 'special';
}
</script>

<template>
  <!-- ═══ 已加载 ═══ -->
  <div v-if="player" class="status-overview">
    <!-- ═══════ 玩家概要 —— 身份一行 + 方形画像 ═══════ -->
    <div class="section">
      <!-- 身份一行的**两种落位**（同一份数据，两处 DOM）:
           · 有大画像 → 盖在画框顶端（见 .player-summary 里那一份）；
           · 只有头像 / 没有素材 → 留在这里自己一行。11.25rem 的小方框上盖一条
             通栏的字会把画像整个吞掉，所以小框形态**不**overlay。
           不合并成一份的原因是**放哪里决定了点击能不能生效**: 盖在画上的那份必须
           是画像槽的后代，冒泡到槽才有"点哪都开设置窗"；而这一份必须在槽外面，
           否则一行身份文字会变成"点了会弹文件框"的按钮内容。 -->
      <div v-if="!hasLargePortrait" class="section-header">
        <div class="identity-line" :title="identityTitle">
          <template v-for="(f, i) in identityFields" :key="f.label"
            ><span v-if="i" class="identity-sep" aria-hidden="true"> · </span
            ><span class="identity-field" :class="f.cls">{{ f.value }}</span></template
          >
        </div>
      </div>
      <div class="player-summary">
        <!-- 画像上不画任何东西: 整块可点，去处由 `onPortraitActivate` 按"有没有
             东西可调"决定（有大画像 → 设置弹窗；否则直接开文件框）。 -->
        <div
          class="portrait-slot"
          :class="{ large: hasLargePortrait }"
          role="button"
          tabindex="0"
          :title="portraitActionLabel"
          :aria-label="portraitActionLabel"
          @click="onPortraitActivate"
          @keydown.enter.prevent="onPortraitActivate"
          @keydown.space.prevent="onPortraitActivate"
        >
          <!-- 立绘 / 立绘bg → 顶对齐的大画像；只有头像 → 保持 1:1 小方框。
               两种形态都被同一个可点的槽包着，入口对两者一视同仁。 -->
          <CharacterPortrait
            v-if="hasLargePortrait"
            :name="player.name"
            :src="portraitUrl"
            :video="portraitIsVideo"
            :framing="portraitRow?.framing ?? null"
          />
          <AvatarPanel
            v-else
            :name="player.name"
            size="xl"
            shape="square"
            :src="portraitUrl ?? undefined"
            :video="portraitIsVideo"
          />
          <!-- 身份条 —— **内容**，不是控件: 没有按钮、没有徽章、没有悬停浮层，
               只有一层自上而下化开的护读底把字托住（见 style 里的说明）。 -->
          <div v-if="hasLargePortrait" class="identity-strip">
            <div class="identity-line" :title="identityTitle">
              <template v-for="(f, i) in identityFields" :key="f.label"
                ><span v-if="i" class="identity-sep" aria-hidden="true"> · </span
                ><span class="identity-field" :class="f.cls">{{ f.value }}</span></template
              >
            </div>
          </div>
        </div>
        <input
          ref="portraitInput"
          class="portrait-file"
          type="file"
          :accept="PORTRAIT_ACCEPT"
          @change="onPortraitFile"
        />
        <div class="summary-name">{{ player.name }}</div>
        <AppButton
          class="persona-edit-button"
          variant="ghost"
          size="sm"
          :disabled="Boolean(personaBlockedReason)"
          :title="personaBlockedReason || '编辑影响后续叙事的玩家人设'"
          @click="openPersonaEditor"
        >
          编辑人设
        </AppButton>
      </div>
    </div>

    <div class="status-glass">
      <!-- ═══════ 属性 ═══════ -->
      <div class="section attribute-section">
        <div
          class="section-header clickable"
          role="button"
          tabindex="0"
          :aria-expanded="daoOpen"
          @click="daoOpen = !daoOpen"
          @keydown.enter="daoOpen = !daoOpen"
          @keydown.space.prevent="daoOpen = !daoOpen"
        >
          <span class="section-title">属性</span>
          <!-- 剩余自由点 —— 在 Transition 之外，属性区折叠时依然看得见（有点没花是要
               玩家去花的，藏在折叠里等于没通知）。它是**内容不是控件**：真正的分配
               入口是下面每一维的「+」。 -->
          <span v-if="freeAttrPoints > 0" class="attr-free">自由点 {{ freeAttrPoints }}</span>
          <span class="attr-level">Lv.{{ player.level }}</span>
          <i class="fa-solid" :class="daoOpen ? 'fa-chevron-up' : 'fa-chevron-down'" />
        </div>
        <Transition name="collapse">
          <div v-if="daoOpen" class="section-body">
            <ResourceBar
              label="HP"
              :current="player.hp"
              :max="player.maxHp"
              color="color-mix(in srgb, var(--theme-hp) 65%, #000)"
              :height="20"
              :show-values="true"
            />
            <ResourceBar
              label="MP"
              :current="player.mp"
              :max="player.maxMp"
              color="color-mix(in srgb, var(--theme-mp) 65%, #000)"
              :height="20"
              :show-values="true"
            />
            <ResourceBar
              label="SP"
              :current="player.sp"
              :max="player.maxSp"
              color="color-mix(in srgb, var(--theme-sp) 65%, #000)"
              :height="20"
              :show-values="true"
            />

            <!-- 经验条 —— 逐级累计显示（经验系统改造 v1 2026-08-24）
             current = 累计经验 totalExp，max = 当前等级对应的累计门槛 getRequiredXpForLevel(level)
             （Lv1=120, Lv2=360, …；totalExp 永不清空，攒过门槛即升级）。满级（Lv25）→ 隐藏整条。 -->
            <ResourceBar
              v-if="expMax !== null"
              label="EXP"
              :current="player.totalExp"
              :max="expMax"
              color="color-mix(in srgb, var(--theme-exp) 65%, #000)"
              :height="20"
              :show-values="true"
            />
            <div v-else class="exp-max">EXP 已满级（Lv.25 登神）</div>

            <!-- 五维属性保持单行 -->
            <!-- 有自由点时每格底下长出一个通栏的「+」: 加的是**高度**不是宽度，
                 五列仍旧一行放得下（横向再挤会把「力量」这样的两字标签逼到换行）。
                 到顶那一维的 title 挂在格子上 —— disabled 的按钮不派发鼠标事件，
                 tooltip 挂在它自己身上在部分浏览器里根本不出现。 -->
            <div class="attr-grid">
              <div
                v-for="attr in attrEntries"
                :key="attr.key"
                class="kv-item"
                :title="freeAttrPoints > 0 && attr.atCap ? attr.plusTitle : undefined"
              >
                <span class="kv-label">{{ attr.label }}</span>
                <span class="kv-value">{{ attr.value }}</span>
                <button
                  v-if="freeAttrPoints > 0"
                  class="attr-plus"
                  type="button"
                  :disabled="attr.atCap || allocating"
                  :title="attr.plusTitle"
                  :aria-label="attr.plusTitle"
                  @click="addAttrPoint(attr.key)"
                >
                  +
                </button>
              </div>
            </div>
          </div>
        </Transition>
      </div>

      <!-- ═══════ 状态效果 ═══════ -->
      <!-- 徽章与标题同处一行：flex-wrap 让前几个自然排在标题右侧，放不下的往下折 -->
      <div v-if="player.statusEffects?.length" class="section">
        <div class="section-header buff-header">
          <span class="section-title">状态效果</span>
          <div class="buff-scroll">
            <button
              v-for="fx in player.statusEffects"
              :key="fx.name"
              class="buff-row"
              :aria-describedby="buffPop.key.value === fx.name ? 'buff-pop' : undefined"
              @mouseenter="buffPop.onEnter($event, fx.name)"
              @mouseleave="buffPop.hide"
              @focus="buffPop.onFocus($event, fx.name)"
              @blur="buffPop.hide"
            >
              <BuffChip :name="fx.name" :type="buffType(fx.category)" :stacks="fx.stacks" />
              <span v-if="fx.remainingTime === null" class="buff-time">永久</span>
              <span
                v-else-if="fx.remainingTime !== null && fx.remainingTime < 999"
                class="buff-time"
                >{{ fx.remainingTime }}{{ fx.timeUnit }}</span
              >
            </button>
          </div>
        </div>
      </div>

      <!-- ═══════ 储物袋预览 ═══════ -->
      <div class="section">
        <div
          class="section-header clickable"
          role="button"
          tabindex="0"
          :aria-expanded="inventoryOpen"
          @click="inventoryOpen = !inventoryOpen"
          @keydown.enter="inventoryOpen = !inventoryOpen"
          @keydown.space.prevent="inventoryOpen = !inventoryOpen"
        >
          <span class="section-title">持有物</span>
          <!-- 钱袋 / 命运点常驻标题行 —— 在 Transition 之外，折叠时依然可见 -->
          <span class="hold-meta">
            <span class="hold-money"><i class="fa-solid fa-coins" />{{ player.money }} G</span>
            <span class="hold-fp"><i class="fa-solid fa-star" />{{ game.fp }} FP</span>
          </span>
          <i class="fa-solid" :class="inventoryOpen ? 'fa-chevron-up' : 'fa-chevron-down'" />
        </div>
        <Transition name="collapse">
          <div v-if="inventoryOpen" class="hold-body">
            <AppTabs :tabs="holdTabs" :active="holdTab" @select="holdTab = $event" />

            <div class="item-list">
              <div
                v-for="row in holdRows.slice(0, HOLD_PREVIEW)"
                :key="row.name"
                class="item-entry"
                :class="{ open: isHoldOpen(row.name) }"
              >
                <button
                  class="item-row"
                  :class="{ open: isHoldOpen(row.name) }"
                  :aria-expanded="isHoldOpen(row.name)"
                  @click="toggleHold(row.name)"
                >
                  <i :class="row.icon" class="item-icon" />
                  <span class="item-name">{{ row.name }}</span>
                  <span v-if="row.tag" class="item-tag">{{ row.tag }}</span>
                  <span v-if="row.trail" class="item-count">{{ row.trail }}</span>
                  <i
                    class="fa-solid item-chevron"
                    :class="isHoldOpen(row.name) ? 'fa-chevron-up' : 'fa-chevron-down'"
                  />
                </button>

                <div v-if="isHoldOpen(row.name)" class="item-detail">
                  <div v-if="row.description" class="det-desc">{{ row.description }}</div>
                  <div v-if="row.meta.length" class="det-meta">
                    <span v-for="m in row.meta" :key="m.label" class="det-chip">
                      <span class="det-chip-label">{{ m.label }}</span
                      >{{ m.value }}
                    </span>
                  </div>
                  <div v-if="row.effects && Object.keys(row.effects).length" class="det-effects">
                    <div v-for="(text, name) in row.effects" :key="name" class="det-effect">
                      <span class="det-effect-name">{{ name }}</span
                      >{{ text }}
                    </div>
                  </div>
                  <div
                    v-if="
                      !row.description &&
                      !row.meta.length &&
                      !(row.effects && Object.keys(row.effects).length)
                    "
                    class="det-empty"
                  >
                    暂无更多记载
                  </div>
                </div>
              </div>

              <div v-if="!holdRows.length" class="empty-tab">囊中空空…</div>
            </div>

            <div
              v-if="holdOverflow"
              class="item-footer"
              role="button"
              tabindex="0"
              @click="game.showModal('items')"
              @keydown.enter="game.showModal('items')"
            >
              查看全部 · 另有 {{ holdOverflow }} 项
              <i class="fa-solid fa-chevron-right" />
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </div>

  <!-- ═══ 骨架屏 ═══ -->
  <div v-else-if="game.isGenerating || !game.player" class="status-skeleton">
    <div v-for="i in 4" :key="i" class="sk-block">
      <div class="sk-hdr" />
      <div class="sk-lines">
        <div class="sk-l" />
        <div class="sk-l sk-short" />
      </div>
    </div>
  </div>

  <!-- ═══ 错误态 ═══ -->
  <div v-else class="status-error">
    <i class="fa-solid fa-triangle-exclamation error-icon" />
    <p>角色数据加载失败</p>
    <button class="retry-btn" @click="game.loadSave(game.activeSaveId!)">重试</button>
  </div>

  <!-- ═══ 状态效果悬停气泡（Teleport 出滚动容器，否则会被 overflow 裁掉） ═══ -->
  <Teleport to="body">
    <Transition name="buff-pop">
      <div
        v-if="popBuff && buffPop.style.value"
        id="buff-pop"
        class="buff-pop"
        role="tooltip"
        :style="buffPop.style.value"
      >
        <div class="bd-name">{{ popBuff.name }}</div>
        <div class="bd-desc">{{ popBuff.description }}</div>
        <div class="bd-meta">
          <span>层数: {{ popBuff.stacks }}</span>
          <span
            >剩余:
            {{
              popBuff.remainingTime === null ? '永久' : popBuff.remainingTime + popBuff.timeUnit
            }}</span
          >
          <span>来源: {{ popBuff.source }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- ═══ 画像设置 —— 取景滑块 + 更换图片 ═══
       `&& !cropOpen`: 裁剪台开着时本窗先收起来（而不是叠成两层弹窗）。两个
       AppModal 各自在 document 上听 Escape，同时开着按一下 Esc 会把两层一起关掉
       —— 与 AssetCharacterDrawer 同一个解法，不另发明第二套。收起来不丢状态:
       `portraitDialogOpen` 还是 true，裁剪台一关本窗原样回来，用户接着调新图的取景。
       「更换图片」不在弹窗里自己实现，只把意图发回来走**同一条** `pickPortrait`
       → `onPortraitFile` 路径（图片进裁剪台 / mp4 直通头像），两处各写一遍必漂。 -->
  <PortraitSettingsDialog
    v-if="player"
    :open="portraitDialogOpen && !cropOpen"
    :name="player.name"
    :src="portraitUrl"
    :video="portraitIsVideo"
    :asset-id="portraitRow?.id ?? null"
    :framing="portraitRow?.framing ?? null"
    @close="closePortraitDialog"
    @replace="pickPortrait"
  />

  <!-- ═══ 裁剪台 —— 一张源图 → 立绘 + 头像 ═══
       刻意挂在 `v-if="player"` **之外**: 挂在里面的话，编辑器开着时存档切换 /
       角色数据短暂缺席就会把它连根卸载，用户拉了一半的框凭空消失。
       它自己调 `importPortraitPair` 落库，本组件只负责开台与收台。 -->
  <AssetCropEditor
    :open="cropOpen"
    :source="cropSource"
    :name="cropName"
    @close="closeCrop"
    @saved="onCropSaved"
  />

  <PlayerPersonaEditorModal
    :open="personaOpen"
    :persona="playerPersona"
    :saving="personaSaving"
    :error="personaError"
    @close="closePersonaEditor"
    @save="savePersona"
  />
</template>

<style scoped>
/* ═══ 根容器 ═══ */
.status-overview {
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-y: auto;
  height: 100%;
}

/* ═══ Section 区块 ═══ */
.section {
  border-bottom: 1px solid var(--theme-card-border);
}
.section:last-child {
  border-bottom: none;
}

.status-glass {
  display: flex;
  flex-direction: column;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 6px;
  user-select: none;
}
.section-header.clickable {
  cursor: pointer;
}
.section-header.clickable:hover {
  color: var(--theme-text-primary);
}
.section-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.section-header i {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  transition: transform 0.2s;
}

.section-body {
  padding: 4px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ═══ 玩家概要 ═══ */
/* 身份一行：种族 · 身份 · 职业 · 生命层级 · 冒险者等级
   inline 子元素 + block 容器，才能让 text-overflow 生效（flex 容器上不生效） */
.identity-line {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.identity-sep {
  color: var(--theme-text-muted);
  opacity: 0.6;
}
.identity-field {
  font-weight: 500;
}

/* ── 身份条：盖在大画像顶端 ──────────────────────────────────
 *
 * 📌 **pointer-events 刻意保持默认。** 它是画像槽的**后代**，点在字上事件照样
 *   冒泡到槽的 @click，去处与点画面别处完全一样 —— 所以不需要 `pointer-events:
 *   none` 来"让开"。反过来，设了 none 会把截断时唯一的补救（悬停 title 看全文）
 *   一起关掉。同理这里不写 @click.stop、不放按钮/徽章: 这块是内容，不是控件。
 *
 * 🔴 **护读底必须与主题无关。** 底下是用户自己导入的图，深浅未知；若用主题变量
 *   调色，浅色主题会给出浅色 scrim，在一张白图上彻底失效。所以 scrim 恒为黑、
 *   字恒为浅色 —— 这一对在白图与黑图上都成立。
 *
 * 🔴 **用渐变而不是实色条。** 实色条会盖掉用户刚裁好的构图（取景滑块调的正是
 *   那一块），渐变只在字那一带压暗，往下化到全透明。
 */
.identity-strip {
  position: absolute;
  top: 1px; /* 让开画框那 1px 边框，边线保持干净 */
  left: 1px;
  right: 1px;
  z-index: 1;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md) var(--theme-spacing-xl);
  border-radius: calc(var(--theme-radius-md, 6px) - 1px) calc(var(--theme-radius-md, 6px) - 1px) 0 0;
  /* 字带（顶起 ~40%）内 alpha 0.78→0.58: 白图被压到约 22-42% 亮度，浅色字对比
     仍有 ~7:1；黑图上自然更高。往下 100% 处归零，构图不受影响。 */
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.78) 0%,
    rgba(0, 0, 0, 0.58) 40%,
    rgba(0, 0, 0, 0) 100%
  );
}
/* 与主题无关的浅色墨（见上）。text-shadow 兜住"顶部很花"的图 —— 花图上
   scrim 压暗有余而反差不足，一圈暗描边才能把笔画从纹理里拉出来。 */
.identity-strip .identity-line {
  font-size: 0.75rem;
  color: #f0ebe1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
}
.identity-strip .identity-sep {
  color: #f0ebe1;
  opacity: 0.5;
}
/* 品质紫落在深 scrim 上偏暗 —— 提亮，但仍是同一个语义色而非另换一色 */
.identity-strip .tier-text {
  color: color-mix(in srgb, var(--theme-quality-epic) 60%, #fff);
}

.player-summary {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 12px 12px;
  gap: 8px;
}
/* 画像槽 —— 与原 AvatarPanel 同一个盒子（width:100% + max-width 11.25rem），
   只是多了个定位上下文与可点击的观感，尺寸/形状/间距一律不动 */
.portrait-slot {
  position: relative;
  width: 100%;
  max-width: 11.25rem;
  cursor: pointer;
  border-radius: var(--theme-radius-md, 6px);
  transition: box-shadow var(--theme-transition-fast, 0.15s ease);
}
/* 大画像形态：解开 1:1 小框的宽度上限，让 4:5 立牌吃满整栏 */
.portrait-slot.large {
  max-width: none;
}
.portrait-slot:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
/* 画像上不放任何家具，"可点"只由指针形状与一圈极淡的染边表达 */
.portrait-slot:hover {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-primary) 35%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .portrait-slot {
    transition: none;
  }
}
/* 真正的文件选择框藏起来，点击由画像槽转发 */
.portrait-file {
  display: none;
}

.summary-name {
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}

.persona-edit-button {
  min-height: 36px;
}

/* ═══ KV 行 ═══ */

.kv-item {
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm, 4px);
  padding: 7px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kv-label {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
}
.kv-value {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.tier-text {
  color: var(--theme-quality-epic);
}

/* ═══ 五维属性 —— 紧凑单行 ═══ */
.attr-level {
  margin-left: auto;
  margin-right: 10px;
  color: var(--theme-primary);
  font-size: 0.75rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.attr-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 4px;
  margin-top: 4px;
}
.attr-grid .kv-item {
  align-items: center;
  text-align: center;
  min-width: 0;
  padding: 5px 2px;
}
.attr-grid .kv-label {
  font-size: 0.5625rem;
  line-height: 1.2;
}
.attr-grid .kv-value {
  font-size: 0.75rem;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

/* ═══ 自由属性点 ═══ */
/* 剩余点数徽章 —— design.md §1「激活态/强调徽章通用配方」的染底 + 混合边框 */
.attr-free {
  margin-left: var(--theme-spacing-sm);
  padding: 1px 6px;
  border-radius: var(--theme-radius-sm, 4px);
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-primary);
  font-size: 0.625rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* ═══ EXP 满级 ═══ */
/* 满级时经验条整条隐藏（ResourceBar 的 current/max 没有「满级」表达），
   用一行等高的说明文字占住位置 —— 与资源条同宽同形，避免折叠抖动 */
.exp-max {
  display: flex;
  align-items: center;
  height: 20px;
  padding: 0 4px;
  border-radius: var(--theme-radius-sm, 4px);
  background: color-mix(in srgb, var(--theme-exp) 10%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-exp) 25%, var(--theme-card-border));
  color: var(--theme-exp);
  font-size: 0.625rem;
  font-weight: 600;
}
/* 通栏的「+」: 宽度吃满格子换取指点面积。
   🔴 高度刻意低于 design.md §4.1 那条 36px 触摸目标: 这是侧栏里 5 列的紧凑网格，
   36px 会把这一格撑成整块面板最高的东西，而「五维保持单行」是这块布局的硬约束。
   补偿在宽度上 —— 整格可点，比一个 36px 见方的圆钮还好按。 */
.attr-plus {
  margin-top: 3px;
  width: 100%;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  background: var(--theme-card-bg);
  color: var(--theme-primary);
  font-family: inherit;
  font-size: 0.75rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast, 0.15s ease),
    border-color var(--theme-transition-fast, 0.15s ease);
}
.attr-plus:hover:not(:disabled) {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.attr-plus:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}
/* 🔴 只写 `:disabled`，不挂裸 `.disabled` 类 —— utilities.css 里那条全局
   `.disabled { pointer-events: none }` 会连带把 title 提示一起吞掉 */
.attr-plus:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  color: var(--theme-text-muted);
}
@media (prefers-reduced-motion: reduce) {
  .attr-plus {
    transition: none;
  }
}

/* ═══ 状态效果 ═══ */
/* 标题行改为可换行：标题在左，徽章紧随其后；一行放不下的自动折到下一行 */
.buff-header {
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 8px;
  padding-bottom: 10px;
}
.buff-header .section-title {
  flex-shrink: 0;
}
.buff-scroll {
  max-height: 7.5rem;
  overflow-y: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  flex: 1;
  min-width: 0;
}
/* cursor: help —— 点击不再有行为，指针不该继续骗人说"可点" */
.buff-row {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: help;
  border: none;
  background: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  width: auto;
}
.buff-time {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
}

/* 悬停气泡 —— fixed 定位，走语义 z 阶而非魔法数字 */
.buff-pop {
  position: fixed;
  z-index: var(--z-tooltip, 500);
  zoom: 1.1; /* 与状态栏同步放大 —— 它在面板外，继承不到 */
  width: 240px;
  padding: 9px 11px;
  background: var(--theme-card-bg);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--theme-shadow-lg);
  pointer-events: none; /* 气泡不吃鼠标，避免盖住徽章造成进出闪烁 */
}
.bd-name {
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.bd-desc {
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-secondary);
  margin-top: 3px;
}
.bd-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 7px;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

.buff-pop-enter-active {
  transition: opacity 0.12s ease-out;
}
.buff-pop-leave-active {
  transition: opacity 0.1s ease-in;
}
.buff-pop-enter-from,
.buff-pop-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .buff-pop-enter-active,
  .buff-pop-leave-active {
    transition: none;
  }
}

/* ═══ 持有物 —— 页签体（AppTabs 全宽出血，列表自带内边距） ═══ */
.hold-body {
  display: flex;
  flex-direction: column;
}
/* 钱袋 / 命运点 —— 挂在「持有物」标题行右侧，靠 margin-left:auto 顶到 chevron 前 */
.hold-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
  margin-right: 10px;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.hold-money,
.hold-fp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
}
.hold-money {
  color: var(--theme-currency-gold);
}
.hold-fp {
  color: var(--theme-primary);
}
.hold-meta i {
  font-size: 0.6875rem;
  opacity: 0.85;
}
.hold-body .item-list {
  padding: 8px 12px 4px;
}
.item-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.item-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 3px;
  font-size: 0.75rem;
  border: none;
  background: none;
  font-family: inherit;
  color: inherit;
  width: 100%;
  text-align: left;
  cursor: pointer;
}
.item-row:hover {
  background: var(--theme-surface-muted);
}
.item-icon {
  width: 1rem;
  text-align: center;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  flex-shrink: 0;
}
.item-name {
  flex: 1;
  color: var(--theme-text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-tag {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  background: var(--theme-surface-muted);
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.item-count {
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  flex-shrink: 0;
}
.item-footer {
  text-align: center;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  padding: 6px 0 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.item-footer:hover {
  color: var(--theme-text-secondary);
}
.item-footer i {
  font-size: 0.5625rem;
}

/* ═══ 条目就地展开详情 ═══ */
.item-chevron {
  flex-shrink: 0;
  font-size: 0.5rem;
  color: var(--theme-text-muted);
  opacity: 0.55;
}
.item-row.open {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
}
.item-row.open .item-chevron {
  opacity: 0.9;
}
.item-detail {
  /* 与上方条目等宽 —— 原先左缩进 22px 让它比条目窄一截、右侧还空着 */
  margin: 2px 0 6px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--theme-primary) 5%, var(--theme-surface-muted));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
  border-radius: var(--theme-radius-md, 6px);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.det-desc {
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-secondary);
}
.det-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}
.det-chip {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  padding: 1px 6px;
  font-variant-numeric: tabular-nums;
}
.det-chip-label {
  color: var(--theme-text-muted);
  font-weight: 400;
  margin-right: 4px;
}
.det-effects {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-top: 1px dashed var(--theme-card-border);
  padding-top: 6px;
}
.det-effect {
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--theme-text-secondary);
}
.det-effect-name {
  color: var(--theme-primary);
  font-weight: 600;
  margin-right: 5px;
}
.det-empty {
  font-size: 0.6875rem;
  font-style: italic;
  color: var(--theme-text-muted);
}

/* ═══ 空态 —— design.md §5.2 统一配方 ═══ */
.empty-tab {
  padding: 20px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: 6px;
  font-size: 1.25rem;
  opacity: 0.3;
}

/* ═══ 骨架屏 ═══ */
.status-skeleton {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 10px;
}
.sk-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sk-hdr {
  height: 10px;
  width: 40%;
  border-radius: 3px;
  background: var(--theme-surface-muted);
  animation: sk-pulse 1.5s infinite;
}
.sk-lines {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 4px;
}
.sk-l {
  height: 14px;
  width: 90%;
  border-radius: 3px;
  background: var(--theme-surface-muted);
  animation: sk-pulse 1.5s infinite;
}
.sk-short {
  width: 50%;
}
@keyframes sk-pulse {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 0.7;
  }
}

/* ═══ 错误态 ═══ */
.status-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--theme-text-muted);
  padding: 16px;
  text-align: center;
}
.error-icon {
  font-size: 1.75rem;
  color: var(--theme-error);
}
.retry-btn {
  padding: 6px 16px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
  cursor: pointer;
  font-family: inherit;
}
.retry-btn:hover {
  background: var(--theme-tab-hover-bg);
}

/* ═══ 折叠动画 — 只动 opacity/transform，不动布局属性 ═══ */
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
</style>
