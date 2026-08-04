<script setup lang="ts">
/**
 * 存档数据分区 —— 导出 / 导入 / 存储用量 / 清除全部（Q-25 从 SettingsPage.vue 抽出）
 *
 * 🔴 用量在**本分区挂载时**读一次，而不再是整页挂载时读一次。分区是 v-if 的，
 *    所以效果反而更准（每次点进来都是新数），代价是切走再切回会多问一次
 *    `navigator.storage.estimate()` —— 那是个便宜的浏览器查询。
 */
import { ref, onMounted } from 'vue';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useUIStore } from '../../stores/ui-store';

const cfg = useSettingsStore();
const ui = useUIStore();

const showClearConfirm = ref(false);
const storageInfo = ref<{ used: number; quota: number; pct: number } | null>(null);
async function loadStorageUsage() {
  storageInfo.value = await cfg.getStorageUsage();
}
onMounted(loadStorageUsage);
function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
async function exportAll() {
  const { exportAllData } = await import('@engine/database');
  const d = await exportAllData();
  const b = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u;
  a.download = `fated-poem-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(u);
  ui.toast('导出成功', 'success');
}
async function importAll() {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = '.json';
  i.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const { importAllData } = await import('@engine/database');
      await importAllData(JSON.parse(await f.text()));
      await cfg.reloadApiEntries();
      ui.toast('导入成功', 'success');
      await loadStorageUsage();
    } catch {
      ui.toast('导入失败', 'error');
    }
  };
  i.click();
}
/**
 * 清除全部数据。
 *
 * 🔴 这里以前解构的是 `deleteDatabase` —— database.ts 从来没导出过这个名字，
 * 于是 `await deleteDatabase()` 必然 TypeError，抛在弹窗关闭与 toast **之前**：
 * 弹窗不关、没有提示、一个字节也没删，用户只看见"点了没反应"。`tsc` 拦不住它，
 * 因为项目的 typecheck 是裸 tsc，不解析 .vue 模板与 script setup 之外的类型流。
 * 真名是 `clearAllData()`（`db.delete()` 整库删除 + dbInstance 置空，含 assetMeta /
 * assetBlobs / audio* 全部表）。守护测试见 SettingsPage.engine-imports.test.ts。
 */
async function clearAll() {
  const { clearAllData } = await import('@engine/database');
  await clearAllData();
  cfg.resetAll();
  showClearConfirm.value = false;
  ui.toast('数据已清除，页面即将刷新', 'warning');
  setTimeout(() => location.reload(), 1500);
}
</script>

<template>
  <section class="section centered">
    <h3>存档数据管理</h3>
    <p class="section-desc">导出、导入或清除所有数据。建议定期导出备份。</p>
    <!--
    两处遗漏必须明说（素材设计 §4.5）: 存档导出是一份 JSON，字节类的库进不去，
    所以音频与素材都不在里面 —— 各自另有出口。写在分区正文里而不是 tooltip 里，
    是因为换设备时才发现"东西没跟过来"已经太晚了。
  -->
    <p class="data-note">
      存档导出/导入<strong>不包含音频库与素材库</strong> —— 两者是全局资源，不随存档走。
      它们各有出口：素材与上传的音频可在「素材」分区打包成 zip
      导出；「音频」分区的音乐文件夹本就把文件留在磁盘上。
      <span class="data-note-em">「清除所有数据」会一并删除这两个库。</span>
    </p>
    <div class="data-actions">
      <AppCard padding="md"
        ><h4>导出数据</h4>
        <p class="text-muted text-sm">
          将所有存档、角色、记忆、剧情导出为 JSON 文件（不含音频库与素材库）
        </p>
        <AppButton variant="secondary" size="sm" style="margin-top: 8px" @click="exportAll"
          >导出全部数据</AppButton
        ></AppCard
      ><AppCard padding="md"
        ><h4>导入数据</h4>
        <p class="text-muted text-sm">
          从 JSON 文件恢复数据，将合并到现有数据库（同样不含音频与素材）
        </p>
        <AppButton variant="secondary" size="sm" style="margin-top: 8px" @click="importAll"
          >导入数据</AppButton
        ></AppCard
      ><AppCard padding="md"
        ><h4>浏览器存储用量</h4>
        <div v-if="storageInfo">
          <div class="storage-bar-track">
            <div
              class="storage-bar-fill"
              :style="{ transform: 'scaleX(' + storageInfo.pct / 100 + ')' }"
            ></div>
          </div>
          <p class="text-sm" style="margin: 6px 0 0">
            {{ fmtBytes(storageInfo.used) }} / {{ fmtBytes(storageInfo.quota) }}（{{
              storageInfo.pct.toFixed(1)
            }}%）
          </p>
          <p class="text-xs text-muted">IndexedDB + localStorage</p>
        </div>
        <p v-else class="text-muted text-sm">获取中…</p></AppCard
      ><AppCard padding="md" class="data-danger"
        ><h4>清除所有数据</h4>
        <p class="text-muted text-sm">
          永久删除所有存档、角色、记忆、设置，以及上传的音频曲库与播放列表、素材库。不可撤销。
        </p>
        <AppButton
          variant="danger"
          size="sm"
          style="margin-top: 8px"
          @click="showClearConfirm = true"
          >清除所有数据</AppButton
        ></AppCard
      >
    </div>
    <AppModal
      :open="showClearConfirm"
      title="确认清除"
      size="sm"
      @update:open="showClearConfirm = $event"
      ><p>
        确定要删除所有数据吗？此操作<strong style="color: var(--theme-error)">不可撤销</strong>。
      </p>
      <p class="text-muted text-sm">
        包括存档、角色、记忆、剧情，以及<strong>上传的音频曲库与播放列表、素材库</strong>（音频与素材都不包含在存档导出中，删除后无法通过导入存档恢复）。
      </p>
      <template #footer
        ><AppButton variant="ghost" size="sm" @click="showClearConfirm = false">取消</AppButton
        ><AppButton variant="danger" size="sm" @click="clearAll">确认清除</AppButton></template
      ></AppModal
    >
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
/* Data */
/* 备份遗漏说明：正文档字号(0.8125rem)，语气与四张卡一致 —— 是告知，不是警告，
   所以不用 warning 色、不加边框，只把最后那句"会一并删除"提到正文色上 */
.data-note {
  margin: 0 0 var(--theme-spacing-lg);
  font-size: 0.8125rem;
  line-height: 1.7;
  color: var(--theme-text-muted);
}
.data-note strong {
  color: var(--theme-text-secondary);
  font-weight: 600;
}
.data-note-em {
  color: var(--theme-text-primary);
}
.data-actions {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.data-actions h4 {
  margin: 0 0 4px;
  font-size: 0.95rem;
}
.data-danger {
  border-color: color-mix(in srgb, var(--theme-error) 25%, transparent) !important;
  background: color-mix(in srgb, var(--theme-error) 3%, transparent);
}
.data-danger:hover {
  border-color: color-mix(in srgb, var(--theme-error) 45%, transparent) !important;
}
.storage-bar-track {
  height: 8px;
  border-radius: 4px;
  background: var(--theme-card-border);
  overflow: hidden;
}
.storage-bar-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--theme-quality-rare);
  width: 100%;
  transform-origin: left;
  transition: transform 0.5s ease;
}
/* 减少动态效果（design.md 检查清单）——
   整页那条 @media 里只有这一条属于本分区，另两条（分区切换 / 模板预览）留在壳层 */
@media (prefers-reduced-motion: reduce) {
  .storage-bar-fill {
    transition: none;
  }
}
</style>
