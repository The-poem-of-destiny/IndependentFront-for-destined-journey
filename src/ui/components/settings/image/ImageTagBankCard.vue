<script setup lang="ts">
/**
 * 第四张卡：**标签词库** —— 导入 ST 世界书格式的中文→danbooru 映射（图像 v1.4）。
 *
 * 检索模型是 **AI 看目录 → 调工具取标签 → 自己组装**（用户裁定，2026-08-05）：
 * 词库有几千条，装不进一次提示词，所以 system 消息里只放**名字目录**，标签本体由
 * `get_image_tags` / `search_image_tags` 现取。
 *
 * 这张卡必须说清楚三件事，缺一件用户就会在账单或空白上撞墙：
 *
 * 1. 🔴 **导入报告不能只报成功数**。几千条手写语料里一定有读不懂的写法，
 *    转换器把它们收进 `plan.notes` 而不是抛错。这里如实分四类列出来（跳过 / 修过 /
 *    存疑 / 重名）—— 只说「导入 2841 条」会让用户以为整本都进来了。
 *
 * 2. 🔴 **目录字符数要摆在明面上**。目录每张图都发一遍，几千条就是几万字符。
 *    它逐字节稳定因而能命中 prompt cache，但那是**折扣不是免费**。把数字显示出来，
 *    用户才有依据决定要不要停用其中一本。
 *
 * 3. 🔴 **检索预览用的是真函数**（`searchTagEntries`），不是另写一套模糊匹配。
 *    预览的全部价值就在于「我看到的就是 AI 会看到的」；另写一份就成了安慰剂。
 */
import { computed, ref } from 'vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import { useImageTagBankStore } from '../../../stores/image-tag-bank-store';
import { useUIStore } from '../../../stores/ui-store';
import { searchTagEntries } from '@engine/image-tag-bank';
import { groupImportNotes } from './tag-bank-report';
import type { TagBankImportPlan } from '@engine/types-image';

const store = useImageTagBankStore();
const ui = useUIStore();

void store.init();

// ═══ 导入 ═══

const importing = ref(false);
const report = ref<{ bankName: string; plan: TagBankImportPlan } | null>(null);

async function pickFile(): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    importing.value = true;
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        // JSON 都没解析出来 —— 这与「格式认不出」是两回事，措辞要分开，
        // 否则用户会去改词库格式，而问题其实是文件坏了 / 选错了文件
        ui.toast('这个文件不是合法的 JSON，选错文件了？', 'error');
        return;
      }
      // 文件名去掉扩展名当默认书名 —— 用户一次导好几本时靠它区分
      const name = file.name.replace(/\.[^.]+$/, '');
      const result = await store.importFromJson(raw, name, file.name);
      if (!result.ok) {
        ui.toast(result.message, 'error');
        return;
      }
      report.value = { bankName: result.value.bank.name, plan: result.value.plan };
      ui.toast(`已导入 ${result.value.plan.stats.imported} 条标签`, 'success');
    } finally {
      importing.value = false;
    }
  };
  input.click();
}

/**
 * 报告里按类别分组的处置记录。
 *
 * 判定在 `tag-bank-report.ts`（纯函数）—— 它藏在文件选择器回调后面，留在组件里
 * **测不到**（jsdom 里没法真的选一个文件），那条「如实分类」的承诺就只剩注释在保证。
 */
const groupedNotes = computed(() => groupImportNotes(report.value?.plan.notes ?? []));

// ═══ 列表 ═══

async function toggle(id: string, enabled: boolean): Promise<void> {
  const r = await store.setEnabled(id, enabled);
  if (!r.ok) ui.toast(r.message, 'error');
}

async function remove(id: string, name: string): Promise<void> {
  if (!confirm(`确定删除词库「${name}」吗？此操作不可撤销。`)) return;
  const r = await store.remove(id);
  ui.toast(r.ok ? `已删除「${name}」` : r.message, r.ok ? 'success' : 'error');
  if (r.ok && report.value?.bankName === name) report.value = null;
}

async function renameBank(id: string, current: string): Promise<void> {
  const next = prompt('新的词库名', current);
  if (next === null) return;
  const r = await store.rename(id, next);
  if (!r.ok) ui.toast(r.message, 'error');
}

// ═══ 检索预览 ═══

const probe = ref('');
const probeHits = computed(() => {
  const q = probe.value.trim();
  if (q === '') return [];
  // 🔴 与 `search_image_tags` 工具**同一个函数** —— 预览的价值全在这里
  return searchTagEntries(store.enabledEntries, q, 8).hits;
});

const catalogueSummary = computed(() => {
  const chars = store.catalogueChars;
  if (chars === 0) return '';
  // 中文按每字符约 1 token 粗算，明说是粗算，不给一个假装精确的数
  return `目录约 ${chars.toLocaleString('en-US')} 字符，每次出图都会发一遍（内容固定，通常命中缓存）`;
});
</script>

<template>
  <AppCard padding="md">
    <div class="image-card-head">
      <h4>标签词库</h4>
      <p class="image-card-scope">
        导入 SillyTavern 世界书格式的<strong>中文→danbooru 标签</strong>对照表。出图时，
        写标签的那个 AI 会先看到一份<strong>只有名字的目录</strong>，再按需查出具体标签——
        于是几千条词条也能用，而不必一次塞进提示词。
      </p>
    </div>

    <div class="bank-actions">
      <AppButton variant="secondary" size="sm" :disabled="importing" @click="pickFile">
        {{ importing ? '导入中…' : '导入词库 JSON' }}
      </AppButton>
      <span v-if="catalogueSummary" class="bank-meta">{{ catalogueSummary }}</span>
    </div>

    <!-- ── 已导入的词库 ── -->
    <div v-if="store.banks.length > 0" class="bank-list">
      <div v-for="bank in store.banks" :key="bank.id" class="bank-row">
        <label class="bank-toggle">
          <input
            type="checkbox"
            :checked="bank.enabled"
            @change="toggle(bank.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="bank-name">{{ bank.name }}</span>
        </label>
        <span class="bank-count">{{ bank.entries.length }} 条</span>
        <span class="bank-buttons">
          <AppButton variant="ghost" size="sm" @click="renameBank(bank.id, bank.name)">
            改名
          </AppButton>
          <AppButton variant="ghost" size="sm" @click="remove(bank.id, bank.name)">删除</AppButton>
        </span>
      </div>
    </div>
    <p v-else class="bank-empty">
      还没有词库。没有也能出图——那时写标签的 AI 全凭自己的英文词汇， 画面风格会更飘一些。
    </p>

    <!-- ── 导入报告 ── -->
    <div v-if="report" class="bank-report">
      <h5>「{{ report.bankName }}」导入报告</h5>
      <p class="bank-report-line">
        文件里 {{ report.plan.stats.total }} 条，进库
        <strong>{{ report.plan.stats.imported }}</strong> 条，跳过
        {{ report.plan.stats.skipped }} 条。
      </p>

      <p v-if="report.plan.stats.categories.length > 0" class="bank-report-line">
        分类：
        <span v-for="c in report.plan.stats.categories" :key="c.category" class="bank-cat">
          {{ c.category }} {{ c.count }}
        </span>
      </p>

      <div v-for="group in groupedNotes" :key="group.kind" class="bank-notes">
        <div class="bank-notes-head">{{ group.label }} · {{ group.total }} 条</div>
        <ul>
          <li v-for="(note, i) in group.shown" :key="i">
            <code>{{ note.label }}</code> — {{ note.text }}
          </li>
          <li v-if="group.total > group.shown.length" class="bank-notes-more">
            …另有 {{ group.total - group.shown.length }} 条同类
          </li>
        </ul>
      </div>
    </div>

    <!-- ── 检索预览 ── -->
    <div v-if="store.enabledEntries.length > 0" class="bank-probe">
      <label class="bank-probe-label" for="tag-bank-probe">
        试一个场景词——看看 AI 查这个词时会拿到什么
      </label>
      <input
        id="tag-bank-probe"
        v-model="probe"
        class="form-input"
        type="text"
        placeholder="例如：温泉 / 猫耳 / 雨天"
      />
      <ul v-if="probeHits.length > 0" class="bank-probe-hits">
        <li v-for="hit in probeHits" :key="hit.category + hit.name">
          <span class="bank-probe-name">[{{ hit.category }}] {{ hit.name }}</span>
          <span class="bank-probe-tags">{{ hit.tags }}</span>
        </li>
      </ul>
      <p v-else-if="probe.trim() !== ''" class="bank-probe-empty">
        词库里没有匹配的条目——真出图时 AI 会自己写这部分标签。
      </p>
    </div>
  </AppCard>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.image-card-head {
  margin-bottom: var(--theme-spacing-lg);
}
.image-card-head h4 {
  margin: 0 0 var(--theme-spacing-sm);
}
.image-card-scope {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.7;
  color: var(--theme-text-secondary);
}

.bank-actions {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
  margin-bottom: var(--theme-spacing-lg);
}
.bank-meta {
  font-size: 0.8rem;
  color: var(--theme-text-muted);
}

.bank-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-lg);
}
.bank-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-border);
  border-radius: var(--theme-radius-md);
}
.bank-toggle {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.bank-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bank-count {
  font-size: 0.8rem;
  color: var(--theme-text-muted);
  white-space: nowrap;
}
.bank-buttons {
  display: flex;
  gap: var(--theme-spacing-xs);
}
.bank-empty {
  margin: 0 0 var(--theme-spacing-lg);
  font-size: 0.85rem;
  line-height: 1.7;
  color: var(--theme-text-muted);
}

.bank-report {
  padding: var(--theme-spacing-md);
  margin-bottom: var(--theme-spacing-lg);
  border: 1px solid var(--theme-border);
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-text-muted) 6%, transparent);
}
.bank-report h5 {
  margin: 0 0 var(--theme-spacing-sm);
  font-size: 0.9rem;
}
.bank-report-line {
  margin: 0 0 var(--theme-spacing-sm);
  font-size: 0.85rem;
  color: var(--theme-text-secondary);
}
.bank-cat {
  display: inline-block;
  margin-right: var(--theme-spacing-sm);
  font-size: 0.8rem;
  color: var(--theme-text-muted);
}
.bank-notes {
  margin-top: var(--theme-spacing-md);
}
.bank-notes-head {
  font-size: 0.82rem;
  color: var(--theme-text-secondary);
  margin-bottom: 4px;
}
.bank-notes ul {
  margin: 0;
  padding-left: 1.2em;
}
.bank-notes li {
  font-size: 0.8rem;
  line-height: 1.7;
  color: var(--theme-text-muted);
}
.bank-notes-more {
  font-style: italic;
}

.bank-probe {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.bank-probe-label {
  font-size: 0.85rem;
  color: var(--theme-text-secondary);
}
.bank-probe-hits {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bank-probe-hits li {
  display: flex;
  gap: var(--theme-spacing-md);
  font-size: 0.8rem;
  line-height: 1.6;
}
.bank-probe-name {
  flex: 0 0 auto;
  color: var(--theme-text-secondary);
}
.bank-probe-tags {
  color: var(--theme-text-muted);
  word-break: break-word;
}
.bank-probe-empty {
  margin: 0;
  font-size: 0.8rem;
  color: var(--theme-text-muted);
}
</style>
