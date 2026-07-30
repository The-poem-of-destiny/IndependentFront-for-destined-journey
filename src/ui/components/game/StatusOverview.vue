<script setup lang="ts">
import { ref, computed } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { useAssetStore } from '../../stores/asset-store'
import { useUIStore } from '../../stores/ui-store'
import { useHoverPopup } from '../../composables/useHoverPopup'
import { useAssetImage } from '../../composables/useAssetImage'
import { ASSET_MIME_BY_EXTENSION, mimeForAssetExtension } from '@engine/asset-types'
import { ASSET_TYPE_FALLBACK_CHAIN } from '@engine/asset-resolve'
import type { AssetMutationOutcome } from '../../stores/asset-store'
import { normalizeItemType } from '@engine/field-enums'
import ResourceBar from '../shared/ResourceBar.vue'
import AvatarPanel from '../shared/AvatarPanel.vue'
import CharacterPortrait from '../shared/CharacterPortrait.vue'
import AppTabs from '../shared/AppTabs.vue'
import BuffChip from '../shared/BuffChip.vue'
// 裁剪台是 shared/ 的东西（它只认「一份源字节 + 一个名字」，跟设置页零耦合；
// 正因为这里也在用它，它才不该住在 settings/assets/ 下）。这里**原样消费**
// 它的 props/events，不复制一份 —— 复制一份就等于把 D16 不变式、撞位分配、
// 部分成功口径再实现一遍。
import AssetCropEditor from '../shared/AssetCropEditor.vue'

const game = useGameStore()

const player = computed(() => game.player)

// ═══ 玩家画像 —— 素材库渲染 + 定点导入 ═══════════════════
//
// 名字**严格 `===`**（D2）: `useAssetImage` 不做任何归一化，名字对不上就静默走
// 首字母兜底 —— 那是 prompt / 世界书要在源头修的缺陷，素材层不宽容匹配。
//
// **读**走立牌链 `立绘 → 立绘bg → 头像`: 右栏这块地方是竖着的，有立绘就该铺开用。
//
// **写**分两条，判据是**这份字节能不能过画布**:
//   · 图片 → 开裁剪台，一张源图烘出 `立绘` + `头像` 两行。这才是这个入口的意义:
//     用户手里只有一张图，让他导两次、各裁一次，等于把"这两张图同源"的记账推给他。
//   · mp4 → **不开**裁剪台。画布只取得到某一帧，"裁一段视频"没有意义；而且 D7
//     本来就不让视频落在 `立绘` 上（那是要抠图合成的）。于是走原来的直通路径，
//     且**只**写 `头像` —— 存进去的必须是确定的一格，只有读取才降级。
const {
  url: portraitUrl,
  isVideo: portraitIsVideo,
  row: portraitRow,
} = useAssetImage(() => player.value?.name, ASSET_TYPE_FALLBACK_CHAIN)

/**
 * 铺成大画像，还是留在 1:1 小方框里？
 *
 * 判据是**链上命中的那一档**，不是「有没有图」: `立绘` / `立绘bg` 本来就是竖幅
 * 或整幅构图，铺满整栏是它们该有的样子；而 `头像` 是一张脸的特写，拉满整栏宽
 * 只会糊成一团，看起来像 bug 而不像功能 —— 所以只有头像的角色必须留小框。
 */
const hasLargePortrait = computed(
  () =>
    portraitUrl.value !== null &&
    (portraitRow.value?.type === '立绘' || portraitRow.value?.type === '立绘bg'),
)

const assets = useAssetStore()
const ui = useUIStore()

/** 认可的素材 MIME —— 路由表是唯一来源（含 `video/mp4`），不在这里手抄一份 */
const ASSET_MIMES = new Set(Object.values(ASSET_MIME_BY_EXTENSION))
/** 文件选择框的 accept */
const PORTRAIT_ACCEPT = Array.from(ASSET_MIMES).join(',')

/**
 * 这份字节按素材路由表算是什么 MIME —— 与 asset-store 的 `resolveSourceMime`
 * **同一条优先级**: 先信 `blob.type`（从磁盘选出来的 `File` 在某些系统上是空串，
 * 但有值时它比扩展名可靠），问不出来再退到文件名扩展名。
 *
 * 两边都问不出 → `undefined`，**不猜**: 猜错了会让一份 svg / 乱改扩展名的文件
 * 一路走到裁剪台，然后在保存那一刻才含糊地失败。
 */
function assetMimeOf(file: File): string | undefined {
  const declared = (file.type ?? '').trim().toLowerCase()
  if (ASSET_MIMES.has(declared)) return declared
  const dot = file.name.lastIndexOf('.')
  return mimeForAssetExtension(dot > 0 ? file.name.slice(dot + 1) : '')
}

const portraitInput = ref<HTMLInputElement | null>(null)

function pickPortrait(): void {
  portraitInput.value?.click()
}

// ── 裁剪台的开关 ──────────────────────────────────────────
// 名字在**开台那一刻**就定死（`cropName`），不是每帧去读 `player.name`: 编辑器
// 开着的时候存档可以切、角色可以改名，而用户裁的是他刚才点开的那个人。
// 🔴 编辑器**永不**改名字，它只决定像素（见 AssetCropEditor 顶部注释）。

const cropOpen = ref(false)
const cropSource = ref<File | null>(null)
const cropName = ref('')

/**
 * 取消 = **什么都不留下**: 没有半张素材（落库全在编辑器的确认里）、没有卡住的
 * 忙碌位（本组件不持有忙碌位，互斥闸在 store 里且随那次调用结束而释放）、
 * 源字节也放掉（编辑器自己会撤销它铸的 object URL）。
 *
 * 文件选择框的 `value` 不在这里清 —— 它在 `onPortraitFile` 一进门就清了，
 * 那才是唯一正确的时机: 取消**编辑器**与取消**文件对话框**是两件事，只有前者
 * 会走到这里，而"连选同一个文件两次"这个坑两条路都要躲过。
 */
function closeCrop(): void {
  cropOpen.value = false
  cropSource.value = null
}

/** 两半都落地了才会来（部分成功由编辑器就地说明，不冒充成功） */
function onCropSaved(ids: { portraitId?: string; avatarId?: string }): void {
  const name = cropName.value
  closeCrop()
  const saved = [
    ...(ids.portraitId !== undefined ? ['立绘'] : []),
    ...(ids.avatarId !== undefined ? ['头像'] : []),
  ]
  if (saved.length === 0) return
  ui.toast(`已把这张图设为「${name}」的${saved.join('与')}。`, 'info')
}

/**
 * 每种结局一句**属于它自己**的话。
 *
 * 两种「名字不合法」（D16 命名不变式 / D19 zip 条目名可承载性）**必须说清是名字的问题**:
 * 这条路径上文件名只贡献扩展名，name 由角色给定，所以用户改文件名一万次也没用 ——
 * 报成「导入失败」会让人对着一张好图反复重试。
 *
 * 🔴 **`'busy'` 刻意不在这张表里**: 互斥闸 `rejectIfBusy()` 自己已经播报过
 * 「已有一个导入正在进行，请等它结束。」，这里再说一句就是同一件事弹两条 toast。
 * 那句共用文案对本路径完全成立（要等的确实是同一个闸），所以删的是**本地这句**
 * 而不是共用那句。调用方在拿到 `'busy'` 时直接返回，绝不会走到这个 switch。
 */
function portraitMessage(outcome: AssetMutationOutcome, name: string): { text: string; type: 'info' | 'error' } {
  switch (outcome) {
    case 'ok':
      return { text: `已把这张图设为「${name}」的画像。`, type: 'info' }
    case 'naming-invariant':
      return {
        text: `没法用「${name}」这个角色名当素材文件名：名字里含有「头像 / 立绘 / 立绘bg」这类类型词（或名字为空），素材会被读成另一个角色。请先改角色名。`,
        type: 'error',
      }
    case 'unrepresentable-name':
      return {
        text: `没法用「${name}」这个角色名当素材文件名：名字里带「/」「\\」或以「.」开头，导出成素材包后会变成路径或被当成隐藏文件。请先改角色名。`,
        type: 'error',
      }
    case 'media-rule':
      return { text: '这个类型不接受 mp4，请换一张图片。', type: 'error' }
    default:
      // not-found / failed —— 字节没写进去（格式不认、读不出、存储写入失败）
      return { text: '这张图没能存进素材库：可能是格式不支持，或浏览器存储写入失败。', type: 'error' }
  }
}

async function onPortraitFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // 🔴 先清空，否则连续选**同一个文件**不会再触发 change（浏览器认为值没变）。
  // 必须在**所有** early return 之前 —— 走到裁剪台那条分支同样要清，否则
  // "开了裁剪台 → 取消 → 想重选刚才那张图" 会一声不响地什么都不发生。
  input.value = ''
  if (!file) return
  const name = player.value?.name
  if (!name) return

  const mime = assetMimeOf(file)
  if (mime === undefined) {
    // 连 MIME 都问不出来: 不开裁剪台，也不把一个必然失败的请求发给 store
    const { text, type } = portraitMessage('failed', name)
    ui.toast(text, type)
    return
  }

  if (!mime.startsWith('video/')) {
    // 图片 → 交给裁剪台，由它调 `importPortraitPair` 一次烘出 立绘 + 头像
    cropSource.value = file
    cropName.value = name
    cropOpen.value = true
    return
  }

  // mp4 → 裁不了（画布只有某一帧），直通导入，且只写 头像。
  // 文件名在这条路径上**只**贡献扩展名 —— name 与 type 由这个槽位说了算，
  // 于是 `IMG_1234.mp4` 不会在库里长出一个叫 IMG_1234 的幽灵角色组
  const { outcome } = await assets.importForCharacter(file, name, '头像')
  // 互斥闸已经自己播报过了 —— 这里再补一句就是两条 toast 说同一件事
  if (outcome === 'busy') return
  const { text, type } = portraitMessage(outcome, name)
  ui.toast(text, type)
}

// ═══ 折叠状态 ═══
const daoOpen = ref(true)
const inventoryOpen = ref(true)

// ═══ 状态效果：悬停弹出详情（延迟走全局设置 settings.hoverDelayMs） ═══
// 气泡 Teleport 到 body，拿不到状态栏的 zoom:1.1，自己缩放；
// 传给夹紧计算的是**渲染后**尺寸：240×1.1=264 / 132×1.1=145
const buffPop = useHoverPopup({ width: 264, estHeight: 145, zoom: 1.1, placement: 'below' })
const popBuff = computed(() =>
  player.value?.statusEffects?.find(f => f.name === buffPop.key.value) ?? null
)

// ═══ 身份元信息 —— 顶部一行（取代原「玩家概要」标题 + 整个「个人信息」区块） ═══
const identityFields = computed(() => {
  const p = player.value
  if (!p) return []
  return [
    { label: '种族', value: p.race || '—', cls: '' },
    { label: '身份', value: p.identity?.[0] || '—', cls: '' },
    { label: '职业', value: p.occupation?.[0] || '—', cls: '' },
    { label: '生命层级', value: p.tierName || '—', cls: 'tier-text' },
    { label: '冒险者等级', value: p.adventurerRank ? `${p.adventurerRank}级` : '—', cls: '' },
  ]
})
/** 一行放不下时会被省略号截断，完整带标签的版本挂在 title 上，信息不丢 */
const identityTitle = computed(() =>
  identityFields.value.map(f => `${f.label}：${f.value}`).join('　')
)

// ═══ 属性映射 ═══
const ATTR_LABELS: Record<string, string> = {
  str: '力量', dex: '敏捷', con: '体质', int: '智力', spi: '精神',
}
const attrEntries = computed(() =>
  Object.entries(player.value?.attributes ?? {}).map(([key, value]) => ({
    key,
    label: ATTR_LABELS[key] || key,
    value,
  }))
)

// ═══ 装备列表 ═══
// M6 完整重构: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3），槽位为中文枚举
const EQUIP_ICONS: Record<string, string> = {
  '武器': 'fa-solid fa-sword', '副手': 'fa-solid fa-shield-halved', '头部': 'fa-solid fa-helmet-safety',
  '身体': 'fa-solid fa-shirt', '手部': 'fa-solid fa-mitten', '脚部': 'fa-solid fa-shoe-prints',
  '腰带': 'fa-solid fa-ring', '饰品': 'fa-regular fa-gem',
}
const equipmentList = computed(() =>
  (player.value?.inventory ?? []).filter(i => i.equippedSlot).map(e => ({
    ...e,
    icon: EQUIP_ICONS[e.equippedSlot!] || 'fa-solid fa-circle',
  }))
)

// ═══ 持有物页签：装备 / 背包 / 消耗品 / 技能 ═══
type HoldTab = 'equipment' | 'bag' | 'consumable' | 'skills'
const holdTab = ref<HoldTab>('equipment')
const holdTabs: { key: HoldTab; label: string }[] = [
  { key: 'equipment', label: '装备' },
  { key: 'bag', label: '背包' },
  { key: 'consumable', label: '消耗品' },
  { key: 'skills', label: '技能' },
]

/** 未穿戴的物品（穿戴中的归「装备」页签，规范 §3：装备是物品的状态而非独立实体） */
const unequipped = computed(() =>
  (player.value?.inventory ?? []).filter(i => !i.equippedSlot)
)
const consumableList = computed(() =>
  unequipped.value.filter(i => normalizeItemType(i.type ?? '') === '消耗品')
)
/** 背包 = 未穿戴且非消耗品（材料/任务物品/特殊/未穿戴的装备都在这） */
const bagList = computed(() =>
  unequipped.value.filter(i => normalizeItemType(i.type ?? '') !== '消耗品')
)
const skillList = computed(() => player.value?.skills ?? [])

/** 统一行模型 —— 四个页签共用一套渲染，避免四份几乎一样的模板 */
interface HoldRow {
  name: string
  icon: string
  tag?: string
  trail?: string
  description?: string
  meta: { label: string; value: string }[]
  effects?: Record<string, string>
}

/** 装备加成 Record<词条, 数值> → meta 行，正数补 + 号 */
function statsMeta(stats?: Record<string, number>): { label: string; value: string }[] {
  if (!stats) return []
  return Object.entries(stats).map(([label, v]) => ({
    label,
    value: v > 0 ? `+${v}` : String(v),
  }))
}

const holdRows = computed<HoldRow[]>(() => {
  switch (holdTab.value) {
    case 'equipment':
      return equipmentList.value.map(e => ({
        name: e.name,
        icon: e.icon,
        tag: e.equippedSlot ?? undefined,
        description: e.description,
        meta: [
          ...(e.rarity ? [{ label: '品质', value: e.rarity }] : []),
          ...statsMeta(e.stats),
          ...(e.maxDurability ? [{ label: '耐久', value: `${e.durability ?? e.maxDurability}/${e.maxDurability}` }] : []),
        ],
        effects: e.effects,
      }))
    case 'bag':
    case 'consumable': {
      const list = holdTab.value === 'bag' ? bagList.value : consumableList.value
      const icon = holdTab.value === 'bag' ? 'fa-solid fa-cube' : 'fa-solid fa-flask'
      return list.map(i => ({
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
      }))
    }
    case 'skills':
      return skillList.value.map(s => ({
        name: s.name,
        icon: s.type === 'active' ? 'fa-solid fa-wand-sparkles' : 'fa-solid fa-shield-heart',
        tag: s.type === 'active' ? '主动' : '被动',
        trail: s.level ? `Lv.${s.level}` : undefined,
        description: s.description,
        meta: [
          ...(s.cost ? [{ label: '消耗', value: `${s.cost.amount} ${s.cost.type}` }] : []),
          ...(s.maxCooldown ? [{ label: '冷却', value: `${s.cooldown ?? 0}/${s.maxCooldown}` }] : []),
        ],
        effects: s.effects,
      }))
  }
})

/** 每个页签最多预览 6 条，超出走「查看全部」进背包面板 */
const HOLD_PREVIEW = 6
const holdOverflow = computed(() => Math.max(0, holdRows.value.length - HOLD_PREVIEW))

/** 就地展开详情（原先点条目会弹全屏 Modal —— 触发已摘掉，store.focusItem 保留未删） */
const expandedHold = ref<string | null>(null)
function toggleHold(name: string) {
  const key = `${holdTab.value}:${name}`
  expandedHold.value = expandedHold.value === key ? null : key
}
function isHoldOpen(name: string): boolean {
  return expandedHold.value === `${holdTab.value}:${name}`
}

function buffType(cat: string): 'buff' | 'debuff' | 'special' {
  if (cat === '增益') return 'buff'
  if (cat === '减益') return 'debuff'
  return 'special'
}
</script>

<template>
  <!-- ═══ 已加载 ═══ -->
  <div class="status-overview" v-if="player">

    <!-- ═══════ 玩家概要 —— 身份一行 + 方形画像 ═══════ -->
    <div class="section">
      <div class="section-header">
        <div class="identity-line" :title="identityTitle">
          <template v-for="(f, i) in identityFields" :key="f.label"
            ><span v-if="i" class="identity-sep" aria-hidden="true"> · </span
            ><span class="identity-field" :class="f.cls">{{ f.value }}</span
          ></template>
        </div>
      </div>
      <div class="player-summary">
        <!-- 点画像 = 挑一张图，裁出这个角色的立绘与头像（唯一带导入入口的渲染位）。
             说明文案照实说**结果是两张素材**，而不是含糊的"导入" —— 用户点之前
             就该知道这一下会同时定下立牌位和头像位。 -->
        <div
          class="portrait-slot"
          :class="{ large: hasLargePortrait }"
          role="button"
          tabindex="0"
          :title="`点击挑一张图，裁出「${player.name}」的立绘与头像`"
          :aria-label="`设置「${player.name}」的立绘与头像`"
          @click="pickPortrait"
          @keydown.enter="pickPortrait"
          @keydown.space.prevent="pickPortrait"
        >
          <!-- 立绘 / 立绘bg → 顶对齐的大画像（带取景旋钮）；只有头像 → 保持 1:1 小方框。
               两种形态都被同一个可点的槽包着，导入入口对两者一视同仁。 -->
          <CharacterPortrait
            v-if="hasLargePortrait"
            :name="player.name"
            :src="portraitUrl"
            :video="portraitIsVideo"
            :asset-id="portraitRow?.id ?? null"
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
          <span class="portrait-hint" aria-hidden="true"><i class="fa-solid fa-camera" /></span>
        </div>
        <input
          ref="portraitInput"
          class="portrait-file"
          type="file"
          :accept="PORTRAIT_ACCEPT"
          @change="onPortraitFile"
        />
        <div class="summary-name">{{ player.name }}</div>
      </div>
    </div>

    <div class="status-glass">
    <!-- ═══════ 属性 ═══════ -->
    <div class="section attribute-section">
      <div class="section-header clickable" @click="daoOpen = !daoOpen" role="button" tabindex="0" :aria-expanded="daoOpen" @keydown.enter="daoOpen = !daoOpen" @keydown.space.prevent="daoOpen = !daoOpen">
        <span class="section-title">属性</span>
        <span class="attr-level">Lv.{{ player.level }}</span>
        <i class="fa-solid" :class="daoOpen ? 'fa-chevron-up' : 'fa-chevron-down'" />
      </div>
      <Transition name="collapse">
        <div class="section-body" v-if="daoOpen">
        <ResourceBar label="HP" :current="player.hp" :max="player.maxHp" color="color-mix(in srgb, var(--theme-hp) 65%, #000)" :height="20" :showValues="true" />
        <ResourceBar label="MP" :current="player.mp" :max="player.maxMp" color="color-mix(in srgb, var(--theme-mp) 65%, #000)" :height="20" :showValues="true" />
        <ResourceBar label="SP" :current="player.sp" :max="player.maxSp" color="color-mix(in srgb, var(--theme-sp) 65%, #000)" :height="20" :showValues="true" />

        <!-- 经验条 —— 与 HP/MP/SP 同宽同形
             totalExp = 本层级已积累，expToNext = 距上限还差多少，两者之和 = 该层级 EXP 上限
             （实测 8500 + 1500 = 10000，正是核心数值表 T4 的 expCap；创角时 0 + expCap 亦自洽） -->
        <ResourceBar label="EXP" :current="player.totalExp" :max="player.totalExp + player.expToNext" color="color-mix(in srgb, var(--theme-exp) 65%, #000)" :height="20" :showValues="true" />

        <!-- 五维属性保持单行 -->
        <div class="attr-grid">
          <div v-for="attr in attrEntries" :key="attr.key" class="kv-item">
            <span class="kv-label">{{ attr.label }}</span>
            <span class="kv-value">{{ attr.value }}</span>
          </div>
        </div>

      </div>
      </Transition>
    </div>

    <!-- ═══════ 状态效果 ═══════ -->
    <!-- 徽章与标题同处一行：flex-wrap 让前几个自然排在标题右侧，放不下的往下折 -->
    <div class="section" v-if="player.statusEffects?.length">
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
          <span class="buff-time" v-if="fx.remainingTime === null">永久</span>
          <span class="buff-time" v-else-if="fx.remainingTime !== null && fx.remainingTime < 999">{{ fx.remainingTime }}{{ fx.timeUnit }}</span>
        </button>
        </div>
      </div>
    </div>

    <!-- ═══════ 储物袋预览 ═══════ -->
    <div class="section">
      <div class="section-header clickable" @click="inventoryOpen = !inventoryOpen" role="button" tabindex="0" :aria-expanded="inventoryOpen" @keydown.enter="inventoryOpen = !inventoryOpen" @keydown.space.prevent="inventoryOpen = !inventoryOpen">
        <span class="section-title">持有物</span>
        <!-- 钱袋 / 命运点常驻标题行 —— 在 Transition 之外，折叠时依然可见 -->
        <span class="hold-meta">
          <span class="hold-money"><i class="fa-solid fa-coins" />{{ player.money }} G</span>
          <span class="hold-fp"><i class="fa-solid fa-star" />{{ game.fp }} FP</span>
        </span>
        <i class="fa-solid" :class="inventoryOpen ? 'fa-chevron-up' : 'fa-chevron-down'" />
      </div>
      <Transition name="collapse">
        <div class="hold-body" v-if="inventoryOpen">
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
                <span class="item-tag" v-if="row.tag">{{ row.tag }}</span>
                <span class="item-count" v-if="row.trail">{{ row.trail }}</span>
                <i class="fa-solid item-chevron" :class="isHoldOpen(row.name) ? 'fa-chevron-up' : 'fa-chevron-down'" />
              </button>

              <div class="item-detail" v-if="isHoldOpen(row.name)">
                <div class="det-desc" v-if="row.description">{{ row.description }}</div>
                <div class="det-meta" v-if="row.meta.length">
                  <span v-for="m in row.meta" :key="m.label" class="det-chip">
                    <span class="det-chip-label">{{ m.label }}</span>{{ m.value }}
                  </span>
                </div>
                <div class="det-effects" v-if="row.effects && Object.keys(row.effects).length">
                  <div v-for="(text, name) in row.effects" :key="name" class="det-effect">
                    <span class="det-effect-name">{{ name }}</span>{{ text }}
                  </div>
                </div>
                <div class="det-empty" v-if="!row.description && !row.meta.length && !(row.effects && Object.keys(row.effects).length)">
                  暂无更多记载
                </div>
              </div>
            </div>

            <div class="empty-tab" v-if="!holdRows.length">囊中空空…</div>
          </div>

          <div class="item-footer" v-if="holdOverflow" role="button" tabindex="0" @click="game.showModal('items')" @keydown.enter="game.showModal('items')">
            查看全部 · 另有 {{ holdOverflow }} 项
            <i class="fa-solid fa-chevron-right" />
          </div>
        </div>
      </Transition>
    </div>
    </div>

  </div>

  <!-- ═══ 骨架屏 ═══ -->
  <div class="status-skeleton" v-else-if="game.isGenerating || !game.player">
    <div class="sk-block" v-for="i in 4" :key="i">
      <div class="sk-hdr" />
      <div class="sk-lines"><div class="sk-l" /><div class="sk-l sk-short" /></div>
    </div>
  </div>

  <!-- ═══ 错误态 ═══ -->
  <div class="status-error" v-else>
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
          <span>剩余: {{ popBuff.remainingTime === null ? '永久' : popBuff.remainingTime + popBuff.timeUnit }}</span>
          <span>来源: {{ popBuff.source }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>

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
.section:last-child { border-bottom: none; }

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
}
/* 大画像形态：解开 1:1 小框的宽度上限，让 4:5 立牌吃满整栏 */
.portrait-slot.large {
  max-width: none;
}
/* 右下角归取景旋钮了，导入提示让到左下 —— 两个 24px 的小按钮不该叠在一起 */
.portrait-slot.large .portrait-hint {
  right: auto;
  left: 6px;
}
.portrait-slot:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.portrait-hint {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--theme-radius-sm, 4px);
  background: color-mix(in srgb, var(--theme-primary) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-primary-text);
  font-size: 0.6875rem;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}
.portrait-slot:hover .portrait-hint,
.portrait-slot:focus-visible .portrait-hint {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .portrait-hint { transition: none; }
}
/* 真正的文件选择框藏起来，点击由画像槽转发 */
.portrait-file { display: none; }

.summary-name {
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--theme-text-primary);
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
.tier-text { color: var(--theme-quality-epic); }

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

/* ═══ 状态效果 ═══ */
/* 标题行改为可换行：标题在左，徽章紧随其后；一行放不下的自动折到下一行 */
.buff-header {
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 8px;
  padding-bottom: 10px;
}
.buff-header .section-title { flex-shrink: 0; }
.buff-scroll { max-height: 7.5rem; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 4px 8px; flex: 1; min-width: 0; }
/* cursor: help —— 点击不再有行为，指针不该继续骗人说"可点" */
.buff-row { display: flex; align-items: center; gap: 4px; cursor: help; border: none; background: none; padding: 0; font-family: inherit; font-size: inherit; color: inherit; width: auto; }
.buff-time { font-size: 0.625rem; color: var(--theme-text-muted); }

/* 悬停气泡 —— fixed 定位，走语义 z 阶而非魔法数字 */
.buff-pop {
  position: fixed;
  z-index: var(--z-tooltip, 500);
  zoom: 1.1;              /* 与状态栏同步放大 —— 它在面板外，继承不到 */
  width: 240px;
  padding: 9px 11px;
  background: var(--theme-card-bg);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--theme-shadow-lg);
  pointer-events: none;   /* 气泡不吃鼠标，避免盖住徽章造成进出闪烁 */
}
.bd-name { font-size: 0.8125rem; font-weight: 700; color: var(--theme-text-primary); }
.bd-desc { font-size: 0.75rem; line-height: 1.55; color: var(--theme-text-secondary); margin-top: 3px; }
.bd-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 7px; font-size: 0.6875rem; color: var(--theme-text-muted); }

.buff-pop-enter-active { transition: opacity 0.12s ease-out; }
.buff-pop-leave-active { transition: opacity 0.1s ease-in; }
.buff-pop-enter-from, .buff-pop-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .buff-pop-enter-active, .buff-pop-leave-active { transition: none; }
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
.hold-money, .hold-fp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
}
.hold-money { color: var(--theme-currency-gold); }
.hold-fp { color: var(--theme-primary); }
.hold-meta i { font-size: 0.6875rem; opacity: 0.85; }
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
.item-footer:hover { color: var(--theme-text-secondary); }
.item-footer i { font-size: 0.5625rem; }

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
.item-row.open .item-chevron { opacity: 0.9; }
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
.sk-block { display: flex; flex-direction: column; gap: 6px; }
.sk-hdr {
  height: 10px; width: 40%;
  border-radius: 3px;
  background: var(--theme-surface-muted);
  animation: sk-pulse 1.5s infinite;
}
.sk-lines { display: flex; flex-direction: column; gap: 4px; padding-left: 4px; }
.sk-l {
  height: 14px; width: 90%;
  border-radius: 3px;
  background: var(--theme-surface-muted);
  animation: sk-pulse 1.5s infinite;
}
.sk-short { width: 50%; }
@keyframes sk-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.7; }
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
.error-icon { font-size: 1.75rem; color: var(--theme-error); }
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
.retry-btn:hover { background: var(--theme-tab-hover-bg); }

/* ═══ 折叠动画 — 只动 opacity/transform，不动布局属性 ═══ */
.collapse-enter-active {
  transition: opacity 0.2s ease-out, transform 0.2s ease-out;
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
