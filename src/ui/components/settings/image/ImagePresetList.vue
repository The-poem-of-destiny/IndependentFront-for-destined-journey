<script setup lang="ts">
/**
 * 第三张卡：**视觉预设** —— 角色 / 地点的 danbooru 外观描述 CRUD（D40/D51）。
 *
 * 角色预设管**人**的一致性，地点预设管**场景**的一致性 —— 两者形状完全一样，
 * 所以是同一张表加一个 `kind`（D40），这里也就是同一份 UI 加两个筛选页签。
 *
 * 🔴 **改名 ≠ 改字段**：主键是 `` `${kind}:${name}` ``，所以改名走 store 的
 *    `rename()`（删旧建新），不是原地 upsert —— 直接 upsert 会留下一条孤儿旧记录，
 *    而界面上看起来只是"改了个名字"。目标名被占用时 store 会拒绝（`name-taken`），
 *    这里如实把它的 `message` 报给用户：自动编号在这里是骗人的，编号过的名字
 *    永远查不中（预设是**按名字**被出图链路查中的）。
 *
 * 🔴 名字**不做任何归一化**（铁律 1 / D2）：不 trim、不折叠大小写、不 NFKC。
 *    角色名的真源在别处，这边偷偷改名只会让预设查不中。所以输入框里写什么就存什么。
 *
 * 🔴 `pinnedSeed` 的说明必须**照实说**：同一 seed 只让构图更接近，**不保证同一张脸**。
 *    把它写成"锁定角色长相"会造出一个我们守不住的承诺。它现实中的设置路径是图鉴里的
 *    「把这次的 seed 钉给他」，这里只提供查看与清除。
 */
import { computed, onMounted, ref } from 'vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import AppModal from '../../shared/AppModal.vue';
import AppTabs from '../../shared/AppTabs.vue';
import { useImagePresetStore } from '../../../stores/image-preset-store';
import { useUIStore } from '../../../stores/ui-store';
import type { ImagePreset, ImagePresetKind } from '@engine/types-image';

const store = useImagePresetStore();
const ui = useUIStore();

onMounted(() => {
  void store.init();
});

const activeKind = ref<ImagePresetKind>('character');

const tabs = computed(() => [
  { key: 'character' as ImagePresetKind, label: '角色', badge: store.characters.length },
  { key: 'location' as ImagePresetKind, label: '地点', badge: store.locations.length },
]);

const rows = computed<ImagePreset[]>(() =>
  activeKind.value === 'character' ? store.characters : store.locations,
);

// ═══ 编辑器 ═══

const editorOpen = ref(false);
/** 打开编辑器时的原名；null = 新建。改名判据就是它与 `form.name` 的差 */
const editingName = ref<string | null>(null);
const saving = ref(false);

const form = ref({ name: '', positive: '', negative: '', pinnedSeed: null as number | null });

function openCreate() {
  editingName.value = null;
  form.value = { name: '', positive: '', negative: '', pinnedSeed: null };
  editorOpen.value = true;
}

function openEdit(row: ImagePreset) {
  editingName.value = row.name;
  form.value = {
    name: row.name,
    positive: row.dialects.danbooru?.positive ?? '',
    negative: row.dialects.danbooru?.negative ?? '',
    pinnedSeed: row.pinnedSeed ?? null,
  };
  editorOpen.value = true;
}

async function save() {
  if (saving.value) return;
  // 空名字由 store 拒收（主键会退化成 `character:`，两条空名字预设互相覆盖），
  // 但在这里先拦一次，省用户一次往返
  if (form.value.name === '') {
    ui.toast('名字不能为空。', 'warning');
    return;
  }
  saving.value = true;
  try {
    const kind = activeKind.value;
    const renamed = editingName.value !== null && editingName.value !== form.value.name;
    if (renamed) {
      const r = await store.rename(kind, editingName.value as string, form.value.name);
      if (!r.ok) {
        ui.toast(r.message, 'error');
        return;
      }
    }
    const result = await store.upsert({
      kind,
      name: form.value.name,
      danbooru: { positive: form.value.positive, negative: form.value.negative },
      ...(form.value.pinnedSeed !== null && Number.isFinite(form.value.pinnedSeed)
        ? { pinnedSeed: form.value.pinnedSeed }
        : {}),
    });
    if (!result.ok) {
      ui.toast(result.message, 'error');
      return;
    }
    editorOpen.value = false;
    ui.toast('预设已保存', 'success');
  } finally {
    saving.value = false;
  }
}

// ═══ 删除 ═══

const pendingDelete = ref<ImagePreset | null>(null);

async function confirmDelete() {
  const row = pendingDelete.value;
  if (!row) return;
  const r = await store.remove(row.key);
  pendingDelete.value = null;
  ui.toast(r.ok ? '预设已删除' : r.message, r.ok ? 'info' : 'error');
}

/** 列表行里的一句话摘要；空预设也要有话说，不然那一行看着像坏了 */
function summarize(row: ImagePreset): string {
  const positive = row.dialects.danbooru?.positive ?? '';
  return positive === '' ? '（还没写外观标签）' : positive;
}
</script>

<template>
  <AppCard padding="md">
    <div class="image-card-head">
      <h4>视觉预设</h4>
      <p class="image-card-scope">
        同一个角色/地点每次出图都带上同一串外观标签 —— 这是画面一致性的来源。
        名字按<strong>原样</strong>匹配正文里的角色名与地点名，不做大小写或空格的容错。
      </p>
    </div>

    <div class="preset-toolbar">
      <AppTabs :tabs="tabs" :active="activeKind" @select="activeKind = $event" />
      <AppButton variant="ghost" size="sm" @click="openCreate">+ 新建</AppButton>
    </div>

    <div v-if="rows.length === 0" class="empty-tab">
      {{ activeKind === 'character' ? '还没有角色预设，画中人全凭 AI 即兴' : '还没有地点预设' }}
    </div>

    <ul v-else class="preset-list">
      <li v-for="row in rows" :key="row.key" class="preset-row">
        <div class="preset-main">
          <span class="preset-name">{{ row.name }}</span>
          <span class="preset-summary">{{ summarize(row) }}</span>
        </div>
        <div class="preset-actions">
          <span v-if="row.pinnedSeed !== undefined" class="seed-badge" title="已钉住 seed"
            >seed</span
          >
          <AppButton variant="ghost" size="sm" @click="openEdit(row)">编辑</AppButton>
          <AppButton variant="ghost" size="sm" @click="pendingDelete = row">删除</AppButton>
        </div>
      </li>
    </ul>

    <!-- 编辑器（AppModal 自己 Teleport，留在卡内层不改变渲染位置） -->
    <AppModal
      :open="editorOpen"
      :title="editingName === null ? '新建视觉预设' : '编辑视觉预设'"
      size="md"
      @update:open="editorOpen = $event"
    >
      <div class="api-form">
        <label class="form-label"
          >名字
          <p class="form-hint">
            与正文里出现的{{ activeKind === 'character' ? '角色名' : '地点名'
            }}<strong>逐字相同</strong>才会命中，不做归一化
          </p>
          <input v-model="form.name" class="form-input"
        /></label>
        <label class="form-label"
          >外观标签（正向）
          <p class="form-hint">danbooru 逗号串，如 silver hair, golden eyes, black coat</p>
          <textarea v-model="form.positive" class="form-input form-textarea" rows="3"></textarea>
        </label>
        <label class="form-label"
          >专属负向
          <p class="form-hint">
            只在这个{{ activeKind === 'character' ? '角色' : '地点' }}出场时追加，通常留空
          </p>
          <textarea v-model="form.negative" class="form-input form-textarea" rows="2"></textarea>
        </label>
        <label v-if="activeKind === 'character'" class="form-label"
          >钉住的 seed
          <p class="form-hint">
            同一 seed 只让构图更接近，<strong>不保证同一张脸</strong>。留空 = 每次随机。
            正常设置路径是图鉴里的「把这次的 seed 钉给他」。
          </p>
          <input v-model.number="form.pinnedSeed" type="number" class="form-input"
        /></label>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="editorOpen = false">取消</AppButton>
        <AppButton variant="primary" size="sm" :disabled="saving" @click="save">保存</AppButton>
      </template>
    </AppModal>

    <AppModal
      :open="pendingDelete !== null"
      title="删除这条预设？"
      size="sm"
      @update:open="pendingDelete = null"
    >
      <p class="confirm-text">
        删掉「{{ pendingDelete?.name }}」之后，他/它在新图里的外观会重新变成 AI 即兴发挥。
        已经画出来的图不受影响。
      </p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="pendingDelete = null">取消</AppButton>
        <AppButton variant="primary" size="sm" @click="confirmDelete">删除</AppButton>
      </template>
    </AppModal>
  </AppCard>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.image-card-head {
  margin-bottom: var(--theme-spacing-lg);
}
.image-card-head h4 {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 1.05rem;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-xs);
}
.image-card-head h4::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.image-card-scope {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--theme-text-muted);
}

.preset-toolbar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  margin-bottom: var(--theme-spacing-md);
}
.preset-toolbar > :first-child {
  flex: 1;
  min-width: 0;
}

.preset-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.preset-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  min-height: 36px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  transition: background var(--theme-transition-fast);
}
.preset-row:hover {
  background: var(--theme-tab-hover-bg);
}
.preset-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.preset-name {
  font-family: var(--theme-font-title);
  font-size: 0.9rem;
  color: var(--theme-text-primary);
}
.preset-summary {
  font-size: 0.76rem;
  color: var(--theme-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preset-actions {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  flex-shrink: 0;
}
.seed-badge {
  padding: 2px 6px;
  font-size: 0.68rem;
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  color: var(--theme-primary);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
}

/* 空态：装饰符 + 斜体（design.md §5.2） */
.empty-tab {
  padding: 32px 0;
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

.confirm-text {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.7;
  color: var(--theme-text-secondary);
}
</style>
