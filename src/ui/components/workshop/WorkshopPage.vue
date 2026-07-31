<script setup lang="ts">
/**
 * 创意工坊页（Phase 1 / P1-4）
 *
 * 编排壳: 已装列表 + 四个模态（浏览 / 详情 / 覆盖警告 / 卸载确认）。子组件都是纯呈现或
 * 只读网络，**所有落库动作都收在本文件里**，因为这里有一条不能被绕开的时序。
 *
 * ★ **本页的核心纪律：安装只有一条路，且冲突先于落库（D15）**
 *
 *   prepare（不写任何一行）→ 看 `plan.conflicts` → 非空则弹警告，等用户点头
 *                                              → 空则直接 commitInstall
 *
 *   网络安装、本地文件导入、覆盖确认后的提交，三个入口汇合于 {@link settlePrepared} /
 *   {@link commit} 这一对函数。第二条提交路径就是第二条绕过警告的路径 —— 而被绕过的
 *   后果是用户亲手写的世界书条目被上游版本静默盖掉，事后无从追回。
 *
 * 页面不碰 Dexie、不碰 `fetch`: 落库经 `workshop-store`，网络经 `workshop-client`。
 *
 * 只做安装侧: 登录/点赞/订阅/投稿属 Phase 3+，本页一个入口都不给。
 * 「哪些工坊项目在这个存档里启用」是另一条轴（P1-5，捏人页 + 每存档面板），不在这里。
 */
import { computed, onMounted, ref } from 'vue';
import type { WorkshopProject } from '@engine/types';
import type { InstallConflict } from '@engine/workshop-types';
import { groupWorkshopNotes } from '@engine/workshop-types';
import { useUIStore } from '../../stores/ui-store';
import { useWorkshopStore } from '../../stores/workshop-store';
import type { WorkshopPrepared } from '../../stores/workshop-store';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import WorkshopBrowseModal from './WorkshopBrowseModal.vue';
import WorkshopDetailModal from './WorkshopDetailModal.vue';
import WorkshopInstalledList from './WorkshopInstalledList.vue';
import WorkshopConflictModal from './WorkshopConflictModal.vue';
import { describeFailure } from './failure-text';
import { summarizeNoteGroups } from './format';

const ui = useUIStore();
const workshop = useWorkshopStore();

onMounted(() => {
  // 幂等：init 内部共用同一个 Promise，App.vue 已经踢过的 store 在这里空转
  void workshop.init();
});

const projects = computed<WorkshopProject[]>(() => workshop.projects);

// ═══ 模态状态 ═══

const browseOpen = ref(false);
const detailOpen = ref(false);
const detailId = ref('');

/** 正在跑安装/更新/卸载/查更新的项目 id —— 同一时刻只允许一个 */
const busyId = ref('');

/** D15 待确认的覆盖。`prepared` 必须原样留着交给 commitInstall（它会以当下游标重算） */
const pending = ref<{ prepared: WorkshopPrepared; conflicts: InstallConflict[] } | null>(null);
const pendingUninstall = ref<WorkshopProject | null>(null);

/** 唯一的状态播报区 */
const liveMessage = ref('');

function announce(text: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  liveMessage.value = text;
  ui.toast(text, type);
}

function openDetail(projectId: string): void {
  detailId.value = projectId;
  detailOpen.value = true;
}

// ═══ 安装管线（唯一路径） ═══

/**
 * 提交一份计划。**只有它调 `commitInstall`** —— 别在别处再加一个调用点。
 *
 * 回执文案把数字一起报: 装了多少条目、多少美化规则，以及处置记录**分类**后的计数。
 * 这是 D16 的「丢弃必须 loud」在 toast 上的落点；详情仍留在已装列表里可展开。
 *
 * ⚠️ 处置计数**必须与已装列表同口径**（`summarizeNoteGroups`）。曾经这里把三类
 * 合起来报「N 项未导入」，而其中大多数条目装得好好的 —— 两处说法一旦分家，用户
 * 会以为自己遇到了两个不同的问题。
 */
async function commit(prepared: WorkshopPrepared): Promise<void> {
  busyId.value = prepared.projectId;
  try {
    const { project, plan } = await workshop.commitInstall(prepared);
    const groups = groupWorkshopNotes(project.droppedNotes);
    const parts = [`世界书 ${plan.entries.length} 条`, `美化规则 ${plan.rules.length} 条`];
    const noteSummary = summarizeNoteGroups(groups);
    if (noteSummary) parts.push(noteSummary);
    // 真丢了东西或有全局副作用才升到 warning；「装上了只是效果打折」不该长得像失败
    const alarming = groups.dropped.length > 0 || groups.sideEffect.length > 0;
    announce(`「${project.name}」已装上 · ${parts.join(' · ')}`, alarming ? 'warning' : 'success');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    announce(`安装写入失败：${reason}`, 'error');
  } finally {
    busyId.value = '';
  }
}

/**
 * ★ D15 闸门: 有冲突就**先停下**，一行都不写。
 *
 * 返回值只给调用方看「有没有走到落库」，不承担别的语义。
 */
async function settlePrepared(prepared: WorkshopPrepared): Promise<void> {
  if (prepared.plan.conflicts.length > 0) {
    pending.value = { prepared, conflicts: prepared.plan.conflicts };
    return;
  }
  await commit(prepared);
}

/** 网络安装/更新。`force: true` 绕开 5 分钟详情缓存 —— 用户按更新就是想要最新的 */
async function installFromNetwork(projectId: string): Promise<void> {
  if (busyId.value) return;
  busyId.value = projectId;
  let prepared: WorkshopPrepared | null = null;
  try {
    const prep = await workshop.prepareInstall(projectId, { force: true });
    if (!prep.ok) {
      if (prep.error.kind !== 'cancelled') announce(describeFailure(prep.error), 'error');
      return;
    }
    prepared = prep.prepared;
  } finally {
    busyId.value = '';
  }
  await settlePrepared(prepared);
}

/** 用户在覆盖警告上点了「覆盖并更新」 */
async function confirmOverwrite(): Promise<void> {
  const p = pending.value;
  if (!p) return;
  pending.value = null;
  await commit(p.prepared);
}

// ═══ 本地文件导入（离线来源，与网络同一条管线） ═══

const fileInput = ref<HTMLInputElement | null>(null);

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 先清空 value：不清的话选同一个文件第二次不会触发 change
  input.value = '';
  if (!file) return;

  let raw: unknown;
  try {
    raw = JSON.parse(await file.text()) as unknown;
  } catch {
    announce(`「${file.name}」不是合法的 JSON 文件。`, 'error');
    return;
  }

  const prep = workshop.prepareInstallFromFile(raw);
  if (!prep.ok) {
    announce(describeFailure(prep.error), 'error');
    return;
  }
  await settlePrepared(prep.prepared);
}

// ═══ 查更新 / 卸载 ═══

async function checkUpdate(projectId: string): Promise<void> {
  if (busyId.value) return;
  busyId.value = projectId;
  try {
    const res = await workshop.checkUpdate(projectId, { force: true });
    if (!res.ok) {
      announce(describeFailure(res.error), 'error');
      return;
    }
    announce(
      res.hasUpdate
        ? `「${res.project.name}」有新版本 ${res.project.version}（已装 ${res.project.installedVersion}）`
        : `「${res.project.name}」已是最新版本。`,
      res.hasUpdate ? 'info' : 'success',
    );
  } finally {
    busyId.value = '';
  }
}

function askUninstall(projectId: string): void {
  const p = workshop.getProject(projectId);
  if (!p) return;
  pendingUninstall.value = p;
}

async function confirmUninstall(): Promise<void> {
  const target = pendingUninstall.value;
  if (!target) return;
  pendingUninstall.value = null;
  busyId.value = target.id;
  try {
    const ok = await workshop.uninstall(target.id);
    announce(
      ok ? `「${target.name}」已卸载。` : `「${target.name}」不在库里，无需卸载。`,
      ok ? 'success' : 'info',
    );
    if (detailId.value === target.id) detailOpen.value = false;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    announce(`卸载失败：${reason}`, 'error');
  } finally {
    busyId.value = '';
  }
}

// ═══ 详情模态的派生 ═══

const detailInstalled = computed(() => workshop.getProject(detailId.value));
const pendingName = computed(() => pending.value?.prepared.input.project.name ?? '');
</script>

<template>
  <div class="workshop-page">
    <!-- ═══ 顶栏 ═══ -->
    <header class="wk-topbar">
      <AppButton variant="ghost" size="sm" @click="ui.navigate('home')">← 返回</AppButton>
      <h2 class="wk-title">创意工坊</h2>
      <div class="wk-topbar-actions">
        <AppButton variant="secondary" size="sm" @click="fileInput?.click()">
          导入本地文件
        </AppButton>
        <AppButton variant="primary" size="sm" @click="browseOpen = true">浏览工坊</AppButton>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept=".json,application/json"
        class="wk-file-input"
        aria-label="导入 project-xxx.json"
        @change="onFilePicked"
      />
    </header>

    <main class="wk-main">
      <p class="wk-intro">
        创意工坊的项目由社区投稿，未经本引擎审核。装上之后，它的世界书条目会进入
        <strong>创意工坊</strong> 分区（与内置内容彼此隔离），正则会进入「输出美化」规则库。
        装了还不等于生效 —— 还要在存档里勾选启用。
      </p>

      <section class="wk-section">
        <h3 class="wk-section-title">已安装（{{ projects.length }}）</h3>
        <WorkshopInstalledList
          :projects="projects"
          :busy-id="busyId"
          @detail="openDetail"
          @update="installFromNetwork"
          @check="checkUpdate"
          @uninstall="askUninstall"
        />
      </section>

      <p class="sr-only" role="status" aria-live="polite">{{ liveMessage }}</p>
    </main>

    <!-- ═══ 浏览 ═══ -->
    <WorkshopBrowseModal v-model:open="browseOpen" :installed="projects" @open="openDetail" />

    <!-- ═══ 详情 ═══ -->
    <WorkshopDetailModal
      v-model:open="detailOpen"
      :project-id="detailId"
      :installed="detailInstalled"
      :busy="busyId === detailId"
      @install="installFromNetwork"
      @uninstall="askUninstall"
    />

    <!-- ═══ ★ D15 覆盖警告：出现在任何一行落库之前 ═══ -->
    <WorkshopConflictModal
      :open="pending !== null"
      :project-name="pendingName"
      :conflicts="pending?.conflicts ?? []"
      :busy="busyId !== ''"
      @confirm="confirmOverwrite"
      @cancel="pending = null"
    />

    <!-- ═══ 卸载确认 ═══ -->
    <AppModal
      :open="pendingUninstall !== null"
      title="卸载工坊项目"
      size="sm"
      @update:open="pendingUninstall = null"
    >
      <p class="wk-uninstall-text">
        卸载「<strong>{{ pendingUninstall?.name }}</strong
        >」会删掉它的世界书与美化规则。存档里对它的启用记录会失效，但存档本身不受影响。
      </p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="pendingUninstall = null">取消</AppButton>
        <AppButton variant="danger" size="sm" @click="confirmUninstall">卸载</AppButton>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.workshop-page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--theme-window-bg);
}

/* ── 顶栏 ── */
.wk-topbar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md) var(--theme-spacing-xl);
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
}
.wk-title {
  flex: 1;
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1.3rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--theme-text-primary);
}
.wk-topbar-actions {
  display: flex;
  gap: var(--theme-spacing-sm);
}
.wk-file-input {
  display: none;
}

/* ── 主体 ── */
.wk-main {
  flex: 1;
  width: min(100%, 900px);
  margin: 0 auto;
  padding: var(--theme-spacing-xl);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xl);
}

.wk-intro {
  margin: 0;
  padding-bottom: var(--theme-spacing-md);
  font-size: 0.8125rem;
  line-height: 1.7;
  color: var(--theme-text-muted);
  border-bottom: 1px solid var(--theme-card-border);
}

.wk-section {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}
/* Section 标题装饰线（design.md §5.1） */
.wk-section-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.wk-section-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

.wk-uninstall-text {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.7;
  color: var(--theme-text-secondary);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
</style>
