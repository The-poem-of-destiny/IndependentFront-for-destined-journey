import { defineStore } from 'pinia';
import { ref } from 'vue';

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

  function navigate(view: AppView, saveId?: string) {
    if (saveId !== undefined) activeSaveId.value = saveId;
    if (view !== currentView.value) {
      previousView.value = currentView.value;
      viewHistory.value.push(currentView.value);
    }
    currentView.value = view;
  }

  /** 从设置页外直接打开指定分区；请求由 SettingsPage 挂载时消费一次。 */
  function openSettings(section: SettingsSection = 'api') {
    requestedSettingsSection.value = section;
    navigate('settings');
  }

  function consumeSettingsSectionRequest(): SettingsSection | null {
    const section = requestedSettingsSection.value;
    requestedSettingsSection.value = null;
    return section;
  }

  /** 返回真实来路，不经 navigate，避免把当前页重新压回历史栈。 */
  function back(fallback: AppView = 'home') {
    const target = viewHistory.value.pop() ?? fallback;
    currentView.value = target;
    previousView.value = viewHistory.value[viewHistory.value.length - 1] ?? fallback;
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
    requestedSettingsSection,
    navigate,
    openSettings,
    consumeSettingsSectionRequest,
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
