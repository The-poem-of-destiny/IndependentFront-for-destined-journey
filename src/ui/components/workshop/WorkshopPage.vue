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
 *   网络安装与覆盖确认后的提交，两个入口汇合于 {@link settlePrepared} /
 *   {@link commit} 这一对函数。第二条提交路径就是第二条绕过警告的路径 —— 而被绕过的
 *   后果是用户亲手写的世界书条目被上游版本静默盖掉，事后无从追回。
 *
 * 页面不碰 Dexie、不碰 `fetch`: 落库经 `workshop-store`，网络经 `workshop-client`。
 *
 * 社交侧只在本页占**一格**（P3c）: 顶栏的登录位（未登录一个按钮，已登录头像 + 名字 +
 * 登出）。点赞/订阅长在卡片与详情上，不经过本页；投稿/管理面仍不做。
 * 「哪些工坊项目在这个存档里启用」是另一条轴（P1-5，捏人页 + 每存档面板），不在这里。
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { WorkshopProject } from '@engine/types';
import type { InstallConflict, WorkshopProjectMeta } from '@engine/workshop-types';
import type { WorkshopUpdateDiff } from '@engine/workshop-diff';
import { groupWorkshopNotes } from '@engine/workshop-types';
import { useUIStore } from '../../stores/ui-store';
import { useWorkshopStore } from '../../stores/workshop-store';
import type { WorkshopPrepared } from '../../stores/workshop-store';
import { useWorkshopSocialStore } from '../../stores/workshop-social-store';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import WorkshopBrowseModal from './WorkshopBrowseModal.vue';
import WorkshopSubmitModal from './WorkshopSubmitModal.vue';
import WorkshopAdminModal from './WorkshopAdminModal.vue';
import WorkshopDetailModal from './WorkshopDetailModal.vue';
import WorkshopInstalledList from './WorkshopInstalledList.vue';
import WorkshopConflictModal from './WorkshopConflictModal.vue';
import { describeFailure, describeLoginFailure } from './failure-text';
import {
  DISCORD_FALLBACK_AVATAR,
  discordAvatarUrl,
  discordDisplayName,
  summarizeNoteGroups,
} from './format';

const ui = useUIStore();
const workshop = useWorkshopStore();
const social = useWorkshopSocialStore();

onMounted(() => {
  // 幂等：init 内部共用同一个 Promise，App.vue 已经踢过的 store 在这里空转
  void workshop.init();
  // 同样幂等。做两件事：给 client 注册 token provider、从 localStorage 恢复登录态
  social.init();
});

const projects = computed<WorkshopProject[]>(() => workshop.projects);

// ═══ 模态状态 ═══

const browseOpen = ref(false);
const detailOpen = ref(false);
const detailId = ref('');

/** 正在跑安装/更新/卸载/查更新的项目 id —— 同一时刻只允许一个 */
const busyId = ref('');

/**
 * 正在跑的**是哪个动作**。
 *
 * 光有 busyId 不够: 一行上并排三个按钮，只按 id 判定会让三个一起转圈，用户看不出
 * 自己按的是「查更新」还是「卸载」—— 尤其卸载是不可逆的，让它看起来在跑而实际在
 * 跑别的，是会吓到人的。
 */
type BusyAction = '' | 'install' | 'update' | 'check' | 'uninstall';
const busyAction = ref<BusyAction>('');

/** 起止成对出现，避免哪条路径忘了清而把按钮永久钉在转圈上 */
function beginBusy(id: string, action: BusyAction): void {
  busyId.value = id;
  busyAction.value = action;
}

function endBusy(): void {
  busyId.value = '';
  busyAction.value = '';
}

/** D15 待确认的覆盖。`prepared` 必须原样留着交给 commitInstall（它会以当下游标重算） */
const pending = ref<{
  prepared: WorkshopPrepared;
  conflicts: InstallConflict[];
  /** 改动预告（B3）。首装为 null —— 没有可比的对象 */
  diff: WorkshopUpdateDiff | null;
} | null>(null);
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
  // 已装的走「更新」，没装的走「安装」—— 两者的按钮不在同一处
  beginBusy(prepared.projectId, workshop.getProject(prepared.projectId) ? 'update' : 'install');
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
    endBusy();
  }
}

/**
 * ★ D15 闸门: 有冲突就**先停下**，一行都不写。
 *
 * 返回值只给调用方看「有没有走到落库」，不承担别的语义。
 */
async function settlePrepared(prepared: WorkshopPrepared): Promise<void> {
  const conflicts = prepared.plan.conflicts;

  /*
   * ★ 更新**一律**先停下给预告（B3），不再只在有冲突时才停。
   *
   * 「更新」这个动作会静默改掉用户已经在玩的内容 —— 加条目、删条目、换正文。
   * 冲突警告只覆盖其中一种后果（他自己改过的那几条），另外几种同样不可逆，
   * 却此前一个字都不说。首装不走这道闸: 那时全部内容都是新的，预告等于把详情
   * 模态里刚看过的东西再念一遍，纯粹的摩擦。
   */
  if (prepared.plan.isUpdate || conflicts.length > 0) {
    pending.value = { prepared, conflicts, diff: workshop.previewUpdate(prepared) };
    return;
  }
  await commit(prepared);
}

/**
 * 网络安装/更新。
 *
 * ★ `force`（绕开 5 分钟详情缓存）**只在更新时给**，首装不给:
 * - **更新**：用户按下「更新」就是冲着最新版本元数据来的，这时缓存该让路 —— 拿一份
 *   五分钟前的版本号去装，会装出与按钮上写的版本对不上的东西。
 * - **首装**：用户几秒前刚在详情模态里看过这个项目（详情缓存正热），他点头同意装的
 *   就是**刚刚看到的那一份**。重拉一次既换不来他没看过的信息，还让「安装」比「浏览」
 *   多等一个往返 —— 恰好是最没耐心的那一刻。
 */
async function installFromNetwork(projectId: string): Promise<void> {
  if (busyId.value) return;
  const isUpdate = workshop.getProject(projectId) !== undefined;
  beginBusy(projectId, isUpdate ? 'update' : 'install');
  let prepared: WorkshopPrepared | null = null;
  try {
    const prep = await workshop.prepareInstall(projectId, { force: isUpdate });
    if (!prep.ok) {
      if (prep.error.kind !== 'cancelled') announce(describeFailure(prep.error), 'error');
      return;
    }
    prepared = prep.prepared;
  } finally {
    endBusy();
  }
  await settlePrepared(prepared);
}

/** 用户在覆盖警告上点了「覆盖并更新」 */
async function confirmOverwrite(): Promise<void> {
  const p = pending.value;
  if (!p) return;
  // ★ 先跑完再关。曾经是先 `pending = null` 再 await —— 模态在写入开始前就消失了，
  //   于是它的忙碌态（「正在覆盖…」、禁用的取消键）永远没有机会渲染，是死代码；
  //   而用户在几秒的写入期间对着一个已经关掉的对话框，不知道覆盖到底跑没跑。
  await commit(p.prepared);
  pending.value = null;
}

// ═══ 查更新 / 卸载 ═══

async function checkUpdate(projectId: string): Promise<void> {
  if (busyId.value) return;
  beginBusy(projectId, 'check');
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
    endBusy();
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
  // 同 confirmOverwrite：跑完再关，否则模态上的「卸载中…」是死代码
  beginBusy(target.id, 'uninstall');
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
    endBusy();
    pendingUninstall.value = null;
  }
}

// ═══ 登录位（P3c / D19·D25） ═══

/** 头像 URL 拉不动时的兜底标志。换了用户就重置，否则新头像会被上一个人的失败判死 */
const avatarFailed = ref(false);
watch(
  () => social.user?.userId,
  () => {
    avatarFailed.value = false;
  },
);

const accountName = computed(() => discordDisplayName(social.user));
const avatarUrl = computed(() =>
  avatarFailed.value ? DISCORD_FALLBACK_AVATAR : discordAvatarUrl(social.user),
);

/**
 * 登录。**不自己编排弹窗/轮询** —— 那一整套（双重验签、快路径、60 秒超时、单飞）
 * 都在 store 里，本页只把收场翻成一句话。
 *
 * 连点两下不会开出两个弹窗: store 的单飞让第二次调用共用同一个 Promise，
 * 而按钮在 pending 期间本来就是禁用的（`loading`）。
 */
async function onLogin(): Promise<void> {
  const res = await social.login();
  if (res.status === 'success') {
    announce(`已登录为 ${accountName.value}`, 'success');
    return;
  }
  // D25：上游原话照登，后面补一句我们自己的前提说明（口径收在 failure-text）
  announce(describeLoginFailure(res.message), 'error');
}

/** 登出不发请求（O4）——上游 logout 是纯 no-op，丢掉本地 token 就是登出的全部含义 */
function onLogout(): void {
  social.logout();
  announce('已登出创意工坊账号。', 'info');
}

// ═══ 详情模态的派生 ═══

// ═══ 投稿 / 编辑（B4） ═══

const submitOpen = ref(false);
/** 有值 = 编辑那一份；null = 新建投稿 */
const submitEditing = ref<{
  id: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
} | null>(null);

function openSubmit(): void {
  submitEditing.value = null;
  submitOpen.value = true;
}

/**
 * 从浏览模态里点「编辑」。
 *
 * 表单初值以**上游那一行**为准（模态转达过来的，`/api/projects` 与 `/api/my/projects`
 * 都带 description/version/tags），本地已装的那份只做兜底。
 *
 * 🔴 顺序不能反：「我的项目」列的是作者名下全部项目，**未必在本地装过**。以本地为准
 * 时那种项目会开出一张空表单，而「提交修改」是整份 PUT —— 一次没留神就把上游的简介
 * 清空、标签清光。宁可少填一个字段，也不能拿空串去覆盖线上还在的内容。
 */
function openEdit(project: WorkshopProjectMeta): void {
  const local = workshop.getProject(project.id);
  submitEditing.value = {
    id: project.id,
    name: project.name || (local?.name ?? ''),
    description: project.description || (local?.description ?? ''),
    version: project.version || (local?.version ?? '1.0.0'),
    tags: [...(project.tags.length > 0 ? project.tags : (local?.tags ?? []))],
  };
  submitOpen.value = true;
}

function onSubmitted(): void {
  announce('已提交到创意工坊，等待审核。', 'success');
}

// ═══ 审核面板（B5，仅管理员） ═══

const adminOpen = ref(false);
/**
 * 只决定**画不画这个入口**，不是权限边界 —— 真正的门禁在上游的 403 上
 * （见 WorkshopAdminModal 的文件头）。
 */
const isAdmin = computed(() => social.user?.isAdmin === true);

const detailInstalled = computed(() => workshop.getProject(detailId.value));
const pendingName = computed(() => pending.value?.prepared.input.project.name ?? '');
</script>

<template>
  <div class="workshop-page">
    <!--
      ═══ 顶栏 ═══
      只留导航与标题。动作按钮曾经全挤在这一条右侧，窄屏下会折行把标题顶掉，
      而且「浏览工坊」这个主动作藏在页面最边角 —— 它其实是这一页的主要入口。
      2026-08-01 全部下沉进页面本体。
    -->
    <header class="wk-topbar">
      <!--
        原路返回：工坊现在有三个入口（首页 / 游戏页侧栏 / 设置页导航），
        一律回首页会把从设置里进来的人扔到标题画面。`previousView` 只记一层，
        够这一个用途；工坊自己不该出现在返回目标里（防返回键就地失效）。
      -->
      <AppButton
        variant="ghost"
        size="sm"
        @click="ui.navigate(ui.previousView === 'workshop' ? 'home' : ui.previousView)"
        >← 返回</AppButton
      >
      <h2 class="wk-title">创意工坊</h2>
    </header>

    <main class="wk-main">
      <p class="wk-intro">
        创意工坊的项目由社区投稿，未经本引擎审核。装上之后，它的世界书条目会进入
        <strong>创意工坊</strong> 分区（与内置内容彼此隔离），正则会进入「输出美化」规则库。
        装了还不等于生效 —— 还要在存档里勾选启用。
      </p>

      <!--
        ═══ 动作区 ═══
        左：身份（登录 / 头像 + 登出）。右：动作，「浏览工坊」作为主动作排在最后
        （视线终点，也是最常按的那个）。
      -->
      <section class="wk-actionbar">
        <div class="wk-actionbar-identity">
          <!-- ═══ 登录位（P3c） ═══ -->
          <div v-if="social.isLoggedIn" class="wk-account">
            <img
              class="wk-avatar"
              :src="avatarUrl"
              alt=""
              referrerpolicy="no-referrer"
              @error="avatarFailed = true"
            />
            <span class="wk-account-name" :title="accountName">{{ accountName }}</span>
            <AppButton variant="ghost" size="sm" @click="onLogout">登出</AppButton>
          </div>
          <AppButton
            v-else
            variant="secondary"
            size="sm"
            :loading="social.loginPhase === 'pending'"
            @click="onLogin"
          >
            {{ social.loginPhase === 'pending' ? '等待 Discord 授权…' : 'Discord 登录' }}
          </AppButton>
        </div>

        <div class="wk-actionbar-actions">
          <AppButton v-if="isAdmin" variant="secondary" size="sm" @click="adminOpen = true">
            审核
          </AppButton>

          <!-- 投稿要有身份可署名，未登录时不出这个按钮（点了也只会 401） -->
          <AppButton v-if="social.isLoggedIn" variant="secondary" size="sm" @click="openSubmit">
            投稿
          </AppButton>

          <AppButton variant="primary" size="sm" @click="browseOpen = true">浏览工坊</AppButton>
        </div>
      </section>

      <section class="wk-section">
        <!-- 水合完成前不报数：这时 projects 恒为空，报「已安装（0）」是在说假话 -->
        <h3 class="wk-section-title">
          已安装<template v-if="workshop.ready">（{{ projects.length }}）</template>
        </h3>
        <WorkshopInstalledList
          :projects="projects"
          :busy-id="busyId"
          :busy-action="busyAction"
          :hydrating="!workshop.ready"
          @detail="openDetail"
          @update="installFromNetwork"
          @check="checkUpdate"
          @uninstall="askUninstall"
        />
      </section>

      <p class="sr-only" role="status" aria-live="polite">{{ liveMessage }}</p>
    </main>

    <!-- ═══ 浏览 ═══ -->
    <WorkshopBrowseModal
      v-model:open="browseOpen"
      :installed="projects"
      @open="openDetail"
      @edit="openEdit"
      @notify="announce"
    />

    <!-- ═══ 审核面板（B5） ═══ -->
    <WorkshopAdminModal v-model:open="adminOpen" @notify="announce" />

    <!-- ═══ 投稿 / 编辑（B4） ═══ -->
    <WorkshopSubmitModal
      v-model:open="submitOpen"
      :editing="submitEditing ?? undefined"
      @submitted="onSubmitted"
    />

    <!-- ═══ 详情 ═══ -->
    <WorkshopDetailModal
      v-model:open="detailOpen"
      :project-id="detailId"
      :installed="detailInstalled"
      :busy="busyId === detailId"
      :busy-action="busyAction"
      @install="installFromNetwork"
      @uninstall="askUninstall"
    />

    <!-- ═══ ★ D15 覆盖警告：出现在任何一行落库之前 ═══ -->
    <WorkshopConflictModal
      :open="pending !== null"
      :project-name="pendingName"
      :conflicts="pending?.conflicts ?? []"
      :diff="pending?.diff ?? null"
      :busy="busyId !== ''"
      @confirm="confirmOverwrite"
      @cancel="busyId ? undefined : (pending = null)"
    />

    <!-- ═══ 卸载确认 ═══ -->
    <AppModal
      :open="pendingUninstall !== null"
      title="卸载工坊项目"
      size="sm"
      :closable="busyAction !== 'uninstall'"
      @update:open="busyAction === 'uninstall' ? undefined : (pendingUninstall = null)"
    >
      <p class="wk-uninstall-text">
        卸载「<strong>{{ pendingUninstall?.name }}</strong
        >」会删掉它的世界书与美化规则。存档里对它的启用记录会失效，但存档本身不受影响。
      </p>
      <template #footer>
        <AppButton
          variant="ghost"
          size="sm"
          :disabled="busyAction === 'uninstall'"
          @click="pendingUninstall = null"
        >
          取消
        </AppButton>
        <AppButton
          variant="danger"
          size="sm"
          :loading="busyAction === 'uninstall'"
          @click="confirmUninstall"
        >
          {{ busyAction === 'uninstall' ? '卸载中…' : '卸载' }}
        </AppButton>
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
/*
 * ── 动作区（2026-08-01 从顶栏下沉） ──
 *
 * 一行两组、中间自动撑开。窄屏折成两行而不是把按钮挤成一列 —— 竖着排四个按钮
 * 会把「已安装」整块推到首屏之外。
 */
.wk-actionbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-lg);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
}
.wk-actionbar-identity,
.wk-actionbar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-sm);
}

/* ── 登录位 ── */
.wk-account {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.wk-avatar {
  width: 24px;
  height: 24px;
  border-radius: var(--theme-radius-full);
  object-fit: cover;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
}
/*
 * 名字给个上限并省略: Discord 显示名可以很长（表情、装饰符号一大串），不封顶的话
 * 会把同一行右边的动作按钮一路挤到折行。
 */
.wk-account-name {
  max-width: 10rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
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
