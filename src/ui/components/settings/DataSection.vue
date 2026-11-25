<script setup lang="ts">
/**
 * 数据与备份分区 —— 导出 / 导入 / 存储用量 / 清除全部（Q-25 从 SettingsPage.vue 抽出）
 *
 * 🔴 用量在**本分区挂载时**读一次，而不再是整页挂载时读一次。分区是 v-if 的，
 *    所以效果反而更准（每次点进来都是新数），代价是切走再切回会多问一次
 *    `navigator.storage.estimate()` —— 那是个便宜的浏览器查询。
 *
 * 📌 2026-11-14（S-01）：内容包卡已搬到独立的「内容包」分区（ContentPackSection），
 *    这里只留一行指路；「清除所有数据」挪到分区底部单独的危险区，不再与日常卡片同网格。
 */
import { ref, shallowRef, computed, onMounted } from 'vue';
import type { SceneImageUsage } from '@engine/types/types-image';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import FormSelect from '../shared/form/FormSelect.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useUIStore } from '../../stores/ui-store';
import { useGameStore } from '../../stores/game-store';
import type { FullBackup } from '@engine/persistence/database';
import {
  CLEAR_ALL_LOCKED_MESSAGE,
  FULL_IMPORT_LOCKED_MESSAGE,
  findSavesLockedElsewhere,
} from '../../lib/save-tab-lock';
// 经验档位读取（loadExperienceMode）走静态导入：与 loadSceneUsage 的动态 import 并存时，
// Vitest 的 vi.mock 对同一模块的多次动态 import 有竞态（挂起到环境拆除、dexie 加载失败），
// 静态 import 由 vi.mock 稳定拦截，规避之（2026-08-24）。
import { getSaveProfile } from '@engine/persistence/database';

const cfg = useSettingsStore();
const ui = useUIStore();
const game = useGameStore();

onMounted(() => {
  // void：用量与经验档位互不依赖，不必串成一条链；失败已在各自函数内自吞，
  // 裸调会漏成 unhandled rejection（.vue 不在类型感知 lint 档内，闸门看不见）
  void loadStorageUsage();
  void loadExperienceMode();
});

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

// ═══════════ 经验档位（简单/普通模式，2026-08-24）═══════════
// 当前存档的 experienceMode 下拉 + 命名写入口切换（persistExperienceMode，照 persistFocusQuest
// 的 withSaveWriteLock 锁内重读窄改模式）。为什么在数据与备份分区：它是**每存档**的设置，
// 与插画用量同一逻辑（图像生成设计 §7.5 / D47 同款理由），放这里找得到。
const experienceMode = ref<'normal' | 'easy'>('normal');

/**
 * 按存档生效的卡片标明作用对象（UIL-20）：「经验档位」「本存档插画」都写到 ui.activeSaveId，
 * 不写名字的话用户分不清改的是哪一个存档。
 */
const activeSaveLabel = computed(() => ui.activeSaveName ?? '当前存档');

/** 读当前存档的经验档位（旧档缺字段兜底 normal） */
async function loadExperienceMode() {
  const saveId = ui.activeSaveId;
  if (!saveId) {
    experienceMode.value = 'normal';
    return;
  }
  try {
    const profile = await getSaveProfile(saveId);
    experienceMode.value = profile?.experienceMode === 'easy' ? 'easy' : 'normal';
  } catch {
    experienceMode.value = 'normal';
  }
}

/** 切换当前存档经验档位 —— 走命名写入口；成功后轻量回读 game-store（战斗分档立即生效） */
async function changeExperienceMode(mode: 'normal' | 'easy') {
  const saveId = ui.activeSaveId;
  if (!saveId) return;
  const next = mode === 'easy' ? 'easy' : 'normal';
  try {
    const { persistExperienceMode } = await import('@engine/state/save-profile');
    await persistExperienceMode(saveId, next);
    experienceMode.value = next;
    ui.toast(next === 'easy' ? '已切换为简单模式（经验获取更快）' : '已切换为普通模式', 'success');
    // 🔴 同步 game-store 的 saveProfile 内存：战斗经验分档读 game.experienceMode，
    //    不刷新的话下一次战斗仍用旧档。失败不致命（下次 loadSave/refreshFromDb 会补上）。
    try {
      await game.refreshFromDb();
    } catch {
      /* 回读失败仅影响本次会话内的分档，存档已正确落库 */
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[data] 切换经验档位失败:', err);
    ui.toast(`切换经验档位失败：${msg}`, 'error');
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
 * 🔴 为什么这一行在**数据与备份**分区而不是图像分区：用量是**每存档**的数字，而图像
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
  const { getSceneImageUsage } = await import('@engine/persistence/database');
  sceneUsage.value = await getSceneImageUsage(saveId);
}
onMounted(loadSceneUsage);
async function cleanSceneImages() {
  const saveId = ui.activeSaveId;
  if (!saveId) return;
  cleaningImages.value = true;
  try {
    const { listCleanableSceneImageIds, dropSceneImageBlobs } =
      await import('@engine/persistence/database');
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
  const { exportAllData } = await import('@engine/persistence/database');
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
    const { isFullBackupFile } = await import('@engine/persistence/session-backup');
    if (!isFullBackupFile(raw)) {
      ui.toast('导入失败：这个文件看起来不是整库备份', 'error');
      return;
    }
    // 标签页锁（R8）：整库导入会覆盖所有存档，别的标签页在玩任一存档时拒绝
    if ((await findSavesLockedElsewhere()).length > 0) {
      ui.toast(FULL_IMPORT_LOCKED_MESSAGE, 'warning', 6000);
      return;
    }
    const { importAllData } = await import('@engine/persistence/database');
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
  // 标签页锁（R8）：清库会删掉所有存档，别的标签页在玩任一存档时拒绝；本标签页自持的不拦
  if ((await findSavesLockedElsewhere()).length > 0) {
    showClearConfirm.value = false;
    ui.toast(CLEAR_ALL_LOCKED_MESSAGE, 'warning', 6000);
    return;
  }
  const { clearAllData } = await import('@engine/persistence/database');
  await clearAllData();
  cfg.resetAll();
  showClearConfirm.value = false;
  ui.toast('数据已清除，页面即将刷新', 'warning');
  setTimeout(() => location.reload(), 1500);
}
</script>

<template>
  <section class="section centered">
    <h3>数据与备份</h3>
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
    <p class="data-note">
      <strong>API 端点与 API 密钥不包含在备份中。</strong>
      导入不会覆盖本机已保存的 API 凭据；换到新设备后需要重新配置 API。
    </p>
    <!-- S-01：内容包卡搬去独立分区后，留一行指路给按旧习惯来这里找的人 -->
    <p class="pack-pointer">
      <i class="fa-solid fa-box-open" aria-hidden="true"></i>
      <span>内容包已移至「内容包」分区。</span>
      <AppButton variant="ghost" size="sm" @click="ui.openSettings('content-pack')"
        >前往内容包</AppButton
      >
    </p>
    <div class="data-actions">
      <AppCard padding="md"
        ><h4>导出数据</h4>
        <p class="text-muted text-sm">
          将所有存档、角色、记忆、剧情导出为 JSON 文件（不含音频库、素材库、API 端点与密钥）
        </p>
        <AppButton variant="secondary" size="sm" class="card-action" @click="exportAll"
          >导出全部数据</AppButton
        ></AppCard
      ><AppCard padding="md"
        ><h4>导入数据</h4>
        <p class="text-muted text-sm">
          从 JSON 文件恢复数据；备份中的数据会替换现有内容，本机 API 凭据不会被覆盖
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
      ><AppCard padding="md" class="mode-card"
        ><h4>经验档位</h4>
        <p v-if="ui.activeSaveId" class="save-scope text-xs">作用于存档「{{ activeSaveLabel }}」</p>
        <p class="text-muted text-sm">
          简单模式升级更快：一层约2倍、二层约1.8倍、三层约1.5倍战斗经验，层级越高差距越小，六层起与普通持平。
        </p>
        <FormSelect
          :model-value="experienceMode"
          :options="[
            { label: '普通', value: 'normal' },
            { label: '简单', value: 'easy' },
          ]"
          :disabled="!ui.activeSaveId"
          @update:model-value="(v) => changeExperienceMode(v as 'normal' | 'easy')"
        />
        <p v-if="!ui.activeSaveId" class="text-muted text-sm">
          未载入存档 —— 经验档位按存档保存，进入游戏后可在此切换。
        </p></AppCard
      ><AppCard padding="md"
        ><h4>本存档插画</h4>
        <p v-if="ui.activeSaveId" class="save-scope text-xs">作用于存档「{{ activeSaveLabel }}」</p>
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
      >
    </div>
    <!--
      危险区（S-01）：全应用破坏力最大的那个按钮单独放到分区底部，用分隔线与红色描边
      和日常卡片拉开 —— 不再与导出 / 导入 / 内容包排在同一个网格里。
    -->
    <div class="danger-zone" role="group" aria-labelledby="data-danger-zone-title">
      <h4 id="data-danger-zone-title" class="danger-zone-title">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> 危险操作
      </h4>
      <AppCard padding="md" class="data-danger"
        ><h4>清除所有数据</h4>
        <p class="text-muted text-sm">
          永久删除所有存档、角色、记忆、设置，以及上传的音频曲库与播放列表、素材库。不可撤销。
        </p>
        <AppButton variant="danger" size="sm" class="card-action" @click="showClearConfirm = true"
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
    <!--
      整库导入确认：备份包含的数据会被替换，设备本地凭据保留，点之前必须先说清楚。
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
        整库导入会用备份文件<strong style="color: var(--theme-error)"
          >替换备份范围内的现有数据</strong
        >，包括所有存档、角色、记忆、剧情与世界书。
      </p>
      <p class="text-muted text-sm">
        API 端点与 API 密钥不会从备份恢复，本机已保存的 API 凭据不会被覆盖；换到新设备后需要重新配置
        API。备份范围内的现有数据将被覆盖且不可撤销（音频库与素材库也不受影响）。建议先「导出全部数据」留一份备份。
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
          >替换备份数据并导入</AppButton
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
        将清理存档「{{ activeSaveLabel }}」中
        <strong>{{ cleanableCount }}</strong> 张插画的图片文件，释放约
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
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
/* Data */
/* 按存档生效的卡片：标题下一行标明作用于哪个存档 */
.save-scope {
  margin: 0 0 var(--theme-spacing-xs);
  color: var(--theme-text-secondary);
}
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
/* 内容包指路：一行说明 + 一个跳转按钮，不做成卡片（它已经不是这里的东西了） */
.pack-pointer {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin: 0 0 var(--theme-spacing-lg);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}
.pack-pointer i {
  color: var(--theme-quality-rare);
}
/* 危险区：与上方日常卡片用分隔线拉开，标题与描边都走 error 色 */
.danger-zone {
  margin-top: var(--theme-spacing-xl);
  padding-top: var(--theme-spacing-lg);
  border-top: 1px solid color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
}
.danger-zone-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  margin: 0 0 var(--theme-spacing-md);
  font-size: 0.85rem;
  color: var(--theme-error);
}
.data-danger h4 {
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
