import { createRouter, createWebHashHistory } from 'vue-router'
import HomePage from '@/pages/HomePage.vue'

// 用 hash 路由：GitHub Pages 子路径下刷新不会 404
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage, meta: { title: '司南基金' } },
    { path: '/screen', name: 'screen', component: () => import('@/pages/ScreenPage.vue'), meta: { title: '选基' } },
    { path: '/watch', name: 'watch', component: () => import('@/pages/WatchlistPage.vue'), meta: { title: '自选' } },
    { path: '/compare', name: 'compare', component: () => import('@/pages/ComparePage.vue'), meta: { title: '对比' } },
    { path: '/assets', name: 'assets', component: () => import('@/pages/AssetsPage.vue'), meta: { title: '资产' } },
    { path: '/fund/:code', name: 'fund', component: () => import('@/pages/FundDetailPage.vue'), meta: { title: '基金详情' } },
    { path: '/report/:code', name: 'report', component: () => import('@/pages/ReportPage.vue'), meta: { title: '体检报告' } }
  ]
})

router.afterEach((to) => {
  const t = to.meta?.title as string | undefined
  document.title = t ? `${t} · 司南基金` : '司南基金'
})

export default router
