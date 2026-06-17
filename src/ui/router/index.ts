import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

// 占位组件（后续 Phase 替换为真实页面）
const HomePage = () => import('../components/home/HomePage.vue')
const CreatePage = () => import('../components/create/CreatePage.vue')
const GamePage = () => import('../components/game/GamePage.vue')
const SettingsPage = () => import('../components/settings/SettingsPage.vue')
const WorkshopPage = () => import('../components/workshop/WorkshopPage.vue')

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: HomePage,
    meta: { transition: 'fade' },
  },
  {
    path: '/create',
    name: 'create',
    component: CreatePage,
    meta: { transition: 'fade' },
  },
  {
    path: '/game/:saveId',
    name: 'game',
    component: GamePage,
    meta: { transition: 'fade' },
    beforeEnter: async (to) => {
      // 路由守卫：验证 saveId 存在于 IndexedDB
      const { getSave } = await import('@engine/database')
      const save = await getSave(to.params.saveId as string)
      if (!save) {
        return { name: 'home' }
      }
    },
  },
  {
    path: '/settings',
    name: 'settings',
    component: SettingsPage,
    meta: { transition: 'fade' },
  },
  {
    path: '/workshop',
    name: 'workshop',
    component: WorkshopPage,
    meta: { transition: 'fade' },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
