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
 *
 * 🔴 **散文方言下「只有标签形式」的老预设会被静默跳过**（图像 v2 / C15）：装配层判它
 *    `missing-preset`，图里那个人干脆不出现，而这张表看上去一切正常。所以每行带一句
 *    提示 —— 判定在 `preset-dialect-form.ts`（与装配层同源的纯函数），这里只渲染。
 */
import { computed, onMounted, ref } from 'vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import AppModal from '../../shared/AppModal.vue';
import AppTabs from '../../shared/AppTabs.vue';
import { useImagePresetStore } from '../../../stores/image-preset-store';
import { useCharacterAppearanceStore } from '../../../stores/character-appearance-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { useUIStore } from '../../../stores/ui-store';
import { contentReadyPromise, getContentRegistry } from '../../../stores/content-store';
import type { ImageDialect, ImagePreset, ImagePresetKind } from '@engine/types-image';
import { parseImageDialects, resolveImageDialect } from '@engine/image-dialect';
import {
  APPEARANCE_SLOT_ORDER,
  EMPTY_APPEARANCE,
  type CharacterAppearance,
} from '@engine/character-appearance';
import { bootstrapAppearance } from '@engine/character-appearance-agent';
import { PRESET_NO_FORM_HINT, lacksFormUnderDialect } from './preset-dialect-form';

const store = useImagePresetStore();
const session = useCharacterAppearanceStore();
const settings = useSettingsStore();
const ui = useUIStore();

// ═══ 当前方言（C15 的提示行靠它）═══
//
// 🔴 内容注册表**不是响应式的**（`getContentRegistry()` 是一个同步取值函数）——
//    直接写进 computed 会把「还没灌注完的空注册表」永久缓存下来，表现为提示行
//    永远不出现。所以落一个 ref，并在 `contentReadyPromise` 兑现后再读一次。
const dialects = ref<ImageDialect[]>(parseImageDialects(getContentRegistry().imageDialects));

/**
 * 当前生效的方言。覆盖袋也一并叠上：虽然本卡只看 `appearance` 这一格（覆盖改不到它），
 * 但取用口只该有一种写法 —— 少传一个参数的版本迟早会被抄去别处。
 */
const activeDialect = computed<ImageDialect>(() => {
  const s = settings.settings;
  return resolveImageDialect(
    dialects.value,
    s.imageDialectId,
    s.imageDialectOverrides?.[s.imageDialectId],
  );
});

/** 这一行的角色在当前方言下画不出形象（判定在 preset-dialect-form.ts） */
function lacksForm(row: ImagePreset): boolean {
  return lacksFormUnderDialect(row, activeDialect.value);
}

onMounted(() => {
  void store.init();
  // 会话副本按存档存（D56）。没有活动存档时它是空的，界面据此说明白，
  // 而不是画一个点了没反应的重置按钮。
  if (ui.activeSaveId) void session.load(ui.activeSaveId);
  void contentReadyPromise.then(() => {
    dialects.value = parseImageDialects(getContentRegistry().imageDialects);
  });
});

// ═══ 会话副本（D56）═══

/** 槽的中文名 —— 编辑器与差异行共用，两处各写一份必然漂 */
const SLOT_LABELS: Record<keyof CharacterAppearance, string> = {
  count: '人数性别',
  hairColor: '发色',
  hairStyle: '发型',
  eyes: '瞳色',
  build: '体型',
  features: '固有特征',
  outfit: '穿戴',
  condition: '状态',
  expression: '表情',
};

const slotOrder = APPEARANCE_SLOT_ORDER;
const hasSave = computed(() => ui.activeSaveId !== null);
const changedCount = computed(() => session.rows.length);

/** 这个角色在本档里被 AI 改过哪些槽（空 = 没改过） */
function sessionSlots(name: string): { slot: keyof CharacterAppearance; value: string }[] {
  const patch = session.patchOf(name);
  if (!patch) return [];
  return slotOrder
    .filter((slot) => patch[slot] !== undefined)
    .map((slot) => ({ slot, value: patch[slot] as string }));
}

async function resetOne(name: string) {
  const r = await session.resetOne(name);
  ui.toast(r.ok ? `「${name}」已回到初始设定` : r.message, r.ok ? 'success' : 'error');
}

async function resetAll() {
  const r = await session.resetAll();
  ui.toast(r.ok ? '本存档的外貌变化已全部重置' : r.message, r.ok ? 'success' : 'error');
}

// ═══ 只有本档外貌、还没有初始设定的角色（v1.3）═══
//
// 🔴 这一节存在的理由: 没有初始设定的角色，出图 AI 即兴出来的样子只落**会话副本**
//    （v1.3 裁定 —— AI 一个字节都碰不到全局基线）。那份外貌**没有对应的预设行**，
//    上面那张表按预设行渲染，于是它会整个隐形: 用户看不见 AI 给他定成了什么样，
//    也没有单角色重置可按（只剩「全部重置」这把大锤）。
//
//    「存为初始设定」是这一节的另一半 —— 从「AI 即兴」到「用户拥有、跨存档钉死」的
//    唯一路径，且**由人按下**。这正是 v1.3 把自动建基线砍掉之后该有的替代品。

interface SessionOnlyRow {
  name: string;
  appearance: CharacterAppearance;
  slots: { slot: keyof CharacterAppearance; value: string }[];
}

const sessionOnlyRows = computed<SessionOnlyRow[]>(() => {
  const named = new Set(store.characters.map((p) => p.name));
  const out: SessionOnlyRow[] = [];
  for (const row of session.rows) {
    // 🔴 名字原样比较（铁律 1）
    if (named.has(row.name)) continue;
    const appearance = bootstrapAppearance(row.patch);
    const slots = slotOrder
      .filter((slot) => appearance[slot].trim() !== '')
      .map((slot) => ({ slot, value: appearance[slot] }));
    if (slots.length === 0) continue;
    out.push({ name: row.name, appearance, slots });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
});

const promoting = ref<string | null>(null);

/**
 * 把 AI 即兴出来的那份**提升成初始设定**（跨存档、只有用户能改的那一份）。
 *
 * 提升之后把会话行删掉: 它的内容已经**逐字**成为基线，留着只会让这个角色顶着一个
 * 「本档已变」的角标，而它与基线其实分毫不差。
 */
async function promoteToBaseline(row: SessionOnlyRow) {
  if (promoting.value !== null) return;
  promoting.value = row.name;
  try {
    const saved = await store.upsert({
      kind: 'character',
      name: row.name,
      appearance: row.appearance,
    });
    if (!saved.ok) {
      ui.toast(saved.message, 'error');
      return;
    }
    await session.resetOne(row.name);
    ui.toast(`「${row.name}」已存为初始设定，之后每个存档都用它`, 'success');
  } finally {
    promoting.value = null;
  }
}

const activeKind = ref<ImagePresetKind>('character');

/**
 * 🪦 D59：「地点」页签已删 —— 地点无法穷举（宫殿 → 宴会厅 → 盥洗室），
 *    改由 `image_prompt` 侧链在出图时现写。只剩一个页签仍保留这套外壳，
 *    是因为 D56 之后这里要长出「初始定义 / 会话定义」两个视图。
 */
const tabs = computed(() => [
  { key: 'character' as ImagePresetKind, label: '角色', badge: store.characters.length },
]);

const rows = computed<ImagePreset[]>(() => store.characters);

// ═══ 编辑器 ═══

const editorOpen = ref(false);
/** 打开编辑器时的原名；null = 新建。改名判据就是它与 `form.name` 的差 */
const editingName = ref<string | null>(null);
const saving = ref(false);

const form = ref({
  name: '',
  positive: '',
  negative: '',
  pinnedSeed: null as number | null,
  appearance: { ...EMPTY_APPEARANCE } as CharacterAppearance,
});

function openCreate() {
  editingName.value = null;
  form.value = {
    name: '',
    positive: '',
    negative: '',
    pinnedSeed: null,
    appearance: { ...EMPTY_APPEARANCE },
  };
  editorOpen.value = true;
}

function openEdit(row: ImagePreset) {
  editingName.value = row.name;
  form.value = {
    name: row.name,
    positive: row.dialects.danbooru?.positive ?? '',
    negative: row.dialects.danbooru?.negative ?? '',
    pinnedSeed: row.pinnedSeed ?? null,
    appearance: { ...EMPTY_APPEARANCE, ...(row.appearance ?? {}) },
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
      // 🔴 槽整份写回：编辑器里每个槽都有输入框，「留空」就是明确的空值。
      //    只挑非空的写会让「清空某个槽」永远做不到（D58 的空串语义）。
      appearance: { ...form.value.appearance },
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
        角色的<strong>初始设定</strong>：每次出图都带上同一份外观，这是画面一致性的来源。
        名字按<strong>原样</strong>匹配正文里的角色名，不做大小写或空格的容错。
      </p>
      <p class="image-card-scope">
        剧情里换了衣服、留了疤，出图 AI 会把变化<strong>自动</strong>记进
        <strong>本存档的副本</strong>；初始设定不受影响，随时可以重置回去。
      </p>
    </div>

    <div v-if="hasSave" class="session-bar">
      <span class="session-note">
        本存档有 <strong>{{ changedCount }}</strong> 个角色的外貌被剧情改过
      </span>
      <AppButton
        variant="ghost"
        size="sm"
        :disabled="changedCount === 0"
        class="reset-all-btn"
        @click="resetAll"
        >全部重置</AppButton
      >
    </div>
    <p v-else class="form-hint session-note">
      当前没有进行中的存档，所以看不到「本存档的外貌变化」——下面编辑的是初始设定。
    </p>

    <div class="preset-toolbar">
      <AppTabs :tabs="tabs" :active="activeKind" @select="activeKind = $event" />
      <AppButton variant="ghost" size="sm" @click="openCreate">+ 新建</AppButton>
    </div>

    <div v-if="rows.length === 0 && sessionOnlyRows.length === 0" class="empty-tab">
      还没有角色预设，画中人全凭 AI 即兴
    </div>

    <ul v-else-if="rows.length > 0" class="preset-list">
      <li v-for="row in rows" :key="row.key" class="preset-row">
        <div class="preset-main">
          <span class="preset-name">{{ row.name }}</span>
          <span class="preset-summary">{{ summarize(row) }}</span>
          <!--
            C15：散文方言下只有 danbooru 标签的老预设会被**静默跳过**（不做跨方言降级），
            画面里就是少了个人。这一行是那件事唯一看得见的地方。
          -->
          <span v-if="lacksForm(row)" class="dialect-warn">{{ PRESET_NO_FORM_HINT }}</span>
          <!-- 会话副本：只列**改过的槽**，让「现在与初始差在哪」一眼看得见 -->
          <ul v-if="sessionSlots(row.name).length > 0" class="session-diff">
            <li v-for="d in sessionSlots(row.name)" :key="d.slot">
              <span class="diff-slot">{{ SLOT_LABELS[d.slot] }}</span>
              <span class="diff-value">{{ d.value || '（已清空）' }}</span>
            </li>
          </ul>
        </div>
        <div class="preset-actions">
          <span v-if="sessionSlots(row.name).length > 0" class="session-badge" title="本存档里变过"
            >本档已变</span
          >
          <AppButton
            v-if="sessionSlots(row.name).length > 0"
            variant="ghost"
            size="sm"
            class="reset-one-btn"
            @click="resetOne(row.name)"
            >重置</AppButton
          >
          <span v-if="row.pinnedSeed !== undefined" class="seed-badge" title="已钉住 seed"
            >seed</span
          >
          <AppButton variant="ghost" size="sm" @click="openEdit(row)">编辑</AppButton>
          <AppButton variant="ghost" size="sm" @click="pendingDelete = row">删除</AppButton>
        </div>
      </li>
    </ul>

    <!--
      只有本档外貌、还没有初始设定的角色（v1.3）。
      不列出来的话，AI 给他定成了什么样是**看不见**的，也没有单角色重置可按。
    -->
    <div v-if="sessionOnlyRows.length > 0" class="session-only">
      <h5 class="session-only-head">本档临时外貌（还没有初始设定）</h5>
      <p class="form-hint session-only-note">
        这些角色你还没写过初始设定，出图 AI 即兴给了他们一份，<strong>只在本存档有效</strong>。
        觉得对就「存为初始设定」——从此跨存档钉死，而且只有你能改。
      </p>
      <ul class="preset-list">
        <li v-for="row in sessionOnlyRows" :key="row.name" class="preset-row">
          <div class="preset-main">
            <span class="preset-name">{{ row.name }}</span>
            <ul class="session-diff">
              <li v-for="d in row.slots" :key="d.slot">
                <span class="diff-slot">{{ SLOT_LABELS[d.slot] }}</span>
                <span class="diff-value">{{ d.value }}</span>
              </li>
            </ul>
          </div>
          <div class="preset-actions">
            <span class="session-badge" title="只在本存档有效">仅本档</span>
            <AppButton
              variant="ghost"
              size="sm"
              :disabled="promoting !== null"
              @click="promoteToBaseline(row)"
              >存为初始设定</AppButton
            >
            <AppButton variant="ghost" size="sm" class="reset-one-btn" @click="resetOne(row.name)"
              >重置</AppButton
            >
          </div>
        </li>
      </ul>
    </div>

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
        <p class="form-hint">
          下面是这个角色的<strong>初始设定</strong>。剧情里的变化由 AI 记在本存档的副本里，
          不会改动这里 —— 所以这几栏可以放心当作「她本来的样子」。
        </p>
        <div class="slot-grid">
          <label v-for="slot in slotOrder" :key="slot" class="form-label slot-label"
            >{{ SLOT_LABELS[slot] }}
            <input v-model="form.appearance[slot]" class="form-input" spellcheck="false" />
          </label>
        </div>
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

/* 会话副本（D56）：初始设定 vs 本档变化 */
.session-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-sm);
  padding: 8px 12px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-md);
}
.session-note {
  font-size: 0.8rem;
  color: var(--theme-text-secondary);
}
.session-badge {
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--theme-primary) 14%, var(--theme-card-bg));
  color: var(--theme-primary);
  white-space: nowrap;
}
.session-diff {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.session-diff li {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.diff-slot {
  color: var(--theme-primary);
  margin-right: 4px;
}
/* C15 提示行 —— warning 语义（design.md §1 的语义徽章配方，只取色不做胶囊：
 * 它是一句完整的话，压成小圆角标签会被截断成读不懂的半句） */
.dialect-warn {
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--theme-warning);
}
/* 只有本档外貌的角色（v1.3）—— 与上面那张表刻意分开，两者的归属不同
 *
 * 🔴 边框一律 `--theme-card-border`（design.md 禁令表）：这里原本写的是
 *    `--theme-border`，那个 token 全仓没有定义，且没写 fallback ——
 *    整条声明 invalid at computed-value time，`border-top-style` 退回初始值
 *    `none`，于是**这条线根本没画出来**。而它承担的正是 D60/D61 的语义：
 *    把「有基线预设的角色」与「只有本档临时外貌的角色」分开。唯一说明
 *    两张表归属不同的视觉线索，此前是隐形的。 */
.session-only {
  margin-top: var(--theme-spacing-md);
  padding-top: var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
}
.session-only-head {
  margin: 0 0 4px;
  font-size: 0.85rem;
  color: var(--theme-text-secondary);
}
.session-only-note {
  margin: 0 0 var(--theme-spacing-sm);
}
.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-sm);
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

/* 空态样式在 styles/utilities.css（全站唯一一份 `.empty-tab`，design.md §5.2） */

.confirm-text {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.7;
  color: var(--theme-text-secondary);
}
</style>
