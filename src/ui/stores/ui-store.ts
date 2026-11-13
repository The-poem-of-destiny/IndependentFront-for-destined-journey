import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
// game-store 不反向引用 ui-store，静态导入不成环；只在函数体内取实例。
import { useGameStore } from './game-store';

export interface Toast {
  id: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  duration: number;
}

/** 所有页面视图 */
export type AppView = 'home' | 'create' | 'game' | 'settings' | 'extensions' | 'workshop';

/** 设置页主分区；首页“关于”等跨页面入口通过这一类型传递目标。 */
export type SettingsSection =
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

export const useUIStore = defineStore('ui', () => {
  // ===== 导航 =====
  const currentView = ref<AppView>('home');
  const activeSaveId = ref<string | null>(null);
  const viewHistory = ref<AppView[]>([]);
  const requestedSettingsSection = ref<SettingsSection | null>(null);

  /**
   * 离开当前视图前它是谁 —— 保留给旧消费端读取；真正的多层返回由 viewHistory 承担。
   * 同视图内的重复 navigate 不覆盖它，否则返回键会就地失效。
   */
  const previousView = ref<AppView>('home');

  /**
   * 当前存档上下文的显示名 —— 设置页里按存档生效的卡片用它标明「作用于哪个存档」。
   * 名字取自 game-store 已载入的存档行；没有活跃存档时为 null。
   */
  const activeSaveName = computed<string | null>(() => {
    const id = activeSaveId.value;
    if (!id) return null;
    return useGameStore().saves.find((save) => save.id === id)?.name ?? null;
  });

  /**
   * 回到首页即离开存档上下文：清掉 ui 与 game-store 两处的活跃存档。
   * 否则「首页 → 设置」里的单存档操作（体验模式、清理场景图、外观预设）会写到刚离开的存档。
   * 只在抵达 home 时清；游戏页 → 设置不经过这里，档内设置仍保有存档上下文。
   */
  function leaveSaveContext() {
    activeSaveId.value = null;
    useGameStore().clearActive();
  }

  function navigate(view: AppView, saveId?: string) {
    if (saveId !== undefined) activeSaveId.value = saveId;
    if (view !== currentView.value) {
      previousView.value = currentView.value;
      viewHistory.value.push(currentView.value);
    }
    currentView.value = view;
    if (view === 'home') leaveSaveContext();
  }

  /** 打开设置页的指定分区；SettingsPage 挂载时或已在设置页时立即消费该请求。 */
  function openSettings(section: SettingsSection = 'api') {
    requestedSettingsSection.value = section;
    navigate('settings');
  }

  function consumeSettingsSectionRequest(): SettingsSection | null {
    const section = requestedSettingsSection.value;
    requestedSettingsSection.value = null;
    return section;
  }

  /** 应用级存档管理窗口；不参与页面导航，游戏页打开时保持当前叙事挂载。 */
  const saveManagerOpen = ref(false);

  function openSaveManager() {
    saveManagerOpen.value = true;
  }

  function closeSaveManager() {
    saveManagerOpen.value = false;
  }

  /** 返回真实来路，不经 navigate，避免把当前页重新压回历史栈。 */
  function back(fallback: AppView = 'home') {
    const target = viewHistory.value.pop() ?? fallback;
    currentView.value = target;
    previousView.value = viewHistory.value[viewHistory.value.length - 1] ?? fallback;
    if (target === 'home') leaveSaveContext();
  }

  // ===== UI 状态 =====
  const statusBarOpen = ref(false);
  const statusTab = ref('status');
  const leftSidebarOpen = ref(true);
  const rightSidebarOpen = ref(true);
  const activeModal = ref<string | null>(null);
  const toasts = ref<Toast[]>([]);

  function toggleStatusBar() {
    statusBarOpen.value = !statusBarOpen.value;
  }

  function switchStatusTab(tabId: string) {
    statusTab.value = tabId;
  }

  function toggleLeftSidebar() {
    leftSidebarOpen.value = !leftSidebarOpen.value;
  }

  function toggleRightSidebar() {
    rightSidebarOpen.value = !rightSidebarOpen.value;
  }

  function showModal(id: string) {
    activeModal.value = id;
  }

  function closeModal() {
    activeModal.value = null;
  }

  function toast(message: string, type: Toast['type'] = 'info', duration = 3000) {
    const id = crypto.randomUUID();
    toasts.value.push({ id, message, type, duration });
    if (duration > 0) {
      setTimeout(() => removeToast(id), duration);
    }
  }

  function removeToast(id: string) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  return {
    currentView,
    previousView,
    viewHistory,
    activeSaveId,
    activeSaveName,
    requestedSettingsSection,
    saveManagerOpen,
    navigate,
    openSettings,
    consumeSettingsSectionRequest,
    openSaveManager,
    closeSaveManager,
    back,
    statusBarOpen,
    statusTab,
    leftSidebarOpen,
    rightSidebarOpen,
    activeModal,
    toasts,
    toggleStatusBar,
    switchStatusTab,
    toggleLeftSidebar,
    toggleRightSidebar,
    showModal,
    closeModal,
    toast,
    removeToast,
  };
});
