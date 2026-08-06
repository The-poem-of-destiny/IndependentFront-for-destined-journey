<script setup lang="ts">
/**
 * 世界书分区 —— 列表 / 导入 / 新建 / 删除 / 单本恢复 / 全部恢复 + 条目编辑器
 * （Q-25 从 SettingsPage.vue 抽出）
 *
 * 📌 Agent 配置里那份"这个 Agent 能看哪几本"的勾选列表**不在这里** —— 它是
 *    per-Agent 设置，仍住在 SettingsPage 的 Agent 分区。两处都读同一个
 *    worldbook-store，那是 Phase 0 定的唯一入口，不是重复。
 */
import { ref } from 'vue';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import WorldBookEditor from './WorldBookEditor.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useUIStore } from '../../stores/ui-store';
import { useWorldBookStore } from '../../stores/worldbook-store';
import type { WorldBook } from '@engine/types';

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
  if (!confirm(`确定将"${book.name}"恢复为默认吗？\n\n您对该书的所有修改将被清除。`)) return;
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

async function importWorldBook() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      const book: WorldBook = {
        id: f.name.replace(/\.json$/i, ''),
        name: raw.name || f.name.replace(/\.json$/i, ''),
        partition: 'world_setting',
        description: raw.description || '',
        entries: Array.isArray(raw.entries)
          ? raw.entries.map((e: any) => ({
              uid: e.uid || Date.now(),
              name: e.name || e.comment || '',
              content: e.content || '',
              enabled: e.enabled !== false,
              constant: e.constant || false,
              key: e.key || [],
              keysecondary: e.keysecondary || [],
              selectiveLogic: e.selectiveLogic ?? 0,
              order: e.order ?? 100,
              position: e.position ?? 0,
            }))
          : [],
      };
      await wb.upsertBook(book);
      ui.toast(`已导入 "${book.name}" (${book.entries.length} 条目)`, 'success');
    } catch {
      ui.toast('导入失败：文件格式错误', 'error');
    }
  };
  input.click();
}

async function newWorldBook() {
  const name = prompt('世界书名称：');
  if (!name) return;
  const id = name.toLowerCase().replace(/\s+/g, '_');
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
  activeWorldBook.value = wb.getBook(id) ?? book;
  ui.toast(`已创建 "${name}"`, 'success');
}

async function deleteWorldBook(id: string) {
  const book = wb.getBook(id);
  if (!book) return;
  if (
    !confirm(
      `确定删除世界书"${book.name}"吗？将删除全部 ${book.entries?.length || 0} 条条目，此操作不可撤销。`,
    )
  )
    return;
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

async function resetWorldBooks() {
  if (
    !confirm(
      '确定恢复所有世界书为默认吗？\n\n这将清除所有修改和导入的世界书，重新加载内置版本。此操作不可撤销。',
    )
  )
    return;
  try {
    await cfg.resetWorldBooksToDefaults();
    activeWorldBook.value = null;
    ui.toast('世界书已恢复为默认', 'success');
  } catch {
    ui.toast('恢复失败，请检查 data/worldbooks/ 目录', 'error');
  }
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
            <AppButton
              variant="ghost"
              size="sm"
              style="color: var(--color-warning)"
              @click="resetWorldBooks"
              >⟳ 恢复默认</AppButton
            >
          </div>
        </div>
      </div>

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
