<script setup lang="ts">
/**
 * ②-A 角色抽屉 —— 一个分组（同名素材）的全部变体
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §7.4 / §8
 *
 * 三条要点，都是设计里明写的取舍，别顺手"优化"掉:
 *   ① **删掉主图不会自动提拔变体** —— 该类型留成「无主图」，由「设为主图」显式修。
 *      自动提拔等于悄悄改写一个用户没碰过的文件名，还在猜他的意图。
 *   ② **改名是全字段的**（name / type / variant 都能改，D14），但命名不变式（D16）
 *      会拒收带类型词的名字/变体 —— 拒收要**就地**提示在字段旁，不弹 toast:
 *      那是这个输入框的问题，说明必须留在输入框边上。
 *   ③ **设为主图在 v1 什么都不渲染**，但仍然保留 —— 它是唯一能左右 v2 显示什么的
 *      控制项，现在不给，今天导入的素材包就没法预先排好。
 *
 * 边界: 只调 asset-store 的公开动作；分组本身按 `name` 从 store 现算，
 * 于是任何一次落库刷新后抽屉自动跟上（不缓存一份会过期的行）。
 */
import { computed, inject, reactive, ref, useId, watch } from 'vue'
import { ASSET_TYPES, type AssetMetaRecord, type AssetType } from '@engine/types'
import { isVideoExtension } from '@engine/asset-types'
import { useAssetStore, type AssetMutationOutcome } from '../../../stores/asset-store'
import { useUIStore } from '../../../stores/ui-store'
import AppButton from '../../shared/AppButton.vue'
import AppModal from '../../shared/AppModal.vue'
import AssetCropEditor from '../../shared/AssetCropEditor.vue'
import { assetDialogsKey } from './dialogs'
import { useAssetThumbs } from './thumbs'
import { fmtBytes } from '../audio/format'

const props = defineProps<{
  /** 分组名（即 `AssetMetaRecord.name`）；null 表示抽屉关着 */
  name: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'announce', message: string): void
}>()

const assets = useAssetStore()
const ui = useUIStore()
const dialogs = inject(assetDialogsKey)!

const group = computed(() => (props.name ? assets.groups.find((g) => g.name === props.name) : undefined))

/**
 * 变体排序: 主图在前，随后**自然序**。
 *
 * store 的 `compareRows` 用的是纯 `localeCompare`，于是自动编号一多就排成
 * `_10 < _2`。抽屉是唯一逐条列变体的地方，这里补上 `numeric: true`；
 * 不去改 store 的口径，因为那份顺序还服务着别的调用方。
 */
function byVariantNatural(a: AssetMetaRecord, b: AssetMetaRecord): number {
  const va = a.variant ?? ''
  const vb = b.variant ?? ''
  if (va === '' && vb !== '') return -1
  if (vb === '' && va !== '') return 1
  if (va !== vb) return va.localeCompare(vb, 'zh-Hans-CN', { numeric: true })
  return a.createdAt - b.createdAt
}

interface DrawerSection {
  type: AssetType
  rows: AssetMetaRecord[]
  /** 该类型有行、但没有主图 —— §8 的「无主图」，删过主图后的常态 */
  baseless: boolean
}

const sections = computed<DrawerSection[]>(() => {
  const g = group.value
  if (!g) return []
  const out: DrawerSection[] = []
  for (const type of ASSET_TYPES) {
    const rows = g.rows.filter((r) => r.type === type).sort(byVariantNatural)
    if (rows.length === 0) continue
    out.push({ type, rows, baseless: g.baselessTypes.includes(type) })
  }
  return out
})

const visibleRows = computed<AssetMetaRecord[]>(() => sections.value.flatMap((s) => s.rows))

const { thumbFor } = useAssetThumbs(() => visibleRows.value)

/**
 * 组整个消失就关抽屉 —— 最后一条被删掉、或改名把它搬去了别的组。
 * 留一个空抽屉挂在屏幕上，读起来像是加载失败。
 */
watch(group, (g) => {
  if (props.name && !g) {
    editingId.value = ''
    emit('close')
  }
})

function labelFor(row: AssetMetaRecord): string {
  return row.variant ? row.variant : '主图'
}

// ═══ 行内改名（全字段，D14）═══════════════════════════════

const editingId = ref('')
const editError = ref('')
const form = reactive<{ name: string; type: AssetType; variant: string }>({
  name: '',
  type: '头像',
  variant: '',
})

/**
 * 改名输入框的候选名单 —— §7.3 承诺的「autocomplete off existing asset names」。
 *
 * 它落在**改名**这里而不是一个导入前的命名表单，是因为 §3.2 的风险是
 * **名字拼错了没人发现**（没有名册、没有覆盖率表、v1 又什么都不渲染），而拼错
 * 最常见的形态是"同一个角色被写成两个名字"。改名是唯一一处用户真的在斟酌名字的
 * 地方，把已有名字摆在他眼前，正是那一刻最有用。
 *
 * 用原生 `<datalist>`: 不拦输入（新角色的第一个文件本来就没得可选），
 * 键盘与读屏都是浏览器原生行为，比手搓下拉靠谱。
 */
const nameListId = `asset-name-list-${useId()}`

const knownNames = computed<string[]>(() => assets.groups.map((g) => g.name))

function startEdit(row: AssetMetaRecord): void {
  editingId.value = row.id
  editError.value = ''
  form.name = row.name
  form.type = row.type
  form.variant = row.variant ?? ''
}

function cancelEdit(): void {
  editingId.value = ''
  editError.value = ''
}

/** 拒收理由 → 就地能读懂的人话（每条都说清后果，不只说"不行"） */
function explainOutcome(outcome: AssetMutationOutcome): string {
  switch (outcome) {
    case 'naming-invariant':
      return '名称与变体里都不能出现「头像 / 立绘 / 立绘bg」这类类型词，也不能留空名 —— 否则导出再导入时会被解析成另一行，这条素材会悄悄换主人。'
    case 'media-rule':
      return '立绘不支持 mp4：视频没有合成用的透明通道，抠像立牌会渲染成人物背后一块黑框。换成图片（含动态 WebP），或改成「头像 / 立绘bg」。'
    case 'not-found':
      return '这条素材已经不在库里了（可能在别处被删除）。'
    case 'already-base':
      return '这一项已经是主图了。'
    default:
      return '保存失败，这条素材没有任何改动，可以再试一次。'
  }
}

async function saveEdit(row: AssetMetaRecord): Promise<void> {
  editError.value = ''
  const res = await assets.renameAsset(row.id, {
    name: form.name,
    type: form.type,
    variant: form.variant,
  })
  if (res.outcome !== 'ok') {
    // 就地提示，编辑面板原样留着 —— 用户填的东西不能被清掉。
    // 刻意**不给这段加 role="alert"**: 那会是分区里的第二个 live region，与壳层
    // 那唯一一处抢着说话。视觉上就地显示，读屏则走同一条 announce 通道。
    editError.value = explainOutcome(res.outcome)
    emit('announce', editError.value)
    return
  }
  editingId.value = ''
  emit(
    'announce',
    res.renumberedFrom !== undefined
      ? `已保存；目标位已被占用，自动编号为「${res.row?.variant ?? ''}」。`
      : '已保存。',
  )
}

// ═══ 设为主图 / 删除 ══════════════════════════════════════

async function makePrimary(row: AssetMetaRecord): Promise<void> {
  const res = await assets.setPrimary(row.id)
  if (res.outcome === 'ok') {
    emit(
      'announce',
      res.renumberedFrom !== undefined
        ? `已把「${labelFor(row)}」设为主图，原主图自动编号后保留在库里。`
        : `已把「${labelFor(row)}」设为主图。`,
    )
    return
  }
  // 这一条不是某个输入框的问题（没有输入框），所以走 toast 而非行内提示
  ui.toast(explainOutcome(res.outcome), res.outcome === 'already-base' ? 'info' : 'error')
}

// ═══ 裁剪（一源两图，再编辑入口）═════════════════════════

/**
 * 打开裁剪编辑器。名字**取这条素材已有的 `name`** —— 编辑器里没有名字输入框，
 * 也不该有（§7.3 否决了第二个命名入口）。
 *
 * 视频进不来: `image-crop.ts` 明写"调用方传视频进来是调用方的错"，所以把它拦在
 * **按钮**上而不是等到抛错 —— 一个点了才报错的按钮，等于让用户替我们做类型检查。
 */
const cropSource = ref<Blob | null>(null)
const cropName = ref('')
const cropOpen = ref(false)
const cropLoadingId = ref('')

async function startCrop(row: AssetMetaRecord): Promise<void> {
  if (isVideoExtension(row.ext)) return
  cropLoadingId.value = row.id
  try {
    // 字节也走 store（`assetBlob`）—— store 是本 UI 通往 Dexie 的唯一边界，
    // 于是 D6 那条 loadBlob 注入缝仍然只有一处，日后换磁盘层不用回头找调用点
    const blob = await assets.assetBlob(row.id)
    if (!blob) {
      // 元数据在、字节没了。这不是"再试一次"能修的，得说清楚
      ui.toast('这条素材的字节读不出来（元数据还在，图像已丢失），没法裁剪。', 'error')
      return
    }
    cropSource.value = blob
    cropName.value = row.name
    cropOpen.value = true
  } catch {
    ui.toast('读取素材字节失败，没法裁剪；可以再试一次。', 'error')
  } finally {
    cropLoadingId.value = ''
  }
}

function closeCrop(): void {
  cropOpen.value = false
  cropSource.value = null
}

async function removeRow(row: AssetMetaRecord): Promise<void> {
  const isBase = !row.variant
  const message = isBase
    ? `删除「${row.name}」的${row.type}主图？\n删除主图不会自动提拔其他变体：这一类会显示为「无主图」，需要你手动用「设为主图」指定一个。此操作不可撤销。`
    : `删除「${row.name}」的${row.type}变体「${row.variant}」？此操作不可撤销。`
  const ok = await dialogs.askConfirm({
    title: '删除素材',
    message,
    confirmLabel: '删除',
    danger: true,
  })
  if (!ok) return
  // 失败时 store 自己会弹一条 error（尽力做完模式），这里只播报成功
  if (await assets.deleteAsset(row.id)) emit('announce', '已删除一条素材。')
}
</script>

<template>
  <!-- 裁剪编辑器开着时抽屉先收起来（而不是叠成两层弹窗）: 两个 AppModal 各自在
       document 上听 Escape，同时开着按一下 Esc 会把两层一起关掉。收起来不丢状态 ——
       `group` 由 props.name 现算，编辑器一关抽屉原样回来。 -->
  <AppModal
    :open="!!group && !cropOpen"
    :title="group ? `素材 · ${group.name}` : ''"
    size="lg"
    @update:open="emit('close')"
  >
    <template v-if="group">
      <p class="drawer-meta">
        共 {{ group.total }} 项<template v-if="group.variantCount > 0">，其中 {{ group.variantCount }} 项是变体</template>。
        变体越堆越多是「永不覆盖」的代价 —— 用不上的可以在这里删掉。
      </p>

      <section v-for="sec in sections" :key="sec.type" class="type-section">
        <h5 class="type-label">
          {{ sec.type }}
          <span v-if="sec.baseless" class="baseless-badge">无主图</span>
        </h5>
        <p v-if="sec.baseless" class="baseless-note">
          这一类没有主图（原主图被删过）。给其中一项点「设为主图」即可补上。
        </p>

        <div v-for="row in sec.rows" :key="row.id" class="asset-row">
          <!-- 预览。mp4 用 <video muted playsinline>：静音 + 内联播放不需要用户手势，
               素材没有音频那套自动播放税。刻意不 autoplay —— 抽屉给的是 controls，
               动不动由用户决定，reduced-motion 下也就无需另开分支。 -->
          <span class="thumb">
            <video
              v-if="isVideoExtension(row.ext) && thumbFor(row.id)"
              class="thumb-media"
              :src="thumbFor(row.id) ?? undefined"
              muted
              playsinline
              controls
              preload="metadata"
            />
            <img
              v-else-if="thumbFor(row.id)"
              class="thumb-media"
              :src="thumbFor(row.id) ?? undefined"
              :alt="`${row.name} ${row.type} ${labelFor(row)}`"
            />
            <span v-else class="thumb-blank" role="img" aria-label="预览不可用">—</span>
          </span>

          <span class="row-label">{{ labelFor(row) }}</span>
          <span v-if="!row.variant" class="base-badge">主图</span>
          <span class="row-meta">{{ row.ext.toUpperCase() }}</span>
          <span class="row-meta">{{ fmtBytes(row.bytes) }}</span>

          <AppButton
            variant="secondary"
            size="sm"
            :disabled="!row.variant"
            @click="makePrimary(row)"
          >设为主图</AppButton>
          <!-- 视频不给裁: 画布只取得到某一帧，而"哪一帧"从来没人指定过。
               禁用而不是藏起来 —— 藏起来只会让人以为这一行坏了。 -->
          <button
            class="icon-btn"
            :data-crop-action="row.id"
            :disabled="isVideoExtension(row.ext) || cropLoadingId === row.id"
            :aria-label="isVideoExtension(row.ext) ? '裁剪（视频无法裁剪）' : '裁剪出立绘与头像'"
            :title="isVideoExtension(row.ext)
              ? '视频没法裁剪：画布只取得到某一帧。'
              : '从这张图裁出立绘与头像'"
            @click="startCrop(row)"
          >
            <i class="fa-solid fa-crop-simple" aria-hidden="true" />
          </button>
          <button class="icon-btn" aria-label="重命名" @click="startEdit(row)">
            <i class="fa-solid fa-pen" aria-hidden="true" />
          </button>
          <button class="icon-btn icon-danger" aria-label="删除素材" @click="removeRow(row)">
            <i class="fa-solid fa-trash" aria-hidden="true" />
          </button>

          <!-- 行内改名：name / type / variant 全可改；被拒的理由就地写在下面 -->
          <div v-if="editingId === row.id" class="edit-panel">
            <!-- 候选是已有的素材名，防的是「同一个角色写成两个名字」（§3.2） -->
            <input
              v-model="form.name"
              class="mini-input"
              aria-label="名称"
              placeholder="名称"
              :list="nameListId"
              autocomplete="off"
            />
            <datalist :id="nameListId">
              <option v-for="n in knownNames" :key="n" :value="n" />
            </datalist>
            <select v-model="form.type" class="mini-select" aria-label="类型">
              <option v-for="t in ASSET_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
            <input
              v-model="form.variant"
              class="mini-input"
              aria-label="变体（留空即主图）"
              placeholder="变体，留空即主图"
            />
            <AppButton variant="primary" size="sm" @click="saveEdit(row)">保存</AppButton>
            <AppButton variant="ghost" size="sm" @click="cancelEdit">取消</AppButton>
            <p v-if="editError" class="field-error">{{ editError }}</p>
          </div>
        </div>
      </section>
    </template>
  </AppModal>

  <!-- 刻意挂在 AppModal **外面**: 挂在里面就会随抽屉收起一起卸载，编辑器刚开就没了 -->
  <AssetCropEditor
    :open="cropOpen"
    :source="cropSource"
    :name="cropName"
    @close="closeCrop"
    @announce="emit('announce', $event)"
  />
</template>

<style scoped>
.drawer-meta {
  margin: 0 0 var(--theme-spacing-lg);
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-muted);
}

/* ═══ 类型分节：标题 + ::after 渐变装饰线 ═══ */
.type-section + .type-section {
  margin-top: var(--theme-spacing-lg);
}
.type-label {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin: 0 0 var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.type-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.baseless-note {
  margin: 0 0 var(--theme-spacing-sm);
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-muted);
}

/* ═══ 素材行 ═══ */
.asset-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-sm) 0;
  border-bottom: 1px solid var(--theme-card-border);
}
.asset-row:last-child {
  border-bottom: none;
}
.thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3rem;
  height: 3rem;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
}
.thumb-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-blank {
  font-size: 0.875rem;
  color: var(--theme-text-muted);
  opacity: 0.5;
}
.row-label {
  flex: 1;
  min-width: 6rem;
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 3rem;
  text-align: right;
}

/* 徽章纵向 1px 沿用音频曲库 .tag-chip 的既有取舍（4px 会把行撑高一档） */
.base-badge,
.baseless-badge {
  font-size: 0.6875rem;
  padding: 1px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-full);
}
.base-badge {
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
  color: var(--theme-primary);
}
.baseless-badge {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  color: var(--theme-warning);
}

/* ═══ 行内编辑（与音频曲库的编辑面板同一副外壳） ═══ */
.edit-panel {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  flex-basis: 100%;
  margin-top: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.field-error {
  flex-basis: 100%;
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-error);
}
.mini-input,
.mini-select {
  height: 36px;
  padding: 0 var(--theme-spacing-sm);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.8125rem;
}
.mini-input {
  min-width: 8rem;
  flex: 1;
}
.mini-input:focus,
.mini-select:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}

/* ═══ 图标按钮 ═══ */
.icon-btn {
  min-width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background var(--theme-transition-fast), color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.icon-btn i {
  font-size: 0.875rem;
  line-height: 1;
}
.icon-btn:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.icon-btn:focus-visible {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
.icon-danger:hover:not(:disabled) {
  color: var(--theme-error);
  border-color: color-mix(in srgb, var(--theme-error) 45%, var(--theme-card-border));
}
@media (prefers-reduced-motion: reduce) {
  .icon-btn {
    transition: none;
  }
}
</style>
