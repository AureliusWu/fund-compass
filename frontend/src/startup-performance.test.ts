/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
}

describe('首屏性能约束', () => {
  it('不再把 Vant 全量样式打入首屏', () => {
    const main = source('./main.ts')
    const viteConfig = source('../vite.config.ts')

    expect(main).not.toContain("vant/lib/index.css")
    expect(viteConfig).toContain('VantResolver({ importStyle: true })')
  })

  it('普通打开不强制刷新 GitHub 任务且不主动请求通知权限', () => {
    const home = source('./pages/HomePage.vue')

    expect(home).toContain('refreshHome(false)')
    expect(home).toContain('fetchTaskStatuses(force)')
    expect(home).not.toContain('requestNotifyPermission')
  })

  it('自选首屏先展示本地数据，不等待云同步、估值和逐只决策', () => {
    const watchlist = source('./pages/WatchlistPage.vue')

    expect(watchlist).toContain('hydrateLocal()\nonMounted(refresh)')
    expect(watchlist).toContain('Promise.allSettled([refreshItems(localItems), watch.load(true)])')
    expect(watchlist).toContain("const loading = ref(watch.items.length === 0 && watch.hasToken)")
    expect(watchlist).toContain("const label = estimate.cached ? '缓存估值' : estimate.label")
  })

  it('决策结果逐只写入，不再等待最慢基金后统一展示', () => {
    const watchlist = source('./pages/WatchlistPage.vue')

    expect(watchlist).toContain('await Promise.allSettled(items.map(async (item) => {')
    expect(watchlist).toContain('decisions[decision.code] = decision')
    expect(watchlist).not.toContain('const settled = await Promise.allSettled')
  })

  it('大型按需资源不进入 Service Worker 安装期预缓存', () => {
    const viteConfig = source('../vite.config.ts')

    expect(viteConfig).toContain("'**/assets/echarts-*.js'")
    expect(viteConfig).toContain("'**/pwa-*.png'")
    expect(viteConfig).toContain("cacheName: 'fc-heavy-assets'")
  })
})
