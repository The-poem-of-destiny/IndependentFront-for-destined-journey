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

export const useUIStore = defineStore('ui', () => {
  // ===== 导航 =====
  const currentView = ref<AppView>('home');
  const activeSaveId = ref<string | null>(null);
  const viewHistory = ref<AppView[]>([]);

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
    navigate,
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
