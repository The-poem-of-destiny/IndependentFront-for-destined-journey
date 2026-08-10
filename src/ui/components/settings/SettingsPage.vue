<script setup lang="ts">
/**
 * 设置页壳层 —— 导航 + Agent 分区（Q-25）
 *
 * 14 个分区里 13 个已经是一行子组件；只剩 **Agent 配置**还内联在这里，因为它
 * 要读写 13 张 per-Agent 并行 map（`agentModels` / `agentPrompts` / …），
 * 而那些 map 的形状正是 Q-18 要改的东西 —— 先拆再改等于拆两遍。
 * Q-18 落地后照 `settings/audio/` 的样子拆成 `settings/agent/` 目录。
 *
 * 分区共用的外壳样式在 `settings-chrome.css`：本页的 `<style scoped>` 只能命中
 * 自己的模板与子组件的**根节点**，够不到根节点里面，所以那份共用规则由各分区
 * （含本页）各自 `<style scoped src>` 引入 —— 一份源码，各自作用域。
 */
import { ref, computed, onMounted } from 'vue';
import { useUIStore } from '../../stores/ui-store';
import { useSettingsStore } from '../../stores/settings-store';
import { getAgentSettings } from '../../stores/agent-settings';
import { useWorldBookStore } from '../../stores/worldbook-store';
import AppButton from '../shared/AppButton.vue';
import ContentStatusBanner from '../shared/ContentStatusBanner.vue';
import AgentSection from './agent/AgentSection.vue';
import AgentUpdateCenter from './agent/AgentUpdateCenter.vue';
import { AGENT_LIST, resolveAgentSelection } from './agent/agent-list';
import ApiSection from './ApiSection.vue';
import WorldBookSection from './WorldBookSection.vue';
import PlotSection from './PlotSection.vue';
import MemorySection from './MemorySection.vue';
import ThemeSection from './ThemeSection.vue';
import MessagesSection from './MessagesSection.vue';
import BeautifierSection from './BeautifierSection.vue';
import AudioSection from './AudioSection.vue';
import AssetSection from './AssetSection.vue';
import ImageSection from './image/ImageSection.vue';
import DataSection from './DataSection.vue';
import DeveloperSection from './DeveloperSection.vue';
import AboutSection from './AboutSection.vue';

const ui = useUIStore();
const cfg = useSettingsStore();
const s = cfg.settings; // 短别名，模板里用 s.xxx
// Phase 0：书本体在 Dexie，唯一入口是 worldbook-store（`s.worldBooks` 已不存在）
const wb = useWorldBookStore();

/**
 * 有没有配好 API —— **两个消费者都在壳层**，所以它没跟着 ApiSection 走：
 * 左侧 Agent 子导航的红色 `!` 角标，以及 Agent 分区里"没选模型且没配 API"那句提示。
 * 读的是 store，与 ApiSection 天然同源，不需要跨组件传。
 */
const hasApi = computed(() => s.apiPool.length > 0);

// ============================================================
// 主导航
// ============================================================
type Section =
  | 'api'
  | 'agent'
  | 'worldbook'
  | 'plot'
  | 'memory'
  | 'theme'
  | 'messages'
  | 'beautifier'
  | 'audio'
  | 'asset'
  | 'image'
  | 'data'
  | 'developer'
  | 'about';
const activeSection = ref<Section>('api');

const navItems: { key: Section; label: string; icon: string }[] = [
  { key: 'api', label: 'API 配置', icon: 'fa-solid fa-plug' },
  { key: 'agent', label: 'Agent 配置', icon: 'fa-solid fa-robot' },
  { key: 'worldbook', label: '世界书', icon: 'fa-solid fa-book-open' },
  { key: 'plot', label: '剧情系统', icon: 'fa-solid fa-scroll' },
  { key: 'memory', label: '记忆 & 缓存', icon: 'fa-solid fa-brain' },
  { key: 'theme', label: '外观主题', icon: 'fa-solid fa-palette' },
  { key: 'messages', label: '消息显示', icon: 'fa-solid fa-message' },
  { key: 'beautifier', label: '输出美化', icon: 'fa-solid fa-wand-magic-sparkles' },
  { key: 'audio', label: '音频', icon: 'fa-solid fa-music' },
  // 媒体三分区相邻（音频 / 素材 / 图像生成），数据操作排在它们之后（设计 §7.1）
  { key: 'asset', label: '素材', icon: 'fa-solid fa-image' },
  { key: 'image', label: '图像生成', icon: 'fa-solid fa-wand-sparkles' },
  { key: 'data', label: '存档数据', icon: 'fa-solid fa-database' },
  { key: 'developer', label: '开发者模式', icon: 'fa-solid fa-code' },
  { key: 'about', label: '关于', icon: 'fa-solid fa-circle-info' },
];

/**
 * 子导航当前选中的 Agent（null = 显示「未选择」空态）。
 *
 * 读回来的持久化值先过 `resolveAgentSelection` —— 陈旧 id 的判定是纯函数，
 * 连同「为什么不能原样用」的理由一起放在 `agent-list.ts`。
 */
const activeAgent = ref<string | null>(resolveAgentSelection(s.activeAgent));

/**
 * 切主分区。
 *
 * 🔴 进 Agent 分区时**恢复上次选中的那个**，不要置 null。此前这里对每一个导航项
 *    都无条件 `activeAgent = null`（含「Agent 配置」自己），于是 `s.activeAgent`
 *    成了一个**存了却永远读不到**的值：`activeSection` 初值是 'api'，想进 Agent
 *    分区必须点一下那个按钮，而那一下正好把选择清掉 —— 每次都落在
 *    「← 请从左侧选择一个 Agent」空态，持久化白做。
 *
 *    置 null 当初是为了「强制重挂载，好让草稿的 immediate watch 触发」。那件事
 *    本来就由 `v-if` 保证：整个 Agent 分区随 `activeSection` 挂载/卸载，进来时
 *    永远是新挂载，`AgentConfigPanel` 的 `watch(..., { immediate: true })` 照常
 *    在挂载那一刻用正确的 agentId 触发。所以这里不需要拿一次用户点击去换它。
 */
function selectSection(key: Section) {
  activeSection.value = key;
  if (key === 'agent') activeAgent.value = resolveAgentSelection(s.activeAgent);
}

/**
 * 选一个 Agent。
 *
 * 只做**页面骨架**该做的两件事：记住选了谁、把它持久化。草稿载入随
 * `AgentConfigPanel` 的 `watch(agentId, …, { immediate: true })` 走 ——
 * 分区整块是 `v-if`，进来时永远是新挂载，immediate 会在同一时刻触发；
 * 在分区内换 Agent 则走 prop 变化，同一条 watch 照常触发。
 */
function selectAgent(agentId: string) {
  activeAgent.value = agentId;
  s.activeAgent = agentId;
}

/** 子导航角标要问「这个 Agent 选过 API 池没有」，问的不是当前选中的那个 */
function agentModelOf(agentId: string): string {
  // D44 修正 1：合默认层 —— 用户没覆写 model 时，角标也能正确反映「默认层给了一个池」。
  return getAgentSettings(s, agentId, cfg.projectAgentDefaults?.agents ?? {}).model;
}

// Phase 0: 保证进设置页时世界书已就绪（init() 幂等，App.vue 已踢过一次）
// Agent 分区的"这个 Agent 能看哪几本"勾选列表要用它；API 密钥的解密改由
// ApiSection 自己在挂载时踢（Q-25）。
onMounted(() => {
  void wb.init().catch(() => {
    /* 世界书装不起来不该拦住设置页其它分区 */
  });
});
</script>

<template>
  <div class="settings-page">
    <!-- 内容态徽标（波 1 T2 / §5.5）：占位 / error / 检测到本地真实内容 -->
    <ContentStatusBanner class="settings-content-banner" />
    <!-- 顶部栏 -->
    <div class="settings-header">
      <AppButton variant="ghost" size="sm" @click="ui.navigate(ui.activeSaveId ? 'game' : 'home')"
        >← 返回</AppButton
      >
      <h2 class="settings-title">系统设置</h2>
      <div class="header-spacer" />
    </div>

    <div class="settings-body">
      <!-- ====== 左侧主导航 ====== -->
      <nav class="main-nav">
        <button
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ 'nav-active': activeSection === item.key }"
          @click="selectSection(item.key)"
        >
          <span class="nav-icon"><i :class="item.icon" aria-hidden="true"></i></span>
          <span class="nav-label">{{ item.label }}</span>
        </button>

        <!--
          🔴 这一条**不是分区**：它离开设置页去创意工坊，所以既不进 `navItems`、
          也永远不会拿到 `.nav-active`（`activeSection` 里没有它的 key）。
          分隔线 + 右侧外链箭头就是在说这件事 —— 长得和上面一模一样的话，
          用户会以为点了会在右侧开一块面板，结果整页换掉。
          回来的路由工坊页的返回键负责（走 `ui.previousView`）。
        -->
        <div class="nav-divider" aria-hidden="true"></div>
        <button class="nav-item nav-external" @click="ui.navigate('workshop')">
          <span class="nav-icon"><i class="fa-solid fa-puzzle-piece" aria-hidden="true"></i></span>
          <span class="nav-label">创意工坊</span>
          <i
            class="fa-solid fa-arrow-up-right-from-square nav-external-mark"
            aria-hidden="true"
          ></i>
        </button>
      </nav>

      <!-- ====== Agent 子导航（仅当选中 Agent 配置时显示）====== -->
      <nav v-if="activeSection === 'agent'" class="sub-nav">
        <button
          v-for="ag in AGENT_LIST"
          :key="ag.id"
          class="sub-nav-item"
          :class="{ 'sub-nav-active': activeAgent === ag.id }"
          @click="selectAgent(ag.id)"
        >
          <span class="sub-nav-name">{{ ag.name }}</span>
          <!-- 未配置 API 标红 -->
          <span v-if="!hasApi" class="sub-nav-badge sub-nav-bad">!</span>
          <span v-else-if="!agentModelOf(ag.id)" class="sub-nav-badge sub-nav-bad">&#10005;</span>
          <span v-else class="sub-nav-badge sub-nav-ok">&#10003;</span>
        </button>
      </nav>

      <!-- ====== 右侧内容（居中）====== -->
      <div class="settings-content" :class="{ 'content-with-subnav': activeSection === 'agent' }">
        <Transition name="section-fade" mode="out-in">
          <div :key="activeSection" class="section-wrapper">
            <!-- ========== API 池 ========== -->
            <ApiSection v-if="activeSection === 'api'" />

            <!-- ========== Agent 详情 ========== -->
            <AgentSection v-if="activeSection === 'agent' && activeAgent" :agent-id="activeAgent" />

            <!-- Agent 未选择时的提示 -->
            <section v-if="activeSection === 'agent' && !activeAgent" class="section centered">
              <div class="empty-tab">
                <i class="fa-solid fa-robot empty-tab-icon" aria-hidden="true"></i>
                请从左侧选择一个 Agent
                <span class="empty-tab-hint">
                  每个 Agent 单独配置 API 池、采样参数与可见的世界书；名字旁的角标是它配好了没有
                </span>
              </div>
              <!-- 提示词更新中心：项目默认更新后，用户存量配置不会自动跟新（fillMissing
                   只填空位），这里给一个一键同步的入口。没有更新时组件自己不渲染。 -->
              <AgentUpdateCenter />
            </section>

            <!-- ========== 世界书 (Phase 8) ========== -->
            <WorldBookSection v-if="activeSection === 'worldbook'" />

            <!-- ========== 剧情系统 ========== -->
            <PlotSection v-if="activeSection === 'plot'" />

            <!-- ========== 记忆 & 缓存 ========== -->
            <MemorySection v-if="activeSection === 'memory'" />

            <!-- ========== 外观主题 ========== -->
            <ThemeSection v-if="activeSection === 'theme'" />

            <!-- ========== 消息显示 ========== -->
            <MessagesSection v-if="activeSection === 'messages'" />

            <!-- ========== 输出美化 ========== -->
            <BeautifierSection v-if="activeSection === 'beautifier'" />

            <!-- ========== 音频 ========== -->
            <AudioSection v-if="activeSection === 'audio'" />

            <!-- ========== 素材 ========== -->
            <AssetSection v-if="activeSection === 'asset'" />

            <!-- ========== 图像生成 ========== -->
            <ImageSection v-if="activeSection === 'image'" />

            <!-- ========== 存档数据 ========== -->
            <DataSection v-if="activeSection === 'data'" />

            <!-- ========== 开发者模式 ========== -->
            <DeveloperSection v-if="activeSection === 'developer'" />

            <!-- ========== 关于 ========== -->
            <AboutSection v-if="activeSection === 'about'" />
          </div>
          <!-- /section-wrapper -->
        </Transition>
      </div>
    </div>

    <!-- 添加/编辑 API 弹窗 -->
  </div>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--theme-window-bg);
}
.settings-content-banner {
  margin: 8px 16px 0;
}
.settings-header {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
  gap: 16px;
  flex-shrink: 0;
}
.settings-title {
  font-family: var(--theme-font-title);
  font-size: 1.1rem;
  color: var(--theme-text-primary);
  margin: 0;
}
.header-spacer {
  flex: 1;
}
.settings-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
/* 主导航 */
.main-nav {
  width: 180px;
  flex-shrink: 0;
  background: var(--theme-title-bar-bg);
  border-right: 1px solid var(--theme-card-border);
  padding: 12px 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-md);
  background: transparent;
  color: var(--theme-tab-text);
  font-family: inherit;
  font-size: 0.88rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
  text-align: left;
}
.nav-item:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.nav-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  color: var(--theme-text-primary);
  font-weight: 600;
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.nav-icon {
  font-size: 1rem;
  line-height: 1;
  flex-shrink: 0;
  width: 24px;
  text-align: center;
  opacity: 0.7;
  display: flex;
  align-items: center;
  justify-content: center;
}
.nav-icon i {
  font-size: 1rem;
}
.nav-active .nav-icon {
  opacity: 1;
  color: var(--theme-primary);
}
.nav-label {
  flex: 1;
}
/* 离开设置页的入口：与分区之间留一道分隔线 + 一个外链角标 */
.nav-divider {
  height: 1px;
  margin: 8px 12px;
  background: var(--theme-card-border);
}
.nav-external-mark {
  font-size: 0.7rem;
  opacity: 0.5;
  flex-shrink: 0;
}
.nav-external:hover .nav-external-mark {
  opacity: 0.9;
}
/* Agent 子导航 */
.sub-nav {
  width: 170px;
  flex-shrink: 0;
  background: var(--theme-content-bg);
  border-right: 1px solid var(--theme-card-border);
  padding: 10px 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sub-nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border: none;
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-tab-text);
  font-family: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all var(--theme-transition-fast);
  text-align: left;
}
.sub-nav-item:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.sub-nav-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  color: var(--theme-primary);
  font-weight: 600;
}
.sub-nav-name {
  flex: 1;
}
.sub-nav-badge {
  font-size: 0.65rem;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.sub-nav-bad {
  background: color-mix(in srgb, var(--theme-error) 15%, var(--theme-card-bg));
  color: var(--theme-error);
  border: 1px solid color-mix(in srgb, var(--theme-error) 40%, var(--theme-card-border));
}
.sub-nav-ok {
  background: color-mix(in srgb, var(--theme-success) 15%, var(--theme-card-bg));
  color: var(--theme-success);
  border: 1px solid color-mix(in srgb, var(--theme-success) 40%, var(--theme-card-border));
}
/* 内容区 */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 32px 40px;
}
.content-with-subnav {
  padding: 32px 32px;
}
.section-wrapper {
  width: 100%;
}
/* 分区切换动画 */
.section-fade-enter-active,
.section-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.section-fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.section-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
/* 居中 */
.centered {
  max-width: 780px;
  margin: 0 auto;
}
/* 减少动态效果（design.md 检查清单）。
   `.storage-bar-fill` 随 DataSection 走了；`.template-preview-panel` 随
   agent-chrome.css 走了（它与自己的 @keyframes 必须同组件，否则 Vue 的
   scoped 编译器按组件重命名关键帧，动画会一声不响地停掉）。 */
@media (prefers-reduced-motion: reduce) {
  .section-fade-enter-active,
  .section-fade-leave-active {
    transition: none;
  }
}
</style>
