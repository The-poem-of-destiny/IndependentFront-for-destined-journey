<script setup lang="ts">
/**
 * 存档数据分区 —— 导出 / 导入 / 存储用量 / 清除全部（Q-25 从 SettingsPage.vue 抽出）
 *
 * 🔴 用量在**本分区挂载时**读一次，而不再是整页挂载时读一次。分区是 v-if 的，
 *    所以效果反而更准（每次点进来都是新数），代价是切走再切回会多问一次
 *    `navigator.storage.estimate()` —— 那是个便宜的浏览器查询。
 */
import { ref, shallowRef, computed, onMounted } from 'vue';
import type { SceneImageUsage } from '@engine/types-image';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import PackInstallConfirmModal from './PackInstallConfirmModal.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useUIStore } from '../../stores/ui-store';
import type { FullBackup } from '@engine/database';
import type { PackInstallPlan } from '@engine/types-content';
import type { PackUpgradeDiff } from '@engine/content-pack-plan';

const cfg = useSettingsStore();
const ui = useUIStore();

/** 内容态（内容包是否已装） */
const activeContent = ref<{ packId: string | null; packVersion: string | null }>({
  packId: null,
  packVersion: null,
});
const hasActivePack = computed(() => activeContent.value.packId !== null);
const activePackVersion = computed(() => activeContent.value.packVersion);

/** 挂载时读一次内容态（content-store 的 store 状态） */
onMounted(async () => {
  // void：用量与内容态互不依赖，不必串成一条链；失败已在 loadStorageUsage 内自吞，
  // 裸调会漏成 unhandled rejection（.vue 不在类型感知 lint 档内，闸门看不见）
  void loadStorageUsage();
  const { useContentStore } = await import('../../stores/content-store');
  const c = useContentStore();
  await c.hydratePackState();
  activeContent.value = { packId: c.activePackId, packVersion: c.activePackVersion };
});

// ═══════════ 内容包导入（波 1 T7 / D19 / §5.2）═══════════

/**
 * 内容包导入入口：文件 picker（.json）→ installPack → 有 conflicted 弹两阶段确认；
 * 无冲突直接装。
 *
 * 🔴 两阶段提交（D19）：installPack 在无 `confirmConflicts` 时遇 conflicted 返回
 * `needs_confirmation`（带完整 plan），这里把 plan 塞给
 * `PackInstallConfirmModal`，用户确认后以 `{ confirmConflicts: true }` 重入。
 */
const packPlan = ref<PackInstallPlan | null>(null);
// 🔴 shallowRef：pack 是纯数据，绝不能进响应式系统——ref 深代理会让确认重入时
//    取回 Proxy，savePreset 落库 IDB 结构化克隆拒绝 Proxy → DataCloneError
//    （2026-08-07 真机根因；savePreset 侧已加 detach 双保险）。
const packPending = shallowRef<unknown | null>(null); // 待确认的原始 pack JSON
const packDiff = ref<PackUpgradeDiff | null>(null);
const packError = ref<string | null>(null);
const packInstalling = ref(false);

async function pickPackFile() {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = '.json';
  i.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await f.text());
    } catch {
      ui.toast('内容包格式无效：JSON 解析失败', 'error');
      return;
    }
    await runInstall(raw);
  };
  i.click();
}

/** 执行安装（第一段：无冲突直接装；有冲突弹确认）。已装同 packId → 走升级路径（显示 diff） */
async function runInstall(raw: unknown) {
  packError.value = null;
  packDiff.value = null;
  packInstalling.value = true;
  try {
    const { useContentStore } = await import('../../stores/content-store');
    const c = useContentStore();
    const packId = (raw as { packId?: string } | null)?.packId ?? '';
    // 已是同 packId → 升级路径（diff 展示）；否则首次安装
    if (activeContent.value.packId === packId) {
      await runUpgradeRaw(c, raw);
      return;
    }
    const outcome = await c.installPack(raw);
    if (!outcome.ok) {
      if (outcome.status === 'needs_confirmation') {
        packPlan.value = outcome.plan ?? null;
        packPending.value = raw;
        packDiff.value = outcome.upgradeDiff ?? null;
      } else if (outcome.status === 'invalid') {
        packError.value =
          (outcome.validationErrors ?? []).map((e: any) => e.text ?? String(e)).join('\n') ||
          '内容包校验未通过';
        ui.toast('内容包校验未通过', 'error');
      }
      return;
    }
    await afterPackApplied(outcome.notes ?? []);
    ui.toast('内容包已安装', 'success');
  } catch (err) {
    // 🔴 安装异常必须留痕：此前空 catch 吞掉全部错误，只弹 toast、控制台零输出，
    //    失败原因无从排查（2026-08-07 真机：导入 pack 报「安装失败」但无任何日志）。
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[content-pack] 内容包安装失败:', err);
    packError.value = msg || '内容包安装失败（无错误信息）';
    ui.toast('内容包安装失败', 'error');
  } finally {
    packInstalling.value = false;
  }
}

/** 升级路径：查 diff → 展示 → 有冲突/变化则弹确认；无冲突直接装 */
async function runUpgradeRaw(
  store: {
    upgradePack: (
      raw: unknown,
      opts?: { confirmConflicts?: boolean },
    ) => Promise<{
      ok: boolean;
      status: string;
      plan?: unknown;
      upgradeDiff?: unknown;
      notes?: unknown[];
    }>;
  },
  raw: unknown,
): Promise<void> {
  const outcome = await store.upgradePack(raw);
  if (!outcome.ok && outcome.status === 'needs_confirmation') {
    packPlan.value = (outcome.plan as PackInstallPlan | null) ?? null;
    packPending.value = raw;
    packDiff.value = (outcome.upgradeDiff as PackUpgradeDiff | null) ?? null;
    return;
  }
  if (outcome.ok) {
    await afterPackApplied(outcome.notes ?? []);
    ui.toast('内容包已升级', 'success');
  } else if (outcome.status === 'invalid') {
    packError.value =
      ((outcome as { validationErrors?: unknown[] }).validationErrors ?? [])
        .map((e: any) => e.text ?? String(e))
        .join('\n') || '内容包校验未通过';
    ui.toast('内容包校验未通过', 'error');
  }
}

/** 用户在确认 Modal 点「确认」→ 以 confirmConflicts 重入 */
async function confirmPackInstall() {
  if (!packPending.value) return;
  const raw = packPending.value;
  const wasUpgrade = activeContent.value.packId === ((raw as { packId?: string })?.packId ?? '');
  packPending.value = null;
  packPlan.value = null;
  packDiff.value = null;
  packInstalling.value = true;
  try {
    const { useContentStore } = await import('../../stores/content-store');
    const c = useContentStore();
    const outcome = await (wasUpgrade
      ? c.upgradePack(raw, { confirmConflicts: true })
      : c.installPack(raw, { confirmConflicts: true }));
    if (!outcome.ok) {
      ui.toast('内容包安装失败', 'error');
      return;
    }
    await afterPackApplied(outcome.notes ?? []);
    ui.toast(wasUpgrade ? '内容包已升级' : '内容包已安装', 'success');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[content-pack] 内容包安装失败（确认重入）:', err);
    packError.value = msg || '内容包安装失败（无错误信息）';
    ui.toast('内容包安装失败', 'error');
  } finally {
    packInstalling.value = false;
  }
}

/** 装/卸/升后统一收尾：重载 Agent 默认 + 刷新内容态 */
async function afterPackApplied(notes: unknown[]): Promise<void> {
  showSuccessNotes(notes, null);
  await cfg.loadAgentProjectDefaults();
  const { useContentStore } = await import('../../stores/content-store');
  const c = useContentStore();
  await c.hydratePackState();
  activeContent.value = { packId: c.activePackId, packVersion: c.activePackVersion };
}

/** 卸载（带确认；编辑过的书需二次确认） */
async function requestUninstall() {
  const { useContentStore } = await import('../../stores/content-store');
  const c = useContentStore();
  const outcome = await c.uninstallPack();
  if (!outcome.ok && outcome.status === 'needs_confirmation') {
    // 有编辑过的书，弹 confirm
    if (
      window.confirm(
        `有 ${outcome.plan?.confirmations.length ?? 0} 本内容包世界书被编辑过，卸载会丢弃这些修改。确定卸载吗？`,
      )
    ) {
      const done = await c.uninstallPack({ confirmEdits: true });
      if (done.ok) {
        ui.toast('内容包已卸载', 'success');
        await cfg.loadAgentProjectDefaults();
      } else ui.toast('卸载失败', 'error');
    }
    return;
  }
  if (outcome.ok) {
    ui.toast('内容包已卸载', 'success');
    await cfg.loadAgentProjectDefaults();
  } else if (outcome.status === 'busy') {
    ui.toast('另一次内容包操作正在进行，请稍后再试', 'error');
  } else ui.toast('卸载失败', 'error');
}

/** 安装结果的三类处置记录 toast（dropped/degraded/sideEffect） */
function showSuccessNotes(notes: unknown[], _outcome: unknown): void {
  const dropped = notes.filter((n: any) => n?.kind === 'dropped');
  const degraded = notes.filter((n: any) => n?.kind === 'degraded');
  const side = notes.filter((n: any) => n?.kind === 'sideEffect');
  if (dropped.length || degraded.length || side.length) {
    const parts: string[] = [];
    if (dropped.length) parts.push(`${dropped.length} 项丢弃`);
    if (degraded.length) parts.push(`${degraded.length} 项降级`);
    if (side.length) parts.push(`${side.length} 项附带影响`);
    ui.toast(`内容包已处理，注意：${parts.join('、')}`, 'warning');
  }
}

const showClearConfirm = ref(false);
const storageInfo = ref<{ used: number; quota: number; pct: number } | null>(null);
async function loadStorageUsage() {
  try {
    storageInfo.value = await cfg.getStorageUsage();
  } catch (err) {
    // 隐私模式 / 浏览器不给 storage.estimate：读不出用量而已，本分区其余功能照常，
    // 不值得弹 toast 打断用户；留一条控制台记录便于排查（此前是静默 unhandled rejection）
    console.warn('[data] 读取存储用量失败:', err);
    storageInfo.value = null;
  }
}
function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

/**
 * 本存档插画用量与清理（图像生成设计 §7.5 / D47）。
 *
 * 🔴 为什么这一行在**存档数据**分区而不是图像分区：用量是**每存档**的数字，而图像
 * 分区整个存的是全局 `UiSettings`。把「本存档 20 MB」摆在一屏全局设置里会被读成
 * 「总共 20 MB」。这里本来就有 saveId 上下文（`ui.activeSaveId`）。
 *
 * 🔴 「清理」= 删字节、**留记录**：插画条目、标题说明与提示词一条不动，图鉴里那一格
 * 变成「字节已清理 + 重画」而不是消失。确认文案必须把这件事说清楚 —— 用户以为自己
 * 在删回忆，和用户以为自己只是腾空间，是两种完全不同的心情。
 */
const sceneUsage = ref<SceneImageUsage | null>(null);
const showImageCleanConfirm = ref(false);
const cleaningImages = ref(false);
/** 收藏的那些不在清理范围内（D6 的豁免位），所以「可清理」要把它们减掉 */
const cleanableCount = computed(() =>
  sceneUsage.value ? sceneUsage.value.storedCount - sceneUsage.value.favoriteCount : 0,
);
const cleanableBytes = computed(() =>
  sceneUsage.value ? sceneUsage.value.storedBytes - sceneUsage.value.favoriteBytes : 0,
);
/** 记录还在、字节已经没了的那些 —— 图鉴里显示成「可重画」的格子 */
const droppedCount = computed(() =>
  sceneUsage.value ? sceneUsage.value.records - sceneUsage.value.storedCount : 0,
);
async function loadSceneUsage() {
  const saveId = ui.activeSaveId;
  // 没有活跃存档时不去查（查了也只会得到别人存档的 0），照实显示"未载入存档"
  if (!saveId) {
    sceneUsage.value = null;
    return;
  }
  const { getSceneImageUsage } = await import('@engine/database');
  sceneUsage.value = await getSceneImageUsage(saveId);
}
onMounted(loadSceneUsage);
async function cleanSceneImages() {
  const saveId = ui.activeSaveId;
  if (!saveId) return;
  cleaningImages.value = true;
  try {
    const { listCleanableSceneImageIds, dropSceneImageBlobs } = await import('@engine/database');
    // 名单在**点下确认这一刻**重新取：面板可能已经开着好一会儿了
    const ids = await listCleanableSceneImageIds(saveId);
    const dropped = await dropSceneImageBlobs(ids);
    ui.toast(`已清理 ${dropped} 张插画的图片文件，条目与提示词都还在`, 'success');
  } catch {
    ui.toast('清理失败', 'error');
  } finally {
    cleaningImages.value = false;
    showImageCleanConfirm.value = false;
    await loadSceneUsage();
    await loadStorageUsage();
  }
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
/**
 * 整库导入 —— 选好文件**先确认再执行**。
 *
 * 🔴 这一步不是仪式感：这个按钮做的是**替换**而不是追加，点下去之前用户看到的
 *    只有「导入数据」四个字。确认弹窗是唯一说清后果的地方。
 * 🔴 待确认的文件放 shallowRef：内容包那条路踩过 Proxy 进 IndexedDB 的雷（见上方注释）。
 */
const showImportConfirm = ref(false);
const pendingImportFile = shallowRef<File | null>(null);

function importAll() {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = '.json';
  i.onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    pendingImportFile.value = f;
    showImportConfirm.value = true;
  };
  i.click();
}

async function confirmImportAll() {
  const f = pendingImportFile.value;
  showImportConfirm.value = false;
  pendingImportFile.value = null;
  if (!f) return;
  try {
    const raw: unknown = JSON.parse(await f.text());
    // 🔴 进 importAllData 之前必须先认形状：validateBackupOrThrow 对「实体数组全缺席」
    //    是容忍的（三态语义，为老备份留的），于是一份只带 `version` 的角色卡 / 预设 JSON
    //    能一路走到 doImportAllData 把整个库清空。判据用引擎那份严格的，不在这里另写一个。
    const { isFullBackupFile } = await import('@engine/session-backup');
    if (!isFullBackupFile(raw)) {
      ui.toast('导入失败：这个文件看起来不是整库备份', 'error');
      return;
    }
    const { importAllData } = await import('@engine/database');
    await importAllData(raw as FullBackup);
    await cfg.reloadApiEntries();
    ui.toast('导入成功', 'success');
    await loadStorageUsage();
  } catch (err) {
    // 真实错误必须说出来：此前空 catch 只弹一句「导入失败」，
    // 校验拒绝 / JSON 坏了 / 事务回滚三种情况长得一模一样，无从排查。
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[data] 整库导入失败:', err);
    ui.toast(`导入失败：${msg}`, 'error');
  }
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
    <!--
    内容-引擎分离波 1 / D18：存档备份同样不含**内容包本体**（contentPacks.payload）——
    payload 进备份 = 每份日常备份都是可自由转发的完整内容包 + 体积翻倍。恢复后引擎会自动
    对账（reconcilePackState）：内容包拥有的世界书 / 预设若在恢复中缺失或被替换，会在内容
    状态横幅提示需要处理，给你「本地重放 / 卸载回占位」二选，不会自动改你的东西。
  -->
    <p class="data-note">
      存档导出<strong>不含内容包本体</strong> ——
      恢复后若发现内容包拥有的世界书或预设与本地不一致，会在内容状态处提示，可一键从本地内容包重放。
    </p>
    <div class="data-actions">
      <AppCard padding="md"
        ><h4>导出数据</h4>
        <p class="text-muted text-sm">
          将所有存档、角色、记忆、剧情导出为 JSON 文件（不含音频库与素材库）
        </p>
        <AppButton variant="secondary" size="sm" class="card-action" @click="exportAll"
          >导出全部数据</AppButton
        ></AppCard
      ><AppCard padding="md"
        ><h4>导入数据</h4>
        <p class="text-muted text-sm">
          从 JSON 文件恢复数据，将合并到现有数据库（同样不含音频与素材）
        </p>
        <AppButton variant="secondary" size="sm" class="card-action" @click="importAll"
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
      ><AppCard padding="md"
        ><h4>本存档插画</h4>
        <!-- 一张都没有时照常显示「0 张 / 0 B」，不把这一行藏起来 ——
             它同时在回答"我这存档到底有没有在攒图" -->
        <div v-if="sceneUsage">
          <p class="text-sm" style="margin: 0">
            {{ sceneUsage.storedCount }} 张 / {{ fmtBytes(sceneUsage.storedBytes) }}
          </p>
          <p class="text-xs text-muted" style="margin: 4px 0 0">
            共 {{ sceneUsage.records }} 条插画记录<template v-if="droppedCount > 0"
              >，其中 {{ droppedCount }} 条的图片文件已清理（配方还在，可重画）</template
            ><template v-if="sceneUsage.favoriteCount > 0"
              >；收藏的 {{ sceneUsage.favoriteCount }} 张不会被清理</template
            >
          </p>
          <AppButton
            variant="secondary"
            size="sm"
            class="card-action"
            :disabled="cleanableCount === 0"
            @click="showImageCleanConfirm = true"
            >清理图片文件</AppButton
          >
        </div>
        <p v-else class="text-muted text-sm">
          未载入存档 —— 插画用量按存档统计，进入游戏后可在此查看与清理。
        </p></AppCard
      ><AppCard padding="md" class="data-danger"
        ><h4>清除所有数据</h4>
        <p class="text-muted text-sm">
          永久删除所有存档、角色、记忆、设置，以及上传的音频曲库与播放列表、素材库。不可撤销。
        </p>
        <AppButton variant="danger" size="sm" class="card-action" @click="showClearConfirm = true"
          >清除所有数据</AppButton
        ></AppCard
      ><AppCard padding="md" class="pack-card"
        ><h4>内容包</h4>
        <p class="text-muted text-sm">
          导入《命定之诗》内容包以加载完整的世界书、Agent 提示词、预设与目录数据。<template
            v-if="activePackVersion"
            >当前：{{ activePackVersion }}。</template
          >未装包时运行在演示级占位内容上。
        </p>
        <div class="pack-actions">
          <AppButton
            variant="secondary"
            size="sm"
            class="card-action"
            :loading="packInstalling"
            @click="pickPackFile"
            >导入 / 升级内容包</AppButton
          >
          <AppButton
            v-if="hasActivePack"
            variant="ghost"
            size="sm"
            class="card-action"
            :disabled="packInstalling"
            @click="requestUninstall"
            >卸载内容包</AppButton
          >
        </div>
      </AppCard>
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
    <!--
      整库导入确认：这个动作是**替换**不是合并，点之前必须先说清楚。
    -->
    <AppModal
      :open="showImportConfirm"
      title="确认导入"
      size="sm"
      @update:open="
        (v: boolean) => {
          if (!v) {
            showImportConfirm = false;
            pendingImportFile = null;
          }
        }
      "
      ><p>
        整库导入会用备份文件<strong style="color: var(--theme-error)">替换全部现有数据</strong
        >，包括所有存档、角色、记忆、剧情与世界书。
      </p>
      <p class="text-muted text-sm">
        当前数据将被覆盖且不可撤销（音频库与素材库不在备份范围内，不受影响）。建议先「导出全部数据」留一份备份。
      </p>
      <template #footer
        ><AppButton
          variant="ghost"
          size="sm"
          @click="
            showImportConfirm = false;
            pendingImportFile = null;
          "
          >取消</AppButton
        ><AppButton variant="danger" size="sm" @click="confirmImportAll"
          >替换全部数据并导入</AppButton
        ></template
      ></AppModal
    >
    <!--
      清理插画字节的确认（D47）。三句话缺一不可：
        ① 清掉的**只是图片文件** —— 条目/标题说明/提示词都留着，图鉴里那一格变成
           「字节已清理 + 重画」，不是消失；
        ② **不可撤销** —— 字节没了就得重新生成，而生成是花钱的；
        ③ 收藏的不动。
      少了 ① 用户会以为在删回忆而不敢点，少了 ② 用户会以为随手可恢复而乱点。
    -->
    <AppModal
      :open="showImageCleanConfirm"
      title="确认清理插画图片"
      size="sm"
      @update:open="showImageCleanConfirm = $event"
      ><p>
        将清理本存档 <strong>{{ cleanableCount }}</strong> 张插画的图片文件，释放约
        <strong>{{ fmtBytes(cleanableBytes) }}</strong
        >。
      </p>
      <p class="text-muted text-sm">
        清掉的只是<strong>图片文件本身</strong>：插画条目、标题说明与提示词全部保留，图鉴里仍会列出它们，随时可以按原配方<strong>重画</strong>。<template
          v-if="sceneUsage && sceneUsage.favoriteCount > 0"
          >收藏的 {{ sceneUsage.favoriteCount }} 张不在清理范围内。</template
        >
      </p>
      <p class="text-muted text-sm">
        但此操作<strong style="color: var(--theme-error)">不可撤销</strong> ——
        已清理的图片只能重新生成，会再次消耗生成额度。
      </p>
      <template #footer
        ><AppButton variant="ghost" size="sm" @click="showImageCleanConfirm = false">取消</AppButton
        ><AppButton variant="danger" size="sm" :loading="cleaningImages" @click="cleanSceneImages"
          >确认清理</AppButton
        ></template
      ></AppModal
    >
    <!--
      内容包安装/升级的两阶段确认（波 1 T7 / D19 / §5.2）：
      plan 非空时展示，确认后 confirmPackInstall 以 confirmConflicts:true 重入 installPack。
    -->
    <PackInstallConfirmModal
      :open="!!(packPlan || packError)"
      :plan="packPlan"
      :upgrade-diff="packDiff"
      :error-message="packError"
      @update:open="
        (v: boolean) => {
          if (!v) {
            packPlan = null;
            packError = null;
            packPending = null;
          }
        }
      "
      @confirm="confirmPackInstall"
      @cancel="
        packPlan = null;
        packError = null;
        packPending = null;
      "
    />
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
/* 内容包卡片的按钮行（导入 + 卸载并排） */
.pack-card {
  border-color: color-mix(in srgb, var(--theme-quality-rare) 25%, transparent) !important;
}
.pack-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
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
