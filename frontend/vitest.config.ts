import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// 独立于 vite.config.ts：纯函数单测用 node 环境即可，无需 DOM / PWA 插件
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
