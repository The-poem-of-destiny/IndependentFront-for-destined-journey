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

  /**
   * 离开当前视图前它是谁 —— 只服务「进去了要能原路回来」的页面（工坊）。
   *
   * 🔴 不是浏览器那种历史栈，**只记一层**，而且同视图内的重复 navigate 不覆盖它
   *    （否则 workshop → workshop 会把返回目标改成自己，返回键就地失效）。
   *    要真正的前进/后退请另起一套，别把这个变量喂大。
   */
  const previousView = ref<AppView>('home');

  function navigate(view: AppView, saveId?: string) {
    if (saveId !== undefined) activeSaveId.value = saveId;
    if (view !== currentView.value) previousView.value = currentView.value;
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
    previousView,
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
