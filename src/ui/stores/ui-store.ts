import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Toast {
  id: string
  message: string
  type: 'info' | 'success' | 'warning' | 'error'
  duration: number
}

export const useUIStore = defineStore('ui', () => {
  const statusBarOpen = ref(false)
  const statusTab = ref('status')
  const leftSidebarOpen = ref(true)
  const rightSidebarOpen = ref(true)
  const activeModal = ref<string | null>(null)
  const toasts = ref<Toast[]>([])

  function toggleStatusBar() {
    statusBarOpen.value = !statusBarOpen.value
  }

  function switchStatusTab(tabId: string) {
    statusTab.value = tabId
  }

  function toggleLeftSidebar() {
    leftSidebarOpen.value = !leftSidebarOpen.value
  }

  function toggleRightSidebar() {
    rightSidebarOpen.value = !rightSidebarOpen.value
  }

  function showModal(id: string) {
    activeModal.value = id
  }

  function closeModal() {
    activeModal.value = null
  }

  function toast(message: string, type: Toast['type'] = 'info', duration = 3000) {
    const id = crypto.randomUUID()
    toasts.value.push({ id, message, type, duration })
    if (duration > 0) {
      setTimeout(() => removeToast(id), duration)
    }
  }

  function removeToast(id: string) {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }

  return {
    statusBarOpen, statusTab,
    leftSidebarOpen, rightSidebarOpen,
    activeModal, toasts,
    toggleStatusBar, switchStatusTab,
    toggleLeftSidebar, toggleRightSidebar,
    showModal, closeModal,
    toast, removeToast,
  }
})
