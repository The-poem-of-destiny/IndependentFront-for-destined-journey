<script setup lang="ts">
/**
 * 世界书分区 —— 列表 / 导入 / 新建 / 删除 / 单本恢复 / 全部恢复 + 条目编辑器
 * （Q-25 从 SettingsPage.vue 抽出）
 *
 * 📌 Agent 配置里的世界书勾选列表已退役（内容计划 §7.2）：读取范围是**书 / 条目自己的
 *    声明**（`lore.audiences`）。玩家自建书在编辑器顶部的「读取范围」里改，
 *    新建与导入时默认只给正文 Agent。
 */
import { computed, nextTick, ref } from 'vue';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import WorldBookEditor from './WorldBookEditor.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useUIStore } from '../../stores/ui-store';
import { useWorldBookStore } from '../../stores/worldbook-store';
import type { WorldBook } from '@engine/types/types';
import { importUserWorldBookEntries } from '@engine/content/worldbook-import';
import { confirmDialog } from '../../lib/confirm-dialog';

/** 新建 / 导入的自建书默认读取范围（只给正文；玩家可在编辑器里加） */
const DEFAULT_USER_BOOK_AUDIENCES = ['story'] as const;

const cfg = useSettingsStore();
const s = cfg.settings;
const ui = useUIStore();
// Phase 0：书本体在 Dexie，唯一入口是 worldbook-store（`s.worldBooks` 已不存在）
const wb = useWorldBookStore();

const activeWorldBook = ref<WorldBook | null>(null);

/** 保存内置世界书 → 写回 data/worldbooks/{id}.json（需要开发服务器运行） */
async function saveWorldBookAsDefault(book: WorldBook) {
  if (!book.builtIn) {
    ui.toast('只有内置世界书可以保存为默认', 'warning');
    return;
  }
  try {
    const payload = { ...book, builtIn: true };
    const res = await fetch(`/api/worldbooks/${book.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload, null, 2),
    });
    if (res.ok) {
      ui.toast(`已将"${book.name}"保存为项目默认`, 'success');
    } else {
      ui.toast(`保存失败 (${res.status})`, 'error');
    }
  } catch {
    ui.toast('保存失败，请确认开发服务器正在运行', 'error');
  }
}

/** 重置单本内置世界书 → 删除用户副本，从默认真源重新加载（§5.6：pack payload > 占位文件） */
async function resetSingleWorldBook(id: string) {
  const book = wb.getBook(id);
  if (!book?.builtIn) return;
  const ok = await confirmDialog({
    title: '重置内置世界书',
    message: `将《${book.name}》恢复为默认？您对该书的所有修改将被清除。`,
    confirmLabel: '重置',
    danger: true,
  });
  if (!ok) return;
  try {
    // 内容-引擎分离波 1 / §5.6：默认真源 = 已装 content pack 的 payload > 占位文件。
    // 导入真实包后 restore 不再把提示词打回占位。
    const { loadDefaultBook } = await import('../../stores/content-store');
    const fresh = await loadDefaultBook(id);
    if (!fresh) {
      ui.toast('恢复失败：未找到内置版本', 'error');
      return;
    }
    await wb.upsertBook({ ...fresh, builtIn: true });
    if (activeWorldBook.value?.id === id) activeWorldBook.value = wb.getBook(id) ?? null;
    ui.toast(`"${book.name}"已恢复为默认`, 'success');
  } catch {
    ui.toast('恢复失败', 'error');
  }
}

/** 「导入 ST 世界书」：选文件 → 交给 importWorldBookFile */
function importWorldBook() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void importWorldBookFile(f);
  };
  input.click();
}

/**
 * 解析 + 冲突处理 + 落库（S-21 / S-28）。
 * - 没有 `entries` 条目表的 JSON 直接拒绝（此前会「成功」导入一本 0 条目的书）；
 * - id 与已有书相同 → 先问「覆盖」，不覆盖再问「导入为副本」（唯一 id），绝不静默覆盖。
 */
async function importWorldBookFile(f: File) {
  const baseName = f.name.replace(/\.json$/i, '');
  let raw: Record<string, unknown> & { lore?: { audiences?: unknown } };
  try {
    raw = JSON.parse(await f.text());
  } catch {
    ui.toast('导入失败：文件不是有效的 JSON', 'error');
    return;
  }
  if (!raw || typeof raw !== 'object' || !raw.entries || typeof raw.entries !== 'object') {
    ui.toast('导入失败：文件里没有 entries 条目表，不是 SillyTavern 世界书', 'error');
    return;
  }
  let book: WorldBook;
  try {
    const declared = Array.isArray(raw.lore?.audiences)
      ? (raw.lore.audiences as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined;
    book = {
      id: baseName,
      name: (typeof raw.name === 'string' && raw.name.trim()) || baseName,
      partition: 'world_setting',
      description: typeof raw.description === 'string' ? raw.description : '',
      // 读取范围逐条目写入：条目自带声明就用它，否则用文件书级声明（旧格式）或默认只给正文
      entries: importUserWorldBookEntries(
        raw.entries as Parameters<typeof importUserWorldBookEntries>[0],
        'world_setting',
        declared ?? DEFAULT_USER_BOOK_AUDIENCES,
      ),
    };
  } catch {
    ui.toast('导入失败：条目格式无法识别', 'error');
    return;
  }

  const existing = wb.getBook(book.id);
  if (existing) {
    const overwrite = await confirmDialog({
      title: '已有同名世界书',
      message: `覆盖已有的《${existing.name}》（${existing.entries?.length || 0} 条目）？覆盖后原内容无法找回。`,
      confirmLabel: '覆盖',
      cancelLabel: '不覆盖',
      danger: true,
    });
    if (!overwrite) {
      const asCopy = await confirmDialog({
        title: '导入为副本？',
        message: `保留原有的《${existing.name}》，把文件作为一本新书导入。`,
        confirmLabel: '导入为副本',
        cancelLabel: '取消导入',
      });
      if (!asCopy) return;
      book = { ...book, id: wb.uniqueBookId(book.id) };
    }
  }

  try {
    await wb.upsertBook(book);
  } catch {
    ui.toast('导入失败：写入存储出错', 'error');
    return;
  }
  ui.toast(`已导入 "${book.name}" (${book.entries.length} 条目)`, 'success');
}

// ===== 新建世界书（行内输入行，替代原生 prompt） =====

const newBookOpen = ref(false);
const newBookName = ref('');
const newBookError = ref('');
const newBookInput = ref<HTMLInputElement | null>(null);

async function newWorldBook() {
  newBookOpen.value = true;
  newBookName.value = '';
  newBookError.value = '';
  await nextTick();
  newBookInput.value?.focus();
}

function cancelNewWorldBook() {
  newBookOpen.value = false;
  newBookError.value = '';
}

/** 提交新建：同名（去首尾空白后完全相同）拒绝；id 由名字生成且保证唯一，绝不覆盖已有书（S-21） */
async function submitNewWorldBook() {
  const name = newBookName.value.trim();
  if (!name) {
    newBookError.value = '请输入世界书名称';
    return;
  }
  const dup = wb.books.find((b) => b.name.trim() === name);
  if (dup) {
    newBookError.value = `已有同名世界书《${dup.name}》，请换个名字`;
    return;
  }
  const id = wb.uniqueBookId(name);
  const book: WorldBook = {
    id,
    name,
    partition: 'world_setting',
    entries: [],
  };
  try {
    await wb.upsertBook(book);
  } catch {
    ui.toast('创建失败', 'error');
    return;
  }
  newBookOpen.value = false;
  activeWorldBook.value = wb.getBook(id) ?? book;
  ui.toast(`已创建 "${name}"`, 'success');
}

async function deleteWorldBook(id: string) {
  const book = wb.getBook(id);
  if (!book) return;
  const ok = await confirmDialog({
    title: '删除世界书',
    message: `删除《${book.name}》及其全部 ${book.entries?.length || 0} 条条目？此操作不可撤销。`,
    confirmLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await wb.deleteBook(id);
  } catch {
    ui.toast('删除失败', 'error');
    return;
  }
  if (activeWorldBook.value?.id === id) activeWorldBook.value = null;
  ui.toast(`已删除"${book.name}"`, 'warning');
}

function closeWorldBookEditor() {
  activeWorldBook.value = null;
}

/** 恢复默认会删掉的书（自建 / 导入 / 工坊）——确认框逐本点名 */
const removableBooks = computed(() => wb.books.filter((b) => !b.builtIn));

/**
 * 全部恢复默认（S-22）：确认框点名将被删除的书；失败如实报错且数据不动。
 * 直接调 worldbook-store（它在失败时抛出）——settings-store 的同名包装会吞掉错误。
 */
async function resetWorldBooks() {
  const doomed = removableBooks.value;
  const shown = doomed.slice(0, 5).map((b) => `《${b.name}》（${b.entries?.length || 0} 条目）`);
  if (doomed.length > shown.length) shown.push(`……另有 ${doomed.length - shown.length} 本`);
  const ok = await confirmDialog({
    title: '恢复全部世界书为默认',
    message:
      doomed.length > 0
        ? `将删除以下 ${doomed.length} 本自建或导入的世界书，并清除对内置书的所有修改。此操作不可撤销。`
        : '将清除对内置书的所有修改，重新载入默认版本。此操作不可撤销。',
    details: shown,
    confirmLabel: '删除并恢复默认',
    danger: true,
  });
  if (!ok) return;
  try {
    await wb.resetToDefaults();
    cfg.saveNow();
  } catch (err) {
    const reason = err instanceof Error && err.message ? `：${err.message}` : '';
    ui.toast(`恢复失败${reason}。现有世界书未改动`, 'error');
    return;
  }
  activeWorldBook.value = null;
  ui.toast('世界书已恢复为默认', 'success');
}

async function handleWorldBookUpdate(updated: WorldBook) {
  try {
    await wb.upsertBook(updated);
  } catch {
    ui.toast('保存失败', 'error');
    return;
  }
  ui.toast('世界书已保存', 'success');
}
</script>

<template>
  <section class="section centered">
    <!-- 编辑模式：显示条目编辑器 -->
    <WorldBookEditor
      v-if="activeWorldBook"
      :book="activeWorldBook"
      :readonly="(activeWorldBook.builtIn && !s.allowEditBuiltInBooks) || false"
      @back="closeWorldBookEditor"
      @update="handleWorldBookUpdate"
    />

    <!-- 列表模式 -->
    <template v-else>
      <div class="section-head">
        <div>
          <h3>世界书管理</h3>
          <p class="section-desc">管理世界书条目，为 Agent 提供世界观上下文。</p>
        </div>
        <div class="worldbook-toolbar">
          <label
            class="toggle-label protection-toggle"
            :title="
              s.allowEditBuiltInBooks
                ? '内置书当前可编辑，点击恢复只读保护'
                : '内置书当前受只读保护，点击允许编辑'
            "
          >
            <span class="toggle-label-text">{{
              s.allowEditBuiltInBooks ? '可编辑' : '只读保护'
            }}</span>
            <input v-model="s.allowEditBuiltInBooks" type="checkbox" class="toggle-input" />
            <span class="toggle-slider"></span>
          </label>
          <div class="worldbook-actions">
            <AppButton variant="secondary" size="sm" @click="importWorldBook"
              >导入ST世界书</AppButton
            >
            <AppButton variant="primary" size="sm" @click="newWorldBook">+ 新建世界书</AppButton>
          </div>
        </div>
      </div>

      <!-- 新建世界书：行内输入行（替代原生 prompt） -->
      <form v-if="newBookOpen" class="new-book-row" @submit.prevent="submitNewWorldBook">
        <label class="form-label" for="new-book-name">新世界书名称</label>
        <div class="new-book-controls">
          <input
            id="new-book-name"
            ref="newBookInput"
            v-model="newBookName"
            class="form-input"
            placeholder="例如：我的大陆设定"
            :aria-invalid="newBookError ? 'true' : undefined"
            aria-describedby="new-book-error"
            @input="newBookError = ''"
            @keydown.escape.prevent="cancelNewWorldBook"
          />
          <AppButton variant="primary" size="sm" type="submit">创建</AppButton>
          <AppButton variant="ghost" size="sm" type="button" @click="cancelNewWorldBook"
            >取消</AppButton
          >
        </div>
        <p v-if="newBookError" id="new-book-error" class="new-book-error" role="alert">
          {{ newBookError }}
        </p>
      </form>

      <AppCard v-if="wb.books.length === 0" padding="md">
        <div class="empty-tab">
          <i class="fa-solid fa-book-open empty-tab-icon" aria-hidden="true"></i>
          还没有任何世界书
          <span class="empty-tab-hint">
            用右上角「导入 ST 世界书」读入一份 SillyTavern 的 JSON，或「新建世界书」从空白开始
          </span>
        </div>
      </AppCard>

      <div v-else class="worldbook-list">
        <AppCard v-for="book in wb.books" :key="book.id" padding="md" class="worldbook-card">
          <div class="wb-info">
            <h4>
              <i
                class="fa-solid fa-book"
                aria-hidden="true"
                style="margin-right: 6px; opacity: 0.6"
              ></i
              >{{ book.name }}
              <span v-if="book.builtIn" class="builtin-badge">内置</span>
            </h4>
            <p class="text-sm text-muted">{{ book.description || book.partition }}</p>
            <span class="text-sm text-muted">{{ book.entries?.length || 0 }} 条目</span>
          </div>
          <div style="display: flex; gap: 8px">
            <AppButton
              v-if="!book.builtIn"
              variant="danger"
              size="sm"
              :aria-label="`删除 ${book.name}`"
              :title="`删除 ${book.name}`"
              @click="deleteWorldBook(book.id)"
            >
              <i class="fa-solid fa-trash" aria-hidden="true"></i>
            </AppButton>
            <AppButton
              v-if="book.builtIn && s.allowEditBuiltInBooks"
              variant="ghost"
              size="sm"
              @click="saveWorldBookAsDefault(book)"
            >
              保存为默认
            </AppButton>
            <AppButton
              v-if="book.builtIn"
              variant="ghost"
              size="sm"
              style="color: var(--color-warning)"
              @click="resetSingleWorldBook(book.id)"
            >
              重置
            </AppButton>
            <AppButton variant="secondary" size="sm" @click="activeWorldBook = book">
              <i
                v-if="book.builtIn"
                class="fa-solid fa-eye"
                aria-hidden="true"
                style="margin-right: 4px"
              ></i>
              浏览
              <i class="fa-solid fa-arrow-right" aria-hidden="true" style="margin-left: 4px"></i>
            </AppButton>
          </div>
        </AppCard>
      </div>

      <!-- 危险区（S-22）：与导入/新建分开，放在分区最底部 -->
      <div class="danger-zone" role="group" aria-labelledby="wb-danger-title">
        <div class="danger-zone-text">
          <h4 id="wb-danger-title">恢复全部默认</h4>
          <p>
            删除所有自建、导入的世界书（当前
            {{ removableBooks.length }} 本），并清除对内置书的修改。不可撤销。
          </p>
        </div>
        <AppButton variant="danger" size="sm" @click="resetWorldBooks">恢复全部默认…</AppButton>
      </div>
    </template>
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
/* 世界书工具栏: 编辑保护 + 操作按钮分行 */
.worldbook-toolbar {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  flex-shrink: 0;
}
.protection-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
}
.toggle-label-text {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--theme-text-secondary);
  white-space: nowrap;
}
.worldbook-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.worldbook-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.worldbook-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  transition: all 0.15s;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg, 12px);
}
.worldbook-card:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 25%, var(--theme-card-border));
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.wb-info {
  flex: 1;
  min-width: 0;
}
.wb-info h4 {
  font-size: 15px;
  margin: 0 0 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.new-book-row {
  margin-bottom: var(--theme-spacing-md);
  padding: var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
}
.new-book-controls {
  display: flex;
  gap: var(--theme-spacing-sm);
  align-items: center;
}
.new-book-controls .form-input {
  flex: 1;
}
.new-book-error {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.8rem;
  color: var(--theme-error);
}
/* 危险区：与常规操作隔开，error 色调描边 */
.danger-zone {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  margin-top: var(--theme-spacing-xl);
  padding: var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-error) 45%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-error) 6%, transparent);
}
.danger-zone h4 {
  margin: 0 0 4px;
  font-size: 0.95rem;
  color: var(--theme-error);
}
.danger-zone p {
  margin: 0;
  font-size: 0.8rem;
  color: var(--theme-text-secondary);
}
.builtin-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
  border: 1px solid color-mix(in srgb, var(--theme-success) 30%, transparent);
}
</style>
