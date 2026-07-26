import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
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

  it('大型按需资源不进入 Service Worker 安装期预缓存', () => {
    const viteConfig = source('../vite.config.ts')

    expect(viteConfig).toContain("'**/assets/echarts-*.js'")
    expect(viteConfig).toContain("'**/pwa-*.png'")
    expect(viteConfig).toContain("cacheName: 'fc-heavy-assets'")
  })
})
