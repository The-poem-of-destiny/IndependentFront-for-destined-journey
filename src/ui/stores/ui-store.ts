import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface Toast {
  id: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  duration: number;
}

/** 所有页面视图 */
export type AppView = 'home' | 'create' | 'game' | 'settings' | 'workshop';

export const useUIStore = defineStore('ui', () => {
  // ===== 导航 =====
  const currentView = ref<AppView>('home');
  const activeSaveId = ref<string | null>(null);

  function navigate(view: AppView, saveId?: string) {
    if (saveId !== undefined) activeSaveId.value = saveId;
    currentView.value = view;
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
    activeSaveId,
    navigate,
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
