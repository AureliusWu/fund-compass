import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// 部署在 GitHub Pages 子路径下：https://aureliuswu.github.io/fund-compass/
export default defineConfig({
  base: '/fund-compass/',
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: '司南基金',
        short_name: '司南基金',
        description: '个人基金选基与择时辅助工具',
        theme_color: '#0f9d75',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  server: {
    port: 5173,
    // 开发时把 /api 代理到本地 FastAPI，绕开跨域
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true }
    }
  }
})
