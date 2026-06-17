import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface ThemeDefinition {
  id: string
  name: string
  nameZh: string
  type: 'warm' | 'dark' | 'light'
  preview: string  // CSS gradient for preview swatch
}

export const THEME_LIST: ThemeDefinition[] = [
  { id: 'parchment', name: 'Parchment', nameZh: '羊皮纸', type: 'warm', preview: 'linear-gradient(135deg, #f5efe6, #d7c8b6)' },
  { id: 'obsidian', name: 'Obsidian', nameZh: '黑曜石', type: 'dark', preview: 'linear-gradient(135deg, #15171c, #323846)' },
  { id: 'crimson', name: 'Crimson', nameZh: '深红', type: 'dark', preview: 'linear-gradient(135deg, #1a1015, #3d1f28)' },
  { id: 'indigo', name: 'Indigo', nameZh: '靛蓝', type: 'dark', preview: 'linear-gradient(135deg, #111827, #1e3a5f)' },
  { id: 'bronze', name: 'Bronze', nameZh: '古铜', type: 'dark', preview: 'linear-gradient(135deg, #1a1510, #4a3520)' },
  { id: 'sakura', name: 'Sakura', nameZh: '樱', type: 'dark', preview: 'linear-gradient(135deg, #1a1018, #3d2a3a)' },
  { id: 'ivory', name: 'Ivory', nameZh: '象牙白', type: 'light', preview: 'linear-gradient(135deg, #faf8f5, #e8e0d5)' },
  { id: 'misty-lilac', name: 'Misty Lilac', nameZh: '雾紫', type: 'light', preview: 'linear-gradient(135deg, #f5f0fa, #d8c8e8)' },
  { id: 'forest', name: 'Forest', nameZh: '森林', type: 'dark', preview: 'linear-gradient(135deg, #0d1a12, #1a3a25)' },
  { id: 'ocean', name: 'Ocean', nameZh: '海洋', type: 'dark', preview: 'linear-gradient(135deg, #0a1628, #1a3550)' },
]

export const useThemeStore = defineStore('theme', () => {
  const current = ref('obsidian')
  const fonts = ref<'serif' | 'sans' | 'mixed'>('sans')
  const fontSize = ref('16')

  function setFontSize(size: string) {
    fontSize.value = size
    document.documentElement.style.fontSize = size + 'px'
    try { localStorage.setItem('fated-poem-font-size', size) } catch {}
  }

  function initFontSize() {
    try {
      const saved = localStorage.getItem('fated-poem-font-size')
      if (saved) setFontSize(saved)
    } catch {}
  }

  const currentTheme = computed(() => THEME_LIST.find(t => t.id === current.value))

  function apply(themeId: string) {
    document.documentElement.setAttribute('data-theme', themeId)
    current.value = themeId
    try {
      localStorage.setItem('fated-poem-theme', themeId)
    } catch { /* localStorage not available */ }
  }

  function init() {
    try {
      const saved = localStorage.getItem('fated-poem-theme')
      if (saved && THEME_LIST.some(t => t.id === saved)) {
        apply(saved)
      } else {
        apply('obsidian')
      }
    } catch {
      apply('obsidian')
    }
  }

  function setFonts(mode: 'serif' | 'sans' | 'mixed') {
    fonts.value = mode
    document.documentElement.style.setProperty(
      '--theme-font-body',
      mode === 'serif' ? "'Noto Serif SC', serif"
        : mode === 'mixed' ? "'Noto Sans SC', 'Noto Serif SC', sans-serif"
        : "'Noto Sans SC', sans-serif"
    )
    try {
      localStorage.setItem('fated-poem-fonts', mode)
    } catch { /* */ }
  }

  return { current, fonts, fontSize, currentTheme, THEME_LIST, apply, init, initFontSize, setFonts, setFontSize }
})
