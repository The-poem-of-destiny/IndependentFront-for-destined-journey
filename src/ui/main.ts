import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { useThemeStore } from './stores/theme-store'
import './styles/base.css'
import './styles/transitions.css'
import './styles/utilities.css'

// 主题系统
import './themes/variables.css'
import './themes/parchment.css'
import './themes/obsidian.css'
import './themes/crimson.css'
import './themes/indigo.css'
import './themes/bronze.css'
import './themes/sakura.css'
import './themes/ivory.css'
import './themes/misty-lilac.css'
import './themes/forest.css'
import './themes/ocean.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// 初始化主题（在 app 挂载前）
const themeStore = useThemeStore()
themeStore.init()
themeStore.initFontSize()

app.mount('#app')
